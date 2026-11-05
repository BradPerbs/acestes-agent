/**
 * The buddy: Acestes beside the cursor, and the one sign on screen that an
 * agent is using the computer.
 *
 * Whenever an agent drives the desktop, whether it was asked in a chat or
 * through the buddy itself, what shows is a notch at the top of the main
 * screen and a small mark that rides beside the cursor, saying what the agent
 * is doing as it does it (looking, clicking "Save", waiting for you), and
 * whether the user's hand paused it or Esc stopped it. The notch has Stop and
 * Open for the turn it shows. It comes up as an agent takes the desktop and
 * goes a little after the last one lets go. With several at work it shows the
 * newest and counts the others.
 *
 * Switched on for good in Settings (`buddy`, the default; Windows only), it
 * stays up all the time and listens, and the app keeps out of the way: closing
 * its window leaves it running in the tray. Hold Ctrl+Alt anywhere and say
 * what you want. On letting go, a picture of the monitor the pointer is on is
 * taken, with the pointer's tip ringed on it, and goes to the agent with what
 * was said; the agent works with the computer tools at once, and its recap is
 * read aloud. "This" and "here" mean what the pointer is on.
 *
 * Nothing of it is in the way: its windows never take focus, every click
 * goes through them, and they are kept out of screen capture, so the agent's
 * own screenshots never show them. The person's mouse stays theirs until the
 * agent acts.
 *
 *   the chord    seen by the desktop helper's keyboard hook (computer.js
 *                `pushToTalk`), driving or not. Down starts the microphone in
 *                the buddy's window under the cursor, up stops it, another
 *                key while it is held (Ctrl+Alt+T) throws it away. Held while
 *                the notch shows an agent at work, from a chat or not, what
 *                is said steers that agent.
 *   the voice    Ctrl+S while an agent drives, on/off rather than held, seen
 *   key          by the helper only while it drives (computer.js VOICE_KEY):
 *                the way to steer by voice with the buddy not on for good,
 *                and on a Mac, whose helper watches no chord.
 *   one chat     the buddy keeps one conversation going, so "now do the
 *                same for the next one" works, and starts a fresh one after
 *                a quiet spell. Spoken to while it works, what is said steers
 *                the turn under way (see `steer` in index.js), and answers a
 *                question it is standing on.
 *   pointing     a reply that ends [POINT:x,y:label] sends the mark flying
 *                to that place on the screen, as Clicky's does, x and y in
 *                pixels of the agent's latest screenshot.
 *   drawing      and [CIRCLE], [HIGHLIGHT], [ARROW] and [UNDERLINE] draw on
 *                the screen, by hand as it were, while the recap is said: a
 *                loop around a button, a box over a region, an arrow to a
 *                thing, a line under some words. They fade a few seconds
 *                after it has been said, or as soon as Ctrl+Alt goes down.
 *
 * It answers the way it was asked: a turn of the buddy's own conversation is
 * spoken to, so its recap and its questions are said aloud; a chat's turn was
 * typed, so it is shown and never said.
 *
 * One window per display, each the size of it: transparent, click-through,
 * topmost. Each draws the mark when the cursor is on its display; the one on
 * the display the notch was left on draws the notch (the top middle of the
 * main display, unless it was dragged to another edge or away from them;
 * see `moveNotch`), and the one on the
 * main display does the talking. The cursor is
 * looked at here sixty times a second while the windows are up, and told to
 * them only when it moves; the mark, while it follows, asks for it once a
 * frame as well (`cursorNow`). Always on is Windows only: the Mac helper does not
 * watch modifiers on their own yet. A Mac still shows the agents at work.
 */

const path = require('path');
const elevenlabs = require('./elevenlabs');
const tones = require('./buddy-tone');

let electron = {};
try {
    electron = require('electron');
} catch {
    // Not under Electron: a test, which hands in what it needs.
}

/** The chord held to talk. */
const CHORD = 'ctrl+alt';
/** As the notch shows it. */
const CHORD_LABEL = 'Ctrl Alt';
/** Pressed with the chord held, the next agent: Ctrl+Alt+Space. The helper keeps it from the apps. */
const SWITCH_KEY = 'space';
const SWITCH_LABEL = 'Ctrl Alt Space';
/** The most agents offered in the notch. */
const MOST_AGENTS = 12;
/**
 * How often the cursor is looked at while the buddy is on, in milliseconds.
 * Windows runs this process's timers in steps of about 15.6ms, and 16 was two
 * of them: some 37 times a second, unevenly. 8 is one step, about 64. The
 * mark does not ride on this while it follows: it asks once a frame
 * (`cursorNow`), at whatever rate the display draws. This is for the rest:
 * which display the cursor is on, the notch opening under it, its hit area.
 */
const FOLLOW_EVERY = 8;
/** A hold shorter than this was a slip of the hand: no picture is taken for it. */
const SLIP_MS = 250;
/** The longest anything is listened to: a chord stuck down is not a recording that never ends. */
const HOLD_LIMIT_MS = 120000;
/** How long after its last turn the buddy's conversation is carried on, rather than a fresh one started. */
const CARRY_ON_MS = 20 * 60 * 1000;
/** How long a finished turn's reply stays in the notch once it has been said. */
const REPLY_MS = 9000;
/** How long a word of trouble (nothing heard, voice off) stays. */
const NOTICE_MS = 4000;
/** How long the mark stays at a place it points to, before it comes back. */
const POINT_MS = 3200;
/** How long what it drew stays once the recap has been said (or, with nothing said, once drawn). */
const DRAW_MS = 6000;
/** The longest a drawing stays however long the saying takes: a voice that never ends does not leave it up. */
const DRAW_LIMIT_MS = 60000;
/** The most it draws for one reply. */
const MOST_SHAPES = 6;
/** The most that is ever read aloud: a recap, not the reply. The reply is in the notch and the conversation. */
const SPEAK_CHARS = 220;
/** A recap made from the reply, when the agent gave none: its first sentence or two, up to this. */
const RECAP_CHARS = 160;
/** The voice key while an agent drives (computer.js VOICE_KEY), as the notch shows it and as an accelerator. */
const VOICE_LABEL = 'Ctrl S';
const VOICE_ACCELERATOR = 'Ctrl+S';
/** The phases of a turn under way. */
const WORKING = new Set(['thinking', 'acting', 'waiting']);
/** The events that end a turn. */
const ENDINGS = new Set(['interrupted', 'result', 'error', 'closed']);

/**
 * How long things stay, in milliseconds. A test shortens them.
 *
 *   reply   a finished turn's reply in the notch, once it has been said
 *   notice  a word of trouble (nothing heard, voice off)
 *   beat    a finished turn's reply, when another agent is at work to show next
 *   gone    after the turn shown lets go of the desktop, before it is taken
 *           for finished when nothing said it ended
 *   leave   at rest, with the buddy not on for good, before its windows go
 */
const TIMING = { reply: REPLY_MS, notice: NOTICE_MS, beat: 2500, gone: 1500, leave: 700 };
let timing = { ...TIMING };

let deps = {
    ai: null,
    computer: null,
    settings: null,
    // The keychain (secrets.js), for the ElevenLabs key; and the voice itself.
    secrets: null,
    tts: elevenlabs,
    // The agents (agents.js), to offer in the notch; and a settings change
    // made as Settings makes it, so the rest of the app hears of it.
    agents: null,
    setSettings: null,
    // Its conversation as a tab in the app, opened in the background so it
    // can be watched and stopped there; and brought up in front, from the notch.
    showConversation: null,
    openConversation: null,
    isLocked: () => false,
    urlOf: () => '',
    // Told when the buddy goes on or off, for the tray's menu.
    changed: () => {},
};

// On for good: listening for the chord, up at rest, the app kept in the tray.
let enabled = false;
// Its windows are up: on for good, or an agent is at work on the desktop.
let present = false;
// The app is quitting: nothing comes up again.
let final = false;
let config = { notch: true, place: null, speak: true, agentId: '', voice: 'system', voiceModel: '', voiceId: '', tone: tones.toneOf({}) };
// The recap being read out by ElevenLabs: its id, and how to stop it.
let speaking = null;
let baseUrl = '';
// displayId -> { window, display, ready }
const windows = new Map();
let screenListening = false;
let followTimer = null;
let lastCursor = null;
let leaveTimer = null;
let goneTimer = null;

// Every conversation at work on the desktop now, as computer.js tells it:
// id -> { id, title, agent, since, held }. The buddy's own among them.
const drivers = new Map();
// The conversation the notch and the mark draw now, '' for none: the
// buddy's own, or a chat at work on the desktop.
let shown = '';
// The voice key held as an accelerator, while it is not the helper's to see.
let shortcutOn = false;

// The conversation the buddy talks in, and every one it has: their turns
// are spoken to, so they are said aloud, and need no notification.
let conversationId = '';
const mine = new Set();
// Conversations told how the buddy works: the first message carries it all.
const briefed = new Set();
// Conversations already opened as a tab in the app.
const tabbed = new Set();
let lastTurnAt = 0;
let unobserve = null;
// Another agent was picked: the next hold starts a conversation with it,
// rather than carrying on (or steering) the last one's.
let freshNext = false;
let switchSeq = 0;

