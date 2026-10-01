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
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const WIDTH = 360;
const HEIGHT = 330;
const MARGIN = 12;
/** How long a finished row stays, so the last thing it did can be read. */
const LINGER = 5000;
/** At most this often, so a burst of events is one repaint. */
const THROTTLE = 120;
const SAID = 220;

// conversationId -> { id, title, agent, look, phase, tool, said, done }
const rows = new Map();
let window = null;
let baseUrl = () => '';
let pushTimer = null;
const removals = new Map();

function configure({ urlOf } = {}) {
    if (typeof urlOf === 'function') baseUrl = urlOf;
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
    window.webContents.on('did-finish-load', () => send());
    window.on('closed', () => { window = null; });
    window.loadURL(url());
    return window;
}

function send() {
    if (!window || window.isDestroyed()) return;
    window.webContents.send('ai-activity', { rows: [...rows.values()] });
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
}

function hideWhenEmpty() {
    if (rows.size > 0) return;
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
        if (row) {
            Object.assign(row, { title: entry.title || row.title, done: false });
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
            });
        }
    }
    for (const [id, row] of rows) {
        if (now.has(id) || row.done) continue;
        row.done = true;
        row.phase = 'done';
        row.tool = null;
        removals.set(id, setTimeout(() => {
            removals.delete(id);
            rows.delete(id);
            send();
            hideWhenEmpty();
        }, LINGER));
    }
    if (rows.size > 0) showWindow();
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
            row.tool = { name: stamped.name, input: slim(stamped.input), aim: '' };
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
            break;
        case 'approval-settled':
        case 'question-settled':
            row.phase = 'thinking';
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
    if (window && !window.isDestroyed()) window.destroy();
    window = null;
}

module.exports = {
    configure,
    drivers,
    watching,
    event,
    aimed,
    isOverlay,
    close,
};
