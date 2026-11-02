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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