// The hold under way: { seq, at, mode, displayId, conversationId, looking, timer }
let press = null;
let lastSeq = 0;
// The last hold that ended with nothing heard, so the notice that follows
// it is shown (or not, for a slip of the hand).
let lastEmpty = null;
// What the turn under way has said since its last tool call: the reply.
let texts = [];
let actionSeq = 0;
let sayId = 0;
let lingerTimer = null;
let pointTimer = null;
let drawTimer = null;

/** What the windows draw. Pushed whole on every change; small. */
let state = fresh();

function fresh() {
    return {
        phase: 'idle',
        mode: 'ask',
        heard: '',
        action: null,
        ask: null,
        said: '',
        reply: '',
        // What was read aloud of the reply: the agent's [SAY], or its first sentence.
        recap: '',
        notice: '',
        held: '',
        since: 0,
        title: '',
        // The turn shown is a chat's, not the buddy's own: named in the
        // notch with its agent, and never said aloud.
        chat: false,
        agent: '',
        // How many more agents are at work on the desktop than the one shown.
        others: 0,
        // How to talk to it: 'hold' the chord (on for good), or 'press' the
        // voice key while an agent drives; and whether this listening is a press.
        talk: 'press',
        toggle: false,
        voiceChord: VOICE_LABEL,
        point: null,
        // What it drew on the screen: { at, shapes: [{ kind, ..., label }] } in DIPs, or null.
        drawing: null,
        notch: true,
        // Where the notch is: { display, x, y, dock }, see `placeOf`.
        place: null,
        chord: CHORD_LABEL,
        // Who it talks to, and who else it could: [{ id, name, color, computerUse }].
        agents: [],
        agentId: '',
        // Counts each switch, so the notch opens on the agents for a moment.
        switcher: 0,
        switchChord: SWITCH_LABEL,
    };
}

function configure(next = {}) {
    deps = { ...deps, ...next };
}

/* ------------------------------------------------------------------ *
 * On and off
 * ------------------------------------------------------------------ */

let platform = process.platform;

/** Whether it can be on for good: its chord is the Windows helper's. */
function supported() {
    return platform === 'win32';
}

/** Whether it can show the agents at work: wherever there is computer use. */
function canShow() {
    return platform === 'win32' || platform === 'darwin';
}

function isOn() {
    return enabled;
}

function isPresent() {
    return present;
}

/** Whether a conversation is one of the buddy's, so its desktop work is shown here. */
function owns(id) {
    return Boolean(id) && mine.has(id);
}

/** The settings as they are now: switch on, off, or follow a change. */
async function sync() {
    let current = {};
    try {
        current = deps.settings?.get() || {};
    } catch {
        current = {};
    }
    const before = enabled ? roster().agentId : '';
    config = {
        notch: current.buddyNotch !== false,
        place: current.buddyNotchPlace && typeof current.buddyNotchPlace === 'object' ? current.buddyNotchPlace : null,
        speak: current.buddySpeak !== false,
        agentId: String(current.buddyAgent || ''),
        voice: current.buddyVoice === 'elevenlabs' ? 'elevenlabs' : 'system',
        voiceModel: String(current.buddyVoiceModel || ''),
        voiceId: String(current.buddyVoiceId || ''),
        tone: tones.toneOf(current),
    };
    const wanted = Boolean(current.buddy) && supported();
    if (wanted && !enabled) await start();
    else if (!wanted && enabled) stop();
    else if (present) {
        const now = roster();
        // Pointed at another agent in Settings: the next hold talks to it.
        if (enabled && before && now.agentId !== before) freshNext = true;
        push({ notch: config.notch, place: placeOf(), ...now });
    }
    return { enabled };
}

/**
 * The agents it could talk to, and the one it does: the one picked for it,
 * else the one selected in the app. Each with whether it may use this
 * computer, since one that may not can answer but not act.
 */
function roster() {
    let list = [];
    try {
        list = deps.agents?.snapshot?.()?.agents || [];
    } catch {
        list = [];
    }
    let agentId = '';
    try {
        agentId = deps.settings?.get(config.agentId || undefined)?.agentId || '';
    } catch {
        agentId = '';
    }
    const agents = list.slice(0, MOST_AGENTS).map((agent) => {
        let computerUse = false;
        try {
            computerUse = Boolean(deps.settings?.get(agent.id)?.computerUse);
        } catch {
            computerUse = false;
        }
        return { id: String(agent.id), name: String(agent.name || 'Agent').slice(0, 40), color: String(agent.color || ''), computerUse };
    });
    return { agents, agentId };
}

/** On for good: up at rest, and listening for the chord. */
async function start() {
    const { BrowserWindow } = electron;
    if (typeof BrowserWindow !== 'function' || final) return;
    enabled = true;
    appear();
    push({ talk: 'hold', notch: config.notch, ...roster() });
    const armed = await deps.computer?.pushToTalk(CHORD, { next: SWITCH_KEY });
    if (armed && !armed.ok) notice(`Ctrl+Alt is not being watched: ${armed.error || 'the desktop helper did not start'}.`);
    deps.changed(true);
}

/** Off for good: the chord let go, and the windows gone, unless an agent is still at work. */
function stop() {
    enabled = false;
    if (press && !press.toggle) {
        sendTo(press.displayId, 'buddy-listen', { action: 'cancel' });
        dropPress();
    }
    deps.computer?.pushToTalk('').catch?.(() => {});
    deps.changed(false);
    if (!present) return;
    if (drivers.size === 0 && !press) {
        leave();
        return;
    }
    push({ talk: 'press' });
}

/** The windows up, one per display, following the cursor and the conversations. */
function appear() {
    clearTimeout(leaveTimer);
    leaveTimer = null;
    if (present || final) return;
    const { BrowserWindow, screen } = electron;
    if (typeof BrowserWindow !== 'function' || !canShow()) return;
    present = true;
    state = { ...fresh(), notch: config.notch, place: placeOf(), talk: enabled ? 'hold' : 'press', ...roster() };
    const url = deps.urlOf?.();
    if (url) baseUrl = url;
    layout();
    if (!screenListening && screen?.on) {
        screen.on('display-added', layout);
        screen.on('display-removed', layout);
        screen.on('display-metrics-changed', layout);
        screenListening = true;
    }
    followTimer = setInterval(follow, FOLLOW_EVERY);
    if (!unobserve && deps.ai?.observe) unobserve = deps.ai.observe(onEvent);
}

