/**
 * Our tools, for an agent that can only start an MCP server, not reach one.
 *
 * Some agents take MCP servers as commands to spawn and nothing else. The
 * app's tools are served over loopback HTTP by `mcp-host`, so this is the
 * command they are given: it reads JSON-RPC from stdin one line at a time,
 * posts each message to that address, and writes whatever comes back, a JSON
 * body or a stream of server-sent events, to stdout one message per line.
 *
 * Run with the app's own binary under ELECTRON_RUN_AS_NODE, like
 * `mcp-launch.js`, so nothing has to be installed for it. The address carries
 * the token (see mcp-host's `tokenUrl`), so nothing else is needed either.
 *
 *   node mcp-bridge.js <url>
 */

const url = process.argv[2];
if (!url) {
    process.stderr.write('mcp-bridge: no address given\n');
    process.exit(2);
}

let sessionId = '';
let queue = Promise.resolve();

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** Every message in an SSE body, in order. */
function* events(text) {
    for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''))
            .join('\n');
        if (!data) continue;
        try {
            yield JSON.parse(data);
        } catch {
            // Not a message: a comment or a keepalive.
        }
    }
}

async function forward(message) {
    const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    let response;
    try {
        response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) });
    } catch (error) {
        if (message.id !== undefined) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `The app's tool server could not be reached: ${error.message}` } });
        }
        return;
    }

    const issued = response.headers.get('mcp-session-id');
    if (issued) sessionId = issued;
    if (response.status === 202 || response.status === 204) return;

    const type = response.headers.get('content-type') || '';
    if (type.includes('text/event-stream') && response.body) {
        // Read as it arrives, so a long tool call's progress notifications
        // reach the agent while the call is still running.
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            const cut = buffer.lastIndexOf('\n\n');
            if (cut < 0) continue;
            for (const event of events(buffer.slice(0, cut + 2))) write(event);
            buffer = buffer.slice(cut + 2);
        }
        for (const event of events(buffer)) write(event);
        return;
    }

    const text = await response.text();
    if (!text.trim()) return;
    try {
        const body = JSON.parse(text);
        for (const entry of Array.isArray(body) ? body : [body]) write(entry);
    } catch {
        if (message.id !== undefined) {
            write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: `Unreadable answer from the app's tool server (${response.status}).` } });
        }
    }
}

let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    pending += chunk;
    let index = pending.indexOf('\n');
    while (index >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
        if (!line) continue;
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            continue;
        }
        // Requests are answered concurrently, as they would be over HTTP, but
        // notifications keep their order relative to what came before them.
        if (message.id === undefined) queue = queue.then(() => forward(message));
        else forward(message);
    }
});
process.stdin.on('end', async () => {
    await queue;
    if (sessionId) {
        fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }).catch(() => {});
    }
});
