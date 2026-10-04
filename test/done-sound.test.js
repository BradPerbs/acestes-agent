/**
 * The sound a finished task makes.
 *
 * The list of sounds lives twice: in the renderer, which draws them, and in
 * main's settings, which validates what is stored. Checked here that the two
 * agree, that every listed sound has a label, and that the store keeps a
 * good choice, refuses a bad one and clamps the volume.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', 'src');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-done-sound-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const settings = require(path.join(ROOT, 'main', 'ai', 'settings'));

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

async function main() {
    const sounds = await import(pathToFileURL(path.join(ROOT, 'renderer', 'lib', 'sounds.js')).href);
    const en = (await import(pathToFileURL(path.join(ROOT, 'renderer', 'i18n', 'locales', 'en.js')).href)).default;
    const { sanitize } = settings._test;

    console.log('\ndone sound');

    check('main and the renderer list the same sounds', () => {
        assert.deepStrictEqual([...settings.DONE_SOUNDS], sounds.SOUND_IDS);
    });

    check('every listed sound can be drawn and has a label', () => {
        for (const id of sounds.SOUND_IDS) {
            assert.ok(sounds.isSound(id), `${id} has no drawing`);
            assert.ok(en[`settings.chat.sound.${id}`], `${id} has no label`);
        }
    });

    check('every group has a heading and no sound is listed twice', () => {
        for (const group of sounds.SOUND_GROUPS) {
            assert.ok(en[`settings.chat.soundGroup.${group.id}`], `${group.id} has no heading`);
        }
        assert.strictEqual(new Set(sounds.SOUND_IDS).size, sounds.SOUND_IDS.length);
    });

    check('the default is the chime at 70', () => {
        const clean = sanitize(null);
        assert.strictEqual(clean.doneSound, 'chime');
        assert.strictEqual(clean.doneSoundVolume, 70);
        assert.strictEqual(sounds.DEFAULT_SOUND, clean.doneSound);
        assert.strictEqual(sounds.DEFAULT_VOLUME, clean.doneSoundVolume);
    });

    check('a listed sound is kept, an unknown one is refused', () => {
        assert.strictEqual(sanitize({ doneSound: 'sadtrombone' }).doneSound, 'sadtrombone');
        assert.strictEqual(sanitize({ doneSound: 'off' }).doneSound, 'off');
        assert.strictEqual(sanitize({ doneSound: '../../evil.wav' }).doneSound, 'chime');
    });

    check('the volume is clamped to 0-100', () => {
        assert.strictEqual(sanitize({ doneSoundVolume: 250 }).doneSoundVolume, 100);
        assert.strictEqual(sanitize({ doneSoundVolume: -5 }).doneSoundVolume, 0);
        assert.strictEqual(sanitize({ doneSoundVolume: 'loud' }).doneSoundVolume, 70);
    });

    check('playing without Web Audio does not throw', () => {
        sounds.playSound('airhorn', 50);
        sounds.playChime();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
