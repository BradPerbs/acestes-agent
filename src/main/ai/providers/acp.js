const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');
const { app } = require('electron');

const mcpHost = require('../mcp-host');
const mcpConfig = require('../mcp-config');
const catalog = require('../tools');
const diff = require('../diff');

/**
 * Agents that speak the Agent Client Protocol.
 *
 * ACP is the stdio protocol editors use to drive a coding agent: JSON-RPC
 * over the agent's stdin and stdout, a session per conversation, the agent's
 * text, thinking and tool calls streamed back as `session/update`
 * notifications, and the agent asking before it runs one of its own tools.
 * Qwen Code, Mistral Vibe and a growing list of others speak it, so rather than
 * a thousand-line sibling of `claude-code.js` per agent, this is one engine and
 * each of them is a short description of how to find and start it.
 *
 * What an agent gets is what every other runtime here gets:
 *
 *   - its own harness and its own login, since it is the user's install that
 *     runs, started in an empty directory of ours
 *   - our tools, over loopback from `mcp-host`, gated there by the approval
 *     policy like every runtime's; handed over as an HTTP server when the agent
 *     says it can take one, and through `mcp-bridge.js` over stdio when not
 *   - the agent's own MCP servers from the inventory, in the same session
 *   - its own tools asked about through the same approval card, with the same
 *     rules: the local-tools switch, the blocked list, and the approval mode
 *   - the model list and the effort levels it reports, and switching both on a
 *     running session
 *   - token usage per turn, when the agent reports it, for the limits page
 *
 * The protocol is young and some of it is still marked unstable (the model
 * list, config options, usage). All of it is read defensively: a field an
 * agent does not send is a feature that stays off, never an error.
 */

const SERVER_NAME = 'remote';
const PROTOCOL_VERSION = 1;

/** How long the handshake and a new session may take before it is given up on. */
const START_TIMEOUT = 60 * 1000;

/**
 * How long a turn may go without a word from the agent before it is given up
 * on. Measured from the last message, and never while one of our tools or a
 * permission card is open: a turn waiting on a person is not hung.
 */
const IDLE_TIMEOUT = 30 * 60 * 1000;

/** The app's effort scale, low to high, for mapping onto an agent's own. */
const APP_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Names an agent might give an effort level, by the app level they mean. */
const EFFORT_ALIASES = {
    low: ['low', 'minimal', 'light', 'fast'],
    medium: ['medium', 'normal', 'default', 'balanced'],
    high: ['high', 'deep'],
    xhigh: ['xhigh', 'x-high', 'extra-high', 'very-high'],
    max: ['max', 'maximum', 'ultra-high'],
    ultra: ['ultra', 'ultrathink'],
};

/** Our tools, by name, so a tool call can be told apart from the agent's own. */
const OUR_TOOLS = new Set(catalog.TOOLS.map(tool => tool.name));

/** An ACP tool kind, as the name the approval rules know a native tool by. */
const KIND_NAMES = {
    read: 'read',
    search: 'grep',
    fetch: 'webfetch',
    think: 'task',
    execute: 'bash',
    edit: 'edit',
    delete: 'delete',
    move: 'move',
};

/* ------------------------------------------------------------------ *
 * JSON-RPC over a child's stdio
 * ------------------------------------------------------------------ */

/**
 * A connection to one agent process.
 *
 * `onRequest` answers what the agent asks us (a permission, in practice), and
 * may return a promise. `onNotification` hears everything else. A message
 * that is not JSON is ignored: agents log to stdout more often than they
 * should, and a stray line is not a reason to drop the session.
 */
