/**
 * The live dictation worker: one speech model, through sherpa-onnx, in a
 * process of its own. The load message says which way it works.
 *
 * Its own process for two reasons. sherpa-onnx carries its own ONNX Runtime,
 * and the main process may already have another loaded for whisper; on
 * Windows the second DLL of that name would be handed the first. And a model
 * this size is better away from the process that draws
 * every window.
 *
 *   pieces      Parakeet (NVIDIA's TDT 0.6B v3), which is not a streaming
 *               model, with a voice activity detector. Audio arrives while
 *               the user talks; the detector cuts it where they pause, and
 *               each piece is written down there and then, so the words keep
 *               up with the voice and stopping leaves only the last few
 *               seconds to do. Between pauses the piece so far is written
 *               down every so often too, as a draft the next pass replaces.
 *               Everything decodes in order, one at a time.
 *   streaming   Nemotron 3.5 (NVIDIA's streaming 0.6B), which is. Each chunk
 *               of audio is fed in as it comes and decoded as soon as the
 *               model has enough for its next step; the words so far grow as
 *               they are heard, carrying what came before. A pause long
 *               enough to end a sentence closes it, and the next starts
 *               fresh. The language is pinned per recording when asked.
 *
 * Started by live-speech.js as an Electron utility process (parentPort) or,
 * in the tests, a plain child process (process.send).
 */
const os = require('os');

const RATE = 16000;
/** Silero's window: what the detector takes at a time. */
const WINDOW = 512;
/** How often the piece being spoken is written down as a draft. */
const DRAFT_EVERY = 450;
/** A draft covers the end of the piece so far, not all of a long one. */
const DRAFT_SECONDS = 12;
/** Seconds of what came before a piece and after it, kept with it. */
const LEAD_IN = 1;
const TRAIL = 0.3;

/** Silence fed in after the last word, so the streaming model's last step has it whole. */
const STREAM_TAIL = 0.8;

let recognizer = null;
let sherpa = null;
let vadConfig = null;
// 'pieces' or 'streaming', from the load message; and the streaming model.
let mode = 'pieces';
let online = null;
const sessions = new Map();

const port = process.parentPort || null;
function post(message) {
    if (port) port.postMessage(message);
    else if (process.send) process.send(message);
}

/**
 * The streaming model. Its features are 128-wide, not Parakeet's 80. An
 * endpoint is a second of quiet after speech, or two and a half before any,
 * or half a minute without one: what closes a sentence.
 */
function loadStreaming({ model, threads }) {
    sherpa = sherpa || require('sherpa-onnx-node');
    // Three at most: it decodes in small steps, and on a laptop's mix of fast
    // and slow cores a fourth thread made each step wait on a slow one
    // (measured on a Core Ultra 9 185H: never better, sometimes several times worse).
    const numThreads = threads || Math.max(1, Math.min(3, os.cpus().length - 1));
    online = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: RATE, featureDim: 128 },
        modelConfig: {
            transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
            tokens: model.tokens,
            numThreads,
            provider: 'cpu',
            debug: 0,
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.0,
        rule3MinUtteranceLength: 30,
    });
}

async function load(message) {
    mode = message.kind === 'streaming' ? 'streaming' : 'pieces';
    if (mode === 'streaming') {
        loadStreaming(message);
        return;
    }
    const { model, vad, threads } = message;
    sherpa = sherpa || require('sherpa-onnx-node');
    const numThreads = threads || Math.max(1, Math.min(4, os.cpus().length - 1));
    recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: RATE, featureDim: 80 },
        modelConfig: {
            transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
            tokens: model.tokens,
            numThreads,
            provider: 'cpu',
            debug: 0,
            modelType: 'nemo_transducer',
        },
    });
    vadConfig = {
        sileroVad: {
            model: vad,
            threshold: 0.5,
            // A breath is not a pause; half a second is.
            minSilenceDuration: 0.5,
            minSpeechDuration: 0.25,
            // Long runs without a pause are cut anyway, so no piece is huge.
            maxSpeechDuration: 15,
            windowSize: WINDOW,
        },
        sampleRate: RATE,
        debug: false,
        numThreads: 1,
    };
}

