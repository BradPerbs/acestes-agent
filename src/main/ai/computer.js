/**
 * Computer use: the agent's hands on this desktop, where whoever is
 * supervising can see them.
 *
 * desktop-helper.exe (tools/DesktopHelper.cs) does the seeing, moving and
 * clicking on Windows, and desktop-helper (tools/mac/) on macOS, speaking the
 * same protocol. This is the policy in front of either, since a helper that
 * does what it is told is only as careful as whatever is telling it:
 *
 *   switched on   per agent, and off until someone switches it on
 *   in person     conversations with the user only. A job's run is refused:
 *                 nobody is watching it, and a locked screen shows nothing.
 *   one driver    one conversation has the mouse at a time, for its turn
 *   per app       the first time a conversation reaches for an app, the user
 *                 is asked, with a word of warning for the apps that reach
 *                 further than they look (a terminal, Explorer, Settings)
 *   hands off     the user clicking or typing outside Acestes, or moving the
 *                 mouse while an action is under way, pauses the agent until
 *                 they say to carry on. Esc stops the turn outright.
 *   not Acestes   its own windows are never listed, read or touched; the
 *                 helper refuses them itself, so the agent cannot approve its
 *                 own card
 *
 * The agent sees a window as its accessibility tree (UI Automation on
 * Windows, the accessibility API on macOS), numbered, and acts on elements by
 * number: the helper aims at the element, checks nothing covers
 * it, and glides the real cursor there before clicking, so the person
 * watching sees where it is going before it gets there.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const captcha = require('./captcha');

/** How fast the cursor travels and the keys go in, per agent. */
const PACES = {
    slow: { glide: 550, cps: 14 },
    normal: { glide: 320, cps: 30 },
    fast: { glide: 120, cps: 90 },
};

const OPTION_ALLOW = 'Allow in this conversation';
const OPTION_DENY = 'Don\'t allow';

/**
 * Apps that reach further than they look, by process. Not refused: the user
 * decides, knowing what a yes gives away.
 */
const WARNINGS = [
    {
        processes: ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'conhost.exe',
            'openconsole.exe', 'mintty.exe', 'alacritty.exe', 'wezterm-gui.exe', 'putty.exe', 'mobaxterm.exe',
            'wsl.exe', 'bash.exe', 'kitty.exe', 'tabby.exe'],
        warning: 'This is a terminal: controlling it is the same as running any command.',
    },
    {
        processes: ['code.exe', 'code - insiders.exe', 'cursor.exe', 'windsurf.exe', 'devenv.exe', 'idea64.exe',
            'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'goland64.exe', 'clion64.exe', 'zed.exe'],
        warning: 'This is an IDE: it can run code and has a terminal inside, so controlling it is the same as running any command.',
    },
    {
        processes: ['explorer.exe'],
        warning: 'Explorer can open, move or delete any of your files.',
    },
    {
        processes: ['systemsettings.exe', 'control.exe', 'mmc.exe', 'regedit.exe', 'taskmgr.exe', 'msconfig.exe',
            'services.exe', 'gpedit.exe'],
        warning: 'This can change how Windows is set up.',
    },
    {
        processes: ['1password.exe', 'keepass.exe', 'keepassxc.exe', 'bitwarden.exe', 'dashlane.exe', 'enpass.exe',
            'lastpass.exe', 'proton pass.exe'],
        warning: 'This holds your passwords.',
    },
    {
        processes: ['chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe',
            'librewolf.exe', 'waterfox.exe'],
        warning: 'A browser reaches every site you are signed in to. For web work the Playwright browser is safer.',
    },
    // The same on a Mac, where an app goes by its own name.
    {
        processes: ['terminal', 'iterm2', 'warp', 'ghostty', 'alacritty', 'kitty', 'wezterm', 'wezterm-gui', 'hyper',
            'tabby', 'script editor', 'automator', 'shortcuts'],
        warning: 'This is a terminal: controlling it is the same as running any command.',
    },
    {
        processes: ['code', 'visual studio code', 'code - insiders', 'cursor', 'windsurf', 'xcode', 'intellij idea',
            'pycharm', 'webstorm', 'rider', 'goland', 'clion', 'zed', 'nova', 'bbedit'],
        warning: 'This is an IDE: it can run code and has a terminal inside, so controlling it is the same as running any command.',
    },
    {
        processes: ['finder'],
        warning: 'Finder can open, move or delete any of your files.',
    },
    {
        processes: ['system settings', 'system preferences', 'activity monitor', 'disk utility', 'console',
            'directory utility', 'migration assistant'],
        warning: 'This can change how macOS is set up.',
    },
    {
        processes: ['keychain access', 'passwords', '1password', '1password 7', 'bitwarden', 'keepassxc', 'dashlane',
            'enpass', 'proton pass'],
        warning: 'This holds your passwords.',
    },
    {
        processes: ['safari', 'google chrome', 'firefox', 'microsoft edge', 'brave browser', 'arc', 'opera', 'vivaldi',
            'chromium', 'orion', 'librewolf'],
        warning: 'A browser reaches every site you are signed in to. For web work the Playwright browser is safer.',
    },
];

function warningFor(processName) {
    const name = String(processName || '').toLowerCase();
    return WARNINGS.find(entry => entry.processes.includes(name))?.warning || '';
}

/* ------------------------------------------------------------------ *
 * The helper process
 * ------------------------------------------------------------------ */

let helperCommand = null;
let helper = null;
let platform = process.platform;

/** The systems there is a helper for. */
const SUPPORTED = ['win32', 'darwin'];

/** Where the helper is, in a build and in a checkout. See hello.js, which this follows. */
function findHelper() {
    let appPath = '';
    try {
        appPath = require('electron').app.getAppPath();
    } catch {
        // Not under Electron: a test, which names its own helper.
    }
    const name = platform === 'darwin' ? 'desktop-helper' : 'desktop-helper.exe';
    const candidates = [
        process.resourcesPath && path.join(process.resourcesPath, 'resources', name),
        process.resourcesPath && path.join(process.resourcesPath, name),
        appPath && path.join(appPath, 'resources', name),
        path.join(__dirname, '..', '..', '..', 'resources', name),
    ].filter(Boolean);
    const found = candidates.find(candidate => fs.existsSync(candidate));
    return found ? { file: found, args: [] } : null;
}

/**
 * The helper, started on first use and kept for the session. It exits by
 * itself when this process does, because its stdin closes.
 */
function ensureHelper() {
    if (helper) return helper.ready;
    const command = helperCommand || findHelper();
    if (!command) {
        return Promise.reject(new Error('The desktop helper is missing from this build. In a checkout, run npm run build:desktop.'));
    }

    const child = spawn(command.file, [...command.args, '--protect', String(process.pid)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const state = { child, pending: new Map(), seq: 0, ready: null };
    let announce;
    let fail;
    state.ready = new Promise((resolve, reject) => {
        announce = resolve;
        fail = reject;
    });
    helper = state;

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        if (message.event) {
            if (message.event === 'ready') announce(message);
            else onEvent(message);
            return;
        }
        const waiting = state.pending.get(message.id);
        if (!waiting) return;
        state.pending.delete(message.id);
        clearTimeout(waiting.timer);
        // Stopped because it ran past its time: said as that, with what the
        // helper knows of how far it got.
        if (waiting.late && message.code === 'cancelled') {
            const detail = String(message.error || '').replace(/^Stopped by the app\.\s*/, '');
            waiting.resolve({ ...message, code: 'timeout', error: `It took longer than allowed, so it was stopped.${detail ? ` ${detail}` : ''}` });
            return;
        }
        waiting.resolve(message);
    });
    child.stderr.on('data', (chunk) => console.error('desktop helper:', String(chunk).trim()));
    // A request written as the helper goes arrives as a broken pipe, emitted
    // rather than thrown. Unheard, it would take the whole app down with it;
    // the exit below is what answers everything that was waiting.
    child.stdin.on('error', () => {});

    const gone = (reason) => {
        detach(state);
        fail(new Error(reason));
        for (const waiting of state.pending.values()) {
            clearTimeout(waiting.timer);
            waiting.resolve({ ok: false, code: 'helper-exited', error: reason });
        }
        state.pending.clear();
    };
    child.on('error', error => gone(`The desktop helper could not start: ${error.message}`));
    child.on('exit', code => gone(`The desktop helper stopped (exit ${code}).`));
    return state.ready;
}

/**
 * A helper let go, or gone: the next call starts a fresh one, and whoever was
 * driving has to drive that one afresh. Done at once when a helper is given up
 * on, not when it exits a moment later, or a call in between (the look after
 * a failed step) went to the helper on its way out. One already replaced is
 * nobody's concern.
 */
function detach(state) {
    if (helper !== state) return;
    helper = null;
    driving = false;
    helperPaused = false;
}

/**
 * How long the helper is given, in milliseconds. A test shortens them.
 *   typeBase     on top of the time the typing itself should take
 *   cancelGrace  for a request that ran past its time to stop when asked
 */
const TIMEOUTS = { typeBase: 15000, cancelGrace: 3000 };
let timeouts = TIMEOUTS;

/**
 * One request, answered with the helper's reply; never rejects.
 *
 * One that runs past its time is asked to stop. An action stops at its next
 * step and says how far it got, and the helper stays, with its badge and
 * every agent's numbers. Killing it outright, as this once did, threw all of
 * that away over typing that was merely long. Only a helper that does not
 * answer even then is let go: that is a read stuck in an app that stopped
 * answering UI Automation, and the next call starts a fresh helper.
 */
