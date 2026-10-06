const { app } = require('electron');
const path = require('path');

/**
 * Sentence embeddings, computed on this machine.
 *
 * The memory store searches by meaning, and that needs a vector per note.
 * They are made here with a small sentence encoder run through ONNX: no API
 * key, no network after the first run, and a note never leaves the machine
 * to be indexed. The model is fetched once, to userData, and read from there
 * afterwards.
 *
 * MiniLM is the choice mem0 and most local setups make for the same job:
 * 384 dimensions, a few milliseconds a sentence, good enough to tell "where
 * is the web server config" from "the user prefers vim". A bigger model can
 * be swapped in by changing MODEL; the index is rebuilt when the name does
 * not match what it was built with.
 *
 * The model runs in a process of its own (embeddings-worker.js). ONNX
 * Runtime's Node binding runs a model on the thread that calls it, start to
 * finish, so in the main process every embed froze it: the timer meant to
 * hold a message's memory search to a budget could not fire until the embed
 * it was timing had finished, and indexing a batch of notes held up terminal
 * output and the reply streaming in. Here the main process only posts texts
 * and waits for vectors, and the slow require of the library happens over
 * there too.
 */

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;

/** How long a failed load, or a process that died, is remembered before it is tried again. */
const RETRY_AFTER = 60 * 1000;

let worker = null;
let ready = false;
let failedAt = 0;
let failure = '';
let nextId = 1;
/** id -> { state, resolve, reject }, for each request the process has not answered. */
const waiting = new Map();
let spawnOverride = null;

function spawnWorker() {
    const script = path.join(__dirname, 'embeddings-worker.js');
    if (spawnOverride) return spawnOverride(script);
    const { utilityProcess } = require('electron');
    const child = utilityProcess.fork(script, [], { serviceName: 'Acestes memory', stdio: 'ignore' });
    return {
        send: message => child.postMessage(message),
        onMessage: fn => child.on('message', fn),
        onExit: fn => child.on('exit', fn),
        kill: () => child.kill(),
    };
}

/**
 * Give up on a process: what waits on it fails, and the next call starts
 * another once RETRY_AFTER has passed. Meanwhile search is by words.
 */
function drop(state, reason) {
    if (worker !== state) return;
    worker = null;
    ready = false;
    failedAt = Date.now();
    failure = reason;
    for (const [id, waiter] of waiting) {
        if (waiter.state !== state) continue;
        waiting.delete(id);
        waiter.reject(new Error(reason));
    }
    try { state.child?.kill(); } catch { /* already gone */ }
}

function answer(message) {
    const waiter = waiting.get(message.id);
    if (!waiter) return;
    waiting.delete(message.id);
    if (message.type === 'vectors') waiter.resolve(message.vectors || []);
    else waiter.reject(new Error(message.error || 'The embedding failed'));
}

/** The process with the model loaded, started if it is not. Rejects if the model cannot load. */
function load() {
    if (worker) return worker.loaded;
    if (failedAt && Date.now() - failedAt < RETRY_AFTER) {
        return Promise.reject(new Error(failure || 'The embedding model is not available'));
    }

    const state = { child: null, loaded: null };
    worker = state;
    state.loaded = new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnWorker();
        } catch (error) {
            drop(state, `The embedding process could not start: ${error.message}`);
            reject(new Error(failure));
            return;
        }
        state.child = child;
        child.onMessage((message) => {
            if (message?.type === 'loaded') {
                ready = true;
                failedAt = 0;
                failure = '';
                resolve();
            } else if (message?.type === 'load-failed') {
                drop(state, message.error || 'The embedding model could not be loaded');
                reject(new Error(failure));
            } else if (message?.type === 'vectors' || message?.type === 'failed') {
                answer(message);
            }
        });
        child.onExit(() => {
            drop(state, 'The embedding process stopped');
            reject(new Error('The embedding process stopped'));
        });
        child.send({ type: 'load', model: MODEL, cacheDir: path.join(app.getPath('userData'), 'models') });
    });
    // A load nobody waited on (warm) must not surface as an unhandled rejection.
    state.loaded.catch(() => {});
    return state.loaded;
}

/** Whether the model is loaded, so a caller in a hurry can tell an embed will be quick. */
function isReady() {
    return ready;
}

/**
 * Start the process and load the model, without waiting for either. Called
 * once the window is up, as the user starts typing, and by anything that
 * wanted the model and found it not loaded.
 */
function warm() {
    if (worker) return;
    if (failedAt && Date.now() - failedAt < RETRY_AFTER) return;
    load().catch(() => {});
}

/** One unit-length vector per text, in order. Rejects if the model cannot load. */
async function embed(texts) {
    const list = (texts || []).map(text => String(text ?? ''));
    if (list.length === 0) return [];
    await load();
    const state = worker;
    if (!state) throw new Error(failure || 'The embedding model is not available');
    const id = nextId;
    nextId += 1;
    const rows = await new Promise((resolve, reject) => {
        waiting.set(id, { state, resolve, reject });
        try {
            state.child.send({ type: 'embed', id, texts: list });
        } catch (error) {
            waiting.delete(id);
            reject(error);
        }
    });
    return rows.map(row => Float32Array.from(row));
}

/** Whether the model has loaded, so a page can say why search is by words only. */
function status() {
    return { model: MODEL, dims: DIMS, loading: Boolean(worker) && !ready, failure };
}

// Not with the window, as the speech workers go: jobs still run, and still
// remember, from the tray. Guarded because the tests stub `app` down.
if (typeof app?.on === 'function') {
    app.on('will-quit', () => {
        try { worker?.child?.kill(); } catch { /* already gone */ }
    });
}

module.exports = {
    MODEL,
    DIMS,
    embed,
    load,
    warm,
    isReady,
    status,
    _test: {
        useSpawn: (fn) => { spawnOverride = fn; },
        reset: () => {
            if (worker) drop(worker, 'reset');
            worker = null;
            ready = false;
            failedAt = 0;
            failure = '';
        },
    },
};