/** The windows gone, and everything they were drawing. */
function leave() {
    clearTimeout(leaveTimer);
    leaveTimer = null;
    if (!present) return;
    present = false;
    hush();
    if (press) dropPress();
    if (followTimer) clearInterval(followTimer);
    followTimer = null;
    lastCursor = null;
    clearTimeout(lingerTimer);
    clearTimeout(pointTimer);
    clearTimeout(drawTimer);
    clearTimeout(goneTimer);
    unobserve?.();
    unobserve = null;
    for (const entry of windows.values()) {
        if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    windows.clear();
    shown = '';
    texts = [];
    syncShortcut();
}

/**
 * At rest, with the buddy not on for good: its windows go a moment later,
 * once the notch has folded, unless something has come up meanwhile.
 */
function leaveSoon() {
    if (leaveTimer || enabled || !present) return;
    leaveTimer = setTimeout(() => {
        leaveTimer = null;
        if (!enabled && state.phase === 'idle' && drivers.size === 0 && !press) leave();
    }, timing.leave);
}

/* ------------------------------------------------------------------ *
 * The windows: one per display
 * ------------------------------------------------------------------ */

function url(displayId) {
    const base = String(baseUrl || deps.urlOf?.() || '').split('#')[0];
    if (base) return `${base}#buddy=${displayId}`;
    const fallback = path.join(__dirname, '..', '..', '..', 'dist', 'renderer', 'index.html');
    return `file://${fallback.replace(/\\/g, '/')}#buddy=${displayId}`;
}

function primaryId() {
    try {
        return electron.screen.getPrimaryDisplay().id;
    } catch {
        return null;
    }
}

/**
 * How much of a display's bottom edge its window leaves uncovered, in DIPs.
 *
 * A window on top of everything that covers a whole monitor is, to Windows,
 * a full-screen app: Do Not Disturb comes on by itself (the shell reports
 * QUNS_BUSY) and no app's notifications pop up, Acestes' own included, for
 * as long as the buddy is on. One physical pixel short is enough for Windows
 * not to count it; two DIPs are at least that at any scale, after rounding.
 */
const SHORT_OF_FULL_SCREEN = 2;

/** A display's window: all of it but a sliver of its bottom edge. See SHORT_OF_FULL_SCREEN. */
function windowBounds(display) {
    const { x, y, width, height } = display.bounds;
    return { x, y, width, height: Math.max(1, height - SHORT_OF_FULL_SCREEN) };
}

/** Every display has its window, the size of it, and each knows which it is. */
function layout() {
    if (!present) return;
    const { BrowserWindow, screen } = electron;
    const displays = screen.getAllDisplays();
    const here = new Set(displays.map(display => display.id));
    for (const [id, entry] of windows) {
        if (here.has(id)) continue;
        if (!entry.window.isDestroyed()) entry.window.destroy();
        windows.delete(id);
    }
    const primary = primaryId();
    for (const display of displays) {
        let entry = windows.get(display.id);
        if (!entry || entry.window.isDestroyed()) {
            entry = { window: makeWindow(BrowserWindow, display), display, ready: false };
            windows.set(display.id, entry);
        } else {
            entry.display = display;
            entry.window.setBounds(windowBounds(display));
        }
        if (entry.ready) hello(entry, primary);
    }
    // The display the notch was left on may have come or gone.
    const place = placeOf();
    if (JSON.stringify(place) !== JSON.stringify(state.place)) push({ place });
}

/* ------------------------------------------------------------------ *
 * Where the notch is
 *
 * At the top middle of the main display unless it was dragged elsewhere:
 * the pointer resting on it, then the button held and the notch moved. Let
 * go near a display's top edge, it hangs from it; near its left or right
 * side, it stands on end against that side; anywhere else it floats. Where
 * it was left is a setting (`buddyNotchPlace`), so it is there again after a
 * restart; on a display that is not there now, it goes to the same place on
 * the main one.
 * ------------------------------------------------------------------ */

/** How near a display's edge, in DIPs, a notch let go of docks there. Kept with DOCK_ZONE in BuddyOverlay.jsx. */
const DOCK_ZONE = 36;
/** The edges it docks to. Kept with EDGES in BuddyOverlay.jsx and settings.js. */
const EDGES = ['top', 'left', 'right'];

/** The edge a place is docked to, or false: `true`, from before it docked to the sides, is the top. */
function edgeOf(dock) {
    if (dock === true) return 'top';
    return EDGES.includes(dock) ? dock : false;
}

/** The edge a point on a display is near enough to dock to, the nearer of two in a corner; false for none. */
function edgeNear(x, y, width, height) {
    const near = [['top', y], ['left', x], ['right', width - x]]
        .filter(([, gap]) => gap >= 0 && gap < DOCK_ZONE)
        .sort((a, b) => a[1] - b[1]);
    return near.length ? near[0][0] : false;
}

/** x and y as the edge it is docked to has them: on the top, y is 0; on a side, x is that side. */
function pinTo(x, y, dock) {
    if (dock === 'top') return { x, y: 0 };
    if (dock === 'left') return { x: 0, y };
    if (dock === 'right') return { x: 1, y };
    return { x, y };
}

/**
 * Where the notch is drawn: `{ display, x, y, dock }`, the display by its id,
 * x and y the middle of the notch at rest as fractions of its size, and dock
 * the edge it is docked to ('top', 'left' or 'right'), or false.
 */
function placeOf() {
    const saved = config.place;
    let displays = [];
    try {
        displays = electron.screen?.getAllDisplays?.() || [];
    } catch {
        displays = [];
    }
    const there = saved?.display ? displays.find(display => String(display.id) === String(saved.display)) : null;
    const display = there ? there.id : primaryId();
    if (!saved) return { display, x: 0.5, y: 0, dock: 'top' };
    const fraction = value => Math.min(1, Math.max(0, Number(value) || 0));
    const dock = edgeOf(saved.dock);
    return { display, ...pinTo(fraction(saved.x), fraction(saved.y), dock), dock };
}

/**
 * The notch let go of after a drag, from the window it was dragged in: where
 * on that window's display, as fractions, and the edge it docked to, if any,
 * as the window drew it. Let go over another display, it goes there, under
 * the pointer. Kept in the settings, so it stays after a restart.
 */
function moveNotch(sender, payload = {}) {
    let entry = null;
    for (const candidate of windows.values()) {
        if (!candidate.window.isDestroyed() && candidate.window.webContents === sender) entry = candidate;
    }
    if (!entry) return false;
    const x = Number(payload?.x);
    const y = Number(payload?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    let display = entry.display;
    let at = { x, y, dock: edgeOf(payload.dock) };
    try {
        const point = electron.screen.getCursorScreenPoint();
        const under = electron.screen.getDisplayNearestPoint(point);
        if (under && under.id !== display.id) {
            const { bounds } = under;
            const dock = edgeNear(point.x - bounds.x, point.y - bounds.y, bounds.width, bounds.height);
            at = { x: (point.x - bounds.x) / bounds.width, y: (point.y - bounds.y) / bounds.height, dock };
            display = under;
        }
    } catch {
        // Where the pointer is could not be read: the window's word for it.
    }
    const fraction = value => Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
    const saved = { display: String(display.id), ...pinTo(fraction(at.x), fraction(at.y), at.dock), dock: at.dock };
    config.place = saved;
    try {
        deps.setSettings?.({ buddyNotchPlace: saved });
    } catch (error) {
        console.error('Where the notch was left could not be saved:', error.message);
    }
    push({ place: placeOf() });
    return true;
}

function makeWindow(BrowserWindow, display) {
    const window = new BrowserWindow({
        ...windowBounds(display),
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        enableLargerThanScreen: true,
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: false,
            // Drawn while nothing of the app is in front, which is always.
            backgroundThrottling: false,
        },
    });
    // Above everything, in the way of nothing, in no picture of the screen.
    // ACESTES_CAPTURABLE leaves it in pictures, for recording a demo or
    // checking how it looks; the app never sets it.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true);
    // On a Mac, on every Space and over a full-screen app, as the agent's work may be.
    if (platform === 'darwin') window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    if (!process.env.ACESTES_CAPTURABLE) window.setContentProtection(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => {
        if (window.isDestroyed()) return;
        window.setBounds(windowBounds(display));
        window.showInactive();
    });
    window.loadURL(url(display.id));
    return window;
}

/** A window's renderer is listening: what it is, and what to draw now. */
function ready(sender) {
    for (const entry of windows.values()) {
        if (entry.window.isDestroyed() || entry.window.webContents !== sender) continue;
        entry.ready = true;
        hello(entry, primaryId());
        entry.window.webContents.send('buddy-state', state);
        if (lastCursor) entry.window.webContents.send('buddy-cursor', lastCursor);
        return true;
    }
    return false;
}

function hello(entry, primary) {
    if (entry.window.isDestroyed()) return;
    entry.window.webContents.send('buddy-hello', {
        displayId: entry.display.id,
        bounds: entry.display.bounds,
        primary: entry.display.id === primary,
    });
}

/** Whether a sender is one of the buddy's windows, for main to take its word. */
function isBuddyWindow(candidate) {
    for (const entry of windows.values()) {
        if (entry.window === candidate || entry.window.webContents === candidate) return true;
    }
    return false;
}

function sendAll(channel, payload) {
    for (const entry of windows.values()) {
        if (entry.ready && !entry.window.isDestroyed()) entry.window.webContents.send(channel, payload);
    }
}

function sendTo(displayId, channel, payload) {
    const entry = windows.get(displayId);
    if (!entry || entry.window.isDestroyed()) return false;
    entry.window.webContents.send(channel, payload);
    return true;
}

function push(patch = {}) {
    state = { ...state, ...patch };
    sendAll('buddy-state', state);
    if (state.phase === 'idle') leaveSoon();
}

/** Where the cursor is, told to the windows when it moves. */
function follow() {
    let point;
    try {
        point = electron.screen.getCursorScreenPoint();
    } catch {
        return;
    }
    if (lastCursor && lastCursor.x === point.x && lastCursor.y === point.y) return;
    lastCursor = { x: point.x, y: point.y };
    sendAll('buddy-cursor', lastCursor);
    reach(lastCursor);
}

/**
 * Where the cursor is this moment, for a buddy window's mark to follow
 * frame by frame: on a 144 or 165Hz display, the timer above moves its target
 * only every few frames, and that shows as steps. `lastCursor` is left alone,
 * so `follow` still sees every move and tells the other windows.
 */
function cursorNow(sender) {
    if (!present || !isBuddyWindow(sender)) return null;
    try {
        const point = electron.screen.getCursorScreenPoint();
        return { x: point.x, y: point.y };
    } catch {
        return null;
    }
}

/*
 * The one place the buddy can be clicked: the agents in its notch, while
 * they show. A window takes the mouse only while the pointer is over them,
 * and lets every click through again the moment it leaves, so nothing else
 * of it is ever in the way. It never takes focus either way (focusable:
 * false), so a click there leaves the app in front where it was.
 */

/** The window's clickable place, in its own CSS pixels, or null: told by the notch. */
function hit(sender, rect) {
    for (const entry of windows.values()) {
        if (entry.window.isDestroyed() || entry.window.webContents !== sender) continue;
        const ok = rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(Number(rect[key])))
            && rect.width > 0 && rect.height > 0 && rect.width < 4000 && rect.height < 4000;
        const bounds = entry.display.bounds;
        const opening = ok && !entry.hit;
        // CSS pixels are the display's own only at 100%: the app's zoom keys
        // reach these windows too, being the same page.
        let zoom = 1;
        try {
            zoom = Number(entry.window.webContents.getZoomFactor?.()) || 1;
        } catch {
            zoom = 1;
        }
        entry.hit = ok
            ? { x: bounds.x + Number(rect.x) * zoom, y: bounds.y + Number(rect.y) * zoom, width: Number(rect.width) * zoom, height: Number(rect.height) * zoom }
            : null;
        // The agents may have changed since they were last listed.
        if (opening) refreshRoster();
        if (lastCursor) reach(lastCursor);
        return true;
    }
    return false;
}

