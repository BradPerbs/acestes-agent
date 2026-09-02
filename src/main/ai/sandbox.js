const path = require('path');

/**
 * The envelope an agent works inside.
 *
 * An agent is sandboxed twice. The first layer is code: every tool call passes
 * through handlers in this process, and those handlers check what the call
 * touches against the envelope below before anything runs. That layer is
 * always on. It is also the only layer that can fence the servers, because
 * the SSH sessions and the vault live here and nowhere a container could
 * wrap.
 *
 * The second layer is a container, per agent, opted into by the user. When
 * it is on, everything the agent does on *this* machine (its local commands,
 * its file reads and writes, the MCP servers from its inventory) runs inside
 * a hardened Docker container with only the folders granted here mounted,
 * so a bug in a handler or a hostile MCP server cannot reach the rest of the
 * disk. See container.js for that side.
 *
 * This file is the envelope itself: its shape, its defaults, and the pure
 * checks the tool layer runs against it. No Docker, no filesystem; it is what
 * both layers agree on.
 */

const EXECUTIONS = new Set(['host', 'container']);
const SESSIONS = new Set(['own', 'any']);
const NETWORKS = new Set(['none', 'any']);
const MODES = new Set(['read', 'write']);

const MAX_FOLDERS = 20;
const MAX_PATH = 1000;

/** The image the container runs when the user has not named one. */
const DEFAULT_IMAGE = 'debian:bookworm-slim';

/**
 * Where the granted folders appear inside the container. Each folder is
 * mounted under this by its own base name, so `/home/me/site` becomes
 * `/workspace/site`, and the agent's scratch space is the root of it.
 */
const WORKSPACE = '/workspace';

/**
 * What a fresh agent gets.
 *
 * Nothing local: no folders, so the local tools refuse until the user grants
 * one. `sessions: 'own'` is the one default that tightens something that
 * used to be open, and it is the point of the exercise: two agents in the
 * same window must not be able to drive each other's terminals.
 */
const DEFAULTS = Object.freeze({
    execution: 'host',
    sessions: 'own',
    network: 'none',
    folders: [],
    image: '',
});

const clean = (value, max = MAX_PATH) => String(value ?? '').trim().slice(0, max);

function normalizeFolder(raw) {
    if (!raw) return null;
    const source = typeof raw === 'string' ? { path: raw } : raw;
    if (typeof source !== 'object') return null;
    const folder = clean(source.path);
    if (!folder || !path.isAbsolute(folder)) return null;
    return {
        path: path.normalize(folder),
        mode: MODES.has(source.mode) ? source.mode : 'read',
    };
}

/**
 * An envelope as stored: every field present, every value one of the known
 * ones, and nothing that was not asked for. A folder that is not an absolute
 * path is dropped rather than repaired, since a relative grant would be
 * relative to whatever the process happens to be in.
 */
