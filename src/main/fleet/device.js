const fleetCrypto = require('./crypto');
const { createRelayClient, relayUrl } = require('./client');

/**
 * This computer as a device in a fleet: the other Acestes installs it can
 * hand work to and keep in step with.
 *
 * What it keeps (through `load` and `save`, with every private key and the
 * fleet key passed through `protect` first, which in the app is the vault):
 *
 *   identity   this device's id and key pairs (crypto.js)
 *   fleet      the fleet's id, its relay, and its keys by epoch
 *   roster     every device in it: name, public keys, who added it and when.
 *              Kept here and changed only by signed, sealed messages from a
 *              member, never by the relay's say-so, so a relay cannot add a
 *              device the others will believe.
 *   peers      what each device last said about itself (status), so one that
 *              is off still shows what it was
 *   invites    codes this device made and nobody has used yet
 *
 * How a device joins: the inviter makes a code (crypto.makeInvite) and tells
 * the relay to expect it; the joiner knocks with the code's proof; the relay
 * passes the knock to the inviter, which checks the proof, puts the device on
 * the roster, tells the relay to let it in, and sends it a welcome only it
 * can open, carrying the fleet key and the roster. The welcome carries a
 * proof of its own, so the joiner knows it came from the code's maker.
 *
 * Removing a device takes it off the roster and starts a new key epoch,
 * wrapped to each device that stays, so what it held stops opening anything
 * new.
 *
 * Messages between devices are `{ k: kind, d: data }`, sealed and signed.
 * `request` waits for an answer; `on(kind, handler)` answers one. The relay
 * holds what a device that is off would miss; `ephemeral` sends only to the
 * ones online (a status, which is stale by the time an absent device would
 * read it).
 */

const VERSION = 1;
const SEEN_LIMIT = 5000;
// Every epoch's key is kept: the sync log holds records sealed under old
// ones, and a fleet does not remove enough devices for the list to matter.
const KEEP_EPOCHS = 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const NAME_MAX = 64;

const cleanName = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