/** Each window takes the mouse only with the pointer over its clickable place. */
function reach(point) {
    for (const entry of windows.values()) {
        if (entry.window.isDestroyed()) continue;
        const area = entry.hit;
        const over = Boolean(area) && point.x >= area.x && point.x < area.x + area.width
            && point.y >= area.y && point.y < area.y + area.height;
        if (Boolean(entry.mouse) === over) continue;
        entry.mouse = over;
        entry.window.setIgnoreMouseEvents(!over);
    }
}

function refreshRoster() {
    const now = roster();
    if (JSON.stringify(now) !== JSON.stringify({ agents: state.agents, agentId: state.agentId })) push(now);
}

/* ------------------------------------------------------------------ *
 * Who it talks to
 * ------------------------------------------------------------------ */

/**
 * Talk to another agent from now on, picked in the notch or by the switch
 * key: saved as Settings saves it, and the next hold starts a conversation
 * with it. A turn the last one is still on carries on, and is still drawn,
 * until then. What was being said as the switch key went down is let go.
 */
function choose(agentId) {
    if (!enabled) return false;
    const listed = roster();
    const target = listed.agents.find(agent => agent.id === agentId);
    if (!target) return false;
    if (press) {
        sendTo(press.displayId, 'buddy-listen', { action: 'cancel' });
        dropPress();
        settleBack();
    }
    if (target.id !== listed.agentId) {
        config.agentId = target.id;
        freshNext = true;
        try {
            deps.setSettings?.({ buddyAgent: target.id });
        } catch (error) {
            console.error('The buddy\'s agent could not be saved:', error.message);
        }
    }
    switchSeq += 1;
    push({ agents: listed.agents, agentId: target.id, switcher: switchSeq });
    return true;
}

/** The switch key: the agent after this one, round to the first. */
function nextAgent() {
    const { agents, agentId } = roster();
    if (!agents.length) return false;
    const at = agents.findIndex(agent => agent.id === agentId);
    return choose(agents[(at + 1) % agents.length].id);
}

/** A click on an agent in the notch. */
function pick(sender, payload = {}) {
    if (!isBuddyWindow(sender)) return false;
    return choose(String(payload.agentId || ''));
}

/* ------------------------------------------------------------------ *
 * Stop, and open in the app: the notch's buttons while the agent works
 * ------------------------------------------------------------------ */

/**
 * Stop the turn the notch shows, the buddy's or a chat's, as the Stop button
 * in the app does. Said at once in the notch; the turn's own end then puts
 * it to rest.
 */
function stopTurn(sender) {
    if (!isBuddyWindow(sender)) return false;
    const id = shown;
    if (!id || !deps.ai?.isBusy?.(id)) return false;
    hush();
    push({ phase: state.action ? 'acting' : 'thinking', held: 'escape', ask: null, say: null });
    Promise.resolve(deps.ai.interrupt?.(id)).catch((error) => {
        notice(`Could not stop it: ${error.message}`);
    });
    return true;
}

/** The conversation the notch shows, else the buddy's own, brought up in the app as the tab in front. */
function openInApp(sender) {
    if (!isBuddyWindow(sender)) return false;
    const id = shown || conversationId;
    if (!id || !deps.ai?.has?.(id)) return false;
    tabbed.add(id);
    try {
        deps.openConversation?.(id);
    } catch (error) {
        console.error('The buddy\'s conversation could not be brought up:', error.message);
        return false;
    }
    return true;
}

function displayAtCursor() {
    try {
        return electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint()).id;
    } catch {
        return primaryId();
    }
}

/* ------------------------------------------------------------------ *
 * The agents at work on the desktop
 *
 * computer.js says who is driving whenever that changes (by way of
 * index.js, which names them). The first to take the desktop brings the
 * windows up; the newest is the one drawn, unless the notch is busy with
 * something else (someone talking to it, the buddy's own turn, a recap being
 * said), in which case it is counted and drawn next.
 * ------------------------------------------------------------------ */

const isBusy = id => Boolean(id) && Boolean(deps.ai?.isBusy?.(id));

function othersCount() {
    let count = 0;
    for (const id of drivers.keys()) if (id !== shown) count += 1;
    return count;
}

/**
 * Whether the notch may turn to another conversation: nobody is talking to
 * it, and the turn it shows is over. `settling` is the moment it comes back
 * from listening or a notice, when the phase still says so.
 */
function free({ settling = false } = {}) {
    if (press) return false;
    if (!settling && ['listening', 'hearing', 'looking', 'speaking'].includes(state.phase)) return false;
    return !isBusy(shown);
}

/** Draw this conversation's turn from here on, starting as it would be now: thinking. */
function focus(id) {
    const driver = drivers.get(id);
    shown = id;
    texts = [];
    clearTimeout(lingerTimer);
    clearTimeout(goneTimer);
    push({
        phase: 'thinking',
        mode: 'ask',
        toggle: false,
        chat: !owns(id),
        title: driver?.title || '',
        agent: driver?.agent || '',
        since: driver?.since || Date.now(),
        action: null,
        ask: null,
        said: '',
        held: driver?.held || '',
        reply: '',
        recap: '',
        notice: '',
        heard: '',
        point: null,
        drawing: null,
        say: null,
        others: othersCount(),
    });
}

/** Another agent still at work, the newest, drawn now; false when there is none, or the notch is not free. */
function refocus({ settling = false } = {}) {
    if (!present || !free({ settling })) return false;
    const next = [...drivers.keys()].reverse().find(id => id !== shown);
    if (!next) return false;
    focus(next);
    return true;
}

/**
 * Nothing at work to draw: the notch folds. A chat's turn shown until now is
 * let go, so its later turns (typed, with no desktop in them) are the app's
 * alone; the buddy's own stays, for the reply its notch shows on a hover.
 */
function rest(extra = {}) {
    const patch = { phase: 'idle', heard: '', toggle: false, ...extra };
    if (shown && !owns(shown)) {
        shown = '';
        Object.assign(patch, { chat: false, title: '', agent: '', action: null, ask: null, held: '', said: '', reply: '', recap: '' });
    }
    patch.others = othersCount();
    push(patch);
}

/** Who is at work on the desktop now: `[{ id, title, agent }]`, from computer.js by way of index.js. */
function setDrivers(list = []) {
    const now = new Map();
    for (const entry of Array.isArray(list) ? list : []) {
        const id = String(entry?.id || '');
        if (!id) continue;
        const before = drivers.get(id);
        now.set(id, {
            id,
            title: String(entry.title || before?.title || '').slice(0, 120),
            agent: String(entry.agent || before?.agent || '').slice(0, 40),
            since: before?.since || Date.now(),
            held: before?.held || '',
        });
    }
    const joined = [...now.keys()].filter(id => !drivers.has(id));
    const left = [...drivers.keys()].filter(id => !now.has(id));
    drivers.clear();
    for (const [id, entry] of now) drivers.set(id, entry);
    if (drivers.size > 0) appear();
    syncShortcut();
    if (!present) return;
    const newest = joined[joined.length - 1];
    // The one shown back at the desktop after its turn had ended (a chat's
    // next turn, its last reply still in the notch): a new stint, from the top.
    const again = Boolean(newest) && newest === shown && !press && !WORKING.has(state.phase)
        && !['listening', 'hearing', 'looking', 'speaking'].includes(state.phase);
    if (newest && ((newest !== shown && free()) || again)) {
        focus(newest);
    } else {
        if (left.includes(shown)) checkGone(shown);
        if (state.others !== othersCount()) push({ others: othersCount() });
        if (state.phase === 'idle') leaveSoon();
    }
}

/**
 * The turn shown let go of the desktop. Its end comes as an event, and it is
 * finished then; if none says so in a moment and it is no longer at work
 * (closed, say), it is finished here, so the notch is never left working.
 */
function checkGone(id) {
    clearTimeout(goneTimer);
    goneTimer = setTimeout(() => {
        if (shown !== id || drivers.has(id) || press) return;
        if (!WORKING.has(state.phase) || isBusy(id)) return;
        finish({});
    }, timing.gone);
}

/**
 * The voice key, pressed while an agent drives (computer.js `voice`, which
 * names the one to steer: one standing on a question first, else the
 * newest). Pressed once it listens, again it sends: on and off, not held.
 */
