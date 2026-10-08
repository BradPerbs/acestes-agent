const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const mcpHost = require('../mcp-host');
const mcpConfig = require('../mcp-config');
const sandboxLib = require('../sandbox');

/**
 * The Codex provider.
 *
 * Drives @openai/codex-sdk, which spawns the Codex CLI the same way the other
 * provider spawns Claude Code: the account, the plan and the login are the
 * user's own, already on this machine, and nothing of ours is stored for it.
 *
 * Two things are different enough from the Claude path to say out loud.
 *
 * The tools do not travel with the query. Codex reaches an MCP server by URL,
 * so `mcp-host` serves ours on loopback and this hands over the address and a
 * token. Same handlers, same approval card, same activity log.
 *
 * A turn is a call, not a stream you push into. `runStreamed` runs one turn to
 * completion and ends, where the Claude SDK keeps one iterator open for the
 * life of the conversation. So this holds the thread and starts a turn per
 * message, which is also why the model and the effort can be changed between
 * turns without anything being restarted.
 */

const SERVER_NAME = 'remote';

/** The levels the app can store, so nothing is offered that cannot be saved. */
const EFFORT_LEVELS = new Set(require('../settings').EFFORTS);

function envValue(env, ...names) {
    for (const name of names) {
        if (env?.[name]) return env[name];
    }
    return '';
}

/**
 * Where the Codex desktop app keeps its CLI.
 *
 * The folder under `bin` is content-addressed, so it changes with every update
 * and cannot be written down. The newest one wins, which is the same rule the
 * app itself follows.
 */
function codexAppRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData')
        || paths.join(home, 'AppData', 'Local');

    return [
        paths.join(localAppData, 'OpenAI', 'Codex', 'bin'),
        paths.join(home, '.codex', 'bin'),
        paths.join(home, 'Library', 'Application Support', 'OpenAI', 'Codex', 'bin'),
        paths.join(home, '.local', 'share', 'openai', 'codex', 'bin'),
    ];
}

/**
 * Every folder a standalone Codex CLI can land in.
 *
 * The desktop app is not the only way to get one. The official install script,
 * npm, Homebrew, Scoop and Chocolatey each put a `codex` somewhere else, and
 * until this existed a machine that installed it any of those ways was told
 * Codex was not on it at all.
 *
 * PATH leads, because someone who arranged their own PATH has already said
 * which copy they mean. The named folders are for the packaged app, whose PATH
 * is whatever the desktop session handed it and is often close to empty.
 */
function codexRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path.posix;
    const roots = String(envValue(env, 'PATH', 'Path', 'path'))
        .split(windows ? ';' : ':')
        .filter(Boolean);

    // The app's own folders again, for a binary sitting directly in one rather
    // than in a hashed subfolder of it.
    roots.push(...codexAppRoots({ platform, env, home }));

    if (windows) {
        const appData = envValue(env, 'APPDATA', 'AppData');
        const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData');
        const chocolatey = envValue(env, 'ChocolateyInstall', 'CHOCOLATEYINSTALL');
        const scoop = envValue(env, 'SCOOP', 'Scoop') || paths.join(home, 'scoop');

        roots.push(
            appData && paths.join(appData, 'npm'),
            paths.join(scoop, 'shims'),
            localAppData && paths.join(localAppData, 'Programs', 'codex'),
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
 * The real executable behind an npm install on Windows.
 *
 * `npm i -g @openai/codex` leaves a `codex.cmd` shim, and a shim is not
 * something this can hand over: the SDK spawns the path with no shell, as does
 * `app-server` further down, and Node refuses to spawn a `.cmd` that way. The
 * binary the shim would have reached is in the platform package sitting beside
 * it, so this walks `node_modules/@openai/codex-*\/vendor/<triple>/bin` and
 * takes that. The triple is read rather than written down, since it differs by
 * architecture and by libc.
 */
function vendoredCodex(root, { readdirSync, statSync, paths, binary }) {
    const scope = paths.join(root, 'node_modules', '@openai');
    let packages = [];
    try {
        packages = readdirSync(scope, { withFileTypes: true });
    } catch {
        return '';
    }

    for (const entry of packages) {
        if (!entry.isDirectory() || !entry.name.startsWith('codex-')) continue;
        const vendor = paths.join(scope, entry.name, 'vendor');
        let triples = [];
        try {
            triples = readdirSync(vendor, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const triple of triples) {
            if (!triple.isDirectory()) continue;
            const candidate = paths.join(vendor, triple.name, 'bin', binary);
            try {
                statSync(candidate);
                return candidate;
            } catch {
                // Not this one.
            }
        }
    }
    return '';
}

/**
 * The Codex CLI, wherever this machine happens to keep it.
 *
 * The desktop app's copy is preferred when there is one: it updates itself, and
 * its sign-in is the one the desktop session is already using. Everything after
 * that is for the machines that never installed the app.
 */
function findCodex(options = {}) {
    const platform = options.platform || process.platform;
    const env = options.env || process.env;
    const home = options.home || os.homedir();
    const readdirSync = options.readdirSync || fs.readdirSync;
    const statSync = options.statSync || fs.statSync;
    const accessSync = options.accessSync || fs.accessSync;
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const binary = platform === 'win32' ? 'codex.exe' : 'codex';

    const runnable = (candidate) => {
        try {
            accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    };

    let best = null;
    for (const root of codexAppRoots({ platform, env, home })) {
        let entries = [];
        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = paths.join(root, entry.name, binary);
            try {
                const stat = statSync(candidate);
                if (!best || stat.mtimeMs > best.at) best = { path: candidate, at: stat.mtimeMs };
            } catch {
                // Not this one.
            }
        }
    }
    if (best) return best.path;

    let shim = '';
    for (const root of codexRoots({ platform, env, home })) {
        const direct = paths.join(root, binary);
        if (runnable(direct)) return direct;

        if (platform === 'win32') {
            const vendored = vendoredCodex(root, { readdirSync, statSync, paths, binary });
            if (vendored) return vendored;

            // Last resort only, for the reason `vendoredCodex` gives. Better to
            // fail saying which file could not be started than to say Codex is
            // not here when it plainly is.
            if (!shim) {
                const cmd = paths.join(root, 'codex.cmd');
                if (runnable(cmd)) shim = cmd;
            }
        }
    }
    return shim;
}

let sdkPromise = null;
function loadSdk() {
    if (!sdkPromise) sdkPromise = import('@openai/codex-sdk');
    return sdkPromise;
}

/** The effort the app asked for, if it is one Codex has a name for. */
function effortFor(settings) {
    return EFFORT_LEVELS.has(settings.effort) ? settings.effort : undefined;
}

/**
 * Where Codex may write on this machine, from the folders the agent was
 * granted.
 *
 * `workspace-write` lets Codex write in its working directory and in each
 * extra directory, and read everywhere. So the working directory is the first
 * folder granted for writing and the rest of those are added. A folder
 * granted read-only is left out: making it the working directory would make
 * it writable. The temp directory stays writable, as it always was, for
 * anything scratch.
 *
 * This used to be the temp directory every time, so an agent granted a
 * repository for writing had every Codex edit to it refused, and tested a
 * copy in %TEMP% instead. The first-writable-grant rule lives in
 * `sandbox.js` (`writableFolders`) and is shared with every provider; this
 * only adds what Codex alone takes: the rest of the writable grants, and
 * the temp directory, as additional directories.
 */
function workspaceFor(sandbox) {
    const temp = os.tmpdir();
    const writable = sandboxLib.writableFolders(sandbox);
    if (writable.length === 0) return { workingDirectory: temp, additionalDirectories: [] };
    return { workingDirectory: writable[0], additionalDirectories: [...writable.slice(1), temp] };
}

/**
 * Thread options. Codex fixes them when a turn starts, so they are rebuilt
 * whenever a model, an effort or the sandbox changes, and land on the next
 * answer rather than the next conversation.
 *
 * The sandbox follows the app's own switch: with local tools off, Codex's
 * built-in shell and file tools get a read-only view of this machine and no
 * network of their own, and no folder is writable whatever was granted. The
 * servers are reached through our tools, which is the point, and those are
 * approved one at a time.
 */
function threadOptions(settings, mcp) {
    const writes = Boolean(settings.allowLocalTools);
    const workspace = writes
        ? workspaceFor(settings.sandbox)
        : { workingDirectory: os.tmpdir(), additionalDirectories: [] };
    return {
        model: settings.model || undefined,
        modelReasoningEffort: effortFor(settings),
        workingDirectory: workspace.workingDirectory,
        additionalDirectories: workspace.additionalDirectories.length ? workspace.additionalDirectories : undefined,
        skipGitRepoCheck: true,
        // Full access takes Codex's own sandbox off too: the agent was told
        // it may write anywhere on this machine, and a workspace-write
        // sandbox would refuse every write outside the grants regardless.
        sandboxMode: writes
            ? (sandboxLib.fullAccess(settings) ? 'danger-full-access' : 'workspace-write')
            : 'read-only',
        networkAccessEnabled: writes,
        // Nothing is waved through on Codex's side. Everything that matters
        // here is a call into our own tools, and those stop at the approval
        // card before they touch a host.
        approvalPolicy: 'never',
        // Looking something up is not touching this machine, so the web is
        // open whichever way the local-tools switch is set.
        webSearchEnabled: true,
        mcp,
    };
}

/** What decides where Codex may write, as one comparable string. */
function fenceOf(options) {
    return JSON.stringify([options.sandboxMode, options.workingDirectory, options.additionalDirectories || []]);
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
    const sdk = await loadSdk();

    const binary = findCodex();
    if (!binary) {
        throw new Error('The Codex CLI could not be found on this machine. Install the Codex app, '
            + 'or install the CLI and make sure its executable is on PATH.');
    }

    // Bare provider CLI: none of the app's tools attached (the SERVER_NAME
    // entry is left out below). The agent's own servers stay: user config.
    const { url, token } = settings?.bareProvider
        ? { url: null, token: null }
        : await mcpHost.acquire({ toolContext, requestApproval, onEvent });

    // Pointed at the account's CODEX_HOME when one other than the machine's
    // own is chosen, which is the whole of what an account is to Codex.
    const env = { ...accountEnv(settings), ...(token ? { CLOUDBLAST_MCP_TOKEN: token } : {}) };
    if (settings.apiKey) env.OPENAI_API_KEY = settings.apiKey;

    const codex = new sdk.Codex({
        codexPathOverride: binary,
        env,
        config: {
            mcp_servers: {
                // The agent's own servers first, ours last, so a name clash
                // cannot shadow the app's tools.
                ...mcpConfig.codex(
                    (settings.mcpServers || []).filter(entry => entry?.name !== SERVER_NAME),
                    settings.sandbox,
                    settings.agentId,
                ),
                ...(url ? {
                    [SERVER_NAME]: {
                        url,
                        bearer_token_env_var: 'CLOUDBLAST_MCP_TOKEN',
                    // Codex asks its own caller before every MCP tool call,
                    // as an elicitation. Nothing can answer that here: the
                    // SDK exposes no hook for it, so it resolves itself with
                    // Cancel and the call is dropped before it is ever sent.
                    // Every remote tool failed as "the tool call was
                    // cancelled" until this was found.
                    //
                    // `approve` is not a loosening. It moves the question to
                    // where it belongs: the handler in `mcp-host` asks the
                    // user through the panel's own approval card, under this
                    // app's policy, before anything touches a server. Codex
                    // asking as well would be a second dialog for the same
                    // call, on a channel with nobody on the other end.
                    default_tools_approval_mode: 'approve',
                    },
                } : {}),
            },
        },
    });

    // The system prompt is not a thread option, so it leads the first turn.
    // Codex carries it forward with the rest of the thread from there. Bare:
    // no Acestes prompt at all.
    let preamble = settings?.bareProvider ? '' : systemPrompt;

    let thread = resumeSessionId
        ? codex.resumeThread(resumeSessionId, threadOptions(settings, undefined))
        : codex.startThread(threadOptions(settings, undefined));
    let fence = fenceOf(threadOptions(settings, undefined));
    let announced = Boolean(resumeSessionId);
    let running = null;
    let abort = null;
    // Every turn is a fresh `codex exec`, which reads its config again and
    // warns again. Once a conversation is enough.
    const warned = new Set();
    const report = (event) => {
        if (event.type === 'warning') {
            if (warned.has(event.message)) return;
            warned.add(event.message);
        }
        onEvent(event);
    };

    /** One turn, from the text going in to the transcript coming out. */
    async function turn(text, images = []) {
        const current = getSettings();
        // A folder granted or the local-tools switch flipped since the thread
        // opened applies from this turn, the way it does for our own tools.
        const options = threadOptions(current, undefined);
        if (fenceOf(options) !== fence) {
            thread = thread.id ? codex.resumeThread(thread.id, options) : codex.startThread(options);
            fence = fenceOf(options);
        }
        abort = new AbortController();

        const body = preamble ? `${preamble}\n\n---\n\n${text}` : text;
        preamble = '';

        // On disk only for the turn: the CLI reads the files as it starts and
        // sends the pixels itself, so once the turn is over nothing needs them.
        const staged = await stageImages(images);
        try {
            const { events } = await thread.runStreamed(turnInput(body, staged.paths), { signal: abort.signal });

            for await (const event of events) {
                translate(event, report);

                if (event.type === 'thread.started' && !announced) {
                    announced = true;
                    onEvent({ type: 'session', sessionId: thread.id || '', model: current.model || '' });
                }
            }
        } finally {
            await staged.cleanup();
        }
    }

    return {
        send(text, images = []) {
            running = (running || Promise.resolve())
                .then(() => turn(text, images))
                .catch((error) => {
                    if (!abort?.signal.aborted) onEvent({ type: 'error', message: describeFailure(error) });
                })
                .finally(() => {
                    abort = null;
                    onEvent({ type: 'result', costUsd: 0, subtype: 'success' });
                });
        },
        /**
         * Both of these take effect on the next turn rather than the current
         * one: they are properties of the thread, and Codex fixes them when a
         * turn starts. The thread itself is kept, so nothing is lost.
         */
        async setModel() {
            thread = codex.resumeThread(thread.id, threadOptions(getSettings(), undefined));
        },
        async setEffort() {
            thread = codex.resumeThread(thread.id, threadOptions(getSettings(), undefined));
        },
        async interrupt() {
            abort?.abort();
        },
        async close() {
            abort?.abort();
            await running?.catch(() => {});
            await mcpHost.release(token);
        },
    };
}

const IMAGE_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
};

/**
 * Put the images where Codex can be pointed at them.
 *
 * Codex takes a picture as a path, not as bytes: the SDK hands each one to
 * `codex exec --image`, and the CLI reads the file itself. So the base64 that
 * came over the bridge is written out to a private directory of its own,
 * fresh for every turn, and `cleanup` takes the directory away again.
 *
 * Returns `{ paths, cleanup }`; with nothing to stage both are no-ops.
 */
async function stageImages(images, root = os.tmpdir()) {
    if (!images.length) return { paths: [], cleanup: async () => {} };

    const dir = await fs.promises.mkdtemp(path.join(root, 'cloudterm-images-'));
    const paths = [];
    for (const [index, image] of images.entries()) {
        const file = path.join(dir, `image-${index + 1}${IMAGE_EXTENSIONS[image.mediaType] || '.bin'}`);
        await fs.promises.writeFile(file, Buffer.from(image.data, 'base64'));
        paths.push(file);
    }

    return {
        paths,
        cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}),
    };
}

