const { spawn } = require('child_process');
const sandboxModule = require('./sandbox');

/**
 * One hardened Docker container per agent.
 *
 * The app stays on the host. It holds the SSH sessions, the vault and the
 * tool server, and none of that moves. What moves into the container is the
 * agent's footprint on this machine: the local commands it runs, the files it
 * reads and writes, and the MCP servers from its inventory. The container is
 * the boundary for those, which is what lets a scheduled agent be given more
 * rope locally than one would hand a process with the run of the disk.
 *
 * The container is persistent per agent rather than per call, the way
 * OpenClaw scopes it: packages the agent installs and files it leaves in its
 * workspace are still there next conversation. "Reset" throws it away.
 *
 * Hardening, per Hermes Agent's defaults: every capability dropped, no
 * privilege escalation, a PID cap against fork bombs, a read-only root with
 * a small `noexec` /tmp, and a memory cap. Network is `none` unless the
 * agent's envelope says otherwise, because most of what this app's agents do
 * happens over SSH sessions the host holds, and a container with no way out
 * cannot leak what it was shown.
 *
 * The `docker` CLI is driven rather than the engine API, since the CLI is what
 * every install of Docker Desktop and Podman has on the path, and it speaks
 * to whichever socket that install uses without this file having to know.
 */

const PREFIX = 'acestes-agent-';
const NETWORK = 'acestes-agent';

/** How long a plain `docker` call gets before it is presumed hung. */
const COMMAND_TIMEOUT = 30000;

/** How long the first pull of an image may take. */
const PULL_TIMEOUT = 10 * 60 * 1000;

/** What one command inside the container may return, per stream. */
const MAX_OUTPUT = 60000;

const PIDS_LIMIT = 256;
const MEMORY = '4g';

let spawner = spawn;

/** For tests: replace the process launcher. */
function setSpawner(fn) {
    spawner = fn || spawn;
}

function containerName(agentId) {
    return PREFIX + String(agentId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function clip(text, limit) {
    if (text.length <= limit) return { text, truncated: false };
    return { text: text.slice(-limit), truncated: true };
}

/**
 * Run the docker CLI once and collect what it said.
 *
 * Never a shell: every argument is passed as-is, so a folder path with a
 * space or a command the model wrote cannot become a second docker command.
 */
function docker(args, { timeout = COMMAND_TIMEOUT, stdin = null } = {}) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawner('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (error) {
            resolve({ ok: false, code: null, stdout: '', stderr: error.message, missing: true });
            return;
        }

        let out = '';
        let err = '';
        let settled = false;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            try { child.kill(); } catch { /* gone */ }
            settle({ ok: false, code: null, timedOut: true, stdout: clip(out, MAX_OUTPUT).text, stderr: clip(err, MAX_OUTPUT).text });
        }, timeout);

        child.on('error', (error) => {
            settle({ ok: false, code: null, stdout: '', stderr: error.message, missing: error.code === 'ENOENT' });
        });
        child.stdout?.on('data', (data) => { if (out.length < MAX_OUTPUT * 4) out += data.toString('utf8'); });
        child.stderr?.on('data', (data) => { if (err.length < MAX_OUTPUT * 4) err += data.toString('utf8'); });
        child.on('close', (code) => {
            const stdout = clip(out, MAX_OUTPUT);
            const stderr = clip(err, MAX_OUTPUT);
            settle({ ok: code === 0, code, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated });
        });

        if (stdin !== null && child.stdin) {
            child.stdin.end(stdin);
        } else {
            child.stdin?.end();
        }
    });
}

/* ------------------------------------------------------------------ *
 * The daemon
 * ------------------------------------------------------------------ */

/**
 * Whether Docker is there and answering. The settings page asks this before
 * the switch is offered, so a container the machine cannot run is refused
 * with a reason rather than accepted and failed on the first tool call.
 */
async function probe() {
    const result = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 10000 });
    if (result.missing) {
        return { available: false, reason: 'Docker is not installed, or the docker command is not on the path.' };
    }
    if (!result.ok) {
        const text = (result.stderr || result.stdout).trim().split('\n')[0] || 'Docker did not answer.';
        return { available: false, reason: /cannot connect|failed to connect|not running|pipe/i.test(text)
            ? 'Docker is installed but the daemon is not running.'
            : text };
    }
    return { available: true, version: result.stdout.trim() };
}

/* ------------------------------------------------------------------ *
 * Creating
 * ------------------------------------------------------------------ */

/**
 * The `docker create` arguments for one agent's container.
 *
 * Pure, so a test can read what would be run. The order matters only to a
 * reader: flags first, mounts, then the image, then the command that keeps
 * the container alive, which is `sleep infinity` because a container with
 * nothing running in it is a stopped container.
 */
function createArgs(agentId, sandbox) {
    const envelope = sandboxModule.normalize(sandbox);
    const args = [
        'create',
        '--name', containerName(agentId),
        '--label', 'app=acestes-agent',
        '--label', `agent=${String(agentId || '')}`,
        '--cap-drop', 'ALL',
        '--cap-add', 'DAC_OVERRIDE',
        '--cap-add', 'CHOWN',
        '--cap-add', 'FOWNER',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', String(PIDS_LIMIT),
        '--memory', MEMORY,
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m',
        '--tmpfs', '/var/tmp:rw,noexec,nosuid,size=128m',
        '--tmpfs', '/run:rw,noexec,nosuid,size=16m',
        // The agent's own scratch space: a named volume so it survives a
        // reset of nothing but the image, and so nothing is written under the
        // read-only root.
        '--mount', `type=volume,source=${containerName(agentId)}-workspace,target=${sandboxModule.WORKSPACE}`,
        '--workdir', sandboxModule.WORKSPACE,
        '--network', envelope.network === 'any' ? 'bridge' : 'none',
        '--env', 'HOME=' + sandboxModule.WORKSPACE,
        '--env', 'LANG=C.UTF-8',
    ];

    for (const mount of sandboxModule.mountPlan(envelope)) {
        args.push('--mount', [
            'type=bind',
            `source=${mount.host}`,
            `target=${mount.container}`,
            ...(mount.mode === 'write' ? [] : ['readonly']),
        ].join(','));
    }

    args.push(envelope.image || sandboxModule.DEFAULT_IMAGE, 'sleep', 'infinity');
    return args;
}

