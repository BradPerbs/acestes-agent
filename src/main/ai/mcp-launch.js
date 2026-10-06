/**
 * Start one of an agent's MCP servers with exactly the environment it was
 * given, and nothing inherited.
 *
 * Claude Code spawns the stdio servers in its config itself, and it lays the
 * server's `env` over its own environment rather than replacing it. That is
 * the right default for a developer's laptop and the wrong one here: a server
 * from an agent's inventory would inherit every cloud key exported in the
 * shell that launched the app. So the config names this script instead, run
 * by the app's own binary as plain Node, and the real command and its
 * scrubbed environment ride along as one JSON argument. This process then
 * does the one spawn with `env` set outright.
 *
 * Standalone on purpose: it runs outside the app, so it requires nothing
 * from it. Stdio is inherited, which is the whole MCP transport, and the
 * child is taken down with this process so a runtime that kills its server
 * does not leave the real one running.
 *
 * Windows needs two things a POSIX spawn does not. A bare name such as
 * `npx` is not a program there but a `.cmd` shim found through PATH and
 * PATHEXT, and `spawn` without a shell does not look; so the name is
 * resolved here first. And a `.cmd` or `.bat` file can only be run through
 * `cmd.exe`, which takes the whole command line as one string it parses
 * itself: Node's `shell: true` joins the arguments with spaces and no
 * quoting, so a path with a space in it (`C:\Program Files\nodejs\npx.cmd`)
 * became `'C:\Program' is not recognized`. The line is built and quoted
 * here instead, and handed over verbatim.
 *
 * And one shortcut, for the commonest server of all. `npx -y <package>` is
 * how nearly every MCP server is written up, and npx is slow to say nothing:
 * a shell, npm's own start-up and a registry check come to a second and a
 * half on Windows before the server is even run, and the runtime holds the
 * conversation's first message until every server has answered. So when the
 * package is already in npx's own cache, under exactly the spec it is being
 * asked for, its bin is run with `node` directly (Playwright: 0.3 seconds
 * rather than 1.4). npx is still the one that fetches it the first time and
 * the one that keeps it current: a spec that is not an exact version is
 * checked in the background, at most once a day, by `npm exec` with the same
 * spec, which updates that same cache entry the way npx would have. Anything
 * this does not recognise goes through npx exactly as before.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** How long after start a background check waits, so it never races the server's own start-up. */
const REFRESH_DELAY = 60 * 1000;
/** How often one spec is checked for a newer version. */
const REFRESH_EVERY = 24 * 60 * 60 * 1000;

/** A value of an environment by name, whichever case it was given in. */
function envValueOf(env, name) {
    const key = Object.keys(env || {}).find(entry => entry.toLowerCase() === name.toLowerCase());
    return key ? String(env[key]) : '';
}

/**
 * The file a bare command name stands for, found the way the shell finds it:
 * each PATH directory and, on Windows, each PATHEXT extension, in order. A
 * name with a directory or an extension in it is taken as given.
 */
function resolveCommand(command, env, { platform = process.platform, statSync = fs.statSync } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    if (/[\\/]/.test(command) || (windows && paths.extname(command))) return command;
    const dirs = envValueOf(env, 'PATH').split(windows ? ';' : ':').filter(Boolean);
    const exts = windows ? (envValueOf(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = paths.join(dir, command + ext);
            try {
                if (statSync(candidate).isFile()) return candidate;
            } catch {
                // Not there; next.
            }
        }
    }
    return command;
}

