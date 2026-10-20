/**
 * The fleet, end to end: a relay hub on a random port and several devices
 * talking through it over real WebSockets.
 *
 * What it pins down: the crypto round trips; a fleet started, a device let in
 * by a code and a forged code refused; requests answered across devices;
 * the mailbox holding a message for a device that is off; a removed device
 * wiped and the key moved on for the others; and a hub restarted from its
 * file with every device signing back in by itself.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fleetCrypto = require('../src/main/fleet/crypto');
const { createHub } = require('../src/main/fleet/hub');
const { createDevice } = require('../src/main/fleet/device');
const reach = require('../src/main/fleet/reach');

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

async function until(test, what, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (await test()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

/** A device whose saved state lives in memory, with a stand-in for the vault. */
function makeDevice(name, { saved = { value: null } } = {}) {
    const device = createDevice({
        load: () => (saved.value ? JSON.parse(saved.value) : null),
        save: (state) => {
            saved.value = JSON.stringify(state);
        },
        protect: value => `enc:${Buffer.from(String(value)).toString('base64')}`,
        unprotect: value => Buffer.from(String(value).replace(/^enc:/, ''), 'base64').toString('utf8'),
        describe: () => ({ os: 'test', version: '0.0.0' }),
        defaultName: () => name,
    });
    device.saved = saved;
    return device;
}

const others = (device) => device.devices().filter(entry => !entry.self);