function voicePressed(id = '') {
    if (!present) return;
    if (press?.toggle) {
        released();
        return;
    }
    if (press) return;
    pressed({ toggle: true, target: String(id || '') });
}

/**
 * While a press of the voice key is listening and nobody drives any more
 * (the turn ended mid-sentence, or the user's hand paused them all), the
 * helper no longer sees the key, so it is held here as an accelerator for
 * the moment, to stop the recording with the keys that started it. Never
 * while an agent drives: the helper has the key then, and an accelerator
 * would also catch the agent's own typing of it.
 */
function syncShortcut() {
    const { globalShortcut } = electron;
    if (!globalShortcut) return;
    const watched = [...drivers.values()].some(entry => !entry.held);
    const want = present && Boolean(press?.toggle) && !watched;
    if (want === shortcutOn) return;
    try {
        if (want) {
            shortcutOn = globalShortcut.register(VOICE_ACCELERATOR, () => voicePressed(''));
        } else {
            globalShortcut.unregister(VOICE_ACCELERATOR);
            shortcutOn = false;
        }
    } catch (error) {
        console.error('Could not hold the voice key:', error.message);
        shortcutOn = false;
    }
}

/* ------------------------------------------------------------------ *
 * Holding the chord
 * ------------------------------------------------------------------ */

function onPtt(message = {}) {
    if (!enabled) return;
    // Sent from the helper's thread pool, which keeps no order.
    const seq = Number(message.seq) || 0;
    if (seq && seq <= lastSeq) return;
    if (seq) lastSeq = seq;
    // Listening on a press of the voice key: the chord coming up is not the end of it.
    if (press?.toggle && message.state !== 'next') return;
    if (message.state === 'down') pressed();
    else if (message.state === 'up') released();
    else if (message.state === 'cancel') cancelled();
    else if (message.state === 'next') nextAgent();
}

function voiceSettings() {
    let current = {};
    try {
        current = deps.settings?.get() || {};
    } catch {
        current = {};
    }
    return {
        enabled: current.voiceInput !== false,
        live: current.voiceEngine === 'parakeet' || current.voiceEngine === 'nemotron',
    };
}

/** The conversation is fresh enough to carry on, and still here. */
function carryOn() {
    if (!conversationId) return false;
    if (!deps.ai?.has?.(conversationId)) return false;
    if (deps.ai.isBusy?.(conversationId)) return true;
    return Date.now() - lastTurnAt < CARRY_ON_MS;
}

/** The buddy's conversation, started now if it has none or the last one went quiet long ago. */
function ensureConversation() {
    if (!freshNext && carryOn()) return conversationId;
    freshNext = false;
    const created = deps.ai.create({ agentId: config.agentId, scope: 'global' });
    // On the model, effort and mode a new tab starts on, as a conversation
    // a person opens at the desk is.
    deps.ai.startOnPick?.(created.conversationId);
    conversationId = created.conversationId;
    mine.add(conversationId);
    lastTurnAt = Date.now();
    return conversationId;
}

/**
 * The turn a hold of the chord steers: the one the notch shows, a chat's or
 * the buddy's, else the buddy's own still at work. None after a switch: what
 * is said then is for the new agent.
 */
function steerable() {
    if (freshNext) return '';
    if (isBusy(shown)) return shown;
    if (isBusy(conversationId)) return conversationId;
    return '';
}

/**
 * Start listening: the chord gone down, or the voice key pressed (`toggle`,
 * naming the agent at work it is for). Held, it steers the turn at work, or
 * asks the buddy afresh; pressed, it always steers the agent named.
 */
function pressed({ toggle = false, target: named = '' } = {}) {
    if (press || !present) return;
    clearTimeout(lingerTimer);
    // Talking over the buddy stops it.
    hush();
    if (deps.isLocked()) {
        notice('Acestes is locked. Unlock it first.');
        return;
    }
    const voice = voiceSettings();
    if (!voice.enabled) {
        notice('Voice input is switched off in Settings, under Chat.');
        return;
    }
    let target = '';
    let steering = false;
    if (toggle) {
        target = named || shown;
        if (!target) return;
        steering = true;
        // The one it is for is the one the notch shows while it listens.
        if (target !== shown) focus(target);
    } else {
        target = steerable();
        steering = Boolean(target);
        try {
            if (!steering) target = ensureConversation();
        } catch (error) {
            notice(`Could not start a conversation: ${error.message}`);
            return;
        }
    }
    // While the person talks, the runtime gets ready, so the first answer
    // does not wait on it starting. Nothing goes to a model.
    if (!steering) deps.ai.warm?.(target)?.catch?.(() => {});
    const displayId = displayAtCursor();
    // A new request is the buddy's own turn from here: whatever was drawn
    // before (a chat at rest, its own last reply) gives way to it.
    const asking = steering ? {} : {
        action: null, ask: null, held: '', said: '', chat: false, title: '', agent: '',
    };
    if (!steering) shown = target;
    press = {
        seq: lastSeq,
        at: Date.now(),
        mode: steering ? 'steer' : 'ask',
        toggle,
        displayId,
        conversationId: target,
        looking: null,
        timer: setTimeout(() => released(), HOLD_LIMIT_MS),
    };
    syncShortcut();
    push({
        ...asking,
        phase: 'listening',
        mode: press.mode,
        toggle,
        others: othersCount(),
        heard: '',
        notice: '',
        reply: steering ? state.reply : '',
        point: null,
        // What it drew goes as they start talking again.
        drawing: null,
        // Talking over a reply being read out stops it.
        say: null,
    });
    sendTo(displayId, 'buddy-listen', { action: 'start', live: voice.live });
}

function released() {
    if (!press || press.releasedAt) return;
    press.releasedAt = Date.now();
    clearTimeout(press.timer);
    sendTo(press.displayId, 'buddy-listen', { action: 'stop' });
    // The picture is of what is on the screen as they let go, as Clicky's
    // is: by then they have pointed at what they meant.
    if (press.mode === 'ask' && press.releasedAt - press.at >= SLIP_MS) press.looking = deps.computer.look();
    push({ phase: 'hearing' });
}

function cancelled() {
    if (!press) return;
    sendTo(press.displayId, 'buddy-listen', { action: 'cancel' });
    dropPress();
    settleBack();
}

function dropPress() {
    clearTimeout(press?.timer);
    press = null;
    syncShortcut();
}

/** Back to whatever the turn shown is doing, or to another agent at work, or to rest. */
function settleBack() {
    if (isBusy(shown)) push({ phase: state.action ? 'acting' : 'thinking', heard: '', toggle: false });
    else if (!refocus({ settling: true })) rest();
}

/**
 * From the window listening: the words so far, the words at the end, or a
 * word of trouble (no microphone, nothing heard). Trouble while still
 * listening ends it; "nothing heard" just after an empty end is said,
 * unless the hold was a slip of the hand.
 */
function heard(sender, payload = {}) {
    if (typeof payload.notice === 'string') {
        const text = payload.notice.trim();
        if (!text) return;
        if (press && !press.releasedAt) {
            sendTo(press.displayId, 'buddy-listen', { action: 'cancel' });
            dropPress();
            notice(text);
        } else if (lastEmpty && Date.now() - lastEmpty.at < 2000 && !lastEmpty.slip) {
            lastEmpty = null;
            notice(text);
        }
        return;
    }
    if (!press) return;
    const text = String(payload.text || '').trim();
    if (!payload.final) {
        if (text !== state.heard) push({ heard: text.slice(-400) });
        return;
    }
    const taken = press;
    dropPress();
    if (!text) {
        lastEmpty = { at: Date.now(), slip: !taken.releasedAt || taken.releasedAt - taken.at < SLIP_MS };
        settleBack();
        return;
    }
    push({ heard: text });
    act(taken, text).catch((error) => {
        notice(`Could not send that: ${error.message}`);
    });
}

/** Where the pointer is now, as a pixel of a conversation's latest screenshot, said in words. */
function pointerWords(id) {
    try {
        const { screen } = electron;
        const dip = screen.getCursorScreenPoint();
        const physical = typeof screen.dipToScreenPoint === 'function' ? screen.dipToScreenPoint(dip) : dip;
        const at = deps.computer.screenToFrame(id, physical.x, physical.y);
        return at ? `(pointing at ${at.x},${at.y} in your latest screenshot)` : '';
    } catch {
        return '';
    }
}

