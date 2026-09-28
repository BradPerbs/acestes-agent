const crypto = require('crypto');
const { Cron } = require('croner');
const database = require('./db');

/**
 * Jobs: what starts a run when nobody is at the keyboard.
 *
 * A job is a prompt, a schedule, and the policy the run gets. Six kinds of
 * schedule, taken from what the reference harnesses settled on:
 *
 *   at         once, at a moment ("in 20m", an ISO date)
 *   every      a fixed interval
 *   cron       a five- or six-field expression, in a timezone
 *   event      a thing that happened in the app: a monitored host going
 *              offline or coming back
 *   webhook    a POST to the app's loopback endpoint, with a token
 *   heartbeat  a fixed interval with a probe in front of it: a local command
 *              that runs first, and only wakes the agent if it has something
 *              to say
 *
 * The scheduler in scheduler.js reads `next_run_at` and does the firing;
 * this file owns the records, the schedule arithmetic (through Croner, so
 * timezones and DST are its problem), and the backoff bookkeeping.
 */

const KINDS = new Set(['at', 'every', 'cron', 'event', 'webhook', 'heartbeat']);
const EVENTS = new Set(['host-offline', 'host-online']);
const MISSED = new Set(['skip', 'catchup']);
const SESSIONS = new Set(['isolated']);

/** Retry delays after consecutive failures, then the job is switched off. */
const BACKOFF_MS = [30000, 60000, 5 * 60000, 15 * 60000, 60 * 60000];
const MAX_FAILURES = 10;

const MIN_EVERY_MS = 60000;
const MAX_NAME = 120;
const MAX_PROMPT = 20000;

let notify = () => {};
let counter = 0;

function setNotifier(fn) {
    notify = fn || (() => {});
}

function nextId() {
    counter += 1;
    return `job-${Date.now().toString(36)}-${counter.toString(36)}`;
}

const json = (value) => JSON.stringify(value ?? {});
const parse = (text, fallback = {}) => {
    try {
        return text ? JSON.parse(text) : fallback;
    } catch {
        return fallback;
    }
};
const clean = (value, max = MAX_NAME) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/* ------------------------------------------------------------------ *
 * Schedules
 * ------------------------------------------------------------------ */

const UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 7 * 86400000 };

/** "20m", "2h", "1d" to milliseconds, or null. */
function spanMs(text) {
    const found = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i.exec(String(text || '').trim());
    if (!found) return null;
    const unit = found[2][0].toLowerCase();
    return Math.round(Number(found[1]) * UNITS[unit]);
}

/**
 * Read a schedule as the user or the agent wrote it.
 *
 * Takes an object with a `kind`, or a string in one of the shapes people
 * actually type: "in 20m", "every 2h", "at 2026-09-03T09:00", an ISO date,
 * or a cron expression. Answers `{ error }` when it is none of those, with
 * the reason, so a job is never saved with a schedule that will never fire.
 */
function parseSchedule(input, now = Date.now()) {
    if (input && typeof input === 'object') return normalizeSchedule(input, now);
    const text = String(input || '').trim();
    if (!text) return { error: 'A schedule is needed.' };

    const relative = /^in\s+(.+)$/i.exec(text);
    if (relative) {
        const ms = spanMs(relative[1]);
        if (!ms) return { error: `Could not read "${relative[1]}" as a delay. Try "in 20m" or "in 2h".` };
        return normalizeSchedule({ kind: 'at', at: now + ms }, now);
    }
    const interval = /^every\s+(.+)$/i.exec(text);
    if (interval) {
        const ms = spanMs(interval[1]);
        if (!ms) return { error: `Could not read "${interval[1]}" as an interval. Try "every 30m" or "every 2h".` };
        return normalizeSchedule({ kind: 'every', everyMs: ms }, now);
    }
    const at = /^at\s+(.+)$/i.exec(text);
    if (at) return normalizeSchedule({ kind: 'at', at: at[1] }, now);

    const fields = text.split(/\s+/);
    if ((fields.length === 5 || fields.length === 6) && /[\d*]/.test(fields[0])) {
        return normalizeSchedule({ kind: 'cron', expr: text }, now);
    }
    const stamp = Date.parse(text);
    if (Number.isFinite(stamp)) return normalizeSchedule({ kind: 'at', at: stamp }, now);

    return { error: `Could not read "${text}" as a schedule. Use "in 20m", "every 2h", a cron expression like "0 9 * * 1", or a date.` };
}

