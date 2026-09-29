const fs = require('fs');
const path = require('path');
const diff = require('./diff');
const local = require('./local');

/**
 * What a turn did to files, and how to take it back.
 *
 * A turn that edits files ends with a card listing them, the way a diff
 * tool's summary does, and the card offers to undo the lot. Undo needs the
 * files as they were, so each one is read the moment before its first edit
 * in the turn and again after every edit, and the pair is kept here.
 *
 * Where the read happens depends on who does the writing:
 *
 *   our own tools    edit_file, write_file and their local twins record the
 *                    file themselves, in the handler, on either side of the
 *                    write. That is the only road to a file on a server.
 *   a runtime's own  Claude Code's Edit, OpenCode's edit and the rest run in
 *                    their own process, so the file is read when the call is
 *                    announced and again when its result comes back. Claude
 *                    Code cannot run a call before `canUseTool` has answered,
 *                    and that answer comes after the announcement, so the
 *                    first read is always of the file before the edit. For a
 *                    runtime that announces late the read can land after the
 *                    edit; the passage the call named is then reversed
 *                    instead, which is what `passages` is for.
 *
 * Undo is refused, file by file, where a file has moved on since: restoring
 * a snapshot over someone else's later change would be a second, worse
 * edit. A passage that can still be found is put back even then.
 *
 * Kept on disk beside the conversation history, one file per conversation,
 * so the card still works after a restart. A file bigger than a diff is
 * worth reading, or binary, is not held at all and is left out of the card.
 */

/** Past this a file is not snapshotted: the card would not show it anyway. */
const MAX_BYTES = 2 * 1024 * 1024;
/** Turns kept per conversation. Older ones lose their undo, not their card. */
const MAX_TURNS = 12;

/** conversationId -> the turn being recorded: `{ turnId, files, calls }`. */
const open = new Map();
/** conversationId -> the finished turns read from or written to disk. */
const finished = new Map();

let directory = '';

function storeDir() {
    if (!directory) {
        // eslint-disable-next-line global-require
        const { app } = require('electron');
        directory = path.join(app.getPath('userData'), 'assistant-checkpoints');
    }
    return directory;
}

/** For the tests: somewhere that is not the user's profile. */
function setDirectory(value) {
    directory = value;
    finished.clear();
    open.clear();
}

const fileFor = (conversationId) => path.join(
    storeDir(),
    `${String(conversationId).replace(/[^\w.-]/g, '_')}.json`,
);

function loadTurns(conversationId) {
    if (finished.has(conversationId)) return finished.get(conversationId);
    let turns = [];
    try {
        const parsed = JSON.parse(fs.readFileSync(fileFor(conversationId), 'utf8'));
        if (Array.isArray(parsed?.turns)) turns = parsed.turns;
    } catch {
        // None yet, or unreadable: either way there is nothing to undo.
    }
    finished.set(conversationId, turns);
    return turns;
}

