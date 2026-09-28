const { shell } = require('electron');
const accounts = require('./accounts');
const limits = require('./limits');

/**
 * What the settings page does to accounts: add them, sign them in, ask
 * how much of their plan is left, and take them away again.
 *
 * The registry (accounts.js) and the figures (limits.js) know nothing about
 * the runtimes; this is where the two meet the providers that can answer for
 * an account. Only Claude Code and Codex can: they are the runtimes with a
 * sign-in that moves by an environment variable and a plan that reports its
 * own limits. Every other runtime still gets its usage tallied, under its
 * one `default` account, by the conversation code.
 */

const RUNNERS = {
    'claude-code': require('./providers/claude-code'),
    codex: require('./providers/codex'),
    cursor: require('./providers/cursor'),
    antigravity: require('./providers/antigravity'),
    muse: require('./providers/muse'),
    qwen: require('./providers/qwen'),
    vibe: require('./providers/vibe'),
    pi: require('./providers/pi'),
};

let notify = () => {};

/** Sign-ins under way, by account key: `{ provider, accountId, url, lines, cancel }`. */
const logins = new Map();
/** Checks under way, by account key, so two clicks share one CLI. */
const checks = new Map();

function setNotifier(fn) {
    notify = fn;
    accounts.setNotifier(fn);
    limits.setNotifier(fn);
}

/** The settings a provider needs to act for one account, and nothing else. */
const settingsFor = (provider, accountId) => ({ accountEnv: accounts.envFor(provider, accountId) });

function findAccount(id) {
    for (const list of Object.values(accounts.snapshot())) {
        const found = list.find(account => account.id === id && !account.builtIn);
        if (found) return found;
    }
    return null;
}

/**
 * What each runtime can do here, so the page offers only what works: a second
 * account, and signing one in from the app rather than from a terminal.
 */
function capabilities() {
    return Object.fromEntries(Object.keys(accounts.snapshot()).map(provider => [provider, {
        multiple: accounts.multiple(provider),
        signIn: typeof RUNNERS[provider]?.login === 'function',
    }]));
}

function overview() {
    return {
        accounts: accounts.snapshot(),
        limits: limits.snapshot(),
        capabilities: capabilities(),
        logins: [...logins.values()].map(({ provider, accountId, url, code, lines }) => ({ provider, accountId, url, code, lines: lines.slice(-4) })),
    };
}

/**
 * Ask one account who it is and where its plan stands.
 *
 * A full answer replaces the windows kept for it, since it is the plan as it
 * is now. A runtime too old to answer the plan question leaves them alone:
 * what the last turn's events said is still the best figure there is.
 */
function check(provider, accountId = accounts.DEFAULT_ID) {
    const runner = RUNNERS[provider];
    if (!runner?.readLimits) return Promise.resolve(overview());
    const key = limits.key(provider, accountId);
    if (checks.has(key)) return checks.get(key);

    const promise = (async () => {
        let answer;
        try {
            answer = await runner.readLimits({ settings: settingsFor(provider, accountId) });
        } catch (error) {
            answer = { identity: null, windows: [], error: error.message };
        }
        if (answer.identity) limits.recordIdentity(provider, accountId, answer.identity);
        if (answer.error) {
            limits.recordError(provider, accountId, answer.error);
        } else {
            limits.recordWindows(provider, accountId, answer.windows || [], {
                replace: !answer.unsupported,
                source: 'probe',
            });
        }
        limits.flush();
        return overview();
    })().finally(() => checks.delete(key));

    checks.set(key, promise);
    return promise;
}

/**
 * Every account of every runtime that can answer, one runtime at a time
 * each so a machine with five accounts does not start five CLIs at once.
 */
async function checkAll() {
    await Promise.all(Object.keys(RUNNERS).map(async (provider) => {
        for (const account of accounts.list(provider)) {
            await check(provider, account.id);
        }
    }));
    return overview();
}

function add(payload) {
    const result = accounts.add(payload || {});
    return { ...overview(), ...result };
}

function rename(id, label) {
    const result = accounts.rename(id, label);
    return { ...overview(), ...result };
}

/**
 * Take an account away.
 *
 * One this app made is signed out first, so the runtime clears what it keeps
 * outside the folder (on macOS the login is in the Keychain, not the folder),
 * and then its folder goes. One the user pointed at is only forgotten: that
 * login is theirs, and presumably in use from a terminal somewhere.
 */
async function remove(id) {
    const account = findAccount(id);
    if (!account) return { ...overview(), error: 'No such account.' };

    const key = limits.key(account.provider, id);
    logins.get(key)?.cancel();

    if (account.managed) {
        try {
            await RUNNERS[account.provider]?.logout?.({ settings: settingsFor(account.provider, id) });
        } catch {
            // Best effort: the folder is removed either way.
        }
    }
    const result = accounts.remove(id);
    limits.forget(account.provider, id);
    return { ...overview(), ...result };
}

/**
 * Start signing one account in. Progress goes out as `ai-account-login`
 * events; when it finishes the account is checked, so the page shows who it
 * is and what is left without a second click.
 */
function startLogin(provider, accountId = accounts.DEFAULT_ID) {
    const runner = RUNNERS[provider];
    if (!runner?.login) return { started: false, error: 'That agent signs in on its own.' };
    const key = limits.key(provider, accountId);
    if (logins.has(key)) return { started: false, already: true };

    const entry = { provider, accountId, url: '', code: '', lines: [], cancel: () => {} };
    logins.set(key, entry);

    const handle = runner.login({
        settings: settingsFor(provider, accountId),
        onProgress: ({ line, url, code }) => {
            if (line) entry.lines = [...entry.lines, line].slice(-20);
            // A device-code sign-in (Muse) shows a code to type on the page.
            if (code && !entry.code) entry.code = code;
            if (url && !entry.url) {
                entry.url = url;
                // Codex hands the address back for the caller to open; Claude
                // Code opens the browser itself and only prints it.
                if (['codex', 'muse'].includes(provider) && /^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
            }
            notify('ai-account-login', { provider, accountId, phase: 'waiting', url: entry.url, code: entry.code, line: line || '' });
        },
    });
    entry.cancel = handle.cancel;

    handle.done.then(async (verdict) => {
        logins.delete(key);
        notify('ai-account-login', {
            provider,
            accountId,
            phase: verdict.ok ? 'done' : 'failed',
            message: verdict.message || '',
        });
        await check(provider, accountId);
    });

    notify('ai-account-login', { provider, accountId, phase: 'started', url: '', line: '' });
    return { started: true };
}

function cancelLogin(provider, accountId = accounts.DEFAULT_ID) {
    logins.get(limits.key(provider, accountId))?.cancel();
    return { cancelled: true };
}

/** Stop every sign-in still waiting on a browser, for a quit. */
function shutdown() {
    for (const entry of logins.values()) entry.cancel();
    limits.flush();
}

module.exports = {
    setNotifier,
    overview,
    check,
    checkAll,
    add,
    rename,
    remove,
    startLogin,
    cancelLogin,
    shutdown,
    discover: accounts.discover,
    RUNNERS,
};
