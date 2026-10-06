const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const spawn = require('cross-spawn');
const { app } = require('electron');

const mcpHost = require('../mcp-host');
const mcpConfig = require('../mcp-config');
const catalog = require('../tools');
const acp = require('./acp');

/**
 * The Muse Code provider.
 *
 * Muse Code is Meta's terminal agent, and `muse serve` is its session
 * protocol (MSP): newline-delimited JSON-RPC on stdio, the surface Meta's own
 * SDKs are built on. This drives the user's own install the way the Codex
 * provider drives Codex, with one process per conversation:
 *
 *   - a session started (or resumed) in an empty directory of ours, with our
 *     tools handed over as a Streamable HTTP MCP server from `mcp-host`
 *   - turns sent as `turn/start`, their text, reasoning and tool calls read off
 *     the `item/*` notifications, and `turn/completed` closing each one with
 *     its token usage
 *   - the agent's approvals answered with `approval/decide` under the app's
 *     own rules, ours waved through because mcp-host asks about those itself
 *   - model and reasoning effort switched on the live session
 *   - the plan's five-hour and weekly windows read from `usage/changed`, and
 *     on demand from `usage/read`, for the limits page
 *
 * Commands carry a UUIDv7 `commandId`, which is MSP's idempotency handle.
 */

const SERVER_NAME = 'remote';
const LABEL = 'Muse Code';
const START_TIMEOUT = 60 * 1000;
const IDLE_TIMEOUT = 30 * 60 * 1000;

/** MSP's reasoning tiers that the app has a name for, low to high.
 *
 * Five, not six: `ultra` parses on the wire but resolves to the base knobs
 * on Muse models (`muse model-profile show <model> --effort ultra` reports
 * `full`/`false`, unlike `max`'s `trimmed`/`true`), so offering it would put
 * a stop above Max that buys nothing. A stored `ultra` is sent as `max`.
 */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The tier sent for an app level: Codex's top stop rides as Muse's. */
const wireEffort = (effort) => (effort === 'ultra' ? 'max' : effort);

