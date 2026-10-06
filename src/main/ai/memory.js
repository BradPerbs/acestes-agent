const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const embeddings = require('./embeddings');

/**
 * What an agent remembers between conversations.
 *
 * A conversation ends and the agent forgets everything in it: the next one
 * starts from the system prompt and whatever the user says. This is the part
 * that carries over. It is a notebook per agent, short notes the agent (or the
 * user, from the Memory page) writes down, and it reaches the agent two ways:
 * the newest notes go into the system prompt, and the ones that bear on each
 * message are found by meaning and sent with it. That second path is what
 * lets the notebook grow past what a prompt could carry.
 *
 * The notes are a JSON file per agent under userData, sentences a person can
 * read and edit, which is what makes the page worth having and what keeps a
 * wrong memory something the user can see and delete rather than a vector
 * nobody can inspect. Beside it sits the index: one embedding per note, made
 * on this machine (see embeddings.js), kept as a flat binary file with an id
 * list next to it. Search embeds the query and takes the nearest notes, with
 * a plain word match folded in so an exact term still wins, and falls back
 * to words alone while the model is not there.
 *
 * Nothing secret belongs in here, and the tools say so. It is written in the
 * clear, like the conversation history is, for the same reason: it is what the
 * app shows the person in front of it.
 */

const VERSION = 1;
const MAX_ENTRIES = 20000;
const MAX_TEXT = 1000;
const MAX_TAGS = 8;
const MAX_TAG = 40;

/**
 * How much of the notebook goes into the system prompt: the newest few. The
 * rest is reached by meaning, per message, and by the recall tool.
 */
const PROMPT_ENTRIES = 30;
const PROMPT_CHARS = 4000;

/** How many notes are embedded in one call, and how long a write is coalesced. */
const EMBED_BATCH = 32;
const SAVE_DELAY = 400;

/**
 * Where a cosine score stops meaning anything. MiniLM puts a note about the
 * same thing around 0.35 and up; unrelated notes sit near zero. Below the
 * floor a vector hit is noise, and a word match has to carry it instead.
 */
const VECTOR_FLOOR = 0.25;

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