/** One token of a cmd.exe command line, quoted when it has to be. */
function quoteForCmd(token) {
    if (token !== '' && !/[\s"&|<>^()]/.test(token)) return token;
    return `"${token.replace(/"/g, '\\"')}"`;
}

/**
 * `npx [-y] [--] <package> [args...]` as the package and its arguments, or
 * null for anything else: a flag this does not know (`-p`, `--registry`,
 * `-c`) changes what npx would do, so that is left to npx.
 */
function parseNpx(command, args) {
    const base = String(command || '').split(/[\\/]/).pop().toLowerCase();
    if (!['npx', 'npx.cmd', 'npx.exe'].includes(base)) return null;
    let index = 0;
    while (index < args.length && /^(-y|--yes|-q|--quiet|--silent)$/.test(args[index])) index += 1;
    if (args[index] === '--') index += 1;
    const spec = args[index];
    if (!spec || spec.startsWith('-')) return null;
    // A path or a URL is not a registry package with a cache entry to find.
    if (/^[.~/\\]|^[a-z]+:/i.test(spec) && !spec.startsWith('@')) return null;
    return { spec, args: args.slice(index + 1) };
}

/** The package name in a spec: `@playwright/mcp@latest` -> `@playwright/mcp`. */
function packageName(spec) {
    const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
    return at > 0 ? spec.slice(0, at) : spec;
}

/** Whether a spec pins one exact version, which nothing upstream can move. */
function isExactVersion(spec) {
    const name = packageName(spec);
    return /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(spec.slice(name.length + 1));
}

/** Where npm keeps its cache, from the environment or the platform's default. */
function npmCacheDir(env, { platform = process.platform, home = os.homedir() } = {}) {
    const configured = envValueOf(env, 'npm_config_cache');
    if (configured) return configured;
    if (platform === 'win32') {
        const local = envValueOf(env, 'LOCALAPPDATA');
        return local ? path.win32.join(local, 'npm-cache') : '';
    }
    return path.posix.join(home, '.npm');
}

/**
 * The bin npx would run for a package, by npx's own rule: the only one, or
 * the one named after the package. Null when there is no telling.
 */
function binOf(manifest, name) {
    const bin = manifest?.bin;
    if (typeof bin === 'string') return bin;
    if (!bin || typeof bin !== 'object') return null;
    const entries = Object.entries(bin);
    if (entries.length === 1) return entries[0][1];
    const unscoped = name.split('/').pop();
    return bin[unscoped] || null;
}

/**
 * The installed copy of a package in npx's cache, under exactly this spec,
 * as `{ installDir, bin }`, or null. npm records the specs each entry was
 * installed for (`_npx.packages`), which is what npx itself matches on; the
 * same spec spelled another way is another entry, and is left to npx.
 */
function findCached(spec, cacheDir, { readdirSync = fs.readdirSync, readFileSync = fs.readFileSync, statSync = fs.statSync } = {}) {
    if (!cacheDir) return null;
    const root = path.join(cacheDir, '_npx');
    let entries;
    try {
        entries = readdirSync(root);
    } catch {
        return null;
    }
    const name = packageName(spec);
    for (const entry of entries) {
        const installDir = path.join(root, entry);
        try {
            const record = JSON.parse(readFileSync(path.join(installDir, 'package.json'), 'utf8'));
            const packages = record?._npx?.packages;
            if (!Array.isArray(packages) || packages.length !== 1 || packages[0] !== spec) continue;
            const packageDir = path.join(installDir, 'node_modules', ...name.split('/'));
            const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
            const relative = binOf(manifest, name);
            if (!relative) return null;
            const bin = path.join(packageDir, relative);
            if (!statSync(bin).isFile() || !isNodeScript(bin, readFileSync)) return null;
            return { installDir, bin };
        } catch {
            // Half installed, or not npm's: next.
        }
    }
    return null;
}

/** Whether a bin is something `node` runs, by its extension or its shebang. */
function isNodeScript(file, readFileSync = fs.readFileSync) {
    if (/\.(c|m)?js$/i.test(file)) return true;
    try {
        const head = readFileSync(file, 'utf8').slice(0, 200).split('\n')[0];
        return /^#!.*\bnode\b/.test(head);
    } catch {
        return false;
    }
}

/**
 * The plan for an `npx` server whose package is cached: run its bin with
 * `node`, with the install's `.bin` ahead on PATH as npx would have it.
 * Null when there is no cached copy or no `node` to run it with.
 */
function npxShortcut(command, args, env, options = {}) {
    const parsed = parseNpx(command, args);
    if (!parsed) return null;
    const cached = findCached(parsed.spec, npmCacheDir(env, options), options);
    if (!cached) return null;
    const node = resolveCommand('node', env, options);
    if (!path.isAbsolute(node)) return null;
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    const delimiter = (options.platform || process.platform) === 'win32' ? ';' : ':';
    const binDir = path.join(cached.installDir, 'node_modules', '.bin');
    return {
        command: node,
        args: [cached.bin, ...parsed.args],
        env: { ...env, [pathKey]: [binDir, env[pathKey]].filter(Boolean).join(delimiter) },
        spec: parsed.spec,
    };
}

/**
 * Ask npm, later and out of the way, whether the spec has moved on, so the
 * next start runs what npx would have. `npm exec` with the same spec uses
 * and updates the same cache entry; `node --version` is something to run
 * that exits at once. At most once a day per spec, across every server.
 */
function scheduleRefresh(spec, env) {
    if (isExactVersion(spec)) return;
    const timer = setTimeout(() => {
        try {
            const stamps = path.join(os.tmpdir(), 'acestes-npx-refresh');
            fs.mkdirSync(stamps, { recursive: true });
            const stamp = path.join(stamps, `${crypto.createHash('sha1').update(spec).digest('hex').slice(0, 16)}.stamp`);
            try {
                if (Date.now() - fs.statSync(stamp).mtimeMs < REFRESH_EVERY) return;
            } catch {
                // Never checked.
            }
            fs.writeFileSync(stamp, spec);

            const npmArgs = ['exec', '--yes', `--package=${spec}`, '--', 'node', '--version'];
            const npm = resolveCommand('npm', env);
            const options = { env, stdio: 'ignore', detached: true, windowsHide: true };
            const child = process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm)
                ? spawn(envValueOf(env, 'ComSpec') || 'cmd.exe', ['/d', '/s', '/c', `"${[npm, ...npmArgs].map(quoteForCmd).join(' ')}"`], {
                    ...options, windowsVerbatimArguments: true,
                })
                : spawn(npm, npmArgs, options);
            child.on('error', () => {});
            child.unref();
        } catch {
            // The cached copy goes on being used; npx's next run catches up.
        }
    }, REFRESH_DELAY);
    timer.unref?.();
}

function main() {
    let spec;
    try {
        spec = JSON.parse(process.argv[2] || '{}');
    } catch {
        console.error('mcp-launch: the launch spec is not valid JSON');
        process.exit(2);
    }

    if (!spec.command) {
        console.error('mcp-launch: no command to run');
        process.exit(2);
    }

    const env = spec.env && typeof spec.env === 'object' ? spec.env : {};
    const args = Array.isArray(spec.args) ? spec.args.map(String) : [];

    let child;
    let shortcut = null;
    try {
        shortcut = npxShortcut(String(spec.command), args, env);
    } catch {
        shortcut = null;
    }

    if (shortcut) {
        child = spawn(shortcut.command, shortcut.args, {
            env: shortcut.env,
            cwd: spec.cwd || undefined,
            stdio: 'inherit',
            windowsHide: true,
        });
        scheduleRefresh(shortcut.spec, env);
    } else if (process.platform === 'win32') {
        const resolved = resolveCommand(String(spec.command), env);
        if (/\.(cmd|bat)$/i.test(resolved)) {
            // cmd.exe reads the line itself: `/d` skips AutoRun, `/s` makes it
            // treat the outer quotes as the whole command. Verbatim arguments,
            // so Node does not quote it a second time.
            const line = [resolved, ...args].map(quoteForCmd).join(' ');
            child = spawn(envValueOf(env, 'ComSpec') || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
                env,
                cwd: spec.cwd || undefined,
                stdio: 'inherit',
                windowsVerbatimArguments: true,
                windowsHide: true,
            });
        } else {
            child = spawn(resolved, args, {
                env,
                cwd: spec.cwd || undefined,
                stdio: 'inherit',
                windowsHide: true,
            });
        }
    } else {
        child = spawn(spec.command, args, {
            env,
            cwd: spec.cwd || undefined,
            stdio: 'inherit',
        });
    }

    child.on('error', (error) => {
        console.error(`mcp-launch: ${error.message}`);
        process.exit(1);
    });

    child.on('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        process.exit(code === null ? 1 : code);
    });

    const stop = () => {
        try { child.kill(); } catch { /* already gone */ }
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('SIGHUP', stop);
    process.on('exit', stop);
}

if (require.main === module) main();

module.exports = {
    parseNpx,
    packageName,
    isExactVersion,
    npmCacheDir,
    binOf,
    findCached,
    npxShortcut,
    resolveCommand,
    quoteForCmd,
};
