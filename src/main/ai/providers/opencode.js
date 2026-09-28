const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');
const spawn = require('cross-spawn');
const { app } = require('electron');

const catalog = require('../tools');
const mcpHost = require('../mcp-host');

/**
 * The OpenCode provider.
 *
 * OpenCode exposes its agent as a loopback HTTP server. We start the user's
 * installed CLI, connect with the official SDK, and translate its SSE stream
 * into the same transcript events as Claude Code and Codex.
 *
 * Its own filesystem and shell tools are denied unless the app's local-tools
 * switch is on. The remote tools are served by `mcp-host`, whose handlers own
 * the approval policy, live SSH sessions, and activity log.
 */

const SERVER_NAME = 'remote';
const START_TIMEOUT = 20000;

let sdkPromise = null;

function loadSdk() {
    if (!sdkPromise) {
        sdkPromise = import('@opencode-ai/sdk').catch((error) => {
            sdkPromise = null;
            throw new Error(`The OpenCode SDK could not be loaded: ${error.message}`);
        });
    }
    return sdkPromise;
}

function envValue(env, ...names) {
    for (const name of names) {
        if (env?.[name]) return env[name];
    }
    return '';
}

/** Every native location supported by OpenCode's Windows installers. */
function openCodeCandidates({
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
} = {}) {
    const windows = platform === 'win32';
    const paths = windows ? path.win32 : path;
    const names = windows ? ['opencode.exe', 'opencode.cmd', 'opencode.bat'] : ['opencode'];
    const pathEntries = String(envValue(env, 'PATH', 'Path', 'path'))
        .split(windows ? ';' : path.delimiter)
        .filter(Boolean);
    const roots = [...pathEntries];

    if (windows) {
        const appData = envValue(env, 'APPDATA', 'AppData');
        const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData');
        const chocolatey = envValue(env, 'ChocolateyInstall', 'CHOCOLATEYINSTALL');
        const scoop = envValue(env, 'SCOOP', 'Scoop') || paths.join(home, 'scoop');

        roots.push(
            paths.join(home, '.opencode', 'bin'),
            paths.join(scoop, 'shims'),
            appData && paths.join(appData, 'npm'),
            localAppData && paths.join(localAppData, 'opencode', 'bin'),
            localAppData && paths.join(localAppData, 'Programs', 'opencode', 'bin'),
            chocolatey && paths.join(chocolatey, 'bin')
        );
    } else {
        roots.push(
            paths.join(home, '.opencode', 'bin'),
            paths.join(home, '.local', 'bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin'
        );
    }

    return [...new Set(roots.filter(Boolean).flatMap(root => names.map(name => paths.join(root, name))))];
}

/**
 * Where OpenCode Desktop puts itself, per platform.
 *
 * The desktop app ships no CLI. Its server is a bundle inside its app.asar,
 * run by the app as a sidecar under its own Electron; the same can be done
 * from here, with the app's executable as plain Node and a launcher of ours
 * (opencode-desktop-serve.mjs) that imports the bundle and listens. Each
 * candidate is the executable and the archive beside it.
 */
function desktopCandidates({
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
} = {}) {
    const windows = platform === 'win32';
    // The platform is an argument, so the separators follow it rather than
    // the machine running the check.
    const paths = windows ? path.win32 : path.posix;
    const found = [];
    if (windows) {
        const localAppData = envValue(env, 'LOCALAPPDATA', 'LocalAppData');
        for (const folder of ['@opencode-aidesktop', 'OpenCode', 'opencode-desktop']) {
            if (!localAppData) break;
            const root = paths.join(localAppData, 'Programs', folder);
            found.push({ exe: paths.join(root, 'OpenCode.exe'), asar: paths.join(root, 'resources', 'app.asar') });
        }
    } else if (platform === 'darwin') {
        for (const root of ['/Applications/OpenCode.app', paths.join(home, 'Applications', 'OpenCode.app')]) {
            found.push({ exe: paths.join(root, 'Contents', 'MacOS', 'OpenCode'), asar: paths.join(root, 'Contents', 'Resources', 'app.asar') });
        }
    } else {
        for (const root of ['/opt/OpenCode', '/opt/opencode-desktop', '/usr/lib/opencode-desktop']) {
            found.push({ exe: paths.join(root, 'opencode-desktop'), asar: paths.join(root, 'resources', 'app.asar') });
        }
    }
    return found;
}

/**
 * Whether the archive is there.
 *
 * Under Electron, `fs` treats an app.asar as a directory it can read into,
 * and `accessSync` on the archive itself answers ENOENT for the root of
 * it. `statSync` answers, as a directory. Under plain Node it is a file.
 * Either answer means the archive exists; only a throw means it does not.
 */
function archivePresent(target, { accessSync = fs.accessSync, statSync = fs.statSync } = {}) {
    try {
        accessSync(target, fs.constants.F_OK);
        return true;
    } catch {
        // The shim's ENOENT, or a real one: stat tells them apart.
    }
    try {
        statSync(target);
        return true;
    } catch {
        return false;
    }
}

/** The desktop app's executable and archive, when both are there. */
function findOpenCodeDesktop(options = {}) {
    const accessSync = options.accessSync || fs.accessSync;
    const statSync = options.statSync || (options.accessSync ? () => { throw new Error('missing'); } : fs.statSync);
    for (const candidate of desktopCandidates(options)) {
        try {
            accessSync(candidate.exe, fs.constants.F_OK);
        } catch {
            continue;
        }
        if (archivePresent(candidate.asar, { accessSync, statSync })) return candidate;
    }
    return null;
}

/**
 * How to start a server on this machine: the CLI when there is one, the
 * desktop app's bundle otherwise. `args` takes the port, since it is
 * reserved at launch. Nothing found is null.
 */
function findOpenCodeLaunch(options = {}) {
    const binary = findOpenCode(options);
    if (binary) {
        return {
            kind: 'cli',
            label: binary,
            command: binary,
            args: (port) => ['serve', '--hostname=127.0.0.1', `--port=${port}`],
            env: {},
        };
    }
    const desktop = findOpenCodeDesktop(options);
    if (desktop) {
        return {
            kind: 'desktop',
            label: desktop.exe,
            command: desktop.exe,
            args: (port) => [path.join(__dirname, 'opencode-desktop-serve.mjs'), desktop.asar, '127.0.0.1', String(port)],
            env: { ELECTRON_RUN_AS_NODE: '1' },
        };
    }
    return null;
}

/** Find the CLI even when a packaged Electron app has a minimal PATH. */
function findOpenCode(options = {}) {
    const platform = options.platform || process.platform;
    const accessSync = options.accessSync || fs.accessSync;
    const candidates = openCodeCandidates({
        platform,
        env: options.env || process.env,
        home: options.home || os.homedir(),
    });

    for (const candidate of candidates) {
        try {
            accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
            return candidate;
        } catch {
            // Keep looking.
        }
    }
    return '';
}

/**
 * The app's effort scale, which is the part of OpenCode's that lines up.
 *
 * OpenCode calls a reasoning level a variant, and each model names its own:
 * `minimal, low, medium, high, xhigh` on one, `low, medium, high` on the
 * next, none at all on most. The stops the app has no name for are dropped
 * rather than approximated, which is the rule every other runtime's list
 * follows, and the menu hides the dial when nothing is left.
 */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * The efforts a model offers, read from `/config/providers`.
 *
 * The pinned SDK does not declare `variants` on a model, but the server has
 * sent them since 1.18: the types lag the API rather than the API lacking
 * the field, so this reads it off the response and does not care that
 * TypeScript has not caught up. A model without variants gets an empty
 * list, which is what every OpenCode model used to get.
 */
function variantsOf(model) {
    const named = model?.variants && typeof model.variants === 'object'
        ? Object.keys(model.variants)
        : [];
    return EFFORT_LEVELS.filter(level => named.includes(level));
}

/**
 * The level to ask for, which is not always the one that is set.
 *
 * The saved effort travels between runtimes and between models whose scales
 * differ, so a model that stops at `high` is asked for `high` when the
 * setting says `max`. Rounding down rather than resetting is what the menu
 * shows and what the other runtimes do with a level they cannot honour. An
 * effort off the scale entirely, or a model naming no variants, asks for
 * nothing and lets the runtime pick.
 */
function nearestVariant(offered, effort) {
    if (!offered?.length || !effort) return '';
    if (offered.includes(effort)) return effort;
    const wanted = EFFORT_LEVELS.indexOf(effort);
    if (wanted < 0) return '';
    for (let index = offered.length - 1; index >= 0; index -= 1) {
        if (EFFORT_LEVELS.indexOf(offered[index]) <= wanted) return offered[index];
    }
    return '';
}

/** OpenCode model ids are always `provider/model`, with model allowed slashes. */
function parseModel(value) {
    const text = String(value || '');
    const split = text.indexOf('/');
    if (split <= 0 || split === text.length - 1) return undefined;
    return { providerID: text.slice(0, split), modelID: text.slice(split + 1) };
}

/**
 * The last matching OpenCode permission wins. Deny/ask everything first,
 * then allow only our MCP namespace: its real approval happens in mcp-host.
 *
 * `question` is the exception, and it is allowed whatever the local-tools
 * switch says. It is not a local tool in the sense the switch means: it
 * touches nothing, it asks the user something, and the answer is given on
 * the same card `ask_user` uses (see `answerQuestion`). Left to the `*`
 * rule it was either refused for no good reason or, on the versions that
 * treat it as a control tool outside the glob, asked and never answered,
 * which stopped the turn dead.
 */
function permissions(allowLocalTools) {
    return {
        '*': allowLocalTools ? 'ask' : 'deny',
        [`${SERVER_NAME}_*`]: 'allow',
        question: 'allow',
    };
}

function serverConfig({ url, token, allowLocalTools = false, maxTurns = 40 } = {}) {
    const permission = permissions(allowLocalTools);
    return {
        share: 'disabled',
        autoupdate: false,
        instructions: [],
        plugin: [],
        permission,
        // Kept for OpenCode versions predating the unified permission field.
        tools: allowLocalTools ? undefined : {
            '*': false,
            [`${SERVER_NAME}_*`]: true,
            question: true,
        },
        agent: {
            cloudblast: {
                description: 'Operate the remote systems visible in CloudBlast SSH.',
                mode: 'primary',
                maxSteps: maxTurns,
                permission,
            },
        },
        ...(url ? {
            mcp: {
                [SERVER_NAME]: {
                    type: 'remote',
                    url,
                    headers: { Authorization: `Bearer ${token}` },
                    oauth: false,
                    timeout: 20000,
                },
            },
        } : {}),
    };
}

function reservePort() {
    return new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.unref();
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', () => {
            const port = socket.address().port;
            socket.close(error => (error ? reject(error) : resolve(port)));
        });
    });
}

