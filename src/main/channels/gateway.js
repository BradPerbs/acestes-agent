const crypto = require('crypto');
const os = require('os');
const format = require('./format');

/**
 * A channel's gateway: the user's own bot on a chat app, answering only
 * them, with each message a turn in an Acestes conversation and the turn
 * shown back in the chat as it goes.
 *
 * It is the gateway OpenClaw and Hermes run as a daemon, built into the main
 * process instead, because the main process already is one: it outlives the
 * window, holds every conversation, and settles approvals and questions by
 * request id. So this file is mostly translation, in both directions, plus
 * the rules about who may talk to it. The chat app itself is an adapter
 * (telegram.js, discord.js, slack.js, matrix.js): how to reach it, how its
 * messages arrive, and how it draws Markdown and buttons. Everything said
 * here is Markdown, and the adapter turns it into what its app shows.
 *
 * Trust, in the order it is checked:
 *
 *   - Private chats only, and only the one account that was paired, by a
 *     one-time code from the desktop. Everyone else is ignored without an
 *     answer, so a stranger who finds the bot learns nothing from it.
 *   - Nothing at all while the app is locked: the credentials cannot be
 *     read, and the listener waits for the unlock.
 *   - A message older than ten minutes when it arrives (sent while the app
 *     was closed) is not run, it is offered: "restart nginx" sent last night
 *     should not run by itself this morning.
 *   - A turn from a channel asks before every change, whatever the agent's
 *     own approval mode, unless the user chose otherwise. A phone or a chat
 *     account is weaker proof of who is there than the desk is. See `strict`
 *     in ai/index.js.
 *   - A question that wants a secret is never answered here. Bot chats are
 *     not end-to-end encrypted, Matrix rooms included as far as Acestes goes.
 *
 * Outbound, for a turn the chat started: a typing indicator where the app
 * has one, one progress message edited in place as tools are called,
 * approval and question cards with buttons, and the reply as a new message
 * so the phone notifies. The first answer to a card wins, from the chat or
 * the desktop, and the other side is updated to say so.
 *
 * The adapter's side of it:
 *
 *   name, label, target   'slack', 'Slack', the format.js target
 *   prefix                how its commands are typed ('/' or '!')
 *   typing                whether it has a typing indicator
 *   prepare(raw)          the settings page's fields -> { credentials } | { error }
 *   verify(credentials)   -> the bot's identity ({ id, ... }), or throws
 *   pairLink, pairText    (identity, code) -> how the user sends the code
 *   client(credentials, identity) -> {
 *       listen({ signal, cursor, owner, emit, setCursor, onReady, accept })
 *       send(chatId, { markdown | formatted, buttons, silent }) -> { id }
 *       edit(chatId, messageId, { markdown | formatted, buttons })
 *       typing(chatId), fetch(attachment, maxBytes), sendFile?(chatId, file)
 *   }
 *
 * `listen` runs until its signal aborts, calling `emit` with each message,
 * button press or command, normalised; it throws an error with `kind`
 * 'auth', 'conflict' or 'webhook' for the failures that are not a network
 * blip.
 */

/** A message older than this when it arrives is offered rather than run. */
const STALE_AFTER = 10 * 60 * 1000;
/** How long a pairing code is good for. */
const PAIRING_TTL = 10 * 60 * 1000;
/** The fewest milliseconds between two edits of the progress message. */
const PROGRESS_INTERVAL = 3000;
/** Typing indicators last about five seconds; renewed a little sooner. */
const TYPING_INTERVAL = 4500;
/** Typing stops after this long without a word from the turn. */
const TYPING_QUIET_LIMIT = 5 * 60 * 1000;
/** Steps shown in the progress message; the rest are counted. */
const PROGRESS_STEPS = 6;
/** A reply longer than this many messages goes as a file after the first. */
const MAX_REPLY_MESSAGES = 4;
/** Without files, how many messages a reply may take before it is cut. */
const MAX_REPLY_WITHOUT_FILES = 8;
/** The image cap `send` enforces. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The text file cap `send` enforces. */
const MAX_FILE_CHARS = 64 * 1024;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_EXTENSIONS = /\.(txt|md|markdown|log|json|ya?ml|toml|ini|conf|cfg|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|sql|env|service|tf|dockerfile)$/i;

const md = format.escapeMarkdown;

function helpText(prefix) {
    return [
        'Send a message and the agent works on it in Acestes, on your computer.',
        '',
        `${prefix}new  start a new conversation`,
        `${prefix}list  pick up a recent conversation`,
        `${prefix}stop  stop the agent`,
        `${prefix}status  what it is doing`,
        `${prefix}agent  choose which agent to talk to`,
        '',
        'Changes it wants to make wait for your Approve. Photos and text files can be sent too.',
    ].join('\n');
}

function randomCode(length = 10) {
    const bytes = crypto.randomBytes(length);
    let out = '';
    for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    return out;
}

