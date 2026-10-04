/**
 * The Antigravity provider against a scripted `agy`.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-agy-'));
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

const agy = require('../src/main/ai/providers/antigravity');
agy._test.useCommand({ command: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-agy.js')] });

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

(async () => {
    await test('skipped actions are said in one sentence', () => {
        assert.match(agy._test.deniedNotice([{ tool: 'write_file', target: 'a.txt' }, 'run_command']), /skipped 2 actions.*write_file \(a\.txt\), run_command/);
        assert.strictEqual(agy._test.deniedNotice([]), '');
    });

    await test('the model list groups each tier into its base model', async () => {
        const rows = await agy.listModels();
        assert.deepStrictEqual(rows.map(row => row.value), ['gemini-3.8-flash', 'claude-opus-4.6']);
        assert.strictEqual(rows[0].label, 'Gemini 3.8 Flash');
        assert.strictEqual(rows[1].short, 'Claude Opus 4.6');
        assert.deepStrictEqual(rows[0].effort, ['low', 'medium', 'high']);
        // A base seen with no tier carries none, and runs with its default.
        assert.deepStrictEqual(rows[1].effort, []);
        // The real TSV shape parses too, including a Fetching line on stderr.
        const tsv = agy._test.describeModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n');
        assert.strictEqual(tsv[0].value, 'gemini-3.8-flash');
        assert.deepStrictEqual(tsv[0].effort, ['high']);
    });

    await test('the tier rides as --effort on the base model, never as a suffixed slug', () => {
        // The reported failure: a medium slug with --effort high conflicted.
        const args = agy._test.runArguments({ model: 'claude-opus-5-5-medium', effort: 'high' });
        assert.ok(!args.some(arg => String(arg).includes('claude-opus-5-5-medium')), 'no suffixed slug');
        assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
        assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
        // Higher stored stops ride as the lineup's top instead of erroring.
        const capped = agy._test.runArguments({ model: 'gemini-3.8-flash', effort: 'xhigh' });
        assert.strictEqual(capped[capped.indexOf('--effort') + 1], 'high');
        // No effort stored: the base runs with its default.
        assert.ok(!agy._test.runArguments({ model: 'gemini-3.8-flash' }).includes('--effort'));
    });

    await test('/usage becomes a five-hour and a weekly window, without a turn', async () => {
        const answer = await agy.readLimits();
        assert.strictEqual(answer.identity.email, 'me@example.com');
        assert.strictEqual(answer.identity.plan, 'pro');
        const byId = Object.fromEntries(answer.windows.map(window => [window.id, window.used]));
        assert.deepStrictEqual(byId, { five_hour: 25, seven_day: 60 });
    });

    const events = [];
    let current = { approval: 'writes', allowLocalTools: true, mcpServers: [], model: 'gemini-3.8-flash', effort: 'high' };
    const session = await agy.start({
        settings: current,
        getSettings: () => current,
        systemPrompt: 'SYSTEM',
        toolContext: () => ({ settings: current }),
        requestApproval: async () => ({ approved: true }),
        onEvent: event => events.push(event),
    });

    await test('a turn runs one process with the workspace MCP config, and streams text and our tools', async () => {
        session.send('hello');
        await until(() => events.some(event => event.type === 'result'), 'the first result');
        const texts = events.filter(event => event.type === 'assistant-text').map(event => event.text);
        assert.strictEqual(texts[0], 'Looking. ');
        assert.ok(texts[1].includes('servers=remote'), texts[1]);
        assert.ok(texts[1].includes('model=gemini-3.8-flash'), 'the base model passes to the CLI');
        assert.ok(texts[1].includes('effort=high'), 'the tier passes as --effort');
        assert.ok(texts[1].includes('prompt=with-system'));
        assert.ok(texts[1].includes('skip=false'));
        const call = events.find(event => event.type === 'tool-call');
        assert.strictEqual(call.name, 'list_hosts');
        assert.strictEqual(call.local, false);
        assert.ok(events.some(event => event.type === 'session' && event.sessionId === 'conv-1'));
        assert.deepStrictEqual(events.find(event => event.type === 'result').usage, { input_tokens: 500, output_tokens: 75, cache_read_input_tokens: 100 });
        assert.ok(!events.some(event => event.type === 'notice'), 'no warning when the tools loaded');
    });

    await test('the next turn continues the conversation and says what was skipped', async () => {
        events.length = 0;
        session.send('please write notes');
        await until(() => events.some(event => event.type === 'result'), 'the second result');
        const reply = events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(reply.includes('conversation=conv-1'), reply);
        assert.ok(reply.includes('prompt=plain'), 'the system prompt goes once');
        assert.match(events.find(event => event.type === 'notice').text, /skipped 1 action/);
    });

    await test('"Never ask" runs with permissions skipped', async () => {
        events.length = 0;
        current = { ...current, approval: 'never' };
        session.send('hello');
        await until(() => events.some(event => event.type === 'result'), 'the third result');
        assert.ok(events.filter(event => event.type === 'assistant-text').pop().text.includes('skip=true'));
    });

    await test('a failed run is an error with its reason', async () => {
        events.length = 0;
        session.send('this will fail');
        await until(() => events.some(event => event.type === 'result'), 'the failed result');
        assert.strictEqual(events.find(event => event.type === 'result').isError, true);
        assert.match(events.find(event => event.type === 'error').message, /model unavailable/);
    });

    await session.close();
    console.log(`${passed} passed, 0 failed`);
    fs.rmSync(userData, { recursive: true, force: true });
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
