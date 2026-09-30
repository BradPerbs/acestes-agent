/**
 * The live dictation worker: Parakeet (NVIDIA's TDT 0.6B v3, through
 * sherpa-onnx) and a voice activity detector, in a process of their own.
 *
 * Its own process for two reasons. sherpa-onnx carries its own ONNX Runtime,
 * and the main process already has another loaded for the memory's
 * embeddings; on Windows the second DLL of that name would be handed the
 * first. And a model this size is better away from the process that draws
 * every window.
 *
 * Audio arrives while the user talks. The detector cuts it where they pause,
 * and each piece is written down there and then, so the words keep up with
 * the voice and stopping leaves only the last few seconds to do. Between
 * pauses the piece so far is written down every so often too, as a draft the
 * next pass replaces. Everything decodes in order, one at a time.
 *
 * Started by parakeet.js as an Electron utility process (parentPort) or, in
 * the tests, a plain child process (process.send).
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

let recognizer = null;
let sherpa = null;
let vadConfig = null;
const sessions = new Map();

const port = process.parentPort || null;
function post(message) {
    if (port) port.postMessage(message);
    else if (process.send) process.send(message);
}

async function load({ model, vad, threads }) {
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

async function handle(message) {
    if (!message || typeof message !== 'object') return;
    try {
        if (message.type === 'load') {
            await load(message);
            post({ type: 'loaded' });
        } else if (message.type === 'begin') {
            begin(message.id);
        } else if (message.type === 'audio') {
            audio(message.id, message.samples);
        } else if (message.type === 'end') {
            await end(message.id);
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
