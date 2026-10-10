/**
 * A stand-in for desktop-helper.exe, speaking its protocol over stdin and
 * stdout, for test/computer.test.js. Every request is appended to the log
 * file named first on the command line, so a test can see what reached it.
 *
 * Two apps are open: Notepad in front and a Command Prompt behind it.
 * Element 99 is where the user "takes over": clicking it answers as the real
 * helper does when a hand touches the mouse mid-action. Pressing "f12" has the
 * user press Esc instead.
 *
 * Typing "slowly" answers only once a cancel names it, as long typing does
 * when it runs past its time; typing "stuck" never answers at all, like a
 * helper caught in an app that stopped answering.
 *
 * The window changes when told to, for the reads after an action: aiming at
 * element 8 opens a small dialog in Notepad, "f5" swaps the whole window for
 * another, and "f6" puts it back as it was. A file named like the log with
 * ".private" beside it makes the clipboard hold a password manager's copy.
 */
const fs = require('fs');
const readline = require('readline');

const log = process.argv[2];
const WINDOWS = [
    { hwnd: 101, title: 'notes.txt - Notepad', process: 'Notepad.exe', pid: 11, x: 0, y: 0, width: 800, height: 600, minimized: false, foreground: true, protected: false, elevated: false },
    { hwnd: 202, title: 'Command Prompt', process: 'cmd.exe', pid: 22, x: 100, y: 100, width: 600, height: 400, minimized: false, foreground: false, protected: false, elevated: false },
];
const NODES = [
    { id: 1, d: 0, r: 'window', n: 'notes.txt - Notepad' },
    { id: 2, d: 1, r: 'document', n: 'Text editor', v: 'hello', len: 9000, s: 'focused' },
    { id: 3, d: 1, r: 'button', n: 'Save' },
    { d: 1, offscreen: 12 },
    { d: 1, more: 4 },
];
// A long document, for read_text's pages.
const LONG = 'x'.repeat(70000);

/*
 * A captcha, scripted by the test through a file beside the log:
 * { stage, tiles, rounds }. Clicks move it on as the real widgets do: the
 * reCAPTCHA box opens a grid, Verify passes it once two tiles are pressed
 * (a new round first, while `rounds` is above one), and Turnstile's box goes
 * quiet once pressed.
 */
const SCENARIO = `${log}.captcha`;
const scenario = () => (fs.existsSync(SCENARIO) ? JSON.parse(fs.readFileSync(SCENARIO, 'utf8')) : { stage: 'none' });
const save = state => fs.writeFileSync(SCENARIO, JSON.stringify(state));

const BOX = [100, 200, 30, 30];
const GRID = [300, 100, 400, 580];
const VERIFY = [600, 640, 90, 30];
const TURNSTILE_BOX = [100, 300, 300, 50];
const RECTS = { 61: BOX, 63: VERIFY, 64: [310, 640, 30, 30], 65: VERIFY, 66: [310, 640, 30, 30], 71: TURNSTILE_BOX, 81: [100, 400, 200, 60] };

/*
 * An hCaptcha, dealing a different puzzle each round from `puzzles`
 * ('click', 'drag', 'area'). Its button reads Skip until an answer of the
 * right kind lands (a click for a click puzzle, a drag for a drag one), and
 * Verify after; `deaf` makes nothing land. Skip and Refresh deal the next
 * puzzle; Verify after an answer passes it once the puzzles run out.
 */
const PUZZLE_WORDS = {
    click: 'Seleziona tutte le immagini con una barca',
    drag: 'Sposta la fiala corretta nell\'alloggiamento vuoto corrispondente alla sua forma',
    area: 'Disegna un contorno attorno al cane',
};
const hchallenge = state => ({
    kind: 'hcaptcha', part: 'challenge', url: 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=challenge', id: 67,
    rect: GRID, visible: true,
    buttons: [
        { id: 66, name: 'Aggiorna sfida.', cls: 'refresh button', rect: RECTS[66], enabled: true, visible: true },
        { id: 65, name: state.answered ? 'Verifica la risposta' : 'Salta la sfida', cls: 'button-submit button', rect: VERIFY, enabled: true, visible: true },
    ],
    text: PUZZLE_WORDS[(state.puzzles || [])[state.index || 0]] || '',
});

const anchor = (extra = {}) => ({
    kind: 'recaptcha', part: 'checkbox', url: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc', id: 60,
    rect: [90, 190, 300, 80], visible: true, buttons: [], text: '', ...extra,
});
const bframe = visible => ({
    kind: 'recaptcha', part: 'challenge', url: 'https://www.google.com/recaptcha/api2/bframe?k=abc', id: 62, rect: GRID, visible,
    buttons: [
        { id: 64, name: 'Get a new challenge', aid: 'recaptcha-reload-button', rect: RECTS[64], enabled: true, visible },
        { id: 63, name: 'Verifica', aid: 'recaptcha-verify-button', rect: VERIFY, enabled: true, visible },
    ],
    text: 'Seleziona tutte le immagini con autobus',
});
const turnstile = extra => ({
    kind: 'turnstile', part: 'checkbox', url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0', id: 70,
    rect: [90, 290, 450, 70], visible: true, buttons: [], text: '', ...extra,
});

