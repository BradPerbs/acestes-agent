/**
 * The memory's encoder, out of the main process: embeddings.js talking to a
 * fake process (loads once, answers in order, a model that will not load or
 * a process that dies fails what waits rather than hanging it), and the real
 * embeddings-worker.js run as a child with a fake model that holds its thread
 * the way ONNX Runtime does, to show a search is answered before indexing
 * that was asked for first.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { fork } = require('child_process');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-embeddings-'));

const electronStub = { app: { getPath: () => userData } };
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const embeddings = require(path.join(ROOT, 'ai', 'embeddings'));

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

/** A stand-in for the process: records what it is sent and answers like the worker. */
function fakeWorker({ loadFails = false, hold = false } = {}) {
    const worker = { sent: [], listeners: [], exits: [], killed: false, hold };
    const emit = message => worker.listeners.forEach(fn => fn(message));
    worker.handle = {
        send: (message) => {
            worker.sent.push(message);
            setTimeout(() => {
                if (message.type === 'load') emit(loadFails ? { type: 'load-failed', error: 'no model here' } : { type: 'loaded' });
                else if (message.type === 'embed' && !worker.hold) {
                    emit({ type: 'vectors', id: message.id, vectors: message.texts.map(text => [text.length, 0, 0]) });
                }
            }, 5);
        },
        onMessage: fn => worker.listeners.push(fn),
        onExit: fn => worker.exits.push(fn),
        kill: () => { worker.killed = true; },
    };
    return worker;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

(async () => {
    await check('vectors come back in order, as Float32Arrays, and the model is loaded once', async () => {
        embeddings._test.reset();
        let spawned = 0;
        const worker = fakeWorker();
        embeddings._test.useSpawn(() => { spawned += 1; return worker.handle; });

        assert.strictEqual(embeddings.isReady(), false);
        const vectors = await embeddings.embed(['ab', 'abcd']);
        assert.ok(vectors.every(vector => vector instanceof Float32Array));
        assert.deepStrictEqual(vectors.map(vector => vector[0]), [2, 4]);
        assert.strictEqual(embeddings.isReady(), true);
        assert.strictEqual(embeddings.status().loading, false);

        embeddings.warm();
        await embeddings.embed(['x']);
        assert.strictEqual(spawned, 1, 'one process');
        assert.strictEqual(worker.sent.filter(message => message.type === 'load').length, 1, 'loaded once');
        const load = worker.sent.find(message => message.type === 'load');
        assert.strictEqual(load.cacheDir, path.join(userData, 'models'));
    });

    await check('nothing to embed starts nothing', async () => {
        embeddings._test.reset();
        let spawned = 0;
        embeddings._test.useSpawn(() => { spawned += 1; return fakeWorker().handle; });
        assert.deepStrictEqual(await embeddings.embed([]), []);
        assert.strictEqual(spawned, 0);
    });

    await check('a model that will not load is reported, and not tried again straight away', async () => {
        embeddings._test.reset();
        let spawned = 0;
        const worker = fakeWorker({ loadFails: true });
        embeddings._test.useSpawn(() => { spawned += 1; return worker.handle; });

        await assert.rejects(embeddings.embed(['a']), /no model here/);
        assert.strictEqual(embeddings.isReady(), false);
        assert.strictEqual(embeddings.status().failure, 'no model here');
        assert.ok(worker.killed, 'the process is let go');

        embeddings.warm();
        await assert.rejects(embeddings.embed(['a']), /no model here/);
        assert.strictEqual(spawned, 1, 'no second process inside the retry window');
    });

    await check('a process that dies fails what was waiting on it instead of hanging it', async () => {
        embeddings._test.reset();
        const worker = fakeWorker({ hold: true });
        embeddings._test.useSpawn(() => worker.handle);

        const waiting = embeddings.embed(['a', 'b']);
        await tick();
        assert.ok(worker.sent.some(message => message.type === 'embed'), 'the request went out');
        worker.exits.forEach(fn => fn(1));
        await assert.rejects(waiting, /stopped/);
        assert.strictEqual(embeddings.isReady(), false);
        await assert.rejects(embeddings.embed(['c']), /stopped/);
    });

    await check('the worker answers a search before indexing that was asked for first', async () => {
        // A model that holds the thread for the whole of a run, as ONNX
        // Runtime does: 15 ms a text, so 64 texts are about a second.
        const preload = path.join(userData, 'fake-transformers.js');
        fs.writeFileSync(preload, `
const Module = require('module');
const real = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@huggingface/transformers') {
        return {
            env: {},
            pipeline: async () => async (texts) => {
                const until = Date.now() + 15 * texts.length;
                while (Date.now() < until) { /* busy, like a model run */ }
                return { tolist: () => texts.map(text => [text.length, 1, 0]) };
            },
        };
    }
    return real.call(this, request, ...rest);
};
`);
        const child = fork(path.join(ROOT, 'ai', 'embeddings-worker.js'), [], { execArgv: ['--require', preload], stdio: 'ignore' });
        try {
            const answers = [];
            const started = {};
            const done = new Promise((resolve, reject) => {
                child.on('message', (message) => {
                    if (message.type === 'loaded') return;
                    answers.push({ ...message, after: Date.now() - started[message.id] });
                    if (answers.length === 2) resolve();
                });
                child.on('exit', code => reject(new Error(`worker exited ${code}`)));
            });
            const loaded = new Promise(resolve => child.once('message', resolve));
            child.send({ type: 'load', model: 'fake', cacheDir: userData });
            assert.strictEqual((await loaded).type, 'loaded');

            const bulk = Array.from({ length: 64 }, (_, index) => 'n'.repeat(index + 1));
            started[1] = Date.now();
            child.send({ type: 'embed', id: 1, texts: bulk });
            await new Promise(resolve => setTimeout(resolve, 60));
            started[2] = Date.now();
            child.send({ type: 'embed', id: 2, texts: ['where is the nginx config'] });
            await done;

            assert.deepStrictEqual(answers.map(answer => answer.id), [2, 1], 'the search first');
            assert.ok(answers[0].after < 600, `the search waited ${answers[0].after} ms, more than a chunk`);
            assert.deepStrictEqual(answers[0].vectors, [[25, 1, 0]]);
            assert.deepStrictEqual(answers[1].vectors.map(vector => vector[0]), bulk.map(text => text.length), 'indexing whole and in order');
        } finally {
            child.kill();
        }
    });

    console.log(`embeddings: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
    fs.rmSync(userData, { recursive: true, force: true });
    setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
})();