async function act(taken, text) {
    // Still at work, or a chat's turn: what was said steers the turn, or
    // answers its question; a chat whose turn ended while they spoke gets it
    // as its next message (see `steer` in index.js), not the buddy.
    const target = taken.conversationId;
    if (taken.mode === 'steer' && (deps.ai.isBusy(target) || !owns(target))) {
        const where = pointerWords(target);
        const result = await deps.ai.steer(target, where ? `${text} ${where}` : text);
        if (!result?.success) {
            notice(result?.message || 'That did not reach the agent.');
            return;
        }
        if (shown === target) {
            push({
                phase: state.action ? 'acting' : 'thinking',
                toggle: false,
                ask: result.answered ? null : state.ask,
                said: result.answered ? 'Answered' : 'Got it',
            });
        }
        return;
    }

    // A new request, or the buddy's turn ended while they spoke: a message,
    // with the picture of what they are looking at.
    push({ phase: 'looking', toggle: false });
    const look = await (taken.looking || deps.computer.look());
    const id = taken.mode === 'ask' ? target : ensureConversation();
    if (!deps.ai.has?.(id)) {
        notice('The conversation was closed. Try again.');
        return;
    }
    if (look?.ok) deps.computer.seed(id, look.frame);
    const note = noteFor(id, look);
    briefed.add(id);
    conversationId = id;
    mine.add(id);
    shown = id;
    // In the app too, as a tab beside the others: there it can be read in
    // full and stopped. Opened in the background, once, as the first message
    // goes; the app is not brought up over what the person is doing.
    if (!tabbed.has(id)) {
        tabbed.add(id);
        try {
            deps.showConversation?.(id);
        } catch (error) {
            console.error('The buddy\'s conversation could not be opened in the app:', error.message);
        }
    }
    texts = [];
    lastTurnAt = Date.now();
    push({
        phase: 'thinking', since: Date.now(), action: null, ask: null, reply: '', said: '', held: '',
        chat: false, title: '', agent: '', others: othersCount(),
    });
    const result = await deps.ai.send(id, text, look?.ok ? [look.image] : [], [], [], { spoken: true, note });
    if (!result?.success) notice(result?.message || 'The agent did not take that.');
}

/**
 * What the agent is told with the message: the first time, how the buddy
 * works and how to answer through it; after that, only what this picture is.
 */
function noteFor(id, look) {
    const picture = look?.ok
        ? (look.pointer
            ? `The picture with this message is the monitor their pointer is on, taken as they let go of the keys. The red ring at (${look.pointer[0]}, ${look.pointer[1]}) is the tip of their pointer: "this", "that", "here" and "it" mean what is under the ring. The picture is ${look.width}x${look.height} and it is already your latest screenshot: x and y in click, scroll, drag and hover can be pixels of it, so the first action needs no screenshot before it.`
            : `The picture with this message is the monitor their pointer is on, ${look.width}x${look.height}, and it is already your latest screenshot.`)
        : `No picture of their screen could be taken (${look?.error || 'unknown reason'}): take a screenshot before acting.`;
    // How the spoken lines sound, as set now: it may have changed since the
    // last message, so it is said every time.
    const said = tones.brief(config.tone, { cues: canCue() });
    if (briefed.has(id)) {
        return `Said through the buddy again, by voice. ${picture} ${said.short}, and point with [POINT:x,y:label] or draw with [CIRCLE], [HIGHLIGHT], [ARROW] and [UNDERLINE] when it helps.`;
    }
    return [
        'The user is talking to you through the Acestes buddy: they held Ctrl+Alt wherever they were on their desktop and spoke, so this message is their speech, transcribed (allow for misheard words). Acestes stays in the background meanwhile: they are looking at their own screen, not at this chat, and do not read your replies as you work.',
        picture,
        'How to work:',
        '- Do what they ask straight away with the computer tools. Do not ask before ordinary steps; ask only when the request is truly unclear, or would delete or send something that cannot be taken back.',
        `- End every turn with one line: [SAY: a spoken recap of what you did or found, ${said.length}, plain speech with no square brackets, symbols or links]. Only that line is read aloud to them; the rest of your reply is there to read later and may be as long as it needs.`,
        ...(said.voice ? [`- Your spoken lines (the [SAY] recap, and any question you ask them) are in this voice: ${said.voice}. The work itself, and the rest of your reply, stay as careful as ever.`] : []),
        ...(said.cueLine ? [`- ${said.cueLine}`] : []),
        '- When they ask where something is, or how to do something themselves, point rather than act: also end your reply with [POINT:x,y:label], x and y in pixels of your latest screenshot and the label one to three words, and the buddy flies there. Leave it out when there is nothing to point at.',
        `- To show rather than tell (where to click, what to look at, the steps in order, what a part of the screen is), draw on their screen too, up to ${MOST_SHAPES} shapes at the end of your reply, in the order to look at them: [CIRCLE:x,y,r:label] a loop around a button or icon, x,y its centre and r its radius; [HIGHLIGHT:x,y,w,h:label] a box over a region, x,y its top left corner; [ARROW:x1,y1,x2,y2:label] an arrow from x1,y1 to the thing at x2,y2, the label written at its tail; [UNDERLINE:x,y,w:label] a line under some words, from x to x+w along their baseline y. All in pixels of your latest screenshot, on the exact thing; the label is one to four words and may be left out ([CIRCLE:x,y,r]). They are drawn as your recap is said and fade a few seconds later. For steps, number the labels (1 Settings, 2 Privacy). Draw only what helps; most replies need none.`,
        '- They can hold Ctrl+Alt again while you work: what they say then reaches you as a <user-steer>. A question you ask them is read aloud too, so keep it short.',
    ].join('\n');
}

/**
 * Whether the voice can perform delivery cues ({laughs}): Eleven v4 can,
 * as audio tags, and only when the tone wants them. Any other voice would
 * read them out, so the agent is not offered them.
 */
function canCue() {
    return config.speak && config.voice === 'elevenlabs' && (config.voiceModel || elevenlabs.DEFAULT_MODEL) === 'eleven_v4'
        && tones.expressive(config.tone);
}

function notice(text) {
    clearTimeout(lingerTimer);
    push({ phase: 'notice', notice: String(text || '').slice(0, 240), heard: '', toggle: false });
    lingerTimer = setTimeout(() => settleBack(), timing.notice);
}

/* ------------------------------------------------------------------ *
 * The turn, as it goes
 * ------------------------------------------------------------------ */

/** A tool call's input, kept small: a line of it at most is shown. */
function slim(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') out[key] = value.slice(0, 120);
        else if (typeof value !== 'object' || value === null) out[key] = value;
        else if (key === 'steps' && Array.isArray(value)) out.steps = value.slice(0, 12).map(step => ({ do: step?.do }));
    }
    return out;
}

function onEvent(event, info) {
    if (!present || !info?.conversationId) return;
    const id = info.conversationId;
    // A chat at work but not drawn yet keeps its name for when it is.
    if (event.type === 'title' && drivers.has(id) && event.title) drivers.get(id).title = String(event.title).slice(0, 120);
    if (id !== shown) {
        // A message typed into the buddy's own tab, with nothing else drawn: its turn is drawn.
        if (!(id === conversationId && !shown && event.type === 'user-message' && !info.remembering)) return;
        shown = id;
    }
    // The note-taking turn after a real one is the app's, not the person's.
    if (info.remembering) return;
    if (event.type === 'title') {
        push({ title: String(event.title || '') });
        return;
    }
    // A subagent's work, or a child conversation's, is not this turn's.
    if (event.parentId || event.via) return;
    // Spoken to, it speaks; a chat's turn is shown and never said.
    const voiced = owns(id);
    // A chat is drawn while it uses the computer, and as that turn ends;
    // the rest of what it does is the app's to show.
    if (!voiced && (ENDINGS.has(event.type) ? !WORKING.has(state.phase) : !drivers.has(id))) return;
    const listening = Boolean(press);
    switch (event.type) {
        case 'user-message':
            texts = [];
            if (voiced) lastTurnAt = Date.now();
            if (!listening && state.phase !== 'thinking') push({ phase: 'thinking', since: Date.now(), reply: '', action: null });
            return;
        case 'tool-call':
            actionSeq += 1;
            // What it said before a tool call was narration; the reply is
            // what it says after the last one.
            if (texts.length) push({ said: texts[texts.length - 1].replace(/\s+/g, ' ').slice(0, 160) });
            texts = [];
            push({
                ...(listening ? {} : { phase: 'acting' }),
                action: { name: event.name || '', input: slim(event.input), aim: '', seq: actionSeq },
            });
            return;
        case 'tool-result':
            push({ ...(listening ? {} : { phase: 'thinking' }), action: null });
            return;
        case 'assistant-text':
            if (event.text) texts.push(String(event.text));
            return;
        case 'approval-request':
        case 'question-request': {
            const ask = event.type === 'question-request'
                ? {
                    question: String(event.question || '').slice(0, 240),
                    options: event.secret ? [] : (event.options || []).slice(0, 4).map(option => String(option).slice(0, 40)),
                }
                : { question: `Allow: ${String(event.title || event.name || 'this step').slice(0, 200)}?`, options: ['Yes', 'No'] };
            // Said aloud too, in the buddy's own turns: it is answered by
            // voice, often without looking up at the notch.
            const said = listening || !voiced ? null : speak(questionWords(ask));
            push({
                ...(listening ? {} : { phase: 'waiting' }),
                action: null,
                ask,
                ...(said ? { say: said } : {}),
            });
            return;
        }
        case 'approval-settled':
        case 'question-settled':
            push({ ...(listening ? {} : { phase: 'thinking' }), ask: null });
            return;
        case 'interrupted':
            finish({ stopped: true });
            return;
        case 'result':
            if (event.isError && event.subtype !== 'success') finish({ error: `The run ended early (${event.subtype || 'error'}).` });
            else finish({});
            return;
        case 'error':
            finish({ error: event.message || 'The agent reported an error.' });
            return;
        case 'closed':
            finish({ error: 'The agent stopped before it finished.' });
            return;
        default:
            break;
    }
}

