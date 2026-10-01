/**
 * A runtime's subagents, as conversations of their own to read.
 *
 * Their events are in the parent's log, each marked with the call that
 * started its subagent; a tab on `<conversation>/<call>` is that subagent's
 * transcript, read back from there and told of new events as they land. The
 * events go through the conversation's own `emit`, the road a runtime's take.
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-subagents-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const assistant = require(path.join(ROOT, 'ai'));

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

(async () => {
    console.log('subagents');
    const { replay } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'transcript-reducer.js')).href);

    const told = [];
    assistant.setNotifier((channel, payload) => {
        if (channel === 'ai-event') told.push(payload);
    });

    const { conversationId } = assistant.create({});
    const emit = event => assistant._test.emit(conversationId, event);
    const first = `${conversationId}/agent-1`;

    emit({ type: 'user-message', text: 'Check both disks' });
    // As `send` leaves it: the turn is running.
    assistant._test.conversation(conversationId).busy = true;
    emit({ type: 'tool-call', id: 'agent-1', name: 'Agent', local: true, input: { description: 'Disk on web-01', prompt: 'Run df -h on web-01 and report.' } });
    emit({ type: 'tool-call', id: 'agent-2', name: 'Agent', local: true, input: { description: 'Disk on web-02', prompt: 'Run df -h on web-02 and report.' } });
    emit({ type: 'task-started', taskId: 't1', toolUseId: 'agent-1', description: 'Disk on web-01', background: true });
    emit({ type: 'task-started', taskId: 't2', toolUseId: 'agent-2', description: 'Disk on web-02', background: true });
    emit({ type: 'tool-call', id: 'run-1', name: 'run_command', local: false, input: { command: 'df -h' }, parentId: 'agent-1' });
    emit({ type: 'tool-result', id: 'run-1', text: '/dev/sda1 40%', parentId: 'agent-1' });
    emit({ type: 'assistant-text', text: 'web-01 is at 40%.', parentId: 'agent-1' });

    await check('a subagent reads back as its own transcript: the brief, its calls, its words', async () => {
        const past = assistant.history(first);
        assert.strictEqual(past.found, true);
        assert.strictEqual(past.title, 'Disk on web-01');
        assert.deepStrictEqual(past.subagent, { parentId: conversationId, parentTitle: assistant.history(conversationId).title });
        assert.deepStrictEqual(past.events.map(event => event.type), ['user-message', 'tool-call', 'tool-result', 'assistant-text']);
        assert.strictEqual(past.events[0].text, 'Run df -h on web-01 and report.');
        assert.ok(past.events.every(event => !event.parentId), 'unmarked, as its own');
        assert.strictEqual(past.busy, true, 'still at work');
        const state = replay(past.events);
        assert.strictEqual(state.busy, true);
        assert.strictEqual(state.items.filter(item => item.kind === 'tool').length, 1);
    });

    await check('the other subagent has only its own brief', async () => {
        const past = assistant.history(`${conversationId}/agent-2`);
        assert.deepStrictEqual(past.events.map(event => event.type), ['user-message']);
    });

    await check('the parent shows the calls that started them and nothing of their work', async () => {
        const state = replay(assistant.history(conversationId).events);
        assert.deepStrictEqual(state.items.filter(item => item.kind === 'tool').map(item => item.id), ['agent-1', 'agent-2']);
        assert.ok(!state.items.some(item => item.kind === 'assistant'), 'the subagent did not speak for the parent');
    });

    await check('a tab on a subagent is told of its events as they land', async () => {
        const mine = told.filter(entry => entry.conversationId === first).map(entry => entry.event);
        assert.deepStrictEqual(mine.map(event => event.type), ['tool-call', 'tool-result', 'assistant-text']);
        assert.ok(mine.every(event => !event.parentId));
    });

    await check('its end closes its transcript, live and read back', async () => {
        emit({ type: 'task-ended', taskId: 't1', toolUseId: 'agent-1', status: 'completed', toolUses: 1 });
        const live = told.filter(entry => entry.conversationId === first).pop().event;
        assert.strictEqual(live.type, 'result');
        const past = assistant.history(first);
        assert.strictEqual(past.events[past.events.length - 1].type, 'result');
        assert.strictEqual(past.busy, false);
        assert.strictEqual(replay(past.events).busy, false);
    });

    await check('stopping the parent stops the subagents still at work', async () => {
        emit({ type: 'interrupted' });
        const second = told.filter(entry => entry.conversationId === `${conversationId}/agent-2`).pop().event;
        assert.strictEqual(second.type, 'interrupted');
    });

    await check('with the parent\'s turn over, one that never said it was done is not running', async () => {
        assistant._test.conversation(conversationId).busy = false;
        const past = assistant.history(`${conversationId}/agent-2`);
        assert.strictEqual(past.busy, false);
        assert.strictEqual(replay(past.events).busy, false);
    });

    await check('a subagent is read only', async () => {
        const answer = await assistant.send(first, 'hello');
        assert.strictEqual(answer.success, false);
        assert.ok(/read only/.test(answer.message));
    });

    await check('a call that is not there is not a conversation', async () => {
        assert.strictEqual(assistant.history(`${conversationId}/nope`).found, false);
        assert.strictEqual(assistant.history('conv-missing/agent-1').found, false);
    });

    await check('subagents are not conversations in the list', async () => {
        assert.ok(!assistant.list().some(row => String(row.conversationId).includes('/')));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
