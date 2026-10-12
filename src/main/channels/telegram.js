const crypto = require('crypto');
const os = require('os');
const { createTelegramApi, TelegramError } = require('./telegram-api');
const format = require('./format');

/**
 * The Telegram gateway: the user's own bot, answering only them, with each
 * message a turn in an Acestes conversation and the turn shown back on the
 * phone as it goes.
 *
 * It is the gateway OpenClaw and Hermes run as a daemon, built into the main
 * process instead, because the main process already is one: it outlives the
 * window, holds every conversation, and settles approvals and questions by
 * request id. So this file is mostly translation, in both directions, plus
 * the rules about who may talk to it.
 *
 * Inbound is a long poll of `getUpdates`: no public URL, no tunnel, nothing
 * to open on the router, and it works from a laptop behind any NAT. The
 * offset is saved before each update is handled, so an update that crashes
 * the app is not run a second time on the way back up.
 *
 * Trust, in the order it is checked:
 *
 *   - Private chats only, and only the one Telegram account that was paired,
 *     by a one-time code from the desktop. Everyone else is ignored without
 *     an answer, so a stranger who finds the bot learns nothing from it.
 *   - Nothing at all while the app is locked: the token cannot be read, and
 *     the poll waits for the unlock.
 *   - A message older than ten minutes when it arrives (sent while the app
 *     was closed; Telegram holds them for a day) is not run, it is offered:
 *     "restart nginx" sent last night should not run by itself this morning.
 *   - A turn from the phone asks before every change, whatever the agent's
 *     own approval mode, unless the user chose otherwise. A phone is weaker
 *     proof of who is there than the desk is. See `strict` in ai/index.js.
 *   - A question that wants a secret is never answered here. Bot chats are
 *     not end-to-end encrypted.
 *
 * Outbound, for a turn the phone started: a typing indicator, one progress
 * message edited in place as tools are called, approval and question cards
 * with buttons, and the reply as a new message so the phone notifies. The
 * first answer to a card wins, from the phone or the desktop, and the other
 * side is updated to say so.
 */

/** A message older than this when it arrives is offered rather than run. */
const STALE_AFTER = 10 * 60 * 1000;
/** How long a pairing code is good for. */
const PAIRING_TTL = 10 * 60 * 1000;
/** The fewest milliseconds between two edits of the progress message. */
const PROGRESS_INTERVAL = 3000;
/** Telegram shows "typing" for five seconds; renewed a little sooner. */
const TYPING_INTERVAL = 4500;
/** Typing stops after this long without a word from the turn. */
const TYPING_QUIET_LIMIT = 5 * 60 * 1000;
/** Steps shown in the progress message; the rest are counted. */
const PROGRESS_STEPS = 6;
/** A reply longer than this many messages goes as a file after the first. */
const MAX_REPLY_MESSAGES = 4;
/** The image cap `send` enforces. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The text file cap `send` enforces. */
const MAX_FILE_CHARS = 64 * 1024;

const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_EXTENSIONS = /\.(txt|md|markdown|log|json|ya?ml|toml|ini|conf|cfg|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|sql|env|service|tf|dockerfile)$/i;

const COMMANDS = [
    { command: 'new', description: 'Start a new conversation' },
    { command: 'list', description: 'Pick up a recent conversation' },
    { command: 'stop', description: 'Stop the agent' },
    { command: 'status', description: 'What the agent is doing' },
    { command: 'agent', description: 'Choose which agent to talk to' },
    { command: 'help', description: 'What this bot can do' },
];

const HELP = [
    'Send a message and the agent works on it in Acestes, on your computer.',
    '',
    '/new  start a new conversation',
    '/list  pick up a recent conversation',
    '/stop  stop the agent',
    '/status  what it is doing',
    '/agent  choose which agent to talk to',
    '',
    'Changes it wants to make wait for your Approve. Photos and text files can be sent too.',
].join('\n');

const escapeHtml = format.escapeHtml;

function randomCode(length = 10) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return out;
}