/** Spawn one private OpenCode server and wait until it publishes its URL. */
async function launchServer(launch, config, directory) {
    // A bare path is the CLI, for the callers and tests that pass one.
    const spec = typeof launch === 'string'
        ? { command: launch, args: (port) => ['serve', '--hostname=127.0.0.1', `--port=${port}`], env: {} }
        : launch;
    const port = await reservePort();
    return new Promise((resolve, reject) => {
        let child;
        let timer;
        let settled = false;
        let output = '';

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) {
                closeProcess(child);
                reject(error);
            } else {
                resolve(value);
            }
        };

        timer = setTimeout(() => {
            finish(new Error(`OpenCode did not start within ${START_TIMEOUT / 1000} seconds`));
        }, START_TIMEOUT);

        try {
            child = spawn(spec.command, spec.args(port), {
                cwd: directory,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ...(spec.env || {}),
                    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
                },
            });
        } catch (error) {
            finish(error);
            return;
        }

        const read = (chunk) => {
            output = `${output}${chunk.toString('utf8')}`.slice(-16000);
            const match = output.match(/opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/i);
            if (match) finish(null, { child, url: match[1] });
        };

        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.once('error', error => finish(error));
        child.once('exit', (code) => {
            if (!settled) {
                const detail = output.trim() ? `: ${output.trim().slice(-1000)}` : '';
                finish(new Error(`OpenCode exited before it was ready (code ${code})${detail}`));
            }
        });
    });
}

