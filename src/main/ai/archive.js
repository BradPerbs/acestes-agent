const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Conversations, kept across runs of the app, all of them.
 *
 * Nothing is dropped here. Not the oldest conversation when a new one starts,
 * not the start of a long one, not the pictures pasted into one. The only
 * thing that ever deletes a conversation is the user: by deleting it, or by
 * choosing how long the history is kept in the settings (see `sweepHistory`
 * in `index.js`). A history that quietly lost everything older than a day and
 * a half was the reason this was rewritten.
 *
 * Kept in its own folder next to the assistant's settings rather than in the
 * sessions store, for the same reason those are: none of this is a host, a key
 * or a snippet, and the store's shape is the thing that syncs between machines.
 * A chat about a server belongs to the machine it was had on.
 *
 * Nothing here is a secret, but it is not nothing either: it holds command
 * output from real servers. It is written to the userData directory with the
 * same reach as the activity log, and for the same reason: it is what the app
 * shows the person sitting in front of it, and encrypting it would mean the
 * history menu could not be read until the vault was open.
 *
 * Layout, under `assistant-history/`:
 *
 *   <id>.json      one conversation, whole: everything about it and every event
 *                  in it. Rewritten when that conversation changes, and only then.
 *   index.jsonl    what the lists need about every conversation (title, dates,
 *                  how many messages) without opening any of them. Appended to,
 *                  one line per change, the last line for an id winning; written
 *                  out fresh once it holds more old lines than live ones.
 *   images/        the pictures pasted into messages, one file each, named for
 *                  the conversation they belong to.
 *
 * One file for everything, rewritten every couple of seconds, was fine for
 * twenty conversations and is not for a year of them. So is holding every
 * event of every conversation in memory: a conversation read back from disk
 * is a stub, its metadata and nothing else, and its events are read the first
 * time anything asks for them (see `track`). The ones nobody has looked at for
 * a while are let go again (see `release`), so memory follows what is in use
 * rather than how long the app has been installed.
 */

const SCHEMA_VERSION = 2;

/**
 * The stream, as opposed to what it produced.
 *
 * Deltas are a preview of a block that arrives whole a moment later as
 * `assistant-text`, and thinking is not rendered at all. They are not history:
 * the finished block is, and that is kept.
 */
const TRANSIENT = new Set(['text-delta', 'thinking-delta', 'thinking-start']);

/** Writes are coalesced: one turn emits a couple of dozen events. */
const FLUSH_DELAY = 2000;

/**
 * How many conversations keep their events in memory once they have been
 * read. A cache, not a limit on anything: one let go is read back from its
 * file the next time it is asked for, exactly as it was.
 */
const MAX_RESIDENT = 40;

/** Old lines the index may carry, beyond twice the live ones, before it is rewritten. */
const COMPACT_SLACK = 200;

/** How much of a first and last message the index keeps, for search by meaning. */
const SKETCH_CHARS = 600;

const IMAGE_EXTENSIONS = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};

const legacyPath = () => path.join(app.getPath('userData'), 'assistant-history.json');
const directory = () => path.join(app.getPath('userData'), 'assistant-history');
const journalPath = () => path.join(directory(), 'index.jsonl');
const imagesDirectory = () => path.join(directory(), 'images');

/**
 * The file name a conversation id is kept under. The app's own ids are safe
 * as they are; anything else (an id from somebody's backup) is hashed, so no
 * id can reach outside the folder or land on a name Windows reserves.
 */
function fileStem(id) {
    const text = String(id);
    if (/^[A-Za-z0-9_-]{1,100}$/.test(text) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(text)) return text;
    return `x-${crypto.createHash('sha1').update(text).digest('hex')}`;
}

const recordPath = id => path.join(directory(), `${fileStem(id)}.json`);

let source = null;
let flushTimer = null;
// Off until `index.js` has read the folder into the map this writes from. A
// process that quits before then, a second copy of the app opened and closed
// again, has an empty map, and nothing it did should reach the disk.
let suspended = true;

/** Ids whose file needs writing, and ids whose file is to go. */
const dirty = new Set();
const removed = new Set();

/** Lines in the index file, so it can be rewritten when they outnumber the live ones. */
let journalLines = 0;
/** The index file was left without its last newline: the next line starts on one of its own. */
let journalNeedsNewline = false;

/**
 * Per conversation object: its events when they are in memory (null when they
 * are on disk only), what the index says about it, and what was last written.
 */
