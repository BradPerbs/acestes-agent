const path = require('path');
const sandboxModule = require('./sandbox');
const container = require('./container');
const secrets = require('./secrets');

/**
 * The MCP servers from an agent's inventory, in the shapes the runtimes
 * take them.
 *
 * One place for what used to be Claude Code's alone, because every runtime
 * is owed the same servers: a Playwright the user switched on for the agent
 * is the agent's, whichever CLI happens to be answering. The spawning rule
 * is the same everywhere too. A stdio server is started through the
 * launcher (`mcp-launch.js`) run by the app's own binary as plain Node, with
 * the system's environment scrubbed of anything that looks like a secret
 * and the server's own variables laid over it; inside a container it is
 * `docker exec` instead. An http server is its URL and its headers.
 *
 * `agentServers` is the generic shape (what the Claude Agent SDK and a
 * `.mcp.json` take: `command`/`args`/`env`, or `type: 'http'`/`url`/
 * `headers`); the others render that shape into one CLI's config.
 */

function agentServers(servers, sandbox = null, agentId = '') {
    const out = {};
    for (const entry of Array.isArray(servers) ? servers : []) {
        if (!entry?.name) continue;
        // A `{{secret:name}}` on the record becomes the agent's value here, at the
        // moment the server is handed to a runtime, and nowhere earlier.
        const env = secrets.resolveObject(entry.env || {}, agentId);
        const headers = secrets.resolveObject(entry.headers || {}, agentId);
        if (entry.transport === 'http') {
            out[entry.name] = {
                type: 'http',
                url: secrets.resolve(entry.url, agentId),
                ...(Object.keys(headers).length ? { headers } : {}),
            };
        } else if (sandbox?.execution === 'container') {
            out[entry.name] = container.execSpec(agentId, { ...entry, env });
        } else {
            out[entry.name] = {
                command: process.execPath,
                args: [
                    path.join(__dirname, 'mcp-launch.js'),
                    JSON.stringify({
                        command: entry.command,
                        args: (entry.args || []).map(arg => secrets.resolve(arg, agentId)),
                        env: sandboxModule.safeEnv(process.env, env),
                    }),
                ],
                env: { ELECTRON_RUN_AS_NODE: '1' },
            };
        }
    }
    return out;
}

/** A TOML key: bare when it can be, quoted otherwise. */
function tomlKey(name) {
    return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** A TOML basic string. JSON's escapes are a subset of TOML's. */
const tomlString = (value) => JSON.stringify(String(value ?? ''));

/**
 * The same servers as `[mcp_servers.<name>]` tables, the spelling Grok
 * Build reads. A stdio server carries its command, arguments and env; an
 * http one its URL and headers.
 */
function toml(servers, sandbox = null, agentId = '', { table = 'mcp_servers' } = {}) {
    const lines = [];
    for (const [name, spec] of Object.entries(agentServers(servers, sandbox, agentId))) {
        const key = `${table}.${tomlKey(name)}`;
        lines.push(`[${key}]`);
        if (spec.type === 'http') {
            lines.push(`url = ${tomlString(spec.url)}`);
            if (spec.headers && Object.keys(spec.headers).length) {
                lines.push(`[${key}.headers]`);
                for (const [header, value] of Object.entries(spec.headers)) lines.push(`${tomlKey(header)} = ${tomlString(value)}`);
            }
        } else {
            lines.push(`command = ${tomlString(spec.command)}`);
            lines.push(`args = [${(spec.args || []).map(tomlString).join(', ')}]`);
            if (spec.env && Object.keys(spec.env).length) {
                lines.push(`[${key}.env]`);
                for (const [variable, value] of Object.entries(spec.env)) lines.push(`${tomlKey(variable)} = ${tomlString(value)}`);
            }
        }
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * The same servers as the Codex SDK's `mcp_servers` config: `command`/
 * `args`/`env` for stdio, `url` and `http_headers` for http.
 */
function codex(servers, sandbox = null, agentId = '') {
    const out = {};
    for (const [name, spec] of Object.entries(agentServers(servers, sandbox, agentId))) {
        out[name] = spec.type === 'http'
            ? { url: spec.url, ...(spec.headers ? { http_headers: { ...spec.headers } } : {}) }
            : { command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) };
    }
    return out;
}

module.exports = { agentServers, toml, codex, tomlKey, tomlString };
