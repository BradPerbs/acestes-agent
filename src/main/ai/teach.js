/**
 * Teach mode: learning a job by watching the person do it, once.
 *
 * The person turns recording on, works in the apps they chose, and turns it
 * off. The desktop helper reports what they did (see the record command in
 * tools/DesktopRecorder.cs) as event lines, which arrive here through
 * computer.js. This module writes them to a trace, and when recording stops it
 * asks the agent's runtime to distil the trace into a draft pack: a map of
 * each app, procedures as specs, a glossary, templates, and a few questions.
 * The person reviews the draft, answers the questions, and accepts or discards
 * it. Only on accept does anything reach the agent's memory, its specs or its
 * keychain. Nothing is trained; "learning" is notes and specs, the same memory
 * the agent fills by exploring on its own.
 *
 * Two rules shape what is kept:
 *
 *   no passwords   A password field's contents are never recorded. Windows
 *                  hides them from other programs on purpose, and the one way
 *                  around that is to log the keys, which is what a credential
 *                  stealer does. The trace holds only a `login` line: the site
 *                  and the username beside it. The agent still gets to sign in,
 *                  but by the person typing the password into a masked field in
 *                  the Q&A, on purpose, not by the machine skimming it.
 *
 *   nothing early  The password typed in the Q&A, and every draft fact and
 *                  spec, live in memory until the person accepts. Accept writes
 *                  them and deletes the recording; discard overwrites the
 *                  passwords and deletes the recording, and nothing reached the
 *                  keychain. So a recording the person throws away leaves no
 *                  trace, the password included.
 *
 * The distilling is asked the way titles.js and memory-tidy.js ask: one turn,
 * no tools, no session in the user's history, through the runtime's title().
 */

const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const secrets = require('./secrets');

/* ------------------------------------------------------------------ *
 * Wiring the module can be given, so a test can stand in its own.
 * ------------------------------------------------------------------ */

let userDataDir = null;
/** Saves a spec to the inventory. Given by index.js; a no-op until then. */
let saveSpec = null;
/** The helper's record command. Given by computer.js so tests need no helper. */
let helper = {
    start: async () => ({ ok: true }),
    pause: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
};
let now = () => Date.now();

function configure(next = {}) {
    if (next.userDataDir !== undefined) userDataDir = next.userDataDir;
    if (typeof next.saveSpec === 'function') saveSpec = next.saveSpec;
    if (next.helper) helper = next.helper;
    if (typeof next.now === 'function') now = next.now;
}

