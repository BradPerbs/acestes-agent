/**
 * The ACP engine, against a scripted agent.
 *
 * Drives `createAcpProvider` end to end over real stdio: the handshake, the
 * session's models and effort levels, streamed text and thinking, the agent
 * asking before its own tools (allowed, blocked, and ours waved through to
 * mcp-host), usage on the result, switching model and effort, cancelling a
 * turn, and resuming a session without replaying it.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-acp-'));
const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const { createAcpProvider, _test } = require('../src/main/ai/providers/acp');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');

const provider = createAcpProvider({
    id: 'fake-acp',
    label: 'Fake',
    find: () => process.execPath,
    args: () => [FIXTURE],
    env: () => ({ ELECTRON_RUN_AS_NODE: '1' }),
});

const baseSettings = {
    approval: 'writes',
    allowLocalTools: true,
    autoApproveCommands: [],
    blockedCommands: ['rm -rf'],
    mcpServers: [],
    model: '',
    effort: 'high',
};

function harness(settings = baseSettings) {
    const events = [];
    const approvals = [];
    let current = { ...settings };
    return {
        events,
        approvals,
        set(patch) { current = { ...current, ...patch }; },
        options: {
            settings: current,
            getSettings: () => current,
            systemPrompt: 'SYSTEM',
            toolContext: () => ({ settings: current }),
            requestApproval: async (request) => {
                approvals.push(request);
                return { approved: true };
            },
            onEvent: (event) => events.push(event),
        },
    };
}

const until = async (check, what, timeout = 8000) => {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

let passed = 0;
async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
}

(async () => {
    /* ---------------- pure pieces ---------------- */

    await test('effort levels round down onto what the agent names', () => {
        const options = [{ value: 'low' }, { value: 'medium' }, { value: 'high' }];
        assert.strictEqual(_test.agentEffortFor(options, 'high'), 'high');
        assert.strictEqual(_test.agentEffortFor(options, 'max'), 'high');
        assert.strictEqual(_test.agentEffortFor(options, 'ultra'), 'high');
        assert.strictEqual(_test.agentEffortFor([{ value: 'minimal' }, { value: 'deep' }], 'medium'), 'minimal');
    });

    await test('our tools are recognised however the agent spells them', () => {
        assert.strictEqual(_test.ourTool({ title: 'list_hosts (remote MCP Server)' }), 'list_hosts');
        assert.strictEqual(_test.ourTool({ title: 'mcp__remote__run_command' }), 'run_command');
        assert.strictEqual(_test.ourTool({ title: 'remote__read_file' }), 'read_file');
        assert.strictEqual(_test.ourTool({ title: 'Run ls -la', kind: 'execute' }), '');
        // A native tool that happens to share a name with ours is not ours.
        assert.strictEqual(_test.ourTool({ title: 'write_file' }), '');
        assert.strictEqual(_test.ourTool({ title: 'read_file', toolName: 'read_file' }), '');
        assert.strictEqual(_test.ourTool({ toolName: 'list_hosts', server: 'remote' }), 'list_hosts');
        assert.strictEqual(_test.ourTool({ title: 'mcp_remote_list_hosts' }), 'list_hosts');
    });

    await test('servers go over HTTP when the agent can take it, bridged when not', () => {
        const host = { url: 'http://127.0.0.1:1/mcp', token: 'tok', tokenUrl: 'http://127.0.0.1:1/mcp/tok' };
        const http = _test.sessionServers({ mcpServers: [] }, host, { mcpCapabilities: { http: true } });
        assert.deepStrictEqual(http, [{ type: 'http', name: 'remote', url: host.url, headers: [{ name: 'Authorization', value: 'Bearer tok' }] }]);
        const stdio = _test.sessionServers({ mcpServers: [] }, host, {});
        assert.strictEqual(stdio[0].name, 'remote');
        assert.ok(stdio[0].args[0].endsWith('mcp-bridge.js'));
        assert.strictEqual(stdio[0].args[1], host.tokenUrl);
    });

    await test('usage maps onto the counts the limits page reads', () => {
        assert.deepStrictEqual(_test.usageOf({ inputTokens: 10, outputTokens: 4, thoughtTokens: 2, cachedReadTokens: 1 }),
            { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 1 });
        assert.strictEqual(_test.usageOf(null), null);
    });

    /* ---------------- a whole conversation ---------------- */

    await test('the model list comes from a session opened and closed again', async () => {
        const rows = await provider.listModels({ settings: {} });
        assert.deepStrictEqual(rows.map(row => row.value), ['fake-large', 'fake-small']);
        assert.strictEqual(rows[0].preferred, true);
        assert.strictEqual(rows[1].short, 'Fake Small');
        assert.deepStrictEqual(rows[0].effort, ['low', 'medium', 'high']);
    });

    const h = harness();
    const session = await provider.start(h.options);

    await test('a session announces itself and its models, and takes the saved effort', async () => {
        assert.ok(h.events.some(event => event.type === 'session' && event.sessionId === 'sess-1'));
        assert.ok(h.events.some(event => event.type === 'models' && event.models.length === 2));
    });

    await test('a turn streams, asks about native tools, waves ours through, and reports usage', async () => {
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the first result');

        const texts = h.events.filter(event => event.type === 'assistant-text').map(event => event.text);
        assert.strictEqual(texts[0], 'Hello world.');
        assert.ok(texts[1].includes('effort=high'), 'the saved effort was applied');
        assert.ok(texts[1].includes('servers=remote:http'), 'our tools went over HTTP');
        assert.ok(h.events.some(event => event.type === 'thinking-delta' && event.text === 'hmm'));

        // Only the agent's own command reached the card; ours did not.
        assert.strictEqual(h.approvals.length, 1);
        assert.strictEqual(h.approvals[0].local, true);
        assert.deepStrictEqual(h.approvals[0].input, { command: 'touch notes.txt' });

        const results = h.events.filter(event => event.type === 'tool-result');
        assert.strictEqual(results.find(event => event.id === 't1').text, 'permission:yes');
        assert.strictEqual(results.find(event => event.id === 't2').text, 'ours:ok');
        const calls = h.events.filter(event => event.type === 'tool-call');
        assert.strictEqual(calls.find(event => event.id === 't2').local, false);
        assert.strictEqual(calls.find(event => event.id === 't2').name, 'list_hosts');

        const result = h.events.find(event => event.type === 'result');
        assert.strictEqual(result.subtype, 'success');
        assert.deepStrictEqual(result.usage, { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 5 });
    });

    await test('a blocked command is refused without a card', async () => {
        h.events.length = 0;
        h.approvals.length = 0;
        session.send('danger');
        await until(() => h.events.some(event => event.type === 'result'), 'the second result');
        assert.strictEqual(h.approvals.length, 0);
        assert.ok(h.events.some(event => event.type === 'tool-blocked'));
        assert.strictEqual(h.events.find(event => event.type === 'tool-result' && event.id === 't1').text, 'permission:no');
    });

    await test('the local-tools switch refuses the agent\'s own tools', async () => {
        h.events.length = 0;
        h.set({ allowLocalTools: false });
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the third result');
        assert.strictEqual(h.events.find(event => event.type === 'tool-result' && event.id === 't1').text, 'permission:no');
        h.set({ allowLocalTools: true });
    });

    await test('model and effort change on the running session', async () => {
        h.events.length = 0;
        h.set({ model: 'fake-small', effort: 'low' });
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the fourth result');
        const text = h.events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(text.includes('model=fake-small'), text);
        assert.ok(text.includes('effort=low'), text);
    });

    await test('an interrupt cancels the turn', async () => {
        h.events.length = 0;
        session.send('wait for it');
        await until(() => h.events.some(event => event.type === 'text-delta'), 'the turn to start');
        await session.interrupt();
        await until(() => h.events.some(event => event.type === 'result'), 'the cancelled result');
        const result = h.events.find(event => event.type === 'result');
        assert.strictEqual(result.subtype, 'cancelled');
        assert.ok(!h.events.some(event => event.type === 'error'));
    });

    await session.close();
    await test('a closed session reports itself stopped', async () => {
        await until(() => session.stopped, 'the process to go');
    });

    await test('resuming loads the session without replaying it, and bridges when HTTP is not on offer', async () => {
        const resumed = harness();
        process.env.FAKE_ACP_HTTP = '0';
        const again = await provider.start({ ...resumed.options, resumeSessionId: 'sess-1' });
        delete process.env.FAKE_ACP_HTTP;
        assert.ok(!resumed.events.some(event => event.type === 'text-delta' && event.text === 'REPLAYED'));
        assert.ok(resumed.events.some(event => event.type === 'session' && event.sessionId === 'sess-1'));
        again.send('hello');
        await until(() => resumed.events.some(event => event.type === 'result'), 'the resumed result');
        const text = resumed.events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(text.includes('servers=remote:stdio'), text);
        await again.close();
    });

    console.log(`${passed} passed, 0 failed`);
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
