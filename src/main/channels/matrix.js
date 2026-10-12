const format = require('./format');

/**
 * Matrix, as a channel: an account made for the bot on any homeserver,
 * signed in with its access token, talked to in a room with the user.
 *
 * Inbound is `/sync` held open, a long poll like Telegram's, so nothing has
 * to be reachable from outside, and the sync token saved between launches
 * means what arrived while the app was closed comes with the first sync.
 * The bot joins a room only when invited while the desktop is pairing, or
 * by the paired account; any other invite is turned down.
 *
 * Matrix has no buttons. A card's choices are reactions the bot puts under
 * it, listed in the message; the user picks one by adding the same
 * reaction. Once answered, the bot takes its reactions back.
 *
 * Encrypted rooms are not read: that takes the Olm and Megolm libraries and
 * a device of the bot's own to verify. A message in one is answered, in the
 * clear, with how to make a room Acestes can read.
 */

const NUMBER_KEYS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

const SYNC_TIMEOUT = 30000;

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

/** "matrix.org" or "https://matrix.example.com/", as an origin. */
function normalizeServer(raw) {
    let text = String(raw || '').trim().replace(/\/+$/, '');
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
    try {
        const url = new URL(text);
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
        return '';
    }
}

/** The client-server API with one access token. */
function createMatrixApi({ homeserver, accessToken, fetchImpl = globalThis.fetch }) {
    async function call(method, route, body, { signal, timeout = 20000, raw = false } = {}) {
        for (let attempt = 0; ; attempt += 1) {
            const init = {
                method,
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: deadline(timeout, signal),
            };
            if (body !== undefined) {
                init.headers['Content-Type'] = 'application/json';
                init.body = JSON.stringify(body);
            }
            let response;
            try {
                response = await fetchImpl(`${homeserver}${route}`, init);
            } catch (error) {
                const wrapped = new Error(`Could not reach the homeserver (${error?.name === 'TimeoutError' ? 'timed out' : error?.cause?.code || error?.message || 'failed'})`);
                wrapped.network = true;
                throw wrapped;
            }
            if (raw && response.ok) return response;
            let data = null;
            try {
                data = await response.json();
            } catch {
                data = null;
            }
            if (response.status === 429 && attempt < 2) {
                const wait = Number(data?.retry_after_ms) || 1000;
                if (wait <= 30000) {
                    await sleep(wait, signal);
                    continue;
                }
            }
            if (!response.ok) {
                const error = new Error(data?.error ? `Matrix: ${data.error}` : `The homeserver answered ${response.status}`);
                error.status = response.status;
                error.code = data?.errcode || '';
                throw error;
            }
            return data;
        }
    }
    return { call, homeserver };
}

const authFailure = error => error?.status === 401 || error?.code === 'M_UNKNOWN_TOKEN' || error?.code === 'M_MISSING_TOKEN';

/** A message body without the quoted fallback a reply carries. */
function withoutReplyFallback(content) {
    const body = String(content?.body || '');
    if (!content?.['m.relates_to']?.['m.in_reply_to']) return body;
    const lines = body.split('\n');
    let at = 0;
    while (at < lines.length && lines[at].startsWith('>')) at += 1;
    while (at < lines.length && !lines[at].trim()) at += 1;
    return lines.slice(at).join('\n');
}

let transactions = 0;
const txn = () => {
    transactions += 1;
    return `acestes-${Date.now().toString(36)}-${transactions}`;
};