function captchaScan() {
    const current = scenario();
    const { stage } = current;
    const box = state => ({ checkbox: { id: 61, name: 'Non sono un robot', rect: BOX, state, visible: true } });
    switch (stage) {
        case 'hcaptcha': return { widgets: [hchallenge(current)], images: [] };
        case 'hcaptcha-done': return { widgets: [], images: [] };
        case 'checkbox': return { widgets: [anchor(box('unchecked')), bframe(false)], images: [] };
        case 'challenge': return { widgets: [anchor(box('unchecked')), bframe(true)], images: [] };
        case 'checked': return { widgets: [anchor(box('checked')), bframe(false)], images: [] };
        case 'invisible': return { widgets: [anchor(), bframe(false)], images: [] };
        case 'turnstile': return { widgets: [turnstile({ checkbox: { id: 71, name: 'Verify you are human', rect: TURNSTILE_BOX, state: 'unchecked', visible: true } })], images: [] };
        case 'turnstile-quiet': return { widgets: [turnstile({ text: 'Success!' })], images: [] };
        case 'image': return { widgets: [], images: [{ id: 81, name: 'CAPTCHA image', rect: RECTS[81], visible: true }] };
        default: return { widgets: [], images: [] };
    }
}

function hcaptchaAct(state, how, x, y) {
    const inside = ([left, top, width, height]) => x >= left && x <= left + width && y >= top && y <= top + height;
    const puzzle = (state.puzzles || [])[state.index || 0];
    const next = () => { state.index = (state.index || 0) + 1; state.answered = false; };
    if (how === 'click' && inside(RECTS[66])) {
        state.refreshes = (state.refreshes || 0) + 1;
        next();
    } else if (how === 'click' && inside(VERIFY)) {
        if (!state.answered) {
            state.skips = (state.skips || 0) + 1;
            next();
        } else if ((state.index || 0) + 1 >= state.puzzles.length) {
            state.stage = 'hcaptcha-done';
        } else {
            next();
        }
    } else if (inside(GRID) && how === puzzle && !state.deaf) {
        state.answered = true;
    }
}

function captchaDrag(x, y) {
    const state = scenario();
    if (state.stage === 'hcaptcha') {
        hcaptchaAct(state, 'drag', x, y);
        save(state);
    }
}

