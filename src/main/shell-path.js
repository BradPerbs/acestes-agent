const { spawnSync } = require('child_process');

/**
 * The login shell's PATH, for a packaged app started outside a terminal.
 *
 * On macOS an app opened from Finder or the Dock (and on Linux one opened
 * from a desktop file) starts with a minimal PATH such as
 * `/usr/bin:/bin:/usr/sbin:/sbin`. That PATH knows no `node`, so a CLI that
 * is a `#!/usr/bin/env node` script dies the moment it is spawned: the
 * kernel runs `/usr/bin/env node`, `env` finds nothing, and the child is
 * gone before it prints a word. `pi` is exactly such a script
 * (`/opt/homebrew/bin/pi` points at Pi's bundled `cli.js`), so in the
 * installed build `pi --mode rpc` never answers `get_available_models` and
 * the Pi model list comes back empty. `npm run dev` works because Electron
 * then inherits the terminal's PATH, where `node` resolves.
 *
 * The same trap waits for every other CLI agent that is a script rather
 * than a native binary, so this is fixed once, here, instead of per
 * provider: before anything spawns a CLI, the login shell is asked for the
 * PATH it would have in a terminal and anything missing is added to this
 * process, which every provider inherits through `process.env`.
 *
 * Never throws and never removes an entry. When the shell cannot be asked
 * (or answers nonsense, e.g. a chatty dotfile), the PATH is left alone and
 * the providers fall back to their own extra search folders as before.
 */

/** How long asking the shell may take before it is given up on. */
const SHELL_TIMEOUT = 4000;

/** Shells to ask, in order: the user's own first, then the likely stock ones. */
function shellCandidates(env = process.env) {
    const shells = [];
    if (typeof env.SHELL === 'string' && env.SHELL.startsWith('/')) shells.push(env.SHELL);
    for (const fallback of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
        if (!shells.includes(fallback)) shells.push(fallback);
    }
    return shells;
}

/**
 * The PATH a shell reports for `printf %s "$PATH"`, or ''. Login (`-l`) so
 * the profile files that set PATH run; interactive (`-i`) so `~/.zshrc` and
 * friends, where version managers usually put themselves, run too.
 */
function queryShellPath(shell, spawnFn = spawnSync) {
    let result;
    try {
        result = spawnFn(shell, ['-l', '-i', '-c', 'printf %s "$PATH"'], {
            encoding: 'utf8',
            timeout: SHELL_TIMEOUT,
            windowsHide: true,
        });
    } catch {
        return '';
    }
    if (!result || result.status !== 0 || typeof result.stdout !== 'string') return '';
    return pickPathLine(result.stdout);
}

/**
 * The PATH line of a shell's output. A dotfile may echo around it, so this
 * is the last non-empty line rather than the whole output; a PATH never
 * spans lines. Anything that is not colon-separated absolute directories is
 * not a PATH and is refused, so a weird answer cannot corrupt the process.
 */
function pickPathLine(output) {
    const lines = String(output || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.length) return '';
    const candidate = lines[lines.length - 1];
    const entries = candidate.split(':').filter(Boolean);
    if (!entries.length) return '';
    if (!entries.every(entry => entry.startsWith('/') || entry.startsWith('~'))) return '';
    return entries.join(':');
}

/**
 * The union of both PATHs, the shell's order first: it is the order the
 * user chose in their dotfiles, while the inherited one is the system's
 * fallback. Entries already present are not duplicated, and anything only
 * in the current PATH is kept at the end rather than dropped.
 */
function mergePaths(current, shellPath, delimiter = ':') {
    const seen = new Set();
    const out = [];
    for (const entry of [...String(shellPath || '').split(delimiter), ...String(current || '').split(delimiter)]) {
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out.join(delimiter);
}

function ensureShellPath({ env = process.env, platform = process.platform, spawnFn = spawnSync } = {}) {
    if (platform === 'win32') return env.PATH;
    const current = typeof env.PATH === 'string' ? env.PATH : '';
    for (const shell of shellCandidates(env)) {
        const reported = queryShellPath(shell, spawnFn);
        if (!reported) continue;
        const merged = mergePaths(current, reported, ':');
        if (merged && merged !== current) env.PATH = merged;
        return env.PATH;
    }
    return current;
}

module.exports = {
    ensureShellPath,
    _test: { shellCandidates, queryShellPath, pickPathLine, mergePaths },
};
