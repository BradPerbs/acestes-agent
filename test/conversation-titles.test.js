/**
 * A conversation named by what it is about, through `send` itself: a draft
 * from the first message at once, the runtime's own words for it once they
 * come, a greeting that waits for the next message, and a title a job set
 * left alone. The runtime is a fake that answers every name question with
 * what the test tells it to. `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-titles-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    // A store that works, so a secret can be kept and then masked.
    safeStorage: { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(String(text), 'utf8'), decryptString: buffer => Buffer.from(buffer).toString('utf8') },
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

/** Every name question the fake was asked, and what it answers next. */
const asked = [];
let answer = 'Fix 502 errors on web-01';
let hold = null;

const fake = {
    supportsImages: false,
    async start() {
        return { send() {}, async interrupt() {}, async close() {}, async setModel() {}, async setEffort() {} };
    },
    async title(request) {
        asked.push(request);
        if (hold) await hold;
        return answer;
    },
};
for (const name of Object.keys(assistant._test.providers)) assistant._test.providers[name] = fake;

/** Let the name question's promise settle. */
const settle = () => new Promise(resolve => setImmediate(resolve));

const titleOf = id => assistant.list({}).find(row => row.conversationId === id)?.title;

(async () => {
    console.log('conversation titles');

    await check('the first message is the draft at once, and the runtime\'s name replaces it', async () => {
        const { conversationId } = assistant.create({});
        let release;
        hold = new Promise((resolve) => { release = resolve; });
        const sent = await assistant.send(conversationId, 'hey can you have a look at the web box, it keeps throwing 502s');
        assert.strictEqual(sent.success, true, sent.message);
        assert.strictEqual(titleOf(conversationId), 'Have a look at the web box, it keeps throwing 502s');
        assert.strictEqual(asked.length, 1);
        assert.ok(asked[0].prompt.includes('it keeps throwing 502s'));

        release();
        hold = null;
        await settle();
        assert.strictEqual(titleOf(conversationId), 'Fix 502 errors on web-01');
        const told = assistant.history(conversationId).events.filter(entry => entry.type === 'title').map(entry => entry.title);
        assert.deepStrictEqual(
            told,
            ['Have a look at the web box, it keeps throwing 502s', 'Fix 502 errors on web-01'],
            'a panel is told the draft and then the name, and one rebuilt from the log agrees',
        );
    });

    await check('it is named once: later messages do not rename it', async () => {
        const { conversationId } = assistant.create({});
        await assistant.send(conversationId, 'check disk usage on db-02 please');
        await settle();
        const before = asked.length;
        answer = 'Something else entirely';
        await assistant.send(conversationId, 'and clean up /var/log while you are there');
        await settle();
        assert.strictEqual(asked.length, before);
        assert.strictEqual(titleOf(conversationId), 'Fix 502 errors on web-01');
        answer = 'Fix 502 errors on web-01';
    });

    await check('a greeting waits for the second message, and is named from both', async () => {
        const { conversationId } = assistant.create({});
        const before = asked.length;
        await assistant.send(conversationId, 'hi');
        await settle();
        assert.strictEqual(asked.length, before, 'nothing to name yet');
        assert.strictEqual(titleOf(conversationId), 'Hi');

        answer = 'Rotate SSH keys on staging';
        let release;
        hold = new Promise((resolve) => { release = resolve; });
        await assistant.send(conversationId, 'rotate the ssh keys on the staging boxes');
        assert.strictEqual(titleOf(conversationId), 'Rotate the ssh keys on the staging boxes', 'the draft moves on from "hi"');
        release();
        hold = null;
        await settle();
        assert.strictEqual(asked.length, before + 1);
        assert.ok(asked.at(-1).prompt.includes('User: hi') && asked.at(-1).prompt.includes('User: rotate the ssh keys'));
        assert.strictEqual(titleOf(conversationId), 'Rotate SSH keys on staging');
    });

    await check('a runtime that gives no name leaves the draft, and is not asked again', async () => {
        const { conversationId } = assistant.create({});
        answer = 'Sure! Let me go and look at the nginx logs first and then I will tell you what I find.';
        await assistant.send(conversationId, 'restart nginx on web-01');
        await settle();
        const before = asked.length;
        assert.strictEqual(titleOf(conversationId), 'Restart nginx on web-01');
        await assistant.send(conversationId, 'and tail the error log');
        await settle();
        assert.strictEqual(asked.length, before);
        answer = 'Fix 502 errors on web-01';
    });

    await check('a secret in the answer is masked like everywhere else', async () => {
        const secrets = require(path.join(ROOT, 'ai', 'secrets'));
        const stored = secrets.forAgent('').set('title-test-key', 'sk-live-TITLESECRET123');
        assert.strictEqual(stored.stored, true, JSON.stringify(stored));
        const { conversationId } = assistant.create({});
        answer = 'Use sk-live-TITLESECRET123 on web-01';
        await assistant.send(conversationId, 'set the api key on web-01');
        await settle();
        assert.ok(!titleOf(conversationId).includes('TITLESECRET123'));
        answer = 'Fix 502 errors on web-01';
    });

    for (const row of assistant.list({})) await assistant.close(row.conversationId);
    try {
        fs.rmSync(userData, { recursive: true, force: true });
    } catch {
        // The runs database can still have its file open on Windows.
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
