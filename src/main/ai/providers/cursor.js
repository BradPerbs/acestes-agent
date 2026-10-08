const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');
const acp = require('./acp');

/**
 * The Cursor provider.
 *
 * Cursor's terminal agent speaks the Agent Client Protocol through a hidden
 * `acp` command, so `acp.js` drives it: sessions with Cursor's own models and
 * modes, our tools over HTTP MCP, its tools asked about through the approval
 * card, sessions resumed with `session/load`.
 *
 * Found as `cursor-agent`, never as `agent`: that shorter name is also Grok
 * Build's, and on a machine with both the wrong one answers. On Windows there
 * is no executable at all, only a `.cmd` that starts PowerShell that starts
 * the bundled node, so the bundled node is run directly from the newest
 * version folder, which is what the launcher itself would pick.
 *
 * What it does not give over ACP is usage: no tokens on the prompt result and
 * no usage updates. Its turns are counted on the limits page; its plan's
 * meters are only in its own interactive `/usage`.
 *
 * Its login does not follow CURSOR_CONFIG_DIR. A second account moves the
 * places the credentials do live, per platform: see accounts.js.
 */

const LABEL = 'Cursor';

/** Version folders sort by their date prefix, newest last. */
function newestVersion(root, readdirSync = fs.readdirSync) {
    try {
        return readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort()
            .pop() || '';
    } catch {
        return '';
    }
}

/** How to start `cursor-agent <args>` on this machine, or null. */
function launcher(args, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        const versions = path.join(local, 'cursor-agent', 'versions');
        const latest = newestVersion(versions);
        if (latest) {
            const node = path.join(versions, latest, 'node.exe');
            const entry = path.join(versions, latest, 'index.js');
            if (fs.existsSync(node) && fs.existsSync(entry)) return { command: node, args: [entry, ...args] };
        }
    }
    const binary = acp.findBinary(['cursor-agent'], { extra: acp.commonRoots({ env, home, platform }), env, platform });
    return binary ? { command: binary, args } : null;
}

const find = () => launcher([])?.command || '';

/** Run one `cursor-agent` subcommand with JSON output, or null. */
function runJson(args, settings = {}, timeout = 20000) {
    const command = launcher(args);
    if (!command) return Promise.resolve(null);
    return new Promise((resolve) => {
        let stdout = '';
        let child;
        try {
            child = spawn(command.command, command.args, {
                env: { ...process.env, ...(settings.accountEnv || {}) },
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
        } catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => { acp.stopProcess(child); resolve(null); }, timeout);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', () => {
            clearTimeout(timer);
            try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
        });
    });
}

const provider = acp.createAcpProvider({
    id: 'cursor',
    label: LABEL,
    find,
    command: () => launcher(['acp']),
    notInstalled: 'Cursor CLI is not installed on this machine. Install it from cursor.com/cli, then try again.',
    signInHint: 'Run "cursor-agent login" in a terminal, or sign in from the accounts card, then try again.',
    authMethods: ['cursor_login'],
    supportsImages: true,
});

/** `cursor-agent status`, which reads the stored login and spends no tokens. */
async function status(settings) {
    return runJson(['status', '--format', 'json'], settings);
}

async function detect(options = {}) {
    if (!find()) return { ok: false, reason: 'notFound' };
    const answer = await status(options.settings);
    if (answer && answer.isAuthenticated === false) return { ok: false, reason: 'notSignedIn' };
    return { ok: true, reason: '' };
}

/**
 * Who the account is, from `status` and `about`. Cursor keeps its plan's
 * meters to its own interactive `/usage`, so there are no windows here.
 */
async function readLimits({ settings = {} } = {}) {
    if (!find()) return { identity: null, windows: [], error: 'Cursor CLI is not installed on this machine.' };
    const [answer, about] = await Promise.all([status(settings), runJson(['about', '--format', 'json'], settings)]);
    if (!answer) return { identity: null, windows: [], error: 'Cursor did not answer "status".' };
    return {
        identity: {
            signedIn: Boolean(answer.isAuthenticated),
            email: answer.userInfo?.email || about?.userEmail || '',
            plan: about?.subscriptionTier || '',
            organization: answer.userInfo?.teamName || '',
            method: answer.status || '',
        },
        windows: [],
    };
}

/** `cursor-agent login`: it opens the browser and waits for it to come back. */
function login({ settings = {}, onProgress = () => {} } = {}) {
    const command = launcher(['login']);
    if (!command) return { done: Promise.resolve({ ok: false, message: 'Cursor CLI is not installed on this machine.' }), cancel() {} };
    let child = null;
    let cancelled = false;
    let sawUrl = false;
    let tail = '';
    const done = new Promise((resolve) => {
        child = spawn(command.command, command.args, {
            env: { ...process.env, ...(settings.accountEnv || {}) },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const timer = setTimeout(() => acp.stopProcess(child), 10 * 60 * 1000);
        timer.unref?.();
        const read = (chunk) => {
            const text = chunk.toString('utf8');
            tail = (tail + text).slice(-2000);
            const url = /https:\/\/\S+/.exec(text)?.[0];
            if (url && !sawUrl) { sawUrl = true; onProgress({ url }); }
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, message: error.message }); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (cancelled) resolve({ ok: false, message: 'Cancelled.' });
            else if (code === 0) resolve({ ok: true, message: '' });
            else resolve({ ok: false, message: tail.trim().split(/\r?\n/).pop() || `The sign-in stopped (exit ${code}).` });
        });
    });
    return { done, cancel() { cancelled = true; acp.stopProcess(child); } };
}

async function logout({ settings = {} } = {}) {
    const answer = await runJson(['logout'], settings);
    return { ok: answer !== undefined };
}

module.exports = {
    ...provider,
    detect,
    readLimits,
    login,
    logout,
    findCursor: find,
    // How to start `cursor-agent <args>`: on Windows a node.exe and the
    // script it runs, so a caller asking for `--version` needs both.
    cursorLauncher: launcher,
    _test: { launcher, newestVersion },
};