/** A UUIDv7: 48 bits of milliseconds, the version, and randomness. */
function uuid7() {
    const bytes = crypto.randomBytes(16);
    const now = BigInt(Date.now());
    for (let index = 0; index < 6; index += 1) bytes[index] = Number((now >> BigInt(8 * (5 - index))) & 0xffn);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The `muse` launcher, wherever the installer put it.
 *
 * The launcher rather than the versioned binary behind it: it is what keeps
 * the install updated and sets up the release info the binary reads. On
 * Windows it is a `.cmd`, which `cross-spawn` starts properly.
 */
function findMuse({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const extra = [];
    if (env.MUSE_INSTALL_DIR) extra.push(env.MUSE_INSTALL_DIR);
    if (windows) {
        const local = env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local');
        extra.push(paths.join(local, 'Programs', 'muse'));
    }
    extra.push(...acp.commonRoots({ env, home, platform }));
    return acp.findBinary(['muse'], { extra, env, platform });
}

/** Set by the tests to a fake `muse`, as `{ command, args }`. */
let override = null;

/** The command that runs `muse <args>`. */
function commandFor(args) {
    if (override) return { command: override.command, args: [...override.args, ...args] };
    const binary = findMuse();
    return binary ? { command: binary, args } : null;
}

function workspace() {
    let root;
    try { root = app.getPath('userData'); } catch { root = os.tmpdir(); }
    const directory = path.join(root, 'agent-workspaces', 'muse');
    try { fs.mkdirSync(directory, { recursive: true }); } catch { /* the spawn says so */ }
    return directory;
}

const envFor = (settings = {}) => ({ ...process.env, ...(settings.accountEnv || {}) });

function launch(settings) {
    const command = commandFor(['serve']);
    if (!command) throw new Error('Muse Code is not installed on this machine. Install it from dev.meta.ai, then try again.');
    const child = spawn(command.command, command.args, {
        cwd: workspace(),
        env: envFor(settings),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    return { child, stderr: () => stderr };
}

async function handshake(rpc, { experimental = false } = {}) {
    let version = '0.0.0';
    try { version = app.getVersion(); } catch { /* tests */ }
    const result = await rpc.request('initialize', {
        clientInfo: { name: 'acestes_agent', title: 'Acestes Agent', version },
        // No dialogs of Muse's own: questions come to the person through the
        // app's cards, and approvals through `approval/decide`.
        // `sessionMcp` is the grant `session/start` and `session/resume`
        // require before they accept `config.mcpServers`; without it the
        // host rejects the start with -32010 `capabilityRequired`.
        capabilities: { userInputDialogs: false, requestedCapabilities: ['sessionMcp'], ...(experimental ? { experimentalApi: true } : {}) },
    }, { timeout: START_TIMEOUT });
    rpc.notify('initialized');
    return result;
}

/** The session's MCP servers in MSP's shape: the agent's own, then ours. */
function sessionServers(settings, host) {
    const out = {};
    const own = mcpConfig.agentServers(
        (settings.mcpServers || []).filter(entry => entry?.name !== SERVER_NAME),
        settings.sandbox,
        settings.agentId,
    );
    for (const [name, spec] of Object.entries(own)) {
        out[name] = spec.type === 'http'
            ? { transport: 'streamableHttp', url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}), mode: 'optional' }
            : { transport: 'stdio', command: spec.command, args: spec.args || [], ...(spec.env ? { env: spec.env } : {}), mode: 'optional' };
    }
    if (host) {
        out[SERVER_NAME] = { transport: 'streamableHttp', url: host.url, headers: { Authorization: `Bearer ${host.token}` }, mode: 'required' };
    }
    return out;
}

/** `model/list` rows, as the composer's menu draws them. */
function describeModels(result) {
    const rows = Array.isArray(result?.models) ? result.models : [];
    return rows.filter(row => row?.modelId).slice(0, 60).map(row => ({
        value: row.modelId,
        resolved: row.modelId,
        label: row.displayLabel || row.modelId,
        short: String(row.displayLabel || row.modelId).replace(/\s*\([^)]*\)\s*$/, ''),
        description: String(row.description || '').slice(0, 200),
        preferred: Boolean(row.isDefault),
        providerId: row.providerId || '',
        // MSP names eight tiers but `ultra` resolves to the base knobs on
        // these models, so the menu offers the five through `max` and a
        // stored `ultra` rounds down to it. See EFFORTS.
        effort: ['low', 'medium', 'high', 'xhigh', 'max'],
    }));
}

/** `usage/read` or `usage/changed`, as the limits page's windows. */
function windowsFrom(usage) {
    if (!usage || typeof usage !== 'object') return [];
    const windows = [];
    const clamp = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : null);
    if (usage.window) {
        const minutes = Number(usage.window.windowDurationMins) || 300;
        windows.push({
            id: minutes === 300 ? 'five_hour' : `window_${minutes}`,
            label: '',
            minutes,
            used: clamp(usage.window.usedPercent),
            resetsAt: Number(usage.window.resetsAtMs) || null,
            status: Number(usage.window.usedPercent) >= 100 ? 'rejected' : '',
        });
    }
    if (usage.weekly) {
        windows.push({
            id: 'seven_day',
            label: '',
            minutes: 10080,
            used: clamp(usage.weekly.usedPercent),
            resetsAt: Number(usage.weekly.resetsAtMs) || null,
            status: Number(usage.weekly.usedPercent) >= 100 ? 'rejected' : '',
        });
    }
    return windows;
}

/** A turn's token usage, in the shape the limits page reads. */
function usageOf(usage) {
    if (!usage) return null;
    return {
        input_tokens: Number(usage.inputTokens) || 0,
        output_tokens: Number(usage.outputTokens) || 0,
        cache_read_input_tokens: Number(usage.cacheReadTokens ?? usage.cachedTokens) || 0,
    };
}

const parseArgs = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return { args: String(raw) }; }
};

