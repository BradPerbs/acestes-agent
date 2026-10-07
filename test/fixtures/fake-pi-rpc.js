/**
 * A scripted `pi --mode rpc`, for the Pi provider's tests.
 *
 * Follows Pi's RPC reference: commands with an id get a `response`, a prompt
 * streams `message_update`, tool execution and `message_end` events and ends
 * with `agent_settled`. A native tool is put to the client as the app
 * extension's `confirm`, as `pi-extension.mjs` does.
 */

const args = process.argv.slice(2);
const flag = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : ''; };
const state = {
    model: flag('--model') || 'anthropic/claude-sonnet-5',
    thinking: flag('--thinking') || 'medium',
    sessionId: flag('--session-id') || 'none',
    builtins: !args.includes('--no-builtin-tools'),
    extension: flag('-e'),
    waiting: new Map(),
    aborted: false,
};

let buffer = '';
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, command, data) => send({ id, type: 'response', command, success: true, ...(data !== undefined ? { data } : {}) });
const confirm = (tool, input) => new Promise((resolve) => {
    const id = `ui-${Date.now()}-${Math.random()}`;
    state.waiting.set(id, resolve);
    send({ type: 'extension_ui_request', id, method: 'confirm', title: 'acestes:approve', message: JSON.stringify({ tool, input }) });
});

async function prompt(message) {
    state.aborted = false;
    send({ type: 'agent_start' });
    if (message.includes('wait')) {
        send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'waiting' } });
        const timer = setInterval(() => {
            if (!state.aborted) return;
            clearInterval(timer);
            send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'waiting' }], stopReason: 'aborted', usage: { input: 1, output: 1, cacheRead: 0, cost: { total: 0 } } } });
            send({ type: 'agent_settled' });
        }, 20);
        return;
    }
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'pondering' } });
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Working on it.' } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }], stopReason: 'toolUse', usage: { input: 100, output: 20, cacheRead: 10, cost: { total: 0.0012 } } } });

    const command = message.includes('danger') ? 'rm -rf /' : 'npm test';
    const allowed = await confirm('bash', { command });
    send({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: { command } });
    send({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: { content: [{ type: 'text', text: allowed ? 'ran' : 'blocked' }] }, isError: !allowed });

    // One of the app's tools, which the extension would have registered.
    send({ type: 'tool_execution_start', toolCallId: 'c2', toolName: 'list_hosts', args: {} });
    send({ type: 'tool_execution_end', toolCallId: 'c2', toolName: 'list_hosts', result: { content: [{ type: 'text', text: 'hosts' }] }, isError: false });

    const reply = `Done. model=${state.model} thinking=${state.thinking} session=${state.sessionId} builtins=${state.builtins} extension=${Boolean(state.extension)} mcp=${Boolean(process.env.ACESTES_MCP_URL)} cwd=${process.cwd()}`;
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop', usage: { input: 200, output: 40, cacheRead: 30, cost: { total: 0.0034 } } } });
    send({ type: 'agent_end', messages: [] });
    send({ type: 'agent_settled' });
}

function handle(message) {
    switch (message.type) {
        case 'get_state':
            respond(message.id, 'get_state', { model: { provider: state.model.split('/')[0], id: state.model.split('/').slice(1).join('/') }, thinkingLevel: state.thinking, sessionId: state.sessionId, isStreaming: false });
            return;
        case 'get_available_models':
            respond(message.id, 'get_available_models', { models: [
                { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', reasoning: true, contextWindow: 200000 },
                { id: 'gpt-5.6', name: 'GPT-5.6', provider: 'openai-codex', reasoning: true, contextWindow: 400000 },
                { id: 'tiny', name: 'Tiny', provider: 'local', reasoning: false },
            ] });
            return;
        case 'set_model':
            state.model = `${message.provider}/${message.modelId}`;
            respond(message.id, 'set_model', {});
            return;
        case 'set_thinking_level':
            state.thinking = message.level;
            respond(message.id, 'set_thinking_level');
            return;
        case 'prompt':
            respond(message.id, 'prompt');
            prompt(message.message || '');
            return;
        case 'abort':
            state.aborted = true;
            return;
        case 'extension_ui_response': {
            const resolve = state.waiting.get(message.id);
            state.waiting.delete(message.id);
            resolve?.(Boolean(message.confirmed));
            return;
        }
        default:
            if (message.id) send({ id: message.id, type: 'response', command: message.type, success: false, error: `no ${message.type}` });
    }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (line) handle(JSON.parse(line));
    }
});
process.stdin.on('end', () => process.exit(0));
