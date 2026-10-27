/**
 * A model lent between devices (src/main/fleet/brain.js), over a real relay.
 *
 * The desk has a model; the server has none. The desk's stand-in runtime
 * does what a real one is seen to do from outside: says which session it is,
 * calls a tool, asks about a call of its own, says something with what the
 * tool gave back, and ends the turn. Every call has to come back to the
 * server and run there, and every event has to reach the server in order.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHub } = require('../src/main/fleet/hub');
const { createDevice } = require('../src/main/fleet/device');
const { createBrain, fitResult } = require('../src/main/fleet/brain');

let passed = 0;
let failed = 0;

async function check(label, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${label}`);
    } catch (error) {
        failed += 1;
        process.exitCode = 1;
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.stack || error.message}`);
    }
}

async function until(test, what, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await test()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

function makeDevice(name, info = {}) {
    const saved = { value: null };
    return createDevice({
        load: () => (saved.value ? JSON.parse(saved.value) : null),
        save: (state) => {
            saved.value = JSON.stringify(state);
        },
        describe: () => ({ os: 'test', ...info }),
        defaultName: () => name,
    });
}

/** The desk's runtime, as hostRun hands it over: one scripted turn per message. */
function makeHost() {
    const runs = [];
    return {
        runs,
        hostRun: async (options) => {
            const run = { options, sent: [], interrupted: 0, closed: 0 };
            runs.push(run);
            run.session = {
                send(text) {
                    run.sent.push(text);
                    (async () => {
                        options.onEvent({ type: 'models', models: ['kept on the desk'] });
                        options.onEvent({ type: 'session', sessionId: 'abc123' });
                        options.onEvent({ type: 'tool', name: 'read_screen', input: { window: 'calc' } });
                        const result = await options.forwardTool('read_screen', { window: 'calc' });
                        const verdict = await options.requestApproval({ toolName: 'WebSearch', name: 'WebSearch', input: { query: 'x' }, local: true, signal: {} });
                        options.onEvent({ type: 'assistant-text', text: `saw: ${result.text}; search ${verdict.approved ? 'allowed' : 'refused'}` });
                        options.onEvent({ type: 'result', text: 'done' });
                    })();
                },
                async interrupt() {
                    run.interrupted += 1;
                },
                async close() {
                    run.closed += 1;
                },
            };
            return { session: run.session, runtime: 'claude-code', model: 'opus' };
        },
    };
}

