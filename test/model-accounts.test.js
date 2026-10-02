/**
 * One runtime offered in the model menu under more than one sign-in.
 *
 * Ticking a second Claude Code account for the menu lists every model once
 * per account, and picking a row pins the conversation to that account as
 * well as the model. Checked here: the setting, the pin as the main process
 * keeps and resolves it, the agent's own account moving without dragging a
 * pinned conversation along, what is carried to the other account, and the
 * menu's rows as the renderer builds them.
 *
 * `electron` is stubbed so it runs under plain node, and the renderer's
 * modules are ESM written for the bundler, so they are imported with a
 * resolve hook that adds the extensions the bundler would.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-model-accounts-'));
const machineClaude = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-model-accounts-claude-'));
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

// `../i18n` the way the bundler reads it, as `../i18n/index.js`.
Module.registerHooks({
    resolve(specifier, context, nextResolve) {
        try {
            return nextResolve(specifier, context);
        } catch (error) {
            if (!specifier.startsWith('.')) throw error;
            for (const suffix of ['.js', '/index.js']) {
                try {
                    return nextResolve(specifier + suffix, context);
                } catch {
                    // The next spelling.
                }
            }
            throw error;
        }
    },
});
const memoryStore = new Map();
globalThis.localStorage = {
    getItem: key => (memoryStore.has(key) ? memoryStore.get(key) : null),
    setItem: (key, value) => memoryStore.set(key, String(value)),
};
globalThis.document = { documentElement: {} };

const accounts = require(path.join(ROOT, 'ai', 'accounts'));
const settings = require(path.join(ROOT, 'ai', 'settings'));
const archive = require(path.join(ROOT, 'ai', 'archive'));
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

const work = accounts.add({ provider: 'claude-code', label: 'Work' }).account;
const play = accounts.add({ provider: 'claude-code', label: 'Play' }).account;

(async () => {
    const importRenderer = file => import(pathToFileURL(path.join(RENDERER, 'lib', file)).href);
    const catalog = await importRenderer('ai-catalog.js');
    const usage = await importRenderer('usage-limits.js');
    const lastModel = await importRenderer('last-model.js');

    console.log('\nthe setting');

    await check('the menu accounts are kept per runtime, deduplicated, and an empty list is dropped', () => {
        const clean = settings._test.sanitize({
            menuAccounts: { 'claude-code': [work.id, work.id, '', 7, play.id], bogus: ['x'], codex: [] },
        });
        assert.deepStrictEqual(clean.menuAccounts, { 'claude-code': [work.id, play.id] });
        assert.deepStrictEqual(settings._test.sanitize({ menuAccounts: ['nope'] }).menuAccounts, {});
    });

    await check('one runtime\'s list lands over the others, and is per agent', () => {
        settings.set({ menuAccounts: { 'claude-code': [work.id] } });
        const after = settings.set({ menuAccounts: { codex: ['acct-codex'] } });
        assert.deepStrictEqual(after.menuAccounts, { 'claude-code': [work.id], codex: ['acct-codex'] });
        const cleared = settings.set({ menuAccounts: { codex: [] } });
        assert.deepStrictEqual(cleared.menuAccounts, { 'claude-code': [work.id] });
        const stored = JSON.parse(fs.readFileSync(path.join(userData, 'agents.json'), 'utf8'));
        const agent = (stored.agents || []).find(entry => entry.settings?.menuAccounts);
        assert.ok(agent, 'kept with the agent, beside the account in use');
    });

    console.log('\nthe pin');

    const { conversationId } = assistant.create({ scope: 'global' });
    const conversation = assistant._test.conversation(conversationId);

    await check('picking a row from another account pins the conversation to it', () => {
        const { pinned } = assistant.setConversationModel(conversationId, {
            provider: 'claude-code', model: 'opus', effort: 'high', account: work.id,
        });
        assert.deepStrictEqual(pinned, { provider: 'claude-code', model: 'opus', effort: 'high', account: work.id });
        const effective = assistant.effectiveSettings(conversation);
        assert.strictEqual(effective.accountId, work.id);
        assert.deepStrictEqual(effective.accountEnv, { CLAUDE_CONFIG_DIR: work.home });
    });

    await check('an effort change keeps the account', () => {
        const { pinned } = assistant.setConversationModel(conversationId, { effort: 'low' });
        assert.strictEqual(pinned.account, work.id);
    });

    await check('moving to another account of the same runtime restarts its query', () => {
        settings.set({ menuAccounts: { 'claude-code': [work.id, play.id] } });
        conversation.session = { setModel: () => {}, setEffort: () => {}, close: async () => {} };
        conversation.needsRestart = false;
        assistant.setConversationModel(conversationId, { provider: 'claude-code', model: 'opus', account: play.id });
        assert.strictEqual(conversation.needsRestart, true, 'the account is fixed in the process environment');
        conversation.session = null;
        conversation.needsRestart = false;
    });

    await check('an empty account goes back to the agent\'s own choice', () => {
        const { pinned } = assistant.setConversationModel(conversationId, { provider: 'claude-code', model: 'opus', account: '' });
        assert.strictEqual(pinned.account, undefined);
        assert.strictEqual(assistant.effectiveSettings(conversation).accountId, accounts.DEFAULT_ID);
    });

    await check('a change of runtime that names no account drops it', () => {
        assistant.setConversationModel(conversationId, { provider: 'claude-code', model: 'opus', account: work.id });
        const { pinned } = assistant.setConversationModel(conversationId, { provider: 'codex', model: 'gpt-5' });
        assert.strictEqual(pinned.account, undefined, 'an account belongs to its runtime');
    });

    await check('an account removed since falls back to the agent\'s own, not the machine\'s', () => {
        settings.set({ accounts: { 'claude-code': play.id } });
        conversation.settingsPatch = { provider: 'claude-code', model: 'opus', account: 'acct-gone' };
        assert.strictEqual(assistant.effectiveSettings(conversation).accountId, play.id);
        settings.set({ accounts: { 'claude-code': 'default' } });
    });

    await check('the agent\'s account moving leaves a conversation pinned to its own alone', () => {
        const other = assistant.create({ scope: 'global' }).conversationId;
        const following = assistant._test.conversation(other);
        conversation.settingsPatch = { provider: 'claude-code', model: 'opus', account: work.id };
        for (const entry of [conversation, following]) {
            entry.provider = 'claude-code';
            entry.session = { setModel: () => {}, setEffort: () => {}, close: async () => {} };
            entry.needsRestart = false;
        }
        const before = settings.get();
        const after = settings.set({ accounts: { 'claude-code': play.id } });
        assistant.reconfigure(before, after, after.agentId);
        assert.strictEqual(following.needsRestart, true, 'one following the agent moves with it');
        assert.strictEqual(conversation.needsRestart, false, 'one pinned to an account stays on it');
        for (const entry of [conversation, following]) entry.session = null;
        settings.set({ accounts: { 'claude-code': 'default' } });
    });

    await check('unticking a conversation\'s account puts it back on the agent\'s, and restarts it', () => {
        settings.set({ menuAccounts: { 'claude-code': [work.id, play.id] } });
        conversation.settingsPatch = { provider: 'claude-code', model: 'opus', account: work.id };
        conversation.provider = 'claude-code';
        conversation.session = { setModel: () => {}, setEffort: () => {}, close: async () => {} };
        conversation.needsRestart = false;
        assert.strictEqual(assistant.effectiveSettings(conversation).accountId, work.id);
        const before = settings.get();
        const after = settings.set({ menuAccounts: { 'claude-code': [play.id] } });
        assistant.reconfigure(before, after, after.agentId);
        assert.strictEqual(assistant.effectiveSettings(conversation).accountId, accounts.DEFAULT_ID, 'an unticked account is not used');
        assert.strictEqual(conversation.needsRestart, true);
        conversation.session = null;
        conversation.needsRestart = false;
    });

    await check('the pin survives the archive, account and all', () => {
        conversation.settingsPatch = { provider: 'claude-code', model: 'opus', account: work.id };
        const record = archive.pack(conversation);
        const back = archive.unpack(JSON.parse(JSON.stringify(record)), 'claude-code');
        assert.deepStrictEqual(back.settingsPatch, { provider: 'claude-code', model: 'opus', account: work.id });
    });

    await check('what was said before the latest message is what goes to the other account', () => {
        const id = assistant.create({ scope: 'global' }).conversationId;
        const emit = event => assistant._test.emit(id, event);
        emit({ type: 'user-message', text: 'Check the disks' });
        emit({ type: 'tool-call', id: 'c1', name: 'run_command', input: { command: 'df -h' } });
        emit({ type: 'tool-result', id: 'c1', text: '/dev/sda1 40%' });
        emit({ type: 'assistant-text', text: 'Disks are at 40%.' });
        emit({ type: 'result', costUsd: 0 });
        emit({ type: 'user-message', text: 'And memory?' });
        const said = assistant._test.saidBefore(id);
        assert.match(said, /Check the disks/);
        assert.match(said, /Disks are at 40%/);
        assert.doesNotMatch(said, /And memory/, 'the latest message goes on its own');
        assert.doesNotMatch(said, /df -h/, 'messages only');
    });

    console.log('\nthe menu');

    const catalogs = { 'claude-code': [{ value: 'opus', label: 'Opus 5.5' }, { value: 'sonnet', label: 'Sonnet 5' }] };
    const overview = {
        accounts: { 'claude-code': accounts.list('claude-code') },
        limits: { [`claude-code:${work.id}`]: { identity: { signedIn: true, email: 'me@work.example' } } },
    };
    const t = key => ({ 'statusBar.machine': 'This computer', 'settings.accounts.machineLogin': 'This computer’s login' }[key] || key);

    await check('with one account in the menu it is the menu it always was', () => {
        const agent = { provider: 'claude-code', providers: ['claude-code'], accounts: {}, menuAccounts: {} };
        assert.deepStrictEqual(usage.offeredAccounts(overview, agent, 'claude-code'), []);
        const rows = catalog.mergedModelRows(catalogs, ['claude-code'], agent);
        assert.deepStrictEqual(rows.map(row => row.key), ['claude-code:opus', 'claude-code:sonnet']);
        assert.ok(rows.every(row => row.account === undefined));
    });

    await check('two accounts ticked give two of each model, one per account', () => {
        const agent = { provider: 'claude-code', model: 'opus', providers: ['claude-code'], accounts: {}, menuAccounts: { 'claude-code': [work.id] } };
        const offered = usage.offeredAccounts(overview, agent, 'claude-code');
        assert.deepStrictEqual(offered.map(account => account.id), ['default', work.id], 'the one in use, and the one ticked');
        const names = offered.map(account => usage.accountName(account, overview.limits[`claude-code:${account.id}`], t));
        assert.deepStrictEqual(names.map(name => name.full), ['This computer’s login', 'Work · me@work.example']);
        const shape = {
            'claude-code': {
                current: usage.answeringAccount(overview, agent, 'claude-code').id,
                accounts: offered.map((account, index) => ({ id: account.id, name: names[index].full, short: names[index].short })),
            },
        };
        const rows = catalog.mergedModelRows(catalogs, ['claude-code'], agent, shape);
        assert.deepStrictEqual(rows.map(row => row.key), [
            'claude-code@default:opus', 'claude-code@default:sonnet',
            `claude-code@${work.id}:opus`, `claude-code@${work.id}:sonnet`,
        ]);
        assert.strictEqual(rows.filter(row => row.label === 'Opus 5.5').length, 2, 'Opus once per account');
        assert.strictEqual(catalog.currentModelRow(rows, agent, shape).key, 'claude-code@default:opus', 'ticked under the account answering');

        // The same conversation pinned to the work account ticks the work row.
        const pinned = { ...agent, account: work.id };
        const moved = { 'claude-code': { ...shape['claude-code'], current: usage.answeringAccount(overview, pinned, 'claude-code').id } };
        const again = catalog.mergedModelRows(catalogs, ['claude-code'], pinned, moved);
        assert.strictEqual(catalog.currentModelRow(again, pinned, moved).key, `claude-code@${work.id}:opus`);
        assert.strictEqual(catalog.currentModelRow(again, pinned, moved).accountShort, 'Work');
    });

    await check('only the ticked accounts are in the menu, whatever a conversation was pinned to', () => {
        const agent = { provider: 'claude-code', account: play.id, accounts: {}, menuAccounts: {} };
        assert.deepStrictEqual(usage.offeredAccounts(overview, agent, 'claude-code'), [], 'one ticked is the plain menu');
        assert.strictEqual(usage.answeringAccount(overview, agent, 'claude-code').id, 'default', 'an unticked pin is not used');
    });

    await check('one click on a box: tick adds, untick removes, the last one stays', () => {
        const one = { accounts: {}, menuAccounts: {} };
        // Tick the second: both in use.
        assert.deepStrictEqual(usage.toggleAccountPatch(overview, one, 'claude-code', work.id), { menuAccounts: { 'claude-code': [work.id] } });
        // The only one ticked cannot be cleared.
        assert.strictEqual(usage.toggleAccountPatch(overview, one, 'claude-code', 'default'), null);
        const both = { accounts: {}, menuAccounts: { 'claude-code': [work.id] } };
        assert.deepStrictEqual(usage.tickedAccounts(overview, both, 'claude-code').map(account => account.id), ['default', work.id]);
        // Untick the other: back to one.
        assert.deepStrictEqual(usage.toggleAccountPatch(overview, both, 'claude-code', work.id), { menuAccounts: { 'claude-code': [] } });
        // Untick the one in use: the next ticked one takes over.
        assert.deepStrictEqual(
            usage.toggleAccountPatch(overview, both, 'claude-code', 'default'),
            { accounts: { 'claude-code': work.id }, menuAccounts: { 'claude-code': [] } },
        );
        // And that lands as only the work account ticked, in main as here.
        settings.set({ accounts: { 'claude-code': 'default' }, menuAccounts: { 'claude-code': [work.id] } });
        const landed = settings.set(usage.toggleAccountPatch(overview, both, 'claude-code', 'default'));
        assert.strictEqual(landed.accounts['claude-code'], work.id);
        assert.deepStrictEqual(usage.tickedAccounts(overview, landed, 'claude-code').map(account => account.id), [work.id]);
    });

    await check('a new conversation starts on the last account only while it is still offered', () => {
        const agent = { provider: 'claude-code', model: '', providers: ['claude-code'], accounts: {}, menuAccounts: { 'claude-code': [work.id] } };
        lastModel.rememberModel('agent-1', agent, { provider: 'claude-code', model: 'opus', account: work.id });
        assert.strictEqual(lastModel.lastModel('agent-1', agent).account, work.id);
        const untick = { ...agent, menuAccounts: {} };
        assert.deepStrictEqual(lastModel.lastModel('agent-1', untick), { provider: 'claude-code', model: 'opus' });
        lastModel.rememberModel('agent-1', agent, { provider: 'claude-code', model: 'opus', account: 'default' });
        assert.strictEqual(lastModel.lastModel('agent-1', untick).account, 'default', 'the machine\'s own is in use when none is chosen');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    // Best effort: on Windows the archive can still be holding the folder.
    for (const folder of [userData, machineClaude]) {
        try {
            fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
            // Left in the temp folder.
        }
    }
    process.exit(failed > 0 ? 1 : 0);
})();