function connect(child, { onRequest = async () => null, onNotification = () => {}, onActivity = () => {} } = {}) {
    let nextId = 1;
    let closed = false;
    let buffer = '';
    const waiting = new Map();

    const fail = (error) => {
        for (const entry of waiting.values()) entry.reject(error);
        waiting.clear();
    };

    const send = (message) => {
        if (closed) return;
        try {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        } catch {
            // The process is gone; `close` hears about it.
        }
    };

    const handle = (message) => {
        onActivity();
        if (message.method && message.id !== undefined) {
            Promise.resolve()
                .then(() => onRequest(message.method, message.params || {}))
                .then(result => send({ jsonrpc: '2.0', id: message.id, result: result ?? null }))
                .catch(error => send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: error?.code || -32603, message: error?.message || 'The request failed.' },
                }));
            return;
        }
        if (message.method) {
            try { onNotification(message.method, message.params || {}); } catch { /* the listener's problem */ }
            return;
        }
        const entry = waiting.get(message.id);
        if (!entry) return;
        waiting.delete(message.id);
        if (message.error) {
            const error = new Error(message.error.message || 'The agent refused the request.');
            error.code = message.error.code;
            error.data = message.error.data;
            entry.reject(error);
        } else {
            entry.resolve(message.result);
        }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
            if (!line || line[0] !== '{') continue;
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            handle(message);
        }
    });

    const onGone = () => {
        if (closed) return;
        closed = true;
        fail(new Error('The agent stopped.'));
    };
    child.on('exit', onGone);
    child.on('error', onGone);

    return {
        request(method, params, { timeout = 0 } = {}) {
            if (closed) return Promise.reject(new Error('The agent stopped.'));
            const id = nextId++;
            return new Promise((resolve, reject) => {
                let timer = null;
                if (timeout) {
                    timer = setTimeout(() => {
                        waiting.delete(id);
                        reject(new Error(`The agent did not answer ${method} in time.`));
                    }, timeout);
                    timer.unref?.();
                }
                waiting.set(id, {
                    resolve: (value) => { clearTimeout(timer); resolve(value); },
                    reject: (error) => { clearTimeout(timer); reject(error); },
                });
                send({ jsonrpc: '2.0', id, method, params });
            });
        },
        notify(method, params) {
            send({ jsonrpc: '2.0', method, params });
        },
        get closed() {
            return closed;
        },
    };
}

/** Kill an agent and everything it started. On Windows that takes taskkill. */
function stopProcess(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    if (process.platform === 'win32' && child.pid) {
        const result = require('child_process').spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        if (!result.error && result.status === 0) return;
    }
    try { child.kill(); } catch { /* already gone */ }
}

/* ------------------------------------------------------------------ *
 * What goes in, what comes out
 * ------------------------------------------------------------------ */

const pairs = (map) => Object.entries(map || {}).map(([name, value]) => ({ name, value: String(value ?? '') }));

/**
 * The MCP servers a session starts with, in ACP's shape: the agent's own from
 * the inventory, then ours last so a name clash cannot shadow the app's tools.
 * HTTP where the agent can take it; otherwise a stdio command, with our own
 * server and any remote one reached through `mcp-bridge.js`.
 */
function sessionServers(settings, host, capabilities, { forceHttp = false } = {}) {
    const http = forceHttp || Boolean(capabilities?.mcpCapabilities?.http);
    const bridge = (name, address) => ({
        name,
        command: process.execPath,
        args: [path.join(__dirname, '..', 'mcp-bridge.js'), address],
        env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }],
    });

    const out = [];
    const own = mcpConfig.agentServers(
        (settings.mcpServers || []).filter(entry => entry?.name !== SERVER_NAME),
        settings.sandbox,
        settings.agentId,
    );
    for (const [name, spec] of Object.entries(own)) {
        if (spec.type === 'http') {
            // A header cannot ride on a bridged address, so a remote server
            // that needs one is only offered to an agent that speaks HTTP.
            if (http) out.push({ type: 'http', name, url: spec.url, headers: pairs(spec.headers) });
            else if (!spec.headers || Object.keys(spec.headers).length === 0) out.push(bridge(name, spec.url));
        } else {
            out.push({ name, command: spec.command, args: spec.args || [], env: pairs(spec.env) });
        }
    }
    if (host) {
        out.push(http
            ? { type: 'http', name: SERVER_NAME, url: host.url, headers: [{ name: 'Authorization', value: `Bearer ${host.token}` }] }
            : bridge(SERVER_NAME, host.tokenUrl));
    }
    return out;
}

/** An app effort level for one of an agent's own level names, or ''. */
function appEffortFor(value) {
    const name = String(value || '').toLowerCase();
    for (const [level, aliases] of Object.entries(EFFORT_ALIASES)) {
        if (aliases.includes(name)) return level;
    }
    return '';
}

/** The agent's own level for an app level, rounding down to one it has. */
function agentEffortFor(options, level) {
    if (!Array.isArray(options) || options.length === 0) return '';
    const byLevel = new Map(options.map(option => [appEffortFor(option.value) || appEffortFor(option.name), option.value]));
    const wanted = APP_EFFORTS.indexOf(level);
    for (let index = wanted < 0 ? APP_EFFORTS.length - 1 : wanted; index >= 0; index -= 1) {
        if (byLevel.has(APP_EFFORTS[index])) return byLevel.get(APP_EFFORTS[index]);
    }
    return '';
}

