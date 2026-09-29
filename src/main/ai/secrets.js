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
 * Each secret belongs to an agent, the way its hosts, keys and memory do.
 * An agent lists and resolves its own and nobody else's, so a token stored
 * for one agent's work is not something another agent can spend; two
 * agents can each have a `webshare` of their own, and the credentials
 * vaulted for two agents' MCP servers of the same name do not collide. A
 * secret with no owner is shared by all of them: what a store written
 * before secrets had owners holds, until each is given one.
 *
 * The second half is scrubbing. Every value stored here, whoever owns it,
 * is also masked out of every event the app records or shows, so a secret
 * that did reach an agent by some other road (pasted into chat, read off a
 * disk) is not repeated by the transcript.
 */

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/;
const REFERENCE = /\{\{\s*secret:([A-Za-z0-9_][A-Za-z0-9_.-]{0,59})\s*\}\}/g;
const MASK = '••••';
/** Shorter than this and masking would eat ordinary words. */
const MIN_SCRUB_LENGTH = 8;

const SCHEMA_VERSION = 2;

const file = () => path.join(app.getPath('userData'), 'secrets.json');

/**
 * Where a secret is kept: `<owner>/<name>`, the owner an agent id or empty
 * for a shared one. Neither half can hold a slash, so the key splits back
 * cleanly. A key with no slash is a name from the store's first version,
 * which had no owners, and is read as shared.
 */
const keyFor = (owner, name) => `${owner || ''}/${name}`;
function splitKey(key) {
    const at = key.indexOf('/');
    return at === -1 ? { owner: '', name: key } : { owner: key.slice(0, at), name: key.slice(at + 1) };
}

const cleanOwner = (owner) => String(owner || '').trim();

// `<owner>/<name>` -> { value: base64 ciphertext, createdAt, updatedAt }
let records = null;
// `<owner>/<name>` -> plaintext, for resolving and scrubbing without a decrypt per use
let plain = new Map();

function load() {
    if (records) return records;
    records = {};
    plain = new Map();
    try {
        const parsed = JSON.parse(fs.readFileSync(file(), 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object') {
            for (const [stored, record] of Object.entries(parsed.secrets)) {
                const { owner, name } = splitKey(stored);
                if (NAME.test(name)) records[keyFor(owner, name)] = record;
            }
        }
    } catch {
        // Missing or unreadable: none yet.
    }
    for (const [key, record] of Object.entries(records)) {
        try {
            plain.set(key, safeStorage.decryptString(Buffer.from(String(record.value || ''), 'base64')));
        } catch {
            // Written under another OS account or machine: listed, unusable.
        }
    }
    return records;
}

function persist() {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({ version: SCHEMA_VERSION, secrets: records }, null, 2), 'utf8');
}

const referenceFor = (name) => `{{secret:${name}}}`;

/**
 * The key a name resolves to for an owner: the owner's own secret of that
 * name, else a shared one, else null. An agent's own always wins, so giving
 * it a secret of its own is how a shared one is overridden for it.
 */
function lookup(name, owner = '') {
    load();
    const who = cleanOwner(owner);
    if (who && Object.prototype.hasOwnProperty.call(records, keyFor(who, name))) return keyFor(who, name);
    if (Object.prototype.hasOwnProperty.call(records, keyFor('', name))) return keyFor('', name);
    return null;
}

/** Store a secret under a name, for an owner (none: shared). An empty value removes it. */
function set(name, value, owner = '') {
    load();
    const who = cleanOwner(owner);
    const clean = String(name || '').trim();
    if (!NAME.test(clean)) return { error: 'A secret name is letters, digits, dots, dashes and underscores, up to 60 characters.' };
    const text = String(value ?? '');
    if (!text) return remove(clean, who);
    if (!safeStorage.isEncryptionAvailable()) {
        return { error: 'This computer offers no way to encrypt the secret, so it was not stored.' };
    }
    let ciphertext;
    try {
        ciphertext = safeStorage.encryptString(text).toString('base64');
    } catch (error) {
        return { error: `The secret could not be encrypted: ${error.message}` };
    }
    const key = keyFor(who, clean);
    const now = Date.now();
    records[key] = { value: ciphertext, createdAt: records[key]?.createdAt || now, updatedAt: now };
    plain.set(key, text);
    persist();
    return { stored: true, name: clean, reference: referenceFor(clean) };
}

/**
 * Remove an owner's secret by name. An agent removes its own; a shared one
 * is removed when asked for with no owner, from the keychain page, and never
 * by an agent that merely has the use of it.
 */
function remove(name, owner = '') {
    load();
    const clean = String(name || '').trim();
    const key = keyFor(cleanOwner(owner), clean);
    const had = Object.prototype.hasOwnProperty.call(records, key);
    delete records[key];
    plain.delete(key);
    if (had) persist();
    return { removed: had, name: clean };
}

/**
 * The names, never the values. For an owner: its own and the shared ones,
 * the shared marked so; the owner's own hides a shared one of the same name,
 * as it does when resolving. With no owner given: every secret, each with
 * its owner, for the backup and for scrubbing's sake.
 */
