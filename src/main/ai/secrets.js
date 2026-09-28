const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Service secrets: API keys, tokens and passwords the agent's work needs,
 * held by name and never by the agent.
 *
 * The rule the host store already follows for passwords is made general
 * here. A secret goes in through a card the user types into, or the
 * settings page, and is encrypted by the OS keychain before it touches the
 * disk. What the agent gets back is a reference, `{{secret:name}}`, which
 * it uses wherever a value is needed: the env of a local command, the env
 * or headers of an MCP server, the password of a proxy. The app resolves
 * the reference at the moment of use, in this process, and the value is
 * never in a tool call, a transcript, a run log or a model's context.
 *
 * The second half is scrubbing. Every value stored here is also masked out
 * of every event the app records or shows, so a secret that did reach the
 * agent by some other road (pasted into chat, read off a disk) is not
 * repeated by the transcript.
 */

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/;
const REFERENCE = /\{\{\s*secret:([A-Za-z0-9_][A-Za-z0-9_.-]{0,59})\s*\}\}/g;
const MASK = '••••';
/** Shorter than this and masking would eat ordinary words. */
const MIN_SCRUB_LENGTH = 8;

const file = () => path.join(app.getPath('userData'), 'secrets.json');

// name -> { value: base64 ciphertext, createdAt, updatedAt }
let records = null;
// name -> plaintext, for resolving and scrubbing without a decrypt per use
let plain = new Map();

function load() {
    if (records) return records;
    records = {};
    plain = new Map();
    try {
        const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object') {
            records = parsed.secrets;
        }
    } catch {
        // Missing or unreadable: none yet.
    }
    for (const [name, record] of Object.entries(records)) {
        try {
            plain.set(name, safeStorage.decryptString(Buffer.from(String(record.value || ''), 'base64')));
        } catch {
            // Written under another OS account or machine: listed, unusable.
        }
    }
    return records;
}

function persist() {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: 1, secrets: records }, null, 2), 'utf8');
}

const referenceFor = (name) => `{{secret:${name}}}`;

/** Store a secret under a name. An empty value removes it. */
function set(name, value) {
    load();
    const key = String(name || '').trim();
    if (!NAME.test(key)) return { error: 'A secret name is letters, digits, dots, dashes and underscores, up to 60 characters.' };
    const text = String(value ?? '');
    if (!text) return remove(key);
    if (!safeStorage.isEncryptionAvailable()) {
        return { error: 'This computer offers no way to encrypt the secret, so it was not stored.' };
    }
    let ciphertext;
    try {
        ciphertext = safeStorage.encryptString(text).toString('base64');
    } catch (error) {
        return { error: `The secret could not be encrypted: ${error.message}` };
    }
    const now = Date.now();
    records[key] = { value: ciphertext, createdAt: records[key]?.createdAt || now, updatedAt: now };
    plain.set(key, text);
    persist();
    return { stored: true, name: key, reference: referenceFor(key) };
}

function remove(name) {
    load();
    const key = String(name || '').trim();
    const had = Boolean(records[key]);
    delete records[key];
    plain.delete(key);
    if (had) persist();
    return { removed: had, name: key };
}

