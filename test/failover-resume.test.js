/**
 * Failover, end to end through the assistant: a conversation is mid-turn,
 * with a command sent and no answer back, when its process dies. The next
 * launch, with failover on, sends the turn on: under the same run, resumed
 * on the runtime's own session, told which call never reported back, and
 * the user told it happened.
 *
 * The first life runs in a child process (this file, with `--first-life`)
 * that exits without any of the app's shutdown, which is what a crash
 * leaves behind. The runtime is a fake that records what it is sent;
 * `electron` and the embedding model are stubbed.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const FIRST_LIFE = process.argv.includes('--first-life');
const userData = FIRST_LIFE
    ? process.argv[process.argv.indexOf('--first-life') + 1]
    : fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-failover-resume-'));

const toasts = [];
const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}), isPackaged: false },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(String(text), 'utf8'), decryptString: buffer => Buffer.from(buffer).toString('utf8') },
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
    async title() { return 'Fix nginx'; },
};

/** Load the failover module for a launch, without a real watchdog. */
function launchFailover(argv) {
    const childProcess = require('child_process');
    const realFork = childProcess.fork;
    childProcess.fork = () => { throw new Error('no watchdog in tests'); };
    const failover = require(path.join(ROOT, 'failover'));
    failover.init({ argv });
    childProcess.fork = realFork;
    return failover;
}

function loadAssistant() {
    const assistant = require(path.join(ROOT, 'ai'));
    for (const name of Object.keys(assistant._test.providers)) assistant._test.providers[name] = fake;
    assistant.setToaster(toast => toasts.push(toast));
    return assistant;
}

async function firstLife() {
    launchFailover(['electron', '.']);
    const assistant = loadAssistant();
    const runs = require(path.join(ROOT, 'runs'));
    const archive = require(path.join(ROOT, 'ai', 'archive'));

    const { conversationId } = assistant.create({});
    const sent = await assistant.send(conversationId, 'restart nginx on web-01 and check it came back');
    if (!sent.success) throw new Error(sent.message);
    const { options } = starts[0];
    options.onEvent({ type: 'session', sessionId: 'runtime-session-7' });
    options.onEvent({ type: 'assistant-text', text: 'Restarting nginx now.' });
    options.onEvent({ type: 'tool-call', id: 'call-1', name: 'run_command', input: { command: 'systemctl restart nginx' } });

    const conversation = assistant._test.conversation(conversationId);
    // What the archive's timer would have written by now.
    archive.flush();
    process.stdout.write(JSON.stringify({
        pid: process.pid,
        conversationId,
        runId: conversation.runId,
        status: runs.get(conversation.runId).status,
    }));
    // A crash: none of the app's shutdown runs.
    process.exit(0);
}

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

async function secondLife() {
    console.log('\nfailover: a turn cut short, sent on after the crash');

    fs.writeFileSync(path.join(userData, 'failover.json'), JSON.stringify({ enabled: true }));
    const first = spawnSync(process.execPath, [__filename, '--first-life', userData], { encoding: 'utf8', timeout: 60000 });
    if (first.status !== 0) {
        console.log(first.stdout, first.stderr);
        throw new Error(`the first life failed (${first.status})`);
    }
    const before = JSON.parse(first.stdout.trim().split('\n').pop());

    await check('the first life died mid-turn, its run still open and its lease never closed', () => {
        assert.strictEqual(before.status, 'running');
        const lease = JSON.parse(fs.readFileSync(path.join(userData, 'failover-lease.json'), 'utf8'));
        assert.strictEqual(lease.pid, before.pid);
        assert.strictEqual(lease.clean, false);
    });

    const failover = launchFailover(['electron', '.']);
    const assistant = loadAssistant();
    const runs = require(path.join(ROOT, 'runs'));

    await check('the next launch reads that as a crash and wants the work resumed', () => {
        assert.strictEqual(failover.resumeWanted(), true);
        assert.strictEqual(failover.status().lastRecovery.reason, 'unclean');
    });

    const result = await failover.afterLaunch(() => assistant.resumeInterrupted());

    await check('the turn is sent on, under the same run', () => {
        assert.strictEqual(result.resumed, 1);
        const run = runs.get(before.runId);
        assert.strictEqual(run.status, 'running');
        assert.strictEqual(assistant._test.conversation(before.conversationId).runId, before.runId);
    });

    await check('the runtime resumes its own session, so the agent remembers the turn', () => {
        assert.strictEqual(starts.length, 1);
        assert.strictEqual(starts[0].options.resumeSessionId, 'runtime-session-7');
    });

    await check('the agent is told what happened, and to check the call that never reported back', () => {
        const message = starts[0].session.sent[0];
        assert.match(message, /<app-note>[\s\S]*stopped unexpectedly[\s\S]*<\/app-note>/);
        assert.match(message, /never reported back[\s\S]*run_command[\s\S]*systemctl restart nginx/);
        assert.match(message, /list_sessions/);
        assert.ok(message.endsWith('Carry on from where you were cut off.'), message.slice(-200));
    });

    await check('the transcript says the turn was cut short and is being carried on', () => {
        const events = assistant._test.conversation(before.conversationId).events;
        const notices = events.filter(event => event.type === 'notice').map(event => event.text);
        assert.ok(notices.some(text => /cut short when the app closed/.test(text)), notices.join(' | '));
        assert.ok(notices.some(text => /Failover restarted it/.test(text)), notices.join(' | '));
        const said = events.filter(event => event.type === 'user-message').map(event => event.text);
        assert.strictEqual(said.length, 2);
        assert.match(said[1], /^Failover restarted the app/);
    });

    await check('the user is told, with the conversation to open', () => {
        assert.strictEqual(toasts.length, 1);
        assert.match(toasts[0].title, /restarted and carried on/);
        assert.ok(toasts[0].conversationId);
    });

    await check('nothing is resumed twice', async () => {
        assert.deepStrictEqual(await assistant.resumeInterrupted(), { resumed: 0 });
        assert.strictEqual(starts.length, 1);
    });

    await check('the resume counts against the turn\'s limit', () => {
        const settings = JSON.parse(fs.readFileSync(path.join(userData, 'failover.json'), 'utf8'));
        assert.strictEqual(settings.resumes[before.runId], 1);
    });

    try { require(path.join(ROOT, 'runs', 'db')).close(); } catch { /* closed */ }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
}

(FIRST_LIFE ? firstLife() : secondLife()).catch((error) => {
    console.error(error);
    process.exit(1);
});
