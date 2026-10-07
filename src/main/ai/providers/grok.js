const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const spawn = require('cross-spawn');
const { app } = require('electron');

const mcpHost = require('../mcp-host');
const mcpConfig = require('../mcp-config');
const sandboxLib = require('../sandbox');
const engine = require('./openai-compatible');
// Pictures staged for the turn, as files the CLI is pointed at. Shared with
// the Codex provider, whose headless run takes them the same way.
const { stageImages } = require('./codex');

/**
 * The Grok provider.
 *
 * Two ways in, in this order.
 *
 * Grok Build is xAI's terminal agent, installed by the user and signed in to
 * their own account. When it is on the machine this drives it the way the Codex
 * provider drives Codex: one headless run per turn, `--output-format
 * streaming-json` on stdout, our own tools served over loopback by `mcp-host`
 * and reached by URL. The agent brings its own harness with it, which is the
 * point of driving an agent rather than a model.
 *
 * What it can run is read out of that same install: `~/.grok` holds the model
 * cache the CLI writes when it signs in, and the model it is set to. That is
 * the only honest source, and for a while it was not the one used: the list
 * came from api.x.ai, asked for with a key stored in this app, so a machine
 * with the CLI installed and no key had a working agent and an empty model
 * menu. Nothing in that directory is ever written to.
 *
 * When the CLI is not installed, an xAI API key is enough. `openai-compatible.js`
 * runs the loop instead and talks to api.x.ai, which speaks the same shape as
 * every other server that file was written for. It is the lesser of the two,
 * because the loop is ours rather than xAI's, and it is no longer a way to
 * switch this agent on: nothing stores a key any more, and the tick asks for
 * the CLI. It stays for whoever already had one.
 *
 * Which of the two is in use is announced as an `account` event, so the panel
 * can say so rather than leaving the user to infer it from the shape of the
 * answers.
 */

/** The name our tools are served under. As elsewhere: what they do, not whose. */
const SERVER_NAME = 'remote';

/**
 * What "no ceiling" (a step limit of 0 in Settings) is passed as: the CLI
 * wants a number, so one no turn reaches, and small enough for whatever
 * integer type it parses into.
 */
const UNLIMITED_TURNS = 10000;

const API_URL = 'https://api.x.ai/v1';

/**
 * Where the CLI reads the subscription allowance (`/usage` in its own window).
 *
 * `settings_cache.json` names the same host, with `/v1` on the end. A cache
 * that names anything else is ignored: the login token is not sent elsewhere.
 */
const BILLING_ORIGIN = 'https://cli-chat-proxy.grok.com';

const LABEL = 'xAI';

/** How long one headless run may take before it is given up on. */
/**
 * How long a turn may go without a word from the CLI before it is given up
 * on. Measured from the last line on stdout rather than from the start: a
 * turn that is working is one that keeps talking, and one that reads and
 * writes for forty minutes is a turn, not a hang. The run's own budget is
 * the ceiling on the whole.
 */
const IDLE_TIMEOUT = 30 * 60 * 1000;

/**
 * Grok Build's own tools, which act on this machine rather than on a server.
 *
 * Denied unless the app's local-tools switch is on, by the same reasoning the
 * Claude provider gives: this panel manages remote hosts, and a shell on the
 * user's own computer is a far larger surface than that needs.
 *
 * The names are the ones the CLI's own permission rules use (`Read`, `Grep`,
 * `Bash(git *)`), which are shared with the rest of this generation of agents.
 * If a release renames them the denylist stops matching, so it is not the only
 * thing standing between a model and this machine: the run happens in an empty
 * directory of ours, and everything that reaches a server goes through the
 * approval gate in `mcp-host` regardless of what the agent thinks it may do.
 */
const LOCAL_TOOLS = [
    'Bash', 'BashOutput', 'KillShell',
    'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    'Glob', 'Grep',
    'Task', 'TodoWrite',
];
// `WebFetch` and `WebSearch` are deliberately not in that list. Reading a page
// is not touching this machine, and an assistant that cannot look anything up
// reads to the user as one with no internet.

/**
 * The levels Grok Build names, low to high.
 *
 * Its scale runs `none, minimal, low, medium, high, xhigh, max`, and the app's
 * runs `low` to `ultra`. The overlap is what can be passed through; `ultra` is
 * Codex's own top stop and is sent as `max`, which is what rounding down to the
 * nearest level this agent has means.
 */
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function envValue(env, ...names) {
    for (const name of names) {
        if (env?.[name]) return env[name];
    }
    return '';
}

/**
 * Every folder a Grok Build install can leave its binary in.
 *
 * PATH first, because somebody who arranged their own PATH has already said
 * which copy they mean. Then the installer's locations, which is what a
 * packaged app actually needs: Electron inherits the PATH of whatever launched
 * it, and a desktop shortcut has a far shorter one than a shell does.
 */
function grokRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const roots = String(envValue(env, 'PATH', 'Path', 'path'))
        .split(windows ? ';' : ':')
        .filter(Boolean);

    // What the install script writes, on every platform it runs on.
    roots.push(paths.join(home, '.grok', 'bin'));

    if (windows) {
        const appData = envValue(env, 'APPDATA', 'AppData');
        const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData');
        const chocolatey = envValue(env, 'ChocolateyInstall', 'CHOCOLATEYINSTALL');
        const scoop = envValue(env, 'SCOOP', 'Scoop') || paths.join(home, 'scoop');

        roots.push(
            localAppData && paths.join(localAppData, 'Programs', 'grok'),
            localAppData && paths.join(localAppData, 'grok', 'bin'),
            appData && paths.join(appData, 'npm'),
            paths.join(scoop, 'shims'),
            chocolatey && paths.join(chocolatey, 'bin')
        );
    } else {
        roots.push(
            paths.join(home, '.local', 'bin'),
            paths.join(home, 'bin'),
            paths.join(home, '.bun', 'bin'),
            paths.join(home, '.npm-global', 'bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin'
        );
    }

    return [...new Set(roots.filter(Boolean))];
}

