/**
 * The MCP probe: a handshake with an agent's server, over stdio and over
 * http, and what it says when the server is not there.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-mcp-probe-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const agents = require(path.join(ROOT, 'agents'));
const probe = require(path.join(ROOT, 'ai', 'mcp-probe'));

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');

/** A stateless streamable-http MCP server that insists on one bearer token. */
function serveHttp(token) {
    const server = http.createServer(async (req, res) => {
        if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401).end('no');
            return;
        }
        const mcp = new McpServer({ name: 'http-fixture', version: '0.0.2' });
        mcp.registerTool('ping', { description: 'Answers pong.' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
        mcp.registerTool('time', { description: 'The time.' }, async () => ({ content: [{ type: 'text', text: String(Date.now()) }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` }));
    });
}

async function main() {
    console.log('mcp probe');

    // stdio: the fixture answers, names itself, and lists its one tool.
    const stdio = await probe.probe({ transport: 'stdio', command: process.execPath, args: [FIXTURE], env: {} });
    assert.strictEqual(stdio.ok, true, `stdio probe failed: ${stdio.error}`);
    assert.strictEqual(stdio.name, 'echo-fixture');
    assert.strictEqual(stdio.version, '0.0.1');
    assert.deepStrictEqual(stdio.tools, ['ping']);
    assert.ok(stdio.latencyMs >= 0);
    console.log('  ok  stdio: handshake, name, version, tools');

    // stdio: a command that does not exist is a reason, not a hang.
    const missing = await probe.probe({ transport: 'stdio', command: 'no-such-mcp-server-xyz', args: [], env: {} });
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.error, 'a failed probe carries a reason');
    console.log(`  ok  stdio: missing command is reported (${missing.error})`);

    // Windows: a `.cmd` shim, in a folder with a space in its name, and the
    // same shim by its bare name through PATH, which is what `npx` is.
    if (process.platform === 'win32') {
        const spaced = fs.mkdtempSync(path.join(os.tmpdir(), 'cb probe space-'));
        try {
            const shim = path.join(spaced, 'echo-fixture.cmd');
            fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`);
            const viaShim = await probe.probe({ transport: 'stdio', command: shim, args: [], env: {} });
            assert.strictEqual(viaShim.ok, true, `a .cmd in a folder with a space: ${viaShim.error}`);
            assert.deepStrictEqual(viaShim.tools, ['ping']);
            const bare = await probe.probe({ transport: 'stdio', command: 'echo-fixture', args: [], env: { PATH: `${spaced};${process.env.PATH || ''}` } });
            assert.strictEqual(bare.ok, true, `a bare name resolved through PATH and PATHEXT: ${bare.error}`);
            console.log('  ok  windows: .cmd shims with spaces, and bare names through PATH');
        } finally {
            fs.rmSync(spaced, { recursive: true, force: true });
        }
    }

    // http: the header on the record reaches the server; two tools come back.
    const { server, url } = await serveHttp('t0k');
    try {
        const remote = await probe.probe({ transport: 'http', url, headers: { Authorization: 'Bearer t0k' } });
        assert.strictEqual(remote.ok, true, `http probe failed: ${remote.error}`);
        assert.strictEqual(remote.name, 'http-fixture');
        assert.deepStrictEqual(remote.tools.sort(), ['ping', 'time']);
        console.log('  ok  http: handshake with the record\'s headers');

        const wrong = await probe.probe({ transport: 'http', url, headers: { Authorization: 'Bearer nope' } });
        assert.strictEqual(wrong.ok, false);
        assert.ok(wrong.error);
        console.log('  ok  http: a refused token is reported');
    } finally {
        server.close();
    }

    // http: nothing listening is a quick no.
    const nobody = await probe.probe({ transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: {} });
    assert.strictEqual(nobody.ok, false);
    console.log('  ok  http: nothing listening is reported');

    // check(): records the status under the server's id and pushes it.
    const pushed = [];
    probe.setNotifier((channel, payload) => pushed.push({ channel, payload }));
    const made = agents.save({ name: 'Prober', mcpServers: [{ name: 'echo', transport: 'stdio', command: process.execPath, args: [FIXTURE] }] });
    const agentId = made.saved;
    const serverId = agents.get(agentId).mcpServers[0].id;

    const [first, second] = await Promise.all([probe.check(agentId, serverId), probe.check(agentId, serverId)]);
    assert.strictEqual(first, second, 'two askers share one handshake');
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(probe.known(agentId)[serverId].tools, ['ping']);
    assert.ok(pushed.some(entry => entry.channel === 'mcp-status' && entry.payload.status.checking), 'a checking status is pushed first');
    assert.ok(pushed.some(entry => entry.channel === 'mcp-status' && entry.payload.status.ok), 'the result is pushed after');
    console.log('  ok  check: shared in flight, recorded, pushed');

    probe.forget(serverId);
    assert.deepStrictEqual(probe.known(agentId), {});
    const all = await probe.checkAll(agentId);
    assert.strictEqual(all[serverId].ok, true);
    console.log('  ok  forget and checkAll');

    console.log('\nall mcp probe tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
});
