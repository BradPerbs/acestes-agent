const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const embeddings = require('./embeddings');

/**
 * What an agent remembers between conversations.
 *
 * A conversation ends and the agent forgets everything in it: the next one
 * starts from the system prompt and whatever the user says. This is the part
 * that carries over: a notebook per agent, short notes the agent (or the
 * user, from the Memory page) writes down.
 *
 * It reaches the agent in three ways, the way the memory of every agent that
 * gets this right does (Letta's core blocks, Hermes' frozen MEMORY.md, Claude
 * Code's index):
 *
 *  1. The core, in the system prompt of every conversation, small and
 *     bounded: the rules (standing instructions such as "never add a Claude
 *     co-author line"), and a one-line index of what else is in the notebook,
 *     so the agent knows what it could recall. Rules go in whatever was
 *     written since, because what a task message says ("commit this") rarely
 *     resembles the rule that bears on it ("no attribution trailers"), so a
 *     search would never find them.
 *  2. The archive, everything else, found by meaning for each message and
 *     sent with it: a few notes at most, only those close to the best match,
 *     and never one this conversation has already been shown. The recall tool
 *     searches all of it on demand.
 *  3. Tidying, off to the side (see memory-tidy.js): now and then the
 *     notebook is read whole by the agent's own runtime, which merges what
 *     says the same thing twice, rewrites what has moved on, files each note
 *     under its kind and puts away what no longer holds. Every change is kept
 *     in a log the Memory page shows, and the last tidy can be undone.
 *
 * A note is one of three kinds: a rule (applies to every task), a fact (holds
 * until it changes: where a config lives, how a box is set up) or an event
 * (what happened and when: a fix, a release). Events fade a little with age
 * in the search; rules and facts do not.
 *
 * The notes are a JSON file per agent under userData, sentences a person can
 * read and edit, which is what keeps a wrong memory something the user can
 * see and delete rather than a vector nobody can inspect. Beside it sits the
 * index: one embedding per note, made on this machine (see embeddings.js),
 * kept as a flat binary file with an id list next to it. Deleted notes wait
 * in a bin for a month, so a tidy or a forget can be taken back.
 *
 * Nothing secret belongs in here, and the tools say so. It is written in the
 * clear, like the conversation history is, for the same reason: it is what the
 * app shows the person in front of it.
 */

const VERSION = 2;
const MAX_ENTRIES = 20000;
const MAX_TEXT = 1000;
const MAX_TAGS = 8;
const MAX_TAG = 40;
const KINDS = ['rule', 'fact', 'event'];
/** Earlier texts kept on a note that was rewritten, newest last. */
const MAX_HISTORY = 3;

/**
 * The core's budget, in characters. Rules first, newest written by the user
 * first; a rule that does not fit is still found by meaning, and the Memory
 * page says it did not fit. The index after them is one line.
 */
const RULE_CHARS = 2400;
const INDEX_CHARS = 600;

/** How many notes are embedded in one call, and how long a write is coalesced. */
const EMBED_BATCH = 32;
const SAVE_DELAY = 400;

/**
 * Where a cosine score stops meaning anything. MiniLM puts a note about the
 * same thing around 0.35 and up; unrelated notes sit near zero. Below the
 * floor a vector hit is noise, and a word match has to carry it instead.
 */
const VECTOR_FLOOR = 0.25;

/**
 * The notes sent with a message: above an absolute floor, within a spread of
 * the best match (a note far behind the best is rarely about the same thing),
 * and a handful at most. Measured on a real notebook of 59 notes against 14
 * messages: this found 23 of 31 notes that bore on them, against 14 for the
 * newest-notes-plus-top-6 it replaced, for the same characters per message.
 */
const RELEVANT_FLOOR = 0.3;
const RELEVANT_SPREAD = 0.1;
const RELEVANT_LIMIT = 4;

/**
 * A follow-up ("ok, commit it") says too little to search on, so a short
 * message is searched together with the one before it, which counts for a
 * little less. A long one carries its own subject.
 */
const SHORT_MESSAGE_WORDS = 8;
const PREVIOUS_WEIGHT = 0.85;

/** An event loses up to this share of its score, half of it a month after it happened. */
const EVENT_FADE = 0.15;
const EVENT_HALF_LIFE = 30 * 24 * 60 * 60 * 1000;

/**
 * A note already shown in a conversation is not sent again: the model has it
 * in the transcript. After this many messages it may be, since a runtime that
 * compacts a long conversation may have summarised it away.
 */
const RESHOW_AFTER = 30;

/** The bin: how long a deleted note can be brought back, and how many are kept. */
const TRASH_DAYS = 30;
const TRASH_MAX = 500;

/** Tidy logs kept per notebook, newest last. Only the last can be undone. */
const TIDY_LOGS = 10;

const DAY = 24 * 60 * 60 * 1000;

const stores = new Map();
let notify = () => {};

function setNotifier(fn) {
    notify = fn;
}

