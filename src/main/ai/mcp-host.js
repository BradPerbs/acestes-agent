const http = require('http');
const crypto = require('crypto');

const catalog = require('./tools');

/**
 * The remote toolset, served over the loopback interface.
 *
 * Claude Code takes our tools as JavaScript functions and runs them inside its
 * own SDK, in this process. Codex cannot: it connects to MCP servers by URL or
 * by spawning a command, so the tools have to be reachable from outside.
 *
 * Outside, but not far. The handlers hold live ssh sessions and the app's
 * settings, so moving them into a subprocess would mean inventing a second
 * protocol to talk back here for every call. Instead this serves them over
 * http on 127.0.0.1: the tools stay exactly where they are, and the agent gets
 * a URL.
 *
 * Three things keep that from being a hole in the side of the app:
 *
 *   - it binds to 127.0.0.1 with an OS-assigned port, so nothing off this
 *     machine can reach it and the port is not guessable from run to run
 *   - every request must carry a token, in the Authorization header or in
 *     the URL path, compared in constant time. Anything else gets 401 before
 *     it is parsed
 *   - it is started on demand by a provider that needs it, and stopped when
 *     the last one is done
 *
 * The token is per conversation, not per server. Each `acquire` mints its own
 * and the request is answered in the context that token was minted for: that
 * conversation's agent, its scope, its settings and its approval card. One
 * server, many tokens, and a call from agent B's runtime cannot land in agent
 * A's context, because it does not hold A's token. (It used to be one token
 * and the first caller's context for everyone, which with two agents open
 * was exactly that.)
 *
 * The approval policy is the same one the in-process provider uses, applied
 * in the same place it matters: before the handler runs. A call that needs a
 * person parks here until the panel answers.
 */

let server = null;
let ready = null;

// token -> { toolContext, requestApproval, onEvent }
const contexts = new Map();