function normalize(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const folders = [];
    for (const entry of Array.isArray(source.folders) ? source.folders : []) {
        const folder = normalizeFolder(entry);
        if (!folder) continue;
        const key = process.platform === 'win32' ? folder.path.toLowerCase() : folder.path;
        if (seen.has(key)) continue;
        seen.add(key);
        folders.push(folder);
        if (folders.length >= MAX_FOLDERS) break;
    }

    return {
        execution: EXECUTIONS.has(source.execution) ? source.execution : DEFAULTS.execution,
        sessions: SESSIONS.has(source.sessions) ? source.sessions : DEFAULTS.sessions,
        network: NETWORKS.has(source.network) ? source.network : DEFAULTS.network,
        folders,
        image: clean(source.image, 200),
    };
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * Whether `target` is `root` or somewhere under it, after both are resolved.
 *
 * Case-insensitive on Windows, where `C:\Site` and `c:\site` are one folder,
 * and never a bare prefix match: `/srv/site` must not admit `/srv/site2`.
 */
function within(root, target) {
    const base = path.resolve(root);
    const candidate = path.resolve(target);
    const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
    const relative = path.relative(fold(base), fold(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The granted folder a local path falls in, or null when it falls in none.
 *
 * `mode` is what the caller is about to do. A folder granted read-only
 * refuses a write, and the refusal names the folder so the model's next move
 * is a correct one. The deepest grant wins when they nest, which is what
 * lets a write-only subfolder sit inside a read-only tree.
 */
function grantFor(sandbox, target, mode = 'read') {
    const folders = Array.isArray(sandbox?.folders) ? sandbox.folders : [];
    let best = null;
    for (const folder of folders) {
        if (!within(folder.path, target)) continue;
        if (!best || folder.path.length > best.path.length) best = folder;
    }
    if (!best) return { error: noGrant(sandbox, target) };
    if (mode === 'write' && best.mode !== 'write') {
        return { error: `"${target}" is inside ${best.path}, which this agent may only read. Ask the user to grant it for writing.` };
    }
    return { folder: best, path: path.resolve(target) };
}

function noGrant(sandbox, target) {
    const folders = Array.isArray(sandbox?.folders) ? sandbox.folders : [];
    if (folders.length === 0) {
        return 'This agent has no folders on this computer. Ask the user to grant one in the agent\'s sandbox settings.';
    }
    return `"${target}" is outside the folders this agent may use on this computer. `
        + `Granted: ${folders.map(folder => `${folder.path} (${folder.mode})`).join(', ')}. `
        + 'Stay inside them; if the task needs more, say so and let the user widen the grant.';
}

/**
 * Where a granted folder is mounted inside the container.
 *
 * By base name, with a numeric suffix when two grants share one, so the model
 * sees `/workspace/site` rather than a hash. Stable for a given list, which
 * matters because the mounts are decided when the container is created and
 * the paths are quoted to the model on every turn after that.
 */
function mountPlan(sandbox) {
    const used = new Map();
    return (Array.isArray(sandbox?.folders) ? sandbox.folders : []).map((folder) => {
        const base = path.basename(folder.path).replace(/[^A-Za-z0-9._-]/g, '_') || 'folder';
        const count = used.get(base) || 0;
        used.set(base, count + 1);
        const name = count === 0 ? base : `${base}-${count + 1}`;
        return {
            host: folder.path,
            container: `${WORKSPACE}/${name}`,
            mode: folder.mode,
        };
    });
}

/**
 * A path as the model names it inside the container, checked against the
 * mounts. Anything outside `/workspace` is refused here as well as by the
 * container's read-only root: the message is better than EACCES, and the
 * agent's own scratch space under `/workspace` stays writable either way.
 */
function containerPath(sandbox, target, mode = 'read') {
    const posix = path.posix;
    const raw = String(target || '').trim();
    if (!raw) return { error: 'A path is needed.' };
    const resolved = posix.resolve(WORKSPACE, raw.replace(/\\/g, '/'));
    const relative = posix.relative(WORKSPACE, resolved);
    if (relative.startsWith('..') || posix.isAbsolute(relative)) {
        return { error: `"${raw}" is outside ${WORKSPACE}, which is all this agent can reach inside its container.` };
    }
    for (const mount of mountPlan(sandbox)) {
        const inside = posix.relative(mount.container, resolved);
        if (inside === '' || (!inside.startsWith('..') && !posix.isAbsolute(inside))) {
            if (mode === 'write' && mount.mode !== 'write') {
                return { error: `"${resolved}" is a read-only mount of ${mount.host}. Ask the user to grant it for writing.` };
            }
            return { path: resolved, mount };
        }
    }
    return { path: resolved, mount: null };
}

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

/**
 * Variables that are plausibly a secret, by name. Stripped from anything the
 * agent's own MCP servers are started with: a server from someone's
 * inventory has no business inheriting the user's cloud keys because they
 * happened to be exported in the shell that launched the app.
 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/**
 * What a subprocess needs to run at all: where programs are, where home is,
 * what the locale and the temp directory are. Windows needs a few more for
 * anything to start, and they carry no secrets.
 */
const SYSTEM_NAMES = new Set([
    'PATH', 'Path', 'HOME', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TZ',
    'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'SYSTEMDRIVE', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC',
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ProgramFiles', 'PROGRAMFILES',
    'ProgramFiles(x86)', 'ProgramData', 'PROGRAMDATA', 'PATHEXT', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'OS', 'DISPLAY', 'WAYLAND_DISPLAY', 'SSH_AUTH_SOCK',
]);

/**
 * The environment an agent's MCP server is started with: the system's own
 * variables, minus anything that looks like a secret, plus what the user
 * typed on the server's own record, which wins because they put it there for
 * this server on purpose.
 */
function safeEnv(base = process.env, own = {}) {
    const out = {};
    for (const [name, value] of Object.entries(base || {})) {
        if (value === undefined) continue;
        if (!SYSTEM_NAMES.has(name)) continue;
        if (SECRET_NAME.test(name)) continue;
        out[name] = String(value);
    }
    for (const [name, value] of Object.entries(own || {})) {
        out[name] = String(value ?? '');
    }
    return out;
}

/** A line for the prompt: what the agent may touch on this computer. */
function describe(sandbox) {
    const folders = Array.isArray(sandbox?.folders) ? sandbox.folders : [];
    if (sandbox?.execution === 'container') {
        const mounts = mountPlan(sandbox);
        const lines = [
            `Your local tools run inside a container, not on the user's computer directly. `
            + `Your working directory is ${WORKSPACE}, which is scratch space that persists between conversations. `
            + (sandbox.network === 'none'
                ? 'The container has no network access.'
                : 'The container can reach the network.'),
        ];
        if (mounts.length > 0) {
            lines.push('Folders from the user\'s computer, mounted inside it:');
            for (const mount of mounts) {
                lines.push(`- ${mount.container} (${mount.mode === 'write' ? 'read and write' : 'read only'}) is ${mount.host}`);
            }
        } else {
            lines.push('No folders from the user\'s computer are mounted.');
        }
        return lines.join('\n');
    }
    if (folders.length === 0) {
        return 'You have no access to files or commands on the user\'s own computer. The local tools will refuse until the user grants a folder.';
    }
    return [
        'On the user\'s own computer you may use only these folders, and the local tools refuse anything outside them:',
        ...folders.map(folder => `- ${folder.path} (${folder.mode === 'write' ? 'read and write' : 'read only'})`),
    ].join('\n');
}

module.exports = {
    DEFAULTS,
    DEFAULT_IMAGE,
    WORKSPACE,
    normalize,
    within,
    grantFor,
    mountPlan,
    containerPath,
    safeEnv,
    describe,
};
