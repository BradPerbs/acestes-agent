/**
 * Computer use, the rules in front of the helper: switched on per agent, in
 * person only, one driver at a time, the user's say-so per app, a hand on the
 * mouse pausing it, Esc stopping the turn, and secrets typed at the last
 * moment. Run against a stand-in helper (fixtures/fake-desktop-helper.js),
 * so nothing here touches the real desktop.
 *
 * At the end, the real helper is asked two questions that move nothing
 * (ping, and the list of windows), when it has been built on this machine.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-computer-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', getAppPath: () => path.join(__dirname, '..'), on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const computer = require(path.join(ROOT, 'ai', 'computer'));
const tools = require(path.join(ROOT, 'ai', 'tools'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.stack || error.message}`);
    }
}

const log = path.join(userData, 'helper.log');
const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
const clearLog = () => fs.writeFileSync(log, '');

/** A conversation as computer.js sees one, with every answer scripted. */
function conversation(id, overrides = {}) {
    const asked = [];
    const state = {
        id,
        title: () => `Chat ${id}`,
        runKind: () => 'interactive',
        settings: () => ({ computerUse: true, computerPace: 'fast' }),
        agentName: () => 'Acestes',
        answer: 'Allow in this conversation',
        ask: async (payload) => {
            asked.push(payload);
            return { answered: true, answer: state.answer, chosen: true };
        },
        resolveSecrets: text => text.replace('{{secret:wifi}}', 'hunter2'),
        canSee: () => true,
        ...overrides,
    };
    return { state, asked, api: computer.apiFor(state) };
}

