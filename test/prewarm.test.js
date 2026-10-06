/**
 * What a message waits for, taken off its path: the runtime started while the
 * message is typed (`warm`), a draft that leaves nothing behind when it is
 * abandoned, the memory search that never holds a send up for the model, and
 * the timings written for a send that was slow anyway. The runtime is a fake
 * that records its starts; `electron` and the embedding model are stubbed so
 * this runs under plain node and never loads a model.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-prewarm-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(String(text), 'utf8'), decryptString: buffer => Buffer.from(buffer).toString('utf8') },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

/** The embedding model, as a switch: loaded or not, quick or slow. */
const model = { ready: false, delay: 0, warmed: 0, embedded: 0 };
const embeddingsPath = require.resolve(path.join(ROOT, 'ai', 'embeddings'));
require.cache[embeddingsPath] = {
    id: embeddingsPath,
    filename: embeddingsPath,
    loaded: true,
    exports: {
        MODEL: 'test-model',
        DIMS: 3,
        isReady: () => model.ready,
        warm: () => { model.warmed += 1; },
        load: async () => {},
        status: () => ({ model: 'test-model', dims: 3, loading: false, failure: '' }),
        embed: async (texts) => {
            model.embedded += 1;
            if (model.delay) await new Promise(resolve => setTimeout(resolve, model.delay));
            return texts.map(() => Float32Array.from([1, 0, 0]));
        },
    },
};

const assistant = require(path.join(ROOT, 'ai'));
const memory = require(path.join(ROOT, 'ai', 'memory'));
const sendTiming = require(path.join(ROOT, 'ai', 'send-timing'));

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

/** Every start the fake runtime was asked for, and the sessions it handed back. */
const starts = [];
/** What the fake says on its way up, through the start's own onEvent. */
let onTheWayUp = [];

const fake = {
    supportsImages: false,
    async start(options) {
        const session = {
            sent: [],
            closed: false,
            send(text) { this.sent.push(text); },
            async interrupt() {},
            async close() { this.closed = true; },
            async setModel() {},
            async setEffort() {},
        };
        starts.push({ options, session });
        for (const event of onTheWayUp) options.onEvent(event);
        return session;
    },
    async title() { return 'A conversation'; },
};
for (const name of Object.keys(assistant._test.providers)) assistant._test.providers[name] = fake;

const listed = id => assistant.list({}).some(row => row.conversationId === id);
const eventsOf = id => assistant._test.conversation(id).events;