/**
 * The `grok` on this machine, or '' if there is none.
 *
 * Shims are accepted here where the Codex provider refuses them, because this
 * spawns through `cross-spawn`, which starts a `.cmd` the way a shell would.
 * The npm package installs one, so refusing it would mean telling a user with
 * a working `grok` that they have not got one.
 */
function findGrok(options = {}) {
    const platform = options.platform || process.platform;
    const accessSync = options.accessSync || fs.accessSync;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const names = platform === 'win32'
        ? ['grok.exe', 'grok.cmd', 'grok.bat']
        : ['grok'];

    for (const root of grokRoots({
        platform,
        env: options.env || process.env,
        home: options.home || os.homedir(),
    })) {
        for (const name of names) {
            const candidate = paths.join(root, name);
            try {
                accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
                return candidate;
            } catch {
                // Keep looking.
            }
        }
    }
    return '';
}

/**
 * Where Grok Build keeps its own setup: its login, its config, its model cache.
 *
 * `~/.grok` is the CLI's default, and `GROK_HOME` wins if one is set, because
 * that is the answer the CLI itself would give. What is in there belongs to
 * the CLI. This app reads it, trusts the folder it runs in (see
 * `trustWorkspace`), and, while a session is open, merges its own
 * `[mcp_servers.*]` tables into `config.toml` and takes them out again.
 */
function grokHome({ env = process.env, home = os.homedir() } = {}) {
    return envValue(env, 'GROK_HOME') || path.join(home, '.grok');
}

/** Whether the CLI has a login in that home to run on. */
function signedIn({ source = grokHome(), existsSync = fs.existsSync } = {}) {
    return existsSync(path.join(source, 'auth.json'));
}

/** The login entry the CLI stored, or nothing when the file is not one. */
function authEntry(source = grokHome()) {
    const auth = readJson(path.join(source, 'auth.json'));
    if (!auth || typeof auth !== 'object') return null;
    return Object.values(auth).find(entry => entry && typeof entry === 'object' && entry.key) || null;
}

/**
 * The subscription allowance, as the limits page's windows.
 *
 * The CLI's `/usage` modal reads `GET /v1/billing?format=credits`. The figure
 * is one period, weekly on a SuperGrok plan: `creditUsagePercent` of that
 * period, resetting at `currentPeriod.end`. A period the answer does not
 * name is treated as that week. Pay-as-you-go with a zero cap is not a
 * second window.
 */
function windowsFromBilling(body) {
    const config = body?.config && typeof body.config === 'object' ? body.config : body;
    if (!config || typeof config !== 'object') return [];
    const clamp = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
    };
    let used = clamp(config.creditUsagePercent);
    if (used === null && Array.isArray(config.productUsage)) {
        const build = config.productUsage.find(row => /grok.?build/i.test(String(row?.product || '')));
        used = clamp(build?.usagePercent);
    }
    if (used === null) return [];
    const period = config.currentPeriod && typeof config.currentPeriod === 'object' ? config.currentPeriod : {};
    const type = String(period.type || '');
    const monthly = /MONTH/i.test(type);
    const resetsAt = Date.parse(period.end || config.billingPeriodEnd || '') || null;
    return [{
        id: monthly ? 'window_43200' : 'seven_day',
        label: '',
        minutes: monthly ? 43200 : 10080,
        used,
        resetsAt,
        status: used >= 100 ? 'rejected' : '',
    }];
}

/** The billing URL the CLI itself would call, from its cache when that names this host. */
function billingUrl(source = grokHome()) {
    const cache = readJson(path.join(source, 'settings_cache.json'));
    let origin = `${BILLING_ORIGIN}/v1`;
    try {
        const payload = typeof cache?.payload === 'string' ? JSON.parse(cache.payload) : cache?.payload;
        const named = String(payload?.origin || '').replace(/\/$/, '');
        if (named === BILLING_ORIGIN || named.startsWith(`${BILLING_ORIGIN}/`)) origin = named;
    } catch {
        // The known host.
    }
    return `${origin}/billing?format=credits`;
}

/** One HTTPS GET, as `{ status, body }`. `body` is parsed JSON, or null. */
function getJson(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers, timeout: 15000 }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let body = null;
                try { body = JSON.parse(text); } catch { body = null; }
                resolve({ status: res.statusCode || 0, body });
            });
        });
        req.on('timeout', () => req.destroy(new Error('The billing request timed out.')));
        req.on('error', reject);
    });
}

/**
 * Who the account is and how much of its weekly allowance is used.
 *
 * No turn is sent. The figure is the plan's, so it counts every device on
 * the login, which is what the status bar is for.
 */
async function readLimits() {
    if (!findGrok()) return { identity: null, windows: [], error: 'Grok Build is not installed on this machine.' };
    const source = grokHome();
    const entry = authEntry(source);
    const identity = {
        signedIn: Boolean(entry?.key),
        email: String(entry?.email || ''),
        plan: '',
        organization: String(entry?.team_name || ''),
        method: String(entry?.auth_mode || ''),
    };
    if (!identity.signedIn) return { identity, windows: [] };
    let answer;
    try {
        answer = await getJson(billingUrl(source), {
            Authorization: `Bearer ${entry.key}`,
            Accept: 'application/json',
        });
    } catch (error) {
        return { identity, windows: [], error: describeFailure(error.message) };
    }
    if (answer.status === 401 || answer.status === 403) {
        return {
            identity,
            windows: [],
            error: 'Grok Build is not signed in on this machine. Run "grok" in a terminal and sign in, then try again here.',
        };
    }
    if (answer.status !== 200 || !answer.body) {
        return { identity, windows: [], error: 'Grok Build did not answer its usage limits. Try again in a moment.' };
    }
    const windows = windowsFromBilling(answer.body);
    return { identity, windows, unsupported: windows.length === 0 };
}

/** One of the CLI's own files, parsed, or nothing if it is not there yet. */
function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The model the CLI is set to, out of its own configuration.
 *
 * One line under `[models]`, which is the only part of that file this needs.
 * Read a line at a time rather than parsed: the answer decides which row the
 * menu lands on, so being wrong about it costs a highlight rather than a
 * conversation, and a TOML parser for one key is a dependency for nothing.
 */