/**
 * One turn's input as the SDK takes it: the string alone when there are no
 * pictures, otherwise the pictures followed by the words about them.
 *
 * The CLI wants some prompt text with the images, so a screenshot sent on its
 * own goes with the one line that says what it is.
 */
function turnInput(text, paths = []) {
    if (!paths.length) return text;
    const input = paths.map(file => ({ type: 'local_image', path: file }));
    input.push({ type: 'text', text: text || (paths.length > 1 ? 'See the attached images.' : 'See the attached image.') });
    return input;
}

/** One Codex event, as the transcript events the panel already draws. */
function translate(event, onEvent) {
    switch (event.type) {
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
            const item = event.item;
            if (!item) return;

            if (item.type === 'agent_message') {
                // Only once it is finished: Codex sends the whole text each
                // time it grows, where the panel appends what it is given.
                if (event.type === 'item.completed') {
                    onEvent({ type: 'assistant-text', text: item.text || '' });
                }
                return;
            }

            if (item.type === 'reasoning') {
                if (event.type === 'item.completed' && item.text) {
                    onEvent({ type: 'thinking-delta', text: item.text });
                }
                return;
            }

            if (item.type === 'mcp_tool_call') {
                onEvent({
                    type: event.type === 'item.completed' ? 'tool-result' : 'tool-call',
                    id: item.id,
                    name: String(item.tool || '').replace(/^remote__/, ''),
                    input: item.arguments || {},
                    text: typeof item.result === 'string' ? item.result : '',
                    isError: item.status === 'failed',
                    local: false,
                });
                return;
            }

            // Codex's own tools, which act on this machine rather than on a
            // server. Reported so the transcript is honest about them, marked
            // local so the panel says whose computer they touched.
            if (item.type === 'command_execution') {
                onEvent({
                    type: event.type === 'item.completed' ? 'tool-result' : 'tool-call',
                    id: item.id,
                    name: 'run_command',
                    input: { command: item.command || '' },
                    text: item.aggregated_output || '',
                    isError: item.status === 'failed',
                    local: true,
                });
                return;
            }

            // Non-fatal, by the SDK's own account: a warning about the
            // person's Codex setup, such as a hook in ~/.codex/hooks.json
            // whose timeout it clamped. The turn carries on and answers.
            // Reported as an error, it ended the turn, and the warning stood
            // where the answer should have been.
            if (item.type === 'error' && item.message) {
                onEvent({ type: 'warning', message: item.message });
            }
            return;
        }

        case 'turn.failed':
            onEvent({ type: 'error', message: event.error?.message || 'The turn failed' });
            return;

        case 'error':
            onEvent({ type: 'error', message: event.message || 'Codex reported an error' });
            return;

        default:
    }
}

