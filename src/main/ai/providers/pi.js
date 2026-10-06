const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const spawn = require('cross-spawn');
const { app } = require('electron');

const mcpHost = require('../mcp-host');
const catalog = require('../tools');
const acp = require('./acp');

/**
 * The Pi provider.
 *
 * Pi is the minimal terminal agent from Earendil (`pi`). It has no MCP and
 * never asks before a tool runs, both on purpose, and it has an RPC mode and
 * extensions. This drives `pi --mode rpc` with one extension of ours loaded
 * (`pi-extension.mjs`), which is where the parity with the other agents comes
 * from:
 *
 *   - the extension registers the app's tools, calling them in `mcp-host`,
 *     where they are gated like every runtime's
 *   - the extension puts every call to one of Pi's own tools to the client as
 *     a `confirm`, which arrives here as an `extension_ui_request` and is
 *     answered under the app's approval rules: the local-tools switch, the
 *     blocked list, the approval mode, the card
 *
 * Everything else is Pi's RPC: `prompt`, `abort`, `set_model`,
 * `set_thinking_level`, streamed message and tool events, `agent_settled` for
 * the end of a turn, and per-message usage with a cost in dollars (which Pi
 * works out from list prices, subscription or not).
 *
 * The session id is ours: `--session-id` opens that session or creates it,
 * so resuming a conversation is starting Pi with the same id. The home moves
 * with PI_CODING_AGENT_DIR, which is what lets two accounts sit side by side.
 */

const LABEL = 'Pi';
const START_TIMEOUT = 60 * 1000;
const IDLE_TIMEOUT = 30 * 60 * 1000;

/** Pi's thinking levels, by the app level they stand for. */
const THINKING = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' };
const APPROVAL = 'acestes:approve';
const OUR_TOOLS = new Set(catalog.TOOLS.map(tool => tool.name));

let override = null;