/**
 * The client's `fetch`, over plain http, because a turn takes longer than
 * five minutes.
 *
 * `client.session.prompt` holds one request open for the whole of a turn:
 * the answer arrives on the event stream, and that call resolves when the
 * agent has finished thinking. Node's own fetch gives a response 300
 * seconds to begin, and past that it drops the socket, which surfaced as
 * "fetch failed" and took the run down with it. Two turns in a row died at
 * 307 seconds, which is that limit and not a coincidence.
 *
 * The timeout cannot be moved without reaching for undici, which is only
 * here through a build tool and would not be in a packaged app. Node's own
 * http client has no such limit, so this is that: one request, streamed
 * both ways, aborting when the caller's signal says to. The server is on
 * the loopback interface, so there is no TLS and no redirect to handle.
 */
async function loopbackFetch(request) {
    const url = new URL(request.url);
    const body = ['GET', 'HEAD'].includes(request.method)
        ? null
        : Buffer.from(await request.arrayBuffer());

    return new Promise((resolve, reject) => {
        const headers = {};
        request.headers.forEach((value, name) => { headers[name] = value; });
        if (body) headers['content-length'] = String(body.length);

        const outgoing = http.request({
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: request.method,
            headers,
        }, (incoming) => {
            resolve(new Response(
                // A stream rather than a buffer: the event subscription is an
                // open-ended one, and buffering it would never resolve.
                incoming.statusCode === 204 || incoming.statusCode === 304
                    ? null
                    : Readable.toWeb(incoming),
                {
                    status: incoming.statusCode,
                    statusText: incoming.statusMessage,
                    headers: Object.entries(incoming.headers)
                        .filter(([, value]) => value !== undefined)
                        .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value)]),
                },
            ));
        });

        outgoing.on('error', reject);

        const signal = request.signal;
        if (signal) {
            if (signal.aborted) {
                outgoing.destroy(new Error('aborted'));
                reject(new DOMException('The request was aborted', 'AbortError'));
                return;
            }
            signal.addEventListener('abort', () => {
                outgoing.destroy(new Error('aborted'));
                reject(new DOMException('The request was aborted', 'AbortError'));
            }, { once: true });
        }

        if (body) outgoing.write(body);
        outgoing.end();
    });
}