/** What went wrong, in words that say what to do about it. */
function describeFailure(error) {
    const message = error?.message || String(error);
    if (/not logged in|unauthor|401/i.test(message)) {
        return 'Codex is not signed in on this machine. Sign in with the Codex app, or run "codex login" '
            + 'in a terminal, then try again.';
    }
    // Windows refuses to spawn a .cmd without a shell, which is the shim an npm
    // install leaves behind when its platform package is missing alongside it.
    if (/EINVAL/i.test(message)) {
        return 'The Codex CLI on this machine is a script shim that cannot be started directly. '
            + 'Reinstall Codex, or put a real codex executable on PATH.';
    }
    if (/ENOENT|not found/i.test(message)) {
        return 'The Codex CLI could not be started. Check that Codex is installed and on PATH.';
    }
    return message;
}

/**
 * What this Codex can run, and how hard each of them will think.
 *
 * Not in the SDK, which takes `model` as a free string and says nothing about
 * what it accepts. It is in the app server: `codex app-server` speaks
 * line-delimited JSON-RPC on stdio, and `model/list` is the request the
 * desktop app's own picker is built on. So this brings one up, asks, and
 * shuts it down.
 *
 * Worth the spawn for what comes back, which is better than a list of names:
 * every model reports the reasoning efforts it actually supports, and they
 * differ (the 5.6 line has `ultra`, the 5.4 line stops at `xhigh`). That is
 * what lets the dial offer a model's real scale instead of a guess.
 */
