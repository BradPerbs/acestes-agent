/**
 * Conversations beside this one: what the agent's conversation tools do to
 * the conversations behind them, without a runtime. Branching after a turn,
 * mid-turn included; opening tabs beside the chat that asked; and the
 * fences: another agent's conversations, a conversation this one did not
 * start, and how deep the chain may go.
 *
 * Nothing here sends a message, which would start a runtime. `electron` is
 * stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-conversation-tools-'));

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

/** Two finished turns, then a third still running with a call and a card out. */
function playConversation(conversationId) {
    const emit = event => assistant._test.emit(conversationId, event);
    emit({ type: 'user-message', text: 'Check the disks on web-01' });
    emit({ type: 'tool-call', id: 'call_1', name: 'run_command', input: { command: 'df -h' } });
    emit({ type: 'tool-result', id: 'call_1', isError: false, text: '/dev/sda1 40%' });
    emit({ type: 'assistant-text', text: 'Disks are at 40%.' });
    emit({ type: 'result', costUsd: 0 });
    emit({ type: 'user-message', text: 'And memory?' });
    emit({ type: 'assistant-text', text: 'Memory is fine.' });
    emit({ type: 'result', costUsd: 0 });
    emit({ type: 'user-message', text: 'Try restarting nginx two ways' });
    emit({ type: 'tool-call', id: 'call_2', name: 'branch_conversation', input: {} });
    emit({ type: 'approval-request', requestId: 'approve_x', name: 'run_command', input: { command: 'systemctl restart nginx' } });
}

