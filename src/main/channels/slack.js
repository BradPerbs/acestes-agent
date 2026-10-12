const format = require('./format');

/**
 * Slack, as a channel: a Slack app of the user's own, in their workspace,
 * talked to in its Messages tab.
 *
 * Inbound is Socket Mode: the app opens a WebSocket with the app-level
 * token (`xapp-`), so nothing has to be reachable from outside. Every
 * envelope is acknowledged at once, as Slack asks. Outbound is the Web API
 * with the bot token (`xoxb-`). Slack does not replay what arrived while
 * the socket was closed, so on each connect the paired DM's history since
 * the last message seen is read instead.
 *
 * The app is set up from the manifest below, which asks for no more than
 * this needs: reading and writing its own DMs, reading files sent there,
 * and the names of who wrote. Slack reserves anything starting with "/" for
 * its own commands, so the gateway's commands are typed with "!" here. Bots
 * have no typing indicator in Slack; the progress message does that job.
 */

const DEFAULT_API = 'https://slack.com/api';

/** What the user pastes into "Create an app, From a manifest". */
const MANIFEST = {
    display_information: {
        name: 'Acestes',
        description: 'Your Acestes agent, answering from your computer.',
    },
    features: {
        app_home: {
            home_tab_enabled: false,
            messages_tab_enabled: true,
            messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: 'Acestes', always_online: true },
    },
    oauth_config: {
        scopes: { bot: ['chat:write', 'im:history', 'im:read', 'im:write', 'files:read', 'users:read'] },
    },
    settings: {
        event_subscriptions: { bot_events: ['message.im'] },
        interactivity: { is_enabled: true },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
    },
};

const AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'token_expired', 'not_allowed_token_type']);

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

/** The Web API with one token. Form-encoded, which every method takes. */
function createSlackApi({ token, base = DEFAULT_API, fetchImpl = globalThis.fetch }) {
    async function call(method, params = {}, { signal, timeout = 20000 } = {}) {
        for (let attempt = 0; ; attempt += 1) {
            const body = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) {
                if (value === undefined || value === null) continue;
                body.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
            }
            let response;
            try {
                response = await fetchImpl(`${base}/${method}`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body,
                    signal: deadline(timeout, signal),
                });
            } catch (error) {
                throw new Error(`Could not reach Slack (${error?.name === 'TimeoutError' ? 'timed out' : error?.cause?.code || error?.message || 'failed'})`);
            }
            if (response.status === 429 && attempt < 2) {
                const wait = Number(response.headers.get('retry-after')) || 1;
                if (wait <= 30) {
                    await sleep(wait * 1000, signal);
                    continue;
                }
            }
            let data = null;
            try {
                data = await response.json();
            } catch {
                data = null;
            }
            if (!data?.ok) {
                const error = new Error(`Slack: ${data?.error || `answered ${response.status}`}`);
                error.code = data?.error || '';
                error.status = response.status;
                throw error;
            }
            return data;
        }
    }
    return { call };
}

