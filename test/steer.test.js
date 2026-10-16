/**
 * Steering a turn while it runs: words the user said to the corner card
 * during computer use wait on the conversation, and ride to the model on
 * the next result of one of our tools, whichever runtime is answering. The
 * transcript gets them at that moment. A turn stopped before then says they
 * were not passed on, with the words.
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
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-steer-'));

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

/** A tool of ours, as a runtime would hand a call to it. */
const clickTool = { name: 'click', handler: async () => ({ text: 'Clicked button "Next".' }) };

(async () => {
    const { conversationId } = assistant.create({});
    const conversation = assistant._test.conversation(conversationId);
    const ctx = { takeSteer: () => assistant._test.takeSteers(conversationId) };
    assistant._test.emit(conversationId, { type: 'user-message', text: 'Fill in the signup form' });
    conversation.busy = true;

    await check('said while it works, a steer waits on the turn rather than stopping it', async () => {
        const result = await assistant.steer(conversationId, '  use the work address  ');
        assert.deepStrictEqual(result, { success: true, steered: true });
        assert.deepStrictEqual(conversation.steers, ['use the work address']);
        assert.strictEqual(conversation.busy, true, 'the turn goes on');
        assert.ok(!conversation.events.some(event => event.type === 'steer'), 'not in the transcript until the agent has it');
    });

    await check('the next tool result carries it to the model, and the transcript gets it then', async () => {
        const result = await tools.invoke(clickTool, {}, ctx);
        assert.ok(result.text.startsWith('Clicked button "Next".'), 'the result itself comes first');
        assert.ok(/<user-steer>[\s\S]*"use the work address"[\s\S]*<\/user-steer>/.test(result.text), result.text);
        assert.ok(/do not stop/.test(result.text), 'told to carry on, changed by it');
        const steer = conversation.events.filter(event => event.type === 'steer');
        assert.deepStrictEqual(steer.map(event => event.text), ['use the work address']);
        assert.deepStrictEqual(conversation.steers, []);
    });

    await check('handed over once: the call after that is untouched', async () => {
        const result = await tools.invoke(clickTool, {}, ctx);
        assert.strictEqual(result.text, 'Clicked button "Next".');
    });

    await check('two said before the next call go together, in order', async () => {
        await assistant.steer(conversationId, 'first name only');
        await assistant.steer(conversationId, 'and skip the newsletter');
        const result = await tools.invoke(clickTool, {}, ctx);
        assert.ok(result.text.indexOf('"first name only"') < result.text.indexOf('"and skip the newsletter"'), result.text);
    });

    await check('a call with no conversation behind it (a test, the page) is the plain call', async () => {
        const result = await tools.invoke(clickTool, {}, {});
        assert.strictEqual(result.text, 'Clicked button "Next".');
    });

    await check('nothing said is refused, and a conversation that is gone says so', async () => {
        assert.strictEqual((await assistant.steer(conversationId, '   ')).success, false);
        assert.strictEqual((await assistant.steer('no-such-conversation', 'hello')).success, false);
    });

    await check('stopped before the agent read it: the transcript says it was not passed on, with the words', async () => {
        await assistant.steer(conversationId, 'actually use my personal email');
        await assistant.interrupt(conversationId);
        assert.deepStrictEqual(conversation.steers, []);
        const warning = conversation.events.filter(event => event.type === 'warning').at(-1);
        assert.ok(/Not passed on/.test(warning.message) && /actually use my personal email/.test(warning.message), warning.message);
    });

    await check('the carry-over to another runtime keeps what was said mid-turn', async () => {
        // The carry-over is of the turns before the message about to go.
        assistant._test.emit(conversationId, { type: 'user-message', text: 'Now submit it' });
        const said = assistant._test.saidBefore(conversationId);
        assert.ok(/while the agent worked/.test(said) && /use the work address/.test(said), said);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    Module._load = realLoad;
    process.exit(failed > 0 ? 1 : 0);
})();