const bodies = new WeakMap();

/** The conversations whose events are in memory, for `release`. */
const resident = new Set();

/** Image object -> the file it was saved as, so a picture is hashed once. */
const savedImages = new WeakMap();

/**
 * Where the conversations to write are read from, set once by `index.js`:
 * `{ get(id), all(), canRelease(conversation) }`.
 */
function setSource(next) {
    source = next;
}

const isTransient = (type) => TRANSIENT.has(type);

/* ------------------------------------------------------------------ *
 * Shape on disk
 * ------------------------------------------------------------------ */

/**
 * Everything about a conversation except its events.
 *
 * `busy` is recorded rather than smoothed over here, because the repair belongs
 * on the way back in: a conversation saved mid-turn is honestly mid-turn, and
 * it is only when it comes back to a panel that the turn is definitively over.
 */
function packMeta(conversation) {
    return {
        id: conversation.id,
        scope: conversation.scope,
        sessionId: conversation.boundSessionId,
        // The set a pinned conversation is fenced to. Session ids do not
        // survive the app closing, and `unpack` drops them; host ids do, which
        // is what lets "these two boxes" still mean something tomorrow.
        sessionIds: conversation.sessionIds || [],
        hostIds: conversation.hostIds || [],
        // The agent's own id for this chat, and which agent it belongs to. Both
        // or neither: see `unpack`.
        providerSessionId: conversation.providerSessionId || '',
        provider: conversation.provider || '',
        // Which of that runtime's sign-ins the session id was issued under:
        // Claude Code keeps a session in the account's own folder.
        accountId: conversation.accountId || '',
        title: conversation.title || '',
        // Whether the title is still the draft waiting to be named. A
        // question still out when the app closed is asked again.
        titleSource: conversation.titleSource === 'draft' || conversation.titleSource === 'naming' ? 'draft' : '',
        // Kept at the top of the list by the user. Their choice, so it
        // outlives the app the way a title does.
        pinned: Boolean(conversation.pinned),
        // The runtime, model and effort picked for this conversation, over
        // the agent's defaults. Null while it follows them.
        settingsPatch: conversation.settingsPatch || null,
        // What goes with the next message: a branch's earlier conversation,
        // and a word about files the user undid. Both are spent on sending.
        carryOver: conversation.carryOver || '',
        pendingNote: conversation.pendingNote || '',
        // Whose it is. An id no agent answers to any more is repaired on the
        // way back in, by `index.js`.
        agentId: conversation.agentId || '',
        costUsd: conversation.costUsd || 0,
        busy: Boolean(conversation.busy),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
    };
}

/**
 * A message's pictures as the file holds them: the name and type, and the file
 * the bytes were saved to when they have been. The bytes themselves never go
 * in the conversation's file, which stays small enough to rewrite often.
 */
function packImages(images) {
    return images.map(image => (image?.file
        ? { name: image.name, mediaType: image.mediaType, file: image.file }
        : { name: image?.name, mediaType: image?.mediaType }));
}

/** Every event worth keeping, in order. All of them: none is dropped for age or size. */
function packEvents(events) {
    const out = [];
    for (const event of events || []) {
        if (!event || TRANSIENT.has(event.type)) continue;
        out.push(Array.isArray(event.images) ? { ...event, images: packImages(event.images) } : event);
    }
    return out;
}

/** One conversation, whole, as a backup or the file carries it. */
function pack(conversation) {
    return { ...packMeta(conversation), events: packEvents(conversation.events) };
}

/** Anything that is still recognisably one of our events. */
function readEventList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(event => event && typeof event === 'object' && typeof event.type === 'string');
}

/**
 * The model a conversation was left on, or null. Strings only: an unknown
 * runtime is dropped later, by whoever resolves the settings.
 */
function readSettingsPatch(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const patch = {};
    // `account` is which of the runtime's sign-ins the composer's menu put
    // it on, when the menu offers more than one.
    for (const field of ['provider', 'model', 'effort', 'account']) {
        if (typeof raw[field] === 'string' && raw[field]) patch[field] = raw[field];
    }
    return Object.keys(patch).length ? patch : null;
}