function normalizeSchedule(raw, now = Date.now()) {
    const kind = KINDS.has(raw.kind) ? raw.kind : '';
    if (!kind) return { error: `Unknown schedule kind "${raw.kind}".` };

    switch (kind) {
        case 'at': {
            const stamp = typeof raw.at === 'number' ? raw.at : Date.parse(String(raw.at || ''));
            if (!Number.isFinite(stamp)) return { error: 'An "at" schedule needs a date or time.' };
            if (stamp < now - 60000) return { error: 'That time has already passed.' };
            return { schedule: { kind, at: stamp } };
        }
        case 'every':
        case 'heartbeat': {
            const everyMs = typeof raw.everyMs === 'number' ? raw.everyMs : spanMs(raw.every);
            if (!everyMs || everyMs < MIN_EVERY_MS) return { error: 'An interval has to be at least one minute.' };
            const schedule = { kind, everyMs };
            if (kind === 'heartbeat') {
                const probe = raw.probe && typeof raw.probe === 'object' ? raw.probe : { command: raw.probe };
                const command = clean(probe.command, 2000);
                if (!command) return { error: 'A heartbeat needs a probe command to run first.' };
                schedule.probe = { command, cwd: clean(probe.cwd, 1000) };
            }
            return { schedule };
        }
        case 'cron': {
            const expr = clean(raw.expr || raw.cron, 120);
            const tz = clean(raw.tz || raw.timezone, 80);
            if (!expr) return { error: 'A cron schedule needs an expression.' };
            try {
                const trial = new Cron(expr, { paused: true, ...(tz ? { timezone: tz } : {}) });
                const next = trial.nextRun();
                trial.stop();
                if (!next) return { error: 'That cron expression never fires.' };
            } catch (error) {
                return { error: `That is not a valid cron expression: ${error.message}` };
            }
            return { schedule: { kind, expr, ...(tz ? { tz } : {}) } };
        }
        case 'event': {
            const event = clean(raw.event, 40);
            if (!EVENTS.has(event)) return { error: `Unknown event "${event}". Use host-offline or host-online.` };
            return { schedule: { kind, event, hostId: clean(raw.hostId, 80) } };
        }
        case 'webhook':
            return { schedule: { kind } };
        default:
            return { error: `Unknown schedule kind "${kind}".` };
    }
}

/**
 * When a job fires next, or null when it never will on its own.
 *
 * Event and webhook jobs have no next time; they wait. An interval counts
 * from the last run, or from now for a job that has never run, so a job
 * made at noon "every 30m" first fires at half past.
 */
function nextRunAt(job, now = Date.now()) {
    const schedule = job.schedule || {};
    switch (schedule.kind) {
        case 'at':
            return job.runCount > 0 ? null : schedule.at;
        case 'every':
        case 'heartbeat':
            return (job.lastRunAt || now) + schedule.everyMs;
        case 'cron': {
            try {
                const cron = new Cron(schedule.expr, { paused: true, ...(schedule.tz ? { timezone: schedule.tz } : {}) });
                const next = cron.nextRun(new Date(now));
                cron.stop();
                return next ? next.getTime() : null;
            } catch {
                return null;
            }
        }
        default:
            return null;
    }
}