/** Whether the container exists, and whether it is running. */
async function inspect(agentId) {
    const result = await docker(['inspect', '--format', '{{.State.Status}}|{{.Config.Image}}', containerName(agentId)]);
    if (!result.ok) return { exists: false };
    const [status, image] = result.stdout.trim().split('|');
    return { exists: true, running: status === 'running', status, image };
}

/**
 * The container for an agent, created and started if need be.
 *
 * Created fresh when the envelope that shaped it has changed: mounts and
 * network are fixed at creation, so a folder granted after the fact would
 * otherwise not appear until a reset. The envelope in force is kept as a
 * label and compared here.
 */
async function ensure(agentId, sandbox) {
    const envelope = sandboxModule.normalize(sandbox);
    const name = containerName(agentId);
    const wanted = JSON.stringify({ network: envelope.network, folders: envelope.folders, image: envelope.image });

    const labelled = await docker(['inspect', '--format', '{{index .Config.Labels "acestes.envelope"}}|{{.State.Status}}', name]);
    if (labelled.ok) {
        const [have, status] = labelled.stdout.trim().split('|');
        if (have === wanted) {
            if (status !== 'running') {
                const started = await docker(['start', name]);
                if (!started.ok) return { ok: false, message: started.stderr.trim() || 'The container could not be started.' };
            }
            return { ok: true, name, created: false };
        }
        await docker(['rm', '-f', name]);
    }

    const image = envelope.image || sandboxModule.DEFAULT_IMAGE;
    const present = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (!present.ok) {
        const pulled = await docker(['pull', image], { timeout: PULL_TIMEOUT });
        if (!pulled.ok) return { ok: false, message: `The image ${image} could not be pulled: ${pulled.stderr.trim()}` };
    }

    const args = createArgs(agentId, envelope);
    args.splice(1, 0, '--label', `acestes.envelope=${wanted}`);
    const created = await docker(args);
    if (!created.ok) return { ok: false, message: created.stderr.trim() || 'The container could not be created.' };

    const started = await docker(['start', name]);
    if (!started.ok) return { ok: false, message: started.stderr.trim() || 'The container could not be started.' };
    return { ok: true, name, created: true };
}

/* ------------------------------------------------------------------ *
 * Using
 * ------------------------------------------------------------------ */

/**
 * Run one shell command inside the agent's container.
 *
 * `sh -c` inside the container, because that is where the shell is; the
 * host never parses the command. `cwd` is a path as the model sees it,
 * already checked by the caller against the mounts.
 */
async function exec(agentId, command, { cwd = '', timeout = 60000, stdin = null } = {}) {
    const name = containerName(agentId);
    const args = ['exec', '-i'];
    if (cwd) args.push('--workdir', cwd);
    args.push(name, 'sh', '-c', String(command));
    const result = await docker(args, { timeout, stdin });
    if (result.missing) return { success: false, message: 'Docker is not available.' };
    if (result.timedOut) {
        return {
            success: false,
            timedOut: true,
            message: `The command was still running after ${Math.round(timeout / 1000)}s and was stopped`,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    }
    return {
        success: true,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: Boolean(result.truncated),
    };
}

/**
 * How an agent's stdio MCP server is spawned when the agent is containerised:
 * as a `docker exec` into the container, with the server's own variables
 * passed as `-e` flags. Nothing from the host environment goes along, since
 * inside the container there is nothing of the host's to inherit.
 */
function execSpec(agentId, { command, args = [], env = {} } = {}) {
    const flags = ['exec', '-i', '--workdir', sandboxModule.WORKSPACE];
    for (const [key, value] of Object.entries(env || {})) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) flags.push('-e', `${key}=${value ?? ''}`);
    }
    return { command: 'docker', args: [...flags, containerName(agentId), command, ...args] };
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/** Stop the container without losing its workspace. */
async function stop(agentId) {
    await docker(['stop', '-t', '5', containerName(agentId)]);
}

/** Throw the container away, and its workspace with it. */
async function remove(agentId, { keepWorkspace = false } = {}) {
    const name = containerName(agentId);
    await docker(['rm', '-f', name]);
    if (!keepWorkspace) await docker(['volume', 'rm', '-f', `${name}-workspace`]);
    return { ok: true };
}

/** A fresh container from the same envelope. */
async function reset(agentId, sandbox) {
    await remove(agentId);
    return ensure(agentId, sandbox);
}

/** What the settings page shows beside the switch. */
async function status(agentId) {
    const daemon = await probe();
    if (!daemon.available) return { ...daemon, container: { exists: false } };
    return { ...daemon, container: await inspect(agentId) };
}

module.exports = {
    probe,
    ensure,
    exec,
    execSpec,
    stop,
    remove,
    reset,
    status,
    inspect,
    createArgs,
    containerName,
    setSpawner,
    NETWORK,
    MAX_OUTPUT,
};
