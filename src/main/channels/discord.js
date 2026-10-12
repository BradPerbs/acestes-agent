const format = require('./format');

/**
 * Discord, as a channel: a bot of the user's own from the Developer Portal,
 * talked to in a direct message.
 *
 * Inbound is the Gateway, a WebSocket the app opens, so nothing has to be
 * reachable from outside. It identifies with the direct-messages intent and
 * nothing else: no server is read, and a DM's content arrives without the
 * privileged message-content intent, which Discord exempts DMs from. A DM
 * sent while the app was closed is not replayed by the Gateway, so on each
 * connect the paired DM's history since the last message seen is read
 * through the REST API instead.
 *
 * Commands are registered as slash commands usable in DMs with the bot
 * (`contexts: [BOT_DM]`); Discord shows them only to someone who shares a
 * server with it, which is also what lets them open a DM at all. A command
 * is answered by turning its first reply into the interaction's response.
 * Buttons are message components, acknowledged at once so a slow turn never
 * shows "This interaction failed".
 */

const DEFAULT_API = 'https://discord.com/api/v10';
const DEFAULT_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** DIRECT_MESSAGES. Nothing from servers. */
const INTENTS = 1 << 12;

const FLAG_SUPPRESS_EMBEDS = 1 << 2;
const FLAG_SUPPRESS_NOTIFICATIONS = 1 << 12;
const FLAG_EPHEMERAL = 1 << 6;
const FLAG_VOICE_MESSAGE = 1 << 13;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;

const COMMANDS = [
    { name: 'new', description: 'Start a new conversation' },
    { name: 'list', description: 'Pick up a recent conversation' },
    { name: 'stop', description: 'Stop the agent' },
    { name: 'status', description: 'What the agent is doing' },
    {
        name: 'agent',
        description: 'Choose which agent to talk to',
        options: [{ type: 3, name: 'name', description: 'The agent\'s name', required: false }],
    },
    { name: 'help', description: 'What this bot can do' },
].map(command => ({ type: 1, contexts: [1], integration_types: [0], ...command }));

const STYLES = { primary: 1, secondary: 2, success: 3, danger: 4 };

function failure(message, kind) {
    const error = new Error(message);
    if (kind) error.kind = kind;
    return error;
}

const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
        clearTimeout(timer);
        resolve();
    }, { once: true });
});

