/**
 * Computer use: the agent's hands on this desktop, where whoever is
 * supervising can see them.
 *
 * desktop-helper.exe (tools/DesktopHelper.cs) does the seeing, moving and
 * clicking. This is the policy in front of it, since a helper that does what
 * it is told is only as careful as whatever is telling it:
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
 * The agent sees a window as its UI Automation tree, numbered, and acts on
 * elements by number: the helper aims at the element, checks nothing covers
 * it, and glides the real cursor there before clicking, so the person
 * watching sees where it is going before it gets there.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

/** Where the exe is, in a build and in a checkout. See hello.js, which this follows. */
function findHelper() {
    let appPath = '';
    try {
        appPath = require('electron').app.getAppPath();
    } catch {
        // Not under Electron: a test, which names its own helper.
    }
    const candidates = [
        process.resourcesPath && path.join(process.resourcesPath, 'resources', 'desktop-helper.exe'),
        process.resourcesPath && path.join(process.resourcesPath, 'desktop-helper.exe'),
        appPath && path.join(appPath, 'resources', 'desktop-helper.exe'),
        path.join(__dirname, '..', '..', '..', 'resources', 'desktop-helper.exe'),
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
        waiting.resolve(message);
    });
    child.stderr.on('data', (chunk) => console.error('desktop helper:', String(chunk).trim()));

    const gone = (reason) => {
        if (helper === state) helper = null;
        fail(new Error(reason));
        for (const waiting of state.pending.values()) {
            clearTimeout(waiting.timer);
            waiting.resolve({ ok: false, code: 'helper-exited', error: reason });
        }
        state.pending.clear();
        // Whoever was driving has to be driven again by a fresh helper.
        if (holder) holder.driving = false;
    };
    child.on('error', error => gone(`The desktop helper could not start: ${error.message}`));
    child.on('exit', code => gone(`The desktop helper stopped (exit ${code}).`));
    return state.ready;
}

/** One request, answered with the helper's reply; never rejects. */
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
        const timer = setTimeout(() => {
            state.pending.delete(id);
            // A read that hangs is usually an app that stopped answering UI
            // Automation. The helper is let go so the next call starts clean.
            try { state.child.kill(); } catch { /* already gone */ }
            resolve({ ok: false, code: 'timeout', error: 'The desktop helper did not answer in time. The app may have stopped responding.' });
        }, timeout);
        state.pending.set(id, { resolve, timer });
        try {
            state.child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
        } catch (error) {
            clearTimeout(timer);
            state.pending.delete(id);
            resolve({ ok: false, code: 'helper-exited', error: error.message });
        }
    });
}

/* ------------------------------------------------------------------ *
 * Who is driving
 * ------------------------------------------------------------------ */

// { conversationId, title, driving, pausedBy }
let holder = null;
// conversationId -> Set of process names the user allowed
const consents = new Map();

let hooks = {
    isBusy: () => false,
    interrupt: () => {},
    surface: () => {},
};

function configure(next = {}) {
    hooks = { ...hooks, ...next };
}

function onEvent(message) {
    if (!holder) return;
    if (message.event === 'took-over') {
        holder.pausedBy = 'took-over';
    } else if (message.event === 'escape') {
        holder.pausedBy = 'escape';
        const id = holder.conversationId;
        Promise.resolve().then(() => hooks.interrupt(id)).catch(() => {});
    }
}

const PAUSED = {
    'took-over': 'The user took control of the mouse or keyboard, so the agent stopped. Stop here: say in one line what '
        + 'you were doing and what is left, and wait for them to tell you to carry on.',
    escape: 'The user pressed Esc to stop. Stop here and wait for them.',
};

/** Hand the desktop back: the badge goes, the hooks go. At the end of every turn. */
function release(conversationId) {
    if (!holder || holder.conversationId !== conversationId) return;
    const wasDriving = holder.driving;
    holder = null;
    if (wasDriving && helper) call('drive', { on: false }, 5000).catch(() => {});
}

