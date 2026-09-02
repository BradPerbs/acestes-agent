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
 */
const { spawn } = require('child_process');

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

const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
    env: spec.env && typeof spec.env === 'object' ? spec.env : {},
    cwd: spec.cwd || undefined,
    stdio: 'inherit',
    // A `.cmd` shim, which is what npm leaves on Windows, cannot be spawned
    // without a shell. A path the user typed is taken as a path.
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(spec.command),
    windowsHide: true,
});

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