async function call(cmd, payload = {}, timeout = 30000) {
    try {
        await ensureHelper();
    } catch (error) {
        return { ok: false, code: 'no-helper', error: error.message };
    }
    const state = helper;
    return new Promise((resolve) => {
        state.seq += 1;
        const id = state.seq;
        const waiting = { resolve, timer: null, late: false };
        const giveUp = () => {
            state.pending.delete(id);
            detach(state);
            try { state.child.kill(); } catch { /* already gone */ }
            resolve({ ok: false, code: 'timeout', error: 'The desktop helper did not answer in time. The app may have stopped responding.' });
        };
        waiting.timer = setTimeout(() => {
            waiting.late = true;
            try {
                state.child.stdin.write(`${JSON.stringify({ cmd: 'cancel', target: id })}\n`);
            } catch { /* gone: its exit answers everything waiting */ }
            waiting.timer = setTimeout(giveUp, timeouts.cancelGrace);
        }, timeout);
        state.pending.set(id, waiting);
        try {
            state.child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
        } catch (error) {
            clearTimeout(waiting.timer);
            state.pending.delete(id);
            resolve({ ok: false, code: 'helper-exited', error: error.message });
        }
    });
}

/* ------------------------------------------------------------------ *
 * Who is driving
 *
 * Several conversations can use the desktop at once. Most of an agent's
 * time is thinking, not moving the mouse, so while one thinks another can
 * act: each action takes the mouse for the second it needs (aim, move,
 * click, look) and hands it back. A conversation is a driver from its first
 * action to the end of its turn, and the badge counts the drivers. The user
 * taking over, or pressing Esc, stops every one of them.
 * ------------------------------------------------------------------ */

// conversationId -> { name, pausedBy }
const drivers = new Map();
// Whether the helper's badge and hooks are on, and whether it has paused
// itself on the user's hand since they were last switched on.
let driving = false;
let helperPaused = false;
// The one mouse, as a queue: each action runs whole before the next starts.
let mouse = Promise.resolve();
// conversationId -> the window it was last working in, which is where
// typing and keys aimed at nothing in particular go, whoever acted since.
const homes = new Map();

// How many actions are queued for the mouse right now, so the one holding
// it can hurry when others are waiting.
let waiting = 0;

function withMouse(work) {
    waiting += 1;
    const start = () => {
        waiting -= 1;
        return work();
    };
    const turn = mouse.then(start, start);
    mouse = turn.catch(() => {});
    return turn;
}

/** Longer text types faster, so no one action keeps the mouse for long. */
const TYPE_SECONDS = 2.5;
/** The most keys a second either helper types (DesktopHelper.cs, Input.swift). */
const MAX_CPS = 400;
// conversationId -> Set of process names the user allowed
const consents = new Map();
// conversationId -> the latest screenshot's frame: which window, the screen
// region it shows, the scale it was shrunk by, and whether the agent is
// working from pictures ('image') or from the tree ('tree') just now.
const frames = new Map();

/**
 * How big a picture the model is sent: within what every current model
 * accepts without shrinking it again, so a pixel in it is a pixel it sees.
 */
const IMAGE = { maxLong: 1568, maxPixels: 1150000 };

/**
 * How long the look after an action waits for the window to stop changing,
 * in milliseconds; less between the steps of a batch, which only need what a
 * step set off to have landed before the next one aims.
 */
const SETTLE = { after: 1500, between: 800 };

// conversationId -> Map of hwnd -> { nodes, limit }: the last read this agent
// had of each window, which the read after an action is set against so that
// only what changed goes back.
const seen = new Map();

/**
 * What the Windows helper does and the Mac one does not yet: numbers that
 * stay with their controls (so one read can be set against the last),
 * numbered pictures, waiting for a window to settle, and the newer actions.
 */
const windowsOnly = () => platform === 'win32';
const WINDOWS_ONLY = 'This works on Windows only for now.';

let hooks = {
    isBusy: () => false,
    interrupt: () => {},
    surface: () => {},
    // Keeps Acestes's own windows out of a screenshot, and lets them back in.
    hideFromCapture: () => {},
    // Told who is driving whenever that changes, for the corner overlay.
    driversChanged: () => {},
    // Told what an action is aimed at, by name, for the corner overlay.
    aimed: () => {},
    // How a captcha service is reached. A test hands in its own.
    fetch: (...args) => globalThis.fetch(...args),
};

/**
 * How long a captcha is given, in milliseconds. A widget takes a moment to
 * decide after its box is ticked, and a grid refills after its tiles are
 * clicked. A test shortens all of it.
 */
const CAPTCHA_TIMING = {
    settle: 700,
    patience: 10000,
    quiet: 4000,
    tiles: [250, 600],
    refill: 1200,
    afterVerify: 2500,
    solver: { first: 4000, every: 3000, limit: 180000 },
};
let captchaTiming = CAPTCHA_TIMING;

function configure(next = {}) {
    const { captchaTiming: timing, ...rest } = next;
    hooks = { ...hooks, ...rest };
    if (timing) captchaTiming = { ...CAPTCHA_TIMING, ...timing, solver: { ...CAPTCHA_TIMING.solver, ...(timing.solver || {}) } };
}

/** The user's hand stops everyone: taking over pauses every driver, Esc ends every driver's turn. */
function pauseAll(code) {
    helperPaused = true;
    for (const [id, entry] of drivers) {
        if (entry.pausedBy === code) continue;
        entry.pausedBy = code;
        if (code === 'escape') Promise.resolve().then(() => hooks.interrupt(id)).catch(() => {});
    }
}

function onEvent(message) {
    if (message.event === 'took-over' || message.event === 'escape') pauseAll(message.event);
}

/** Whoever is watching who drives (the corner overlay) hears it on every change. */
function announce() {
    try {
        hooks.driversChanged([...drivers.keys()]);
    } catch (error) {
        console.error('Could not tell who is driving:', error.message);
    }
}

/** What the badge says: the agent by name, or how many are at it. */
function badge() {
    const names = [...drivers.values()].map(entry => entry.name);
    const label = names.length > 1
        ? `${names.length} agents are using your computer · Esc to stop`
        : `${names[0] || 'The agent'} is using your computer · Esc to stop`;
    return call('drive', { on: true, label, paused: 'Paused · you have control', stopped: 'Stopped' }, 10000);
}

const PAUSED = {
    'took-over': 'The user took control of the mouse or keyboard, so the agent stopped. Stop here: say in one line what '
        + 'you were doing and what is left, and wait for them to tell you to carry on.',
    escape: 'The user pressed Esc to stop. Stop here and wait for them.',
};

/**
 * A conversation's turn is over: it stops being a driver. The last one out
 * takes the badge and the hooks with it; otherwise the badge recounts.
 */
function release(conversationId) {
    if (!drivers.delete(conversationId)) return;
    // A mouse button this agent pressed and never let go goes with its turn.
    if (helper && windowsOnly()) call('letgo', { owner: conversationId }, 5000).catch(() => {});
    announce();
    if (drivers.size === 0) {
        const wasDriving = driving;
        driving = false;
        helperPaused = false;
        if (wasDriving && helper) call('drive', { on: false }, 5000).catch(() => {});
    } else if (driving && !helperPaused) {
        badge().catch(() => {});
    }
}

