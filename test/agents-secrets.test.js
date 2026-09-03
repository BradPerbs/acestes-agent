/**
 * Credentials on an MCP server record go to the secrets store whichever
 * door they came through: the settings page, the agent's own tool, or an
 * agents.json written before the store existed.
 *
 * `electron` is stubbed with a reversible "encryption" so the round trip
 * can be checked under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-agent-secrets-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
        decryptString: (buffer) => {
            const text = buffer.toString('utf8');
            if (!text.startsWith('enc:')) throw new Error('not ours');
            return text.slice(4);
        },
    },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const KEY = '7356243d4843f97bd8f4fd38052169d8';
const TOKEN = 'glsa_abcdefghijklmnopqrstuvwxyz';

// The file as an earlier release wrote it: the key in the clear.
fs.writeFileSync(path.join(userData, 'agents.json'), JSON.stringify({
    version: 1,
    activeId: 'agent-1',
    agents: [{
        id: 'agent-1',
        name: 'Acestes',
        color: 'sky',
        createdAt: 1,
        settings: {},
        mcpServers: [{
            id: 'mcp-solver',
            name: 'mcp-captcha-solver',
            transport: 'stdio',
            command: 'python',
            args: ['-m', 'server'],
            env: { APIKEY_2CAPTCHA: KEY, PYTHONPATH: 'C:\\solver', BROWSER_HEADLESS: 'true' },
            headers: {},
        }, {
            id: 'mcp-grafana',
            name: 'Grafana',
            transport: 'http',
            url: 'https://grafana.example.com/mcp',
            headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
        }],
        sandbox: {},
        hooks: [],
    }],
}, null, 2));

const secrets = require(path.join(ROOT, 'ai', 'secrets'));
const agents = require(path.join(ROOT, 'agents'));

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

console.log('agent credentials');

check('a key in the clear in agents.json is moved to the store on load', () => {
    const [solver, grafana] = agents.get('agent-1').mcpServers;
    assert.strictEqual(solver.env.APIKEY_2CAPTCHA, '{{secret:mcp-captcha-solver.APIKEY_2CAPTCHA}}');
    assert.strictEqual(solver.env.PYTHONPATH, 'C:\\solver', 'a path is not a credential');
    assert.strictEqual(solver.env.BROWSER_HEADLESS, 'true');
    assert.strictEqual(grafana.headers.Authorization, '{{secret:Grafana.Authorization}}');
    assert.strictEqual(grafana.headers.Accept, 'application/json');
    assert.strictEqual(agents.migratedCredentials(), 2);
    assert.strictEqual(secrets.read('mcp-captcha-solver.APIKEY_2CAPTCHA'), KEY);
    assert.strictEqual(secrets.read('Grafana.Authorization'), `Bearer ${TOKEN}`);
});

check('the migrated file is written back without the values', () => {
    const text = fs.readFileSync(path.join(userData, 'agents.json'), 'utf8');
    assert.ok(!text.includes(KEY), 'the key is gone from agents.json');
    assert.ok(!text.includes(TOKEN), 'the token is gone from agents.json');
    assert.ok(text.includes('{{secret:mcp-captcha-solver.APIKEY_2CAPTCHA}}'));
});

check('the launch config gets the value back', () => {
    const [solver] = agents.get('agent-1').mcpServers;
    assert.deepStrictEqual(secrets.resolveObject(solver.env).APIKEY_2CAPTCHA, KEY);
});

check('a server saved from the settings page is vaulted the same way', () => {
    agents.save({ id: 'agent-1', mcpServers: [
        ...agents.get('agent-1').mcpServers,
        { name: 'Brave', transport: 'stdio', command: 'npx', args: ['-y', 'brave'], env: { BRAVE_API_KEY: 'BSA-1234567890', HOME: '/home/me' } },
    ] });
    const brave = agents.get('agent-1').mcpServers.find(server => server.name === 'Brave');
    assert.strictEqual(brave.env.BRAVE_API_KEY, '{{secret:Brave.BRAVE_API_KEY}}');
    assert.strictEqual(brave.env.HOME, '/home/me');
    assert.strictEqual(secrets.read('Brave.BRAVE_API_KEY'), 'BSA-1234567890');
    const text = fs.readFileSync(path.join(userData, 'agents.json'), 'utf8');
    assert.ok(!text.includes('BSA-1234567890'));
});

check('a reference written on purpose is kept as it is, and saving again does not re-vault', () => {
    secrets.set('webshare', 'ws-test-key-not-a-real-credential');
    agents.save({ id: 'agent-1', mcpServers: [
        ...agents.get('agent-1').mcpServers,
        { name: 'Proxy tool', transport: 'stdio', command: 'x', env: { WEBSHARE_TOKEN: '{{secret:webshare}}' } },
    ] });
    const tool = agents.get('agent-1').mcpServers.find(server => server.name === 'Proxy tool');
    assert.strictEqual(tool.env.WEBSHARE_TOKEN, '{{secret:webshare}}');
    assert.ok(!secrets.has('Proxy tool.WEBSHARE_TOKEN'), 'no second copy under the server\'s name');
    const before = secrets.list().length;
    agents.save({ id: 'agent-1', mcpServers: agents.get('agent-1').mcpServers });
    assert.strictEqual(secrets.list().length, before, 'a save of what is already vaulted stores nothing new');
});

check('what the renderer and the agent read carries references, never values', () => {
    const shown = JSON.stringify(agents.snapshot());
    assert.ok(!shown.includes(KEY));
    assert.ok(!shown.includes(TOKEN));
    assert.ok(!shown.includes('BSA-1234567890'));
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