const POINT_TAG = /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]]*?))?)\]/gi;
const SAY_TAG = /\[SAY:\s*([^\]]*?)\s*\]/gi;
/**
 * A drawing: its kind, its numbers, and a label after a colon if it has one.
 * Any such tag comes out of the reply; only one whose numbers make a shape is drawn.
 */
const SHAPE_TAG = /\[(CIRCLE|HIGHLIGHT|ARROW|UNDERLINE):([^\]:]*)(?::([^\]]*))?\]/gi;
/** How many numbers each kind takes, and what they are. */
const SHAPE_FIELDS = {
    circle: ['x', 'y', 'r'],
    highlight: ['x', 'y', 'w', 'h'],
    arrow: ['x1', 'y1', 'x2', 'y2'],
    underline: ['x', 'y', 'w'],
};

/** A drawing tag's numbers as a shape, in pixels of the screenshot, or null when they do not make one. */
function shapeOf(kind, numbers, label) {
    const fields = SHAPE_FIELDS[kind];
    const values = String(numbers || '').split(',').map(part => Number(part.trim()));
    if (values.length !== fields.length || values.some(value => !Number.isFinite(value))) return null;
    const shape = { kind, label: String(label || '').trim().slice(0, 40) };
    fields.forEach((field, index) => { shape[field] = Math.max(0, Math.round(values[index])); });
    // Too small to see is not drawn: a ring of no size, a box with no area, an arrow with no length.
    if (kind === 'circle' && shape.r < 2) return null;
    if (kind === 'highlight' && (shape.w < 2 || shape.h < 2)) return null;
    if (kind === 'arrow' && Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 8) return null;
    if (kind === 'underline' && shape.w < 4) return null;
    return shape;
}

/**
 * A reply's tags, and the reply without them: its last [POINT] (where the
 * mark flies), its last [SAY] (the recap read aloud), and what it draws, in
 * the order written, a few at most.
 */
function readTags(text) {
    let point = null;
    let recap = '';
    const shapes = [];
    const body = String(text || '')
        .replace(POINT_TAG, (all, x, y, label) => {
            point = x !== undefined && y !== undefined
                ? { x: Number(x), y: Number(y), label: String(label || '').replace(/:screen\d+$/i, '').trim().slice(0, 40) }
                : null;
            return '';
        })
        .replace(SAY_TAG, (all, words) => {
            recap = String(words || '').trim();
            return '';
        })
        .replace(SHAPE_TAG, (all, kind, numbers, label) => {
            const shape = shapeOf(kind.toLowerCase(), numbers, label);
            if (shape && shapes.length < MOST_SHAPES) shapes.push(shape);
            return '';
        });
    return { body: body.replace(/[ \t]+\n/g, '\n').trim(), point, recap, shapes };
}

/**
 * What is read aloud at the end of a turn: the agent's own recap, else the
 * first sentence or two of its reply. Never the whole reply: a turn of
 * computer use can end in paragraphs nobody wants read to them.
 */
function recapOf(body, recap) {
    if (recap) return speakable(recap);
    const plain = speakable(body);
    if (plain.length <= RECAP_CHARS) return plain;
    const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [];
    let out = '';
    for (const sentence of sentences) {
        if (out && (out + sentence).length > RECAP_CHARS) break;
        out += sentence;
    }
    out = out.trim();
    // One sentence that runs on is cut at a word.
    if (!out || out.length > RECAP_CHARS + 60) out = `${plain.slice(0, RECAP_CHARS).replace(/\s+\S*$/, '')}.`;
    return out;
}

/** A question as it is said: the question, and its choices when there are few. */
function questionWords(ask) {
    const options = ask?.options || [];
    const choices = options.length > 1 && options.length <= 3 ? ` ${options.slice(0, -1).join(', ')} or ${options[options.length - 1]}?` : '';
    return speakable(`${ask?.question || ''}${choices}`);
}

/** A reply as it is said: no markdown, no code, no links, no tag. */
function speakable(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, 'the link')
        .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
        .replace(/[*_~>|]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SPEAK_CHARS);
}

function finish({ error = '', stopped = false } = {}) {
    clearTimeout(goneTimer);
    // The buddy's own turn speaks, points and draws; a chat's is shown only.
    const voiced = owns(shown);
    if (voiced) lastTurnAt = Date.now();
    const { body, point, recap, shapes } = readTags(texts.join('\n\n'));
    texts = [];
    // As said, delivery cues and all; and as shown, without them.
    const short = recapOf(body, recap);
    const plain = tones.withoutCues(short);
    if (press) {
        // They are talking already: what this turn said waits in the notch.
        push({ action: null, ask: null, reply: body, recap: plain, said: '' });
        return;
    }
    if (error) {
        notice(error);
        return;
    }
    if (stopped) {
        if (!refocus({ settling: true })) rest({ action: null, ask: null, held: '' });
        return;
    }
    const drawn = voiced ? shapes.map(sketch).filter(Boolean) : [];
    const drawing = drawn.length ? { at: Date.now(), shapes: drawn } : null;
    // With a drawing and nowhere named to point, the mark goes to the first
    // thing drawn, as the hand that draws it, saying nothing of its own.
    const named = voiced && point ? place(point) : null;
    const spot = named || (drawn.length ? { ...anchorOf(drawn[0]), label: '', at: Date.now() } : null);
    const say = voiced ? speak(short) : null;
    push({
        phase: say ? 'speaking' : 'done',
        action: null,
        ask: null,
        held: '',
        said: '',
        reply: body,
        recap: plain,
        point: spot,
        drawing,
        say,
    });
    if (spot) {
        clearTimeout(pointTimer);
        pointTimer = setTimeout(() => push({ point: null }), POINT_MS + 2000);
    }
    // Up while it is said, and a while after (see `spoke`); with nothing to say, a while from now.
    if (drawing) eraseLater(drawing, say?.text ? DRAW_LIMIT_MS : DRAW_MS);
    if (!say?.text) linger();
}

/** A pixel of the agent's latest screenshot, as a point on the desktop (DIPs) the windows draw on, or null. */
function toDesk(x, y) {
    const physical = deps.computer.frameToScreen(shown || conversationId, x, y);
    if (!physical) return null;
    let dip = physical;
    try {
        if (typeof electron.screen?.screenToDipPoint === 'function') dip = electron.screen.screenToDipPoint(physical);
    } catch {
        dip = physical;
    }
    return { x: Math.round(dip.x), y: Math.round(dip.y) };
}

/** A point of the agent's latest screenshot, as a place on the desktop the windows draw on. */
function place(point) {
    const at = toDesk(point.x, point.y);
    return at ? { ...at, label: point.label || '', at: Date.now() } : null;
}

/**
 * A shape in the screenshot's pixels, as one on the desktop. Its corners go
 * through the screenshot's frame; its sizes by how big a pixel of it is,
 * since a far corner would be held to the screenshot's edge.
 */
function sketch(shape) {
    const origin = toDesk(0, 0);
    const across = toDesk(50, 0);
    if (!origin || !across) return null;
    const size = value => Math.max(1, Math.round(value * ((across.x - origin.x) / 50 || 1)));
    const label = shape.label || '';
    if (shape.kind === 'arrow') {
        const from = toDesk(shape.x1, shape.y1);
        const to = toDesk(shape.x2, shape.y2);
        return from && to ? { kind: 'arrow', x1: from.x, y1: from.y, x2: to.x, y2: to.y, label } : null;
    }
    const at = toDesk(shape.x, shape.y);
    if (!at) return null;
    if (shape.kind === 'circle') return { kind: 'circle', ...at, r: size(shape.r), label };
    if (shape.kind === 'highlight') return { kind: 'highlight', ...at, w: size(shape.w), h: size(shape.h), label };
    if (shape.kind === 'underline') return { kind: 'underline', ...at, w: size(shape.w), label };
    return null;
}

/** Where the mark goes to draw a shape: beside its loop, at the box's far corner, at the arrow's tail, at the line's end. */
function anchorOf(shape) {
    switch (shape.kind) {
        case 'circle':
            return { x: Math.round(shape.x + shape.r * 0.72), y: Math.round(shape.y + shape.r * 0.72) };
        case 'highlight':
            return { x: shape.x + shape.w, y: shape.y + shape.h };
        case 'arrow':
            return { x: shape.x1, y: shape.y1 };
        default:
            return { x: shape.x + shape.w, y: shape.y };
    }
}

/** The drawing goes in a while, unless another has taken its place by then. */
function eraseLater(drawing, ms) {
    clearTimeout(drawTimer);
    drawTimer = setTimeout(() => {
        if (state.drawing && state.drawing.at === drawing.at) push({ drawing: null });
    }, ms);
}