(async () => {
    console.log('\nfleet crypto');

    await check('seal and open round trip, and tampering is caught', () => {
        const key = fleetCrypto.newFleetKey();
        const sealed = fleetCrypto.seal(key, { hello: 'world' }, 'aad');
        assert.deepStrictEqual(fleetCrypto.open(key, sealed, 'aad'), { hello: 'world' });
        assert.throws(() => fleetCrypto.open(key, sealed, 'other aad'));
        assert.throws(() => fleetCrypto.open(fleetCrypto.newFleetKey(), sealed, 'aad'));
    });

    await check('a value wrapped to a device opens only with its key', () => {
        const alice = fleetCrypto.generateIdentity();
        const bob = fleetCrypto.generateIdentity();
        const wrapped = fleetCrypto.wrapTo(alice.boxPublic, { key: 'k' });
        assert.deepStrictEqual(fleetCrypto.unwrap(alice, wrapped), { key: 'k' });
        assert.throws(() => fleetCrypto.unwrap(bob, wrapped));
    });

    await check('signatures verify, and the device id comes from the key', () => {
        const alice = fleetCrypto.generateIdentity();
        const sig = fleetCrypto.sign(alice, 'text');
        assert.strictEqual(fleetCrypto.verify(alice.signPublic, 'text', sig), true);
        assert.strictEqual(fleetCrypto.verify(alice.signPublic, 'other', sig), false);
        assert.strictEqual(fleetCrypto.deviceIdFor(alice.signPublic), alice.deviceId);
    });

    await check('invite codes parse back, and junk does not', () => {
        const invite = fleetCrypto.makeInvite({ relay: 'ws://127.0.0.1:1', fleetId: 'abcdefgh', name: 'PC' });
        const parsed = fleetCrypto.parseInvite(`  ${invite.code}\n`);
        assert.strictEqual(parsed.secret, invite.secret);
        assert.strictEqual(parsed.from, 'PC');
        assert.strictEqual(fleetCrypto.parseInvite('hello'), null);
        assert.strictEqual(fleetCrypto.parseInvite('ACESTES1.!!!'), null);
    });

    console.log('\nfleet over a relay');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acestes-fleet-'));
    const file = path.join(dir, 'relay.json');
    let hub = createHub({ port: 0, host: '127.0.0.1', file });
    const { port } = await hub.start();
    const relay = `ws://127.0.0.1:${port}`;

    const office = makeDevice('Office PC');
    const rdp = makeDevice('RDP-01');
    const laptop = makeDevice('Laptop');
    const all = [office, rdp, laptop];

    await check('a fleet starts and its first device signs in', async () => {
        const result = office.createFleet({ relay });
        assert.ok(!result.error, result.error);
        await until(() => office.status().connection.state === 'online', 'office online');
        assert.strictEqual(office.devices().length, 1);
    });

    await check('a device joins with a code and both see each other', async () => {
        const { code } = office.createInvite();
        assert.ok(code.startsWith('ACESTES1.'));
        rdp.join(code);
        await until(() => rdp.status().fleet && rdp.status().connection.state === 'online', 'rdp in the fleet');
        await until(() => others(office).some(entry => entry.name === 'RDP-01' && entry.online), 'office sees rdp');
        await until(() => others(rdp).some(entry => entry.name === 'Office PC' && entry.online), 'rdp sees office');
        assert.strictEqual(rdp.status().fleet.id, office.status().fleet.id);
        assert.strictEqual(others(rdp)[0].info.os, 'test');
    });

    await check('a code is single use', async () => {
        const { code } = office.createInvite();
        const first = makeDevice('First');
        first.join(code);
        await until(() => first.status().fleet, 'first joined');
        const second = makeDevice('Second');
        second.join(code);
        await until(() => second.status().connection.state === 'error', 'second refused');
        assert.strictEqual(second.status().fleet, null);
        office.removeDevice(first.selfId());
        await until(() => first.status().fleet === null, 'first removed');
        first.stop();
        second.stop();
    });

    await check('a code can carry another address for the relay, and only a relay address', async () => {
        const alternate = `ws://100.100.1.2:${port}`;
        const made = office.createInvite({ relay: `${alternate}/` });
        assert.ok(!made.error, made.error);
        assert.strictEqual(made.relay, alternate);
        assert.strictEqual(fleetCrypto.parseInvite(made.code).relay, alternate);
        assert.strictEqual(office.status().invite.relay, alternate);
        assert.strictEqual(office.createInvite().relay, relay);
        assert.ok(office.createInvite({ relay: 'http://example.com' }).error);
        assert.ok(office.createInvite({ relay: 'ws://a b' }).error);
    });

    console.log('\nfleet reach');

    await check('addresses are named for who can reach them', () => {
        const cases = {
            '100.112.44.103': 'tailscale',
            'pc.tail1234.ts.net': 'tailscale',
            '192.168.254.103': 'lan',
            '10.0.0.5': 'lan',
            '172.20.1.1': 'lan',
            '172.32.1.1': 'public',
            '169.254.3.15': 'linklocal',
            '127.0.0.1': 'loopback',
            localhost: 'loopback',
            '81.2.69.160': 'public',
            'office-pc': 'lan',
            'acestes-relay.example.workers.dev': 'internet',
        };
        for (const [host, kind] of Object.entries(cases)) assert.strictEqual(reach.kindOf(host), kind, host);
        assert.strictEqual(reach.kindOf('10.5.0.2', 'Tailscale'), 'tailscale');
        assert.strictEqual(reach.kindOf('10.6.0.2', 'ZeroTier One [abc]'), 'vpn');
    });

    await check('a relay address is taken apart, with the default port filled in', () => {
        assert.deepStrictEqual(reach.describeRelay('ws://100.112.44.103:7377'),
            { url: 'ws://100.112.44.103:7377', kind: 'tailscale', host: '100.112.44.103', port: '7377', secure: false });
        const hosted = reach.describeRelay('wss://relay.example.com');
        assert.strictEqual(hosted.kind, 'internet');
        assert.strictEqual(hosted.port, '443');
        assert.strictEqual(reach.describeRelay('http://x').kind, 'unknown');
        assert.strictEqual(reach.describeRelay('not a url').kind, 'unknown');
    });

    await check('this computer\'s networks leave out loopback and self-assigned addresses', () => {
        for (const entry of reach.networks()) {
            assert.ok(['tailscale', 'lan', 'vpn', 'public'].includes(entry.kind), `${entry.address} ${entry.kind}`);
        }
    });

    await check('a relay that is up answers the probe, and a closed port says so', async () => {
        const up = await reach.probe(relay);
        assert.strictEqual(up.ok, true, JSON.stringify(up));
        assert.ok(up.ms >= 0);
        // A port that was just free: fetch refuses low "unsafe" ports outright.
        const spare = require('net').createServer();
        await new Promise(resolve => spare.listen(0, '127.0.0.1', resolve));
        const sparePort = spare.address().port;
        await new Promise(resolve => spare.close(resolve));
        const closed = await reach.probe(`ws://127.0.0.1:${sparePort}`);
        assert.strictEqual(closed.ok, false);
        assert.strictEqual(closed.code, 'refused', JSON.stringify(closed));
        assert.strictEqual((await reach.probe('nonsense')).code, 'bad-address');
    });

    await check('a forged code is never let in', async () => {
        const { code } = office.createInvite();
        const parsed = fleetCrypto.parseInvite(code);
        const forged = `ACESTES1.${Buffer.from(JSON.stringify({ r: parsed.relay, f: parsed.fleetId, i: parsed.inviteId, s: fleetCrypto.newId(16), n: '' })).toString('base64url')}`;
        const intruder = makeDevice('Intruder');
        intruder.join(forged);
        await until(() => intruder.status().connection.state === 'waiting', 'intruder waiting');
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.strictEqual(intruder.status().fleet, null);
        assert.ok(!office.devices().some(entry => entry.name === 'Intruder'));
        intruder.stop();
    });

    await check('a request is answered by the other device', async () => {
        rdp.on('echo', async (data, meta) => ({ said: data.text, from: meta.fromName }));
        const answer = await office.request(rdp.selfId(), 'echo', { text: 'hi' });
        assert.deepStrictEqual(answer, { said: 'hi', from: 'Office PC' });
        await assert.rejects(office.request(rdp.selfId(), 'nothing-handles-this', {}), /does not know how/);
    });

    await check('a device invited by a member other than the first joins too', async () => {
        const { code } = rdp.createInvite();
        laptop.join(code);
        await until(() => laptop.status().fleet, 'laptop joined');
        await until(() => others(office).some(entry => entry.name === 'Laptop' && entry.online), 'office sees laptop');
        await until(() => others(laptop).length === 2 && others(laptop).every(entry => entry.online), 'laptop sees both');
    });

    await check('a message to a device that is off waits for it', async () => {
        const notes = [];
        laptop.on('note', async (data) => {
            notes.push(data.text);
            return true;
        });
        laptop.stop();
        await until(() => !office.isOnline(laptop.selfId()), 'laptop offline');
        office.send(laptop.selfId(), 'note', { text: 'while you were out' });
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.deepStrictEqual(notes, []);
        laptop.start();
        await until(() => notes.length === 1, 'the note delivered');
        assert.strictEqual(notes[0], 'while you were out');
    });

    await check('a removed device is wiped and the key moves on', async () => {
        const before = JSON.parse(rdp.saved.value).fleet.epoch;
        office.removeDevice(laptop.selfId());
        await until(() => laptop.status().fleet === null, 'laptop wiped');
        await until(() => JSON.parse(rdp.saved.value).fleet.epoch === before + 1, 'rdp rekeyed');
        await until(() => !others(rdp).some(entry => entry.name === 'Laptop'), 'rdp forgot laptop');
        const answer = await office.request(rdp.selfId(), 'echo', { text: 'after rekey' });
        assert.strictEqual(answer.said, 'after rekey');
    });

    await check('secrets are kept only through protect', () => {
        const saved = JSON.parse(office.saved.value);
        assert.ok(saved.identity.signPrivate.startsWith('enc:'));
        assert.ok(Object.values(saved.fleet.keys).every(value => value.startsWith('enc:')));
    });

    await check('a restarted hub has the fleet back, and devices sign in again', async () => {
        await hub.stop();
        await until(() => office.status().connection.state !== 'online', 'office notices');
        hub = createHub({ port, host: '127.0.0.1', file });
        await hub.start();
        await until(() => office.status().connection.state === 'online' && rdp.status().connection.state === 'online', 'both back', 15000);
        const answer = await office.request(rdp.selfId(), 'echo', { text: 'after restart' });
        assert.strictEqual(answer.said, 'after restart');
    });

    await check('leaving takes a device out for good', async () => {
        rdp.leave();
        assert.strictEqual(rdp.status().fleet, null);
        await until(() => office.devices().length === 1, 'office alone');
    });

    for (const device of all) device.stop();
    // Let the sockets close before the process goes: Node on Windows aborts
    // on a handle still closing at exit.
    await new Promise(resolve => setTimeout(resolve, 300));
    await hub.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(process.exitCode || 0);
})();
