/**
 * The Telegram channel: the formatter, the config store, the Bot API client
 * and the gateway, end to end against a fake Bot API server over real HTTP.
 *
 * The assistant core is a stand-in here that records what the gateway asks
 * of it and lets the test play events back the way `emit` would. What the
 * real core does with a message from the phone (the tag, the stricter
 * approvals, `by` on a settled card) is channels-assistant.test.js.
 *
 * The cases that matter most are the trust rules: a stranger gets nothing,
 * pairing takes the code the desktop issued and no other, a message that
 * arrives late is offered rather than run, a locked app reads nothing, and
 * a secret is never asked for over Telegram.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main', 'channels');
const format = require(path.join(ROOT, 'format'));
const { createConfig, cleanSection } = require(path.join(ROOT, 'config'));
const { createTelegramApi, TelegramError } = require(path.join(ROOT, 'telegram-api'));
const { createTelegramGateway } = require(path.join(ROOT, 'telegram'));
const { stepLine } = require(path.join(ROOT, 'gateway'));
const { createControls, readEffort, readMode, nearestEffort, effortStops } = require(path.join(ROOT, 'controls'));

const TOKEN = '123456789:AAtestTOKENtestTOKENtestTOKENtest12';
const OWNER = { id: 5001, first_name: 'Brad', username: 'brad', is_bot: false };
const STRANGER = { id: 6666, first_name: 'Mallory', username: 'mallory', is_bot: false };

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
async function until(predicate, { timeout = 3000, label = 'condition' } = {}) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

/* ------------------------------------------------------------------ *
 * A fake Bot API
 * ------------------------------------------------------------------ */

function fakeTelegram() {
    const calls = [];
    let updates = [];
    let updateId = 100;
    let messageId = 1000;
    const waiters = new Set();
    const failures = new Map();
    let polls = 0;

    const reply = (response, status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
    };

    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const raw = Buffer.concat(chunks);
            const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(request.url);
            if (file) {
                response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
                response.end(Buffer.from('hello from a text file\n'));
                return;
            }
            const match = /^\/bot([^/]+)\/(\w+)$/.exec(request.url);
            if (!match) return reply(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
            const [, token, method] = match;
            if (token !== TOKEN) return reply(response, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
            let body = {};
            if (/json/.test(request.headers['content-type'] || '')) {
                try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
            } else {
                body = { multipart: raw.length };
            }
            const failure = failures.get(method);
            if (failure && failure.count > 0) {
                failure.count -= 1;
                return reply(response, failure.status, { ok: false, error_code: failure.status, description: failure.description, parameters: failure.parameters });
            }
            if (method !== 'getUpdates') calls.push({ method, body });
            switch (method) {
                case 'getMe':
                    return reply(response, 200, { ok: true, result: { id: 42, is_bot: true, username: 'acestes_test_bot', first_name: 'Acestes Test' } });
                case 'getUpdates': {
                    polls += 1;
                    const offset = Number(body.offset) || 0;
                    updates = updates.filter(update => update.update_id >= offset);
                    if (updates.length) return reply(response, 200, { ok: true, result: updates });
                    const waiter = () => {
                        clearTimeout(timer);
                        waiters.delete(waiter);
                        updates = updates.filter(update => update.update_id >= offset);
                        reply(response, 200, { ok: true, result: updates });
                    };
                    const timer = setTimeout(waiter, Math.min(1000, (Number(body.timeout) || 0) * 1000));
                    waiters.add(waiter);
                    // The response's close, not the request's: a request
                    // closes as soon as its body has been read.
                    response.on('close', () => { clearTimeout(timer); waiters.delete(waiter); });
                    return undefined;
                }
                case 'sendMessage':
                case 'sendDocument':
                    messageId += 1;
                    // For pressing a menu's buttons: the id it went out as.
                    calls[calls.length - 1].messageId = messageId;
                    return reply(response, 200, { ok: true, result: { message_id: messageId, chat: { id: body.chat_id }, text: body.text } });
                case 'getFile':
                    return reply(response, 200, { ok: true, result: { file_id: body.file_id, file_path: 'documents/notes.txt' } });
                default:
                    return reply(response, 200, { ok: true, result: true });
            }
        });
    });

    return {
        calls,
        get polls() { return polls; },
        listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
        close: () => new Promise((resolve) => {
            for (const waiter of [...waiters]) waiter();
            server.closeAllConnections?.();
            server.close(() => resolve());
        }),
        push(update) {
            updateId += 1;
            updates.push({ update_id: updateId, ...update });
            for (const waiter of [...waiters]) waiter();
            return updateId;
        },
        message(from, text, extra = {}) {
            return this.push({
                message: {
                    message_id: Math.floor(Math.random() * 1e6),
                    date: Math.floor(Date.now() / 1000),
                    chat: { id: from.id, type: 'private' },
                    from,
                    text,
                    ...extra,
                },
            });
        },
        press(from, data, messageIdOfCard) {
            return this.push({
                callback_query: {
                    id: `cb-${Math.random()}`,
                    from,
                    data,
                    message: { message_id: messageIdOfCard, chat: { id: from.id, type: 'private' } },
                },
            });
        },
        fail(method, status, description, count = 1, parameters = {}) {
            failures.set(method, { status, description, count, parameters });
        },
        sent: method => calls.filter(call => call.method === method),
        clear() { calls.length = 0; },
    };
}

/* ------------------------------------------------------------------ *
 * A stand-in assistant core
 * ------------------------------------------------------------------ */

/** What the runtimes say they have, for the model, effort and mode cases. */
const CATALOGS = {
    'claude-code': [
        { value: 'opus', resolved: 'claude-opus-5-5', label: 'Opus 5.5', effort: ['low', 'medium', 'high', 'xhigh', 'max'], preferred: true },
        { value: 'sonnet', resolved: 'claude-sonnet-5', label: 'Sonnet 5', effort: ['low', 'medium', 'high'] },
        { value: 'haiku', resolved: 'claude-haiku-4-5', label: 'Haiku 4.5', effort: [] },
    ],
    codex: [
        { value: 'gpt-5.5', label: 'GPT-5.5', effort: ['low', 'medium', 'high', 'xhigh'], preferred: true },
    ],
};

