/**
 * The app's side of a Pi session, as a Pi extension.
 *
 * Pi has no MCP of its own and never asks before a tool runs, both by design.
 * It does have extensions, and this one is loaded into the user's Pi for our
 * runs only (`pi --mode rpc -e <this file>`), to give it the two things every
 * other runtime here has:
 *
 *   - the app's tools. Their list is read from `mcp-host` over HTTP when the
 *     extension loads, and each is registered as a Pi tool whose `execute`
 *     calls it there. mcp-host gates them, exactly as for every runtime.
 *   - a question before Pi's own tools run. Every call to one of them is put
 *     to the client as an extension `confirm`, which in RPC mode is a request
 *     on stdout that the provider answers under the app's approval rules.
 *
 * The address comes in ACESTES_MCP_URL, with the token in its path. Nothing
 * here is installed into the user's Pi or written anywhere.
 */

// NOTE: no static `typebox` import: the packaged build unpacks only this
// file (asarUnpack), with no node_modules beside it, so a static import
// kills the extension and Pi exits with `Pi stopped (Hint: -ne)`. The
// schema is passed through untouched when typebox is unreachable.
let Type = { Unsafe: (schema) => schema };
try {
    ({ Type } = await import('typebox'));
} catch {
    // Pass-through above stands in.
}

const URL_ = process.env.ACESTES_MCP_URL || '';
const APPROVAL = 'acestes:approve';

let sessionId = '';
let nextId = 1;

/** Every JSON-RPC message in an SSE body. */
function events(text) {
    const out = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!data) continue;
        try { out.push(JSON.parse(data)); } catch { /* a keepalive */ }
    }
    return out;
}

async function rpc(method, params, signal) {
    const id = nextId++;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal });
    const issued = response.headers.get('mcp-session-id');
    if (issued) sessionId = issued;
    const text = await response.text();
    const messages = (response.headers.get('content-type') || '').includes('text/event-stream')
        ? events(text)
        : [JSON.parse(text || '{}')];
    const answer = messages.find(message => message.id === id);
    if (!answer) throw new Error(`The app's tool server gave no answer to ${method}.`);
    if (answer.error) throw new Error(answer.error.message || `${method} failed.`);
    return answer.result;
}

async function notify(method) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    await fetch(URL_, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method }) }).catch(() => {});
}

export default async function acestes(pi) {
    const ours = new Set();

    if (URL_) {
        try {
            await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'acestes-pi', version: '1.0.0' } });
            await notify('notifications/initialized');
            const { tools = [] } = await rpc('tools/list', {});
            for (const tool of tools) {
                const spec = (name) => ({
                    name,
                    label: tool.title || tool.annotations?.title || tool.name,
                    description: tool.description || tool.name,
                    parameters: Type.Unsafe(tool.inputSchema || { type: 'object', properties: {} }),
                    async execute(_callId, params, signal) {
                        const result = await rpc('tools/call', { name: tool.name, arguments: params || {} }, signal);
                        const text = (result?.content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
                        if (result?.isError) throw new Error(text || `${tool.name} failed.`);
                        return { content: [{ type: 'text', text }], details: undefined };
                    },
                });
                // Another extension (e.g. pi-blackhole's `recall`) may own
                // the name: a conflict fails the whole extension load and
                // Pi exits (`Pi stopped`). Keep ours under an `acestes_`
                // alias instead of dying.
                try {
                    pi.registerTool(spec(tool.name));
                    ours.add(tool.name);
                } catch (error) {
                    if (!/conflict/i.test(error?.message || '')) throw error;
                    const aliased = `acestes_${tool.name}`;
                    pi.registerTool(spec(aliased));
                    ours.add(aliased);
                    process.stderr.write(`acestes: tool "${tool.name}" conflicts; registered as "${aliased}"\n`);
                }
            }
        } catch (error) {
            // Pi still runs; it just cannot reach the servers, and says so.
            process.stderr.write(`acestes: the app's tools could not be loaded: ${error.message}\n`);
        }
    }

    pi.on('tool_call', async (event, ctx) => {
        try {
            if (ours.has(event.toolName)) return undefined;
            if (!ctx.hasUI) return { block: true, reason: 'This run cannot ask for approval.' };
            const approved = await ctx.ui.confirm(APPROVAL, JSON.stringify({ tool: event.toolName, input: event.input ?? {} }));
            return approved ? undefined : { block: true, reason: 'The user declined that.' };
        } catch (error) {
            // Never let an approval-path failure kill the extension (and
            // with it the Pi process: `Pi stopped (Hint: -ne)`). Block the
            // tool and say why instead.
            process.stderr.write(`acestes: approval failed for ${event?.toolName || 'tool'}: ${error?.message || error}\n`);
            return { block: true, reason: `Approval failed: ${error?.message || error}` };
        }
    });
}
