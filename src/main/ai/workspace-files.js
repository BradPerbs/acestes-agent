const fs = require('fs');
const path = require('path');
const sandboxModule = require('./sandbox');

/**
 * The files in the folders the user granted an agent, for the `@` picker.
 *
 * `@` used to know only the agent's inventory (hosts, snippets, notes,
 * proxies, keys, MCP servers, skills), so typing it showed the servers and
 * never a file from the work path. This module is the file side: a capped
 * walk of the granted folders for completion, plus the path helpers the
 * send flow uses to resolve a tagged file back to something `local.read`
 * may open.
 *
 * The walk never leaves the granted folders and never follows a symlink, so
 * a linked tree cannot pull the listing (or the model) somewhere the grant
 * does not reach. It stays small on purpose: ignored build and control
 * directories, a depth cap, a size cap, and a file cap, sorted so the list
 * is stable between keystrokes.
 */

/** Capped, so the picker stays a picker and not an index. */
const MAX_FILES = 800;
const MAX_DEPTH = 8;
/** Past this a file is listed nowhere: tagging it could only send a prefix. */
const MAX_FILE_SIZE = 1024 * 1024;

/** Directories that are never worth tagging: build output and controls. */
const IGNORE_DIRS = new Set([
    'node_modules',
    '.git',
    '.hg',
    '.svn',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output',
    '__pycache__',
    '.venv',
    'venv',
    'target',
    '.idea',
    '.turbo',
    '.cache',
]);

/** Extensions with no text worth sending when tagged. */
const BINARY_EXT = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp', 'avif',
    'pdf', 'zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'dmg', 'pkg',
    'exe', 'dll', 'so', 'dylib', 'node', 'woff', 'woff2', 'ttf', 'otf', 'eot',
    'mp3', 'mp4', 'mov', 'avi', 'mkv', 'sqlite', 'db',
]);

const clean = (value) => String(value ?? '');

function foldersOf(sandbox) {
    return Array.isArray(sandbox?.folders) ? sandbox.folders.filter(folder => folder?.path) : [];
}

/** The deepest granted folder a path sits in, or null outside the grant. */
function containingFolder(folders, absolutePath) {
    let best = null;
    for (const folder of folders) {
        if (!sandboxModule.within(folder.path, absolutePath)) continue;
        if (!best || folder.path.length > best.path.length) best = folder;
    }
    return best;
}

/**
 * A file as the picker shows it: the path relative to its folder, prefixed
 * with the folder's own name when several folders are granted, next to the
 * absolute path for matching. The id is the absolute path: what the send
 * flow resolves, checked against the grant again rather than trusted.
 */
function displayRel(sandbox, absolutePath) {
    const folders = foldersOf(sandbox);
    const folder = containingFolder(folders, absolutePath);
    const rel = folder
        ? path.relative(folder.path, absolutePath).split(path.sep).join('/')
        : path.basename(absolutePath);
    if (!folder || folders.length < 2) return rel || path.basename(absolutePath);
    const base = path.basename(folder.path) || folder.path;
    return `${base}/${rel}`;
}

function listableDir(name) {
    return !IGNORE_DIRS.has(name);
}

function listableFile(name, size) {
    if (size > MAX_FILE_SIZE) return false;
    const ext = path.extname(name).slice(1).toLowerCase();
    return !BINARY_EXT.has(ext);
}

/**
 * The granted folders as a flat file list: `[{ id, name, hint }]`. Missing
 * folders read as empty rather than an error, so an unplugged drive cannot
 * break the composer.
 */
function listWorkspaceFiles(sandbox, options = {}) {
    const maxFiles = options.maxFiles || MAX_FILES;
    const maxDepth = options.maxDepth || MAX_DEPTH;
    const out = [];

    for (const folder of foldersOf(sandbox)) {
        let root;
        try {
            root = path.resolve(folder.path);
            if (!fs.existsSync(root)) continue;
            if (!fs.statSync(root).isDirectory()) continue;
        } catch {
            continue;
        }
        const stack = [{ dir: root, depth: 0 }];
        while (stack.length > 0 && out.length < maxFiles) {
            const current = stack.pop();
            if (current.depth > maxDepth) continue;
            let entries;
            try {
                entries = fs.readdirSync(current.dir, { withFileTypes: true });
            } catch {
                continue;
            }
            // Stable order, files before deeper directories is irrelevant:
            // sort by name so the list does not shuffle between keystrokes.
            entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
            for (const entry of entries) {
                if (out.length >= maxFiles) break;
                const full = path.join(current.dir, entry.name);
                let stat = null;
                try {
                    stat = fs.lstatSync(full);
                } catch {
                    continue;
                }
                // Never follow a link: a linked tree could otherwise walk the
                // listing out of the granted folders.
                if (stat.isSymbolicLink()) continue;
                if (stat.isDirectory()) {
                    if (current.depth < maxDepth && listableDir(entry.name)) {
                        stack.push({ dir: full, depth: current.depth + 1 });
                    }
                    continue;
                }
                if (!stat.isFile() || !listableFile(entry.name, stat.size)) continue;
                const id = path.resolve(full);
                out.push({ id, name: displayRel(sandbox, id), hint: id });
            }
        }
        if (out.length >= maxFiles) break;
    }

    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out.slice(0, maxFiles);
}

/**
 * The path `local.read` may open for a tagged file id. On the host that is
 * the id itself once the grant admits it; in a container it is the same
 * file under its mount, since the model only ever names `/workspace` paths
 * there. Anything outside the granted folders is refused with the reason.
 */
function toAgentPath(sandbox, id) {
    const raw = clean(id).trim();
    if (!raw) return { error: 'A file to tag needs a path.' };
    if (!path.isAbsolute(raw)) return { error: `"${raw}" is not an absolute path.` };
    const absolutePath = path.normalize(raw);
    const folders = foldersOf(sandbox);

    if (sandbox?.execution === 'container') {
        const folder = containingFolder(folders, absolutePath);
        if (!folder) {
            return { error: `"${absolutePath}" is outside the folders this agent may use on this computer.` };
        }
        const mounts = sandboxModule.mountPlan(sandbox);
        const mount = mounts.find(entry => entry.host === path.normalize(folder.path));
        const rel = path.relative(folder.path, absolutePath).split(path.sep).join('/');
        const containerPath = mount
            ? path.posix.join(mount.container, rel)
            : path.posix.join(sandboxModule.WORKSPACE, rel);
        return { path: containerPath };
    }

    const grant = sandboxModule.grantFor(sandbox, absolutePath);
    if (grant.error) return { error: grant.error };
    return { path: grant.path };
}

module.exports = {
    listWorkspaceFiles,
    toAgentPath,
    displayRel,
    MAX_FILES,
    MAX_DEPTH,
    MAX_FILE_SIZE,
};
