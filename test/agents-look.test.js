/**
 * The look an agent's mark wears: a colour, a helmet, and the crest or none,
 * each one of a known list, kept across a save and refused when it is not one
 * the renderer can draw.
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

check('an agent saved before there was a choice of helmet wears the Corinthian', () => {
    assert.strictEqual(shown('agent-1').helmet, 'corinthian');
});

check('a new agent wears the helmet it was given, and an edit can change it alone', () => {
    const result = agents.save({ name: 'Ronin', color: 'rose', helmet: 'kabuto', crest: 'none' });
    assert.strictEqual(shown(result.saved).helmet, 'kabuto');

    agents.save({ id: result.saved, helmet: 'greathelm' });
    const agent = shown(result.saved);
    assert.strictEqual(agent.helmet, 'greathelm');
    assert.strictEqual(agent.color, 'rose', 'the colour is untouched');
    assert.strictEqual(agent.crest, 'none', 'the crest is untouched');
});

check('every crest there is can be worn and is kept', () => {
    for (const crest of ['plume', 'transverse', 'horns', 'crown', 'feathers', 'none']) {
        const result = agents.save({ name: `Crested ${crest}`, helmet: 'galea', crest });
        assert.strictEqual(shown(result.saved).crest, crest);
    }
});

check('a helmet nobody can draw is refused rather than stored', () => {
    agents.save({ id: 'agent-1', helmet: 'fedora' });
    assert.strictEqual(shown('agent-1').helmet, 'corinthian');

    const result = agents.save({ name: 'Hatless', helmet: '../../etc' });
    assert.strictEqual(shown(result.saved).helmet, 'corinthian');
});

check('an agent saved before there was a finish or a description is outlined and has none', () => {
    const agent = shown('agent-1');
    assert.strictEqual(agent.finish, 'outline');
    assert.strictEqual(agent.description, '');
});

check('a colour of the agent\'s own is kept, in capitals', () => {
    const result = agents.save({ name: 'Mint', color: '#3ad29f' });
    assert.strictEqual(shown(result.saved).color, '#3AD29F');

    agents.save({ id: result.saved, color: '#FF00AA' });
    assert.strictEqual(shown(result.saved).color, '#FF00AA');

    agents.save({ id: result.saved, color: 'teal' });
    assert.strictEqual(shown(result.saved).color, 'teal', 'and it can go back to one of the set');
});

check('a colour that is not a colour is refused rather than stored', () => {
    agents.save({ id: 'agent-1', color: '#FFF' });
    agents.save({ id: 'agent-1', color: 'red; background: url(x)' });
    agents.save({ id: 'agent-1', color: '#12345G' });
    assert.strictEqual(shown('agent-1').color, 'amber');

    const result = agents.save({ name: 'Unpainted', color: 'rgb(1,2,3)' });
    assert.strictEqual(shown(result.saved).color, 'sky');
});

check('the finish is kept, and one nobody can draw is refused', () => {
    const result = agents.save({ name: 'Enamel', color: 'violet', finish: 'solid' });
    assert.strictEqual(shown(result.saved).finish, 'solid');

    agents.save({ id: result.saved, finish: 'glitter' });
    assert.strictEqual(shown(result.saved).finish, 'solid');

    agents.save({ id: result.saved, finish: 'outline' });
    assert.strictEqual(shown(result.saved).finish, 'outline');
    assert.strictEqual(shown(result.saved).color, 'violet', 'the colour is untouched');
});

check('an agent has no effect until it is given one, then keeps it', () => {
    assert.strictEqual(shown('agent-1').aura, 'none');

    for (const aura of ['embers', 'stars', 'orbit', 'drift', 'none']) {
        agents.save({ id: 'agent-1', aura });
        assert.strictEqual(shown('agent-1').aura, aura);
    }

    const result = agents.save({ name: 'Forge', aura: 'embers' });
    assert.strictEqual(shown(result.saved).aura, 'embers');
});

check('an effect nobody can draw is refused rather than stored', () => {
    agents.save({ id: 'agent-1', aura: 'stars' });
    agents.save({ id: 'agent-1', aura: 'fireworks' });
    assert.strictEqual(shown('agent-1').aura, 'stars');

    const result = agents.save({ name: 'Plain', aura: '<canvas>' });
    assert.strictEqual(shown(result.saved).aura, 'none');
});

check('the description is kept, trimmed and capped, and can be emptied', () => {
    const result = agents.save({ name: 'Keeper', description: '  Web servers\n and backups  ' });
    assert.strictEqual(shown(result.saved).description, 'Web servers and backups');

    agents.save({ id: result.saved, description: 'x'.repeat(200) });
    assert.strictEqual(shown(result.saved).description.length, 60);

    agents.save({ id: result.saved, name: 'Keeper' });
    assert.strictEqual(shown(result.saved).description.length, 60, 'an edit that does not name it leaves it');

    agents.save({ id: result.saved, description: '' });
    assert.strictEqual(shown(result.saved).description, '');
});

check('the look is written to disk and read back', () => {
    const text = fs.readFileSync(path.join(userData, 'agents.json'), 'utf8');
    const saved = JSON.parse(text).agents;
    const scout = saved.find(agent => agent.name === 'Scout');
    assert.strictEqual(scout.color, 'black');
    assert.strictEqual(scout.crest, 'none');
    assert.strictEqual(saved.find(agent => agent.name === 'Ronin').helmet, 'greathelm');
    assert.strictEqual(saved.find(agent => agent.name === 'Mint').color, 'teal');
    assert.strictEqual(saved.find(agent => agent.name === 'Enamel').finish, 'outline');
});

console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