function describeSchedule(schedule) {
    switch (schedule?.kind) {
        case 'at': return `once, at ${new Date(schedule.at).toLocaleString()}`;
        case 'every': return `every ${describeSpan(schedule.everyMs)}`;
        case 'heartbeat': return `every ${describeSpan(schedule.everyMs)}, after the probe`;
        case 'cron': return `cron ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
        case 'event': return `when a host goes ${schedule.event === 'host-online' ? 'online' : 'offline'}`;
        case 'webhook': return 'on a webhook';
        default: return '';
    }
}

function describeSpan(ms) {
    if (ms % UNITS.d === 0) return `${ms / UNITS.d}d`;
    if (ms % UNITS.h === 0) return `${ms / UNITS.h}h`;
    if (ms % UNITS.m === 0) return `${ms / UNITS.m}m`;
    return `${Math.round(ms / 1000)}s`;
}

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

function normalizePolicy(raw) {
    const runs = require('./index');
    const policy = runs.normalizePolicy(raw);
    // A job that says nothing about approvals parks on the first write,
    // which is the one default that is safe with nobody watching.
    if (policy.approvals === 'inherit') policy.approvals = 'park';
    return policy;
}

function normalizeDelivery(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const webhook = clean(source.webhook, 500);
    return {
        notify: source.notify === undefined ? true : Boolean(source.notify),
        webhook: /^https?:\/\//i.test(webhook) ? webhook : '',
        file: clean(source.file, 1000),
    };
}

function rowToJob(row) {
    if (!row) return null;
    const schedule = parse(row.schedule);
    return {
        id: row.id,
        agentId: row.agent_id,
        name: row.name,
        enabled: Boolean(row.enabled),
        schedule,
        scheduleText: describeSchedule(schedule),
        prompt: row.prompt,
        session: row.session,
        policy: parse(row.policy),
        provider: row.provider || '',
        model: row.model,
        effort: row.effort,
        delivery: parse(row.delivery),
        missed: row.missed,
        keepAfterRun: Boolean(row.keep_after_run),
        createdBy: row.created_by,
        token: row.token,
        lastRunAt: row.last_run_at,
        lastStatus: row.last_status,
        nextRunAt: row.next_run_at,
        failures: row.failures,
        runCount: row.run_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function get(jobId) {
    const db = database.open();
    return rowToJob(db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId));
}

function list({ agentId = '', enabled = null } = {}) {
    const db = database.open();
    const where = [];
    const values = [];
    if (agentId) { where.push('agent_id = ?'); values.push(agentId); }
    if (enabled !== null) { where.push('enabled = ?'); values.push(enabled ? 1 : 0); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM jobs ${clause} ORDER BY updated_at DESC`).all(...values).map(rowToJob);
}

