/**
 * The Muse Code provider, against a scripted `muse serve` that follows
 * Meta's published conformance transcripts.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-muse-'));
const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const muse = require('../src/main/ai/providers/muse');

process.env.ELECTRON_RUN_AS_NODE = '1';
muse._test.useCommand({ command: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-muse-serve.js')] });

const until = async (check, what, timeout = 8000) => {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

let passed = 0;
async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
}

function harness(overrides = {}) {
    const events = [];
    const approvals = [];
    let current = {
        approval: 'writes', allowLocalTools: true, autoApproveCommands: [], blockedCommands: ['rm -rf'],
        mcpServers: [], model: '', effort: 'high', ...overrides,
    };
    return {
        events,
        approvals,
        set(patch) { current = { ...current, ...patch }; },
        options: {
            settings: current,
            getSettings: () => current,
            systemPrompt: 'SYSTEM',
            toolContext: () => ({ settings: current }),
            requestApproval: async (request) => { approvals.push(request); return { approved: true }; },
            onEvent: (event) => events.push(event),
        },
    };
}

(async () => {
    await test('a UUIDv7 carries the version and variant bits', () => {
        const id = muse._test.uuid7();
        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    await test('plan usage becomes a five-hour and a weekly window', () => {
        const windows = muse._test.windowsFrom({ window: { usedPercent: 140, windowDurationMins: 300, resetsAtMs: 5 }, weekly: { usedPercent: 12, resetsAtMs: 9 } });
        assert.deepStrictEqual(windows.map(window => [window.id, window.used, window.status]), [['five_hour', 100, 'rejected'], ['seven_day', 12, '']]);
    });

    await test('the model list is read from a server brought up and put down', async () => {
        const rows = await muse.listModels();
        assert.deepStrictEqual(rows.map(row => row.value), ['muse-spark-1.3', 'muse-spark-1.3-contributor']);
        assert.strictEqual(rows[0].preferred, true);
        assert.strictEqual(rows[1].short, 'Muse Spark 1.3');
    });

    await test('limits and identity are read without a turn', async () => {
        const answer = await muse.readLimits();
        assert.strictEqual(answer.identity.signedIn, true);
        assert.strictEqual(answer.identity.email, 'someone@example.com');
        assert.strictEqual(answer.identity.plan, 'everyday');
        assert.deepStrictEqual(answer.windows.map(window => [window.id, window.used]), [['five_hour', 20], ['seven_day', 55]]);
    });

    const h = harness();
    const session = await muse.start(h.options);

    await test('a turn streams reasoning and text, gates the shell, waves ours through, and reports usage and limits', async () => {
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the first result');
        assert.ok(h.events.some(event => event.type === 'session'));
        assert.ok(h.events.some(event => event.type === 'thinking-delta' && event.text === 'thinking it over'));

        const reply = h.events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(reply.includes('servers=remote:streamableHttp'), reply);
        assert.ok(reply.includes('effort=high'), reply);

        assert.strictEqual(h.approvals.length, 1, 'only the shell reached a card');
        assert.deepStrictEqual(h.approvals[0].input, { command: 'cargo build' });
        const results = h.events.filter(event => event.type === 'tool-result');
        assert.strictEqual(results.find(event => event.id === 't1').text, 'decided:allow_once');
        assert.strictEqual(results.find(event => event.id === 't2').text, 'ours:allow_once');
        assert.strictEqual(h.events.find(event => event.type === 'tool-call' && event.id === 't2').local, false);

        const result = h.events.find(event => event.type === 'result');
        assert.deepStrictEqual(result.usage, { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 400 });
        const limits = h.events.find(event => event.type === 'limits');
        assert.deepStrictEqual(limits.windows.map(window => [window.id, window.used]), [['five_hour', 37], ['seven_day', 12]]);
    });

    await test('a blocked command is denied without a card', async () => {
        h.events.length = 0;
        h.approvals.length = 0;
        session.send('danger');
        await until(() => h.events.some(event => event.type === 'result'), 'the second result');
        assert.strictEqual(h.approvals.length, 0);
        assert.ok(h.events.some(event => event.type === 'tool-blocked'));
        assert.strictEqual(h.events.find(event => event.type === 'tool-result' && event.id === 't1').text, 'decided:deny');
    });

    await test('model and effort follow the settings on the live session', async () => {
        h.events.length = 0;
        h.set({ model: 'muse-spark-1.3-contributor', effort: 'low' });
        session.send('hello');
        await until(() => h.events.some(event => event.type === 'result'), 'the third result');
        const reply = h.events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(reply.includes('model=muse-spark-1.3-contributor'), reply);
        assert.ok(reply.includes('effort=low'), reply);
    });

    await test('an interrupt cancels the running turn', async () => {
        h.events.length = 0;
        session.send('wait please');
        await until(() => h.events.some(event => event.type === 'text-delta'), 'the turn to start');
        await session.interrupt();
        await until(() => h.events.some(event => event.type === 'result'), 'the cancelled result');
        assert.strictEqual(h.events.find(event => event.type === 'result').subtype, 'cancelled');
    });

    await session.close();
    await test('a closed session reports itself stopped', async () => {
        await until(() => session.stopped, 'the process to go');
    });

    await test('a session resumes by id', async () => {
        const resumed = harness();
        const again = await muse.start({ ...resumed.options, resumeSessionId: 'resume-me' });
        assert.ok(resumed.events.some(event => event.type === 'session' && event.sessionId === 'resume-me'));
        await again.close();
    });

    console.log(`${passed} passed, 0 failed`);
    fs.rmSync(userData, { recursive: true, force: true });
    process.exit(0);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
