/**
 * The buddy: Acestes in the background, beside the cursor.
 *
 * Switched on in Settings (`buddy`), the app keeps out of the way: closing
 * its window leaves it running in the tray, and what shows of it is a notch
 * at the top of the main screen and a small mark that rides beside the
 * cursor. Hold Ctrl+Alt anywhere and say what you want. On letting go, a
 * picture of the monitor the pointer is on is taken, with the pointer's tip
 * ringed on it, and goes to the agent with what was said; the agent works
 * with the computer tools at once, and its reply is read aloud. "This" and
 * "here" mean what the pointer is on.
 *
 * Nothing of it is in the way: its windows never take focus, every click
 * goes through them, and they are kept out of screen capture, so the agent's
 * own screenshots never show them. The person's mouse stays theirs until the
 * agent acts, and the mark beside the cursor says what it is doing as it
 * does it (looking, clicking "Save", waiting for you).
 *
 *   the chord    seen by the desktop helper's keyboard hook (computer.js
 *                `pushToTalk`), driving or not. Down starts the microphone in
 *                the buddy's window under the cursor, up stops it, another
 *                key while it is held (Ctrl+Alt+T) throws it away.
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
 * One window per display, each the size of it: transparent, click-through,
 * topmost. Each draws the mark when the cursor is on its display; the one on
 * the main display draws the notch and does the talking. The cursor is
 * looked at here sixty times a second while the buddy is on, and told to the
 * windows only when it moves. Windows only for now: the Mac helper does not
 * watch modifiers on their own yet.
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
/** How often the cursor is looked at while the buddy is on, in milliseconds. */
const FOLLOW_EVERY = 16;
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

let enabled = false;
let config = { notch: true, speak: true, agentId: '', voice: 'system', voiceModel: '', voiceId: '', tone: tones.toneOf({}) };
// The recap being read out by ElevenLabs: its id, and how to stop it.
let speaking = null;
let baseUrl = '';
// displayId -> { window, display, ready }
const windows = new Map();
let screenListening = false;
let followTimer = null;
let lastCursor = null;

// The conversation the buddy talks in, and every one it has, so their
// work on the desktop is shown here and not in the corner card too.
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
        point: null,
        // What it drew on the screen: { at, shapes: [{ kind, ..., label }] } in DIPs, or null.
        drawing: null,
        notch: true,
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

function supported() {
    return platform === 'win32';
}

