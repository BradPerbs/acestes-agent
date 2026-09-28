const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Sign-ins, for the runtimes that can hold more than one on a machine.
 *
 * Claude Code and Codex each keep their login in one directory, and each
 * reads an environment variable that moves it: CLAUDE_CONFIG_DIR and
 * CODEX_HOME. That is the whole mechanism behind two Claude accounts on one
 * PC. Every account here is a directory, and the runtime is started with the
 * variable pointed at it. The login itself stays the runtime's business; this
 * never reads a token.
 *
 * `default` is always there and is never stored: it is whatever login the
 * machine already has, reached by leaving the variable alone. So a machine
 * that never adds an account runs exactly as it did before this existed.
 *
 * Kept under userData rather than in the store, like the agents: a directory
 * path belongs to the machine it is on, and the store is what syncs.
 */

const VERSION = 1;
const MAX_ACCOUNTS = 20;
const MAX_LABEL = 60;

/**
 * What each runtime needs to be moved to another login: the variable, the
 * directory it uses when the variable is not set, and a file whose presence
 * says a directory really is one of its homes rather than a folder that
 * happens to be named like one.
 */
const RUNTIMES = {
    'claude-code': { env: 'CLAUDE_CONFIG_DIR', folder: '.claude', markers: ['.claude.json', '.credentials.json', 'settings.json'] },
    codex: { env: 'CODEX_HOME', folder: '.codex', markers: ['auth.json', 'config.toml'] },
    qwen: { env: 'QWEN_HOME', folder: '.qwen', markers: ['settings.json', 'oauth_creds.json'] },
    /**
     * Cursor's config follows CURSOR_CONFIG_DIR but its login does not: it is
     * in %APPDATA% on Windows, XDG_CONFIG_HOME on Linux, and the Keychain on
     * macOS unless told to use a file under the home directory. An account
     * moves all of it, and keeps the login in a file.
     */
    cursor: {
        folder: null,
        markers: [],
        vars: (home) => ({
            CURSOR_CONFIG_DIR: path.join(home, 'config'),
            CURSOR_DATA_DIR: path.join(home, 'data'),
            AGENT_CLI_CREDENTIAL_STORE: 'file',
            ...(process.platform === 'win32' ? { APPDATA: path.join(home, 'appdata') }
                : process.platform === 'darwin' ? { HOME: home }
                    : { XDG_CONFIG_HOME: path.join(home, 'xdg') }),
        }),
    },
    pi: { env: 'PI_CODING_AGENT_DIR', folder: path.join('.pi', 'agent'), markers: ['auth.json', 'settings.json'] },
    /**
     * Muse keeps its settings and login under XDG_CONFIG_HOME and its
     * sessions under XDG_DATA_HOME, so an account moves both. Its login is
     * put in a file rather than the system keychain, whose one slot every
     * account on the machine would otherwise share.
     */
    muse: {
        folder: null,
        markers: [path.join('config', 'muse', 'auth.json')],
        vars: (home) => ({
            XDG_CONFIG_HOME: path.join(home, 'config'),
            XDG_DATA_HOME: path.join(home, 'data'),
            MUSE_AUTH_PATH: path.join(home, 'config', 'muse', 'auth.json'),
            TBH_CREDENTIAL_BACKEND: 'file',
        }),
    },
    /**
     * One login per machine: Antigravity's lives in the OS keyring and
     * Vibe's API key in one keyring entry whatever its home says. Listed so
     * their sign-in and limits have a row, with nothing to add beside it.
     */
    antigravity: { single: true },
    vibe: { single: true },
};

const DEFAULT_ID = 'default';

const filePath = () => path.join(app.getPath('userData'), 'ai-accounts.json');
/** Where the accounts this app made for itself keep their login. */
const managedRoot = () => path.join(app.getPath('userData'), 'ai-accounts');

let state = null;
let notify = () => {};

function setNotifier(fn) {
    notify = fn;
}

const clean = (value, max = MAX_LABEL) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

