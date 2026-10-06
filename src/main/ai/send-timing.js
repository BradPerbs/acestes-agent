const fs = require('fs');
const path = require('path');

/**
 * Where a message's time goes between the send and the runtime.
 *
 * Claude Code takes about twenty milliseconds from reading a message to
 * starting on it, and a week of this app's sends took a third of a second
 * from the click to there, the same for a short message as a long one. This
 * is the record that says which part of `send` that is: each stage's time,
 * written as one line to `logs/send-timing.jsonl` in the app's folder, and
 * only for a send slower than the threshold, so a quick one costs nothing
 * but a few clock readings. The file is kept to a few hundred kilobytes,
 * with one previous file beside it.
 */

/** A send faster than this is not worth a line. */
const THRESHOLD = 150;
/** Past this the file is moved aside and a new one started. */
const MAX_BYTES = 256 * 1024;

const clock = () => performance.now();

/**
 * A stopwatch for one send. `mark(name)` closes the stage just run under
 * that name; `entry()` is the whole of it, in milliseconds.
 */
function createTimer(now = clock) {
    const started = now();
    let last = started;
    const stages = {};
    return {
        mark(name) {
            const at = now();
            stages[name] = Math.round((stages[name] || 0) + (at - last));
            last = at;
        },
        entry(extra = {}) {
            return { at: new Date().toISOString(), total: Math.round(now() - started), stages: { ...stages }, ...extra };
        },
    };
}

let defaultFile = null;
function logFile() {
    if (defaultFile) return defaultFile;
    try {
        const { app } = require('electron');
        defaultFile = path.join(app.getPath('userData'), 'logs', 'send-timing.jsonl');
    } catch {
        defaultFile = '';
    }
    return defaultFile;
}

/** Write one send's timings, when it was slow enough to be worth it. Never throws. */
function record(entry, { file = logFile(), threshold = THRESHOLD, maxBytes = MAX_BYTES } = {}) {
    if (!file || !entry || entry.total < threshold) return false;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
        } catch {
            // No file yet.
        }
        fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
        return true;
    } catch {
        return false;
    }
}

module.exports = { createTimer, record, THRESHOLD };