(async () => {
    console.log('prewarm');

    await check('warming starts the runtime once, and the send uses it', async () => {
        const before = starts.length;
        const { conversationId } = assistant.create({});
        assert.deepStrictEqual(await assistant.warm(conversationId), { success: true });
        assert.strictEqual(starts.length, before + 1);
        // A second warm while it is up starts nothing.
        await assistant.warm(conversationId);
        assert.strictEqual(starts.length, before + 1);

        const sent = await assistant.send(conversationId, 'check the disk on web-01');
        assert.strictEqual(sent.success, true, sent.message);
        assert.strictEqual(starts.length, before + 1, 'no second start for the send');
        const { session } = starts[starts.length - 1];
        assert.strictEqual(session.sent.length, 1);
        assert.ok(session.sent[0].endsWith('check the disk on web-01'));
    });

    await check('a draft warmed and abandoned leaves nothing in the history', async () => {
        onTheWayUp = [
            { type: 'session', sessionId: 'runtime-session-1' },
            { type: 'account', subscriptionType: 'max' },
        ];
        try {
            const { conversationId } = assistant.create({});
            await assistant.warm(conversationId);
            assert.strictEqual(eventsOf(conversationId).length, 0, 'no events');
            assert.strictEqual(listed(conversationId), false, 'not listed');
            // Kept as state for the send to resume with.
            assert.strictEqual(assistant._test.conversation(conversationId).providerSessionId, 'runtime-session-1');

            await assistant.send(conversationId, 'now it is a conversation');
            assert.ok(eventsOf(conversationId).some(event => event.type === 'user-message'));
            assert.strictEqual(listed(conversationId), true, 'listed once a message has gone');
        } finally {
            onTheWayUp = [];
        }
    });

    await check('a runtime that stops before the message is started again by the send', async () => {
        const { conversationId } = assistant.create({});
        await assistant.warm(conversationId);
        const first = starts[starts.length - 1];
        first.options.onEvent({ type: 'closed' });
        assert.strictEqual(eventsOf(conversationId).length, 0);

        const before = starts.length;
        await assistant.send(conversationId, 'are you there');
        assert.strictEqual(starts.length, before + 1, 'started again');
        assert.strictEqual(starts[starts.length - 1].session.sent.length, 1);
        assert.strictEqual(first.session.sent.length, 0, 'nothing written into the one that stopped');
    });

    await check('a model change waiting for the next message is applied while typing', async () => {
        const { conversationId } = assistant.create({});
        await assistant.send(conversationId, 'first message');
        const conversation = assistant._test.conversation(conversationId);
        conversation.busy = false;
        const running = starts[starts.length - 1].session;
        conversation.needsRestart = true;

        const before = starts.length;
        await assistant.warm(conversationId);
        assert.strictEqual(running.closed, true, 'the old query is put down');
        assert.strictEqual(starts.length, before + 1, 'and the new one is up before the send');
        assert.strictEqual(conversation.needsRestart, false);
    });

    await check('a conversation in the middle of a turn is left alone', async () => {
        const { conversationId } = assistant.create({});
        await assistant.send(conversationId, 'long job');
        const conversation = assistant._test.conversation(conversationId);
        conversation.busy = true;
        conversation.needsRestart = true;
        const before = starts.length;
        assert.deepStrictEqual(await assistant.warm(conversationId), { success: false });
        assert.strictEqual(starts.length, before);
        assert.strictEqual(conversation.needsRestart, true, 'kept for the send');
    });

    await check('warming with memory on starts the memory model too', async () => {
        const before = model.warmed;
        const { conversationId } = assistant.create({});
        await assistant.warm(conversationId);
        assert.ok(model.warmed > before);
        assert.deepStrictEqual(await assistant.warm('no-such-conversation'), { success: false });
    });

    await check('memory: a model not loaded yet is started, and the notes found by word', async () => {
        const agentId = 'agent-memory-test';
        memory.add(agentId, { text: 'The nginx config on web-01 lives in /etc/nginx/sites-enabled' });
        model.ready = false;
        const before = { warmed: model.warmed, embedded: model.embedded };
        const found = await memory.relevant(agentId, 'where is the nginx config', 6);
        assert.ok(model.warmed > before.warmed, 'asked to load');
        assert.strictEqual(model.embedded, before.embedded, 'not waited for');
        // The newest notes are in the prompt already, so relevant leaves them
        // out; search shows the word match is there.
        const searched = await memory.search(agentId, 'nginx config', 5, { budget: 0 });
        assert.ok(searched.some(entry => entry.text.includes('nginx')));
        assert.ok(Array.isArray(found));
    });

    await check('memory: a loaded but slow model is given a moment, not the send', async () => {
        const agentId = 'agent-memory-slow';
        memory.add(agentId, { text: 'Backups run at 01:00 from db-02' });
        model.ready = true;
        model.delay = 1000;
        try {
            const started = Date.now();
            await memory.relevant(agentId, 'when do backups run');
            const took = Date.now() - started;
            assert.ok(took < 600, `waited ${took}ms`);
            // A search the agent asked for still waits for the model.
            const waited = Date.now();
            await memory.search(agentId, 'backups', 5);
            assert.ok(Date.now() - waited >= 900, 'recall waits for meaning');
        } finally {
            model.delay = 0;
        }
    });

    await check('send timings: stages add up, and only a slow send is written', async () => {
        let now = 0;
        const timer = sendTiming.createTimer(() => now);
        now = 40; timer.mark('record');
        now = 45; timer.mark('runtime');
        now = 245; timer.mark('memory');
        const entry = timer.entry({ provider: 'claude-code' });
        assert.deepStrictEqual(entry.stages, { record: 40, runtime: 5, memory: 200 });
        assert.strictEqual(entry.total, 245);
        assert.strictEqual(entry.provider, 'claude-code');

        const file = path.join(userData, 'timing-test', 'send-timing.jsonl');
        assert.strictEqual(sendTiming.record({ ...entry, total: 20 }, { file }), false, 'quick send not written');
        assert.strictEqual(fs.existsSync(file), false);
        assert.strictEqual(sendTiming.record(entry, { file }), true);
        assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8').trim()).total, 245);
        // Moved aside once it is big enough.
        sendTiming.record(entry, { file, maxBytes: 10 });
        assert.ok(fs.existsSync(`${file}.1`));
    });

    console.log(`prewarm: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
    // The stubbed runtime leaves no handles, but the assistant's own timers
    // may; the result is in.
    setTimeout(() => process.exit(process.exitCode || 0), 50).unref();
})();