let counter = 0;
function nextId() {
    counter += 1;
    return `acct-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Two spellings of one folder compare equal, case and all on Windows. */
function samePath(left, right) {
    if (!left || !right) return false;
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Whether `child` is `parent` or somewhere inside it. */
function inside(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function supports(provider) {
    return Boolean(RUNTIMES[provider]);
}

/** Whether a runtime can hold a second account at all. */
function multiple(provider) {
    return Boolean(RUNTIMES[provider]) && !RUNTIMES[provider].single;
}

/** The folder the runtime uses when nothing moves it, where it has one. */
function defaultHome(provider, { env = process.env, home = os.homedir() } = {}) {
    const runtime = RUNTIMES[provider];
    if (!runtime?.env) return '';
    return env[runtime.env] || (runtime.folder ? path.join(home, runtime.folder) : '');
}

function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = clean(raw.id, 80);
    if (!id || id === DEFAULT_ID || !multiple(raw.provider)) return null;
    const home = String(raw.home || '').trim();
    if (!home || !path.isAbsolute(home)) return null;
    return {
        id,
        provider: raw.provider,
        label: clean(raw.label) || 'Account',
        home,
        // Made by this app under its own folder, and so its to delete. A
        // folder the user pointed at is theirs, and removing the account only
        // forgets it.
        managed: Boolean(raw.managed),
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    };
}

function load() {
    if (state) return state;
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    } catch {
        // Missing or unreadable: no accounts beyond the machine's own.
    }
    const accounts = (Array.isArray(parsed?.accounts) ? parsed.accounts : [])
        .map(normalize)
        .filter(Boolean)
        .slice(0, MAX_ACCOUNTS);
    state = { version: VERSION, accounts };
    return state;
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(filePath()), { recursive: true });
        fs.writeFileSync(filePath(), JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('Could not save the accounts:', error.message);
    }
}

function builtIn(provider) {
    return { id: DEFAULT_ID, provider, label: '', home: '', managed: false, builtIn: true, createdAt: 0 };
}

/** Every account for one runtime, the machine's own first. */
function list(provider) {
    if (!supports(provider)) return [];
    return [builtIn(provider), ...load().accounts.filter(account => account.provider === provider)];
}

/** One account, or the machine's own for `default` and for an id that is gone. */
function resolve(provider, id) {
    if (!supports(provider)) return null;
    if (!id || id === DEFAULT_ID) return builtIn(provider);
    return load().accounts.find(account => account.provider === provider && account.id === id) || builtIn(provider);
}

/**
 * The variables that point the runtime at one account. Empty for the
 * machine's own, so its environment is exactly what it would have been.
 */
function envFor(provider, id) {
    const account = resolve(provider, id);
    if (!account || account.builtIn) return {};
    const runtime = RUNTIMES[provider];
    if (runtime.vars) return runtime.vars(account.home);
    return runtime.env ? { [runtime.env]: account.home } : {};
}

function snapshot() {
    return Object.fromEntries(Object.keys(RUNTIMES).map(provider => [provider, list(provider)]));
}

/**
 * Add an account.
 *
 * With no `home`, a fresh folder is made for it under this app's own, which
 * is the usual case: the next step is signing in, and the login lands there.
 * With one, it is a folder the user already signs in from (a `~/.claude-work`
 * behind a shell alias is the common shape) and it is taken as it is.
 */
function add({ provider, label, home } = {}) {
    if (!multiple(provider)) return { error: 'That agent cannot hold more than one account.' };
    const current = load();
    if (current.accounts.length >= MAX_ACCOUNTS) return { error: `At most ${MAX_ACCOUNTS} accounts.` };

    const id = nextId();
    // `~/.claude-work` is how people write these, and how the form suggests
    // one; nothing on this side of a shell would expand it.
    let wanted = String(home || '').trim();
    if (wanted === '~' || /^~[\\/]/.test(wanted)) wanted = path.join(os.homedir(), wanted.slice(1));
    let folder = '';
    let managed = false;

    if (wanted) {
        if (!path.isAbsolute(wanted)) return { error: 'Give the full path to the folder.' };
        let stat = null;
        try {
            stat = fs.statSync(wanted);
        } catch {
            return { error: 'That folder does not exist.' };
        }
        if (!stat.isDirectory()) return { error: 'That is a file, not a folder.' };
        if (samePath(wanted, defaultHome(provider))) {
            return { error: 'That folder is this computer\'s own login, which is already listed.' };
        }
        if (current.accounts.some(account => account.provider === provider && samePath(account.home, wanted))) {
            return { error: 'That folder is already an account here.' };
        }
        folder = path.resolve(wanted);
    } else {
        folder = path.join(managedRoot(), id);
        try {
            fs.mkdirSync(folder, { recursive: true });
        } catch (error) {
            return { error: `Could not make a folder for the account: ${error.message}` };
        }
        managed = true;
    }

    const account = normalize({
        id,
        provider,
        label: clean(label) || `Account ${list(provider).length}`,
        home: folder,
        managed,
        createdAt: Date.now(),
    });
    current.accounts.push(account);
    persist();
    notify('ai-accounts-changed', snapshot());
    return { account };
}

function rename(id, label) {
    const account = load().accounts.find(entry => entry.id === id);
    if (!account) return { error: 'No such account.' };
    account.label = clean(label) || account.label;
    persist();
    notify('ai-accounts-changed', snapshot());
    return { account };
}

/**
 * Forget an account, and delete its folder if this app made it.
 *
 * The folder is only ever removed when it is marked managed *and* sits under
 * this app's own account folder, checked again here rather than trusted from
 * the file: a hand-edited record should not be able to point a delete at a
 * folder somebody else owns.
 */
function remove(id) {
    const current = load();
    const index = current.accounts.findIndex(entry => entry.id === id);
    if (index < 0) return { error: 'No such account.' };
    const [account] = current.accounts.splice(index, 1);
    persist();

    if (account.managed && inside(managedRoot(), account.home) && !samePath(managedRoot(), account.home)) {
        try {
            // Retried, because on Windows a runtime that was just signed out
            // can still be holding the folder for a moment after it exits.
            fs.rmSync(account.home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
        } catch (error) {
            console.error('Could not delete the account folder:', error.message);
        }
    }
    notify('ai-accounts-changed', snapshot());
    return { account };
}

/**
 * Folders in the home directory that look like another login for this
 * runtime, and are not already here: `~/.claude-work`, `~/.codex-personal`.
 *
 * Only a suggestion for the add form. It reads directory names and checks for
 * a marker file, and nothing inside is opened.
 */
function discover(provider, { home = os.homedir(), readdirSync = fs.readdirSync, existsSync = fs.existsSync } = {}) {
    const runtime = RUNTIMES[provider];
    // Only runtimes whose home is one named folder can be found by its name.
    if (!runtime?.folder || runtime.single || runtime.folder.includes(path.sep)) return [];
    const pattern = new RegExp(`^${runtime.folder.replace('.', '\\.')}[-_.].+`, 'i');
    let entries = [];
    try {
        entries = readdirSync(home, { withFileTypes: true });
    } catch {
        return [];
    }
    const known = list(provider).map(account => account.home).filter(Boolean);
    return entries
        .filter(entry => entry.isDirectory() && pattern.test(entry.name))
        .map(entry => path.join(home, entry.name))
        .filter(folder => runtime.markers.some(marker => existsSync(path.join(folder, marker))))
        .filter(folder => !known.some(other => samePath(other, folder)) && !samePath(folder, defaultHome(provider)))
        .slice(0, 10);
}

module.exports = {
    setNotifier,
    supports,
    multiple,
    list,
    resolve,
    envFor,
    snapshot,
    add,
    rename,
    remove,
    discover,
    defaultHome,
    RUNTIMES,
    DEFAULT_ID,
    _test: { samePath, inside, reset: () => { state = null; } },
};
