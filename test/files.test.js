/**
 * The agent's files: the store (who sees which file, names, renames,
 * replacing, deleting, an agent's files passing on) and the tools over it
 * (save from text and from a granted folder, read text, pictures and
 * binaries, send to a folder and to another agent, {{file:name}} in a local
 * command).
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-files-'));
const granted = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-files-grant-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-files-outside-'));

const electronStub = {
    app: {
        getPath: () => userData,
        getVersion: () => '1.0.0',
        on: () => {},
        whenReady: () => new Promise(() => {}),
    },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
    ipcMain: { handle: () => {}, on: () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const tools = require(path.join(ROOT, 'ai', 'tools'));
const files = require(path.join(ROOT, 'ai', 'files'));
const fileTools = require(path.join(ROOT, 'ai', 'file-tools'));
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
        console.log(`       ${error.stack || error.message}`);
        failed++;
    }
};

const call = (name, input, ctx) => tools.BY_NAME.get(name).handler(input, ctx);
const parse = (result) => JSON.parse(result.text);

// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
    console.log('\nfiles');

    const mine = agents.save({ name: 'Mine' }).saved;
    const theirs = agents.save({ name: 'Theirs' }).saved;

    const changes = [];
    const ctx = (agentId, extra = {}) => ({
        agentId,
        scope: 'all',
        sessionIds: [],
        hostIds: [],
        settings: {},
        sandbox: { execution: 'host', folders: [{ path: granted, mode: 'write' }] },
        inventoryChanged: (kind) => changes.push(kind),
        ...extra,
    });

    await check('the file tools are in the catalog, and only looking and adding go without asking', () => {
        for (const name of ['list_files', 'read_inventory_file']) {
            assert.strictEqual(tools.BY_NAME.get(name).readOnly, true, name);
            assert.strictEqual(tools.changesNothing(name), true, name);
        }
        const save = tools.BY_NAME.get('save_inventory_file');
        assert.strictEqual(save.readOnly, true);
        assert.strictEqual(tools.changesNothing('save_inventory_file'), false);
        for (const name of ['update_inventory_file', 'send_inventory_file', 'delete_inventory_file']) {
            assert.strictEqual(tools.BY_NAME.get(name).readOnly, false, name);
        }
    });

    await check('a file saved from text is the saving agent\'s and nobody else\'s', async () => {
        const result = await call('save_inventory_file', {
            name: 'notes.txt',
            content: 'one\ntwo\nthree\nfour',
            description: 'Some notes',
            tags: ['#ops'],
        }, ctx(mine));
        assert.ok(!result.isError, result.text);
        const saved = parse(result);
        assert.strictEqual(saved.name, 'notes.txt');
        assert.strictEqual(saved.mime, 'text/plain');
        assert.deepStrictEqual(saved.tags, ['ops']);
        assert.strictEqual(saved.reference, '{{file:notes.txt}}');
        assert.ok(changes.includes('files'));

        assert.strictEqual(parse(await call('list_files', {}, ctx(mine))).total, 1);
        assert.strictEqual(parse(await call('list_files', {}, ctx(theirs))).total, 0);
    });

    await check('a name already taken is refused, ignoring case', async () => {
        const result = await call('save_inventory_file', { name: 'NOTES.txt', content: 'x' }, ctx(mine));
        assert.ok(result.isError);
        assert.match(result.text, /already a file/);
    });

    await check('names a disk cannot hold are refused', () => {
        for (const bad of ['', 'a/b', 'a\\b', 'what?', 'con', 'NUL.txt', '..', 'x'.repeat(121)]) {
            assert.ok(files.cleanName(bad).error, bad);
        }
        assert.strictEqual(files.cleanName('  report final.pdf  ').name, 'report final.pdf');
        assert.strictEqual(files.cleanName('trailing. ').name, 'trailing');
    });

    await check('a shared file is everyone\'s, and an agent\'s own of the same name hides it', async () => {
        const shared = await files.add({ name: 'readme.md', data: Buffer.from('# shared') }, '');
        assert.ok(shared.file, shared.error);
        assert.ok(parse(await call('list_files', {}, ctx(theirs))).files.some(file => file.name === 'readme.md' && file.shared));

        await files.add({ name: 'README.md', data: Buffer.from('# mine') }, mine);
        const read = parse(await call('read_inventory_file', { file: 'readme.md' }, ctx(mine)));
        assert.strictEqual(read.content, '# mine');
        const theirsRead = parse(await call('read_inventory_file', { file: 'readme.md' }, ctx(theirs)));
        assert.strictEqual(theirsRead.content, '# shared');
    });

    await check('text is read by line when asked', async () => {
        const read = parse(await call('read_inventory_file', { file: 'notes.txt', offset: 2, limit: 2 }, ctx(mine)));
        assert.strictEqual(read.content, 'two\nthree');
        assert.strictEqual(read.lines, '2-3 of 4');
    });

    await check('a picture comes back as a picture, and a binary as its details', async () => {
        await call('save_inventory_file', { name: 'dot.png', base64: PNG.toString('base64') }, ctx(mine));
        const picture = await call('read_inventory_file', { file: 'dot.png' }, ctx(mine));
        assert.strictEqual(picture.images.length, 1);
        assert.strictEqual(picture.images[0].mediaType, 'image/png');
        assert.strictEqual(Buffer.from(picture.images[0].data, 'base64').equals(PNG), true);

        await files.add({ name: 'blob.bin', data: Buffer.from([0, 1, 2, 0, 255]) }, mine);
        const binary = parse(await call('read_inventory_file', { file: 'blob.bin' }, ctx(mine)));
        assert.match(binary.note, /binary/);
        const raw = parse(await call('read_inventory_file', { file: 'blob.bin', encoding: 'base64' }, ctx(mine)));
        assert.deepStrictEqual([...Buffer.from(raw.base64, 'base64')], [0, 1, 2, 0, 255]);
    });

    await check('a file is copied in from a granted folder and refused from anywhere else', async () => {
        fs.writeFileSync(path.join(granted, 'app.conf'), 'listen 80;');
        fs.writeFileSync(path.join(outside, 'secret.conf'), 'nope');
        const kept = await call('save_inventory_file', { localPath: path.join(granted, 'app.conf') }, ctx(mine));
        assert.ok(!kept.isError, kept.text);
        assert.strictEqual(parse(kept).name, 'app.conf');
        assert.strictEqual(parse(kept).source, path.join(granted, 'app.conf'));

        const refused = await call('save_inventory_file', { localPath: path.join(outside, 'secret.conf') }, ctx(mine));
        assert.ok(refused.isError);
        assert.match(refused.text, /outside the folders/);
    });

    await check('one source at a time', async () => {
        const result = await call('save_inventory_file', { name: 'x.txt', content: 'a', base64: 'YQ==' }, ctx(mine));
        assert.ok(result.isError);
        assert.match(result.text, /one source/);
    });

    await check('sent to a granted folder, without replacing what is there unless told to', async () => {
        const into = await call('send_inventory_file', { file: 'notes.txt', to: 'local', path: `${granted}${path.sep}` }, ctx(mine));
        assert.ok(!into.isError, into.text);
        assert.strictEqual(fs.readFileSync(path.join(granted, 'notes.txt'), 'utf8'), 'one\ntwo\nthree\nfour');

        const again = await call('send_inventory_file', { file: 'notes.txt', to: 'local', path: granted }, ctx(mine));
        assert.ok(again.isError);
        assert.match(again.text, /already exists/);

        const replaced = await call('send_inventory_file', { file: 'notes.txt', to: 'local', path: granted, overwrite: true }, ctx(mine));
        assert.ok(!replaced.isError, replaced.text);

        const away = await call('send_inventory_file', { file: 'notes.txt', to: 'local', path: path.join(outside, 'n.txt') }, ctx(mine));
        assert.ok(away.isError);
    });

    await check('sent to another agent, by name, as a copy of its own', async () => {
        const sent = await call('send_inventory_file', { file: 'notes.txt', to: 'agent', agent: 'theirs' }, ctx(mine));
        assert.ok(!sent.isError, sent.text);
        assert.strictEqual(parse(sent).to, 'Theirs');
        const theirList = parse(await call('list_files', {}, ctx(theirs))).files;
        const copy = theirList.find(file => file.name === 'notes.txt');
        assert.ok(copy && !copy.shared);
        assert.ok(parse(await call('list_files', {}, ctx(mine))).files.some(file => file.name === 'notes.txt'));

        const nobody = await call('send_inventory_file', { file: 'notes.txt', to: 'agent', agent: 'Nobody' }, ctx(mine));
        assert.ok(nobody.isError);
    });

    await check('renamed and replaced, keeping its id', async () => {
        const before = files.get('app.conf', mine);
        const result = await call('update_inventory_file', {
            file: 'app.conf',
            name: 'nginx.conf',
            content: 'listen 443 ssl;',
            description: 'The edge config',
        }, ctx(mine));
        assert.ok(!result.isError, result.text);
        const after = parse(result);
        assert.strictEqual(after.id, before.id);
        assert.strictEqual(after.name, 'nginx.conf');
        assert.strictEqual(after.contentsReplaced, true);
        assert.strictEqual(parse(await call('read_inventory_file', { file: 'nginx.conf' }, ctx(mine))).content, 'listen 443 ssl;');
        assert.ok(fs.existsSync(files.pathOf('nginx.conf', mine)));
        assert.strictEqual(path.basename(files.pathOf('nginx.conf', mine)), 'nginx.conf');
    });

    await check('a shared file is the user\'s to change; the agent may only copy it', async () => {
        const changeIt = await call('update_inventory_file', { file: 'readme.md', name: 'x.md' }, ctx(theirs));
        assert.ok(changeIt.isError);
        assert.match(changeIt.text, /shared file/);
        const deleteIt = await call('delete_inventory_file', { file: 'readme.md' }, ctx(theirs));
        assert.ok(deleteIt.isError);

        const own = await call('send_inventory_file', { file: 'readme.md', to: 'agent', agent: 'Theirs', name: 'my-readme.md' }, ctx(theirs));
        assert.ok(!own.isError, own.text);
        assert.ok(files.list(theirs).some(file => file.name === 'my-readme.md' && !file.shared));

        const shared = files.list(theirs).find(file => file.name === 'readme.md');
        const asUser = await files.update(shared.id, theirs, { description: 'From the page' }, { asUser: true });
        assert.ok(!asUser.error, asUser.error);
    });

    await check('the page can share a file and take it back', async () => {
        const file = files.get('dot.png', mine);
        const sharedNow = await files.update(file.id, mine, { shared: true }, { asUser: true });
        assert.strictEqual(sharedNow.file.shared, true);
        assert.ok(files.list(theirs).some(entry => entry.id === file.id));
        const back = await files.update(file.id, mine, { shared: false }, { asUser: true });
        assert.strictEqual(back.file.shared, false);
        assert.ok(!files.list(theirs).some(entry => entry.id === file.id));
    });

    await check('{{file:name}} in a local command is the file\'s path', () => {
        const resolved = fileTools.resolveLocal(ctx(mine), 'type {{file:notes.txt}}', { CONF: '{{ file:nginx.conf }}' });
        assert.ok(!resolved.error, resolved.error);
        assert.strictEqual(resolved.command, `type ${files.pathOf('notes.txt', mine)}`);
        assert.strictEqual(resolved.env.CONF, files.pathOf('nginx.conf', mine));

        assert.match(fileTools.resolveLocal(ctx(mine), 'cat {{file:missing.txt}}').error, /no file "missing.txt"/);
        assert.match(fileTools.resolveLocal(ctx(mine, { sandbox: { execution: 'container', folders: [] } }), 'cat {{file:notes.txt}}').error, /container/);
        const untouched = fileTools.resolveLocal(ctx(mine), 'echo hi', null);
        assert.strictEqual(untouched.command, 'echo hi');
    });

    await check('deleted for good', async () => {
        const where = files.pathOf('blob.bin', mine);
        const result = await call('delete_inventory_file', { file: 'blob.bin' }, ctx(mine));
        assert.ok(!result.isError, result.text);
        assert.strictEqual(fs.existsSync(where), false);
        assert.strictEqual(files.get('blob.bin', mine), null);
    });

    await check('an agent\'s files pass to another when it goes, renamed where names meet', () => {
        const moved = files.moveAll(mine, theirs);
        assert.ok(moved > 0);
        const names = files.list(theirs).map(file => file.name);
        assert.ok(names.includes('notes.txt'));
        assert.ok(names.includes('notes (2).txt'));
        assert.strictEqual(files.list(mine).filter(file => !file.shared).length, 0);
        for (const file of files.list(theirs)) assert.ok(fs.existsSync(files.pathOf(file.id, theirs)), file.name);
    });

    await check('the index survives a reload', () => {
        const count = files.list().length;
        files._test.reset();
        assert.strictEqual(files.list().length, count);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
