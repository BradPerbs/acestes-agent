/**
 * The stdio bridge, against the real tool server.
 *
 * An agent that can only spawn MCP servers is handed `mcp-bridge.js` with
 * mcp-host's token address. This starts the host, speaks MCP to the bridge
 * over its stdio the way such an agent would, and checks that the app's
 * tools come back.
 */
const Module = require('module');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

const electronStub = { app: { getPath: () => require('os').tmpdir(), getVersion: () => '1.0.0' } };
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const mcpHost = require('../src/main/ai/mcp-host');

(async () => {
    const host = await mcpHost.acquire({
        toolContext: () => ({ settings: { approval: 'never', autoApproveCommands: [], blockedCommands: [] } }),
        requestApproval: async () => ({ approved: true }),
    });

    const bridge = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'main', 'ai', 'mcp-bridge.js'), host.tokenUrl], {
        stdio: ['pipe', 'pipe', 'inherit'],
    });

    const answers = new Map();
    let buffer = '';
    bridge.stdout.setEncoding('utf8');
    bridge.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n');
        while (index >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf('\n');
            if (!line) continue;
            const message = JSON.parse(line);
            if (message.id !== undefined) answers.get(message.id)?.(message);
        }
    });
    const call = (id, method, params) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 10000);
        answers.set(id, (message) => { clearTimeout(timer); resolve(message); });
        bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

    const init = await call(1, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'bridge-test', version: '1.0.0' },
    });
    assert.ok(init.result?.serverInfo, `initialize answered: ${JSON.stringify(init)}`);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const tools = await call(2, 'tools/list', {});
    const names = (tools.result?.tools || []).map(tool => tool.name);
    assert.ok(names.includes('list_hosts'), `tools came back: ${names.slice(0, 5).join(', ')}`);
    console.log(`  ok   the bridge reaches the app's ${names.length} tools over stdio`);

    bridge.stdin.end();
    await mcpHost.release(host.token);
    console.log('1 passed, 0 failed');
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
