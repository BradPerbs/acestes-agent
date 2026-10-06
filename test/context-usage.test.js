/**
 * How full the model's context is, the ring beside the composer's model chip.
 *
 * OpenCode Desktop draws the latest reply's tokens over the model's context
 * window; Acestes reads the same figure from OpenCode's events and from
 * Claude Code's, so both are checked against the shapes those runtimes
 * actually send. Then the main process, which keeps one reading per
 * conversation rather than one per step, and the panel's reducer.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-context-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const opencode = require(path.join(ROOT, 'ai', 'providers', 'opencode'));
const claude = require(path.join(ROOT, 'ai', 'providers', 'claude-code'));
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

/** An assistant message as OpenCode's server sends it on `message.updated`. */
const openCodeMessage = (tokens, extra = {}) => ({
    type: 'message.updated',
    properties: {
        info: {
            id: 'msg-1',
            sessionID: 'session-1',
            role: 'assistant',
            providerID: 'opencode',
            modelID: 'muse-spark',
            tokens,
            time: { created: 1 },
            ...extra,
        },
    },
});

(async () => {
    console.log('\nOpenCode');

    await check('a reply\'s tokens over the model\'s window, the way OpenCode Desktop counts them', async () => {
        const events = [];
        const translator = opencode.createTranslator('session-1', event => events.push(event), {
            contextLimit: (provider, model) => (provider === 'opencode' && model === 'muse-spark' ? 200000 : 0),
        });
        await translator.event(openCodeMessage({ input: 30000, output: 1500, reasoning: 500, cache: { read: 18000, write: 0 } }));
        assert.deepStrictEqual(events, [{
            type: 'context', used: 50000, limit: 200000, percent: 25, model: 'opencode/muse-spark', cached: 18000,
        }]);
    });

    await check('said once per change, and not for a message with no tokens yet', async () => {
        const events = [];
        const translator = opencode.createTranslator('session-1', event => events.push(event), { contextLimit: () => 100000 });
        await translator.event(openCodeMessage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
        await translator.event(openCodeMessage({ input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
        await translator.event(openCodeMessage({ input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }));
        await translator.event(openCodeMessage({ input: 9000, output: 1000, reasoning: 0, cache: { read: 0, write: 0 } }));
        assert.deepStrictEqual(events.filter(event => event.type === 'context').map(event => event.percent), [1, 10]);
    });

    await check('another session\'s replies, and a model with no known window, are handled', async () => {
        const events = [];
        const translator = opencode.createTranslator('session-1', event => events.push(event));
        const other = openCodeMessage({ input: 5000 });
        other.properties.info.sessionID = 'session-2';
        await translator.event(other);
        assert.strictEqual(events.length, 0, 'another session is not this one');
        await translator.event(openCodeMessage({ input: 5000 }));
        assert.strictEqual(events[0].limit, 0);
        assert.strictEqual(events[0].percent, null, 'no window, no percentage, still the tokens');
        assert.strictEqual(events[0].used, 5000);
    });

    await check('the cost of a completed reply still counts toward the turn', async () => {
        const events = [];
        const translator = opencode.createTranslator('session-1', event => events.push(event), { contextLimit: () => 100000 });
        translator.beginTurn();
        await translator.event(openCodeMessage({ input: 1000 }, { cost: 0.25, time: { created: 1, completed: 2 } }));
        translator.finish();
        assert.strictEqual(events.find(event => event.type === 'result').costUsd, 0.25);
    });

    console.log('\nClaude Code');

    const assistantMessage = (usage, extra = {}) => ({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { model: 'claude-opus-5-5', usage },
        ...extra,
    });

    await check('the first reading comes with the turn\'s result, which names the window', () => {
        const events = [];
        const meter = claude.createContextMeter(event => events.push(event));
        meter.see(assistantMessage({ input_tokens: 4, cache_read_input_tokens: 38000, cache_creation_input_tokens: 2000, output_tokens: 996 }));
        assert.strictEqual(events.length, 0, 'the window is not known yet');
        meter.see({ type: 'result', modelUsage: { 'claude-opus-5-5[1m]': { inputTokens: 90000, contextWindow: 1000000 } } });
        assert.deepStrictEqual(events, [{ type: 'context', used: 41000, limit: 1000000, percent: 4, model: 'claude-opus-5-5', cached: 38000 }]);
    });

    await check('no cache fields in usage means no cached figure on the reading', () => {
        const events = [];
        const meter = claude.createContextMeter(event => events.push(event));
        meter.see(assistantMessage({ input_tokens: 10000, output_tokens: 500 }));
        meter.see({ type: 'result', modelUsage: { 'claude-opus-5-5': { inputTokens: 10000, contextWindow: 200000 } } });
        assert.deepStrictEqual(events, [{ type: 'context', used: 10500, limit: 200000, percent: 5, model: 'claude-opus-5-5' }]);
    });

    await check('after that every main-thread reply moves it, and a subagent\'s does not', () => {
        const events = [];
        const meter = claude.createContextMeter(event => events.push(event));
        meter.see(assistantMessage({ input_tokens: 10000, output_tokens: 0 }));
        meter.see({ type: 'result', modelUsage: { 'claude-opus-5-5': { inputTokens: 10000, contextWindow: 200000 } } });
        meter.see(assistantMessage({ input_tokens: 100000, output_tokens: 0 }, { parent_tool_use_id: 'toolu_sub' }));
        meter.see(assistantMessage({ input_tokens: 50000, output_tokens: 0 }));
        assert.deepStrictEqual(events.map(event => event.percent), [5, 25]);
    });

    await check('the window is matched to the model, not to a helper model in the same turn', () => {
        const usage = {
            'claude-haiku-4-5': { inputTokens: 900000, contextWindow: 200000 },
            'claude-opus-5-5[1m]': { inputTokens: 1000, contextWindow: 1000000 },
        };
        assert.strictEqual(claude.contextWindowOf(usage, 'claude-opus-5-5'), 1000000);
        assert.strictEqual(claude.contextWindowOf(usage, 'unknown'), 200000, 'the busiest when none matches');
        assert.strictEqual(claude.contextWindowOf({}, 'x'), 0);
    });

    console.log('\nthe conversation');

    await check('one reading per conversation is kept in the log, the latest', () => {
        const { conversationId } = assistant.create({ scope: 'global' });
        const conversation = assistant._test.conversation(conversationId);
        conversation.provider = 'opencode';
        const emit = event => assistant._test.emit(conversationId, event);
        emit({ type: 'user-message', text: 'hello' });
        emit({ type: 'context', used: 1000, limit: 100000, percent: 1 });
        emit({ type: 'assistant-text', text: 'hi' });
        emit({ type: 'context', used: 2000, limit: 100000, percent: 2 });
        const readings = conversation.events.filter(event => event.type === 'context');
        assert.strictEqual(readings.length, 1);
        assert.strictEqual(readings[0].percent, 2);
    });

    await check('the panel keeps the latest reading, replayed or live', async () => {
        const reducer = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'transcript-reducer.js')).href);
        let state = reducer.INITIAL;
        assert.strictEqual(state.context, null);
        state = reducer.applyEvent(state, { type: 'context', used: 10, limit: 100, percent: 10, provider: 'opencode', at: 1 });
        assert.strictEqual(state.context.percent, 10);
        state = reducer.applyEvent(state, { type: 'context', used: 50, limit: 100, percent: 50, provider: 'opencode', at: 2 });
        assert.strictEqual(state.context.percent, 50);
        const replayed = reducer.replay([
            { type: 'user-message', text: 'hi', at: 1 },
            { type: 'context', used: 30, limit: 100, percent: 30, provider: 'claude-code', at: 2 },
        ]);
        assert.strictEqual(replayed.context.percent, 30, 'a conversation opened again shows its last reading');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    try {
        fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
        // Left in the temp folder.
    }
    process.exit(failed > 0 ? 1 : 0);
})();