function describeFailure(error, stderr = '') {
    const text = `${error?.message || error || ''}`;
    if (/authRequired|auth|log ?in|sign ?in|credential|401/i.test(`${text} ${error?.kind || ''}`)) {
        return 'Muse Code is not signed in on this machine. Run "muse login" in a terminal, or sign in from the accounts card, then try again.';
    }
    if (/keychain write failed/i.test(`${text} ${stderr}`)) {
        return 'Muse Code could not store its login in the system keychain. Sign in again with TBH_CREDENTIAL_BACKEND=file set.';
    }
    if (/ENOENT|not found|spawn/i.test(text)) {
        return `Muse Code could not be started. Check that "muse" runs in a terminal. (${text})`;
    }
    const last = stderr.trim().split(/\r?\n/).filter(Boolean).pop();
    return last && !text.includes(last) ? `${text} (${last.slice(0, 300)})` : text;
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
    // Bare provider CLI: none of the app tools attached (sessionServers
    // already skips ours without a host). The agent's own servers stay.
    const host = settings?.bareProvider ? null : await mcpHost.acquire({ toolContext, requestApproval, onEvent });
    let proc;
    try {
        proc = launch(settings);
    } catch (error) {
        if (host) await mcpHost.release(host.token);
        throw error;
    }
    const { child } = proc;

    let sessionId = '';
    let lastActivity = Date.now();
    let turn = null;
    const decided = new Set();
    const cards = new Set();
    let modelProviders = new Map();
    let currentModel = '';
    let currentEffort = '';

    const rpc = acp.connect(child, {
        onActivity: () => { lastActivity = Date.now(); },
        // `approval/request` and `userInput/request` come as requests; the
        // answer to the request is only a receipt, and the decision travels
        // as a command of its own.
        onRequest: (method, params) => {
            if (method === 'approval/request') handleApproval(params);
            return {};
        },
        onNotification: (method, params) => {
            if (params?.sessionId && sessionId && params.sessionId !== sessionId) return;
            switch (method) {
                case 'approval/requested':
                    handleApproval(params);
                    return;
                case 'usage/changed': {
                    const windows = windowsFrom(params.usage || params);
                    if (windows.length) onEvent({ type: 'limits', windows, plan: params.usage?.tier || params.tier || '' });
                    return;
                }
                case 'session/modelChanged':
                    currentModel = params.modelId || currentModel;
                    return;
                case 'session/reasoningEffortChanged':
                    currentEffort = params.reasoningEffort || currentEffort;
                    return;
                default:
                    turn?.notify(method, params);
            }
        },
    });

    const cleanup = async () => {
        acp.stopProcess(child);
        if (host) await mcpHost.release(host.token);
    };

    const cwd = workspace();
    try {
        await handshake(rpc);
        const mcpServers = sessionServers(settings, host);
        if (resumeSessionId) {
            try {
                const resumed = await rpc.request('session/resume', {
                    commandId: uuid7(),
                    sessionId: resumeSessionId,
                    config: { mcpServers },
                    excludeItems: true,
                }, { timeout: START_TIMEOUT });
                sessionId = resumed?.session?.sessionId || resumeSessionId;
                currentModel = resumed?.session?.modelId || '';
            } catch {
                // Gone or unreadable: a new one, and the transcript carries on.
            }
        }
        if (!sessionId) {
            const started = await rpc.request('session/start', {
                commandId: uuid7(),
                workspaceRoot: cwd,
                ...(settings.model ? { modelId: settings.model } : {}),
                config: { mcpServers },
            }, { timeout: START_TIMEOUT });
            sessionId = started?.session?.sessionId;
            currentModel = started?.session?.modelId || settings.model || '';
        }
        if (!sessionId) throw new Error('Muse Code did not start a session.');
    } catch (error) {
        const message = describeFailure(error, proc.stderr());
        await cleanup();
        throw new Error(message);
    }

    onEvent({ type: 'session', sessionId, model: currentModel });

    // The model list, from the same process: it says which models this
    // account can use and which one the session is on.
    rpc.request('model/list', { sessionId }, { timeout: START_TIMEOUT })
        .then((result) => {
            const rows = describeModels(result);
            modelProviders = new Map(rows.map(row => [row.value, row.providerId]));
            if (rows.length) onEvent({ type: 'models', models: rows });
        })
        .catch(() => {});

    async function applyModel(model) {
        if (!model || model === currentModel) return;
        try {
            await rpc.request('session/setModel', {
                commandId: uuid7(),
                sessionId,
                model: { modelId: model, ...(modelProviders.get(model) ? { providerId: modelProviders.get(model) } : {}) },
            });
            currentModel = model;
        } catch {
            // Kept on what it had.
        }
    }

    async function applyEffort(effort) {
        const level = wireEffort(effort);
        if (!EFFORTS.includes(level) || level === currentEffort) return;
        try {
            await rpc.request('session/setReasoningEffort', { commandId: uuid7(), sessionId, reasoningEffort: level });
            currentEffort = level;
        } catch {
            // As above.
        }
    }

    /**
     * One approval, decided once. Ours are approved, since mcp-host asks
     * about those; the agent's own go through the same rules as every other
     * runtime's native tools.
     */
    async function handleApproval(params) {
        const requirement = params?.currentRequirementId;
        const key = `${params?.approvalId}:${requirement?.sourceIndex ?? ''}`;
        if (!params?.approvalId || decided.has(key)) return;
        decided.add(key);

        const choices = Array.isArray(params.availableChoices) ? params.availableChoices : [];
        const allowChoice = choices.find(choice => choice.decision === 'approved' && choice.scope === 'once')
            || choices.find(choice => choice.decision === 'approved')
            || choices.find(choice => /^approved/.test(choice.decision));
        const denyChoice = choices.find(choice => choice.decision === 'denied')
            || choices.find(choice => /^denied/.test(choice.decision));

        const decide = (choice) => {
            if (!choice) return;
            rpc.request('approval/decide', {
                sessionId,
                commandId: uuid7(),
                approvalId: params.approvalId,
                requirementId: requirement,
                choiceId: choice.choiceId,
            }).catch(() => {});
        };

        const toolName = String(params.toolName || params.subject?.toolName || '');
        const input = parseArgs(params.rawArgs);
        const server = params.subject?.server || params.subject?.serverName || params.subject?.mcpServer || '';
        if (acp._test.ourTool({ title: toolName, toolName, server })) {
            decide(allowChoice);
            return;
        }

        const current = getSettings();
        const lower = toolName.toLowerCase();
        const web = /fetch|search_web|web_search|read_url/.test(lower);
        if (!current.allowLocalTools && !web) {
            decide(denyChoice);
            return;
        }
        if (/shell|bash|command|exec/.test(lower)) {
            const command = String(input.command ?? input.cmd ?? '');
            const blocked = catalog.blockedReason('run_local_command', { command }, current);
            if (blocked) {
                onEvent({ type: 'tool-blocked', name: toolName, rule: blocked });
                decide(denyChoice);
                return;
            }
        }
        if (catalog.nativeAutoApproved(lower, input, current)) {
            decide(allowChoice);
            return;
        }

        let settle;
        const cancelled = new Promise((resolve) => { settle = resolve; });
        cards.add(settle);
        try {
            const verdict = await Promise.race([
                requestApproval({ toolName, name: toolName, input, local: true }),
                cancelled.then(() => null),
            ]);
            if (verdict) decide(verdict.approved ? allowChoice : denyChoice);
        } finally {
            cards.delete(settle);
        }
    }

    function newTurn() {
        const texts = new Map();
        const thinking = new Set();
        const tools = new Map();
        let finish = () => {};
        const finished = new Promise((resolve) => { finish = resolve; });
        let turnId = '';

        return {
            finished,
            set id(value) { turnId = value; },
            get id() { return turnId; },
            notify(method, params) {
                if (method === 'turn/completed' && (!turnId || params.turnId === turnId)) {
                    finish(params);
                    return;
                }
                if (method === 'item/delta') {
                    const field = params.field;
                    const id = params.itemId;
                    if (texts.has(id) && field === 'text') {
                        texts.set(id, texts.get(id) + (params.delta || ''));
                        onEvent({ type: 'text-delta', text: params.delta || '' });
                    } else if (thinking.has(id) && (field === 'text' || field === 'summary')) {
                        onEvent({ type: 'thinking-delta', text: params.delta || '' });
                    }
                    return;
                }
                const item = params.item;
                if (!item || (turnId && item.turnId && item.turnId !== turnId)) return;
                if (method === 'item/started') {
                    if (item.kind === 'agentMessage') texts.set(item.itemId, item.text || '');
                    else if (item.kind === 'reasoning') {
                        thinking.add(item.itemId);
                        onEvent({ type: 'thinking-start' });
                    } else if (item.kind === 'toolCall') {
                        const input = parseArgs(item.args);
                        const ours = acp._test.ourTool({ title: item.tool, toolName: item.tool });
                        tools.set(item.itemId, true);
                        onEvent({ type: 'tool-call', id: item.itemId, name: ours || item.tool || 'tool', rawName: item.tool || '', local: !ours, input });
                    }
                    return;
                }
                if (method === 'item/completed') {
                    if (item.kind === 'agentMessage') {
                        const text = item.text || texts.get(item.itemId) || '';
                        texts.delete(item.itemId);
                        if (text.trim()) onEvent({ type: 'assistant-text', text });
                    } else if (item.kind === 'reasoning') {
                        if (!thinking.has(item.itemId) && item.text) onEvent({ type: 'thinking-delta', text: item.text });
                        thinking.delete(item.itemId);
                    } else if (item.kind === 'toolCall') {
                        if (!tools.has(item.itemId)) {
                            const ours = acp._test.ourTool({ title: item.tool, toolName: item.tool });
                            onEvent({ type: 'tool-call', id: item.itemId, name: ours || item.tool || 'tool', rawName: item.tool || '', local: !ours, input: parseArgs(item.args) });
                        }
                        onEvent({
                            type: 'tool-result',
                            id: item.itemId,
                            isError: item.status !== 'completed',
                            text: item.visibleOutput || item.failureReason || '',
                        });
                    }
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
        const input = [];
        for (const image of images || []) input.push({ type: 'image', base64Data: image.data, mediaType: image.mediaType });
        input.push({ type: 'text', text: body || 'See the attached image.' });

        turn = newTurn();
        cancelling = false;
        lastActivity = Date.now();
        const watchdog = setInterval(() => {
            const busy = (host ? mcpHost.pending(host.token) : 0) > 0 || cards.size > 0;
            if (!busy && Date.now() - lastActivity > IDLE_TIMEOUT && turn?.id) {
                rpc.request('turn/cancel', { commandId: uuid7(), sessionId, turnId: turn.id }).catch(() => {});
            }
        }, 30 * 1000);
        watchdog.unref?.();

        try {
            const accepted = await rpc.request('turn/start', {
                sessionId,
                commandId: uuid7(),
                input,
                displayText: text,
                ...(EFFORTS.includes(wireEffort(current.effort)) ? { reasoningEffort: wireEffort(current.effort) } : {}),
            });
            turn.id = accepted?.turnId || '';
            const done = await Promise.race([
                turn.finished,
                new Promise((_, reject) => child.once('exit', () => reject(new Error('Muse Code stopped.')))),
            ]);
            const terminal = done?.terminal || 'completed';
            if (terminal === 'failed') {
                onEvent({ type: 'error', message: describeFailure({ message: done?.error?.message || done?.reason || 'The turn failed.', kind: done?.error?.kind }, proc.stderr()) });
            }
            onEvent({
                type: 'result',
                subtype: terminal === 'completed' ? 'success' : terminal,
                isError: terminal === 'failed',
                costUsd: 0,
                usage: usageOf(done?.usage),
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
        if (turn?.id && !rpc.closed) {
            rpc.request('turn/cancel', { commandId: uuid7(), sessionId, turnId: turn.id }).catch(() => {});
        }
    };

    return {
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
            cancel();
        },
        async close() {
            cancel();
            await cleanup();
        },
    };
}

/** The model list, from a `muse serve` brought up and put down again. */
async function listModels({ settings = {} } = {}) {
    if (!commandFor([])) return null;
    let proc;
    try { proc = launch(settings); } catch { return null; }
    const rpc = acp.connect(proc.child);
    try {
        await handshake(rpc);
        const rows = describeModels(await rpc.request('model/list', {}, { timeout: START_TIMEOUT }));
        return rows.length ? rows : null;
    } catch (error) {
        console.error('Could not read the model list from Muse Code:', describeFailure(error, proc.stderr()));
        return null;
    } finally {
        acp.stopProcess(proc.child);
    }
}

/**
 * Who the account is and where its plan stands, without a turn: MSP's
 * `account/read` (experimental, so asked for) and `usage/read`, which holds
 * the last figures the host observed.
 */
async function readLimits({ settings = {} } = {}) {
    if (!commandFor([])) return { identity: null, windows: [], error: 'Muse Code is not installed on this machine.' };
    let proc;
    try { proc = launch(settings); } catch (error) { return { identity: null, windows: [], error: error.message }; }
    const rpc = acp.connect(proc.child);
    try {
        await handshake(rpc, { experimental: true });
        let identity = null;
        try {
            const account = await rpc.request('account/read', {}, { timeout: START_TIMEOUT });
            const state = account?.state || account?.account?.state || '';
            identity = {
                signedIn: Boolean(state) && state !== 'loggedOut',
                email: account?.label || '',
                plan: '',
                organization: '',
                method: state === 'accountLogin' ? 'account' : state,
            };
        } catch {
            // An older host without the experimental read.
        }
        let windows = [];
        try {
            const usage = await rpc.request('usage/read', {}, { timeout: START_TIMEOUT });
            windows = windowsFrom(usage?.usage);
            if (identity && usage?.usage?.tier) identity.plan = usage.usage.tier;
        } catch {
            // Nothing observed yet.
        }
        return { identity, windows, unsupported: windows.length === 0 };
    } catch (error) {
        return { identity: null, windows: [], error: describeFailure(error, proc.stderr()) };
    } finally {
        acp.stopProcess(proc.child);
    }
}

/**
 * Sign in with `muse login`, a device-code flow: it prints an address and a
 * code, and finishes when the browser has been through it.
 */
function login({ settings = {}, onProgress = () => {} } = {}) {
    const binary = findMuse();
    if (!binary) return { done: Promise.resolve({ ok: false, message: 'Muse Code is not installed on this machine.' }), cancel() {} };
    let child = null;
    let cancelled = false;
    let tail = '';
    let sawUrl = false;
    let sawCode = false;
    const done = new Promise((resolve) => {
        try {
            child = spawn(binary, ['login'], { env: envFor(settings), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
            resolve({ ok: false, message: describeFailure(error) });
            return;
        }
        const timer = setTimeout(() => acp.stopProcess(child), 10 * 60 * 1000);
        timer.unref?.();
        const read = (chunk) => {
            const text = chunk.toString('utf8');
            tail = (tail + text).slice(-2000);
            for (const line of text.split(/\r?\n/).map(entry => entry.trim()).filter(Boolean)) {
                onProgress({ line: line.slice(0, 500) });
                const url = /https:\/\/\S+/.exec(line)?.[0];
                if (url && !sawUrl) { sawUrl = true; onProgress({ url }); }
                const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/.exec(line)?.[1];
                if (code && !sawCode) { sawCode = true; onProgress({ code }); }
            }
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, message: describeFailure(error) }); });
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
    const binary = findMuse();
    if (!binary) return { ok: false };
    return new Promise((resolve) => {
        const child = spawn(binary, ['logout'], { env: envFor(settings), stdio: 'ignore', windowsHide: true });
        const timer = setTimeout(() => { acp.stopProcess(child); resolve({ ok: false }); }, 15000);
        child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0 }); });
        child.on('error', () => { clearTimeout(timer); resolve({ ok: false }); });
    });
}

function detect() {
    return { ok: Boolean(findMuse()), reason: 'notFound' };
}

module.exports = {
    start,
    listModels,
    readLimits,
    login,
    logout,
    detect,
    findMuse,
    supportsImages: true,
    SERVER_NAME,
    _test: {
        uuid7,
        describeModels,
        windowsFrom,
        usageOf,
        sessionServers,
        useCommand: (command) => { override = command; },
    },
};