/** Where recordings live, made on first use. */
function recordingsDir() {
    const base = userDataDir || (() => {
        try {
            return require('electron').app.getPath('userData');
        } catch {
            return path.join(require('os').tmpdir(), 'acestes-recordings');
        }
    })();
    const dir = path.join(base, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Whether an id is one makeId() could have given. The renderer hands ids back
 * for review and discard, and a discard deletes the folder recursively, so
 * anything else (an empty string, "..", a path) is refused before it is joined.
 */
function validId(id) {
    return typeof id === 'string' && /^rec-[a-z0-9]+-[a-z0-9]+$/.test(id);
}

function recordingDir(id) {
    if (!validId(id)) throw new Error('Not a recording id.');
    return path.join(recordingsDir(), id);
}

/* ------------------------------------------------------------------ *
 * Redaction: what a line holds before it is written.
 * ------------------------------------------------------------------ */

/** A run of digits that passes the Luhn check: a card number, most likely. */
function looksLikeCard(digits) {
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let even = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
        let n = digits.charCodeAt(i) - 48;
        if (even) {
            n *= 2;
            if (n > 9) n -= 9;
        }
        sum += n;
        even = !even;
    }
    return sum % 10 === 0;
}

const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,8}[ ]?[A-Z0-9]{1,4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/**
 * A value as it is written down. Any stored secret is masked (secrets.scrub,
 * the same rule the transcript follows), so a password that reached the trace
 * some other way is not repeated. With `redact` on (a company setting, off by
 * default), card numbers and IBANs become placeholders too.
 */
function redactText(text, { redact = false } = {}) {
    let out = secrets.scrub(String(text == null ? '' : text));
    if (!redact) return out;
    out = out.replace(IBAN, '{{iban}}');
    out = out.replace(CARD, match => (looksLikeCard(match.replace(/[ -]/g, '')) ? '{{card}}' : match));
    return out;
}

/** The fields of a line that carry free text, redacted in place. */
const TEXT_FIELDS = ['value', 'text', 'title', 'note', 'window', 'user'];

function redactLine(line, options = {}) {
    if (!line || typeof line !== 'object') return null;
    const out = { ...line };
    for (const key of TEXT_FIELDS) {
        if (out[key] !== undefined) out[key] = redactText(out[key], options);
    }
    if (Array.isArray(out.headings)) out.headings = out.headings.map(h => redactText(h, options));
    if (out.target && typeof out.target === 'object') {
        out.target = { ...out.target };
        if (out.target.name !== undefined) out.target.name = redactText(out.target.name, options);
    }
    // A password must never be written, whatever a confused helper sends: a
    // value on a line flagged password, and anything on a login line, go.
    const flagged = line.password;
    delete out.password;
    if (out.type === 'login' || flagged) delete out.value;
    return out;
}

/* ------------------------------------------------------------------ *
 * The active recording.
 * ------------------------------------------------------------------ */

/** At most one recording at a time: one person, one screen. */
let active = null;

function makeId() {
    return `rec-${now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

/** Whether a recording is under way (for the button and to refuse a second). */
function recording() {
    return active ? { id: active.id, agentId: active.agentId, paused: active.paused, lines: active.count } : null;
}

/**
 * Start recording for an agent, in the apps named (empty means every app).
 * Refused if one is already under way. Tells the helper to record and opens
 * the trace file; the helper's `rec` events then arrive through ingest().
 */
async function start(agentId, { apps = [], redact = false, label = '', paused = '', task = '' } = {}) {
    if (active) return { ok: false, code: 'busy', error: 'A recording is already under way.' };
    const id = makeId();
    const dir = recordingDir(id);
    fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
    const started = new Date(now()).toISOString();
    const session = {
        id,
        agentId: String(agentId || ''),
        dir,
        redact: Boolean(redact),
        paused: false,
        count: 0,
        stream: fs.createWriteStream(path.join(dir, 'trace.jsonl'), { flags: 'a' }),
    };
    const header = { v: 1, type: 'header', id, started, scope: { apps: apps.map(a => String(a).toLowerCase()) } };
    // What the person said they were about to do, if they said: the one thing
    // the recording cannot show, and what the rest is read in the light of.
    const said = cleanTask(task, { redact });
    if (said) header.task = said;
    session.stream.write(`${JSON.stringify(header)}\n`);
    active = session;
    const reply = await helper.start({ apps, label, paused });
    if (reply && reply.ok === false) {
        active = null;
        try { session.stream.end(); } catch { /* nothing opened */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to remove */ }
        return reply;
    }
    return { ok: true, id };
}

/** A recorder event line, redacted and appended. Called by computer.js. */
function ingest(line) {
    if (!active || active.paused) return;
    const clean = redactLine(line, { redact: active.redact });
    if (!clean) return;
    active.stream.write(`${JSON.stringify(clean)}\n`);
    active.count += 1;
}

async function pause(on) {
    if (!active) return { ok: false, code: 'idle', error: 'Nothing is recording.' };
    active.paused = Boolean(on);
    await helper.pause(Boolean(on));
    return { ok: true, paused: active.paused };
}

/**
 * Stop recording and close the trace. The helper is told to stop so its hooks
 * and badge go. The trace stays on disk until the draft is accepted or
 * discarded; nothing is distilled here, so stopping is quick.
 */
async function stop() {
    if (!active) return { ok: false, code: 'idle', error: 'Nothing is recording.' };
    const session = active;
    active = null;
    await helper.stop();
    await new Promise(resolve => session.stream.end(resolve));
    return { ok: true, id: session.id, lines: session.count };
}

/* ------------------------------------------------------------------ *
 * The trace, read back as episodes.
 * ------------------------------------------------------------------ */

function readTrace(id) {
    let text;
    try {
        text = fs.readFileSync(path.join(recordingDir(id), 'trace.jsonl'), 'utf8');
    } catch {
        return null;
    }
    const lines = [];
    for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
            lines.push(JSON.parse(trimmed));
        } catch {
            // A half-written last line as the helper went: skip it.
        }
    }
    return lines;
}

/** Longer than this between two actions, and they belong to different tasks. */
const EPISODE_GAP = 2 * 60 * 1000;

/**
 * The trace as episodes: stretches of work with no long wait between them.
 * Split on a gap over two minutes and on a mark the person dropped, and NOT on
 * a change of app: most office work is moving something from one app to
 * another (an order from the mail into the sheet), and cutting it at every
 * switch hid exactly that from the model. A switch is a line inside the
 * episode instead. The header is left out.
 */
function splitEpisodes(lines) {
    const episodes = [];
    let current = null;
    let lastT = 0;
    let appNow = '';
    const open = (app, t) => {
        current = { id: `e${episodes.length + 1}`, app: app || '', start: t || 0, lines: [] };
        episodes.push(current);
    };
    for (const line of lines) {
        if (!line || line.type === 'header') continue;
        const t = Number(line.t) || 0;
        if (line.type === 'window' && line.app) appNow = line.app;
        const gap = current && t - lastT > EPISODE_GAP;
        const mark = line.type === 'mark';
        if (!current || gap || mark) open(line.app || appNow, t);
        current.lines.push(line);
        lastT = t;
    }
    return episodes;
}

/** What the person says the task was: one line of plain text, scrubbed. */
function cleanTask(text, options = {}) {
    return redactText(String(text == null ? '' : text), options).replace(/\s+/g, ' ').trim().slice(0, 600);
}

/**
 * The task the person described: one they gave when reading again (kept
 * beside the trace), else the one they gave at the start (in the header).
 */
function readTask(id, lines) {
    try {
        const said = fs.readFileSync(path.join(recordingDir(id), 'task.txt'), 'utf8').trim();
        if (said) return said;
    } catch {
        // None given after the fact.
    }
    const header = (lines || []).find(line => line && line.type === 'header');
    return header && typeof header.task === 'string' ? header.task : '';
}

/** The logins the recorder saw, for the Q&A: site and username, no password. */
function loginsFrom(lines) {
    const seen = new Map();
    for (const line of lines) {
        if (!line || line.type !== 'login') continue;
        const site = String(line.site || line.window || '').trim();
        const user = String(line.user || '').trim();
        const key = `${site}\u0000${user}`;
        if (!seen.has(key)) seen.set(key, { site, user });
    }
    return [...seen.values()];
}

function clock(ms) {
    const s = Math.max(0, Math.floor(Number(ms) / 1000));
    const mm = Math.floor(s / 60).toString().padStart(2, '0');
    const ss = (s % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
}

/**
 * Shortcuts in the words a person would use. The model was shown "press
 * ctrl+v" and asked the person what they had pasted; told "paste", with the
 * value that landed on the next line, it has no need to.
 */
const KEY_WORDS = {
    'ctrl+c': 'copy',
    'ctrl+insert': 'copy',
    'ctrl+x': 'cut',
    'shift+delete': 'cut',
    'ctrl+v': 'paste',
    'ctrl+shift+v': 'paste',
    'shift+insert': 'paste',
    'ctrl+z': 'undo',
    'ctrl+y': 'redo',
    'ctrl+s': 'save',
    'ctrl+a': 'select all',
    'ctrl+f': 'find',
    'ctrl+h': 'find and replace',
    'ctrl+p': 'print',
    'ctrl+n': 'new',
    'ctrl+t': 'new tab',
    'ctrl+w': 'close tab',
    'ctrl+tab': 'next tab',
    'ctrl+shift+tab': 'previous tab',
    'ctrl+l': 'go to the address bar',
    'ctrl+r': 'refresh',
    f5: 'refresh',
    'alt+tab': 'switch window',
    'alt+f4': 'close window',
    enter: 'press Enter',
    tab: 'press Tab',
    'shift+tab': 'press Shift+Tab',
    esc: 'press Esc',
};

/** Keys that only move the caret or the view: noise for what the job was. */
const MOVE_KEYS = /^(?:ctrl\+)?(?:shift\+)?(?:left|right|up|down|home|end|pageup|pagedown)$/;

/** A paste lands in the field left within this long after it. */
const PASTE_WINDOW = 60 * 1000;

/** One line of an episode, as the model is shown it. */
function renderLine(line) {
    const target = line.target || {};
    const where = target.path && target.path.length ? ` (${target.path.join(' > ')})` : '';
    switch (line.type) {
        case 'window': return `switch to ${line.app || 'app'}${line.window ? ` · ${line.window}` : ''}${line.url ? ` · ${line.url}` : ''}`;
        case 'page': return `page ${line.url || line.title || ''}`;
        case 'content': return line.text ? `screen: ${String(line.text).replace(/\s+/g, ' ').slice(0, 600)}` : '';
        case 'click': return `click ${target.role || 'control'} "${target.name || ''}"${where}`;
        case 'field': return `enter "${target.name || 'field'}" = ${line.value == null ? '' : line.value}`;
        case 'login': return `sign in at ${line.site || line.window || ''}${line.user ? ` as ${line.user}` : ''}`;
        case 'select': return `choose "${target.name || ''}" = ${line.value == null ? '' : line.value}`;
        case 'keys': {
            const combo = String(line.keys || '').toLowerCase();
            return KEY_WORDS[combo] || `press ${combo}`;
        }
        case 'mark': return line.note ? `note: ${line.note}` : 'marked';
        default: return '';
    }
}

/**
 * An episode as the model reads it: the work, not every key. Caret and scroll
 * keys go; a paste is folded into the field it landed in ("enter X = v
 * (pasted)"); the same screen text is shown once; and a run of one action
 * becomes "action ×n".
 */
function renderEpisode(ep, index = 0) {
    const out = [];
    const seenScreens = new Set();
    let paste = null; // { at: index in out, t } of the last paste not yet placed
    for (const line of ep.lines) {
        const t = Number(line.t) || 0;
        if (line.type === 'keys' && MOVE_KEYS.test(String(line.keys || '').toLowerCase())) continue;
        if (line.type === 'content') {
            const text = String(line.text || '').replace(/\s+/g, ' ').trim();
            if (!text || seenScreens.has(text)) continue;
            seenScreens.add(text);
        }
        if (line.type === 'window') paste = null;
        let text = renderLine(line);
        if (!text) continue;
        if (line.type === 'field' && paste && t - paste.t <= PASTE_WINDOW) {
            out.splice(paste.at, 1);
            text = `${text} (pasted)`;
            paste = null;
        }
        if (text === 'paste') paste = { at: out.length, t };
        out.push(text);
    }
    const body = [];
    for (const text of out) {
        const last = body[body.length - 1];
        if (last && (last.text === text)) last.n += 1;
        else body.push({ text, n: 1 });
    }
    const head = `Part ${index + 1} · ${clock(ep.start)}`;
    return [head, ...body.map(({ text, n }) => `  ${text}${n > 1 ? ` ×${n}` : ''}`)].join('\n');
}

/* ------------------------------------------------------------------ *
 * Distilling: the one question put to the runtime.
 * ------------------------------------------------------------------ */

// Asked on the agent's own model, not the small one titles use: reading a
// person's job out of a trace of clicks is judgement, and the small model
// answered with the clicks (and asked what had been pasted).
const TIMEOUT = 8 * 60 * 1000;
const THINK = 8192;
const MAX_QUESTIONS = 4;

const INSTRUCTION = [
    'You are looking over a person\'s shoulder. Below is a recording of them at work, and you turn it into notes an IT agent can use to do the same job for them later.',
    '',
    'Read the whole recording as a story before you write anything, and work out what the person was trying to get done and why: the job, not the keystrokes. The "screen:" lines are what was on screen at the time, and they are your best evidence of what the work was about (the emails, tickets, orders, rows or pages being handled). Clicks, keys and field entries are only how it was done. If the person said what the task was, take that as true and read the recording in its light.',
    '',
    'How to read the lines: "switch to" is a change of app or window. "copy" and "paste" move a value from one place to another; the value that arrived is on the "enter" line marked (pasted). An "enter" line is a field\'s value as the person left it. "×3" is the same action three times in a row. A part begins after a pause of a few minutes or where the person dropped a mark.',
    '',
    'Return JSON only, no prose, with these keys:',
    '- "summary": two or three plain sentences on what the person was doing, what for, and how it ended, beginning with a verb and no subject ("Copying this week\'s new orders from the Shopify admin into the Warehouse sheet, one row per order, so they can be packed."). Use their terms: their apps, customers, data. Not a list of clicks. Where you are guessing at the purpose, say so ("probably").',
    '- "procedures": array of {name, goal, when, params, steps, branches} - each task done in the recording. "name" says what the task achieves ("Log a supplier invoice in Xero"); "goal" its outcome; "when" what sets it off. "params" are the values that change from one time to the next (a customer, an amount). "steps" are written the way a colleague would hand them over ("Copy the invoice number from the email into Reference"), naming the controls and URLs seen; no step for a single key or click unless it matters. "branches" are the points where the path depended on something.',
    '- "appMap": array of {app, where, path} - where a thing the job needs lives in an app or site, as a menu path. Only places that matter to the work.',
    '- "glossary": array of {term, meaning} - abbreviations or terms used that need explaining.',
    '- "templates": array of {name, text} - text the person wrote that is reused, with the parts that change as {{placeholders}}.',
    `- "questions": array of {id, text} - at most ${MAX_QUESTIONS}, see below.`,
    '',
    'Questions. The person answers from what they know about their job, not from memory of the recording. Nobody remembers what they pasted, typed, clicked or saw at minute four, so never ask that, and never ask what a key, a shortcut, a copy, a paste or a click did or held. Where a detail like that is missing, work it out from what was on screen around it, or make it a param. Ask only what you need to do this job well, that the recording cannot show, and that the person can answer at once: what starts the task and how often it comes up, how they choose between two paths, the rule behind a value (always the same? where does it come from?), what to do in a case the recording did not cover, what must never be done. Most useful first. None at all is right when the recording is clear. Write each in the person\'s words, never the recorder\'s: no "part 2", no "ctrl+v", no control names a person would not say aloud.',
    '',
    'A password is never in the recording and must never be in your answer. A "sign in" line names the site and username only.',
    'Keep every value you were shown as written; do not invent names, numbers or steps that are not in the recording.',
].join('\n');

function request(episodes, task = '') {
    const blocks = episodes.map((ep, i) => renderEpisode(ep, i)).join('\n\n');
    const said = task
        ? `The person said what they were doing: "${task}"\n\n`
        : '';
    return `${said}Here is the recording.\n\n<recording>\n${blocks}\n</recording>\n\nReturn the JSON draft.`;
}

/** The model's reply as an object, or an error. Tolerant of fences and prose. */
function parseDraft(reply) {
    const text = String(reply || '');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return { ok: false, error: 'The runtime did not return a draft.' };
    let parsed;
    try {
        parsed = JSON.parse(body.slice(start, end + 1));
    } catch (error) {
        return { ok: false, error: `The draft was not readable: ${error.message}` };
    }
    const asArray = v => (Array.isArray(v) ? v : []);
    // Each question needs an id for its answer to be kept by; a model that
    // left one out, or gave two the same, still gets its answers back.
    const ids = new Set();
    const questions = asArray(parsed.questions)
        .filter(q => q && String(q.text || '').trim())
        .slice(0, MAX_QUESTIONS)
        .map((q, i) => {
            let id = String(q.id || '').trim() || `q${i + 1}`;
            if (ids.has(id)) id = `${id}-${i + 1}`;
            ids.add(id);
            return { id, text: String(q.text).trim() };
        });
    return {
        ok: true,
        draft: {
            summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
            appMap: asArray(parsed.appMap),
            procedures: asArray(parsed.procedures),
            glossary: asArray(parsed.glossary),
            templates: asArray(parsed.templates),
            questions,
        },
    };
}

/** Drafts held in memory between distil and accept/discard, keyed by id. */
const drafts = new Map();
/** Distils still being asked, keyed by id, so a second ask joins the first. */
const distilling = new Map();

/**
 * Read a recording, ask the runtime to distil it, and hold the draft for
 * review. The draft returned carries the logins the recorder saw (site and
 * username, no password) so the Q&A can show them even if the model left them
 * out. Never rejects: a runtime that cannot be asked gives an empty draft with
 * the trace's own app and login list, so the person still has something to
 * review. Asked again for the same recording while the first is still going,
 * it hands back the same answer rather than asking the runtime twice.
 */
function distil(provider, { settings, id } = {}) {
    if (distilling.has(id)) return distilling.get(id);
    const asking = distilNow(provider, { settings, id })
        .catch(error => ({ ok: false, error: error?.message || 'The recording could not be read.' }))
        .finally(() => distilling.delete(id));
    distilling.set(id, asking);
    return asking;
}

/**
 * Open a recording for review: the draft already held for it, the distil
 * already under way, or a fresh distil of the trace on disk. This is how a
 * recording left over (the page was closed while it distilled, the app was
 * restarted, or the first distil failed) gets its Q&A back.
 */
function review(provider, { settings, id, task } = {}) {
    if (!validId(id)) return Promise.resolve({ ok: false, code: 'bad-id', error: 'Not a recording id.' });
    if (active && active.id === id) {
        return Promise.resolve({ ok: false, code: 'recording', error: 'That recording is still under way. Stop it first.' });
    }
    if (typeof task === 'string') return retell(provider, { settings, id, task });
    const held = drafts.get(id);
    if (held) return Promise.resolve({ ok: true, ...held });
    return distil(provider, { settings, id });
}

/**
 * Read a recording again with the person's own account of what they were
 * doing, when the draft got the job wrong. Their words are kept beside the
 * trace (so a later review uses them too), the held draft is dropped, and
 * the recording is distilled afresh in their light.
 */
async function retell(provider, { settings, id, task }) {
    const said = cleanTask(task);
    try {
        const file = path.join(recordingDir(id), 'task.txt');
        if (said) fs.writeFileSync(file, said, 'utf8');
        else fs.rmSync(file, { force: true });
    } catch {
        return { ok: false, code: 'gone', error: 'That recording is gone.' };
    }
    const reading = distilling.get(id);
    if (reading) await reading.catch(() => null);
    forget(id);
    return distil(provider, { settings, id });
}

async function distilNow(provider, { settings, id } = {}) {
    const lines = readTrace(id);
    if (!lines) return { ok: false, error: 'That recording is gone.' };
    const episodes = splitEpisodes(lines);
    const logins = loginsFrom(lines);
    const task = readTask(id, lines);

    let draft = { summary: '', appMap: [], procedures: [], glossary: [], templates: [], questions: [] };
    let note = '';
    if (typeof provider?.title === 'function' && episodes.length) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), TIMEOUT);
        timer.unref?.();
        try {
            const reply = await provider.title({
                settings,
                instruction: INSTRUCTION,
                prompt: request(episodes, task),
                signal: abort.signal,
                think: THINK,
                model: 'agent',
            });
            const parsed = abort.signal.aborted ? { ok: false, error: 'The runtime took too long.' } : parseDraft(reply);
            if (parsed.ok) draft = parsed.draft;
            else note = parsed.error;
        } catch (error) {
            note = abort.signal.aborted ? 'The runtime took too long.' : (error?.message || 'The runtime could not be asked.');
        } finally {
            clearTimeout(timer);
        }
    } else if (!episodes.length) {
        note = 'The recording was empty.';
    } else {
        note = 'This agent\'s runtime cannot be asked to distil a recording.';
    }

    // Discarded while the runtime was thinking: hold nothing for it.
    if (!fs.existsSync(recordingDir(id))) return { ok: false, code: 'gone', error: 'That recording was discarded.' };
    // Which model read it, so the review can say so beside the summary.
    const reader = { provider: String(settings?.provider || ''), model: String(settings?.model || ''), effort: String(settings?.effort || '') };
    const held = { id, logins, draft, note, task, reader };
    drafts.set(id, held);
    return { ok: true, ...held };
}

function getDraft(id) {
    return drafts.get(id) || null;
}

/* ------------------------------------------------------------------ *
 * Accept and discard.
 * ------------------------------------------------------------------ */

/** A keychain name from a site and username: the NAME charset, nothing else. */
function secretName(site, user) {
    const host = s => String(s || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '');
    const clean = s => String(s || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    const left = clean(host(site)) || 'login';
    const right = clean(user);
    const name = right ? `${left}-${right}` : left;
    return name.slice(0, 60);
}

/** Overwrite a string's backing so a discarded password does not linger. */
function wipe(holder, key) {
    if (holder && typeof holder[key] === 'string') holder[key] = '\u0000'.repeat(holder[key].length);
    if (holder) delete holder[key];
}

/**
 * Accept a reviewed draft: write what the person kept into the agent's memory
 * and specs, and the kept logins into its keychain, then delete the recording.
 * This is the one place a password is written. Selections say which items to
 * keep; anything not named is kept, so an untouched review accepts the draft
 * as drafted. A login without a password (the person did not supply one) is
 * noted as a spec step but stored no secret.
 */
async function accept(id, { agentId, drop = {}, logins = [], answers = {} } = {}) {
    const held = drafts.get(id);
    if (!held) return { ok: false, code: 'gone', error: 'There is no draft to accept.' };
    const owner = String(agentId || held.draft.agentId || '');
    const dropped = new Set([].concat(drop.appMap || [], drop.procedures || [], drop.glossary || [], drop.templates || [], drop.logins || []));
    const counts = { facts: 0, specs: 0, logins: 0 };

    for (const entry of held.draft.appMap) {
        if (dropped.has(entry.path) || dropped.has(entry.where)) continue;
        const text = `On ${entry.app}, ${entry.where} is at ${entry.path}.`;
        if (memory.add(owner, { text, tags: ['teach', slug(entry.app)].filter(Boolean), kind: 'fact', source: 'teach' })) counts.facts += 1;
    }
    for (const entry of held.draft.glossary) {
        if (dropped.has(entry.term)) continue;
        const text = `${entry.term}: ${entry.meaning}`;
        if (memory.add(owner, { text, tags: ['teach', 'glossary'], kind: 'fact', source: 'teach' })) counts.facts += 1;
    }
    // What the person was doing, as read (and, if they corrected it, as they
    // put it), and what they answered: the part of the job a recording
    // cannot show. Unanswered questions are let go.
    const summary = String(held.draft.summary || '').trim();
    if (summary && !drop.summary) {
        const text = `Seen in a recording of the user at work: ${summary}`;
        if (memory.add(owner, { text, tags: ['teach', 'workflow'], kind: 'fact', source: 'teach' })) counts.facts += 1;
    }
    for (const question of held.draft.questions || []) {
        const answer = String((answers && answers[question.id]) || '').trim();
        if (!answer) continue;
        const text = `Asked "${String(question.text || '').trim()}", the user said: ${redactText(answer).slice(0, 600)}`;
        if (memory.add(owner, { text, tags: ['teach', 'workflow'], kind: 'fact', source: 'teach' })) counts.facts += 1;
    }

    const loginByKey = new Map(logins.map(l => [`${String(l.site || '').trim()}\u0000${String(l.user || '').trim()}`, l]));
    for (const seen of held.logins) {
        const key = `${seen.site}\u0000${seen.user}`;
        if (dropped.has(key)) continue;
        const supplied = loginByKey.get(key);
        if (supplied && supplied.password) {
            const name = secretName(seen.site, seen.user);
            const result = secrets.set(name, supplied.password, owner);
            if (result && result.stored) counts.logins += 1;
            wipe(supplied, 'password');
        }
    }

    if (typeof saveSpec === 'function') {
        for (const proc of held.draft.procedures) {
            if (dropped.has(proc.name)) continue;
            if (await writeSpec(owner, proc, { kind: 'procedure', id })) counts.specs += 1;
        }
        for (const tpl of held.draft.templates) {
            if (dropped.has(tpl.name)) continue;
            if (await writeSpec(owner, tpl, { kind: 'template', id })) counts.specs += 1;
        }
    }

    forget(id);
    removeRecording(id);
    return { ok: true, counts };
}

function slug(text) {
    return String(text || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** A procedure or template as a spec document, saved through saveSpec. */
async function writeSpec(owner, item, { kind, id }) {
    const lines = [];
    const name = String(item.name || (kind === 'template' ? 'Template' : 'Procedure')).slice(0, 120);
    if (kind === 'template') {
        lines.push(item.text || '');
    } else {
        if (item.goal) lines.push(`Goal: ${item.goal}`);
        if (item.when) lines.push(`When: ${item.when}`);
        if (Array.isArray(item.params) && item.params.length) lines.push(`Fill in: ${item.params.join(', ')}`);
        lines.push('', 'Steps:');
        for (const step of (Array.isArray(item.steps) ? item.steps : [])) lines.push(`- ${step}`);
        if (Array.isArray(item.branches) && item.branches.length) {
            lines.push('', 'Watch for:');
            for (const branch of item.branches) lines.push(`- ${branch}`);
        }
    }
    lines.push('', `Learned by watching, recording ${id}, ${new Date(now()).toISOString().slice(0, 10)}.`);
    try {
        const saved = await saveSpec({
            agentId: owner,
            name,
            kind: 'spec',
            text: lines.join('\n'),
            description: kind === 'template' ? 'A template learned by watching.' : 'A procedure learned by watching.',
            tags: ['teach'],
        });
        return Boolean(saved);
    } catch {
        return false;
    }
}

/** Forget a held draft, overwriting any password a caller stashed on it. */
function forget(id) {
    const held = drafts.get(id);
    if (held && Array.isArray(held.logins)) {
        for (const login of held.logins) wipe(login, 'password');
    }
    drafts.delete(id);
}

function removeRecording(id) {
    if (!validId(id) || (active && active.id === id)) return false;
    try {
        fs.rmSync(recordingDir(id), { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}

/**
 * Discard a recording: drop the draft (overwriting any password typed in the
 * Q&A), and delete the trace and frames. Nothing reached the keychain, the
 * memory or the specs.
 */
function discard(id, { logins = [] } = {}) {
    for (const login of logins) wipe(login, 'password');
    forget(id);
    const removed = removeRecording(id);
    return { ok: true, removed };
}

/**
 * Recordings on disk waiting to be reviewed, newest first. The one still
 * under way is not among them.
 */
function pending() {
    let names;
    try {
        names = fs.readdirSync(recordingsDir());
    } catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        if (!validId(name) || (active && active.id === name)) continue;
        let stat;
        try {
            stat = fs.statSync(path.join(recordingsDir(), name));
        } catch {
            continue;
        }
        // ready: a draft is held and opens at once; reading: the runtime is on it.
        out.push({ id: name, at: stat.mtimeMs, ready: drafts.has(name), reading: distilling.has(name) });
    }
    return out.sort((a, b) => b.at - a.at);
}

/** Delete recordings older than a week that were never reviewed. */
function sweep(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
    const cutoff = now() - maxAgeMs;
    let removed = 0;
    for (const entry of pending()) {
        if (entry.at < cutoff) removed += removeRecording(entry.id) ? 1 : 0;
    }
    return removed;
}

module.exports = {
    configure,
    start,
    ingest,
    pause,
    stop,
    recording,
    distil,
    review,
    getDraft,
    accept,
    discard,
    pending,
    sweep,
    _test: {
        redactText,
        redactLine,
        splitEpisodes,
        loginsFrom,
        renderEpisode,
        parseDraft,
        secretName,
        looksLikeCard,
        validId,
        reset: () => { active = null; drafts.clear(); distilling.clear(); },
    },
};
