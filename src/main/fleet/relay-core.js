/**
 * The relay: what every device in a fleet connects out to.
 *
 * It does three things and knows nothing else: it checks a device is on the
 * fleet's roster before it routes anything for it, it says who is online, and
 * it carries sealed messages between devices, holding them in a mailbox for a
 * device that is off until it comes back and acknowledges them. What the
 * messages say it cannot read: they are sealed under the fleet key, which it
 * never sees (crypto.js).
 *
 * No runtime of its own. The same core runs in Node (hub.js, on any machine,
 * an Acestes install included) and in a Cloudflare Durable Object, with what
 * differs handed in:
 *
 *   storage       async get(key), put(key, value), delete(key),
 *                 list(prefix, { after?, limit? }) -> [[key, value], ...] in
 *                 key order, from the first key after `after`
 *   sockets()     this fleet's open connections, each { send(text),
 *                 close(code, reason), getState(), setState(state) }. State
 *                 is kept on the connection, not here, because a Durable
 *                 Object that hibernates keeps its sockets and loses its heap.
 *   verify        async (signPublic, text, signature) -> boolean, Ed25519
 *   deviceIdFor   async (signPublic) -> the id derived from it
 *   randomId, now
 *
 * The conversation, in frames of JSON:
 *
 *   relay   { t: 'challenge', nonce }                     on connect
 *   device  { t: 'create', device, signPublic, sig }      the first device, starting the fleet
 *           { t: 'hello', device, sig }                   a device on the roster
 *           { t: 'join', device, signPublic, invite, request, sig }
 *                                                         a new device with a code; waits
 *   relay   { t: 'ready', device, roster, online }        signed in
 *           { t: 'presence', device, online, removed? }
 *           { t: 'join-request', seq, device, signPublic, invite, request }   to the inviter
 *           { t: 'msg', seq?, from, id, body }            a device's sealed message
 *   device  { t: 'invite', invite, expiresAt }            a code was made; let its holder knock
 *           { t: 'admit', device, signPublic, invite }    the inviter checked the code's proof
 *           { t: 'send', to, id, body, ephemeral? }       to a device id, or '*' for all the others
 *           { t: 'ack', seqs }                            delivered; drop from the mailbox
 *           { t: 'remove', device }                       off the roster, sockets closed
 *           { t: 'ping' }
 *
 * And two services for the fleet's shared state, each answered with the
 * request's `rid`:
 *
 *   The sync log. `{ t: 'log.put', rid, entries: [{ k, blob }] }` keeps the
 *   latest sealed record under each key, numbered as it arrives; `{ t:
 *   'log.pull', rid, since, limit }` reads them in order after a number. A
 *   key is an HMAC under the fleet key and a blob is sealed, so the relay
 *   holds the fleet's settings, inventory and memory without being able to
 *   name a single one. One entry per key, so the log never grows past the
 *   data it holds, and a device off for a month reads exactly what changed.
 *   Every other device is told `{ t: 'log.new', seq }` to pull.
 *
 *   Claims. `{ t: 'claim', rid, k, ttl }` answers `{ won, by }`: the first
 *   device to claim a key has it until it expires. This is how a scheduled
 *   job fires on exactly one device when several are on.
 *
 * `sig` signs "acestes-relay\n<action>\n<fleet>\n<device>\n<nonce>" with the
 * device's key, so a signature is good for one connection only.
 */

const MAILBOX_LIMIT = 2000;
const MAILBOX_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_INVITES = 20;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_BLOB = 512 * 1024;
const PULL_LIMIT = 200;
const MAX_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9_-]{8,128}$/;

const pad = (seq) => String(seq).padStart(12, '0');
const ID = /^[0-9a-f]{20}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

function signedText(action, fleetId, deviceId, nonce) {
    return `acestes-relay\n${action}\n${fleetId}\n${deviceId}\n${nonce}`;
}

