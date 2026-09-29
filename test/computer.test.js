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
    computer.configure({
        isBusy: id => busy.has(id),
        interrupt: (id) => { interrupted.push(id); },
        surface: (id) => { surfaced.push(id); },
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

    console.log('\nthe catalog');

    await check('reading is read-only; acting is a write the per-app question gates; opening an app asks', () => {
        for (const name of ['list_windows', 'read_screen', 'wait_for']) {
            assert.strictEqual(tools.changesNothing(name), true, `${name} changes nothing`);
        }
        for (const name of ['click', 'type_text', 'press_keys', 'scroll', 'drag']) {
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
            const ask = (id, cmd) => new Promise((resolve, reject) => {
                child.stdin.write(`${JSON.stringify({ id, cmd })}\n`);
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
            } finally {
                child.stdin.end();
            }
        });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