function sameCode(a, b) {
    const left = Buffer.from(String(a || '').toUpperCase());
    const right = Buffer.from(String(b || '').toUpperCase());
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

/** What an approval card shows of the call it is about, as Markdown. */
function approvalBody(event) {
    const input = event.input && typeof event.input === 'object' ? event.input : {};
    if (typeof input.command === 'string') return format.codeBlock(format.clip(input.command, 1500));
    if (event.diff?.path) return `\`${String(event.diff.path).replace(/`/g, "'")}\`  +${event.diff.added || 0} -${event.diff.removed || 0}`;
    const rows = Object.entries(input)
        .filter(([key, value]) => key !== 'session' && value !== undefined && value !== null && value !== '')
        .slice(0, 8)
        .map(([key, value]) => `${key}: ${format.clip(typeof value === 'string' ? value : JSON.stringify(value), 300)}`);
    return rows.length ? format.codeBlock(rows.join('\n')) : '';
}

/**
 * The gateway, given its adapter and what it drives.
 *
 *   adapter   the chat app (see above)
 *   section   this channel's part of channels/config.js
 *   ai        create, send, interrupt, respondToApproval, respondToQuestion,
 *             observe, list, history: the assistant core, or a stand-in
 *   agents    list() -> [{ id, name }], activeId(), get(id)
 *   jobs      get(id), for whether a job's cards and results come here
 *   isLocked  whether the vault is locked
 *   scrub     masks stored secrets out of text leaving the machine
 *   onChange  told the status whenever it moves, for the settings page
 *   audit     an activity-log entry, for pairing and unpairing
 */
