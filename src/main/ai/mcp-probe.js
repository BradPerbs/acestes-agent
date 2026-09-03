const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const agents = require('../agents');
const sandboxModule = require('./sandbox');
const secrets = require('./secrets');

/**
 * Whether an agent's MCP servers can actually be reached.
 *
 * A server record is a command or a URL, and either can be wrong in ways
 * that only show when something connects: the package is not installed, the
 * token is stale, the endpoint moved. Until now that showed as the runtime
 * failing quietly at the start of a conversation. This asks each server the
 * question directly, with the same handshake every runtime performs: open
 * the transport, `initialize`, list the tools, close. What comes back is the
 * server's own name and version, how many tools it offers, and how long the
 * handshake took; or the reason it did not.
 *
 * A stdio server is spawned the way Claude Code spawns it for the agent,
 * through the launcher that sets the environment outright, so a probe that
 * passes is a start that will pass, and one that fails names the same
 * failure. An http server is tried on the streamable transport first and the
 * older SSE one second, which between them cover every remote server in the
 * registry.
 *
 * Results are kept per server id and pushed to the windows, so the MCP page
 * can show a dot next to each server without asking twice.
 */

const TIMEOUT_MS = 30000;
const CLIENT = { name: 'acestes', version: '1.0.0' };

// serverId -> status
const statuses = new Map();
// serverId -> Promise<status>, so two askers share one handshake
const inFlight = new Map();

let notify = () => {};

function setNotifier(fn) {
    notify = fn;
}

function withTimeout(promise, ms, what) {
    let timer;
    const clock = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, clock]).finally(() => clearTimeout(timer));
}

/** The transports to try for a server, in order. */
function transportsFor(server) {
    if (server.transport === 'http') {
        const headers = secrets.resolveObject(server.headers || {});
        const url = new URL(secrets.resolve(server.url));
        return [
            () => new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
            () => new SSEClientTransport(url, {
                requestInit: { headers },
                eventSourceInit: {
                    fetch: (input, init) => fetch(input, { ...init, headers: { ...(init?.headers || {}), ...headers } }),
                },
            }),
        ];
    }
    return [() => new StdioClientTransport({
        command: process.execPath,
        args: [
            path.join(__dirname, 'mcp-launch.js'),
            JSON.stringify({
                command: server.command,
                args: (server.args || []).map(secrets.resolve),
                env: sandboxModule.safeEnv(process.env, secrets.resolveObject(server.env || {})),
            }),
        ],
        env: { ...getDefaultEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
        stderr: 'pipe',
    })];
}

/** The handshake's failure, said the way a person reading the page would want it. */
function describe(error, stderr) {
    const said = String(error?.message || error || '').replace(/^MCP error -?\d+:\s*/, '').trim();
    const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' ').trim();
    if (/ENOENT/.test(said) || /ENOENT/.test(tail)) return 'The command was not found.';
    if (/Connection closed/i.test(said) && tail) return tail.slice(0, 300);
    return (said || 'The server did not answer.').slice(0, 300);
}

/**
 * One handshake with one server record, on its own; nothing is recorded.
 * Exposed so a server can be tried before it is saved.
 */
async function probe(server) {
    const started = Date.now();
    let lastError = '';
    for (const make of transportsFor(server)) {
        const client = new Client(CLIENT);
        let transport = null;
        const stderr = [];
        try {
            transport = make();
            const connecting = client.connect(transport);
            // The stream exists once the transport has started, which
            // `connect` does first. Reading it is what turns "connection
            // closed" into the line the server printed on its way out.
            if (transport.stderr) transport.stderr.on('data', (chunk) => stderr.push(String(chunk)));
            await withTimeout(connecting, TIMEOUT_MS, 'The handshake');

            const info = client.getServerVersion() || {};
            const capabilities = client.getServerCapabilities() || {};
            let tools = [];
            if (capabilities.tools) {
                const listed = await withTimeout(client.listTools(), TIMEOUT_MS, 'Listing tools');
                tools = (listed?.tools || []).map(tool => tool.name);
            }
            await client.close().catch(() => {});
            return {
                ok: true,
                name: String(info.name || ''),
                version: String(info.version || ''),
                tools,
                latencyMs: Date.now() - started,
                checkedAt: Date.now(),
            };
        } catch (error) {
            lastError = describe(error, stderr.join(''));
            await client.close().catch(() => {});
        }
    }
    return { ok: false, error: lastError, latencyMs: Date.now() - started, checkedAt: Date.now() };
}

function publish(agentId, serverId, status) {
    statuses.set(serverId, status);
    notify('mcp-status', { agentId, serverId, status });
}

/**
 * Probe one of an agent's servers and record what it said. Two callers
 * asking while a handshake is open get the same answer.
 */
function check(agentId, serverId) {
    const server = (agents.get(agentId)?.mcpServers || []).find(entry => entry.id === serverId);
    if (!server) return Promise.resolve({ ok: false, error: 'No such server.', checkedAt: Date.now() });
    if (inFlight.has(serverId)) return inFlight.get(serverId);

    publish(agentId, serverId, { checking: true, ...(statuses.get(serverId) || {}) });
    const run = probe(server)
        .then((status) => {
            publish(agentId, serverId, status);
            return status;
        })
        .finally(() => inFlight.delete(serverId));
    inFlight.set(serverId, run);
    return run;
}

/** Every server the agent has, probed together. */
async function checkAll(agentId) {
    const servers = agents.get(agentId)?.mcpServers || [];
    const results = await Promise.all(servers.map(server => check(agentId, server.id)));
    return Object.fromEntries(servers.map((server, index) => [server.id, results[index]]));
}

/** What is known about the agent's servers, without asking them again. */
function known(agentId) {
    const servers = agents.get(agentId)?.mcpServers || [];
    return Object.fromEntries(servers.filter(server => statuses.has(server.id)).map(server => [server.id, statuses.get(server.id)]));
}

/** A server that was deleted or redefined has no status until it is asked again. */
function forget(serverId) {
    statuses.delete(serverId);
}

module.exports = { setNotifier, probe, check, checkAll, known, forget, TIMEOUT_MS };