let counter = 0;
function nextId() {
    counter += 1;
    return `m-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const text = clean(raw.text);
    if (!text) return null;
    const at = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
    return {
        id: String(raw.id || '').trim() || nextId(),
        text,
        tags: normalizeTags(raw.tags),
        // Who wrote it: the agent from a conversation, or the user on the page.
        source: raw.source === 'user' ? 'user' : 'agent',
        createdAt: at,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : at,
    };
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

function load(agentId) {
    const key = safe(agentId);
    if (stores.has(key)) return stores.get(key);

    let entries = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(entriesFile(agentId), 'utf8'));
        entries = (Array.isArray(parsed?.entries) ? parsed.entries : [])
            .map(normalizeEntry)
            .filter(Boolean)
            .slice(0, MAX_ENTRIES);
    } catch {
        // Nothing remembered yet.
    }

    const store = {
        agentId: String(agentId || ''),
        entries,
        vectors: readVectors(agentId),
        pending: new Set(),
        embedding: false,
        saveTimer: null,
    };
    stores.set(key, store);

    // Anything the index does not cover is queued now: notes written before
    // there was an index, or under another model.
    for (const entry of entries) {
        if (!store.vectors.has(entry.id)) store.pending.add(entry.id);
    }
    scheduleEmbed(store);

    return store;
}

function persist(store) {
    try {
        fs.mkdirSync(dir(), { recursive: true });
        fs.writeFileSync(entriesFile(store.agentId), JSON.stringify({ version: VERSION, entries: store.entries }, null, 2));
    } catch (error) {
        console.error('Could not save the agent memory:', error.message);
    }
    notify('memory-changed', { agentId: store.agentId });
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

            const vectors = await embeddings.embed(batch.map(entry => entry.text));
            batch.forEach((entry, index) => {
                // A note edited while its vector was being made is embedded
                // again for the new text, so a stale vector is never kept.
                if (store.pending.has(entry.id) && vectors[index]) {
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

/* ------------------------------------------------------------------ *
 * The notebook
 * ------------------------------------------------------------------ */

const copy = (entry) => ({ ...entry, tags: [...entry.tags] });

/**
 * The oldest go first once the notebook is full: what was true years ago is
 * the least likely thing in it still to be true.
 */
function trim(store) {
    if (store.entries.length <= MAX_ENTRIES) return;
    const dropped = store.entries
        .sort((a, b) => a.updatedAt - b.updatedAt)
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

/**
 * Write a note. The same sentence twice is one note touched twice, so an
 * agent that says "the user prefers vim" in every conversation does not fill
 * the notebook with it.
 */
function add(agentId, { text, tags, source } = {}) {
    const store = load(agentId);
    const entry = normalizeEntry({ text, tags, source });
    if (!entry) return null;

    const same = store.entries.find(held => held.text.toLowerCase() === entry.text.toLowerCase());
    if (same) {
        same.updatedAt = Date.now();
        same.tags = normalizeTags([...same.tags, ...entry.tags]);
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

function update(agentId, id, { text, tags } = {}) {
    const store = load(agentId);
    const entry = store.entries.find(held => held.id === id);
    if (!entry) return null;

    if (text !== undefined) {
        const next = clean(text);
        if (!next) return null;
        if (next !== entry.text) {
            entry.text = next;
            // The vector described the old sentence.
            store.vectors.delete(entry.id);
            store.pending.add(entry.id);
        }
    }
    if (tags !== undefined) entry.tags = normalizeTags(tags);
    entry.updatedAt = Date.now();
    persist(store);
    scheduleEmbed(store);
    return copy(entry);
}

function remove(agentId, id) {
    const store = load(agentId);
    const index = store.entries.findIndex(held => held.id === id);
    if (index === -1) return false;
    store.entries.splice(index, 1);
    store.pending.delete(id);
    if (store.vectors.delete(id)) persistVectors(store);
    persist(store);
    return true;
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

const tokens = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}_.-]{2,}/gu) || [];

/** The share of the query's words a note carries, in its text or its tags. */
function wordScore(entry, wanted) {
    const haystack = [...tokens(entry.text), ...entry.tags];
    let hits = 0;
    for (const word of wanted) {
        if (haystack.includes(word)) hits += 1;
        else if (haystack.some(held => held.includes(word) || word.includes(held))) hits += 0.5;
    }
    return hits / wanted.length;
}

function cosine(a, b) {
    let sum = 0;
    for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
    return sum;
}

/**
 * The notes closest to a few words, by meaning and by word.
 *
 * Every note gets the better of two scores: how near its vector is to the
 * query's, when both exist and the distance means something, and how many
 * of the query's words it carries. The vector finds "the web server config"
 * when the note says nginx; the words find an id or a hostname the encoder
 * has never seen. Ties go to the note touched most recently.
 *
 * A pass over every vector is deliberate. At 384 floats a note, ten thousand
 * notes are a few million multiplications, which is under a millisecond of
 * the time a message spends waiting on a model; an approximate index would
 * be a dependency spent on a problem this app does not have.
 */
async function search(agentId, query, limit = 10, { floor = 0, budget = Infinity } = {}) {
    const store = load(agentId);
    const wanted = [...new Set(tokens(query))];
    if (wanted.length === 0) return list(agentId).slice(0, limit);

    let probe = null;
    try {
        probe = await probeFor(String(query), budget);
    } catch {
        // By words alone until the model is back.
    }
    // A search is a good moment to catch up on anything unindexed.
    scheduleEmbed(store);

    return store.entries
        .map((entry) => {
            const vector = probe && store.vectors.has(entry.id) ? cosine(probe, store.vectors.get(entry.id)) : 0;
            const words = wordScore(entry, wanted);
            const score = Math.max(vector >= VECTOR_FLOOR ? vector : 0, words * 0.6);
            return { entry, score };
        })
        .filter(({ score }) => score > floor)
        .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
        .slice(0, limit)
        .map(({ entry, score }) => ({ ...copy(entry), score: Number(score.toFixed(3)) }));
}

/**
 * The query's vector, or null when there is none in time.
 *
 * With no budget this waits for the model, loading it if it must: what a
 * search the agent asked for wants. With one, a model that is not loaded yet
 * is started in the background and the search goes by words, and a loaded
 * one gets that long to answer before the search goes by words anyway. The
 * embed is not cancelled; it finishes on its own and is simply not waited for.
 */
async function probeFor(query, budget = Infinity) {
    if (!Number.isFinite(budget)) {
        const [vector] = await embeddings.embed([query]);
        return vector;
    }
    if (!embeddings.isReady?.()) {
        embeddings.warm?.();
        return null;
    }
    let timer = null;
    const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(0, budget));
        timer.unref?.();
    });
    const embedded = embeddings.embed([query]).then(([vector]) => vector);
    embedded.catch(() => {});
    try {
        return await Promise.race([embedded, late]);
    } finally {
        clearTimeout(timer);
    }
}

/** The ids the system prompt already carries, so a turn does not repeat them. */
function pinnedIds(agentId) {
    return new Set(list(agentId).slice(0, PROMPT_ENTRIES).map(entry => entry.id));
}

/**
 * How long a message waits for its notes to be found by meaning. The search
 * is on the way to the model, so it is the user's wait: a loaded model takes
 * a few milliseconds for a short message and a tenth of a second for a long
 * one, and past this the notes are found by words instead.
 */
const RELEVANT_BUDGET = 150;

/**
 * The notes that bear on one message, for the turn that carries it. Held to
 * a higher bar than a search the agent asked for, since nobody asked, and
 * without the newest notes, which the prompt has already. Never held up by
 * the model: see `probeFor`.
 */
async function relevant(agentId, text, limit = 6, { budget = RELEVANT_BUDGET } = {}) {
    const pinned = pinnedIds(agentId);
    const found = await search(agentId, text, limit + pinned.size, { floor: 0.3, budget });
    return found.filter(entry => !pinned.has(entry.id)).slice(0, limit);
}

/**
 * The notebook as the system prompt carries it: the most recently touched
 * notes, each on a line with its id so the agent can name one to forget.
 * Empty when there is nothing, so the prompt can leave the section out.
 */
function summary(agentId) {
    const lines = [];
    let chars = 0;
    for (const entry of list(agentId).slice(0, PROMPT_ENTRIES)) {
        const tags = entry.tags.length ? `  #${entry.tags.join(' #')}` : '';
        const line = `- (${entry.id}) ${entry.text}${tags}`;
        if (chars + line.length > PROMPT_CHARS) break;
        chars += line.length;
        lines.push(line);
    }
    return lines.join('\n');
}

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

/** How the index stands, for the page: how many notes, how many are indexed. */
function status(agentId) {
    const store = load(agentId);
    return {
        count: store.entries.length,
        indexed: store.entries.filter(entry => store.vectors.has(entry.id)).length,
        ...embeddings.status(),
    };
}

/**
 * Every notebook as a backup carries it: entries only, keyed by agent. The
 * vector index beside each file is a derived cache (rebuilt from the model
 * on this machine), so it does not travel.
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
 * the notes, their dates and who wrote them. Not the index, which the
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
    setNotifier, list, add, update, remove, search, relevant, summary, moveAll, status,
    exportAll, importAll, exportAgent, importAgent,
};
