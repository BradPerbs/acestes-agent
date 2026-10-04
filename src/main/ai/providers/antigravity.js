const fs = require('fs');
const os = require('os');
const path = require('path');
const spawn = require('cross-spawn');
const { app } = require('electron');

const mcpHost = require('../mcp-host');
const mcpConfig = require('../mcp-config');
const acp = require('./acp');

/**
 * The Antigravity provider.
 *
 * Antigravity CLI (`agy`) is Google's terminal agent, and the successor to
 * Gemini CLI for Google AI plans. It has no session protocol of its own yet,
 * but its print mode streams: `--input-format stream-json` takes the turn on
 * stdin and `--output-format stream-json` answers with `init`, `step_update`
 * and `result` lines. This runs one process per turn, the way the Grok and
 * Kimi providers do, and carries the conversation from turn to turn with
 * `--conversation <id>`.
 *
 * Two things differ from the other agents here, and both come from the CLI.
 *
 * Tools reach it through a workspace MCP config. There is no flag for an MCP
 * server, so `.agents/mcp_config.json` is written into our own empty working
 * directory at the top of every turn, pointing at `mcp-host`. The user's own
 * `~/.gemini` is never written to.
 *
 * It cannot be asked. A headless run has no channel for approvals: anything
 * that needs one is soft-denied and listed in the result's `denied_actions`.
 * So under "never ask" the run is started with permissions skipped, which is
 * what that setting means everywhere else; under any other mode nothing is
 * pre-approved, and what it would have done is reported in the conversation
 * rather than lost. Our own tools are gated by mcp-host either way.
 *
 * Its login lives in the OS keyring, one per machine, so there are no
 * separate accounts. The plan's windows are read with `/usage`, which spends
 * no quota.
 */

const SERVER_NAME = 'remote';
const LABEL = 'Antigravity';
const IDLE_TIMEOUT = 30 * 60 * 1000;

/** The levels `--effort` takes (`agy --help`); the app's `ultra` runs as `max`. */
const EFFORT_MAP = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' };

let override = null;

function findAgy({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const extra = [];
    if (windows) {
        const local = env.LOCALAPPDATA || paths.join(home, 'AppData', 'Local');
        extra.push(paths.join(local, 'agy', 'bin'));
    }
    extra.push(...acp.commonRoots({ env, home, platform }));
    return acp.findBinary(['agy'], { extra, env, platform });
}

function commandFor(args) {
    if (override) return { command: override.command, args: [...override.args, ...args] };
    const binary = findAgy();
    return binary ? { command: binary, args } : null;
}

function workspace() {
    let root;
    try { root = app.getPath('userData'); } catch { root = os.tmpdir(); }
    const directory = path.join(root, 'agent-workspaces', 'antigravity');
    try { fs.mkdirSync(path.join(directory, '.agents'), { recursive: true }); } catch { /* the spawn says so */ }
    return directory;
}

/** The workspace MCP config: the agent's own servers, then ours. */
function writeMcpConfig(directory, settings, host) {
    const servers = {};
    const own = mcpConfig.agentServers(
        (settings.mcpServers || []).filter(entry => entry?.name !== SERVER_NAME),
        settings.sandbox,
        settings.agentId,
    );
    for (const [name, spec] of Object.entries(own)) {
        servers[name] = spec.type === 'http'
            ? { serverUrl: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) }
            : { command: spec.command, args: spec.args || [], ...(spec.env ? { env: spec.env } : {}) };
    }
    if (host) servers[SERVER_NAME] = { serverUrl: host.url, headers: { Authorization: `Bearer ${host.token}` } };
    fs.writeFileSync(path.join(directory, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: servers }, null, 2));
}

function runArguments({ model, effort, conversationId, skipPermissions }) {
    return [
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        '--print-timeout', '12h',
        ...(model ? ['--model', model] : []),
        ...(EFFORT_MAP[effort] ? ['--effort', EFFORT_MAP[effort]] : []),
        ...(conversationId ? ['--conversation', conversationId] : []),
        ...(skipPermissions ? ['--dangerously-skip-permissions'] : []),
    ];
}

