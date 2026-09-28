const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const sandboxModule = require('./sandbox');
const container = require('./container');

/**
 * What the agent may do on this computer, behind one door.
 *
 * The local tools in the catalog call these four functions and nothing else.
 * Each one reads the agent's envelope and takes one of two roads: on the
 * host, inside the folders the user granted and nowhere else; or inside the
 * agent's container, where the same folders are mounts under /workspace and
 * the container itself is the wall.
 *
 * The runtime's own local tools (Claude Code's Bash and Write, Codex's
 * workspace) are a separate, older switch. This is the path that respects
 * the envelope, which is why a containerised agent has that switch forced
 * off and works through these instead.
 */

const MAX_FILE_BYTES = 120000;
const MAX_ENTRIES = 500;
const DEFAULT_TIMEOUT = 60000;
const MAX_OUTPUT = 60000;

let spawner = spawn;

/** For tests: replace the process launcher used on the host road. */
function setSpawner(fn) {
    spawner = fn || spawn;
}

const containerised = (ctx) => ctx?.sandbox?.execution === 'container';

function clip(text, limit) {
    if (text.length <= limit) return { text, truncated: false };
    return { text: text.slice(-limit), truncated: true };
}

/**
 * Bring the container up before a call that needs it. Cheap when it is
 * already running: one `docker inspect`.
 */
async function ready(ctx) {
    const result = await container.ensure(ctx.agentId, ctx.sandbox);
    return result.ok ? null : `The agent's container is not available: ${result.message}`;
}

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

async function list(ctx, target) {
    if (containerised(ctx)) {
        const checked = sandboxModule.containerPath(ctx.sandbox, target || sandboxModule.WORKSPACE);
        if (checked.error) return { error: checked.error };
        const problem = await ready(ctx);
        if (problem) return { error: problem };
        const result = await container.exec(ctx.agentId, `ls -la --time-style=long-iso -- ${shellQuote(checked.path)}`);
        if (!result.success) return { error: result.message };
        if (result.exitCode !== 0) return { error: result.stderr.trim() || `ls exited with ${result.exitCode}` };
        return { path: checked.path, listing: result.stdout, truncated: result.truncated };
    }

    const grant = sandboxModule.grantFor(ctx.sandbox, target || '');
    if (grant.error) return { error: grant.error };
    let names;
    try {
        names = fs.readdirSync(grant.path, { withFileTypes: true });
    } catch (error) {
        return { error: error.message };
    }
    const entries = [];
    for (const entry of names.slice(0, MAX_ENTRIES)) {
        let size = null;
        let modified = null;
        try {
            const stat = fs.statSync(path.join(grant.path, entry.name));
            size = stat.size;
            modified = stat.mtime.toISOString();
        } catch {
            // A broken link, or a file that vanished under us.
        }
        entries.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'link' : 'file',
            size,
            modified,
        });
    }
    return { path: grant.path, entries, truncated: names.length > MAX_ENTRIES };
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * A slice of what was read, by line, and a note of where it sits.
 *
 * Reading a hundred-line stretch out of the middle of a long file is the
 * commonest thing an agent does with a file it is about to edit, and
 * without it the only way through is the whole file or a shell command.
 * The numbers are one-based, as every editor and every error message
 * counts them, and each line comes back prefixed with its number so the
 * agent can quote a passage back without counting.
 */
function slice(content, { offset = 0, limit = 0 } = {}) {
    if (!offset && !limit) return { content, from: 1 };
    const first = Math.max(1, Number(offset) || 1);
    // No limit is the rest of the file, not one line of it.
    const count = limit ? Math.max(1, Number(limit)) : 0;
    const lines = content.split('\n');
    const taken = lines.slice(first - 1, count ? first - 1 + count : undefined);
    return {
        content: taken.join('\n'),
        from: first,
        to: first + taken.length - 1,
        lines: lines.length,
        // Said plainly, so an agent that asked past the end knows it did.
        ...(first > lines.length ? { past: true } : {}),
    };
}

async function read(ctx, target, options = {}) {
    if (containerised(ctx)) {
        const checked = sandboxModule.containerPath(ctx.sandbox, target);
        if (checked.error) return { error: checked.error };
        const problem = await ready(ctx);
        if (problem) return { error: problem };
        const result = await container.exec(ctx.agentId, `head -c ${MAX_FILE_BYTES} -- ${shellQuote(checked.path)}`);
        if (!result.success) return { error: result.message };
        if (result.exitCode !== 0) return { error: result.stderr.trim() || `read exited with ${result.exitCode}` };
        return {
            path: checked.path,
            ...slice(result.stdout, options),
            truncated: result.stdout.length >= MAX_FILE_BYTES,
        };
    }

    const grant = sandboxModule.grantFor(ctx.sandbox, target);
    if (grant.error) return { error: grant.error };
    let handle;
    try {
        handle = fs.openSync(grant.path, 'r');
        const stat = fs.fstatSync(handle);
        if (stat.isDirectory()) return { error: `"${grant.path}" is a directory. Use list_local_directory.` };
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_FILE_BYTES));
        const got = fs.readSync(handle, buffer, 0, buffer.length, 0);
        return {
            path: grant.path,
            ...slice(buffer.subarray(0, got).toString('utf8'), options),
            truncated: stat.size > MAX_FILE_BYTES,
        };
    } catch (error) {
        return { error: error.message };
    } finally {
        if (handle !== undefined) fs.closeSync(handle);
    }
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

