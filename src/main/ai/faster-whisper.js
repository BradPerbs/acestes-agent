const { app } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

/**
 * Faster-Whisper: the same Whisper models on CTranslate2, several times
 * quicker on a CPU than the built-in engine and able to tell the language by
 * itself, at the price of Python on the machine.
 *
 * It is the user's to switch on (Settings, Voice input), and its package the
 * user's to install; the page offers to run pip for them. Once in use, one
 * Python process is kept with the model loaded, spoken to in JSON lines, so
 * a message is not a model load. Audio goes to it as a 16 kHz WAV in the temp
 * folder, deleted once read. Models are fetched on first use into userData.
 */

// The worker, written out beside the models rather than shipped in the app's
// archive: Python cannot read from inside an asar.
const WORKER = String.raw`# Acestes's Faster-Whisper worker: one model kept loaded, JSON lines on
# stdin and stdout. Written out by src/main/ai/faster-whisper.js.
import json
import sys
import wave


def say(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


try:
    import numpy
    import faster_whisper
    from faster_whisper import WhisperModel
except Exception as error:  # the package is not there, or broken
    say({"event": "missing", "error": str(error)})
    sys.exit(3)


def samples(path):
    # Our own 16 kHz mono 16-bit WAV, read here rather than by faster-whisper,
    # whose decoder (PyAV) breaks between versions: 1.2.1 passes PyAV an
    # argument that PyAV has since dropped.
    with wave.open(path, "rb") as audio:
        frames = audio.readframes(audio.getnframes())
    return numpy.frombuffer(frames, dtype=numpy.int16).astype(numpy.float32) / 32768.0

root = sys.argv[1] if len(sys.argv) > 1 else None
models = {}
# Set once a GPU turns out unusable: a card is found, but not the CUDA
# libraries it needs, which only shows when the first sentence is heard.
cpu_only = False


def model_for(name):
    key = (name, cpu_only)
    if key in models:
        return models[key]
    say({"event": "loading", "model": name})
    model = None
    if not cpu_only:
        try:
            # A GPU when there is one that works, else the CPU in int8.
            model = WhisperModel(name, device="auto", compute_type="default", download_root=root)
        except Exception:
            model = None
    if model is None:
        model = WhisperModel(name, device="cpu", compute_type="int8", download_root=root)
    models.clear()  # one at a time: they are large
    models[key] = model
    say({"event": "loaded", "model": name})
    return model


def hear(request):
    model = model_for(request.get("model") or "base")
    segments, info = model.transcribe(
        samples(request["audio"]),
        language=request.get("language") or None,
        vad_filter=True,
        beam_size=5,
    )
    # The segments are worked out as they are read, so this is where it runs.
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return text, info


say({"event": "ready", "version": getattr(faster_whisper, "__version__", "")})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except Exception:
        continue
    ident = request.get("id")
    try:
        try:
            text, info = hear(request)
        except Exception as error:
            gpu = any(word in str(error).lower() for word in ("cublas", "cudnn", "cuda"))
            if cpu_only or not gpu:
                raise
            # The card is there and its libraries are not: the CPU, from now on.
            cpu_only = True
            text, info = hear(request)
        say({"id": ident, "text": text, "language": info.language, "duration": info.duration})
    except Exception as error:
        say({"id": ident, "error": str(error)})
`;

const PYTHONS = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];

/** A first use can download a model several gigabytes large. */
const FIRST_TIMEOUT = 20 * 60 * 1000;
const TIMEOUT = 3 * 60 * 1000;

let tell = () => {};
let python = undefined; // undefined: not looked for yet; null: none found
let worker = null;

function setNotifier(fn) {
    tell = typeof fn === 'function' ? fn : () => {};
}

function run(command, args, { timeout = 20000 } = {}) {
    return new Promise((resolve) => {
        execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
            resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error });
        });
    });
}

/** A Python 3.9 or later, however this machine calls it. */
async function findPython({ fresh = false } = {}) {
    if (python !== undefined && !fresh) return python;
    python = null;
    for (const [command, args] of PYTHONS) {
        const answer = await run(command, [...args, '-c', 'import sys; print(sys.version_info[0], sys.version_info[1])']);
        const [major, minor] = answer.stdout.split(/\s+/).map(Number);
        if (answer.ok && major === 3 && minor >= 9) {
            python = { command, args, version: `${major}.${minor}` };
            break;
        }
    }
    return python;
}

/** Whether it can be used: Python found, and the package in it. */
async function status({ fresh = false } = {}) {
    const found = await findPython({ fresh });
    if (!found) return { python: null, installed: null };
    const answer = await run(found.command, [...found.args, '-c', 'import faster_whisper; print(faster_whisper.__version__)']);
    return { python: found.version, installed: answer.ok ? (answer.stdout || 'yes') : null };
}

