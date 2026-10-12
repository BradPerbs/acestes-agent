/**
 * Discord, Slack and Matrix as channels, each against a fake of its own API
 * over real HTTP and, for Discord's Gateway and Slack's Socket Mode, a real
 * WebSocket. The gateway they drive is the one Telegram uses, tested in full
 * in channels.test.js; this is about what each adapter does differently:
 * how it connects and checks its credentials, how a message, a button press
 * and a command arrive, how cards and replies are drawn, and that a stranger
 * or a group is still ignored.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main', 'channels');
const format = require(path.join(ROOT, 'format'));
const { createConfig } = require(path.join(ROOT, 'config'));
const { createGateway } = require(path.join(ROOT, 'gateway'));
const { createDiscordAdapter, components } = require(path.join(ROOT, 'discord'));
const { createSlackAdapter, plainText } = require(path.join(ROOT, 'slack'));
const { createMatrixAdapter, normalizeServer, withoutReplyFallback } = require(path.join(ROOT, 'matrix'));

let passed = 0;
let failed = 0;
async function check(label, fn) {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed += 1;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.stack || error.message}`);
        failed += 1;
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, { timeout = 8000, label = 'condition' } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

/* ------------------------------------------------------------------ *
 * A WebSocket server, enough of RFC 6455 for a JSON conversation
 * ------------------------------------------------------------------ */

function acceptWebSockets(server, onConnection) {
    server.on('upgrade', (request, socket) => {
        const key = request.headers['sec-websocket-key'];
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        const listeners = new Set();
        let closed = false;
        let buffer = Buffer.alloc(0);
        const frame = (opcode, payload) => {
            if (socket.destroyed) return;
            const length = payload.length;
            let header;
            if (length < 126) {
                header = Buffer.from([0x80 | opcode, length]);
            } else if (length < 65536) {
                header = Buffer.alloc(4);
                header[0] = 0x80 | opcode;
                header[1] = 126;
                header.writeUInt16BE(length, 2);
            } else {
                header = Buffer.alloc(10);
                header[0] = 0x80 | opcode;
                header[1] = 127;
                header.writeBigUInt64BE(BigInt(length), 2);
            }
            socket.write(Buffer.concat([header, payload]));
        };
        const connection = {
            url: request.url,
            received: [],
            get closed() { return closed; },
            send: data => frame(1, Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))),
            close(code = 1000) {
                if (closed) return;
                closed = true;
                const payload = Buffer.alloc(2);
                payload.writeUInt16BE(code);
                frame(8, payload);
                socket.end();
            },
            onMessage: fn => listeners.add(fn),
        };
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 2) {
                const opcode = buffer[0] & 0x0f;
                const masked = (buffer[1] & 0x80) !== 0;
                let length = buffer[1] & 0x7f;
                let offset = 2;
                if (length === 126) {
                    if (buffer.length < 4) return;
                    length = buffer.readUInt16BE(2);
                    offset = 4;
                } else if (length === 127) {
                    if (buffer.length < 10) return;
                    length = Number(buffer.readBigUInt64BE(2));
                    offset = 10;
                }
                const maskAt = offset;
                if (masked) offset += 4;
                if (buffer.length < offset + length) return;
                const payload = Buffer.from(buffer.subarray(offset, offset + length));
                if (masked) {
                    const mask = buffer.subarray(maskAt, maskAt + 4);
                    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
                }
                buffer = buffer.subarray(offset + length);
                if (opcode === 8) {
                    if (!closed) {
                        closed = true;
                        frame(8, payload.subarray(0, 2));
                        socket.end();
                    }
                    return;
                }
                if (opcode === 9) {
                    frame(10, payload);
                    continue;
                }
                if (opcode === 1) {
                    let parsed;
                    try { parsed = JSON.parse(payload.toString('utf8')); } catch { parsed = payload.toString('utf8'); }
                    connection.received.push(parsed);
                    for (const fn of listeners) fn(parsed);
                }
            }
        });
        socket.on('error', () => {});
        socket.on('close', () => { closed = true; });
        onConnection(connection);
    });
}