/** A select option list, flattened out of any groups it is in. */
function optionsOf(config) {
    const list = Array.isArray(config?.options) ? config.options : [];
    return list.flatMap(entry => (Array.isArray(entry?.options) ? entry.options : [entry]))
        .filter(option => option && option.value !== undefined)
        .map(option => ({ value: String(option.value), name: String(option.name || option.value), description: String(option.description || '') }));
}

/**
 * The session's config options, sorted into the two the app has a control
 * for. An agent can offer the model list either as the older `models` field
 * or as a config option in the `model` category; the reasoning level only as
 * a `thought_level` one.
 */
function readSession(session) {
    const configs = Array.isArray(session?.configOptions) ? session.configOptions : [];
    // By category where the agent sets one, and by the ids agents are known
    // to use where it does not: Qwen's `reasoning_effort`, Vibe's `thinking`.
    const modelConfig = configs.find(config => config?.category === 'model')
        || configs.find(config => config?.id === 'model');
    const effortConfig = configs.find(config => config?.category === 'thought_level')
        || configs.find(config => ['reasoning_effort', 'thinking', 'thought_level', 'effort'].includes(config?.id));
    const models = modelConfig
        ? { list: optionsOf(modelConfig), current: String(modelConfig.currentValue || ''), configId: modelConfig.id }
        : {
            list: (session?.models?.availableModels || []).map(model => ({
                value: String(model.modelId || ''),
                name: String(model.name || model.modelId || ''),
                description: String(model.description || ''),
            })).filter(model => model.value),
            current: String(session?.models?.currentModelId || ''),
            configId: '',
        };
    return {
        models,
        effort: effortConfig ? { configId: effortConfig.id, options: optionsOf(effortConfig), current: String(effortConfig.currentValue || '') } : null,
        modes: session?.modes || null,
    };
}

/** The session's models, as the rows the composer's menu draws. */
function describeModels(state) {
    const levels = state.effort
        ? APP_EFFORTS.filter(level => agentEffortFor(state.effort.options, level) && appEffortFor(agentEffortFor(state.effort.options, level)) === level)
        : [];
    return state.models.list.slice(0, 60).map(model => ({
        value: model.value,
        resolved: model.value,
        label: model.name,
        short: model.name.replace(/\s*\([^)]*\)\s*$/, ''),
        description: model.description.slice(0, 200),
        preferred: model.value === state.models.current,
        effort: levels,
    }));
}

/** A tool call's text, however the agent wrapped it. */
function flattenContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((block) => {
        if (block?.type === 'content') return flattenContent([block.content]);
        if (block?.type === 'text') return block.text || '';
        if (block?.type === 'diff') return `${block.path || ''}`;
        if (block?.type === 'terminal') return '';
        return '';
    }).filter(Boolean).join('\n');
}

/** The first file change in a tool call's content, as the app's diff. */
function diffOf(content) {
    const block = (Array.isArray(content) ? content : []).find(entry => entry?.type === 'diff');
    if (!block) return null;
    try {
        return diff.fromToolInput('edit', { file_path: block.path || '', old_string: block.oldText ?? '', new_string: block.newText ?? '' });
    } catch {
        return null;
    }
}

/**
 * Whether a tool call is one of ours, reached through `mcp-host`, rather than
 * one of the agent's own. Agents name MCP calls every which way
 * (`remote__run_command`, `mcp__remote__run_command`, `run_command (remote MCP
 * Server)`), so it is read off the title and the tool-name hints together.
 *
 * Getting this wrong in the "ours" direction is safe: our tools are gated in
 * mcp-host whatever is decided here.
 */