function list(owner) {
    load();
    const everything = owner === undefined || owner === null;
    const who = cleanOwner(owner);
    const byName = new Map();
    for (const [key, record] of Object.entries(records)) {
        const { owner: holder, name } = splitKey(key);
        if (!everything && holder && holder !== who) continue;
        const entry = {
            name,
            reference: referenceFor(name),
            owner: holder,
            shared: !holder,
            createdAt: record.createdAt || 0,
            updatedAt: record.updatedAt || record.createdAt || 0,
            readable: plain.has(key),
        };
        if (everything) {
            byName.set(key, entry);
        } else if (!byName.has(name) || holder) {
            byName.set(name, entry);
        }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
}

function has(name, owner = '') {
    const key = lookup(String(name || '').trim(), owner);
    return Boolean(key && plain.has(key));
}

/** The value itself. Main process only; nothing hands this to a model. */
function read(name, owner = '') {
    const key = lookup(String(name || '').trim(), owner);
    return (key && plain.get(key)) || '';
}

/**
 * Every `{{secret:name}}` in a string replaced by its value, for an owner:
 * its own secrets and the shared ones. Another agent's are left as written,
 * exactly as an unknown name is, so to this owner they do not exist.
 */
function resolve(text, owner = '') {
    if (typeof text !== 'string' || !text.includes('{{')) return text;
    load();
    return text.replace(REFERENCE, (whole, name) => {
        const key = lookup(name, owner);
        return key && plain.has(key) ? plain.get(key) : whole;
    });
}

/** The same over a map of strings, such as an env or a set of headers. */
function resolveObject(map, owner = '') {
    const out = {};
    for (const [key, value] of Object.entries(map || {})) out[key] = resolve(String(value ?? ''), owner);
    return out;
}

/**
 * The same through arrays and objects: every string leaf with a reference
 * in it. For the arguments of a tool call, where a password typed into a
 * browser form is `{{secret:site}}` as the model wrote it and the value as
 * the server receives it.
 */
function resolveDeep(value, owner = '', depth = 0) {
    if (typeof value === 'string') return resolve(value, owner);
    if (!value || typeof value !== 'object' || depth > 8) return value;
    if (Array.isArray(value)) return value.map(entry => resolveDeep(entry, owner, depth + 1));
    let out = value;
    for (const [key, entry] of Object.entries(value)) {
        const filled = resolveDeep(entry, owner, depth + 1);
        if (filled !== entry) {
            if (out === value) out = { ...value };
            out[key] = filled;
        }
    }
    return out;
}

/** The names a string refers to that this owner has no secret for. */
function unresolved(text, owner = '') {
    if (typeof text !== 'string') return [];
    load();
    const missing = new Set();
    for (const match of text.matchAll(REFERENCE)) {
        const key = lookup(match[1], owner);
        if (!key || !plain.has(key)) missing.add(match[1]);
    }
    return [...missing];
}

/** The same through arrays and objects. */
function unresolvedDeep(value, owner = '', depth = 0) {
    if (typeof value === 'string') return unresolved(value, owner);
    if (!value || typeof value !== 'object' || depth > 8) return [];
    const missing = new Set();
    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
        for (const name of unresolvedDeep(entry, owner, depth + 1)) missing.add(name);
    }
    return [...missing];
}

/**
 * The store as one agent sees it: every call bound to that owner, in the
 * shape the tool layer has always taken. What a conversation's tools get,
 * so nothing an agent runs can name another agent's secrets.
 */
function forAgent(owner) {
    const who = cleanOwner(owner);
    return {
        list: () => list(who),
        set: (name, value) => set(name, value, who),
        remove: (name) => remove(name, who),
        has: (name) => has(name, who),
        resolve: (text) => resolve(text, who),
        resolveObject: (map) => resolveObject(map, who),
        resolveDeep: (value) => resolveDeep(value, who),
        unresolved: (text) => unresolved(text, who),
        unresolvedDeep: (value) => unresolvedDeep(value, who),
    };
}

/** Every stored value masked out of a string, whoever owns it. */
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
 * (which is itself encrypted), keyed `<owner>/<name>` so each goes back to
 * the agent it belongs to. Names encrypted under another OS account or
 * machine decrypt to nothing and are left out: the reference survives in
 * whichever record holds it, and the value has to be typed again.
 */
function exportAll() {
    load();
    const out = {};
    for (const key of Object.keys(records)) {
        const value = plain.get(key);
        if (value) out[key] = value;
    }
    return out;
}

/**
 * Bring secrets from a backup, matched on owner and name, re-encrypted under
 * this machine's keychain on the way in. A backup from before secrets had
 * owners is keyed by name alone, and those come in shared. Anything the OS
 * cannot encrypt is skipped rather than kept in the clear.
 */
function importAll(payload, { overwrite = false } = {}) {
    load();
    const result = { added: 0, replaced: 0, skipped: 0 };
    const incoming = payload && typeof payload === 'object' ? payload : {};
    for (const [stored, value] of Object.entries(incoming)) {
        if (!value) {
            result.skipped++;
            continue;
        }
        const { owner, name } = splitKey(stored);
        const had = Object.prototype.hasOwnProperty.call(records, keyFor(owner, name));
        if (had && !overwrite) {
            result.skipped++;
            continue;
        }
        const kept = set(name, String(value), owner);
        if (!kept?.stored) {
            result.skipped++;
            continue;
        }
        if (had) result.replaced++;
        else result.added++;
    }
    return result;
}

/** The backup keys this store already holds, for a preview to count against. */
function keys() {
    load();
    return Object.keys(records);
}

module.exports = {
    set,
    remove,
    list,
    has,
    read,
    forAgent,
    exportAll,
    importAll,
    keys,
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