/** pip install faster-whisper, its output passed along a line at a time. */
async function install() {
    const found = await findPython({ fresh: true });
    if (!found) return { ok: false, error: 'Python 3.9 or later was not found. Install it from python.org first.' };
    return new Promise((resolve) => {
        const child = spawn(found.command, [...found.args, '-m', 'pip', 'install', '--upgrade', 'faster-whisper'], { windowsHide: true });
        const lines = [];
        const hear = (chunk) => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (!line.trim()) continue;
                lines.push(line);
                tell({ state: 'installing', line: line.slice(0, 200) });
            }
        };
        child.stdout.on('data', hear);
        child.stderr.on('data', hear);
        child.on('error', error => resolve({ ok: false, error: error.message }));
        child.on('exit', (code) => {
            if (code === 0) {
                tell({ state: 'installed' });
                resolve({ ok: true });
            } else {
                resolve({ ok: false, error: lines.slice(-4).join('\n') || `pip stopped with code ${code}` });
            }
        });
    });
}

function scriptPath() {
    const folder = path.join(app.getPath('userData'), 'speech');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'faster_whisper_worker.py');
    // Written again whenever it differs, so an update to it reaches the disk.
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== WORKER) fs.writeFileSync(file, WORKER, 'utf8');
    return file;
}

function startWorker() {
    if (worker) return worker.ready;
    const state = { child: null, pending: new Map(), seq: 0, loadedOnce: false, ready: null };
    worker = state;
    state.ready = (async () => {
        const found = await findPython();
        if (!found) throw new Error('Python 3.9 or later was not found. Install it, or switch the voice engine to the built-in Whisper.');
        const models = path.join(app.getPath('userData'), 'models', 'faster-whisper');
        fs.mkdirSync(models, { recursive: true });
        const child = spawn(found.command, [...found.args, '-u', scriptPath(), models], { windowsHide: true });
        state.child = child;
        child.stdin.on('error', () => {});
        return new Promise((resolve, reject) => {
            readline.createInterface({ input: child.stdout }).on('line', (line) => {
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    return;
                }
                if (message.event === 'ready') resolve();
                else if (message.event === 'missing') reject(new Error('faster-whisper is not installed in that Python. Install it from Settings, Voice input.'));
                else if (message.event === 'loading') tell({ state: 'loading', model: message.model });
                else if (message.event === 'loaded') {
                    state.loadedOnce = true;
                    tell({ state: 'ready' });
                } else if (message.id !== undefined) {
                    const waiting = state.pending.get(message.id);
                    if (!waiting) return;
                    state.pending.delete(message.id);
                    clearTimeout(waiting.timer);
                    waiting.resolve(message);
                }
            });
            child.on('exit', (code) => {
                if (worker === state) worker = null;
                reject(new Error(`The Faster-Whisper worker stopped (exit ${code}).`));
                for (const waiting of state.pending.values()) {
                    clearTimeout(waiting.timer);
                    waiting.resolve({ error: `The Faster-Whisper worker stopped (exit ${code}).` });
                }
                state.pending.clear();
            });
            child.on('error', error => reject(error));
        });
    })().catch((error) => {
        if (worker === state) worker = null;
        throw error;
    });
    return state.ready;
}

/** 16 kHz mono float samples as a 16-bit PCM WAV. */
function toWav(samples, rate = 16000) {
    const data = Buffer.alloc(samples.length * 2);
    for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]));
        data.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), index * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

/** The words in a recording, by Faster-Whisper. `language` empty: it works it out. */
async function transcribe(samples, { model = 'base', language = '' } = {}) {
    await startWorker();
    const state = worker;
    const file = path.join(os.tmpdir(), `acestes-speech-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(file, toWav(samples));
    try {
        const answer = await new Promise((resolve) => {
            state.seq += 1;
            const id = state.seq;
            const timer = setTimeout(() => {
                state.pending.delete(id);
                resolve({ error: 'Faster-Whisper did not answer in time.' });
            }, state.loadedOnce ? TIMEOUT : FIRST_TIMEOUT);
            state.pending.set(id, { resolve, timer });
            state.child.stdin.write(`${JSON.stringify({ id, audio: file, model, language: language || null })}\n`);
        });
        if (answer.error) throw new Error(answer.error);
        return { text: String(answer.text || ''), language: answer.language || '' };
    } finally {
        fs.unlink(file, () => {});
    }
}

function shutdown() {
    if (!worker?.child) return;
    try { worker.child.kill(); } catch { /* already gone */ }
    worker = null;
}

module.exports = {
    status,
    install,
    transcribe,
    setNotifier,
    shutdown,
    _test: {
        toWav,
        WORKER,
        // A test names its own Python rather than the one on the PATH.
        usePython: (value) => { python = value; },
    },
};
