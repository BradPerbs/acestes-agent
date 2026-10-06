/**
 * The memory's sentence encoder, in a process of its own (see embeddings.js
 * for why it is not in the main one).
 *
 * Requests are embedded a chunk at a time, and between chunks the queue is
 * looked at again: a request of a text or two is a search someone is waiting
 * on (the notes for a message about to be sent), so it goes ahead of a long
 * one, which is indexing that nobody is. A search therefore waits for the
 * chunk under way (tens of milliseconds), never for a whole notebook.
 *
 * Vectors go back as plain arrays of numbers, which every channel carries.
 *
 * Started by embeddings.js as an Electron utility process (parentPort) or, in
 * the tests, a plain child process (process.send).
 */

/** Texts embedded at a time: roughly a tenth of a second of a long notebook. */
const CHUNK = 16;
/** A request this small is a search waiting on its answer. */
const SMALL = 2;

const port = process.parentPort || null;

function post(message) {
    if (port) port.postMessage(message);
    else if (process.send) process.send(message);
}

let loading = null;
let extractor = null;
const queue = [];
let draining = false;

function load({ model, cacheDir }) {
    if (loading) return;
    loading = (async () => {
        // Required here, not at the top: it is the slow part of starting, and
        // a process told to load something it cannot should still answer.
        const { pipeline, env } = require('@huggingface/transformers');
        if (cacheDir) env.cacheDir = cacheDir;
        env.allowLocalModels = true;
        extractor = await pipeline('feature-extraction', model, { dtype: 'q8' });
    })();
    loading.then(
        () => post({ type: 'loaded' }),
        error => post({ type: 'load-failed', error: error?.message || String(error) }),
    );
}

/** The request to work on next: a waiting search first, otherwise the oldest. */
function next() {
    return queue.find(job => job.texts.length <= SMALL) || queue[0];
}

function finish(job, message) {
    queue.splice(queue.indexOf(job), 1);
    post({ id: job.id, ...message });
}

async function drain() {
    if (draining) return;
    draining = true;
    try {
        try {
            if (!loading) throw new Error('The embedding model was not asked to load');
            await loading;
        } catch (error) {
            for (const job of queue.splice(0)) post({ type: 'failed', id: job.id, error: error?.message || String(error) });
            return;
        }
        while (queue.length > 0) {
            const job = next();
            const part = job.texts.slice(job.done, job.done + CHUNK);
            try {
                const output = await extractor(part, { pooling: 'mean', normalize: true });
                job.vectors.push(...output.tolist());
                job.done += part.length;
            } catch (error) {
                finish(job, { type: 'failed', error: error?.message || String(error) });
                continue;
            }
            if (job.done >= job.texts.length) finish(job, { type: 'vectors', vectors: job.vectors });
            // ONNX Runtime holds this thread for the whole of a run, so this
            // is where requests sent meanwhile are let in, before the next chunk.
            await new Promise(resolve => setImmediate(resolve));
        }
    } finally {
        draining = false;
    }
}

function receive(message) {
    if (message?.type === 'load') load(message);
    else if (message?.type === 'embed') {
        const texts = Array.isArray(message.texts) ? message.texts.map(String) : [];
        if (texts.length === 0) {
            post({ type: 'vectors', id: message.id, vectors: [] });
            return;
        }
        queue.push({ id: message.id, texts, done: 0, vectors: [] });
        drain();
    }
}

if (port) port.on('message', event => receive(event.data));
else process.on('message', receive);