/** A conversation thrown away forgets what it was allowed, and its numbers. */
function forget(conversationId) {
    release(conversationId);
    consents.delete(conversationId);
    frames.delete(conversationId);
    homes.delete(conversationId);
    seen.delete(conversationId);
    if (helper) call('forget', { whose: conversationId }, 5000).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * One conversation's hands
 * ------------------------------------------------------------------ */

/**
 * What the computer tools reach through, for one conversation. `state`
 * supplies what only the conversation knows, read fresh on every call:
 * its id and title, what kind of run it is, the agent's settings and name,
 * how to put a question to the user, and how to fill in a secret.
 */
function apiFor(state) {
    const settings = () => state.settings() || {};
    /**
     * How fast the cursor travels and the keys go in: the agent's own pace,
     * nearly twice as quick while another agent is queued for the mouse (so
     * the one waiting gets it sooner), and never exactly the same twice, the
     * way a hand is not.
     */
    const pace = () => {
        const base = PACES[settings().computerPace] || PACES.normal;
        const hurry = waiting > 0 ? 0.55 : 1;
        const vary = 0.85 + Math.random() * 0.3;
        return { glide: Math.round(base.glide * hurry * vary), cps: Math.round(base.cps / hurry) };
    };

    /** May this conversation use the computer at all. */
    const allowed = () => {
        if (!SUPPORTED.includes(platform)) return 'Computer use works on Windows and macOS only for now.';
        if (!settings().computerUse) {
            return 'Computer use is switched off for this agent. The user can switch it on in Settings, under the agent, '
                + '"Use this computer". Say so rather than working around it.';
        }
        if (state.runKind() !== 'interactive') {
            return 'Computer use is only for conversations with the user. This is a background run: nobody is watching it, '
                + 'and a locked screen cannot be read.';
        }
        return '';
    };

    /**
     * Become one of this turn's drivers. The desktop is shared: others may
     * be driving too, and the mouse is taken per action, not held here. The
     * badge is switched on, or recounted when another agent joins, or put
     * back after the user's hand paused it and this is a new turn.
     */
    const drive = async () => {
        let me = drivers.get(state.id);
        if (!me) {
            me = { name: state.agentName() || 'The agent', pausedBy: '', counted: false };
            drivers.set(state.id, me);
            announce();
        }
        if (me.pausedBy) return PAUSED[me.pausedBy];
        if (!driving || helperPaused || !me.counted) {
            const answer = await badge();
            if (!answer.ok) return answer.error || 'The desktop helper did not start.';
            driving = true;
            helperPaused = false;
            me.counted = true;
        }
        return '';
    };

    /** Every request carries whose it is, so each agent keeps its own numbers. */
    const callFor = (cmd, payload = {}, timeout) => call(cmd, { ...payload, owner: state.id }, timeout);

    /** Whether the user allowed this app to this conversation, or to the one that started it. */
    const allowedApp = (app) => {
        const family = [state.id, ...(typeof state.lineage === 'function' ? state.lineage() : [])];
        return family.some(id => consents.get(id)?.has(app));
    };

    /** The window in front after an action is where this agent is working now. */
    const remember = async () => {
        const answer = await callFor('foreground');
        if (answer.ok && answer.window && !answer.window.protected) homes.set(state.id, answer.window);
    };

    /**
     * The user's say-so for one app, once per conversation. A conversation
     * another one started for the same job (to work side by side) has what
     * its parent was allowed, so the user is not asked again per agent.
     * Acestes is brought forward for the question, since the app it is about
     * may well be covering it.
     */
    const consent = async (window) => {
        if (!window) return '';
        const app = String(window.process || '').toLowerCase();
        if (!app) return '';
        if (allowedApp(app)) return '';

        const title = String(window.title || '').slice(0, 80);
        const warning = warningFor(app);
        hooks.surface(state.id);
        const reply = await state.ask({
            question: `Let the agent control ${window.process}${title ? ` ("${title}")` : ''} in this conversation?`
                + (warning ? ` ${warning}` : ''),
            options: [OPTION_ALLOW, OPTION_DENY],
        });
        if (!reply?.answered) return reply?.message || 'The user has not answered whether the agent may control that app.';
        if (reply.answer !== OPTION_ALLOW) {
            return `The user did not allow controlling ${window.process}. Do not try it again unless they ask.`;
        }
        grant(app);
        return '';
    };

    const grant = (app) => {
        if (!consents.has(state.id)) consents.set(state.id, new Set());
        consents.get(state.id).add(String(app).toLowerCase());
    };

    /** A failure from the helper, as the agent should read it. */
    const explain = (answer) => {
        if (answer.code === 'took-over' || answer.code === 'escape') {
            pauseAll(answer.code);
            return PAUSED[answer.code];
        }
        return answer.error || 'The desktop helper could not do that.';
    };

    /** The windows, front to back, as the agent sees them. */
    const listWindows = async () => {
        const answer = await callFor('windows');
        if (!answer.ok) return { error: explain(answer) };
        return { windows: answer.windows };
    };

    /** A window by the id list_windows gave, part of its title, or its app; the front one when none is named. */
    const pickWindow = async (query) => {
        const listed = await listWindows();
        if (listed.error) return listed;
        const { windows } = listed;
        if (windows.length === 0) return { error: 'There are no windows open apart from Acestes.' };
        const wanted = String(query ?? '').trim();
        if (!wanted) return { window: windows[0] };
        const byId = windows.find(window => String(window.hwnd) === wanted);
        if (byId) return { window: byId };
        const lower = wanted.toLowerCase();
        const byName = windows.find(window => window.process.toLowerCase() === lower || window.process.toLowerCase() === `${lower}.exe`)
            || windows.find(window => window.title.toLowerCase().includes(lower));
        if (byName) return { window: byName };
        return { error: `No window matches "${wanted}". list_windows shows what is open.` };
    };

    /**
     * A point in the latest screenshot, as a point on the screen. The
     * screenshot was shrunk to what the model is sent, so its pixels are
     * scaled back up and moved to where the picture was taken from.
     */
    const toScreen = (x, y) => {
        const frame = frames.get(state.id);
        if (!frame) {
            return { error: 'x and y are pixels of a screenshot. Take one first, or name an element from read_screen.' };
        }
        if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
            return { error: `(${x}, ${y}) is outside your latest screenshot, which is ${frame.width}×${frame.height}.` };
        }
        return {
            x: frame.region[0] + Math.round(x / frame.scale),
            y: frame.region[1] + Math.round(y / frame.scale),
            frame,
        };
    };

    /** Aim at an element or a point, and check the user allowed the app it is in. */
    const aim = async ({ element, x, y }) => {
        if (!element && !(Number.isFinite(x) && Number.isFinite(y))) {
            return { error: 'Say where: an element id from read_screen, or x and y in your latest screenshot.' };
        }
        let point = null;
        if (!element) {
            point = toScreen(x, y);
            if (point.error) return point;
        }
        const target = await callFor('target', element
            ? { element }
            : { x: point.x, y: point.y, hwnd: point.frame.screen ? 0 : point.frame.hwnd });
        if (!target.ok) return { error: explain(target) };
        // A window that moved or changed size since its picture was taken
        // would put the click somewhere the picture never showed.
        if (point && !point.frame.screen && target.frame && target.frame.join(',') !== point.frame.region.join(',')) {
            return { error: 'The window moved or changed size since your screenshot. Take another before clicking by position.' };
        }
        const refused = await consent(target.window);
        if (refused) return { error: refused };
        if (target.label) hooks.aimed(state.id, target.label);
        return { target };
    };

    /**
     * A picture of a window, or of the monitor it is on. Acestes is kept out
     * of it, and it becomes the frame the next x and y are read against.
     *
     * On Windows the window's controls are boxed and numbered on it, from a
     * read taken the moment before, and that read comes back with it: the
     * model sees where things are and still clicks by number, which is surer
     * than pixels. A picture asked for clean stays clean after actions too.
     */
    const snap = async (window, { screen = false, marks, full = true } = {}) => {
        const numbered = windowsOnly() && (marks ?? frames.get(state.id)?.marks ?? true);
        hooks.hideFromCapture(true);
        await new Promise(resolve => setTimeout(resolve, 60));
        let answer;
        try {
            answer = await callFor('capture', {
                hwnd: window.hwnd,
                monitor: screen,
                ...IMAGE,
                ...(numbered ? { marks: true, maxNodes: 300 } : {}),
            }, 20000);
        } finally {
            hooks.hideFromCapture(false);
        }
        if (!answer.ok) return { error: explain(answer) };
        frames.set(state.id, {
            hwnd: window.hwnd,
            screen,
            region: answer.region,
            scale: answer.scale,
            width: answer.width,
            height: answer.height,
            mode: 'image',
            marks: numbered,
        });
        return {
            screenshot: {
                of: screen ? `the screen ${window.process} is on` : `"${window.title}" (${window.process})`,
                size: `${answer.width}×${answer.height}`,
                note: answer.marked
                    ? 'The numbered boxes are elements: click them by element, which is surer than x and y. x and y '
                        + 'for click, scroll and drag are pixels of this picture.'
                    : 'x and y for click, scroll and drag are pixels of this picture.',
            },
            image: { mediaType: answer.mediaType, data: answer.data },
            ...(Array.isArray(answer.nodes) ? { screen: describe(answer, { full, limit: 300 }) } : {}),
        };
    };

    /** Everything an action does first: allowed, holding the mouse. */
    const begin = async () => allowed() || drive();

    const brief = window => (window ? { id: window.hwnd, title: window.title, app: window.process } : undefined);

    const settled = (answer, extra = {}) => ({
        ...extra,
        ...(answer.under ? { under: answer.under } : {}),
    });

    /** A read, as the agent gets it back. */
    const present = (answer) => {
        const spotted = captcha.spotIn(answer.nodes);
        return {
            window: brief(answer.window),
            elements: formatTree(answer.nodes),
            ...(answer.truncated ? { truncated: 'Stopped before the end. Read part of it with under: <id>.' } : {}),
            ...(answer.nodes.length <= 6 ? {
                sparse: 'Very little is exposed here: some apps (Electron, games, canvas) do not describe their '
                    + 'insides to the accessibility API. Take a screenshot to see it; keyboard shortcuts may still work.',
            } : {}),
            ...(spotted ? { captcha: `There is ${spotted} here. solve_captcha gets through it; do not click it yourself.` } : {}),
        };
    };

    /**
     * A read as the agent gets it back: whole, or, after an action, only what
     * changed since this agent last read the same window, which is most of
     * the time a few lines where the whole read was a few hundred. Whole the
     * first time, when much changed, and on a Mac, whose helper does not yet
     * keep numbers from read to read. A read of part of a window (under, or
     * with what is scrolled away) is not one to set the next against.
     */
    const describe = (answer, { full = false, partial = false, limit = 300 } = {}) => {
        const hwnd = answer.window?.hwnd;
        const mine = seen.get(state.id) || new Map();
        const before = hwnd ? mine.get(hwnd) : null;
        const changes = !full && before && windowsOnly()
            ? changesBetween(before.nodes, answer.nodes, { truncated: Boolean(answer.truncated) })
            : null;
        if (hwnd && !partial) {
            mine.set(hwnd, { nodes: answer.nodes, limit });
            seen.set(state.id, mine);
        }
        if (changes === null) return present(answer);
        const spotted = captcha.spotIn(answer.nodes);
        return {
            window: brief(answer.window),
            changes,
            ...(spotted ? { captcha: `There is ${spotted} here. solve_captcha gets through it; do not click it yourself.` } : {}),
        };
    };

    /**
     * Until this agent's window stops changing, so that what an action set
     * off has finished before it is looked at, and no turn goes on reading a
     * dialog half open. Windows only; a failure here costs nothing but the wait.
     */
    const settle = async (max = SETTLE.after) => {
        if (!windowsOnly()) return;
        const window = homes.get(state.id);
        await callFor('settle', { hwnd: window ? window.hwnd : 0, max }, max + 5000);
    };

    /**
     * This agent's own window after an action, the way the agent has been
     * looking at it: read, or pictured when it has been working from
     * screenshots of that window. Its own, not whichever is in front: with
     * another agent at work, the window in front can be theirs a moment
     * later, and handing that back had an agent chasing a paste that had
     * gone exactly where it meant it to. The agent looked after nearly every
     * action anyway, and each look was a turn of its own. An app the user
     * has not allowed is named but not looked at. Only what changed comes
     * back, unless `full`.
     */
    const look = async (window = null, { full = false } = {}) => {
        let target = window || homes.get(state.id) || null;
        if (!target) {
            const front = await callFor('foreground');
            target = front.ok ? front.window : null;
        }
        if (!target || target.protected) return {};
        const app = String(target.process || '').toLowerCase();
        if (!allowedApp(app)) {
            return { now: `${target.process} is in front ("${target.title}"). read_screen it to carry on; the user is asked first.` };
        }
        const frame = frames.get(state.id);
        if (frame?.mode === 'image' && (frame.screen || frame.hwnd === target.hwnd) && state.canSee()) {
            const picture = await snap(target, { screen: frame.screen, full });
            if (!picture.error) return picture;
        }
        // As many as the agent's own last read of it held, so a longer read
        // is not set against a shorter one and found to have lost its tail.
        const limit = Math.max(300, seen.get(state.id)?.get(target.hwnd)?.limit || 0);
        const answer = await callFor('tree', { hwnd: target.hwnd, maxNodes: limit }, 45000);
        return answer.ok ? { screen: describe(answer, { full, limit }) } : {};
    };

    const clickAt = async (target, { button = 'left', count = 1, modifiers = '' } = {}) => {
        const answer = await callFor('click', {
            x: target.x,
            y: target.y,
            rect: target.rect,
            button,
            count,
            modifiers,
            glide: pace().glide,
        });
        return answer.ok ? { answer } : { error: explain(answer) };
    };

    /**
     * Where typing, keys or a scroll aimed at nothing in particular go: the
     * window this agent was last working in, brought back to the front if
     * another agent has been at work since; the window in front when it has
     * none yet, or it has closed. Only if the user allowed its app.
     */
    const front = async () => {
        const home = homes.get(state.id);
        if (home) {
            const focused = await callFor('focus', { hwnd: home.hwnd });
            if (focused.ok && focused.window) {
                const denied = await consent(focused.window);
                return denied ? { error: denied } : { window: focused.window };
            }
            if (focused.code !== 'gone') return { error: explain(focused) };
            homes.delete(state.id);
        }
        const answer = await callFor('foreground');
        if (!answer.ok) return { error: explain(answer) };
        const denied = await consent(answer.window);
        return denied ? { error: denied } : { window: answer.window };
    };

    /* The actions themselves, each one step: no taking the mouse, no look after. */

    const doClick = async ({ element, x, y, button, count, modifiers }) => {
        const aimed = await aim({ element, x, y });
        if (aimed.error) return aimed;
        const clicked = await clickAt(aimed.target, { button, count, modifiers });
        if (clicked.error) return clicked;
        return settled(clicked.answer, { clicked: element ? `element ${element}` : `${x},${y}` });
    };

    const doType = async ({ text, element, x, y, replace }, { raw = false } = {}) => {
        if (element || (Number.isFinite(x) && Number.isFinite(y))) {
            const aimed = await aim({ element, x, y });
            if (aimed.error) return aimed;
            const clicked = await clickAt(aimed.target);
            if (clicked.error) return clicked;
        } else {
            const shown = await front();
            if (shown.error) return shown;
        }
        if (replace) {
            // Select all: Command on a Mac, where Control+A goes to the start of the line.
            const cleared = await callFor('keys', { keys: platform === 'darwin' ? 'cmd+a' : 'ctrl+a' });
            if (!cleared.ok) return { error: explain(cleared) };
        }
        // A secret is filled in here, at the last moment. The model wrote
        // the reference; the transcript keeps the reference. Text that came
        // off the screen (a captcha's letters) is typed as it is: a page could
        // show a reference and have the secret typed into its own form.
        const filled = raw ? String(text ?? '') : state.resolveSecrets(String(text ?? ''));
        if (!filled) return { error: 'Nothing to type.' };
        // Short text at the pace, so it can be followed; long text (an
        // address, a paragraph) sped up to be done in a couple of seconds, as
        // far as the helper goes. The time allowed is reckoned at the speed
        // it will really type: reckoned at a speed it never reached, anything
        // over about 1,200 characters ran out of time partway through.
        const cps = Math.min(MAX_CPS, Math.max(pace().cps, Math.ceil(filled.length / TYPE_SECONDS)));
        const answer = await callFor('type', { text: filled, cps }, timeouts.typeBase + Math.ceil((filled.length / cps) * 1500));
        if (!answer.ok) return { error: explain(answer) };
        return { typed: `${answer.typed} characters` };
    };

    /** The window keys go to: the one named, brought forward, or this agent's own. Null when it may, an error when not. */
    const keysTo = async (window) => {
        if (window) {
            const picked = await pickWindow(window);
            if (picked.error) return picked;
            const denied = await consent(picked.window);
            if (denied) return { error: denied };
            const focused = await callFor('focus', { hwnd: picked.window.hwnd });
            if (!focused.ok) return { error: explain(focused) };
            return null;
        }
        const shown = await front();
        return shown.error ? shown : null;
    };

    const doKeys = async ({ keys, window, repeat }) => {
        if (!keys) return { error: 'Name the keys, like "ctrl+s" or "enter".' };
        const refused = await keysTo(window);
        if (refused) return refused;
        const answer = await callFor('keys', { keys, repeat });
        if (!answer.ok) return { error: explain(answer) };
        return { pressed: keys };
    };

    /** Keys held down for a while and let go: a game's controls, a key that does something only while it is down. */
    const doHold = async ({ keys, seconds, window }) => {
        if (!windowsOnly()) return { error: WINDOWS_ONLY };
        if (!keys) return { error: 'Name the keys to hold, like "shift" or "right".' };
        const hold = Math.round(Math.min(10, Math.max(0.1, Number(seconds) || 1)) * 1000);
        const refused = await keysTo(window);
        if (refused) return refused;
        const answer = await callFor('keys', { keys, hold }, hold + 15000);
        if (!answer.ok) return { error: explain(answer) };
        return { held: `${keys} for ${hold / 1000}s` };
    };

    /**
     * The cursor rested on a control, without a click, for a moment: what
     * only shows under a pointer (a tooltip, a menu that opens on hover, a
     * row's own buttons) has time to show.
     */
    const doHover = async ({ element, x, y, seconds }) => {
        if (!windowsOnly()) return { error: WINDOWS_ONLY };
        const aimed = await aim({ element, x, y });
        if (aimed.error) return aimed;
        const answer = await callFor('move', { x: aimed.target.x, y: aimed.target.y, rect: aimed.target.rect, glide: pace().glide });
        if (!answer.ok) return { error: explain(answer) };
        const dwell = Math.min(10, Math.max(0, Number(seconds ?? 0.8)));
        if (dwell > 0) await new Promise(resolve => setTimeout(resolve, dwell * 1000));
        return settled(answer, { hovered: element ? `element ${element}` : `${x},${y}` });
    };

    /**
     * A mouse button pressed and kept down, or let go: a press held while
     * something else happens, or a gesture made in parts. Pressing needs a
     * place; letting go happens where the cursor is unless given one. The
     * helper lets go of anything still down when the turn ends.
     */
    const doMouse = async ({ action, button = 'left', element, x, y }) => {
        if (!windowsOnly()) return { error: WINDOWS_ONLY };
        if (action !== 'down' && action !== 'up') return { error: 'Say down or up.' };
        const placed = element || (Number.isFinite(x) && Number.isFinite(y));
        if (action === 'down' && !placed) return { error: 'Say where to press: an element, or x and y in your latest screenshot.' };
        let target = null;
        if (placed) {
            const aimed = await aim({ element, x, y });
            if (aimed.error) return aimed;
            target = aimed.target;
        }
        const answer = await callFor('button', {
            down: action === 'down',
            button,
            ...(target ? { x: target.x, y: target.y, rect: target.rect } : {}),
            glide: pace().glide,
        });
        if (!answer.ok) return { error: explain(answer) };
        const where = target ? ` at ${element ? `element ${element}` : `${x},${y}`}` : '';
        return settled(answer, action === 'down' ? { pressed: `the ${button} button${where}, held down` } : { released: `the ${button} button${where}` });
    };

    const doScroll = async ({ element, x, y, direction, amount }) => {
        if (!direction) return { error: 'Say which way to scroll.' };
        let target;
        if (element || (Number.isFinite(x) && Number.isFinite(y))) {
            const aimed = await aim({ element, x, y });
            if (aimed.error) return aimed;
            target = aimed.target;
        } else {
            const shown = await front();
            if (shown.error) return shown;
            const w = shown.window;
            target = { x: Math.round(w.x + w.width / 2), y: Math.round(w.y + w.height / 2) };
        }
        const answer = await callFor('scroll', { x: target.x, y: target.y, rect: target.rect, direction, amount, glide: pace().glide });
        if (!answer.ok) return { error: explain(answer) };
        return settled(answer, { scrolled: `${direction} ${amount || 3}` });
    };

    const doDrag = async ({ fromElement, fromX, fromY, toElement, toX, toY, path }) => {
        if (Array.isArray(path) && path.length) return dragThrough(path);
        const from = await aim({ element: fromElement, x: fromX, y: fromY });
        if (from.error) return from;
        const to = await aim({ element: toElement, x: toX, y: toY });
        if (to.error) return to;
        const answer = await callFor('drag', {
            x: from.target.x,
            y: from.target.y,
            toX: to.target.x,
            toY: to.target.y,
            glide: pace().glide,
        });
        if (!answer.ok) return { error: explain(answer) };
        return settled(answer, { dragged: true });
    };

    /**
     * A drag through every point of a path, in the latest screenshot's
     * pixels: a shape drawn, a signature, a slider dragged one way and back.
     * The window it starts in is aimed at, and asked about, like any click.
     */
    const dragThrough = async (path) => {
        if (!windowsOnly()) return { error: WINDOWS_ONLY };
        if (path.length < 2) return { error: 'A path needs two points at least.' };
        const first = await aim({ x: path[0].x, y: path[0].y });
        if (first.error) return first;
        const points = [];
        for (const point of path) {
            const at = toScreen(point.x, point.y);
            if (at.error) return at;
            points.push([at.x, at.y]);
        }
        const answer = await callFor('drag', { path: points, glide: pace().glide }, 30000);
        if (!answer.ok) return { error: explain(answer) };
        return settled(answer, { dragged: `through ${points.length} points` });
    };

    /**
     * Until something shows up, or with gone, until it has gone (a spinner,
     * "Loading…", a progress dialog). Searched without renumbering anything,
     * so the numbers the agent holds, and the steps after this one, stay good.
     */
    const doWait = async ({ text, role, window, seconds, timeout, gone }) => {
        if (!text) return { error: 'Say what to wait for.' };
        const picked = await pickWindow(window);
        if (picked.error) return picked;
        const denied = await consent(picked.window);
        if (denied) return { error: denied };
        const limit = Math.min(60, Math.max(1, seconds || timeout || 10));
        const deadline = Date.now() + limit * 1000;
        do {
            const answer = await callFor('tree', { hwnd: picked.window.hwnd, find: String(text), role: role || '' }, 45000);
            if (!answer.ok) return { error: explain(answer) };
            if (gone && !answer.found) return { gone: `nothing matching "${text}" is there now`, window: picked.window };
            if (!gone && answer.found) return { found: `${answer.found.r} "${answer.found.n}"`, window: picked.window };
            await new Promise(resolve => setTimeout(resolve, 400));
        } while (Date.now() < deadline);
        const span = `${limit} second${limit === 1 ? '' : 's'}`;
        return {
            error: gone
                ? `"${text}" was still there after ${span}.`
                : `Nothing matching "${text}" appeared within ${span}.`,
        };
    };

    const doPause = async ({ seconds }) => {
        const wait = Math.min(30, Math.max(0.1, Number(seconds) || 1));
        await new Promise(resolve => setTimeout(resolve, wait * 1000));
        return { paused: `${wait}s` };
    };

    const STEPS = {
        click: doClick,
        type: doType,
        keys: doKeys,
        scroll: doScroll,
        drag: doDrag,
        wait_for: doWait,
        pause: doPause,
        hover: doHover,
        mouse_down: step => doMouse({ ...step, action: 'down' }),
        mouse_up: step => doMouse({ ...step, action: 'up' }),
        hold_key: doHold,
    };

    /* ---------------------------------------------------------------- *
     * Captchas. The helper finds a widget by the address of its frame and
     * says what its checkbox and challenge show; captcha.js asks the user's
     * service what a picture needs; this does the rest with the real mouse.
     * ---------------------------------------------------------------- */

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const between = ([low, high]) => low + Math.random() * (high - low);

    /** Esc, or a hand on the mouse, heard between the steps of a long job. */
    const stopped = () => {
        const code = drivers.get(state.id)?.pausedBy;
        return code ? PAUSED[code] : '';
    };

    const CAPTCHA_NAMES = { recaptcha: 'reCAPTCHA', hcaptcha: 'hCaptcha', turnstile: 'Cloudflare check', arkose: 'Arkose puzzle' };
    const named = widget => CAPTCHA_NAMES[widget?.kind] || 'captcha';

    const scanCaptchas = async (window) => {
        const answer = await callFor('captcha', { hwnd: window.hwnd }, 45000);
        if (!answer.ok) return { error: explain(answer) };
        return { widgets: answer.widgets || [], images: answer.images || [] };
    };

    /** Where a captcha stands, from one scan: a challenge open, a box to tick, passed, quiet, or nothing to answer. */
    const judge = (scan) => {
        const widgets = scan.widgets || [];
        const challenge = widgets.find(widget => widget.visible && widget.part === 'challenge');
        if (challenge) return { stage: 'challenge', widget: challenge };
        const boxes = widgets.filter(widget => widget.part === 'checkbox');
        const open = boxes.find(widget => widget.visible && widget.checkbox && widget.checkbox.visible !== false
            && widget.checkbox.state !== 'checked');
        if (open) return { stage: 'checkbox', widget: open };
        const ticked = boxes.find(widget => widget.checkbox?.state === 'checked');
        if (ticked) return { stage: 'passed', widget: ticked };
        // Turnstile shows no box while it checks, and none once it has passed.
        const quiet = boxes.find(widget => widget.visible && widget.kind === 'turnstile');
        if (quiet) return { stage: 'quiet', widget: quiet };
        return { stage: 'none' };
    };

    /**
     * Somewhere on a box a person might press, not its exact middle. A wide
     * one is a label with the square at its left end (Turnstile's), so the
     * square is what is aimed at.
     */
    const pointIn = ([x, y, width, height]) => {
        const square = width > height * 2.5;
        const spanX = square ? height : width;
        const middleX = square ? x + height / 2 : x + width / 2;
        const wobble = size => ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * size * 0.36;
        return { x: Math.round(middleX + wobble(spanX)), y: Math.round(y + height / 2 + wobble(height)) };
    };

    /** A press the way a hand makes one: the helper's natural reach, never faster than a person would. */
    const pressAt = async ({ x, y }, rect) => {
        const answer = await callFor('click', {
            x, y, ...(rect ? { rect } : {}), natural: true, glide: Math.max(420, pace().glide), settle: 80,
        });
        return answer.ok ? {} : { error: explain(answer) };
    };

    /** An element from the scan, aimed at afresh; where the scan saw it, if its frame was redrawn since. */
    const pressElement = async (id, rect) => {
        const target = await callFor('target', { element: id });
        let box = rect;
        if (target.ok) {
            const refused = await consent(target.window);
            if (refused) return { error: refused };
            box = target.rect || rect;
        } else if (!['gone', 'unknown-element'].includes(target.code) || !rect) {
            return { error: explain(target) };
        }
        return pressAt(pointIn(box), box);
    };

    /** A picture of part of the screen for a service: Acestes kept out of it, as for a screenshot. */
    const grab = async (region) => {
        hooks.hideFromCapture(true);
        await sleep(60);
        let answer;
        try {
            answer = await callFor('capture', { region, ...IMAGE, format: 'jpeg' }, 20000);
        } finally {
            hooks.hideFromCapture(false);
        }
        return answer.ok ? answer : { error: explain(answer) };
    };

    /** Corners in the latest screenshot, as a region of the screen. */
    const cornersToRegion = ({ x0, y0, x1, y1 }) => {
        const frame = frames.get(state.id);
        if (!frame) return { error: 'x0, y0, x1 and y1 are pixels of a screenshot. Take one first.' };
        const left = Math.max(0, Math.min(x0, x1));
        const top = Math.max(0, Math.min(y0, y1));
        const right = Math.min(frame.width, Math.max(x0, x1));
        const bottom = Math.min(frame.height, Math.max(y0, y1));
        if (right - left < 8 || bottom - top < 8) return { error: 'That region is too small, or outside your latest screenshot.' };
        return {
            region: [
                frame.region[0] + Math.round(left / frame.scale),
                frame.region[1] + Math.round(top / frame.scale),
                Math.round((right - left) / frame.scale),
                Math.round((bottom - top) / frame.scale),
            ],
        };
    };

    const hasCorners = input => ['x0', 'y0', 'x1', 'y1'].every(key => Number.isFinite(input[key]));

    /** A service's points on a picture, as points on the screen, dropping any outside it. */
    const onScreen = (points, shot) => points
        .filter(point => point.x >= 0 && point.y >= 0 && point.x < shot.width && point.y < shot.height)
        .map(point => ({ x: shot.region[0] + Math.round(point.x / shot.scale), y: shot.region[1] + Math.round(point.y / shot.scale) }));

    const took = (solver, solved) => `${solver.label} answered in ${solved.seconds}s${solved.cost ? ` for $${solved.cost}` : ''}`;

    /** Each point pressed in turn, with a person's pause between. */
    const pressAll = async (points) => {
        for (const [index, point] of points.entries()) {
            const stop = stopped();
            if (stop) return { error: stop };
            const pressed = await pressAt(point);
            if (pressed.error) return pressed;
            if (index < points.length - 1) await sleep(between(captchaTiming.tiles));
        }
        return {};
    };

    // What a challenge's own button to send the answer is called, in the
    // languages a browser is likeliest to be in. reCAPTCHA and hCaptcha are
    // found by the id and the class they give it, before any of these. The
    // same button reads Skip until something is chosen, so Skip is kept apart:
    // pressing it after an answer means the answer never landed.
    const SEND = /verif|submit|next|confirm|done|continue|avanti|conferma|invia|weiter|bestätig|suivant|valider|siguiente|verificar|próximo|enviar|далее|проверить|确认|验证|下一/i;
    const SKIP = /skip|salta|überspringen|passer|omitir|saltar|pular|пропустить|跳过/i;
    const VERIFY = new RegExp(`${SEND.source}|${SKIP.source}`, 'i');
    const REFRESH = /refresh|reload|new challenge|aggiorna|ricarica|nuova sfida|neu laden|aktualisier|actualiser|nouveau|actualizar|recargar|atualizar|обнов|刷新|换一/i;

    const usable = widget => (widget.buttons || []).filter(button => button.visible !== false && button.enabled !== false);

    const verifyButton = (widget) => {
        const buttons = usable(widget);
        return buttons.find(button => button.aid === 'recaptcha-verify-button')
            || buttons.find(button => /\bbutton-submit\b/.test(button.cls || ''))
            || buttons.find(button => VERIFY.test(button.name || ''));
    };

    const refreshButton = (widget) => {
        const buttons = usable(widget);
        return buttons.find(button => button.aid === 'recaptcha-reload-button')
            || buttons.find(button => /\brefresh\b/.test(button.cls || ''))
            || buttons.find(button => REFRESH.test(button.name || ''));
    };

    /** A button that, as it reads now, would throw the challenge away rather than send an answer. */
    const onlySkips = button => Boolean(button) && SKIP.test(button.name || '') && !SEND.test(button.name || '');

    // What kind of puzzle a round is, from its own words. hCaptcha deals a
    // different one each round: a grid, a point on one picture, a piece to
    // drag into place, now and then a shape to draw around. The drag words
    // count only where a sentence starts ("Drag the…", "Sposta la…"), so a
    // grid asking for "things that can move" stays a grid.
    const DRAG_START = /(?:^|[.!?:]\s+)(?:please\s+|per favore\s+|bitte\s+)?(?:drag|move|slide|sposta|trascina|fai scorrere|zieh|verschieb|schieb|fais glisser|glisse|déplace|arrastra|mueve|desliza|arraste|mova|deslize|перетащ|перемест|передвин|拖|移动|滑动)/i;
    const AREA = /\b(?:draw|trace|outline|circle around)\b|disegna|traccia|contorna|zeichne|umrand|dessine|entoure|dibuja|rodea|desenhe|нарисуй|обвед|画出|圈出/i;

    const puzzleKind = (widget) => {
        const words = String(widget.text || '').slice(0, 300);
        if (DRAG_START.test(words)) return 'drag';
        if (AREA.test(words)) return 'area';
        return 'click';
    };

    /** Drags from each first point to the point after it, with a person's pause between. */
    const dragAll = async (pairs) => {
        for (const [index, [from, to]] of pairs.entries()) {
            const stop = stopped();
            if (stop) return { error: stop };
            const answer = await callFor('drag', { x: from.x, y: from.y, toX: to.x, toY: to.y, glide: Math.max(500, pace().glide) });
            if (!answer.ok) return { error: explain(answer) };
            if (index < pairs.length - 1) await sleep(between(captchaTiming.tiles));
        }
        return {};
    };

    /** Throws the round away for a new one, which costs nothing. */
    const refreshRound = async (widget, why) => {
        const refresh = refreshButton(widget);
        if (!refresh) return { note: `${why} There was no button for a new one.`, stuck: true };
        const pressed = await pressElement(refresh.id, refresh.rect);
        if (pressed.error) return pressed;
        return { note: `${why} Pressed "${refresh.name || 'Refresh'}" for a new one.`, refreshed: true };
    };

    /** The challenge as it stands now, rescanned, or null once it has closed. */
    const challengeNow = async (window, kind) => {
        const scan = await scanCaptchas(window);
        if (scan.error) return scan;
        return { widget: scan.widgets.find(widget => widget.visible && widget.part === 'challenge' && widget.kind === kind) || null };
    };

    /**
     * One round of an image challenge. Its words say what kind of puzzle it
     * is; a click puzzle's picture goes to the service for where to click, a
     * drag puzzle's for where each piece starts and where it goes, and one
     * this cannot answer is swapped for a new one without paying for it.
     * Then the challenge is read again: if its button still reads Skip after
     * an answer, the answer did not land, and the round is refreshed rather
     * than skipped. A place on one of the challenge's own buttons is left
     * alone: pressing Verify is this code's call.
     */
    const solveChallenge = async (window, widget, solver) => {
        const focused = await callFor('focus', { hwnd: window.hwnd });
        if (!focused.ok) return { error: explain(focused) };
        const kind = puzzleKind(widget);
        if (kind === 'area') return refreshRound(widget, 'This round asked for a shape drawn around something, which cannot be answered yet.');

        const shot = await grab(widget.rect);
        if (shot.error) return shot;
        const words = String(widget.text || '').slice(0, 240);
        const asked = `Follow the instruction at the top of the picture${words ? ` ("${words}")` : ''}. `;
        const comment = kind === 'drag'
            ? `${asked}This is a DRAG puzzle. Click exactly two points for each piece that must move: first the middle `
                + 'of the piece, then the middle of the place it must be dropped. Usually only one piece moves. Do not click any button.'
            : `${asked}Click the middle of every image or object that matches, once each. Do not click any button.`;
        const solved = await captcha.solve({
            service: solver.id, key: solver.key, kind: 'points', image: shot.data, comment,
            fetch: hooks.fetch, timing: captchaTiming.solver, stopped,
        });
        if (solved.error) return solved;
        const cost = Number(solved.cost) || 0;
        const buttons = (widget.buttons || []).filter(button => Array.isArray(button.rect) && button.rect[2] > 0);
        const onButton = point => buttons.some(({ rect: [bx, by, bw, bh] }) => point.x >= bx && point.x <= bx + bw && point.y >= by && point.y <= by + bh);
        const points = onScreen(solved.points, shot).filter(point => !onButton(point));

        let did;
        if (kind === 'drag') {
            const pairs = [];
            for (let i = 0; i + 1 < points.length; i += 2) pairs.push([points[i], points[i + 1]]);
            if (!pairs.length) {
                const again = await refreshRound(widget, `${took(solver, solved)} with ${points.length} point${points.length === 1 ? '' : 's'}, not a piece and a place for a drag puzzle.`);
                return { ...again, cost };
            }
            const dragged = await dragAll(pairs);
            if (dragged.error) return dragged;
            did = `dragged ${pairs.length} piece${pairs.length === 1 ? '' : 's'}`;
        } else {
            const pressed = await pressAll(points);
            if (pressed.error) return pressed;
            did = `pressed ${points.length} place${points.length === 1 ? '' : 's'}`;
        }
        // Some grids fade new pictures in where the chosen ones were, and the
        // button only changes from Skip once the page has taken the answer.
        await sleep(captchaTiming.refill);
        const now = await challengeNow(window, widget.kind);
        if (now.error) return now;
        const head = `${took(solver, solved)} for a ${kind} puzzle: ${did}`;
        if (!now.widget) return { note: `${head}, and the challenge closed.`, cost };
        const verify = verifyButton(now.widget);
        if (points.length && onlySkips(verify)) {
            const again = await refreshRound(now.widget, `${head}, but the button still read "${verify.name}", so the answer did not land.`);
            return { ...again, cost };
        }
        if (verify) {
            const sent = await pressElement(verify.id, verify.rect);
            if (sent.error) return sent;
        }
        return {
            note: `${head}${verify ? `, then "${verify.name || 'Verify'}".` : ', and found no Verify button to press.'}`,
            cost,
        };
    };

    /** Scans again until the widget moves on from `stage`, or patience runs out. */
    const settleFrom = async (window, stage, patience = captchaTiming.patience) => {
        const deadline = Date.now() + patience;
        let scan;
        do {
            await sleep(captchaTiming.settle);
            const stop = stopped();
            if (stop) return { error: stop };
            scan = await scanCaptchas(window);
            if (scan.error || judge(scan).stage !== stage) return scan;
        } while (Date.now() < deadline);
        return scan;
    };

    /**
     * Find the captcha and see it through: tick its box, and while an image
     * challenge is open, answer it round by round. Stops when it passes, when
     * it needs something only the user has, or after `rounds`.
     */
    const autoCaptcha = async (window, { service, rounds, budget }) => {
        const done = [];
        const failWith = message => ({ error: done.length ? `${message} Before that: ${done.join(' ')}` : message });
        const finish = async (solved, what) => ({ solved, what, ...(done.length ? { done } : {}), ...(await look(window)) });

        let scan = await scanCaptchas(window);
        if (scan.error) return scan;
        if (!scan.widgets.length) {
            const picture = scan.images.find(image => image.visible);
            if (picture) {
                return {
                    error: `The captcha here is a picture ("${picture.name}"). Call solve_captcha again with into: the field `
                        + 'its answer goes in, by its number from read_screen.',
                };
            }
            return {
                error: 'No captcha was found in this window. If one is on screen that this does not know, take a screenshot '
                    + 'and call solve_captcha with its corners (x0, y0, x1, y1) and what it asks (instruction).',
            };
        }

        let solver = null;
        let acted = false;
        let spent = 0;
        let stuck = 0;
        const cap = Math.min(1, Math.max(0.001, Number(budget) || 0.02));
        const limit = Math.min(10, Math.max(1, rounds || 6));
        for (let round = 0; round < limit; round++) {
            const stop = stopped();
            if (stop) return failWith(stop);
            const now = judge(scan);

            if (now.stage === 'passed') return finish(true, `The ${named(now.widget)} is ticked: it passed.`);

            if (now.stage === 'none') {
                if (acted) return finish(true, 'The captcha went away once it was answered, which is how it shows it passed.');
                const kinds = [...new Set(scan.widgets.map(named))].join(' and ');
                return finish(false, `There is a ${kinds} on the page, but nothing to answer yet. An invisible one comes up `
                    + 'only when the form is sent: send it, and call solve_captcha again if a challenge appears.');
            }

            if (now.stage === 'checkbox') {
                const box = now.widget.checkbox;
                const pressed = await pressElement(box.id, box.rect);
                if (pressed.error) return failWith(pressed.error);
                done.push(`Ticked the ${named(now.widget)} checkbox.`);
                acted = true;
                scan = await settleFrom(window, 'checkbox');
                if (scan.error) return failWith(scan.error);
                continue;
            }

            if (now.stage === 'quiet') {
                const later = await settleFrom(window, 'quiet', captchaTiming.quiet);
                if (later.error) return failWith(later.error);
                if (judge(later).stage === 'quiet') {
                    const says = String(later.widgets.find(widget => widget.kind === 'turnstile')?.text || '').trim().slice(0, 200);
                    return finish(true, 'The Cloudflare check shows no checkbox, which is how it looks once it has passed'
                        + `${says ? `. It says: "${says}"` : ''}. Check that the page carried on.`);
                }
                scan = later;
                continue;
            }

            // An image challenge is open.
            if (now.widget.kind === 'arkose') {
                return finish(false, 'This is an Arkose (FunCaptcha) puzzle, which this cannot answer yet. Ask the user to '
                    + 'solve it with ask_user, then carry on.');
            }
            if (!solver) {
                solver = captcha.pick({ resolve: state.resolveSecrets, kind: 'points', wanted: service });
                if (solver.error) {
                    return finish(false, `The ${named(now.widget)} opened an image challenge. ${solver.error} Until then, `
                        + 'ask the user with ask_user to solve it on screen, then carry on.');
                }
            }
            if (spent >= cap) {
                return finish(false, `Stopped at the spending cap: $${spent.toFixed(4)} of $${cap} on this captcha. Ask the user `
                    + 'with ask_user to solve it on screen, or call solve_captcha again with a higher budget if they say so.');
            }
            const answered = await solveChallenge(window, now.widget, solver);
            if (answered.error) return failWith(answered.error);
            spent += answered.cost || 0;
            done.push(answered.note);
            acted = true;
            if (answered.stuck && ++stuck >= 2) {
                return finish(false, 'The challenge keeps dealing puzzles this cannot answer, and has no button for a new one. '
                    + 'Ask the user to solve it with ask_user.');
            }
            await sleep(captchaTiming.afterVerify);
            scan = await scanCaptchas(window);
            if (scan.error) return failWith(scan.error);
        }
        return finish(false, `Still not through after ${limit} rounds ($${spent.toFixed(4)} spent). Ask the user to finish it with ask_user.`);
    };

    /** A picture of text: the service reads it, and what it read is typed into the field, as it is. */
    const textCaptcha = async (window, input) => {
        let region;
        if (input.element) {
            const target = await callFor('target', { element: input.element });
            if (!target.ok) return { error: explain(target) };
            region = target.rect;
            if (!region) return { error: `Element ${input.element} has no place on screen.` };
        } else if (hasCorners(input)) {
            const place = cornersToRegion(input);
            if (place.error) return place;
            region = place.region;
        } else {
            const scan = await scanCaptchas(window);
            if (scan.error) return scan;
            const picture = scan.images.find(image => image.visible);
            if (!picture) {
                return { error: 'No captcha picture was found by itself. Take a screenshot and give its corners (x0, y0, x1, y1).' };
            }
            region = picture.rect;
        }
        const solver = captcha.pick({ resolve: state.resolveSecrets, kind: 'text', wanted: input.service });
        if (solver.error) return { error: `${solver.error} Until then, ask the user what the picture says with ask_user.` };
        const focused = await callFor('focus', { hwnd: window.hwnd });
        if (!focused.ok) return { error: explain(focused) };
        const shot = await grab(region);
        if (shot.error) return shot;
        const solved = await captcha.solve({
            service: solver.id, key: solver.key, kind: 'text', image: shot.data, comment: input.instruction || '',
            fetch: hooks.fetch, timing: captchaTiming.solver, stopped,
        });
        if (solved.error) return solved;
        const typed = await doType({ text: solved.text, element: input.into, replace: true }, { raw: true });
        if (typed.error) return typed;
        return {
            solved: true,
            what: `${took(solver, solved)}, reading "${solved.text}", which was typed into element ${input.into}. Send the form to finish.`,
            ...(await look(window)),
        };
    };

    /** Any other puzzle that asks for clicks: its corners in the screenshot, and what it asks. */
    const regionCaptcha = async (window, input) => {
        const place = cornersToRegion(input);
        if (place.error) return place;
        const solver = captcha.pick({ resolve: state.resolveSecrets, kind: 'points', wanted: input.service });
        if (solver.error) return { error: `${solver.error} Until then, ask the user to solve it with ask_user.` };
        const focused = await callFor('focus', { hwnd: window.hwnd });
        if (!focused.ok) return { error: explain(focused) };
        const shot = await grab(place.region);
        if (shot.error) return shot;
        const solved = await captcha.solve({
            service: solver.id, key: solver.key, kind: 'points', image: shot.data,
            comment: input.instruction || 'Do what the picture asks: click where it says, in the order it says.',
            fetch: hooks.fetch, timing: captchaTiming.solver, stopped,
        });
        if (solved.error) return solved;
        const points = onScreen(solved.points, shot);
        if (!points.length) return { error: `${solver.label} sent back no place to click.` };
        const pressed = await pressAll(points);
        if (pressed.error) return pressed;
        return {
            solved: 'clicked',
            what: `${took(solver, solved)}: pressed ${points.length} place${points.length === 1 ? '' : 's'}. Press the puzzle's `
                + 'own Verify or Submit if it has one, and check that it passed.',
            ...(await look(window)),
        };
    };

    /**
     * An action as a tool: take the mouse, do it, look, and give the mouse
     * back. Held for the action alone, so another agent's action can come
     * next while this one's model thinks about the result.
     */
    const act = step => async (input = {}) => {
        const refused = await begin();
        if (refused) return { error: refused };
        const done = await withMouse(async () => {
            const result = await step(input);
            if (result.error) return { result };
            await remember();
            if (input.read === false) return { result };
            if (!pictured()) return { result, later: true };
            await settle();
            return { result: { ...result, ...(await look()) } };
        });
        if (!done.later) return done.result;
        // Waiting for the window to settle and reading it move nothing and
        // need nothing on top, so they happen after the mouse is handed on:
        // the next agent's action starts while this one's window settles.
        await settle();
        return { ...done.result, ...(await look()) };
    };

    /**
     * A hover as a tool: the look is taken with the mouse still held, since
     * what a hover shows goes again when another agent moves the cursor away.
     */
    const hoverTool = async (input = {}) => {
        const refused = await begin();
        if (refused) return { error: refused };
        return withMouse(async () => {
            const result = await doHover(input);
            if (result.error) return result;
            await remember();
            if (input.read === false) return result;
            await settle();
            return { ...result, ...(await look()) };
        });
    };

    /**
     * Whether the look after an action will be a picture. A picture is of
     * the screen as it is, so it is taken while the mouse is still held,
     * before anyone else brings their own window forward.
     */
    const pictured = () => {
        const frame = frames.get(state.id);
        const home = homes.get(state.id);
        return frame?.mode === 'image' && state.canSee() && (frame.screen || frame.hwnd === home?.hwnd);
    };

    /** The look at the end of a batch, held for a picture and not for a read. */
    const lookAfter = (options = {}) => (pictured() ? withMouse(() => look(null, options)) : look(null, options));

    /** An action that is not one of the steps (opening, pictures, a captcha), with the mouse held throughout. */
    const held = work => async (input = {}) => {
        const refused = await begin();
        if (refused) return { error: refused };
        return withMouse(async () => {
            const result = await work(input);
            if (!result.error) await remember();
            return result;
        });
    };

    return {
        async windows() {
            const refused = allowed();
            if (refused) return { error: refused };
            const listed = await listWindows();
            if (listed.error) return listed;
            return {
                windows: listed.windows.map(window => ({
                    id: window.hwnd,
                    title: window.title,
                    app: window.process,
                    ...(window.foreground ? { front: true } : {}),
                    ...(window.minimized ? { minimized: true } : {}),
                    ...(window.elevated ? { elevated: true } : {}),
                })),
                note: 'Acestes itself is not listed: it is not yours to control.',
            };
        },

        open: held(async ({ app, args = '' }) => {
            const answer = await callFor('launch', { target: app, args }, 30000);
            if (!answer.ok) return { error: explain(answer) };
            // Approving the launch is not approving what it opened. An app
            // that restores its last session (Notepad, Office, an IDE) comes
            // up holding the user's own work, and the question names that
            // window by its title so they can see what they are saying yes to.
            const denied = await consent(answer.window);
            return {
                window: brief(answer.window),
                ...(answer.note ? { note: answer.note } : {}),
                ...(denied ? { notAllowed: denied } : {}),
                check: 'Read what is in the window before typing into it: an app may reopen the user\'s own documents.',
                ...(denied ? {} : await look(answer.window)),
            };
        }),

        async read({ window, under, maxElements, offscreen }) {
            const refused = allowed();
            if (refused) return { error: refused };
            let payload;
            if (under) {
                payload = { under };
            } else {
                const picked = await pickWindow(window);
                if (picked.error) return picked;
                const denied = await consent(picked.window);
                if (denied) return { error: denied };
                payload = { hwnd: picked.window.hwnd };
            }
            const limit = maxElements || 300;
            const answer = await callFor('tree', { ...payload, maxNodes: limit, offscreen: Boolean(offscreen) }, 45000);
            if (!answer.ok) return { error: explain(answer) };
            // Reading the tree again is a sign of going back to it: the
            // actions after this hand back reads, not pictures.
            const frame = frames.get(state.id);
            if (frame) frame.mode = 'tree';
            // Always whole; and what the next action's changes are set against,
            // unless it was a read of only part of the window.
            return describe(answer, { full: true, partial: Boolean(under || offscreen), limit });
        },

        /** A picture of a window, brought to the front first, or of the monitor it is on. */
        screenshot: held(async ({ window, screen, marks }) => {
            if (!state.canSee()) {
                return { error: 'The runtime this agent is on cannot see images. Use read_screen and read_text, or switch to one that can (Claude Code, Codex).' };
            }
            const picked = await pickWindow(window);
            if (picked.error) return picked;
            const denied = await consent(picked.window);
            if (denied) return { error: denied };
            const focused = await callFor('focus', { hwnd: picked.window.hwnd });
            if (!focused.ok) return { error: explain(focused) };
            return snap(focused.window || picked.window, { screen: Boolean(screen), marks: marks !== false, full: true });
        }),

        /**
         * Windows put where they are wanted: side by side for two agents, or
         * two apps being worked between, quarters for four, one filling the
         * screen. Each window's app needs the user's say-so, like any other
         * control of it. Screenshots taken before are of windows that have
         * since moved, so pixel positions from them are refused until retaken.
         */
        arrange: held(async ({ windows: wanted = [] }) => {
            const placed = [];
            for (const entry of wanted) {
                const picked = await pickWindow(entry.window);
                if (picked.error) return { error: picked.error, ...(placed.length ? { placed } : {}) };
                const denied = await consent(picked.window);
                if (denied) return { error: denied, ...(placed.length ? { placed } : {}) };
                const answer = await callFor('place', {
                    hwnd: picked.window.hwnd,
                    slot: entry.place,
                    monitor: entry.monitor === undefined ? '' : String(entry.monitor),
                });
                if (!answer.ok) return { error: explain(answer), ...(placed.length ? { placed } : {}) };
                const [x, y, width, height] = answer.bounds;
                placed.push({ ...brief(answer.window), place: entry.place, at: `${x},${y} ${width}×${height}` });
            }
            return { placed };
        }),

        /**
         * A closer look at part of the latest screenshot, at the screen's own
         * resolution. The frame stays the screenshot's: x and y still mean
         * pixels of that, not of this.
         */
        async zoom({ x0, y0, x1, y1 }) {
            const refused = allowed();
            if (refused) return { error: refused };
            if (!state.canSee()) return { error: 'The runtime this agent is on cannot see images.' };
            const frame = frames.get(state.id);
            if (!frame) return { error: 'Take a screenshot first: zoom looks closer at part of it.' };
            const left = Math.max(0, Math.min(x0, x1));
            const top = Math.max(0, Math.min(y0, y1));
            const right = Math.min(frame.width, Math.max(x0, x1));
            const bottom = Math.min(frame.height, Math.max(y0, y1));
            if (right - left < 4 || bottom - top < 4) return { error: 'That region is too small, or outside the screenshot.' };
            const region = [
                frame.region[0] + Math.round(left / frame.scale),
                frame.region[1] + Math.round(top / frame.scale),
                Math.round((right - left) / frame.scale),
                Math.round((bottom - top) / frame.scale),
            ];
            hooks.hideFromCapture(true);
            await new Promise(resolve => setTimeout(resolve, 60));
            let answer;
            try {
                answer = await callFor('capture', { region, ...IMAGE }, 20000);
            } finally {
                hooks.hideFromCapture(false);
            }
            if (!answer.ok) return { error: explain(answer) };
            return {
                zoomed: `(${left}, ${top}) to (${right}, ${bottom}) of your screenshot, at ${answer.width}×${answer.height}`,
                note: 'x and y for click, scroll and drag are still pixels of the full screenshot, not of this.',
                image: { mediaType: answer.mediaType, data: answer.data },
            };
        },

        /** The whole text of an element or a window, a page at a time. */
        async text({ element, window, offset = 0 }) {
            const refused = allowed();
            if (refused) return { error: refused };
            let payload;
            if (element) {
                payload = { element };
            } else {
                const picked = await pickWindow(window);
                if (picked.error) return picked;
                const denied = await consent(picked.window);
                if (denied) return { error: denied };
                payload = { hwnd: picked.window.hwnd };
            }
            const answer = await callFor('text', payload, 45000);
            if (!answer.ok) return { error: explain(answer) };
            const whole = String(answer.text || '');
            const start = Math.max(0, Math.min(Number(offset) || 0, whole.length));
            const end = Math.min(whole.length, start + TEXT_PAGE);
            return {
                length: whole.length,
                ...(start > 0 ? { offset: start } : {}),
                ...(end < whole.length ? { nextOffset: end } : {}),
                text: whole.slice(start, end),
            };
        },

        click: act(doClick),
        type: act(doType),
        keys: act(doKeys),
        scroll: act(doScroll),
        drag: act(doDrag),
        hover: hoverTool,
        mouse: act(doMouse),
        hold: act(doHold),

        /**
         * What is on the clipboard: its text a page at a time, the files
         * copied, and whether it holds a picture. A copy a password manager
         * marked private is refused by the helper, whole.
         */
        async clipboard({ offset = 0 } = {}) {
            const refused = allowed();
            if (refused) return { error: refused };
            if (!windowsOnly()) return { error: WINDOWS_ONLY };
            const answer = await callFor('clipboard', {}, 15000);
            if (!answer.ok) return { error: explain(answer) };
            if (answer.private) {
                return { error: 'The clipboard holds a copy its app marked private, the way password managers mark theirs, so it is not read.' };
            }
            const has = typeof answer.text === 'string';
            const whole = has ? answer.text : '';
            const start = Math.max(0, Math.min(Number(offset) || 0, whole.length));
            const end = Math.min(whole.length, start + TEXT_PAGE);
            return {
                ...(has ? { length: whole.length, text: whole.slice(start, end) } : {}),
                ...(start > 0 ? { offset: start } : {}),
                ...(end < whole.length ? { nextOffset: end } : {}),
                ...(answer.files ? { files: answer.files } : {}),
                ...(answer.image ? { picture: 'There is a picture on the clipboard.' } : {}),
                ...(!has && !answer.files && !answer.image ? { empty: 'The clipboard holds nothing that can be read.' } : {}),
            };
        },

        async waitFor(input = {}) {
            const refused = allowed();
            if (refused) return { error: refused };
            const result = await doWait(input);
            if (result.error) return result;
            return { ...(input.gone ? { gone: result.gone } : { found: result.found }), ...(await look(result.window)) };
        },

        /**
         * Several actions in one turn, in order, stopping at the first that
         * fails. The numbers from the last read hold for all of them, since
         * nothing is read in between; the window is read once, at the end.
         * The mouse is taken per step, and not at all for a pause or a wait,
         * so another agent's steps can fall in between. Each step aims afresh
         * and typing goes back to this agent's own window, so they do not
         * trip over each other.
         */
        async steps({ steps = [] }) {
            const refused = await begin();
            if (refused) return { error: refused };
            const done = [];
            for (const [index, step] of steps.entries()) {
                const run = STEPS[step?.do];
                if (!run) return { error: `Step ${index + 1}: there is no action "${step?.do}".` };
                const idle = step.do === 'pause' || step.do === 'wait_for';
                const result = idle ? await run(step) : await withMouse(async () => {
                    const outcome = await run(step);
                    if (!outcome.error) await remember();
                    return outcome;
                });
                if (result.error) {
                    // The whole window, not what changed: a failed batch is
                    // planned again from what is there.
                    const after = await lookAfter({ full: true });
                    const screen = after.screen ? `\n\nThe window now:\n${after.screen.elements || after.screen.changes}` : (after.now ? `\n\n${after.now}` : '');
                    return {
                        error: `Step ${index + 1} of ${steps.length} (${step.do}) failed: ${result.error}`
                            + `${done.length ? ` The ${done.length} before it were done.` : ''}${screen}`,
                    };
                }
                done.push(`${index + 1}. ${Object.entries(result).filter(([key]) => key !== 'window').map(([key, value]) => `${key} ${value}`).join(', ')}`);
                // What a step set off has landed before the next one aims:
                // the dialog a click opened is there to type into.
                if (!idle && index < steps.length - 1) await settle(SETTLE.between);
            }
            await settle();
            return { done, ...(await lookAfter()) };
        },

        /**
         * A captcha seen through: found and answered by itself, a picture of
         * text read into a field (into), or any other click puzzle given by
         * its corners in the latest screenshot.
         */
        captcha: held(async (input = {}) => {
            const picked = await pickWindow(input.window);
            if (picked.error) return picked;
            const denied = await consent(picked.window);
            if (denied) return { error: denied };
            // A widget behind another window, or in a minimised one, is not on
            // screen to be seen or pressed.
            const focused = await callFor('focus', { hwnd: picked.window.hwnd });
            if (!focused.ok) return { error: explain(focused) };
            if (input.into) return textCaptcha(picked.window, input);
            if (hasCorners(input)) return regionCaptcha(picked.window, input);
            if (input.element) {
                return { error: 'element names the picture of a text captcha; say where its answer goes with into. For anything else, leave it out and the captcha is found by itself.' };
            }
            return autoCaptcha(picked.window, input);
        }),
    };
}