function joined(pieces) {
    return pieces.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

async function decode(samples) {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: RATE, samples });
    const result = await recognizer.decodeAsync(stream);
    return String(result?.text || '').trim();
}

function concat(chunks) {
    let length = 0;
    for (const chunk of chunks) length += chunk.length;
    const out = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

function begin(id) {
    sessions.set(id, {
        id,
        vad: new sherpa.Vad(vadConfig, 60),
        // What has not yet made a whole window for the detector.
        leftover: new Float32Array(0),
        // Everything heard, and where the next piece starts in it. Pieces are
        // cut from this at the detector's bounds rather than taken from the
        // detector, whose pieces start a little late: the first word of each
        // was coming out clipped.
        audio: new Float32Array(RATE * 30),
        length: 0,
        cut: 0,
        heardSpeech: false,
        pieces: [],
        draft: '',
        sent: '',
        lastDraft: 0,
        drafting: false,
        queue: Promise.resolve(),
        ended: false,
    });
}

/** Run after everything before it for this session, in order. */
function enqueue(session, job) {
    session.queue = session.queue.then(job).catch((error) => {
        post({ type: 'failed', id: session.id, error: error.message });
    });
    return session.queue;
}

function update(session) {
    const text = joined([...session.pieces, session.draft]);
    if (text === session.sent) return;
    session.sent = text;
    post({ type: 'update', id: session.id, text });
}

/** Everything heard, kept end to end in one buffer that grows as it fills. */
function keep(session, chunk) {
    if (session.length + chunk.length > session.audio.length) {
        const grown = new Float32Array(Math.max(session.audio.length * 2, session.length + chunk.length));
        grown.set(session.audio.subarray(0, session.length));
        session.audio = grown;
    }
    session.audio.set(chunk, session.length);
    session.length += chunk.length;
}

/** Pieces the detector has closed, each written down in turn. */
function takePieces(session) {
    while (!session.vad.isEmpty()) {
        // Not a view of the detector's memory (Electron does not allow
        // buffers held outside its heap), and only its bounds are used.
        const segment = session.vad.front(false);
        session.vad.pop();
        session.heardSpeech = true;
        const end = segment.start + segment.samples.length;
        const from = Math.max(session.cut, segment.start - LEAD_IN * RATE);
        const to = Math.min(session.length, end + TRAIL * RATE);
        const samples = session.audio.slice(from, to);
        session.cut = Math.max(session.cut, to);
        enqueue(session, async () => {
            const text = await decode(samples);
            session.pieces.push(text);
            session.draft = '';
            update(session);
        });
    }
}

function audio(id, samples) {
    const session = sessions.get(id);
    if (!session || session.ended) return;
    const chunk = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    keep(session, chunk);

    const buffer = concat([session.leftover, chunk]);
    let offset = 0;
    for (; offset + WINDOW <= buffer.length; offset += WINDOW) {
        session.vad.acceptWaveform(buffer.slice(offset, offset + WINDOW));
    }
    session.leftover = buffer.slice(offset);
    takePieces(session);

    // A draft of the piece so far, when speech is under way and none is in hand.
    const now = Date.now();
    if (session.vad.isDetected() && !session.drafting && now - session.lastDraft >= DRAFT_EVERY) {
        session.drafting = true;
        session.lastDraft = now;
        const tail = session.audio.slice(Math.max(session.cut, session.length - DRAFT_SECONDS * RATE), session.length);
        const count = session.pieces.length;
        enqueue(session, async () => {
            try {
                const text = await decode(tail);
                // A piece closed meanwhile has written this down properly.
                if (session.pieces.length === count && !session.ended) {
                    session.draft = text;
                    update(session);
                }
            } finally {
                session.drafting = false;
            }
        });
    }
}

async function end(id) {
    const session = sessions.get(id);
    if (!session) return;
    session.ended = true;
    session.vad.flush();
    takePieces(session);
    await session.queue;
    let text = joined(session.pieces);
    // Speech too quiet or too short for the detector: the whole of it, once.
    if (!text && !session.heardSpeech) {
        const whole = session.audio.slice(0, session.length);
        if (whole.length >= RATE / 4 && whole.length <= RATE * 30) {
            try {
                text = await decode(whole);
            } catch {
                text = '';
            }
        }
    }
    sessions.delete(id);
    post({ type: 'done', id, text });
}

function cancel(id) {
    const session = sessions.get(id);
    if (!session) return;
    session.ended = true;
    sessions.delete(id);
}

/* ------------------------------------------------------------------ *
 * Streaming (Nemotron)
 * ------------------------------------------------------------------ */

/** "it", "it-IT", "IT_it": the base code the model's prompt table takes. */
const languageCode = value => String(value || '').trim().toLowerCase().split(/[-_]/)[0];

function pin(session) {
    if (session.language) session.stream.setOption('language', session.language);
}

function beginStreaming(id, language) {
    const session = {
        id,
        stream: online.createStream(),
        language: languageCode(language),
        // Sentences closed at an endpoint, and the one being spoken.
        pieces: [],
        draft: '',
        sent: '',
        ended: false,
    };
    pin(session);
    sessions.set(id, session);
}

/**
 * Decode all the model has room for, and read the sentence so far. At an
 * endpoint it is closed and the stream starts the next one fresh, pinned as
 * before. At the end (`finishing`) whatever is there is the last of it.
 */
function drainStreaming(session, { finishing = false } = {}) {
    while (online.isReady(session.stream)) online.decode(session.stream);
    const text = String(online.getResult(session.stream)?.text || '').trim();
    if (!finishing && online.isEndpoint(session.stream)) {
        if (text) session.pieces.push(text);
        session.draft = '';
        online.reset(session.stream);
        pin(session);
    } else {
        session.draft = text;
    }
    update(session);
}

function audioStreaming(id, samples) {
    const session = sessions.get(id);
    if (!session || session.ended) return;
    const chunk = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
    session.stream.acceptWaveform({ sampleRate: RATE, samples: chunk });
    drainStreaming(session);
}

function endStreaming(id) {
    const session = sessions.get(id);
    if (!session) return;
    session.ended = true;
    session.stream.acceptWaveform({ sampleRate: RATE, samples: new Float32Array(Math.round(RATE * STREAM_TAIL)) });
    session.stream.inputFinished();
    drainStreaming(session, { finishing: true });
    sessions.delete(id);
    post({ type: 'done', id, text: joined([...session.pieces, session.draft]) });
}

async function handle(message) {
    if (!message || typeof message !== 'object') return;
    const streaming = mode === 'streaming';
    try {
        if (message.type === 'load') {
            await load(message);
            post({ type: 'loaded' });
        } else if (message.type === 'begin') {
            if (streaming) beginStreaming(message.id, message.language);
            else begin(message.id);
        } else if (message.type === 'audio') {
            if (streaming) audioStreaming(message.id, message.samples);
            else audio(message.id, message.samples);
        } else if (message.type === 'end') {
            if (streaming) endStreaming(message.id);
            else await end(message.id);
        } else if (message.type === 'cancel') {
            cancel(message.id);
        }
    } catch (error) {
        post({ type: message.type === 'load' ? 'load-failed' : 'failed', id: message.id, error: error.message });
        if (message.id !== undefined && message.type === 'end') post({ type: 'done', id: message.id, text: '', error: error.message });
    }
}

if (port) port.on('message', event => handle(event.data));
else process.on('message', handle);