function fakeAi() {
    const observers = new Set();
    const conversations = new Map();
    const pendingApprovals = new Set();
    const pendingQuestions = new Set();
    /** conversationId -> its pin, as setConversationModel keeps one. */
    const pins = new Map();
    let counter = 0;
    const calls = { send: [], interrupt: [], approvals: [], questions: [], create: [], pin: [] };
    return {
        calls,
        conversations,
        pendingApprovals,
        pendingQuestions,
        pins,
        models: async ({ provider }) => CATALOGS[provider] || null,
        setConversationModel(id, patch) {
            if (!conversations.has(id)) return { error: 'No such conversation.' };
            calls.pin.push({ id, patch });
            const next = { ...(pins.get(id) || {}) };
            for (const [key, value] of Object.entries(patch)) if (value) next[key] = value;
            pins.set(id, next);
            return { pinned: next };
        },
        observe(fn) {
            observers.add(fn);
            return () => observers.delete(fn);
        },
        emit(conversationId, event, extra = {}) {
            for (const fn of observers) {
                fn({ ...event, at: Date.now() }, {
                    conversationId,
                    agentId: 'agent-1',
                    title: conversations.get(conversationId)?.title || '',
                    runKind: 'interactive',
                    jobId: '',
                    busy: true,
                    remembering: false,
                    ...extra,
                });
            }
        },
        create({ agentId }) {
            counter += 1;
            const id = `conv-${counter}`;
            calls.create.push({ id, agentId });
            conversations.set(id, { id, agentId, title: `Chat ${counter}`, busy: false });
            return { conversationId: id };
        },
        history(id) {
            const found = conversations.get(id);
            return found
                ? { found: true, busy: found.busy, title: found.title, agentId: found.agentId, pinned: pins.get(id) || null }
                : { found: false };
        },
        list({ agentId }) {
            return [...conversations.values()]
                .filter(entry => !agentId || entry.agentId === agentId)
                .map(entry => ({ conversationId: entry.id, title: entry.title, busy: entry.busy }));
        },
        async send(id, text, images, tagged, files, options) {
            calls.send.push({ id, text, images, files, options });
            const conversation = conversations.get(id);
            if (conversation) conversation.busy = true;
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
            return pendingQuestions.delete(payload.requestId);
        },
    };
}

const fakeCrypt = {
    encrypt: value => `enc:${Buffer.from(value).toString('base64')}`,
    decrypt: stored => (stored.startsWith('enc:') ? Buffer.from(stored.slice(4), 'base64').toString('utf8') : ''),
};

/** The agents' settings as ai/settings.js answers them, and what was changed. */
function fakeSettings(overrides = {}) {
    const agents = {
        'agent-1': { provider: 'claude-code', model: '', effort: 'high', approval: 'writes', providers: ['claude-code', 'codex'], hiddenModels: {}, ...overrides },
        'agent-2': { provider: 'claude-code', model: 'sonnet', effort: 'medium', approval: 'always', providers: ['claude-code'], hiddenModels: {} },
    };
    const calls = { set: [], record: [] };
    return {
        agents,
        calls,
        get: (id) => {
            const key = agents[id] ? id : 'agent-1';
            return { ...agents[key], agentId: key };
        },
        set(patch, id) {
            calls.set.push({ patch, id });
            Object.assign(agents[id], patch);
            return { ...agents[id], agentId: id };
        },
        takePropagation: () => [],
    };
}

async function setup({ locked = { value: false }, jobs, settings = null } = {}) {
    const telegram = fakeTelegram();
    const base = await telegram.listen();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-channels-'));
    const config = createConfig({ dir, crypt: fakeCrypt });
    const section = config.section('telegram');
    const ai = fakeAi();
    const audits = [];
    const changes = [];
    const agentList = [{ id: 'agent-1', name: 'Acestino' }, { id: 'agent-2', name: 'Night Shift' }];
    const controls = settings ? createControls({
        ai,
        settings,
        record: entry => settings.calls.record.push(entry),
        catalogWait: 200,
    }) : null;
    const gateway = createTelegramGateway({
        section,
        ai,
        controls,
        agents: {
            list: () => agentList,
            activeId: () => 'agent-1',
            get: id => agentList.find(agent => agent.id === id) || null,
        },
        jobs: jobs || { get: () => null },
        isLocked: () => locked.value,
        scrub: text => String(text).split('SUPERSECRETVALUE').join('••••'),
        onChange: state => changes.push(state),
        audit: entry => audits.push(entry),
        apiFactory: token => createTelegramApi({ token, base }),
        pollTimeout: 1,
        progressInterval: 0,
        typingInterval: 60000,
        retryDelay: 50,
        conflictDelay: 100,
        lockCheck: 50,
        hostName: 'test-pc',
        log: { error: () => {} },
    });
    gateway.start();
    return { telegram, base, dir, config, ai, gateway, audits, changes, locked, settings };
}

async function pairOwner(env) {
    const connected = await env.gateway.connect({ token: TOKEN });
    assert.ok(connected.connected, connected.error);
    const status = env.gateway.pair();
    env.telegram.message(OWNER, `/start ${status.pairing.code}`);
    await until(() => env.gateway.status().owner, { label: 'pairing' });
    await until(() => env.telegram.sent('sendMessage').some(call => /Paired with Acestes/.test(call.body.text)), { label: 'welcome' });
    env.telegram.clear();
}

