/**
 * What a turn did to files, and taking it back.
 *
 * Real files in a temporary folder, because the point is what ends up on
 * disk: a file put back, a file the turn created gone again, and a file
 * that has moved on since left alone.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const checkpoints = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'checkpoints'));

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-checkpoints-'));
const store = path.join(root, 'store');
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
checkpoints.setDirectory(store);

const file = name => path.join(work, name);
const read = name => fs.readFileSync(file(name), 'utf8');
const write = (name, text) => fs.writeFileSync(file(name), text, 'utf8');
const local = name => ({ where: 'local', path: file(name) });

/** One of our own tools, recording on either side of its write. */
function ourWrite(conversation, name, text) {
    checkpoints.before(conversation, local(name), checkpoints.readLocal(file(name)));
    write(name, text);
    checkpoints.after(conversation, local(name), checkpoints.readLocal(file(name)));
}

(async () => {
    console.log('checkpoints');

    await check('a turn that edits a file is summed up, and undo puts it back', async () => {
        write('a.conf', 'one\ntwo\nthree\n');
        checkpoints.begin('c1', 100);
        ourWrite('c1', 'a.conf', 'one\nTWO\nthree\nfour\n');
        const summary = checkpoints.finish('c1');
        assert.strictEqual(summary.turnId, 100);
        assert.strictEqual(summary.files.length, 1);
        assert.strictEqual(summary.files[0].added, 2);
        assert.strictEqual(summary.files[0].removed, 1);
        // The contents stay in the main process; the card gets the counts.
        assert.strictEqual(summary.files[0].before, undefined);

        const result = await checkpoints.revert('c1', 100);
        assert.deepStrictEqual(result.failed, []);
        assert.strictEqual(read('a.conf'), 'one\ntwo\nthree\n');
    });

    await check('a turn that changed nothing has no card', async () => {
        write('b.conf', 'same\n');
        checkpoints.begin('c2', 200);
        ourWrite('c2', 'b.conf', 'same\n');
        assert.strictEqual(checkpoints.finish('c2'), null);
    });

    await check('a file the turn created is removed by undo', async () => {
        checkpoints.begin('c3', 300);
        ourWrite('c3', 'new.txt', 'hello\n');
        const summary = checkpoints.finish('c3');
        assert.strictEqual(summary.files[0].created, true);
        await checkpoints.revert('c3', 300);
        assert.strictEqual(fs.existsSync(file('new.txt')), false);
    });

    await check('the first reading before and the last after are the ones kept', async () => {
        write('c.conf', 'v1\n');
        checkpoints.begin('c4', 400);
        ourWrite('c4', 'c.conf', 'v2\n');
        ourWrite('c4', 'c.conf', 'v3\n');
        checkpoints.finish('c4');
        await checkpoints.revert('c4', 400);
        assert.strictEqual(read('c.conf'), 'v1\n');
    });

    await check("a runtime's own edit is read when announced and when answered", async () => {
        write('d.js', 'const a = 1;\nconst b = 2;\n');
        checkpoints.begin('c5', 500);
        const call = {
            id: 'toolu_1',
            name: 'Edit',
            local: true,
            input: { file_path: file('d.js'), old_string: 'const b = 2;', new_string: 'const b = 3;' },
        };
        checkpoints.callStarted('c5', call);
        write('d.js', 'const a = 1;\nconst b = 3;\n');
        checkpoints.callFinished('c5', { id: 'toolu_1', isError: false });
        const summary = checkpoints.finish('c5');
        assert.strictEqual(summary.files.length, 1);
        await checkpoints.revert('c5', 500);
        assert.strictEqual(read('d.js'), 'const a = 1;\nconst b = 2;\n');
    });

    await check('an edit read too late is undone by putting its passage back', async () => {
        // The runtime ran the edit before the app saw the call: both readings
        // are of the edited file, and only the passage says what changed.
        write('e.js', 'let x = "new";\n');
        checkpoints.begin('c6', 600);
        checkpoints.callStarted('c6', {
            id: 'call_1',
            name: 'edit',
            local: true,
            input: { filePath: file('e.js'), oldString: 'let x = "old";', newString: 'let x = "new";' },
        });
        checkpoints.callFinished('c6', { id: 'call_1', isError: false });
        const summary = checkpoints.finish('c6');
        assert.strictEqual(summary.files.length, 1);
        assert.strictEqual(summary.files[0].added, 1);
        await checkpoints.revert('c6', 600);
        assert.strictEqual(read('e.js'), 'let x = "old";\n');
    });

    await check('a refused edit changes nothing and leaves no card', async () => {
        write('f.js', 'untouched\n');
        checkpoints.begin('c7', 700);
        checkpoints.callStarted('c7', {
            id: 'call_2',
            name: 'Edit',
            local: true,
            input: { file_path: file('f.js'), old_string: 'untouched', new_string: 'touched' },
        });
        checkpoints.callFinished('c7', { id: 'call_2', isError: true });
        assert.strictEqual(checkpoints.finish('c7'), null);
    });

    await check('a file that moved on since is left alone, and the others still go back', async () => {
        write('g1.txt', 'g1 before\n');
        write('g2.txt', 'g2 before\n');
        checkpoints.begin('c8', 800);
        ourWrite('c8', 'g1.txt', 'g1 after\n');
        ourWrite('c8', 'g2.txt', 'g2 after\n');
        checkpoints.finish('c8');
        write('g2.txt', 'someone else wrote this\n');

        const result = await checkpoints.revert('c8', 800);
        assert.deepStrictEqual(result.reverted, [file('g1.txt')]);
        assert.strictEqual(result.failed.length, 1);
        assert.strictEqual(result.failed[0].path, file('g2.txt'));
        assert.strictEqual(read('g1.txt'), 'g1 before\n');
        assert.strictEqual(read('g2.txt'), 'someone else wrote this\n');
    });

    await check('a passage still there is put back even when the file moved on', async () => {
        write('h.conf', 'port 80\nhost a\n');
        checkpoints.begin('c9', 900);
        checkpoints.before('c9', local('h.conf'), checkpoints.readLocal(file('h.conf')));
        write('h.conf', 'port 8080\nhost a\n');
        checkpoints.after('c9', local('h.conf'), checkpoints.readLocal(file('h.conf')));
        checkpoints.passage('c9', local('h.conf'), { old: 'port 80', new: 'port 8080' });
        checkpoints.finish('c9');
        write('h.conf', 'port 8080\nhost b\n');

        const result = await checkpoints.revert('c9', 900);
        assert.deepStrictEqual(result.failed, []);
        assert.strictEqual(read('h.conf'), 'port 80\nhost b\n');
    });

    await check('undo is kept on disk, and asking twice does nothing twice', async () => {
        write('i.txt', 'i before\n');
        checkpoints.begin('c10', 1000);
        ourWrite('c10', 'i.txt', 'i after\n');
        checkpoints.finish('c10');

        // A fresh start of the app: nothing in memory.
        checkpoints.setDirectory(store);
        const changes = checkpoints.changes('c10', 1000);
        assert.strictEqual(changes.found, true);
        assert.strictEqual(changes.files[0].diff.added, 1);

        await checkpoints.revert('c10', 1000);
        assert.strictEqual(read('i.txt'), 'i before\n');
        write('i.txt', 'written again\n');
        const again = await checkpoints.revert('c10', 1000);
        assert.strictEqual(again.already, true);
        assert.strictEqual(read('i.txt'), 'written again\n');
    });

    await check('a server file goes back over its own channel', async () => {
        const remote = { '/etc/app.conf': { existed: true, content: 'remote after\n' } };
        const io = () => ({
            read: async entry => remote[entry.path],
            write: async (entry, content) => { remote[entry.path] = { existed: true, content }; },
            remove: async (entry) => { remote[entry.path] = { existed: false, content: '' }; },
        });
        const server = { where: 'remote', sessionId: 's1', path: '/etc/app.conf', host: 'web-01' };
        checkpoints.begin('c11', 1100);
        checkpoints.before('c11', server, { existed: true, content: 'remote before\n' });
        checkpoints.after('c11', server, { existed: true, content: 'remote after\n' });
        const summary = checkpoints.finish('c11');
        assert.strictEqual(summary.files[0].host, 'web-01');
        const result = await checkpoints.revert('c11', 1100, { remote: io });
        assert.deepStrictEqual(result.failed, []);
        assert.strictEqual(remote['/etc/app.conf'].content, 'remote before\n');
    });

    await check('forgetting a conversation drops its snapshots', async () => {
        checkpoints.forget('c10');
        assert.strictEqual(checkpoints.changes('c10', 1000).found, false);
    });

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