/**
 * The events of a stored conversation, repaired for having been closed.
 *
 * Two things are repaired on the way in, both of them consequences of the app
 * having been closed rather than of anything the user did:
 *
 *   A question that was never answered. The request is in the log, so a panel
 *   replaying it would draw a live approval card whose id died with the last
 *   process, and clicking it would do nothing at all. It is settled as expired,
 *   which is the same thing that happens to one nobody answers in time.
 *
 *   A turn that was still running. Without a `result` to close it the panel
 *   would come back showing "Working" forever, on a query that stopped existing
 *   when the app did. It is closed out with a line saying so.
 */
function repairEvents(raw, { busy = false, at = Date.now() } = {}) {
    const events = readEventList(raw);

    const answered = new Set(
        events.filter(event => event.type === 'approval-settled').map(event => event.requestId)
    );
    for (const event of events.slice()) {
        if (event.type !== 'approval-request') continue;
        if (answered.has(event.requestId)) continue;
        answered.add(event.requestId);
        events.push({ type: 'approval-settled', requestId: event.requestId, status: 'expired', at });
    }

    // And the agent's own questions, the same way: one nobody answered
    // before the app closed is not still being asked.
    const replied = new Set(
        events.filter(event => event.type === 'question-settled').map(event => event.requestId)
    );
    for (const event of events.slice()) {
        if (event.type !== 'question-request') continue;
        if (replied.has(event.requestId)) continue;
        replied.add(event.requestId);
        events.push({ type: 'question-settled', requestId: event.requestId, status: 'expired', answer: '', at });
    }

    if (busy) {
        events.push({
            type: 'notice',
            tone: 'info',
            text: 'This turn was cut short when the app closed.',
            at,
        });
    }
    return events;
}

/**
 * A stored conversation's metadata, back in the shape the rest of the module
 * works with, and no events. `null` for anything unreadable, so one bad record
 * cannot cost the rest.
 */
function unpackMeta(record, currentProvider) {
    if (!record || typeof record !== 'object') return null;
    if (typeof record.id !== 'string' || !record.id) return null;

    const at = Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now();

    // The agent's session id means nothing to a different agent: resuming a
    // Claude Code chat inside Codex either fails or, worse, continues something
    // else. Dropped when they disagree, which costs the model its memory of the
    // conversation and keeps the transcript, rather than the other way round.
    const provider = typeof record.provider === 'string' ? record.provider : '';
    const resumable = provider && provider === currentProvider;

    // The hosts of a pinned set outlive the app; its sessions do not. Every
    // session id in a stored record belongs to a terminal that closed when the
    // window did, so they are dropped and the hosts carry the fence. A set that
    // was nothing but sessions falls back to following the session in front,
    // which is what an empty set means everywhere else.
    const hostIds = Array.isArray(record.hostIds) ? record.hostIds.filter(Boolean) : [];
    const stillPinned = record.scope === 'targets' && hostIds.length > 0;

    let scope = 'session';
    if (record.scope === 'global') scope = 'global';
    else if (stillPinned) scope = 'targets';

    return {
        id: record.id,
        scope,
        boundSessionId: scope === 'session' && typeof record.sessionId === 'string'
            ? record.sessionId
            : '',
        sessionIds: [],
        hostIds: stillPinned ? hostIds : [],
        session: null,
        starting: null,
        busy: false,
        // Where the user is now is not where they were, so the situational
        // block goes again with the first message of this run.
        lastContext: '',
        providerSessionId: resumable ? String(record.providerSessionId || '') : '',
        provider,
        accountId: typeof record.accountId === 'string' ? record.accountId : '',
        needsRestart: false,
        costUsd: Number.isFinite(record.costUsd) ? record.costUsd : 0,
        title: typeof record.title === 'string' ? record.title : '',
        titleSource: record.titleSource === 'draft' ? 'draft' : '',
        pinned: record.pinned === true,
        settingsPatch: readSettingsPatch(record.settingsPatch),
        carryOver: typeof record.carryOver === 'string' ? record.carryOver : '',
        pendingNote: typeof record.pendingNote === 'string' ? record.pendingNote : '',
        agentId: typeof record.agentId === 'string' ? record.agentId : '',
        createdAt: Number.isFinite(record.createdAt) ? record.createdAt : at,
        updatedAt: at,
    };
}

/** A whole stored conversation, events and all, repaired: see `repairEvents`. */
function unpack(record, currentProvider) {
    const conversation = unpackMeta(record, currentProvider);
    if (!conversation) return null;
    conversation.events = repairEvents(record.events, { busy: Boolean(record.busy), at: conversation.updatedAt });
    return conversation;
}