function findPi({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const agentDir = env.PI_CODING_AGENT_DIR || paths.join(home, '.pi', 'agent');
    const extra = [paths.join(agentDir, 'bin'), ...acp.commonRoots({ env, home, platform })];
    return acp.findBinary(['pi'], { extra, env, platform });
}

function commandFor(args) {
    if (override) return { command: override.command, args: [...override.args, ...args] };
    const binary = findPi();
    return binary ? { command: binary, args } : null;
}

/** The extension, where Pi can read it: outside the asar in a packaged app. */
function extensionPath() {
    return path.join(__dirname, '..', 'pi-extension.mjs').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function workspace() {
    let root;
    try { root = app.getPath('userData'); } catch { root = os.tmpdir(); }
    const directory = path.join(root, 'agent-workspaces', 'pi');
    try { fs.mkdirSync(directory, { recursive: true }); } catch { /* the spawn says so */ }
    return directory;
}

/**
 * A connection to `pi --mode rpc`: commands with an id get a `response`
 * back, everything else is an event. Split on LF only, as Pi asks, since its
 * records can carry U+2028 inside strings.
 */
function connect(child, { onEvent = () => {}, onActivity = () => {} } = {}) {
    let buffer = '';
    let nextId = 1;
    let closed = false;
    const waiting = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        onActivity();
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
            if (!line.trim() || line.trimStart()[0] !== '{') continue;
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (message.type === 'response' && message.id && waiting.has(message.id)) {
                const entry = waiting.get(message.id);
                waiting.delete(message.id);
                if (message.success === false) entry.reject(new Error(message.error || `${message.command} failed.`));
                else entry.resolve(message.data);
                continue;
            }
            try { onEvent(message); } catch { /* the listener's problem */ }
        }
    });
    const gone = () => {
        if (closed) return;
        closed = true;
        for (const entry of waiting.values()) entry.reject(new Error('Pi stopped.'));
        waiting.clear();
    };
    child.on('exit', gone);
    child.on('error', gone);
    const write = (message) => {
        if (closed) return;
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { /* gone */ }
    };
    return {
        send(type, fields = {}, { timeout = 0 } = {}) {
            if (closed) return Promise.reject(new Error('Pi stopped.'));
            const id = `r${nextId++}`;
            return new Promise((resolve, reject) => {
                let timer = null;
                if (timeout) {
                    timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Pi did not answer ${type} in time.`)); }, timeout);
                    timer.unref?.();
                }
                waiting.set(id, {
                    resolve: (value) => { clearTimeout(timer); resolve(value); },
                    reject: (error) => { clearTimeout(timer); reject(error); },
                });
                write({ id, type, ...fields });
            });
        },
        write,
        get closed() { return closed; },
    };
}

/** A context window as `128k` or `1M`: millions from 1,000,000 up, not `1024k`. */
function formatContextWindow(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1000000) {
        const m = n / 1000000;
        const text = m >= 10
            ? String(Math.round(m))
            : String(Math.round(m * 10) / 10).replace(/\.0$/, '');
        return `${text}M`;
    }
    return `${Math.round(n / 1000)}k`;
}

/** `get_available_models`, as the composer's rows. */
function describeModels(data) {
    const list = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    return list.filter(model => model?.id && model?.provider).slice(0, 500).map(model => ({
        value: `${model.provider}/${model.id}`,
        resolved: model.id,
        label: model.name || model.id,
        short: String(model.name || model.id).replace(/\s*\([^)]*\)\s*$/, ''),
        description: `${model.provider}${model.contextWindow ? ` · ${formatContextWindow(model.contextWindow)} context` : ''}`,
        preferred: false,
        // Pi clamps a level to what the model has, so every level is safe to
        // offer on a model that reasons at all.
        effort: model.reasoning ? ['low', 'medium', 'high', 'xhigh', 'max'] : [],
    }));
}

function usageOf(total) {
    if (!total) return null;
    return { input_tokens: total.input, output_tokens: total.output, cache_read_input_tokens: total.cacheRead };
}

function describeFailure(error, stderr = '') {
    const text = `${error?.message || error || ''}`;
    if (/credentials_not_configured|no api key|not logged in|unauthori[sz]ed|401|auth/i.test(`${text}\n${stderr}`)) {
        return 'Pi has no credentials for this model. Run "pi" in a terminal and use /login, or set the provider\'s API key, then try again.';
    }
    if (/ENOENT|not found|spawn/i.test(text)) {
        return `Pi could not be started. Check that "pi" runs in a terminal. (${text})`;
    }
    const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
    // The Hint (`-ne`) is always the last line, never the cause. Prefer the
    // first error-ish line (extension/acestes crash) so the message names
    // the culprit instead of sending everyone to retry without extensions.
    const culprit = lines.find(line => /acestes:|extension.*(fail|error|crash)|typebox|ERR_MODULE|Cannot find/i.test(line))
        || lines.find(line => /error|fail|crash|exception/i.test(line) && !/Hint:/i.test(line))
        || lines.pop();
    if (culprit && !text.includes(culprit)) {
        const hint = lines.find(line => /Hint:/i.test(line));
        const suffix = hint && !culprit.includes(hint) ? ` [${hint.trim().slice(0, 120)}]` : '';
        return `${text} (${culprit.slice(0, 300)}${suffix})`;
    }
    return text;
}

function launch(settings, { sessionId = '', host = null, rpcArgs = [] } = {}) {
    const current = settings || {};
    const model = String(current.model || '');
    const args = [
        '--mode', 'rpc',
        '--no-themes',
        // Hermetic runs: the user's Pi packages (e.g. pi-blackhole's
        // `recall`) would otherwise load beside our extension and kill Pi
        // on a name clash. Explicit `-e` still loads under --no-extensions.
        ...(host ? ['--no-extensions', '-e', extensionPath()] : []),
        ...(sessionId ? ['--session-id', sessionId] : ['--no-session']),
        ...(model ? ['--model', model] : []),
        ...(THINKING[current.effort] ? ['--thinking', THINKING[current.effort]] : []),
        // With the local-tools switch off Pi keeps only the app's tools.
        ...(host && current.allowLocalTools === false ? ['--no-builtin-tools'] : []),
        ...rpcArgs,
    ];
    const command = commandFor(args);
    if (!command) throw new Error('Pi is not installed on this machine. Install it with "npm install -g @earendil-works/pi-coding-agent", then try again.');
    const child = spawn(command.command, command.args, {
        cwd: workspace(),
        env: { ...process.env, ...(current.accountEnv || {}), ...(host ? { ACESTES_MCP_URL: host.tokenUrl } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    return { child, stderr: () => stderr };
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
    // Bare provider CLI: no app tools attached, so no extension and no MCP
    // URL either — Pi runs exactly as it does in a terminal, and its own
    // permission model answers for its native tools.
    const host = settings?.bareProvider ? null : await mcpHost.acquire({ toolContext, requestApproval, onEvent });
    const sessionId = resumeSessionId || crypto.randomUUID();
    let proc;
    try {
        proc = launch(settings, { sessionId, host });
    } catch (error) {
        if (host) await mcpHost.release(host.token);
        throw error;
    }
    const { child } = proc;

    let lastActivity = Date.now();
    let turn = null;
    const cards = new Set();
    let currentModel = String(settings.model || '');
    let currentThinking = THINKING[settings.effort] || '';

    const rpc = connect(child, {
        onActivity: () => { lastActivity = Date.now(); },
        onEvent: (message) => {
            if (message.type === 'extension_ui_request') {
                answerUi(message);
                return;
            }
            turn?.event(message);
        },
    });

    /** The extension's `confirm` for one of Pi's own tools, answered under the app's rules. */
    async function answerUi(request) {
        const respond = (fields) => rpc.write({ type: 'extension_ui_response', id: request.id, ...fields });
        if (!['confirm', 'select', 'input', 'editor'].includes(request.method)) return; // fire-and-forget
        if (request.method !== 'confirm' || request.title !== APPROVAL) {
            // Another extension's dialog: there is nobody to show it to.
            respond({ cancelled: true });
            return;
        }
        let asked = {};
        try { asked = JSON.parse(request.message || '{}'); } catch { /* as nothing */ }
        const tool = String(asked.tool || 'tool');
        const input = asked.input || {};
        const current = getSettings();
        const lower = tool.toLowerCase();

        if (!current.allowLocalTools) {
            respond({ confirmed: false });
            return;
        }
        if (lower === 'bash' || lower === 'powershell') {
            const blocked = catalog.blockedReason('run_local_command', { command: String(input.command ?? '') }, current);
            if (blocked) {
                onEvent({ type: 'tool-blocked', name: tool, rule: blocked });
                respond({ confirmed: false });
                return;
            }
        }
        if (catalog.nativeAutoApproved(lower === 'powershell' ? 'bash' : lower, input, current)) {
            respond({ confirmed: true });
            return;
        }
        let settle;
        const cancelled = new Promise((resolve) => { settle = resolve; });
        cards.add(settle);
        try {
            const verdict = await Promise.race([
                requestApproval({ toolName: tool, name: tool, input, local: true }),
                cancelled.then(() => null),
            ]);
            respond({ confirmed: Boolean(verdict?.approved) });
        } finally {
            cards.delete(settle);
        }
    }

    try {
        const state = await rpc.send('get_state', {}, { timeout: START_TIMEOUT });
        if (state?.model?.provider && state?.model?.id) currentModel = `${state.model.provider}/${state.model.id}`;
        if (state?.thinkingLevel) currentThinking = state.thinkingLevel;
    } catch (error) {
        const message = describeFailure(error, proc.stderr());
        acp.stopProcess(child);
        if (host) await mcpHost.release(host.token);
        throw new Error(message);
    }

    onEvent({ type: 'session', sessionId, model: currentModel });
    // The rows behind the composer's menu, kept so a saved bare id (from
    // another agent, or an older pin) can be resolved to its provider/id.
    let knownModels = [];
    // Context windows by `provider/id`, for the composer's ring: Pi reports
    // usage per reply but no window, so the window comes from the catalogue.
    const windows = new Map();
    const noteWindows = (data) => {
        const list = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
        for (const model of list) {
            const window = Number(model?.contextWindow) || 0;
            if (model?.provider && model?.id && window > 0) {
                windows.set(`${model.provider}/${model.id}`, window);
            }
        }
    };
    rpc.send('get_available_models', {}, { timeout: START_TIMEOUT })
        .then((data) => {
            const rows = describeModels(data);
            if (rows.length) {
                knownModels = rows;
                noteWindows(data);
                onEvent({ type: 'models', models: rows });
            }
        })
        .catch(() => {});

    async function ensureKnownModels() {
        if (knownModels.length) return;
        try {
            const data = await rpc.send('get_available_models', {}, { timeout: START_TIMEOUT });
            const rows = describeModels(data);
            if (rows.length) {
                knownModels = rows;
                noteWindows(data);
                onEvent({ type: 'models', models: rows });
            }
        } catch {
            // Kept on what it had.
        }
    }

    /** A composer value to the provider/id Pi's set_model needs. */
    async function resolveModel(model) {
        if (!model || model === currentModel) return null;
        const cut = model.indexOf('/');
        if (cut > 0) return model;
        // Bare id: what the Muse menu saves, or an older pin. Pi's launch
        // flag resolves it, but set_model needs the provider, so look it up.
        await ensureKnownModels();
        const bare = String(model).replace(/\[[^\]]*\]/g, '');
        const matches = knownModels.filter(row => row.resolved === bare || row.value === bare || row.value.endsWith(`/${bare}`));
        if (matches.length === 1) return matches[0].value;
        if (matches.length > 1) {
            const currentProvider = currentModel.split('/')[0];
            const sameProvider = matches.find(row => row.value.startsWith(`${currentProvider}/`));
            return (sameProvider || matches[0]).value;
        }
        return null;
    }

    async function applyModel(model) {
        const resolved = await resolveModel(model);
        if (!resolved || resolved === currentModel) return;
        const cut = resolved.indexOf('/');
        if (cut <= 0) return;
        try {
            await rpc.send('set_model', { provider: resolved.slice(0, cut), modelId: resolved.slice(cut + 1) });
            currentModel = resolved;
        } catch {
            // Kept on what it had.
        }
    }

    async function applyEffort(effort) {
        const level = THINKING[effort];
        if (!level || level === currentThinking) return;
        try {
            await rpc.send('set_thinking_level', { level });
            currentThinking = level;
        } catch {
            // As above.
        }
    }

    function newTurn() {
        let thinking = false;
        let finish = () => {};
        const finished = new Promise((resolve) => { finish = resolve; });
        const total = { input: 0, output: 0, cacheRead: 0, cost: 0, seen: false };
        let failure = '';
        let aborted = false;
        let lastContext = '';

        return {
            finished,
            total,
            get failure() { return failure; },
            get aborted() { return aborted; },
            event(message) {
                switch (message.type) {
                    case 'message_update': {
                        const inner = message.assistantMessageEvent || {};
                        if (inner.type === 'text_delta' && inner.delta) onEvent({ type: 'text-delta', text: inner.delta });
                        else if (inner.type === 'thinking_delta' && inner.delta) {
                            if (!thinking) { thinking = true; onEvent({ type: 'thinking-start' }); }
                            onEvent({ type: 'thinking-delta', text: inner.delta });
                        }
                        return;
                    }
                    case 'message_end': {
                        const done = message.message || {};
                        if (done.role !== 'assistant') return;
                        const text = (done.content || []).filter(block => block?.type === 'text').map(block => block.text).join('');
                        if (text.trim()) onEvent({ type: 'assistant-text', text });
                        if (done.usage) {
                            const input = Number(done.usage.input) || 0;
                            const output = Number(done.usage.output) || 0;
                            const cacheRead = Number(done.usage.cacheRead) || 0;
                            total.seen = true;
                            total.input += input;
                            total.output += output;
                            total.cacheRead += cacheRead;
                            total.cost += Number(done.usage.cost?.total) || 0;
                            // The composer's ring: this reply's tokens over
                            // the model's window, with its cache reads for
                            // the hit rate. Per reply like Opencode, not the
                            // turn's running total: every step re-sends the
                            // transcript, so a sum reads past the window on
                            // any long turn.
                            const used = input + output + cacheRead;
                            const limit = windows.get(currentModel) || 0;
                            const key = `${used}/${limit}/${cacheRead}`;
                            if (used > 0 && key !== lastContext) {
                                lastContext = key;
                                onEvent({
                                    type: 'context',
                                    used,
                                    limit,
                                    percent: limit ? Math.round((used / limit) * 100) : null,
                                    model: currentModel,
                                    ...(cacheRead > 0 ? { cached: cacheRead } : {}),
                                });
                            }
                        }
                        if (done.stopReason === 'error') failure = done.errorMessage || 'Pi reported an error.';
                        if (done.stopReason === 'aborted') aborted = true;
                        return;
                    }
                    case 'tool_execution_start': {
                        // The extension aliases our tools to `acestes_<name>`
                        // on conflicts (e.g. pi-blackhole's `recall`); those
                        // are still ours, not Pi natives.
                        const raw = String(message.toolName || '');
                        const bare = raw.startsWith('acestes_') ? raw.slice(8) : raw;
                        const ours = OUR_TOOLS.has(raw) || OUR_TOOLS.has(bare);
                        onEvent({ type: 'tool-call', id: message.toolCallId, name: bare, rawName: raw, local: !ours, input: message.args || {} });
                        return;
                    }
                    case 'tool_execution_end': {
                        const text = (message.result?.content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
                        onEvent({ type: 'tool-result', id: message.toolCallId, isError: Boolean(message.isError), text });
                        return;
                    }
                    case 'agent_settled':
                        finish();
                        return;
                    default:
                }
            },
        };
    }

    let preamble = systemPrompt || '';
    let queue = Promise.resolve();
    let cancelling = false;

    async function runTurn(text, images) {
        const current = getSettings();
        await applyModel(current.model);
        await applyEffort(current.effort);
        const body = preamble ? `${preamble}\n\n---\n\n${text}` : text;
        preamble = '';

        turn = newTurn();
        cancelling = false;
        lastActivity = Date.now();
        const watchdog = setInterval(() => {
            const busy = (host && mcpHost.pending(host.token) > 0) || cards.size > 0;
            if (!busy && Date.now() - lastActivity > IDLE_TIMEOUT) rpc.write({ type: 'abort' });
        }, 30 * 1000);
        watchdog.unref?.();

        try {
            await rpc.send('prompt', {
                message: body || 'See the attached image.',
                ...(images?.length ? { images: images.map(image => ({ type: 'image', data: image.data, mimeType: image.mediaType })) } : {}),
            });
            await Promise.race([
                turn.finished,
                new Promise((_, reject) => child.once('exit', () => reject(new Error('Pi stopped.')))),
            ]);
            const stopped = cancelling || turn.aborted;
            if (turn.failure && !stopped) onEvent({ type: 'error', message: describeFailure({ message: turn.failure }, proc.stderr()) });
            onEvent({
                type: 'result',
                subtype: stopped ? 'cancelled' : turn.failure ? 'error' : 'success',
                isError: Boolean(turn.failure) && !stopped,
                costUsd: Math.round(turn.total.cost * 1e6) / 1e6,
                usage: turn.total.seen ? usageOf(turn.total) : null,
                turns: 1,
                sessionId,
            });
        } catch (error) {
            if (!cancelling) onEvent({ type: 'error', message: describeFailure(error, proc.stderr()) });
            onEvent({ type: 'result', subtype: cancelling ? 'cancelled' : 'error', isError: !cancelling, costUsd: 0, usage: null });
        } finally {
            clearInterval(watchdog);
        }
    }

    child.on('exit', () => onEvent({ type: 'closed' }));

    const cancel = () => {
        cancelling = true;
        for (const settle of [...cards]) settle();
        rpc.write({ type: 'abort' });
    };

    return {
        get stopped() { return rpc.closed; },
        send(text, images = []) {
            queue = queue.then(() => runTurn(text, images)).catch(() => {});
        },
        async setModel(model) { await applyModel(model); },
        async setEffort(effort) { await applyEffort(effort); },
        async interrupt() { cancel(); },
        async close() {
            cancel();
            acp.stopProcess(child);
            if (host) await mcpHost.release(host.token);
        },
    };
}

/** What this Pi can run, from an RPC session with no session file. */
async function listModels({ settings = {} } = {}) {
    if (!commandFor([])) {
        console.error('Could not read the model list from Pi: the pi binary was not found on PATH.');
        return null;
    }
    let proc;
    try { proc = launch({ ...settings, model: '', effort: '' }); } catch (error) {
        console.error('Could not read the model list from Pi:', error.message);
        return null;
    }
    const rpc = connect(proc.child);
    try {
        const rows = describeModels(await rpc.send('get_available_models', {}, { timeout: START_TIMEOUT }));
        if (!rows.length) console.error('Pi reported no models.');
        return rows.length ? rows : null;
    } catch (error) {
        console.error('Could not read the model list from Pi:', error.message);
        return null;
    } finally {
        acp.stopProcess(proc.child);
    }
}

/**
 * Whether the model Pi is set to has credentials, via `pi auth check`, which
 * spends nothing. Pi reports no plan windows; its turns are counted here.
 */
async function readLimits({ settings = {} } = {}) {
    if (!commandFor([])) return { identity: null, windows: [], error: 'Pi is not installed on this machine.' };
    let provider = '';
    let proc;
    try {
        proc = launch({ ...settings, model: '', effort: '' });
        const rpc = connect(proc.child);
        const state = await rpc.send('get_state', {}, { timeout: START_TIMEOUT });
        provider = state?.model?.provider || '';
    } catch {
        // Unknown provider: said as not signed in below.
    } finally {
        if (proc) acp.stopProcess(proc.child);
    }
    if (!provider) return { identity: { signedIn: false, email: '', plan: '', organization: '', method: '' }, windows: [] };

    const check = await new Promise((resolve) => {
        const command = commandFor(['auth', 'check', '--provider', provider, '--json', '--no-refresh']);
        let stdout = '';
        const child = spawn(command.command, command.args, { env: { ...process.env, ...(settings.accountEnv || {}) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const timer = setTimeout(() => { acp.stopProcess(child); resolve(null); }, 20000);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); } });
    });
    return {
        identity: {
            signedIn: check?.status === 'ready',
            email: '',
            plan: provider,
            organization: '',
            method: check?.authType || '',
        },
        windows: [],
    };
}

function detect() {
    const found = findPi();
    return { ok: Boolean(found), reason: found ? '' : 'notFound' };
}

module.exports = {
    start,
    listModels,
    readLimits,
    detect,
    findPi,
    supportsImages: true,
    _test: { describeModels, formatContextWindow, extensionPath, useCommand: (command) => { override = command; } },
};
