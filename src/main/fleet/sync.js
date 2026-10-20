const crypto = require('crypto');

/**
 * Sync: every device in the fleet holding the same agents, settings,
 * inventory, secrets, memory and jobs.
 *
 * The unit is a record: a collection ('hosts', 'memory', ...), an id, and a
 * value, or null for one that was deleted. Each change is stamped with a
 * hybrid logical clock (wall time, a counter, the device id), and the newest
 * stamp wins, record by record. That is last-writer-wins, which is what
 * people expect of a setting or a host and is right for everything synced
 * here: no record is edited by two machines at once often enough to need
 * more, and when it is, the later edit is the one the person last saw.
 *
 * Records travel through the relay's sync log (relay-core.js): the latest
 * sealed copy of each, under a name the relay cannot read, numbered as it
 * arrives. A device pulls what is newer than the last number it read, so one
 * that was off for a month reads exactly what changed, once.
 *
 * Local changes are found by looking, not by hooking every write: each
 * collection is listed, each record hashed, and a hash that moved is a change
 * to stamp and publish. The stores' own change signals trigger a look within
 * a second; a slow timer catches anything else. A record applied from the
 * fleet is hashed as it reads back after applying, so the store's own
 * tidying of it is not taken for an edit and sent back.
 *
 * Joining: a device pulls the whole log before it looks at its own records
 * for the first time. So where the fleet and the newcomer both have a record
 * (the default agent every install starts with), the fleet's copy wins, and
 * what only the newcomer had is published to the others.
 *
 * Each collection is `{ list(), apply(id, value), subscribe?(fn) }`:
 *   list()            -> { id: value } of every record, plain JSON
 *   apply(id, value)  write it, or delete it when value is null
 *   subscribe(fn)     call fn when the store changes; returns an unsubscribe
 */

const SCAN_DEBOUNCE_MS = 1000;
const SCAN_EVERY_MS = 20 * 1000;
const PULL_EVERY_MS = 60 * 1000;
const PUT_BATCH = 40;
const MAX_RECORD_BYTES = 400 * 1024;