/** What went wrong, from the result, the stderr error line, or the exit. */
function describeFailure(text, stderr = '') {
    const structured = /AGY_ERROR:\s*(\{.*\})/.exec(stderr)?.[1];
    let message = String(text || '');
    if (structured) {
        try { message = JSON.parse(structured).message || message; } catch { /* as it was */ }
    }
    const combined = `${message}\n${stderr}`;
    if (/auth|log ?in|sign ?in|credential|unauthenticated|401/i.test(combined)) {
        return 'Antigravity is not signed in on this machine. Run "agy" in a terminal and sign in with your Google account, then try again.';
    }
    if (/ENOENT|not found|spawn/i.test(message)) {
        return `Antigravity could not be started. Check that "agy" runs in a terminal. (${message})`;
    }
    const last = stderr.trim().split(/\r?\n/).filter(line => line && !line.startsWith('AGY_ERROR')).pop();
    return message || last || 'Antigravity stopped without saying why.';
}

/** A result's token usage, in the shape the limits page reads. */
function usageOf(usage) {
    if (!usage) return null;
    return {
        input_tokens: Number(usage.input_tokens) || 0,
        output_tokens: (Number(usage.output_tokens) || 0) + (Number(usage.thinking_tokens) || 0),
        cache_read_input_tokens: Number(usage.cache_read_tokens) || 0,
    };
}

/** What a headless run skipped for want of an approval, in one sentence. */
function deniedNotice(denied) {
    if (!Array.isArray(denied) || denied.length === 0) return '';
    const names = denied.slice(0, 4).map((entry) => {
        if (typeof entry === 'string') return entry;
        const tool = entry?.tool || entry?.name || entry?.action || 'an action';
        const target = entry?.target || entry?.command || entry?.path || entry?.parameters?.CommandLine || '';
        return target ? `${tool} (${String(target).slice(0, 60)})` : tool;
    });
    const more = denied.length > names.length ? ` and ${denied.length - names.length} more` : '';
    return `Antigravity skipped ${denied.length} action${denied.length === 1 ? '' : 's'} that need approval: ${names.join(', ')}${more}. `
        + 'Headless runs cannot ask, so set approvals to "Never ask" for this agent to let it act, or allow them in Antigravity\'s own settings.';
}