/** Constant time, because a token check that returns early leaks the token. */
function tokenMatches(offered, expected) {
    const a = Buffer.from(String(offered || ''));
    const b = Buffer.from(String(expected || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The context a request is entitled to, or null.
 *
 * Every token is compared, not looked up: a Map lookup is a string compare
 * that returns early, and the whole point of the constant-time compare is
 * that it does not. There are as many tokens as open conversations, which is
 * a handful.
 */
function contextFor(offered) {
    let found = null;
    for (const [token, context] of contexts) {
        if (tokenMatches(offered, token)) found = context;
    }
    return found;
}

/**
 * The token a request is offering, from the header or from the path.
 *
 * The header is how an agent that can be told to send one does it, and it is
 * still what Codex and OpenCode use. The path is for the ones that take a URL
 * and nothing else: an address is the one thing every MCP client can be given,
 * and on a loopback socket an unguessable path in it is the same secret in a
 * different envelope. It buys nothing to be strict about which envelope, and
 * it costs a provider that then cannot reach its own tools.
 */
function offeredToken(request) {
    const header = String(request.headers?.authorization || '').replace(/^Bearer\s+/i, '');
    if (header) return header;
    const [, fromPath = ''] = /^\/mcp\/([^/?#]+)/.exec(String(request.url || '')) || [];
    return decodeURIComponent(fromPath);
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        request.on('data', (chunk) => {
            size += chunk.length;
            // A tool call is a few hundred bytes. Anything of this order is
            // either a bug or someone playing, and neither gets a buffer.
            if (size > 4 * 1024 * 1024) {
                reject(new Error('The request body is too large'));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

/**
 * A server per request, built for the context the token names.
 *
 * This looked like something to hoist: the tool definitions never change,
 * so why rebuild them per call. Because the transport is what a server is
 * connected to, and connecting a second one replaces the first: a shared
 * server answers each request into whichever transport connected last, and
 * the call that was actually waiting is left to time out as cancelled.
 * Stateless means stateless. Building ten closures per request is nothing
 * next to the ssh round trip they are about to make.
 */
function buildServer(McpServer, { toolContext, requestApproval, onEvent }) {
    const mcp = new McpServer({ name: 'remote', version: '1.0.0' });

    for (const definition of catalog.TOOLS) {
        mcp.registerTool(
            definition.name,
            {
                title: definition.title,
                description: definition.description,
                inputSchema: definition.shape,
            },
            async (input) => {
                const context = toolContext();
                const settings = context.settings;

                // Refused outright, before the approval path rather than
                // inside it: there is no answer the user could give that would
                // let this run, so asking would only be a card whose buttons
                // both mean no.
                const blocked = catalog.blockedReason(definition.name, input || {}, settings);
                if (blocked) {
                    onEvent({ type: 'tool-blocked', name: definition.name, rule: blocked });
                    return {
                        content: [{ type: 'text', text: catalog.blockedMessage(blocked) }],
                        isError: true,
                    };
                }

                // The gate. Not in the agent's own permission system, which is
                // a different set of promises on every agent, but here, once,
                // in front of the thing that actually touches a server.
                if (!catalog.isAutoApproved(definition.name, input || {}, settings)) {
                    const verdict = await requestApproval({
                        toolName: definition.name,
                        name: definition.name,
                        input: input || {},
                        local: false,
                    });
                    if (!verdict.approved) {
                        return {
                            content: [{ type: 'text', text: verdict.message || 'The user declined that.' }],
                            isError: true,
                        };
                    }
                }

                try {
                    const result = await catalog.invoke(definition, input || {}, context);
                    return {
                        content: [{ type: 'text', text: String(result.text ?? '') }],
                        isError: Boolean(result.isError),
                    };
                } catch (error) {
                    onEvent({ type: 'tool-failed', name: definition.name, message: error.message });
                    return {
                        content: [{ type: 'text', text: `The ${definition.name} tool failed: ${error.message}` }],
                        isError: true,
                    };
                }
            }
        );
    }

    return mcp;
}

async function listen() {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StreamableHTTPServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );

    return new Promise((resolve, reject) => {
        // Stateless: a server and a transport per request, torn down with the
        // response. There is no session id to track and nothing to leak between
        // turns, which for a socket this process is hosting is the point.
        server = http.createServer(async (request, response) => {
            const context = contextFor(offeredToken(request));
            if (!context) {
                if (process.env.CLOUDBLAST_MCP_DEBUG) console.error('[mcp] 401', request.method, request.url);
                response.writeHead(401).end();
                return;
            }

            try {
                const body = request.method === 'POST'
                    ? JSON.parse(await readBody(request) || '{}')
                    : undefined;

                if (process.env.CLOUDBLAST_MCP_DEBUG) {
                    console.error('[mcp]', request.method, request.url, body?.method || '', 'accept=', request.headers.accept || '');
                }

                const mcp = buildServer(McpServer, context);
                const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
                response.on('close', () => {
                    transport.close();
                    mcp.close();
                });

                await mcp.connect(transport);
                await transport.handleRequest(request, response, body);
            } catch (error) {
                if (!response.headersSent) response.writeHead(500).end();
                context.onEvent({ type: 'tool-failed', name: 'mcp', message: error.message });
            }
        });

        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve(server.address().port);
        });
    });
}

/**
 * Start the server if it is not running, and mint a token for this caller.
 *
 * `toolContext` is read per call rather than captured, so a tool always acts
 * on the session in front of the user now and under the settings as they are
 * now, exactly as the in-process path does.
 */
async function acquire({ toolContext, requestApproval, onEvent = () => {} }) {
    const token = crypto.randomBytes(32).toString('hex');
    contexts.set(token, { toolContext, requestApproval, onEvent });

    if (!ready) {
        ready = listen().catch((error) => {
            ready = null;
            server = null;
            throw error;
        });
    }

    let port;
    try {
        port = await ready;
    } catch (error) {
        contexts.delete(token);
        throw error;
    }

    return {
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        // The same endpoint with the token already in it, for a client
        // that can only be handed an address. See `offeredToken`.
        tokenUrl: `http://127.0.0.1:${port}/mcp/${token}`,
    };
}

/**
 * Let go of one token. The last one out closes the door.
 *
 * Called without a token by nobody now, but tolerated: it then only closes
 * the server if no token is left, which is the safe reading.
 */
async function release(token) {
    if (token) contexts.delete(token);
    if (contexts.size > 0 || !server) return;

    const closing = server;
    server = null;
    ready = null;
    await new Promise(resolve => closing.close(resolve));
}

module.exports = { acquire, release, _test: { offeredToken, contextFor, contexts } };
