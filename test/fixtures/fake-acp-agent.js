/**
 * A scripted Agent Client Protocol agent, for the ACP engine's tests.
 *
 * Speaks just enough of the protocol to exercise every path the engine has:
 * a model list and an effort config option, streamed thinking and text, a
 * native shell command that needs permission, one of the app's own tools,
 * usage on the prompt response, and a turn that waits to be cancelled.
 *
 * `FAKE_ACP_HTTP=0` makes it an agent that cannot take HTTP MCP servers.
 */

let buffer = '';
let nextId = 1000;
const waiting = new Map();
const state = { model: 'fake-large', effort: 'medium', servers: [], cancelled: false, loads: 0 };

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId, body) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: body } });
const ask = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
});

const configOptions = () => [{
    id: 'reasoning',
    name: 'Reasoning',
    category: 'thought_level',
    type: 'select',
    currentValue: state.effort,
    options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
}];

const session = () => ({
    sessionId: 'sess-1',
    models: {
        availableModels: [
            { modelId: 'fake-large', name: 'Fake Large', description: 'The big one' },
            { modelId: 'fake-small', name: 'Fake Small (fast)' },
        ],
        currentModelId: state.model,
    },
    configOptions: configOptions(),
});

async function prompt(id, params) {
    const sid = params.sessionId;
    const text = (params.prompt || []).filter(block => block.type === 'text').map(block => block.text).join('');
    state.cancelled = false;

    if (text.includes('wait')) {
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting' } });
        const timer = setInterval(() => {
            if (!state.cancelled) return;
            clearInterval(timer);
            send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
        }, 20);
        return;
    }

    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world.' } });

    const command = text.includes('danger') ? 'rm -rf /' : 'touch notes.txt';
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: `Run ${command}`, kind: 'execute', status: 'pending', rawInput: { command } });
    const verdict = await ask('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 't1', title: `Run ${command}`, kind: 'execute', rawInput: { command } },
        options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
    });
    const chosen = verdict?.outcome?.optionId || verdict?.outcome?.outcome;
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: chosen === 'yes' ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: `permission:${chosen}` } }] });

    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'list_hosts (remote MCP Server)', kind: 'other', status: 'pending', rawInput: {} });
    const ours = await ask('session/request_permission', {
        sessionId: sid,
        toolCall: { toolCallId: 't2', title: 'list_hosts (remote MCP Server)', kind: 'other' },
        options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'nope', name: 'Reject', kind: 'reject_once' }],
    });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: `ours:${ours?.outcome?.optionId}` } }] });

    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` model=${state.model} effort=${state.effort} servers=${state.servers.map(server => `${server.name}:${server.type || 'stdio'}`).join(',')}` } });
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 30, thoughtTokens: 10, cachedReadTokens: 5 } } });
}

function handle(message) {
    if (message.id !== undefined && !message.method) {
        const resolve = waiting.get(message.id);
        waiting.delete(message.id);
        resolve?.(message.result);
        return;
    }
    const { id, method, params = {} } = message;
    switch (method) {
        case 'initialize':
            send({ jsonrpc: '2.0', id, result: {
                protocolVersion: 1,
                agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: { image: true },
                    mcpCapabilities: { http: process.env.FAKE_ACP_HTTP !== '0' },
                },
                authMethods: [],
            } });
            return;
        case 'session/new':
            state.servers = params.mcpServers || [];
            send({ jsonrpc: '2.0', id, result: session() });
            return;
        case 'session/load':
            state.loads += 1;
            state.servers = params.mcpServers || [];
            // A load replays history; the engine must not show it again.
            update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } });
            send({ jsonrpc: '2.0', id, result: { models: session().models, configOptions: configOptions() } });
            return;
        case 'session/set_model':
            state.model = params.modelId;
            send({ jsonrpc: '2.0', id, result: {} });
            return;
        case 'session/set_config_option':
            if (params.configId === 'reasoning') state.effort = params.value;
            send({ jsonrpc: '2.0', id, result: { configOptions: configOptions() } });
            return;
        case 'session/prompt':
            prompt(id, params);
            return;
        case 'session/cancel':
            state.cancelled = true;
            return;
        default:
            if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `no ${method}` } });
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
