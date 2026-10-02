/**
 * The card in the corner of the screen while an agent drives the desktop.
 *
 * What main pushes to it: a row per conversation at work, on a clock that
 * starts when it takes the desktop and stops when it lets go, with each
 * action numbered so the card can tell a new action from the same one
 * named better once its target is found. A conversation back at work before
 * its finished row has gone starts on a fresh clock, thinking.
 *
 * `electron` is stubbed with a window that records what it is sent, so it
 * runs under plain node.
 */
const Module = require('module');
const path = require('path');
const assert = require('assert');

const sent = [];
class FakeWindow {
    constructor() {
        this.visible = false;
        this.handlers = {};
        this.webContents = {
            send: (channel, payload) => sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) }),
            setWindowOpenHandler: () => {},
            on: (name, handler) => { this.handlers[name] = handler; },
        };
    }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    setContentProtection() {}
    on() {}
    loadURL() {}
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    setBounds() {}
    destroy() {}
}
const electronStub = {
    BrowserWindow: FakeWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const overlay = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'overlay'));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
/** The rows in the newest push, by id, after the throttle has let it through. */
async function latest() {
    await wait(160);
    const last = sent.filter(entry => entry.channel === 'ai-activity').pop();
    return Object.fromEntries((last?.payload.rows || []).map(row => [row.id, row]));
}

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
    } catch (error) {
        failures += 1;
        console.log(`  FAIL ${name}\n       ${error.stack}`);
    }
}

(async () => {
    console.log('activity overlay');

    await test('a conversation taking the desktop comes up thinking, on a running clock', async () => {
        const before = Date.now();
        overlay.drivers([{ id: 'a', title: 'Fill in the form', agent: 'Acestes' }]);
        const { a } = await latest();
        assert.equal(a.phase, 'thinking');
        assert.ok(a.since >= before && a.since <= Date.now(), 'since is when it took the desktop');
        assert.equal(a.ended, 0);
        assert.equal(a.done, false);
    });

    await test('each action is numbered, and naming its target keeps the number', async () => {
        overlay.event('a', { type: 'tool-call', name: 'click', input: { element: 12 } });
        const first = (await latest()).a.tool;
        assert.equal(first.name, 'click');
        assert.ok(Number.isInteger(first.seq) && first.seq > 0);

        overlay.aimed('a', 'button "Submit"');
        const aimed = (await latest()).a.tool;
        assert.equal(aimed.aim, 'button "Submit"');
        assert.equal(aimed.seq, first.seq, 'the same action, better named');

        overlay.event('a', { type: 'tool-result', name: 'click' });
        assert.equal((await latest()).a.phase, 'thinking');

        overlay.event('a', { type: 'tool-call', name: 'click', input: { element: 12 } });
        const second = (await latest()).a.tool;
        assert.ok(second.seq > first.seq, 'the same click again is a new action');
    });

    await test('letting go stops the clock and marks the row done', async () => {
        const { a: before } = await latest();
        overlay.drivers([]);
        const { a } = await latest();
        assert.equal(a.done, true);
        assert.equal(a.phase, 'done');
        assert.equal(a.tool, null);
        assert.ok(a.ended >= before.since);
    });

    await test('back at work before the finished row has gone: a fresh clock, thinking', async () => {
        const { a: done } = await latest();
        await wait(5);
        overlay.drivers([{ id: 'a', title: 'Fill in the form' }]);
        const { a } = await latest();
        assert.equal(a.done, false);
        assert.equal(a.phase, 'thinking', 'not left reading Done');
        assert.equal(a.ended, 0);
        assert.ok(a.since > done.since, 'a new stint');
    });

    await test('a second driver joining leaves the first one\'s clock alone', async () => {
        const { a: before } = await latest();
        overlay.drivers([{ id: 'a', title: 'Fill in the form' }, { id: 'b', title: 'Tidy the desktop' }]);
        const { a, b } = await latest();
        assert.equal(a.since, before.since);
        assert.equal(b.phase, 'thinking');
        assert.ok(b.since >= a.since);
    });

    overlay.close();
    Module._load = realLoad;
    if (failures) {
        console.log(`\n${failures} failed`);
        process.exit(1);
    }
    console.log('\nall passed');
})();