async function listModels({ settings = {} } = {}) {
    const binary = findCodex();
    if (!binary) return null;

    // It is a local process answering from a cache, not a network call. If it
    // has not spoken by now something is wrong with the install, and the menus
    // have a row that works without it.
    const server = appServer(binary, { env: accountEnv(settings), timeout: 20000 });
    try {
        await server.ready;
        const result = await server.request('model/list', { includeHidden: false });
        return describeModels(result?.data);
    } catch {
        return null;
    } finally {
        server.close();
    }
}

/**
 * A name for a conversation, from `codex exec` with nothing to do.
 *
 * Its own process rather than a thread on the SDK, for two flags the SDK has
 * no way to pass: `--ephemeral`, so the question is not a session in the
 * user's Codex history, and `--ignore-user-config`, so their MCP servers are
 * not started to answer it. Read-only, in the temp directory, low effort.
 * See titles.js.
 */
function title({ settings = {}, instruction, prompt, signal } = {}) {
    const binary = findCodex();
    if (!binary) return Promise.resolve('');

    const args = [
        'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--json',
        '--sandbox', 'read-only', '--cd', os.tmpdir(),
        '--config', 'model_reasoning_effort="low"',
        '--config', 'web_search="disabled"',
        '--config', 'approval_policy="never"',
    ];
    if (settings.model) args.push('--model', settings.model);
    args.push('-');

    const env = accountEnv(settings);
    if (settings.apiKey) env.OPENAI_API_KEY = settings.apiKey;

    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
        } catch {
            resolve('');
            return;
        }

        const stop = () => {
            try { child.kill(); } catch { /* already gone */ }
        };
        signal?.addEventListener('abort', stop, { once: true });

        let text = '';
        let buffer = '';
        child.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            let index = buffer.indexOf('\n');
            while (index >= 0) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
                let event;
                try { event = JSON.parse(line); } catch { continue; }
                if (event?.type === 'item.completed' && event.item?.type === 'agent_message') {
                    text = event.item.text || '';
                }
            }
        });
        child.on('error', () => resolve(''));
        child.on('close', () => {
            signal?.removeEventListener('abort', stop);
            resolve(text);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(`${instruction}\n\n${prompt}`);
    });
}