function deadline(ms, signal) {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The REST API, with the bot's token, rate limits waited out twice. */
function createDiscordRest({ token, base = DEFAULT_API, fetchImpl = globalThis.fetch }) {
    async function call(method, route, body, { form = null, signal, timeout = 20000 } = {}) {
        for (let attempt = 0; ; attempt += 1) {
            const init = {
                method,
                headers: { Authorization: `Bot ${token}`, 'User-Agent': 'DiscordBot (https://tryacestes.com, 1) Acestes' },
                signal: deadline(timeout, signal),
            };
            if (form) {
                init.body = form;
            } else if (body !== undefined) {
                init.headers['Content-Type'] = 'application/json';
                init.body = JSON.stringify(body);
            }
            let response;
            try {
                response = await fetchImpl(`${base}${route}`, init);
            } catch (error) {
                throw new Error(`Could not reach Discord (${error?.name === 'TimeoutError' ? 'timed out' : error?.cause?.code || error?.message || 'failed'})`);
            }
            if (response.status === 204) return null;
            let data = null;
            try {
                data = await response.json();
            } catch {
                data = null;
            }
            if (response.status === 429 && attempt < 2) {
                const wait = Number(data?.retry_after) || 1;
                if (wait <= 30) {
                    await sleep(wait * 1000, signal);
                    continue;
                }
            }
            if (!response.ok) {
                const error = new Error(data?.message ? `Discord: ${data.message}` : `Discord answered ${response.status}`);
                error.status = response.status;
                error.code = data?.code;
                throw error;
            }
            return data;
        }
    }
    return {
        call,
        get: (route, options) => call('GET', route, undefined, options),
        post: (route, body, options) => call('POST', route, body, options),
        patch: (route, body, options) => call('PATCH', route, body, options),
        put: (route, body, options) => call('PUT', route, body, options),
        delete: (route, options) => call('DELETE', route, undefined, options),
    };
}

/** The gateway's rows of buttons as Discord's: at most five to a row, five rows. */
function components(buttons) {
    if (!buttons) return [];
    let rows = [];
    for (const row of buttons) {
        for (let at = 0; at < row.length; at += 5) rows.push(row.slice(at, at + 5));
    }
    if (rows.length > 5) {
        const all = rows.flat();
        rows = [];
        for (let at = 0; at < all.length && rows.length < 5; at += 5) rows.push(all.slice(at, at + 5));
    }
    return rows.map(row => ({
        type: 1,
        components: row.map(button => ({
            type: 2,
            style: STYLES[button.style] || STYLES.secondary,
            label: format.clip(button.text, 80),
            custom_id: String(button.data).slice(0, 100),
        })),
    }));
}

const author = user => ({
    id: String(user?.id || ''),
    name: user?.global_name || user?.username || '',
    username: user?.username || '',
    bot: Boolean(user?.bot),
});

/** A Discord message as the gateway reads one. */
function readMessage(message) {
    const voice = (Number(message.flags) & FLAG_VOICE_MESSAGE) !== 0;
    return {
        type: 'message',
        id: String(message.id),
        chatId: String(message.channel_id),
        private: !message.guild_id,
        from: author(message.author),
        text: message.content || '',
        date: Date.parse(message.timestamp) || Date.now(),
        attachments: (message.attachments || []).map((item) => {
            const type = String(item.content_type || '').split(';')[0].toLowerCase();
            return {
                kind: voice || type.startsWith('audio/') ? 'voice' : type.startsWith('image/') ? 'image' : 'file',
                name: item.filename || 'file',
                mediaType: type,
                size: Number(item.size) || 0,
                ref: item.url,
            };
        }),
    };
}

const bySnowflake = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

function createDiscordAdapter({ apiBase = DEFAULT_API, gatewayUrl = DEFAULT_GATEWAY, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch } = {}) {
    const rest = token => createDiscordRest({ token, base: apiBase, fetchImpl });

    return {
        name: 'discord',
        label: 'Discord',
        target: 'discord',
        prefix: '/',
        typing: true,

        prepare(raw) {
            const token = String(raw?.token || '').trim().replace(/^Bot\s+/i, '');
            if (!TOKEN_SHAPE.test(token)) {
                return { error: 'That does not look like a bot token. Discord shows it under your application, Bot, Reset Token.' };
            }
            return { credentials: { token } };
        },

        async verify({ token }) {
            const api = rest(token);
            let me;
            let application;
            try {
                me = await api.get('/users/@me');
                application = await api.get('/oauth2/applications/@me');
            } catch (error) {
                if (error.status === 401) throw failure('Discord did not accept that token. Reset it under Bot in the Developer Portal and copy it again.');
                throw failure(error?.message || 'Discord could not be reached.');
            }
            if (!me?.bot) throw failure('That token does not belong to a bot.');
            return {
                id: String(me.id),
                username: me.username,
                name: me.global_name || application?.name || me.username,
                applicationId: String(application?.id || ''),
            };
        },

        /** Where to add the bot to a server, which is what lets the user DM it. */
        setup: identity => ({
            inviteUrl: identity.applicationId
                ? `https://discord.com/oauth2/authorize?client_id=${identity.applicationId}&scope=bot%20applications.commands&permissions=0`
                : '',
        }),

        pairLink: identity => `https://discord.com/users/${identity.id}`,
        pairText: (identity, code) => `pair ${code}`,

        client({ token }, identity = {}) {
            const api = rest(token);
            const applicationId = identity.applicationId || '';
            /** chatId -> the slash command waiting for its first reply. */
            const waiting = new Map();
            let registered = false;

            async function respond(interaction, body) {
                return api.post(`/interactions/${interaction.id}/${interaction.token}/callback`, body);
            }

            return {
                async listen({ signal, cursor, owner, emit, setCursor, onReady }) {
                    if (!registered && applicationId) {
                        registered = true;
                        api.put(`/applications/${applicationId}/commands`, COMMANDS).catch(() => { registered = false; });
                    }

                    // Everything inbound is handled one at a time, in order.
                    let queue = Promise.resolve();
                    const deliver = event => (queue = queue.then(() => emit(event)).catch(() => {}));

                    await new Promise((resolve, reject) => {
                        let socket;
                        try {
                            socket = new WebSocketImpl(gatewayUrl);
                        } catch (error) {
                            reject(new Error(`Could not reach Discord (${error?.message || 'failed'})`));
                            return;
                        }
                        let sequence = null;
                        let heartbeat = null;
                        let acknowledged = true;
                        let settled = false;

                        const finish = (error) => {
                            if (settled) return;
                            settled = true;
                            if (heartbeat) clearTimeout(heartbeat);
                            signal.removeEventListener('abort', onAbort);
                            try {
                                socket.close(1000);
                            } catch {
                                // Already closed.
                            }
                            if (error) reject(error);
                            else resolve();
                        };
                        const onAbort = () => finish();
                        signal.addEventListener('abort', onAbort, { once: true });
                        if (signal.aborted) {
                            finish();
                            return;
                        }

                        const op = (code, data) => {
                            try {
                                socket.send(JSON.stringify({ op: code, d: data }));
                            } catch {
                                // The close handler deals with a dead socket.
                            }
                        };

                        const catchUp = async () => {
                            if (!owner?.chatId || !cursor) return;
                            let missed;
                            try {
                                missed = await api.get(`/channels/${owner.chatId}/messages?after=${encodeURIComponent(cursor)}&limit=50`, { signal });
                            } catch {
                                return;
                            }
                            for (const message of (Array.isArray(missed) ? missed : []).sort(bySnowflake)) {
                                if (message.author?.bot) continue;
                                setCursor(message.id);
                                deliver(readMessage(message));
                            }
                        };

                        const dispatch = (type, data) => {
                            if (type === 'READY') {
                                onReady();
                                catchUp();
                                return;
                            }
                            if (type === 'MESSAGE_CREATE') {
                                if (data.guild_id || data.author?.bot) return;
                                setCursor(data.id);
                                deliver(readMessage(data));
                                return;
                            }
                            if (type !== 'INTERACTION_CREATE') return;
                            const user = author(data.user || data.member?.user);
                            const chatId = String(data.channel_id || data.channel?.id || '');
                            if (data.type === 3) {
                                // Acknowledged now; what the press did shows on the card.
                                respond(data, { type: 6 }).catch(() => {});
                                deliver({
                                    type: 'button',
                                    chatId,
                                    from: user,
                                    data: data.data?.custom_id || '',
                                    messageId: String(data.message?.id || ''),
                                    ack: text => (text && applicationId
                                        ? api.post(`/webhooks/${applicationId}/${data.token}`, { content: text, flags: FLAG_EPHEMERAL })
                                        : null),
                                });
                                return;
                            }
                            if (data.type === 2) {
                                // "Thinking" until the command's first reply, which takes its place.
                                respond(data, { type: 5 }).catch(() => {});
                                waiting.set(chatId, { token: data.token, used: false });
                                deliver({
                                    type: 'command',
                                    id: String(data.id),
                                    chatId,
                                    private: !data.guild_id,
                                    from: user,
                                    name: data.data?.name || '',
                                    argument: data.data?.options?.[0]?.value || '',
                                    date: Date.now(),
                                    done: async () => {
                                        const pending = waiting.get(chatId);
                                        if (!pending || pending.token !== data.token) return;
                                        waiting.delete(chatId);
                                        if (!pending.used && applicationId) {
                                            await api.delete(`/webhooks/${applicationId}/${data.token}/messages/@original`).catch(() => {});
                                        }
                                    },
                                });
                            }
                        };

                        socket.addEventListener('message', (message) => {
                            let packet;
                            try {
                                packet = JSON.parse(typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8'));
                            } catch {
                                return;
                            }
                            if (packet.s !== null && packet.s !== undefined) sequence = packet.s;
                            switch (packet.op) {
                                case 10: {
                                    const interval = Number(packet.d?.heartbeat_interval) || 41250;
                                    const beat = () => {
                                        if (!acknowledged) {
                                            finish(new Error('Discord stopped answering'));
                                            return;
                                        }
                                        acknowledged = false;
                                        op(1, sequence);
                                        heartbeat = setTimeout(beat, interval);
                                    };
                                    heartbeat = setTimeout(beat, Math.floor(interval * Math.random()));
                                    op(2, {
                                        token,
                                        intents: INTENTS,
                                        properties: { os: process.platform, browser: 'Acestes', device: 'Acestes' },
                                    });
                                    break;
                                }
                                case 11:
                                    acknowledged = true;
                                    break;
                                case 1:
                                    op(1, sequence);
                                    break;
                                case 7:
                                    // Asked to reconnect: the loop opens a new connection.
                                    finish();
                                    break;
                                case 9:
                                    finish(new Error('Discord ended the session'));
                                    break;
                                case 0:
                                    dispatch(packet.t, packet.d || {});
                                    break;
                                default:
                                    break;
                            }
                        });

                        socket.addEventListener('close', (event) => {
                            if (settled) return;
                            if (event.code === 4004) {
                                finish(failure('Discord no longer accepts this bot\'s token. Connect the bot again.', 'auth'));
                            } else if (event.code === 4013 || event.code === 4014) {
                                finish(failure('Discord refused the bot\'s permissions for direct messages.', 'fatal'));
                            } else {
                                finish(new Error(`Discord closed the connection (${event.code || 'no code'})`));
                            }
                        });
                        socket.addEventListener('error', () => {
                            // A close always follows; that is where it is handled.
                        });
                    });
                    await queue;
                },

                async send(chatId, { markdown, formatted, buttons, silent }) {
                    const content = format.truncate((formatted ?? format.toText(markdown, 'discord')).replace(/\s+$/, ''), 2000)
                        || '\u200b';
                    const pending = waiting.get(chatId);
                    if (pending && !pending.used && applicationId) {
                        pending.used = true;
                        const message = await api.patch(`/webhooks/${applicationId}/${pending.token}/messages/@original`, {
                            content,
                            components: components(buttons),
                            allowed_mentions: { parse: [] },
                        });
                        return { id: String(message?.id || '') };
                    }
                    const message = await api.post(`/channels/${chatId}/messages`, {
                        content,
                        components: components(buttons),
                        allowed_mentions: { parse: [] },
                        flags: FLAG_SUPPRESS_EMBEDS | (silent ? FLAG_SUPPRESS_NOTIFICATIONS : 0),
                    });
                    return { id: String(message?.id || '') };
                },

                async edit(chatId, messageId, { markdown, formatted, buttons }) {
                    const content = format.truncate((formatted ?? format.toText(markdown, 'discord')).replace(/\s+$/, ''), 2000) || '\u200b';
                    await api.patch(`/channels/${chatId}/messages/${messageId}`, {
                        content,
                        components: components(buttons),
                        allowed_mentions: { parse: [] },
                    });
                },

                typing: chatId => api.post(`/channels/${chatId}/typing`),

                sendFile(chatId, { name, text, caption = '' }) {
                    const form = new FormData();
                    form.append('payload_json', JSON.stringify({ content: caption, attachments: [{ id: 0, filename: name }], allowed_mentions: { parse: [] } }));
                    form.append('files[0]', new Blob([String(text)], { type: 'text/markdown' }), name);
                    return api.call('POST', `/channels/${chatId}/messages`, undefined, { form, timeout: 60000 });
                },

                async fetch(attachment, maxBytes) {
                    if (attachment.size > maxBytes) throw new Error('The file is too large');
                    let response;
                    try {
                        response = await fetchImpl(attachment.ref, { signal: AbortSignal.timeout(60000) });
                    } catch (error) {
                        throw new Error(`Could not download the file (${error?.cause?.code || error?.message || 'failed'})`);
                    }
                    if (!response.ok) throw new Error(`Could not download the file (${response.status})`);
                    const buffer = Buffer.from(await response.arrayBuffer());
                    if (buffer.length > maxBytes) throw new Error('The file is too large');
                    return buffer;
                },
            };
        },
    };
}

module.exports = { createDiscordAdapter, createDiscordRest, components, COMMANDS, INTENTS };