function ourTool(call) {
    // The server has to be named, not merely the tool: agents ship native
    // tools called `read_file` and `write_file` too, and one of those taken
    // for ours would skip the approval card entirely.
    const server = call?.server || call?._meta?.server || call?._meta?.serverName;
    const names = [call?._meta?.toolName, call?._meta?.tool, call?.toolName, call?.name, call?.title]
        .filter(Boolean).map(String);
    const marked = /(^|[^a-z])remote([^a-z]|$)/i;
    for (const name of names) {
        const bare = name
            .replace(/^mcp__remote__/, '')
            .replace(/^mcp_remote_/, '')
            .replace(/^remote(__|\.|\/|:)/, '')
            .split(/[\s(]/)[0];
        if (!OUR_TOOLS.has(bare)) continue;
        if (server === SERVER_NAME || (bare !== name && marked.test(name))) return bare;
    }
    return '';
}

/** Token counts from ACP's usage shape, in the shape `limits.js` reads. */
function usageOf(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return {
        input_tokens: n(usage.inputTokens ?? usage.input_tokens),
        output_tokens: n(usage.outputTokens ?? usage.output_tokens) + n(usage.thoughtTokens ?? usage.thought_tokens),
        cache_read_input_tokens: n(usage.cachedReadTokens ?? usage.cached_read_tokens ?? usage.cachedInputTokens),
    };
}

/** A directory of ours for one agent to run in, empty of anything of the user's. */
function workspace(id) {
    let root;
    try {
        root = app.getPath('userData');
    } catch {
        root = os.tmpdir();
    }
    const directory = path.join(root, 'agent-workspaces', id);
    try { fs.mkdirSync(directory, { recursive: true }); } catch { /* the spawn says so */ }
    return directory;
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

/**
 * Make a provider for one ACP agent.
 *
 *   id             the provider's name in the settings
 *   label          what the agent is called in messages
 *   find()         the executable, or '' when it is not installed
 *   args(settings) how to start it in ACP mode
 *   env(settings)  anything else its environment needs
 *   notInstalled   what to say when `find` comes back empty
 *   signInHint     the command that signs it in, for the failure message
 *   authMethods    method ids to try, in order, when a session needs one
 *   supportsImages whether the composer may attach pictures for it
 *   detect()       optional: `{ ok, reason }` beyond "the binary is here"
 */
function createAcpProvider(spec) {
    const envFor = (settings) => ({
        ...process.env,
        ...(settings?.accountEnv || {}),
        ...(spec.env ? spec.env(settings || {}) : {}),
    });

    const launch = (settings) => {
        // A spec can name the whole command (Cursor runs its own bundled
        // node on Windows) or just the binary and its arguments.
        const command = spec.command
            ? spec.command(settings || {})
            : (spec.find() ? { command: spec.find(), args: spec.args ? spec.args(settings || {}) : [] } : null);
        if (!command) throw new Error(spec.notInstalled || `${spec.label} is not installed on this machine.`);
        const child = spawn(command.command, command.args, {
            cwd: workspace(spec.id),
            env: envFor(settings),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
        return { child, stderr: () => stderr };
    };

    const describeFailure = (error, stderr = '') => {
        const text = `${error?.message || error || ''}`;
        const combined = `${text}\n${stderr}`;
        if (error?.code === -32000 || /auth|log ?in|sign ?in|credential|api[_ -]?key|unauthori[sz]ed|401/i.test(combined)) {
            return `${spec.label} is not signed in on this machine.${spec.signInHint ? ` ${spec.signInHint}` : ''}`;
        }
        if (/ENOENT|not found|spawn/i.test(text)) {
            return `${spec.label} could not be started. Check that it is installed and runs in a terminal. (${text})`;
        }
        const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
        return last && !text.includes(last) ? `${text} (${last.slice(0, 300)})` : text;
    };

    /** A new session, signing in first when the agent asks for it and a method is known. */
    async function openSession(rpc, params, init) {
        try {
            return await rpc.request('session/new', params, { timeout: START_TIMEOUT });
        } catch (error) {
            const methods = (init?.authMethods || []).map(method => method.id);
            const choice = (spec.authMethods || []).find(id => methods.includes(id));
            if (!choice || !/auth/i.test(`${error.message} ${error.code}`)) throw error;
            await rpc.request('authenticate', { methodId: choice }, { timeout: START_TIMEOUT });
            return rpc.request('session/new', params, { timeout: START_TIMEOUT });
        }
    }

    async function handshake(rpc, meta = spec.clientMeta) {
        return rpc.request('initialize', {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                ...(meta ? { _meta: meta } : {}),
            },
            clientInfo: { name: 'acestes-agent', title: 'Acestes Agent', version: safeVersion() },
        }, { timeout: START_TIMEOUT });
    }

    async function start({
        settings,
        getSettings = () => settings,
        systemPrompt,
        toolContext,
        requestApproval,
        onEvent,
        resumeSessionId = '',
    }) {
        const host = await mcpHost.acquire({ toolContext, requestApproval, onEvent });
        let proc;
        try {
            proc = launch(settings);
        } catch (error) {
            await mcpHost.release(host.token);
            throw error;
        }
        const { child } = proc;

        let lastActivity = Date.now();
        let replaying = false;
        let turn = null;
        const permissions = new Set();

        const rpc = connect(child, {
            onActivity: () => { lastActivity = Date.now(); },
            onNotification: (method, params) => {
                if (method === 'session/update' && !replaying) turn?.update(params.update || {});
            },
            onRequest: (method, params) => {
                if (method === 'session/request_permission') return askPermission(params);
                // Nothing else was offered in the handshake; say so plainly.
                const error = new Error(`${method} is not supported by this client.`);
                error.code = -32601;
                throw error;
            },
        });

        const cleanup = async () => {
            stopProcess(child);
            await mcpHost.release(host.token);
        };

        let init;
        let sessionId = '';
        let state;
        const cwd = workspace(spec.id);
        try {
            init = await handshake(rpc);
            const capabilities = init?.agentCapabilities || {};
            const mcpServers = sessionServers(settings, host, capabilities, { forceHttp: Boolean(spec.mcpHttp) });

            if (resumeSessionId && capabilities.loadSession) {
                // The agent replays the whole conversation as updates while it
                // loads. The transcript already has it; hearing it again would
                // draw every message twice.
                replaying = true;
                try {
                    const loaded = await rpc.request('session/load', { sessionId: resumeSessionId, cwd, mcpServers }, { timeout: START_TIMEOUT });
                    sessionId = resumeSessionId;
                    state = readSession(loaded || {});
                } catch {
                    // Gone or unreadable: a new one, and the transcript carries on.
                } finally {
                    replaying = false;
                }
            }
            if (!sessionId) {
                const created = await openSession(rpc, { cwd, mcpServers }, init);
                sessionId = created.sessionId;
                state = readSession(created);
            }
        } catch (error) {
            const message = describeFailure(error, proc.stderr());
            await cleanup();
            throw new Error(message);
        }

        const capabilities = init?.agentCapabilities || {};
        onEvent({ type: 'session', sessionId, model: state.models.current });
        const rows = describeModels(state);
        if (rows.length) onEvent({ type: 'models', models: rows });

        async function applyModel(model) {
            if (!model || model === state.models.current) return;
            try {
                if (state.models.configId) {
                    await rpc.request('session/set_config_option', { sessionId, configId: state.models.configId, value: model });
                } else {
                    await rpc.request('session/set_model', { sessionId, modelId: model });
                }
                state.models.current = model;
            } catch {
                // An agent that cannot switch keeps what it had.
            }
        }

        let currentMode = '';
        /** The agent's own permission mode for the app's approval setting, if the spec maps one. */
        async function applyMode(current) {
            const wanted = spec.modeFor ? spec.modeFor(current || {}) : '';
            if (!wanted || wanted === currentMode) return;
            const offered = (state.modes?.availableModes || []).map(mode => mode.id);
            if (offered.length && !offered.includes(wanted)) return;
            try {
                await rpc.request('session/set_mode', { sessionId, modeId: wanted });
                currentMode = wanted;
            } catch {
                // Kept on the agent's default.
            }
        }

        async function applyEffort(level) {
            if (!state.effort || !level) return;
            const value = agentEffortFor(state.effort.options, level);
            if (!value || value === state.effort.current) return;
            try {
                await rpc.request('session/set_config_option', { sessionId, configId: state.effort.configId, value });
                state.effort.current = value;
            } catch {
                // As above.
            }
        }

        await applyModel(settings.model);
        await applyEffort(settings.effort);
        await applyMode(settings);

        /**
         * The agent asking before one of its own tools runs. Ours are let
         * through, since `mcp-host` asks about those itself; the agent's are
         * put to the same rules the Claude provider applies to Claude Code's.
         */
        async function askPermission(params) {
            const call = params.toolCall || {};
            const options = Array.isArray(params.options) ? params.options : [];
            const known = turn?.tools.get(call.toolCallId) || {};
            const pick = (...kinds) => options.find(option => kinds.includes(option.kind));
            const allow = () => {
                const option = pick('allow_once') || pick('allow_always') || options[0];
                return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
            };
            const reject = () => {
                const option = pick('reject_once') || pick('reject_always');
                return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
            };

            if (ourTool({ ...known.call, ...call })) return allow();

            // A question from the agent put as a permission, one option per
            // answer (Cursor does this). Choosing "allow" would pick an answer
            // for the person, so it is skipped and the agent carries on.
            if (options.some(option => /ask_question|skip/i.test(String(option.optionId || '')))) return reject();

            const current = getSettings();
            const kind = call.kind || known.call?.kind || 'other';
            const input = call.rawInput || known.call?.rawInput || {};
            const title = call.title || known.call?.title || spec.label;

            if (!current.allowLocalTools && kind !== 'fetch') {
                return reject();
            }
            if (kind === 'execute') {
                const command = String(input.command ?? input.cmd ?? (Array.isArray(input.args) ? input.args.join(' ') : '') ?? '');
                const blocked = catalog.blockedReason('run_local_command', { command }, current);
                if (blocked) {
                    onEvent({ type: 'tool-blocked', name: title, rule: blocked });
                    return reject();
                }
            }
            if (catalog.nativeAutoApproved(KIND_NAMES[kind] || kind, input, current)) return allow();

            // Held so a cancelled turn can answer every open question at once,
            // which the protocol requires of a client that cancels.
            let settle;
            const cancelled = new Promise((resolve) => { settle = resolve; });
            permissions.add(settle);
            try {
                const verdict = await Promise.race([
                    requestApproval({ toolName: title, name: title, input, local: true }),
                    cancelled.then(() => null),
                ]);
                if (!verdict) return { outcome: { outcome: 'cancelled' } };
                return verdict.approved ? allow() : reject();
            } finally {
                permissions.delete(settle);
            }
        }

        let preamble = systemPrompt || '';
        let queue = Promise.resolve();
        let cancelling = false;
        // The running totals of an agent that reports them per session.
        let totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
        let totalCost = 0;

        function newTurn() {
            let text = '';
            let thinking = false;
            let usage = null;
            let cost = 0;
            // Usage an agent reports per model round on its message chunks,
            // summed over the turn.
            const rounds = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, seen: false };
            const tools = new Map();

            const flush = () => {
                if (text.trim()) onEvent({ type: 'assistant-text', text });
                text = '';
            };

            const announce = (id, call) => {
                const ours = ourTool(call);
                onEvent({
                    type: 'tool-call',
                    id,
                    name: ours || call.title || call.kind || 'tool',
                    rawName: call.title || '',
                    local: !ours,
                    input: call.rawInput || {},
                    ...(diffOf(call.content) ? { diff: diffOf(call.content) } : {}),
                });
            };

            return {
                tools,
                flush,
                usage: () => usage || (rounds.seen ? { input_tokens: rounds.input_tokens, output_tokens: rounds.output_tokens, cache_read_input_tokens: rounds.cache_read_input_tokens } : null),
                cost: () => cost,
                update(update) {
                    switch (update.sessionUpdate) {
                        case 'agent_message_chunk': {
                            const round = usageOf(update._meta?.usage);
                            if (round) {
                                rounds.seen = true;
                                rounds.input_tokens += round.input_tokens;
                                rounds.output_tokens += round.output_tokens;
                                rounds.cache_read_input_tokens += round.cache_read_input_tokens;
                            }
                            const chunk = update.content?.type === 'text' ? update.content.text || '' : '';
                            if (!chunk) return;
                            text += chunk;
                            onEvent({ type: 'text-delta', text: chunk });
                            return;
                        }
                        case 'agent_thought_chunk': {
                            const chunk = update.content?.type === 'text' ? update.content.text || '' : '';
                            if (!chunk) return;
                            if (!thinking) {
                                thinking = true;
                                onEvent({ type: 'thinking-start' });
                            }
                            onEvent({ type: 'thinking-delta', text: chunk });
                            return;
                        }
                        case 'tool_call': {
                            flush();
                            const id = update.toolCallId;
                            tools.set(id, { call: update, announced: true });
                            announce(id, update);
                            if (update.status === 'completed' || update.status === 'failed') {
                                onEvent({ type: 'tool-result', id, isError: update.status === 'failed', text: flattenContent(update.content) });
                            }
                            return;
                        }
                        case 'tool_call_update': {
                            const id = update.toolCallId;
                            const entry = tools.get(id) || { call: {}, announced: false };
                            entry.call = { ...entry.call, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) };
                            tools.set(id, entry);
                            if (!entry.announced) {
                                flush();
                                entry.announced = true;
                                announce(id, entry.call);
                            }
                            if (update.status === 'completed' || update.status === 'failed') {
                                const output = flattenContent(update.content) || (typeof update.rawOutput === 'string' ? update.rawOutput : update.rawOutput ? JSON.stringify(update.rawOutput) : '');
                                onEvent({ type: 'tool-result', id, isError: update.status === 'failed', text: output });
                            }
                            return;
                        }
                        case 'usage_update': {
                            // Context size, and on some agents a running cost.
                            if (update.cost?.currency === 'USD' && Number.isFinite(Number(update.cost.amount))) cost = Number(update.cost.amount);
                            return;
                        }
                        case 'config_option_update':
                        case 'current_mode_update': {
                            if (Array.isArray(update.configOptions)) Object.assign(state, readSession({ configOptions: update.configOptions }));
                            return;
                        }
                        default:
                            return;
                    }
                },
                setUsage(value) {
                    usage = value;
                },
                setCost(value) {
                    cost = value;
                },
            };
        }

        async function runTurn(text, images) {
            const current = getSettings();
            await applyModel(current.model);
            await applyEffort(current.effort);
            await applyMode(current);

            const body = preamble ? `${preamble}\n\n---\n\n${text}` : text;
            preamble = '';
            const prompt = [];
            if (capabilities.promptCapabilities?.image) {
                for (const image of images || []) prompt.push({ type: 'image', mimeType: image.mediaType, data: image.data });
            }
            prompt.push({ type: 'text', text: body || 'See the attached image.' });

            turn = newTurn();
            cancelling = false;
            lastActivity = Date.now();

            // Given up on only after a long silence with nothing open: no tool
            // call in mcp-host and no card waiting on the user.
            const watchdog = setInterval(() => {
                const busy = mcpHost.pending(host.token) > 0 || permissions.size > 0;
                if (!busy && Date.now() - lastActivity > IDLE_TIMEOUT) {
                    rpc.notify('session/cancel', { sessionId });
                }
            }, 30 * 1000);
            watchdog.unref?.();

            try {
                const response = await rpc.request('session/prompt', { sessionId, prompt });
                turn.flush();
                const reason = response?.stopReason || 'end_turn';
                let reported = usageOf(response?.usage);
                // An agent whose totals run for the whole session (Vibe) is
                // turned into this turn's share by the difference.
                if (reported && spec.cumulativeUsage) {
                    const delta = {
                        input_tokens: Math.max(0, reported.input_tokens - totals.input_tokens),
                        output_tokens: Math.max(0, reported.output_tokens - totals.output_tokens),
                        cache_read_input_tokens: Math.max(0, reported.cache_read_input_tokens - totals.cache_read_input_tokens),
                    };
                    totals = reported;
                    reported = delta;
                }
                turn.setUsage(reported);
                if (spec.cumulativeUsage) {
                    const spent = Math.max(0, turn.cost() - totalCost);
                    totalCost = turn.cost() || totalCost;
                    turn.setCost(spent);
                }
                onEvent({
                    type: 'result',
                    subtype: reason === 'end_turn' ? 'success' : reason,
                    isError: reason === 'refusal',
                    costUsd: turn.cost(),
                    usage: turn.usage(),
                    turns: 1,
                    sessionId,
                });
            } catch (error) {
                turn.flush();
                if (!cancelling) onEvent({ type: 'error', message: describeFailure(error, proc.stderr()) });
                onEvent({ type: 'result', subtype: cancelling ? 'cancelled' : 'error', isError: !cancelling, costUsd: turn.cost(), usage: null });
            } finally {
                clearInterval(watchdog);
            }
        }

        // The process going away between turns is a closed conversation; the
        // next message starts it again and resumes the session if it can.
        child.on('exit', () => onEvent({ type: 'closed' }));

        return {
            /** Whether the process has gone, so the next message starts it again. */
            get stopped() {
                return rpc.closed;
            },
            send(text, images = []) {
                queue = queue.then(() => runTurn(text, images)).catch(() => {});
            },
            async setModel(model) {
                await applyModel(model);
            },
            async setEffort(effort) {
                await applyEffort(effort);
            },
            async interrupt() {
                cancelling = true;
                for (const settle of [...permissions]) settle();
                rpc.notify('session/cancel', { sessionId });
            },
            async close() {
                cancelling = true;
                for (const settle of [...permissions]) settle();
                if (!rpc.closed) rpc.notify('session/cancel', { sessionId });
                await cleanup();
            },
        };
    }

    /**
     * What the installed agent can run, read by opening a session and
     * closing it again. A new session starts nothing with a model, so this
     * costs a second of startup and no tokens.
     */
    async function listModels({ settings = {} } = {}) {
        if (!spec.find()) return null;
        let proc;
        try {
            proc = launch(settings);
        } catch {
            return null;
        }
        const rpc = connect(proc.child);
        try {
            const init = await handshake(rpc);
            const created = await openSession(rpc, { cwd: workspace(spec.id), mcpServers: [] }, init);
            const rows = describeModels(readSession(created));
            return rows.length ? rows : null;
        } catch (error) {
            console.error(`Could not read the model list from ${spec.label}:`, describeFailure(error, proc.stderr()));
            return null;
        } finally {
            stopProcess(proc.child);
        }
    }

    /**
     * Bring the agent up, run `fn(rpc, init)` against it, and put it down,
     * for the questions that need no conversation: sign-in state, the
     * account, signing in.
     */
    async function withAgent(settings, fn, { timeout = START_TIMEOUT, onSpawn = () => {} } = {}) {
        const proc = launch(settings || {});
        onSpawn(proc.child);
        const rpc = connect(proc.child);
        const timer = setTimeout(() => stopProcess(proc.child), timeout);
        timer.unref?.();
        try {
            const init = await handshake(rpc, spec.clientMeta);
            return await fn(rpc, init);
        } finally {
            clearTimeout(timer);
            stopProcess(proc.child);
        }
    }

    function detect(options) {
        if (!spec.find()) return { ok: false, reason: 'notFound' };
        return spec.detect ? spec.detect(options) : { ok: true, reason: '' };
    }

    return {
        start,
        listModels,
        detect,
        withAgent,
        supportsImages: Boolean(spec.supportsImages),
        SERVER_NAME,
    };
}

function safeVersion() {
    try {
        return app.getVersion();
    } catch {
        return '0.0.0';
    }
}

/* ------------------------------------------------------------------ *
 * Finding a binary
 * ------------------------------------------------------------------ */

/**
 * The first of these names that is a real file on PATH or in one of the
 * extra folders, or ''. On Windows the npm shims (`.cmd`) are accepted:
 * `cross-spawn` starts them properly, which Node's own spawn will not.
 */
function findBinary(names, { extra = [], env = process.env, platform = process.platform } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const pathEntries = String(env.PATH || env.Path || env.path || '').split(windows ? ';' : ':').filter(Boolean);
    const roots = [...new Set([...pathEntries, ...extra.filter(Boolean)])];
    const suffixes = windows ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const root of roots) {
        for (const name of names) {
            for (const suffix of suffixes) {
                const candidate = paths.join(root, name + suffix);
                try {
                    const stat = fs.statSync(candidate);
                    if (stat.isFile() && stat.size > 0) return candidate;
                } catch {
                    // Keep looking.
                }
            }
        }
    }
    return '';
}

/** The folders package managers put CLIs in, beyond PATH. */
function commonRoots({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const roots = [
        paths.join(home, '.local', 'bin'),
        paths.join(home, 'bin'),
        paths.join(home, '.bun', 'bin'),
        paths.join(home, '.npm-global', 'bin'),
        paths.join(home, '.cargo', 'bin'),
    ];
    if (windows) {
        const appData = env.APPDATA || paths.join(home, 'AppData', 'Roaming');
        const local = env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local');
        roots.push(
            paths.join(appData, 'npm'),
            paths.join(local, 'pnpm'),
            paths.join(home, 'scoop', 'shims'),
            paths.join(appData, 'Python', 'Scripts'),
            paths.join(local, 'Programs', 'Python', 'Scripts'),
        );
    } else {
        roots.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
    }
    return roots;
}

module.exports = {
    createAcpProvider,
    findBinary,
    commonRoots,
    stopProcess,
    connect,
    _test: { sessionServers, readSession, describeModels, agentEffortFor, appEffortFor, ourTool, usageOf, flattenContent },
};