/** The names, never the values. */
function list() {
    load();
    return Object.entries(records)
        .map(([name, record]) => ({
            name,
            reference: referenceFor(name),
            createdAt: record.createdAt || 0,
            updatedAt: record.updatedAt || record.createdAt || 0,
            readable: plain.has(name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function has(name) {
    load();
    return plain.has(String(name || '').trim());
}

/** The value itself. Main process only; nothing hands this to a model. */
function read(name) {
    load();
    return plain.get(String(name || '').trim()) || '';
}

/** Every `{{secret:name}}` in a string replaced by its value. Unknown names are left as written. */
function resolve(text) {
    if (typeof text !== 'string' || !text.includes('{{')) return text;
    load();
    return text.replace(REFERENCE, (whole, name) => (plain.has(name) ? plain.get(name) : whole));
}

/** The same over a map of strings, such as an env or a set of headers. */
function resolveObject(map) {
    const out = {};
    for (const [key, value] of Object.entries(map || {})) out[key] = resolve(String(value ?? ''));
    return out;
}

/**
 * The same through arrays and objects: every string leaf with a reference
 * in it. For the arguments of a tool call, where a password typed into a
 * browser form is `{{secret:site}}` as the model wrote it and the value as
 * the server receives it.
 */
function resolveDeep(value, depth = 0) {
    if (typeof value === 'string') return resolve(value);
    if (!value || typeof value !== 'object' || depth > 8) return value;
    if (Array.isArray(value)) return value.map(entry => resolveDeep(entry, depth + 1));
    let out = value;
    for (const [key, entry] of Object.entries(value)) {
        const filled = resolveDeep(entry, depth + 1);
        if (filled !== entry) {
            if (out === value) out = { ...value };
            out[key] = filled;
        }
    }
    return out;
}

/** The names a string refers to that this store does not hold. */
function unresolved(text) {
    if (typeof text !== 'string') return [];
    load();
    const missing = new Set();
    for (const match of text.matchAll(REFERENCE)) {
        if (!plain.has(match[1])) missing.add(match[1]);
    }
    return [...missing];
}

/** The same through arrays and objects. */
function unresolvedDeep(value, depth = 0) {
    if (typeof value === 'string') return unresolved(value);
    if (!value || typeof value !== 'object' || depth > 8) return [];
    const missing = new Set();
    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
        for (const name of unresolvedDeep(entry, depth + 1)) missing.add(name);
    }
    return [...missing];
}

/** Every stored value masked out of a string. */
function scrub(text) {
    if (typeof text !== 'string' || text.length < MIN_SCRUB_LENGTH) return text;
    load();
    let out = text;
    for (const value of plain.values()) {
        if (value.length < MIN_SCRUB_LENGTH) continue;
        if (out.includes(value)) out = out.split(value).join(MASK);
    }
    return out;
}

/** The same, through arrays and objects. */
function scrubDeep(value, depth = 0) {
    if (typeof value === 'string') return scrub(value);
    if (!value || typeof value !== 'object' || depth > 8) return value;
    if (Array.isArray(value)) return value.map(entry => scrubDeep(entry, depth + 1));
    let out = value;
    for (const [key, entry] of Object.entries(value)) {
        const cleaned = scrubDeep(entry, depth + 1);
        if (cleaned !== entry) {
            if (out === value) out = { ...value };
            out[key] = cleaned;
        }
    }
    return out;
}

/**
 * Every secret the store can still read, in the clear inside the payload
 * (which is itself encrypted). Names encrypted under another OS account or
 * machine decrypt to nothing and are left out: the reference survives in
 * whichever record holds it, and the value has to be typed again.
 */
function exportAll() {
    load();
    const out = {};
    for (const name of Object.keys(records)) {
        const value = plain.get(name);
        if (value) out[name] = value;
    }
    return out;
}

/**
 * Bring secrets from a backup, matched on name, re-encrypted under this
 * machine's keychain on the way in. Anything the OS cannot encrypt is
 * skipped rather than kept in the clear.
 */
function importAll(payload, { overwrite = false } = {}) {
    load();
    const result = { added: 0, replaced: 0, skipped: 0 };
    const incoming = payload && typeof payload === 'object' ? payload : {};
    for (const [name, value] of Object.entries(incoming)) {
        if (!value) {
            result.skipped++;
            continue;
        }
        const had = Boolean(records[name]);
        if (had && !overwrite) {
            result.skipped++;
            continue;
        }
        const stored = set(name, String(value));
        if (!stored?.stored) {
            result.skipped++;
            continue;
        }
        if (had) result.replaced++;
        else result.added++;
    }
    return result;
}

module.exports = {
    set,
    remove,
    list,
    has,
    read,
    exportAll,
    importAll,
    resolve,
    resolveObject,
    resolveDeep,
    unresolved,
    unresolvedDeep,
    scrub,
    scrubDeep,
    referenceFor,
    NAME,
    MASK,
    _test: { reset: () => { records = null; plain = new Map(); } },
};