async function write(ctx, target, content) {
    const text = String(content ?? '');
    if (containerised(ctx)) {
        const checked = sandboxModule.containerPath(ctx.sandbox, target, 'write');
        if (checked.error) return { error: checked.error };
        const problem = await ready(ctx);
        if (problem) return { error: problem };
        const quoted = shellQuote(checked.path);
        const result = await container.exec(
            ctx.agentId,
            `mkdir -p -- "$(dirname -- ${quoted})" && cat > ${quoted}`,
            { stdin: text },
        );
        if (!result.success) return { error: result.message };
        if (result.exitCode !== 0) return { error: result.stderr.trim() || `write exited with ${result.exitCode}` };
        return { path: checked.path, bytes: Buffer.byteLength(text) };
    }

    const grant = sandboxModule.grantFor(ctx.sandbox, target, 'write');
    if (grant.error) return { error: grant.error };
    try {
        fs.mkdirSync(path.dirname(grant.path), { recursive: true });
        fs.writeFileSync(grant.path, text, 'utf8');
        return { path: grant.path, bytes: Buffer.byteLength(text) };
    } catch (error) {
        return { error: error.message };
    }
}

/* ------------------------------------------------------------------ *
 * Editing
 *
 * A replacement of one passage rather than the whole file. The agent
 * names the text it saw and what it should become; the passage must be
 * there exactly once (or `all` must be set), so an edit cannot land on
 * the wrong line because two looked alike. Read and write go through
 * the two doors above, so the grant is checked twice and the container
 * road is the same one.
 * ------------------------------------------------------------------ */

/** How many of a text's line breaks are Windows ones. */
const crlfCount = (text) => (text.match(/\r\n/g) || []).length;
const toLf = (text) => text.replace(/\r\n/g, '\n');
const toCrlf = (text) => toLf(text).replace(/\n/g, '\r\n');

/**
 * Replace a passage of a file with another.
 *
 * Matched on the text with its line endings normalised, and written back
 * with the file's own. A model writes `\n` because that is what text is,
 * and half the files in a repository checked out on Windows have `\r\n` in
 * them: matching literally meant "the text to replace was not found" on a
 * passage the agent had just read and copied exactly, and the way around it
 * was to rewrite the whole file, which changed every line ending in it and
 * buried the real change in a whitespace diff.
 */
function applyEdit(content, oldText, newText, { all = false } = {}) {
    if (!oldText) return { error: 'Say which text to replace: `old` is empty.' };

    // The file's own ending, by weight of evidence: a file that is mostly
    // CRLF keeps CRLF, whatever the passage coming in uses.
    const windows = crlfCount(content) > 0 && crlfCount(content) >= (toLf(content).split('\n').length - 1) / 2;
    const flat = toLf(content);
    const needle = toLf(oldText);
    const replacement = toLf(newText);

    let count = 0;
    let at = flat.indexOf(needle);
    while (at !== -1) {
        count += 1;
        at = flat.indexOf(needle, at + needle.length);
    }
    if (count === 0) return { error: 'The text to replace was not found. Read the file again and copy it exactly, whitespace included.' };
    if (count > 1 && !all) {
        return { error: `The text to replace appears ${count} times. Include more of the surrounding lines so it matches once, or pass all: true to replace every occurrence.` };
    }

    const edited = all ? flat.split(needle).join(replacement) : flat.replace(needle, () => replacement);
    return { content: windows ? toCrlf(edited) : edited, replaced: count };
}

async function edit(ctx, target, oldText, newText, options = {}) {
    // The write is checked before the read so a read-only grant refuses
    // before the file is opened, with the message about writing.
    const allowed = containerised(ctx)
        ? sandboxModule.containerPath(ctx.sandbox, target, 'write')
        : sandboxModule.grantFor(ctx.sandbox, target, 'write');
    if (allowed.error) return { error: allowed.error };

    const current = await read(ctx, target);
    if (current.error) return { error: current.error };
    if (current.truncated) return { error: 'The file is larger than one read can hold, so it cannot be edited in place. Use run_local_command with sed or a script.' };

    const applied = applyEdit(current.content, String(oldText ?? ''), String(newText ?? ''), options);
    if (applied.error) return { error: applied.error };

    const written = await write(ctx, target, applied.content);
    if (written.error) return { error: written.error };
    return { path: written.path, replaced: applied.replaced, bytes: written.bytes };
}

