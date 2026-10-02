/**
 * A scripted `muse serve`, for the Muse Code provider's tests.
 *
 * Its messages follow the conformance transcripts Meta publishes with the
 * SDK (schema/msp/transcripts): the handshake, session/start and resume,
 * model/list, a turn of reasoning, text, a shell call behind an approval and
 * one of the app's tools behind another, turn/completed with usage,
 * usage/changed, and a turn that waits to be cancelled.
 */

let buffer = '';
let serverId = 1;
const state = { model: 'muse-spark-1.3', effort: 'high', servers: {}, session: '0198f0aa-1111-7000-8000-0000000000aa', pending: new Map(), granted: [] };

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ jsonrpc: '2.0', method, params: { sessionId: state.session, ...params }, emittedAtMs: Date.now() });

const session = () => ({
    sessionId: state.session, status: 'idle', turnCount: 0, providerId: 'meta', modelId: state.model,
    approvalMode: { mode: 'promptUnmatched', source: 'startup', lastCommandId: null },
});

function approval(turnId, itemId, approvalId, toolName, rawArgs) {
    const params = {
        approvalId, turnId, itemId, toolCallId: `call_${itemId}`, toolName, rawArgs,
        subject: { kind: 'toolUse', toolName },
        currentRequirementId: { approvalId, sourceIndex: 0 },
        availableChoices: [
            { choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' },
            { choiceId: 'allow_session', label: 'Allow for this session', decision: 'approvedForSession', scope: 'session' },
            { choiceId: 'deny', label: 'Deny', decision: 'denied', scope: 'once' },
        ],
    };
    notify('approval/requested', params);
    send({ jsonrpc: '2.0', id: serverId++, method: 'approval/request', params: { sessionId: state.session, ...params } });
    return new Promise(resolve => state.pending.set(approvalId, resolve));
}

async function turn(id, params) {
    const turnId = params.commandId;
    const text = (params.input || []).filter(part => part.type === 'text').map(part => part.text).join('');
    send({ jsonrpc: '2.0', id, result: { commandId: turnId, status: 'accepted', turnId, startedNewTurn: true, disposition: 'started' } });
    notify('turn/started', { turnId, commandId: turnId });
    if (params.reasoningEffort) state.effort = params.reasoningEffort;

    if (text.includes('wait')) {
        notify('item/started', { item: { itemId: 'msg-w', kind: 'agentMessage', turnId, status: 'inProgress', text: '' } });
        notify('item/delta', { itemId: 'msg-w', field: 'text', delta: 'waiting' });
        state.waiting = turnId;
        return;
    }

    notify('item/started', { item: { itemId: 'r1', kind: 'reasoning', turnId, status: 'inProgress', text: '' } });
    notify('item/delta', { itemId: 'r1', field: 'text', delta: 'thinking it over' });
    notify('item/completed', { item: { itemId: 'r1', kind: 'reasoning', turnId, status: 'completed', text: 'thinking it over' } });

    const command = text.includes('danger') ? 'rm -rf /' : 'cargo build';
    notify('item/started', { item: { itemId: 't1', kind: 'toolCall', turnId, status: 'inProgress', tool: 'shell', args: JSON.stringify({ command }), approvalId: `a1-${turnId}` } });
    const shell = await approval(turnId, 't1', `a1-${turnId}`, 'shell', JSON.stringify({ command }));
    notify('item/completed', { item: { itemId: 't1', kind: 'toolCall', turnId, status: shell === 'deny' ? 'failed' : 'completed', tool: 'shell', args: JSON.stringify({ command }), visibleOutput: `decided:${shell}`, failureReason: shell === 'deny' ? 'denied' : undefined } });

    notify('item/started', { item: { itemId: 't2', kind: 'toolCall', turnId, status: 'inProgress', tool: 'mcp__remote__list_hosts', args: '{}' } });
    const ours = await approval(turnId, 't2', `a2-${turnId}`, 'mcp__remote__list_hosts', '{}');
    notify('item/completed', { item: { itemId: 't2', kind: 'toolCall', turnId, status: 'completed', tool: 'mcp__remote__list_hosts', args: '{}', visibleOutput: `ours:${ours}` } });

    notify('item/started', { item: { itemId: 'm1', kind: 'agentMessage', turnId, status: 'inProgress', text: '' } });
    const reply = `Done. model=${state.model} effort=${state.effort} servers=${Object.entries(state.servers).map(([name, spec]) => `${name}:${spec.transport}`).join(',')}`;
    notify('item/delta', { itemId: 'm1', field: 'text', delta: reply });
    notify('item/completed', { item: { itemId: 'm1', kind: 'agentMessage', turnId, status: 'completed', text: reply } });

    notify('usage/changed', { usage: { observedAtMs: Date.now(), tier: 'high_usage', window: { usedPercent: 37, windowDurationMins: 300, resetsAtMs: Date.now() + 3600000 }, weekly: { usedPercent: 12, resetsAtMs: Date.now() + 86400000 } } });
    notify('turn/completed', { turnId, terminal: 'completed', durationMs: 1200, usage: { inputTokens: 900, outputTokens: 120, cachedTokens: 400, reasoningTokens: 30 } });
}

function handle(message) {
    if (message.id !== undefined && !message.method) return; // receipts for our requests
    const { id, method, params = {} } = message;
    switch (method) {
        case 'initialize':
            state.granted = Array.isArray(params.capabilities?.requestedCapabilities)
                ? params.capabilities.requestedCapabilities.filter(name => name === 'sessionMcp')
                : [];
            send({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'muse-session-server', version: '0.0.0-fixture' }, schema: { version: 1, fingerprint: 'sha256:0' }, grantedCapabilities: state.granted, experimentalApi: Boolean(params.capabilities?.experimentalApi) } });
            return;
        case 'initialized':
            return;
        case 'session/start':
            if (params.config?.mcpServers && Object.keys(params.config.mcpServers).length && !state.granted.includes('sessionMcp')) {
                send({ jsonrpc: '2.0', id, error: { code: -32010, message: 'session MCP configuration requires the sessionMcp capability', data: { kind: 'capabilityRequired', capability: 'sessionMcp' } } });
                return;
            }
            state.servers = params.config?.mcpServers || {};
            if (params.modelId) state.model = params.modelId;
            send({ jsonrpc: '2.0', id, result: { session: session(), viewCursor: 'v:1' } });
            return;
        case 'session/resume':
            if (params.config?.mcpServers && Object.keys(params.config.mcpServers).length && !state.granted.includes('sessionMcp')) {
                send({ jsonrpc: '2.0', id, error: { code: -32010, message: 'session MCP configuration requires the sessionMcp capability', data: { kind: 'capabilityRequired', capability: 'sessionMcp' } } });
                return;
            }
            state.servers = params.config?.mcpServers || {};
            state.session = params.sessionId;
            state.resumed = true;
            send({ jsonrpc: '2.0', id, result: { session: session(), viewCursor: 'v:9' } });
            return;
        case 'model/list':
            send({ jsonrpc: '2.0', id, result: { providerId: 'meta', models: [
                { modelId: 'muse-spark-1.3', displayLabel: 'Muse Spark 1.3', providerId: 'meta', isDefault: true, isActive: true, description: 'The flagship' },
                { modelId: 'muse-spark-1.3-contributor', displayLabel: 'Muse Spark 1.3 (contributor)', providerId: 'meta', isDefault: false, isActive: false },
            ] } });
            return;
        case 'session/setModel':
            state.model = params.model?.modelId;
            send({ jsonrpc: '2.0', id, result: { commandId: params.commandId, status: 'accepted' } });
            notify('session/modelChanged', { modelId: state.model, providerId: 'meta', source: 'user' });
            return;
        case 'session/setReasoningEffort':
            state.effort = params.reasoningEffort;
            send({ jsonrpc: '2.0', id, result: { commandId: params.commandId, status: 'accepted' } });
            return;
        case 'turn/start':
            turn(id, params);
            return;
        case 'turn/cancel':
            send({ jsonrpc: '2.0', id, result: { commandId: params.commandId, status: 'accepted', turnId: params.turnId } });
            if (state.waiting) {
                notify('turn/completed', { turnId: state.waiting, terminal: 'cancelled', reason: 'cancelled' });
                state.waiting = null;
            }
            return;
        case 'approval/decide': {
            // Stale or wrong requirement ids are refused, as the real host does.
            if (params.requirementId?.approvalId !== params.approvalId) {
                send({ jsonrpc: '2.0', id, error: { code: -32053, message: 'stale requirement' } });
                return;
            }
            send({ jsonrpc: '2.0', id, result: { commandId: params.commandId, status: 'accepted', approvalId: params.approvalId, terminal: true } });
            const resolve = state.pending.get(params.approvalId);
            state.pending.delete(params.approvalId);
            resolve?.(params.choiceId);
            return;
        }
        case 'account/read':
            send({ jsonrpc: '2.0', id, result: { credentialRequired: false, state: 'accountLogin', label: 'someone@example.com' } });
            return;
        case 'usage/read':
            send({ jsonrpc: '2.0', id, result: { usage: { observedAtMs: Date.now(), tier: 'everyday', window: { usedPercent: 20, windowDurationMins: 300, resetsAtMs: Date.now() + 7200000 }, weekly: { usedPercent: 55, resetsAtMs: Date.now() + 172800000 } } } });
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