function isOn() {
    return enabled;
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
    else if (enabled) {
        const now = roster();
        // Pointed at another agent in Settings: the next hold talks to it.
        if (before && now.agentId !== before) freshNext = true;
        push({ notch: config.notch, ...now });
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

async function start() {
    const { BrowserWindow, screen } = electron;
    if (typeof BrowserWindow !== 'function') return;
    enabled = true;
    state = { ...fresh(), notch: config.notch, ...roster() };
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
    const armed = await deps.computer?.pushToTalk(CHORD, { next: SWITCH_KEY });
    if (armed && !armed.ok) notice(`Ctrl+Alt is not being watched: ${armed.error || 'the desktop helper did not start'}.`);
    deps.changed(true);
}

function stop() {
    enabled = false;
    hush();
    if (press) dropPress();
    deps.computer?.pushToTalk('').catch?.(() => {});
    if (followTimer) clearInterval(followTimer);
    followTimer = null;
    lastCursor = null;
    clearTimeout(lingerTimer);
    clearTimeout(pointTimer);
    clearTimeout(drawTimer);
    unobserve?.();
    unobserve = null;
    for (const entry of windows.values()) {
        if (!entry.window.isDestroyed()) entry.window.destroy();
    }
    windows.clear();
    deps.changed(false);
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
    if (!enabled) return;
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
 * Stop the turn under way, as the Stop button in the app does. Said at once
 * in the notch; the turn's own end then puts it to rest.
 */
function stopTurn(sender) {
    if (!isBuddyWindow(sender)) return false;
    const id = conversationId;
    if (!id || !deps.ai?.isBusy?.(id)) return false;
    hush();
    push({ phase: state.action ? 'acting' : 'thinking', held: 'escape', ask: null, say: null });
    Promise.resolve(deps.ai.interrupt?.(id)).catch((error) => {
        notice(`Could not stop it: ${error.message}`);
    });
    return true;
}

/** The buddy's conversation, brought up in the app as the tab in front. */
function openInApp(sender) {
    if (!isBuddyWindow(sender)) return false;
    const id = conversationId;
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
 * Holding the chord
 * ------------------------------------------------------------------ */

function onPtt(message = {}) {
    if (!enabled) return;
    // Sent from the helper's thread pool, which keeps no order.
    const seq = Number(message.seq) || 0;
    if (seq && seq <= lastSeq) return;
    if (seq) lastSeq = seq;
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

function pressed() {
    if (press) return;
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
    // Not after a switch: what is said then is for the new agent.
    const steering = !freshNext && Boolean(conversationId) && Boolean(deps.ai?.isBusy?.(conversationId));
    let target = '';
    try {
        target = steering ? conversationId : ensureConversation();
    } catch (error) {
        notice(`Could not start a conversation: ${error.message}`);
        return;
    }
    // While the person talks, the runtime gets ready, so the first answer
    // does not wait on it starting. Nothing goes to a model.
    if (!steering) deps.ai.warm?.(target)?.catch?.(() => {});
    const displayId = displayAtCursor();
    press = {
        seq: lastSeq,
        at: Date.now(),
        mode: steering ? 'steer' : 'ask',
        displayId,
        conversationId: target,
        looking: null,
        timer: setTimeout(() => released(), HOLD_LIMIT_MS),
    };
    push({
        phase: 'listening',
        mode: press.mode,
        heard: '',
        notice: '',
        reply: steering ? state.reply : '',
        point: null,
        // What it drew goes as they start talking again.
        drawing: null,
        // Talking over a reply being read out stops it.
        say: null,
        ...(steering ? {} : { action: null, ask: null, held: '', said: '' }),
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
}

/** Back to whatever the turn under way is doing, or to rest. */
function settleBack() {
    const busy = conversationId && deps.ai?.isBusy?.(conversationId);
    push({ phase: busy ? (state.action ? 'acting' : 'thinking') : 'idle', heard: '' });
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
    // Still at work: what was said steers the turn, or answers its question.
    if (taken.mode === 'steer' && deps.ai.isBusy(taken.conversationId)) {
        const where = pointerWords(taken.conversationId);
        const result = await deps.ai.steer(taken.conversationId, where ? `${text} ${where}` : text);
        if (!result?.success) {
            notice(result?.message || 'That did not reach the agent.');
            return;
        }
        push({
            phase: state.action ? 'acting' : 'thinking',
            ask: result.answered ? null : state.ask,
            said: result.answered ? 'Answered' : 'Got it',
        });
        return;
    }

    // A new request, or the turn ended while they spoke: a message, with
    // the picture of what they are looking at.
    push({ phase: 'looking' });
    const look = await (taken.looking || deps.computer.look());
    const id = taken.mode === 'ask' ? taken.conversationId : ensureConversation();
    if (!deps.ai.has?.(id)) {
        notice('The conversation was closed. Try again.');
        return;
    }
    if (look?.ok) deps.computer.seed(id, look.frame);
    const note = noteFor(id, look);
    briefed.add(id);
    conversationId = id;
    mine.add(id);
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
    push({ phase: 'thinking', since: Date.now(), action: null, ask: null, reply: '', said: '', held: '' });
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
    push({ phase: 'notice', notice: String(text || '').slice(0, 240), heard: '' });
    lingerTimer = setTimeout(() => settleBack(), NOTICE_MS);
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
    if (!enabled || !info || info.conversationId !== conversationId) return;
    // The note-taking turn after a real one is the app's, not the person's.
    if (info.remembering) return;
    if (event.type === 'title') {
        push({ title: String(event.title || '') });
        return;
    }
    // A subagent's work, or a child conversation's, is not this turn's.
    if (event.parentId || event.via) return;
    const listening = Boolean(press);
    switch (event.type) {
        case 'user-message':
            texts = [];
            lastTurnAt = Date.now();
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
            // Said aloud too: it is answered by voice, often without
            // looking up at the notch.
            const said = listening ? null : speak(questionWords(ask));
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
    lastTurnAt = Date.now();
    const { body, point, recap, shapes } = readTags(texts.join('\n\n'));
    texts = [];
    // As said, delivery cues and all; and as shown, without them.
    const short = recapOf(body, recap);
    const shown = tones.withoutCues(short);
    if (press) {
        // They are talking already: what this turn said waits in the notch.
        push({ action: null, ask: null, reply: body, recap: shown, said: '' });
        return;
    }
    if (error) {
        notice(error);
        return;
    }
    if (stopped) {
        push({ phase: 'idle', action: null, ask: null, held: '' });
        return;
    }
    const drawn = shapes.map(sketch).filter(Boolean);
    const drawing = drawn.length ? { at: Date.now(), shapes: drawn } : null;
    // With a drawing and nowhere named to point, the mark goes to the first
    // thing drawn, as the hand that draws it, saying nothing of its own.
    const spot = point ? place(point) : (drawn.length ? { ...anchorOf(drawn[0]), label: '', at: Date.now() } : null);
    const say = speak(short);
    push({
        phase: say ? 'speaking' : 'done',
        action: null,
        ask: null,
        held: '',
        said: '',
        reply: body,
        recap: shown,
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
    const physical = deps.computer.frameToScreen(conversationId, x, y);
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

function linger() {
    clearTimeout(lingerTimer);
    lingerTimer = setTimeout(() => {
        if (state.phase === 'done') push({ phase: 'idle' });
    }, REPLY_MS);
}

/** What the action under way is aimed at, by name, once the helper has found it. */
function aimed(id, label) {
    if (!enabled || id !== conversationId || !state.action || !label) return;
    push({ action: { ...state.action, aim: String(label).slice(0, 120) } });
}

/** The person's hand stopped the agents: took over the mouse or keyboard, or pressed Esc. */
function held(ids = [], code = 'took-over') {
    if (!enabled || !ids.includes(conversationId)) return;
    push({ held: code === 'escape' ? 'escape' : 'took-over', action: null });
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

function shutdown() {
    if (enabled) stop();
}

module.exports = {
    CHORD,
    configure,
    sync,
    isOn,
    owns,
    ready,
    isBuddyWindow,
    onPtt,
    heard,
    spoke,
    hit,
    pick,
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
        reset: () => {
            enabled = false;
            press = null;
            lastSeq = 0;
            freshNext = false;
            conversationId = '';
            mine.clear();
            briefed.clear();
            tabbed.clear();
            texts = [];
            state = fresh();
        },
        enable: () => {
            enabled = true;
            if (!unobserve && deps.ai?.observe) unobserve = deps.ai.observe(onEvent);
        },
        setElectron: (value) => { electron = value; },
        setPlatform: (value) => { platform = value; },
    },
};
