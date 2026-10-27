/**
 * The agents at work, in a corner of the screen.
 *
 * While an agent drives the desktop, the Acestes window is usually behind
 * the app it is working in, so nothing on screen says what it is doing, or
 * that it is doing anything at all in the seconds between one click and the
 * next. This is a small card in the bottom-right corner with a row for each
 * conversation at work: its title, what it is doing this moment (clicking,
 * typing, thinking, waiting for you), and the last thing it said.
 *
 * It never takes focus, clicks go straight through it, and it is kept out of
 * screen capture, so the agent's own screenshots never show it. It comes up
 * when the first agent takes the desktop (see computer.js) and goes a few
 * seconds after the last one lets go. The window runs the same renderer
 * bundle as the main one, told by its URL hash to draw only this; what it
 * shows is pushed from here as the conversation's events go past.
 *
 * It is the only sign on screen that an agent is driving (the helper's badge
 * at the top of the screen is off), so it also says when the user's hand
 * paused the agents or Esc stopped them.
 *
 * Under the cursor it fades nearly away, so the cursor (the user's or the
 * agent's) is never hidden behind it: being click-through, the window hears
 * no mouse, so the cursor is looked at from here, a dozen times a second
 * while it is up, against where the renderer says its cards are.
 *
 * And it listens. The voice shortcut, pressed while an agent drives (the
 * helper sees it, see computer.js), opens the microphone here; pressed again,
 * what was said steers the newest agent at work without stopping it (see
 * `steer` in index.js). The recording is made in this window, so its meter
 * and the words so far are drawn where the person is looking.
 */

const { BrowserWindow, globalShortcut, screen } = require('electron');
const path = require('path');

const WIDTH = 380;
const HEIGHT = 460;
const MARGIN = 12;
/** How long a finished row stays, so the last thing it did can be read. */
const LINGER = 5000;
/** At most this often, so a burst of events is one repaint. */
const THROTTLE = 120;
const SAID = 220;
/** How often the cursor is looked at while the card is up, in milliseconds. */
const HOVER_EVERY = 70;
/** How far around the cards the cursor counts as over them, in pixels. */
const HOVER_PAD = 10;

// conversationId -> { id, title, agent, look, phase, tool, said, done, since, ended, held }
// `since` and `ended` are the clock on the card: when this stint on the
// desktop began, and when it let go (0 until then). `held` is why the user's
// hand stopped it: 'took-over', 'escape', or '' while it is free to work.
const rows = new Map();
/** Numbers each action, so the card can tell a new one from the same one better named. */
let calls = 0;
let window = null;
let baseUrl = () => '';
let pushTimer = null;
const removals = new Map();
// What the renderer last said: where its cards are, in the window's own
// pixels, and whether it is listening (or showing what it just sent).
let extent = null;
let listening = false;
let hovering = false;
let hoverTimer = null;
// A voice toggle sent before the window had loaded, sent once it has.
let pendingVoice = null;
// The accelerator that also stops a recording once nobody is driving, when
// the helper no longer sees the keys. See `syncShortcut`.
let accelerator = 'Ctrl+S';
let shortcutOn = false;

function configure({ urlOf, voiceAccelerator } = {}) {
    if (typeof urlOf === 'function') baseUrl = urlOf;
    if (typeof voiceAccelerator === 'string' && voiceAccelerator) accelerator = voiceAccelerator;
}

function isOverlay(candidate) {
    return Boolean(window && candidate === window);
}

function url() {
    const base = String(baseUrl() || '').split('#')[0];
    if (base) return `${base}#activity=1`;
    const fallback = path.join(__dirname, '..', '..', '..', 'dist', 'renderer', 'index.html');
    return `file://${fallback.replace(/\\/g, '/')}#activity=1`;
}

/** The bottom-right corner of the screen the user works on, above the taskbar. */
function place() {
    const area = screen.getPrimaryDisplay().workArea;
    return {
        x: area.x + area.width - WIDTH - MARGIN,
        y: area.y + area.height - HEIGHT - MARGIN,
        width: WIDTH,
        height: HEIGHT,
    };
}

function ensureWindow() {
    if (window && !window.isDestroyed()) return window;
    window = new BrowserWindow({
        ...place(),
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: false,
        },
    });
    // Above the app being worked in, never in the way of it, never in the
    // agent's own pictures of the screen.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true);
    window.setContentProtection(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-finish-load', () => {
        send();
        if (pendingVoice) {
            window.webContents.send('ai-activity-voice', pendingVoice);
            pendingVoice = null;
        }
    });
    window.on('closed', () => {
        window = null;
        stopHover();
        listening = false;
        syncShortcut();
    });
    window.loadURL(url());
    return window;
}