/** What the index keeps about a conversation's events: enough for a list row and a search sketch. */
function summarize(events) {
    let messages = 0;
    let first = '';
    let last = '';
    let spoken = 0;
    for (const event of events || []) {
        if (event?.type !== 'user-message') continue;
        messages += 1;
        if (!event.text) continue;
        spoken += 1;
        if (!first) first = String(event.text);
        last = String(event.text);
    }
    return {
        messages,
        firstMessage: first.slice(0, SKETCH_CHARS),
        lastMessage: spoken > 1 ? last.slice(0, SKETCH_CHARS) : '',
    };
}

/* ------------------------------------------------------------------ *
 * Events on demand
 * ------------------------------------------------------------------ */

/**
 * Give a conversation an `events` that is read from its file the first time
 * it is asked for.
 *
 * Every caller in `index.js` goes on reading and assigning `conversation.events`
 * the way it always has; whether the array was in memory already is this
 * module's business. `events` is the array when it is in memory, `null` for a
 * stub whose events are still on disk.
 */
function track(conversation, events, summary = null) {
    const state = {
        events: Array.isArray(events) ? events : null,
        summary: summary || { messages: 0, firstMessage: '', lastMessage: '' },
        usedAt: Date.now(),
        // Whether the file holds what is in memory, which is what lets the
        // events go again: what is let go has to be readable back.
        onDisk: !Array.isArray(events),
        written: null,
    };
    bodies.set(conversation, state);
    Object.defineProperty(conversation, 'events', {
        configurable: true,
        enumerable: true,
        get() {
            state.usedAt = Date.now();
            if (state.events) return state.events;
            state.events = loadEvents(conversation.id);
            state.written = fingerprint(conversation, state.events);
            resident.add(conversation);
            release(conversation);
            return state.events;
        },
        set(value) {
            state.events = Array.isArray(value) ? value : [];
            state.usedAt = Date.now();
            resident.add(conversation);
        },
    });
    if (state.events) resident.add(conversation);
    return conversation;
}

/** A conversation from the index: its metadata now, its events when asked for. */
function stub(meta, currentProvider) {
    const conversation = unpackMeta(meta, currentProvider);
    if (!conversation) return null;
    return track(conversation, null, {
        messages: Number.isFinite(meta.messages) ? meta.messages : 0,
        firstMessage: typeof meta.firstMessage === 'string' ? meta.firstMessage : '',
        lastMessage: typeof meta.lastMessage === 'string' ? meta.lastMessage : '',
    });
}

/** Whether a conversation's events are in memory. Untracked objects always are. */
function isLoaded(conversation) {
    const state = bodies.get(conversation);
    return !state || Boolean(state.events);
}

/**
 * Whether there is anything in a conversation worth listing or writing. A stub
 * always has: it was only ever written because it did.
 */
function hasContent(conversation) {
    if (!isLoaded(conversation)) return true;
    return Boolean(conversation.title) || conversation.events.length > 0;
}

/** The index's view of a conversation's events, read from them when they are in memory. */
function summaryOf(conversation) {
    if (isLoaded(conversation)) return summarize(conversation.events);
    return bodies.get(conversation).summary;
}

/** How many messages the user sent in it, without reading it in. */
function messageCount(conversation) {
    return summaryOf(conversation).messages;
}

/**
 * A conversation's events for one look, without keeping them: a search over
 * a year of history reads each one and lets it go. In memory already, they
 * are simply handed back.
 *
 * `mustContain` is words, lowercase, that the search needs every one of: a
 * file that does not hold them all, as text, cannot match, and is answered
 * with null without being parsed.
 */
async function peekEvents(conversation, mustContain = []) {
    if (isLoaded(conversation)) return conversation.events;
    try {
        const text = await fs.promises.readFile(recordPath(conversation.id), 'utf8');
        if (mustContain.length > 0) {
            const lower = text.toLowerCase();
            if (!mustContain.every(word => lower.includes(word))) return null;
        }
        return readEventList(JSON.parse(text)?.conversation?.events);
    } catch {
        return [];
    }
}

/**
 * Change the events of a conversation where they are, in memory or in the
 * file, without reading a stub in to do it. For the secrets scrub, which has
 * to reach every conversation there is. `true` when something changed.
 */