function dataOf(response) {
    return response && Object.prototype.hasOwnProperty.call(response, 'data')
        ? response.data
        : response;
}

function closeProcess(child, {
    platform = process.platform,
    spawnSyncFn = spawnSync,
} = {}) {
    if (!child || child.exitCode != null || child.signalCode != null) return;

    // A .cmd npm shim owns the actual OpenCode process beneath cmd.exe.
    // Killing only the shim leaves the server listening after CloudBlast
    // closes, so Windows gets the same whole-tree shutdown OpenCode's SDK uses.
    if (platform === 'win32' && child.pid) {
        const result = spawnSyncFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
        });
        if (!result.error && result.status === 0) return;
    }
    try { child.kill(); } catch { /* already gone */ }
}

/** Turn one OpenCode SSE event into panel events, with transition deduping. */
function createTranslator(sessionId, onEvent) {
    const textFinished = new Set();
    const toolStates = new Map();
    const completedMessages = new Set();
    let turnOpen = false;
    let turnCost = 0;

    const belongs = (value) => value === sessionId;
    const toolName = raw => String(raw || '').replace(new RegExp(`^${SERVER_NAME}_`), '');

    const finishTurn = (subtype = 'success', isError = false) => {
        if (!turnOpen) return;
        turnOpen = false;
        onEvent({ type: 'result', subtype, isError, costUsd: turnCost });
        turnCost = 0;
    };

    const failTurn = (error) => {
        onEvent({ type: 'error', message: describeFailure(error) });
        turnOpen = false;
        turnCost = 0;
    };

    return {
        beginTurn() {
            turnOpen = true;
            turnCost = 0;
        },
        fail(error) {
            failTurn(error);
        },
        /** Whether a turn is still waiting to be ended. See the pump. */
        open() {
            return turnOpen;
        },
        finish: finishTurn,
        async event(event, answerPermission, answerQuestion) {
            const properties = event?.properties || {};

            if (event?.type === 'message.part.updated') {
                const part = properties.part;
                if (!part || !belongs(part.sessionID)) return;

                if (part.type === 'text') {
                    if (properties.delta) onEvent({ type: 'text-delta', text: properties.delta });
                    if (part.time?.end && !part.synthetic && !part.ignored && !textFinished.has(part.id)) {
                        textFinished.add(part.id);
                        onEvent({ type: 'assistant-text', text: part.text || '' });
                    }
                    return;
                }

                if (part.type === 'reasoning') {
                    if (properties.delta) onEvent({ type: 'thinking-delta', text: properties.delta });
                    return;
                }

                if (part.type !== 'tool') return;
                const state = part.state || {};
                const previous = toolStates.get(part.callID);
                const local = !String(part.tool || '').startsWith(`${SERVER_NAME}_`);

                if (!['running', 'completed', 'error'].includes(previous)
                    && ['running', 'completed', 'error'].includes(state.status)) {
                    onEvent({
                        type: 'tool-call',
                        id: part.callID,
                        name: toolName(part.tool),
                        rawName: part.tool,
                        local,
                        input: state.input || {},
                    });
                }

                if (!['completed', 'error'].includes(previous)
                    && ['completed', 'error'].includes(state.status)) {
                    onEvent({
                        type: 'tool-result',
                        id: part.callID,
                        text: state.status === 'error' ? (state.error || '') : (state.output || ''),
                        isError: state.status === 'error',
                    });
                }
                toolStates.set(part.callID, state.status);
                return;
            }

            if (event?.type === 'message.updated') {
                const info = properties.info;
                if (!info || !belongs(info.sessionID) || info.role !== 'assistant' || !info.time?.completed) return;
                if (!completedMessages.has(info.id)) {
                    completedMessages.add(info.id);
                    turnCost += Number(info.cost) || 0;
                }
                if (info.error) {
                    onEvent({ type: 'error', message: describeFailure(info.error) });
                }
                return;
            }

            if (event?.type === 'permission.updated' && belongs(properties.sessionID)) {
                await answerPermission(properties);
                return;
            }

            // A question from the runtime's own `question` tool. Not awaited,
            // unlike a permission: the person has fifteen minutes to answer and
            // the stream has to keep flowing behind the card, or the transcript
            // freezes and the idle that ends the turn never gets read.
            // answerQuestion settles the request itself and never throws.
            if ((event?.type === 'question.asked' || event?.type === 'question.v2.asked')
                && belongs(properties.sessionID)) {
                if (typeof answerQuestion === 'function') {
                    Promise.resolve(answerQuestion(properties, event.type === 'question.v2.asked'))
                        .catch(() => { /* it settles the request itself; nothing left to do here */ });
                }
                return;
            }

            if (event?.type === 'session.error' && (!properties.sessionID || belongs(properties.sessionID))) {
                failTurn(properties.error);
                return;
            }

            if ((event?.type === 'session.idle' && belongs(properties.sessionID))
                || (event?.type === 'session.status'
                    && belongs(properties.sessionID)
                    && properties.status?.type === 'idle')) {
                finishTurn();
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
    const launch = findOpenCodeLaunch();
    if (!launch) {
        throw new Error('OpenCode is not installed on this machine: neither its CLI nor OpenCode Desktop could be found');
    }

    const directory = app.getPath('userData');
    const { url: mcpUrl, token } = await mcpHost.acquire({ toolContext, requestApproval, onEvent });
    let server;

    try {
        server = await launchServer(launch, serverConfig({
            url: mcpUrl,
            token,
            allowLocalTools: settings.allowLocalTools,
            maxTurns: settings.maxTurns,
        }), directory);
    } catch (error) {
        await mcpHost.release(token);
        throw error;
    }

    let sdk;
    let client;
    let session;
    try {
        sdk = await loadSdk();
        client = sdk.createOpencodeClient({
            baseUrl: server.url,
            directory,
            throwOnError: true,
            // See loopbackFetch: a turn outlives Node's own fetch timeout.
            fetch: loopbackFetch,
        });

        if (resumeSessionId) {
            try {
                session = dataOf(await client.session.get({ path: { id: resumeSessionId } }));
            } catch {
                // A stale id should start a usable conversation, not brick it.
            }
        }
        if (!session) {
            session = dataOf(await client.session.create({
                body: { title: 'CloudBlast SSH' },
            }));
        }
    } catch (error) {
        closeProcess(server.child);
        await mcpHost.release(token);
        throw error;
    }
    if (!session?.id) {
        closeProcess(server.child);
        await mcpHost.release(token);
        throw new Error('OpenCode started but did not create a session');
    }

    onEvent({ type: 'session', sessionId: session.id, model: settings.model || '' });
    const translator = createTranslator(session.id, onEvent);
    const abortEvents = new AbortController();

    const answerPermission = async (permission) => {
        const current = getSettings();
        const remote = String(permission.type || '').startsWith(`${SERVER_NAME}_`);
        let approved = remote;
        if (!remote && current.allowLocalTools) {
            const input = {
                ...(permission.metadata || {}),
                ...(permission.pattern ? { pattern: permission.pattern } : {}),
            };
            // The approval mode applies to OpenCode's own tools as it does to
            // ours: under "never" nothing waits, and a read under the default
            // is not worth a card. Without this every grep and every file read
            // stopped the run, whatever the user had chosen.
            if (catalog.nativeAutoApproved(permission.type || '', input, current)) {
                approved = true;
            } else {
                const verdict = await requestApproval({
                    toolName: permission.type || permission.title || 'tool',
                    name: permission.type || 'tool',
                    input,
                    local: true,
                });
                approved = verdict.approved;
            }
        }
        try {
            await client.postSessionIdPermissionsPermissionId({
                path: { id: session.id, permissionID: permission.id },
                body: { response: approved ? 'once' : 'reject' },
            });
        } catch (error) {
            if (!abortEvents.signal.aborted) onEvent({ type: 'error', message: describeFailure(error) });
        }
    };

    /**
     * OpenCode's own `question` tool, answered on the app's question card.
     *
     * A question is not a permission. The model asks the person something,
     * the session blocks, and it stays blocked until an answer or a
     * rejection is posted back on a separate endpoint. Nothing here was
     * listening for it, so a model that reached for the tool stopped the
     * turn dead: the call drew in the transcript, no card was ever put up,
     * the session never went idle and the turn never ended. It is the same
     * question `ask_user` asks, so it goes on the same card, and whatever
     * happens the request is settled so the session is never left waiting.
     */
    const answerQuestion = async (request, v2) => {
        const requestId = String(request?.id || '');
        if (!requestId) return;
        const asked = Array.isArray(request.questions) ? request.questions : [];
        const answers = [];
        // Nowhere to put a card, so the question is turned down at once
        // rather than held open against a screen nobody is looking at.
        let parked = typeof toolContext?.askUser !== 'function';

        for (const item of parked ? [] : asked) {
            const options = (item?.options || [])
                .map(option => String(option?.label || '').trim())
                .filter(Boolean)
                .slice(0, 6);
            let reply;
            try {
                // No signal: this process can wait for a person properly, and
                // the runtime is waiting on the endpoint rather than on a call
                // it might give up on. See requestQuestion's QUESTION_WAIT.
                reply = await toolContext.askUser({
                    question: String(item?.question || item?.header || '').trim() || 'The agent has a question.',
                    options,
                });
            } catch {
                reply = { answered: false };
            }
            if (!reply?.answered) {
                // Nobody answered, or they dismissed it. Reject rather than
                // invent an answer: the tool call fails, the model ends its
                // turn, and the card stays up so a later answer arrives as
                // the next message.
                parked = true;
                break;
            }
            // One answer per question, each a list of the labels chosen.
            answers.push([String(reply.answer ?? '')]);
        }

        await settleQuestion({ requestId, sessionId: session.id, v2, answers, reject: parked });
    };

    /**
     * Post the answer back, on whichever of the two routes this build has.
     *
     * The session-scoped route is the newer one and the flat one is what
     * older builds serve. The event says which flavour asked, and a 404 or
     * 405 means this build only knows the other, so the fallback is tried
     * before giving up: a question left unsettled is a hung turn, which is
     * the failure this whole path exists to prevent.
     */
    const settleQuestion = async ({ requestId, sessionId, v2, answers, reject }) => {
        const verb = reject ? 'reject' : 'reply';
        const query = `?directory=${encodeURIComponent(directory)}`;
        const scoped = `${server.url}/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/${verb}${query}`;
        const flat = `${server.url}/question/${encodeURIComponent(requestId)}/${verb}${query}`;
        const routes = v2 ? [scoped, flat] : [flat, scoped];

        let last = null;
        for (const url of routes) {
            if (abortEvents.signal.aborted) return;
            try {
                const response = await loopbackFetch(new Request(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(reject ? {} : { answers }),
                }));
                // loopbackFetch hands back a live socket, so the body is read
                // whatever the status: an unread one is a connection left open.
                await response.text().catch(() => {});
                if (response.ok) return;
                // Only a route this build does not serve is worth retrying
                // elsewhere. A 400 is our payload and would fail twice.
                if (response.status !== 404 && response.status !== 405) {
                    last = new Error(`OpenCode would not take the answer (${response.status})`);
                    break;
                }
                last = new Error(`OpenCode has no route for this question (${response.status})`);
            } catch (error) {
                last = error;
            }
        }
        if (last && !abortEvents.signal.aborted) {
            onEvent({ type: 'error', message: describeFailure(last) });
        }
    };

    let events;
    try {
        events = await client.event.subscribe({ signal: abortEvents.signal });
    } catch (error) {
        abortEvents.abort();
        closeProcess(server.child);
        await mcpHost.release(token);
        throw error;
    }
    const pump = (async () => {
        try {
            for await (const event of events.stream) {
                await translator.event(event, answerPermission, answerQuestion);
            }
            // The stream ended without anyone asking it to. A server that has
            // gone away sends no `session.idle`, so a turn still open here
            // would sit spinning for ever with nothing left to end it.
            if (!abortEvents.signal.aborted && translator.open()) {
                translator.fail(new Error('The OpenCode server stopped before the turn finished.'));
            }
        } catch (error) {
            if (!abortEvents.signal.aborted) translator.fail(error);
        }
    })();

    let running = Promise.resolve();
    let closed = false;

    /**
     * What each model calls its reasoning levels, asked once per session.
     *
     * An effort is only ever sent as a variant the model actually names, so
     * the list has to be in hand before the first turn. Read once here
     * rather than per turn, and a failure is not fatal: no variants means
     * the runtime picks its own level, which is what it did before any of
     * this existed.
     */
    let variants = new Map();
    try {
        const catalogue = dataOf(await client.config.providers());
        for (const entry of catalogue?.providers || []) {
            for (const model of Object.values(entry.models || {})) {
                if (model?.id) variants.set(`${entry.id}/${model.id}`, variantsOf(model));
            }
        }
    } catch {
        variants = new Map();
    }

    const turn = async (text) => {
        translator.beginTurn();
        const current = getSettings();
        const model = parseModel(current.model);
        const variant = model ? nearestVariant(variants.get(current.model), current.effort) : '';

        // Said twice, because the two ways of saying it landed in different
        // builds. The session route is the one this app can prove takes it,
        // and the prompt's own model is what the turn is actually run with,
        // so whichever the build honours, both agree. Neither is sent unless
        // the model named this variant itself, so a build too old to report
        // variants is asked for nothing and behaves exactly as before.
        if (variant) {
            try {
                const url = `${server.url}/api/session/${encodeURIComponent(session.id)}/model`
                    + `?directory=${encodeURIComponent(directory)}`;
                const response = await loopbackFetch(new Request(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ model: { id: model.modelID, providerID: model.providerID, variant } }),
                }));
                await response.text().catch(() => {});
            } catch {
                // An older build has no such route. The prompt still carries it.
            }
        }

        try {
            await client.session.prompt({
                path: { id: session.id },
                body: {
                    agent: 'cloudblast',
                    system: systemPrompt,
                    ...(model ? { model: { ...model, ...(variant ? { variant } : {}) } } : {}),
                    parts: [{ type: 'text', text }],
                },
            });
        } catch (error) {
            if (!closed) translator.fail(error);
        }
    };

    return {
        send(text) {
            running = running.then(() => turn(text));
        },
        // Both are read from settings when the next prompt starts.
        async setModel() {},
        async setEffort() {},
        async interrupt() {
            translator.finish();
            try {
                await client.session.abort({ path: { id: session.id } });
            } catch {
                // Already idle or the server has gone away.
            }
        },
        async close() {
            closed = true;
            abortEvents.abort();
            try { await client.session.abort({ path: { id: session.id } }); } catch { /* idle */ }
            await running.catch(() => {});
            closeProcess(server.child);
            await pump.catch(() => {});
            await mcpHost.release(token);
        },
    };
}

