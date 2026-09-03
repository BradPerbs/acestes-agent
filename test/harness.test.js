/**
 * The harness pieces that can be exercised without a provider: hooks
 * around a tool call, compaction of a local model's history, the trace a
 * run becomes, and the shape of the delegation tools.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-harness-'));

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

const tools = require(path.join(ROOT, 'ai', 'tools'));
const provider = require(path.join(ROOT, 'ai', 'providers', 'openai-compatible'));
const runs = require(path.join(ROOT, 'runs'));
const db = require(path.join(ROOT, 'runs', 'db'));
const agents = require(path.join(ROOT, 'agents'));

let passed = 0;
let failed = 0;
const check = async (label, fn) => {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        failed++;
    }
};

(async () => {
    console.log('\nhooks');

    await check('a pre-tool hook can block a call, and its reason is what the model reads', async () => {
        const definition = { name: 'probe', handler: async () => ({ text: 'ran' }) };
        const seen = [];
        const ctx = {
            hooks: async (event, payload) => {
                seen.push([event, payload.tool]);
                return event === 'pre-tool' ? { blocked: true, message: 'Not on a Friday.' } : {};
            },
        };
        const result = await tools.invoke(definition, { a: 1 }, ctx);
        assert.strictEqual(result.isError, true);
        assert.strictEqual(result.text, 'Not on a Friday.');
        assert.deepStrictEqual(seen, [['pre-tool', 'probe']], 'the handler and the post hook never ran');
    });

    await check('an allowing hook lets the call through and sees its output afterwards', async () => {
        const definition = { name: 'probe', handler: async (input) => ({ text: `ran ${input.a}` }) };
        const seen = [];
        const ctx = { hooks: async (event, payload) => { seen.push([event, payload.output]); return { blocked: false }; } };
        const result = await tools.invoke(definition, { a: 7 }, ctx);
        assert.strictEqual(result.text, 'ran 7');
        assert.deepStrictEqual(seen, [['pre-tool', undefined], ['post-tool', 'ran 7']]);
    });

    await check('a context without hooks is the plain call', async () => {
        const definition = { name: 'probe', handler: async () => ({ text: 'plain' }) };
        assert.strictEqual((await tools.invoke(definition, {}, {})).text, 'plain');
    });

    await check('hooks are kept on the agent record, validated, and only enabled ones are handed out', () => {
        const made = agents.save({ name: 'Hooked' });
        const id = made.saved;
        agents.save({ id, hooks: [
            { event: 'pre-tool', command: 'python guard.py', tools: ['run_command', ''] },
            { event: 'run-end', command: 'notify-send done', enabled: false },
            { event: 'nonsense', command: 'x' },
            { event: 'post-tool', command: '' },
        ] });
        const stored = agents.get(id).hooks;
        assert.strictEqual(stored.length, 2, 'the two malformed ones are dropped');
        assert.deepStrictEqual(stored[0].tools, ['run_command']);
        assert.strictEqual(agents.hooks(id).length, 1, 'the disabled one is not run');
        assert.strictEqual(agents.hooks(id)[0].command, 'python guard.py');
    });

    console.log('\ncompaction');

    const history = (turns) => {
        const messages = [{ role: 'system', content: 'You are the agent.' }, { role: 'user', content: 'Fix the deploy on web-01.' }];
        for (let index = 0; index < turns; index += 1) {
            messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'run_command', arguments: `{"command":"step ${index}"}` } }] });
            messages.push({ role: 'tool', tool_call_id: `c${index}`, content: `output ${index}` });
        }
        messages.push({ role: 'assistant', content: 'Done with that part.' });
        return messages;
    };

    await check('a short history is left alone; a long one is due for compaction', () => {
        assert.strictEqual(provider.needsCompaction(history(5)), false);
        assert.strictEqual(provider.needsCompaction(history(30)), true);
        const big = [{ role: 'user', content: 'x'.repeat(130000) }];
        assert.strictEqual(provider.needsCompaction(big), true, 'characters count as well as messages');
    });

    await check('the split keeps the system prompt, the tail verbatim, and never orphans a tool answer', () => {
        const { head, middle, tail } = provider.splitForCompaction(history(30));
        assert.strictEqual(head[0].role, 'system');
        assert.ok(tail.length >= provider._test.KEEP_TAIL);
        assert.notStrictEqual(tail[0].role, 'tool', 'the tail does not start on a tool answer');
        assert.strictEqual(head.length + middle.length + tail.length, history(30).length);
    });

    await check('folding puts one summary with provenance in place of the middle', () => {
        const before = history(30);
        const after = provider.foldHistory(before, 'The deploy failed at step 12 because of a missing env var; steps 0 to 20 were diagnostics.');
        assert.ok(after.length < before.length);
        assert.strictEqual(after[0].role, 'system');
        assert.strictEqual(after[1].role, 'user');
        assert.ok(after[1].content.startsWith(provider._test.SUMMARY_MARK));
        assert.ok(/missing env var/.test(after[1].content));
        assert.ok(/run_command \{"command":"step 0"\} → output 0/.test(after[1].content), 'each folded tool call keeps a line of provenance');
        assert.ok(!after.some((message, index) => message.role === 'tool' && index > 0 && after[index - 1].role !== 'assistant' && after[index - 1].role !== 'tool'), 'no orphaned tool message');
        // A second fold carries the first summary forward rather than losing it.
        const again = provider.foldHistory([...after, ...history(30).slice(2)], 'Later: restarted the service.');
        assert.ok(/missing env var/.test(again[1].content) && /restarted the service/.test(again[1].content));
    });

    console.log('\ntraces');

    await check('a run becomes a span tree in the GenAI shape', () => {
        const run = runs.create({ agentId: 'a', title: 'Trace me' });
        runs.start(run.id);
        const turn = runs.beginStep(run.id, { kind: 'turn' });
        const call = runs.beginStep(run.id, { kind: 'tool', name: 'read_file', input: { path: '/etc/hosts' } });
        runs.endStep(run.id, call, { output: '127.0.0.1 localhost' });
        runs.endStep(run.id, turn);
        runs.tally(run.id, { toolCalls: 1, costUsd: 0.01, turns: 1 });
        runs.finish(run.id, {});
        const trace = runs.trace(run.id);
        assert.strictEqual(trace.name, 'invoke_agent');
        assert.strictEqual(trace.attributes['gen_ai.operation.name'], 'invoke_agent');
        assert.strictEqual(trace.children.length, 1);
        assert.strictEqual(trace.children[0].name, 'chat');
        assert.strictEqual(trace.children[0].children[0].name, 'execute_tool');
        assert.strictEqual(trace.children[0].children[0].attributes['gen_ai.tool.name'], 'read_file');
        assert.ok(trace.endTime >= trace.startTime);
        assert.strictEqual(runs.trace('nope'), null);
    });

    await check('a secret in a run title is scrubbed from the log', () => {
        const leaky = runs.create({ agentId: 'a', title: 'my api key is ws-test-key-not-a-real-credential' });
        const fine = runs.create({ agentId: 'a', title: 'check the disks' });
        const changed = runs.scrubTitles(text => text.split('ws-test-key-not-a-real-credential').join('••••'));
        assert.strictEqual(changed, 1);
        assert.strictEqual(runs.get(leaky.id).title, 'my api key is ••••');
        assert.strictEqual(runs.get(fine.id).title, 'check the disks');
        assert.strictEqual(runs.scrubTitles(text => text), 0, 'nothing to change the second time');
    });

    await check('a secret in a step\'s arguments or output is scrubbed from the log', () => {
        const run = runs.create({ agentId: 'a', title: 'form' });
        const seq = runs.beginStep(run.id, { kind: 'tool', name: 'browser_type', input: { text: 'Kp4vZ9mQx2Tw' } });
        runs.endStep(run.id, seq, { output: "fill('Kp4vZ9mQx2Tw')" });
        const changed = runs.scrubSteps(text => text.split('Kp4vZ9mQx2Tw').join('••••'));
        assert.strictEqual(changed, 1);
        const [step] = runs.steps(run.id);
        assert.strictEqual(step.input, '{"text":"••••"}', 'the arguments are kept as text, and scrubbed as text');
        assert.strictEqual(step.output, "fill('••••')");
    });

    console.log('\ndelegation tools');

    await check('the delegation tools are in the catalog with the right approval flags', () => {
        for (const name of ['delegate', 'fan_out']) {
            const tool = tools.BY_NAME.get(name);
            assert.ok(tool, `${name} is in the catalog`);
            assert.strictEqual(tool.readOnly, false, `${name} is a write`);
        }
        assert.strictEqual(tools.BY_NAME.get('list_agents').readOnly, true);
        for (const name of ['schedule_job', 'update_job']) assert.strictEqual(tools.BY_NAME.get(name).readOnly, false);
        assert.strictEqual(tools.BY_NAME.get('list_jobs').readOnly, true);
    });

    await check('delegate refuses without an api, and shapes an outcome with one', async () => {
        const delegate = tools.BY_NAME.get('delegate');
        assert.strictEqual((await delegate.handler({ brief: 'x' }, {})).isError, true);
        const ctx = { delegate: {
            run: async ({ agent, brief }) => ({ status: 'done', conversationId: 'conv-child', summary: `${agent} did: ${brief}` }),
            fanOut: async () => ({ results: [] }),
            agents: () => [],
        } };
        const result = JSON.parse((await delegate.handler({ brief: 'check disks', agent: 'Ops' }, ctx)).text);
        assert.strictEqual(result.status, 'done');
        assert.strictEqual(result.report, 'Ops did: check disks');
        const fan = tools.BY_NAME.get('fan_out');
        const fanned = JSON.parse((await fan.handler({ hostIds: ['h1', 'h2'], brief: 'uptime' }, { delegate: {
            run: async () => ({}),
            fanOut: async ({ hostIds }) => ({ results: hostIds.map(id => ({ hostId: id, host: id, status: 'done', summary: 'up' })) }),
            agents: () => [],
        } })).text);
        assert.strictEqual(fanned.hosts, 2);
        assert.strictEqual(fanned.done, 2);
    });

    await check('schedule_job turns a probe into a heartbeat and a timezone into a cron schedule', async () => {
        const made = [];
        const ctx = { jobs: {
            create: (spec) => { made.push(spec); return { job: { id: 'j', name: spec.name, scheduleText: 'x', nextRunAt: null, policy: spec.policy } }; },
            list: () => [], update: () => ({}), remove: () => ({}), runNow: async () => ({}),
        } };
        const tool = tools.BY_NAME.get('schedule_job');
        await tool.handler({ name: 'Beat', schedule: 'every 5m', prompt: 'p', probe: 'check' }, ctx);
        assert.deepStrictEqual(made[0].schedule, { kind: 'heartbeat', every: '5m', probe: { command: 'check' } });
        await tool.handler({ name: 'Cron', schedule: '0 9 * * 1', prompt: 'p', timezone: 'Europe/Rome' }, ctx);
        assert.deepStrictEqual(made[1].schedule, { kind: 'cron', expr: '0 9 * * 1', tz: 'Europe/Rome' });
        assert.strictEqual(made[1].policy.approvals, 'park', 'parking is the default');
        const refused = await tool.handler({ name: 'Bad', schedule: '0 9 * * 1', prompt: 'p', probe: 'x' }, ctx);
        assert.strictEqual(refused.isError, true, 'a probe needs an interval');
    });

    console.log('\nmodel matching');

    const modelMatch = require(path.join(ROOT, 'ai', 'model-match'));
    const catalogs = [
        { provider: 'claude-code', rows: [
            { value: 'claude-opus-5', label: 'Opus 5', effort: ['low', 'medium', 'high', 'max'], preferred: true },
            { value: 'claude-sonnet-5', label: 'Sonnet 5', effort: ['low', 'medium', 'high'] },
        ] },
        { provider: 'grok', rows: [
            { value: 'grok-4.6', label: 'Grok 4.6', effort: ['low', 'high', 'xhigh'] },
            { value: 'grok-4.6-fast', label: 'Grok 4.6 Fast', effort: ['low', 'high'] },
            { value: 'grok-4', label: 'Grok 4', effort: [] },
        ] },
        { provider: 'opencode', rows: [
            { value: 'anthropic/claude-opus-5', label: 'Opus 5', effort: ['high'] },
        ] },
    ];
    const order = ['claude-code', 'grok', 'opencode'];

    await check('"grok 4.6 xhigh" finds the model on Grok with its effort', () => {
        const found = modelMatch.matchModel(catalogs, 'grok 4.6 xhigh', { providerOrder: order });
        assert.strictEqual(found.provider, 'grok');
        assert.strictEqual(found.model, 'grok-4.6');
        assert.strictEqual(found.effort, 'xhigh');
        assert.strictEqual(found.error, undefined);
    });

    await check('"claude fable 5.1" finds Fable by the id Claude Code reports for it', () => {
        // The rows as the Claude Code SDK actually describes them: the id
        // carries the version with dashes, the label carries no version.
        const claude = [{ provider: 'claude-code', rows: [
            { value: 'opus[1m]', label: 'Opus (1M context)', resolved: 'claude-opus-5[1m]', short: 'Opus', effort: ['low', 'high', 'xhigh'] },
            { value: 'claude-fable-5-1[1m]', label: 'Fable', resolved: 'claude-fable-5-1', short: 'Fable', effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
            { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', short: 'Sonnet', effort: ['low', 'high'] },
        ] }];
        const found = modelMatch.matchModel(claude, 'claude fable 5.1 xhigh', { providerOrder: ['claude-code'] });
        assert.strictEqual(found.error, undefined, found.error);
        assert.strictEqual(found.model, 'claude-fable-5-1[1m]');
        assert.strictEqual(found.effort, 'xhigh');
        assert.strictEqual(modelMatch.matchModel(claude, 'fable', { providerOrder: ['claude-code'] }).model, 'claude-fable-5-1[1m]');
        assert.strictEqual(modelMatch.matchModel(claude, 'opus 5', { providerOrder: ['claude-code'] }).model, 'opus[1m]');
    });

    await check('the tighter name wins, and the runtime word narrows the search', () => {
        assert.strictEqual(modelMatch.matchModel(catalogs, 'grok 4', { providerOrder: order }).model, 'grok-4');
        assert.strictEqual(modelMatch.matchModel(catalogs, 'grok 4.6 fast high', { providerOrder: order }).model, 'grok-4.6-fast');
        const onOpencode = modelMatch.matchModel(catalogs, 'opus on opencode', { providerOrder: order });
        assert.strictEqual(onOpencode.provider, 'opencode');
        assert.strictEqual(onOpencode.model, 'anthropic/claude-opus-5');
    });

    await check('a name two runtimes offer is reported as ambiguous, not guessed', () => {
        const found = modelMatch.matchModel(catalogs, 'opus', { providerOrder: order });
        assert.ok(found.error && /more than one runtime/.test(found.error));
        assert.ok(found.candidates.length >= 2);
    });

    await check('an effort the model does not offer is dropped and named', () => {
        const found = modelMatch.matchModel(catalogs, 'sonnet 5 ultra', { providerOrder: order });
        assert.strictEqual(found.model, 'claude-sonnet-5');
        assert.strictEqual(found.effort, '');
        assert.strictEqual(found.effortDropped, 'ultra');
        assert.deepStrictEqual(found.effortOffered, ['low', 'medium', 'high']);
    });

    await check('only a runtime, or only an effort, picks that runtime\'s preferred model', () => {
        const claude = modelMatch.matchModel(catalogs, 'on claude', { providerOrder: order });
        assert.strictEqual(claude.provider, 'claude-code');
        assert.strictEqual(claude.model, 'claude-opus-5');
        assert.ok(modelMatch.matchModel(catalogs, 'gemini ultra', { providerOrder: order }).error);
        assert.ok(modelMatch.matchModel(catalogs, '', { providerOrder: order }).error);
    });

    await check('list_models reports what the runtimes say, and start_task pins exactly what was listed', async () => {
        const live = [
            { provider: 'claude-code', rows: [
                { value: 'claude-fable-5-1[1m]', label: 'Fable', resolved: 'claude-fable-5-1', effort: ['low', 'high', 'xhigh'], preferred: true },
                { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', effort: ['low', 'high'] },
            ] },
            { provider: 'grok', rows: [{ value: 'grok-4.6', label: 'Grok 4.6', effort: ['high', 'xhigh'] }] },
        ];
        const calls = [];
        const ctx = { jobs: {
            create: () => ({}), list: () => [], update: () => ({}), remove: () => ({}), runNow: async () => ({}),
            listModels: async () => live,
            resolveModel: async () => ({ error: 'should not be asked when provider is given' }),
            startTask: async (spec) => { calls.push(spec); return { job: { id: 'j1' }, runId: 'run-1', conversationId: 'conv-1' }; },
        } };

        const listed = JSON.parse((await tools.BY_NAME.get('list_models').handler({}, ctx)).text);
        assert.deepStrictEqual(listed.runtimes.map(entry => entry.provider), ['claude-code', 'grok']);
        assert.deepStrictEqual(listed.runtimes[0].models[0], { value: 'claude-fable-5-1[1m]', label: 'Fable', efforts: ['low', 'high', 'xhigh'], default: true });

        const start = tools.BY_NAME.get('start_task');
        const started = JSON.parse((await start.handler({ task: 'Say which model you are', provider: 'claude-code', model: 'claude-fable-5-1[1m]', effort: 'xhigh' }, ctx)).text);
        assert.strictEqual(started.runId, 'run-1');
        assert.strictEqual(calls[0].provider, 'claude-code');
        assert.strictEqual(calls[0].model, 'claude-fable-5-1[1m]');
        assert.strictEqual(calls[0].effort, 'xhigh');

        // A value the list does not carry is refused, not guessed at.
        const refused = await start.handler({ task: 'x', provider: 'claude-code', model: 'claude-fable-5.1' }, ctx);
        assert.ok(refused.isError && /list_models/.test(refused.text), refused.text);
        // So is a runtime the agent has not switched on.
        const off = await start.handler({ task: 'x', provider: 'codex', model: 'gpt-5' }, ctx);
        assert.ok(off.isError && /not switched on/.test(off.text), off.text);
        // An effort the model does not offer is dropped and said so.
        const dropped = JSON.parse((await start.handler({ task: 'x', provider: 'claude-code', model: 'sonnet', effort: 'xhigh' }, ctx)).text);
        assert.strictEqual(calls[calls.length - 1].effort, undefined);
        assert.ok(/does not offer/.test(dropped.note || ''), JSON.stringify(dropped));
    });

    await check('start_task resolves the model, pins it on a one-shot job, and parks unless told otherwise', async () => {
        const calls = [];
        const ctx = { jobs: {
            create: () => ({}), list: () => [], update: () => ({}), remove: () => ({}), runNow: async () => ({}),
            resolveModel: async (query) => (query.includes('grok')
                ? { provider: 'grok', model: 'grok-4.6', label: 'Grok 4.6', effort: 'xhigh', effortOffered: ['xhigh'], candidates: [] }
                : { error: 'No model matching that.', candidates: [{ provider: 'grok', model: 'grok-4.6', label: 'Grok 4.6' }] }),
            startTask: async (spec) => { calls.push(spec); return { job: { id: 'j1' }, runId: 'run-1', conversationId: 'conv-1' }; },
        } };
        const tool = tools.BY_NAME.get('start_task');
        const started = JSON.parse((await tool.handler({ task: 'Refactor the auth module\nkeep tests green', model: 'grok 4.6 xhigh' }, ctx)).text);
        assert.strictEqual(started.runId, 'run-1');
        assert.strictEqual(started.approvals, 'park');
        assert.strictEqual(calls[0].provider, 'grok');
        assert.strictEqual(calls[0].model, 'grok-4.6');
        assert.strictEqual(calls[0].effort, 'xhigh');
        assert.strictEqual(calls[0].name, 'Refactor the auth module');

        const free = JSON.parse((await tool.handler({ task: 'Tidy up', autonomous: true }, ctx)).text);
        assert.strictEqual(free.approvals, 'full');
        assert.strictEqual(calls[1].model, undefined, 'no pin when no model was named');

        const missing = await tool.handler({ task: 'x', model: 'gemini' }, ctx);
        assert.strictEqual(missing.isError, true);
        assert.ok(/Closest: Grok 4.6 \(grok\)/.test(missing.text));
    });

    console.log('\nopenai-compatible api');

    const settings = require(path.join(ROOT, 'ai', 'settings'));
    const openai = require(path.join(ROOT, 'ai', 'providers', 'openai'));

    await check('the api runtime is a provider with OpenRouter as its default address', () => {
        assert.ok(settings.PROVIDERS.has('openai'));
        assert.ok(settings.KEYED_PROVIDERS.has('openai'));
        assert.strictEqual(settings.DEFAULTS.apiBaseUrl, 'https://openrouter.ai/api/v1');
        const clean = settings._test.sanitize({ apiBaseUrl: 'https://my-gateway.example.com/v1/' });
        assert.strictEqual(clean.apiBaseUrl, 'https://my-gateway.example.com/v1', 'trailing slash goes');
        assert.strictEqual(settings._test.sanitize({ apiBaseUrl: 'ftp://nope' }).apiBaseUrl, settings.DEFAULTS.apiBaseUrl);
        const endpoint = openai.endpoint({ apiBaseUrl: 'https://x.example/v1', apiKey: 'k' });
        assert.strictEqual(endpoint.apiKey, 'k');
        assert.strictEqual(endpoint.headers['X-Title'], 'Acestes Agent');
    });

    await check('a key is refused rather than stored in the clear when the OS cannot encrypt it', () => {
        const result = settings.setApiKey('openai', 'sk-or-secret');
        assert.ok(result.error && /encrypt/.test(result.error));
        assert.strictEqual(settings.get().apiKeys.openai, false);
        assert.strictEqual(settings.readApiKey('openai'), '');
        assert.ok(settings.setApiKey('codex', 'x').error, 'only the keyed runtimes take a key');
        assert.deepStrictEqual(settings.setApiKey('openai', ''), { stored: false }, 'clearing needs no encryption');
    });

    await check('without a key the api runtime says so instead of dialling', async () => {
        const verdict = await openai.detect({ settings: { apiKey: '' } });
        assert.deepStrictEqual(verdict, { ok: false, reason: 'noKey' });
        assert.strictEqual(await openai.listModels({ settings: { apiKey: '' } }), null);
        await assert.rejects(() => openai.start({ settings: { apiKey: '' } }), /No API key/);
    });

    console.log('\nmcp config');
    const mcpConfig = require(path.join(ROOT, 'ai', 'mcp-config'));
    const inventory = [
        { name: 'Playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { FOO: 'bar' } },
        { name: 'context 7', transport: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer t' } },
    ];

    await check('the generic shape spawns stdio servers through the launcher and passes http ones through', () => {
        const shaped = mcpConfig.agentServers(inventory);
        assert.strictEqual(shaped.Playwright.command, process.execPath);
        assert.ok(shaped.Playwright.args[0].endsWith('mcp-launch.js'));
        const spec = JSON.parse(shaped.Playwright.args[1]);
        assert.strictEqual(spec.command, 'npx');
        assert.deepStrictEqual(spec.args, ['-y', '@playwright/mcp@latest']);
        assert.strictEqual(spec.env.FOO, 'bar');
        assert.strictEqual(shaped.Playwright.env.ELECTRON_RUN_AS_NODE, '1');
        assert.deepStrictEqual(shaped['context 7'], { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer t' } });
    });

    await check('the TOML spelling is what Grok Build reads, and the Codex shape what its SDK takes', () => {
        const toml = mcpConfig.toml(inventory);
        assert.ok(toml.includes('[mcp_servers.Playwright]'));
        assert.ok(toml.includes(`command = ${JSON.stringify(process.execPath)}`));
        assert.ok(toml.includes('[mcp_servers.Playwright.env]\nELECTRON_RUN_AS_NODE = "1"'));
        assert.ok(toml.includes('[mcp_servers."context 7"]\nurl = "https://mcp.context7.com/mcp"\n[mcp_servers."context 7".headers]\nAuthorization = "Bearer t"'));

        const codex = mcpConfig.codex(inventory);
        assert.strictEqual(codex.Playwright.command, process.execPath);
        assert.deepStrictEqual(codex['context 7'], { url: 'https://mcp.context7.com/mcp', http_headers: { Authorization: 'Bearer t' } });
    });

    console.log('\nmcp library');

    const library = require(path.join(ROOT, 'ai', 'mcp-library'));

    await check('the curated shelf lists, filters and hides nothing secret', () => {
        const all = library.list();
        assert.ok(all.length >= 12);
        assert.ok(all.every(template => template.fields.every(field => !('prefix' in field))), 'fields carry no values');
        assert.deepStrictEqual(library.list({ category: 'web' }).map(t => t.id).sort(), ['brave-search', 'fetch', 'playwright']);
        assert.strictEqual(library.list({ query: 'kube' })[0].id, 'kubernetes');
        assert.strictEqual(library.get('nope'), null);
    });

    await check('a template becomes a server record with values in the right places', () => {
        const fs = library.instantiate(library.CURATED.find(t => t.id === 'filesystem'), { root: 'C:\\site' });
        assert.deepStrictEqual(fs.server.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\site']);
        assert.strictEqual(fs.server.template, 'filesystem');
        assert.ok(/needed/.test(library.instantiate(library.CURATED.find(t => t.id === 'filesystem'), {}).error));

        const brave = library.instantiate(library.CURATED.find(t => t.id === 'brave-search'), { BRAVE_API_KEY: 'BSA123' }, { name: 'Brave' });
        assert.strictEqual(brave.server.name, 'Brave');
        assert.deepStrictEqual(brave.server.env, { BRAVE_API_KEY: 'BSA123' });

        const github = library.instantiate(library.CURATED.find(t => t.id === 'github'), { Authorization: 'github_pat_x' });
        assert.strictEqual(github.server.transport, 'http');
        assert.strictEqual(github.server.url, 'https://api.githubcopilot.com/mcp/');
        assert.deepStrictEqual(github.server.headers, { Authorization: 'Bearer github_pat_x' }, 'the prefix is kept out of what the user types');

        const memory = library.instantiate(library.CURATED.find(t => t.id === 'memory'), {});
        assert.deepStrictEqual(memory.server.env, {}, 'an optional field left empty sets nothing');

        const playwright = library.CURATED.find(t => t.id === 'playwright');
        const bare = library.instantiate(playwright, {});
        assert.deepStrictEqual(bare.server.args, ['-y', '@playwright/mcp@latest'], 'a flag and an option left empty are left out');
        const tuned = library.instantiate(playwright, { headless: 'yes', profile: 'C:\\browser', proxy: 'http://proxy:3128' });
        assert.deepStrictEqual(
            tuned.server.args,
            ['-y', '@playwright/mcp@latest', '--headless', '--user-data-dir=C:\\browser', '--proxy-server=http://proxy:3128'],
            'an option carries its value with it',
        );

        const custom = library.instantiate(library.CURATED.find(t => t.id === 'custom-http'), { url: 'nope' });
        assert.ok(/http/.test(custom.error));
    });

    await check('a registry entry is read into the same template shape', () => {
        const remote = library.fromRegistry({
            server: {
                name: 'io.github.acme/thing',
                description: 'Acme things.',
                remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp', headers: [
                    { name: 'Authorization', value: 'Bearer {acme_token}', isRequired: true, isSecret: true, description: 'Acme API token' },
                ] }],
            },
            _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
        });
        assert.strictEqual(remote.id, 'registry:io.github.acme/thing');
        assert.strictEqual(remote.transport, 'http');
        assert.strictEqual(remote.fields[0].kind, 'header');
        assert.strictEqual(remote.fields[0].prefix, 'Bearer ');
        const made = library.instantiate(remote, { Authorization: 'tok' });
        assert.deepStrictEqual(made.server.headers, { Authorization: 'Bearer tok' });

        const npm = library.fromRegistry({
            server: {
                name: 'io.github.acme/files',
                description: 'Files.',
                packages: [{
                    registryType: 'npm', identifier: '@acme/files-mcp', version: '1.2.0', runtimeHint: 'npx',
                    packageArguments: [{ type: 'positional', valueHint: 'root', description: 'Folder to serve', isRequired: true }],
                    environmentVariables: [{ name: 'ACME_TOKEN', description: 'Token', isRequired: true, isSecret: true }],
                }],
            },
        });
        assert.strictEqual(npm.command, 'npx');
        assert.deepStrictEqual(npm.args, ['-y', '@acme/files-mcp@1.2.0', '{{root}}']);
        assert.deepStrictEqual(npm.fields.map(f => [f.key, f.kind]), [['root', 'arg'], ['ACME_TOKEN', 'env']]);
        const built = library.instantiate(npm, { root: '/srv', ACME_TOKEN: 'abc' });
        assert.deepStrictEqual(built.server.args, ['-y', '@acme/files-mcp@1.2.0', '/srv']);
        assert.deepStrictEqual(built.server.env, { ACME_TOKEN: 'abc' });

        assert.strictEqual(library.fromRegistry({ server: { name: 'x', packages: [{ registryType: 'nuget', identifier: 'X', runtimeHint: 'dotnet' }] } }), null, 'a runtime this app cannot launch is left out');
        assert.strictEqual(library.fromRegistry({ server: { name: 'gone' }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated' } } }), null);
    });

    await check('save_mcp_server takes a template and its values', async () => {
        const id = agents.save({ name: 'Libby' }).saved;
        const tool = tools.BY_NAME.get('save_mcp_server');
        const result = JSON.parse((await tool.handler({ template: 'filesystem', values: { root: 'C:\\site' } }, { agentId: id })).text);
        assert.strictEqual(result.saved, 'created');
        const stored = agents.get(id).mcpServers[0];
        assert.strictEqual(stored.name, 'Filesystem');
        assert.strictEqual(stored.template, 'filesystem');
        assert.deepStrictEqual(stored.args, ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\site']);
        const missing = await tool.handler({ template: 'github', values: {} }, { agentId: id });
        assert.strictEqual(missing.isError, true);
        const listed = JSON.parse((await tools.BY_NAME.get('list_mcp_library').handler({ category: 'files', registry: false }, {})).text);
        assert.strictEqual(listed.curated[0].template, 'filesystem');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    db.close();
    fs.rmSync(userData, { recursive: true, force: true });
    if (failed > 0) process.exit(1);
})();