function send() {
    if (!window || window.isDestroyed()) return;
    window.webContents.send('ai-activity', { rows: [...rows.values()] });
}

/* ------------------------------------------------------------------ *
 * Fading under the cursor
 * ------------------------------------------------------------------ */

function lookAtCursor() {
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    let over = false;
    if (extent) {
        const bounds = window.getBounds();
        const point = screen.getCursorScreenPoint();
        const x = point.x - bounds.x;
        const y = point.y - bounds.y;
        over = x >= extent.left - HOVER_PAD && x <= extent.right + HOVER_PAD
            && y >= extent.top - HOVER_PAD && y <= extent.bottom + HOVER_PAD;
    }
    if (over === hovering) return;
    hovering = over;
    window.webContents.send('ai-activity-hover', { over });
}

function startHover() {
    if (hoverTimer) return;
    hoverTimer = setInterval(lookAtCursor, HOVER_EVERY);
}

function stopHover() {
    if (hoverTimer) clearInterval(hoverTimer);
    hoverTimer = null;
    hovering = false;
}

/* ------------------------------------------------------------------ *
 * Listening
 * ------------------------------------------------------------------ */

/** Whether any agent is still at work on the desktop, its helper hook watching the keys. */
function anyDriving() {
    for (const row of rows.values()) if (!row.done && !row.held) return true;
    return false;
}

/**
 * While the card is listening and nobody drives any more (the turn ended
 * mid-sentence), the helper's hook is gone, so the shortcut is held here for
 * the moment, to stop the recording with the keys that started it. Never
 * while an agent drives: the helper has the keys then, and an accelerator
 * would also catch the agent's own typing of them.
 */
function syncShortcut() {
    const want = listening && !anyDriving() && Boolean(window && !window.isDestroyed());
    if (want === shortcutOn) return;
    try {
        if (want) {
            shortcutOn = globalShortcut.register(accelerator, () => {
                if (window && !window.isDestroyed()) window.webContents.send('ai-activity-voice', { action: 'toggle' });
            });
        } else {
            globalShortcut.unregister(accelerator);
            shortcutOn = false;
        }
    } catch (error) {
        console.error('Could not hold the voice shortcut:', error.message);
        shortcutOn = false;
    }
}

/**
 * The voice shortcut, pressed while agents drive: start listening for the
 * conversation named, or stop and send if already listening. Which of the
 * two is the renderer's to know; this only says the keys were pressed.
 */
function voice(conversationId, { live = false, enabled = true } = {}) {
    if (typeof BrowserWindow !== 'function') return;
    const row = rows.get(conversationId);
    const message = { action: 'toggle', conversationId, live, enabled, title: row?.title || row?.agent || '' };
    const shown = ensureWindow();
    shown.setBounds(place());
    if (!shown.isVisible()) shown.showInactive();
    startHover();
    if (shown.webContents.isLoading()) pendingVoice = message;
    else shown.webContents.send('ai-activity-voice', message);
}

/** What the renderer says of itself: where its cards are, and whether it is listening. */
function ui(state = {}) {
    const box = state.extent;
    extent = box && [box.top, box.left, box.right, box.bottom].every(Number.isFinite)
        ? { top: box.top, left: box.left, right: box.right, bottom: box.bottom }
        : null;
    if (typeof state.listening === 'boolean' && state.listening !== listening) {
        listening = state.listening;
        syncShortcut();
        if (!listening) hideWhenEmpty();
    }
}

/** The user's hand stopped these drivers: took over the mouse or keyboard, or pressed Esc. */
function held(conversationIds = [], code = 'took-over') {
    for (const id of conversationIds) {
        const row = rows.get(id);
        if (!row || row.done) continue;
        row.held = code === 'escape' ? 'escape' : 'took-over';
        row.tool = null;
    }
    syncShortcut();
    push();
}

function push() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
        pushTimer = null;
        send();
    }, THROTTLE);
}

function showWindow() {
    // Under a test there is no Electron to draw with; the rows are still kept.
    if (typeof BrowserWindow !== 'function') return;
    const shown = ensureWindow();
    shown.setBounds(place());
    if (!shown.isVisible()) shown.showInactive();
    startHover();
}

/** Gone once nothing is left on it: no agent's card, and not listening. */
function hideWhenEmpty() {
    if (rows.size > 0 || listening) return;
    stopHover();
    if (window && !window.isDestroyed() && window.isVisible()) window.hide();
}