const safe = (id) => String(id || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
const dir = () => path.join(app.getPath('userData'), 'memory');
const entriesFile = (agentId) => path.join(dir(), `${safe(agentId)}.json`);
const indexFile = (agentId) => path.join(dir(), `${safe(agentId)}.vectors.json`);
const vectorsFile = (agentId) => path.join(dir(), `${safe(agentId)}.vectors.bin`);

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

function normalizeTags(tags) {
    const seen = new Set();
    const out = [];
    for (const tag of Array.isArray(tags) ? tags : []) {
        const value = String(tag ?? '').trim().toLowerCase().replace(/^#/, '').slice(0, MAX_TAG);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/**
 * The kind of a note that was not given one: a note from before kinds
 * existed, or one the agent wrote without saying. Careful with rules, since
 * every rule costs prompt in every conversation: only what reads as a
 * standing instruction, or was tagged as one. Tidying files the rest
 * properly.
 */
const RULE_TAGS = new Set(['rule', 'rules', 'preference', 'preferences', 'hard-rule', 'convention', 'conventions', 'style']);
const RULE_WORDS = /^(?:never|always|don't|do not|hard rule|from now on)\b/i;
const EVENT_WORDS = /\b(?:fixed|released|published|pushed|committed|uncommitted|merged|deployed|verified live|self-test|was (?:down|broken)|failed on)\b|\b20\d\d-\d\d-\d\d\b/i;

function inferKind(text, tags = []) {
    if (RULE_WORDS.test(text) || tags.some(tag => RULE_TAGS.has(tag))) return 'rule';
    if (EVENT_WORDS.test(text)) return 'event';
    return 'fact';
}

const normalizeKind = (kind) => (KINDS.includes(kind) ? kind : '');

let counter = 0;
function nextId() {
    counter += 1;
    return `m-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function normalizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(item => item && typeof item.text === 'string' && item.text.trim())
        .map(item => ({ text: clean(item.text), at: Number.isFinite(item.at) ? item.at : 0 }))
        .slice(-MAX_HISTORY);
}

function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = clean(raw.text);
    if (!text) return null;
    const at = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
    const tags = normalizeTags(raw.tags);
    const entry = {
        id: String(raw.id || '').trim() || nextId(),
        text,
        tags,
        kind: normalizeKind(raw.kind) || inferKind(text, tags),
        // Who wrote it: the agent from a conversation, or the user on the page.
        source: raw.source === 'user' ? 'user' : 'agent',
        createdAt: at,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : at,
    };
    const history = normalizeHistory(raw.history);
    if (history.length) entry.history = history;
    return entry;
}

/** A note as it went in the bin: the note, when, and why. */
function normalizeTrashed(raw) {
    const entry = normalizeEntry(raw);
    if (!entry) return null;
    entry.deletedAt = Number.isFinite(raw.deletedAt) ? raw.deletedAt : Date.now();
    entry.reason = String(raw.reason || '').slice(0, 300);
    return entry;
}

/* ------------------------------------------------------------------ *
 * Disk
 * ------------------------------------------------------------------ */

/**
 * The index as written: an id list and a binary file of rows in the same
 * order. Read back only if it was built with the model in use; otherwise the
 * notes are embedded again in the background, which is the whole migration.
 */
function readVectors(agentId) {
    const vectors = new Map();
    try {
        const index = JSON.parse(fs.readFileSync(indexFile(agentId), 'utf8'));
        if (index?.model !== embeddings.MODEL || index?.dims !== embeddings.DIMS) return vectors;
        const bytes = fs.readFileSync(vectorsFile(agentId));
        const rows = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
        const ids = Array.isArray(index.ids) ? index.ids : [];
        for (let row = 0; row < ids.length; row += 1) {
            const from = row * embeddings.DIMS;
            if (from + embeddings.DIMS > rows.length) break;
            vectors.set(String(ids[row]), rows.slice(from, from + embeddings.DIMS));
        }
    } catch {
        // No index yet, or one this build cannot read: rebuilt below.
    }
    return vectors;
}

function readTidy(raw) {
    const logs = Array.isArray(raw?.logs) ? raw.logs.filter(log => log && Number.isFinite(log.at)).slice(-TIDY_LOGS) : [];
    return {
        logs,
        failedAt: Number.isFinite(raw?.failedAt) ? raw.failedAt : 0,
        failure: String(raw?.failure || ''),
    };
}

function load(agentId) {
    const key = safe(agentId);
    if (stores.has(key)) return stores.get(key);

    let entries = [];
    let trash = [];
    let tidy = readTidy(null);
    let migrated = false;
    try {
        const parsed = JSON.parse(fs.readFileSync(entriesFile(agentId), 'utf8'));
        const raw = Array.isArray(parsed?.entries) ? parsed.entries : [];
        entries = raw.map(normalizeEntry).filter(Boolean).slice(0, MAX_ENTRIES);
        trash = (Array.isArray(parsed?.trash) ? parsed.trash : []).map(normalizeTrashed).filter(Boolean);
        tidy = readTidy(parsed?.tidy);
        // A notebook from before kinds: each note was given one above, and
        // the file is written back once so it says so.
        migrated = (parsed?.version || 1) < VERSION && entries.length > 0;
    } catch {
        // Nothing remembered yet.
    }

    const store = {
        agentId: String(agentId || ''),
        entries,
        trash,
        tidy,
        vectors: readVectors(agentId),
        pending: new Set(),
        embedding: false,
        saveTimer: null,
        // Bumped on every change, so what is worked out from the notes (the
        // word statistics) knows when to be worked out again.
        rev: 0,
        words: null,
    };
    stores.set(key, store);
    if (migrated) persist(store, { quiet: true });

    // Anything the index does not cover is queued now: notes written before
    // there was an index, or under another model.
    for (const entry of entries) {
        if (!store.vectors.has(entry.id)) store.pending.add(entry.id);
    }
    scheduleEmbed(store);

    return store;
}

/** The bin, emptied of what has waited its month, and held to its size. */
function pruneTrash(store) {
    const cutoff = Date.now() - TRASH_DAYS * DAY;
    store.trash = store.trash.filter(entry => entry.deletedAt >= cutoff).slice(-TRASH_MAX);
}

function persist(store, { quiet = false } = {}) {
    store.rev += 1;
    pruneTrash(store);
    try {
        fs.mkdirSync(dir(), { recursive: true });
        fs.writeFileSync(entriesFile(store.agentId), JSON.stringify({
            version: VERSION,
            entries: store.entries,
            trash: store.trash,
            tidy: store.tidy,
        }, null, 2));
    } catch (error) {
        console.error('Could not save the agent memory:', error.message);
    }
    if (!quiet) notify('memory-changed', { agentId: store.agentId });
}

/** The index, written whole a moment after the last change to it. */
function persistVectors(store) {
    clearTimeout(store.saveTimer);
    store.saveTimer = setTimeout(() => {
        store.saveTimer = null;
        const ids = [];
        const rows = new Float32Array(store.vectors.size * embeddings.DIMS);
        let row = 0;
        for (const [id, vector] of store.vectors) {
            ids.push(id);
            rows.set(vector, row * embeddings.DIMS);
            row += 1;
        }
        try {
            fs.mkdirSync(dir(), { recursive: true });
            fs.writeFileSync(vectorsFile(store.agentId), Buffer.from(rows.buffer));
            fs.writeFileSync(indexFile(store.agentId), JSON.stringify({
                version: VERSION,
                model: embeddings.MODEL,
                dims: embeddings.DIMS,
                ids,
            }));
        } catch (error) {
            console.error('Could not save the memory index:', error.message);
        }
    }, SAVE_DELAY);
    store.saveTimer.unref?.();
}

/* ------------------------------------------------------------------ *
 * Embedding, in the background
 * ------------------------------------------------------------------ */

function scheduleEmbed(store) {
    if (store.embedding || store.pending.size === 0) return;
    store.embedding = true;
    setImmediate(() => flushEmbeds(store));
}

/**
 * Embed what is waiting, a batch at a time, until nothing is. A failure
 * leaves the batch pending and stops: the model will be tried again on the
 * next write or search, and meanwhile search is by words.
 */
async function flushEmbeds(store) {
    try {
        while (store.pending.size > 0) {
            const batch = [...store.pending].slice(0, EMBED_BATCH)
                .map(id => store.entries.find(entry => entry.id === id))
                .filter(Boolean);
            for (const id of [...store.pending].slice(0, EMBED_BATCH)) {
                if (!batch.some(entry => entry.id === id)) store.pending.delete(id);
            }
            if (batch.length === 0) continue;

            const texts = batch.map(entry => entry.text);
            const vectors = await embeddings.embed(texts);
            batch.forEach((entry, index) => {
                // A note edited while its vector was being made is embedded
                // again for the new text, so a stale vector is never kept.
                if (store.pending.has(entry.id) && vectors[index] && entry.text === texts[index]) {
                    store.vectors.set(entry.id, vectors[index]);
                    store.pending.delete(entry.id);
                }
            });
            persistVectors(store);
        }
    } catch {
        // Kept pending; see above.
    } finally {
        store.embedding = false;
    }
}

/**
 * One note's vector, now rather than in the queue, for a caller that wants
 * to compare it (`similar`). Null if the model is not there in time.
 */
async function vectorFor(store, entry, budget) {
    if (store.vectors.has(entry.id) && !store.pending.has(entry.id)) return store.vectors.get(entry.id);
    const text = entry.text;
    const [vector] = (await race(embeddings.embed([text]), budget)) || [];
    if (!vector) return null;
    if (entry.text === text && store.entries.includes(entry)) {
        store.vectors.set(entry.id, vector);
        store.pending.delete(entry.id);
        persistVectors(store);
    }
    return vector;
}

/** A promise's value, or null if it is not in within `budget` milliseconds. */
async function race(promise, budget) {
    promise.catch(() => {});
    if (!Number.isFinite(budget)) return promise.catch(() => null);
    let timer = null;
    const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, budget));
        timer.unref?.();
    });
    try {
        return await Promise.race([promise.catch(() => null), late]);
    } finally {
        clearTimeout(timer);
    }
}

/* ------------------------------------------------------------------ *
 * The notebook
 * ------------------------------------------------------------------ */

const copy = (entry) => {
    const out = { ...entry, tags: [...entry.tags] };
    if (entry.history) out.history = entry.history.map(item => ({ ...item }));
    return out;
};

/**
 * The oldest go first once the notebook is full: what was true years ago is
 * the least likely thing in it still to be true. Rules last of all.
 */
function trim(store) {
    if (store.entries.length <= MAX_ENTRIES) return;
    const dropped = store.entries
        .sort((a, b) => (a.kind === 'rule') - (b.kind === 'rule') || a.updatedAt - b.updatedAt)
        .splice(0, store.entries.length - MAX_ENTRIES);
    for (const old of dropped) {
        store.vectors.delete(old.id);
        store.pending.delete(old.id);
    }
}

/** Every note, most recently touched first. */
function list(agentId) {
    return [...load(agentId).entries]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(copy);
}

function get(agentId, id) {
    const entry = load(agentId).entries.find(held => held.id === id);
    return entry ? copy(entry) : null;
}

/** A note's earlier wording, kept when it is rewritten. */
function remember(entry, text, at = Date.now()) {
    entry.history = [...(entry.history || []), { text, at }].slice(-MAX_HISTORY);
}

/**
 * Write a note. The same sentence twice is one note touched twice, so an
 * agent that says "the user prefers vim" in every conversation does not fill
 * the notebook with it.
 */
function add(agentId, { text, tags, source, kind } = {}) {
    const store = load(agentId);
    const entry = normalizeEntry({ text, tags, source, kind });
    if (!entry) return null;

    const same = store.entries.find(held => held.text.toLowerCase() === entry.text.toLowerCase());
    if (same) {
        same.updatedAt = Date.now();
        same.tags = normalizeTags([...same.tags, ...entry.tags]);
        if (normalizeKind(kind)) same.kind = kind;
        persist(store);
        return copy(same);
    }

    store.entries.push(entry);
    trim(store);
    persist(store);

    store.pending.add(entry.id);
    scheduleEmbed(store);
    return copy(entry);
}

function update(agentId, id, { text, tags, kind } = {}) {
    const store = load(agentId);
    const entry = store.entries.find(held => held.id === id);
    if (!entry) return null;

    if (text !== undefined) {
        const next = clean(text);
        if (!next) return null;
        if (next !== entry.text) {
            remember(entry, entry.text);
            entry.text = next;
            // The vector described the old sentence.
            store.vectors.delete(entry.id);
            store.pending.add(entry.id);
        }
    }
    if (tags !== undefined) entry.tags = normalizeTags(tags);
    if (normalizeKind(kind)) entry.kind = kind;
    entry.updatedAt = Date.now();
    persist(store);
    scheduleEmbed(store);
    return copy(entry);
}

/** Into the bin, from where `restore` brings it back for a month. */
function discard(store, entry, reason) {
    const index = store.entries.indexOf(entry);
    if (index === -1) return;
    store.entries.splice(index, 1);
    store.pending.delete(entry.id);
    if (store.vectors.delete(entry.id)) persistVectors(store);
    store.trash = store.trash.filter(held => held.id !== entry.id);
    store.trash.push({ ...copy(entry), deletedAt: Date.now(), reason: String(reason || '').slice(0, 300) });
}

function remove(agentId, id, { reason = '' } = {}) {
    const store = load(agentId);
    const entry = store.entries.find(held => held.id === id);
    if (!entry) return false;
    discard(store, entry, reason);
    persist(store);
    return true;
}

/** A note out of the bin, as it was. */
function restore(agentId, id) {
    const store = load(agentId);
    const index = store.trash.findIndex(held => held.id === id);
    if (index === -1) return null;
    const [held] = store.trash.splice(index, 1);
    const { deletedAt, reason, ...rest } = held;
    const entry = normalizeEntry(rest);
    if (!entry || store.entries.some(note => note.id === entry.id)) {
        persist(store);
        return null;
    }
    store.entries.push(entry);
    store.pending.add(entry.id);
    persist(store);
    scheduleEmbed(store);
    return copy(entry);
}

function trashed(agentId) {
    const store = load(agentId);
    pruneTrash(store);
    return [...store.trash].sort((a, b) => b.deletedAt - a.deletedAt).map(entry => ({ ...entry, tags: [...entry.tags] }));
}

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

/**
 * Words that say nothing about what a note is about. A message is mostly
 * these ("can you have a look at the"), and a note that shares them shares
 * nothing.
 */
const STOP = new Set((
    'a an and any are as at be been but by can could did do does doing done for from get got had has have how i '
    + 'if in into is it its just let lets like me my no not now of off on once only or our out over please so some '
    + 'something than that the their them then there these they this those to too up us very was we were what when '
    + 'where which while who why will with would you your yours ok okay yes yeah hey hi hello thanks thank again also '
    + 'here look looks make sure want wanna need think know see try going go goes still'
).split(' '));

/** The words of a text, lower case, with the full stop or dash at either end off ("again." is "again"). */
const tokens = (text) => (String(text || '').toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) || [])
    .map(word => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(word => word.length >= 2);

/**
 * A word with its common English endings off, the same way on both sides, so
 * "commits" and "committed" find "commit" and "releases" finds "release".
 * Rough on purpose: it only has to agree with itself.
 */
function stem(word) {
    let out = word;
    if (out.length <= 3 || /\d/.test(out)) return out;
    if (/ies$/.test(out) && out.length > 5) out = `${out.slice(0, -3)}y`;
    else if (/(?:ss|x|z|ch|sh)es$/.test(out)) out = out.slice(0, -2);
    else if (/[^su]s$/.test(out)) out = out.slice(0, -1);
    if (/ing$/.test(out) && out.length >= 7) out = out.slice(0, -3);
    else if (/ed$/.test(out) && out.length >= 6) out = out.slice(0, -2);
    if (/([b-df-hj-np-tv-z])\1$/.test(out) && !/(?:ll|ss|zz)$/.test(out)) out = out.slice(0, -1);
    if (/e$/.test(out) && out.length >= 5) out = out.slice(0, -1);
    return out;
}

/** A word that names one thing (a host, a file, a version): web-01, main.js, 1.3.8. */
const looksLikeName = (word) => word.length >= 3 && /[\d._-]/.test(word) && /[\p{L}\p{N}]/u.test(word);

const contentWords = (text) => tokens(text).filter(word => !STOP.has(word));

/**
 * What the words in the notebook are worth: how many notes each appears in,
 * worked out again only when the notebook has changed. A word in every note
 * says little; one in two notes says a lot.
 */
function wordStats(store) {
    if (store.words?.rev === store.rev && store.words.count === store.entries.length) return store.words;
    const byNote = new Map();
    const df = new Map();
    for (const entry of store.entries) {
        const seen = new Set([...contentWords(entry.text), ...entry.tags].map(stem));
        const raw = new Set([...tokens(entry.text), ...entry.tags]);
        byNote.set(entry.id, { stems: seen, raw });
        for (const word of seen) df.set(word, (df.get(word) || 0) + 1);
    }
    store.words = { rev: store.rev, count: store.entries.length, byNote, df };
    return store.words;
}

/**
 * How much of what the query is about a note carries: the query's content
 * words, each weighted by how rare it is in the notebook, and the share of
 * that weight the note has. 1 when it has every word that matters.
 */
function wordScorer(store, query) {
    const stats = wordStats(store);
    const total = Math.max(1, store.entries.length);
    const wanted = [...new Set(contentWords(query).map(stem))]
        .map(word => ({ word, weight: Math.log(1 + (total + 1) / ((stats.df.get(word) || 0) + 0.5)) }));
    const names = [...new Set(tokens(query).filter(looksLikeName))];
    const sum = wanted.reduce((acc, item) => acc + item.weight, 0);
    return (entry) => {
        const held = stats.byNote.get(entry.id);
        if (!held || sum === 0) return { words: 0, name: false };
        let got = 0;
        for (const item of wanted) if (held.stems.has(item.word)) got += item.weight;
        return { words: got / sum, name: names.some(name => held.raw.has(name)) };
    };
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function cosine(a, b) {
    let sum = 0;
    for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
    return sum;
}

/**
 * The query's vectors, or null when there are none in time.
 *
 * With no budget this waits for the model, loading it if it must: what a
 * search the agent asked for wants. With one, a model that is not loaded yet
 * is started in the background and the search goes by words (a load takes
 * longer than any budget a send can spare), and a loaded one gets that long
 * to answer before the search goes by words anyway. The embed is not
 * cancelled; it finishes in its own process and is simply not waited for.
 */
async function probesFor(texts, budget = Infinity) {
    if (Number.isFinite(budget) && !embeddings.isReady?.()) {
        embeddings.warm?.();
        return null;
    }
    return race(embeddings.embed(texts), budget);
}

/** An event's score, faded a little with its age; rules and facts keep theirs. */
function faded(entry, score, now = Date.now()) {
    if (entry.kind !== 'event') return score;
    const age = Math.max(0, now - entry.createdAt);
    return score * (1 - EVENT_FADE + EVENT_FADE * 0.5 ** (age / EVENT_HALF_LIFE));
}

/**
 * Every note scored against a query: the better of how near its vector is
 * (when there is one and the distance means something) and how much of the
 * query's weighted words it carries, raised for a note that names the same
 * host, file or version the query does, which an encoder has never seen.
 */
function scoreAll(store, query, probes, { previous = '' } = {}) {
    const words = wordScorer(store, query);
    const before = previous ? wordScorer(store, previous) : null;
    const [probe, prior] = probes || [];
    return store.entries.map((entry) => {
        const vector = store.vectors.get(entry.id);
        let near = probe && vector ? cosine(probe, vector) : 0;
        if (prior && vector) near = Math.max(near, PREVIOUS_WEIGHT * cosine(prior, vector));
        const said = words(entry);
        let wordScore = said.words;
        if (before) wordScore = Math.max(wordScore, PREVIOUS_WEIGHT * before(entry).words);
        let score = Math.max(near >= VECTOR_FLOOR ? near : 0, wordScore * 0.6);
        if (said.name) score = Math.max(score, 0.45) + 0.05;
        return { entry, score };
    });
}

/**
 * The notes closest to a few words, by meaning and by word: the recall tool
 * and the Memory page's search.
 *
 * A pass over every vector is deliberate. At 384 floats a note, ten thousand
 * notes are a few million multiplications, which is under a millisecond of
 * the time a message spends waiting on a model; an approximate index would
 * be a dependency spent on a problem this app does not have.
 */
async function search(agentId, query, limit = 10, { floor = 0, budget = Infinity, kind = '', tag = '' } = {}) {
    const store = load(agentId);
    const wantedKind = normalizeKind(kind);
    const wantedTag = String(tag || '').trim().toLowerCase().replace(/^#/, '');
    const filter = entry => (!wantedKind || entry.kind === wantedKind) && (!wantedTag || entry.tags.includes(wantedTag));
    if (contentWords(query).length === 0 && !tokens(query).some(looksLikeName)) {
        return list(agentId).filter(filter).slice(0, limit);
    }

    const probes = await probesFor([String(query)], budget);
    // A search is a good moment to catch up on anything unindexed.
    scheduleEmbed(store);

    return scoreAll(store, String(query), probes)
        .filter(({ entry, score }) => score > floor && filter(entry))
        .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
        .slice(0, limit)
        .map(({ entry, score }) => ({ ...copy(entry), score: Number(score.toFixed(3)) }));
}

/* ------------------------------------------------------------------ *
 * What each conversation has been shown
 * ------------------------------------------------------------------ */

/**
 * conversationId -> { session, turn, ids: Map(noteId -> turn shown) }.
 *
 * Held per provider session, because that is what the model can see back
 * into: a conversation moved to a new session (another runtime, another
 * account) starts with nothing shown. The first message of a session has no
 * id yet; it is taken on when one is announced.
 */
const shown = new Map();

function shownFor(conversationId, session = '') {
    if (!conversationId) return null;
    let memo = shown.get(conversationId);
    if (!memo || (memo.session && memo.session !== session)) {
        memo = { session, turn: 0, ids: new Map() };
        shown.set(conversationId, memo);
    } else if (!memo.session && session) {
        memo.session = session;
    }
    return memo;
}

/** Notes the conversation now has in front of it: a recall's results, a note just written. */
function markShown(conversationId, ids) {
    if (!conversationId) return;
    let memo = shown.get(conversationId);
    if (!memo) {
        memo = { session: '', turn: 0, ids: new Map() };
        shown.set(conversationId, memo);
    }
    for (const id of ids || []) memo.ids.set(String(id), memo.turn);
}

function forgetConversation(conversationId) {
    shown.delete(conversationId);
}

/**
 * How long a message waits for its notes to be found by meaning. The search
 * is on the way to the model, so it is the user's wait: a loaded model takes
 * a few milliseconds for a short message and a tenth of a second for a long
 * one, and past this the notes are found by words instead.
 */
const RELEVANT_BUDGET = 150;

/** What is searched of a message: its start says what it is about. */
const QUERY_CHARS = 1500;

/**
 * The notes that bear on one message, for the turn that carries it.
 *
 * Not the ones the system prompt carries (`exclude`, the core's ids as that
 * conversation's prompt was written) and not one the conversation was
 * already shown. Above the floor, within the spread of the best, a handful
 * at most: a message about nothing the notebook knows gets nothing. Never
 * held up by the model past the budget: see `probesFor`.
 */
async function relevant(agentId, text, {
    previous = '',
    conversationId = '',
    session = '',
    exclude = null,
    limit = RELEVANT_LIMIT,
    budget = RELEVANT_BUDGET,
} = {}) {
    const store = load(agentId);
    const query = String(text || '').slice(0, QUERY_CHARS);
    if (store.entries.length === 0 || !query.trim()) return [];

    const memo = shownFor(conversationId, session);
    if (memo) memo.turn += 1;
    const pinned = new Set(exclude || core(agentId).ids);
    const seen = (id) => memo && memo.ids.has(id) && memo.turn - memo.ids.get(id) < RESHOW_AFTER;

    const short = contentWords(query).length < SHORT_MESSAGE_WORDS;
    const before = short ? String(previous || '').slice(0, 600) : '';
    const probes = await probesFor(before ? [query, before] : [query], budget);
    scheduleEmbed(store);

    const now = Date.now();
    const ranked = scoreAll(store, query, probes, { previous: before })
        .map(({ entry, score }) => ({ entry, score: faded(entry, score, now) }))
        .filter(({ entry, score }) => score >= RELEVANT_FLOOR && !pinned.has(entry.id))
        .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt);
    if (ranked.length === 0) return [];

    // The spread is measured from the best match overall, shown or not: a
    // message about something already in front of the model should not pull
    // in its weaker neighbours instead.
    const best = ranked[0].score;
    const found = ranked
        .filter(({ entry, score }) => score >= best - RELEVANT_SPREAD && !seen(entry.id))
        .slice(0, limit);
    if (memo) for (const { entry } of found) memo.ids.set(entry.id, memo.turn);
    return found.map(({ entry, score }) => ({ ...copy(entry), score: Number(score.toFixed(3)) }));
}

/** Notes that say much the same as one note, for the agent that just wrote it. */
async function similar(agentId, id, { threshold = 0.8, limit = 3, budget = 2000 } = {}) {
    const store = load(agentId);
    const entry = store.entries.find(held => held.id === id);
    if (!entry) return [];
    const vector = await vectorFor(store, entry, budget);
    if (!vector) return [];
    return store.entries
        .filter(other => other.id !== id && store.vectors.has(other.id))
        .map(other => ({ entry: other, score: cosine(vector, store.vectors.get(other.id)) }))
        .filter(({ score }) => score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ entry: other, score }) => ({ id: other.id, kind: other.kind, text: other.text, score: Number(score.toFixed(3)) }));
}

/* ------------------------------------------------------------------ *
 * The core: what every conversation's prompt carries
 * ------------------------------------------------------------------ */

/** Tags that say what state a note is in rather than what it is about. */
const STATUS_TAGS = new Set([
    'preference', 'preferences', 'rule', 'rules', 'hard-rule', 'lesson', 'fix', 'fixed', 'verified', 'committed',
    'uncommitted', 'todo', 'note', 'notes', 'user',
]);

/**
 * The topics of the notes the prompt does not carry, as one line: a tag
 * counts once it is on two notes, and not when it is on most of them (the
 * name of the project every note is about says nothing).
 */
function topicIndex(entries) {
    const counts = new Map();
    for (const entry of entries) for (const tag of entry.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    const common = entries.length >= 10 ? entries.length * 0.5 : Infinity;
    const topics = [...counts]
        .filter(([tag, count]) => count >= 2 && count <= common && !STATUS_TAGS.has(tag))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const parts = [];
    let chars = 0;
    for (const [tag, count] of topics) {
        const part = `${tag} (${count})`;
        if (chars + part.length + 2 > INDEX_CHARS) break;
        chars += part.length + 2;
        parts.push(part);
    }
    return parts.join(', ');
}

const day = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

/**
 * The notebook as the system prompt carries it: the rules, each with its id
 * so the agent can name one to forget or rewrite, newest written by the user
 * first, as many as the budget holds; then one line on the rest. `ids` is
 * what it carries, so the search per message can leave those out.
 */
function core(agentId) {
    const store = load(agentId);
    const rules = store.entries
        .filter(entry => entry.kind === 'rule')
        .sort((a, b) => (a.source === 'user' ? 0 : 1) - (b.source === 'user' ? 0 : 1) || b.updatedAt - a.updatedAt);
    const lines = [];
    const ids = [];
    const over = [];
    let chars = 0;
    for (const rule of rules) {
        const line = `- (${rule.id}) ${rule.text}`;
        if (chars + line.length + 1 > RULE_CHARS) {
            over.push(rule.id);
            continue;
        }
        chars += line.length + 1;
        lines.push(line);
        ids.push(rule.id);
    }

    const carried = new Set(ids);
    const rest = store.entries.filter(entry => !carried.has(entry.id));
    const parts = [];
    if (lines.length) parts.push('Rules the user set, for every task:', ...lines);
    if (rest.length) {
        const topics = topicIndex(rest);
        if (parts.length) parts.push('');
        parts.push(
            `${rest.length} more ${rest.length === 1 ? 'note' : 'notes'}, sent with a message when they bear on it`
            + (topics ? `, on: ${topics}.` : '.')
            + ' Use recall for one that was not sent.',
        );
    }
    return {
        text: parts.join('\n'),
        ids,
        rules: rules.length,
        over,
        ruleChars: chars,
        ruleBudget: RULE_CHARS,
        count: store.entries.length,
    };
}

/** The core's text alone, as the prompt takes it. Empty when there is nothing. */
function summary(agentId) {
    return core(agentId).text;
}

/** How a note found for a message is written into it: an event with its date. */
function line(entry) {
    const when = entry.kind === 'event' ? `, ${day(entry.createdAt)}` : '';
    return `- (${entry.id}${when}) ${entry.text}`;
}

/* ------------------------------------------------------------------ *
 * Tidying: see memory-tidy.js for the question; here, what it may change
 * ------------------------------------------------------------------ */

/** How often a notebook is tidied on its own, and what makes it worth it. */
const TIDY_EVERY = 20 * 60 * 60 * 1000;
const TIDY_FIRST_AT = 8;
const TIDY_CHANGES = 5;
const TIDY_RETRY = 6 * 60 * 60 * 1000;
/** The most notes one tidy is shown; a bigger notebook is tidied where it changed. */
const TIDY_MAX_NOTES = 150;

function lastTidy(store) {
    return store.tidy.logs[store.tidy.logs.length - 1] || null;
}

/** Where a notebook stands for tidying, for the scheduler and the page. */
function tidyState(agentId) {
    const store = load(agentId);
    const last = lastTidy(store);
    const lastAt = last?.at || 0;
    const changed = store.entries.filter(entry => entry.updatedAt > lastAt).length;
    const now = Date.now();
    const rested = now - lastAt >= TIDY_EVERY && now - store.tidy.failedAt >= TIDY_RETRY;
    const overBudget = core(agentId).over.length > 0;
    const due = rested && store.entries.length >= 2 && (
        (!last && store.entries.length >= TIDY_FIRST_AT)
        || (last && changed >= TIDY_CHANGES)
        || overBudget
    );
    return {
        due,
        lastAt,
        changed,
        failedAt: store.tidy.failedAt,
        failure: store.tidy.failure,
        last: last ? {
            at: last.at,
            by: last.by || '',
            undone: Boolean(last.undone),
            counts: last.counts || {},
            changes: (last.changes || []).map(change => ({
                op: change.op,
                ids: change.ids,
                reason: change.reason || '',
                before: (change.before || []).map(entry => ({ id: entry.id, text: entry.text, kind: entry.kind, tags: entry.tags || [] })),
                after: change.after ? { id: change.after.id, text: change.after.text, kind: change.after.kind, tags: change.after.tags || [] } : null,
            })),
        } : null,
    };
}

/**
 * The notes one tidy is shown. All of them, up to a limit; past it, the ones
 * touched since the last tidy and the notes nearest each of those, which is
 * where duplicates and contradictions are.
 */
function tidyInput(agentId, { full = false } = {}) {
    const store = load(agentId);
    let picked = store.entries;
    if (picked.length > TIDY_MAX_NOTES) {
        const since = full ? 0 : (lastTidy(store)?.at || 0);
        const changed = store.entries
            .filter(entry => entry.updatedAt > since)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, Math.floor(TIDY_MAX_NOTES / 3));
        const chosen = new Set(changed.map(entry => entry.id));
        for (const entry of changed) {
            const vector = store.vectors.get(entry.id);
            if (!vector) continue;
            store.entries
                .filter(other => !chosen.has(other.id) && store.vectors.has(other.id))
                .map(other => ({ other, score: cosine(vector, store.vectors.get(other.id)) }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 3)
                .forEach(({ other }) => chosen.add(other.id));
            if (chosen.size >= TIDY_MAX_NOTES) break;
        }
        picked = store.entries.filter(entry => chosen.has(entry.id)).slice(0, TIDY_MAX_NOTES);
    }
    return {
        notes: picked.map(entry => ({
            id: entry.id,
            kind: entry.kind,
            source: entry.source,
            created: day(entry.createdAt),
            updated: day(entry.updatedAt),
            tags: [...entry.tags],
            text: entry.text,
        })),
        total: store.entries.length,
        ruleBudget: RULE_CHARS,
    };
}

/** Notes per question: small enough for a quick model to answer in a minute or two. */
const TIDY_BATCH = 30;

/**
 * The notes one tidy is shown, cut into questions of a size a runtime answers
 * quickly. The rules come first and together, since rules that say the same
 * thing are the duplicates that cost the most. The rest go in an order where
 * each note sits beside the one nearest it in meaning, so the notes a batch
 * holds are about the same things and a pair of duplicates is rarely cut in two.
 */
function tidyBatches(agentId, { full = false, size = TIDY_BATCH } = {}) {
    const store = load(agentId);
    const { notes } = tidyInput(agentId, { full });
    const batches = [];
    const rules = notes.filter(note => note.kind === 'rule');
    for (let index = 0; index < rules.length; index += size) batches.push(rules.slice(index, index + size));

    const rest = notes.filter(note => note.kind !== 'rule');
    const placed = rest.filter(note => store.vectors.has(note.id));
    const ordered = [];
    const left = new Set(placed.map(note => note.id));
    const byId = new Map(placed.map(note => [note.id, note]));
    let current = placed[0] || null;
    while (current) {
        ordered.push(current);
        left.delete(current.id);
        const here = store.vectors.get(current.id);
        let next = null;
        let best = -Infinity;
        for (const id of left) {
            const score = cosine(here, store.vectors.get(id));
            if (score > best) {
                best = score;
                next = byId.get(id);
            }
        }
        current = next;
    }
    ordered.push(...rest.filter(note => !store.vectors.has(note.id)));
    for (let index = 0; index < ordered.length; index += size) batches.push(ordered.slice(index, index + size));
    return batches;
}

/**
 * Apply what a tidy decided, as far as it is allowed to go.
 *
 * Every operation is checked against the notebook as it is now, not trusted:
 * an id that is not there is skipped, a note the user wrote keeps its words
 * (its kind and tags may change), a rule is never thrown away (it may be
 * merged or rewritten), and a plan that would empty the notebook is refused
 * whole. What is removed goes in the bin, and every change is logged with
 * the notes as they were, so the page can show it and `undoTidy` can take
 * it back.
 */
function applyTidy(agentId, ops, { by = '' } = {}) {
    const store = load(agentId);
    const byId = new Map(store.entries.map(entry => [entry.id, entry]));
    const touched = new Set();
    const accepted = [];

    const free = (id) => byId.has(id) && !touched.has(id);
    const fields = (op) => ({
        text: op.text === undefined ? undefined : clean(op.text),
        kind: normalizeKind(op.kind),
        tags: Array.isArray(op.tags) ? normalizeTags(op.tags) : undefined,
        reason: String(op.reason || '').slice(0, 300),
    });

    for (const op of Array.isArray(ops) ? ops : []) {
        if (!op || typeof op !== 'object') continue;
        if (op.op === 'edit') {
            const id = String(op.id || '');
            if (!free(id)) continue;
            const entry = byId.get(id);
            const { text, kind, tags, reason } = fields(op);
            const next = {
                text: entry.source === 'user' || !text ? entry.text : text,
                kind: kind || entry.kind,
                tags: tags || entry.tags,
            };
            if (next.text === entry.text && next.kind === entry.kind && next.tags.join() === entry.tags.join()) continue;
            touched.add(id);
            accepted.push({ op: 'edit', ids: [id], next, reason });
        } else if (op.op === 'merge') {
            const ids = [...new Set((Array.isArray(op.ids) ? op.ids : []).map(String))];
            const { text, kind, tags, reason } = fields(op);
            if (ids.length < 2 || !text || !ids.every(free)) continue;
            if (ids.some(id => byId.get(id).source === 'user')) continue;
            const merged = ids.map(id => byId.get(id));
            ids.forEach(id => touched.add(id));
            accepted.push({
                op: 'merge',
                ids,
                next: {
                    text,
                    kind: kind || (merged.some(entry => entry.kind === 'rule') ? 'rule' : merged[0].kind),
                    tags: tags || normalizeTags(merged.flatMap(entry => entry.tags)),
                },
                reason,
            });
        } else if (op.op === 'delete') {
            const id = String(op.id || '');
            if (!free(id)) continue;
            const entry = byId.get(id);
            if (entry.source === 'user') continue;
            const { reason } = fields(op);
            // A rule goes only as the duplicate of another rule that stays,
            // named in the reason ("same as m-abc"); checked once the plan is in.
            const keeper = entry.kind === 'rule' ? (reason.match(/m-[a-z0-9]+-[a-z0-9]+/g) || []).find(other => other !== id) : '';
            if (entry.kind === 'rule' && !keeper) continue;
            touched.add(id);
            accepted.push({ op: 'delete', ids: [id], reason, keeper });
        }
    }

    // A rule deleted as a duplicate of one that is itself going, or is no
    // longer a rule, would leave the rule unsaid: that deletion is dropped.
    const going = new Set(accepted.filter(change => change.op === 'delete').map(change => change.ids[0]));
    for (const change of accepted) if (change.op === 'merge') change.ids.slice(1).forEach(id => going.add(id));
    const kindAfter = (id) => {
        const change = accepted.find(item => item.op !== 'delete' && item.ids[0] === id);
        return change ? change.next.kind : byId.get(id)?.kind;
    };
    for (let index = accepted.length - 1; index >= 0; index -= 1) {
        const change = accepted[index];
        if (!change.keeper) continue;
        if (!byId.has(change.keeper) || going.has(change.keeper) || kindAfter(change.keeper) !== 'rule') {
            accepted.splice(index, 1);
            going.delete(change.ids[0]);
        }
    }

    const removing = accepted.reduce((sum, change) => sum + (change.op === 'delete' ? 1 : change.op === 'merge' ? change.ids.length - 1 : 0), 0);
    if (removing > Math.max(5, Math.floor(store.entries.length * 0.4))) {
        store.tidy.failedAt = Date.now();
        store.tidy.failure = `The tidy wanted to remove ${removing} of ${store.entries.length} notes, which is too many; nothing was changed.`;
        persist(store, { quiet: true });
        return { applied: false, message: store.tidy.failure };
    }

    const now = Date.now();
    const changes = [];
    const counts = { merged: 0, edited: 0, reclassified: 0, retagged: 0, removed: 0 };
    for (const change of accepted) {
        const before = change.ids.map(id => copy(byId.get(id)));
        if (change.op === 'delete') {
            discard(store, byId.get(change.ids[0]), change.reason || 'Put away when the notes were tidied');
            counts.removed += 1;
            changes.push({ op: 'delete', ids: change.ids, before, after: null, reason: change.reason });
            continue;
        }
        const [first, ...others] = change.ids.map(id => byId.get(id));
        if (change.next.text !== first.text) {
            remember(first, first.text, now);
            first.text = change.next.text;
            store.vectors.delete(first.id);
            store.pending.add(first.id);
        }
        if (change.op === 'edit' && change.next.text !== before[0].text) counts.edited += 1;
        else if (change.op === 'edit' && change.next.kind !== before[0].kind) counts.reclassified += 1;
        else if (change.op === 'edit') counts.retagged += 1;
        first.kind = change.next.kind;
        first.tags = change.next.tags;
        first.updatedAt = now;
        if (change.op === 'merge') {
            first.createdAt = Math.min(...change.ids.map(id => byId.get(id).createdAt));
            for (const other of others) discard(store, other, `Merged into ${first.id}`);
            counts.merged += others.length + 1;
        }
        changes.push({ op: change.op, ids: change.ids, before, after: copy(first), reason: change.reason });
    }

    store.tidy.logs = [...store.tidy.logs, { at: now, by, counts, changes, undone: false }].slice(-TIDY_LOGS);
    store.tidy.failedAt = 0;
    store.tidy.failure = '';
    persist(store);
    scheduleEmbed(store);
    return { applied: true, counts, changes: changes.length };
}

/** A tidy that could not be asked or answered, so it is not asked again at once. */
function tidyFailed(agentId, message) {
    const store = load(agentId);
    store.tidy.failedAt = Date.now();
    store.tidy.failure = String(message || 'The tidy failed').slice(0, 300);
    persist(store, { quiet: true });
}

/**
 * Take the last tidy back: each note it changed returns to what it was, and
 * what it removed comes out of the bin. A note changed again since, by the
 * agent or the user, is left as it is now (and so are the notes merged into
 * it): the later change is the one that counts.
 */
function undoTidy(agentId) {
    const store = load(agentId);
    const log = lastTidy(store);
    if (!log || log.undone) return { undone: false, restored: 0, kept: 0 };
    let restored = 0;
    let kept = 0;

    const putBack = (before) => {
        const entry = normalizeEntry(before);
        if (!entry) return;
        const index = store.entries.findIndex(held => held.id === entry.id);
        if (index >= 0) store.entries[index] = entry;
        else store.entries.push(entry);
        store.trash = store.trash.filter(held => held.id !== entry.id);
        store.vectors.delete(entry.id);
        store.pending.add(entry.id);
        restored += 1;
    };

    // Changed since if it no longer reads as the tidy left it: compared by
    // content, since an edit in the same millisecond has the same timestamp.
    const changedSince = (entry, after) => !entry || !after || entry.text !== after.text
        || entry.kind !== after.kind || entry.tags.join() !== (after.tags || []).join();

    for (const change of [...(log.changes || [])].reverse()) {
        const survivor = store.entries.find(held => held.id === change.ids[0]);
        if (change.op !== 'delete' && changedSince(survivor, change.after)) {
            kept += 1;
            continue;
        }
        if (change.op === 'delete') {
            if (store.entries.some(held => held.id === change.ids[0])) continue;
            putBack(change.before[0]);
            continue;
        }
        for (const before of change.before) {
            if (before.id !== change.ids[0] && store.entries.some(held => held.id === before.id)) continue;
            putBack(before);
        }
    }

    log.undone = true;
    persist(store);
    scheduleEmbed(store);
    return { undone: true, restored, kept };
}

/* ------------------------------------------------------------------ *
 * Moving, counting, backing up
 * ------------------------------------------------------------------ */

/** Hand a deleted agent's notebook to another, so nothing learned is lost. */
function moveAll(fromAgentId, toAgentId) {
    const from = load(fromAgentId);
    if (from.entries.length === 0) return 0;
    const to = load(toAgentId);
    let moved = 0;
    for (const entry of from.entries) {
        if (to.entries.some(held => held.text.toLowerCase() === entry.text.toLowerCase())) continue;
        to.entries.push(entry);
        const vector = from.vectors.get(entry.id);
        if (vector) to.vectors.set(entry.id, vector);
        else to.pending.add(entry.id);
        moved += 1;
    }
    from.entries = [];
    from.vectors.clear();
    from.pending.clear();
    persist(from);
    persistVectors(from);
    persist(to);
    persistVectors(to);
    scheduleEmbed(to);
    return moved;
}

/** How the notebook stands, for the page: counts by kind, the index, the core's budget. */
function status(agentId) {
    const store = load(agentId);
    const held = core(agentId);
    const kinds = { rule: 0, fact: 0, event: 0 };
    for (const entry of store.entries) kinds[entry.kind] += 1;
    return {
        count: store.entries.length,
        indexed: store.entries.filter(entry => store.vectors.has(entry.id)).length,
        kinds,
        rulesCarried: held.ids.length,
        rulesOver: held.over,
        ruleChars: held.ruleChars,
        ruleBudget: held.ruleBudget,
        trashed: store.trash.length,
        ...embeddings.status(),
    };
}

/**
 * Every notebook as a backup carries it: entries only, keyed by agent. The
 * vector index beside each file is a derived cache (rebuilt from the model
 * on this machine), so it does not travel, and neither does the bin.
 */
function exportAll() {
    const out = {};
    let files = [];
    try {
        files = fs.readdirSync(dir());
    } catch {
        return out;
    }
    for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.vectors.json')) continue;
        const key = file.slice(0, -'.json'.length);
        const store = load(key);
        out[key] = store.entries.map(copy);
    }
    return out;
}

/**
 * Bring memories from a backup, matched on entry id within each notebook.
 * Unknown entries are queued for embedding like written ones, so search by
 * meaning catches up in the background.
 */
function importAll(payload, { overwrite = false } = {}) {
    const result = { added: 0, replaced: 0, skipped: 0 };
    const incoming = payload && typeof payload === 'object' ? payload : {};
    for (const [key, rawEntries] of Object.entries(incoming)) {
        if (!Array.isArray(rawEntries)) continue;
        const store = load(key);
        let changed = false;
        for (const raw of rawEntries) {
            const entry = normalizeEntry(raw);
            if (!entry) {
                result.skipped++;
                continue;
            }
            const index = store.entries.findIndex(held => held.id === entry.id);
            if (index < 0) {
                store.entries.push(entry);
                store.pending.add(entry.id);
                result.added++;
                changed = true;
            } else if (overwrite) {
                store.entries[index] = entry;
                store.vectors.delete(entry.id);
                store.pending.add(entry.id);
                result.replaced++;
                changed = true;
            } else {
                result.skipped++;
            }
        }
        trim(store);
        if (changed) {
            persist(store);
            scheduleEmbed(store);
        }
    }
    return result;
}

/* ------------------------------------------------------------------ *
 * One notebook as a file
 * ------------------------------------------------------------------ */

const FORMAT = 'acestes-memory';

/**
 * One agent's notebook as a file a person can keep or hand to another agent:
 * the notes, their kinds, dates and who wrote them. Not the index, which the
 * machine that imports it builds for itself.
 */
function exportAgent(agentId, { name = '' } = {}) {
    return {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        agent: { id: String(agentId || ''), name: String(name || '') },
        entries: list(agentId),
    };
}

/**
 * The notes a file holds, in whichever shape it came: an export from the
 * Memory page, a notebook file from this folder (the same `entries`), or a
 * bare list of notes or of plain sentences. Null when it is none of these.
 */
function entriesIn(payload) {
    let raw = null;
    if (Array.isArray(payload)) raw = payload;
    else if (Array.isArray(payload?.entries)) raw = payload.entries;
    if (!raw) return null;
    return raw.map(item => (typeof item === 'string' ? { text: item } : item));
}

/**
 * Fold a file's notes into one agent's notebook. A note that is already
 * there under the same id keeps whichever copy was touched last; one that
 * says what another note already says is left out, as `add` would. The rest
 * arrive with their own dates and author, and are indexed in the background.
 */
function importAgent(agentId, payload) {
    const incoming = entriesIn(payload);
    if (!incoming) return null;

    const store = load(agentId);
    const result = { added: 0, updated: 0, skipped: 0 };
    for (const raw of incoming) {
        const entry = normalizeEntry(raw);
        if (!entry) {
            result.skipped += 1;
            continue;
        }

        const held = store.entries.find(note => note.id === entry.id);
        if (held) {
            if (entry.updatedAt <= held.updatedAt) {
                result.skipped += 1;
                continue;
            }
            if (entry.text !== held.text) {
                store.vectors.delete(held.id);
                store.pending.add(held.id);
            }
            Object.assign(held, entry);
            result.updated += 1;
            continue;
        }

        const said = entry.text.toLowerCase();
        if (store.entries.some(note => note.text.toLowerCase() === said)) {
            result.skipped += 1;
            continue;
        }
        store.entries.push(entry);
        store.pending.add(entry.id);
        result.added += 1;
    }

    if (result.added || result.updated) {
        trim(store);
        persist(store);
        scheduleEmbed(store);
    }
    return result;
}

module.exports = {
    KINDS,
    setNotifier,
    list,
    get,
    add,
    update,
    remove,
    restore,
    trashed,
    search,
    relevant,
    similar,
    markShown,
    forgetConversation,
    core,
    summary,
    line,
    tidyState,
    tidyInput,
    tidyBatches,
    applyTidy,
    tidyFailed,
    undoTidy,
    moveAll,
    status,
    exportAll,
    importAll,
    exportAgent,
    importAgent,
    _test: { inferKind, topicIndex, stem, contentWords, faded, reset: () => { stores.clear(); shown.clear(); } },
};
