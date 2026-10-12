/**
 * What the assistant core does with a message from a channel (Telegram):
 * the message is marked, the turn asks before every change whatever the
 * agent's mode, the model is told once that it is talking to a phone, a
 * card answered on the phone records where, and the next message typed at
 * the desk puts everything back. Plus `message_user`, the agent's way of
 * writing to the phone first.
 *
 * The runtime is a fake that records what it is sent; `electron` and the
 * embedding model are stubbed. The gateway itself is channels.test.js.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-channels-assistant-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}), isPackaged: false },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: text => Buffer.from(String(text), 'utf8'),
        decryptString: buffer => Buffer.from(buffer).toString('utf8'),
    },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

// No embedding model: memory search answers at once with nothing.
const embeddingsPath = require.resolve(path.join(ROOT, 'ai', 'embeddings'));
require.cache[embeddingsPath] = {
    id: embeddingsPath,
    filename: embeddingsPath,
    loaded: true,
    exports: {
        MODEL: 'test-model',
        DIMS: 3,
        isReady: () => false,
        warm: () => {},
        load: async () => {},
        status: () => ({ model: 'test-model', dims: 3, loading: false, failure: '' }),
        embed: async texts => texts.map(() => Float32Array.from([1, 0, 0])),
    },
};

const starts = [];
const fake = {
    supportsImages: false,
    async start(options) {
        const session = {
            sent: [],
            send(text) { this.sent.push(text); },
            async interrupt() {},
            async close() {},
            async setModel() {},
            async setEffort() {},
        };
        starts.push({ options, session });
        return session;
    },
    async title() { return 'Disk check'; },
};

const assistant = require(path.join(ROOT, 'ai'));
for (const name of Object.keys(assistant._test.providers)) assistant._test.providers[name] = fake;
const agents = require(path.join(ROOT, 'agents'));
const catalog = require(path.join(ROOT, 'ai', 'tools'));
const secrets = require(path.join(ROOT, 'ai', 'secrets'));

let passed = 0;
let failed = 0;
async function check(label, fn) {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed += 1;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.stack || error.message}`);
        failed += 1;
    }
}

const seen = [];
assistant.observe((event, info) => seen.push({ event, info }));
const eventsOf = (conversationId, type) => seen
    .filter(entry => entry.info.conversationId === conversationId && (!type || entry.event.type === type))
    .map(entry => entry.event);

(async () => {
    console.log('\nchannels in the assistant core');

    const agentId = agents.activeId();
    const probe = (approval, { phone = true, policy = null, own = null } = {}) => {
        assistant.settings.set({ approval }, agentId);
        return assistant.effectiveSettings({
            agentId,
            settingsPatch: own ? { approval: own } : null,
            runPolicy: policy,
            channelTurn: phone ? { channel: 'telegram' } : null,
        }).approval;
    };

    await check('a turn from the phone runs in the conversation\'s own mode, as one from the desk', () => {
        for (const mode of ['always', 'writes', 'never', 'full']) {
            assert.strictEqual(probe(mode), mode, mode);
            assert.strictEqual(probe(mode, { phone: false }), mode, mode);
        }
        assert.strictEqual(probe('writes', { own: 'never' }), 'never', 'the conversation\'s mode over the agent\'s');
        assert.strictEqual(probe('full', { policy: { approvals: 'full' } }), 'never', 'a job\'s policy still decides');
    });

    // The rest runs with the agent in yolo, which a phone turn now keeps.
    assistant.settings.set({ approval: 'never' }, agentId);

    const { conversationId } = assistant.create({ scope: 'global' });
    const conversation = assistant._test.conversation(conversationId);

    await check('a message from the phone is marked, and the model told once where the user is', async () => {
        const sent = await assistant.send(conversationId, 'how full is the disk?', [], [], [], { channel: 'telegram' });
        assert.ok(sent.success, sent.message);
        const [message] = eventsOf(conversationId, 'user-message');
        assert.strictEqual(message.channel, 'telegram');
        assert.strictEqual(conversation.channelTurn.channel, 'telegram');
        assert.strictEqual(assistant.effectiveSettings(conversation).approval, 'never', 'the mode it is in');
        const text = starts[0].session.sent[0];
        assert.ok(/writing through Telegram, away from this computer/.test(text), text);
        assert.ok(!/every change asks/.test(text), text);
        const started = eventsOf(conversationId, 'run-started')[0];
        assert.ok(started, 'a run started');
        const runs = require(path.join(ROOT, 'runs'));
        assert.deepStrictEqual(runs.get(started.runId).trigger, { source: 'telegram' });

        starts[0].options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
        await assistant.send(conversationId, 'and now?', [], [], [], { channel: 'telegram' });
        assert.ok(!/through Telegram/.test(starts[0].session.sent[1]), 'said once per switch, not every message');
        starts[0].options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
    });

    await check('the observer sees every event, with the conversation described and not handed over', () => {
        const entry = seen.find(item => item.info.conversationId === conversationId && item.event.type === 'user-message');
        assert.deepStrictEqual(Object.keys(entry.info).sort(), ['agentId', 'busy', 'conversationId', 'jobId', 'remembering', 'runKind', 'title']);
        assert.ok(eventsOf(conversationId, 'result').length >= 1);
    });

    await check('a card answered on the phone records where; an unknown channel is dropped', async () => {
        const waiting = starts[0].options.requestApproval({ toolName: 'run_command', name: 'run_command', input: { command: 'systemctl restart nginx' } });
        const request = eventsOf(conversationId, 'approval-request').at(-1);
        assert.ok(request, 'a card went up');
        assert.strictEqual(assistant.respondToApproval({ requestId: request.requestId, approved: true, by: 'telegram' }), true);
        const verdict = await waiting;
        assert.strictEqual(verdict.approved, true);
        const settled = eventsOf(conversationId, 'approval-settled').at(-1);
        assert.strictEqual(settled.by, 'telegram');

        const second = starts[0].options.requestApproval({ toolName: 'run_command', name: 'run_command', input: { command: 'reboot' } });
        const again = eventsOf(conversationId, 'approval-request').at(-1);
        assistant.respondToApproval({ requestId: again.requestId, approved: false, by: 'carrier-pigeon' });
        await second;
        assert.strictEqual(eventsOf(conversationId, 'approval-settled').at(-1).by, undefined);
    });

    await check('a question answered on the phone records where', async () => {
        const waiting = starts[0].options.toolContext().askUser({ question: 'Which host?', options: ['web1', 'web2'] });
        const request = eventsOf(conversationId, 'question-request').at(-1);
        assistant.respondToQuestion({ requestId: request.requestId, answer: 'web2', chosen: true, by: 'telegram' });
        const reply = await waiting;
        assert.strictEqual(reply.answer, 'web2');
        assert.strictEqual(eventsOf(conversationId, 'question-settled').at(-1).by, 'telegram');
    });

    await check('the next message typed at the desk ends the phone\'s turn', async () => {
        await assistant.send(conversationId, 'thanks, I am back');
        assert.strictEqual(conversation.channelTurn, null);
        assert.strictEqual(assistant.effectiveSettings(conversation).approval, 'never');
        const message = eventsOf(conversationId, 'user-message').at(-1);
        assert.strictEqual(message.channel, undefined);
        assert.ok(/back at the desktop app/.test(starts[0].session.sent.at(-1)));
        starts[0].options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
    });

    await check('the note-taking turn after a real one changes neither', async () => {
        await assistant.send(conversationId, 'from the phone again', [], [], [], { channel: 'telegram' });
        starts[0].options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
        conversation.remembering = true;
        await assistant.send(conversationId, 'Before we move on: anything to keep?');
        assert.strictEqual(conversation.channelTurn?.channel, 'telegram', 'still the phone\'s turn');
        conversation.remembering = false;
        starts[0].options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
    });

    await check('a phone turn under Full access keeps it, with no restart', async () => {
        assistant.settings.set({ approval: 'full' }, agentId);
        await assistant.send(conversationId, 'desk turn under full access');
        starts.at(-1).options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
        const before = starts.length;
        await assistant.send(conversationId, 'phone turn', [], [], [], { channel: 'telegram' });
        assert.strictEqual(starts.length, before, 'the same runtime');
        assert.strictEqual(starts.at(-1).options.getSettings().approval, 'full');
        starts.at(-1).options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
        assistant.settings.set({ approval: 'never' }, agentId);
    });

    await check('message_user goes through the paired channel, secrets masked, or says there is none', async () => {
        const context = starts.at(-1).options.toolContext();
        const tool = catalog.BY_NAME.get('message_user');
        assert.ok(tool, 'the tool is in the catalog');
        assert.strictEqual(tool.readOnly, true);
        assert.strictEqual(catalog.bundleOf('message_user'), 'automation');

        assistant.setMessenger(null);
        const none = await tool.handler({ text: 'build done' }, context);
        assert.ok(none.isError, 'fails without a channel');

        secrets.set('deploy-key', 'SUPERSECRETVALUE123', '');
        const told = [];
        assistant.setMessenger(async (payload) => {
            told.push(payload);
            return { sent: true, channel: 'telegram' };
        });
        const result = await tool.handler({ text: 'done, and the key SUPERSECRETVALUE123 works' }, context);
        assert.ok(!result.isError, JSON.stringify(result));
        assert.strictEqual(told.length, 1);
        assert.ok(!told[0].text.includes('SUPERSECRETVALUE123'), 'masked before it leaves');
        assert.strictEqual(typeof told[0].from, 'string');
    });

    console.log('\nthe desktop, let go when a turn from the phone ends');

    const computer = require(path.join(ROOT, 'ai', 'computer'));
    // What computer.js's drive() records when an action takes the desktop.
    const takeDesktop = id => computer._test.drivers().set(id, { name: 'Acestes', pausedBy: '', counted: true });

    await check('a follow-up sent into a running turn lets go when it ends, though its run was closed by the first', async () => {
        await assistant.send(conversationId, 'click through the installer', [], [], [], { channel: 'telegram' });
        takeDesktop(conversationId);
        // "and accept the licence too", sent while the first is running: the
        // same run, which the first turn's result closes.
        await assistant.send(conversationId, 'and accept the licence too', [], [], [], { channel: 'telegram' });
        starts.at(-1).options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
        assert.ok(!computer._test.drivers().has(conversationId), 'the first turn let go');
        assert.strictEqual(conversation.runId, '', 'and its run is closed');

        // The follow-up's turn takes the desktop again, then ends with no run open.
        takeDesktop(conversationId);
        starts.at(-1).options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
        assert.ok(!computer._test.drivers().has(conversationId), 'the follow-up let go too');
    });

    await check('stopped from the phone, nothing still running takes the desktop back until the next message', async () => {
        await assistant.send(conversationId, 'fill in the form', [], [], [], { channel: 'telegram' });
        takeDesktop(conversationId);
        const stopped = await assistant.interrupt(conversationId);
        assert.strictEqual(stopped.success, true);
        assert.ok(!computer._test.drivers().has(conversationId), 'let go');
        assert.ok(computer._test.halted().has(conversationId), 'held off');

        // A late action from the stopped turn is turned away before it moves anything.
        const late = computer.apiFor({
            id: conversationId,
            title: () => '',
            runKind: () => 'interactive',
            settings: () => ({ computerUse: true }),
            agentName: () => 'Acestes',
            canSee: () => true,
        });
        if (process.platform === 'win32' || process.platform === 'darwin') {
            const result = await late.click({ element: 3 });
            assert.ok(/stopped this turn/.test(result.error || ''), JSON.stringify(result));
            assert.ok(!computer._test.drivers().has(conversationId), 'still not driving');
        }

        await assistant.send(conversationId, 'ok, carry on', [], [], [], { channel: 'telegram' });
        assert.ok(!computer._test.halted().has(conversationId), 'a new turn may drive again');
        starts.at(-1).options.onEvent({ type: 'result', subtype: 'success', isError: false, costUsd: 0 });
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    await assistant.shutdown().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
})();