function captchaClick(x, y) {
    const state = scenario();
    const inside = ([left, top, width, height]) => x >= left && x <= left + width && y >= top && y <= top + height;
    if (state.stage === 'hcaptcha') {
        hcaptchaAct(state, 'click', x, y);
    } else if (state.stage === 'checkbox' && inside(BOX)) {
        state.stage = 'challenge';
    } else if (state.stage === 'challenge' && inside(VERIFY)) {
        if ((state.tiles || 0) >= 2) {
            if ((state.rounds || 1) > 1) {
                state.rounds -= 1;
                state.tiles = 0;
            } else {
                state.stage = 'checked';
            }
        }
    } else if (state.stage === 'challenge' && inside(GRID)) {
        state.tiles = (state.tiles || 0) + 1;
    } else if (state.stage === 'turnstile' && inside(TURNSTILE_BOX)) {
        state.stage = 'turnstile-quiet';
    }
    if (state.stage !== 'none') save(state);
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

send({ event: 'ready', version: 'fake', elevated: false });

let front = WINDOWS[0];
// The id of typing that answers only when asked to stop.
let slowType = null;
// How the window stands: a dialog open in it, or swapped for another.
let opened = false;
let swapped = false;

const DIALOG = [
    { id: 50, d: 1, r: 'dialog', n: 'Saved' },
    { id: 51, d: 2, r: 'button', n: 'OK' },
];
const ELSEWHERE = [
    { id: 60, d: 0, r: 'window', n: 'Elsewhere' },
    ...Array.from({ length: 15 }, (unused, index) => ({ id: 61 + index, d: 1, r: 'button', n: `Other ${index + 1}` })),
];
const nodesNow = () => (swapped ? ELSEWHERE : [...NODES, ...(opened ? DIALOG : [])]);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    fs.appendFileSync(log, `${line}\n`);
    const reply = body => send({ id: request.id, ok: true, ...body });
    const refuse = (code, error) => send({ id: request.id, ok: false, code, error });

    switch (request.cmd) {
        case 'windows': return reply({ windows: WINDOWS });
        // The window in front is whichever was last brought forward.
        case 'foreground': return reply({ window: front });
        case 'focus': {
            front = WINDOWS.find(w => w.hwnd === request.hwnd) || WINDOWS[0];
            return reply({ window: front });
        }
        case 'place': {
            const window = WINDOWS.find(w => w.hwnd === request.hwnd) || WINDOWS[0];
            const x = request.slot === 'right' ? 1280 : 0;
            return reply({ window, bounds: [x, 0, 1280, 1400] });
        }
        case 'forget': return reply({});
        case 'drive': return reply({});
        case 'tree': {
            const window = WINDOWS.find(w => w.hwnd === request.hwnd) || WINDOWS[0];
            // A search numbers nothing: "Save" is there, anything else is not.
            if (request.find) return reply({ window, ...(/save/i.test(request.find) ? { found: { r: 'button', n: 'Save' } } : {}) });
            // With a reCAPTCHA scripted, its frame is in the read as Chrome shows one.
            const framed = ['checkbox', 'challenge', 'checked', 'invisible'].includes(scenario().stage);
            const nodes = framed
                ? [...nodesNow(), { id: 9, d: 1, r: 'group', n: 'reCAPTCHA', v: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=abc' }]
                : nodesNow();
            return reply({ window, nodes, truncated: false });
        }
        case 'captcha': return reply({ window: WINDOWS[0], ...captchaScan() });
        case 'text': return reply({ text: LONG, length: LONG.length });
        case 'target': {
            if (request.element === 42) return refuse('protected', 'That is on the Acestes window itself, which the agent may not touch.');
            if (request.element === 8) opened = true;
            if (request.element === undefined) {
                // A point from a screenshot: Notepad sits at 0,0, 800x600,
                // except that aiming at 796,596 finds it nudged since.
                const frame = request.x === 796 ? [5, 5, 800, 600] : [0, 0, 800, 600];
                return reply({ x: request.x, y: request.y, window: WINDOWS[0], ...(request.hwnd ? { frame } : {}) });
            }
            const window = request.element === 7 ? WINDOWS[1] : WINDOWS[0];
            // Aiming brings the element's window forward, as the real one does.
            front = window;
            const rect = RECTS[request.element];
            if (rect) return reply({ x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2, rect, window });
            return reply({ x: 50, y: 60, rect: [40, 50, 20, 20], window });
        }
        case 'capture': {
            // Windows at their bounds, shrunk by half; a region as it is.
            const region = request.region || [0, 0, 800, 600];
            const scale = request.region ? 1 : 0.5;
            return reply({
                data: request.format === 'jpeg' ? '/9j/4AAQ' : 'iVBORw0KGgo=',
                mediaType: request.format === 'jpeg' ? 'image/jpeg' : 'image/png',
                width: region[2] * scale,
                height: region[3] * scale,
                region,
                scale,
                // A numbered picture brings the read its numbers come from.
                ...(request.marks ? { window: WINDOWS[0], nodes: nodesNow(), truncated: false, marked: 2 } : {}),
            });
        }
        case 'click': {
            if (request.x === 50 && request.y === 60 && request.count === 3) {
                send({ event: 'took-over', by: 'mouse' });
                return refuse('took-over', 'The user took control of the mouse or keyboard.');
            }
            captchaClick(request.x, request.y);
            return reply({ under: 'button "Save"', window: WINDOWS[0] });
        }
        case 'type': {
            if (request.text === 'slowly') {
                slowType = request.id;
                return undefined;
            }
            if (request.text === 'stuck') return undefined;
            return reply({ typed: request.text.length, window: WINDOWS[0] });
        }
        // Answers nothing itself: it stops the request it names, which answers.
        case 'cancel': {
            if (request.target === slowType) {
                send({ id: slowType, ok: false, code: 'cancelled', error: 'Stopped by the app. 3 of 6 characters were typed.' });
                slowType = null;
            }
            return undefined;
        }
        case 'keys': {
            if (request.keys === 'f12') send({ event: 'escape' });
            if (request.keys === 'f5') swapped = true;
            if (request.keys === 'f6') {
                swapped = false;
                opened = false;
            }
            return reply({ window: WINDOWS[0] });
        }
        case 'settle': return reply({ settled: true, ms: 1 });
        case 'move': return reply({ under: 'button "Save"', window: WINDOWS[0] });
        case 'button': return reply({ under: 'pane "Canvas"', window: WINDOWS[0] });
        case 'letgo': return reply({});
        case 'clipboard': {
            if (fs.existsSync(`${log}.private`)) return reply({ private: true });
            return reply({ text: 'copied words', files: ['C:\\notes.txt'] });
        }
        case 'scroll': return reply({ under: 'document "Text editor"', window: WINDOWS[0] });
        case 'drag': {
            captchaDrag(request.x, request.y);
            return reply({ under: 'pane "Canvas"', window: WINDOWS[0] });
        }
        case 'launch': {
            front = { ...WINDOWS[0], hwnd: 303, title: 'Untitled - Paint', process: 'mspaint.exe' };
            return reply({ window: front });
        }
        default: return refuse('unknown', `Unknown command: ${request.cmd}`);
    }
});