function listen(server) {
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readBody(request) {
    return new Promise((resolve) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

const reply = (response, status, body) => {
    if (body === undefined) {
        response.writeHead(status).end();
        return;
    }
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
};

/* ------------------------------------------------------------------ *
 * The assistant, standing in
 * ------------------------------------------------------------------ */

function fakeAi() {
    const observers = new Set();
    const conversations = new Map();
    const pendingApprovals = new Set();
    let counter = 0;
    const calls = { send: [], approvals: [], questions: [], interrupt: [] };
    return {
        calls,
        pendingApprovals,
        observe(fn) {
            observers.add(fn);
            return () => observers.delete(fn);
        },
        emit(conversationId, event) {
            for (const fn of observers) {
                fn({ ...event, at: Date.now() }, { conversationId, agentId: 'agent-1', title: '', runKind: 'interactive', jobId: '', busy: true, remembering: false });
            }
        },
        create() {
            counter += 1;
            conversations.set(`conv-${counter}`, { title: `Chat ${counter}`, busy: false });
            return { conversationId: `conv-${counter}` };
        },
        history: id => (conversations.has(id) ? { found: true, ...conversations.get(id), agentId: 'agent-1' } : { found: false }),
        list: () => [...conversations.entries()].map(([conversationId, entry]) => ({ conversationId, ...entry })),
        async send(id, text, images, tagged, files, options) {
            calls.send.push({ id, text, images, files, options });
            return { success: true };
        },
        async interrupt(id) {
            calls.interrupt.push(id);
            return { success: true };
        },
        respondToApproval(payload) {
            calls.approvals.push(payload);
            return pendingApprovals.delete(payload.requestId);
        },
        respondToQuestion(payload) {
            calls.questions.push(payload);
            return false;
        },
    };
}

const fakeCrypt = {
    encrypt: value => `enc:${Buffer.from(value).toString('base64')}`,
    decrypt: stored => (stored.startsWith('enc:') ? Buffer.from(stored.slice(4), 'base64').toString('utf8') : ''),
};

function gatewayOn(adapter, { locked = { value: false } } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cb-test-${adapter.name}-`));
    const config = createConfig({ dir, crypt: fakeCrypt });
    const ai = fakeAi();
    const agentList = [{ id: 'agent-1', name: 'Acestino' }];
    const gateway = createGateway({
        adapter,
        section: config.section(adapter.name),
        ai,
        agents: { list: () => agentList, activeId: () => 'agent-1', get: id => agentList.find(agent => agent.id === id) || null },
        isLocked: () => locked.value,
        progressInterval: 0,
        typingInterval: 60000,
        retryDelay: 50,
        conflictDelay: 100,
        lockCheck: 50,
        hostName: 'test-pc',
        log: { error: () => {} },
    });
    gateway.start();
    return { gateway, ai, config };
}

/* ------------------------------------------------------------------ *
 * Discord
 * ------------------------------------------------------------------ */

const DISCORD_TOKEN = 'MTAwMDAwMDAwMDAwMDAwMDAw.GabcDE.abcdefghijklmnopqrstuvwxyz0123456789AB';

async function fakeDiscord() {
    const calls = [];
    let history = [];
    let nextId = 5000n;
    let sockets = [];
    let sequence = 1;
    let closeWith = 0;
    const server = http.createServer(async (request, response) => {
        const body = await readBody(request);
        const url = new URL(request.url, 'http://x');
        const route = url.pathname.replace(/^\/api\/v10/, '');
        if (request.headers.authorization !== `Bot ${DISCORD_TOKEN}`) return reply(response, 401, { message: '401: Unauthorized', code: 0 });
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { json = { raw: body.length }; }
        calls.push({ method: request.method, route, body: json, query: Object.fromEntries(url.searchParams) });
        if (request.method === 'GET' && route === '/users/@me') return reply(response, 200, { id: '900', username: 'acestes_bot', global_name: null, bot: true });
        if (request.method === 'GET' && route === '/oauth2/applications/@me') return reply(response, 200, { id: '800', name: 'Acestes' });
        if (request.method === 'PUT' && route === '/applications/800/commands') return reply(response, 200, []);
        if (request.method === 'GET' && /^\/channels\/[^/]+\/messages$/.test(route)) return reply(response, 200, history);
        if (request.method === 'POST' && /^\/channels\/[^/]+\/messages$/.test(route)) {
            nextId += 1n;
            return reply(response, 200, { id: String(nextId) });
        }
        if (request.method === 'PATCH' && /^\/channels\/[^/]+\/messages\/[^/]+$/.test(route)) return reply(response, 200, { id: route.split('/').pop() });
        if (/\/typing$/.test(route) || /\/callback$/.test(route) || request.method === 'DELETE') return reply(response, 204);
        if (request.method === 'PATCH' && /@original$/.test(route)) {
            nextId += 1n;
            return reply(response, 200, { id: String(nextId) });
        }
        if (request.method === 'POST' && /^\/webhooks\//.test(route)) return reply(response, 200, { id: '1' });
        return reply(response, 404, { message: 'Unknown', code: 0 });
    });
    acceptWebSockets(server, (socket) => {
        sockets.push(socket);
        socket.send({ op: 10, d: { heartbeat_interval: 45000 } });
        socket.onMessage((packet) => {
            if (packet.op !== 2) return;
            if (closeWith) {
                socket.close(closeWith);
                return;
            }
            socket.send({ op: 0, t: 'READY', s: sequence++, d: { session_id: 's1', user: { id: '900' }, application: { id: '800' } } });
        });
    });
    const port = await listen(server);
    return {
        calls,
        apiBase: `http://127.0.0.1:${port}/api/v10`,
        gatewayUrl: `ws://127.0.0.1:${port}/gateway`,
        get socket() { return sockets[sockets.length - 1]; },
        get sockets() { return sockets; },
        setHistory: (messages) => { history = messages; },
        failIdentify: (code) => { closeWith = code; },
        dispatch(type, data) {
            sockets[sockets.length - 1].send({ op: 0, t: type, s: sequence++, d: data });
        },
        message(user, content, extra = {}) {
            nextId += 1n;
            this.dispatch('MESSAGE_CREATE', {
                id: String(nextId),
                channel_id: 'DM1',
                author: { id: user.id, username: user.username, global_name: user.name },
                content,
                timestamp: new Date().toISOString(),
                attachments: [],
                ...extra,
            });
        },
        sent: route => calls.filter(call => call.route === route),
        close: () => new Promise((resolve) => {
            for (const socket of sockets) socket.close();
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}

const DISCORD_OWNER = { id: '111', username: 'brad', name: 'Brad' };

/* ------------------------------------------------------------------ *
 * Slack
 * ------------------------------------------------------------------ */

const SLACK_BOT = 'xoxb-1111-2222-abcdefghijkl';
const SLACK_APP = 'xapp-1-A111-2222-abcdefghijkl';

async function fakeSlack() {
    const calls = [];
    let sockets = [];
    let ts = Math.floor(Date.now() / 1000);
    let history = [];
    let openFailure = '';
    const server = http.createServer(async (request, response) => {
        const body = Object.fromEntries(new URLSearchParams(await readBody(request)));
        const method = request.url.replace(/^\/api\//, '');
        const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
        calls.push({ method, body, token });
        if (method === 'apps.connections.open') {
            if (token !== SLACK_APP) return reply(response, 200, { ok: false, error: 'invalid_auth' });
            if (openFailure) return reply(response, 200, { ok: false, error: openFailure });
            return reply(response, 200, { ok: true, url: `ws://127.0.0.1:${server.address().port}/socket` });
        }
        if (token !== SLACK_BOT) return reply(response, 200, { ok: false, error: 'invalid_auth' });
        switch (method) {
            case 'auth.test': return reply(response, 200, { ok: true, user_id: 'UBOT', user: 'acestes', team_id: 'T1', team: 'Brad Co', bot_id: 'B1' });
            case 'users.info': return reply(response, 200, { ok: true, user: { id: body.user, name: 'brad', real_name: 'Brad P', profile: { real_name: 'Brad P', display_name: 'brad' } } });
            case 'chat.postMessage':
                ts += 1;
                return reply(response, 200, { ok: true, ts: `${ts}.000100`, channel: body.channel });
            case 'chat.update': return reply(response, 200, { ok: true });
            case 'conversations.history': return reply(response, 200, { ok: true, messages: history });
            default: return reply(response, 200, { ok: false, error: 'unknown_method' });
        }
    });
    acceptWebSockets(server, (socket) => {
        sockets.push(socket);
        socket.send({ type: 'hello', num_connections: 1 });
    });
    const port = await listen(server);
    let envelopes = 0;
    return {
        calls,
        apiBase: `http://127.0.0.1:${port}/api`,
        get socket() { return sockets[sockets.length - 1]; },
        get sockets() { return sockets; },
        setHistory: (messages) => { history = messages; },
        failOpen: (error) => { openFailure = error; },
        envelope(type, payload) {
            envelopes += 1;
            const id = `env-${envelopes}`;
            sockets[sockets.length - 1].send({ envelope_id: id, type, payload, accepts_response_payload: false });
            return id;
        },
        message(user, text, extra = {}) {
            ts += 1;
            return this.envelope('events_api', { event: { type: 'message', channel_type: 'im', channel: 'D1', user, text, ts: `${ts}.000200`, client_msg_id: `m${ts}`, ...extra } });
        },
        sent: method => calls.filter(call => call.method === method),
        close: () => new Promise((resolve) => {
            for (const socket of sockets) socket.close();
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}

/* ------------------------------------------------------------------ *
 * Matrix
 * ------------------------------------------------------------------ */

const MATRIX_TOKEN = 'syt_YWNlc3Rlcw_abcdefghijklmnop_1a2b3c';

async function fakeMatrix() {
    const calls = [];
    const batches = [];
    let waiting = null;
    let batch = 0;
    let eventCounter = 0;
    const roomMembers = { '!dm:test': 2, '!group:test': 3 };
    let failSync = false;
    const server = http.createServer(async (request, response) => {
        const body = await readBody(request);
        const url = new URL(request.url, 'http://x');
        const route = decodeURIComponent(url.pathname);
        if (route === '/.well-known/matrix/client') return reply(response, 404, { errcode: 'M_NOT_FOUND' });
        if (request.headers.authorization !== `Bearer ${MATRIX_TOKEN}`) return reply(response, 401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' });
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { json = null; }
        if (!route.endsWith('/sync')) calls.push({ method: request.method, route, body: json });
        if (route === '/_matrix/client/v3/account/whoami') return reply(response, 200, { user_id: '@bot:test' });
        if (route.startsWith('/_matrix/client/v3/profile/')) return reply(response, 200, { displayname: 'Acestes Bot' });
        if (route === '/_matrix/client/v3/sync') {
            if (failSync) return reply(response, 401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Token revoked' });
            if (!url.searchParams.get('since')) return reply(response, 200, { next_batch: 's0', rooms: {} });
            const answer = () => {
                batch += 1;
                const next = batches.shift() || {};
                reply(response, 200, { next_batch: `s${batch}`, rooms: next });
            };
            if (batches.length) return answer();
            const timer = setTimeout(() => { waiting = null; answer(); }, 500);
            waiting = () => { clearTimeout(timer); waiting = null; answer(); };
            response.on('close', () => clearTimeout(timer));
            return undefined;
        }
        const membersMatch = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/joined_members$/.exec(route);
        if (membersMatch) {
            const count = roomMembers[membersMatch[1]] || 2;
            return reply(response, 200, { joined: Object.fromEntries(Array.from({ length: count }, (_, index) => [`@u${index}:test`, {}])) });
        }
        if (/\/send\//.test(route) || /\/redact\//.test(route)) {
            eventCounter += 1;
            return reply(response, 200, { event_id: `$e${eventCounter}` });
        }
        return reply(response, 200, {});
    });
    const port = await listen(server);
    return {
        calls,
        base: `http://127.0.0.1:${port}`,
        failSync: () => { failSync = true; },
        push(rooms) {
            batches.push(rooms);
            waiting?.();
        },
        message(roomId, sender, body, extra = {}) {
            this.push({ join: { [roomId]: { timeline: { events: [{ type: 'm.room.message', event_id: `$in${Math.random()}`, sender, origin_server_ts: Date.now(), content: { msgtype: 'm.text', body, ...extra } }] } } } });
        },
        sent: type => calls.filter(call => call.method === 'PUT' && call.route.includes(`/send/${type}/`)),
        close: () => new Promise((resolve) => {
            waiting?.();
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
    };
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

(async () => {
    console.log('\nchannels: formatting for Discord, Slack and Matrix');

    await check('Discord keeps Markdown, and a table goes in a code block', () => {
        const [text] = format.toMessages('**bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |', { target: 'discord' });
        assert.strictEqual(text, '**bold** and `code`\n\n```\n| a | b |\n| 1 | 2 |\n```');
    });

    await check('Slack gets mrkdwn: single-asterisk bold, underscores, <url|text>, its three escapes', () => {
        const [text] = format.toMessages('**Done** on *web1* with [docs](https://x.io/a) & <tags>\n\n# Heading', { target: 'slack' });
        assert.strictEqual(text, '*Done* on _web1_ with <https://x.io/a|docs> &amp; &lt;tags&gt;\n\n*Heading*');
    });

    await check('Matrix gets HTML with <br> line breaks, and code keeps its own', () => {
        const [html] = format.toMessages('one\ntwo\n\n```\na\nb\n```', { target: 'matrix' });
        assert.strictEqual(html, 'one<br>two<br><br><pre><code>a\nb</code></pre>');
    });

    await check('Discord messages stay under 2000 characters', () => {
        const messages = format.toMessages(Array.from({ length: 40 }, (_, index) => `Line ${index} ${'x'.repeat(90)}`).join('\n\n'), { target: 'discord' });
        assert.ok(messages.length > 1);
        assert.ok(messages.every(message => message.length <= 1900));
    });

    await check('escaped Markdown is literal in every target', () => {
        const source = format.escapeMarkdown('my_file *not bold*');
        assert.strictEqual(format.toText(source, 'telegram'), 'my_file *not bold*');
        assert.strictEqual(format.toText(source, 'slack'), 'my_file *not bold*');
    });

    await check('Discord buttons are rows of at most five, at most five rows, each with its style', () => {
        const rows = components([[{ text: 'Approve', data: 'a:c1:y', style: 'success' }, { text: 'Deny', data: 'a:c1:n', style: 'danger' }]]);
        assert.deepStrictEqual(rows[0].components.map(button => [button.label, button.style, button.custom_id]), [['Approve', 3, 'a:c1:y'], ['Deny', 4, 'a:c1:n']]);
        const many = components(Array.from({ length: 30 }, (_, index) => [{ text: `${index}`, data: `q:${index}` }]));
        assert.ok(many.length <= 5 && many.every(row => row.components.length <= 5));
    });

    await check('Slack text comes back to what was typed; a Matrix reply loses its quote', () => {
        assert.strictEqual(plainText('see <https://x.io|docs> &amp; &lt;b&gt;'), 'see docs (https://x.io) & <b>');
        assert.strictEqual(withoutReplyFallback({ body: '> <@a:b> earlier\n\nnow this', 'm.relates_to': { 'm.in_reply_to': { event_id: '$1' } } }), 'now this');
        assert.strictEqual(normalizeServer('matrix.org/'), 'https://matrix.org');
    });

    console.log('\nchannels: Discord');

    await check('a token is checked with Discord, and the Gateway asks for DMs only', async () => {
        const discord = await fakeDiscord();
        const { gateway } = gatewayOn(createDiscordAdapter({ apiBase: discord.apiBase, gatewayUrl: discord.gatewayUrl }));
        try {
            assert.ok(gateway.connect({ token: 'nope' }).then);
            const bad = await gateway.connect({ token: 'nope' });
            assert.ok(/does not look like a bot token/.test(bad.error));
            const status = await gateway.connect({ token: DISCORD_TOKEN });
            assert.strictEqual(status.identity.applicationId, '800');
            assert.ok(status.setup.inviteUrl.includes('client_id=800'));
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const identify = discord.socket.received.find(packet => packet.op === 2);
            assert.strictEqual(identify.d.intents, 4096);
            assert.strictEqual(identify.d.token, DISCORD_TOKEN);
            await until(() => discord.calls.some(call => call.route === '/applications/800/commands'), { label: 'commands' });
            const commands = discord.calls.find(call => call.route === '/applications/800/commands').body;
            assert.ok(commands.every(command => command.contexts[0] === 1 && command.type === 1));
        } finally {
            gateway.stop();
            await discord.close();
        }
    });

    await check('pairing by DM; a server message and a stranger are ignored', async () => {
        const discord = await fakeDiscord();
        const { gateway, ai } = gatewayOn(createDiscordAdapter({ apiBase: discord.apiBase, gatewayUrl: discord.gatewayUrl }));
        try {
            await gateway.connect({ token: DISCORD_TOKEN });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            assert.strictEqual(pairing.text, `pair ${pairing.code}`);
            assert.strictEqual(pairing.link, 'https://discord.com/users/900');
            discord.message({ id: '222', username: 'eve', name: 'Eve' }, 'hello', { guild_id: 'G1' });
            discord.message(DISCORD_OWNER, `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            assert.strictEqual(gateway.status().owner.name, 'Brad');
            await until(() => discord.sent('/channels/DM1/messages').some(call => /\*\*Paired with Acestes on test-pc\.\*\*/.test(call.body.content)), { label: 'welcome' });
            discord.message({ id: '333', username: 'mallory', name: 'Mallory' }, 'run something');
            discord.message(DISCORD_OWNER, 'how is web1?');
            await until(() => ai.calls.send.length === 1, { label: 'send' });
            assert.strictEqual(ai.calls.send[0].text, 'how is web1?');
            assert.deepStrictEqual(ai.calls.send[0].options, { channel: 'discord' });
            await until(() => discord.calls.some(call => call.route === '/channels/DM1/typing'), { label: 'typing' });
        } finally {
            gateway.stop();
            await discord.close();
        }
    });

    await check('an approval card has buttons, a press is acknowledged at once and answers it', async () => {
        const discord = await fakeDiscord();
        const { gateway, ai } = gatewayOn(createDiscordAdapter({ apiBase: discord.apiBase, gatewayUrl: discord.gatewayUrl }));
        try {
            await gateway.connect({ token: DISCORD_TOKEN });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            discord.message(DISCORD_OWNER, `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            discord.message(DISCORD_OWNER, 'restart nginx');
            await until(() => ai.calls.send.length === 1, { label: 'send' });
            ai.pendingApprovals.add('approve-1');
            ai.emit(ai.calls.send[0].id, { type: 'approval-request', requestId: 'approve-1', name: 'run_command', title: 'Run a command', host: 'web1', input: { command: 'systemctl restart nginx' } });
            await until(() => discord.sent('/channels/DM1/messages').some(call => /Approval needed/.test(call.body.content)), { label: 'card' });
            const card = discord.sent('/channels/DM1/messages').find(call => /Approval needed/.test(call.body.content));
            assert.ok(card.body.content.includes('```\nsystemctl restart nginx\n```'));
            const approve = card.body.components[0].components[0];
            assert.strictEqual(approve.style, 3);

            discord.dispatch('INTERACTION_CREATE', { id: 'i1', token: 'tok1', type: 3, channel_id: 'DM1', user: { id: '111', username: 'brad' }, message: { id: '5001' }, data: { custom_id: approve.custom_id } });
            await until(() => ai.calls.approvals.length === 1, { label: 'approval' });
            assert.deepStrictEqual(ai.calls.approvals[0], { requestId: 'approve-1', approved: true, by: 'discord' });
            // Sent alongside the handling, not before it: waited for, not assumed.
            await until(() => discord.calls.some(call => call.route === '/interactions/i1/tok1/callback'), { label: 'acknowledged' });
            assert.deepStrictEqual(discord.calls.find(call => call.route === '/interactions/i1/tok1/callback').body, { type: 6 });
            ai.emit(ai.calls.send[0].id, { type: 'approval-settled', requestId: 'approve-1', status: 'approved', by: 'discord' });
            await until(() => discord.calls.some(call => call.method === 'PATCH' && /\/channels\/DM1\/messages\//.test(call.route) && /_Approved\._/.test(call.body.content)), { label: 'settled' });
            const settled = discord.calls.find(call => call.method === 'PATCH' && /_Approved\._/.test(call.body?.content || ''));
            assert.deepStrictEqual(settled.body.components, []);
        } finally {
            gateway.stop();
            await discord.close();
        }
    });

    await check('a slash command is answered in place of Discord\'s "thinking"', async () => {
        const discord = await fakeDiscord();
        const { gateway } = gatewayOn(createDiscordAdapter({ apiBase: discord.apiBase, gatewayUrl: discord.gatewayUrl }));
        try {
            await gateway.connect({ token: DISCORD_TOKEN });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            discord.message(DISCORD_OWNER, `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            discord.dispatch('INTERACTION_CREATE', { id: 'i2', token: 'tok2', type: 2, channel_id: 'DM1', user: { id: '111', username: 'brad' }, data: { name: 'status' } });
            await until(() => discord.calls.some(call => call.route === '/webhooks/800/tok2/messages/@original'), { label: 'response' });
            await until(() => discord.calls.some(call => call.route === '/interactions/i2/tok2/callback'), { label: 'acknowledged' });
            assert.deepStrictEqual(discord.calls.find(call => call.route === '/interactions/i2/tok2/callback').body, { type: 5 });
            const answer = discord.calls.find(call => call.route === '/webhooks/800/tok2/messages/@original');
            assert.strictEqual(answer.method, 'PATCH');
            assert.ok(/\*\*Acestino\*\* on test-pc/.test(answer.body.content), answer.body.content);
        } finally {
            gateway.stop();
            await discord.close();
        }
    });

    await check('a DM sent while the app was closed is read on the next connect', async () => {
        const discord = await fakeDiscord();
        const adapter = createDiscordAdapter({ apiBase: discord.apiBase, gatewayUrl: discord.gatewayUrl });
        const { gateway, ai } = gatewayOn(adapter);
        try {
            await gateway.connect({ token: DISCORD_TOKEN });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            discord.message(DISCORD_OWNER, `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            gateway.stop();
            discord.setHistory([{ id: '99999', channel_id: 'DM1', author: { id: '111', username: 'brad' }, content: 'while you were out', timestamp: new Date().toISOString(), attachments: [] }]);
            gateway.start();
            await until(() => ai.calls.send.some(call => call.text === 'while you were out'), { label: 'caught up' });
            const fetched = discord.calls.find(call => call.method === 'GET' && call.route === '/channels/DM1/messages');
            assert.ok(fetched.query.after, 'asked only for what came after the last one seen');
        } finally {
            gateway.stop();
            await discord.close();
        }
    });

    await check('a refused token at the Gateway stops it and says so', async () => {
        const discord = await fakeDiscord();
        const { gateway } = gatewayOn(createDiscordAdapter({ apiBase: discord.apiBase, gatewayUrl: discord.gatewayUrl }));
        try {
            discord.failIdentify(4004);
            await gateway.connect({ token: DISCORD_TOKEN });
            await until(() => gateway.status().state === 'unauthorized', { label: 'unauthorized' });
        } finally {
            gateway.stop();
            await discord.close();
        }
    });

    console.log('\nchannels: Slack');

    await check('two tokens are checked, and the manifest is offered before there are any', async () => {
        const slack = await fakeSlack();
        const { gateway } = gatewayOn(createSlackAdapter({ apiBase: slack.apiBase }));
        try {
            assert.strictEqual(gateway.status().manifest.settings.socket_mode_enabled, true);
            assert.ok(gateway.status().manifest.oauth_config.scopes.bot.includes('im:history'));
            assert.ok(/xoxb-/.test((await gateway.connect({ botToken: 'xoxp-1', appToken: SLACK_APP })).error));
            assert.ok(/xapp-/.test((await gateway.connect({ botToken: SLACK_BOT, appToken: 'nope' })).error));
            assert.ok(/app-level token/.test((await gateway.connect({ botToken: SLACK_BOT, appToken: 'xapp-1-wrong-token-here' })).error));
            const status = await gateway.connect({ botToken: SLACK_BOT, appToken: SLACK_APP });
            assert.strictEqual(status.identity.team, 'Brad Co');
            assert.strictEqual(status.prefix, '!');
            await until(() => gateway.status().state === 'running', { label: 'running' });
        } finally {
            gateway.stop();
            await slack.close();
        }
    });

    await check('every envelope is acknowledged; pairing names the person from their profile', async () => {
        const slack = await fakeSlack();
        const { gateway, ai } = gatewayOn(createSlackAdapter({ apiBase: slack.apiBase }));
        try {
            await gateway.connect({ botToken: SLACK_BOT, appToken: SLACK_APP });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            assert.strictEqual(pairing.link, '');
            const envelope = slack.message('U1', `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            assert.ok(slack.socket.received.some(packet => packet.envelope_id === envelope), 'acknowledged');
            assert.strictEqual(gateway.status().owner.name, 'Brad P');
            await until(() => slack.sent('chat.postMessage').some(call => /^\*Paired with Acestes on test-pc\.\*/.test(call.body.text)), { label: 'welcome' });

            slack.message('U9', 'a stranger');
            slack.message('U1', 'deploy it', { bot_id: 'B9' });
            slack.message('U1', '!status');
            await until(() => slack.sent('chat.postMessage').some(call => /\*Acestino\* on test-pc/.test(call.body.text)), { label: 'status' });
            slack.message('U1', 'how is web1?');
            await until(() => ai.calls.send.length === 1, { label: 'send' });
            assert.strictEqual(ai.calls.send[0].text, 'how is web1?');
            assert.strictEqual(ai.calls.send[0].options.channel, 'slack');
        } finally {
            gateway.stop();
            await slack.close();
        }
    });

    await check('a card is Block Kit buttons, a press answers it, and the update takes them away', async () => {
        const slack = await fakeSlack();
        const { gateway, ai } = gatewayOn(createSlackAdapter({ apiBase: slack.apiBase }));
        try {
            await gateway.connect({ botToken: SLACK_BOT, appToken: SLACK_APP });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            slack.message('U1', `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            slack.message('U1', 'restart nginx');
            await until(() => ai.calls.send.length === 1, { label: 'send' });
            ai.pendingApprovals.add('approve-1');
            ai.emit(ai.calls.send[0].id, { type: 'approval-request', requestId: 'approve-1', name: 'run_command', input: { command: 'systemctl restart nginx' } });
            await until(() => slack.sent('chat.postMessage').some(call => call.body.blocks), { label: 'card' });
            const card = slack.sent('chat.postMessage').find(call => call.body.blocks);
            const blocks = JSON.parse(card.body.blocks);
            assert.strictEqual(blocks[0].type, 'section');
            assert.ok(blocks[0].text.text.startsWith('*Approval needed*'));
            assert.deepStrictEqual(blocks[1].elements.map(element => element.style), ['primary', 'danger']);

            slack.envelope('interactive', {
                type: 'block_actions',
                user: { id: 'U1', username: 'brad' },
                channel: { id: 'D1' },
                container: { message_ts: card.body.ts || '1700000003.000100' },
                actions: [{ action_id: blocks[1].elements[0].action_id, value: blocks[1].elements[0].value }],
            });
            await until(() => ai.calls.approvals.length === 1, { label: 'approval' });
            assert.deepStrictEqual(ai.calls.approvals[0], { requestId: 'approve-1', approved: true, by: 'slack' });
            ai.emit(ai.calls.send[0].id, { type: 'approval-settled', requestId: 'approve-1', status: 'approved', by: 'slack' });
            await until(() => slack.sent('chat.update').some(call => /_Approved\._/.test(call.body.text)), { label: 'updated' });
            assert.strictEqual(slack.sent('chat.update').find(call => /_Approved\._/.test(call.body.text)).body.blocks, '[]');
        } finally {
            gateway.stop();
            await slack.close();
        }
    });

    await check('a refresh Slack asks for opens a new socket; a revoked token stops', async () => {
        const slack = await fakeSlack();
        const { gateway } = gatewayOn(createSlackAdapter({ apiBase: slack.apiBase }));
        try {
            await gateway.connect({ botToken: SLACK_BOT, appToken: SLACK_APP });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const before = slack.sent('apps.connections.open').length;
            slack.socket.send({ type: 'disconnect', reason: 'refresh_requested' });
            await until(() => slack.sent('apps.connections.open').length > before, { label: 'reconnect' });
            await until(() => slack.sockets.length >= 2, { label: 'second socket' });
            slack.failOpen('token_revoked');
            slack.socket.send({ type: 'disconnect', reason: 'refresh_requested' });
            await until(() => gateway.status().state === 'unauthorized', { label: 'unauthorized' });
        } finally {
            gateway.stop();
            await slack.close();
        }
    });

    console.log('\nchannels: Matrix');

    await check('the token is checked with the homeserver; invites are taken only while pairing', async () => {
        const matrix = await fakeMatrix();
        const { gateway } = gatewayOn(createMatrixAdapter({ syncTimeout: 500 }));
        try {
            assert.ok(/homeserver/.test((await gateway.connect({ homeserver: '', accessToken: MATRIX_TOKEN })).error));
            const status = await gateway.connect({ homeserver: matrix.base, accessToken: MATRIX_TOKEN });
            assert.strictEqual(status.identity.id, '@bot:test');
            assert.strictEqual(status.identity.name, 'Acestes Bot');
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const invite = roomId => ({ invite: { [roomId]: { invite_state: { events: [{ type: 'm.room.member', state_key: '@bot:test', sender: '@eve:test', content: { membership: 'invite' } }] } } } });
            matrix.push(invite('!spam:test'));
            await until(() => matrix.calls.some(call => call.route.includes('!spam:test/leave')), { label: 'declined' });
            gateway.pair();
            matrix.push(invite('!dm:test'));
            await until(() => matrix.calls.some(call => call.route === '/_matrix/client/v3/join/!dm:test'), { label: 'joined' });
        } finally {
            gateway.stop();
            await matrix.close();
        }
    });

    await check('pairing in a two-person room; a group is ignored; an encrypted room is told why', async () => {
        const matrix = await fakeMatrix();
        const { gateway, ai } = gatewayOn(createMatrixAdapter({ syncTimeout: 500 }));
        try {
            await gateway.connect({ homeserver: matrix.base, accessToken: MATRIX_TOKEN });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            assert.strictEqual(pairing.link, '');
            matrix.message('!group:test', '@brad:test', `pair ${pairing.code}`);
            await sleep(700);
            assert.strictEqual(gateway.status().owner, null, 'not from a group room');
            matrix.message('!dm:test', '@brad:test', `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            await until(() => matrix.sent('m.room.message').some(call => /<b>Paired with Acestes on test-pc\.<\/b>/.test(call.body.formatted_body)), { label: 'welcome' });

            matrix.push({ join: { '!dm:test': { timeline: { events: [{ type: 'm.room.encrypted', event_id: '$enc', sender: '@brad:test', origin_server_ts: Date.now(), content: { algorithm: 'm.megolm.v1.aes-sha2' } }] } } } });
            await until(() => matrix.sent('m.room.message').some(call => /end-to-end encrypted/.test(call.body.body)), { label: 'encrypted note' });

            matrix.message('!dm:test', '@brad:test', 'how is web1?');
            await until(() => ai.calls.send.length === 1, { label: 'send' });
            assert.strictEqual(ai.calls.send[0].options.channel, 'matrix');
            await until(() => matrix.calls.some(call => call.method === 'PUT' && call.route.includes('/typing/@bot:test')), { label: 'typing' });
        } finally {
            gateway.stop();
            await matrix.close();
        }
    });

    await check('a card\'s choices are reactions; the user\'s reaction answers it, and the bot takes its own back', async () => {
        const matrix = await fakeMatrix();
        const { gateway, ai } = gatewayOn(createMatrixAdapter({ syncTimeout: 500 }));
        try {
            await gateway.connect({ homeserver: matrix.base, accessToken: MATRIX_TOKEN });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            const { pairing } = gateway.pair();
            matrix.message('!dm:test', '@brad:test', `pair ${pairing.code}`);
            await until(() => gateway.status().owner, { label: 'paired' });
            matrix.message('!dm:test', '@brad:test', 'restart nginx');
            await until(() => ai.calls.send.length === 1, { label: 'send' });
            ai.pendingApprovals.add('approve-1');
            ai.emit(ai.calls.send[0].id, { type: 'approval-request', requestId: 'approve-1', name: 'run_command', input: { command: 'systemctl restart nginx' } });
            await until(() => matrix.sent('m.reaction').length === 2, { label: 'reactions' });
            const card = matrix.sent('m.room.message').find(call => /Approval needed/.test(call.body.body));
            assert.ok(card.body.formatted_body.includes('React with ✅ Approve · ❌ Deny'), card.body.formatted_body);
            const cardEvent = matrix.sent('m.reaction')[0].body['m.relates_to'].event_id;

            matrix.push({ join: { '!dm:test': { timeline: { events: [{ type: 'm.reaction', event_id: '$r1', sender: '@brad:test', origin_server_ts: Date.now(), content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: cardEvent, key: '✅' } } }] } } } });
            await until(() => ai.calls.approvals.length === 1, { label: 'approval' });
            assert.deepStrictEqual(ai.calls.approvals[0], { requestId: 'approve-1', approved: true, by: 'matrix' });
            ai.emit(ai.calls.send[0].id, { type: 'approval-settled', requestId: 'approve-1', status: 'approved', by: 'matrix' });
            await until(() => matrix.sent('m.room.message').some(call => call.body['m.relates_to']?.rel_type === 'm.replace' && /Approved\./.test(call.body['m.new_content'].body)), { label: 'edited' });
            await until(() => matrix.calls.filter(call => call.route.includes('/redact/')).length === 2, { label: 'reactions taken back' });
        } finally {
            gateway.stop();
            await matrix.close();
        }
    });

    await check('a revoked access token stops the sync and says so', async () => {
        const matrix = await fakeMatrix();
        const { gateway } = gatewayOn(createMatrixAdapter({ syncTimeout: 500 }));
        try {
            await gateway.connect({ homeserver: matrix.base, accessToken: MATRIX_TOKEN });
            await until(() => gateway.status().state === 'running', { label: 'running' });
            matrix.failSync();
            await until(() => gateway.status().state === 'unauthorized', { label: 'unauthorized' });
        } finally {
            gateway.stop();
            await matrix.close();
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