/** How much of a long text one answer carries. See tools.js, which pages the same way. */
const TEXT_PAGE = 30000;

/** The helper's nodes as the lines the agent reads, indented by depth. */
function formatTree(nodes = []) {
    return nodes.map((node) => {
        const pad = '  '.repeat(node.d || 0);
        if (node.offscreen) return `${pad}… ${node.offscreen} scrolled out of view`;
        if (node.more) return `${pad}… ${node.more} more`;
        return pad + lineOf(node);
    }).join('\n');
}

/** One control as the line the agent reads, without its indent. */
function lineOf(node) {
    let line = `[${node.id}] ${node.r}`;
    if (node.n) line += ` "${node.n}"`;
    if (node.v) line += ` = "${node.v}"`;
    if (node.len) line += ` (${node.len} characters; read_text ${node.id} for all)`;
    if (node.s) line += ` (${node.s})`;
    return line;
}

/** What a control was, in the parts of it that changed. */
function wasOf(before, after) {
    const parts = [];
    if (before.r !== after.r) parts.push(before.r);
    if (before.n !== after.n) parts.push(before.n ? `"${before.n}"` : 'unnamed');
    if (before.v !== after.v || before.len !== after.len) parts.push(before.v ? `= "${before.v}"` : 'empty');
    if (before.s !== after.s) parts.push(before.s ? `(${before.s})` : '(nothing marked)');
    return parts.join(' ');
}

