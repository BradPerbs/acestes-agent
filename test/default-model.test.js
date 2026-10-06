/**
 * What a new conversation starts on, for the whole app.
 *
 * The model last picked or sent with, in any tab of any agent, unless one is
 * starred; the agent's own default only before either, or when the runtime
 * behind them is switched off. Checked through the main process the way the
 * window reaches it: a new conversation (`create` then `startOnPick`, as the
 * start handler does), a fork (`branch` then `startOnPick`), a send
 * (`rememberUsed`), and the star. `electron` is stubbed so it runs under node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-start-model-'));
const machineClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-start-model-claude-'));
process.env.CLAUDE_CONFIG_DIR = machineClaude;

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

const agents = require(path.join(ROOT, 'agents'));
const settings = require(path.join(ROOT, 'ai', 'settings'));
const assistant = require(path.join(ROOT, 'ai'));
const startModel = require(path.join(ROOT, 'ai', 'start-model'));

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

/** A conversation as a tab opens one: made, then put on the start model. */
function openTab(agentId) {
    const created = assistant.create({ agentId, scope: 'global' });
    const pinned = assistant.startOnPick(created.conversationId);
    return { id: created.conversationId, pinned };
}

const forget = () => {
    try { fs.rmSync(path.join(userData, 'start-model.json'), { force: true }); } catch { /* none */ }
    startModel._test.reset();
};

(async () => {
    // Two runtimes switched on for the machine; two agents with defaults of
    // their own, one of them on an explicit model, which is how the bug
    // looked: that default used to beat whatever had been picked since.
    settings.set({ providers: ['claude-code', 'codex'], provider: 'claude-code' });
    const first = agents.activeId();
    settings.set({ provider: 'codex', model: 'gpt-5.5', effort: 'high' }, first);
    const second = agents.save({ name: 'Second' }).saved;
    settings.set({ provider: 'claude-code', model: '', effort: 'medium' }, second);

    console.log('\nthe last model used');

    await check('before anything is picked, a new tab is on its agent\'s own default', () => {
        forget();
        const tab = openTab(first);
        assert.strictEqual(tab.pinned, null);
        assert.strictEqual(assistant.effectiveSettings(assistant._test.conversation(tab.id)).model, 'gpt-5.5');
    });

    await check('a pick carries to a new tab of another agent, and of the same one', () => {
        forget();
        startModel.remember({ provider: 'claude-code', model: 'opus', effort: 'max' });
        for (const agentId of [second, first]) {
            const tab = openTab(agentId);
            assert.deepStrictEqual(tab.pinned, { provider: 'claude-code', model: 'opus', effort: 'max' }, agentId);
            const running = assistant.effectiveSettings(assistant._test.conversation(tab.id));
            assert.strictEqual(running.provider, 'claude-code');
            assert.strictEqual(running.model, 'opus');
        }
    });

    await check('an agent\'s own default model no longer beats the model last used', () => {
        forget();
        startModel.remember({ provider: 'claude-code', model: 'sonnet', effort: 'high' });
        assert.strictEqual(settings.get(first).model, 'gpt-5.5', 'the agent still has its default');
        assert.strictEqual(openTab(first).pinned.model, 'sonnet');
    });

    await check('sending is using: the conversation sent from is what the next tab starts on', () => {
        forget();
        startModel.remember({ provider: 'claude-code', model: 'opus' });
        const tab = openTab(second);
        assistant.setConversationModel(tab.id, { provider: 'codex', model: 'gpt-5.5-mini', effort: 'low' });
        assistant.rememberUsed(tab.id);
        assert.deepStrictEqual(openTab(first).pinned, { provider: 'codex', model: 'gpt-5.5-mini', effort: 'low' });
    });

    await check('a send on a runtime\'s unnamed default keeps no foreign model name', () => {
        forget();
        startModel.remember({ provider: 'claude-code', model: 'opus' });
        // The first agent's default model is a Codex one; a conversation of
        // it moved to Claude Code without naming a model is not "gpt-5.5".
        const created = assistant.create({ agentId: first, scope: 'global' });
        assistant.setConversationModel(created.conversationId, { provider: 'claude-code' });
        assistant.rememberUsed(created.conversationId);
        assert.strictEqual(startModel.get().last.model, 'opus', 'the last named model stands');
    });

    await check('a fork starts on the model last used, not on the agent default', () => {
        forget();
        const source = assistant.create({ agentId: first, scope: 'global' }).conversationId;
        const at = Date.now();
        assistant._test.emit(source, { type: 'user-message', text: 'hello', at });
        assistant._test.emit(source, { type: 'assistant-text', text: 'hi' });
        startModel.remember({ provider: 'claude-code', model: 'opus', effort: 'max' });
        const forked = assistant.branch(source, at);
        assert.ok(forked.success, forked.message);
        assistant.startOnPick(forked.conversationId);
        const running = assistant.effectiveSettings(assistant._test.conversation(forked.conversationId));
        assert.strictEqual(running.model, 'opus');
        assert.strictEqual(running.effort, 'max');
    });

    console.log('\nthe star');

    await check('a starred model wins over the last one used, and unstarring hands back', () => {
        forget();
        startModel.remember({ provider: 'claude-code', model: 'opus' });
        startModel.star({ provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
        startModel.remember({ provider: 'claude-code', model: 'sonnet' });
        assert.deepStrictEqual(openTab(second).pinned, { provider: 'codex', model: 'gpt-5.5', effort: 'xhigh' });
        startModel.star(null);
        assert.strictEqual(openTab(second).pinned.model, 'sonnet');
    });

    await check('a runtime switched off is passed over: star, then last, then the agent default', () => {
        forget();
        startModel.star({ provider: 'codex', model: 'gpt-5.5' });
        startModel.remember({ provider: 'claude-code', model: 'opus' });
        settings.set({ providers: ['claude-code'] });
        try {
            assert.strictEqual(openTab(second).pinned.model, 'opus', 'the star\'s runtime is off');
            startModel.remember({ provider: 'codex', model: 'gpt-5.5-mini' });
            assert.strictEqual(openTab(second).pinned, null, 'neither runtime is on');
        } finally {
            settings.set({ providers: ['claude-code', 'codex'] });
        }
    });

    await check('only a named model is kept, and both picks survive a restart', () => {
        forget();
        assert.strictEqual(startModel.remember({ provider: 'claude-code', model: '' }), false);
        assert.strictEqual(startModel.get().last, null);
        startModel.remember({ provider: 'claude-code', model: 'opus', effort: 'max' });
        startModel.star({ provider: 'codex', model: 'gpt-5.5' });
        startModel._test.reset();
        assert.deepStrictEqual(startModel.get(), {
            starred: { provider: 'codex', model: 'gpt-5.5' },
            last: { provider: 'claude-code', model: 'opus', effort: 'max' },
        });
    });

    await check('every change is announced, and a repeat is not', () => {
        forget();
        const heard = [];
        startModel.onChange(held => heard.push(held));
        startModel.remember({ provider: 'claude-code', model: 'opus' });
        startModel.remember({ provider: 'claude-code', model: 'opus' });
        startModel.star({ provider: 'claude-code', model: 'opus' });
        assert.strictEqual(heard.length, 2);
        assert.strictEqual(heard[1].starred.model, 'opus');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    for (const folder of [userData, machineClaude]) {
        try {
            fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
            // Left in the temp folder.
        }
    }
    process.exit(failed > 0 ? 1 : 0);
})();