function create(raw = {}, now = Date.now()) {
    const name = clean(raw.name);
    if (!name) return { error: 'A job needs a name.' };
    const agentId = clean(raw.agentId, 80);
    if (!agentId) return { error: 'A job belongs to an agent.' };
    const parsed = parseSchedule(raw.schedule, now);
    if (parsed.error) return { error: parsed.error };
    const prompt = String(raw.prompt || '').trim().slice(0, MAX_PROMPT);
    if (!prompt && parsed.schedule.kind !== 'heartbeat') return { error: 'A job needs a prompt: what the agent should do.' };

    const session = SESSIONS.has(raw.session) ? raw.session : (clean(raw.session, 80) || 'isolated');
    const job = {
        id: nextId(),
        agentId,
        name,
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
        schedule: parsed.schedule,
        prompt,
        session,
        policy: normalizePolicy(raw.policy),
        provider: clean(raw.provider, 40),
        model: clean(raw.model, 160),
        effort: clean(raw.effort, 20),
        delivery: normalizeDelivery(raw.delivery),
        missed: MISSED.has(raw.missed) ? raw.missed : 'skip',
        keepAfterRun: Boolean(raw.keepAfterRun),
        createdBy: raw.createdBy === 'agent' ? 'agent' : 'user',
        token: parsed.schedule.kind === 'webhook' ? crypto.randomBytes(24).toString('base64url') : '',
    };
    const next = job.enabled ? nextRunAt({ ...job, runCount: 0, lastRunAt: null }, now) : null;

    const db = database.open();
    db.prepare(`
        INSERT INTO jobs (id, agent_id, name, enabled, schedule, prompt, session, policy, provider, model, effort, delivery, missed,
                          keep_after_run, created_by, token, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.agentId, job.name, job.enabled ? 1 : 0, json(job.schedule), job.prompt, job.session,
        json(job.policy), job.provider, job.model, job.effort, json(job.delivery), job.missed, job.keepAfterRun ? 1 : 0,
        job.createdBy, job.token, next, now, now);
    const saved = get(job.id);
    notify('jobs-changed', { jobId: job.id, agentId });
    return { job: saved };
}

function update(jobId, patch = {}, now = Date.now()) {
    const existing = get(jobId);
    if (!existing) return { error: 'No such job.' };

    const next = { ...existing };
    if (patch.name !== undefined) {
        const name = clean(patch.name);
        if (!name) return { error: 'A job needs a name.' };
        next.name = name;
    }
    if (patch.schedule !== undefined) {
        const parsed = parseSchedule(patch.schedule, now);
        if (parsed.error) return { error: parsed.error };
        next.schedule = parsed.schedule;
        if (parsed.schedule.kind === 'webhook' && !next.token) next.token = crypto.randomBytes(24).toString('base64url');
        // A new schedule is a fresh start for the counters that drive it.
        next.runCount = 0;
        next.lastRunAt = null;
        next.failures = 0;
    }
    if (patch.prompt !== undefined) next.prompt = String(patch.prompt || '').trim().slice(0, MAX_PROMPT);
    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.session !== undefined) next.session = SESSIONS.has(patch.session) ? patch.session : (clean(patch.session, 80) || 'isolated');
    if (patch.policy !== undefined) next.policy = normalizePolicy(patch.policy);
    if (patch.provider !== undefined) next.provider = clean(patch.provider, 40);
    if (patch.model !== undefined) next.model = clean(patch.model, 160);
    if (patch.effort !== undefined) next.effort = clean(patch.effort, 20);
    if (patch.delivery !== undefined) next.delivery = normalizeDelivery({ ...existing.delivery, ...patch.delivery });
    if (patch.missed !== undefined && MISSED.has(patch.missed)) next.missed = patch.missed;
    if (patch.keepAfterRun !== undefined) next.keepAfterRun = Boolean(patch.keepAfterRun);
    if (patch.enabled === true && !existing.enabled) next.failures = 0;

    const nextRun = next.enabled ? nextRunAt(next, now) : null;
    const db = database.open();
    db.prepare(`
        UPDATE jobs SET name = ?, enabled = ?, schedule = ?, prompt = ?, session = ?, policy = ?, provider = ?, model = ?, effort = ?,
                        delivery = ?, missed = ?, keep_after_run = ?, token = ?, last_run_at = ?, run_count = ?, failures = ?,
                        next_run_at = ?, updated_at = ?
        WHERE id = ?
    `).run(next.name, next.enabled ? 1 : 0, json(next.schedule), next.prompt, next.session, json(next.policy), next.provider, next.model,
        next.effort, json(next.delivery), next.missed, next.keepAfterRun ? 1 : 0, next.token, next.lastRunAt, next.runCount,
        next.failures, nextRun, now, jobId);
    const saved = get(jobId);
    notify('jobs-changed', { jobId, agentId: saved.agentId });
    return { job: saved };
}

function remove(jobId) {
    const db = database.open();
    const job = get(jobId);
    const result = db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    if (result.changes) notify('jobs-changed', { jobId, agentId: job?.agentId || '', removed: true });
    return Boolean(result.changes);
}

/** Jobs whose time has come. */
function due(now = Date.now()) {
    const db = database.open();
    return db.prepare('SELECT * FROM jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at')
        .all(now).map(rowToJob);
}

/** Jobs waiting on an event, whichever host it names. */
function listeners(event, hostId = '') {
    return list({ enabled: true }).filter(job => (
        job.schedule.kind === 'event' && job.schedule.event === event
        && (!job.schedule.hostId || job.schedule.hostId === hostId)
    ));
}

/** A webhook job by its token, in constant time. */
function byToken(jobId, token) {
    const job = get(jobId);
    if (!job || job.schedule.kind !== 'webhook' || !job.enabled || !job.token) return null;
    const a = Buffer.from(String(token || ''));
    const b = Buffer.from(job.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? job : null;
}

/**
 * The job has fired: count it, and move its next time on.
 *
 * Written before the run does anything, so a crash mid-run cannot fire the
 * same job again on the next launch and again on the one after.
 */
function fired(jobId, now = Date.now()) {
    const job = get(jobId);
    if (!job) return null;
    const next = { ...job, lastRunAt: now, runCount: job.runCount + 1 };
    const db = database.open();
    db.prepare('UPDATE jobs SET last_run_at = ?, run_count = ?, last_status = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(now, next.runCount, 'running', nextRunAt(next, now), now, jobId);
    const saved = get(jobId);
    notify('jobs-changed', { jobId, agentId: saved.agentId });
    return saved;
}

/**
 * The run a job started has ended.
 *
 * Success clears the failure count. A failure counts, pushes the next run
 * out on the backoff ladder, and after enough of them switches the job off
 * rather than letting it fail every night for a month. A one-shot job that
 * succeeded is deleted unless it was asked to stay; one that failed stays,
 * disabled, so the failure can be looked at.
 */
function completed(jobId, status, now = Date.now()) {
    const job = get(jobId);
    if (!job) return { job: null, disabled: false, removed: false };
    const db = database.open();
    const ok = status === 'done';

    if (job.schedule.kind === 'at') {
        if (ok && !job.keepAfterRun) {
            remove(jobId);
            return { job: null, disabled: false, removed: true };
        }
        db.prepare('UPDATE jobs SET enabled = 0, last_status = ?, next_run_at = NULL, failures = ?, updated_at = ? WHERE id = ?')
            .run(status, ok ? 0 : job.failures + 1, now, jobId);
        const saved = get(jobId);
        notify('jobs-changed', { jobId, agentId: saved.agentId });
        return { job: saved, disabled: true, removed: false };
    }

    if (ok) {
        db.prepare('UPDATE jobs SET last_status = ?, failures = 0, next_run_at = ?, updated_at = ? WHERE id = ?')
            .run(status, nextRunAt(job, now), now, jobId);
        const saved = get(jobId);
        notify('jobs-changed', { jobId, agentId: saved.agentId });
        return { job: saved, disabled: false, removed: false };
    }

    const failures = job.failures + 1;
    if (failures >= MAX_FAILURES) {
        db.prepare('UPDATE jobs SET last_status = ?, failures = ?, enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?')
            .run(status, failures, now, jobId);
        const saved = get(jobId);
        notify('jobs-changed', { jobId, agentId: saved.agentId });
        return { job: saved, disabled: true, removed: false };
    }
    const scheduled = nextRunAt(job, now);
    const backoff = now + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    // Whichever comes first: a job due in five minutes anyway is not made
    // later by a failure, and one due tomorrow is retried sooner.
    const next = scheduled ? Math.min(scheduled, backoff) : backoff;
    db.prepare('UPDATE jobs SET last_status = ?, failures = ?, next_run_at = ?, updated_at = ? WHERE id = ?')
        .run(status, failures, next, now, jobId);
    const saved = get(jobId);
    notify('jobs-changed', { jobId, agentId: saved.agentId });
    return { job: saved, disabled: false, removed: false };
}

/**
 * On launch: jobs whose time passed while the app was closed.
 *
 * `skip` moves the job on to its next time; `catchup` leaves it due so the
 * scheduler fires it once, now. Neither fires it once per missed tick.
 */
function reconcile(now = Date.now()) {
    const caught = [];
    const db = database.open();
    for (const job of due(now - 60000)) {
        if (job.missed === 'catchup') {
            caught.push(job.id);
            continue;
        }
        const next = job.schedule.kind === 'at' ? job.nextRunAt : nextRunAt(job, now);
        db.prepare('UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ?').run(next, now, job.id);
    }
    return caught;
}

/**
 * Every job as a backup carries it. Run history stays behind: the runs table
 * is a log of what happened on this machine, while a job is setup worth
 * keeping. Execution state (last run, failures, counts) is reset on the way
 * in for the same reason; the schedule is recomputed from now.
 */
function exportAll() {
    return list().map(job => ({ ...job }));
}

/**
 * Bring jobs from a backup, matched on id. A webhook keeps its token (the
 * file is encrypted); everything else about when it fires is recomputed.
 * One-shot schedules whose time has passed are skipped.
 */
function importAll(records, { overwrite = false } = {}) {
    const now = Date.now();
    const result = { added: 0, replaced: 0, skipped: 0 };
    const incoming = Array.isArray(records) ? records : [];
    const db = database.open();

    for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') {
            result.skipped++;
            continue;
        }
        const id = clean(raw.id, 80);
        const name = clean(raw.name);
        const agentId = clean(raw.agentId, 80);
        if (!id || !name || !agentId) {
            result.skipped++;
            continue;
        }
        const parsed = parseSchedule(raw.schedule, now);
        if (parsed.error || !parsed.schedule) {
            result.skipped++;
            continue;
        }
        const existing = get(id);
        if (existing && !overwrite) {
            result.skipped++;
            continue;
        }
        const prompt = String(raw.prompt || '').trim().slice(0, MAX_PROMPT);
        if (!prompt && parsed.schedule.kind !== 'heartbeat') {
            result.skipped++;
            continue;
        }
        const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
        const job = {
            id,
            agentId,
            name,
            enabled,
            schedule: parsed.schedule,
            prompt,
            session: SESSIONS.has(raw.session) ? raw.session : (clean(raw.session, 80) || 'isolated'),
            policy: normalizePolicy(raw.policy),
            provider: clean(raw.provider, 40),
            model: clean(raw.model, 160),
            effort: clean(raw.effort, 20),
            delivery: normalizeDelivery(raw.delivery),
            missed: MISSED.has(raw.missed) ? raw.missed : 'skip',
            keepAfterRun: Boolean(raw.keepAfterRun),
            createdBy: raw.createdBy === 'agent' ? 'agent' : 'user',
            token: parsed.schedule.kind === 'webhook' && raw.token ? String(raw.token) : (parsed.schedule.kind === 'webhook' ? crypto.randomBytes(24).toString('base64url') : ''),
        };
        const next = job.enabled ? nextRunAt({ ...job, runCount: 0, lastRunAt: null }, now) : null;
        if (existing) db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
        db.prepare(`
            INSERT INTO jobs (id, agent_id, name, enabled, schedule, prompt, session, policy, provider, model, effort, delivery, missed,
                              keep_after_run, created_by, token, next_run_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(job.id, job.agentId, job.name, job.enabled ? 1 : 0, json(job.schedule), job.prompt, job.session,
            json(job.policy), job.provider, job.model, job.effort, json(job.delivery), job.missed, job.keepAfterRun ? 1 : 0,
            job.createdBy, job.token, next, now, now);
        if (existing) result.replaced++;
        else result.added++;
        notify('jobs-changed', { jobId: job.id, agentId: job.agentId });
    }
    return result;
}

module.exports = {
    setNotifier,
    parseSchedule,
    normalizeSchedule,
    nextRunAt,
    describeSchedule,
    spanMs,
    get,
    list,
    create,
    update,
    remove,
    exportAll,
    importAll,
    due,
    listeners,
    byToken,
    fired,
    completed,
    reconcile,
    KINDS,
    EVENTS,
    BACKOFF_MS,
    MAX_FAILURES,
};
