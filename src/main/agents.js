const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const sandboxModule = require('./ai/sandbox');

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
    const command = clean(raw.command, 2000);
    if (!event || !command) return null;
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
const COLORS = ['sky', 'violet', 'emerald', 'amber', 'rose', 'orange', 'teal', 'slate'];

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
function normalizeServer(raw) {
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

    return {
        id: clean(raw.id, 80) || nextId('mcp'),
        name,
        transport,
        command: transport === 'stdio' ? command : '',
        args: transport === 'stdio' ? args : [],
        url: transport === 'http' ? url : '',
        env,
        headers,
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
        createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
        // The assistant settings this agent overrides. Validated by the
        // settings module on the way in and again on the way out; this only
        // has to keep it an object.
        settings: raw.settings && typeof raw.settings === 'object' ? { ...raw.settings } : {},
        mcpServers: Array.isArray(raw.mcpServers)
            ? raw.mcpServers.map(normalizeServer).filter(Boolean).slice(0, MAX_SERVERS)
            : [],
        // The envelope the agent works inside: which sessions it may drive,
        // which local folders it may touch, and whether its local footprint
        // runs in a container. See ai/sandbox.js.
        sandbox: sandboxModule.normalize(raw.sandbox),
        hooks: Array.isArray(raw.hooks) ? raw.hooks.map(normalizeHook).filter(Boolean).slice(0, MAX_HOOKS) : [],
    };
}

function fresh(name = DEFAULT_NAME, color = COLORS[0]) {
    return {
        id: nextId('agent'),
        name,
        color: COLORS.includes(color) ? color : COLORS[0],
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

    const agents = (Array.isArray(parsed?.agents) ? parsed.agents : [])
        .map(normalizeAgent)
        .filter(Boolean)
        .slice(0, MAX_AGENTS);

    // There is always one. An app with no agent has nothing to talk to, and
    // the first launch should land in a conversation rather than a setup form.
    if (agents.length === 0) agents.push(fresh());

    const activeId = agents.some(agent => agent.id === parsed?.activeId) ? parsed.activeId : agents[0].id;

    state = { version: VERSION, activeId, agents };
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
        createdAt: agent.createdAt,
        mcpServers: agent.mcpServers.map(server => ({ ...server, env: { ...server.env }, headers: { ...(server.headers || {}) } })),
        sandbox: sandboxModule.normalize(agent.sandbox),
        hooks: (agent.hooks || []).map(hook => ({ ...hook, tools: [...hook.tools] })),
    };
}

/** The hooks one agent runs, enabled ones only. */
function hooks(id) {
    return (get(id)?.hooks || []).filter(hook => hook.enabled);
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
function save({ id, name, color, mcpServers, sandbox: envelope, hooks: hookList } = {}) {
    const current = load();
    const existing = id ? current.agents.find(agent => agent.id === id) : null;

    if (existing) {
        if (name !== undefined) existing.name = clean(name) || existing.name;
        if (COLORS.includes(color)) existing.color = color;
        if (Array.isArray(mcpServers)) {
            existing.mcpServers = mcpServers.map(normalizeServer).filter(Boolean).slice(0, MAX_SERVERS);
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

    const agent = fresh(clean(name) || DEFAULT_NAME, color);
    if (Array.isArray(mcpServers)) {
        agent.mcpServers = mcpServers.map(normalizeServer).filter(Boolean).slice(0, MAX_SERVERS);
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
    DEFAULT_NAME,
};
