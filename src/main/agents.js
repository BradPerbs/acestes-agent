const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const sandboxModule = require('./ai/sandbox');
const secrets = require('./ai/secrets');

/**
 * The agents.
 *
 * An agent is the thing the app is about: it has its own conversations, its
 * own inventory (the hosts, keys, proxies, snippets and MCP servers it works
 * with) and its own settings. This file is the registry of them: which exist,
 * which one is selected, and what each one carries that no other module owns.
 *
 * What an agent *is* to the rest of the app is an id on other records. A
 * conversation carries the id of the agent it belongs to, a host the id of the
 * agent whose inventory it sits in, and the assistant settings keep a patch per
 * agent over the shared base. None of that lives here; this is the list, so a
 * deleted agent can be told apart from one that has simply not been given
 * anything yet.
 *
 * Kept in its own file under userData rather than in the store, for the same
 * reason the assistant settings are: an agent belongs to the machine its
 * runtime is on, and the store's shape is the thing that syncs between
 * machines.
 */

const VERSION = 1;
const DEFAULT_NAME = 'Acestes';
const MAX_AGENTS = 50;
const MAX_NAME = 60;
const MAX_SERVERS = 30;

const TRANSPORTS = new Set(['stdio', 'http']);

/**
 * When a hook runs. See ai/index.js `runHooks`: a command on this
 * computer, inside the agent's folders, given the event as JSON on stdin.
 * A pre-tool hook that exits 2 blocks the call with what it wrote to
 * stderr; every other hook only observes.
 */
const HOOK_EVENTS = new Set(['pre-tool', 'post-tool', 'run-start', 'run-end']);
const MAX_HOOKS = 20;

function normalizeHook(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const event = HOOK_EVENTS.has(raw.event) ? raw.event : '';
    // A hook with no command yet is the row the user just added and has not
    // finished typing into. It is kept so the card can show it, and skipped
    // by hooks() so nothing is ever run for it.
    const command = clean(raw.command, 2000);
    if (!event) return null;
    return {
        id: clean(raw.id, 80) || nextId('hook'),
        event,
        command,
        // For the tool hooks: only these tools, or every tool when empty.
        tools: Array.isArray(raw.tools) ? raw.tools.map(entry => clean(entry, 80)).filter(Boolean).slice(0, 40) : [],
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    };
}

/**
 * The colours an agent can wear, by id. The renderer holds the actual
 * gradients (`lib/agent-colors.js`); this list only has to agree with it, so
 * an id nobody can draw is refused rather than stored.
 */
const COLORS = ['sky', 'violet', 'emerald', 'amber', 'rose', 'orange', 'teal', 'slate', 'white', 'black'];

/**
 * Whether the helmet on the mark wears its crest, by id, the same way: the
 * helmet is drawn in the renderer (`components/assistant/helmet`), and this
 * list only has to agree with it. An agent saved before there was a choice
 * wears the crest.
 */
const CRESTS = ['plume', 'none'];

const filePath = () => path.join(app.getPath('userData'), 'agents.json');

let state = null;
let notify = () => {};
// The file's text as this process last read or wrote it, so a change on disk
// that is not ours can be told from the echo of our own save.
let lastWritten = '';

function setNotifier(fn) {
    notify = fn;
}

/**
 * Follow the file for edits made by anything other than this module: an
 * agent with a hand on the folder, a sync, a person in an editor. The
 * registry is otherwise a cache read once at startup, and a change it did
 * not make would not reach a window until the next launch.
 */
function watch() {
    let timer = null;
    const settle = () => {
        clearTimeout(timer);
        timer = setTimeout(reloadIfChanged, 300);
    };
    try {
        fs.mkdirSync(path.dirname(filePath()), { recursive: true });
        const watcher = fs.watch(path.dirname(filePath()), (event, file) => {
            if (file && file !== path.basename(filePath())) return;
            settle();
        });
        watcher.on('error', () => {});
        return () => watcher.close();
    } catch {
        return () => {};
    }
}

function reloadIfChanged() {
    let text = '';
    try {
        text = fs.readFileSync(filePath(), 'utf8');
    } catch {
        return;
    }
    if (text === lastWritten) return;
    state = null;
    load();
    notify('agents-changed', snapshot());
}

const clean = (value, max = MAX_NAME) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