/* ------------------------------------------------------------------ *
 * Searching
 *
 * A grep over a granted folder. On the host it is a walk of the tree
 * with the usual noise left out; in the container it is grep itself.
 * ------------------------------------------------------------------ */

const MAX_MATCHES = 200;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target']);

/** Files that are not text: a NUL in the first 8 KB is the usual tell. */
function looksBinary(buffer) {
    const head = buffer.subarray(0, Math.min(buffer.length, 8192));
    return head.includes(0);
}

function globToRegExp(glob) {
    const escaped = String(glob)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/\?/g, '[^/\\\\]')
        .replace(/\u0000/g, '.*');
    return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
}

async function search(ctx, {
    query, path: target = '', regex = false, ignoreCase = false, glob = '', limit = MAX_MATCHES,
} = {}) {
    const needle = String(query || '');
    if (!needle) return { error: 'Say what to search for.' };
    const cap = Math.max(1, Math.min(Number(limit) || MAX_MATCHES, MAX_MATCHES));
    const loose = Boolean(ignoreCase);

    let pattern;
    try {
        pattern = regex ? new RegExp(needle, loose ? 'i' : '') : null;
    } catch (error) {
        return { error: `That is not a valid regular expression: ${error.message}` };
    }

    /**
     * Nothing found is an answer, and sometimes it is the wrong one.
     *
     * A plain query is matched literally, so `a|b` looks for those three
     * characters and a name typed in the wrong case is missed. Both come
     * back as a confident zero, which reads as "it is not in this tree" and
     * sends the agent off to guess. Where the query itself says which
     * mistake was made, the empty result says so too.
     */
    const withHint = (result) => {
        if (result.error || result.matches?.length) return result;
        const looksRegex = !regex && /[|\\[\]()*+?{}^$]/.test(needle);
        const looksCased = !loose && /[A-Z]/.test(needle) && /[a-z]/.test(needle);
        if (!looksRegex && !looksCased) return result;
        return {
            ...result,
            hint: looksRegex
                ? 'No matches, and the query was matched as literal text: it reads like a regular '
                    + 'expression, so pass regex: true to use it as one.'
                : 'No matches, and the match is case-sensitive: pass ignoreCase: true if the spelling '
                    + 'may differ.',
        };
    };

    if (containerised(ctx)) {
        const checked = sandboxModule.containerPath(ctx.sandbox, target || sandboxModule.WORKSPACE);
        if (checked.error) return { error: checked.error };
        const problem = await ready(ctx);
        if (problem) return { error: problem };
        const flags = ['-rnI', '--exclude-dir=.git', '--exclude-dir=node_modules', regex ? '-E' : '-F'];
        if (loose) flags.push('-i');
        if (glob) flags.push(`--include=${shellQuote(glob)}`);
        const command = `grep ${flags.join(' ')} -e ${shellQuote(needle)} -- ${shellQuote(checked.path)} | head -n ${cap + 1}`;
        const result = await container.exec(ctx.agentId, command);
        if (!result.success) return { error: result.message };
        // grep exits 1 for "nothing found", which is an answer, not an error.
        if (result.exitCode > 1) return { error: result.stderr.trim() || `grep exited with ${result.exitCode}` };
        const lines = result.stdout.split('\n').filter(Boolean);
        const matches = lines.slice(0, cap).map((line) => {
            const found = /^(.*?):(\d+):(.*)$/.exec(line);
            return found
                ? { path: found[1], line: Number(found[2]), text: found[3].slice(0, 400) }
                : { path: '', line: 0, text: line.slice(0, 400) };
        });
        return withHint({ path: checked.path, matches, truncated: lines.length > cap });
    }

    const folders = ctx?.sandbox?.folders || [];
    if (folders.length === 0) return { error: sandboxModule.grantFor(ctx.sandbox, target || '.').error };
    const roots = target
        ? [sandboxModule.grantFor(ctx.sandbox, target)]
        : folders.map(folder => ({ path: folder.path }));
    const bad = roots.find(root => root.error);
    if (bad) return { error: bad.error };

    const fileFilter = glob ? globToRegExp(glob) : null;
    const matches = [];
    let scanned = 0;
    let truncated = false;

    const lowered = loose ? needle.toLowerCase() : needle;
    const test = (line) => (pattern
        ? pattern.test(line)
        : (loose ? line.toLowerCase().includes(lowered) : line.includes(needle)));

    const walk = (directory) => {
        if (truncated) return;
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (truncated) return;
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            if (fileFilter && !fileFilter.test(entry.name)) continue;
            scanned += 1;
            if (scanned > MAX_SEARCH_FILES) {
                truncated = true;
                return;
            }
            let buffer;
            try {
                const stat = fs.statSync(full);
                if (stat.size > MAX_SEARCH_FILE_BYTES) continue;
                buffer = fs.readFileSync(full);
            } catch {
                continue;
            }
            if (looksBinary(buffer)) continue;
            const lines = buffer.toString('utf8').split('\n');
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                if (!test(line)) continue;
                if (matches.length >= cap) {
                    truncated = true;
                    return;
                }
                matches.push({ path: full, line: index + 1, text: line.trimEnd().slice(0, 400) });
            }
        }
    };

    for (const root of roots) {
        let stat;
        try {
            stat = fs.statSync(root.path);
        } catch {
            continue;
        }
        if (stat.isDirectory()) walk(root.path);
        else {
            // A single file named as the target. Counted and capped like
            // one met on a walk, so the report says what was read.
            const parent = path.dirname(root.path);
            const name = path.basename(root.path);
            if ((!fileFilter || fileFilter.test(name)) && stat.size <= MAX_SEARCH_FILE_BYTES) {
                scanned += 1;
                const buffer = fs.readFileSync(root.path);
                if (!looksBinary(buffer)) {
                    buffer.toString('utf8').split('\n').forEach((line, index) => {
                        if (test(line) && matches.length < cap) matches.push({ path: path.join(parent, name), line: index + 1, text: line.trimEnd().slice(0, 400) });
                    });
                }
            }
        }
    }

    return withHint({
        searched: roots.map(root => root.path),
        filesScanned: scanned,
        matches,
        truncated,
    });
}