/** One turn's stdout, as the transcript's events. */
function createTranslator(onEvent) {
    const steps = new Map();
    let conversationId = '';
    let result = null;
    let toolsSeen = null;

    const flush = (step) => {
        if (step?.text?.trim() && !step.flushed) {
            step.flushed = true;
            onEvent({ type: 'assistant-text', text: step.text });
        }
    };

    return {
        get conversationId() { return conversationId; },
        get result() { return result; },
        get tools() { return toolsSeen; },
        line(message) {
            if (message?.conversation_id && !conversationId) conversationId = message.conversation_id;
            switch (message?.event) {
                case 'init':
                    conversationId = message.init?.conversation_id || message.conversation_id || conversationId;
                    toolsSeen = Array.isArray(message.init?.tools) ? message.init.tools : null;
                    return;
                case 'step_update': {
                    const update = message.step_update || {};
                    if (update.conversation_id && !conversationId) conversationId = update.conversation_id;
                    const index = update.step_index ?? steps.size;
                    const step = steps.get(index) || { text: '', announced: false, type: update.step_type };
                    steps.set(index, step);
                    const type = update.step_type || step.type;
                    // A new step closes the text of the ones before it, even
                    // those that never said DONE, so the transcript keeps the
                    // order things happened in.
                    for (const [other, earlier] of steps) {
                        if (other !== index) flush(earlier);
                    }

                    if (type === 'agent_response') {
                        if (update.text_delta) {
                            step.text += update.text_delta;
                            onEvent({ type: 'text-delta', text: update.text_delta });
                        }
                        if (update.state === 'DONE') flush(step);
                        return;
                    }
                    if (/think|reason/.test(String(type))) {
                        if (update.text_delta) {
                            if (!step.thinking) {
                                step.thinking = true;
                                onEvent({ type: 'thinking-start' });
                            }
                            onEvent({ type: 'thinking-delta', text: update.text_delta });
                        }
                        return;
                    }
                    if (type === 'tool') {
                        const info = update.tool_info || {};
                        const name = info.name || update.tool_name || 'tool';
                        const ours = acp._test.ourTool({ title: name, toolName: name });
                        const id = `step-${index}`;
                        if (!step.announced) {
                            step.announced = true;
                            onEvent({ type: 'tool-call', id, name: ours || name, rawName: name, local: !ours, input: info.parameters || {} });
                        }
                        if (update.state === 'DONE') {
                            onEvent({
                                type: 'tool-result',
                                id,
                                isError: Boolean(info.error),
                                text: String(info.output ?? info.error?.message ?? ''),
                            });
                        }
                    }
                    return;
                }
                case 'result':
                    for (const step of steps.values()) flush(step);
                    result = message.result || message;
                    if (result.conversation_id) conversationId = result.conversation_id;
                    return;
                default:
            }
        },
    };
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
    if (!commandFor([])) {
        throw new Error('Antigravity is not installed on this machine. Install the Antigravity CLI, then try again.');
    }
    const host = await mcpHost.acquire({ toolContext, requestApproval, onEvent });
    let conversationId = resumeSessionId;
    let preamble = systemPrompt || '';
    let running = null;
    let child = null;
    let cancelled = false;
    let warnedTools = false;
    let queue = Promise.resolve();

    async function turn(text) {
        const current = getSettings();
        const directory = workspace();
        writeMcpConfig(directory, current, host);

        const body = preamble ? `${preamble}\n\n---\n\n${text}` : text;
        preamble = '';

        const command = commandFor(runArguments({
            model: current.model,
            effort: current.effort,
            conversationId,
            skipPermissions: current.approval === 'never',
        }));
        const translator = createTranslator(onEvent);
        let stderr = '';
        let lastActivity = Date.now();
        cancelled = false;

        const exit = await new Promise((resolve) => {
            try {
                child = spawn(command.command, command.args, {
                    cwd: directory,
                    env: { ...process.env, ...(current.accountEnv || {}) },
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true,
                });
            } catch (error) {
                resolve({ code: -1, error });
                return;
            }
            let buffer = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                lastActivity = Date.now();
                buffer += chunk;
                let index = buffer.indexOf('\n');
                while (index >= 0) {
                    const line = buffer.slice(0, index).trim();
                    buffer = buffer.slice(index + 1);
                    index = buffer.indexOf('\n');
                    if (!line || line[0] !== '{') continue;
                    try { translator.line(JSON.parse(line)); } catch { /* a stray line */ }
                }
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
            child.on('error', error => resolve({ code: -1, error }));
            child.on('close', code => resolve({ code }));

            child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: body || 'Continue.' } })}\n`);
            child.stdin.end();

            const watchdog = setInterval(() => {
                if (mcpHost.pending(host.token) > 0) return;
                if (Date.now() - lastActivity > IDLE_TIMEOUT) acp.stopProcess(child);
            }, 30 * 1000);
            watchdog.unref?.();
            child.on('close', () => clearInterval(watchdog));
        });
        child = null;

        if (translator.conversationId && translator.conversationId !== conversationId) {
            conversationId = translator.conversationId;
            onEvent({ type: 'session', sessionId: conversationId, model: current.model || '' });
        }

        // The workspace config can be passed over (a known CLI bug); say so
        // once, rather than leaving the model to explain missing tools.
        const tools = translator.tools;
        if (!warnedTools && Array.isArray(tools) && tools.length && !tools.some(name => acp._test.ourTool({ title: String(name) }) || String(name).includes(SERVER_NAME))) {
            warnedTools = true;
            onEvent({ type: 'notice', tone: 'warn', text: 'Antigravity did not load the app\'s tools from its workspace config, so it cannot reach your servers this turn.' });
        }

        const result = translator.result;
        const notice = deniedNotice(result?.denied_actions);
        if (notice) onEvent({ type: 'notice', tone: 'warn', text: notice });

        if (cancelled) {
            onEvent({ type: 'result', subtype: 'cancelled', isError: false, costUsd: 0, usage: usageOf(result?.usage) });
            return;
        }
        const failed = exit.error || !result || (result.status && !['SUCCESS', 'WAITING'].includes(result.status));
        if (failed) {
            onEvent({ type: 'error', message: describeFailure(exit.error?.message || result?.error?.message || result?.error || '', stderr) });
        }
        onEvent({
            type: 'result',
            subtype: failed ? 'error' : 'success',
            isError: Boolean(failed),
            costUsd: 0,
            usage: usageOf(result?.usage),
            turns: 1,
            sessionId: conversationId,
        });
    }

    if (conversationId) onEvent({ type: 'session', sessionId: conversationId, model: settings.model || '' });

    return {
        send(text) {
            queue = queue.then(() => (running = turn(text))).catch((error) => {
                onEvent({ type: 'error', message: describeFailure(error?.message) });
                onEvent({ type: 'result', subtype: 'error', isError: true, costUsd: 0 });
            });
        },
        // Both are flags on the next run, read from the settings when it starts.
        async setModel() {},
        async setEffort() {},
        async interrupt() {
            cancelled = true;
            acp.stopProcess(child);
        },
        async close() {
            cancelled = true;
            acp.stopProcess(child);
            await running?.catch(() => {});
            await mcpHost.release(host.token);
        },
    };
}

/** Run one print-mode command and parse its JSON answer, or null. */
function runJson(args, settings = {}, timeout = 30000) {
    const command = commandFor(args);
    if (!command) return Promise.resolve(null);
    return new Promise((resolve) => {
        let stdout = '';
        let child;
        try {
            child = spawn(command.command, command.args, {
                cwd: workspace(),
                env: { ...process.env, ...(settings.accountEnv || {}) },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => { acp.stopProcess(child); resolve(null); }, timeout);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', () => {
            clearTimeout(timer);
            const text = stdout.trim();
            try {
                resolve(JSON.parse(text));
            } catch {
                // Some commands print one JSON line after others.
                const last = text.split(/\r?\n/).reverse().find(line => line.trim().startsWith('{') || line.trim().startsWith('['));
                try { resolve(last ? JSON.parse(last) : null); } catch { resolve(null); }
            }
        });
    });
}

/** `agy models`, as the composer's rows.
 *
 * The subcommand takes no `--output-format` flag and prints one
 * `slug<TAB>label` line per model (`Fetching…` goes to stderr). Older
 * shapes (a JSON array, `{ models: […] }`) are still accepted so the
 * scripted `agy` in the tests keeps working.
 */
function describeModels(answer) {
    if (typeof answer === 'string') {
        const text = answer.trim();
        // Tolerate a JSON payload (the scripted `agy` in tests) as well as
        // the real TSV.
        if (text.startsWith('[') || text.startsWith('{')) {
            try { answer = JSON.parse(text); } catch { answer = text; }
        }
        if (typeof answer === 'string') {
            answer = answer.split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line && !/^fetching/i.test(line))
                .map((line) => {
                    const [slug, ...rest] = line.split('\t');
                    const label = rest.join('\t').trim() || slug.trim();
                    return { slug: slug.trim(), display_name: label };
                })
                .filter(entry => entry.slug);
        }
    }
    const list = Array.isArray(answer) ? answer
        : Array.isArray(answer?.models) ? answer.models
            : Array.isArray(answer?.structured_output?.models) ? answer.structured_output.models : [];
    return list.map((entry) => {
        const value = typeof entry === 'string' ? entry : entry?.slug || entry?.id || entry?.model || entry?.name;
        if (!value) return null;
        const label = typeof entry === 'string' ? entry : entry.display_name || entry.displayName || entry.name || value;
        return {
            value: String(value),
            resolved: String(value),
            label: String(label),
            short: String(label).replace(/\s*\([^)]*\)\s*$/, ''),
            description: String(entry?.description || '').slice(0, 200),
            preferred: Boolean(entry?.default || entry?.is_default || entry?.current),
            effort: ['low', 'medium', 'high', 'xhigh', 'max'],
        };
    }).filter(Boolean).slice(0, 60);
}

/** Run one plain-text subcommand (`agy models`) and return its stdout, or null. */
function runText(args, settings = {}, timeout = 30000) {
    const command = commandFor(args);
    if (!command) return Promise.resolve(null);
    return new Promise((resolve) => {
        let stdout = '';
        let child;
        try {
            child = spawn(command.command, command.args, {
                cwd: workspace(),
                env: { ...process.env, ...(settings.accountEnv || {}) },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch {
            resolve(null);
            return;
        }
        const timer = setTimeout(() => { acp.stopProcess(child); resolve(null); }, timeout);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); resolve(null); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0 || !stdout.trim()) resolve(null);
            else resolve(stdout);
        });
    });
}

async function listModels() {
    const rows = describeModels(await runText(['models']));
    return rows.length ? rows : null;
}

/**
 * The plan's windows from `/usage`, which starts no turn. The payload is not
 * documented, so it is walked for anything shaped like a quota: a remaining
 * fraction or a used percentage, with a reset beside it.
 */
function windowsFrom(answer, now = Date.now()) {
    const windows = [];
    const seen = new Set();
    const visit = (node, key = '') => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        const remaining = node.remaining_fraction ?? node.remainingFraction;
        const usedPercent = node.used_percent ?? node.usedPercent ?? node.percent_used;
        if (remaining !== undefined || usedPercent !== undefined) {
            const used = usedPercent !== undefined ? Number(usedPercent) : (1 - Number(remaining)) * 100;
            const resetsAt = node.reset_in_seconds !== undefined
                ? now + Number(node.reset_in_seconds) * 1000
                : Date.parse(node.reset_time || node.resets_at || '') || null;
            const name = String(node.name || node.window || key || '').toLowerCase();
            const id = /week/.test(name) ? 'seven_day' : /5.?h|five|hour/.test(name) ? 'five_hour' : `window_${name.replace(/[^a-z0-9]+/g, '_') || windows.length}`;
            const label = /non.?gemini|claude|other/.test(name) ? 'Other models' : '';
            if (Number.isFinite(used)) {
                windows.push({ id: label ? `${id}:other` : id, label, minutes: id === 'seven_day' ? 10080 : id === 'five_hour' ? 300 : null, used: Math.max(0, Math.min(100, Math.round(used))), resetsAt, status: used >= 100 ? 'rejected' : '' });
            }
        }
        for (const [child, value] of Object.entries(node)) visit(value, child);
    };
    visit(answer);
    return windows;
}

async function readLimits() {
    if (!commandFor([])) return { identity: null, windows: [], error: 'Antigravity is not installed on this machine.' };
    const answer = await runJson(['-p', '/usage', '--output-format', 'json'], {}, 45000);
    if (!answer) return { identity: null, windows: [], error: 'Antigravity did not answer /usage. Check that it is signed in.' };
    if (answer.status === 'ERROR' || answer.error) {
        return { identity: { signedIn: false, email: '', plan: '', organization: '', method: '' }, windows: [] };
    }
    const payload = answer.structured_output || (() => {
        try { return JSON.parse(answer.response); } catch { return answer; }
    })();
    const find = (node, names) => {
        if (!node || typeof node !== 'object') return '';
        for (const name of names) if (typeof node[name] === 'string' && node[name]) return node[name];
        for (const value of Object.values(node)) {
            const found = find(value, names);
            if (found) return found;
        }
        return '';
    };
    return {
        identity: {
            signedIn: true,
            email: find(payload, ['email', 'account_email']),
            plan: find(payload, ['plan_tier', 'plan', 'tier']),
            organization: '',
            method: 'google',
        },
        windows: windowsFrom(payload),
    };
}

function detect() {
    return { ok: Boolean(findAgy()), reason: 'notFound' };
}

module.exports = {
    start,
    listModels,
    readLimits,
    detect,
    findAgy,
    supportsImages: false,
    SERVER_NAME,
    _test: {
        createTranslator,
        runArguments,
        deniedNotice,
        windowsFrom,
        describeModels,
        writeMcpConfig,
        useCommand: (command) => { override = command; },
    },
};
