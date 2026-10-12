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
async function start(agentId, { apps = [], redact = false, label = '', paused = '' } = {}) {
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
 * The trace as episodes: runs of actions in one app with no long wait between
 * them. Split on a change of foreground app, a gap over two minutes, and a
 * mark the person dropped. The header is left out.
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
        const appChanged = current && line.app && appNow && line.app !== current.app && line.type === 'window';
        const mark = line.type === 'mark';
        if (!current || gap || appChanged || mark) open(line.app || appNow, t);
        current.lines.push(line);
        lastT = t;
    }
    return episodes;
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

/** One line of an episode, as the model is shown it. */
function renderLine(line) {
    const target = line.target || {};
    const where = target.path && target.path.length ? ` (${target.path.join(' > ')})` : '';
    switch (line.type) {
        case 'window': return `open ${line.app || 'app'}${line.window ? ` · ${line.window}` : ''}${line.url ? ` · ${line.url}` : ''}`;
        case 'page': return `page ${line.url || line.title || ''}`;
        case 'content': return line.text ? `screen: ${String(line.text).replace(/\s+/g, ' ').slice(0, 400)}` : '';
        case 'click': return `click ${target.role || 'control'} "${target.name || ''}"${where}`;
        case 'field': return `enter "${target.name || 'field'}" = ${line.value == null ? '' : line.value}`;
        case 'login': return `sign in at ${line.site || line.window || ''}${line.user ? ` as ${line.user}` : ''}`;
        case 'select': return `choose "${target.name || ''}" = ${line.value == null ? '' : line.value}`;
        case 'keys': return `press ${line.keys || ''}`;
        case 'mark': return line.note ? `note: ${line.note}` : 'marked';
        default: return '';
    }
}

/** An episode as a readable block for the prompt. */
function renderEpisode(ep) {
    const head = `[${ep.id}] ${clock(ep.start)} ${ep.app || 'app'}`;
    const body = ep.lines.map(renderLine).filter(Boolean).map(l => `  ${l}`);
    return [head, ...body].join('\n');
}

/* ------------------------------------------------------------------ *
 * Distilling: the one question put to the runtime.
 * ------------------------------------------------------------------ */

const TIMEOUT = 5 * 60 * 1000;
const THINK = 4096;

const INSTRUCTION = [
    'You turn a recording of one person doing their job into a draft an IT agent can learn from.',
    'You are given the recording as episodes: runs of actions in one app, each action a line (open, page, click, enter, sign in, choose, press).',
    'Return JSON only, no prose, with these keys:',
    '- "appMap": array of {app, where, path} - where a thing lives in an app or site, as a menu path.',
    '- "procedures": array of {name, when, params, steps, branches} - a task done in the recording. "params" are the values that would change next time (a domain, a customer). "steps" are written with the control names and URLs seen. "branches" are the points where the path depended on something.',
    '- "glossary": array of {term, meaning} - abbreviations or terms used that need explaining.',
    '- "templates": array of {name, text} - text the person wrote that is reused, with the parts that change as {{placeholders}}.',
    '- "questions": array of {id, episode, text} - at most 8, for what the recording cannot show: why one path was chosen over another, whether a value is always the same, why two runs of the same task differed, and waits or off-screen steps. Ask the most useful first.',
    'A password is never in the recording and must never be in your answer. A "sign in" line names the site and username only.',
    'Keep every value you were shown as written; do not invent names, numbers or steps that are not in the episodes.',
].join('\n');

function request(episodes) {
    const blocks = episodes.map(renderEpisode).join('\n\n');
    return `Here is the recording.\n\n<recording>\n${blocks}\n</recording>\n\nReturn the JSON draft.`;
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
    return {
        ok: true,
        draft: {
            appMap: asArray(parsed.appMap),
            procedures: asArray(parsed.procedures),
            glossary: asArray(parsed.glossary),
            templates: asArray(parsed.templates),
            questions: asArray(parsed.questions).slice(0, 8),
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
function review(provider, { settings, id } = {}) {
    if (!validId(id)) return Promise.resolve({ ok: false, code: 'bad-id', error: 'Not a recording id.' });
    if (active && active.id === id) {
        return Promise.resolve({ ok: false, code: 'recording', error: 'That recording is still under way. Stop it first.' });
    }
    const held = drafts.get(id);
    if (held) return Promise.resolve({ ok: true, ...held });
    return distil(provider, { settings, id });
}

async function distilNow(provider, { settings, id } = {}) {
    const lines = readTrace(id);
    if (!lines) return { ok: false, error: 'That recording is gone.' };
    const episodes = splitEpisodes(lines);
    const logins = loginsFrom(lines);

    let draft = { appMap: [], procedures: [], glossary: [], templates: [], questions: [] };
    let note = '';
    if (typeof provider?.title === 'function' && episodes.length) {
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), TIMEOUT);
        timer.unref?.();
        try {
            const reply = await provider.title({
                settings,
                instruction: INSTRUCTION,
                prompt: request(episodes),
                signal: abort.signal,
                think: THINK,
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
    const held = { id, logins, draft, note };
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
