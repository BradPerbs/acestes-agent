/**
 * Where a scheduled job runs when two devices both have it
 * (src/main/fleet/placement.js), over a real relay.
 *
 * The job's own device runs it; when that one is off, the other takes it
 * after the grace period; a pinned job runs only where it is pinned; a
 * locked device runs none of the others' jobs; and a device cut off from the
 * relay runs only its own.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createHub } = require('../src/main/fleet/hub');
const { createDevice } = require('../src/main/fleet/device');
const { createGate, claimFor } = require('../src/main/fleet/placement');

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

function makeDevice(name, info = {}) {
    const saved = { value: null };
    return createDevice({
        load: () => (saved.value ? JSON.parse(saved.value) : null),
        save: (state) => { saved.value = JSON.stringify(state); },
        describe: () => info,
        defaultName: () => name,
    });
}

(async () => {
    console.log('\nfleet placement');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-place-'));
    const hub = createHub({ port: 0, host: '127.0.0.1', file: path.join(dir, 'relay.json') });
    const { port } = await hub.start();

    const deskInfo = {};
    const serverInfo = {};
    const desk = makeDevice('Office PC', deskInfo);
    const server = makeDevice('RDP-01', serverInfo);
    desk.createFleet({ relay: `ws://127.0.0.1:${port}` });
    await until(() => desk.status().connection.state === 'online', 'desk online');
    server.join(desk.createInvite().code);
    await until(() => server.status().fleet && desk.isOnline(server.selfId()) && server.isOnline(desk.selfId()), 'both online');

    const places = {};
    const locks = { desk: false, server: false };
    const gateOf = (device, who) => createGate({
        device,
        placementOf: id => places[id] || null,
        locked: () => locks[who],
        graceMs: 150,
    });
    const deskGate = gateOf(desk, 'desk');
    const serverGate = gateOf(server, 'server');
    let tick = 0;
    const job = (id, schedule = { kind: 'cron', expr: '0 9 * * *' }) => {
        tick += 1;
        return { id, schedule, nextRunAt: 1700000000000 + tick * 60000 };
    };

    await check('the job\'s own device runs it, and the other does not', async () => {
        places['job-a'] = { placement: 'any', origin: desk.selfId() };
        const due = job('job-a');
        const [onDesk, onServer] = await Promise.all([deskGate(due), serverGate(due)]);
        assert.deepStrictEqual([onDesk, onServer], [true, false]);
    });

    await check('when the job\'s own device is off, the other takes it after the grace period', async () => {
        places['job-b'] = { placement: 'any', origin: desk.selfId() };
        desk.stop();
        await until(() => !server.isOnline(desk.selfId()), 'desk gone');
        const started = Date.now();
        assert.strictEqual(await serverGate(job('job-b')), true);
        assert.ok(Date.now() - started >= 140, 'waited its turn first');
        desk.start();
        await until(() => desk.status().connection.state === 'online' && server.isOnline(desk.selfId()), 'desk back');
    });

    await check('a pinned job runs only on its device', async () => {
        places['job-c'] = { placement: server.selfId(), origin: desk.selfId() };
        const due = job('job-c');
        assert.strictEqual(await deskGate(due), false);
        assert.strictEqual(await serverGate(due), true);
    });

    await check('a locked device runs none of the others\' jobs, but still its own', async () => {
        locks.server = true;
        places['job-d'] = { placement: 'any', origin: desk.selfId() };
        places['job-e'] = { placement: 'any', origin: server.selfId() };
        assert.strictEqual(await serverGate(job('job-d')), false);
        assert.strictEqual(await serverGate(job('job-e')), true);
        locks.server = false;
    });

    await check('cut off from the relay, a device runs only its own jobs', async () => {
        server.stop();
        places['job-f'] = { placement: 'any', origin: desk.selfId() };
        places['job-g'] = { placement: 'any', origin: server.selfId() };
        assert.strictEqual(await serverGate(job('job-f')), false);
        assert.strictEqual(await serverGate(job('job-g')), true);
        server.start();
        await until(() => server.status().connection.state === 'online', 'server back');
    });

    await check('an interval job is a lease for most of its interval', () => {
        const lease = claimFor({ id: 'job-h', schedule: { kind: 'every', everyMs: 3600000 } });
        assert.strictEqual(lease.name, 'job-h#lease');
        assert.strictEqual(lease.ttl, 2880000);
        const cron = claimFor({ id: 'job-i', schedule: { kind: 'cron' }, nextRunAt: 123 });
        assert.strictEqual(cron.name, 'job-i#123');
    });

    await check('not in a fleet, every job runs here', async () => {
        const alone = makeDevice('Alone');
        const gate = createGate({ device: alone, placementOf: () => ({ placement: 'other' }), locked: () => true });
        assert.strictEqual(await gate(job('job-j')), true);
    });

    desk.stop();
    server.stop();
    // Let the sockets close before the process goes: Node on Windows aborts
    // on a handle still closing at exit.
    await new Promise(resolve => setTimeout(resolve, 300));
    await hub.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(process.exitCode || 0);
})();
