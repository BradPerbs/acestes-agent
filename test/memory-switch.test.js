/**
 * Switching an agent's memory off.
 *
 * The setting is per agent and on by default, so a config from before it
 * existed keeps its memory. Off, the system prompt carries neither the notes
 * nor the invitation to keep them, and the three memory tools refuse rather
 * than read or write the notebook, which is left as it was.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-memory-switch-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const settings = require(path.join(ROOT, 'ai', 'settings'));
const prompt = require(path.join(ROOT, 'ai', 'prompt'));
const memory = require(path.join(ROOT, 'ai', 'memory'));
const tools = require(path.join(ROOT, 'ai', 'tools'));

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

async function main() {
    const { sanitize } = settings._test;
    const AGENT = 'agent-memory-switch';

    console.log('\nmemory switch');

    await check('memory is on by default and for a config that never set it', () => {
        assert.strictEqual(sanitize(null).memory, true);
        assert.strictEqual(sanitize({ autoRemember: true }).memory, true);
    });

    await check('memory can be switched off and on again', () => {
        assert.strictEqual(sanitize({ memory: false }).memory, false);
        assert.strictEqual(sanitize({ memory: true }).memory, true);
    });

    await check('the prompt carries notes and the memory section while on', () => {
        const text = prompt.build({ memory: '- (m-1) The user prefers vim' });
        assert.ok(text.includes('## What you remember'));
        assert.ok(text.includes('The user prefers vim'));
        assert.ok(text.includes('## Memory'));
    });

    await check('the prompt carries neither while off', () => {
        const text = prompt.build({ memory: '- (m-1) The user prefers vim', memoryOff: true });
        assert.ok(!text.includes('## What you remember'));
        assert.ok(!text.includes('The user prefers vim'));
        assert.ok(!text.includes('## Memory'));
        assert.ok(!/\buse remember\b/i.test(text));
        assert.ok(text.includes('## Your inventory'));
    });

    const held = memory.add(AGENT, { text: 'Web-01 runs nginx behind haproxy', source: 'user' });
    const on = { agentId: AGENT, settings: sanitize({ memory: true }) };
    const off = { agentId: AGENT, settings: sanitize({ memory: false }) };

    await check('the tools refuse while off, and leave the notebook alone', async () => {
        for (const [name, input] of [
            ['remember', { text: 'Something new' }],
            ['recall', { query: 'nginx' }],
            ['forget', { id: held.id }],
        ]) {
            const result = await tools.BY_NAME.get(name).handler(input, off);
            assert.strictEqual(result.isError, true, `${name} did not refuse`);
            assert.ok(/switched off/.test(result.text), `${name} did not say why`);
        }
        const notes = memory.list(AGENT);
        assert.strictEqual(notes.length, 1);
        assert.strictEqual(notes[0].id, held.id);
    });

    await check('the tools work while on', async () => {
        const saved = await tools.BY_NAME.get('remember').handler({ text: 'The user prefers vim' }, on);
        assert.ok(!saved.isError);
        const found = await tools.BY_NAME.get('recall').handler({ query: 'haproxy' }, on);
        assert.ok(!found.isError);
        assert.ok(found.text.includes(held.id));
        const gone = await tools.BY_NAME.get('forget').handler({ id: held.id }, on);
        assert.ok(!gone.isError);
        assert.strictEqual(memory.list(AGENT).length, 1);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
