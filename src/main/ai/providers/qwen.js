const fs = require('fs');
const os = require('os');
const path = require('path');
const acp = require('./acp');

/**
 * The Qwen Code provider.
 *
 * Qwen Code is Alibaba's terminal agent (`qwen`), and `qwen --acp` speaks the
 * Agent Client Protocol, so this is only a description of how to find and
 * start it; `acp.js` does the rest. It takes MCP servers over HTTP, reports
 * its models and a `reasoning_effort` option on the session, and reports
 * token usage per model round on its message chunks.
 *
 * It signs in with a provider key chosen through `/auth` in its own TUI (the
 * free OAuth tier was discontinued in April 2026), so there is no sign-in
 * here: an install with no provider chosen is refused when it is switched on,
 * with the command that fixes it. Its home moves with QWEN_HOME, which is
 * what lets a second account sit beside the first.
 */

const LABEL = 'Qwen Code';

const homeOf = (settings = {}) => settings.accountEnv?.QWEN_HOME || process.env.QWEN_HOME || path.join(os.homedir(), '.qwen');

function findQwen({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const extra = [];
    if (platform === 'win32') {
        const local = env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local');
        extra.push(paths.join(local, 'qwen-code', 'bin'));
    }
    extra.push(...acp.commonRoots({ env, home, platform }));
    return acp.findBinary(['qwen'], { extra, env, platform });
}

/** The user's settings, tolerating the comments a hand-edited file picks up. */
function readSettings(home) {
    try {
        const text = fs.readFileSync(path.join(home, 'settings.json'), 'utf8');
        return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
    } catch {
        return null;
    }
}

/** Who this install signs in as, read from its settings: no process, no tokens. */
function identity(settings = {}) {
    const stored = readSettings(homeOf(settings));
    const type = stored?.security?.auth?.selectedType || '';
    return {
        signedIn: Boolean(type),
        email: '',
        plan: type ? String(type).replace(/[-_]/g, ' ') : '',
        organization: String(stored?.model?.name || ''),
        method: type,
    };
}

const provider = acp.createAcpProvider({
    id: 'qwen',
    label: LABEL,
    find: () => findQwen(),
    args: () => ['--acp'],
    notInstalled: 'Qwen Code is not installed on this machine. Install it with "npm install -g @qwen-code/qwen-code", then try again.',
    signInHint: 'Run "qwen" in a terminal and choose a provider with /auth, then try again.',
    authMethods: ['openai'],
    supportsImages: true,
    // "Never ask" is its yolo mode; everything else keeps its default, which
    // asks before it edits or runs anything.
    modeFor: (settings) => (settings.approval === 'never' ? 'yolo' : 'default'),
    detect: (options) => (identity(options?.settings).signedIn ? { ok: true, reason: '' } : { ok: false, reason: 'notSignedIn' }),
});

/** No plan windows: Qwen Code reports none. The identity is still worth showing. */
async function readLimits({ settings = {} } = {}) {
    if (!findQwen()) return { identity: null, windows: [], error: 'Qwen Code is not installed on this machine.' };
    return { identity: identity(settings), windows: [] };
}

module.exports = {
    ...provider,
    readLimits,
    findQwen,
    _test: { identity, readSettings },
};