function createRelay({ fleetId, storage, sockets, verify, deviceIdFor, randomId, now = () => Date.now() }) {
    const send = (conn, frame) => {
        try {
            conn.send(JSON.stringify(frame));
        } catch {
            // A socket closing under us; its close handler tidies up.
        }
    };
    const fail = (conn, code, message, close = false) => {
        send(conn, { t: 'error', code, message });
        if (close) {
            try {
                conn.close(4000, code);
            } catch {
                // Already closed.
            }
        }
    };

    const state = (conn) => conn.getState() || {};
    const signedIn = () => sockets().filter(conn => state(conn).authed);
    const socketsOf = (deviceId) => signedIn().filter(conn => state(conn).device === deviceId);
    const online = () => [...new Set(signedIn().map(conn => state(conn).device))];

    const roster = async () => (await storage.get('roster')) || {};

    async function nextSeq() {
        const seq = ((await storage.get('seq')) || 0) + 1;
        await storage.put('seq', seq);
        return seq;
    }

    /** Hold a frame for a device until it acknowledges it, and hand it over now if it is here. */
    async function deliver(deviceId, frame) {
        const seq = await nextSeq();
        const held = { ...frame, seq, heldAt: now() };
        await storage.put(`mail:${deviceId}:${pad(seq)}`, held);
        const box = await storage.list(`mail:${deviceId}:`);
        // Oldest first out when a device has been away long enough to fill it.
        for (const [key] of box.slice(0, Math.max(0, box.length - MAILBOX_LIMIT))) await storage.delete(key);
        for (const conn of socketsOf(deviceId)) send(conn, held);
    }

    async function flush(conn, deviceId) {
        const cutoff = now() - MAILBOX_TTL_MS;
        for (const [key, frame] of await storage.list(`mail:${deviceId}:`)) {
            if ((frame.heldAt || 0) < cutoff) {
                await storage.delete(key);
                continue;
            }
            send(conn, frame);
        }
    }

    function broadcastPresence(deviceId, isOnline, extra = {}) {
        for (const conn of signedIn()) {
            if (state(conn).device !== deviceId) send(conn, { t: 'presence', device: deviceId, online: isOnline, ...extra });
        }
    }

    async function signIn(conn, deviceId) {
        const wasOnline = socketsOf(deviceId).length > 0;
        conn.setState({ ...state(conn), device: deviceId, authed: true, joining: '' });
        const members = await roster();
        send(conn, {
            t: 'ready',
            device: deviceId,
            roster: Object.keys(members),
            online: online().filter(id => id !== deviceId),
        });
        await flush(conn, deviceId);
        if (!wasOnline) broadcastPresence(deviceId, true);
    }

    async function checkSignature(conn, action, deviceId, signPublic, sig) {
        if (!ID.test(String(deviceId)) || typeof signPublic !== 'string') return false;
        if ((await deviceIdFor(signPublic)) !== deviceId) return false;
        return verify(signPublic, signedText(action, fleetId, deviceId, state(conn).nonce), sig);
    }

    /* ---------------- before signing in ---------------- */

    async function onCreate(conn, msg) {
        const members = await roster();
        const known = members[msg.device];
        if (!(await checkSignature(conn, 'create', msg.device, msg.signPublic, msg.sig))) return fail(conn, 'bad-signature', 'The signature did not verify.', true);
        if (Object.keys(members).length > 0 && known?.signPublic !== msg.signPublic) {
            return fail(conn, 'fleet-exists', 'A fleet with this id already exists.', true);
        }
        if (!known) {
            await storage.put('roster', { [msg.device]: { signPublic: msg.signPublic, addedAt: now(), addedBy: msg.device } });
        }
        return signIn(conn, msg.device);
    }

    async function onHello(conn, msg) {
        const members = await roster();
        const member = members[msg.device];
        if (!member) {
            return fail(conn, Object.keys(members).length ? 'unknown-device' : 'unknown-fleet', 'This device is not in the fleet.', true);
        }
        if (!(await checkSignature(conn, 'hello', msg.device, member.signPublic, msg.sig))) return fail(conn, 'bad-signature', 'The signature did not verify.', true);
        return signIn(conn, msg.device);
    }

    async function onJoin(conn, msg) {
        if (!(await checkSignature(conn, 'join', msg.device, msg.signPublic, msg.sig))) return fail(conn, 'bad-signature', 'The signature did not verify.', true);
        const members = await roster();
        // Admitted already, on an earlier connection: this is a sign-in.
        if (members[msg.device]?.signPublic === msg.signPublic) return signIn(conn, msg.device);
        if (!TOKEN.test(String(msg.invite || ''))) return fail(conn, 'bad-invite', 'That code is not valid.', true);
        const invite = await storage.get(`invite:${msg.invite}`);
        if (!invite || invite.expiresAt < now()) return fail(conn, 'bad-invite', 'That code has expired or was already used.', true);
        const request = msg.request && typeof msg.request === 'object' ? msg.request : {};
        if (JSON.stringify(request).length > MAX_REQUEST_BYTES) return fail(conn, 'too-large', 'The join request is too large.', true);

        conn.setState({ ...state(conn), device: msg.device, signPublic: msg.signPublic, joining: msg.invite });
        send(conn, { t: 'waiting', invite: msg.invite });
        // Held like a message, so an inviter that is off finds it when it comes back.
        await deliver(invite.by, { t: 'join-request', device: msg.device, signPublic: msg.signPublic, invite: msg.invite, request });
        return undefined;
    }

    /* ---------------- signed in ---------------- */

    async function onInvite(conn, msg) {
        if (!TOKEN.test(String(msg.invite || ''))) return fail(conn, 'bad-invite', 'Invite ids are short tokens.');
        const invites = await storage.list('invite:');
        for (const [key, value] of invites) if (value.expiresAt < now()) await storage.delete(key);
        if ((await storage.list('invite:')).length >= MAX_INVITES) return fail(conn, 'too-many-invites', 'Too many codes are waiting to be used.');
        const expiresAt = Math.min(Number(msg.expiresAt) || 0, now() + 24 * 60 * 60 * 1000);
        await storage.put(`invite:${msg.invite}`, { by: state(conn).device, expiresAt });
        return send(conn, { t: 'invited', invite: msg.invite, expiresAt });
    }

    async function onAdmit(conn, msg) {
        const invite = await storage.get(`invite:${msg.invite}`);
        if (!invite || invite.by !== state(conn).device) return fail(conn, 'bad-invite', 'Only the device that made a code can admit with it.');
        if (!ID.test(String(msg.device)) || (await deviceIdFor(msg.signPublic)) !== msg.device) return fail(conn, 'bad-device', 'The device id does not match its key.');
        const members = await roster();
        members[msg.device] = { signPublic: msg.signPublic, addedAt: now(), addedBy: state(conn).device };
        await storage.put('roster', members);
        await storage.delete(`invite:${msg.invite}`);
        send(conn, { t: 'admitted', device: msg.device });
        for (const waiting of sockets()) {
            const info = state(waiting);
            if (!info.authed && info.device === msg.device && info.signPublic === msg.signPublic) await signIn(waiting, msg.device);
        }
        return undefined;
    }

    async function onSend(conn, msg) {
        const from = state(conn).device;
        const members = await roster();
        const targets = msg.to === '*'
            ? Object.keys(members).filter(id => id !== from)
            : (members[msg.to] ? [msg.to] : []);
        if (targets.length === 0) return fail(conn, 'no-recipient', `No device ${msg.to} in the fleet.`);
        const frame = { t: 'msg', from, id: String(msg.id || '').slice(0, 64), body: msg.body };
        for (const target of targets) {
            if (msg.ephemeral) {
                for (const peer of socketsOf(target)) send(peer, frame);
            } else {
                await deliver(target, frame);
            }
        }
        return undefined;
    }

    async function onAck(conn, msg) {
        const device = state(conn).device;
        for (const seq of (Array.isArray(msg.seqs) ? msg.seqs : []).slice(0, 500)) {
            if (Number.isInteger(seq) && seq > 0) await storage.delete(`mail:${device}:${pad(seq)}`);
        }
    }

    async function onRemove(conn, msg) {
        const members = await roster();
        if (!members[msg.device]) return fail(conn, 'no-device', 'That device is not in the fleet.');
        delete members[msg.device];
        await storage.put('roster', members);
        for (const [key] of await storage.list(`mail:${msg.device}:`)) await storage.delete(key);
        for (const peer of sockets().filter(other => state(other).device === msg.device)) {
            try {
                peer.close(4001, 'removed');
            } catch {
                // Already gone.
            }
        }
        broadcastPresence(msg.device, false, { removed: true });
        return send(conn, { t: 'removed', device: msg.device });
    }

    /* ---------------- the sync log ---------------- */

    async function onLogPut(conn, msg) {
        const entries = Array.isArray(msg.entries) ? msg.entries.slice(0, MAX_LOG_ENTRIES) : [];
        let last = (await storage.get('logseq')) || 0;
        // A copy older than the one held is not taken: the newer one goes back
        // to the device instead, so a device that was away cannot overwrite a
        // later edit with its own earlier one. `t` is the record's stamp, the
        // one thing about it the relay can read.
        const stale = [];
        for (const entry of entries) {
            if (!KEY.test(String(entry?.k || ''))) continue;
            if (!entry.blob || JSON.stringify(entry.blob).length > MAX_LOG_BLOB) continue;
            const stamp = String(entry.t || '').slice(0, 80);
            const previous = await storage.get(`log:${entry.k}`);
            if (previous?.t && stamp && previous.t >= stamp) {
                stale.push({ seq: previous.seq, k: entry.k, blob: previous.blob, by: previous.by });
                continue;
            }
            last += 1;
            if (previous) await storage.delete(`logseq:${pad(previous.seq)}`);
            await storage.put(`log:${entry.k}`, { seq: last, t: stamp, blob: entry.blob, by: state(conn).device });
            await storage.put(`logseq:${pad(last)}`, entry.k);
        }
        await storage.put('logseq', last);
        send(conn, { t: 'log.ok', rid: msg.rid, seq: last, stale });
        for (const peer of signedIn()) {
            if (peer !== conn) send(peer, { t: 'log.new', seq: last });
        }
    }

    async function onLogPull(conn, msg) {
        const since = Math.max(0, Number(msg.since) || 0);
        const limit = Math.min(PULL_LIMIT, Math.max(1, Number(msg.limit) || PULL_LIMIT));
        const index = await storage.list('logseq:', { after: `logseq:${pad(since)}`, limit: limit + 1 });
        const entries = [];
        for (const [key, k] of index.slice(0, limit)) {
            const record = await storage.get(`log:${k}`);
            if (record) entries.push({ seq: Number(key.slice('logseq:'.length)), k, blob: record.blob, by: record.by });
        }
        const head = (await storage.get('logseq')) || 0;
        send(conn, { t: 'log.batch', rid: msg.rid, entries, more: index.length > limit, head });
    }

    /* ---------------- claims ---------------- */

    async function onClaim(conn, msg) {
        if (!KEY.test(String(msg.k || ''))) return fail(conn, 'bad-claim', 'Claim keys are short tokens.');
        const key = `claim:${msg.k}`;
        const held = await storage.get(key);
        if (held && held.expiresAt > now()) {
            return send(conn, { t: 'claimed', rid: msg.rid, k: msg.k, won: held.by === state(conn).device, by: held.by });
        }
        const ttl = Math.min(MAX_CLAIM_TTL_MS, Math.max(60 * 1000, Number(msg.ttl) || 60 * 60 * 1000));
        await storage.put(key, { by: state(conn).device, expiresAt: now() + ttl });
        // Tidy the expired ones now and then, rather than on every claim.
        const count = ((await storage.get('claims')) || 0) + 1;
        await storage.put('claims', count);
        if (count % 200 === 0) {
            for (const [other, value] of await storage.list('claim:')) if (value.expiresAt <= now()) await storage.delete(other);
        }
        return send(conn, { t: 'claimed', rid: msg.rid, k: msg.k, won: true, by: state(conn).device });
    }

    const SIGNED_IN = {
        invite: onInvite,
        admit: onAdmit,
        send: onSend,
        ack: onAck,
        remove: onRemove,
        'log.put': onLogPut,
        'log.pull': onLogPull,
        claim: onClaim,
    };

    return {
        onOpen(conn) {
            const nonce = randomId();
            conn.setState({ nonce });
            send(conn, { t: 'challenge', nonce, fleet: fleetId });
        },

        async onMessage(conn, text) {
            let msg;
            try {
                msg = JSON.parse(text);
            } catch {
                return fail(conn, 'bad-frame', 'Frames are JSON.');
            }
            if (!msg || typeof msg !== 'object') return fail(conn, 'bad-frame', 'Frames are JSON objects.');
            if (msg.t === 'ping') return send(conn, { t: 'pong' });
            const info = state(conn);
            if (!info.authed) {
                if (msg.t === 'create') return onCreate(conn, msg);
                if (msg.t === 'hello') return onHello(conn, msg);
                if (msg.t === 'join') return onJoin(conn, msg);
                return fail(conn, 'not-signed-in', 'Sign in first.');
            }
            const handler = SIGNED_IN[msg.t];
            if (!handler) return fail(conn, 'unknown', `Unknown frame ${msg.t}.`);
            return handler(conn, msg);
        },

        onClose(conn) {
            const info = state(conn);
            conn.setState({ ...info, authed: false });
            if (info.authed && info.device && socketsOf(info.device).filter(other => other !== conn).length === 0) {
                broadcastPresence(info.device, false);
            }
        },
    };
}

module.exports = { createRelay, signedText };