function saveTurns(conversationId) {
    const turns = finished.get(conversationId) || [];
    try {
        fs.mkdirSync(storeDir(), { recursive: true });
        fs.writeFileSync(fileFor(conversationId), JSON.stringify({ turns }), 'utf8');
    } catch (error) {
        console.error('Could not save the edit checkpoints:', error.message);
    }
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

/**
 * A file's key within a turn. Case folded on Windows, where `C:\a` and
 * `c:\A` are the same file and a runtime will happily spell it both ways.
 */
function keyOf(file) {
    const where = file.where === 'remote' ? `remote:${file.sessionId || ''}` : 'local';
    const name = file.where === 'remote' ? file.path : path.resolve(file.path);
    return `${where}:${process.platform === 'win32' && file.where !== 'remote' ? name.toLowerCase() : name}`;
}

/**
 * A local file as `{ existed, content }`, or null when it cannot be held:
 * unreadable, too large, or not text. Absent is an answer, not a failure,
 * because a file the turn created is undone by removing it.
 */
function readLocal(target) {
    try {
        const stat = fs.statSync(target);
        if (!stat.isFile() || stat.size > MAX_BYTES) return null;
        const buffer = fs.readFileSync(target);
        if (buffer.subarray(0, 8000).includes(0)) return null;
        return { existed: true, content: buffer.toString('utf8') };
    } catch (error) {
        if (error.code === 'ENOENT') return { existed: false, content: '' };
        return null;
    }
}

const sameState = (left, right) => Boolean(left && right)
    && left.existed === right.existed
    && (!left.existed || left.content === right.content);

/* ------------------------------------------------------------------ *
 * Recording
 * ------------------------------------------------------------------ */

function begin(conversationId, turnId) {
    open.set(conversationId, { turnId, files: new Map(), calls: new Map() });
}

function entryFor(conversationId, file) {
    const turn = open.get(conversationId);
    if (!turn || !file?.path) return null;
    const key = keyOf(file);
    if (!turn.files.has(key)) {
        turn.files.set(key, {
            key,
            path: file.where === 'remote' ? file.path : path.resolve(file.path),
            where: file.where === 'remote' ? 'remote' : 'local',
            sessionId: file.sessionId || '',
            host: file.host || '',
            before: undefined,
            after: undefined,
            passages: [],
        });
    }
    return turn.files.get(key);
}

/** The file before the turn touched it. Only the first reading counts. */
function before(conversationId, file, state) {
    const entry = entryFor(conversationId, file);
    if (entry && entry.before === undefined) entry.before = state || null;
}

/** The file as the turn left it. Every reading replaces the last. */
function after(conversationId, file, state) {
    const entry = entryFor(conversationId, file);
    if (entry) entry.after = state || null;
}

/** A passage the turn replaced, for when the snapshot cannot be trusted. */
function passage(conversationId, file, change) {
    const entry = entryFor(conversationId, file);
    if (entry && typeof change?.new === 'string' && typeof change?.old === 'string') {
        entry.passages.push({ old: change.old, new: change.new, all: Boolean(change.all) });
    }
}

/**
 * The passages an edit call names, in the order they were applied. Every
 * runtime spells them its own way; diff.js already knows the spellings.
 */
function passagesOf(input) {
    if (!input || typeof input !== 'object') return [];
    const one = (value) => {
        const old = diff.pickOld(value);
        const next = diff.pickNew(value);
        return old !== undefined && next !== undefined
            ? [{ old, new: next, all: Boolean(value.replace_all || value.replaceAll || value.all) }]
            : [];
    };
    if (Array.isArray(input.edits)) return input.edits.flatMap(one);
    return one(input);
}

/**
 * A runtime's own edit tool, announced. Read now, before it runs, and held
 * against the call id so the result can read it again.
 */
function callStarted(conversationId, event) {
    const turn = open.get(conversationId);
    if (!turn || !event?.id) return;
    const target = diff.editTarget(event.rawName || event.name, event.input);
    if (!target || !path.isAbsolute(target)) return;
    const file = { where: 'local', path: target };
    before(conversationId, file, readLocal(target));
    turn.calls.set(event.id, { file, passages: passagesOf(event.input) });
}

function callFinished(conversationId, event) {
    const turn = open.get(conversationId);
    const call = turn?.calls.get(event?.id);
    if (!call) return;
    turn.calls.delete(event.id);
    after(conversationId, call.file, readLocal(call.file.path));
    // A refused or failed edit changed nothing, so it has nothing to reverse.
    if (!event.isError) for (const change of call.passages) passage(conversationId, call.file, change);
}

/** How many lines a file gained and lost, from whichever record is sound. */
function countLines(entry) {
    if (entry.before && entry.after) {
        const change = diff.between(entry.before.existed ? entry.before.content : '', entry.after.existed ? entry.after.content : '');
        return change ? { added: change.added, removed: change.removed } : { added: 0, removed: 0 };
    }
    return entry.passages.reduce((total, change) => {
        const counted = diff.between(change.old, change.new);
        return counted
            ? { added: total.added + counted.added, removed: total.removed + counted.removed }
            : total;
    }, { added: 0, removed: 0 });
}

/**
 * Close the turn. Answers what it changed, in the card's shape, or null
 * when it changed nothing; what is needed to undo it is kept here.
 */
function finish(conversationId) {
    const turn = open.get(conversationId);
    open.delete(conversationId);
    if (!turn) return null;

    const files = [];
    for (const entry of turn.files.values()) {
        // Unknown on either side, and no passage to fall back on: the file
        // was never held, so it is neither shown nor offered for undo.
        if (entry.before === undefined) entry.before = null;
        if (entry.after === undefined) entry.after = null;

        // Read after the edit had already landed: the two readings agree, but
        // the call said it replaced something. The passage is the truth then.
        if (entry.before && entry.after && sameState(entry.before, entry.after)) {
            if (entry.passages.length === 0) continue;
            entry.before = null;
        }
        if (!(entry.before && entry.after) && entry.passages.length === 0) continue;

        const { added, removed } = countLines(entry);
        files.push({
            ...entry,
            added,
            removed,
            created: Boolean(entry.before && !entry.before.existed && entry.after?.existed),
            deleted: Boolean(entry.before?.existed && entry.after && !entry.after.existed),
        });
    }
    if (files.length === 0) return null;

    const turns = loadTurns(conversationId);
    turns.push({ turnId: turn.turnId, at: Date.now(), reverted: false, files });
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
    saveTurns(conversationId);

    return { turnId: turn.turnId, files: files.map(summaryOf) };
}

/** A file as the card draws it: no contents, which stay here. */
function summaryOf(entry) {
    return {
        path: entry.path,
        where: entry.where,
        host: entry.host,
        added: entry.added,
        removed: entry.removed,
        created: entry.created,
        deleted: entry.deleted,
    };
}

/* ------------------------------------------------------------------ *
 * Reading back and undoing
 * ------------------------------------------------------------------ */

const findTurn = (conversationId, turnId) => loadTurns(conversationId)
    .find(turn => String(turn.turnId) === String(turnId)) || null;

/** Each file's change as lines, for the card's review. */
function changes(conversationId, turnId) {
    const turn = findTurn(conversationId, turnId);
    if (!turn) return { found: false, files: [] };
    return {
        found: true,
        reverted: Boolean(turn.reverted),
        files: turn.files.map((entry) => {
            let change = null;
            if (entry.before && entry.after) {
                change = diff.between(entry.before.existed ? entry.before.content : '', entry.after.existed ? entry.after.content : '');
            } else {
                // The passages alone: the lines around them were never held.
                const parts = entry.passages.map(item => diff.between(item.old, item.new)).filter(Boolean);
                change = parts.length ? {
                    added: parts.reduce((total, part) => total + part.added, 0),
                    removed: parts.reduce((total, part) => total + part.removed, 0),
                    hunks: parts.flatMap(part => part.hunks),
                    tooLarge: parts.some(part => part.tooLarge),
                    partial: true,
                } : null;
            }
            return { ...summaryOf(entry), diff: change };
        }),
    };
}

/** Reading and writing a local file, for undo. */
const localIo = {
    read: async (entry) => readLocal(entry.path),
    write: async (entry, content) => {
        fs.mkdirSync(path.dirname(entry.path), { recursive: true });
        fs.writeFileSync(entry.path, content, 'utf8');
    },
    remove: async (entry) => {
        try {
            fs.unlinkSync(entry.path);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    },
};

/** The same over the session's SFTP channel, which must still be open. */
function remoteIo() {
    // eslint-disable-next-line global-require
    const sftp = require('../sftp');
    const over = (entry, fn) => sftp.withSftp(entry.sessionId, fn).then((result) => {
        if (result && result.success === false) throw new Error(result.message || 'SFTP is not available on that session.');
        return result?.value;
    });
    return {
        read: entry => over(entry, (handle, resolve) => {
            handle.readFile(entry.path, (error, data) => {
                if (error) {
                    // SSH_FX_NO_SUCH_FILE: gone, which is an answer.
                    resolve(error.code === 2
                        ? { value: { existed: false, content: '' } }
                        : { success: false, message: error.message });
                    return;
                }
                resolve({ value: { existed: true, content: data.toString('utf8') } });
            });
        }),
        write: (entry, content) => over(entry, (handle, resolve) => {
            handle.writeFile(entry.path, content, { encoding: 'utf8' }, (error) => {
                resolve(error ? { success: false, message: error.message } : { value: true });
            });
        }),
        remove: entry => over(entry, (handle, resolve) => {
            handle.unlink(entry.path, (error) => {
                resolve(error && error.code !== 2 ? { success: false, message: error.message } : { value: true });
            });
        }),
    };
}

/**
 * The file with its passages put back, newest first, or null when one of
 * them is no longer there to find.
 */
function reversePassages(content, passages) {
    let text = content;
    for (const change of [...passages].reverse()) {
        // An edit that deleted its passage left nothing to find it by.
        if (!change.new) return null;
        const applied = local.applyEdit(text, change.new, change.old, { all: change.all });
        if (applied.error) return null;
        text = applied.content;
    }
    return text;
}

async function revertFile(entry, io) {
    const current = await io.read(entry);
    if (!current) return 'It could not be read.';

    if (entry.before && entry.after) {
        if (sameState(current, entry.before)) return '';
        if (sameState(current, entry.after)) {
            if (entry.before.existed) await io.write(entry, entry.before.content);
            else await io.remove(entry);
            return '';
        }
    }
    if (entry.passages.length > 0 && current.existed) {
        const restored = reversePassages(current.content, entry.passages);
        if (restored !== null) {
            await io.write(entry, restored);
            return '';
        }
    }
    return 'It has changed since, so it was left as it is.';
}

/**
 * Put every file the turn changed back the way it was. File by file, so
 * one that has moved on since does not stop the others; the answer says
 * which were put back and which were not, and why.
 */
async function revert(conversationId, turnId, { remote = remoteIo } = {}) {
    const turn = findTurn(conversationId, turnId);
    if (!turn) return { success: false, message: 'There is nothing kept to undo for that turn.' };
    if (turn.reverted) return { success: true, reverted: [], failed: [], already: true };

    const reverted = [];
    const failed = [];
    let remoteChannel = null;
    // The last file touched first, so a turn that edited one file twice by
    // two roads is unwound in the order it was wound.
    for (const entry of [...turn.files].reverse()) {
        try {
            const io = entry.where === 'remote'
                ? (remoteChannel || (remoteChannel = remote()))
                : localIo;
            const problem = await revertFile(entry, io);
            if (problem) failed.push({ path: entry.path, reason: problem });
            else reverted.push(entry.path);
        } catch (error) {
            failed.push({ path: entry.path, reason: error.message });
        }
    }

    turn.reverted = failed.length === 0;
    turn.revertedAt = Date.now();
    saveTurns(conversationId);
    return { success: true, reverted, failed };
}

/** A conversation thrown away takes its snapshots with it. */
function forget(conversationId) {
    open.delete(conversationId);
    finished.delete(conversationId);
    try {
        fs.unlinkSync(fileFor(conversationId));
    } catch {
        // Never had any.
    }
}

module.exports = {
    begin,
    before,
    after,
    passage,
    callStarted,
    callFinished,
    finish,
    changes,
    revert,
    forget,
    readLocal,
    setDirectory,
    MAX_BYTES,
};
