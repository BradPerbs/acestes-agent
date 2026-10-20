/**
 * Where a scheduled job runs, when the user has Acestes on several computers.
 *
 * Jobs are synced, so every device has every job and every device's
 * scheduler finds it due. The gate decides which one runs it:
 *
 *   Pinned to a device: that one, and no other. A job that needs a
 *   particular machine's desktop or files is pinned to it.
 *
 *   Any device (the default): the device the job was made on goes first,
 *   then the others that are on, in a fixed order, each a grace period
 *   later. The first to claim the tick on the relay runs it, so it runs
 *   once, and when the first device is off the next one takes it.
 *
 *   A locked device runs only its own jobs: locking is the user saying the
 *   other computers may not have this one do anything.
 *
 *   Not connected to the relay: only the job's own device runs it, so a
 *   network split cannot run a job twice.
 *
 * The claim names the tick. A cron or one-shot job's tick is its due time,
 * the same on every device. An interval job's due time is reckoned from
 * when each device last saw it run, so the devices disagree by seconds;
 * its claim is a lease for most of an interval instead, which whoever takes
 * it first holds.
 */

const GRACE_MS = 20 * 1000;
const TICK_TTL_MS = 24 * 60 * 60 * 1000;
const EVENT_WINDOW_MS = 5 * 60 * 1000;

function claimFor(job, { source = 'schedule', event = '', hostId = '' } = {}, now = Date.now()) {
    if (source === 'event') {
        return { name: `${job.id}#event#${event}#${hostId}#${Math.floor(now / EVENT_WINDOW_MS)}`, ttl: EVENT_WINDOW_MS * 2 };
    }
    const kind = job.schedule?.kind;
    if (kind === 'every' || kind === 'heartbeat') {
        const interval = Number(job.schedule.everyMs) || 60 * 1000;
        return { name: `${job.id}#lease`, ttl: Math.max(60 * 1000, Math.floor(interval * 0.8)) };
    }
    return { name: `${job.id}#${job.nextRunAt || Math.floor(now / 60000)}`, ttl: TICK_TTL_MS };
}

function createGate({ device, placementOf, locked, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), graceMs = GRACE_MS, now = () => Date.now() }) {
    /** Whether this device runs this job this time. Never throws. */
    return async function gate(job, options = {}) {
        if (!device.inFleet()) return true;
        const self = device.selfId();
        const place = placementOf(job.id) || {};
        const origin = place.origin || self;
        const pinned = place.placement && place.placement !== 'any' ? place.placement : '';

        if (pinned) return pinned === self;
        if (locked() && origin !== self) return false;
        if (!device.isConnected()) return origin === self;

        // The job's own device first, then the rest by id: the same order on every device.
        const others = device.devices()
            .filter(entry => entry.online && entry.id !== origin && !(entry.info?.locked))
            .map(entry => entry.id)
            .sort();
        const order = [origin, ...others];
        let rank = order.indexOf(self);
        if (rank < 0) rank = order.length;
        if (rank > 0) await wait(rank * graceMs);

        const claim = claimFor(job, options, now());
        try {
            const { won } = await device.claim(claim.name, claim.ttl);
            return won;
        } catch {
            // The relay went while waiting: the same rule as being offline.
            return origin === self;
        }
    };
}

module.exports = { createGate, claimFor, GRACE_MS };