function createGateway(deps = {}) {
    const {
        adapter,
        section,
        ai,
        agents,
        jobs = { get: () => null },
        isLocked = () => false,
        scrub = text => text,
        onChange = () => {},
        audit = () => {},
        now = () => Date.now(),
        staleAfter = STALE_AFTER,
        pairingTtl = PAIRING_TTL,
        progressInterval = PROGRESS_INTERVAL,
        typingInterval = TYPING_INTERVAL,
        retryDelay = 2000,
        conflictDelay = 60000,
        lockCheck = 3000,
        hostName = os.hostname(),
        log = console,
    } = deps;

    const label = adapter.label;
    const prefix = adapter.prefix || '/';

    let client = null;
    let running = false;
    let generation = 0;
    let controller = null;
    let listening = null;
    let lockTimer = null;
    let unobserve = null;
    let state = 'off';
    let stateMessage = '';
    let lastMessageAt = 0;

    /** { code, expiresAt } while the desktop is waiting for a pairing. */
    let pairing = null;
    /** Codes that have run out, so a late try is told rather than ignored. */
    const expiredCodes = new Map();

    /** conversationId -> the chat's view of its turn. See `beginTurn`. */
    const live = new Map();
    /** card key -> an approval or question card in the chat. */
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
    /** Conversations being stopped from the chat, for how their cards read. */
    const stopping = new Set();
    /** Messages already handled, by chat and id, so one delivered twice runs once. */
    const seen = new Set();

    /* -------------------------------------------------------------- *
     * State
     * -------------------------------------------------------------- */

    const config = () => section.get();

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
        const current = config();
        const open = currentPairing();
        const identity = current.identity;
        return {
            name: adapter.name,
            label,
            prefix,
            connected: Boolean(current.secret),
            identity: identity ? { ...identity } : null,
            setup: identity && adapter.setup ? adapter.setup(identity) : null,
            // How the app is made on the service's side, where it is made from one (Slack).
            manifest: adapter.manifest || null,
            enabled: current.enabled,
            state,
            message: stateMessage,
            owner: current.owner
                ? { name: current.owner.name, username: current.owner.username, pairedAt: current.owner.pairedAt }
                : null,
            pairing: open && identity ? {
                code: open.code,
                link: adapter.pairLink?.(identity, open.code) || '',
                text: adapter.pairText?.(identity, open.code) || open.code,
                expiresAt: open.expiresAt,
            } : null,
            agentId: current.agentId,
            approvals: current.approvals,
            lastMessageAt,
        };
    }

    /** Whether there is someone to send to, right now. */
    function ready() {
        const current = config();
        return Boolean(current.enabled && current.secret && current.owner && !isLocked() && state !== 'unauthorized');
    }

    function getClient() {
        if (isLocked()) {
            // The credentials are not held while the app is locked.
            client = null;
            return null;
        }
        if (client) return client;
        const credentials = section.credentials();
        if (!credentials) return null;
        client = adapter.client(credentials, config().identity || {});
        return client;
    }

    function dropClient() {
        try {
            client?.close?.();
        } catch {
            // Already closed.
        }
        client = null;
    }

    const isOwner = from => Boolean(from && config().owner && String(from.id) === config().owner.userId);

    /* -------------------------------------------------------------- *
     * Sending
     * -------------------------------------------------------------- */

    /**
     * Every call to one chat goes through its queue, in order. The apps
     * limit a chat to about a message a second, and a progress edit landing
     * after the reply it was meant to precede reads as the agent still
     * working when it has finished.
     */
    function enqueue(chatId, task) {
        const key = String(chatId);
        const previous = queues.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(() => {
            const current = getClient();
            if (!current) throw new Error(`${label} is not available`);
            return task(current);
        });
        queues.set(key, next.catch(() => {}));
        return next;
    }

    const quietly = promise => promise.catch((error) => {
        if (!/not modified/i.test(error?.message || '')) log.error?.(`${label}:`, error?.message || error);
        return null;
    });

    /** A short note from the gateway itself, in Markdown. */
    function say(chatId, markdown, extra = {}) {
        return quietly(enqueue(chatId, current => current.send(String(chatId), { markdown, ...extra })));
    }

    /** The agent's Markdown, as one or more messages, or a file when it is long. */
    function sendReply(chatId, markdown) {
        const text = scrub(String(markdown || '')).trim();
        if (!text) return Promise.resolve();
        const messages = format.toMessages(text, { target: adapter.target });
        return quietly(enqueue(chatId, async (current) => {
            if (messages.length <= MAX_REPLY_MESSAGES) {
                for (const formatted of messages) await current.send(String(chatId), { formatted });
                return;
            }
            if (typeof current.sendFile === 'function') {
                await current.send(String(chatId), { formatted: messages[0] });
                await current.sendFile(String(chatId), {
                    name: 'reply.md',
                    text,
                    caption: `The full reply, ${plural(messages.length, 'message')} long.`,
                });
                return;
            }
            for (const formatted of messages.slice(0, MAX_REPLY_WITHOUT_FILES)) await current.send(String(chatId), { formatted });
            if (messages.length > MAX_REPLY_WITHOUT_FILES) {
                await current.send(String(chatId), { markdown: '_The reply was cut short here. The rest is in the conversation in Acestes._' });
            }
        }));
    }

    /* -------------------------------------------------------------- *
     * Listening
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

    async function run(own) {
        let backoff = retryDelay;
        while (running && own === generation) {
            if (isLocked()) {
                dropClient();
                setState('locked', `The app is locked. Messages wait in ${label} until it is unlocked.`);
                await wait(5000);
                continue;
            }
            const current = getClient();
            if (!current) {
                setState('error', `The ${label} credentials could not be read. Connect again.`);
                await wait(10000);
                continue;
            }
            listening = new AbortController();
            const signal = AbortSignal.any([controller.signal, listening.signal]);
            try {
                await current.listen({
                    signal,
                    cursor: config().cursor,
                    owner: config().owner,
                    emit: event => handleEvent(event).catch((error) => {
                        log.error?.(`${label}: could not handle a message:`, error?.message || error);
                    }),
                    setCursor: (value) => {
                        if (String(value) !== config().cursor) section.update({ cursor: String(value) });
                    },
                    onReady: () => {
                        backoff = retryDelay;
                        setState('running');
                    },
                    // A room it is invited to (Matrix): taken while the
                    // desktop is pairing, or from the paired account.
                    accept: from => Boolean(currentPairing()) || isOwner(from),
                });
                if (!running || own !== generation) break;
                // Ended cleanly: a refresh the service asked for, or a lock.
                await wait(signal.aborted ? 0 : 500);
            } catch (error) {
                if (!running || own !== generation) break;
                if (listening.signal.aborted) continue;
                if (error?.kind === 'auth') {
                    dropClient();
                    running = false;
                    setState('unauthorized', error.message || `${label} no longer accepts these credentials. Connect again.`);
                    break;
                }
                if (error?.kind === 'conflict' || error?.kind === 'webhook') {
                    setState(error.kind, error.message);
                    await wait(conflictDelay);
                    continue;
                }
                if (error?.kind === 'fatal') {
                    running = false;
                    setState('error', error.message);
                    break;
                }
                setState('offline', error?.message || `${label} could not be reached.`);
                await wait(backoff);
                backoff = Math.min(backoff * 2, 60000);
            } finally {
                listening = null;
            }
        }
    }

    function startLoop() {
        stopLoop({ quiet: true });
        const current = config();
        if (!current.enabled || !current.secret) {
            setState('off');
            return;
        }
        generation += 1;
        running = true;
        controller = new AbortController();
        setState('starting');
        // A connection that stays open (a WebSocket) is closed on a lock
        // rather than waited out: nothing is read while locked.
        lockTimer = setInterval(() => {
            if (isLocked() && listening) listening.abort();
        }, lockCheck);
        lockTimer.unref?.();
        run(generation).catch((error) => {
            log.error?.(`${label} stopped listening:`, error?.message || error);
        });
    }

    function stopLoop({ quiet = false } = {}) {
        running = false;
        generation += 1;
        controller?.abort();
        controller = null;
        if (lockTimer) clearInterval(lockTimer);
        lockTimer = null;
        dropClient();
        if (!quiet) setState('off');
    }

    /* -------------------------------------------------------------- *
     * Inbound
     * -------------------------------------------------------------- */

    async function handleEvent(event) {
        if (!event) return;
        if (event.id && event.chatId) {
            const key = `${event.chatId}:${event.id}`;
            if (seen.has(key)) return;
            seen.add(key);
            if (seen.size > 1000) seen.delete(seen.values().next().value);
        }
        if (event.type === 'button') {
            await handleButton(event);
            return;
        }
        if (event.type === 'command') {
            try {
                if (!isOwner(event.from) || !event.private) return;
                lastMessageAt = now();
                const handled = await runCommand(event.chatId, String(event.name || '').toLowerCase(), String(event.argument || '').trim());
                if (!handled) await sendToAgent(event.chatId, `/${event.name}${event.argument ? ` ${event.argument}` : ''}`);
            } finally {
                await event.done?.();
            }
            return;
        }
        if (event.type !== 'message' || !event.from || event.from.bot) return;
        // Private chats only: a group would put the agent in front of
        // everyone in it.
        if (!event.private) return;

        const owner = config().owner;
        const text = String(event.text || '').trim();

        if (event.encrypted) {
            if (isOwner(event.from) || currentPairing()) {
                await say(event.chatId, adapter.encryptedNote || 'This chat is end-to-end encrypted, which Acestes cannot read. Use one without encryption.');
            }
            return;
        }

        // The code arrives as Telegram's deep link sends it (/start CODE), as
        // a command (!pair CODE), as "pair CODE", or pasted on its own. Words
        // without a prefix are only read as a code in that exact shape, so
        // "start nginx" from the owner goes to the agent.
        const start = /^[/!](?:start|pair)(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text);
        const spoken = /^pair\s+([A-Za-z0-9]{8,16})\s*$/i.exec(text);
        const bare = /^([A-Za-z0-9]{8,16})$/.exec(text);
        const code = start?.[1] || spoken?.[1] || (currentPairing() && !isOwner(event.from) ? bare?.[1] : '');
        if (code && tryPair(event, code)) return;
        if (!owner || !isOwner(event.from)) return;

        lastMessageAt = now();
        if (start) {
            await say(event.chatId, helpText(prefix));
            return;
        }

        const age = now() - Number(event.date || 0);
        if (event.date && age > staleAfter) {
            await offerStale(event, age);
            return;
        }
        await handleOwnerMessage(event);
    }

    function tryPair(event, code) {
        const open = currentPairing();
        if (open && sameCode(code, open.code)) {
            const from = event.from;
            const name = from.name || from.username || `${label} user`;
            pairing = null;
            const before = config().owner;
            section.update({
                owner: {
                    userId: String(from.id),
                    chatId: String(event.chatId),
                    name,
                    username: from.username || '',
                    pairedAt: now(),
                },
            });
            section.setChat(event.chatId, { conversationId: '', agentId: section.chat(event.chatId).agentId || '' });
            audit({
                action: `channels.${adapter.name}-paired`,
                detail: `${label} account ${from.username ? `@${from.username}` : name} (id ${from.id}) can now talk to the agent`
                    + (before && before.userId !== String(from.id) ? `, replacing ${before.username ? `@${before.username}` : before.name}` : ''),
            });
            const agent = agentFor(event.chatId);
            say(event.chatId, `**Paired with Acestes on ${md(hostName)}.**\n\n`
                + `Send a message to talk to ${md(agent?.name || 'your agent')}.\n\n${helpText(prefix)}`);
            onChange(status());
            return true;
        }
        // A code that ran out is answered, so a late try does not look like
        // a dead bot. A code nobody issued is not.
        for (const [old, at] of expiredCodes) {
            if (now() - at > 24 * 60 * 60 * 1000) expiredCodes.delete(old);
        }
        if ([...expiredCodes.keys()].some(old => sameCode(old, code))) {
            say(event.chatId, 'That pairing code has run out. Make a new one in Acestes: Settings, Channels.');
            return true;
        }
        return false;
    }

    async function offerStale(event, age) {
        heldCounter += 1;
        const key = `h${heldCounter}`;
        held.set(key, { event });
        const preview = format.clip(event.text || '(an attachment)', 200);
        await say(event.chatId,
            `This message reached Acestes ${duration(age)} after you sent it, while the app was closed or asleep, so it has not been run:\n\n`
            + `> ${md(preview)}`,
            { buttons: [[
                { text: 'Run it now', data: `x:${key}:run`, style: 'primary', emoji: '▶️' },
                { text: 'Discard', data: `x:${key}:drop`, emoji: '🗑️' },
            ]] });
    }

    function agentFor(chatId) {
        const chosen = section.chat(chatId).agentId || config().agentId;
        return (chosen && agents.get(chosen)) || agents.get(agents.activeId()) || null;
    }

    /** The conversation a chat is in, started if it has none or it is gone. */
    function conversationFor(chatId) {
        const chat = section.chat(chatId);
        if (chat.conversationId) {
            const found = ai.history(chat.conversationId);
            if (found?.found) return chat.conversationId;
        }
        const agent = agentFor(chatId);
        const created = ai.create({ agentId: agent?.id || '', scope: 'global' });
        section.setChat(chatId, { conversationId: created.conversationId });
        return created.conversationId;
    }

    /** The question card still open in a conversation, if there is one. */
    function openQuestion(conversationId) {
        for (const card of cards.values()) {
            if (card.kind === 'question' && card.conversationId === conversationId && !card.settled && !card.parked && !card.secret) return card;
        }
        return null;
    }

    async function handleOwnerMessage(event) {
        const chatId = event.chatId;
        const text = String(event.text || '').trim();
        const attachments = Array.isArray(event.attachments) ? event.attachments : [];

        const command = /^[/!]([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
        if (command && attachments.length === 0) {
            const handled = await runCommand(chatId, command[1].toLowerCase(), (command[2] || '').trim());
            if (handled) return;
        }

        if (attachments.some(item => item.kind === 'voice')) {
            await say(chatId, 'Voice notes are not supported yet. Type the message instead.');
            return;
        }

        const images = [];
        const files = [];
        try {
            for (const item of attachments.slice(0, 5)) {
                const name = String(item.name || 'file').slice(0, 120);
                const type = String(item.mediaType || '').toLowerCase();
                if (item.kind === 'image' || IMAGE_TYPES.has(type)) {
                    if (item.size > MAX_IMAGE_BYTES) {
                        await say(chatId, `${md(name)} is larger than the 5 MB an image may be. Send it smaller.`);
                        return;
                    }
                    const data = await enqueueFetch(item, MAX_IMAGE_BYTES);
                    images.push({ name, mediaType: IMAGE_TYPES.has(type) ? type : 'image/jpeg', data: data.toString('base64') });
                } else if (type.startsWith('text/') || /json|xml|yaml|toml|javascript|x-sh|sql|csv/.test(type) || TEXT_EXTENSIONS.test(name)) {
                    if (item.size > MAX_FILE_CHARS * 2) {
                        await say(chatId, `${md(name)} is larger than the 64 KB a text file may be.`);
                        return;
                    }
                    const content = (await enqueueFetch(item, MAX_FILE_CHARS * 4)).toString('utf8');
                    if (content.includes('\u0000')) {
                        await say(chatId, `${md(name)} does not read as text.`);
                        return;
                    }
                    if (content.length > MAX_FILE_CHARS) {
                        await say(chatId, `${md(name)} is larger than the 64 KB a text file may be.`);
                        return;
                    }
                    files.push({ name, mediaType: type || 'text/plain', text: content });
                } else {
                    await say(chatId, `Acestes takes photos and text files from here, not ${md(name)}.`);
                    return;
                }
            }
        } catch (error) {
            await say(chatId, `Could not fetch that from ${label}: ${md(error?.message || 'unknown error')}`);
            return;
        }

        if (!text && images.length === 0 && files.length === 0) return;

        // A question waiting for an answer takes a typed reply as its answer.
        if (text && images.length === 0 && files.length === 0) {
            const chat = section.chat(chatId);
            const question = chat.conversationId ? openQuestion(chat.conversationId) : null;
            if (question && ai.respondToQuestion({ requestId: question.requestId, answer: text, chosen: false, by: adapter.name })) return;
        }

        await sendToAgent(chatId, text, images, files);
    }

    function enqueueFetch(item, maxBytes) {
        const current = getClient();
        if (!current) return Promise.reject(new Error(`${label} is not available`));
        return current.fetch(item, maxBytes);
    }

    async function sendToAgent(chatId, text, images = [], files = []) {
        let conversationId;
        try {
            conversationId = conversationFor(chatId);
        } catch (error) {
            await say(chatId, `Could not start a conversation: ${md(error?.message || 'unknown error')}`);
            return;
        }
        beginTurn(conversationId, chatId);
        let result;
        try {
            result = await ai.send(conversationId, text, images, [], files, {
                channel: adapter.name,
                strict: config().approvals !== 'agent',
            });
        } catch (error) {
            result = { success: false, message: error?.message || 'unknown error' };
        }
        if (!result?.success) {
            const entry = live.get(conversationId);
            if (entry && entry.steps.length === 0) endTyping(entry);
            await say(chatId, `Could not send that: ${md(result?.message || 'unknown error')}`);
        }
    }

    /* -------------------------------------------------------------- *
     * Commands
     * -------------------------------------------------------------- */

    async function runCommand(chatId, name, argument) {
        switch (name) {
            case 'help':
            case 'start':
                await say(chatId, helpText(prefix));
                return true;
            case 'new': {
                section.setChat(chatId, { conversationId: '' });
                const agent = agentFor(chatId);
                await say(chatId, `New conversation with ${md(agent?.name || 'the agent')}. Send your first message.`);
                return true;
            }
            case 'stop': {
                const { conversationId } = section.chat(chatId);
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
            case 'status':
                await say(chatId, statusText(chatId));
                return true;
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
                        await say(chatId, `No agent is called "${md(argument)}". Send ${prefix}agent to see them.`);
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
        const { conversationId } = section.chat(chatId);
        const found = conversationId ? ai.history(conversationId) : null;
        const lines = [`**${md(agent?.name || 'Agent')}** on ${md(hostName)}`];
        if (found?.found) {
            lines.push(`Conversation: ${md(format.clip(found.title || 'Untitled', 80))}`);
            lines.push(found.busy ? 'Working on it now.' : 'Idle.');
        } else {
            lines.push('No conversation yet: the next message starts one.');
        }
        lines.push(config().approvals === 'agent'
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
        const { conversationId } = section.chat(chatId);
        const buttons = rows.map((row, index) => [{
            text: `${row.conversationId === conversationId ? '> ' : ''}${format.clip(row.title || 'Untitled', 48)}${row.busy ? ' (running)' : ''}`,
            data: `o:${index}`,
        }]);
        buttons.push([{ text: 'New conversation', data: 'n:0' }]);
        const sent = await say(chatId, `Recent conversations with ${md(agent?.name || 'the agent')}:`, { buttons });
        if (sent?.id) menus.set(`${chatId}:${sent.id}`, rows.map(row => row.conversationId));
    }

    async function showAgents(chatId) {
        const all = agents.list().slice(0, 20);
        const current = agentFor(chatId);
        const buttons = all.map((agent, index) => [{
            text: `${agent.id === current?.id ? '> ' : ''}${format.clip(agent.name, 48)}`,
            data: `g:${index}`,
        }]);
        const sent = await say(chatId, 'Which agent should answer here?', { buttons });
        if (sent?.id) menus.set(`${chatId}:${sent.id}`, all.map(agent => agent.id));
    }

    async function chooseAgent(chatId, agentId) {
        const agent = agents.get(agentId);
        if (!agent) return;
        section.setChat(chatId, { agentId: agent.id, conversationId: '' });
        await say(chatId, `Talking to ${md(agent.name)} now. The next message starts a new conversation.`);
    }

    /* -------------------------------------------------------------- *
     * Buttons
     * -------------------------------------------------------------- */

    async function handleButton(event) {
        const answer = text => quietly(Promise.resolve(event.ack?.(text)));
        if (!isOwner(event.from)) {
            await answer('');
            return undefined;
        }
        lastMessageAt = now();
        const chatId = event.chatId || config().owner.chatId;
        const messageId = event.messageId;
        const [kind, key = '', value = ''] = String(event.data || '').split(':');

        if (kind === 'a') {
            const card = cards.get(key);
            if (!card || card.kind !== 'approval') return answer('This card is out of date.');
            const approved = value === 'y';
            const taken = ai.respondToApproval({ requestId: card.requestId, approved, by: adapter.name });
            return answer(taken ? (approved ? 'Approved' : 'Denied') : 'Already answered');
        }

        if (kind === 'q') {
            const card = cards.get(key);
            const option = card?.options?.[Number(value)];
            if (!card || card.kind !== 'question' || option === undefined) return answer('This card is out of date.');
            if (!card.settled && ai.respondToQuestion({ requestId: card.requestId, answer: option, chosen: true, by: adapter.name })) {
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
                const note = value === 'run' ? '_Running it now._' : '_Discarded._';
                quietly(enqueue(chatId, current => current.edit(String(chatId), messageId, { markdown: note, buttons: null })));
            }
            if (value === 'run') await handleOwnerMessage(entry.event);
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
            section.setChat(chatId, { conversationId: picked });
            await answer('');
            await say(chatId, `Carrying on in **${md(format.clip(found.title || 'Untitled', 80))}**.${found.busy ? ' It is working right now.' : ''}`);
            return undefined;
        }

        if (kind === 'n') {
            section.setChat(chatId, { conversationId: '' });
            await answer('');
            await say(chatId, 'New conversation. Send your first message.');
            return undefined;
        }

        return answer('');
    }

    /* -------------------------------------------------------------- *
     * Turns: what the chat sees of one
     * -------------------------------------------------------------- */

    /**
     * A conversation the chat is following. Started by a message from the
     * chat, ended by one typed on the desktop: whoever spoke last is the one
     * the replies go to.
     */
    function beginTurn(conversationId, chatId) {
        let entry = live.get(conversationId);
        if (!entry || entry.chatId !== String(chatId)) {
            entry = { conversationId, chatId: String(chatId), steps: [], texts: [], progress: null, startedAt: now(), typing: null, lastEventAt: now(), quiet: false, stoppedAt: 0 };
            live.set(conversationId, entry);
        }
        if (entry.steps.length === 0 && entry.texts.length === 0) entry.startedAt = now();
        entry.lastEventAt = now();
        startTyping(entry);
        return entry;
    }

    function startTyping(entry) {
        if (entry.typing || !adapter.typing) return;
        const tick = () => {
            if (live.get(entry.conversationId) !== entry || now() - entry.lastEventAt > TYPING_QUIET_LIMIT) {
                endTyping(entry);
                return;
            }
            quietly(enqueue(entry.chatId, current => current.typing(entry.chatId)));
        };
        tick();
        entry.typing = setInterval(tick, typingInterval);
        entry.typing.unref?.();
    }

    function endTyping(entry) {
        if (entry?.typing) clearInterval(entry.typing);
        if (entry) entry.typing = null;
    }

    function progressText(entry, header) {
        const shown = entry.steps.slice(-PROGRESS_STEPS);
        const earlier = entry.steps.length - shown.length;
        const lines = [header];
        if (earlier > 0) lines.push(`_+${earlier} earlier_`);
        for (const step of shown) lines.push(`• ${md(step)}`);
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
            const markdown = progressText(entry, '_Working…_');
            const progress = entry.progress || (entry.progress = { messageId: '', pending: null });
            progress.pending = quietly(enqueue(entry.chatId, async (current) => {
                if (progress.messageId) {
                    await current.edit(entry.chatId, progress.messageId, { markdown, buttons: null });
                } else {
                    const sent = await current.send(entry.chatId, { markdown, silent: true });
                    progress.messageId = sent?.id || '';
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
            quietly(enqueue(entry.chatId, async (current) => {
                await progress.pending;
                if (progress.messageId) await current.edit(entry.chatId, progress.messageId, { markdown: `_${line}_`, buttons: null });
            }));
        }

        if (outcome.kind === 'stopped') {
            say(entry.chatId, 'Stopped.');
            return;
        }
        if (outcome.kind === 'failed') {
            say(entry.chatId, `**The run stopped on an error.**\n${md(format.clip(scrub(outcome.message || ''), 1500))}`);
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
            quietly(enqueue(entry.chatId, async (current) => {
                await progress.pending;
                if (progress.messageId) await current.edit(entry.chatId, progress.messageId, { markdown: `_${note}_`, buttons: null });
            }));
        }
    }

    /* -------------------------------------------------------------- *
     * Cards
     * -------------------------------------------------------------- */

    /** Where a conversation's cards go: the chat following it, or a job that asked. */
    function cardChat(info) {
        const entry = live.get(info.conversationId);
        if (entry) return entry.chatId;
        if (info.jobId && info.runKind !== 'interactive') {
            const job = jobs.get(info.jobId);
            if (job?.delivery?.channel && config().owner) return config().owner.chatId;
        }
        return null;
    }

    function newCard(fields) {
        cardCounter += 1;
        const key = `c${cardCounter}`;
        const card = { key, settled: false, parked: false, messageId: '', text: '', pending: null, ...fields };
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

    function sendCard(card, markdown, buttons) {
        card.text = markdown;
        card.pending = quietly(enqueue(card.chatId, async (current) => {
            const sent = await current.send(card.chatId, { markdown, buttons: buttons || null });
            card.messageId = sent?.id || '';
        }));
    }

    /** Settle a card in the chat: what happened, and no buttons. */
    function markCard(card, note) {
        card.settled = true;
        const markdown = `${card.text}\n\n_${md(note)}_`;
        quietly(enqueue(card.chatId, async (current) => {
            await card.pending;
            if (card.messageId) await current.edit(card.chatId, card.messageId, { markdown, buttons: null });
        }));
    }

    function approvalCard(info, event, chatId) {
        const entry = live.get(info.conversationId);
        if (entry) endTyping(entry);
        const from = event.via ? ` _(from ${md(format.clip(event.viaTitle || 'another conversation', 60))})_` : '';
        const job = !entry && info.jobId ? ` _(job: ${md(format.clip(info.title || 'a background run', 60))})_` : '';
        const where = event.host ? ` on **${md(event.host)}**` : '';
        const markdown = [
            `**Approval needed**${from}${job}`,
            `${md(event.title || event.name || 'A tool call')}${where}`,
            approvalBody(event),
        ].filter(Boolean).join('\n');
        const card = newCard({ kind: 'approval', requestId: event.requestId, conversationId: info.conversationId, chatId: String(chatId) });
        sendCard(card, markdown, [[
            { text: 'Approve', data: `a:${card.key}:y`, style: 'success', emoji: '✅' },
            { text: 'Deny', data: `a:${card.key}:n`, style: 'danger', emoji: '❌' },
        ]]);
    }

    function questionCard(info, event, chatId) {
        const entry = live.get(info.conversationId);
        if (entry) endTyping(entry);
        const from = event.via ? ` _(from ${md(format.clip(event.viaTitle || 'another conversation', 60))})_` : '';
        const options = Array.isArray(event.options) ? event.options.map(String).slice(0, 6) : [];
        const card = newCard({
            kind: 'question',
            requestId: event.requestId,
            conversationId: info.conversationId,
            chatId: String(chatId),
            options,
            secret: Boolean(event.secret),
        });
        if (event.secret) {
            sendCard(card, `**The agent needs a secret**${from}\n${md(event.question || '')}\n\n`
                + `_Answer this one on the desktop. Secrets never go through ${label}._`);
            return;
        }
        const buttons = options.map((option, index) => [{ text: format.clip(option, 60), data: `q:${card.key}:${index}` }]);
        sendCard(card, `**Question**${from}\n${md(event.question || '')}${options.length ? '' : '\n\n_Reply with your answer._'}`,
            buttons.length ? buttons : null);
    }

    function settleApproval(event) {
        const card = cards.get(cardOf.get(event.requestId));
        if (!card || card.settled) return;
        const here = event.by === adapter.name;
        const elsewhere = event.by ? `on ${event.by[0].toUpperCase()}${event.by.slice(1)}` : 'on the desktop';
        const stopped = stopping.has(card.conversationId);
        let note;
        switch (event.status) {
            case 'approved': note = here ? 'Approved.' : `Approved ${elsewhere}.`; break;
            case 'denied': note = stopped ? 'Not run: the agent was stopped.' : here ? 'Denied.' : `Denied ${elsewhere}.`; break;
            case 'expired': note = 'No longer waiting: not run.'; break;
            default: note = 'Settled.';
        }
        markCard(card, note);
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
        const here = event.by === adapter.name;
        const elsewhere = event.by ? `on ${event.by[0].toUpperCase()}${event.by.slice(1)}` : 'on the desktop';
        const note = event.status === 'answered'
            ? `${here ? 'Answered' : `Answered ${elsewhere}`}${card.secret ? '.' : `: ${format.clip(event.answer || '', 200)}`}`
            : stopping.has(card.conversationId) ? 'Dropped: the agent was stopped.' : 'Dismissed.';
        markCard(card, note);
        const entry = live.get(card.conversationId);
        if (entry && event.status === 'answered') startTyping(entry);
    }

    /* -------------------------------------------------------------- *
     * The assistant's events
     * -------------------------------------------------------------- */

    function observe(event, info) {
        if (!event || !info?.conversationId) return;
        if (!config().secret || isLocked()) return;

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
                // This channel's own message, which started the turn.
                if (event.channel === adapter.name) return;
                // The note-taking turn after a real one: not news, and not
                // anyone taking over.
                if (info.remembering) {
                    entry.quiet = true;
                    return;
                }
                leaveTurn(info.conversationId, event.channel
                    ? `Carried on in ${event.channel[0].toUpperCase()}${event.channel.slice(1)}.`
                    : 'Carried on at the desktop.');
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

    async function connect(raw) {
        const prepared = adapter.prepare(raw || {});
        if (prepared.error) return { error: prepared.error };
        if (isLocked()) return { error: 'Unlock the app first.' };
        let identity;
        try {
            identity = await adapter.verify(prepared.credentials);
        } catch (error) {
            return { error: error?.message || `${label} could not be reached.` };
        }
        if (!identity?.id) return { error: `${label} did not say who the bot is.` };

        const before = config();
        const sameBot = before.identity?.id === String(identity.id);
        try {
            section.setCredentials(prepared.credentials);
        } catch (error) {
            return { error: `The credentials could not be stored: ${error?.message || 'unknown error'}` };
        }
        section.update({
            enabled: true,
            identity: { ...identity, id: String(identity.id) },
            owner: sameBot ? before.owner : null,
            cursor: sameBot ? before.cursor : '',
            chats: sameBot ? before.chats : {},
        });
        dropClient();
        audit({ action: `channels.${adapter.name}-connected`, detail: `${label} bot ${identity.username ? `@${identity.username}` : identity.name || identity.id} connected` });
        startLoop();
        return status();
    }

    function disconnect() {
        stopLoop({ quiet: true });
        const before = config();
        for (const conversationId of [...live.keys()]) leaveTurn(conversationId, '');
        pairing = null;
        section.setCredentials(null);
        section.update({ enabled: false, identity: null, owner: null, cursor: '', chats: {} });
        if (before.identity) {
            audit({ action: `channels.${adapter.name}-disconnected`, detail: `${label} bot ${before.identity.username ? `@${before.identity.username}` : before.identity.name || before.identity.id} disconnected` });
        }
        setState('off');
        return status();
    }

    function pair() {
        const current = config();
        if (!current.secret || !current.identity) return { error: 'Connect a bot first.' };
        if (!current.enabled) {
            section.update({ enabled: true });
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
        const owner = config().owner;
        if (owner) {
            await say(owner.chatId, 'This chat is no longer connected to Acestes.');
            audit({
                action: `channels.${adapter.name}-unpaired`,
                detail: `${label} account ${owner.username ? `@${owner.username}` : owner.name} can no longer talk to the agent`,
            });
        }
        for (const conversationId of [...live.keys()]) leaveTurn(conversationId, '');
        section.update({ owner: null, chats: {} });
        const result = status();
        onChange(result);
        return result;
    }

    function update(patch = {}) {
        const next = {};
        if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
        if (patch.approvals !== undefined) next.approvals = patch.approvals;
        if (patch.agentId !== undefined) next.agentId = String(patch.agentId || '');
        const before = config();
        const after = section.update(next);
        if (before.approvals !== after.approvals) {
            audit({
                action: `channels.${adapter.name}-approvals`,
                detail: after.approvals === 'agent'
                    ? `Turns from ${label} now follow the agent's own approval mode`
                    : `Turns from ${label} now ask before every change`,
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
        const owner = config().owner;
        if (!owner) return { error: `Pair your ${label} account first.` };
        if (!ready()) return { error: `${label} is not running right now.` };
        try {
            await enqueue(owner.chatId, current => current.send(owner.chatId, {
                markdown: `Acestes on ${md(hostName)} can reach you here. Send a message to talk to ${md(agentFor(owner.chatId)?.name || 'your agent')}.`,
            }));
            return { sent: true };
        } catch (error) {
            return { error: error?.message || 'The message did not go.' };
        }
    }

    /** For `message_user`: the agent telling the user something first. */
    async function messageOwner({ text, from = '' } = {}) {
        const owner = config().owner;
        if (!config().secret || !owner) {
            return { error: `No ${label} account is paired.` };
        }
        if (!ready()) return { error: `${label} is switched off or not reachable right now.` };
        const body = String(text || '').trim();
        if (!body) return { error: 'There is nothing to send.' };
        const heading = from ? `**${md(from)}**\n\n` : '';
        try {
            const messages = format.toMessages(scrub(`${heading}${body}`), { target: adapter.target });
            await enqueue(owner.chatId, async (current) => {
                for (const formatted of messages.slice(0, MAX_REPLY_MESSAGES)) await current.send(owner.chatId, { formatted });
            });
            return { sent: true, channel: adapter.name };
        } catch (error) {
            return { error: error?.message || 'The message did not go.' };
        }
    }

    /** A job's result, for a job whose delivery asks for the channels. */
    function deliverJob(job, run) {
        const owner = config().owner;
        if (!job?.delivery?.channel || !owner || !ready()) return;
        const statusWord = run.status === 'done' ? 'finished' : run.status;
        const summary = run.result?.summary || run.result?.reason || '';
        sendReply(owner.chatId, `**${md(job.name)}** ${statusWord}\n\n${summary || '(no summary)'}`);
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
        if (config().enabled && config().secret) startLoop();
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
        const current = config();
        return Boolean(current.enabled && current.secret && current.owner);
    }

    return {
        name: adapter.name,
        label,
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
        lastMessageAt: () => lastMessageAt,
        // For the tests.
        _observe: observe,
        _live: live,
        _cards: cards,
    };
}

module.exports = { createGateway, randomCode, stepLine, approvalBody, helpText, STALE_AFTER, PAIRING_TTL };