/**
 * What changed in a window between two reads of it, in the words the agent
 * reads a window in: controls that appeared, indented as they nest; controls
 * whose name, value or state changed, with what they were; and those no
 * longer there. A control keeps its number from read to read on Windows,
 * which is what lets one read be set against the last. Null when so much
 * changed that the whole read says it better.
 */
function changesBetween(before, after, { truncated = false } = {}) {
    const listed = nodes => nodes.filter(node => node.id);
    const was = new Map(listed(before).map(node => [node.id, node]));
    const now = listed(after);
    const still = new Set(now.map(node => node.id));
    const added = now.filter(node => !was.has(node.id));
    const changed = now.filter(node => was.has(node.id) && lineOf(was.get(node.id)) !== lineOf(node));
    // A read that stopped at its limit says nothing of what lay past it.
    const gone = truncated ? [] : listed(before).filter(node => !still.has(node.id));
    const count = added.length + changed.length + gone.length;
    if (count === 0) return 'Nothing in the window changed.';
    if (count > Math.max(10, Math.ceil(now.length / 2))) return null;

    const parts = [];
    if (added.length) {
        const top = Math.min(...added.map(node => node.d || 0));
        parts.push(`New:\n${added.map(node => `${'  '.repeat(1 + (node.d || 0) - top)}${lineOf(node)}`).join('\n')}`);
    }
    if (changed.length) {
        parts.push(`Changed:\n${changed.map(node => `  ${lineOf(node)}, was ${wasOf(was.get(node.id), node)}`).join('\n')}`);
    }
    if (gone.length) {
        const named = gone.slice(0, 20).map(node => `[${node.id}] ${node.r}${node.n ? ` "${node.n}"` : ''}`);
        parts.push(`Gone: ${named.join(', ')}${gone.length > 20 ? `, and ${gone.length - 20} more` : ''}`);
    }
    if (truncated) parts.push('(The read stops at its limit, so what went past it is not said. read_screen with under reads a part.)');
    return parts.join('\n');
}

function shutdown() {
    if (!helper) return;
    try { helper.child.kill(); } catch { /* already gone */ }
    helper = null;
}

module.exports = {
    PACES,
    configure,
    apiFor,
    release,
    forget,
    shutdown,
    formatTree,
    warningFor,
    _test: {
        useHelper: (command) => {
            shutdown();
            helperCommand = command;
        },
        setPlatform: (value) => { platform = value; },
        timeouts: (next) => { timeouts = { ...TIMEOUTS, ...next }; },
        helperPid: () => helper?.child.pid,
        changesBetween,
        drivers: () => drivers,
        homes: () => homes,
        reset: () => {
            shutdown();
            drivers.clear();
            homes.clear();
            driving = false;
            helperPaused = false;
            mouse = Promise.resolve();
            consents.clear();
            frames.clear();
            seen.clear();
            captchaTiming = CAPTCHA_TIMING;
            timeouts = TIMEOUTS;
        },
    },
};