function rewriteEvents(conversation, change) {
    if (isLoaded(conversation)) {
        const before = conversation.events;
        const after = change(before);
        const changed = after.length !== before.length || after.some((event, index) => event !== before[index]);
        if (changed) conversation.events = after;
        return changed;
    }
    const record = readRecord(conversation.id);
    if (!record) return false;
    const before = readEventList(record.events);
    const after = change(before);
    const changed = after.some((event, index) => event !== before[index]);
    if (!changed) return false;
    try {
        writeRecordFile(conversation.id, { ...packMeta(conversation), events: packEvents(after) });
    } catch (error) {
        console.error('Could not rewrite a stored conversation:', error.message);
        return false;
    }
    return true;
}

/** What was last written of a conversation, cheaply, to tell whether it changed. */
function fingerprint(conversation, events) {
    const last = events[events.length - 1];
    return `${events.length}|${last?.at || ''}|${last?.type || ''}|${JSON.stringify(packMeta(conversation))}`;
}

/**
 * Let go of the events of the conversations nobody has looked at for a while,
 * once more of them are in memory than the cache holds. Only what is safe to
 * read back: written, unchanged since, and not in use (`canRelease`), which
 * rules out anything with a query running. `except` is the one just read in.
 */
function release(except = null) {
    if (resident.size <= MAX_RESIDENT) return;
    const candidates = [];
    for (const conversation of resident) {
        const state = bodies.get(conversation);
        // Deleted, or replaced by a fresh read after a shutdown.
        if (!state || !state.events || source?.get(conversation.id) !== conversation) {
            resident.delete(conversation);
            continue;
        }
        if (conversation === except) continue;
        if (!state.onDisk || dirty.has(conversation.id)) continue;
        if (source?.canRelease && !source.canRelease(conversation)) continue;
        if (state.written !== fingerprint(conversation, state.events)) continue;
        candidates.push(conversation);
    }
    candidates.sort((a, b) => bodies.get(a).usedAt - bodies.get(b).usedAt);
    for (const conversation of candidates) {
        if (resident.size <= MAX_RESIDENT) break;
        const state = bodies.get(conversation);
        state.summary = summarize(state.events);
        state.events = null;
        resident.delete(conversation);
    }
}

/* ------------------------------------------------------------------ *
 * Disk
 * ------------------------------------------------------------------ */

/** The same temp-file + fsync + rename dance the sessions store uses. Text or bytes. */
function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

function writeRecordFile(id, record) {
    fs.mkdirSync(directory(), { recursive: true });
    writeAtomic(recordPath(id), JSON.stringify({ version: SCHEMA_VERSION, conversation: record }));
}

/**
 * Move a file that cannot be read out of the way, rather than overwrite it
 * with what is left. It may be recoverable by hand; it is not recoverable once
 * the next save has replaced it.
 */
function keepAside(file) {
    try {
        fs.renameSync(file, `${file}.unreadable-${Date.now()}`);
    } catch {
        // Already gone, or locked: nothing more to do from here.
    }
}

/** One conversation's file, whole, or null. */
function readRecordAt(file, { quiet = false } = {}) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT' && !quiet) console.error('Could not read a stored conversation:', error.message);
        return null;
    }
    try {
        const record = JSON.parse(text)?.conversation;
        if (!record || typeof record !== 'object' || typeof record.id !== 'string') throw new Error('no conversation in it');
        return record;
    } catch (error) {
        console.error(`Could not read ${path.basename(file)}, kept aside:`, error.message);
        keepAside(file);
        return null;
    }
}

const readRecord = (id, options) => readRecordAt(recordPath(id), options);

/** A picture's bytes back from its file, when it has one. */
function restoreImages(events) {
    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (!Array.isArray(event.images) || !event.images.some(image => image?.file && !image.data)) continue;
        events[index] = {
            ...event,
            images: event.images.map((image) => {
                if (!image?.file || image.data) return image;
                try {
                    const bytes = fs.readFileSync(path.join(imagesDirectory(), path.basename(String(image.file))));
                    return { ...image, data: bytes.toString('base64') };
                } catch {
                    // The file is gone: a chip where the picture was.
                    return image;
                }
            }),
        };
    }
    return events;
}

/** A stub's events, read from its file and repaired for the app having closed. */
function loadEvents(id) {
    const record = readRecord(id);
    if (!record) return [];
    const at = Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now();
    return restoreImages(repairEvents(record.events, { busy: Boolean(record.busy), at }));
}