/* ------------------------------------------------------------------ *
 * Speaking
 *
 * Only ever a recap or a question, a sentence or so: the reply itself is
 * in the notch and the conversation. In this computer's voice (the
 * renderer's speechSynthesis), or ElevenLabs', streamed from here to the
 * window on the main display as it comes; if ElevenLabs cannot, that one
 * time it is this computer's voice, and the notch says why.
 * ------------------------------------------------------------------ */

/** The ElevenLabs key, from the keychain, as the buddy's agent sees it (its own, else the shared one). */
function voiceKey() {
    try {
        const agentId = deps.settings?.get(config.agentId || undefined)?.agentId || '';
        return deps.secrets?.read(elevenlabs.SECRET, agentId) || '';
    } catch {
        return '';
    }
}

/**
 * Say something: the `say` the windows are given to say it by, or null when
 * the buddy is not to speak. ElevenLabs' audio is started here and follows
 * the state to the window as `buddy-audio`.
 */
function speak(text) {
    hush();
    const words = String(text || '').trim().slice(0, SPEAK_CHARS);
    // Without its cues: what the notch shows, and what any voice but Eleven v4 says.
    const plain = tones.withoutCues(words);
    if (!config.speak || !plain) return null;
    const key = config.voice === 'elevenlabs' ? voiceKey() : '';
    const tone = config.tone;
    const say = {
        id: ++sayId,
        text: plain,
        engine: key ? 'elevenlabs' : 'system',
        rate: deps.tts.RATE,
        // This computer's voice, in the tone: how fast, and how high.
        pace: tone.pace,
        pitch: tone.pitch,
    };
    if (config.voice === 'elevenlabs' && !key) say.trouble = 'No ElevenLabs key yet, so this computer\'s voice. Add the key in Settings.';
    if (key) stream(say, key, words);
    return say;
}

function stream(say, key, words = say.text) {
    const controller = new AbortController();
    speaking = { id: say.id, controller };
    const to = primaryId();
    const model = config.voiceModel || elevenlabs.DEFAULT_MODEL;
    // Eleven v4 performs the cues as its audio tags; Flash would read them out.
    const text = model === 'eleven_v4' ? tones.cuesAsTags(words) : tones.withoutCues(words);
    // After this tick, so the state carrying `say` reaches the window first.
    Promise.resolve().then(() => deps.tts.stream({
        key,
        text,
        voiceId: config.voiceId,
        model: config.voiceModel,
        voiceSettings: tones.voiceSettings(config.tone, model),
        signal: controller.signal,
        onAudio: chunk => sendTo(to, 'buddy-audio', { id: say.id, chunk }),
    })).then(() => {
        sendTo(to, 'buddy-audio', { id: say.id, done: true });
    }).catch((error) => {
        if (controller.signal.aborted) return;
        // Said in this computer's voice instead, and why on the notch.
        sendTo(to, 'buddy-audio', { id: say.id, error: error.message });
        if (state.say?.id === say.id) push({ say: { ...state.say, engine: 'system', trouble: error.message } });
    }).finally(() => {
        if (speaking?.id === say.id) speaking = null;
    });
}

/** Stop whatever ElevenLabs is still sending. */
function hush() {
    if (!speaking) return;
    speaking.controller.abort();
    speaking = null;
}

/** The recap has been said (or could not be): it stays a moment, then the notch folds. */
function spoke(sender, payload = {}) {
    if (!state.say || Number(payload.id) !== state.say.id) return;
    if (state.phase === 'speaking') push({ phase: 'done', say: null });
    else push({ say: null });
    // Said: what it drew stays a few seconds more, to be looked at.
    if (state.drawing) eraseLater(state.drawing, DRAW_MS);
    if (state.phase === 'done') linger();
}

/**
 * A finished turn's reply stays a while, then the notch folds; or, with
 * another agent at work on the desktop, it stays a beat and that one is drawn.
 */
function linger() {
    clearTimeout(lingerTimer);
    const next = [...drivers.keys()].some(id => id !== shown);
    lingerTimer = setTimeout(() => {
        if (state.phase !== 'done') return;
        if (!refocus()) rest();
    }, next ? timing.beat : timing.reply);
}

/** What the action under way is aimed at, by name, once the helper has found it. */
function aimed(id, label) {
    if (!present || id !== shown || !state.action || !label) return;
    push({ action: { ...state.action, aim: String(label).slice(0, 120) } });
}

/** The person's hand stopped the agents: took over the mouse or keyboard, or pressed Esc. */
function held(ids = [], code = 'took-over') {
    const how = code === 'escape' ? 'escape' : 'took-over';
    for (const id of ids) {
        const driver = drivers.get(id);
        if (driver) driver.held = how;
    }
    syncShortcut();
    if (!present || !ids.includes(shown)) return;
    push({ held: how, action: null });
}

/** For the settings card: on, who it talks to, and what stands in its way. */
function status() {
    let current = {};
    try {
        current = deps.settings?.get(config.agentId || undefined) || {};
    } catch {
        current = {};
    }
    return {
        supported: supported(),
        enabled,
        agentId: current.agentId || '',
        computerUse: Boolean(current.computerUse),
        voiceInput: current.voiceInput !== false,
        // Whether the keychain holds an ElevenLabs key this agent can use. Whether, never which.
        voiceKey: Boolean(deps.secrets?.has(elevenlabs.SECRET, current.agentId || '')),
        conversationId,
    };
}

/**
 * Settings' "Try it": a sentence in the tone picked, so it can be heard
 * with the buddy off. In the ElevenLabs voice and model picked, handed back
 * whole for the settings window to play; or, for this computer's voice (or
 * `engine: 'system'`), the words with their pace and pitch, which the
 * settings window says itself.
 */
async function tryVoice({ voiceId = '', model = '', tone: toneName = '', note = null, engine = '' } = {}) {
    const tone = tones.toneOf({
        buddyTone: toneName || config.tone.name,
        buddyToneNote: note === null ? config.tone.note : note,
    });
    const system = { text: tones.withoutCues(tone.sample), pace: tone.pace, pitch: tone.pitch };
    if ((engine || config.voice) !== 'elevenlabs') return { system };
    const key = voiceKey();
    if (!key) return { error: 'There is no ElevenLabs key yet.' };
    const chosen = model || config.voiceModel || elevenlabs.DEFAULT_MODEL;
    const chunks = [];
    try {
        const { rate } = await deps.tts.stream({
            key,
            text: chosen === 'eleven_v4' ? tones.cuesAsTags(tone.sample) : tones.withoutCues(tone.sample),
            voiceId,
            model: chosen,
            voiceSettings: tones.voiceSettings(tone, chosen),
            onAudio: chunk => chunks.push(Buffer.from(chunk)),
        });
        return { rate, data: Buffer.concat(chunks).toString('base64') };
    } catch (error) {
        return { error: error.message };
    }
}

/** The voices on the ElevenLabs account, for Settings to offer. */
async function voices() {
    const key = voiceKey();
    if (!key) return { error: 'There is no ElevenLabs key yet.' };
    return deps.tts.voices(key);
}

/**
 * Everything of it gone: the main window closed for real, or (`final`) the
 * app quitting, after which nothing brings it up again.
 */
function shutdown({ final: last = false } = {}) {
    if (last) final = true;
    if (enabled) stop();
    leave();
}

module.exports = {
    CHORD,
    configure,
    sync,
    isOn,
    isPresent,
    owns,
    // Who is at work on the desktop, and the voice key pressed while they are.
    drivers: setDrivers,
    voice: voicePressed,
    ready,
    isBuddyWindow,
    onPtt,
    heard,
    spoke,
    hit,
    pick,
    moveNotch,
    cursorNow,
    stopTurn,
    openInApp,
    aimed,
    held,
    status,
    tryVoice,
    voices,
    shutdown,
    conversation: () => conversationId,
    _test: {
        readTags,
        recapOf,
        questionWords,
        speakable,
        noteFor,
        roster,
        // Each window's clickable place and whether it takes the mouse now.
        reach: () => [...windows.values()].map(entry => ({ displayId: entry.display.id, hit: entry.hit || null, mouse: Boolean(entry.mouse) })),
        state: () => state,
        shown: () => shown,
        reset: () => {
            enabled = false;
            press = null;
            lastSeq = 0;
            freshNext = false;
            conversationId = '';
            shown = '';
            drivers.clear();
            mine.clear();
            briefed.clear();
            tabbed.clear();
            texts = [];
            state = fresh();
        },
        enable: () => {
            enabled = true;
            present = true;
            if (!unobserve && deps.ai?.observe) unobserve = deps.ai.observe(onEvent);
        },
        setElectron: (value) => { electron = value; },
        setPlatform: (value) => { platform = value; },
        // Shorter waits, for a test: `{ reply, notice, beat, gone, leave }` in milliseconds.
        setTiming: (patch) => { timing = { ...TIMING, ...(patch || {}) }; },
    },
};
