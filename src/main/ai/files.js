const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Files an agent carries: documents, scripts, archives, pictures, anything
 * it was handed or made and will want again. The inventory's bag for things
 * that are bytes rather than records.
 *
 * Each file belongs to an agent the way its secrets do. An agent sees its
 * own and the shared ones (no owner), its own hiding a shared one of the
 * same name; another agent's are not there to see. The agent has the whole
 * of its own: it saves, reads, renames, replaces, sends and deletes them. A
 * shared file it may read and send, and copy into its own bag to change; the
 * shared copy is the user's, changed from the Files page.
 *
 * On disk, under the app's data folder:
 *
 *   files/index.json        what each file is: name, owner, size, type, notes
 *   files/<id>/<name>       the bytes, under the file's own name
 *
 * The bytes keep their name so a program handed the path (`{{file:name}}` in
 * a local command) sees the extension it expects. The index is the only
 * record of ownership; a folder the index does not know is not a file.
 */

const SCHEMA_VERSION = 1;

/** One file, at most. Big enough for an image or an installer, small enough to copy without thinking. */
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 500;
const MAX_TAGS = 8;

/** What Windows will not have in a file name, and what no platform should. */
const BAD_CHARS = /[\\/:*?"<>|\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** `{{file:name}}`, as a local command or its env refers to a file. */
const REFERENCE = /\{\{\s*file:([^{}]{1,120}?)\s*\}\}/g;

const root = () => path.join(app.getPath('userData'), 'files');
const indexFile = () => path.join(root(), 'index.json');

let records = null;

function load() {
    if (records) return records;
    records = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
        if (Array.isArray(parsed?.files)) {
            records = parsed.files.filter(entry => entry && typeof entry.id === 'string' && typeof entry.name === 'string');
        }
    } catch {
        // Missing or unreadable: none yet.
    }
    return records;
}

function persist() {
    fs.mkdirSync(root(), { recursive: true });
    const target = indexFile();
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: SCHEMA_VERSION, files: records }, null, 2), 'utf8');
    fs.renameSync(temp, target);
}