/**
 * The file a picture is kept in, written the first time. Named for the
 * conversation, so deleting the conversation finds its pictures, and for the
 * bytes, so writing it again is a no-op.
 */
function saveImage(stem, image) {
    if (!image || typeof image.data !== 'string' || !image.data) {
        return image?.file ? { name: image.name, mediaType: image.mediaType, file: image.file } : { name: image?.name, mediaType: image?.mediaType };
    }
    if (typeof image.file === 'string' && image.file.startsWith(`${stem}.`)) {
        return { name: image.name, mediaType: image.mediaType, file: image.file };
    }
    const known = savedImages.get(image);
    if (known?.startsWith(`${stem}.`)) return { name: image.name, mediaType: image.mediaType, file: known };

    const digest = crypto.createHash('sha1').update(image.data).digest('hex').slice(0, 20);
    const name = `${stem}.${digest}.${IMAGE_EXTENSIONS[image.mediaType] || 'bin'}`;
    const file = path.join(imagesDirectory(), name);
    try {
        if (!fs.existsSync(file)) {
            fs.mkdirSync(imagesDirectory(), { recursive: true });
            writeAtomic(file, Buffer.from(image.data, 'base64'));
        }
        savedImages.set(image, name);
        return { name: image.name, mediaType: image.mediaType, file: name };
    } catch (error) {
        console.error('Could not save a picture from the conversation:', error.message);
        return { name: image.name, mediaType: image.mediaType };
    }
}

/**
 * Write one conversation's file. A stub whose events were never read in keeps
 * the events already in its file, under whatever about it has changed. False
 * when there was nothing that could be written.
 */
function writeRecord(conversation) {
    const state = bodies.get(conversation);
    let events;
    if (state && !state.events) {
        const stored = readRecord(conversation.id);
        // Never written, or unreadable and kept aside: an empty transcript
        // under its title would be a loss dressed up as a save.
        if (!stored) return false;
        events = packEvents(readEventList(stored.events));
    } else {
        // The pictures are saved from the live events, which still have
        // their bytes; the file gets the name of each.
        const stem = fileStem(conversation.id);
        events = [];
        for (const event of conversation.events) {
            if (!event || TRANSIENT.has(event.type)) continue;
            events.push(Array.isArray(event.images)
                ? { ...event, images: event.images.map(image => saveImage(stem, image)) }
                : event);
        }
    }
    writeRecordFile(conversation.id, { ...packMeta(conversation), events });
    if (state) {
        state.onDisk = true;
        if (state.events) state.written = fingerprint(conversation, state.events);
    }
    return true;
}

/** A conversation's file and its pictures, gone. */
function deleteFiles(id) {
    try {
        fs.rmSync(recordPath(id), { force: true });
    } catch (error) {
        console.error('Could not delete a stored conversation:', error.message);
    }
    const prefix = `${fileStem(id)}.`;
    try {
        for (const name of fs.readdirSync(imagesDirectory())) {
            if (name.startsWith(prefix)) fs.rmSync(path.join(imagesDirectory(), name), { force: true });
        }
    } catch {
        // No pictures folder: nothing to delete.
    }
}

/** What a line of the index says about a conversation. */
function metaOf(conversation) {
    return { ...packMeta(conversation), ...summaryOf(conversation) };
}

function appendJournal(entries) {
    if (entries.length === 0) return;
    fs.mkdirSync(directory(), { recursive: true });
    const text = `${journalNeedsNewline ? '\n' : ''}${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`;
    const fd = fs.openSync(journalPath(), 'a');
    try {
        fs.writeSync(fd, text);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    journalNeedsNewline = false;
    journalLines += entries.length;
}

/** The index rewritten to one line per live conversation. */
function compact(metas, legacy) {
    const entries = metas.map(meta => ({ id: meta.id, meta }));
    if (legacy) entries.push({ legacy });
    fs.mkdirSync(directory(), { recursive: true });
    writeAtomic(journalPath(), entries.length ? `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n` : '');
    journalLines = entries.length;
    journalNeedsNewline = false;
}

/**
 * The index as it stands: the last word on every id, and where the merge from
 * the old single file got to. Reads only; changes nothing.
 */
function readJournal() {
    const entries = new Map();
    let legacy = null;
    let lines = 0;
    let needsNewline = false;
    let text = '';
    try {
        text = fs.readFileSync(journalPath(), 'utf8');
    } catch {
        return { entries, legacy, lines, needsNewline, exists: false };
    }
    if (text && !text.endsWith('\n')) needsNewline = true;
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        lines += 1;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            // A line cut short by a crash. The file it described still has
            // everything, and is recovered from below.
            continue;
        }
        if (entry?.legacy && typeof entry.legacy === 'object') {
            legacy = entry.legacy;
            continue;
        }
        if (typeof entry?.id !== 'string' || !entry.id) continue;
        if (entry.removed) entries.delete(entry.id);
        else if (entry.meta && typeof entry.meta === 'object') entries.set(entry.id, { ...entry.meta, id: entry.id });
    }
    return { entries, legacy, lines, needsNewline, exists: true };
}

