/**
 * The look an agent's mark wears: a colour, and the crest or none, each one
 * of a known list, kept across a save and refused when it is not one the
 * renderer can draw.
 *
 * `electron` is stubbed so the registry runs under plain node against a
 * scratch userData folder.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-agents-look-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
        decryptString: (buffer) => buffer.toString('utf8').slice(4),
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

// As a release before the crest choice wrote it: a colour and nothing else.
fs.writeFileSync(path.join(userData, 'agents.json'), JSON.stringify({
    version: 1,
    activeId: 'agent-1',
    agents: [{ id: 'agent-1', name: 'Acestes', color: 'amber', createdAt: 1, settings: {}, mcpServers: [], sandbox: {}, hooks: [] }],
}, null, 2));

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

const shown = (id) => agents.snapshot().agents.find(agent => agent.id === id);

console.log('agent look');

check('an agent saved before there was a choice wears the crest, and keeps its colour', () => {
    const agent = shown('agent-1');
    assert.strictEqual(agent.color, 'amber');
    assert.strictEqual(agent.crest, 'plume');
});

check('a new agent is made in the look it was given', () => {
    const result = agents.save({ name: 'Scout', color: 'black', crest: 'none' });
    const agent = shown(result.saved);
    assert.strictEqual(agent.color, 'black');
    assert.strictEqual(agent.crest, 'none');
});

check('an edit changes only the parts it names', () => {
    agents.save({ id: 'agent-1', crest: 'none' });
    const agent = shown('agent-1');
    assert.strictEqual(agent.crest, 'none');
    assert.strictEqual(agent.color, 'amber', 'the colour is untouched');
});

check('a crest nobody can draw is refused rather than stored', () => {
    agents.save({ id: 'agent-1', crest: 'antlers' });
    assert.strictEqual(shown('agent-1').crest, 'none');

    const result = agents.save({ name: 'Odd', crest: '<svg>' });
    assert.strictEqual(shown(result.saved).crest, 'plume');
});

check('the look is written to disk and read back', () => {
    const text = fs.readFileSync(path.join(userData, 'agents.json'), 'utf8');
    const scout = JSON.parse(text).agents.find(agent => agent.name === 'Scout');
    assert.strictEqual(scout.color, 'black');
    assert.strictEqual(scout.crest, 'none');
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