function configuredModel(source) {
    let text = '';
    try {
        text = fs.readFileSync(path.join(source, 'config.toml'), 'utf8');
    } catch {
        return '';
    }

    let models = false;
    for (const line of text.split(/\r?\n/)) {
        const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
        if (header) {
            models = header[1].trim() === 'models';
            continue;
        }
        if (!models) continue;

        const value = /^\s*default\s*=\s*["']([^"']+)["']/.exec(line);
        if (value) return value[1];
    }
    return '';
}

/**
 * Whether a cache entry is a Grok model and belongs on this menu.
 *
 * The proxy behind `models_cache.json` could one day list third-party models
 * beside Grok's own (Pi's catalog already mixes `meta/muse-spark`,
 * `openai-codex/*` and `xai/grok-*` the same way). Grok Build runs Grok, so
 * anything that is not Grok is filtered out here: Pi and Muse keep offering
 * Muse Spark, Grok Build offers only Grok. Family wins when present
 * (`model_family: "xai"`); otherwise the id has to look like Grok
 * (`grok-4.6`, `grok-4.7-build-fast`).
 */
function isGrokModel(id, info = {}) {
    const family = String(info.model_family || info.family || '').toLowerCase();
    if (family) return family === 'xai' || family.startsWith('grok');
    const candidate = String(info.model || info.id || id || '').toLowerCase();
    return candidate.startsWith('grok-') || candidate === 'grok';
}

/**
 * The models the CLI cached when it last signed in.
 *
 * Each entry carries its own reasoning levels, which is better than the union
 * this app used to offer for every row: 4.6 takes an extra-high that 4.5 does
 * not, and a dial with a stop the model has never heard of is a dial that turns
 * a working conversation into a failed argument. Narrowed to the levels this
 * app has names for, a model the CLI marks hidden is not offered at all, and a
 * model that is not Grok is not offered here either (see `isGrokModel`).
 */
function cachedModels({ source = grokHome() } = {}) {
    const cache = readJson(path.join(source, 'models_cache.json'));
    const models = cache?.models;
    if (!models || typeof models !== 'object') return null;

    const best = configuredModel(source);

    const rows = Object.entries(models)
        .map(([id, entry]) => ({ id, info: entry?.info || {} }))
        .filter(({ id, info }) => !info.hidden && isGrokModel(id, info))
        .map(({ id, info }) => ({
            value: info.id || id,
            resolved: info.model || info.id || id,
            label: info.name || id,
            short: info.name || id,
            description: info.description || '',
            effort: info.supports_reasoning_effort && Array.isArray(info.reasoning_efforts)
                ? info.reasoning_efforts
                    .map(level => String(level?.value || level?.id || ''))
                    .filter(level => EFFORTS.has(level))
                : [],
            preferred: (info.id || id) === best,
        }));

    return rows.length > 0 ? rows : null;
}

/**
 * A directory of our own for the agent to run in.
 *
 * Not the user's project, and not their home. A terminal agent reads the
 * directory it is started in, and this one has no business in either: the work
 * is on the servers, reached through tools, and an empty folder is the honest
 * description of what it has local access to.
 *
 * That is the fallback. With a folder granted for writing the run starts
 * there instead (see `directoryFor`): the model must work where the user
 * said it may, not in an empty folder it then abandons for $HOME.
 */
function workspace() {
    const directory = path.join(app.getPath('userData'), 'grok-build');
    try {
        fs.mkdirSync(directory, { recursive: true });
    } catch {
        // Already there, or a home directory that cannot be written to, in
        // which case the spawn below reports it properly.
    }
    return directory;
}

/**
 * Where one headless run starts: the granted project, else the workspace
 * above. Both the `--cwd` argument and the spawn's own directory, which are
 * the same folder today.
 *
 * A resumed session restores its conversation only (no `--restore-code` is
 * passed and no session files are migrated), so a cwd change carries the
 * chat into the new folder; a stored id the CLI no longer has starts fresh
 * under the same id instead of failing.
 */
function directoryFor(settings) {
    return sandboxLib.workingDirectoryFor(settings, workspace());
}

/**
 * The MCP tables for one session, in the CLI's TOML spelling.
 *
 * Bare (no URL) and no servers of the agent's own: nothing. The user's
 * `~/.grok/config.toml` is already loaded for every directory, so an empty
 * fragment means the run adds no server and writes no file.
 */
function mcpFragment(url, { servers = [], sandbox = null, agentId = '' } = {}) {
    const own = (Array.isArray(servers) ? servers : []).filter(entry => entry?.name && entry.name !== SERVER_NAME);
    return `${mcpConfig.toml(own, sandbox, agentId)}${url ? `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"\n` : ''}`;
}

