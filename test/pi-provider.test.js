/**
 * The Pi provider against a scripted `pi --mode rpc`, and the Pi extension
 * against the real tool server.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { pathToFileURL } = require('url');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-pi-'));
const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const pi = require('../src/main/ai/providers/pi');
const mcpHost = require('../src/main/ai/mcp-host');

pi._test.useCommand({ command: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-pi-rpc.js')] });

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

function harness(overrides = {}) {
    const events = [];
    const approvals = [];
    let current = {
        approval: 'writes', allowLocalTools: true, autoApproveCommands: [], blockedCommands: ['rm -rf'],
        mcpServers: [], model: '', effort: 'high', ...overrides,
    };
    return {
        events,
        approvals,
        set(patch) { current = { ...current, ...patch }; },
        options: {
            settings: current,
            getSettings: () => current,
            systemPrompt: 'SYSTEM',
            toolContext: () => ({ settings: current }),
            requestApproval: async (request) => { approvals.push(request); return { approved: true }; },
            onEvent: (event) => events.push(event),
        },
    };
}

(async () => {
    await test('models come back as provider/id rows, with thinking only where the model reasons', async () => {
        const rows = await pi.listModels();
        assert.deepStrictEqual(rows.map(row => row.value), ['anthropic/claude-sonnet-5', 'openai-codex/gpt-5.6', 'local/tiny']);
        assert.deepStrictEqual(rows[2].effort, []);
        assert.ok(rows[0].effort.includes('xhigh'));
    });

    await test('the extension is found outside the asar in a packaged app', () => {
        assert.ok(pi._test.extensionPath().endsWith('pi-extension.mjs'));
        assert.ok(fs.existsSync(pi._test.extensionPath()));
    });

    const h = harness();
    const session = await pi.start(h.options);

    await test('a turn streams, asks about the shell through the extension, and totals usage and cost', async () => {
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the first result');
        const reply = h.events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(reply.includes('extension=true') && reply.includes('mcp=true'), reply);
        assert.ok(reply.includes('thinking=high'), reply);
        assert.ok(/session=[0-9a-f-]{36}/.test(reply), 'our own session id was passed');
        assert.ok(h.events.some(event => event.type === 'thinking-delta' && event.text === 'pondering'));
        assert.strictEqual(h.approvals.length, 1);
        assert.deepStrictEqual(h.approvals[0].input, { command: 'npm test' });
        assert.strictEqual(h.events.find(event => event.type === 'tool-result' && event.id === 'c1').text, 'ran');
        assert.strictEqual(h.events.find(event => event.type === 'tool-call' && event.id === 'c2').local, false);
        const result = h.events.find(event => event.type === 'result');
        assert.deepStrictEqual(result.usage, { input_tokens: 300, output_tokens: 60, cache_read_input_tokens: 40 });
        assert.strictEqual(result.costUsd, 0.0046);
    });

    await test('each reply reports context usage with cache hits for the composer ring', async () => {
        await until(() => h.events.some(event => event.type === 'models'), 'the model catalogue');
        h.events.length = 0;
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the context result');
        assert.deepStrictEqual(h.events.filter(event => event.type === 'context'), [
            { type: 'context', used: 130, limit: 200000, percent: 0, model: 'anthropic/claude-sonnet-5', cached: 10 },
            { type: 'context', used: 400, limit: 200000, percent: 0, model: 'anthropic/claude-sonnet-5', cached: 40 },
        ]);
    });

    await test('bare mode runs without the extension or the app tools', async () => {
        const bare = harness({ bareProvider: true });
        const bareSession = await pi.start(bare.options);
        bareSession.send('hello');
        await until(() => bare.events.some(event => event.type === 'result'), 'the bare result');
        const reply = bare.events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(reply.includes('extension=false'), `no extension loaded: ${reply}`);
        assert.ok(reply.includes('mcp=false'), `no MCP url passed: ${reply}`);
        await bareSession.close();
    });

    await test('a blocked command is refused without a card', async () => {
        h.events.length = 0;
        h.approvals.length = 0;
        session.send('danger');
        await until(() => h.events.some(event => event.type === 'result'), 'the second result');
        assert.strictEqual(h.approvals.length, 0);
        assert.strictEqual(h.events.find(event => event.type === 'tool-result' && event.id === 'c1').text, 'blocked');
    });

    await test('model and thinking change on the live session', async () => {
        h.events.length = 0;
        h.set({ model: 'openai-codex/gpt-5.6', effort: 'low' });
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the third result');
        const reply = h.events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(reply.includes('model=openai-codex/gpt-5.6') && reply.includes('thinking=low'), reply);
    });

    await test('an interrupt aborts the turn', async () => {
        h.events.length = 0;
        session.send('wait');
        await until(() => h.events.some(event => event.type === 'text-delta'), 'the turn to start');
        await session.interrupt();
        await until(() => h.events.some(event => event.type === 'result'), 'the aborted result');
        assert.strictEqual(h.events.find(event => event.type === 'result').subtype, 'cancelled');
    });

    await session.close();
    await test('a closed session reports itself stopped', async () => {
        await until(() => session.stopped, 'the process to go');
    });

    await test('the extension registers the app\'s tools from the real tool server, calls them, and gates Pi\'s own', async () => {
        // The one import Pi supplies as a virtual module, stubbed.
        const copy = path.join(userData, 'pi-extension.mjs');
        const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ai', 'pi-extension.mjs'), 'utf8')
            .replace("import { Type } from 'typebox';", 'const Type = { Unsafe: (schema) => schema };');
        fs.writeFileSync(copy, source);

        const host = await mcpHost.acquire({
            toolContext: () => ({ settings: { approval: 'never', autoApproveCommands: [], blockedCommands: [] } }),
            requestApproval: async () => ({ approved: true }),
        });
        process.env.ACESTES_MCP_URL = host.tokenUrl;
        const { default: factory } = await import(`${pathToFileURL(copy).href}?t=${Date.now()}`);

        const tools = [];
        const handlers = {};
        await factory({ registerTool: tool => tools.push(tool), on: (name, fn) => { handlers[name] = fn; } });
        assert.ok(tools.some(tool => tool.name === 'list_hosts'), 'list_hosts registered');
        assert.ok(tools.find(tool => tool.name === 'list_hosts').parameters.type === 'object');

        const listed = await tools.find(tool => tool.name === 'list_hosts').execute('id', {}, undefined);
        assert.strictEqual(listed.content[0].type, 'text');

        // Ours pass untouched; a native tool is put to the client, and a no blocks it.
        assert.strictEqual(await handlers.tool_call({ toolName: 'list_hosts', input: {} }, { hasUI: true }), undefined);
        let asked = null;
        const refused = await handlers.tool_call({ toolName: 'bash', input: { command: 'ls' } }, {
            hasUI: true,
            ui: { confirm: async (title, message) => { asked = { title, message }; return false; } },
        });
        assert.strictEqual(asked.title, 'acestes:approve');
        assert.deepStrictEqual(JSON.parse(asked.message), { tool: 'bash', input: { command: 'ls' } });
        assert.strictEqual(refused.block, true);

        await mcpHost.release(host.token);
    });

    console.log(`${passed} passed, 0 failed`);
    fs.rmSync(userData, { recursive: true, force: true });
    // Left to drain rather than cut off: exiting with the extension's fetch
    // sockets still open trips a libuv assertion on Windows. They close with
    // the tool server; the timer is only a backstop.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 6000).unref();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
