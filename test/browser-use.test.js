/**
 * Browser use and the step limit: which servers count as the browser, that
 * switching browser use off leaves the browser out of what the runtimes are
 * handed (and nothing else), and that a step limit of 0 is kept as "no limit"
 * rather than clamped or mistaken for a missing value.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-browser-'));

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

const browserUse = require(path.join(ROOT, 'ai', 'browser-use'));
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
    console.log('\nwhich server is the browser');

    await check('the library template, and Playwright typed in by hand, are the browser', () => {
        assert.strictEqual(browserUse.isBrowserServer({ template: 'playwright', args: [] }), true);
        assert.strictEqual(browserUse.isBrowserServer({ command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--extension'] }), true);
        assert.strictEqual(browserUse.isBrowserServer({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] }), true);
    });

    await check('other servers are not', () => {
        assert.strictEqual(browserUse.isBrowserServer({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] }), false);
        assert.strictEqual(browserUse.isBrowserServer({ command: 'npx', args: ['-y', '@playwright/test'] }), false);
        assert.strictEqual(browserUse.isBrowserServer(null), false);
    });

    await check('findOnPath finds a program in an extra folder, the way Windows names it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-path-'));
        const file = path.join(dir, process.platform === 'win32' ? 'fake-tool.cmd' : 'fake-tool');
        fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
        if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
        assert.strictEqual(path.normalize(browserUse.findOnPath('fake-tool', [dir])).toLowerCase(), path.normalize(file).toLowerCase());
        assert.strictEqual(browserUse.findOnPath('no-such-tool-anywhere', [dir]), '');
    });

    await check('the status read answers in the shape the settings page reads', async () => {
        const status = await browserUse.status();
        assert.strictEqual(typeof status.node.found, 'boolean');
        assert.ok(['chrome', 'msedge', ''].includes(status.preferred));
        assert.strictEqual(typeof status.browsers.chrome, 'boolean');
        assert.strictEqual(typeof status.installer, 'string');
    });

    console.log('\nbrowser use on and off');

    const agentId = agents.activeId();
    agents.save({
        id: agentId,
        mcpServers: [
            { name: 'Playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], template: 'playwright' },
            { name: 'Context7', transport: 'http', url: 'https://mcp.context7.com/mcp' },
        ],
    });

    await check('on from the start, so an agent that has a browser keeps it', () => {
        const current = settings.get(agentId);
        assert.strictEqual(current.browserUse, true);
        assert.deepStrictEqual(current.mcpServers.map(server => server.name).sort(), ['Context7', 'Playwright']);
    });

    await check('off leaves the browser out of the servers every runtime reads, and keeps the rest', () => {
        settings.set({ browserUse: false }, agentId);
        const current = settings.get(agentId);
        assert.strictEqual(current.browserUse, false);
        assert.deepStrictEqual(current.mcpServers.map(server => server.name), ['Context7']);
        // The record itself is kept, so switching back on needs no setup.
        assert.strictEqual(agents.get(agentId).mcpServers.length, 2);
    });

    await check('back on hands it over again', () => {
        settings.set({ browserUse: true }, agentId);
        assert.deepStrictEqual(settings.get(agentId).mcpServers.map(server => server.name).sort(), ['Context7', 'Playwright']);
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