/** The environment a run or a question runs under: this machine's, moved to the account's home. */
function accountEnv(settings = {}) {
    return { ...process.env, ...(settings.accountEnv || {}) };
}

/**
 * `codex app-server`, brought up for a few questions and put down again.
 *
 * Line-delimited JSON-RPC on stdio: the protocol the desktop app and the
 * editor extension are built on, and the only place Codex answers questions
 * about the account rather than about a thread. `ready` settles once the
 * handshake is done; `request` sends one call and resolves its result;
 * notifications go to `onNotification`. Everything is torn down on `close`
 * or when `timeout` runs out, whichever comes first.
 */
function appServer(binary, { env = process.env, timeout = 20000, onNotification = () => {}, onClose = () => {} } = {}) {
    let child = null;
    let closed = false;
    let nextRequest = 1;
    const waiting = new Map();

    const fail = (error) => {
        for (const entry of waiting.values()) entry.reject(error);
        waiting.clear();
    };

    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        fail(new Error('The Codex app server closed.'));
        try { child?.kill(); } catch { /* already gone */ }
        try { onClose(); } catch { /* the listener's problem */ }
    };

    const timer = setTimeout(close, timeout);
    timer.unref?.();

    // Settles once the process has really gone, which on Windows is later
    // than the kill: until then it holds its CODEX_HOME open, and a folder
    // being deleted after a sign-out is refused.
    let markExited = () => {};
    const exited = new Promise((resolve) => { markExited = resolve; });

    try {
        child = spawn(binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env, windowsHide: true });
    } catch (error) {
        close();
        markExited();
        const failed = Promise.reject(error);
        failed.catch(() => {});
        return { ready: failed, request: () => failed, close, exited };
    }

    child.on('error', () => { close(); markExited(); });
    child.on('exit', () => { close(); markExited(); });

    const send = (payload) => {
        try {
            child.stdin.write(`${JSON.stringify(payload)}\n`);
        } catch (error) {
            close();
        }
    };

    const request = (method, params) => new Promise((resolve, reject) => {
        if (closed) {
            reject(new Error('The Codex app server closed.'));
            return;
        }
        const id = nextRequest++;
        waiting.set(id, { resolve, reject });
        send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    });

    let buffer = '';
    child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
            if (!line) continue;

            let message;
            try { message = JSON.parse(line); } catch { continue; }

            if (message.id !== undefined && waiting.has(message.id)) {
                const entry = waiting.get(message.id);
                waiting.delete(message.id);
                if (message.error) entry.reject(new Error(message.error.message || 'Codex refused the request.'));
                else entry.resolve(message.result);
            } else if (message.method && message.id === undefined) {
                try { onNotification(message.method, message.params || {}); } catch { /* the listener's problem */ }
            }
        }
    });

    const ready = request('initialize', {
        clientInfo: { name: 'cloudblast', title: 'CloudTerm', version: '1.0.0' },
    });
    ready.catch(() => {});

    return { ready, request, close, exited };
}

/** Codex's account answer, as the identity the settings page shows. */
function describeAccount(result) {
    const account = result?.account;
    if (!account) return { signedIn: false, email: '', plan: '', organization: '', method: '' };
    return {
        signedIn: true,
        email: account.type === 'chatgpt' ? account.email || '' : '',
        plan: account.type === 'chatgpt' ? account.planType || '' : '',
        organization: '',
        method: account.type === 'chatgpt' ? 'chatgpt' : account.type || '',
    };
}

/**
 * Who the account is and how much of its plan is left, without a turn.
 *
 * `account/read` then `account/rateLimits/read`, both answered from the
 * account's own login. An account signed in with an API key has no plan
 * windows, and says so by answering with none.
 */
async function readLimits({ settings = {} } = {}) {
    const binary = findCodex();
    if (!binary) return { identity: null, windows: [], error: 'Codex is not installed on this machine.' };

    const server = appServer(binary, { env: accountEnv(settings), timeout: 25000 });
    try {
        await server.ready;
        const identity = describeAccount(await server.request('account/read', { refreshToken: false }));
        if (!identity.signedIn) return { identity, windows: [] };
        if (identity.method !== 'chatgpt') return { identity, windows: [], planless: true };
        const limits = await server.request('account/rateLimits/read');
        return { identity, windows: require('../limits').fromCodexLimits(limits) };
    } catch (error) {
        return { identity: null, windows: [], error: describeFailure(error) };
    } finally {
        server.close();
    }
}

