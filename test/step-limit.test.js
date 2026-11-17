/**
 * The step limit: that a step limit of 0 is kept as "no limit" rather than
 * clamped or mistaken for a missing value.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-steps-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    ipcMain: { handle: () => {}, on: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const settings = require(path.join(ROOT, 'ai', 'settings'));
const agents = require(path.join(ROOT, 'agents'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.stack || error.message}`);
    }
}

(async () => {
    const agentId = agents.activeId();

    console.log('\nmcp servers');

    await check('every server on the agent is handed to the runtimes, Playwright included', () => {
        agents.save({
            id: agentId,
            mcpServers: [
                { name: 'Playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], template: 'playwright' },
                { name: 'Context7', transport: 'http', url: 'https://mcp.context7.com/mcp' },
            ],
        });
        const current = settings.get(agentId);
        assert.strictEqual('browserUse' in current, false);
        assert.deepStrictEqual(current.mcpServers.map(server => server.name).sort(), ['Context7', 'Playwright']);
    });

    console.log('\nsteps per turn');

    await check('0 is kept as no limit', () => {
        settings.set({ maxTurns: 0 }, agentId);
        assert.strictEqual(settings.get(agentId).maxTurns, 0);
    });

    await check('an odd value is clamped, never no limit by accident', () => {
        // null reads as a number, as it always has, and is clamped up.
        settings.set({ maxTurns: null }, agentId);
        assert.ok(settings.get(agentId).maxTurns >= 1);
        settings.set({ maxTurns: '0' }, agentId);
        assert.strictEqual(settings.get(agentId).maxTurns, 1);
        settings.set({ maxTurns: 500 }, agentId);
        assert.strictEqual(settings.get(agentId).maxTurns, 200);
        settings.set({ maxTurns: 40 }, agentId);
        assert.strictEqual(settings.get(agentId).maxTurns, 40);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