async function teardown(env) {
    env.gateway.stop();
    await env.telegram.close();
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

(async () => {
    console.log('\nchannels: formatting');

    await check('Markdown becomes the HTML Telegram takes, with everything else escaped', () => {
        const [html] = format.toMessages('Hello **world** and `x < y` and [docs](https://example.com/a?b=1&c=2) & <tags>');
        assert.strictEqual(html, 'Hello <b>world</b> and <code>x &lt; y</code> and <a href="https://example.com/a?b=1&amp;c=2">docs</a> &amp; &lt;tags&gt;');
    });

    await check('snake_case names are not read as italics', () => {
        const [html] = format.toMessages('run check_disk_space then _really_ go');
        assert.strictEqual(html, 'run check_disk_space then <i>really</i> go');
    });

    await check('a javascript: link stays text', () => {
        const [html] = format.toMessages('[click](javascript:alert(1))');
        assert.ok(!html.includes('<a'), html);
    });

    await check('code blocks keep their language; headings, lists and quotes are drawn', () => {
        const [html] = format.toMessages('# Result\n\n- one\n- **two**\n\n```bash\nls -la <dir>\n```\n\n> quoted *bit*');
        assert.ok(html.includes('<b>Result</b>'));
        assert.ok(html.includes('• one\n• <b>two</b>'));
        assert.ok(html.includes('<pre><code class="language-bash">ls -la &lt;dir&gt;</code></pre>'));
        assert.ok(html.includes('<blockquote>quoted <i>bit</i></blockquote>'));
    });

    await check('a chart is named rather than dropped, and a table keeps its columns', () => {
        const [html] = format.toMessages('```chart\n{"type":"bar","title":"Disk use on web1","data":[]}\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |');
        assert.ok(html.includes('[Chart: Disk use on web1.'), html);
        assert.ok(html.includes('<pre>| a | b |\n| 1 | 2 |</pre>'), html);
    });

    await check('a long reply is cut between blocks, and a long code block reopened around each piece', () => {
        const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${'word '.repeat(80)}`);
        const code = `\`\`\`\n${Array.from({ length: 300 }, (_, index) => `line ${index} ${'x'.repeat(30)}`).join('\n')}\n\`\`\``;
        const messages = format.toMessages(`${paragraphs.join('\n\n')}\n\n${code}`);
        assert.ok(messages.length > 3, `got ${messages.length}`);
        for (const message of messages) {
            assert.ok(message.length <= format.MESSAGE_LIMIT, `a message of ${message.length}`);
            assert.strictEqual((message.match(/<pre>/g) || []).length, (message.match(/<\/pre>/g) || []).length, 'pre tags balance');
            assert.strictEqual((message.match(/<b>/g) || []).length, (message.match(/<\/b>/g) || []).length, 'b tags balance');
        }
    });

    await check('one line longer than a message is cut as plain text', () => {
        const messages = format.toMessages('a'.repeat(9000));
        assert.ok(messages.length >= 3);
        assert.ok(messages.every(message => message.length <= format.MESSAGE_LIMIT));
    });

    await check('a step line names the tool and what it was pointed at', () => {
        assert.strictEqual(stepLine({ name: 'run_command', input: { command: 'systemctl status nginx', session: 's1' } }), 'run command: systemctl status nginx');
        assert.strictEqual(stepLine({ name: 'mcp__acestes__read_file', input: { path: '/etc/hosts' } }), 'read file: /etc/hosts');
        assert.strictEqual(stepLine({ name: 'list_hosts', input: {} }), 'list hosts');
    });

    console.log('\nchannels: config');

    await check('the credentials are stored encrypted and read back in the clear', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-channels-config-'));
        const config = createConfig({ dir, crypt: fakeCrypt });
        config.section('telegram').setCredentials({ token: TOKEN });
        const onDisk = fs.readFileSync(path.join(dir, 'channels.json'), 'utf8');
        assert.ok(!onDisk.includes(TOKEN), 'the token is not on disk in the clear');
        assert.strictEqual(config.reload().telegram.secret.startsWith('enc:'), true);
        assert.deepStrictEqual(config.section('telegram').credentials(), { token: TOKEN });
    });

    await check('a locked vault reads no credentials', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-channels-config-'));
        let locked = false;
        const config = createConfig({ dir, crypt: { encrypt: fakeCrypt.encrypt, decrypt: value => (locked ? '' : fakeCrypt.decrypt(value)) } });
        config.section('slack').setCredentials({ botToken: 'xoxb-1', appToken: 'xapp-1' });
        locked = true;
        assert.strictEqual(config.section('slack').credentials(), null);
    });

    await check('the first version\'s Telegram section is read as it was written', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-channels-config-'));
        fs.writeFileSync(path.join(dir, 'channels.json'), JSON.stringify({
            version: 1,
            telegram: { enabled: true, token: fakeCrypt.encrypt(TOKEN), bot: { id: 42, username: 'old_bot', name: 'Old' }, owner: { userId: 5001, chatId: 5001, name: 'Brad' }, offset: 77, chats: { 5001: { conversationId: 'conv-1' } } },
        }));
        const section = createConfig({ dir, crypt: fakeCrypt }).section('telegram');
        assert.deepStrictEqual(section.credentials(), { token: TOKEN });
        assert.strictEqual(section.get().identity.username, 'old_bot');
        assert.strictEqual(section.get().owner.userId, '5001');
        assert.strictEqual(section.get().cursor, '77');
        assert.strictEqual(section.chat('5001').conversationId, 'conv-1');
    });

    await check('junk in the file is dropped, not trusted', () => {
        const clean = cleanSection({ approvals: 'yolo', owner: { userId: '' }, chats: { 'not a chat/x': {}, 12: { conversationId: 'conv-1' } }, offset: -5 });
        assert.strictEqual(clean.approvals, 'ask');
        assert.strictEqual(clean.owner, null);
        assert.deepStrictEqual(Object.keys(clean.chats), ['12']);
        assert.strictEqual(clean.cursor, '');
    });

    console.log('\nchannels: Bot API client');

    await check('a rate limit is waited out and the call retried', async () => {
        const telegram = fakeTelegram();
        const base = await telegram.listen();
        try {
            telegram.fail('sendMessage', 429, 'Too Many Requests: retry after 1', 1, { retry_after: 1 });
            const api = createTelegramApi({ token: TOKEN, base });
            const started = Date.now();
            const sent = await api.sendMessage(1, 'hi');
            assert.ok(sent.message_id > 0);
            assert.ok(Date.now() - started >= 900, 'it waited');
        } finally {
            await telegram.close();
        }
    });

    await check('a refused token is a TelegramError with the status', async () => {
        const telegram = fakeTelegram();
        const base = await telegram.listen();
        try {
            const api = createTelegramApi({ token: '1:wrong', base });
            await assert.rejects(() => api.getMe(), error => error instanceof TelegramError && error.status === 401);
        } finally {
            await telegram.close();
        }
    });

    console.log('\nchannels: the gateway');

    await check('connecting checks the token with Telegram and starts listening', async () => {
        const env = await setup();
        try {
            const bad = await env.gateway.connect({ token: 'not a token' });
            assert.ok(bad.error);
            const result = await env.gateway.connect({ token: TOKEN });
            assert.strictEqual(result.connected, true);
            assert.strictEqual(result.identity.username, 'acestes_test_bot');
            await until(() => env.gateway.status().state === 'running', { label: 'running' });
            await until(() => env.telegram.sent('setMyCommands').length === 1, { label: 'commands' });
            assert.ok(env.audits.some(entry => entry.action === 'channels.telegram-connected'));
            assert.ok(!JSON.stringify(env.gateway.status()).includes(TOKEN), 'the status never carries the token');
        } finally {
            await teardown(env);
        }
    });

    await check('a stranger is ignored, and a wrong code pairs nobody', async () => {
        const env = await setup();
        try {
            await env.gateway.connect({ token: TOKEN });
            env.telegram.message(STRANGER, 'run rm everywhere');
            env.telegram.message(STRANGER, '/start NOTTHECODE');
            const status = env.gateway.pair();
            env.telegram.message(STRANGER, '/start WRONGCODE1');
            await sleep(300);
            assert.strictEqual(env.ai.calls.send.length, 0);
            assert.strictEqual(env.ai.calls.create.length, 0);
            assert.strictEqual(env.telegram.sent('sendMessage').length, 0, 'nothing is said to a stranger');
            assert.strictEqual(env.gateway.status().owner, null);
            assert.ok(status.pairing.link.startsWith('https://t.me/acestes_test_bot?start='));
        } finally {
            await teardown(env);
        }
    });

    await check('the code from the desktop pairs the account that sends it, once', async () => {
        const env = await setup();
        try {
            await env.gateway.connect({ token: TOKEN });
            const status = env.gateway.pair();
            env.telegram.message(OWNER, `/start ${status.pairing.code}`);
            await until(() => env.gateway.status().owner, { label: 'paired' });
            assert.strictEqual(env.gateway.status().owner.username, 'brad');
            assert.strictEqual(env.gateway.status().pairing, null, 'the code is spent');
            await until(() => env.telegram.sent('sendMessage').length >= 1, { label: 'welcome' });
            assert.ok(/Paired with Acestes on test-pc/.test(env.telegram.sent('sendMessage')[0].body.text));
            // The same code again, from someone else, pairs nobody new.
            env.telegram.message(STRANGER, `/start ${status.pairing.code}`);
            await sleep(200);
            assert.strictEqual(env.gateway.status().owner.username, 'brad');
            assert.ok(env.audits.some(entry => entry.action === 'channels.telegram-paired'));
        } finally {
            await teardown(env);
        }
    });

    await check('a message from the owner becomes a strict turn in a new conversation', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'how full is the disk on web1?');
            await until(() => env.ai.calls.send.length === 1, { label: 'send' });
            const [sent] = env.ai.calls.send;
            assert.strictEqual(sent.text, 'how full is the disk on web1?');
            assert.deepStrictEqual(sent.options, { channel: 'telegram', strict: true });
            assert.strictEqual(env.ai.calls.create[0].agentId, 'agent-1');
            await until(() => env.telegram.sent('sendChatAction').length >= 1, { label: 'typing' });

            // A second message goes to the same conversation.
            env.telegram.message(OWNER, 'and on web2?');
            await until(() => env.ai.calls.send.length === 2, { label: 'second send' });
            assert.strictEqual(env.ai.calls.send[1].id, sent.id);
            assert.strictEqual(env.ai.calls.create.length, 1);
        } finally {
            await teardown(env);
        }
    });

    await check('the turn is shown as it goes: progress edited in place, then the reply as a new message', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'check nginx');
            await until(() => env.ai.calls.send.length === 1, { label: 'send' });
            const id = env.ai.calls.send[0].id;

            env.ai.emit(id, { type: 'user-message', text: 'check nginx', channel: 'telegram' });
            env.ai.emit(id, { type: 'assistant-text', text: 'I will look at the service first.' });
            env.ai.emit(id, { type: 'tool-call', name: 'run_command', input: { command: 'systemctl status nginx' } });
            await until(() => env.telegram.sent('sendMessage').some(call => /Working/.test(call.body.text)), { label: 'progress' });
            env.ai.emit(id, { type: 'tool-call', name: 'read_file', input: { path: '/var/log/nginx/error.log' } });
            await until(() => env.telegram.sent('editMessageText').some(call => /error\.log/.test(call.body.text)), { label: 'progress edit' });

            env.ai.emit(id, { type: 'assistant-text', text: 'nginx is **running**. The token SUPERSECRETVALUE was in a log.' });
            env.ai.emit(id, { type: 'result', subtype: 'success', isError: false });
            await until(() => env.telegram.sent('sendMessage').some(call => /nginx is <b>running<\/b>/.test(call.body.text)), { label: 'reply' });
            await until(() => env.telegram.sent('editMessageText').some(call => /Done: 2 steps/.test(call.body.text)), { label: 'done line' });

            const replies = env.telegram.sent('sendMessage').map(call => call.body.text).join('\n');
            assert.ok(!replies.includes('I will look at the service first'), 'narration before a tool call is not the reply');
            assert.ok(!replies.includes('SUPERSECRETVALUE'), 'stored secrets are masked on the way out');
            const reply = env.telegram.sent('sendMessage').find(call => /nginx is/.test(call.body.text));
            assert.strictEqual(reply.body.parse_mode, 'HTML');
            assert.notStrictEqual(reply.body.disable_notification, true, 'the reply notifies');
        } finally {
            await teardown(env);
        }
    });

    await check('an approval card is answered from the phone, and says so', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'restart nginx');
            await until(() => env.ai.calls.send.length === 1, { label: 'send' });
            const id = env.ai.calls.send[0].id;
            env.ai.pendingApprovals.add('approve-1');
            env.ai.emit(id, { type: 'approval-request', requestId: 'approve-1', name: 'run_command', title: 'Run a command', host: 'web1', input: { command: 'systemctl restart nginx' } });
            await until(() => env.telegram.sent('sendMessage').some(call => /Approval needed/.test(call.body.text)), { label: 'card' });
            const card = env.telegram.sent('sendMessage').find(call => /Approval needed/.test(call.body.text));
            assert.ok(card.body.text.includes('systemctl restart nginx'));
            assert.ok(card.body.text.includes('<b>web1</b>'));
            const [approve, deny] = card.body.reply_markup.inline_keyboard[0];
            assert.strictEqual(approve.text, 'Approve');
            assert.strictEqual(deny.text, 'Deny');
            assert.ok(Buffer.byteLength(approve.callback_data) <= 64);

            // A stranger's press does nothing.
            env.telegram.press(STRANGER, approve.callback_data, 1);
            await sleep(150);
            assert.strictEqual(env.ai.calls.approvals.length, 0);

            env.telegram.press(OWNER, approve.callback_data, 1);
            await until(() => env.ai.calls.approvals.length === 1, { label: 'approval' });
            assert.deepStrictEqual(env.ai.calls.approvals[0], { requestId: 'approve-1', approved: true, by: 'telegram' });
            env.ai.emit(id, { type: 'approval-settled', requestId: 'approve-1', status: 'approved', by: 'telegram' });
            await until(() => env.telegram.sent('editMessageText').some(call => /<i>Approved\.<\/i>/.test(call.body.text)), { label: 'card settled' });
            const settled = env.telegram.sent('editMessageText').find(call => /Approved\./.test(call.body.text));
            assert.deepStrictEqual(settled.body.reply_markup, { inline_keyboard: [] }, 'the buttons go');
        } finally {
            await teardown(env);
        }
    });

    await check('a card answered at the desk says so on the phone', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'restart nginx');
            await until(() => env.ai.calls.send.length === 1, { label: 'send' });
            const id = env.ai.calls.send[0].id;
            env.ai.emit(id, { type: 'approval-request', requestId: 'approve-2', name: 'run_command', input: { command: 'reboot' } });
            await until(() => env.telegram.sent('sendMessage').some(call => /Approval needed/.test(call.body.text)), { label: 'card' });
            env.ai.emit(id, { type: 'approval-settled', requestId: 'approve-2', status: 'denied' });
            await until(() => env.telegram.sent('editMessageText').some(call => /Denied on the desktop/.test(call.body.text)), { label: 'settled' });
        } finally {
            await teardown(env);
        }
    });

    await check('a question takes a button or a typed answer; a secret is never asked for here', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'deploy it');
            await until(() => env.ai.calls.send.length === 1, { label: 'send' });
            const id = env.ai.calls.send[0].id;

            env.ai.pendingQuestions.add('ask-1');
            env.ai.emit(id, { type: 'question-request', requestId: 'ask-1', question: 'Which host?', options: ['web1', 'web2'] });
            await until(() => env.telegram.sent('sendMessage').some(call => /Which host\?/.test(call.body.text)), { label: 'question' });
            const card = env.telegram.sent('sendMessage').find(call => /Which host\?/.test(call.body.text));
            assert.deepStrictEqual(card.body.reply_markup.inline_keyboard.map(row => row[0].text), ['web1', 'web2']);
            env.telegram.press(OWNER, card.body.reply_markup.inline_keyboard[1][0].callback_data, 1);
            await until(() => env.ai.calls.questions.length === 1, { label: 'answer' });
            assert.deepStrictEqual(env.ai.calls.questions[0], { requestId: 'ask-1', answer: 'web2', chosen: true, by: 'telegram' });
            env.ai.emit(id, { type: 'question-settled', requestId: 'ask-1', status: 'answered', answer: 'web2', by: 'telegram' });

            env.ai.pendingQuestions.add('ask-2');
            env.ai.emit(id, { type: 'question-request', requestId: 'ask-2', question: 'What branch?', options: [] });
            await until(() => env.telegram.sent('sendMessage').some(call => /What branch\?/.test(call.body.text)), { label: 'free question' });
            env.telegram.message(OWNER, 'release/1.5');
            await until(() => env.ai.calls.questions.length === 2, { label: 'typed answer' });
            assert.strictEqual(env.ai.calls.questions[1].answer, 'release/1.5');
            assert.strictEqual(env.ai.calls.send.length, 1, 'a typed answer is not also sent as a message');
            env.ai.emit(id, { type: 'question-settled', requestId: 'ask-2', status: 'answered', answer: 'release/1.5', by: 'telegram' });

            env.ai.emit(id, { type: 'question-request', requestId: 'ask-3', question: 'The API key?', options: [], secret: true, secretName: 'deploy' });
            await until(() => env.telegram.sent('sendMessage').some(call => /needs a secret/.test(call.body.text)), { label: 'secret card' });
            const secret = env.telegram.sent('sendMessage').find(call => /needs a secret/.test(call.body.text));
            assert.ok(!secret.body.reply_markup, 'no buttons for a secret');
            env.telegram.message(OWNER, 'hunter2hunter2');
            await until(() => env.ai.calls.send.length === 2, { label: 'goes as a message' });
            assert.strictEqual(env.ai.calls.questions.length, 2, 'a typed message never answers a secret question');
        } finally {
            await teardown(env);
        }
    });

    await check('a message that arrives late is offered, not run', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'restart nginx', { date: Math.floor(Date.now() / 1000) - 3 * 60 * 60 });
            await until(() => env.telegram.sent('sendMessage').some(call => /has not been run/.test(call.body.text)), { label: 'offer' });
            assert.strictEqual(env.ai.calls.send.length, 0);
            const offer = env.telegram.sent('sendMessage').find(call => /has not been run/.test(call.body.text));
            assert.ok(/3h 0m/.test(offer.body.text), offer.body.text);
            const [run] = offer.body.reply_markup.inline_keyboard[0];
            env.telegram.press(OWNER, run.callback_data, 1);
            await until(() => env.ai.calls.send.length === 1, { label: 'run it now' });
            assert.strictEqual(env.ai.calls.send[0].text, 'restart nginx');
        } finally {
            await teardown(env);
        }
    });

    await check('the commands: /stop, /new, /agent, /status, /list', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'hello');
            await until(() => env.ai.calls.send.length === 1, { label: 'send' });
            const first = env.ai.calls.send[0].id;

            env.telegram.message(OWNER, '/stop');
            await until(() => env.ai.calls.interrupt.length === 1, { label: 'stop' });
            assert.strictEqual(env.ai.calls.interrupt[0], first);

            env.telegram.message(OWNER, '/status');
            await until(() => env.telegram.sent('sendMessage').some(call => /Acestino<\/b> on test-pc/.test(call.body.text)), { label: 'status' });
            assert.ok(env.telegram.sent('sendMessage').some(call => /every change asks here first/.test(call.body.text)));

            env.telegram.message(OWNER, '/agent night');
            await until(() => env.telegram.sent('sendMessage').some(call => /Talking to Night Shift/.test(call.body.text)), { label: 'agent' });
            env.telegram.message(OWNER, 'who are you?');
            await until(() => env.ai.calls.send.length === 2, { label: 'send to new agent' });
            assert.notStrictEqual(env.ai.calls.send[1].id, first, 'a new conversation');
            assert.strictEqual(env.ai.calls.create[1].agentId, 'agent-2');

            env.telegram.message(OWNER, '/new');
            await until(() => env.telegram.sent('sendMessage').some(call => /New conversation with Night Shift/.test(call.body.text)), { label: 'new' });

            env.telegram.message(OWNER, '/list');
            await until(() => env.telegram.sent('sendMessage').some(call => /Recent conversations/.test(call.body.text)), { label: 'list' });
            const list = env.telegram.sent('sendMessage').find(call => /Recent conversations/.test(call.body.text));
            assert.strictEqual(list.body.reply_markup.inline_keyboard.at(-1)[0].text, 'New conversation');

            // A command it does not know is the agent's, like a skill.
            env.telegram.message(OWNER, '/deploy staging');
            await until(() => env.ai.calls.send.length === 3, { label: 'unknown command' });
            assert.strictEqual(env.ai.calls.send[2].text, '/deploy staging');
        } finally {
            await teardown(env);
        }
    });

    await check('the desk speaking takes the turn back; the note-taking turn after one is not news', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, 'tidy the logs');
            await until(() => env.ai.calls.send.length === 1, { label: 'send' });
            const id = env.ai.calls.send[0].id;

            // The remember turn after a real one.
            env.ai.emit(id, { type: 'assistant-text', text: 'Logs tidied.' });
            env.ai.emit(id, { type: 'result', subtype: 'success', isError: false });
            await until(() => env.telegram.sent('sendMessage').some(call => /Logs tidied/.test(call.body.text)), { label: 'reply' });
            env.ai.emit(id, { type: 'user-message', text: 'Before we move on...' }, { remembering: true });
            env.ai.emit(id, { type: 'tool-call', name: 'remember', input: { text: 'x' } });
            env.ai.emit(id, { type: 'assistant-text', text: 'nothing to keep.' });
            env.ai.emit(id, { type: 'result', subtype: 'success', isError: false });
            await sleep(200);
            assert.ok(!env.telegram.sent('sendMessage').some(call => /nothing to keep/.test(call.body.text)));

            // Then the user types at the desk: the phone stops getting replies.
            env.ai.emit(id, { type: 'user-message', text: 'now the other one' });
            env.ai.emit(id, { type: 'assistant-text', text: 'Desk reply.' });
            env.ai.emit(id, { type: 'result', subtype: 'success', isError: false });
            await sleep(200);
            assert.ok(!env.telegram.sent('sendMessage').some(call => /Desk reply/.test(call.body.text)));
        } finally {
            await teardown(env);
        }
    });

    await check('nothing is read while the app is locked', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.locked.value = true;
            await until(() => env.gateway.status().state === 'locked', { label: 'locked' });
            const before = env.telegram.polls;
            env.telegram.message(OWNER, 'are you there?');
            await sleep(400);
            assert.strictEqual(env.ai.calls.send.length, 0);
            assert.ok(env.telegram.polls - before <= 1, 'no polling while locked');
            const told = await env.gateway.messageOwner({ text: 'hi' });
            assert.ok(told.error, 'nothing goes out either');
            env.locked.value = false;
            await until(() => env.ai.calls.send.length === 1, { timeout: 8000, label: 'read after unlock' });
        } finally {
            await teardown(env);
        }
    });

    await check('another program polling the bot is reported, not fought', async () => {
        const env = await setup();
        try {
            await env.gateway.connect({ token: TOKEN });
            env.telegram.fail('getUpdates', 409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running', 1);
            await until(() => env.gateway.status().state === 'conflict', { label: 'conflict' });
            await until(() => env.gateway.status().state === 'running', { label: 'recovers' });
        } finally {
            await teardown(env);
        }
    });

    await check('a revoked token stops the poll and says so', async () => {
        const env = await setup();
        try {
            await env.gateway.connect({ token: TOKEN });
            await until(() => env.gateway.status().state === 'running', { label: 'running' });
            env.telegram.fail('getUpdates', 401, 'Unauthorized', 5);
            await until(() => env.gateway.status().state === 'unauthorized', { label: 'unauthorized' });
        } finally {
            await teardown(env);
        }
    });

    await check('message_user reaches the paired phone, and fails plainly without one', async () => {
        const env = await setup();
        try {
            const none = await env.gateway.messageOwner({ text: 'build done' });
            assert.ok(/No Telegram account is paired/.test(none.error), none.error);
            await pairOwner(env);
            const sent = await env.gateway.messageOwner({ text: 'The build **passed**.', from: 'Acestino' });
            assert.deepStrictEqual(sent, { sent: true, channel: 'telegram' });
            assert.ok(env.telegram.sent('sendMessage').some(call => /<b>Acestino<\/b>\n\nThe build <b>passed<\/b>\./.test(call.body.text)));
        } finally {
            await teardown(env);
        }
    });

    await check('a job that asks for the phone gets its result and its approvals there', async () => {
        const job = { id: 'job-1', name: 'Nightly disk check', delivery: { channel: true } };
        const env = await setup({ jobs: { get: id => (id === 'job-1' ? job : null) } });
        try {
            await pairOwner(env);
            env.ai.emit('conv-job', { type: 'approval-request', requestId: 'approve-9', name: 'run_command', input: { command: 'apt-get clean' } },
                { runKind: 'job', jobId: 'job-1', title: 'Nightly disk check' });
            await until(() => env.telegram.sent('sendMessage').some(call => /job: Nightly disk check/.test(call.body.text)), { label: 'job card' });

            env.gateway.deliverJob(job, { status: 'done', result: { summary: 'All disks under 70%.' } });
            await until(() => env.telegram.sent('sendMessage').some(call => /<b>Nightly disk check<\/b> finished/.test(call.body.text)), { label: 'result' });

            env.gateway.deliverJob({ ...job, delivery: { channel: false } }, { status: 'done', result: { summary: 'quiet' } });
            env.ai.emit('conv-job-2', { type: 'approval-request', requestId: 'approve-10', name: 'run_command', input: { command: 'x' } },
                { runKind: 'job', jobId: 'job-other' });
            await sleep(200);
            assert.ok(!env.telegram.sent('sendMessage').some(call => /quiet/.test(call.body.text)));
            assert.strictEqual(env.telegram.sent('sendMessage').filter(call => /Approval needed/.test(call.body.text)).length, 1);
        } finally {
            await teardown(env);
        }
    });

    await check('a text file and a photo are passed on; a voice note is declined', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, undefined, { caption: 'what is in this?', document: { file_id: 'f1', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 30 } });
            await until(() => env.ai.calls.send.length === 1, { label: 'file' });
            assert.strictEqual(env.ai.calls.send[0].text, 'what is in this?');
            assert.deepStrictEqual(env.ai.calls.send[0].files, [{ name: 'notes.txt', mediaType: 'text/plain', text: 'hello from a text file\n' }]);

            env.telegram.message(OWNER, undefined, { photo: [{ file_id: 'p1', width: 90, height: 90, file_size: 1000 }, { file_id: 'p2', width: 800, height: 600, file_size: 50000 }] });
            await until(() => env.ai.calls.send.length === 2, { label: 'photo' });
            assert.strictEqual(env.ai.calls.send[1].images[0].mediaType, 'image/jpeg');
            assert.strictEqual(Buffer.from(env.ai.calls.send[1].images[0].data, 'base64').toString(), 'hello from a text file\n');

            env.telegram.message(OWNER, undefined, { voice: { file_id: 'v1', duration: 3 } });
            await until(() => env.telegram.sent('sendMessage').some(call => /Voice notes are not supported/.test(call.body.text)), { label: 'voice' });
            assert.strictEqual(env.ai.calls.send.length, 2);
        } finally {
            await teardown(env);
        }
    });

    await check('unpairing and disconnecting forget the account and the token', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            await env.gateway.unpair();
            assert.strictEqual(env.gateway.status().owner, null);
            env.telegram.message(OWNER, 'still there?');
            await sleep(300);
            assert.strictEqual(env.ai.calls.send.length, 0, 'an unpaired account is a stranger');
            env.gateway.disconnect();
            assert.strictEqual(env.gateway.status().connected, false);
            assert.strictEqual(env.config.reload().telegram.secret, '');
            assert.strictEqual(env.gateway.keepAlive(), false);
        } finally {
            await teardown(env);
        }
    });

    console.log('\nchannels: model, effort and mode');

    const sentText = (env, pattern) => env.telegram.sent('sendMessage').find(call => pattern.test(call.body.text));
    const editedText = (env, pattern) => env.telegram.sent('editMessageText').find(call => pattern.test(call.body.text));
    const buttonsOf = call => call.body.reply_markup.inline_keyboard.flat();

    await check('efforts and modes are read the way they are typed', () => {
        assert.strictEqual(readEffort('Extra high'), 'xhigh');
        assert.strictEqual(readEffort('x-high'), 'xhigh');
        assert.strictEqual(readEffort('MAX'), 'max');
        assert.strictEqual(readEffort('loud'), '');
        assert.strictEqual(readMode('yolo'), 'never');
        assert.strictEqual(readMode('Full access'), 'full');
        assert.strictEqual(readMode('ask'), 'always');
        assert.strictEqual(readMode('workspace'), 'writes');
        assert.strictEqual(readMode('reckless'), '');
        // Rounded down onto a model's scale, as the runtime does.
        assert.strictEqual(nearestEffort(effortStops({ effort: ['low', 'medium', 'high'] }), 'max'), 'high');
        assert.strictEqual(nearestEffort(effortStops({ effort: ['low', 'medium', 'high', 'xhigh'] }), 'max'), 'xhigh');
    });

    await check('/status names the model, the effort and the mode, with buttons for each', async () => {
        const env = await setup({ settings: fakeSettings({ approval: 'never' }) });
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, '/status');
            await until(() => sentText(env, /Model:/), { label: 'status' });
            const status = sentText(env, /Model:/);
            assert.ok(/<b>Model:<\/b> Opus 5\.5 \(Claude Code\) · High effort/.test(status.body.text), status.body.text);
            // Yolo on the agent, held to Workspace only for turns from the phone.
            assert.ok(/<b>Mode:<\/b> Workspace only from here \(Yolo Mode on the desktop/.test(status.body.text), status.body.text);
            assert.deepStrictEqual(buttonsOf(status).map(button => button.text), ['Model', 'Effort', 'Mode']);
            assert.ok(buttonsOf(status).every(button => Buffer.byteLength(button.callback_data) <= 64));
        } finally {
            await teardown(env);
        }
    });

    await check('a mode picked on the phone is the chat\'s conversation\'s, and applies on the phone too', async () => {
        const env = await setup({ settings: fakeSettings({ approval: 'never' }) });
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, '/status');
            await until(() => sentText(env, /Model:/), { label: 'status' });
            env.telegram.press(OWNER, 's:mode', sentText(env, /Model:/).messageId);
            await until(() => sentText(env, /do here without asking/), { label: 'mode menu' });
            const menu = sentText(env, /do here without asking/);
            assert.deepStrictEqual(buttonsOf(menu).map(button => button.text), ['Ask every time', 'Workspace only', '> Yolo Mode', 'Full Access']);
            assert.ok(/held to Workspace only/.test(menu.body.text), menu.body.text);

            // The same mode, picked here: nothing to change, but the phone's
            // hold is lifted so Yolo means Yolo here too. The chat gets a
            // conversation to hold its mode.
            env.telegram.press(OWNER, 'p:never', menu.messageId);
            await until(() => editedText(env, /Yolo Mode/), { label: 'mode settled' });
            assert.strictEqual(env.gateway.status().approvals, 'agent');
            assert.strictEqual(env.ai.calls.create.length, 1);
            assert.strictEqual(env.ai.calls.pin.length, 0, 'nothing moved');
            assert.ok(env.audits.some(entry => entry.action === 'channels.telegram-approvals'));

            env.telegram.clear();
            env.telegram.message(OWNER, '/status');
            await until(() => sentText(env, /Model:/), { label: 'status after' });
            assert.ok(/<b>Mode:<\/b> Yolo Mode, nothing stops/.test(sentText(env, /Model:/).body.text));

            // Typed, and a real change: pinned on the conversation and
            // logged, with the agent's own setting left alone.
            const id = env.ai.calls.create[0].id;
            env.telegram.message(OWNER, '/mode full access');
            await until(() => sentText(env, /<b>Mode:<\/b> Full Access/), { label: 'full access' });
            assert.deepStrictEqual(env.ai.pins.get(id), { approval: 'full' });
            assert.deepStrictEqual(env.settings.calls.record[0].changes, [{ field: 'approvals', from: 'never', to: 'full' }]);
            assert.strictEqual(env.settings.calls.set.length, 0);
            assert.strictEqual(env.settings.agents['agent-1'].approval, 'never');

            env.telegram.clear();
            env.telegram.message(OWNER, '/status');
            await until(() => sentText(env, /Model:/), { label: 'status in full access' });
            assert.ok(/<b>Mode:<\/b> Full Access/.test(sentText(env, /Model:/).body.text), sentText(env, /Model:/).body.text);

            env.telegram.message(OWNER, '/mode reckless');
            await until(() => sentText(env, /is not a mode/), { label: 'unknown mode' });
            assert.strictEqual(env.ai.pins.get(id).approval, 'full');
        } finally {
            await teardown(env);
        }
    });

    await check('the model and the effort are pinned on the chat\'s conversation', async () => {
        const env = await setup({ settings: fakeSettings({ hiddenModels: { 'claude-code': ['haiku'] } }) });
        try {
            await pairOwner(env);
            // No conversation yet: the menu starts one when a model is picked.
            env.telegram.message(OWNER, '/model');
            await until(() => sentText(env, /Which model/), { label: 'model menu' });
            const menu = sentText(env, /Which model/);
            const labels = buttonsOf(menu).map(button => button.text);
            assert.deepStrictEqual(labels, ['> Claude Code: Opus 5.5', 'Claude Code: Sonnet 5', 'Codex: GPT-5.5'], 'haiku is hidden');

            const sonnet = buttonsOf(menu)[1];
            env.telegram.press(OWNER, sonnet.callback_data, menu.messageId);
            await until(() => editedText(env, /Switched to/), { label: 'switched' });
            assert.ok(/Switched to <b>Sonnet 5<\/b> · High effort/.test(editedText(env, /Switched to/).body.text));
            assert.strictEqual(env.ai.calls.create.length, 1);
            const id = env.ai.calls.create[0].id;
            assert.deepStrictEqual(env.ai.pins.get(id), { provider: 'claude-code', model: 'sonnet', effort: 'high' });

            // A level the model does not take is refused, with what it takes.
            env.telegram.message(OWNER, '/effort xhigh');
            await until(() => sentText(env, /Could not change the effort/), { label: 'effort refused' });
            assert.ok(/Sonnet 5 takes low, medium, high/.test(sentText(env, /Could not change the effort/).body.text));

            // By name, with an effort: the same conversation, not a new one.
            env.telegram.message(OWNER, '/model opus max');
            await until(() => sentText(env, /Switched to <b>Opus 5\.5<\/b> · Max effort/), { label: 'opus max' });
            assert.deepStrictEqual(env.ai.pins.get(id), { provider: 'claude-code', model: 'opus', effort: 'max' });
            assert.strictEqual(env.ai.calls.create.length, 1);

            // Onto a model without Max: rounded down, as the runtime would.
            env.telegram.message(OWNER, '/model gpt');
            await until(() => sentText(env, /Switched to <b>GPT-5\.5<\/b> · Extra high effort/), { label: 'gpt' });
            assert.deepStrictEqual(env.ai.pins.get(id), { provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' });

            env.telegram.message(OWNER, '/effort');
            await until(() => sentText(env, /How hard should/), { label: 'effort menu' });
            const efforts = sentText(env, /How hard should/);
            assert.deepStrictEqual(buttonsOf(efforts).map(button => button.text), ['Low', 'Medium', 'High', '> Extra high']);
            env.telegram.press(OWNER, 'e:low', efforts.messageId);
            await until(() => editedText(env, /at <b>Low<\/b> effort/), { label: 'effort low' });
            assert.strictEqual(env.ai.pins.get(id).effort, 'low');

            env.telegram.message(OWNER, '/model banana');
            await until(() => sentText(env, /No model matching/), { label: 'no match' });
        } finally {
            await teardown(env);
        }
    });

    await check('without the controls, the commands are the agent\'s and /status says what it can', async () => {
        const env = await setup();
        try {
            await pairOwner(env);
            env.telegram.message(OWNER, '/model opus');
            await until(() => env.ai.calls.send.length === 1, { label: 'passed on' });
            assert.strictEqual(env.ai.calls.send[0].text, '/model opus');
        } finally {
            await teardown(env);
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    process.exit(0);
})();