/** JSON with the keys in order, so the same value always hashes the same. */
function stable(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
        .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

const hashOf = value => (value === null || value === undefined
    ? null
    : crypto.createHash('sha256').update(stable(value)).digest('base64url').slice(0, 32));

function createSync({ device, collections, persist, now = () => Date.now(), onApplied = () => {}, timers = true }) {
    let state = null;
    let scanTimer = null;
    let busy = false;
    let lastError = '';
    let lastSyncAt = 0;
    const values = {};
    const unsubscribers = [];
    let intervals = [];

    function load() {
        if (state) return state;
        const raw = persist.load() || {};
        state = {
            fleetId: typeof raw.fleetId === 'string' ? raw.fleetId : '',
            clock: raw.clock && Number.isFinite(raw.clock.ms) ? raw.clock : { ms: 0, c: 0 },
            cursor: Number(raw.cursor) || 0,
            primed: Boolean(raw.primed),
            records: raw.records && typeof raw.records === 'object' ? raw.records : {},
        };
        return state;
    }

    const save = () => persist.save(load());

    /** A new fleet (joined, or left and joined another) starts from nothing. */
    function forFleet(fleetId) {
        const current = load();
        if (current.fleetId === fleetId) return current;
        state = { fleetId, clock: current.clock, cursor: 0, primed: false, records: {} };
        save();
        return state;
    }

    /* ---------------- the clock ---------------- */

    const pad = (number, width) => String(number).padStart(width, '0');

    function tick() {
        const clock = load().clock;
        const wall = now();
        if (wall > clock.ms) {
            clock.ms = wall;
            clock.c = 0;
        } else {
            clock.c += 1;
        }
        return `${pad(clock.ms, 14)}.${pad(clock.c, 6)}.${device.selfId()}`;
    }

    /** Never stamp anything older than a stamp already seen. */
    function observe(stamp) {
        const [ms, c] = String(stamp).split('.').map(Number);
        const clock = load().clock;
        if (!Number.isFinite(ms)) return;
        if (ms > clock.ms || (ms === clock.ms && c > clock.c)) {
            clock.ms = ms;
            clock.c = c;
        }
    }

    /* ---------------- looking for local changes ---------------- */

    async function listAll(name) {
        const listed = (await collections[name].list()) || {};
        values[name] = listed;
        return listed;
    }

    /** Stamp every record whose hash moved since it was last stamped or applied. */
    async function stamp() {
        const current = load();
        let changed = false;
        for (const name of Object.keys(collections)) {
            let listed;
            try {
                listed = await listAll(name);
            } catch (error) {
                console.error(`Sync could not read ${name}:`, error.message);
                continue;
            }
            const records = current.records[name] || (current.records[name] = {});
            for (const [id, value] of Object.entries(listed)) {
                const h = hashOf(value);
                if (records[id]?.h !== h) {
                    records[id] = { t: tick(), h, p: 1 };
                    changed = true;
                }
            }
            for (const [id, record] of Object.entries(records)) {
                if (!(id in listed) && record.h !== null) {
                    // Held but not listable right now: not a delete.
                    if (typeof collections[name].present === 'function' && collections[name].present(id)) continue;
                    records[id] = { t: tick(), h: null, p: 1 };
                    changed = true;
                }
            }
        }
        if (changed) save();
    }

    /* ---------------- receiving ---------------- */

    /** Apply records from the log that are newer than ours. Returns the collections touched. */
    async function ingest(entries) {
        const current = load();
        const applied = {};
        for (const entry of entries) {
            const record = device.openRecord(entry.k, entry.blob);
            if (!record || !collections[record.c] || typeof record.i !== 'string') continue;
            observe(record.t);
            const records = current.records[record.c] || (current.records[record.c] = {});
            const local = records[record.i];
            if (local && local.t >= record.t) continue;
            try {
                await collections[record.c].apply(record.i, record.v === undefined ? null : record.v);
            } catch (error) {
                console.error(`Sync could not apply ${record.c} ${record.i}:`, error.message);
            }
            records[record.i] = { t: record.t, h: hashOf(record.v) };
            (applied[record.c] || (applied[record.c] = new Set())).add(record.i);
        }
        // Hashed as they read back, so a store that tidies a record on the
        // way in does not see its own tidying as an edit.
        for (const [name, ids] of Object.entries(applied)) {
            let listed = {};
            try {
                listed = await listAll(name);
            } catch {
                listed = {};
            }
            for (const id of ids) {
                const record = current.records[name][id];
                if (record.h === null && id in listed) continue;
                record.h = hashOf(id in listed ? listed[id] : null);
            }
        }
        return Object.keys(applied);
    }

    async function pullAll() {
        const current = load();
        const touched = new Set();
        let more = true;
        while (more) {
            const batch = await device.relayCall({ t: 'log.pull', since: current.cursor, limit: 200 }, { timeout: 60000 });
            for (const name of await ingest(batch.entries || [])) touched.add(name);
            for (const entry of batch.entries || []) current.cursor = Math.max(current.cursor, Number(entry.seq) || 0);
            more = Boolean(batch.more);
            save();
        }
        return touched;
    }

    /* ---------------- sending ---------------- */

    async function publish() {
        const current = load();
        const touched = new Set();
        const waiting = [];
        for (const [name, records] of Object.entries(current.records)) {
            for (const [id, record] of Object.entries(records)) if (record.p) waiting.push({ name, id, record });
        }
        for (let start = 0; start < waiting.length; start += PUT_BATCH) {
            const entries = [];
            for (const { name, id, record } of waiting.slice(start, start + PUT_BATCH)) {
                if (record.h !== null && !(values[name] && id in values[name])) await listAll(name);
                const value = record.h === null ? null : values[name]?.[id];
                if (record.h !== null && value === undefined) continue;
                const k = device.recordKey(`${name}\n${id}`);
                const blob = device.sealRecord(k, { c: name, i: id, t: record.t, v: value });
                if (JSON.stringify(blob).length > MAX_RECORD_BYTES) {
                    console.error(`Sync skipped ${name} ${id}: too large to send.`);
                    delete record.p;
                    continue;
                }
                entries.push({ k, blob, name, id, t: record.t });
            }
            if (entries.length === 0) continue;
            const answer = await device.relayCall({
                t: 'log.put',
                entries: entries.map(({ k, blob, t }) => ({ k, blob, t })),
            }, { timeout: 60000 });
            for (const entry of entries) {
                const record = current.records[entry.name]?.[entry.id];
                if (record && record.t === entry.t) delete record.p;
            }
            // Newer than ours on the relay: theirs wins, and is applied here.
            for (const name of await ingest(answer.stale || [])) touched.add(name);
            save();
        }
        return touched;
    }

    /* ---------------- a round ---------------- */

    /**
     * Stamp, pull, publish, in that order and one round at a time: a local
     * edit is stamped before anything from the fleet is weighed against it,
     * and nothing is sent until the newer copies have been read.
     */
    async function round() {
        if (!device.inFleet()) return;
        const current = forFleet(device.fleetId());
        if (current.primed) await stamp();
        if (!device.isConnected()) return;
        const touched = await pullAll();
        if (!current.primed) {
            // Joined: the fleet's copies are in. A collection may set aside
            // what a fresh install made for itself before ours go out.
            for (const [name, collection] of Object.entries(collections)) {
                if (typeof collection.onPrime !== 'function') continue;
                const fleetHas = new Set(Object.entries(current.records[name] || {})
                    .filter(([, record]) => record.h !== null)
                    .map(([id]) => id));
                try {
                    await collection.onPrime(fleetHas);
                } catch (error) {
                    console.error(`Sync could not settle ${name} on joining:`, error.message);
                }
            }
            current.primed = true;
            save();
            await stamp();
        }
        for (const name of await publish()) touched.add(name);
        lastSyncAt = now();
        lastError = '';
        if (touched.size > 0) {
            try {
                onApplied([...touched]);
            } catch (error) {
                console.error('Sync change handler failed:', error.message);
            }
        }
    }

    let queue = Promise.resolve();
    let queued = null;

    /** Run a round after the one going, if any. Calls in the meantime share it. */
    function sync() {
        if (queued) return queued;
        queued = queue.then(async () => {
            queued = null;
            busy = true;
            try {
                await round();
            } catch (error) {
                lastError = error.message;
            } finally {
                busy = false;
            }
        });
        queue = queued;
        return queued;
    }

    function scheduleScan(delay = SCAN_DEBOUNCE_MS) {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => {
            scanTimer = null;
            sync();
        }, delay);
        scanTimer.unref?.();
    }

    /* ---------------- running ---------------- */

    function start() {
        for (const collection of Object.values(collections)) {
            if (typeof collection.subscribe === 'function') {
                const off = collection.subscribe(() => scheduleScan());
                if (typeof off === 'function') unsubscribers.push(off);
            }
        }
        unsubscribers.push(device.onRelay((frame) => {
            if (frame.t === 'ready' || frame.t === 'log.new') sync();
        }));
        if (timers) {
            intervals = [
                setInterval(() => sync(), SCAN_EVERY_MS),
                setInterval(() => sync(), PULL_EVERY_MS),
            ];
            for (const timer of intervals) timer.unref?.();
        }
        if (device.inFleet()) sync();
    }

    function stop() {
        clearTimeout(scanTimer);
        for (const timer of intervals) clearInterval(timer);
        intervals = [];
        while (unsubscribers.length) unsubscribers.pop()();
    }

    function status() {
        const current = load();
        let pending = 0;
        const counts = {};
        for (const [name, records] of Object.entries(current.records)) {
            counts[name] = Object.values(records).filter(record => record.h !== null).length;
            pending += Object.values(records).filter(record => record.p).length;
        }
        return { primed: current.primed, pending, counts, lastSyncAt, lastError, busy };
    }

    // `scan` and `pull` are both a round now; the names stay for the callers.
    return { start, stop, sync, scan: sync, pull: sync, status, scheduleScan };
}

module.exports = { createSync, stable, hashOf };