function sameCode(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function duration(ms) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** One line for a tool call: its name and what it was pointed at. */
function stepLine(event) {
    const name = String(event.name || event.rawName || 'tool').replace(/^mcp__\w+?__/, '').replace(/_/g, ' ');
    const input = event.input && typeof event.input === 'object' ? event.input : {};
    const target = input.command ?? input.cmd ?? input.path ?? input.file_path ?? input.url
        ?? input.query ?? input.pattern ?? input.hostId ?? input.app ?? input.question
        ?? Object.values(input).find(value => typeof value === 'string' && value.trim());
    const shown = target === undefined ? '' : format.clip(String(target), 90);
    return shown ? `${name}: ${shown}` : name;
}

/** What an approval card shows of the call it is about. */
function approvalBody(event) {
    const input = event.input && typeof event.input === 'object' ? event.input : {};
    const lines = [];
    if (typeof input.command === 'string') {
        lines.push(`<pre>${escapeHtml(format.clip(input.command, 1500))}</pre>`);
    } else if (event.diff?.path) {
        const counts = `+${event.diff.added || 0} -${event.diff.removed || 0}`;
        lines.push(`<code>${escapeHtml(event.diff.path)}</code>  ${escapeHtml(counts)}`);
    } else {
        const rows = Object.entries(input)
            .filter(([key, value]) => key !== 'session' && value !== undefined && value !== null && value !== '')
            .slice(0, 8)
            .map(([key, value]) => `${key}: ${format.clip(typeof value === 'string' ? value : JSON.stringify(value), 300)}`);
        if (rows.length) lines.push(`<pre>${escapeHtml(rows.join('\n'))}</pre>`);
    }
    return lines.join('\n');
}

/**
 * The gateway, given what it drives.
 *
 *   config    channels/config.js
 *   ai        create, send, interrupt, respondToApproval, respondToQuestion,
 *             observe, list, history: the assistant core, or a stand-in
 *   agents    list() -> [{ id, name }], activeId(), get(id)
 *   jobs      get(id), for whether a job's cards and results come here
 *   isLocked  whether the vault is locked
 *   scrub     masks stored secrets out of text leaving the machine
 *   onChange  told the status whenever it moves, for the settings page
 *   audit     an activity-log entry, for pairing and unpairing
 */
function createTelegramGateway(deps = {}) {
    const {
        config,
        ai,
        agents,
        jobs = { get: () => null },
        isLocked = () => false,
        scrub = text => text,
        onChange = () => {},
        audit = () => {},
        apiFactory = token => createTelegramApi({ token }),
        now = () => Date.now(),
        pollTimeout = 30,
        staleAfter = STALE_AFTER,
        pairingTtl = PAIRING_TTL,
        progressInterval = PROGRESS_INTERVAL,
        typingInterval = TYPING_INTERVAL,
        retryDelay = 2000,
        conflictDelay = 60000,
        hostName = os.hostname(),
        log = console,
    } = deps;

    let api = null;
    let running = false;
    let generation = 0;
    let controller = null;
    let unobserve = null;
    let state = 'off';
    let stateMessage = '';
    let lastMessageAt = 0;
    let commandsSet = false;

    /** { code, expiresAt } while the desktop is waiting for a pairing. */
    let pairing = null;
    /** Codes that have run out, so a late tap is told rather than ignored. */
    const expiredCodes = new Map();

    /** conversationId -> the phone's view of its turn. See `beginTurn`. */
    const live = new Map();
    /** card key -> an approval or question card on the phone. */
    const cards = new Map();
    /** requestId -> card key. */
    const cardOf = new Map();
    let cardCounter = 0;
    /** stale key -> a message held for a "run it now". */
    const held = new Map();
    let heldCounter = 0;
    /** `${chatId}:${messageId}` -> the ids a menu's buttons stand for. */
    const menus = new Map();
    /** chatId -> the promise every call to that chat queues behind. */
    const queues = new Map();
    /** Conversations being stopped from the phone, for how their cards read. */
    const stopping = new Set();

    /* -------------------------------------------------------------- *
     * State
     * -------------------------------------------------------------- */

    const telegram = () => config.telegram();

    function setState(next, message = '') {
        if (state === next && stateMessage === message) return;
        state = next;
        stateMessage = message;
        onChange(status());
    }

    function currentPairing() {
        if (!pairing) return null;
        if (now() >= pairing.expiresAt) {
            expiredCodes.set(pairing.code, now());
            pairing = null;
            return null;
        }
        return pairing;
    }

    function status() {
        const current = telegram();
        const open = currentPairing();
        const username = current.bot?.username || '';
        return {
            telegram: {
                connected: Boolean(current.token),
                bot: current.bot ? { username, name: current.bot.name } : null,
                enabled: current.enabled,
                state,
                message: stateMessage,
                owner: current.owner
                    ? { name: current.owner.name, username: current.owner.username, pairedAt: current.owner.pairedAt }
                    : null,
                pairing: open ? { code: open.code, link: `https://t.me/${username}?start=${open.code}`, expiresAt: open.expiresAt } : null,
                agentId: current.agentId,
                approvals: current.approvals,
                lastMessageAt,
            },
        };
    }

    /** Whether there is someone to send to, right now. */
    function ready() {
        const current = telegram();
        return Boolean(current.enabled && current.token && current.owner && !isLocked() && state !== 'unauthorized');
    }

    function getApi() {
        if (isLocked()) {
            // The token is not held while the app is locked.
            api = null;
            return null;
        }
        if (api) return api;
        const token = config.token();
        if (!token) return null;
        api = apiFactory(token);
        return api;
    }

    function dropApi() {
        api = null;
    }

    /* -------------------------------------------------------------- *
     * Sending
     * -------------------------------------------------------------- */

    /**
     * Every call to one chat goes through its queue, in order. Telegram
     * limits a chat to about a message a second, and a progress edit landing
     * after the reply it was meant to precede reads as the agent still
     * working when it has finished.
     */
    function enqueue(chatId, task) {
        const key = String(chatId);
        const previous = queues.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(() => {
            const client = getApi();
            if (!client) throw new Error('Telegram is not available');
            return task(client);
        });
        queues.set(key, next.catch(() => {}));
        return next;
    }

    const quietly = promise => promise.catch((error) => {
        if (!/not modified/i.test(error?.message || '')) log.error?.('Telegram:', error?.message || error);
        return null;
    });

    const NO_PREVIEW = { link_preview_options: { is_disabled: true } };

    /** One HTML message, sent as plain text instead if Telegram cannot read the HTML. */
    async function sendHtml(client, chatId, html, extra = {}) {
        try {
            return await client.sendMessage(chatId, html, { parse_mode: 'HTML', ...NO_PREVIEW, ...extra });
        } catch (error) {
            if (error instanceof TelegramError && error.status === 400 && /parse|entit|tag/i.test(error.description)) {
                return client.sendMessage(chatId, format.htmlToText(html).slice(0, 4096), { ...NO_PREVIEW, ...extra });
            }
            throw error;
        }
    }

    async function editHtml(client, chatId, messageId, html, extra = {}) {
        try {
            return await client.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', ...NO_PREVIEW, ...extra });
        } catch (error) {
            if (error instanceof TelegramError && error.status === 400 && /parse|entit|tag/i.test(error.description)) {
                return client.editMessageText(chatId, messageId, format.htmlToText(html).slice(0, 4096), { ...NO_PREVIEW, ...extra });
            }
            throw error;
        }
    }

    /** A short note from the gateway itself, already HTML. */
    function say(chatId, html, extra = {}) {
        return quietly(enqueue(chatId, client => sendHtml(client, chatId, html, extra)));
    }

    /** The agent's Markdown, as one or more messages, or a file when it is long. */
    function sendReply(chatId, markdown) {
        const text = scrub(String(markdown || '')).trim();
        if (!text) return Promise.resolve();
        const messages = format.toMessages(text);
        return quietly(enqueue(chatId, async (client) => {
            if (messages.length <= MAX_REPLY_MESSAGES) {
                for (const html of messages) await sendHtml(client, chatId, html);
                return;
            }
            await sendHtml(client, chatId, messages[0]);
            await client.sendDocument(chatId, {
                name: 'reply.md',
                text,
                caption: `The full reply, ${plural(messages.length, 'message')} long.`,
            });
        }));
    }

    /* -------------------------------------------------------------- *
     * The poll
     * -------------------------------------------------------------- */

    function wait(ms) {
        return new Promise((resolve) => {
            const signal = controller?.signal;
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }

    async function poll(own) {
        let backoff = retryDelay;
        while (running && own === generation) {
            if (isLocked()) {
                dropApi();
                setState('locked', 'The app is locked. Messages wait in Telegram until it is unlocked.');
                await wait(5000);
                continue;
            }
            const client = getApi();
            if (!client) {
                setState('error', 'The bot token could not be read. Connect the bot again.');
                await wait(10000);
                continue;
            }
            if (!commandsSet) {
                commandsSet = true;
                client.setMyCommands(COMMANDS).catch(() => { commandsSet = false; });
            }
            try {
                const updates = await client.getUpdates({
                    offset: telegram().offset,
                    timeout: pollTimeout,
                    signal: controller.signal,
                });
                if (!running || own !== generation) break;
                setState('running');
                backoff = retryDelay;
                for (const update of Array.isArray(updates) ? updates : []) {
                    // Moved past before it is handled: an update that takes
                    // the app down with it is not run again on the way up.
                    config.update({ offset: Number(update.update_id) + 1 });
                    try {
                        await handleUpdate(update);
                    } catch (error) {
                        log.error?.('Telegram: could not handle an update:', error?.message || error);
                    }
                }
            } catch (error) {
                if (!running || own !== generation) break;
                if (error instanceof TelegramError && (error.status === 401 || error.status === 404)) {
                    dropApi();
                    running = false;
                    setState('unauthorized', 'Telegram no longer accepts this bot\'s token. Connect the bot again.');
                    break;
                }
                if (error instanceof TelegramError && error.status === 409) {
                    if (/webhook/i.test(error.description)) {
                        setState('webhook', 'This bot has a webhook set, so its messages go somewhere else. Remove the webhook, or use another bot.');
                    } else {
                        setState('conflict', 'Another device or program is reading this bot\'s messages. Only one can at a time.');
                    }
                    await wait(conflictDelay);
                    continue;
                }
                setState('offline', error?.message || 'Telegram could not be reached.');
                await wait(backoff);
                backoff = Math.min(backoff * 2, 60000);
            }
        }
    }

    function startLoop() {
        stopLoop({ quiet: true });
        const current = telegram();
        if (!current.enabled || !current.token) {
            setState('off');
            return;
        }
        generation += 1;
        running = true;
        controller = new AbortController();
        setState('starting');
        poll(generation).catch((error) => {
            log.error?.('Telegram poll stopped:', error?.message || error);
        });
    }

    function stopLoop({ quiet = false } = {}) {
        running = false;
        generation += 1;
        controller?.abort();
        controller = null;
        if (!quiet) setState('off');
    }

    /* -------------------------------------------------------------- *
     * Inbound
     * -------------------------------------------------------------- */

    async function handleUpdate(update) {
        if (update.callback_query) {
            await handleButton(update.callback_query);
            return;
        }
        const message = update.message;
        if (!message?.chat || !message.from || message.from.is_bot) return;
        // Private chats only: a group would put the agent in front of
        // everyone in it.
        if (message.chat.type !== 'private') return;

        const owner = telegram().owner;
        const text = String(message.text || message.caption || '').trim();
        const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text);

        if (start?.[1] && tryPair(message, start[1])) return;
        if (!owner || Number(message.from.id) !== owner.userId) return;

        lastMessageAt = now();
        if (start) {
            await say(message.chat.id, escapeHtml(HELP));
            return;
        }

        const age = now() - Number(message.date || 0) * 1000;
        if (message.date && age > staleAfter) {
            await offerStale(message, age);
            return;
        }
        await handleOwnerMessage(message);
    }

    function tryPair(message, code) {
        const open = currentPairing();
        if (open && sameCode(code, open.code)) {
            const from = message.from;
            const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Telegram user';
            pairing = null;
            const before = telegram().owner;
            config.update({
                owner: {
                    userId: from.id,
                    chatId: message.chat.id,
                    name,
                    username: from.username || '',
                    pairedAt: now(),
                },
            });
            config.setChat(message.chat.id, { conversationId: '', agentId: config.chat(message.chat.id).agentId || '' });
            audit({
                action: 'channels.telegram-paired',
                detail: `Telegram account ${from.username ? `@${from.username}` : name} (id ${from.id}) can now talk to the agent`
                    + (before && before.userId !== from.id ? `, replacing ${before.username ? `@${before.username}` : before.name}` : ''),
            });
            const agent = agentFor(message.chat.id);
            say(message.chat.id, `<b>Paired with Acestes on ${escapeHtml(hostName)}.</b>\n\n`
                + `Send a message to talk to ${escapeHtml(agent?.name || 'your agent')}.\n\n${escapeHtml(HELP)}`);
            onChange(status());
            return true;
        }
        // A link that ran out is answered, so a late tap does not look like
        // a dead bot. A code nobody issued is not.
        for (const [old, at] of expiredCodes) {
            if (now() - at > 24 * 60 * 60 * 1000) expiredCodes.delete(old);
        }
        if ([...expiredCodes.keys()].some(old => sameCode(old, code))) {
            say(message.chat.id, 'That pairing link has run out. Make a new one in Acestes: Settings, Channels.');
            return true;
        }
        return false;
    }

    async function offerStale(message, age) {
        heldCounter += 1;
        const key = `h${heldCounter}`;
        held.set(key, { message });
        const preview = format.clip(message.text || message.caption || '(an attachment)', 200);
        await say(message.chat.id,
            `This message reached Acestes ${escapeHtml(duration(age))} after you sent it, while the app was closed or asleep, so it has not been run:\n\n`
            + `<blockquote>${escapeHtml(preview)}</blockquote>`,
            { reply_markup: { inline_keyboard: [[
                { text: 'Run it now', callback_data: `x:${key}:run` },
                { text: 'Discard', callback_data: `x:${key}:drop` },
            ]] } });
    }

    function agentFor(chatId) {
        const chosen = config.chat(chatId).agentId || telegram().agentId;
        return (chosen && agents.get(chosen)) || agents.get(agents.activeId()) || null;
    }

    /** The conversation a chat is in, started if it has none or it is gone. */
    function conversationFor(chatId) {
        const chat = config.chat(chatId);
        if (chat.conversationId) {
            const found = ai.history(chat.conversationId);
            if (found?.found) return chat.conversationId;
        }
        const agent = agentFor(chatId);
        const created = ai.create({ agentId: agent?.id || '', scope: 'global' });
        config.setChat(chatId, { conversationId: created.conversationId });
        return created.conversationId;
    }

    /** The question card still open in a conversation, if there is one. */
    function openQuestion(conversationId) {
        for (const card of cards.values()) {
            if (card.kind === 'question' && card.conversationId === conversationId && !card.settled && !card.parked && !card.secret) return card;
        }
        return null;
    }

    async function handleOwnerMessage(message) {
        const chatId = message.chat.id;
        const text = String(message.text || message.caption || '').trim();

        const command = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
        if (command && !message.photo && !message.document) {
            const handled = await runCommand(chatId, command[1].toLowerCase(), (command[2] || '').trim());
            if (handled) return;
        }

        if (message.voice || message.audio || message.video_note) {
            await say(chatId, 'Voice notes are not supported yet. Type the message instead.');
            return;
        }

        const images = [];
        const files = [];
        try {
            if (Array.isArray(message.photo) && message.photo.length) {
                const fitting = message.photo
                    .filter(size => !size.file_size || size.file_size <= MAX_IMAGE_BYTES)
                    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
                if (!fitting) {
                    await say(chatId, 'That photo is too large to pass on. Send it smaller.');
                    return;
                }
                images.push({ name: 'photo.jpg', mediaType: 'image/jpeg', data: (await fetchFile(fitting.file_id, MAX_IMAGE_BYTES)).toString('base64') });
            }
            if (message.document) {
                const document = message.document;
                const name = String(document.file_name || 'file').slice(0, 120);
                const type = String(document.mime_type || '').toLowerCase();
                if (IMAGE_TYPES.has(type)) {
                    if (document.file_size > MAX_IMAGE_BYTES) {
                        await say(chatId, `${escapeHtml(name)} is larger than the 5 MB an image may be.`);
                        return;
                    }
                    images.push({ name, mediaType: type, data: (await fetchFile(document.file_id, MAX_IMAGE_BYTES)).toString('base64') });
                } else if (type.startsWith('text/') || /json|xml|yaml|toml|javascript|x-sh|sql|csv/.test(type) || TEXT_EXTENSIONS.test(name)) {
                    if (document.file_size > MAX_FILE_CHARS * 2) {
                        await say(chatId, `${escapeHtml(name)} is larger than the 64 KB a text file may be.`);
                        return;
                    }
                    const buffer = await fetchFile(document.file_id, MAX_FILE_CHARS * 4);
                    const content = buffer.toString('utf8');
                    if (content.includes('\u0000')) {
                        await say(chatId, `${escapeHtml(name)} does not read as text.`);
                        return;
                    }
                    if (content.length > MAX_FILE_CHARS) {
                        await say(chatId, `${escapeHtml(name)} is larger than the 64 KB a text file may be.`);
                        return;
                    }
                    files.push({ name, mediaType: type || 'text/plain', text: content });
                } else {
                    await say(chatId, `Acestes takes photos and text files from here, not ${escapeHtml(name)}.`);
                    return;
                }
            }
        } catch (error) {
            await say(chatId, `Could not fetch that from Telegram: ${escapeHtml(error?.message || 'unknown error')}`);
            return;
        }

        if (!text && images.length === 0 && files.length === 0) return;

        // A question waiting for an answer takes a typed reply as its answer.
        if (text && images.length === 0 && files.length === 0) {
            const chat = config.chat(chatId);
            const question = chat.conversationId ? openQuestion(chat.conversationId) : null;
            if (question && ai.respondToQuestion({ requestId: question.requestId, answer: text, chosen: false, by: 'telegram' })) return;
        }

        await sendToAgent(chatId, text, images, files);
    }

    async function fetchFile(fileId, maxBytes) {
        const client = getApi();
        if (!client) throw new Error('Telegram is not available');
        const file = await client.getFile(fileId);
        if (!file?.file_path) throw new Error('Telegram did not say where the file is');
        return client.download(file.file_path, { maxBytes });
    }

    async function sendToAgent(chatId, text, images = [], files = []) {
        let conversationId;
        try {
            conversationId = conversationFor(chatId);
        } catch (error) {
            await say(chatId, `Could not start a conversation: ${escapeHtml(error?.message || 'unknown error')}`);
            return;
        }
        beginTurn(conversationId, chatId);
        let result;
        try {
            result = await ai.send(conversationId, text, images, [], files, {
                channel: 'telegram',
                strict: telegram().approvals !== 'agent',
            });
        } catch (error) {
            result = { success: false, message: error?.message || 'unknown error' };
        }
        if (!result?.success) {
            const entry = live.get(conversationId);
            if (entry && entry.steps.length === 0) endTyping(entry);
            await say(chatId, `Could not send that: ${escapeHtml(result?.message || 'unknown error')}`);
        }
    }

    /* -------------------------------------------------------------- *
     * Commands
     * -------------------------------------------------------------- */

    async function runCommand(chatId, name, argument) {
        switch (name) {
            case 'help':
                await say(chatId, escapeHtml(HELP));
                return true;
            case 'new': {
                config.setChat(chatId, { conversationId: '' });
                const agent = agentFor(chatId);
                await say(chatId, `New conversation with ${escapeHtml(agent?.name || 'the agent')}. Send your first message.`);
                return true;
            }
            case 'stop': {
                const { conversationId } = config.chat(chatId);
                const found = conversationId ? ai.history(conversationId) : null;
                if (!found?.found || !found.busy) {
                    await say(chatId, 'Nothing is running.');
                    return true;
                }
                stopping.add(conversationId);
                try {
                    await ai.interrupt(conversationId);
                } finally {
                    stopping.delete(conversationId);
                }
                return true;
            }
            case 'status': {
                await say(chatId, statusText(chatId));
                return true;
            }
            case 'list':
                await showList(chatId);
                return true;
            case 'agent':
                if (argument) {
                    const wanted = argument.toLowerCase();
                    const all = agents.list();
                    const match = all.find(agent => agent.name.toLowerCase() === wanted)
                        || all.find(agent => agent.name.toLowerCase().startsWith(wanted));
                    if (!match) {
                        await say(chatId, `No agent is called "${escapeHtml(argument)}". Send /agent to see them.`);
                        return true;
                    }
                    await chooseAgent(chatId, match.id);
                    return true;
                }
                await showAgents(chatId);
                return true;
            default:
                // Anything else is the agent's: a skill, or just a slash.
                return false;
        }
    }

    function statusText(chatId) {
        const agent = agentFor(chatId);
        const { conversationId } = config.chat(chatId);
        const found = conversationId ? ai.history(conversationId) : null;
        const lines = [`<b>${escapeHtml(agent?.name || 'Agent')}</b> on ${escapeHtml(hostName)}`];
        if (found?.found) {
            lines.push(`Conversation: ${escapeHtml(format.clip(found.title || 'Untitled', 80))}`);
            lines.push(found.busy ? 'Working on it now.' : 'Idle.');
        } else {
            lines.push('No conversation yet: the next message starts one.');
        }
        lines.push(telegram().approvals === 'agent'
            ? 'Approvals: the same as on the desktop.'
            : 'Approvals: every change asks here first.');
        return lines.join('\n');
    }

    async function showList(chatId) {
        const agent = agentFor(chatId);
        const rows = (ai.list({ agentId: agent?.id || '' }) || []).slice(0, 8);
        if (rows.length === 0) {
            await say(chatId, 'No conversations yet. Send a message to start one.');
            return;
        }
        const { conversationId } = config.chat(chatId);
        const buttons = rows.map((row, index) => [{
            text: `${row.conversationId === conversationId ? '> ' : ''}${format.clip(row.title || 'Untitled', 48)}${row.busy ? ' (running)' : ''}`,
            callback_data: `o:${index}`,
        }]);
        buttons.push([{ text: 'New conversation', callback_data: 'n:0' }]);
        const sent = await say(chatId, `Recent conversations with ${escapeHtml(agent?.name || 'the agent')}:`, {
            reply_markup: { inline_keyboard: buttons },
        });
        if (sent?.message_id) menus.set(`${chatId}:${sent.message_id}`, rows.map(row => row.conversationId));
    }

    async function showAgents(chatId) {
        const all = agents.list();
        const current = agentFor(chatId);
        const buttons = all.slice(0, 20).map((agent, index) => [{
            text: `${agent.id === current?.id ? '> ' : ''}${format.clip(agent.name, 48)}`,
            callback_data: `g:${index}`,
        }]);
        const sent = await say(chatId, 'Which agent should answer here?', { reply_markup: { inline_keyboard: buttons } });
        if (sent?.message_id) menus.set(`${chatId}:${sent.message_id}`, all.slice(0, 20).map(agent => agent.id));
    }

    async function chooseAgent(chatId, agentId) {
        const agent = agents.get(agentId);
        if (!agent) return;
        config.setChat(chatId, { agentId: agent.id, conversationId: '' });
        await say(chatId, `Talking to ${escapeHtml(agent.name)} now. The next message starts a new conversation.`);
    }

    /* -------------------------------------------------------------- *
     * Buttons
     * -------------------------------------------------------------- */

    async function handleButton(query) {
        const owner = telegram().owner;
        const answer = text => quietly(getApi()?.answerCallbackQuery(query.id, text) || Promise.resolve());
        if (!owner || Number(query.from?.id) !== owner.userId) {
            await answer('');
            return;
        }
        lastMessageAt = now();
        const chatId = query.message?.chat?.id ?? owner.chatId;
        const messageId = query.message?.message_id;
        const [kind, key = '', value = ''] = String(query.data || '').split(':');

        if (kind === 'a') {
            const card = cards.get(key);
            if (!card || card.kind !== 'approval') return answer('This card is out of date.');
            const approved = value === 'y';
            const taken = ai.respondToApproval({ requestId: card.requestId, approved, by: 'telegram' });
            return answer(taken ? (approved ? 'Approved' : 'Denied') : 'Already answered');
        }

        if (kind === 'q') {
            const card = cards.get(key);
            const option = card?.options?.[Number(value)];
            if (!card || card.kind !== 'question' || option === undefined) return answer('This card is out of date.');
            if (!card.settled && ai.respondToQuestion({ requestId: card.requestId, answer: option, chosen: true, by: 'telegram' })) {
                return answer('Sent');
            }
            if (card.parked) {
                // Handed back to the agent already: the pick goes as the
                // next message, the way a late answer on the desktop does.
                markCard(card, `Answered: ${option}`);
                await answer('Sent');
                await sendToAgent(card.chatId, option);
                return undefined;
            }
            return answer('Already answered');
        }

        if (kind === 'x') {
            const entry = held.get(key);
            if (!entry) return answer('This message is out of date.');
            held.delete(key);
            await answer(value === 'run' ? 'Running it' : 'Discarded');
            if (messageId) {
                quietly(enqueue(chatId, client => client.editMessageReplyMarkup(chatId, messageId, null)));
            }
            if (value === 'run') await handleOwnerMessage(entry.message);
            else await say(chatId, 'Discarded.');
            return undefined;
        }

        if (kind === 'o' || kind === 'g') {
            const ids = menus.get(`${chatId}:${messageId}`);
            const picked = ids?.[Number(key)];
            if (!picked) return answer('This menu is out of date. Send the command again.');
            if (kind === 'g') {
                await answer('');
                await chooseAgent(chatId, picked);
                return undefined;
            }
            const found = ai.history(picked);
            if (!found?.found) return answer('That conversation is gone.');
            config.setChat(chatId, { conversationId: picked });
            await answer('');
            await say(chatId, `Carrying on in <b>${escapeHtml(format.clip(found.title || 'Untitled', 80))}</b>.${found.busy ? ' It is working right now.' : ''}`);
            return undefined;
        }

        if (kind === 'n') {
            config.setChat(chatId, { conversationId: '' });
            await answer('');
            await say(chatId, 'New conversation. Send your first message.');
            return undefined;
        }

        return answer('');
    }

    /* -------------------------------------------------------------- *
     * Turns: what the phone sees of one
     * -------------------------------------------------------------- */

    /**
     * A conversation the phone is following. Started by a message from the
     * phone, ended by one typed on the desktop: whoever spoke last is the
     * one the replies go to.
     */
    function beginTurn(conversationId, chatId) {
        let entry = live.get(conversationId);
        if (!entry || entry.chatId !== chatId) {
            entry = { conversationId, chatId, steps: [], texts: [], progress: null, startedAt: now(), typing: null, lastEventAt: now(), quiet: false, stoppedAt: 0 };
            live.set(conversationId, entry);
        }
        if (entry.steps.length === 0 && entry.texts.length === 0) entry.startedAt = now();
        entry.lastEventAt = now();
        startTyping(entry);
        return entry;
    }

    function startTyping(entry) {
        if (entry.typing) return;
        const tick = () => {
            if (live.get(entry.conversationId) !== entry || now() - entry.lastEventAt > TYPING_QUIET_LIMIT) {
                endTyping(entry);
                return;
            }
            quietly(enqueue(entry.chatId, client => client.sendChatAction(entry.chatId, 'typing')));
        };
        tick();
        entry.typing = setInterval(tick, typingInterval);
        entry.typing.unref?.();
    }

    function endTyping(entry) {
        if (entry?.typing) clearInterval(entry.typing);
        if (entry) entry.typing = null;
    }

    function progressHtml(entry, header) {
        const shown = entry.steps.slice(-PROGRESS_STEPS);
        const earlier = entry.steps.length - shown.length;
        const lines = [header];
        if (earlier > 0) lines.push(`<i>${escapeHtml(`+${earlier} earlier`)}</i>`);
        for (const step of shown) lines.push(`• ${escapeHtml(step)}`);
        return lines.join('\n');
    }

    /** The progress message, sent or edited, at most once per interval. */
    function scheduleProgress(entry) {
        if (entry.progressTimer) return;
        const since = now() - (entry.progressAt || 0);
        const delay = Math.max(0, progressInterval - since);
        entry.progressTimer = setTimeout(() => {
            entry.progressTimer = null;
            if (live.get(entry.conversationId) !== entry || entry.steps.length === 0) return;
            entry.progressAt = now();
            const html = progressHtml(entry, '<i>Working…</i>');
            const progress = entry.progress || (entry.progress = { messageId: 0, pending: null });
            progress.pending = quietly(enqueue(entry.chatId, async (client) => {
                if (progress.messageId) {
                    await editHtml(client, entry.chatId, progress.messageId, html);
                } else {
                    const sent = await sendHtml(client, entry.chatId, html, { disable_notification: true });
                    progress.messageId = sent?.message_id || 0;
                }
            }));
        }, delay);
        entry.progressTimer.unref?.();
    }

    /** Close the turn: settle the progress message and send what the agent said. */
    function finishTurn(entry, outcome) {
        if (entry.progressTimer) {
            clearTimeout(entry.progressTimer);
            entry.progressTimer = null;
        }
        endTyping(entry);
        const steps = entry.steps.length;
        const reply = entry.texts.join('\n\n').trim();
        const elapsed = duration(now() - entry.startedAt);
        const progress = entry.progress;
        const quiet = entry.quiet;

        entry.steps = [];
        entry.texts = [];
        entry.progress = null;
        entry.quiet = false;
        entry.startedAt = now();

        if (quiet) return;

        if (progress) {
            const line = outcome.kind === 'done'
                ? `Done: ${plural(steps, 'step')} in ${elapsed}.`
                : outcome.kind === 'stopped'
                    ? `Stopped after ${plural(steps, 'step')}.`
                    : `Ended after ${plural(steps, 'step')}.`;
            quietly(enqueue(entry.chatId, async (client) => {
                await progress.pending;
                if (progress.messageId) await editHtml(client, entry.chatId, progress.messageId, `<i>${escapeHtml(line)}</i>`);
            }));
        }

        if (outcome.kind === 'stopped') {
            say(entry.chatId, 'Stopped.');
            return;
        }
        if (outcome.kind === 'failed') {
            say(entry.chatId, `<b>The run stopped on an error.</b>\n${escapeHtml(format.clip(scrub(outcome.message || ''), 1500))}`);
            if (reply) sendReply(entry.chatId, reply);
            return;
        }
        if (reply) sendReply(entry.chatId, reply);
        else if (steps > 0) say(entry.chatId, 'Done.');
    }

    /** The desktop took over, or the conversation went: stop following it. */
    function leaveTurn(conversationId, note) {
        const entry = live.get(conversationId);
        if (!entry) return;
        live.delete(conversationId);
        if (entry.progressTimer) clearTimeout(entry.progressTimer);
        endTyping(entry);
        const progress = entry.progress;
        if (progress && note) {
            quietly(enqueue(entry.chatId, async (client) => {
                await progress.pending;
                if (progress.messageId) await editHtml(client, entry.chatId, progress.messageId, `<i>${escapeHtml(note)}</i>`);
            }));
        }
    }

    /* -------------------------------------------------------------- *
     * Cards
     * -------------------------------------------------------------- */

    /** Where a conversation's cards go: the phone following it, or a job that asked. */
    function cardChat(info) {
        const entry = live.get(info.conversationId);
        if (entry) return entry.chatId;
        if (info.jobId && info.runKind !== 'interactive') {
            const job = jobs.get(info.jobId);
            if (job?.delivery?.channel && telegram().owner) return telegram().owner.chatId;
        }
        return null;
    }

    function newCard(fields) {
        cardCounter += 1;
        const key = `c${cardCounter}`;
        const card = { key, settled: false, parked: false, messageId: 0, html: '', pending: null, ...fields };
        cards.set(key, card);
        cardOf.set(card.requestId, key);
        // A long session would otherwise keep every card it ever showed.
        if (cards.size > 200) {
            const oldest = cards.keys().next().value;
            const gone = cards.get(oldest);
            cards.delete(oldest);
            if (gone) cardOf.delete(gone.requestId);
        }
        return card;
    }

    function sendCard(card, html, buttons) {
        card.html = html;
        card.pending = quietly(enqueue(card.chatId, async (client) => {
            const sent = await sendHtml(client, card.chatId, html, buttons ? { reply_markup: { inline_keyboard: buttons } } : {});
            card.messageId = sent?.message_id || 0;
        }));
    }

    /** Settle a card on the phone: what happened, and no buttons. */
    function markCard(card, label) {
        card.settled = true;
        const html = `${card.html}\n\n<i>${escapeHtml(label)}</i>`;
        quietly(enqueue(card.chatId, async (client) => {
            await card.pending;
            if (card.messageId) await editHtml(client, card.chatId, card.messageId, html, { reply_markup: { inline_keyboard: [] } });
        }));
    }

    function approvalCard(info, event, chatId) {
        const entry = live.get(info.conversationId);
        if (entry) endTyping(entry);
        const from = event.via ? ` <i>(from ${escapeHtml(format.clip(event.viaTitle || 'another conversation', 60))})</i>` : '';
        const job = !entry && info.jobId ? ` <i>(job: ${escapeHtml(format.clip(info.title || 'a background run', 60))})</i>` : '';
        const where = event.host ? ` on <b>${escapeHtml(event.host)}</b>` : '';
        const html = [
            `<b>Approval needed</b>${from}${job}`,
            `${escapeHtml(event.title || event.name || 'A tool call')}${where}`,
            approvalBody(event),
        ].filter(Boolean).join('\n');
        const card = newCard({ kind: 'approval', requestId: event.requestId, conversationId: info.conversationId, chatId });
        sendCard(card, html, [[
            { text: 'Approve', callback_data: `a:${card.key}:y` },
            { text: 'Deny', callback_data: `a:${card.key}:n` },
        ]]);
    }

    function questionCard(info, event, chatId) {
        const entry = live.get(info.conversationId);
        if (entry) endTyping(entry);
        const from = event.via ? ` <i>(from ${escapeHtml(format.clip(event.viaTitle || 'another conversation', 60))})</i>` : '';
        const options = Array.isArray(event.options) ? event.options.map(String).slice(0, 6) : [];
        const card = newCard({
            kind: 'question',
            requestId: event.requestId,
            conversationId: info.conversationId,
            chatId,
            options,
            secret: Boolean(event.secret),
        });
        if (event.secret) {
            sendCard(card, `<b>The agent needs a secret</b>${from}\n${escapeHtml(event.question || '')}\n\n`
                + '<i>Answer this one on the desktop. Secrets never go through Telegram, whose bot chats are not end-to-end encrypted.</i>');
            return;
        }
        const buttons = options.map((option, index) => [{ text: format.clip(option, 60), callback_data: `q:${card.key}:${index}` }]);
        sendCard(card, `<b>Question</b>${from}\n${escapeHtml(event.question || '')}${options.length ? '' : '\n\n<i>Reply with your answer.</i>'}`,
            buttons.length ? buttons : null);
    }

    function settleApproval(event) {
        const card = cards.get(cardOf.get(event.requestId));
        if (!card || card.settled) return;
        const here = event.by === 'telegram';
        const stopped = stopping.has(card.conversationId);
        let label;
        switch (event.status) {
            case 'approved': label = here ? 'Approved.' : 'Approved on the desktop.'; break;
            case 'denied': label = stopped ? 'Not run: the agent was stopped.' : here ? 'Denied.' : 'Denied on the desktop.'; break;
            case 'expired': label = 'No longer waiting: not run.'; break;
            default: label = 'Settled.';
        }
        markCard(card, label);
        const entry = live.get(card.conversationId);
        if (entry && event.status === 'approved') startTyping(entry);
    }

    function settleQuestion(event) {
        const card = cards.get(cardOf.get(event.requestId));
        if (!card || card.settled) return;
        if (event.status === 'parked') {
            // Handed back to the agent with the card still up: a pick from
            // here now goes as the next message.
            card.parked = true;
            return;
        }
        const here = event.by === 'telegram';
        const label = event.status === 'answered'
            ? `${here ? 'Answered' : 'Answered on the desktop'}${card.secret ? '.' : `: ${format.clip(event.answer || '', 200)}`}`
            : stopping.has(card.conversationId) ? 'Dropped: the agent was stopped.' : 'Dismissed.';
        markCard(card, label);
        const entry = live.get(card.conversationId);
        if (entry && event.status === 'answered') startTyping(entry);
    }

    /* -------------------------------------------------------------- *
     * The assistant's events
     * -------------------------------------------------------------- */

    function observe(event, info) {
        if (!event || !info?.conversationId) return;
        if (!telegram().token || isLocked()) return;

        switch (event.type) {
            case 'approval-settled':
                settleApproval(event);
                return;
            case 'question-settled':
                settleQuestion(event);
                return;
            case 'approval-request': {
                const chatId = cardChat(info);
                if (chatId) approvalCard(info, event, chatId);
                return;
            }
            case 'question-request': {
                const chatId = cardChat(info);
                if (chatId) questionCard(info, event, chatId);
                return;
            }
            default:
                break;
        }

        const entry = live.get(info.conversationId);
        if (!entry) return;
        // A subagent's work, or a child conversation's, is not this turn's
        // reply; only its cards above are passed on.
        if (event.parentId || event.via) return;
        entry.lastEventAt = now();

        switch (event.type) {
            case 'user-message':
                if (event.channel) return;
                // The note-taking turn after a real one: not news, and not
                // the desktop taking over.
                if (info.remembering) {
                    entry.quiet = true;
                    return;
                }
                leaveTurn(info.conversationId, 'Carried on at the desktop.');
                return;
            case 'tool-call':
                if (entry.quiet) return;
                entry.steps.push(stepLine(event));
                // What the agent said before a tool call was narration; the
                // reply is what it says after the last one.
                entry.texts = [];
                scheduleProgress(entry);
                return;
            case 'assistant-text':
                if (event.text) entry.texts.push(String(event.text));
                return;
            case 'turn-resumed':
                startTyping(entry);
                return;
            case 'interrupted':
                entry.stoppedAt = now();
                finishTurn(entry, { kind: 'stopped' });
                return;
            case 'result':
                if (event.isError && event.subtype !== 'success') {
                    if (now() - entry.stoppedAt < 10000) return;
                    finishTurn(entry, { kind: 'failed', message: `The run ended early (${event.subtype || 'error'}).` });
                    return;
                }
                finishTurn(entry, { kind: 'done' });
                return;
            case 'error':
                if (now() - entry.stoppedAt < 10000) return;
                finishTurn(entry, { kind: 'failed', message: event.message || 'The agent reported an error.' });
                return;
            case 'closed':
                if (now() - entry.stoppedAt < 10000) return;
                finishTurn(entry, { kind: 'failed', message: 'The agent\'s process closed before the turn finished.' });
                return;
            default:
                break;
        }
    }

    /* -------------------------------------------------------------- *
     * The desktop's side: settings, pairing, outbound messages
     * -------------------------------------------------------------- */

    async function connect(rawToken) {
        const token = String(rawToken || '').trim();
        if (!TOKEN_SHAPE.test(token)) {
            return { error: 'That does not look like a bot token. @BotFather gives one shaped like 123456789:AA...' };
        }
        if (isLocked()) return { error: 'Unlock the app first.' };
        let me;
        try {
            me = await apiFactory(token).getMe();
        } catch (error) {
            if (error instanceof TelegramError && (error.status === 401 || error.status === 404)) {
                return { error: 'Telegram did not accept that token. Copy it again from @BotFather.' };
            }
            return { error: error?.message || 'Telegram could not be reached.' };
        }
        if (!me?.is_bot || !me.username) return { error: 'That token does not belong to a bot.' };

        const before = telegram();
        const sameBot = before.bot?.id === me.id;
        try {
            config.setToken(token);
        } catch (error) {
            return { error: `The token could not be stored: ${error?.message || 'unknown error'}` };
        }
        config.update({
            enabled: true,
            bot: { id: me.id, username: me.username, name: me.first_name || me.username },
            owner: sameBot ? before.owner : null,
            offset: sameBot ? before.offset : 0,
            chats: sameBot ? before.chats : {},
        });
        dropApi();
        commandsSet = false;
        audit({ action: 'channels.telegram-connected', detail: `Telegram bot @${me.username} connected` });
        startLoop();
        return status();
    }

    function disconnect() {
        stopLoop({ quiet: true });
        const before = telegram();
        for (const conversationId of [...live.keys()]) leaveTurn(conversationId, '');
        pairing = null;
        config.setToken('');
        config.update({ enabled: false, bot: null, owner: null, offset: 0, chats: {} });
        dropApi();
        if (before.bot) audit({ action: 'channels.telegram-disconnected', detail: `Telegram bot @${before.bot.username} disconnected` });
        setState('off');
        return status();
    }

    function pair() {
        const current = telegram();
        if (!current.token || !current.bot?.username) return { error: 'Connect a bot first.' };
        if (!current.enabled) {
            config.update({ enabled: true });
            startLoop();
        }
        if (pairing) expiredCodes.set(pairing.code, now());
        pairing = { code: randomCode(), expiresAt: now() + pairingTtl };
        const result = status();
        onChange(result);
        return result;
    }

    function cancelPair() {
        if (pairing) expiredCodes.set(pairing.code, now());
        pairing = null;
        const result = status();
        onChange(result);
        return result;
    }

    async function unpair() {
        const owner = telegram().owner;
        if (owner) {
            await say(owner.chatId, 'This chat is no longer connected to Acestes.');
            audit({ action: 'channels.telegram-unpaired', detail: `Telegram account ${owner.username ? `@${owner.username}` : owner.name} can no longer talk to the agent` });
        }
        for (const conversationId of [...live.keys()]) leaveTurn(conversationId, '');
        config.update({ owner: null, chats: {} });
        const result = status();
        onChange(result);
        return result;
    }

    function update(patch = {}) {
        const next = {};
        if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
        if (patch.approvals !== undefined) next.approvals = patch.approvals;
        if (patch.agentId !== undefined) next.agentId = String(patch.agentId || '');
        const before = telegram();
        const after = config.update(next);
        if (before.approvals !== after.approvals) {
            audit({
                action: 'channels.telegram-approvals',
                detail: after.approvals === 'agent'
                    ? 'Turns from Telegram now follow the agent\'s own approval mode'
                    : 'Turns from Telegram now ask before every change',
            });
        }
        if (before.enabled !== after.enabled) {
            if (after.enabled) startLoop();
            else stopLoop();
        }
        const result = status();
        onChange(result);
        return result;
    }

    async function test() {
        const owner = telegram().owner;
        if (!owner) return { error: 'Pair your Telegram account first.' };
        if (!ready()) return { error: 'Telegram is not running right now.' };
        try {
            await enqueue(owner.chatId, client => sendHtml(client, owner.chatId,
                `Acestes on ${escapeHtml(hostName)} can reach you here. Send a message to talk to ${escapeHtml(agentFor(owner.chatId)?.name || 'your agent')}.`));
            return { sent: true };
        } catch (error) {
            return { error: error?.message || 'The message did not go.' };
        }
    }

    /** For `message_user`: the agent telling the user something first. */
    async function messageOwner({ text, from = '' } = {}) {
        const owner = telegram().owner;
        if (!telegram().token || !owner) {
            return { error: 'No phone is paired: the user has not connected Telegram in Settings, Channels.' };
        }
        if (!ready()) return { error: 'Telegram is switched off or not reachable right now.' };
        const body = String(text || '').trim();
        if (!body) return { error: 'There is nothing to send.' };
        const heading = from ? `**${from}**\n\n` : '';
        try {
            const messages = format.toMessages(scrub(`${heading}${body}`));
            await enqueue(owner.chatId, async (client) => {
                for (const html of messages.slice(0, MAX_REPLY_MESSAGES)) await sendHtml(client, owner.chatId, html);
            });
            return { sent: true, channel: 'telegram' };
        } catch (error) {
            return { error: error?.message || 'The message did not go.' };
        }
    }

    /** A job's result, for a job whose delivery asks for the phone. */
    function deliverJob(job, run) {
        const owner = telegram().owner;
        if (!job?.delivery?.channel || !owner || !ready()) return;
        const statusWord = run.status === 'done' ? 'finished' : run.status;
        const summary = run.result?.summary || run.result?.reason || '';
        sendReply(owner.chatId, `**${job.name}** ${statusWord}\n\n${summary || '(no summary)'}`);
    }

    /** The window is closing, which ends every conversation's turn. */
    function appClosing() {
        for (const [conversationId, entry] of [...live]) {
            const busy = entry.steps.length > 0 || entry.typing;
            leaveTurn(conversationId, busy ? 'Stopped: the Acestes window was closed.' : '');
            if (busy) say(entry.chatId, 'The Acestes window was closed, which stopped this turn. Send the message again to carry on.');
        }
    }

    function start() {
        if (!unobserve && typeof ai.observe === 'function') unobserve = ai.observe(observe);
        if (telegram().enabled && telegram().token) startLoop();
        else setState('off');
    }

    function stop() {
        stopLoop({ quiet: true });
        for (const entry of live.values()) {
            endTyping(entry);
            if (entry.progressTimer) clearTimeout(entry.progressTimer);
        }
        live.clear();
        unobserve?.();
        unobserve = null;
    }

    /** Whether the app should stay up with no window, to keep answering. */
    function keepAlive() {
        const current = telegram();
        return Boolean(current.enabled && current.token && current.owner);
    }

    return {
        start,
        stop,
        status,
        connect,
        disconnect,
        pair,
        cancelPair,
        unpair,
        update,
        test,
        messageOwner,
        deliverJob,
        appClosing,
        keepAlive,
        ready,
        // For the tests.
        _observe: observe,
        _live: live,
        _cards: cards,
    };
}

module.exports = { createTelegramGateway, randomCode, stepLine, approvalBody, COMMANDS, STALE_AFTER, PAIRING_TTL };
