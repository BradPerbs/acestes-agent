const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * Parakeet: live dictation, written down while the user is still talking.
 *
 * NVIDIA's Parakeet TDT 0.6B v3 in sherpa-onnx's int8 build: as accurate as
 * Whisper's large model, several times quicker than Whisper's base on a CPU,
 * with punctuation and capitals of its own, in 25 European languages it
 * tells apart by itself. The work is done in speech-worker.js, a process of
 * its own; this side fetches the model, starts and stops that process, and
 * carries each recording's audio to it and its words back.
 *
 * The model is fetched once, on the first use or from Settings, into
 * userData (about 670 MB), pinned to one revision and checked by size, and
 * a download cut short picks up where it stopped. The process is started on
 * the first recording and let go of after a while unused, since the model
 * holds most of a gigabyte while loaded.
 */

const REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
const REVISION = '2bda32ec70b097a55adaa07d9a7173915b43cc78';
const FOLDER = 'parakeet-tdt-0.6b-v3-int8';
const FILES = [
    { name: 'tokens.txt', size: 93939 },
    { name: 'decoder.int8.onnx', size: 11845275 },
    { name: 'joiner.int8.onnx', size: 6355277 },
    { name: 'encoder.int8.onnx', size: 652184281 },
    {
        name: 'silero_vad.onnx',
        size: 643854,
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    },
];
const TOTAL = FILES.reduce((sum, file) => sum + file.size, 0);

/** Let go of the model after this long without a recording. */
const IDLE = 10 * 60 * 1000;
/** Loading takes a few seconds; a stuck one is given up on. */
const LOAD_TIMEOUT = 60 * 1000;
/** From stop to the last words: the last piece, and at worst a long one. */
const END_TIMEOUT = 60 * 1000;

let tell = () => {};
let folderOverride = null;
let spawnOverride = null;
let assumeInstalled = false;
let worker = null;
let downloading = null;
let idleTimer = null;
let seq = 0;
const sessions = new Map();

function setNotifier(fn) {
    tell = typeof fn === 'function' ? fn : () => {};
}

function folder() {
    return folderOverride || path.join(app.getPath('userData'), 'models', FOLDER);
}

function fileUrl(file) {
    return file.url || `https://huggingface.co/${REPO}/resolve/${REVISION}/${file.name}`;
}

/** Every file there, at the size it should be. */
function installed() {
    if (assumeInstalled) return true;
    return FILES.every((file) => {
        try {
            return fs.statSync(path.join(folder(), file.name)).size === file.size;
        } catch {
            return false;
        }
    });
}

function onDisk(name) {
    try {
        return fs.statSync(path.join(folder(), name)).size;
    } catch {
        return 0;
    }
}

/** One file, into `<name>.part` first, resumed from what is there. */
async function fetchFile(file, progress) {
    const target = path.join(folder(), file.name);
    const partial = `${target}.part`;
    let have = onDisk(`${file.name}.part`);
    if (have > file.size) {
        fs.rmSync(partial, { force: true });
        have = 0;
    }
    if (have < file.size) {
        const response = await fetch(fileUrl(file), { headers: have ? { Range: `bytes=${have}-` } : {} });
        if (!response.ok) throw new Error(`The speech model could not be downloaded (${response.status}).`);
        // A server that ignores the range sends it all again.
        if (have && response.status !== 206) have = 0;
        const out = fs.createWriteStream(partial, { flags: have ? 'a' : 'w' });
        try {
            const reader = response.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!out.write(Buffer.from(value))) await new Promise(resolve => out.once('drain', resolve));
                have += value.length;
                progress(have);
            }
        } finally {
            await new Promise(resolve => out.end(resolve));
        }
    }
    if (onDisk(`${file.name}.part`) !== file.size) {
        fs.rmSync(partial, { force: true });
        throw new Error(`The speech model came down damaged (${file.name}). Try again.`);
    }
    fs.renameSync(partial, target);
}

/** The model on disk, fetched if it is not, with the percentage told as it goes. */
function download() {
    if (installed()) return Promise.resolve();
    if (downloading) return downloading;
    downloading = (async () => {
        fs.mkdirSync(folder(), { recursive: true });
        let lastSent = -1;
        let done = 0;
        for (const file of FILES) {
            if (onDisk(file.name) === file.size) {
                done += file.size;
                continue;
            }
            const before = done;
            await fetchFile(file, (have) => {
                const percent = Math.floor(((before + have) / TOTAL) * 100);
                if (percent === lastSent) return;
                lastSent = percent;
                tell({ state: 'downloading', percent });
            });
            done += file.size;
        }
        tell({ state: 'downloaded' });
    })().finally(() => {
        downloading = null;
    });
    downloading.catch(error => tell({ state: 'failed', message: error.message }));
    return downloading;
}