(async () => {
    console.log('\nturns');

    await check('a turn is counted from 1, from the end when negative, and none is everything', () => {
        const events = [
            { type: 'user-message' }, { type: 'assistant-text' },
            { type: 'user-message' }, { type: 'assistant-text' },
            { type: 'user-message' },
        ];
        assert.deepStrictEqual(assistant._test.turnEnd(events, 0), { end: 5, turns: 3 });
        assert.deepStrictEqual(assistant._test.turnEnd(events, 1), { end: 2, turns: 1 });
        assert.deepStrictEqual(assistant._test.turnEnd(events, -1), { end: 5, turns: 3 });
        assert.deepStrictEqual(assistant._test.turnEnd(events, -2), { end: 4, turns: 2 });
        assert.ok(assistant._test.turnEnd(events, 4).error, 'past the last turn');
        assert.ok(assistant._test.turnEnd(events, -4).error, 'before the first');
    });

    console.log('\nbranching');

    const opened = [];
    let windowUp = true;
    assistant.setWindowProbe(() => windowUp, () => true);
    assistant.setTabOpener(
        (conversationIds, options) => {
            opened.push({ conversationIds, ...options });
            return { success: true };
        },
        () => false,
    );

    const { conversationId: parentId } = assistant.create({});
    playConversation(parentId);
    const api = assistant._test.conversationsApi(parentId);

    let firstBranch = '';
    await check('a branch after a turn holds that much, opens beside its parent, behind it', async () => {
        const made = await api.branch({ turn: 1 });
        assert.ok(!made.error, made.error);
        firstBranch = made.conversationId;
        assert.strictEqual(made.turns, 1);
        assert.strictEqual(made.from, parentId);
        assert.strictEqual(made.status, 'idle', 'nothing sent without a message');
        assert.strictEqual(made.opened, true);
        const texts = assistant.history(made.conversationId).events
            .filter(event => event.type === 'user-message').map(event => event.text);
        assert.deepStrictEqual(texts, ['Check the disks on web-01']);
        assert.deepStrictEqual(opened.at(-1), { conversationIds: [made.conversationId], near: parentId, focus: false });
    });

    await check('a branch of this conversation mid-turn leaves out the call and the card still out', async () => {
        const made = await api.branch({ open: false });
        assert.ok(!made.error, made.error);
        assert.strictEqual(made.turns, 3);
        const events = assistant.history(made.conversationId).events;
        const calls = events.filter(event => event.type === 'tool-call').map(event => event.id);
        assert.deepStrictEqual(calls, ['call_1'], 'the answered call is kept, the running one is not');
        assert.ok(!events.some(event => event.type === 'approval-request'), 'no card nobody can answer');
        assert.ok(events.some(event => event.text === 'Try restarting nginx two ways'), 'the request itself is carried');
        assert.strictEqual(made.opened, false);
    });

    await check('a branch takes the parent\'s policy, is one deeper, and knows where it came from', () => {
        const child = assistant._test.conversation(firstBranch);
        assert.strictEqual(child.spawnedFrom, parentId);
        assert.strictEqual(child.depth, 1);
        assert.strictEqual(child.runKind, 'interactive');
    });

    await check('a title given names the branch and is never renamed', async () => {
        const made = await api.branch({ turn: 2, title: 'nginx: plan B', open: false });
        assert.strictEqual(made.title, 'nginx: plan B');
        assert.strictEqual(assistant._test.conversation(made.conversationId).titleSource, '');
    });

    await check('a turn that is not there is refused', async () => {
        const made = await api.branch({ turn: 9 });
        assert.ok(/3 turns/.test(made.error), made.error);
    });

    await check('another agent\'s conversation cannot be branched, and an unknown one is refused', async () => {
        const other = assistant._test.conversation(assistant.create({}).conversationId);
        other.agentId = 'somebody-else';
        assert.ok((await api.branch({ conversationId: other.id })).error);
        assert.ok((await api.branch({ conversationId: 'conv-nope' })).error);
    });

    console.log('\nstarting and opening');

    let started = '';
    await check('a new conversation without a message waits, pointed where its parent is', async () => {
        const parent = assistant._test.conversation(parentId);
        parent.runPolicy = { approvals: 'read-only' };
        const made = await api.start({ title: 'Side quest' });
        parent.runPolicy = null;
        assert.ok(!made.error, made.error);
        started = made.conversationId;
        assert.strictEqual(made.status, 'idle');
        const child = assistant._test.conversation(started);
        assert.strictEqual(child.title, 'Side quest');
        assert.strictEqual(child.scope, parent.scope);
        assert.deepStrictEqual(child.runPolicy, { approvals: 'read-only' }, 'never looser than the parent');
    });

    await check('a conversation from a job\'s run is out of sight like a delegated one', async () => {
        const parent = assistant._test.conversation(parentId);
        parent.runKind = 'scheduled';
        const made = await api.start({ open: false });
        parent.runKind = 'interactive';
        assert.strictEqual(assistant._test.conversation(made.conversationId).runKind, 'delegated');
    });

    await check('an unknown agent is refused by name', async () => {
        const made = await api.start({ agent: 'Nobody At All' });
        assert.ok(/Nobody At All/.test(made.error), made.error);
    });

    await check('open shows this agent\'s conversations and its children, and nothing else', () => {
        const other = assistant._test.conversation(assistant.create({}).conversationId);
        other.agentId = 'somebody-else';
        const shown = api.open({ conversationIds: [started, other.id, 'conv-nope'], focus: true });
        assert.strictEqual(shown.opened, true);
        assert.deepStrictEqual(shown.conversationIds, [started]);
        assert.deepStrictEqual(shown.notFound, [other.id, 'conv-nope']);
        assert.deepStrictEqual(opened.at(-1), { conversationIds: [started], near: parentId, focus: true });
        assert.ok(api.open({ conversationIds: [other.id] }).error);
    });

    await check('with no window up, nothing is opened and the agent is told where it is', async () => {
        windowUp = false;
        const before = opened.length;
        const made = await api.branch({ turn: 1 });
        windowUp = true;
        assert.strictEqual(made.opened, false);
        assert.ok(/Conversations page/.test(made.note), made.note);
        assert.strictEqual(opened.length, before);
    });

    console.log('\nfollowing up');

    await check('only a conversation this one started can be messaged, and not while it works', async () => {
        const stranger = assistant.create({}).conversationId;
        assert.ok((await api.message({ conversationId: stranger, message: 'hi' })).error);
        const child = assistant._test.conversation(started);
        child.busy = true;
        const busy = await api.message({ conversationId: started, message: 'hi' });
        child.busy = false;
        assert.ok(/still working/.test(busy.error), busy.error);
    });

    await check('check lists what this one started, and refuses to wait on a stranger', async () => {
        const listed = await api.check();
        const ids = listed.conversations.map(entry => entry.conversationId);
        assert.ok(ids.includes(started) && ids.includes(firstBranch));
        const entry = listed.conversations.find(item => item.conversationId === started);
        assert.strictEqual(entry.kind, 'started');
        assert.strictEqual(entry.working, false);
        const stranger = assistant.create({}).conversationId;
        assert.ok((await api.check({ waitFor: stranger })).error);
    });

    await check('waiting on a conversation gives up after the wait, and says how far it has got', async () => {
        assistant._test.setCheckWait(60);
        const child = assistant._test.conversation(started);
        assistant._test.emit(started, { type: 'user-message', text: 'Read the tickets' });
        assistant._test.emit(started, { type: 'assistant-text', text: '22 of 27 read. Continuing with #4029.' });
        child.busy = true;
        const began = Date.now();
        const listed = await api.check({ waitFor: started });
        child.busy = false;
        assistant._test.setCheckWait(60 * 1000);
        assert.ok(Date.now() - began < 2000, 'not left waiting');
        assert.ok(/still at it/.test(listed.stillWorking), listed.stillWorking);
        const entry = listed.conversations.find(item => item.conversationId === started);
        assert.strictEqual(entry.lastReply, '22 of 27 read. Continuing with #4029.');
    });

    await check('a conversation that finishes on its own reports to the one that started it', async () => {
        const parent = assistant._test.conversation(parentId);
        parent.pendingNote = '';
        assistant._test.emit(started, { type: 'assistant-text', text: 'All 27 read. Two can be answered now: #4017 and #3942.' });
        assistant._test.reportToParent(started, 'done');
        const notice = assistant.history(parentId).events.filter(event => event.type === 'notice').at(-1);
        assert.ok(/finished\. All 27 read/.test(notice.text), notice.text);
        assert.ok(parent.pendingNote.includes('#4017 and #3942'), 'the whole report waits for its next turn');
        assert.ok(parent.pendingNote.includes(started));
    });

    console.log('\nlimits');

    await check('a child two deep cannot start or branch any further', async () => {
        const child = assistant._test.conversation(started);
        child.depth = 2;
        const deep = assistant._test.conversationsApi(started);
        assert.ok(/levels deep/.test((await deep.start({})).error));
        assert.ok(/levels deep/.test((await deep.branch({})).error));
        child.depth = 1;
    });

    await check('six children working at once is the most', async () => {
        const { conversationId } = assistant.create({});
        const busyApi = assistant._test.conversationsApi(conversationId);
        const made = [];
        for (let index = 0; index < 6; index += 1) {
            const one = await busyApi.start({ open: false });
            assistant._test.conversation(one.conversationId).busy = true;
            made.push(one.conversationId);
        }
        assert.ok(/still working/.test((await busyApi.start({ open: false })).error));
        for (const id of made) assistant._test.conversation(id).busy = false;
        assert.ok(!(await busyApi.start({ open: false })).error);
    });

    console.log('\ntools');

    await check('the conversation tools are in the catalog with the right approval flags', () => {
        for (const name of ['new_conversation', 'branch_conversation', 'message_conversation']) {
            assert.strictEqual(tools.BY_NAME.get(name)?.readOnly, false, `${name} is a write`);
        }
        for (const name of ['open_conversation', 'check_conversations']) {
            assert.strictEqual(tools.BY_NAME.get(name)?.readOnly, true, `${name} is a read`);
        }
    });

    await check('the tools refuse without an api, and pass their defaults through', async () => {
        assert.strictEqual((await tools.BY_NAME.get('new_conversation').handler({ message: 'x' }, {})).isError, true);
        const asked = [];
        const ctx = { conversations: {
            start: async (spec) => { asked.push(['start', spec]); return { conversationId: 'conv-a', opened: true, status: 'working' }; },
            branch: async (spec) => { asked.push(['branch', spec]); return { conversationId: 'conv-b', opened: true, status: 'idle' }; },
            open: (spec) => { asked.push(['open', spec]); return { opened: false, reason: 'No window is open.' }; },
            message: async () => ({}),
            check: async () => ({ conversations: [] }),
        } };
        await tools.BY_NAME.get('new_conversation').handler({ message: 'look at logs' }, ctx);
        assert.deepStrictEqual(asked[0], ['start', { agent: '', message: 'look at logs', title: '', open: true, focus: false, wait: false }]);
        await tools.BY_NAME.get('branch_conversation').handler({ turn: -2 }, ctx);
        assert.strictEqual(asked[1][1].turn, -2);
        assert.strictEqual(asked[1][1].open, true);
        const waitless = await tools.BY_NAME.get('branch_conversation').handler({ wait: true }, ctx);
        assert.strictEqual(waitless.isError, true, 'nothing to wait for without a message');
        const shown = await tools.BY_NAME.get('open_conversation').handler({ conversationIds: ['conv-a'] }, ctx);
        assert.strictEqual(shown.isError, true, 'a tab that did not open is a failure');
        assert.strictEqual(asked[2][1].focus, true, 'opening on request brings it forward');
    });

    await check('delegate passes open through, and reports it only when asked', async () => {
        const runs = [];
        await tools.BY_NAME.get('delegate').handler({ brief: 'x', open: true }, { delegate: {
            run: async (spec) => { runs.push(spec); return { status: 'done', conversationId: 'c', summary: '', opened: true }; },
        } });
        assert.strictEqual(runs[0].open, true);
        const result = JSON.parse((await tools.BY_NAME.get('delegate').handler({ brief: 'x' }, { delegate: {
            run: async (spec) => { runs.push(spec); return { status: 'done', conversationId: 'c', summary: '' }; },
        } })).text);
        assert.strictEqual(runs[1].open, false);
        assert.ok(!('opened' in result), 'not asked, not reported');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