function createMatrixAdapter({ fetchImpl = globalThis.fetch, syncTimeout = SYNC_TIMEOUT } = {}) {
    return {
        name: 'matrix',
        label: 'Matrix',
        target: 'matrix',
        prefix: '!',
        typing: true,
        encryptedNote: 'This room is end-to-end encrypted, which Acestes cannot read yet. '
            + 'Make a new room with encryption switched off, invite me to it, and write to me there.',

        prepare(raw) {
            const homeserver = normalizeServer(raw?.homeserver);
            const accessToken = String(raw?.accessToken || '').trim();
            if (!homeserver) return { error: 'Give the homeserver, such as matrix.org or https://matrix.example.com.' };
            if (accessToken.length < 10 || /\s/.test(accessToken)) {
                return { error: 'That does not look like an access token. Element shows it under Settings, Help & About, Advanced.' };
            }
            return { credentials: { homeserver, accessToken } };
        },

        async verify({ homeserver, accessToken }) {
            // The address people use is often not the API's: the server says
            // where its API lives in /.well-known/matrix/client.
            let base = homeserver;
            try {
                const response = await fetchImpl(`${new URL(homeserver).origin}/.well-known/matrix/client`, { signal: AbortSignal.timeout(10000) });
                if (response.ok) {
                    const known = await response.json();
                    const found = normalizeServer(known?.['m.homeserver']?.base_url);
                    if (found) base = found;
                }
            } catch {
                // No discovery: the address is the API.
            }
            const api = createMatrixApi({ homeserver: base, accessToken, fetchImpl });
            let me;
            try {
                me = await api.call('GET', '/_matrix/client/v3/account/whoami');
            } catch (error) {
                if (authFailure(error)) throw failure('The homeserver did not accept that access token.');
                throw failure(error?.message || 'The homeserver could not be reached.');
            }
            let name = '';
            try {
                name = (await api.call('GET', `/_matrix/client/v3/profile/${encodeURIComponent(me.user_id)}/displayname`))?.displayname || '';
            } catch {
                name = '';
            }
            return { id: String(me.user_id), username: String(me.user_id), name: name || String(me.user_id), homeserver: base };
        },

        setup: identity => ({ userId: identity.id, homeserver: identity.homeserver || '' }),

        // No link: matrix.to opens a direct message, which Element encrypts,
        // and the bot cannot read an encrypted room. The room is made by hand.
        pairLink: () => '',
        pairText: (identity, code) => `pair ${code}`,

        client({ homeserver, accessToken }, identity = {}) {
            const api = createMatrixApi({ homeserver: identity.homeserver || homeserver, accessToken, fetchImpl });
            const self = identity.id || '';
            /** eventId -> { roomId, choices: [{ key, data }], reactions: [eventId] } */
            const choices = new Map();
            /** roomId -> how many are in it, for whether it is a private chat. */
            const members = new Map();
            /** userId -> display name, from the member events sync sends. */
            const names = new Map();

            async function memberCount(roomId) {
                if (members.has(roomId)) return members.get(roomId);
                try {
                    const { joined } = await api.call('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`);
                    const count = Object.keys(joined || {}).length;
                    members.set(roomId, count);
                    return count;
                } catch {
                    return 0;
                }
            }

            async function sendEvent(roomId, type, content) {
                const sent = await api.call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/${txn()}`, content);
                return String(sent?.event_id || '');
            }

            /** The message's HTML, with its choices listed under it when it has any. */
            function compose({ markdown, formatted, buttons }) {
                let html = formatted ?? format.toText(markdown, 'matrix');
                const listed = [];
                if (buttons) {
                    buttons.flat().slice(0, NUMBER_KEYS.length).forEach((button, index) => {
                        listed.push({ key: button.emoji || NUMBER_KEYS[index], text: button.text, data: button.data });
                    });
                    html += `<br><br><i>React with ${listed.map(item => `${item.key} ${format.escapeHtml(item.text)}`).join(' · ')}</i>`;
                }
                return { html, text: format.htmlToText(html), listed };
            }

            async function takeBack(eventId) {
                const entry = choices.get(eventId);
                if (!entry) return;
                choices.delete(eventId);
                for (const reaction of entry.reactions) {
                    await api.call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(entry.roomId)}/redact/${encodeURIComponent(reaction)}/${txn()}`, {}).catch(() => {});
                }
            }

            async function readMessage(roomId, event) {
                const content = event.content || {};
                const attachments = [];
                const kind = { 'm.image': 'image', 'm.file': 'file', 'm.audio': 'voice', 'm.video': 'file' }[content.msgtype];
                if (kind) {
                    attachments.push({
                        kind,
                        name: content.filename || content.body || 'file',
                        mediaType: String(content.info?.mimetype || '').toLowerCase(),
                        size: Number(content.info?.size) || 0,
                        ref: content.url || '',
                    });
                }
                const text = kind ? '' : withoutReplyFallback(content);
                return {
                    type: 'message',
                    id: String(event.event_id),
                    chatId: roomId,
                    private: (await memberCount(roomId)) <= 2,
                    from: { id: String(event.sender), name: names.get(event.sender) || String(event.sender), username: String(event.sender) },
                    text,
                    date: Number(event.origin_server_ts) || Date.now(),
                    attachments,
                };
            }

            return {
                async listen({ signal, cursor, emit, setCursor, onReady, accept }) {
                    const filter = JSON.stringify({
                        presence: { types: [] },
                        account_data: { types: [] },
                        room: {
                            timeline: { limit: 30, types: ['m.room.message', 'm.reaction', 'm.room.encrypted', 'm.room.member'] },
                            state: { types: ['m.room.member'], lazy_load_members: true },
                            ephemeral: { types: [] },
                            account_data: { types: [] },
                        },
                    });
                    const sync = (since, timeout) => api.call(
                        'GET',
                        `/_matrix/client/v3/sync?timeout=${timeout}&filter=${encodeURIComponent(filter)}${since ? `&since=${encodeURIComponent(since)}` : ''}`,
                        undefined,
                        { signal, timeout: timeout + 20000 },
                    );

                    const handleInvites = async (invites) => {
                        for (const [roomId, room] of Object.entries(invites || {})) {
                            const invite = (room.invite_state?.events || []).find(event => event.type === 'm.room.member' && event.state_key === self);
                            const from = { id: String(invite?.sender || '') };
                            const path = accept(from)
                                ? `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`
                                : `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`;
                            await api.call('POST', path, {}).catch(() => {});
                            members.delete(roomId);
                        }
                    };

                    let since = cursor;
                    try {
                        if (!since) {
                            // A first sync is the history so far: kept as a
                            // place to start from, never acted on.
                            const first = await sync('', 0);
                            since = first.next_batch;
                            setCursor(since);
                            await handleInvites(first.rooms?.invite);
                        }
                        onReady();
                        while (!signal.aborted) {
                            const data = await sync(since, syncTimeout);
                            if (signal.aborted) return;
                            since = data.next_batch;
                            setCursor(since);
                            await handleInvites(data.rooms?.invite);
                            for (const roomId of Object.keys(data.rooms?.leave || {})) members.delete(roomId);
                            for (const [roomId, room] of Object.entries(data.rooms?.join || {})) {
                                const summary = room.summary || {};
                                if (summary['m.joined_member_count'] !== undefined) {
                                    members.set(roomId, Number(summary['m.joined_member_count']) + Number(summary['m.invited_member_count'] || 0));
                                }
                                for (const event of [...(room.state?.events || []), ...(room.timeline?.events || [])]) {
                                    if (event.type === 'm.room.member') {
                                        if (event.content?.displayname) names.set(event.state_key, event.content.displayname);
                                        if (event.content?.membership && event.state_key !== self) members.delete(roomId);
                                    }
                                }
                                for (const event of room.timeline?.events || []) {
                                    if (event.sender === self) continue;
                                    if (event.type === 'm.room.message') {
                                        if (event.content?.['m.relates_to']?.rel_type === 'm.replace') continue;
                                        await emit(await readMessage(roomId, event));
                                    } else if (event.type === 'm.room.encrypted') {
                                        await emit({
                                            type: 'message',
                                            id: String(event.event_id),
                                            chatId: roomId,
                                            private: (await memberCount(roomId)) <= 2,
                                            from: { id: String(event.sender), name: names.get(event.sender) || String(event.sender), username: String(event.sender) },
                                            text: '',
                                            date: Number(event.origin_server_ts) || Date.now(),
                                            encrypted: true,
                                        });
                                    } else if (event.type === 'm.reaction') {
                                        const relation = event.content?.['m.relates_to'] || {};
                                        const entry = choices.get(relation.event_id);
                                        const choice = entry?.choices.find(item => item.key === relation.key);
                                        if (!choice) continue;
                                        await emit({
                                            type: 'button',
                                            chatId: roomId,
                                            from: { id: String(event.sender), name: names.get(event.sender) || String(event.sender), username: String(event.sender) },
                                            data: choice.data,
                                            messageId: String(relation.event_id),
                                            ack: () => null,
                                        });
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        if (signal.aborted) return;
                        if (authFailure(error)) throw failure('The homeserver no longer accepts the bot\'s access token. Connect it again.', 'auth');
                        throw error;
                    }
                },

                async send(roomId, { markdown, formatted, buttons, silent }) {
                    const { html, text, listed } = compose({ markdown, formatted, buttons });
                    const eventId = await sendEvent(roomId, 'm.room.message', {
                        msgtype: silent ? 'm.notice' : 'm.text',
                        body: text,
                        format: 'org.matrix.custom.html',
                        formatted_body: html,
                    });
                    if (listed.length && eventId) {
                        const reactions = [];
                        for (const item of listed) {
                            const reaction = await sendEvent(roomId, 'm.reaction', {
                                'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key: item.key },
                            }).catch(() => '');
                            if (reaction) reactions.push(reaction);
                        }
                        choices.set(eventId, { roomId, choices: listed.map(({ key, data }) => ({ key, data })), reactions });
                        if (choices.size > 200) choices.delete(choices.keys().next().value);
                    }
                    return { id: eventId };
                },

                async edit(roomId, eventId, { markdown, formatted, buttons }) {
                    const { html, text } = compose({ markdown, formatted, buttons: null });
                    await sendEvent(roomId, 'm.room.message', {
                        msgtype: 'm.text',
                        body: `* ${text}`,
                        format: 'org.matrix.custom.html',
                        formatted_body: `* ${html}`,
                        'm.new_content': { msgtype: 'm.text', body: text, format: 'org.matrix.custom.html', formatted_body: html },
                        'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
                    });
                    if (!buttons) await takeBack(eventId);
                },

                typing: roomId => api.call('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(self)}`, { typing: true, timeout: 8000 }),

                async fetch(attachment, maxBytes) {
                    if (attachment.size > maxBytes) throw new Error('The file is too large');
                    const found = /^mxc:\/\/([^/]+)\/([^/?#]+)/.exec(String(attachment.ref || ''));
                    if (!found) throw new Error('The homeserver did not say where the file is');
                    const [, server, media] = found;
                    let response;
                    try {
                        // Authenticated media (Matrix 1.11), then the older open route.
                        response = await api.call('GET', `/_matrix/client/v1/media/download/${encodeURIComponent(server)}/${encodeURIComponent(media)}`, undefined, { raw: true, timeout: 60000 });
                    } catch {
                        response = await api.call('GET', `/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(media)}`, undefined, { raw: true, timeout: 60000 });
                    }
                    const buffer = Buffer.from(await response.arrayBuffer());
                    if (buffer.length > maxBytes) throw new Error('The file is too large');
                    return buffer;
                },
            };
        },
    };
}

module.exports = { createMatrixAdapter, createMatrixApi, normalizeServer, withoutReplyFallback };