function spawnWorker() {
    const script = path.join(__dirname, 'speech-worker.js');
    if (spawnOverride) return spawnOverride(script);
    const { utilityProcess } = require('electron');
    const child = utilityProcess.fork(script, [], { serviceName: 'Acestes speech', stdio: 'ignore' });
    return {
        send: message => child.postMessage(message),
        onMessage: fn => child.on('message', fn),
        onExit: fn => child.on('exit', fn),
        kill: () => child.kill(),
    };
}

function forget() {
    if (worker?.process) {
        try { worker.process.kill(); } catch { /* already gone */ }
    }
    worker = null;
}

function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        if (!sessions.size) forget();
    }, IDLE);
    idleTimer.unref?.();
}

function fail(session, error) {
    sessions.delete(session.id);
    session.finish?.({ text: '', error });
    session.onUpdate?.({ id: session.id, error });
}

/** The process with the model loaded: started, and the model fetched, if need be. */
function ready() {
    if (worker) return worker.loaded;
    const state = { process: null, loaded: null };
    worker = state;
    state.loaded = (async () => {
        await download();
        const child = spawnWorker();
        state.process = child;
        child.onMessage((message) => {
            const session = sessions.get(message?.id);
            if (message?.type === 'update' && session) session.onUpdate?.({ id: session.id, text: message.text });
            else if (message?.type === 'done' && session) {
                sessions.delete(session.id);
                session.finish?.({ text: String(message.text || ''), ...(message.error ? { error: message.error } : {}) });
            } else if (message?.type === 'failed' && session) fail(session, message.error);
            else if (message?.type === 'loaded' || message?.type === 'load-failed') state.onLoad?.(message);
        });
        child.onExit(() => {
            if (worker === state) worker = null;
            state.onLoad?.({ type: 'load-failed', error: 'The speech process stopped.' });
            for (const session of [...sessions.values()]) {
                if (session.worker === state) fail(session, 'The speech process stopped.');
            }
        });
        const dir = folder();
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('The speech model took too long to load.')), LOAD_TIMEOUT);
            state.onLoad = (message) => {
                clearTimeout(timer);
                state.onLoad = null;
                if (message.type === 'loaded') resolve();
                else reject(new Error(message.error || 'The speech model could not be loaded.'));
            };
            tell({ state: 'loading' });
            child.send({
                type: 'load',
                model: {
                    encoder: path.join(dir, 'encoder.int8.onnx'),
                    decoder: path.join(dir, 'decoder.int8.onnx'),
                    joiner: path.join(dir, 'joiner.int8.onnx'),
                    tokens: path.join(dir, 'tokens.txt'),
                },
                vad: path.join(dir, 'silero_vad.onnx'),
            });
        });
        tell({ state: 'ready' });
    })().catch((error) => {
        if (worker === state) forget();
        throw error;
    });
    return state.loaded;
}

/**
 * A recording begins. Audio sent before the model is loaded (the first use,
 * or after a long rest) is held and passed on once it is, so nothing said
 * while it loads is lost. `onUpdate` hears the words so far as they come.
 */
function start({ onUpdate } = {}) {
    seq += 1;
    const id = `d${Date.now().toString(36)}${seq}`;
    const session = { id, onUpdate, held: [], worker: null, finish: null, ended: false };
    sessions.set(id, session);
    clearTimeout(idleTimer);
    ready().then(() => {
        if (!sessions.has(id)) return;
        session.worker = worker;
        worker.process.send({ type: 'begin', id });
        for (const samples of session.held) worker.process.send({ type: 'audio', id, samples });
        session.held = [];
        if (session.ended) worker.process.send({ type: 'end', id });
    }).catch(error => fail(session, error.message));
    return { id };
}

function audio(id, samples) {
    const session = sessions.get(id);
    if (!session || session.ended) return;
    const chunk = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    if (session.worker) session.worker.process.send({ type: 'audio', id, samples: chunk });
    else session.held.push(chunk);
}

/** The recording ends: the words, once the last of them is written down. */
function stop(id) {
    const session = sessions.get(id);
    if (!session) return Promise.resolve({ text: '', error: 'That recording is no longer going.' });
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            sessions.delete(id);
            resolve({ text: '', error: 'The speech model did not finish in time.' });
        }, END_TIMEOUT);
        session.finish = (result) => {
            clearTimeout(timer);
            touch();
            resolve(result);
        };
        session.ended = true;
        if (session.worker) session.worker.process.send({ type: 'end', id });
    });
}

function cancel(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    if (session.worker) session.worker.process.send({ type: 'cancel', id });
    touch();
}

function status() {
    return { installed: installed(), size: TOTAL, downloading: Boolean(downloading) };
}

function shutdown() {
    clearTimeout(idleTimer);
    for (const session of [...sessions.values()]) fail(session, 'The app is closing.');
    forget();
}

module.exports = {
    FILES,
    TOTAL,
    status,
    download,
    start,
    audio,
    stop,
    cancel,
    setNotifier,
    shutdown,
    _test: {
        useFolder: (value) => { folderOverride = value; },
        useSpawn: (fn) => { spawnOverride = fn; },
        assumeInstalled: (value) => { assumeInstalled = Boolean(value); },
        installed,
    },
};