/** Slack's own escaping and link syntax, back to what the user typed. */
function plainText(text) {
    return String(text || '')
        .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
        .replace(/<(https?:\/\/[^>]+)>/g, '$1')
        .replace(/<mailto:([^|>]+)\|[^>]+>/g, '$1')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function blocks(text, buttons) {
    if (!buttons) return [];
    const elements = buttons.flat().slice(0, 25).map(button => ({
        type: 'button',
        text: { type: 'plain_text', text: format.clip(button.text, 75), emoji: true },
        action_id: String(button.data).slice(0, 255),
        value: String(button.data).slice(0, 2000),
        ...(button.style === 'success' || button.style === 'primary' ? { style: 'primary' } : {}),
        ...(button.style === 'danger' ? { style: 'danger' } : {}),
    }));
    return [
        { type: 'section', text: { type: 'mrkdwn', text: format.truncate(text, 3000) } },
        { type: 'actions', elements },
    ];
}

function createSlackAdapter({ apiBase = DEFAULT_API, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch } = {}) {
    const api = token => createSlackApi({ token, base: apiBase, fetchImpl });

    return {
        name: 'slack',
        label: 'Slack',
        target: 'slack',
        prefix: '!',
        typing: false,
        manifest: MANIFEST,

        prepare(raw) {
            const botToken = String(raw?.botToken || '').trim();
            const appToken = String(raw?.appToken || '').trim();
            if (!/^xoxb-[\w-]{10,}$/.test(botToken)) {
                return { error: 'The bot token starts with xoxb-. Slack shows it under OAuth & Permissions once the app is installed.' };
            }
            if (!/^xapp-[\w-]{10,}$/.test(appToken)) {
                return { error: 'The app-level token starts with xapp-. Make one under Basic Information, App-Level Tokens, with connections:write.' };
            }
            return { credentials: { botToken, appToken } };
        },

        async verify({ botToken, appToken }) {
            let me;
            try {
                me = await api(botToken).call('auth.test');
            } catch (error) {
                if (AUTH_ERRORS.has(error.code)) throw failure('Slack did not accept the bot token. Copy it again from OAuth & Permissions.');
                throw failure(error?.message || 'Slack could not be reached.');
            }
            if (!me.bot_id) throw failure('That is not a bot token. Use the one that starts with xoxb-.');
            try {
                await api(appToken).call('apps.connections.open');
            } catch (error) {
                if (AUTH_ERRORS.has(error.code)) throw failure('Slack did not accept the app-level token. It needs the connections:write scope.');
                if (error.code === 'socket_mode_not_enabled' || error.code === 'not_allowed') throw failure('Socket Mode is off for this app. Turn it on under Socket Mode.');
                throw failure(error?.message || 'Slack could not be reached.');
            }
            return {
                id: String(me.user_id),
                username: me.user || '',
                name: me.user || 'Acestes',
                teamId: me.team_id || '',
                team: me.team || '',
            };
        },

        setup: identity => ({ team: identity.team || '' }),

        // Slack has no link that opens a DM with an app, so the code is sent by hand.
        pairLink: () => '',
        pairText: (identity, code) => `pair ${code}`,

        client({ botToken, appToken }) {
            const web = api(botToken);
            const socketApi = api(appToken);
            /** userId -> { name, username }, so the pairing says who it was. */
            const people = new Map();

            async function person(userId) {
                if (!userId) return { name: '', username: '' };
                if (people.has(userId)) return people.get(userId);
                let found = { name: userId, username: '' };
                try {
                    const { user } = await web.call('users.info', { user: userId });
                    found = {
                        name: user?.profile?.real_name || user?.real_name || user?.name || userId,
                        username: user?.profile?.display_name || user?.name || '',
                    };
                } catch {
                    // Not worth failing a message over.
                }
                people.set(userId, found);
                return found;
            }

            async function readMessage(event) {
                const who = await person(event.user);
                return {
                    type: 'message',
                    id: String(event.client_msg_id || event.ts),
                    chatId: String(event.channel),
                    private: event.channel_type === 'im' || String(event.channel || '').startsWith('D'),
                    from: { id: String(event.user || ''), name: who.name, username: who.username, bot: Boolean(event.bot_id) },
                    text: plainText(event.text),
                    date: Math.round(Number(event.ts) * 1000) || Date.now(),
                    attachments: (event.files || []).map((file) => {
                        const type = String(file.mimetype || '').toLowerCase();
                        return {
                            kind: type.startsWith('audio/') || file.subtype === 'slack_audio' ? 'voice' : type.startsWith('image/') ? 'image' : 'file',
                            name: file.name || 'file',
                            mediaType: type,
                            size: Number(file.size) || 0,
                            ref: file.url_private_download || file.url_private,
                        };
                    }),
                };
            }

            /** A user's own message in a DM: not a bot's, not an edit or a join. */
            const isUserMessage = event => event?.type === 'message' && !event.bot_id
                && (!event.subtype || event.subtype === 'file_share') && event.user;

            return {
                async listen({ signal, cursor, owner, emit, setCursor, onReady }) {
                    let url;
                    try {
                        ({ url } = await socketApi.call('apps.connections.open', {}, { signal }));
                    } catch (error) {
                        if (signal.aborted) return;
                        if (AUTH_ERRORS.has(error.code)) throw failure('Slack no longer accepts this app\'s tokens. Connect it again.', 'auth');
                        throw error;
                    }

                    let queue = Promise.resolve();
                    const deliver = make => (queue = queue.then(async () => emit(await make())).catch(() => {}));
                    let lastTs = cursor;
                    const moveCursor = (ts) => {
                        if (!lastTs || Number(ts) > Number(lastTs)) {
                            lastTs = ts;
                            setCursor(ts);
                        }
                    };

                    await new Promise((resolve, reject) => {
                        let socket;
                        try {
                            socket = new WebSocketImpl(url);
                        } catch (error) {
                            reject(new Error(`Could not reach Slack (${error?.message || 'failed'})`));
                            return;
                        }
                        let settled = false;
                        const finish = (error) => {
                            if (settled) return;
                            settled = true;
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

                        const catchUp = async () => {
                            if (!owner?.chatId || !cursor) return;
                            let history;
                            try {
                                history = await web.call('conversations.history', {
                                    channel: owner.chatId,
                                    oldest: cursor,
                                    inclusive: false,
                                    limit: 50,
                                }, { signal });
                            } catch {
                                return;
                            }
                            for (const message of [...(history.messages || [])].reverse()) {
                                if (!isUserMessage(message)) continue;
                                moveCursor(message.ts);
                                deliver(() => readMessage({ ...message, channel: owner.chatId, channel_type: 'im' }));
                            }
                        };

                        socket.addEventListener('message', (message) => {
                            let envelope;
                            try {
                                envelope = JSON.parse(typeof message.data === 'string' ? message.data : Buffer.from(message.data).toString('utf8'));
                            } catch {
                                return;
                            }
                            // Acknowledged first, whatever it is, or Slack sends it again.
                            if (envelope.envelope_id) {
                                try {
                                    socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
                                } catch {
                                    // The close handler deals with a dead socket.
                                }
                            }
                            if (envelope.type === 'hello') {
                                onReady();
                                catchUp();
                                return;
                            }
                            if (envelope.type === 'disconnect') {
                                // A refresh Slack asked for: the loop opens a new socket.
                                finish();
                                return;
                            }
                            if (envelope.type === 'events_api') {
                                const event = envelope.payload?.event;
                                if (!isUserMessage(event)) return;
                                moveCursor(event.ts);
                                deliver(() => readMessage(event));
                                return;
                            }
                            if (envelope.type === 'interactive' && envelope.payload?.type === 'block_actions') {
                                const payload = envelope.payload;
                                const action = payload.actions?.[0];
                                if (!action) return;
                                const chatId = String(payload.channel?.id || payload.container?.channel_id || '');
                                deliver(async () => {
                                    const who = await person(payload.user?.id);
                                    return {
                                        type: 'button',
                                        chatId,
                                        from: { id: String(payload.user?.id || ''), name: who.name, username: who.username },
                                        data: action.value || action.action_id || '',
                                        messageId: String(payload.container?.message_ts || payload.message?.ts || ''),
                                        ack: () => null,
                                    };
                                });
                            }
                        });

                        socket.addEventListener('close', () => finish(settled ? null : new Error('Slack closed the connection')));
                        socket.addEventListener('error', () => {
                            // A close always follows; that is where it is handled.
                        });
                    });
                    await queue;
                },

                async send(chatId, { markdown, formatted, buttons }) {
                    const text = formatted ?? format.toText(markdown, 'slack');
                    const sent = await web.call('chat.postMessage', {
                        channel: chatId,
                        text,
                        ...(buttons ? { blocks: blocks(text, buttons) } : {}),
                        unfurl_links: false,
                        unfurl_media: false,
                    });
                    return { id: String(sent.ts || '') };
                },

                async edit(chatId, messageId, { markdown, formatted, buttons }) {
                    const text = formatted ?? format.toText(markdown, 'slack');
                    await web.call('chat.update', {
                        channel: chatId,
                        ts: messageId,
                        text,
                        blocks: blocks(text, buttons),
                    });
                },

                typing: async () => null,

                async fetch(attachment, maxBytes) {
                    if (attachment.size > maxBytes) throw new Error('The file is too large');
                    if (!attachment.ref) throw new Error('Slack did not say where the file is');
                    let response;
                    try {
                        response = await fetchImpl(attachment.ref, {
                            headers: { Authorization: `Bearer ${botToken}` },
                            signal: AbortSignal.timeout(60000),
                        });
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

module.exports = { createSlackAdapter, createSlackApi, plainText, MANIFEST };