/** The single file every earlier version kept, if there is one. */
function readLegacy() {
    try {
        const stats = fs.statSync(legacyPath());
        const parsed = JSON.parse(fs.readFileSync(legacyPath(), 'utf8'));
        if (!Array.isArray(parsed?.conversations)) return null;
        return { mtimeMs: stats.mtimeMs, conversations: parsed.conversations };
    } catch (error) {
        if (error.code !== 'ENOENT') console.error('Could not read the old assistant history:', error.message);
        return null;
    }
}

let legacyMark = null;

/**
 * Every stored conversation's metadata, for `index.js` to make stubs of.
 *
 * Three repairs happen on the way, each of them about the disk rather than any
 * one conversation:
 *
 *   A file the index never heard of (the app stopped between writing the one
 *   and the other) is read and listed, rather than left invisible.
 *
 *   An index line whose file is gone is left out: there is nothing to show.
 *
 *   The single `assistant-history.json` earlier versions wrote is merged in,
 *   and left where it is. Merged again whenever it changes, which is what an
 *   older copy of the app still installed beside this one does when it runs:
 *   what it said since the last merge comes across, and what was deleted here
 *   before then does not come back.
 */
function load() {
    const journal = readJournal();
    const { entries } = journal;
    journalLines = journal.lines;
    journalNeedsNewline = journal.needsNewline;
    legacyMark = journal.legacy;

    const appended = [];

    let names = [];
    try {
        names = fs.readdirSync(directory());
    } catch {
        names = [];
    }
    const files = new Set(names.filter(name => name.endsWith('.json')));

    for (const id of [...entries.keys()]) {
        if (!files.has(`${fileStem(id)}.json`)) {
            console.error(`The stored conversation ${id} has no file any more; it is left out.`);
            entries.delete(id);
        }
    }

    const listed = new Set([...entries.keys()].map(id => `${fileStem(id)}.json`));
    for (const name of files) {
        if (listed.has(name)) continue;
        const record = readRecordAt(path.join(directory(), name));
        if (!record || `${fileStem(record.id)}.json` !== name) continue;
        const meta = { ...withoutEvents(record), ...summarize(readEventList(record.events)) };
        entries.set(record.id, meta);
        appended.push({ id: record.id, meta });
    }

    const legacy = readLegacy();
    if (legacy && legacyMark?.mtimeMs !== legacy.mtimeMs) {
        const since = Number(legacyMark?.mergedAt) || 0;
        for (const record of legacy.conversations) {
            if (!record || typeof record.id !== 'string' || !record.id) continue;
            const updatedAt = Number(record.updatedAt) || 0;
            const held = entries.get(record.id);
            // Ours is as new or newer: nothing to take.
            if (held && updatedAt <= (Number(held.updatedAt) || 0)) continue;
            // Not ours, and from before the last merge: deleted here since.
            if (!held && since > 0 && updatedAt <= since) continue;
            // Carried on in the old copy after it was last saved here. The
            // old copy only ever had its own trimmed version of it, so ours
            // is kept whole and what was said over there since goes on the end.
            let events;
            if (held) {
                const stored = readRecord(record.id);
                const after = Number(held.updatedAt) || 0;
                events = packEvents([
                    ...readEventList(stored?.events),
                    ...readEventList(record.events).filter(event => (Number(event.at) || 0) > after),
                ]);
            } else {
                events = packEvents(readEventList(record.events));
            }
            const meta = { ...withoutEvents(record), ...summarize(events) };
            try {
                writeRecordFile(record.id, { ...withoutEvents(record), events });
            } catch (error) {
                console.error('Could not bring an old conversation across:', error.message);
                continue;
            }
            entries.set(record.id, meta);
            appended.push({ id: record.id, meta });
        }
        legacyMark = { mtimeMs: legacy.mtimeMs, mergedAt: Date.now() };
        appended.push({ legacy: legacyMark });
    }

    try {
        appendJournal(appended);
        if (journalLines > 2 * entries.size + COMPACT_SLACK) compact([...entries.values()], legacyMark);
    } catch (error) {
        console.error('Could not update the assistant history index:', error.message);
    }

    return [...entries.values()];
}