function createDevice({
    load,
    save,
    protect = value => value,
    unprotect = value => value,
    describe = () => ({}),
    defaultName = () => 'This computer',
    localRelay = () => '',
    onChange = () => {},
    WebSocketImpl = globalThis.WebSocket,
    now = () => Date.now(),
}) {
    let state = null;
    let client = null;
    let connection = { state: 'idle', code: '', message: '' };
    let online = new Set();
    let lastInvite = null;
    const seen = new Map();
    const pending = new Map();
    const handlers = new Map();
    const arrivals = new Set();
    const relayListeners = new Set();

    const tellArrival = (id) => {
        for (const fn of arrivals) {
            try {
                fn(id);
            } catch (error) {
                console.error('Fleet arrival handler failed:', error.message);
            }
        }
    };

    /* ---------------- state ---------------- */

    function read() {
        if (state) return state;
        const raw = load() || {};
        state = {
            version: VERSION,
            identity: raw.identity && raw.identity.deviceId ? raw.identity : null,
            name: cleanName(raw.name),
            fleet: raw.fleet && raw.fleet.id ? raw.fleet : null,
            joining: raw.joining && raw.joining.fleetId ? raw.joining : null,
            roster: raw.roster && typeof raw.roster === 'object' ? raw.roster : {},
            peers: raw.peers && typeof raw.peers === 'object' ? raw.peers : {},
            // Devices that were in the fleet once: their signing keys, so the
            // records they wrote to the sync log still verify after they left.
            former: raw.former && typeof raw.former === 'object' ? raw.former : {},
            invites: raw.invites && typeof raw.invites === 'object' ? raw.invites : {},
            extra: raw.extra && typeof raw.extra === 'object' ? raw.extra : {},
        };
        return state;
    }

    function persist() {
        save(read());
    }

    const changed = () => {
        try {
            onChange(status());
        } catch (error) {
            console.error('Fleet change handler failed:', error.message);
        }
    };

    function identity() {
        const current = read();
        if (!current.identity) {
            const made = fleetCrypto.generateIdentity();
            current.identity = {
                deviceId: made.deviceId,
                signPublic: made.signPublic,
                boxPublic: made.boxPublic,
                signPrivate: protect(made.signPrivate),
                boxPrivate: protect(made.boxPrivate),
            };
            persist();
        }
        return current.identity;
    }

    /** The identity with its private halves readable, for signing and unwrapping. */
    function openIdentity() {
        const id = identity();
        return { ...id, signPrivate: unprotect(id.signPrivate), boxPrivate: unprotect(id.boxPrivate) };
    }

    const selfId = () => identity().deviceId;
    const myName = () => read().name || cleanName(defaultName());

    function fleetKey(epoch) {
        const stored = read().fleet?.keys?.[epoch];
        return stored ? unprotect(stored) : '';
    }

    /* ---------------- sending ---------------- */

    const aadFor = (fleetId, from, to, id, epoch) => `${fleetId}\n${from}\n${to}\n${id}\n${epoch}`;

    function sealFor(to, id, payload) {
        const fleet = read().fleet;
        const epoch = fleet.epoch;
        const from = selfId();
        const aad = aadFor(fleet.id, from, to, id, epoch);
        const sealed = fleetCrypto.seal(fleetKey(epoch), payload, aad);
        const sig = fleetCrypto.sign(openIdentity(), `${aad}\n${sealed.iv}\n${sealed.ct}`);
        return { to, e: epoch, ...sealed, sig };
    }

    /** Send `{ k: kind, d: data }` to a device, or to every other device with '*'. */
    function send(to, kind, data = {}, { ephemeral = false, id = fleetCrypto.newId(), extra = {} } = {}) {
        if (!read().fleet || !client) return { sent: false, error: 'Not in a fleet.' };
        if (to !== '*' && !read().roster[to]) return { sent: false, error: `No device ${to} in the fleet.` };
        const body = sealFor(to, id, { k: kind, d: data, ts: now(), ...extra });
        const sent = client.send({ t: 'send', to, id, body, ephemeral }, { ephemeral });
        return { sent, id };
    }

    /** Send and wait for the handler on the other side to answer. */
    function request(to, kind, data = {}, { timeout = REQUEST_TIMEOUT_MS, ephemeral = false } = {}) {
        return new Promise((resolve, reject) => {
            const id = fleetCrypto.newId();
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${deviceName(to)} did not answer in time.`));
            }, timeout);
            timer.unref?.();
            pending.set(id, { resolve, reject, timer });
            const result = send(to, kind, data, { id, ephemeral, extra: { rq: 1 } });
            if (result.error) {
                clearTimeout(timer);
                pending.delete(id);
                reject(new Error(result.error));
            }
        });
    }

    function sendStatus(to = '*') {
        if (!read().fleet) return;
        send(to, 'status', { ...describe(), name: myName() }, { ephemeral: true });
    }

    /* ---------------- receiving ---------------- */

    function remember(id) {
        seen.set(id, now());
        if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value);
    }

    function acknowledge(frame) {
        if (Number.isInteger(frame.seq)) client?.send({ t: 'ack', seqs: [frame.seq] });
    }

    async function onMessage(frame) {
        const body = frame.body || {};
        if (body.w) return onWelcome(frame);
        if (body.rk) return onRekey(frame);
        const current = read();
        const member = current.roster[frame.from];
        if (!current.fleet || !member) return undefined;
        const aad = aadFor(current.fleet.id, frame.from, body.to, frame.id, body.e);
        if (body.to !== selfId() && body.to !== '*') return undefined;
        if (!fleetCrypto.verify(member.signPublic, `${aad}\n${body.iv}\n${body.ct}`, body.sig)) return undefined;
        if (seen.has(frame.id)) return undefined;
        const key = fleetKey(body.e);
        if (!key) return undefined;
        let payload;
        try {
            payload = fleetCrypto.open(key, body, aad);
        } catch {
            return undefined;
        }
        remember(frame.id);
        return dispatch(frame.from, frame.id, payload);
    }

    async function dispatch(from, id, payload) {
        const current = read();
        const data = payload.d || {};
        switch (payload.k) {
            case 'status': {
                current.peers[from] = { info: data, seenAt: now() };
                if (data.name) current.roster[from].name = cleanName(data.name);
                persist();
                changed();
                return undefined;
            }
            case 'roster-add': {
                if (!data.device || current.roster[data.device]) return undefined;
                if (fleetCrypto.deviceIdFor(data.signPublic) !== data.device) return undefined;
                current.roster[data.device] = {
                    name: cleanName(data.name),
                    signPublic: data.signPublic,
                    boxPublic: data.boxPublic,
                    addedAt: Number(data.addedAt) || now(),
                    addedBy: from,
                };
                persist();
                // It may have come online before this arrived, when there was no one to tell.
                if (online.has(data.device)) sendStatus(data.device);
                changed();
                return undefined;
            }
            case 'roster-remove': {
                if (data.device === selfId()) return wipe('This device was removed from the fleet.');
                retire(data.device);
                persist();
                changed();
                return undefined;
            }
            case 'reply': {
                const waiting = pending.get(data.re);
                if (!waiting) return undefined;
                pending.delete(data.re);
                clearTimeout(waiting.timer);
                if (data.ok) waiting.resolve(data.value);
                else waiting.reject(new Error(data.error || 'The other device could not do it.'));
                return undefined;
            }
            default: {
                const handler = handlers.get(payload.k);
                let reply;
                try {
                    if (!handler) throw new Error(`${myName()} does not know how to do "${payload.k}". It may need updating.`);
                    reply = { ok: true, value: await handler(data, { from, fromName: deviceName(from), id }) };
                } catch (error) {
                    reply = { ok: false, error: error.message };
                }
                if (payload.rq) send(from, 'reply', { re: id, ...reply });
                return undefined;
            }
        }
    }

    /** A knock with a code this device made: check the proof, then let it in. */
    function onJoinRequest(frame) {
        const current = read();
        const invite = current.invites[frame.invite];
        const request = frame.request || {};
        if (!current.fleet || !invite || invite.expiresAt < now()) return;
        const secret = unprotect(invite.secret);
        const expected = fleetCrypto.joinProof(secret, {
            inviteId: frame.invite,
            deviceId: frame.device,
            signPublic: frame.signPublic,
            boxPublic: request.boxPublic,
        });
        if (!fleetCrypto.sameText(expected, request.proof)) return;
        if (fleetCrypto.deviceIdFor(frame.signPublic) !== frame.device) return;

        const entry = {
            name: cleanName(request.name) || 'New device',
            signPublic: frame.signPublic,
            boxPublic: request.boxPublic,
            addedAt: now(),
            addedBy: selfId(),
        };
        current.roster[frame.device] = entry;
        delete current.invites[frame.invite];
        if (lastInvite?.inviteId === frame.invite) lastInvite = null;
        persist();

        client.send({ t: 'admit', device: frame.device, signPublic: frame.signPublic, invite: frame.invite });

        // Only the newcomer can open this, and the proof says it came from the code's maker.
        const fleet = current.fleet;
        const wrapped = fleetCrypto.wrapTo(request.boxPublic, {
            fleetId: fleet.id,
            relay: fleet.relay,
            epoch: fleet.epoch,
            key: fleetKey(fleet.epoch),
            // All of them, for the records in the sync log sealed under older ones.
            keys: Object.fromEntries(Object.keys(fleet.keys).map(epoch => [epoch, fleetKey(epoch)])),
            roster: current.roster,
            former: current.former,
        });
        const mac = fleetCrypto.welcomeProof(secret, { inviteId: frame.invite, deviceId: frame.device, ct: wrapped.ct });
        const id = fleetCrypto.newId();
        const sig = fleetCrypto.sign(openIdentity(), `welcome\n${fleet.id}\n${selfId()}\n${frame.device}\n${wrapped.ct}`);
        client.send({ t: 'send', to: frame.device, id, body: { w: wrapped, mac, invite: frame.invite, sig } });

        send('*', 'roster-add', { device: frame.device, ...entry });
        changed();
    }

    function onWelcome(frame) {
        const current = read();
        const joining = current.joining;
        const body = frame.body;
        if (!joining || current.fleet || body.invite !== joining.inviteId) return;
        const secret = unprotect(joining.secret);
        const expected = fleetCrypto.welcomeProof(secret, { inviteId: joining.inviteId, deviceId: selfId(), ct: body.w.ct });
        if (!fleetCrypto.sameText(expected, body.mac)) return;
        let welcome;
        try {
            welcome = fleetCrypto.unwrap(openIdentity(), body.w);
        } catch {
            return;
        }
        if (welcome.fleetId !== joining.fleetId || !welcome.roster?.[frame.from]) return;
        const signedBy = welcome.roster[frame.from].signPublic;
        if (!fleetCrypto.verify(signedBy, `welcome\n${welcome.fleetId}\n${frame.from}\n${selfId()}\n${body.w.ct}`, body.sig)) return;

        current.fleet = {
            id: welcome.fleetId,
            relay: joining.relay,
            epoch: welcome.epoch,
            keys: Object.fromEntries(Object.entries({ ...(welcome.keys || {}), [welcome.epoch]: welcome.key })
                .map(([epoch, key]) => [epoch, protect(key)])),
            joinedAt: now(),
            confirmed: true,
        };
        current.roster = welcome.roster;
        current.roster[selfId()] = { ...(current.roster[selfId()] || {}), name: myName() };
        current.former = welcome.former && typeof welcome.former === 'object' ? welcome.former : {};
        current.joining = null;
        persist();
        sendStatus();
        changed();
        // In the fleet from now: what waits for `ready` (sync) can start.
        tellRelay({ t: 'ready', joined: true });
    }

    function onRekey(frame) {
        const current = read();
        const member = current.roster[frame.from];
        const body = frame.body;
        if (!current.fleet || !member) return;
        if (!fleetCrypto.verify(member.signPublic, `rekey\n${current.fleet.id}\n${frame.from}\n${selfId()}\n${body.rk.ct}`, body.sig)) return;
        let next;
        try {
            next = fleetCrypto.unwrap(openIdentity(), body.rk);
        } catch {
            return;
        }
        if (!Number.isInteger(next.epoch) || next.epoch <= current.fleet.epoch) return;
        setKey(next.epoch, next.key);
        persist();
    }

    /** Off the roster, but still trusted for what it wrote while it was on it. */
    function retire(deviceId) {
        const current = read();
        const entry = current.roster[deviceId];
        if (entry?.signPublic) current.former[deviceId] = { signPublic: entry.signPublic, name: entry.name || '' };
        delete current.roster[deviceId];
        delete current.peers[deviceId];
    }

    function setKey(epoch, key) {
        const fleet = read().fleet;
        fleet.keys[epoch] = protect(key);
        fleet.epoch = Math.max(fleet.epoch, epoch);
        const epochs = Object.keys(fleet.keys).map(Number).sort((a, b) => b - a);
        for (const old of epochs.slice(KEEP_EPOCHS)) delete fleet.keys[old];
    }

    /** Frames other parts of the app follow (sync on `ready` and `log.new`). */
    function tellRelay(frame) {
        for (const fn of relayListeners) {
            try {
                fn(frame);
            } catch (error) {
                console.error('Fleet relay listener failed:', error.message);
            }
        }
    }

    function onFrame(frame) {
        if (frame.t === 'log.new' || (frame.t === 'ready' && read().fleet)) {
            // After the switch below has updated the state for `ready`.
            setTimeout(() => tellRelay(frame), 0);
        }
        switch (frame.t) {
            case 'ready': {
                online = new Set(frame.online || []);
                const fleet = read().fleet;
                if (fleet && !fleet.confirmed) {
                    fleet.confirmed = true;
                    persist();
                }
                sendStatus();
                changed();
                for (const id of online) tellArrival(id);
                return;
            }
            case 'presence': {
                if (frame.online) {
                    online.add(frame.device);
                    sendStatus(frame.device);
                    tellArrival(frame.device);
                } else {
                    online.delete(frame.device);
                }
                if (frame.removed) {
                    retire(frame.device);
                    persist();
                }
                changed();
                return;
            }
            case 'join-request':
                try {
                    onJoinRequest(frame);
                } finally {
                    acknowledge(frame);
                }
                return;
            case 'msg':
                Promise.resolve(onMessage(frame))
                    .catch(error => console.error('Fleet message failed:', error.message))
                    .finally(() => acknowledge(frame));
                return;
            case 'removed-self':
                wipe('This device was removed from the fleet.');
                return;
            case 'error':
                if (frame.code === 'bad-invite' && read().joining) {
                    read().joining = null;
                    persist();
                }
                return;
            default:
        }
    }

    /* ---------------- connection ---------------- */

    function connect() {
        disconnect();
        const current = read();
        const target = current.fleet || current.joining;
        if (!target) return;
        const fleetId = () => (read().fleet?.id || read().joining?.fleetId);
        const base = () => localRelay(read().fleet?.relay || read().joining?.relay) || read().fleet?.relay || read().joining?.relay;
        client = createRelayClient({
            url: () => relayUrl(base(), fleetId()),
            fleetId,
            identity: openIdentity,
            WebSocketImpl,
            mode: () => {
                const now_ = read();
                if (now_.fleet && !now_.fleet.confirmed) return { action: 'create' };
                if (now_.fleet) return { action: 'hello' };
                const joining = now_.joining;
                return {
                    action: 'join',
                    extra: {
                        invite: joining.inviteId,
                        request: {
                            name: myName(),
                            boxPublic: identity().boxPublic,
                            proof: fleetCrypto.joinProof(unprotect(joining.secret), {
                                inviteId: joining.inviteId,
                                deviceId: selfId(),
                                signPublic: identity().signPublic,
                                boxPublic: identity().boxPublic,
                            }),
                        },
                    },
                };
            },
            onFrame,
            onState: (next, detail = {}) => {
                connection = { state: next, code: detail.code || '', message: detail.message || '' };
                if (next !== 'online') online = new Set();
                if (next === 'error' && detail.code === 'bad-invite') {
                    read().joining = null;
                    persist();
                }
                changed();
            },
        });
        client.start();
    }

    function disconnect() {
        const old = client;
        client = null;
        old?.stop();
        online = new Set();
    }

    function wipe(message = '') {
        disconnect();
        const current = read();
        current.fleet = null;
        current.joining = null;
        current.roster = {};
        current.peers = {};
        current.former = {};
        current.invites = {};
        lastInvite = null;
        persist();
        connection = { state: message ? 'error' : 'idle', code: message ? 'removed' : '', message };
        for (const waiting of pending.values()) {
            clearTimeout(waiting.timer);
            waiting.reject(new Error('Left the fleet.'));
        }
        pending.clear();
        changed();
    }

    /* ---------------- what the app calls ---------------- */

    function deviceName(id) {
        if (id === selfId()) return myName();
        return read().roster[id]?.name || read().peers[id]?.info?.name || id;
    }

    function devices() {
        const current = read();
        const self = selfId();
        return Object.entries(current.roster).map(([id, entry]) => ({
            id,
            name: id === self ? myName() : (entry.name || current.peers[id]?.info?.name || id),
            self: id === self,
            online: id === self ? connection.state === 'online' : online.has(id),
            seenAt: id === self ? now() : (current.peers[id]?.seenAt || 0),
            addedAt: entry.addedAt || 0,
            info: id === self ? { ...describe(), name: myName() } : (current.peers[id]?.info || {}),
        })).sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name));
    }

    function status() {
        const current = read();
        return {
            deviceId: current.identity?.deviceId || '',
            name: myName(),
            fleet: current.fleet ? { id: current.fleet.id, relay: current.fleet.relay } : null,
            joining: current.joining ? { relay: current.joining.relay, from: current.joining.from } : null,
            connection,
            devices: current.fleet ? devices() : [],
            invite: lastInvite && lastInvite.expiresAt > now()
                ? { code: lastInvite.code, expiresAt: lastInvite.expiresAt, relay: lastInvite.relay }
                : null,
        };
    }

    function createFleet({ relay, name } = {}) {
        const current = read();
        if (current.fleet) return { error: 'This computer is already in a fleet. Leave it first.' };
        const base = String(relay || '').trim();
        if (!/^wss?:\/\/[^\s/]+/i.test(base)) return { error: 'The relay address starts with ws:// or wss://.' };
        if (name) current.name = cleanName(name);
        identity();
        current.fleet = {
            id: fleetCrypto.newId(12),
            relay: base.replace(/\/+$/, ''),
            epoch: 1,
            keys: { 1: protect(fleetCrypto.newFleetKey()) },
            joinedAt: now(),
            confirmed: false,
        };
        current.joining = null;
        current.roster = {
            [selfId()]: {
                name: myName(),
                signPublic: identity().signPublic,
                boxPublic: identity().boxPublic,
                addedAt: now(),
                addedBy: selfId(),
            },
        };
        current.peers = {};
        persist();
        connect();
        changed();
        return status();
    }

    /**
     * A one-time code for another computer. `relay` is the address that
     * computer should use, when it is not the fleet's own: a relay hosted here
     * listens on every network, and the computer joining may be on the
     * tailnet or on the same Wi-Fi. It keeps the address it joined with.
     */
    function createInvite({ relay } = {}) {
        const current = read();
        if (!current.fleet || !client) return { error: 'Start or join a fleet first.' };
        const chosen = String(relay || '').trim().replace(/\/+$/, '');
        if (chosen && !/^wss?:\/\/[^\s/]+$/i.test(chosen)) return { error: 'The relay address starts with ws:// or wss://.' };
        const invite = fleetCrypto.makeInvite({ relay: chosen || current.fleet.relay, fleetId: current.fleet.id, name: myName() });
        for (const [id, entry] of Object.entries(current.invites)) if (entry.expiresAt < now()) delete current.invites[id];
        current.invites[invite.inviteId] = { secret: protect(invite.secret), expiresAt: invite.expiresAt };
        persist();
        client.send({ t: 'invite', invite: invite.inviteId, expiresAt: invite.expiresAt });
        lastInvite = invite;
        changed();
        return { code: invite.code, expiresAt: invite.expiresAt, relay: invite.relay };
    }

    function join(code, { name } = {}) {
        const current = read();
        if (current.fleet) return { error: 'This computer is already in a fleet. Leave it first.' };
        const invite = fleetCrypto.parseInvite(code);
        if (!invite) return { error: 'That is not an Acestes device code.' };
        if (name) current.name = cleanName(name);
        identity();
        current.joining = {
            relay: invite.relay,
            fleetId: invite.fleetId,
            inviteId: invite.inviteId,
            secret: protect(invite.secret),
            from: invite.from,
        };
        persist();
        connect();
        changed();
        return status();
    }

    function removeDevice(id) {
        const current = read();
        if (!current.fleet || !client) return { error: 'Not in a fleet.' };
        if (id === selfId()) return leave();
        if (!current.roster[id]) return { error: 'No such device.' };
        send('*', 'roster-remove', { device: id });
        client.send({ t: 'remove', device: id });
        retire(id);

        // A new key for everyone who stays, so what the removed device held stops working.
        const epoch = current.fleet.epoch + 1;
        const key = fleetCrypto.newFleetKey();
        for (const [peerId, peer] of Object.entries(current.roster)) {
            if (peerId === selfId() || !peer.boxPublic) continue;
            const rk = fleetCrypto.wrapTo(peer.boxPublic, { epoch, key });
            const sig = fleetCrypto.sign(openIdentity(), `rekey\n${current.fleet.id}\n${selfId()}\n${peerId}\n${rk.ct}`);
            client.send({ t: 'send', to: peerId, id: fleetCrypto.newId(), body: { rk, sig } });
        }
        setKey(epoch, key);
        persist();
        changed();
        return status();
    }

    function leave() {
        const current = read();
        if (current.fleet && client) {
            send('*', 'roster-remove', { device: selfId() });
            client.send({ t: 'remove', device: selfId() });
        }
        // Give the frames a moment to leave before the socket closes.
        const closing = client;
        client = null;
        setTimeout(() => closing?.stop(), 500).unref?.();
        wipe();
        return status();
    }

    function rename(name) {
        const clean = cleanName(name);
        if (!clean) return { error: 'A device needs a name.' };
        read().name = clean;
        if (read().fleet && read().roster[selfId()]) read().roster[selfId()].name = clean;
        persist();
        sendStatus();
        changed();
        return status();
    }

    return {
        start() {
            read();
            if (read().fleet || read().joining) connect();
        },
        stop: disconnect,
        status,
        devices,
        deviceName,
        selfId,
        createFleet,
        createInvite,
        join,
        removeDevice,
        leave,
        rename,
        send,
        request,
        isOnline: id => online.has(id),
        announce: () => sendStatus(),
        on(kind, handler) {
            handlers.set(kind, handler);
        },
        /** Called with a device's id each time it is seen to come online, this device's own sign-in included. */
        onArrival(fn) {
            arrivals.add(fn);
            return () => arrivals.delete(fn);
        },
        /** Called with `ready` (signed in, or just joined) and `log.new` frames. */
        onRelay(fn) {
            relayListeners.add(fn);
            return () => relayListeners.delete(fn);
        },
        inFleet: () => Boolean(read().fleet),
        fleetId: () => read().fleet?.id || '',
        isConnected: () => Boolean(client?.isReady()),
        /** Ask the relay itself (the sync log, claims). Rejects when not connected. */
        relayCall(frame, options) {
            if (!client) return Promise.reject(new Error('Not in a fleet.'));
            return client.call(frame, options);
        },
        /** A record's name as the relay sees it: an HMAC under a key only the fleet has. */
        recordKey(name) {
            const keys = Object.keys(read().fleet?.keys || {}).map(Number);
            if (keys.length === 0) throw new Error('Not in a fleet.');
            return fleetCrypto.recordKey(fleetCrypto.indexKeyFrom(fleetKey(Math.min(...keys))), name);
        },
        /** Seal a value for the sync log under `k`, signed by this device. */
        sealRecord(k, value) {
            const fleet = read().fleet;
            const e = fleet.epoch;
            const d = selfId();
            const aad = `sync\n${fleet.id}\n${k}\n${e}`;
            const sealed = fleetCrypto.seal(fleetKey(e), value, aad);
            return { e, d, ...sealed, sig: fleetCrypto.sign(openIdentity(), `${aad}\n${d}\n${sealed.iv}\n${sealed.ct}`) };
        },
        /** The value of a record from the sync log, or null when it does not open or verify. */
        openRecord(k, blob) {
            const fleet = read().fleet;
            if (!fleet || !blob) return null;
            const writer = read().roster[blob.d] || read().former[blob.d];
            if (!writer?.signPublic) return null;
            const aad = `sync\n${fleet.id}\n${k}\n${blob.e}`;
            if (!fleetCrypto.verify(writer.signPublic, `${aad}\n${blob.d}\n${blob.iv}\n${blob.ct}`, blob.sig)) return null;
            const key = fleetKey(blob.e);
            if (!key) return null;
            try {
                return fleetCrypto.open(key, blob, aad);
            } catch {
                return null;
            }
        },
        /** Be the one device to do something: the first to claim a name has it until `ttl`. */
        async claim(name, ttl) {
            const answer = await client.call({ t: 'claim', k: fleetCrypto.recordKey(fleetCrypto.indexKeyFrom(fleetKey(Math.min(...Object.keys(read().fleet.keys).map(Number)))), `claim\n${name}`), ttl });
            return { won: Boolean(answer.won), by: answer.by };
        },
        /** Settings of the app's own that live beside the fleet state (hub mode). */
        extra: () => read().extra,
        saveExtra(patch) {
            Object.assign(read().extra, patch || {});
            persist();
        },
    };
}

module.exports = { createDevice };
