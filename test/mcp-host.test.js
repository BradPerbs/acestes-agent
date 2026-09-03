/**
 * The tool server's open-call count: a call that is waiting on the user
 * is counted for as long as it waits, so a runtime's idle timer can tell
 * a card on screen from a hang.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-mcp-host-'));

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

const mcpHost = require(path.join(ROOT, 'ai', 'mcp-host'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

async function main() {
    console.log('mcp host');

    // An approval that waits until the test says so.
    let decide = null;
    const verdict = new Promise((resolve) => { decide = resolve; });
    const events = [];
    const { url, token, tokenUrl } = await mcpHost.acquire({
        toolContext: () => ({ settings: { approval: 'always', autoApproveCommands: [], blockedCommands: [] } }),
        requestApproval: () => verdict,
        onEvent: (event) => events.push(event),
    });
    assert.strictEqual(mcpHost.pending(token), 0, 'nothing open before a call');

    const client = new Client({ name: 'test', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(tokenUrl || url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);

    const call = client.callTool({ name: 'list_hosts', arguments: {} });
    // Let the request land and reach the approval gate.
    for (let waited = 0; waited < 100 && mcpHost.pending(token) === 0; waited += 1) await tick();
    assert.strictEqual(mcpHost.pending(token), 1, 'the call is counted while it waits for the user');
    console.log('  ok  a call waiting on approval counts as open');

    decide({ approved: false, message: 'Not now.' });
    const result = await call;
    assert.strictEqual(result.isError, true);
    assert.ok(/Not now/.test(result.content[0].text));
    for (let waited = 0; waited < 100 && mcpHost.pending(token) > 0; waited += 1) await tick();
    assert.strictEqual(mcpHost.pending(token), 0, 'and is not counted once answered');
    console.log('  ok  the count drops when the call is answered');

    assert.strictEqual(mcpHost.pending('not-a-token'), 0);
    await client.close();
    await mcpHost.release(token);
    console.log('\nall mcp host tests passed');
}

// No forced exit on success: the server is still closing its socket, and
// tearing the loop down under it trips a libuv assertion on Windows.
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
