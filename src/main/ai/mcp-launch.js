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
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

/** A value of the environment by name, whichever case it was given in. */
function envValue(name) {
    const key = Object.keys(env).find(entry => entry.toLowerCase() === name.toLowerCase());
    return key ? String(env[key]) : '';
}

/**
 * On Windows, the file a bare command name stands for, found the way the
 * shell finds it: each PATH directory, each PATHEXT extension, in order.
 * A name with a directory or an extension in it is taken as given.
 */
function resolveOnWindows(command) {
    if (/[\\/]/.test(command) || path.extname(command)) return command;
    const dirs = envValue('PATH').split(';').filter(Boolean);
    const exts = (envValue('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir, command + ext);
            try {
                if (fs.statSync(candidate).isFile()) return candidate;
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

let child;
if (process.platform === 'win32') {
    const resolved = resolveOnWindows(String(spec.command));
    if (/\.(cmd|bat)$/i.test(resolved)) {
        // cmd.exe reads the line itself: `/d` skips AutoRun, `/s` makes it
        // treat the outer quotes as the whole command. Verbatim arguments,
        // so Node does not quote it a second time.
        const line = [resolved, ...args].map(quoteForCmd).join(' ');
        child = spawn(envValue('ComSpec') || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
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
