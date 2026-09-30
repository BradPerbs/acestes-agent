/**
 * Voice input without a model: what counts as nothing said, the WAV the
 * Faster-Whisper worker is handed, the worker's own script, and the settings
 * that switch it all on. The engines themselves need their models, so they
 * are left to a run of the app.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-speech-'));

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

const speech = require(path.join(ROOT, 'ai', 'speech'));
const fasterWhisper = require(path.join(ROOT, 'ai', 'faster-whisper'));
const settings = require(path.join(ROOT, 'ai', 'settings'));
const parakeet = require(path.join(ROOT, 'ai', 'parakeet'));

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
    console.log('\nwhat was said');

    await check('Whisper\'s answers to silence count as nothing said', () => {
        for (const noise of ['[BLANK_AUDIO]', '(music)', 'Thank you.', 'Thanks for watching!', 'you', '...', '  ']) {
            assert.strictEqual(speech._test.clean(noise), '', noise);
        }
        assert.strictEqual(speech._test.clean('  Open   Notepad, please. '), 'Open Notepad, please.');
        assert.strictEqual(speech._test.clean('Thank you for the report on web-01'), 'Thank you for the report on web-01');
    });

    await check('silence and a click are not sent to any engine', async () => {
        assert.deepStrictEqual(await speech.transcribe(new Float32Array(16000 * 3)), { text: '' });
        const blip = new Float32Array(2000).fill(0.5);
        assert.deepStrictEqual(await speech.transcribe(blip), { text: '' });
        assert.ok(speech._test.loudness(new Float32Array(100).fill(0.5)) > 0.49);
    });

    console.log('\nfaster-whisper');

    await check('the samples go to the worker as a 16 kHz mono 16-bit WAV', () => {
        const wav = fasterWhisper._test.toWav(new Float32Array([0, 1, -1, 0.5]));
        assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
        assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
        assert.strictEqual(wav.readUInt16LE(22), 1, 'mono');
        assert.strictEqual(wav.readUInt32LE(24), 16000, '16 kHz');
        assert.strictEqual(wav.readUInt16LE(34), 16, '16-bit');
        assert.strictEqual(wav.readUInt32LE(40), 8, 'four samples');
        assert.deepStrictEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [0, 32767, -32768]);
    });

    await check('the worker reads the WAV itself, and falls back to the CPU when CUDA is missing', () => {
        const script = fasterWhisper._test.WORKER;
        assert.ok(script.includes('wave.open(path, "rb")'), 'not through PyAV, which breaks between versions');
        assert.ok(/cublas.*cudnn.*cuda/.test(script) && script.includes('cpu_only = True'));
        assert.ok(script.includes('vad_filter=True'), 'silence is cut before it is heard');
    });

    console.log('\nparakeet, live');

    // A stand-in for speech-worker.js: loads when asked, answers each end
    // with the number of chunks it was given, and keeps what it was sent.
    function fakeWorker({ loadFails = false } = {}) {
        const worker = { sent: [], listeners: [], exits: [], killed: false };
        worker.emit = message => setImmediate(() => worker.listeners.forEach(fn => fn(message)));
        worker.handle = {
            send: (message) => {
                worker.sent.push(message);
                if (message.type === 'load') worker.emit(loadFails ? { type: 'load-failed', error: 'no model' } : { type: 'loaded' });
                if (message.type === 'end') {
                    const chunks = worker.sent.filter(entry => entry.type === 'audio' && entry.id === message.id).length;
                    worker.emit({ type: 'update', id: message.id, text: 'so far' });
                    worker.emit({ type: 'done', id: message.id, text: `${chunks} chunks` });
                }
            },
            onMessage: fn => worker.listeners.push(fn),
            onExit: fn => worker.exits.push(fn),
            kill: () => { worker.killed = true; },
        };
        return worker;
    }
    const tick = () => new Promise(resolve => setTimeout(resolve, 20));
    parakeet._test.assumeInstalled(true);

    await check('audio said while the model loads is held, then passed on in order', async () => {
        const worker = fakeWorker();
        parakeet._test.useSpawn(() => worker.handle);
        const updates = [];
        const { id } = parakeet.start({ onUpdate: update => updates.push(update) });
        parakeet.audio(id, new Float32Array([0.1]));
        parakeet.audio(id, new Float32Array([0.2]));
        await tick();
        parakeet.audio(id, new Float32Array([0.3]));
        const result = await parakeet.stop(id);
        assert.deepStrictEqual(result, { text: '3 chunks' });
        assert.deepStrictEqual(updates.map(update => update.text), ['so far']);
        const order = worker.sent.filter(entry => entry.id === id).map(entry => (entry.type === 'audio' ? entry.samples[0] : entry.type));
        assert.deepStrictEqual(order.map(value => (typeof value === 'number' ? Number(value.toFixed(1)) : value)), ['begin', 0.1, 0.2, 0.3, 'end']);
        assert.strictEqual(worker.sent.filter(entry => entry.type === 'load').length, 1, 'loaded once');
        parakeet.shutdown();
    });

    await check('stopping before the model has loaded still gets every word', async () => {
        const worker = fakeWorker();
        parakeet._test.useSpawn(() => worker.handle);
        const { id } = parakeet.start({});
        parakeet.audio(id, new Float32Array([0.5]));
        const result = await parakeet.stop(id);
        assert.deepStrictEqual(result, { text: '1 chunks' });
        parakeet.shutdown();
    });

    await check('a thrown-away recording goes no further, and a dead worker fails what was under way', async () => {
        const worker = fakeWorker();
        parakeet._test.useSpawn(() => worker.handle);
        const first = parakeet.start({});
        await tick();
        parakeet.cancel(first.id);
        parakeet.audio(first.id, new Float32Array([0.5]));
        assert.ok(worker.sent.some(entry => entry.type === 'cancel' && entry.id === first.id));
        assert.ok(!worker.sent.some(entry => entry.type === 'audio' && entry.id === first.id), 'nothing after cancel');

        const updates = [];
        const second = parakeet.start({ onUpdate: update => updates.push(update) });
        await tick();
        const stopping = parakeet.stop(second.id);
        worker.listeners.length = 0; // the worker says nothing more...
        worker.exits.forEach(fn => fn(1)); // ...and dies
        const result = await stopping;
        assert.strictEqual(result.text, '');
        assert.match(result.error, /stopped/);
        parakeet.shutdown();
    });

    await check('a model that will not load is reported, not waited on', async () => {
        parakeet._test.useSpawn(() => fakeWorker({ loadFails: true }).handle);
        const updates = [];
        const { id } = parakeet.start({ onUpdate: update => updates.push(update) });
        const result = await parakeet.stop(id);
        assert.strictEqual(result.text, '');
        assert.match(result.error, /no model/);
        parakeet.shutdown();
    });

    console.log('\nsettings');

    await check('voice input is on from the start with Parakeet, and its choices are checked', () => {
        const before = settings.get();
        assert.strictEqual(before.voiceInput, true);
        assert.strictEqual(before.voiceEngine, 'parakeet');
        assert.strictEqual(settings.set({ voiceInput: false }).voiceInput, false, 'and can be switched off');
        const after = settings.set({ voiceInput: true, voiceEngine: 'faster-whisper', voiceModel: 'large-v3', voiceLanguage: 'it' });
        assert.deepStrictEqual(
            [after.voiceInput, after.voiceEngine, after.voiceModel, after.voiceLanguage],
            [true, 'faster-whisper', 'large-v3', 'it'],
        );
        const refused = settings.set({ voiceEngine: 'cloud', voiceModel: 'huge', voiceLanguage: 'klingon' });
        assert.deepStrictEqual([refused.voiceEngine, refused.voiceModel, refused.voiceLanguage], ['parakeet', 'base', ''], 'nonsense falls back to the defaults');
        assert.strictEqual(refused.voiceInput, true, 'and leaves the switch alone');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