/* ------------------------------------------------------------------ *
 * Running
 * ------------------------------------------------------------------ */

/**
 * Run a command on this computer.
 *
 * In a container the command is the container's problem. On the host it runs
 * with its working directory inside a granted folder, and that is the whole
 * fence: a shell can reach anything the user can, and the folder grant is a
 * statement of intent the approval card enforces, not a wall. The prompt and
 * the settings page both say so. Anyone who wants a wall turns the container
 * on.
 */
async function run(ctx, command, { cwd = '', timeout = DEFAULT_TIMEOUT, stdin = null, env = null } = {}) {
    const text = String(command || '').trim();
    if (!text) return { success: false, message: 'A command is needed.' };

    if (containerised(ctx)) {
        const checked = sandboxModule.containerPath(ctx.sandbox, cwd || sandboxModule.WORKSPACE);
        if (checked.error) return { success: false, message: checked.error };
        const problem = await ready(ctx);
        if (problem) return { success: false, message: problem };
        return container.exec(ctx.agentId, text, { cwd: checked.path, timeout, stdin });
    }

    const folders = ctx?.sandbox?.folders || [];
    if (folders.length === 0) {
        return { success: false, message: sandboxModule.grantFor(ctx.sandbox, cwd || '.').error };
    }
    const grant = sandboxModule.grantFor(ctx.sandbox, cwd || folders[0].path);
    if (grant.error) return { success: false, message: grant.error };

    return new Promise((resolve) => {
        const windows = process.platform === 'win32';
        const shell = windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
        const args = windows ? ['/d', '/s', '/c', text] : ['-c', text];
        let child;
        try {
            child = spawner(shell, args, {
                cwd: grant.path,
                env: env ? { ...process.env, ...env } : process.env,
                windowsHide: true,
                stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            resolve({ success: false, message: error.message });
            return;
        }
        if (stdin !== null && child.stdin) {
            child.stdin.on('error', () => {});
            child.stdin.end(String(stdin));
        }
        let out = '';
        let err = '';
        let settled = false;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* gone */ }
            settle({
                success: false,
                timedOut: true,
                message: `The command was still running after ${Math.round(timeout / 1000)}s and was stopped`,
                stdout: clip(out, MAX_OUTPUT).text,
                stderr: clip(err, MAX_OUTPUT).text,
            });
        }, timeout);
        child.on('error', (error) => settle({ success: false, message: error.message }));
        child.stdout.on('data', (data) => { if (out.length < MAX_OUTPUT * 4) out += data.toString('utf8'); });
        child.stderr.on('data', (data) => { if (err.length < MAX_OUTPUT * 4) err += data.toString('utf8'); });
        child.on('close', (code, signal) => {
            const stdout = clip(out, MAX_OUTPUT);
            const stderr = clip(err, MAX_OUTPUT);
            settle({
                success: true,
                exitCode: typeof code === 'number' ? code : null,
                signal: signal || null,
                stdout: stdout.text,
                stderr: stderr.text,
                truncated: stdout.truncated || stderr.truncated,
            });
        });
    });
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
    list, read, write, edit, search, run, setSpawner, applyEdit,
    MAX_FILE_BYTES, DEFAULT_TIMEOUT, MAX_MATCHES,
};