(async () => {
    console.log('\nfleet brain');

    await check('a result that is too large loses its picture first, then its text', () => {
        const small = fitResult({ text: 'hi', images: [{ data: 'abc', mediaType: 'image/png' }] });
        assert.deepStrictEqual(small, { text: 'hi', images: [{ data: 'abc', mediaType: 'image/png' }] });
        const big = fitResult({ text: 'screen', images: [{ data: 'x'.repeat(600 * 1024), mediaType: 'image/png' }] });
        assert.strictEqual(big.images, undefined);
        assert(/too large/.test(big.text));
        const long = fitResult({ text: 'y'.repeat(900 * 1024), isError: true });
        assert(JSON.stringify(long).length < 410 * 1024);
        assert.strictEqual(long.isError, true);
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-brain-'));
    const hub = createHub({ port: 0, host: '127.0.0.1', file: path.join(dir, 'relay.json') });
    const { port } = await hub.start();

    const desk = makeDevice('Office PC', { lendsModel: true, acceptsTasks: true });
    const server = makeDevice('RDP-01', { lendsModel: false });
    const host = makeHost();
    const accept = { on: true };
    createBrain({ device: desk, ai: { hostRun: host.hostRun }, accepts: () => accept.on, selfName: () => 'Office PC' });
    const serverBrain = createBrain({ device: server, ai: { hostRun: async () => { throw new Error('no model here'); } }, selfName: () => 'RDP-01' });

    desk.createFleet({ relay: `ws://127.0.0.1:${port}` });
    await until(() => desk.status().connection.state === 'online', 'desk online');
    server.join(desk.createInvite().code);
    await until(() => server.status().fleet && server.isOnline(desk.selfId()) && desk.isOnline(server.selfId()), 'server joined');
    await until(() => server.devices().find(entry => entry.id === desk.selfId())?.info?.lendsModel, 'desk says it lends');

    await check('the server picks the desk to borrow from, and never itself', () => {
        const lender = serverBrain.lender();
        assert(lender, 'a lender');
        assert.strictEqual(lender.id, desk.selfId());
        assert.strictEqual(serverBrain.lender(desk.selfId()).id, desk.selfId());
    });

    const events = [];
    const toolCalls = [];
    const approvals = [];
    let session = null;

    await check('opening starts the runtime on the desk with the server\'s prompt and tool list', async () => {
        session = await serverBrain.open({
            peer: serverBrain.lender(),
            systemPrompt: 'You are on RDP-01.',
            toolSettings: { computerUse: true, toolBundles: { desktop: true } },
            resumeSessionId: 'fleet:someone-else:old',
            runTool: async (name, input) => {
                toolCalls.push({ name, input });
                return { text: `calculator on RDP-01 (${input.window})` };
            },
            approve: async (request) => {
                approvals.push(request);
                return { approved: true };
            },
            onEvent: event => events.push(event),
        });
        assert.strictEqual(session.lender.name, 'Office PC');
        assert.strictEqual(session.lender.runtime, 'claude-code');
        assert.strictEqual(host.runs.length, 1);
        const { options } = host.runs[0];
        assert.strictEqual(options.systemPrompt, 'You are on RDP-01.');
        assert.deepStrictEqual(options.toolSettings, { computerUse: true, toolBundles: { desktop: true } });
        assert.strictEqual(options.resumeSessionId, '', 'another computer\'s session is not resumed');
    });

    await check('a turn: the tool runs on the server, the approval is asked there, events arrive in order', async () => {
        session.send('set it up');
        await until(() => events.some(event => event.type === 'result'), 'the turn to end');
        assert.deepStrictEqual(host.runs[0].sent, ['set it up']);
        assert.deepStrictEqual(toolCalls, [{ name: 'read_screen', input: { window: 'calc' } }]);
        assert.strictEqual(approvals.length, 1);
        assert.strictEqual(approvals[0].name, 'WebSearch');
        assert.strictEqual(approvals[0].signal, undefined, 'nothing unsendable crosses');
        assert.deepStrictEqual(events.map(event => event.type), ['session', 'tool', 'assistant-text', 'result'], 'the desk\'s model list stays there');
        assert.strictEqual(events[0].sessionId, `fleet:${desk.selfId()}:abc123`);
        assert.strictEqual(events[2].text, 'saw: calculator on RDP-01 (calc); search allowed');
    });

    await check('a session the desk kept is resumed when the same desk lends again', async () => {
        const again = await serverBrain.open({
            peer: serverBrain.lender(),
            resumeSessionId: `fleet:${desk.selfId()}:abc123`,
            runTool: async () => ({ text: '' }),
            approve: async () => ({ approved: false }),
            onEvent: () => {},
        });
        assert.strictEqual(host.runs[1].options.resumeSessionId, 'abc123');
        await again.close();
        await until(() => host.runs[1].closed === 1, 'the second run to close');
    });

    await check('stop and close reach the desk\'s runtime', async () => {
        await session.interrupt();
        assert.strictEqual(host.runs[0].interrupted, 1);
        await session.close();
        await until(() => host.runs[0].closed === 1, 'the run to close');
    });

    await check('a locked desk does not lend', async () => {
        accept.on = false;
        await assert.rejects(
            serverBrain.open({ peer: serverBrain.lender(), runTool: async () => ({}), approve: async () => ({}), onEvent: () => {} }),
            /could not lend its model: Office PC is locked/,
        );
        accept.on = true;
    });

    await check('the desk cannot run tools for a conversation the server did not open with it', async () => {
        await assert.rejects(
            desk.request(server.selfId(), 'brain.tool', { sid: 'made-up', name: 'run_local_command', input: { command: 'whoami' } }),
            /not open here/,
        );
    });

    desk.stop();
    server.stop();
    // Let the sockets close before the process goes: Node on Windows aborts
    // on a handle still closing at exit.
    await new Promise(resolve => setTimeout(resolve, 300));
    await hub.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(process.exitCode || 0);
})();
