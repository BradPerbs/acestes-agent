const { app } = require('electron');
const path = require('path');

/**
 * Sentence embeddings, computed on this machine.
 *
 * The memory store searches by meaning, and that needs a vector per note.
 * They are made here with a small sentence encoder run through ONNX in this
 * process: no API key, no network after the first run, and a note never
 * leaves the machine to be indexed. The model is fetched once, to userData,
 * and read from there afterwards.
 *
 * MiniLM is the choice mem0 and most local setups make for the same job:
 * 384 dimensions, a few milliseconds a sentence, good enough to tell "where
 * is the web server config" from "the user prefers vim". A bigger model can
 * be swapped in by changing MODEL; the index is rebuilt when the name does
 * not match what it was built with.
 */

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;

/** How long a failed load is remembered before it is tried again. */
const RETRY_AFTER = 60 * 1000;

let loading = null;
let failedAt = 0;
let failure = '';

function load() {
    if (loading) return loading;
    if (failedAt && Date.now() - failedAt < RETRY_AFTER) {
        return Promise.reject(new Error(failure || 'The embedding model is not available'));
    }

    loading = (async () => {
        // Required rather than imported: the package ships a CommonJS build
        // for Node, and a require resolves inside an asar archive where a
        // dynamic import may not.
        const { pipeline, env } = require('@huggingface/transformers');
        env.cacheDir = path.join(app.getPath('userData'), 'models');
        env.allowLocalModels = true;
        return pipeline('feature-extraction', MODEL, { dtype: 'q8' });
    })().catch((error) => {
        loading = null;
        failedAt = Date.now();
        failure = error.message;
        throw error;
    });

    return loading;
}

/** One unit-length vector per text, in order. Rejects if the model cannot load. */
async function embed(texts) {
    const extractor = await load();
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    return output.tolist().map(row => Float32Array.from(row));
}

/** Whether the model has loaded, so a page can say why search is by words only. */
function status() {
    return { model: MODEL, dims: DIMS, loading: Boolean(loading), failure };
}

module.exports = { MODEL, DIMS, embed, load, status };
