/**
 * Sync (src/main/fleet/sync.js) between three devices over a real relay,
 * with in-memory collections standing in for the app's stores.
 *
 * What it pins down: a change on one device reaches the others, deletes too;
 * a device that joins later takes the fleet's copy of a record both have and
 * publishes what only it had; a store that tidies a record on the way in does
 * not start a ping-pong; the later of two edits wins on both sides; a device
 * that was off catches up; a removed device's records still read for a
 * newcomer; and a claim is won by exactly one device.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHub } = require('../src/main/fleet/hub');
const { createDevice } = require('../src/main/fleet/device');
const { createSync } = require('../src/main/fleet/sync');

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

async function until(test, what, timeout = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await test()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

/** A store of records with a change signal, like the app's own. */
function makeStore(initial = {}, { tidy = false } = {}) {
    const records = { ...initial };
    const listeners = new Set();
    const tell = () => { for (const fn of listeners) fn(); };
    return {
        records,
        writes: 0,
        set(id, value) {
            records[id] = value;
            tell();
        },
        remove(id) {
            delete records[id];
            tell();
        },
        collection() {
            const store = this;
            return {
                list: () => JSON.parse(JSON.stringify(records)),
                apply: (id, value) => {
                    store.writes += 1;
                    if (value === null) delete records[id];
                    // A store that adds a field of its own on the way in.
                    else records[id] = tidy ? { ...value, tidied: true } : value;
                },
                subscribe: (fn) => {
                    listeners.add(fn);
                    return () => listeners.delete(fn);
                },
            };
        },
    };
}

function makeNode(name, stores) {
    const saved = { value: null };
    const syncSaved = { value: null };
    const device = createDevice({
        load: () => (saved.value ? JSON.parse(saved.value) : null),
        save: (state) => { saved.value = JSON.stringify(state); },
        describe: () => ({}),
        defaultName: () => name,
    });
    const applied = [];
    const sync = createSync({
        device,
        collections: Object.fromEntries(Object.entries(stores).map(([key, store]) => [key, store.collection()])),
        persist: { load: () => (syncSaved.value ? JSON.parse(syncSaved.value) : null), save: (state) => { syncSaved.value = JSON.stringify(state); } },
        onApplied: names => applied.push(...names),
        timers: false,
    });
    sync.start();
    return { device, sync, stores, applied };
}

(async () => {
    console.log('\nfleet sync');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-sync-'));
    const hub = createHub({ port: 0, host: '127.0.0.1', file: path.join(dir, 'relay.json') });
    const { port } = await hub.start();

    const desk = makeNode('Office PC', {
        hosts: makeStore({ web1: { name: 'web1', address: '10.0.0.1' } }),
        agents: makeStore({ default: { name: 'Ops', instructions: 'be brief' } }),
    });
    desk.device.createFleet({ relay: `ws://127.0.0.1:${port}` });
    await until(() => desk.sync.status().primed, 'desk primed');
    await desk.sync.scan();
    await until(() => desk.sync.status().pending === 0, 'desk published');

    // A fresh install: its own default agent, and a host only it has.
    const server = makeNode('RDP-01', {
        hosts: makeStore({ db1: { name: 'db1', address: '10.0.0.9' } }, { tidy: true }),
        agents: makeStore({ default: { name: 'Acestes', instructions: '' } }),
    });

    await check('a joining device takes the fleet\'s copy and shares what only it had', async () => {
        server.device.join(desk.device.createInvite().code);
        await until(() => server.sync.status().primed, 'server primed');
        assert.deepStrictEqual(server.stores.agents.records.default, { name: 'Ops', instructions: 'be brief' });
        assert.strictEqual(server.stores.hosts.records.web1.address, '10.0.0.1');
        await until(() => desk.stores.hosts.records.db1, 'desk has db1');
        assert.strictEqual(desk.stores.hosts.records.db1.address, '10.0.0.9');
        assert.strictEqual(desk.stores.agents.records.default.name, 'Ops');
    });

    await check('a store that tidies what it is given does not bounce it back', async () => {
        const writes = desk.stores.hosts.writes;
        await server.sync.scan();
        await desk.sync.pull();
        await server.sync.pull();
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.strictEqual(server.sync.status().pending, 0);
        assert.strictEqual(desk.stores.hosts.writes, writes);
    });

    await check('an edit and a delete reach the other device', async () => {
        desk.stores.hosts.set('web1', { name: 'web1', address: '10.0.0.2' });
        await until(() => server.stores.hosts.records.web1?.address === '10.0.0.2', 'edit arrived');
        server.stores.hosts.remove('db1');
        await until(() => !desk.stores.hosts.records.db1, 'delete arrived');
        assert.ok(desk.applied.includes('hosts'));
    });

    await check('the later of two edits wins on both devices', async () => {
        desk.device.stop();
        desk.stores.agents.set('default', { name: 'Ops', instructions: 'first' });
        await desk.sync.scan();
        await new Promise(resolve => setTimeout(resolve, 20));
        server.stores.agents.set('default', { name: 'Ops', instructions: 'second' });
        await until(() => server.sync.status().pending === 0, 'server published');
        desk.device.start();
        await until(() => desk.stores.agents.records.default.instructions === 'second', 'desk took the later edit', 15000);
        await desk.sync.pull();
        await server.sync.pull();
        assert.strictEqual(server.stores.agents.records.default.instructions, 'second');
    });

    await check('a device that was off reads what changed while it was away', async () => {
        server.device.stop();
        for (let i = 0; i < 30; i += 1) desk.stores.hosts.set(`h${i}`, { name: `h${i}` });
        await desk.sync.scan();
        await until(() => desk.sync.status().pending === 0, 'desk published the batch');
        server.device.start();
        await until(() => Object.keys(server.stores.hosts.records).length >= 31, 'server caught up', 15000);
    });

    await check('records from a removed device still read for a newcomer', async () => {
        server.stores.hosts.set('only-server', { name: 'only-server' });
        await until(() => desk.stores.hosts.records['only-server'], 'desk has it');
        desk.device.removeDevice(server.device.selfId());
        await until(() => server.device.status().fleet === null, 'server removed');
        const laptop = makeNode('Laptop', { hosts: makeStore(), agents: makeStore() });
        laptop.device.join(desk.device.createInvite().code);
        await until(() => laptop.sync.status().primed, 'laptop primed');
        assert.ok(laptop.stores.hosts.records['only-server'], 'the removed device\'s host');
        assert.strictEqual(laptop.stores.agents.records.default.instructions, 'second');
        laptop.device.stop();
        laptop.sync.stop();
    });

    await check('a claim is won by exactly one device', async () => {
        const other = makeNode('Spare', { hosts: makeStore(), agents: makeStore() });
        other.device.join(desk.device.createInvite().code);
        await until(() => other.sync.status().primed, 'spare primed');
        const [a, b] = await Promise.all([
            desk.device.claim('job-1@2026-10-20T09:00', 60000),
            other.device.claim('job-1@2026-10-20T09:00', 60000),
        ]);
        assert.strictEqual(Number(a.won) + Number(b.won), 1);
        assert.strictEqual(a.by, b.by);
        const again = await desk.device.claim('job-1@2026-10-20T09:00', 60000);
        assert.strictEqual(again.won, a.won);
        other.device.stop();
        other.sync.stop();
    });

    for (const node of [desk, server]) {
        node.sync.stop();
        node.device.stop();
    }
    // Let the sockets close before the process goes: Node on Windows aborts
    // on a handle still closing at exit.
    await new Promise(resolve => setTimeout(resolve, 300));
    await hub.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(process.exitCode || 0);
})();
