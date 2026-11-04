/**
 * The buddy on by default (settings.js, config version 3).
 *
 * A new install starts with it on. A settings file an older version wrote
 * says `buddy: false` whether or not anyone chose that, since the whole
 * config is written, so it is switched on once on the way in; written again
 * as version 3, a choice made since is kept on the next start.
 *
 * Each start is a fresh copy of the settings module, which keeps what it
 * read for the life of the process. `electron` is stubbed so it runs under
 * plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const SETTINGS = path.join(ROOT, 'ai', 'settings.js');
let userData = '';

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
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

/** The settings module as a new start of the app reads it. */
function start() {
    delete require.cache[require.resolve(SETTINGS)];
    return require(SETTINGS);
}

/** A profile of its own, holding the settings file an older version wrote, if any. */
function profile(written) {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-buddy-default-'));
    if (written) fs.writeFileSync(path.join(userData, 'assistant.json'), JSON.stringify(written), 'utf8');
}

const onDisk = () => JSON.parse(fs.readFileSync(path.join(userData, 'assistant.json'), 'utf8'));

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.stack || error.message}`);
    }
}

console.log('\nthe buddy on by default');

check('a new install starts with it on', () => {
    profile(null);
    assert.strictEqual(start().get().buddy, true);
});

check('a file from before (version 2, buddy off) starts with it on, until anything is saved', () => {
    profile({ version: 2, config: { buddy: false, buddyNotch: true } });
    assert.strictEqual(start().get().buddy, true, 'switched on on the way in');
    assert.strictEqual(onDisk().version, 2, 'nothing written just for reading');
    assert.strictEqual(start().get().buddy, true, 'and again on the next start');
});

check('switched off since, it stays off on the next start', () => {
    profile({ version: 2, config: { buddy: false } });
    const settings = start();
    assert.strictEqual(settings.get().buddy, true);
    settings.set({ buddy: false });
    assert.strictEqual(onDisk().version, 3, 'written as the version that knows the default');
    assert.strictEqual(onDisk().config.buddy, false);
    assert.strictEqual(start().get().buddy, false, 'the choice is kept');
});

check('anything else saved keeps it on from then on', () => {
    profile({ version: 2, config: { buddy: false } });
    start().set({ buddyNotch: false });
    assert.strictEqual(onDisk().config.buddy, true, 'written on, as it was read');
    const next = start().get();
    assert.strictEqual(next.buddy, true);
    assert.strictEqual(next.buddyNotch, false, 'the other change kept');
});

check('a version 3 file that says off is left off', () => {
    profile({ version: 3, config: { buddy: false } });
    assert.strictEqual(start().get().buddy, false);
});

check('where the notch was dragged is kept across a restart, and put back with null', () => {
    profile(null);
    assert.strictEqual(start().get().buddyNotchPlace, null, 'the top middle on a new install');
    start().set({ buddyNotchPlace: { display: '2528732444', x: 0.25, y: 0.75, dock: false } });
    assert.deepStrictEqual(start().get().buddyNotchPlace, { display: '2528732444', x: 0.25, y: 0.75, dock: false });
    // Docked, it is on the edge whatever y says; out of range is held to the display.
    start().set({ buddyNotchPlace: { display: 7, x: 1.4, y: 0.6, dock: 'top' } });
    assert.deepStrictEqual(start().get().buddyNotchPlace, { display: '7', x: 1, y: 0, dock: 'top' });
    // Saved before it docked to the sides, `true` was the top.
    start().set({ buddyNotchPlace: { display: '7', x: 0.4, y: 0.6, dock: true } });
    assert.deepStrictEqual(start().get().buddyNotchPlace, { display: '7', x: 0.4, y: 0, dock: 'top' });
    // On a side: on that side whatever x says.
    start().set({ buddyNotchPlace: { display: '7', x: 0.4, y: 0.3, dock: 'left' } });
    assert.deepStrictEqual(start().get().buddyNotchPlace, { display: '7', x: 0, y: 0.3, dock: 'left' });
    start().set({ buddyNotchPlace: { display: '7', x: 0.4, y: 0.8, dock: 'right' } });
    assert.deepStrictEqual(start().get().buddyNotchPlace, { display: '7', x: 1, y: 0.8, dock: 'right' });
    // An edge it does not dock to: floating where it was.
    start().set({ buddyNotchPlace: { display: '7', x: 0.4, y: 0.8, dock: 'bottom' } });
    assert.deepStrictEqual(start().get().buddyNotchPlace, { display: '7', x: 0.4, y: 0.8, dock: false });
    // Not a place: the top middle.
    start().set({ buddyNotchPlace: { x: 'left', y: 0 } });
    assert.strictEqual(start().get().buddyNotchPlace, null);
    start().set({ buddyNotchPlace: { display: '1', x: 0.5, y: 0.5, dock: false } });
    start().set({ buddyNotchPlace: null });
    assert.strictEqual(start().get().buddyNotchPlace, null, 'put back');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