/** Server names this fragment publishes. A `.headers` or `.env` subtable belongs to its parent. */
function mcpTableNames(toml) {
    const names = [];
    const re = /^\[mcp_servers\.((?:"(?:\\.|[^"\\])*")|[A-Za-z0-9_-]+)\]\s*$/gm;
    for (const match of String(toml).matchAll(re)) {
        let name = match[1];
        if (name.startsWith('"')) {
            try { name = JSON.parse(name); } catch { continue; }
        }
        if (!names.includes(name)) names.push(name);
    }
    return names;
}

/** Whether a TOML header is one of our servers or a subtable of one. */
function ownsMcpTable(header, names) {
    for (const name of names) {
        const key = `mcp_servers.${mcpConfig.tomlKey(name)}`;
        if (header === key || header.startsWith(`${key}.`)) return true;
    }
    return false;
}

/**
 * Drop our `[mcp_servers.*]` tables from a config, including a `.headers`
 * or `.env` subtable. Every other line stays, in order.
 */
function withoutMcpTables(text, names) {
    const lines = String(text).split('\n');
    const out = [];
    let skipping = false;
    for (const line of lines) {
        const header = /^\[([^\]]+)\]\s*$/.exec(line);
        if (header) skipping = ownsMcpTable(header[1], names);
        if (!skipping) out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The text of our tables as they stand in a config, or ''. */
function extractMcpTables(text, names) {
    const lines = String(text).split('\n');
    const out = [];
    let skipping = true;
    for (const line of lines) {
        const header = /^\[([^\]]+)\]\s*$/.exec(line);
        if (header) skipping = !ownsMcpTable(header[1], names);
        if (!skipping) out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Merge our servers into the user config Grok reads for every directory.
 *
 * The run's cwd is the granted repo, and this CLI has no flag that points
 * MCP discovery at another folder, so the tables go in `~/.grok/config.toml`
 * rather than into the repo. Only those tables are touched: a server the
 * user already had under the same name is put back when the session ends,
 * and anything else they edit meanwhile stays. An empty fragment writes
 * nothing. The returned function is safe to call twice.
 */
function publishUserMcp(fragment, { source = grokHome() } = {}) {
    const block = String(fragment || '').trim();
    const names = mcpTableNames(block);
    if (names.length === 0) return () => {};

    const file = path.join(source, 'config.toml');
    let original = null;
    try { original = fs.readFileSync(file, 'utf8'); } catch { original = null; }
    const saved = original == null ? '' : extractMcpTables(original, names);
    const base = original == null ? '' : withoutMcpTables(original, names);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(file, base ? `${base}\n\n${block}\n` : `${block}\n`, 'utf8');

    let done = false;
    return () => {
        if (done) return;
        done = true;
        let current = '';
        try { current = fs.readFileSync(file, 'utf8'); } catch { current = ''; }
        const without = withoutMcpTables(current, names);
        const putBack = saved.trim();
        const next = putBack
            ? (without ? `${without}\n\n${putBack}\n` : `${putBack}\n`)
            : (without ? `${without}\n` : '');
        if (!next && original == null) {
            try { fs.unlinkSync(file); } catch { /* already gone */ }
            return;
        }
        fs.writeFileSync(file, next, 'utf8');
    };
}

/**
 * The same servers, as files in a directory this app owns.
 *
 * Kept for the spelling tests. A real run does not call it: writing these
 * into the working directory would drop them in the user's repository, and
 * Grok reads the user config wherever it was started (see `publishUserMcp`).
 */
function writeMcpConfig(directory, url, { servers = [], sandbox = null, agentId = '' } = {}) {
    const own = (Array.isArray(servers) ? servers : []).filter(entry => entry?.name && entry.name !== SERVER_NAME);
    const json = JSON.stringify({
        mcpServers: {
            ...mcpConfig.agentServers(own, sandbox, agentId),
            ...(url ? { [SERVER_NAME]: { type: 'http', url } } : {}),
        },
    }, null, 2);
    const toml = mcpFragment(url, { servers, sandbox, agentId });

    fs.mkdirSync(path.join(directory, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.grok', 'config.toml'), toml, 'utf8');
    fs.writeFileSync(path.join(directory, '.mcp.json'), json, 'utf8');
}

/**
 * Mark our workspace as a folder Grok Build may take config from.
 *
 * The CLI reads a folder's `.grok/config.toml` only once that folder has
 * been trusted, which in a terminal is a prompt on the first visit. Nobody
 * sees that prompt in headless mode, so the server written above was read
 * and quietly ignored, and the agent ran with none of this app's tools:
 * no hosts, no inventory, no jobs, only what the CLI carries itself. The
 * folder is one this app made and owns, so trusting it is only saying so in
 * the CLI's own file, in the shape the CLI writes for itself, once. An
 * entry that is already there is left as it is, including one that says
 * `false`: that is a decision somebody made in the CLI, not ours to undo.
 */
function trustWorkspace(directory, { source = grokHome(), now = Date.now() } = {}) {
    const file = path.join(source, 'trusted_folders.toml');
    let text = '';
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        text = '';
    }
    // TOML has two spellings for a key with backslashes in it; the CLI
    // writes the literal one, but a hand-edited file may carry the other.
    const literal = `[folders.'${directory}']`;
    const basic = `[folders."${directory.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    if (text.includes(literal) || text.includes(basic)) return false;

    const key = directory.includes('\'') ? basic : literal;
    const block = `${key}\ntrusted = true\ndecided_at = ${Math.floor(now / 1000)}\n`;
    const glue = text.length === 0 ? '' : (text.endsWith('\n') ? '\n' : '\n\n');
    fs.mkdirSync(source, { recursive: true });
    fs.appendFileSync(file, glue + block, 'utf8');
    return true;
}

/** `remote__run_command` or `mcp__remote__read_file` back to the bare name. */
function stripServer(name) {
    const text = String(name || '');
    const match = new RegExp(`^(?:mcp__)?${SERVER_NAME}(?:__|_|\\.)`).exec(text);
    return match ? text.slice(match[0].length) : text;
}

/** The first of these keys the event actually carries a string under. */
function firstString(event, ...keys) {
    for (const key of keys) {
        const value = event?.[key];
        if (typeof value === 'string' && value) return value;
        // ACP-shaped content: a list of blocks, of which the text ones matter.
        if (Array.isArray(value)) {
            const text = value
                .map(entry => entry?.text || entry?.content?.text || '')
                .filter(Boolean)
                .join('');
            if (text) return text;
        }
    }
    return '';
}

/**
 * One streaming-json line, as the transcript events the panel already draws.
 *
 * The event names are the documented ones: `text`, `thought`, `tool_call`,
 * `tool_call_update`, `usage`, `plan`, `available_commands`, `error` and
 * `end`, which is always last. The fields inside them are read leniently,
 * through `firstString` above, because the same event carries `text` in one
 * release and `content` in the next and a transcript that renders nothing is a
 * worse failure than one that renders a field it did not expect.
 */
/**
 * The first string anywhere inside a tool's result, as far down as it is worth
 * looking.
 *
 * `rawOutput` is where this CLI puts what a tool produced, and it is not a
 * string and not one shape: each built-in tool writes its own struct there,
 * named and wrapped in a `Content` field. So the wrapper is opened until a
 * string falls out. Anything unrecognised is shown as its own JSON rather than
 * dropped: a result the panel cannot read nicely is still a result the person
 * can read, and an empty row under a tool call reads as a tool that did
 * nothing.
 */
function unwrapOutput(value, depth = 0) {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || depth > 4) return '';

    if (Array.isArray(value)) {
        return value.map(entry => unwrapOutput(entry, depth + 1)).filter(Boolean).join('\n');
    }

    for (const key of ['content', 'Content', 'text', 'output', 'stdout', 'message', 'error']) {
        const found = unwrapOutput(value[key], depth + 1);
        if (found) return found;
    }

    return depth === 0 ? JSON.stringify(value).slice(0, 2000) : '';
}

/** What a finished tool call produced, however this release spells it. */
function readOutput(payload) {
    return firstString(payload, 'content', 'output', 'result', 'error')
        || unwrapOutput(payload?.rawOutput ?? payload?.raw_output);
}

/**
 * The model's context window, out of the CLI's own model cache.
 *
 * The cache is what the CLI itself reads before it draws its own picker, so
 * it names the same models the menu offers, with the window each one runs
 * in. Every known spelling of a model shares one entry, since the setting
 * the turn runs under and the cache's own id are not always the same string.
 */
function contextWindows({ source = grokHome() } = {}) {
    const cache = readJson(path.join(source, 'models_cache.json'));
    const models = cache?.models;
    const windows = new Map();
    if (!models || typeof models !== 'object') return windows;
    for (const [id, entry] of Object.entries(models)) {
        const info = entry?.info || {};
        const limit = Number(info.context_window)
            || Number(info.contextWindows?.[0])
            || Number(info.context_windows?.[0])
            || 0;
        if (!(limit > 0)) continue;
        for (const alias of [id, info.id, info.model]) {
            if (alias) windows.set(String(alias), limit);
        }
    }
    return windows;
}

/**
 * One model call as tokens for the composer's ring: what that call sent,
 * cached or not, and what it got back.
 *
 * Headless `input_tokens` is the uncached portion, and the cache buckets sit
 * beside it. `total_tokens` is the same call with those buckets included, so
 * when the fields leave the cache out the total is the window. A reading that
 * already folds the cache into `input_tokens` adds up to `total_tokens` on its
 * own: adding the cache bucket again would count it twice. Read leniently, as
 * the rest of this stream is: a shape not listed here reads as nothing rather
 * than as a crash.
 */
function usageTokens(usage) {
    if (!usage || typeof usage !== 'object') return { used: 0, cached: 0 };
    const input = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens) || 0;
    const output = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens) || 0;
    const cached = Number(
        usage.cache_read_input_tokens ?? usage.cachedReadTokens ?? usage.cacheReadInputTokens
        ?? usage.cached_tokens ?? usage.cache_read
    ) || 0;
    const written = Number(
        usage.cache_creation_input_tokens ?? usage.cacheCreationTokens
        ?? usage.cache_creation_tokens ?? usage.cache_creation
    ) || 0;
    const total = Number(usage.total_tokens ?? usage.totalTokens) || 0;
    const fields = input + output;
    const withCache = fields + cached + written;
    const inputHoldsCache = total > 0 && cached + written > 0 && fields >= total;
    return { used: inputHoldsCache ? Math.max(fields, total) : Math.max(withCache, total), cached };
}

/**
 * How many model calls the closing line says it added up.
 *
 * `num_turns` is the main agent's rounds. `modelCalls` counts subagents too.
 * Either one above a single call means `usage` is a sum of calls, which is
 * the bill for the turn and not the size of the window. Zero means the line
 * did not say.
 */
function roundsOf(payload) {
    const named = Number(payload?.num_turns ?? payload?.numTurns) || 0;
    const models = payload?.modelUsage || payload?.model_usage;
    let calls = 0;
    if (models && typeof models === 'object') {
        for (const row of Object.values(models)) {
            calls += Number(row?.modelCalls ?? row?.model_calls) || 0;
        }
    }
    return Math.max(named, calls);
}

function createTranslator(onEvent, { model = '', contextLimit = () => 0 } = {}) {
    let text = '';
    let cost = 0;
    let usage = null;
    let sawError = false;
    const announced = new Set();
    let lastContext = '';
    let reportedContext = false;

    /**
     * How full the context is after the latest model call: that call's tokens
     * over the model's window, as Pi draws it beside its composer. Said each
     * time it moves, once per model call. Without a window there is no
     * reading and the ring stays empty, as before: a percentage over a
     * guessed window would be worse than none.
     */
    const reportContext = (reading) => {
        const { used, cached } = usageTokens(reading);
        if (used <= 0) return;
        const limit = Number(contextLimit(model)) || 0;
        if (limit <= 0) return;
        const key = `${used}/${limit}/${cached}`;
        if (key === lastContext) return;
        lastContext = key;
        reportedContext = true;
        onEvent({
            type: 'context',
            used,
            limit,
            percent: Math.round((used / limit) * 100),
            model,
            // Cache-read tokens behind this reading, when reported: the
            // composer's tooltip shows the hit rate from it.
            ...(cached > 0 ? { cached } : {}),
        });
    };

    /**
     * Any text so far, as a finished block.
     *
     * Called before a tool call rather than after it, because the panel treats
     * the finished block as authoritative and clears whatever streamed: a call
     * announced first would leave the text sitting underneath it.
     */
    const flush = () => {
        if (text.trim()) onEvent({ type: 'assistant-text', text });
        text = '';
    };

    return {
        get failed() {
            return sawError;
        },
        event(payload) {
            switch (payload?.type) {
                // `data` is where this CLI actually puts the words, and for a
                // while it was the one spelling not looked for here: every
                // chunk of every answer matched none of the keys below and was
                // dropped, so a turn ran to a clean exit and said nothing. The
                // others are kept because they cost nothing and this is a
                // format that is not ours to define.
                case 'text': {
                    const delta = firstString(payload, 'data', 'text', 'content', 'delta', 'message');
                    if (!delta) return;
                    text += delta;
                    onEvent({ type: 'text-delta', text: delta });
                    return;
                }

                case 'thought': {
                    const delta = firstString(payload, 'data', 'text', 'content', 'delta', 'thought');
                    if (delta) onEvent({ type: 'thinking-delta', text: delta });
                    return;
                }

                case 'tool_call':
                case 'tool_call_update': {
                    const id = firstString(payload, 'toolCallId', 'tool_call_id', 'id', 'callId')
                        || `tool-${announced.size}`;
                    const raw = firstString(payload, 'toolName', 'tool_name', 'tool', 'name', 'title');
                    const name = stripServer(raw);
                    const status = String(payload.status || '').toLowerCase();
                    const input = payload.rawInput || payload.raw_input || payload.input
                        || payload.arguments || {};

                    if (!announced.has(id)) {
                        announced.add(id);
                        flush();
                        onEvent({
                            type: 'tool-call',
                            id,
                            name: name || 'tool',
                            rawName: raw,
                            // Ours arrive prefixed with the server name. Anything
                            // else is one of the agent's own, acting on this
                            // machine, and the panel says so.
                            local: name === raw,
                            input,
                        });
                    }

                    if (['completed', 'failed', 'error', 'cancelled', 'canceled'].includes(status)) {
                        onEvent({
                            type: 'tool-result',
                            id,
                            text: readOutput(payload),
                            isError: status !== 'completed',
                        });
                    }
                    return;
                }

                case 'usage':
                    usage = payload.usage || payload;
                    cost += Number(payload.costUsd ?? payload.cost_usd ?? payload.cost ?? 0) || 0;
                    if (payload.usage) reportContext(payload.usage);
                    return;

                // The last line of a run, and the only one that totals it. Its
                // `usage` adds up every model call in the prompt, which is the
                // bill (the same prefix counted again on each tool round) and
                // not how full the window is. The per-call `usage` lines above
                // already are the window, the last of them the current one.
                // A single call has nothing to add up, and its `total_tokens`
                // is the window, cache included where the other fields omit it.
                // The cost is only ever stated here: none of the usage lines
                // carries one, which is why the chip read zero.
                case 'end':
                    if (payload.usage) {
                        usage = payload.usage;
                        const rounds = roundsOf(payload);
                        if (rounds <= 1 && (rounds === 1 || !reportedContext)) reportContext(payload.usage);
                    }
                    cost += Number(payload.total_cost_usd ?? payload.totalCostUsd ?? 0) || 0;
                    return;

                case 'error':
                case 'max_turns_reached': {
                    sawError = true;
                    flush();
                    const said = firstString(payload, 'message', 'error', 'text') || '';
                    // The ceiling is a setting of this app, not a fault of the
                    // CLI, and the session is intact: one more message picks
                    // the work up where it stopped.
                    const ceiling = payload.type === 'max_turns_reached' || /max[ _]turns/i.test(said);
                    onEvent({
                        type: 'error',
                        message: ceiling
                            ? 'Stopped at the turn limit for one message (Settings → Max turns). The work is not lost: say "continue" to carry on from here.'
                            : describeFailure(said || 'Grok Build reported an error'),
                    });
                    return;
                }

                // A plan and the slash commands the session offers are about
                // the agent's own interface rather than about this
                // conversation, and the panel has nowhere to put either.
                default:
            }
        },
        finish(subtype = 'success') {
            flush();
            onEvent({
                type: 'result',
                subtype: sawError ? 'error' : subtype,
                isError: sawError || subtype !== 'success',
                costUsd: cost,
                usage,
            });
            cost = 0;
            usage = null;
            sawError = false;
        },
    };
}

/** The effort to pass on, or nothing when the app's level has no name here. */
function effortFor(current) {
    if (EFFORTS.has(current.effort)) return current.effort;
    // The one level above this agent's scale, rounded down rather than dropped.
    return current.effort === 'ultra' ? 'max' : '';
}

/** The arguments for one headless run. */
function runArguments({ current, sessionId, resume, directory, prompt }) {
    const args = [
        '-p', prompt,
        '--output-format', 'streaming-json',
        '--cwd', directory,
        // Our own gate is the one that asks. Grok Build putting a second
        // question on a channel with nobody reading it would stop every tool
        // call dead, which is exactly what happened to Codex before its
        // approval mode was set.
        '--always-approve',
        // 0 is "no ceiling"; the flag wants a number, so a ceiling no turn
        // reaches stands in for it.
        '--max-turns', String(current.maxTurns === 0 ? UNLIMITED_TURNS : (current.maxTurns || 40)),
        // A background update check in the middle of somebody's turn is a
        // download this app did not ask for and cannot report.
        '--no-auto-update',
        resume ? '--resume' : '--session-id', sessionId,
    ];

    if (current.model) args.push('--model', current.model);

    const effort = effortFor(current);
    if (effort) args.push('--effort', effort);

    if (!current.allowLocalTools) args.push('--disallowed-tools', LOCAL_TOOLS.join(','));

    return args;
}

/**
 * The prompt with staged pictures named in it.
 *
 * A headless run takes text, not image blocks, so pictures ride as files the
 * run is pointed at: written out for the turn by `stageImages` (see codex),
 * named here, removed when the turn ends. The agent opens them with its own
 * file tools, the same way it opens anything else the prompt points at.
 */
function promptWithImages(text, paths = []) {
    const body = String(text || '').trim();
    if (!paths.length) return body;
    const lines = paths.map(file => `- ${file}`);
    return [
        body || 'See the attached images.',
        '',
        'Attached images (open each file to view it):',
        ...lines,
    ].join('\n');
}

/**
 * One turn: a process, its stdout read as it arrives, and an exit code.
 *
 * A run per turn rather than a long-lived process is the Codex arrangement,
 * and for the same reason: the CLI's headless mode answers one prompt and
 * ends. The session id is what carries the conversation, and Grok Build keeps
 * it in `~/.grok/sessions`, so this survives the app being closed in a way the
 * in-process providers cannot.
 */
function runTurn({ binary, args, directory, env, translator, onStart = () => {}, waiting = () => false }) {
    return new Promise((resolve) => {
        let child;
        let stderr = '';
        let buffer = '';
        let settled = false;

        const finish = (outcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
        };

        let timer = null;
        const expire = () => {
            // Quiet because one of our own tools is still open, which is a
            // card waiting for the user: not a hang, and not ended.
            if (waiting()) {
                rewind();
                return;
            }
            try { child?.kill(); } catch { /* already gone */ }
            finish({ ok: false, message: 'Grok Build went quiet for half an hour, so the turn was ended.' });
        };
        // Wound again on every line it writes: see IDLE_TIMEOUT.
        const rewind = () => {
            clearTimeout(timer);
            timer = setTimeout(expire, IDLE_TIMEOUT);
        };
        rewind();

        try {
            child = spawn(binary, args, {
                cwd: directory,
                env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (error) {
            finish({ ok: false, message: describeFailure(error.message) });
            return;
        }

        onStart(child);

        child.stdout.on('data', (chunk) => {
            rewind();
            buffer += chunk.toString('utf8');
            let index = buffer.indexOf('\n');
            while (index >= 0) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
                if (!line) continue;
                try {
                    translator.event(JSON.parse(line));
                } catch {
                    // Not a JSON line. A banner, a warning, or a release that
                    // writes something else on this stream; none of it is worth
                    // ending a turn over.
                }
            }
        });

        // Kept rather than shown. It is where the CLI puts the reason it could
        // not start, which is the one thing worth repeating when a run fails
        // without ever having said anything on the wire.
        child.stderr.on('data', (chunk) => {
            stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
        });

        child.once('error', error => finish({ ok: false, message: describeFailure(error.message) }));
        child.once('close', (code) => {
            if (code === 0) {
                finish({ ok: true });
                return;
            }
            finish({
                ok: false,
                code,
                stderr,
                message: describeFailure(stderr.trim() || `Grok Build exited with code ${code}`),
            });
        });
    });
}

/**
 * Stop a run, taking the tree with it.
 *
 * On Windows the path found may be a `.cmd` shim, and killing the shim leaves
 * the agent it launched running under `cmd.exe`: a command still going on a
 * server after the user pressed stop, and a process that outlives the app.
 * This is the same whole-tree shutdown the OpenCode provider does, for the
 * same reason.
 */
function stopProcess(child, { platform = process.platform, spawnSyncFn = null } = {}) {
    if (!child || child.exitCode != null || child.signalCode != null) return;

    if (platform === 'win32' && child.pid) {
        const runner = spawnSyncFn || require('child_process').spawnSync;
        const result = runner('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        if (!result.error && result.status === 0) return;
    }
    try { child.kill(); } catch { /* already gone */ }
}

/** The API path, for a machine with a key and no CLI. */
async function apiSession(options) {
    options.onEvent({
        type: 'account',
        subscriptionType: '',
        apiProvider: 'xAI API',
        apiKeySource: 'CloudBlast',
    });

    return engine.start({
        ...options,
        label: LABEL,
        prefix: 'grok',
        endpoint: current => ({ baseUrl: API_URL, apiKey: current.apiKey || '', label: LABEL }),
        // xAI names its agent model, and it is the one this card is about.
        // Anything else the account can reach is in the menu once the key has
        // been read for the model list.
        model: current => current.model || 'grok-build-0.1',
    });
}

async function start(options) {
    const {
        settings,
        getSettings = () => settings,
        systemPrompt,
        toolContext,
        requestApproval,
        onEvent,
        resumeSessionId = '',
    } = options;

    const binary = findGrok();
    if (!binary) {
        if (settings.apiKey) return apiSession(options);
        throw new Error('Grok Build is not installed on this machine. Install the Grok Build CLI '
            + 'and sign in with "grok" in a terminal, then switch it on again.');
    }

    const directory = directoryFor(settings);
    // Bare provider CLI: none of the app's tools attached; the config keeps
    // the agent's own servers only. Either way the tables go in the user
    // config, which Grok loads for every cwd, so the process can start in
    // the granted repo without a config file landing there.
    const { tokenUrl, token } = settings?.bareProvider
        ? { tokenUrl: null, token: null }
        : await mcpHost.acquire({ toolContext, requestApproval, onEvent });

    let restoreMcp = () => {};
    try {
        restoreMcp = publishUserMcp(mcpFragment(tokenUrl, {
            servers: settings.mcpServers,
            sandbox: settings.sandbox,
            agentId: settings.agentId,
        }));
    } catch (error) {
        if (token) await mcpHost.release(token);
        throw new Error(`The Grok Build configuration could not be written: ${error.message}`);
    }
    // A project folder still has to be trusted or headless mode ignores what
    // it finds there. An entry that already says `false` is left alone.
    try {
        trustWorkspace(directory);
    } catch (error) {
        console.warn(`Could not trust the Grok Build workspace: ${error.message}`);
    }

    // Only from our own store, and only when the user put one there. Left
    // alone otherwise so the CLI uses the login already on this machine.
    const environment = (current) => {
        const env = { ...process.env };
        if (current.apiKey) env.XAI_API_KEY = current.apiKey;
        return env;
    };

    // A session id we choose, so the conversation can be resumed by the same
    // id after the app has been closed and reopened. A UUID because that is
    // what the CLI's own sessions are named.
    const sessionId = resumeSessionId || crypto.randomUUID();
    let resume = Boolean(resumeSessionId);

    onEvent({ type: 'session', sessionId, model: settings.model || '' });

    // Only when there is something to say. A stored key means the turns are
    // metered rather than coming out of a plan, and that is worth reporting;
    // the ordinary case, where the CLI is signed in to an account this app
    // cannot see, is better left unsaid than guessed at.
    if (settings.apiKey) {
        onEvent({ type: 'account', subscriptionType: '', apiProvider: '', apiKeySource: 'CloudBlast' });
    }

    // The system prompt is not a flag on a headless run, so it leads the first
    // turn. Grok Build carries it forward with the rest of the session.
    // Bare: no Acestes prompt at all (index already passes an empty one).
    let preamble = systemPrompt;
    let running = Promise.resolve();
    let closed = false;
    let stopped = false;
    let child = null;

    const hold = (started) => {
        child = started;
        // Stopped between the decision to spawn and the process existing.
        if (stopped) stopProcess(child);
    };

    async function turn(text, images = []) {
        const current = getSettings();
        const env = environment(current);
        // The composer's ring: the reply's tokens over the model's window,
        // out of the CLI's own model cache. Read per turn so a cache the
        // CLI rewrites mid-conversation (sign-in, new model) takes effect
        // on the next message rather than the next restart.
        const windows = contextWindows();
        const translator = createTranslator(onEvent, {
            model: current.model || configuredModel(),
            contextLimit: (name) => windows.get(String(name)) || 0,
        });
        // Pictures ride as files the run is pointed at: staged for the turn,
        // named in the prompt, removed afterwards. The retry below reuses the
        // same staging, so nothing is cleaned up until the turn is over.
        const staged = await stageImages(images);
        const prompt = preamble
            ? `${preamble}\n\n---\n\n${promptWithImages(text, staged.paths)}`
            : promptWithImages(text, staged.paths);
        preamble = '';
        stopped = false;

        const waiting = () => (token ? mcpHost.pending(token) : 0) > 0;
        try {
        let outcome = await runTurn({
            binary,
            args: runArguments({ current, sessionId, resume, directory, prompt }),
            directory,
            env,
            translator,
            onStart: hold,
            waiting,
        });

        // A stored id that this machine no longer has a session for. The
        // conversation carries on as a new session under the same id rather
        // than failing, which is what the transcript in front of the user
        // already implies has happened.
        const missing = /session|not found|unknown|no such/i.test(outcome.stderr || outcome.message || '');
        if (!outcome.ok && !stopped && resume && missing) {
            resume = false;
            outcome = await runTurn({
                binary,
                args: runArguments({ current, sessionId, resume: false, directory, prompt }),
                directory,
                env,
                translator,
                onStart: hold,
                waiting,
            });
        }

        child = null;

        if (outcome.ok) {
            resume = true;
            translator.finish();
            return;
        }

        // A run the user stopped is not a run that failed. The session still
        // exists either way, so the next message resumes it rather than
        // starting again from nothing.
        if (stopped) {
            resume = true;
            return;
        }

        if (closed) return;
        if (!translator.failed) onEvent({ type: 'error', message: outcome.message });
        translator.finish('error');
        } finally {
            await staged.cleanup();
        }
    }

    return {
        send(text, images = []) {
            running = running.then(() => turn(text, images)).catch((error) => {
                if (!closed) onEvent({ type: 'error', message: describeFailure(error.message) });
            });
        },
        // Both are flags on the next run, so there is nothing to push at
        // anything that is already going.
        async setModel() {},
        async setEffort() {},
        async interrupt() {
            stopped = true;
            stopProcess(child);
        },
        async close() {
            closed = true;
            stopped = true;
            stopProcess(child);
            await running.catch(() => {});
            try { restoreMcp(); } catch { /* the next session replaces the same tables */ }
            if (token) await mcpHost.release(token);
        },
    };
}

/**
 * What the account can run.
 *
 * The CLI's own list, out of the cache it writes into its home when it signs
 * in. That used to be a request to api.x.ai made with a key stored in this app,
 * which had the CLI on the machine reporting no models at all: the account the
 * CLI is signed in to is not one this app has a credential for, so with no key
 * there was nothing to ask with and the menu fell back to a single row.
 *
 * Nothing is asked of the network here. The file is what the CLI itself reads
 * before it draws its own picker, so it is the same answer, and it carries more
 * than a `/models` response does: the name each model goes by, what it is for,
 * and the reasoning levels it actually takes.
 *
 * The API path keeps its own answer for a machine with a key and no CLI, since
 * there is no cache to read there.
 */
async function listModels({ settings: current = {} } = {}) {
    if (findGrok()) return cachedModels();

    if (!current.apiKey) return null;

    const rows = await engine.listModels({
        baseUrl: API_URL,
        apiKey: current.apiKey,
        label: LABEL,
    });
    if (!rows?.length) return null;

    // No dial on this path. The request would carry a reasoning field the model
    // may not take, and a dial that turns a working conversation into a 400 is
    // worse than no dial. Filtered to Grok too, so a proxy that lists
    // third-party models does not put Muse Spark on the Grok Build menu.
    const grokOnly = rows.filter(row => isGrokModel(row?.value || row?.resolved, { model: row?.resolved || row?.value }));
    if (!grokOnly.length) return null;
    return grokOnly.map(row => ({ ...row, effort: [] }));
}

/** A failure, in words that say what to do about it. */
function describeFailure(message) {
    const text = String(message || 'Unknown error');

    if (/not logged in|unauthor|401|sign ?in|log ?in|invalid.*api.?key/i.test(text)) {
        return 'Grok Build is not signed in on this machine. Run "grok" in a terminal and sign in, '
            + 'then try again here.';
    }
    if (/ENOENT|not found|spawn/i.test(text)) {
        return 'The Grok Build CLI could not be started. Check that "grok" runs in a terminal, '
            + `then try again. (${text})`;
    }
    if (/unexpected argument|unknown (flag|option)|unrecognized/i.test(text)) {
        return 'This version of Grok Build did not understand how CloudBlast started it. '
            + `Update the CLI and try again. (${text})`;
    }
    if (/rate limit|429|quota/i.test(text)) {
        return 'xAI is rate limiting this account. Wait a moment, then try again.';
    }
    return text;
}

/**
 * Whether this agent could run here. See the note on claude-code's.
 *
 * The CLI and its login, and nothing else. `start` can also run against the xAI
 * API on a stored key, but that is not offered as a way to switch this agent
 * on: the assistant runs what is installed and signed in here, and an agent
 * accepted because a credential could be typed in later is an agent that fails
 * in the middle of a question instead of at the tick. A key an older version
 * stored still drives the fallback for whoever already had one.
 */
function detect() {
    if (!findGrok()) return { ok: false, reason: 'notFound' };
    return { ok: signedIn(), reason: 'notSignedIn' };
}

module.exports = {
    start,
    listModels,
    detect,
    readLimits,
    findGrok,
    grokHome,
    signedIn,
    cachedModels,
    configuredModel,
    contextWindows,
    usageTokens,
    roundsOf,
    windowsFromBilling,
    billingUrl,
    isGrokModel,
    grokRoots,
    createTranslator,
    runArguments,
    writeMcpConfig,
    publishUserMcp,
    trustWorkspace,
    stripServer,
    effortFor,
    describeFailure,
    promptWithImages,
    LOCAL_TOOLS,
    SERVER_NAME,
    API_URL,
    // Pictures go in as files on the turn's prompt: see `promptWithImages`.
    supportsImages: true,
    _test: { runTurn, stopProcess, workspace, directoryFor, mcpFragment },
};