let counter = 0;
function nextId(prefix) {
    counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * One MCP server, as an agent is given it: a command to spawn or a URL to
 * reach. Anything unreadable is dropped rather than repaired, since a server
 * definition is what an agent runs, and a guess here is a process started
 * with arguments nobody typed.
 */
/** An env or header name that is plainly a credential. */
const SECRET_LIKE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/**
 * Credentials in a server's env or headers moved into the secrets store,
 * leaving references on the record.
 *
 * Applied to every server on its way in, whichever door it came through:
 * the settings page, the agent's own save_mcp_server, or agents.json as it
 * was written before the store existed. A value in the clear lands
 * encrypted and the record keeps `{{secret:name}}`; a reference stays as
 * it is; a name that is not credential-shaped (a path, a URL) is left
 * alone. Where the store cannot encrypt, the value is kept rather than
 * lost, and tried again on the next save.
 */
function vaultCredentials(serverName, map, owner = '') {
    const out = {};
    const moved = [];
    for (const [key, raw] of Object.entries(map || {})) {
        const value = String(raw ?? '');
        if (value && SECRET_LIKE.test(key) && !/\{\{\s*secret:/.test(value)) {
            const name = `${serverName}.${key}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
            let kept = null;
            try {
                // The agent whose server it is owns it, so two agents with a
                // server of the same name each keep their own.
                kept = secrets.set(name, value, owner);
            } catch {
                // No store here (a bare test harness): kept in the clear.
            }
            if (kept?.reference) {
                out[key] = kept.reference;
                moved.push(name);
                continue;
            }
        }
        out[key] = value;
    }
    return { map: out, moved };
}

// How many credentials the current load() moved into the store, so the
// migrated file can be written back once.
let vaultedOnLoad = 0;

function normalizeServer(raw, owner = '') {
    if (!raw || typeof raw !== 'object') return null;
    const name = clean(raw.name);
    if (!name) return null;

    const transport = TRANSPORTS.has(raw.transport) ? raw.transport : 'stdio';
    const command = clean(raw.command, 500);
    const url = clean(raw.url, 500);
    if (transport === 'stdio' && !command) return null;
    if (transport === 'http' && !/^https?:\/\//i.test(url)) return null;

    const args = Array.isArray(raw.args)
        ? raw.args.map(entry => String(entry ?? '').trim()).filter(Boolean).slice(0, 50)
        : [];

    const env = {};
    if (raw.env && typeof raw.env === 'object') {
        for (const [key, value] of Object.entries(raw.env)) {
            const cleanKey = String(key).trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(cleanKey)) env[cleanKey] = String(value ?? '');
        }
    }

    // Headers for a remote server: a bearer token, an API key. Only for http;
    // a stdio server gets its secrets through env.
    const headers = {};
    if (transport === 'http' && raw.headers && typeof raw.headers === 'object') {
        for (const [key, value] of Object.entries(raw.headers)) {
            const cleanKey = String(key).trim();
            if (/^[A-Za-z0-9-]+$/.test(cleanKey) && cleanKey.length <= 80) headers[cleanKey] = String(value ?? '').slice(0, 4000);
        }
    }

    // Credentials go to the store; the record keeps references. See
    // vaultCredentials: this is the one door every server comes through.
    const vaultedEnv = vaultCredentials(name, env, owner);
    const vaultedHeaders = vaultCredentials(name, headers, owner);
    vaultedOnLoad += vaultedEnv.moved.length + vaultedHeaders.moved.length;

    return {
        id: clean(raw.id, 80) || nextId('mcp'),
        name,
        transport,
        command: transport === 'stdio' ? command : '',
        args: transport === 'stdio' ? args : [],
        url: transport === 'http' ? url : '',
        env: vaultedEnv.map,
        headers: vaultedHeaders.map,
        // Which library template it came from, if any, so the page can say.
        template: clean(raw.template, 200),
    };
}

function normalizeAgent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = clean(raw.id, 80);
    if (!id) return null;

    return {
        id,
        name: clean(raw.name) || DEFAULT_NAME,
        color: COLORS.includes(raw.color) ? raw.color : COLORS[0],
        crest: CRESTS.includes(raw.crest) ? raw.crest : CRESTS[0],
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        // The assistant settings this agent overrides. Validated by the
        // settings module on the way in and again on the way out; this only
        // has to keep it an object.
        settings: raw.settings && typeof raw.settings === 'object' ? { ...raw.settings } : {},
        mcpServers: Array.isArray(raw.mcpServers)
            ? raw.mcpServers.map(server => normalizeServer(server, id)).filter(Boolean).slice(0, MAX_SERVERS)
            : [],
        // The envelope the agent works inside: which sessions it may drive,
        // which local folders it may touch, and whether its local footprint
        // runs in a container. See ai/sandbox.js.
        sandbox: sandboxModule.normalize(raw.sandbox),
        hooks: Array.isArray(raw.hooks) ? raw.hooks.map(normalizeHook).filter(Boolean).slice(0, MAX_HOOKS) : [],
    };
}

function fresh(name = DEFAULT_NAME, color = COLORS[0], crest = CRESTS[0]) {
    return {
        id: nextId('agent'),
        name,
        color: COLORS.includes(color) ? color : COLORS[0],
        crest: CRESTS.includes(crest) ? crest : CRESTS[0],
        createdAt: Date.now(),
        settings: {},
        mcpServers: [],
        sandbox: sandboxModule.normalize(),
        hooks: [],
    };
}

function load() {
    if (state) return state;

    let parsed = null;
    try {
        const text = fs.readFileSync(filePath(), 'utf8');
        lastWritten = text;
        parsed = JSON.parse(text);
    } catch {
        // Missing or unreadable: one agent, made below.
    }

    vaultedOnLoad = 0;
    const agents = (Array.isArray(parsed?.agents) ? parsed.agents : [])
        .map(normalizeAgent)
        .filter(Boolean)
        .slice(0, MAX_AGENTS);

    // There is always one. An app with no agent has nothing to talk to, and
    // the first launch should land in a conversation rather than a setup form.
    if (agents.length === 0) agents.push(fresh());

    const activeId = agents.some(agent => agent.id === parsed?.activeId) ? parsed.activeId : agents[0].id;

    state = { version: VERSION, activeId, agents };
    // A file written before the secrets store, with a token in the clear in
    // some server's env, is rewritten now with references in its place.
    if (vaultedOnLoad > 0) persist();
    return state;
}

function persist() {
    try {
        fs.mkdirSync(path.dirname(filePath()), { recursive: true });
        const text = JSON.stringify(state, null, 2);
        lastWritten = text;
        fs.writeFileSync(filePath(), text);
    } catch (error) {
        console.error('Could not save the agents:', error.message);
    }
}

/** An agent as the renderer sees it. Settings stay with the settings module. */
function publicAgent(agent) {
    return {
        id: agent.id,
        name: agent.name,
        color: agent.color,
        crest: agent.crest,
        createdAt: agent.createdAt,
        mcpServers: agent.mcpServers.map(server => ({ ...server, env: { ...server.env }, headers: { ...(server.headers || {}) } })),
        sandbox: sandboxModule.normalize(agent.sandbox),
        hooks: (agent.hooks || []).map(hook => ({ ...hook, tools: [...hook.tools] })),
    };
}

/** The hooks one agent runs: enabled, and actually pointing at a command. */
function hooks(id) {
    return (get(id)?.hooks || []).filter(hook => hook.enabled && hook.command);
}

/** How many credentials the last load() moved into the store. For tests. */
function migratedCredentials() {
    load();
    return vaultedOnLoad;
}

/** The envelope one agent works inside, as the tool layer reads it. */
function sandbox(id) {
    return sandboxModule.normalize(get(id)?.sandbox);
}

function snapshot() {
    const current = load();
    return { activeId: current.activeId, agents: current.agents.map(publicAgent) };
}

function activeId() {
    return load().activeId;
}

function get(id) {
    return load().agents.find(agent => agent.id === id) || null;
}

/** The settings patch one agent lays over the shared base. */
function overrides(id) {
    return { ...(get(id)?.settings || {}) };
}

function setOverrides(id, patch) {
    const agent = get(id);
    if (!agent) return false;
    agent.settings = { ...patch };
    persist();
    return true;
}

function select(id) {
    const current = load();
    if (current.agents.some(agent => agent.id === id) && current.activeId !== id) {
        current.activeId = id;
        persist();
        notify('agents-changed', snapshot());
    }
    return snapshot();
}

/**
 * Create or rename an agent, or replace its MCP servers.
 *
 * A new one is selected on creation: making an agent and then having to pick
 * it is two steps for one intention.
 */
function save({ id, name, color, crest, mcpServers, sandbox: envelope, hooks: hookList } = {}) {
    const current = load();
    const existing = id ? current.agents.find(agent => agent.id === id) : null;

    if (existing) {
        if (name !== undefined) existing.name = clean(name) || existing.name;
        if (COLORS.includes(color)) existing.color = color;
        if (CRESTS.includes(crest)) existing.crest = crest;
        if (Array.isArray(mcpServers)) {
            existing.mcpServers = mcpServers.map(server => normalizeServer(server, existing.id)).filter(Boolean).slice(0, MAX_SERVERS);
        }
        if (Array.isArray(hookList)) {
            existing.hooks = hookList.map(normalizeHook).filter(Boolean).slice(0, MAX_HOOKS);
        }
        if (envelope && typeof envelope === 'object') {
            // A patch over what is there, so a page that only changes the
            // network does not have to resend the folder list.
            existing.sandbox = sandboxModule.normalize({ ...existing.sandbox, ...envelope });
        }
        persist();
        notify('agents-changed', snapshot());
        return { ...snapshot(), saved: existing.id };
    }

    if (current.agents.length >= MAX_AGENTS) {
        return { ...snapshot(), error: `At most ${MAX_AGENTS} agents.` };
    }

    const agent = fresh(clean(name) || DEFAULT_NAME, color, crest);
    if (Array.isArray(mcpServers)) {
        agent.mcpServers = mcpServers.map(server => normalizeServer(server, agent.id)).filter(Boolean).slice(0, MAX_SERVERS);
    }
    if (envelope && typeof envelope === 'object') agent.sandbox = sandboxModule.normalize(envelope);
    current.agents.push(agent);
    current.activeId = agent.id;
    persist();
    notify('agents-changed', snapshot());
    return { ...snapshot(), saved: agent.id };
}

/**
 * Delete an agent. The last one stays: see `load`.
 *
 * Its conversations and inventory are not deleted here; the caller decides
 * what becomes of them, since this module knows nothing about either.
 */
function remove(id) {
    const current = load();
    if (current.agents.length <= 1) {
        return { ...snapshot(), error: 'The last agent cannot be deleted.' };
    }
    const index = current.agents.findIndex(agent => agent.id === id);
    if (index === -1) return { ...snapshot(), error: 'No such agent.' };

    current.agents.splice(index, 1);
    if (current.activeId === id) current.activeId = current.agents[0].id;
    persist();
    notify('agents-changed', snapshot());
    return snapshot();
}

/**
 * The registry as a backup carries it: every agent whole, including the
 * settings patch each one lays over the shared base.
 *
 * MCP server env and headers travel as they are stored, which is references
 * (`{{secret:name}}`) rather than values for anything credential-shaped; the
 * values themselves travel in the secrets section of the same file.
 */
function exportAll() {
    const current = load();
    return {
        activeId: current.activeId,
        agents: current.agents.map(agent => JSON.parse(JSON.stringify(agent))),
    };
}

/**
 * Bring agents from a backup into the registry, matched on id like every
 * other collection. The local selection is kept: restoring onto a machine
 * must not yank the user onto another agent. Caps at MAX_AGENTS; anything
 * past it is skipped rather than silently dropping a local agent to fit.
 */
function importAll(payload, { overwrite = false } = {}) {
    const current = load();
    const result = { added: 0, replaced: 0, skipped: 0 };
    const incoming = Array.isArray(payload?.agents) ? payload.agents : [];

    for (const raw of incoming) {
        let record;
        try {
            record = normalizeAgent(raw);
        } catch (error) {
            console.error('Skipping an unreadable backup agent:', error.message);
            result.skipped++;
            continue;
        }
        if (!record) {
            result.skipped++;
            continue;
        }
        const index = current.agents.findIndex(entry => entry.id === record.id);
        if (index < 0) {
            if (current.agents.length >= MAX_AGENTS) {
                result.skipped++;
                continue;
            }
            current.agents.push(record);
            result.added++;
        } else if (overwrite) {
            current.agents[index] = record;
            result.replaced++;
        } else {
            result.skipped++;
        }
    }

    if (result.added > 0 || result.replaced > 0) {
        if (!current.agents.some(agent => agent.id === current.activeId)) {
            current.activeId = current.agents[0].id;
        }
        persist();
        notify('agents-changed', snapshot());
    }
    return result;
}

module.exports = {
    setNotifier,
    watch,
    snapshot,
    activeId,
    get,
    sandbox,
    hooks,
    overrides,
    setOverrides,
    select,
    save,
    remove,
    exportAll,
    importAll,
    vaultCredentials,
    migratedCredentials,
    DEFAULT_NAME,
};
