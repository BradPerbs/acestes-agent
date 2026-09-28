const os = require('os');
const path = require('path');
const acp = require('./acp');

/**
 * The Mistral Vibe provider.
 *
 * Mistral Vibe is Mistral's terminal agent, and it ships `vibe-acp` beside
 * `vibe`: the Agent Client Protocol on stdio, which `acp.js` drives. What is
 * particular to it is said here:
 *
 *   - it takes HTTP MCP servers although its handshake does not claim to, so
 *     our tools go over HTTP rather than through the stdio bridge
 *   - its models and its thinking level are session config options, not a
 *     model list, which the engine reads by their ids
 *   - its usage and cost are running totals for the session, so each turn's
 *     share is the difference
 *   - it signs in over ACP itself (`browser-auth`), which is what the accounts
 *     card's Sign in runs, and reports its sign-in state without a network
 *     call through `_auth/status`
 *
 * Its API key lives in one keyring entry per machine, whatever VIBE_HOME says,
 * so a second account cannot safely sit beside the first. It is one login.
 */

const LABEL = 'Mistral Vibe';

function findVibe({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    const extra = acp.commonRoots({ env, home, platform });
    return acp.findBinary(['vibe-acp'], { extra, env, platform });
}

const provider = acp.createAcpProvider({
    id: 'vibe',
    label: LABEL,
    find: () => findVibe(),
    args: () => [],
    notInstalled: 'Mistral Vibe is not installed on this machine. Install it with "uv tool install mistral-vibe", then try again.',
    signInHint: 'Run "vibe --setup" in a terminal, or sign in from the accounts card, then try again.',
    authMethods: ['browser-auth'],
    mcpHttp: true,
    cumulativeUsage: true,
    supportsImages: true,
    // Its agents double as permission modes. "Never ask" is `auto-approve`;
    // otherwise its default stands.
    modeFor: (settings) => (settings.approval === 'never' ? 'auto-approve' : ''),
});

/** `_auth/status`, which answers from the machine without a network call. */
async function authStatus(settings) {
    return provider.withAgent(settings, rpc => rpc.request('_auth/status', {}, { timeout: 20000 }));
}

async function detect(options = {}) {
    if (!findVibe()) return { ok: false, reason: 'notFound' };
    try {
        const status = await authStatus(options.settings);
        return status?.authenticated === false ? { ok: false, reason: 'notSignedIn' } : { ok: true, reason: '' };
    } catch {
        // An older build without the extension: being installed is the answer.
        return { ok: true, reason: '' };
    }
}

/**
 * Who the account is. The plan comes from `_account/read`, which wants a
 * session, so one is opened and dropped; opening one sends nothing to a model.
 * Vibe reports no plan windows: its budget is monthly and read on Mistral's
 * console.
 */
async function readLimits({ settings = {} } = {}) {
    if (!findVibe()) return { identity: null, windows: [], error: 'Mistral Vibe is not installed on this machine.' };
    try {
        return await provider.withAgent(settings, async (rpc) => {
            const status = await rpc.request('_auth/status', {}, { timeout: 20000 }).catch(() => null);
            if (status && status.authenticated === false) {
                return { identity: { signedIn: false, email: '', plan: '', organization: '', method: '' }, windows: [] };
            }
            let account = null;
            try {
                const session = await rpc.request('session/new', { cwd: os.tmpdir(), mcpServers: [] }, { timeout: 30000 });
                account = await rpc.request('_account/read', { sessionId: session.sessionId }, { timeout: 20000 });
            } catch {
                // The plan stays unknown; being signed in is still known.
            }
            return {
                identity: {
                    signedIn: true,
                    email: String(account?.email || ''),
                    plan: String(account?.plan_name || account?.planName || account?.plan_type || ''),
                    organization: String(account?.organization_kind || ''),
                    method: String(status?.authState || ''),
                },
                windows: [],
            };
        });
    } catch (error) {
        return { identity: null, windows: [], error: error.message };
    }
}

/** Sign in through the browser: Vibe opens it itself and answers when it is done. */
function login({ settings = {} } = {}) {
    let cancel = () => {};
    const done = new Promise((resolve) => {
        let settled = false;
        let child = null;
        cancel = () => {
            if (settled) return;
            settled = true;
            acp.stopProcess(child);
            resolve({ ok: false, message: 'Cancelled.' });
        };
        provider.withAgent(settings, rpc => rpc.request('authenticate', { methodId: 'browser-auth' }), {
            timeout: 10 * 60 * 1000,
            onSpawn: (spawned) => { child = spawned; },
        })
            .then(() => { if (!settled) { settled = true; resolve({ ok: true, message: '' }); } })
            .catch((error) => { if (!settled) { settled = true; resolve({ ok: false, message: error.message }); } });
    });
    return { done, cancel: () => cancel() };
}

async function logout({ settings = {} } = {}) {
    try {
        await provider.withAgent(settings, rpc => rpc.request('_auth/signOut', {}, { timeout: 20000 }));
        return { ok: true };
    } catch {
        return { ok: false };
    }
}

module.exports = {
    ...provider,
    detect,
    readLimits,
    login,
    logout,
    findVibe,
};