/**
 * Sign an account in, through the browser.
 *
 * The app server does the whole OAuth dance itself when asked: it starts its
 * own callback listener, answers with the address to open, and announces
 * `account/login/completed` when the browser comes back. The login is written
 * to the account's CODEX_HOME, which is what makes this an account and not
 * the machine's.
 *
 *   onProgress   called with `{ url }` once there is a page to open
 *
 * Resolves `{ ok, message }`. `cancel` stops waiting and takes the server down.
 */
function login({ settings = {}, onProgress = () => {} } = {}) {
    const binary = findCodex();
    if (!binary) {
        return { done: Promise.resolve({ ok: false, message: 'Codex is not installed on this machine.' }), cancel() {} };
    }

    let finish = () => {};
    const done = new Promise((resolve) => { finish = resolve; });
    let settled = false;
    let loginId = null;
    let server = null;
    const settle = (verdict) => {
        if (settled) return;
        settled = true;
        server?.close();
        finish(verdict);
    };

    // Ten minutes is long enough to find a password and short enough that a
    // forgotten attempt does not keep a listener open for the afternoon. A
    // server that goes away before the browser comes back has said no.
    server = appServer(binary, {
        onClose: () => settle({ ok: false, message: 'The sign-in timed out, or Codex stopped before it finished.' }),
        env: accountEnv(settings),
        timeout: 10 * 60 * 1000,
        onNotification: (method, params) => {
            if (method !== 'account/login/completed') return;
            if (loginId && params.loginId && params.loginId !== loginId) return;
            settle(params.success
                ? { ok: true, message: '' }
                : { ok: false, message: params.error || 'The sign-in did not complete.' });
        },
    });

    (async () => {
        try {
            await server.ready;
            const started = await server.request('account/login/start', { type: 'chatgpt' });
            loginId = started?.loginId || null;
            if (started?.authUrl) onProgress({ url: started.authUrl });
        } catch (error) {
            settle({ ok: false, message: describeFailure(error) });
        }
    })();

    return {
        done,
        cancel() {
            if (loginId) server.request('account/login/cancel', { loginId }).catch(() => {});
            settle({ ok: false, message: 'Cancelled.' });
        },
    };
}

/** Sign an account out, removing its login from its CODEX_HOME. */
async function logout({ settings = {} } = {}) {
    const binary = findCodex();
    if (!binary) return { ok: false };
    const server = appServer(binary, { env: accountEnv(settings), timeout: 15000 });
    try {
        await server.ready;
        await server.request('account/logout');
        return { ok: true };
    } catch {
        return { ok: false };
    } finally {
        server.close();
        // Bounded: a process that will not die is not worth hanging a
        // settings page on.
        await Promise.race([server.exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    }
}

/** One `model/list` row, as the app's menus need it. */
function describeModels(rows) {
    if (!Array.isArray(rows)) return null;

    const models = rows
        .filter(row => row && typeof row.id === 'string' && row.id && !row.hidden)
        .map(row => ({
            value: row.id,
            resolved: row.model || row.id,
            label: row.displayName || row.id,
            short: row.displayName || row.id,
            description: String(row.description || '').slice(0, 200),
            // Codex names its own default, so the menu has something better to
            // show than a row saying "whatever Codex is set to": the model
            // that phrase actually refers to.
            preferred: Boolean(row.isDefault),
            effort: (row.supportedReasoningEfforts || [])
                .map(entry => entry?.reasoningEffort)
                .filter(level => EFFORT_LEVELS.has(level)),
        }))
        .slice(0, 24);

    return models.length ? models : null;
}

/** Whether the CLI is on this machine. See the note on claude-code's. */
function detect() {
    return { ok: Boolean(findCodex()), reason: 'notFound' };
}

module.exports = {
    start,
    title,
    listModels,
    detect,
    readLimits,
    login,
    logout,
    describeAccount,
    findCodex,
    codexAppRoots,
    codexRoots,
    stageImages,
    turnInput,
    threadOptions,
    workspaceFor,
    translate,
    SERVER_NAME,
    // Pictures go in as files on the turn's command line: see `stageImages`.
    supportsImages: true,
};