function withoutEvents(record) {
    const { events, ...rest } = record;
    return rest;
}

/**
 * Every stored conversation, whole and oldest first, for a backup. Whatever
 * is waiting to be written goes first, so the backup holds what the app does.
 * Before this version has ever run, that is what the old single file holds.
 */
function read() {
    if (!suspended) flush();
    const journal = readJournal();
    if (!journal.exists) return readLegacy()?.conversations || [];
    const out = [];
    for (const id of journal.entries.keys()) {
        const record = readRecord(id, { quiet: true });
        if (record) out.push(record);
    }
    return out.sort((a, b) => (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0));
}

/**
 * Write what changed. The ids named by `save`, and any conversation in memory
 * that changed without being named: a field set somewhere that forgot to say
 * so still reaches the disk on the next write, as it did when the whole
 * history was one file written every time.
 */
function writeNow() {
    flushTimer = null;
    if (!source || suspended) return;

    const lines = [];

    for (const id of [...removed]) {
        removed.delete(id);
        if (!fs.existsSync(recordPath(id))) continue;
        deleteFiles(id);
        lines.push({ id, removed: true });
    }

    for (const conversation of resident) {
        const state = bodies.get(conversation);
        if (!state?.events || source.get(conversation.id) !== conversation) continue;
        if (state.written !== fingerprint(conversation, state.events)) dirty.add(conversation.id);
    }

    for (const id of [...dirty]) {
        dirty.delete(id);
        const conversation = source.get(id);
        if (!conversation || !hasContent(conversation)) continue;
        try {
            if (!writeRecord(conversation)) continue;
            lines.push({ id, meta: metaOf(conversation) });
        } catch (error) {
            console.error('Could not save a conversation:', error.message);
        }
    }

    try {
        appendJournal(lines);
        const live = [...source.all()].filter(hasContent);
        if (journalLines > 2 * live.length + COMPACT_SLACK) compact(live.map(metaOf), legacyMark);
    } catch (error) {
        console.error('Could not save the assistant history index:', error.message);
    }

    release();
}

function schedule() {
    if (suspended || flushTimer) return;
    flushTimer = setTimeout(writeNow, FLUSH_DELAY);
    // A pending write must never be the reason the process stays alive.
    flushTimer.unref?.();
}

/**
 * Something changed. Write it out shortly: the conversation named, and anything
 * else in memory that changed with it.
 */
function save(conversationId = '') {
    if (suspended) return;
    if (conversationId) dirty.add(String(conversationId));
    schedule();
}

/** A conversation deleted for good: its file and its pictures go on the next write. */
function remove(conversationId) {
    if (suspended || !conversationId) return;
    removed.add(String(conversationId));
    dirty.delete(String(conversationId));
    schedule();
}

function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!suspended) writeNow();
}

/**
 * Stop writing.
 *
 * Held over a shutdown, which empties the map this reads from: a debounced
 * write landing after that would delete what the shutdown only put down.
 */
function suspend() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    suspended = true;
    dirty.clear();
    removed.clear();
    resident.clear();
}

function resume() {
    suspended = false;
}

// The debounce would otherwise lose the last exchange of a run, which is the
// one anybody is most likely to come back for. Guarded rather than assumed: the
// test harness stubs `app` down to the few members it needs.
if (typeof app?.on === 'function') app.on('will-quit', flush);

module.exports = {
    setSource,
    isTransient,
    pack,
    unpack,
    stub,
    track,
    load,
    read,
    save,
    remove,
    flush,
    suspend,
    resume,
    isLoaded,
    hasContent,
    messageCount,
    summaryOf,
    peekEvents,
    rewriteEvents,
    // For the tests, which look at the folder directly.
    _paths: { directory, journalPath, imagesDirectory, legacyPath, recordPath },
    MAX_RESIDENT,
};