/**
 * Which conversations are at work on the desktop now, each with how to
 * name it. New ones get a row; ones no longer at work are marked done and
 * go after a moment.
 */
function drivers(list = []) {
    const now = new Set(list.map(entry => entry.id));
    for (const entry of list) {
        const pending = removals.get(entry.id);
        if (pending) {
            clearTimeout(pending);
            removals.delete(entry.id);
        }
        const row = rows.get(entry.id);
        if (row?.done) {
            // Back at it before its finished card had gone: a new stint, on a fresh clock.
            Object.assign(row, {
                title: entry.title || row.title,
                done: false,
                phase: 'thinking',
                held: '',
                ask: null,
                since: Date.now(),
                ended: 0,
            });
        } else if (row) {
            row.title = entry.title || row.title;
        } else {
            rows.set(entry.id, {
                id: entry.id,
                title: entry.title || '',
                agent: entry.agent || '',
                look: entry.look || null,
                phase: 'thinking',
                tool: null,
                said: '',
                done: false,
                held: '',
                ask: null,
                since: Date.now(),
                ended: 0,
            });
        }
    }
    for (const [id, row] of rows) {
        if (now.has(id) || row.done) continue;
        row.done = true;
        row.phase = 'done';
        row.tool = null;
        row.ended = Date.now();
        removals.set(id, setTimeout(() => {
            removals.delete(id);
            rows.delete(id);
            send();
            hideWhenEmpty();
        }, LINGER));
    }
    if (rows.size > 0) showWindow();
    syncShortcut();
    push();
}

/** Whether a conversation has a row, so the event path can skip the rest cheaply. */
function watching(conversationId) {
    return rows.has(conversationId);
}

/** A tool call's input, kept small: the row shows a line of it at most. */
function slim(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') out[key] = value.slice(0, 160);
        else if (key === 'steps' && Array.isArray(value)) {
            out.steps = value.slice(0, 12).map(step => ({ ...step, text: typeof step?.text === 'string' ? step.text.slice(0, 60) : undefined }));
        } else if (typeof value !== 'object' || value === null) out[key] = value;
        else if (Array.isArray(value)) out[key] = value.slice(0, 8);
    }
    return out;
}

/** One of the conversation's events, as what its row says now. */
function event(conversationId, stamped, title = '') {
    const row = rows.get(conversationId);
    if (!row) return;
    if (title) row.title = title;
    switch (stamped.type) {
        case 'tool-call':
            row.phase = 'acting';
            calls += 1;
            row.tool = { name: stamped.name, input: slim(stamped.input), aim: '', seq: calls };
            break;
        case 'tool-result':
            row.phase = 'thinking';
            row.tool = null;
            break;
        case 'assistant-text': {
            // What the agent said, not what one of its subagents told it.
            if (stamped.parentId) break;
            const text = String(stamped.text || '').trim();
            if (text) row.said = text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').slice(0, SAID);
            break;
        }
        case 'approval-request':
        case 'question-request':
            row.phase = 'waiting';
            row.tool = null;
            // What it is asking, on the card, so it can be answered by voice
            // without opening Acestes to read it.
            row.ask = stamped.type === 'question-request'
                ? {
                    question: String(stamped.question || '').slice(0, 240),
                    options: stamped.secret ? [] : (stamped.options || []).slice(0, 4).map(option => String(option).slice(0, 40)),
                    secret: Boolean(stamped.secret),
                }
                : { question: `Allow: ${String(stamped.title || stamped.name || 'this step').slice(0, 200)}?`, options: ['Yes', 'No'], secret: false };
            break;
        case 'approval-settled':
        case 'question-settled':
            row.phase = 'thinking';
            row.ask = null;
            break;
        case 'title':
            if (stamped.title) row.title = stamped.title;
            break;
        default:
            return;
    }
    push();
}

/**
 * What the action under way is aimed at, by name (`button "Submit"`), once
 * the helper has found it: more use to the person watching than the number
 * the agent knows it by.
 */
function aimed(conversationId, label) {
    const row = rows.get(conversationId);
    if (!row?.tool || !label) return;
    row.tool.aim = String(label).slice(0, 120);
    push();
}

function close() {
    for (const pending of removals.values()) clearTimeout(pending);
    removals.clear();
    rows.clear();
    stopHover();
    listening = false;
    syncShortcut();
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
}

module.exports = {
    configure,
    drivers,
    watching,
    event,
    aimed,
    held,
    voice,
    ui,
    isOverlay,
    close,
};
