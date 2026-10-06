/**
 * Global settings: a change on the Acestes agent (the default, project-less
 * one) fans out to every agent that never deliberately diverged.
 *
 * An agent that switched a value off itself keeps it; sign-ins never leave
 * the agent that chose them; maps merge key by key so one untouched bundle
 * follows while a switched-off bundle stays off.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-global-'));

const electronStub = {
    app: {
        getPath: () => userData,
        getVersion: () => '1.0.0',
        on: () => {},
        whenReady: () => new Promise(() => {}),
    },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
    ipcMain: { handle: () => {}, on: () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const agents = require(path.join(ROOT, 'agents'));
const settings = require(path.join(ROOT, 'ai', 'settings'));

let passed = 0;
let failed = 0;
const check = async (label, fn) => {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${label}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${label}\n       ${error.stack || error.message}`);
    }
};

const ALL_ON = {
    workspace: true, desktop: true, memory: true, inventory: true,
    automation: true, collaboration: true, integrations: true,
};

(async () => {
    const snap = agents.snapshot();
    assert.strictEqual(snap.agents[0].name, 'Acestes');
    const acestesId = snap.agents[0].id;
    const workerId = agents.save({ name: 'Worker' }).saved;
    const divergedId = agents.save({ name: 'Diverged' }).saved;

    await check('a change on another agent stays on that agent', async () => {
        settings.set({ approval: 'always' }, workerId);
        assert.strictEqual(settings.get(workerId).approval, 'always');
        assert.strictEqual(settings.get(acestesId).approval, 'writes', 'the base is untouched');
        assert.deepStrictEqual(settings.takePropagation(), [], 'nothing fans out');
        settings.set({ approval: 'writes' }, workerId);
    });

    // Diverged switches one bundle off deliberately, before the global change.
    settings.set({ toolBundles: { ...ALL_ON, inventory: false } }, divergedId);

    await check('a change on Acestes lands on the base and on agents that never diverged', async () => {
        settings.set({ toolBundles: { ...ALL_ON, automation: false }, approval: 'always' }, acestesId);
        assert.strictEqual(settings.get(acestesId).toolBundles.automation, false);
        assert.strictEqual(settings.get(workerId).toolBundles.automation, false, 'a snapshot follows');
        assert.strictEqual(settings.get(workerId).approval, 'always', 'scalars follow');
        const touched = settings.takePropagation().map(entry => entry.agentId).sort();
        assert.deepStrictEqual(touched, [divergedId, workerId].sort(), 'both others restart');
    });

    await check('a deliberately diverged bundle stays off while the rest follows', async () => {
        assert.strictEqual(settings.get(divergedId).toolBundles.inventory, false, 'the choice stands');
        assert.strictEqual(settings.get(divergedId).toolBundles.automation, false, 'untouched bundles follow');
    });

    await check('renaming Acestes ends the behaviour', async () => {
        agents.save({ id: acestesId, name: 'Renamed' });
        settings.set({ approval: 'never' }, acestesId);
        assert.strictEqual(settings.get(workerId).approval, 'always', 'no fan-out without the name');
        assert.deepStrictEqual(settings.takePropagation(), []);
        agents.save({ id: acestesId, name: 'Acestes' });
        settings.set({ approval: 'writes' }, acestesId);
    });

    await check('bare mode is off by default and propagates like any setting', async () => {
        assert.strictEqual(settings.get(workerId).bareProvider, false, 'off unless switched on');
        settings.set({ bareProvider: true }, acestesId);
        assert.strictEqual(settings.get(workerId).bareProvider, true, 'follows from Acestes');
        assert.deepStrictEqual(
            settings.takePropagation().map(entry => entry.agentId).sort(),
            [divergedId, workerId].sort()
        );
        settings.set({ bareProvider: false }, acestesId);
        assert.strictEqual(settings.get(workerId).bareProvider, false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