/** A conversation thrown away forgets what it was allowed. */
function forget(conversationId) {
    release(conversationId);
    consents.delete(conversationId);
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
    const pace = () => PACES[settings().computerPace] || PACES.normal;

    /** May this conversation use the computer at all. */
    const allowed = () => {
        if (platform !== 'win32') return 'Computer use works on Windows only for now.';
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

    /** Take the mouse for this turn, or say who has it. */
    const drive = async () => {
        if (holder && holder.conversationId !== state.id && hooks.isBusy(holder.conversationId)) {
            return `The desktop is in use by another conversation, "${holder.title || 'untitled'}". Wait for it to finish, `
                + 'or tell the user it is busy.';
        }
        if (!holder || holder.conversationId !== state.id) {
            if (holder?.driving) await call('drive', { on: false }, 5000);
            holder = { conversationId: state.id, title: state.title(), driving: false, pausedBy: '' };
        }
        if (holder.pausedBy) return PAUSED[holder.pausedBy];
        if (!holder.driving) {
            const name = state.agentName() || 'The agent';
            const answer = await call('drive', {
                on: true,
                label: `${name} is using your computer · Esc to stop`,
                paused: 'Paused · you have control',
                stopped: 'Stopped',
            }, 10000);
            if (!answer.ok) return answer.error || 'The desktop helper did not start.';
            holder.driving = true;
        }
        return '';
    };

    /**
     * The user's say-so for one app, once per conversation. Acestes is
     * brought forward for the question, since the app it is about may well be
     * covering it.
     */
    const consent = async (window) => {
        if (!window) return '';
        const app = String(window.process || '').toLowerCase();
        if (!app) return '';
        const granted = consents.get(state.id);
        if (granted?.has(app)) return '';

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
            if (holder && holder.conversationId === state.id) holder.pausedBy = answer.code;
            return PAUSED[answer.code];
        }
        return answer.error || 'The desktop helper could not do that.';
    };

    /** The windows, front to back, as the agent sees them. */
    const listWindows = async () => {
        const answer = await call('windows');
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

    /** Aim at an element or a point, and check the user allowed the app it is in. */
    const aim = async ({ element, x, y }) => {
        if (!element && !(Number.isFinite(x) && Number.isFinite(y))) {
            return { error: 'Say where: an element id from read_screen, or x and y.' };
        }
        const target = await call('target', element ? { element } : { x, y });
        if (!target.ok) return { error: explain(target) };
        const refused = await consent(target.window);
        if (refused) return { error: refused };
        return { target };
    };

    /** Everything an action does first: allowed, holding the mouse. */
    const begin = async () => allowed() || drive();

    const brief = window => (window ? { id: window.hwnd, title: window.title, app: window.process } : undefined);

    const settled = (answer, extra = {}) => ({
        ...extra,
        ...(answer.under ? { under: answer.under } : {}),
    });

    /** A read, as the agent gets it back. */
    const present = answer => ({
        window: brief(answer.window),
        elements: formatTree(answer.nodes),
        ...(answer.truncated ? { truncated: 'Stopped before the end. Read part of it with under: <id>.' } : {}),
        ...(answer.nodes.length <= 6 ? {
            sparse: 'Very little is exposed here: some apps (Electron, games, canvas) do not describe their '
                + 'insides to UI Automation. Keyboard shortcuts may still work.',
        } : {}),
    });

    /**
     * The window in front, read, after an action. The agent read the screen
     * after nearly every action anyway, and each read was a turn of its own,
     * seconds of thinking to ask for what the action could have handed back.
     * An app the user has not allowed is named but not read.
     */
    const look = async (window = null) => {
        let target = window;
        if (!target) {
            const front = await call('foreground');
            target = front.ok ? front.window : null;
        }
        if (!target || target.protected) return {};
        const app = String(target.process || '').toLowerCase();
        if (!consents.get(state.id)?.has(app)) {
            return { now: `${target.process} is in front ("${target.title}"). read_screen it to carry on; the user is asked first.` };
        }
        const answer = await call('tree', { hwnd: target.hwnd, maxNodes: 300 }, 45000);
        return answer.ok ? { screen: present(answer) } : {};
    };

    const clickAt = async (target, { button = 'left', count = 1, modifiers = '' } = {}) => {
        const answer = await call('click', {
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

    /** The window in front, if the user allowed its app. */
    const front = async () => {
        const answer = await call('foreground');
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

    const doType = async ({ text, element, x, y, replace }) => {
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
            const cleared = await call('keys', { keys: 'ctrl+a' });
            if (!cleared.ok) return { error: explain(cleared) };
        }
        // A secret is filled in here, at the last moment. The model wrote
        // the reference; the transcript keeps the reference.
        const filled = state.resolveSecrets(String(text ?? ''));
        if (!filled) return { error: 'Nothing to type.' };
        const { cps } = pace();
        const answer = await call('type', { text: filled, cps }, 15000 + Math.ceil((filled.length / cps) * 1500));
        if (!answer.ok) return { error: explain(answer) };
        return { typed: `${answer.typed} characters` };
    };

    const doKeys = async ({ keys, window, repeat }) => {
        if (!keys) return { error: 'Name the keys, like "ctrl+s" or "enter".' };
        if (window) {
            const picked = await pickWindow(window);
            if (picked.error) return picked;
            const denied = await consent(picked.window);
            if (denied) return { error: denied };
            const focused = await call('focus', { hwnd: picked.window.hwnd });
            if (!focused.ok) return { error: explain(focused) };
        } else {
            const shown = await front();
            if (shown.error) return shown;
        }
        const answer = await call('keys', { keys, repeat });
        if (!answer.ok) return { error: explain(answer) };
        return { pressed: keys };
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
        const answer = await call('scroll', { x: target.x, y: target.y, rect: target.rect, direction, amount, glide: pace().glide });
        if (!answer.ok) return { error: explain(answer) };
        return settled(answer, { scrolled: `${direction} ${amount || 3}` });
    };

    const doDrag = async ({ fromElement, fromX, fromY, toElement, toX, toY }) => {
        const from = await aim({ element: fromElement, x: fromX, y: fromY });
        if (from.error) return from;
        const to = await aim({ element: toElement, x: toX, y: toY });
        if (to.error) return to;
        const answer = await call('drag', {
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
     * Until something shows up. Searched without renumbering anything, so
     * the numbers the agent holds, and the steps after this one, stay good.
     */
    const doWait = async ({ text, role, window, seconds, timeout }) => {
        if (!text) return { error: 'Say what to wait for.' };
        const picked = await pickWindow(window);
        if (picked.error) return picked;
        const denied = await consent(picked.window);
        if (denied) return { error: denied };
        const limit = Math.min(60, Math.max(1, seconds || timeout || 10));
        const deadline = Date.now() + limit * 1000;
        do {
            const answer = await call('tree', { hwnd: picked.window.hwnd, find: String(text), role: role || '' }, 45000);
            if (!answer.ok) return { error: explain(answer) };
            if (answer.found) return { found: `${answer.found.r} "${answer.found.n}"`, window: picked.window };
            await new Promise(resolve => setTimeout(resolve, 400));
        } while (Date.now() < deadline);
        return { error: `Nothing matching "${text}" appeared within ${limit} seconds.` };
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
    };

    /** An action as a tool: take the mouse, do it, and hand back the window. */
    const act = step => async (input = {}) => {
        const refused = await begin();
        if (refused) return { error: refused };
        const result = await step(input);
        if (result.error) return result;
        return input.read === false ? result : { ...result, ...(await look()) };
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

        async open({ app, args = '' }) {
            const refused = await begin();
            if (refused) return { error: refused };
            const answer = await call('launch', { target: app, args }, 30000);
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
        },

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
            const answer = await call('tree', { ...payload, maxNodes: maxElements || 300, offscreen: Boolean(offscreen) }, 45000);
            if (!answer.ok) return { error: explain(answer) };
            return present(answer);
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
            const answer = await call('text', payload, 45000);
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

        async waitFor(input = {}) {
            const refused = allowed();
            if (refused) return { error: refused };
            const result = await doWait(input);
            if (result.error) return result;
            return { found: result.found, ...(await look(result.window)) };
        },

        /**
         * Several actions in one turn, in order, stopping at the first that
         * fails. The numbers from the last read hold for all of them, since
         * nothing is read in between; the window is read once, at the end.
         */
        async steps({ steps = [] }) {
            const refused = await begin();
            if (refused) return { error: refused };
            const done = [];
            for (const [index, step] of steps.entries()) {
                const run = STEPS[step?.do];
                if (!run) return { error: `Step ${index + 1}: there is no action "${step?.do}".` };
                const result = await run(step);
                if (result.error) {
                    const after = await look();
                    const screen = after.screen ? `\n\nThe window now:\n${after.screen.elements}` : (after.now ? `\n\n${after.now}` : '');
                    return {
                        error: `Step ${index + 1} of ${steps.length} (${step.do}) failed: ${result.error}`
                            + `${done.length ? ` The ${done.length} before it were done.` : ''}${screen}`,
                    };
                }
                done.push(`${index + 1}. ${Object.entries(result).filter(([key]) => key !== 'window').map(([key, value]) => `${key} ${value}`).join(', ')}`);
            }
            return { done, ...(await look()) };
        },
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
        let line = `${pad}[${node.id}] ${node.r}`;
        if (node.n) line += ` "${node.n}"`;
        if (node.v) line += ` = "${node.v}"`;
        if (node.len) line += ` (${node.len} characters; read_text ${node.id} for all)`;
        if (node.s) line += ` (${node.s})`;
        return line;
    }).join('\n');
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
        holder: () => holder,
        reset: () => {
            shutdown();
            holder = null;
            consents.clear();
        },
    },
};
