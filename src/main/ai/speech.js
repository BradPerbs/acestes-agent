const { app } = require('electron');
const path = require('path');
const fasterWhisper = require('./faster-whisper');
const parakeet = require('./parakeet');

/**
 * Speech to text, on this machine: the composer's microphone.
 *
 * What is said becomes the message, to read over, edit and send. It is on
 * from the start (Settings, Voice input), with three engines to choose from,
 * all local: nothing said leaves the machine, and it works the same whichever
 * runtime answers, since what they receive is text.
 *
 *   parakeet         the default: NVIDIA's Parakeet through sherpa-onnx, in a
 *                    process of its own (see parakeet.js). Live: the words are
 *                    written down while the user talks, so stopping takes a
 *                    fraction of a second. 25 European languages, told apart
 *                    by itself; the model is 670 MB, fetched once.
 *   whisper          built in: run through ONNX (transformers.js) in this
 *                    process. Nothing to
 *                    install; the model is fetched once, to userData, on the
 *                    first use (76 MB for base), and the page is told how
 *                    far the download has got.
 *   faster-whisper   the CTranslate2 build, through Python (see
 *                    faster-whisper.js): several times quicker on a CPU,
 *                    bigger models in reach, and it detects the language.
 *
 * The two Whispers take a whole recording once it has stopped, through
 * transcribe(); Parakeet is streamed to, through parakeet.js's start, audio
 * and stop, which ipc wires up directly.
 *
 * The browser's own speech recognition is no use here: in Electron it has no
 * service behind it, since that needs a key only Chrome carries. The renderer
 * records and resamples to 16 kHz mono itself, so what arrives is samples.
 */

/** The built-in engine's models, by size. Past small it is too slow in ONNX on a CPU. */
const WHISPER_MODELS = {
    tiny: 'Xenova/whisper-tiny',
    base: 'Xenova/whisper-base',
    small: 'Xenova/whisper-small',
};
const RATE = 16000;

/** Whisper's name for each language code the user may pick or the app runs in. */
const LANGUAGES = {
    en: 'english', it: 'italian', es: 'spanish', fr: 'french', de: 'german', pt: 'portuguese', ru: 'russian',
    vi: 'vietnamese', zh: 'chinese', ja: 'japanese', ko: 'korean', nl: 'dutch', pl: 'polish', tr: 'turkish',
    ar: 'arabic', hi: 'hindi', id: 'indonesian', tl: 'tagalog', uk: 'ukrainian',
};

/**
 * What Whisper says to silence and noise, learned from the videos it was
 * trained on. A recording that yields only one of these said nothing.
 */
const HALLUCINATIONS = [
    /^\[.*\]$/,
    /^\(.*\)$/,
    /^thank(s| you)( (so much|very much))?( for watching)?[.!]*$/i,
    /^(please )?subscribe[.!]*$/i,
    /^you[.!]*$/i,
    /^\.+$/,
];

const RETRY_AFTER = 60 * 1000;

// The built-in engine's loaded model: one at a time.
let loaded = { id: '', pipeline: null };
let failedAt = 0;
let failure = '';
let tell = () => {};

/** Where progress goes (download, install, loading): set by ipc, to every window. */
function setNotifier(fn) {
    tell = typeof fn === 'function' ? fn : () => {};
    fasterWhisper.setNotifier(tell);
    parakeet.setNotifier(tell);
}

function whisperModel(size) {
    return WHISPER_MODELS[size] || WHISPER_MODELS.small;
}

function load(size = 'base') {
    const id = whisperModel(size);
    if (loaded.id === id && loaded.pipeline) return loaded.pipeline;
    if (failedAt && Date.now() - failedAt < RETRY_AFTER && loaded.id === id) {
        return Promise.reject(new Error(failure || 'The speech model is not available'));
    }

    // Progress by file, summed, so the bar is one number for the whole model.
    const files = new Map();
    let lastSent = -1;
    const progress = (info) => {
        if (!info?.file || !(info.total > 0)) return;
        files.set(info.file, { loaded: info.loaded || 0, total: info.total });
        let done = 0;
        let total = 0;
        for (const entry of files.values()) {
            done += entry.loaded;
            total += entry.total;
        }
        const percent = Math.floor((done / total) * 100);
        if (percent === lastSent) return;
        lastSent = percent;
        tell({ state: 'downloading', percent });
    };

    const pending = (async () => {
        const { pipeline, env } = require('@huggingface/transformers');
        env.cacheDir = path.join(app.getPath('userData'), 'models');
        env.allowLocalModels = true;
        const recognizer = await pipeline('automatic-speech-recognition', id, { dtype: 'q8', progress_callback: progress });
        tell({ state: 'ready' });
        return recognizer;
    })().catch((error) => {
        if (loaded.id === id) loaded = { id: '', pipeline: null };
        failedAt = Date.now();
        failure = error.message;
        tell({ state: 'failed', message: error.message });
        throw error;
    });
    loaded = { id, pipeline: pending };
    return pending;
}

/** Loud enough to hold words: the root mean square of the samples. */
function loudness(samples) {
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
    return Math.sqrt(sum / Math.max(1, samples.length));
}

/** What Whisper made of it, or nothing when that was only its answer to silence. */
function clean(text) {
    const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return '';
    return HALLUCINATIONS.some(pattern => pattern.test(trimmed)) ? '' : trimmed;
}

const code = value => String(value || '').toLowerCase().split('-')[0];

/**
 * The words in a recording of 16 kHz mono samples, by the engine and model
 * the settings name. The language is the one picked in Settings; failing
 * that, Faster-Whisper works it out, and the built-in engine, which would
 * otherwise assume English, takes the app's own. Empty when nothing was said.
 */
async function transcribe(input, { engine = 'whisper', model = 'base', language = '', appLanguage = '' } = {}) {
    const samples = input instanceof Float32Array ? input : Float32Array.from(input || []);
    // Under a quarter of a second, or quieter than a room, is not speech.
    if (samples.length < RATE / 4 || loudness(samples) < 0.004) return { text: '' };

    if (engine === 'faster-whisper') {
        const heard = await fasterWhisper.transcribe(samples, { model, language: code(language) });
        return { text: clean(heard.text), language: heard.language };
    }

    const recognizer = await load(model);
    const spoken = LANGUAGES[code(language)] || LANGUAGES[code(appLanguage)];
    const output = await recognizer(samples, {
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(spoken ? { language: spoken, task: 'transcribe' } : {}),
    });
    return { text: clean(output?.text) };
}

/** Whether each engine can be used, for the settings page. */
async function status({ fresh = false } = {}) {
    return {
        parakeet: parakeet.status(),
        whisper: { models: Object.keys(WHISPER_MODELS), failure },
        fasterWhisper: await fasterWhisper.status({ fresh }),
    };
}

module.exports = {
    RATE,
    WHISPER_MODELS,
    LANGUAGES,
    load,
    transcribe,
    status,
    install: () => fasterWhisper.install(),
    shutdown: () => {
        fasterWhisper.shutdown();
        parakeet.shutdown();
    },
    parakeet,
    setNotifier,
    _test: { clean, loudness },
};
