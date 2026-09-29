/**
 * A turn's edits as the conversation sees them: summed up when it ends,
 * undone on request with the agent told, and carried into a branch.
 *
 * The events are played through the conversation's own `emit`, the road a
 * runtime's events take, so what is checked is the transcript a panel would
 * rebuild itself from. `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-turns-'));

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

const work = path.join(userData, 'project');
fs.mkdirSync(work, { recursive: true });
const target = path.join(work, 'server.conf');

(async () => {
    console.log('turn changes');

    const { conversationId } = assistant.create({});
    const emit = event => assistant._test.emit(conversationId, event);
    const events = () => assistant.history(conversationId).events;

    // One turn: the user asks, the runtime's own Edit tool changes a file,
    // the agent says so, the turn ends.
    fs.writeFileSync(target, 'listen 80\nroot /srv\n', 'utf8');
    emit({ type: 'user-message', text: 'Move it to 8080' });
    const turnId = events()[0].at;
    emit({
        type: 'tool-call',
        id: 'toolu_1',
        name: 'Edit',
        rawName: 'Edit',
        local: true,
        input: { file_path: target, old_string: 'listen 80', new_string: 'listen 8080' },
    });
    fs.writeFileSync(target, 'listen 8080\nroot /srv\n', 'utf8');
    emit({ type: 'tool-result', id: 'toolu_1', isError: false, text: 'ok' });
    emit({ type: 'assistant-text', text: 'Done: it listens on 8080 now.' });
    emit({ type: 'result', costUsd: 0 });

    await check('the turn ends with a card naming the file, just before the result', async () => {
        const types = events().map(event => event.type);
        const card = types.indexOf('turn-changes');
        assert.ok(card > 0, `no turn-changes in ${types.join(', ')}`);
        assert.strictEqual(types[card + 1], 'result');
        const summary = events()[card];
        assert.strictEqual(String(summary.turnId), String(turnId));
        assert.strictEqual(summary.files.length, 1);
        assert.strictEqual(summary.files[0].path, path.resolve(target));
        assert.strictEqual(summary.files[0].added, 1);
        assert.strictEqual(summary.files[0].removed, 1);
    });

    await check('a turn that edits nothing ends without a card', async () => {
        emit({ type: 'user-message', text: 'What port is it on?' });
        emit({ type: 'assistant-text', text: '8080.' });
        emit({ type: 'result', costUsd: 0 });
        assert.strictEqual(events().filter(event => event.type === 'turn-changes').length, 1);
    });

    await check('the review reads the change back as lines', async () => {
        const answer = assistant.turnChanges(conversationId, turnId);
        assert.strictEqual(answer.found, true);
        const lines = answer.files[0].diff.hunks.flatMap(hunk => hunk.lines.map(line => `${line.type[0]} ${line.text}`));
        assert.ok(lines.includes('r listen 80'));
        assert.ok(lines.includes('a listen 8080'));
    });

    let branchId = '';
    await check('a branch holds the conversation up to the end of that turn', async () => {
        const made = assistant.branch(conversationId, turnId);
        assert.strictEqual(made.success, true);
        branchId = made.conversationId;
        const copied = assistant.history(branchId).events;
        assert.deepStrictEqual(
            copied.filter(event => event.type === 'user-message').map(event => event.text),
            ['Move it to 8080'],
        );
        const card = copied.find(event => event.type === 'turn-changes');
        assert.strictEqual(card.from, conversationId, 'the copy of the card is marked as not its own');
    });

    await check('undo puts the file back and says so in the transcript', async () => {
        const result = await assistant.revertTurn(conversationId, turnId);
        assert.deepStrictEqual(result.failed, []);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'listen 80\nroot /srv\n');
        const reverted = events().find(event => event.type === 'turn-reverted');
        assert.ok(reverted);
        assert.deepStrictEqual(reverted.reverted, [path.resolve(target)]);
    });

    await check('undoing it again changes nothing and records nothing', async () => {
        fs.writeFileSync(target, 'listen 9090\n', 'utf8');
        const again = await assistant.revertTurn(conversationId, turnId);
        assert.strictEqual(again.already, true);
        assert.strictEqual(fs.readFileSync(target, 'utf8'), 'listen 9090\n');
        assert.strictEqual(events().filter(event => event.type === 'turn-reverted').length, 1);
    });

    await check('a streamed block is kept in the log as one fragment, not hundreds', async () => {
        const other = assistant.create({}).conversationId;
        const say = event => assistant._test.emit(other, event);
        say({ type: 'user-message', text: 'Go' });
        for (const word of ['Checking ', 'the ', 'logs.']) say({ type: 'text-delta', text: word });
        say({ type: 'tool-call', id: 'k1', name: 'list_hosts', local: false, input: {} });
        say({ type: 'text-delta', text: 'Found ' });
        say({ type: 'text-delta', text: 'it.' });
        const kept = assistant.history(other).events.filter(event => event.type === 'text-delta').map(event => event.text);
        assert.deepStrictEqual(kept, ['Checking the logs.', 'Found it.']);
        await assistant.close(other);
    });

    await check('closing a conversation throws its snapshots away', async () => {
        await assistant.close(conversationId);
        assert.strictEqual(assistant.turnChanges(conversationId, turnId).found, false);
        await assistant.close(branchId);
    });

    try {
        fs.rmSync(userData, { recursive: true, force: true });
    } catch {
        // The runs database can still have its file open on Windows.
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