(async () => {
    computer._test.useHelper({ file: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-desktop-helper.js'), log] });
    computer._test.setPlatform('win32');
    const busy = new Set();
    const interrupted = [];
    const surfaced = [];
    const hidden = [];
    computer.configure({
        isBusy: id => busy.has(id),
        interrupt: (id) => { interrupted.push(id); },
        surface: (id) => { surfaced.push(id); },
        hideFromCapture: (on) => { hidden.push(on); },
    });

    console.log('\nswitched on, in person');

    await check('off by default, and the agent is told where the switch is', async () => {
        const { api } = conversation('c-off', { settings: () => ({}) });
        const result = await api.windows();
        assert.ok(/switched off/.test(result.error) && /Settings/.test(result.error), result.error);
    });

    await check('a background run is refused: nobody is watching it', async () => {
        const { api } = conversation('c-job', { runKind: () => 'scheduled' });
        assert.ok(/background run/.test((await api.click({ element: 3 })).error));
    });

    await check('Windows only, for now', async () => {
        computer._test.setPlatform('darwin');
        const { api } = conversation('c-mac');
        const result = await api.windows();
        computer._test.setPlatform('win32');
        assert.ok(/Windows only/.test(result.error), result.error);
    });

    console.log('\nreading, with the user\'s say-so');

    await check('the windows are listed front to back, with their apps', async () => {
        const { api } = conversation('c-read');
        const result = await api.windows();
        assert.deepStrictEqual(result.windows.map(window => window.app), ['Notepad.exe', 'cmd.exe']);
        assert.strictEqual(result.windows[0].front, true);
    });

    await check('reading an app asks first, once, and a no is final', async () => {
        clearLog();
        const { api, asked, state } = conversation('c-consent');
        state.answer = 'Don\'t allow';
        const refused = await api.read({});
        assert.ok(/did not allow/.test(refused.error), refused.error);
        assert.ok(!sent().some(request => request.cmd === 'tree'), 'nothing was read');

        state.answer = 'Allow in this conversation';
        const read = await api.read({ window: 'notepad' });
        assert.ok(!read.error, read.error);
        assert.strictEqual(asked.length, 2);
        assert.ok(/Notepad\.exe/.test(asked[1].question));
        assert.deepStrictEqual(asked[1].options, ['Allow in this conversation', 'Don\'t allow']);
        assert.strictEqual(read.elements, [
            '[1] window "notes.txt - Notepad"',
            '  [2] document "Text editor" = "hello" (9000 characters; read_text 2 for all) (focused)',
            '  [3] button "Save"',
            '  … 12 scrolled out of view',
            '  … 4 more',
        ].join('\n'));
        assert.strictEqual(sent().find(request => request.cmd === 'tree').maxNodes, 300, 'a smaller read by default');
        await api.read({ window: 'notepad' });
        assert.strictEqual(asked.length, 2, 'not asked again in the same conversation');
        assert.ok(surfaced.includes('c-consent'), 'Acestes is brought forward for the question');
    });

    await check('an app that reaches further says so in the question', async () => {
        const { api, asked } = conversation('c-warn');
        await api.read({ window: 'cmd' });
        assert.ok(/terminal/.test(asked[0].question), asked[0].question);
    });

    await check('a window nobody has open is named as such', async () => {
        const { api } = conversation('c-none');
        assert.ok(/No window matches/.test((await api.read({ window: 'photoshop' })).error));
    });

    console.log('\nacting, and who is driving');

    await check('a click takes the desktop with a badge naming the agent, aims, and clicks at the pace set', async () => {
        clearLog();
        const { api } = conversation('c-click');
        busy.add('c-click');
        const result = await api.click({ element: 3 });
        assert.ok(!result.error, result.error);
        assert.strictEqual(result.under, 'button "Save"');
        assert.strictEqual(result.screen.window.app, 'Notepad.exe');
        assert.ok(result.screen.elements.includes('[3] button "Save"'), 'the window comes back read, so no read_screen turn is needed');
        const requests = sent();
        const drive = requests.find(request => request.cmd === 'drive');
        assert.strictEqual(drive.on, true);
        assert.ok(/^Acestes is using your computer/.test(drive.label), drive.label);
        const click = requests.find(request => request.cmd === 'click');
        assert.deepStrictEqual([click.x, click.y, click.glide], [50, 60, computer.PACES.fast.glide]);
        assert.deepStrictEqual(click.rect, [40, 50, 20, 20], 'the outline goes where it aims');
    });

    await check('another conversation waits while one is driving, and gets it once that turn ends', async () => {
        const other = conversation('c-other');
        const blocked = await other.api.click({ element: 3 });
        assert.ok(/in use by another conversation, "Chat c-click"/.test(blocked.error), blocked.error);
        clearLog();
        busy.delete('c-click');
        computer.release('c-click');
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(sent().some(request => request.cmd === 'drive' && request.on === false), 'the badge goes at the end of the turn');
        busy.add('c-other');
        const result = await other.api.click({ element: 3 });
        assert.ok(!result.error, result.error);
        busy.delete('c-other');
        computer.release('c-other');
    });

    await check('the Acestes window is refused by the helper, and the refusal is passed on', async () => {
        const { api } = conversation('c-protect');
        busy.add('c-protect');
        const result = await api.click({ element: 42 });
        assert.ok(/Acestes window itself/.test(result.error), result.error);
        busy.delete('c-protect');
        computer.release('c-protect');
    });

    await check('a hand on the mouse pauses the agent until the next turn', async () => {
        clearLog();
        const { api } = conversation('c-hand');
        busy.add('c-hand');
        const stopped = await api.click({ element: 3, count: 3 });
        assert.ok(/took control/.test(stopped.error), stopped.error);
        const before = sent().length;
        const next = await api.click({ element: 3 });
        assert.ok(/took control/.test(next.error), 'still paused');
        assert.strictEqual(sent().length, before, 'the helper is not even asked');
        busy.delete('c-hand');
        computer.release('c-hand');
        busy.add('c-hand');
        assert.ok(!(await api.click({ element: 3 })).error, 'a new turn starts clean');
        busy.delete('c-hand');
        computer.release('c-hand');
    });

    await check('Esc stops the conversation that is driving', async () => {
        const { api } = conversation('c-esc');
        busy.add('c-esc');
        await api.keys({ keys: 'f12' });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepStrictEqual(interrupted, ['c-esc']);
        assert.ok(/Esc/.test((await api.click({ element: 3 })).error));
        busy.delete('c-esc');
        computer.release('c-esc');
    });

    await check('a secret is typed from its reference, and never handed back', async () => {
        clearLog();
        const { api } = conversation('c-type');
        busy.add('c-type');
        const result = await api.type({ text: 'pass: {{secret:wifi}}', element: 2 });
        assert.ok(!result.error, result.error);
        const typed = sent().find(request => request.cmd === 'type');
        assert.strictEqual(typed.text, 'pass: hunter2');
        assert.ok(!JSON.stringify(result).includes('hunter2'));
        assert.ok(sent().some(request => request.cmd === 'click'), 'the field is clicked first');
        busy.delete('c-type');
        computer.release('c-type');
    });

    await check('replace selects what the field holds before typing', async () => {
        clearLog();
        const { api } = conversation('c-replace');
        busy.add('c-replace');
        await api.type({ text: 'new', replace: true });
        const order = sent().map(request => request.cmd).filter(cmd => cmd === 'keys' || cmd === 'type');
        assert.deepStrictEqual(order, ['keys', 'type']);
        assert.strictEqual(sent().find(request => request.cmd === 'keys').keys, 'ctrl+a');
        busy.delete('c-replace');
        computer.release('c-replace');
    });

    await check('read: false skips the read after an action', async () => {
        clearLog();
        const { api } = conversation('c-quiet');
        busy.add('c-quiet');
        await api.read({ window: 'notepad' });
        clearLog();
        const result = await api.click({ element: 3, read: false });
        assert.ok(!result.error && !result.screen);
        assert.ok(!sent().some(request => request.cmd === 'tree'));
        busy.delete('c-quiet');
        computer.release('c-quiet');
    });

    await check('do_steps runs a sequence in one call, keeps the numbers good, and reads once at the end', async () => {
        const { api } = conversation('c-steps');
        busy.add('c-steps');
        await api.read({ window: 'notepad' });
        clearLog();
        const result = await api.steps({
            steps: [
                { do: 'click', element: 2 },
                { do: 'type', text: 'invoice 4026\n', replace: true },
                { do: 'wait_for', text: 'save', seconds: 2 },
                { do: 'keys', keys: 'ctrl+s' },
            ],
        });
        assert.ok(!result.error, result.error);
        assert.strictEqual(result.done.length, 4);
        assert.ok(/^3\. found button "Save"/.test(result.done[2]), result.done[2]);
        const trees = sent().filter(request => request.cmd === 'tree');
        assert.ok(trees.slice(0, -1).every(request => request.find), 'waiting searched without renumbering');
        assert.ok(!trees.at(-1).find, 'one read, at the end');
        assert.ok(result.screen.elements.includes('[2] document'));
        busy.delete('c-steps');
        computer.release('c-steps');
    });

    await check('do_steps stops at the first step that fails, says which, and shows the window as it is', async () => {
        clearLog();
        const { api } = conversation('c-steps-fail');
        busy.add('c-steps-fail');
        const result = await api.steps({
            steps: [
                { do: 'click', element: 3 },
                { do: 'click', element: 42 },
                { do: 'type', text: 'never typed' },
            ],
        });
        assert.ok(/^Step 2 of 3 \(click\) failed: .*Acestes window itself/.test(result.error), result.error);
        assert.ok(/The 1 before it were done/.test(result.error));
        assert.ok(/The window now:\n\[1\] window/.test(result.error));
        assert.ok(!sent().some(request => request.cmd === 'type'), 'nothing after the failure ran');
        busy.delete('c-steps-fail');
        computer.release('c-steps-fail');
    });

    await check('read_text hands back a long text a page at a time', async () => {
        const { api } = conversation('c-text');
        const first = await api.text({ window: 'notepad' });
        assert.strictEqual(first.length, 70000);
        assert.strictEqual(first.text.length, 30000);
        assert.strictEqual(first.nextOffset, 30000);
        const last = await api.text({ window: 'notepad', offset: 60000 });
        assert.strictEqual(last.text.length, 10000);
        assert.strictEqual(last.nextOffset, undefined);
    });

    await check('opening an app is not leave to control it: the window it opened is asked about by name', async () => {
        const { api, asked, state } = conversation('c-open');
        busy.add('c-open');
        state.answer = 'Don\'t allow';
        const opened = await api.open({ app: 'mspaint' });
        assert.strictEqual(opened.window.app, 'mspaint.exe');
        assert.strictEqual(asked.length, 1);
        assert.ok(/"Untitled - Paint"/.test(asked[0].question), asked[0].question);
        assert.ok(/did not allow/.test(opened.notAllowed));
        assert.ok(/before typing into it/.test(opened.check));
        assert.strictEqual(opened.screen, undefined, 'a window the user did not allow is not read');
        busy.delete('c-open');
        computer.release('c-open');
    });

    console.log('\nscreenshots');

    await check('a runtime that cannot see images is told so, and nothing is captured', async () => {
        clearLog();
        const { api } = conversation('c-blind', { canSee: () => false });
        busy.add('c-blind');
        const result = await api.screenshot({});
        assert.ok(/cannot see images/.test(result.error), result.error);
        assert.ok(!sent().some(request => request.cmd === 'capture'));
        busy.delete('c-blind');
        computer.release('c-blind');
    });

    await check('a screenshot brings the window forward, keeps Acestes out, and is sized for the model', async () => {
        clearLog();
        hidden.length = 0;
        const { api } = conversation('c-shot');
        busy.add('c-shot');
        const result = await api.screenshot({ window: 'notepad' });
        assert.ok(!result.error, result.error);
        assert.deepStrictEqual(result.image, { mediaType: 'image/png', data: 'iVBORw0KGgo=' });
        assert.strictEqual(result.screenshot.size, '400×300');
        const order = sent().map(request => request.cmd).filter(cmd => cmd === 'focus' || cmd === 'capture');
        assert.deepStrictEqual(order, ['focus', 'capture'], 'to the front, then pictured');
        assert.deepStrictEqual(hidden, [true, false], 'Acestes hidden for the capture only');
        assert.strictEqual(sent().find(request => request.cmd === 'capture').maxLong, 1568);
    });

    await check('x and y are pixels of the screenshot, scaled back to the screen, with its window brought forward', async () => {
        clearLog();
        const { api } = conversation('c-shot');
        const result = await api.click({ x: 100, y: 50 });
        assert.ok(!result.error, result.error);
        const target = sent().find(request => request.cmd === 'target');
        assert.deepStrictEqual([target.x, target.y, target.hwnd], [200, 100, 101]);
        const click = sent().find(request => request.cmd === 'click');
        assert.deepStrictEqual([click.x, click.y], [200, 100]);
    });

    await check('working from pictures, an action hands back a fresh screenshot rather than a read', async () => {
        clearLog();
        const { api } = conversation('c-shot');
        const result = await api.drag({ fromX: 10, fromY: 10, toX: 200, toY: 150 });
        assert.ok(!result.error, result.error);
        assert.ok(result.image && result.screenshot, 'pictured');
        assert.ok(!result.screen, 'not read');
        assert.ok(sent().some(request => request.cmd === 'capture'));
    });

    await check('a point outside the picture, or in a window that has moved since, is refused', async () => {
        const { api } = conversation('c-shot');
        assert.ok(/outside your latest screenshot, which is 400×300/.test((await api.click({ x: 500, y: 10 })).error));
        assert.ok(/moved or changed size/.test((await api.click({ x: 398, y: 298 })).error));
    });

    await check('zoom takes its region from the screenshot and leaves the frame alone', async () => {
        clearLog();
        const { api } = conversation('c-shot');
        const zoomed = await api.zoom({ x0: 0, y0: 0, x1: 100, y1: 50 });
        assert.ok(zoomed.image);
        assert.deepStrictEqual(sent().find(request => request.cmd === 'capture').region, [0, 0, 200, 100]);
        clearLog();
        await api.click({ x: 100, y: 50 });
        assert.strictEqual(sent().find(request => request.cmd === 'target').x, 200, 'still the screenshot\'s pixels');
    });

    await check('reading the tree again goes back to reads after actions', async () => {
        const { api } = conversation('c-shot');
        await api.read({ window: 'notepad' });
        const result = await api.click({ element: 3 });
        assert.ok(result.screen && !result.image);
        busy.delete('c-shot');
        computer.release('c-shot');
    });

    await check('without a screenshot, x and y are refused rather than guessed at', async () => {
        const { api } = conversation('c-noshot');
        busy.add('c-noshot');
        assert.ok(/Take one first/.test((await api.click({ x: 10, y: 10 })).error));
        busy.delete('c-noshot');
        computer.release('c-noshot');
    });

    await check('a picture goes out beside the text, and the transcript gets the text alone', async () => {
        const result = await tools.BY_NAME.get('screenshot').handler({}, {
            computer: { screenshot: async () => ({ screenshot: { size: '10×10' }, image: { mediaType: 'image/png', data: 'AAAA' } }) },
        });
        assert.strictEqual(result.images.length, 1);
        assert.ok(!result.text.includes('AAAA'), 'the text does not carry the picture');
        assert.deepStrictEqual(tools.contentOf(result), [
            { type: 'text', text: result.text },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ]);
    });

    console.log('\ncaptchas');

    const captcha = require(path.join(ROOT, 'ai', 'captcha'));
    const scenarioFile = `${log}.captcha`;
    const script = state => fs.writeFileSync(scenarioFile, JSON.stringify(state));
    const clicks = () => sent().filter(request => request.cmd === 'click');
    const inRect = ([x, y, width, height]) => click => click.x >= x && click.x <= x + width && click.y >= y && click.y <= y + height;

    // A captcha service, answering as 2Captcha and CapSolver do.
    const solverCalls = [];
    let solverReply = () => ({ errorId: 0, status: 'ready', solution: {} });
    const fakeFetch = async (url, options) => {
        const body = JSON.parse(options.body);
        solverCalls.push({ url, body });
        const answer = solverReply(url, body, solverCalls.length);
        return { status: 200, json: async () => answer };
    };
    computer.configure({
        fetch: fakeFetch,
        captchaTiming: { settle: 5, patience: 300, quiet: 30, tiles: [0, 1], refill: 1, afterVerify: 1, solver: { first: 1, every: 1, limit: 2000 } },
    });
    const withKey = (name, value) => text => text.replace(`{{secret:${name}}}`, value).replace('{{secret:wifi}}', 'hunter2');

    await check('the services\' answers become points, whatever shape they come in', () => {
        assert.deepStrictEqual(captcha.pointsOf({ coordinates: [{ x: 10, y: 20 }] }), [{ x: 10, y: 20 }]);
        assert.deepStrictEqual(captcha.pointsOf({ coordinates: [[10, 20]] }), [{ x: 10, y: 20 }]);
        assert.deepStrictEqual(captcha.pointsOf({ coordinates: [[10, 20, 30, 40]] }), [{ x: 20, y: 30 }], 'a rectangle is pressed in its middle');
        assert.deepStrictEqual(captcha.pointsOf({}), []);
    });

    await check('a service is chosen by the keys in the keychain, and one that cannot click is said so', () => {
        const none = captcha.pick({ resolve: text => text, kind: 'points' });
        assert.ok(none.missing && /"2captcha"/.test(none.error), none.error);
        const textOnly = captcha.pick({ resolve: withKey('capsolver', 'CS'), kind: 'points' });
        assert.ok(/CapSolver cannot say where to click/.test(textOnly.error), textOnly.error);
        assert.strictEqual(captcha.pick({ resolve: withKey('capsolver', 'CS'), kind: 'text' }).id, 'capsolver');
        const two = captcha.pick({ resolve: withKey('2captcha', 'K2'), kind: 'points' });
        assert.deepStrictEqual([two.id, two.key], ['2captcha', 'K2']);
        assert.ok(/no Anti-Captcha key/.test(captcha.pick({ resolve: withKey('2captcha', 'K2'), kind: 'points', wanted: 'anticaptcha' }).error));
        assert.ok(/no captcha service called/.test(captcha.pick({ resolve: text => text, kind: 'points', wanted: 'nope' }).error));
    });

    await check('a task is made, polled until ready, and a refusal is told plainly without the key in it', async () => {
        solverCalls.length = 0;
        solverReply = (url, body, count) => (url.endsWith('/createTask') ? { errorId: 0, taskId: 7 }
            : count < 3 ? { errorId: 0, status: 'processing' }
                : { errorId: 0, status: 'ready', solution: { coordinates: [{ x: 1, y: 2 }] }, cost: '0.0012' });
        const fetch = fakeFetch;
        const solved = await captcha.solve({ service: '2captcha', key: 'SECRET-KEY', kind: 'points', image: 'AAAA', comment: 'buses', fetch, timing: { first: 1, every: 1 } });
        assert.deepStrictEqual(solved.points, [{ x: 1, y: 2 }]);
        assert.strictEqual(solved.cost, '0.0012');
        assert.deepStrictEqual(solverCalls.map(call => call.url), [
            'https://api.2captcha.com/createTask', 'https://api.2captcha.com/getTaskResult', 'https://api.2captcha.com/getTaskResult',
        ]);
        assert.deepStrictEqual(solverCalls[0].body.task, { type: 'CoordinatesTask', body: 'AAAA', comment: 'buses' });
        assert.strictEqual(solverCalls[1].body.taskId, 7);

        solverReply = () => ({ errorId: 10, errorCode: 'ERROR_ZERO_BALANCE' });
        const broke = await captcha.solve({ service: 'anticaptcha', key: 'SECRET-KEY', kind: 'points', image: 'AAAA', fetch });
        assert.ok(/no balance/.test(broke.error) && !broke.error.includes('SECRET-KEY'), broke.error);
    });

    await check('read_screen says when a captcha is on the page', async () => {
        script({ stage: 'checkbox' });
        const { api } = conversation('c-captcha-read');
        const read = await api.read({ window: 'notepad' });
        assert.ok(/reCAPTCHA here\. solve_captcha/.test(read.captcha), read.captcha);
        assert.strictEqual(captcha.spotIn([{ r: 'document', v: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile' }]), 'a Cloudflare check (Turnstile)');
        assert.strictEqual(captcha.spotIn([{ r: 'document', v: 'https://www.google.com/recaptcha/api2/demo' }]), '', 'the demo page itself is not one');
    });

    await check('a reCAPTCHA is ticked by hand, its grid answered by the service, and Verify pressed until it passes', async () => {
        script({ stage: 'checkbox', rounds: 2 });
        clearLog();
        solverCalls.length = 0;
        // Two tiles, and a third place on Verify itself, which is left alone.
        solverReply = url => (url.endsWith('/createTask') ? { errorId: 0, taskId: 9 }
            : { errorId: 0, status: 'ready', solution: { coordinates: [{ x: 50, y: 150 }, { x: 150, y: 150 }, { x: 345, y: 555 }] }, cost: '0.0012' });
        const { api } = conversation('c-captcha', { resolveSecrets: withKey('2captcha', 'KEY-2C') });
        const result = await api.captcha({});
        assert.ok(!result.error, result.error);
        assert.strictEqual(result.solved, true, result.what);
        assert.ok(/reCAPTCHA is ticked/.test(result.what), result.what);
        assert.ok(result.screen, 'the window is handed back');

        const pressed = clicks();
        assert.ok(pressed.every(click => click.natural === true && click.glide >= 420), 'every press is a hand\'s');
        assert.ok(inRect([100, 200, 30, 30])(pressed[0]), 'the box first');
        assert.strictEqual(pressed.filter(inRect([600, 640, 90, 30])).length, 2, 'Verify once per round');
        assert.strictEqual(pressed.filter(click => inRect([300, 100, 400, 580])(click) && !inRect([600, 640, 90, 30])(click)).length, 4, 'two tiles a round');

        const created = solverCalls.filter(call => call.url.endsWith('/createTask'));
        assert.strictEqual(created.length, 2, 'one picture per round');
        assert.strictEqual(created[0].body.clientKey, 'KEY-2C');
        assert.strictEqual(created[0].body.task.type, 'CoordinatesTask');
        assert.strictEqual(created[0].body.task.body, '/9j/4AAQ', 'a JPEG, for the service\'s size limit');
        assert.ok(/autobus/.test(created[0].body.task.comment), 'the words the challenge shows go with it');
        const shot = sent().find(request => request.cmd === 'capture');
        assert.deepStrictEqual([shot.region, shot.format], [[300, 100, 400, 580], 'jpeg']);
        assert.ok(result.done.length >= 3 && /2Captcha answered/.test(result.done[1]), result.done.join(' | '));
    });

    await check('hCaptcha: each round is read for its kind; a drawing round is refreshed free, a drag dragged, a grid clicked', async () => {
        script({ stage: 'hcaptcha', puzzles: ['area', 'drag', 'click'] });
        clearLog();
        solverCalls.length = 0;
        solverReply = url => (url.endsWith('/createTask') ? { errorId: 0, taskId: 11 }
            : { errorId: 0, status: 'ready', solution: { coordinates: [{ x: 60, y: 200 }, { x: 200, y: 120 }] }, cost: '0.0012' });
        const { api } = conversation('c-captcha-h', { resolveSecrets: withKey('2captcha', 'KEY-2C') });
        const result = await api.captcha({});
        assert.ok(!result.error, result.error);
        assert.strictEqual(result.solved, true, `${result.what} | ${(result.done || []).join(' | ')}`);

        const created = solverCalls.filter(call => call.url.endsWith('/createTask'));
        assert.strictEqual(created.length, 2, 'the drawing round costs nothing');
        assert.ok(/DRAG puzzle/.test(created[0].body.task.comment) && /fiala/.test(created[0].body.task.comment), created[0].body.task.comment);
        assert.ok(!/DRAG/.test(created[1].body.task.comment) && /barca/.test(created[1].body.task.comment), created[1].body.task.comment);

        const drags = sent().filter(request => request.cmd === 'drag');
        assert.strictEqual(drags.length, 1, 'one piece dragged');
        assert.deepStrictEqual([drags[0].x, drags[0].y, drags[0].toX, drags[0].toY], [360, 300, 500, 220], 'from the first point to the second');
        const state = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
        assert.strictEqual(state.refreshes, 1);
        assert.ok(!state.skips, 'Skip is never pressed after an answer');
        assert.ok(/drag puzzle: dragged 1 piece/.test(result.done.join(' | ')), result.done.join(' | '));
    });

    await check('hCaptcha: an answer that does not land is refreshed, not skipped, and spending stops at the cap', async () => {
        script({ stage: 'hcaptcha', puzzles: ['drag', 'drag', 'drag', 'drag', 'drag', 'drag'], deaf: true });
        clearLog();
        solverCalls.length = 0;
        solverReply = url => (url.endsWith('/createTask') ? { errorId: 0, taskId: 12 }
            : { errorId: 0, status: 'ready', solution: { coordinates: [{ x: 60, y: 200 }, { x: 200, y: 120 }] }, cost: '0.0012' });
        const { api } = conversation('c-captcha-h2', { resolveSecrets: withKey('2captcha', 'KEY-2C') });
        const result = await api.captcha({ budget: 0.003 });
        assert.strictEqual(result.solved, false);
        assert.ok(/spending cap/.test(result.what), result.what);
        assert.strictEqual(solverCalls.filter(call => call.url.endsWith('/createTask')).length, 3, '3 × $0.0012 reaches $0.003');
        const state = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
        assert.ok(!state.skips, 'Skip never pressed');
        assert.strictEqual(state.refreshes, 3);
        assert.ok(/did not land/.test(result.done.join(' | ')), result.done.join(' | '));
        script({ stage: 'none' });
    });

    await check('with no key, an image challenge is handed to the user rather than guessed at', async () => {
        script({ stage: 'checkbox' });
        solverCalls.length = 0;
        const { api } = conversation('c-captcha-nokey');
        const result = await api.captcha({});
        assert.strictEqual(result.solved, false);
        assert.ok(/image challenge/.test(result.what) && /ask_user/.test(result.what), result.what);
        assert.strictEqual(solverCalls.length, 0);
    });

    await check('Turnstile is pressed on its square, not its label, and counts as passed once it goes quiet', async () => {
        script({ stage: 'turnstile' });
        clearLog();
        const { api } = conversation('c-captcha-cf');
        const result = await api.captcha({});
        assert.strictEqual(result.solved, true, result.what);
        assert.ok(/Cloudflare check shows no checkbox/.test(result.what) && /Success!/.test(result.what), result.what);
        const [press] = clicks();
        assert.ok(press.x >= 100 && press.x <= 150 && press.y >= 300 && press.y <= 350, `pressed at ${press.x},${press.y}`);
    });

    await check('an invisible reCAPTCHA with nothing to answer yet says to send the form first', async () => {
        script({ stage: 'invisible' });
        const { api } = conversation('c-captcha-inv');
        const result = await api.captcha({});
        assert.strictEqual(result.solved, false);
        assert.ok(/nothing to answer yet/.test(result.what) && /send it/.test(result.what), result.what);
    });

    await check('a picture of text is read by the service and typed as read, never as a secret it names', async () => {
        script({ stage: 'image' });
        clearLog();
        solverCalls.length = 0;
        // A page could show a secret's reference and hope to have it filled in.
        solverReply = () => ({ errorId: 0, status: 'ready', solution: { text: '{{secret:wifi}}' } });
        const { api } = conversation('c-captcha-text', { resolveSecrets: withKey('capsolver', 'KEY-CS') });
        const result = await api.captcha({ into: 2 });
        assert.ok(!result.error, result.error);
        assert.strictEqual(result.solved, true);
        assert.strictEqual(solverCalls[0].url, 'https://api.capsolver.com/createTask');
        assert.strictEqual(solverCalls[0].body.task.type, 'ImageToTextTask');
        assert.deepStrictEqual(sent().find(request => request.cmd === 'capture').region, [100, 400, 200, 60]);
        assert.strictEqual(sent().find(request => request.cmd === 'type').text, '{{secret:wifi}}');
    });

    await check('with no captcha in the window it says so, and how to point at one it does not know', async () => {
        script({ stage: 'none' });
        const { api } = conversation('c-captcha-none');
        const result = await api.captcha({});
        assert.ok(/No captcha was found/.test(result.error) && /x0, y0, x1, y1/.test(result.error), result.error);
    });

    await check('a puzzle given by its corners is answered with the instruction, in the screenshot\'s pixels', async () => {
        script({ stage: 'none' });
        const { api } = conversation('c-captcha-region', { resolveSecrets: withKey('anticaptcha', 'KEY-AC') });
        await api.screenshot({});
        clearLog();
        solverCalls.length = 0;
        solverReply = url => (url.endsWith('/createTask') ? { errorId: 0, taskId: 3 } : { errorId: 0, status: 'ready', solution: { coordinates: [[10, 10]] } });
        const result = await api.captcha({ x0: 100, y0: 50, x1: 200, y1: 150, instruction: 'click the cat' });
        assert.ok(!result.error, result.error);
        assert.strictEqual(result.solved, 'clicked');
        assert.deepStrictEqual(sent().find(request => request.cmd === 'capture').region, [200, 100, 200, 200], 'the screenshot was shrunk by half');
        assert.deepStrictEqual(solverCalls[0].body.task, { type: 'ImageToCoordinatesTask', body: '/9j/4AAQ', comment: 'click the cat', mode: 'points' });
        const [press] = clicks();
        assert.deepStrictEqual([press.x, press.y], [210, 110]);
    });

    await check('switched off, or in a background run, it does nothing', async () => {
        script({ stage: 'checkbox' });
        clearLog();
        assert.ok(/switched off/.test((await conversation('c-captcha-off', { settings: () => ({}) }).api.captcha({})).error));
        assert.ok(/background run/.test((await conversation('c-captcha-job', { runKind: () => 'scheduled' }).api.captcha({})).error));
        assert.ok(!sent().some(request => request.cmd === 'captcha' || request.cmd === 'click'));
        script({ stage: 'none' });
    });

    for (const id of ['c-captcha-read', 'c-captcha', 'c-captcha-h', 'c-captcha-h2', 'c-captcha-nokey', 'c-captcha-cf', 'c-captcha-inv', 'c-captcha-text', 'c-captcha-none', 'c-captcha-region']) {
        computer.release(id);
    }

    console.log('\nthe catalog');

    await check('reading is read-only; acting is a write the per-app question gates; opening an app asks', () => {
        for (const name of ['list_windows', 'read_screen', 'wait_for']) {
            assert.strictEqual(tools.changesNothing(name), true, `${name} changes nothing`);
        }
        for (const name of ['click', 'type_text', 'press_keys', 'scroll', 'drag', 'solve_captcha']) {
            const tool = tools.BY_NAME.get(name);
            assert.strictEqual(tool.readOnly, true, `${name} does not ask per call`);
            assert.strictEqual(tools.changesNothing(name), false, `${name} is still a write`);
            assert.strictEqual(tools.isAutoApproved(name, {}, { approval: 'writes', readOnlyRun: true }), false, 'a read-only run refuses it');
        }
        assert.strictEqual(tools.BY_NAME.get('open_app').readOnly, false);
        assert.strictEqual(tools.isAutoApproved('open_app', { app: 'notepad' }, { approval: 'writes' }), false);
    });

    await check('the blocked command list reaches open_app', () => {
        assert.strictEqual(tools.blockedReason('open_app', { app: 'cmd', args: '/c rm -rf C:\\' }, { blockedCommands: ['cmd'] }), 'cmd');
    });

    await check('the tools pass a refusal through as an error', async () => {
        const result = await tools.BY_NAME.get('click').handler({ element: 1 }, { computer: { click: async () => ({ error: 'nope' }) } });
        assert.strictEqual(result.isError, true);
        assert.strictEqual((await tools.BY_NAME.get('click').handler({ element: 1 }, {})).isError, true);
    });

    computer._test.reset();

    console.log('\nthe real helper');

    const exe = path.join(__dirname, '..', 'resources', 'desktop-helper.exe');
    if (process.platform !== 'win32' || !fs.existsSync(exe)) {
        console.log('  skip (not built here: npm run build:desktop)');
    } else {
        await check('answers ping and lists windows, leaving out the process that protects itself', async () => {
            const child = spawn(exe, ['--protect', String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
            const answers = new Map();
            const events = [];
            readline.createInterface({ input: child.stdout }).on('line', (line) => {
                const message = JSON.parse(line);
                if (message.event) events.push(message);
                else answers.set(message.id, message);
            });
            const ask = (id, cmd, payload = {}) => new Promise((resolve, reject) => {
                child.stdin.write(`${JSON.stringify({ id, cmd, ...payload })}\n`);
                const started = Date.now();
                const poll = setInterval(() => {
                    if (answers.has(id)) { clearInterval(poll); resolve(answers.get(id)); }
                    else if (Date.now() - started > 15000) { clearInterval(poll); reject(new Error(`no answer to ${cmd}`)); }
                }, 20);
            });
            try {
                const ping = await ask(1, 'ping');
                assert.strictEqual(ping.ok, true);
                assert.ok(events.some(event => event.event === 'ready'));
                const listed = await ask(2, 'windows');
                assert.strictEqual(listed.ok, true);
                assert.ok(Array.isArray(listed.windows));
                assert.ok(listed.windows.every(window => window.pid !== process.pid && !window.protected));
                const refused = await ask(3, 'click');
                assert.strictEqual(refused.code, 'not-driving', 'nothing moves until it is told to drive');
                // Two more that move nothing: a JPEG of a corner of the screen,
                // for a captcha service, and a captcha scan of a window.
                const jpeg = await ask(4, 'capture', { region: [0, 0, 64, 64], format: 'jpeg' });
                assert.strictEqual(jpeg.ok, true, jpeg.error);
                assert.strictEqual(jpeg.mediaType, 'image/jpeg');
                assert.ok(Buffer.from(jpeg.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a JPEG');
                if (listed.windows.length) {
                    const scanned = await ask(5, 'captcha', { hwnd: listed.windows[listed.windows.length - 1].hwnd });
                    assert.strictEqual(scanned.ok, true, scanned.error);
                    assert.ok(Array.isArray(scanned.widgets) && Array.isArray(scanned.images));
                }
            } finally {
                child.stdin.end();
            }
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
