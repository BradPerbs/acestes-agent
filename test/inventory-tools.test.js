/**
 * The agent's kit: the tools that read and keep its own inventory.
 *
 * Two rules are exercised. An agent sees and edits what is in its own bag
 * (its records and the unassigned ones) and nothing that belongs to another
 * agent. And secrets flow one way: it can set a password or a key, but
 * nothing it reads back ever carries one.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-inventory-'));

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
const store = require(path.join(ROOT, 'store'));
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

const call = (name, input, ctx) => tools.BY_NAME.get(name).handler(input, ctx);
const parse = (result) => JSON.parse(result.text);

(async () => {
    console.log('\ninventory tools');

    // Two agents, so ownership has something to be tested against.
    const mine = agents.save({ name: 'Mine' }).saved;
    const theirs = agents.save({ name: 'Theirs' }).saved;

    const changes = [];
    const ctx = (agentId, extra = {}) => ({
        agentId,
        scope: 'all',
        sessionIds: [],
        hostIds: [],
        settings: {},
        inventoryChanged: (kind) => changes.push(kind),
        ...extra,
    });

    // Seed: a shared snippet, one of each agent's, and a host of each.
    store.saveSnippet({ id: 'snip-shared', name: 'uptime', command: 'uptime' });
    store.saveSnippet({ id: 'snip-mine', name: 'Deploy runbook', kind: 'spec', command: '# Deploy\n\n1. Pull.', agentId: mine, tags: ['deploy'] });
    store.saveSnippet({ id: 'snip-theirs', name: 'Their secret plan', kind: 'spec', command: 'x', agentId: theirs });
    store.saveHost({ id: 'host-mine', name: 'web-01', host: '10.0.0.1', port: 22, username: 'root', agentId: mine, password: 'hunter2' });
    store.saveHost({ id: 'host-theirs', name: 'db-01', host: '10.0.0.2', port: 22, agentId: theirs });
    store.saveKey({ id: 'key-1', name: 'work', type: 'ED25519', fingerprint: 'SHA256:abc', privateKey: 'PRIVATE', passphrase: 'pw' });
    store.saveProxy({ id: 'proxy-theirs', name: 'Their office', type: 'socks5', host: '10.9.9.9', port: 1080, agentId: theirs, password: 'secret' });

    await check('every inventory tool is in the catalog and says whether it reads', () => {
        for (const name of [
            'list_snippets', 'read_snippet', 'list_inventory',
            'save_snippet', 'save_host', 'save_proxy', 'save_key', 'save_mcp_server', 'save_folder', 'delete_inventory_item',
        ]) {
            const tool = tools.BY_NAME.get(name);
            assert.ok(tool, `${name} is in the catalog`);
            assert.strictEqual(typeof tool.readOnly, 'boolean');
        }
        for (const name of ['list_snippets', 'read_snippet', 'list_inventory']) {
            assert.strictEqual(tools.BY_NAME.get(name).readOnly, true, `${name} only reads`);
        }
    });

    await check('an agent lists its own snippets and the shared ones, not another agent\'s', async () => {
        const { snippets } = parse(await call('list_snippets', {}, ctx(mine)));
        const ids = snippets.map(entry => entry.id).sort();
        assert.deepStrictEqual(ids, ['snip-mine', 'snip-shared']);
    });

    await check('list_snippets filters by kind and by words', async () => {
        const specs = parse(await call('list_snippets', { kind: 'spec' }, ctx(mine))).snippets;
        assert.deepStrictEqual(specs.map(entry => entry.id), ['snip-mine']);
        const tagged = parse(await call('list_snippets', { query: 'deploy' }, ctx(mine))).snippets;
        assert.deepStrictEqual(tagged.map(entry => entry.id), ['snip-mine']);
    });

    await check('read_snippet hands back the text of its own and refuses another agent\'s', async () => {
        const own = parse(await call('read_snippet', { id: 'snip-mine' }, ctx(mine)));
        assert.strictEqual(own.text, '# Deploy\n\n1. Pull.');
        assert.strictEqual(own.kind, 'spec');
        const other = await call('read_snippet', { id: 'snip-theirs' }, ctx(mine));
        assert.strictEqual(other.isError, true);
    });

    await check('save_snippet creates a spec in the agent\'s own bag', async () => {
        const result = parse(await call('save_snippet', {
            name: 'Cert rotation', kind: 'spec', text: '1. certbot renew', tags: ['tls'],
        }, ctx(mine)));
        assert.strictEqual(result.saved, 'created');
        const record = store.getSnippets().find(entry => entry.id === result.id);
        assert.strictEqual(record.agentId, mine);
        assert.strictEqual(record.command, '1. certbot renew');
        assert.ok(changes.includes('snippets'), 'the windows were told');
    });

    await check('save_snippet updates its own and refuses another agent\'s', async () => {
        const updated = parse(await call('save_snippet', { id: 'snip-mine', text: '# Deploy\n\n1. Pull.\n2. Restart.' }, ctx(mine)));
        assert.strictEqual(updated.saved, 'updated');
        assert.strictEqual(store.getSnippets().find(entry => entry.id === 'snip-mine').command, '# Deploy\n\n1. Pull.\n2. Restart.');
        const refused = await call('save_snippet', { id: 'snip-theirs', text: 'mine now' }, ctx(mine));
        assert.strictEqual(refused.isError, true);
        assert.strictEqual(store.getSnippets().find(entry => entry.id === 'snip-theirs').command, 'x');
    });

    await check('save_snippet refuses an empty record', async () => {
        const result = await call('save_snippet', { name: 'Blank', kind: 'spec', text: '   ' }, ctx(mine));
        assert.strictEqual(result.isError, true);
    });

    await check('list_inventory shows keys without their material and proxies without passwords', async () => {
        const { keys } = parse(await call('list_inventory', { kind: 'keys' }, ctx(mine)));
        assert.strictEqual(keys.length, 1);
        assert.deepStrictEqual(Object.keys(keys[0]).sort(), ['comment', 'fingerprint', 'hasPassphrase', 'id', 'name', 'type']);
        const text = JSON.stringify(keys);
        assert.ok(!text.includes('PRIVATE') && !text.includes('pw'), 'no key material');

        const { proxies } = parse(await call('list_inventory', { kind: 'proxies' }, ctx(theirs)));
        assert.strictEqual(proxies.length, 1);
        assert.strictEqual(proxies[0].password, undefined);
        assert.strictEqual(proxies[0].hasPassword, true);

        const mineProxies = parse(await call('list_inventory', { kind: 'proxies' }, ctx(mine))).proxies;
        assert.strictEqual(mineProxies.length, 0, 'another agent\'s proxy is not listed');
    });

    await check('save_host creates a host in the agent\'s bag, on a keychain key', async () => {
        const result = parse(await call('save_host', {
            name: 'cache-01', address: '10.0.0.9', username: 'ops', tags: ['prod'], keychainKeyId: 'key-1',
        }, ctx(mine)));
        assert.strictEqual(result.saved, 'created');
        assert.strictEqual(result.host.authMethod, 'keychain', 'inferred from the key id');
        const raw = store.getHosts().find(host => host.id === result.host.id);
        assert.strictEqual(raw.agentId, mine);
        assert.strictEqual(raw.keychainKeyId, 'key-1');
        assert.strictEqual(raw.port, 22);
        assert.ok(changes.includes('hosts'));
    });

    await check('save_host stores a password the agent was given, and never shows it back', async () => {
        const result = await call('save_host', {
            name: 'legacy-01', address: '10.0.0.7', username: 'admin', password: 'hunter2',
        }, ctx(mine));
        const created = parse(result);
        assert.strictEqual(created.host.authMethod, 'password', 'inferred from the password');
        assert.ok(!result.text.includes('hunter2'), 'the reply carries no secret');
        const raw = store.getHosts().find(host => host.id === created.host.id);
        assert.strictEqual(raw.hasPassword, true);
        assert.strictEqual(raw.password, undefined, 'redacted on the way out');
        const dial = store.resolveCredentials(created.host.id);
        assert.strictEqual(dial.password, 'hunter2', 'and it is what the connection will use');
    });

    await check('save_host stores a private key and passphrase the agent was given', async () => {
        const created = parse(await call('save_host', {
            name: 'keyed-01', address: '10.0.0.8', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----', passphrase: 'pp',
        }, ctx(mine)));
        assert.strictEqual(created.host.authMethod, 'key');
        const raw = store.getHosts().find(host => host.id === created.host.id);
        assert.strictEqual(raw.hasPrivateKey, true);
        assert.strictEqual(raw.privateKey, undefined);
        const dial = store.resolveCredentials(created.host.id);
        assert.ok(dial.privateKey.includes('OPENSSH PRIVATE KEY'));
        assert.strictEqual(dial.passphrase, 'pp');
    });

    await check('save_host needs a name and an address to create', async () => {
        const result = await call('save_host', { name: 'nameless' }, ctx(mine));
        assert.strictEqual(result.isError, true);
    });

    await check('save_host refuses a key, proxy or jump host that is not in the inventory', async () => {
        assert.strictEqual((await call('save_host', { name: 'a', address: 'b', keychainKeyId: 'nope' }, ctx(mine))).isError, true);
        assert.strictEqual((await call('save_host', { name: 'a', address: 'b', proxyId: 'proxy-theirs' }, ctx(mine))).isError, true);
        assert.strictEqual((await call('save_host', { name: 'a', address: 'b', jumpHostId: 'host-theirs' }, ctx(mine))).isError, true);
    });

    await check('save_host updates its own host and keeps the password the user set', async () => {
        const result = parse(await call('save_host', { id: 'host-mine', tags: ['prod', 'web'], port: 2222 }, ctx(mine)));
        assert.strictEqual(result.saved, 'updated');
        const raw = store.getHosts().find(host => host.id === 'host-mine');
        assert.deepStrictEqual(raw.tags, ['prod', 'web']);
        assert.strictEqual(raw.port, 2222);
        assert.strictEqual(raw.hasPassword, true, 'the secret already on the record survives an edit');
    });

    await check('save_host refuses another agent\'s host and one outside a pinned set', async () => {
        const other = await call('save_host', { id: 'host-theirs', name: 'renamed' }, ctx(mine));
        assert.strictEqual(other.isError, true);
        const pinned = ctx(mine, { scope: 'targets', hostIds: ['host-other'] });
        const outside = await call('save_host', { id: 'host-mine', name: 'renamed' }, pinned);
        assert.strictEqual(outside.isError, true);
        assert.strictEqual(store.getHosts().find(host => host.id === 'host-mine').name, 'web-01');
    });

    await check('save_proxy creates one with its password, keeps it on an edit, and refuses a chain it cannot see', async () => {
        const result = parse(await call('save_proxy', { name: 'Home', host: '192.168.1.1', port: 1080, username: 'me', password: 'x' }, ctx(mine)));
        assert.strictEqual(result.saved, 'created');
        assert.strictEqual(result.proxy.hasPassword, true);
        assert.strictEqual(result.proxy.password, undefined);
        const stored = store.getProxies().find(proxy => proxy.id === result.proxy.id);
        assert.strictEqual(stored.agentId, mine);
        assert.strictEqual(stored.hasPassword, true);

        const edited = parse(await call('save_proxy', { id: result.proxy.id, name: 'Home (socks)' }, ctx(mine)));
        assert.strictEqual(edited.proxy.hasPassword, true, 'an edit without a password keeps the stored one');

        const chained = await call('save_proxy', { name: 'Chained', host: 'h', viaProxyId: 'proxy-theirs' }, ctx(mine));
        assert.strictEqual(chained.isError, true);
    });

    await check('save_key adds a key to the keychain, identified from the key itself', async () => {
        const created = parse(await call('save_key', {
            name: 'deploy',
            privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
            publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGbIuTA1MRCg5j5c0Qk2oyqJkeYlWjwqVm5x0m6wQF7Q test',
            passphrase: 'pp',
        }, ctx(mine)));
        assert.strictEqual(created.saved, 'created');
        assert.strictEqual(created.key.type, 'ED25519');
        assert.ok(created.key.fingerprint.startsWith('SHA256:'));
        assert.strictEqual(created.key.hasPassphrase, true);
        assert.strictEqual(created.key.privateKey, undefined);
        const raw = store.getKeys().find(key => key.id === created.key.id);
        assert.strictEqual(raw.agentId, mine);
        assert.strictEqual(raw.hasPrivateKey, true);
        assert.ok(changes.includes('keys'));

        const listed = parse(await call('list_inventory', { kind: 'keys' }, ctx(theirs))).keys;
        assert.ok(!listed.some(key => key.id === created.key.id), 'another agent does not see it');

        const missing = await call('save_key', { name: 'nameless' }, ctx(mine));
        assert.strictEqual(missing.isError, true);
    });

    await check('save_mcp_server adds to the agent\'s own servers, and updates by name', async () => {
        const created = parse(await call('save_mcp_server', { name: 'files', command: 'npx', args: ['-y', 'server'] }, ctx(mine)));
        assert.strictEqual(created.saved, 'created');
        assert.deepStrictEqual(agents.get(mine).mcpServers.map(server => server.name), ['files']);
        assert.deepStrictEqual(agents.get(theirs).mcpServers, []);

        const updated = parse(await call('save_mcp_server', { name: 'Files', args: ['-y', 'other'] }, ctx(mine)));
        assert.strictEqual(updated.saved, 'updated');
        assert.strictEqual(agents.get(mine).mcpServers.length, 1);
        assert.deepStrictEqual(agents.get(mine).mcpServers[0].args, ['-y', 'other']);

        const bad = await call('save_mcp_server', { name: 'web', transport: 'http', url: 'ftp://x' }, ctx(mine));
        assert.strictEqual(bad.isError, true);
    });

    await check('save_folder creates and renames, and a host can be filed into it', async () => {
        const created = parse(await call('save_folder', { name: 'Edge' }, ctx(mine)));
        assert.strictEqual(created.saved, 'created');
        const renamed = parse(await call('save_folder', { id: created.folder.id, name: 'Edge nodes' }, ctx(mine)));
        assert.strictEqual(renamed.folder.name, 'Edge nodes');
        const filed = parse(await call('save_host', { id: 'host-mine', folderId: created.folder.id }, ctx(mine)));
        assert.strictEqual(filed.host.folderId, created.folder.id);
        const missing = await call('save_host', { id: 'host-mine', folderId: 'folder-nope' }, ctx(mine));
        assert.strictEqual(missing.isError, true);
    });

    await check('delete_inventory_item removes its own records and refuses another agent\'s', async () => {
        assert.strictEqual((await call('delete_inventory_item', { kind: 'snippet', id: 'snip-theirs' }, ctx(mine))).isError, true);
        assert.strictEqual((await call('delete_inventory_item', { kind: 'host', id: 'host-theirs' }, ctx(mine))).isError, true);
        assert.strictEqual((await call('delete_inventory_item', { kind: 'proxy', id: 'proxy-theirs' }, ctx(mine))).isError, true);

        parse(await call('delete_inventory_item', { kind: 'snippet', id: 'snip-mine' }, ctx(mine)));
        assert.ok(!store.getSnippets().some(entry => entry.id === 'snip-mine'));
        parse(await call('delete_inventory_item', { kind: 'host', id: 'host-mine' }, ctx(mine)));
        assert.ok(!store.getHosts().some(entry => entry.id === 'host-mine'));
        parse(await call('delete_inventory_item', { kind: 'server', id: 'files' }, ctx(mine)));
        assert.deepStrictEqual(agents.get(mine).mcpServers, []);
        assert.ok(store.getSnippets().some(entry => entry.id === 'snip-theirs'), 'the other agent\'s records are untouched');
        assert.ok(store.getHosts().some(entry => entry.id === 'host-theirs'));
    });

    await check('delete_inventory_item removes a key and names the hosts left without it', async () => {
        store.saveHost({ id: 'host-keyed', name: 'uses-key', host: '10.0.0.5', authMethod: 'keychain', keychainKeyId: 'key-1', agentId: mine });
        const result = parse(await call('delete_inventory_item', { kind: 'key', id: 'key-1' }, ctx(mine)));
        assert.strictEqual(result.deleted, 'key');
        assert.ok(result.hostsLeftWithoutIt.includes('host-keyed'), 'the host saved on it is named');
        assert.strictEqual(result.hostsLeftWithoutIt.length, 2, 'and so is cache-01 from earlier');
        assert.ok(!store.getKeys().some(key => key.id === 'key-1'));
        const again = await call('delete_inventory_item', { kind: 'key', id: 'key-1' }, ctx(mine));
        assert.strictEqual(again.isError, true);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    fs.rmSync(userData, { recursive: true, force: true });
    if (failed > 0) process.exit(1);
})();