const cleanOwner = (owner) => String(owner || '').trim();
const fold = (name) => String(name || '').toLowerCase();
const newId = () => `f-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const blobDir = (record) => path.join(root(), record.id);
const blobPath = (record) => path.join(blobDir(record), record.name);
const referenceFor = (name) => `{{file:${name}}}`;

/** A name a file can be kept under on any platform, or why not. */
function cleanName(raw) {
    const name = String(raw ?? '').trim().replace(/[. ]+$/, '');
    if (!name) return { error: 'A file needs a name.' };
    if (name.length > MAX_NAME) return { error: `A file name is at most ${MAX_NAME} characters.` };
    if (BAD_CHARS.test(name)) return { error: 'A file name cannot contain \\ / : * ? " < > | or control characters.' };
    if (name === '.' || name === '..' || RESERVED.test(name)) return { error: `"${name}" is not a name a file can have.` };
    return { name };
}

function cleanTags(tags) {
    if (!Array.isArray(tags)) return [];
    return [...new Set(tags.map(tag => String(tag || '').trim().replace(/^#/, '').slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS);
}

const cleanDescription = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION);

const MIME = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain',
    json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', xml: 'application/xml',
    toml: 'application/toml', ini: 'text/plain', conf: 'text/plain', cfg: 'text/plain', env: 'text/plain',
    html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
    ts: 'text/typescript', jsx: 'text/javascript', tsx: 'text/typescript', py: 'text/x-python', rb: 'text/x-ruby',
    go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java', c: 'text/x-c', h: 'text/x-c', cpp: 'text/x-c++',
    cs: 'text/x-csharp', php: 'text/x-php', sh: 'text/x-shellscript', bash: 'text/x-shellscript',
    ps1: 'text/plain', bat: 'text/plain', cmd: 'text/plain', sql: 'application/sql', pem: 'application/x-pem-file',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip',
    tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    exe: 'application/vnd.microsoft.portable-executable', msi: 'application/x-msi', deb: 'application/vnd.debian.binary-package',
    rpm: 'application/x-rpm', iso: 'application/x-iso9660-image', wasm: 'application/wasm',
};

function mimeFor(name) {
    const ext = path.extname(String(name || '')).slice(1).toLowerCase();
    return MIME[ext] || 'application/octet-stream';
}

/** Whether a stretch of bytes looks like text: no NUL in it. */
function looksText(buffer) {
    const sample = buffer.subarray(0, 8192);
    return !sample.includes(0);
}

/* ------------------------------------------------------------------ *
 * Who sees what
 * ------------------------------------------------------------------ */

/**
 * The records an owner sees: its own, and the shared ones it has no file of
 * the same name to hide. With no owner given, every record, for the page
 * that tidies up and for moving an agent's files on when it is deleted.
 */
function visible(owner) {
    const all = load();
    if (owner === undefined || owner === null) return [...all];
    const who = cleanOwner(owner);
    const own = all.filter(record => who && record.owner === who);
    const names = new Set(own.map(record => fold(record.name)));
    const shared = all.filter(record => !record.owner && !names.has(fold(record.name)));
    return [...own, ...shared];
}

/** A file by id or by name, as one owner sees it; its own wins over a shared one of the same name. */
function lookup(ref, owner) {
    const wanted = String(ref ?? '').trim();
    if (!wanted) return null;
    const seen = visible(owner);
    return seen.find(record => record.id === wanted)
        || seen.find(record => record.name === wanted)
        || seen.find(record => fold(record.name) === fold(wanted))
        || null;
}

/** The owner's own file of a name, ignoring case, other than `exceptId`. */
function taken(name, owner, exceptId = '') {
    const who = cleanOwner(owner);
    return load().find(record => (record.owner || '') === who && fold(record.name) === fold(name) && record.id !== exceptId) || null;
}

function publicFile(record) {
    return {
        id: record.id,
        name: record.name,
        size: record.size || 0,
        mime: record.mime || mimeFor(record.name),
        description: record.description || '',
        tags: record.tags || [],
        owner: record.owner || '',
        shared: !record.owner,
        source: record.source || '',
        sha256: record.sha256 || '',
        createdAt: record.createdAt || 0,
        updatedAt: record.updatedAt || record.createdAt || 0,
        reference: referenceFor(record.name),
    };
}

/** May this owner change this record? Its own, always; a shared one only from the page. */
function mayChange(record, owner, asUser) {
    if (asUser) return true;
    return Boolean(record.owner) && record.owner === cleanOwner(owner);
}

const sharedRefusal = (record) => ({
    error: `"${record.name}" is a shared file, which the user changes from the Files page. `
        + 'Use send_inventory_file with to: "agent" naming yourself to keep a copy of your own, and change that.',
});

/* ------------------------------------------------------------------ *
 * Bytes on disk
 * ------------------------------------------------------------------ */

function hashFile(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/**
 * Put bytes where a record's file lives, through a temporary name so a copy
 * that fails half way does not leave a half file under the real one.
 */
async function writeBlob(record, { data, fromPath }) {
    const dir = blobDir(record);
    await fs.promises.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `.incoming-${crypto.randomBytes(4).toString('hex')}`);
    try {
        if (fromPath) await fs.promises.copyFile(fromPath, temp);
        else await fs.promises.writeFile(temp, data);
        // Whatever was there under another name goes: a file is one blob.
        for (const entry of await fs.promises.readdir(dir)) {
            if (entry !== path.basename(temp)) await fs.promises.rm(path.join(dir, entry), { force: true, recursive: true });
        }
        await fs.promises.rename(temp, blobPath(record));
    } catch (error) {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
        throw error;
    }
    const stat = await fs.promises.stat(blobPath(record));
    return { size: stat.size, sha256: await hashFile(blobPath(record)) };
}

/* ------------------------------------------------------------------ *
 * Keeping
 * ------------------------------------------------------------------ */

/**
 * Add a file for an owner (none: shared), from bytes in hand or a file on
 * this disk. A name the owner already has is refused unless `overwrite`,
 * which replaces the bytes and keeps the record: its id, its date of birth,
 * and its notes unless new ones are given.
 */
async function add({ name, data = null, fromPath = '', mime = '', description, tags, source = '' } = {}, owner = '', { overwrite = false } = {}) {
    load();
    const who = cleanOwner(owner);
    const cleaned = cleanName(name || (fromPath ? path.basename(fromPath) : ''));
    if (cleaned.error) return cleaned;

    if (!fromPath && !Buffer.isBuffer(data)) return { error: 'There is nothing to store: no content and no file to copy.' };
    let size;
    if (fromPath) {
        let stat;
        try {
            stat = await fs.promises.stat(fromPath);
        } catch (error) {
            return { error: `Could not read ${fromPath}: ${error.message}` };
        }
        if (!stat.isFile()) return { error: `${fromPath} is not a file.` };
        size = stat.size;
    } else {
        size = data.length;
    }
    if (size > MAX_BYTES) {
        return { error: `That file is ${Math.round(size / 1048576)} MB; a file in the inventory is at most ${MAX_BYTES / 1048576} MB.` };
    }

    const existing = taken(cleaned.name, who);
    if (existing && !overwrite) {
        return {
            error: `There is already a file called "${existing.name}"${who ? '' : ' in the shared files'}. `
                + 'Choose another name, or replace it on purpose.',
            exists: publicFile(existing),
        };
    }

    const now = Date.now();
    const record = existing || { id: newId(), owner: who, createdAt: now };
    record.name = cleaned.name;
    record.mime = mime || mimeFor(cleaned.name);
    if (description !== undefined || !existing) record.description = cleanDescription(description);
    if (tags !== undefined || !existing) record.tags = cleanTags(tags);
    record.source = String(source || record.source || '').slice(0, 500);
    record.updatedAt = now;

    let written;
    try {
        written = await writeBlob(record, fromPath ? { fromPath } : { data });
    } catch (error) {
        return { error: `The file could not be stored: ${error.message}` };
    }
    record.size = written.size;
    record.sha256 = written.sha256;
    if (!existing) records.push(record);
    persist();
    return { file: publicFile(record), replaced: Boolean(existing) };
}

/** Rename a file, change its notes, or (from the page) move it between an agent's bag and the shared one. */
async function update(ref, owner, { name, description, tags, shared } = {}, { asUser = false } = {}) {
    const record = lookup(ref, owner);
    if (!record) return { error: `There is no file "${ref}" in your inventory.` };
    if (!mayChange(record, owner, asUser)) return sharedRefusal(record);

    const who = cleanOwner(owner);
    const nextOwner = shared === undefined || !asUser ? (record.owner || '') : (shared ? '' : who);
    let nextName = record.name;
    if (name !== undefined) {
        const cleaned = cleanName(name);
        if (cleaned.error) return cleaned;
        nextName = cleaned.name;
    }
    const clash = taken(nextName, nextOwner, record.id);
    if (clash) return { error: `There is already a file called "${clash.name}" ${nextOwner ? 'in this bag' : 'among the shared files'}.` };

    if (nextName !== record.name) {
        try {
            await fs.promises.rename(blobPath(record), path.join(blobDir(record), nextName));
        } catch (error) {
            return { error: `The file could not be renamed: ${error.message}` };
        }
        record.mime = mimeFor(nextName);
    }
    record.name = nextName;
    record.owner = nextOwner;
    if (description !== undefined) record.description = cleanDescription(description);
    if (tags !== undefined) record.tags = cleanTags(tags);
    record.updatedAt = Date.now();
    persist();
    return { file: publicFile(record) };
}

/** New bytes for a file this owner may change, keeping its name and notes. */
async function replace(ref, owner, { data = null, fromPath = '', source } = {}, { asUser = false } = {}) {
    const record = lookup(ref, owner);
    if (!record) return { error: `There is no file "${ref}" in your inventory.` };
    if (!mayChange(record, owner, asUser)) return sharedRefusal(record);
    return add({ name: record.name, data, fromPath, mime: mimeFor(record.name), source: source ?? record.source }, record.owner || '', { overwrite: true });
}

/** Delete a file. An agent deletes its own; a shared one goes from the page. */
async function remove(ref, owner, { asUser = false } = {}) {
    const record = lookup(ref, owner);
    if (!record) return { error: `There is no file "${ref}" in your inventory.` };
    if (!mayChange(record, owner, asUser)) return sharedRefusal(record);
    try {
        await fs.promises.rm(blobDir(record), { recursive: true, force: true });
    } catch (error) {
        return { error: `The file could not be deleted: ${error.message}` };
    }
    records = load().filter(entry => entry.id !== record.id);
    persist();
    return { removed: true, file: publicFile(record) };
}

/** A copy of a file this owner can see, into another bag (or its own, under a new name). */
async function copyTo(ref, owner, toOwner, { name, overwrite = false } = {}) {
    const record = lookup(ref, owner);
    if (!record) return { error: `There is no file "${ref}" in your inventory.` };
    return add({
        name: name || record.name,
        fromPath: blobPath(record),
        mime: record.mime,
        description: record.description,
        tags: record.tags,
        source: `copied from ${record.owner ? 'an agent' : 'the shared files'}: ${record.name}`,
    }, toOwner, { overwrite });
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

function get(ref, owner) {
    const record = lookup(ref, owner);
    return record ? publicFile(record) : null;
}

/** Where the bytes are. Main process only: what a local command is handed, and what the page opens. */
function pathOf(ref, owner) {
    const record = lookup(ref, owner);
    return record ? blobPath(record) : '';
}

/** The bytes, up to `max` of them, and whether that was all. */
async function readBytes(ref, owner, { max = MAX_BYTES } = {}) {
    const record = lookup(ref, owner);
    if (!record) return { error: `There is no file "${ref}" in your inventory.` };
    let handle;
    try {
        handle = await fs.promises.open(blobPath(record), 'r');
        const { size } = await handle.stat();
        const length = Math.min(size, max);
        const data = Buffer.alloc(length);
        await handle.read(data, 0, length, 0);
        return { file: publicFile(record), data, truncated: size > length, text: looksText(data) };
    } catch (error) {
        return { error: `Could not read "${record.name}": ${error.message}` };
    } finally {
        await handle?.close().catch(() => {});
    }
}

function list(owner) {
    return visible(owner)
        .map(publicFile)
        .sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
}

/**
 * Every `{{file:name}}` in a string replaced by where that file is on disk,
 * for an owner. Names it has no file for are left as written and reported.
 */
function resolve(text, owner) {
    if (typeof text !== 'string' || !text.includes('{{')) return { text, missing: [] };
    const missing = new Set();
    const out = text.replace(REFERENCE, (whole, name) => {
        const record = lookup(name.trim(), owner);
        if (!record) {
            missing.add(name.trim());
            return whole;
        }
        return blobPath(record);
    });
    return { text: out, missing: [...missing] };
}

/** Whether a string refers to any file at all. */
const refersToFiles = (text) => typeof text === 'string' && /\{\{\s*file:/.test(text);

/* ------------------------------------------------------------------ *
 * An agent leaving
 * ------------------------------------------------------------------ */

/**
 * Hand every file of one agent to another, as its conversations and notes
 * are when an agent is deleted. A name the heir already has gets a number.
 */
function moveAll(fromOwner, toOwner) {
    const from = cleanOwner(fromOwner);
    const to = cleanOwner(toOwner);
    if (!from || from === to) return 0;
    let moved = 0;
    for (const record of load()) {
        if (record.owner !== from) continue;
        let name = record.name;
        const ext = path.extname(name);
        const stem = name.slice(0, name.length - ext.length);
        for (let n = 2; taken(name, to, record.id); n += 1) name = `${stem} (${n})${ext}`;
        if (name !== record.name) {
            try {
                fs.renameSync(blobPath(record), path.join(blobDir(record), name));
                record.name = name;
            } catch {
                continue;
            }
        }
        record.owner = to;
        moved += 1;
    }
    if (moved) persist();
    return moved;
}

/** The store as one agent sees it, every call bound to that owner. */
function forAgent(owner) {
    const who = cleanOwner(owner);
    return {
        list: () => list(who),
        get: (ref) => get(ref, who),
        add: (spec, options) => add(spec, who, options),
        update: (ref, patch) => update(ref, who, patch),
        replace: (ref, spec) => replace(ref, who, spec),
        remove: (ref) => remove(ref, who),
        copyTo: (ref, toOwner, options) => copyTo(ref, who, toOwner, options),
        readBytes: (ref, options) => readBytes(ref, who, options),
        pathOf: (ref) => pathOf(ref, who),
        resolve: (text) => resolve(text, who),
    };
}

module.exports = {
    add,
    update,
    replace,
    remove,
    copyTo,
    get,
    list,
    pathOf,
    readBytes,
    resolve,
    refersToFiles,
    moveAll,
    forAgent,
    mimeFor,
    cleanName,
    referenceFor,
    MAX_BYTES,
    _test: { reset: () => { records = null; } },
};