/** Ask a short-lived local server for the providers/models OpenCode can use. */
async function listModels() {
    const launch = findOpenCodeLaunch();
    if (!launch) return null;

    const directory = app.getPath('userData');
    const server = await launchServer(launch, serverConfig(), directory);
    try {
        const sdk = await loadSdk();
        const client = sdk.createOpencodeClient({
            baseUrl: server.url,
            directory,
            throwOnError: true,
            // See loopbackFetch: a turn outlives Node's own fetch timeout.
            fetch: loopbackFetch,
        });
        const response = dataOf(await client.config.providers());
        const rows = [];

        for (const provider of response?.providers || []) {
            for (const model of Object.values(provider.models || {})) {
                if (!model?.id || model.status === 'deprecated') continue;
                const value = `${provider.id}/${model.id}`;
                rows.push({
                    value,
                    resolved: value,
                    label: model.name ? `${model.name} · ${provider.name}` : value,
                    short: model.name || model.id,
                    description: `${provider.name}${model.capabilities?.reasoning ? ' · reasoning' : ''}`,
                    preferred: false,
                    effort: variantsOf(model),
                });
            }
        }

        rows.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.label.localeCompare(b.label));
        return rows.slice(0, 100);
    } finally {
        closeProcess(server.child);
    }
}

function describeFailure(error) {
    const message = error?.data?.message || error?.message || String(error || 'Unknown error');
    if (/auth|credential|api[_ -]?key|unauthor|401|provider.*not found/i.test(message)) {
        return 'OpenCode could not authenticate with the selected model provider. Run "opencode auth login" '
            + 'in a terminal, then try again.';
    }
    if (/ENOENT|not found|spawn/i.test(message)) {
        return 'The OpenCode CLI could not be started. Install OpenCode and make sure its executable is available.';
    }
    return message;
}

/** Whether the CLI is on this machine. See the note on claude-code's. */
function detect() {
    return { ok: Boolean(findOpenCodeLaunch()), reason: 'notFound' };
}

module.exports = {
    start,
    listModels,
    detect,
    findOpenCode,
    findOpenCodeDesktop,
    findOpenCodeLaunch,
    openCodeCandidates,
    desktopCandidates,
    parseModel,
    variantsOf,
    nearestVariant,
    permissions,
    serverConfig,
    createTranslator,
    SERVER_NAME,
    _test: { launchServer, closeProcess, loopbackFetch },
};
