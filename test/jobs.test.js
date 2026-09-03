/**
 * Jobs and the scheduler: schedules as people write them, the arithmetic
 * for the next time, the backoff ladder, the overlap rule, the heartbeat
 * probe, and delivery of a run's outcome.
 *
 * `electron` is stubbed so it runs under plain node; the database goes in
 * a temporary directory. The scheduler is exercised through its exported
 * pieces with a fake runner, never a real provider.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-jobs-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: { handle: () => {}, on: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const jobs = require(path.join(ROOT, 'runs', 'jobs'));
const runs = require(path.join(ROOT, 'runs'));
const scheduler = require(path.join(ROOT, 'runs', 'scheduler'));
const db = require(path.join(ROOT, 'runs', 'db'));

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

const NOW = Date.parse('2026-09-02T12:00:00Z');

(async () => {
    console.log('\njobs');

    await check('schedules are read as people write them', () => {
        assert.strictEqual(jobs.parseSchedule('in 20m', NOW).schedule.at, NOW + 20 * 60000);
        assert.strictEqual(jobs.parseSchedule('every 2h', NOW).schedule.everyMs, 2 * 3600000);
        assert.strictEqual(jobs.parseSchedule('0 9 * * 1', NOW).schedule.kind, 'cron');
        assert.strictEqual(jobs.parseSchedule('2026-12-01T09:00:00Z', NOW).schedule.kind, 'at');
        assert.ok(/at least one minute/.test(jobs.parseSchedule('every 10s', NOW).error));
        assert.ok(/already passed/.test(jobs.parseSchedule('2020-01-01', NOW).error));
        assert.ok(/not a valid cron/.test(jobs.parseSchedule({ kind: 'cron', expr: '99 99 * * *' }, NOW).error));
        assert.ok(jobs.parseSchedule('tuesdays', NOW).error);
        assert.ok(/probe/.test(jobs.parseSchedule({ kind: 'heartbeat', every: '5m' }, NOW).error));
        assert.strictEqual(jobs.parseSchedule({ kind: 'heartbeat', every: '5m', probe: 'df -h' }, NOW).schedule.probe.command, 'df -h');
        assert.strictEqual(jobs.parseSchedule({ kind: 'event', event: 'host-offline', hostId: 'h1' }, NOW).schedule.hostId, 'h1');
        assert.ok(jobs.parseSchedule({ kind: 'event', event: 'earthquake' }, NOW).error);
    });

    await check('the next time follows the kind: once, from the last run, or from the cron table', () => {
        const once = { schedule: { kind: 'at', at: NOW + 1000 }, runCount: 0, lastRunAt: null };
        assert.strictEqual(jobs.nextRunAt(once, NOW), NOW + 1000);
        assert.strictEqual(jobs.nextRunAt({ ...once, runCount: 1 }, NOW), null, 'a one-shot that ran is done');
        const every = { schedule: { kind: 'every', everyMs: 3600000 }, runCount: 0, lastRunAt: null };
        assert.strictEqual(jobs.nextRunAt(every, NOW), NOW + 3600000, 'a fresh interval counts from now');
        assert.strictEqual(jobs.nextRunAt({ ...every, lastRunAt: NOW - 600000 }, NOW), NOW + 3000000, 'and from the last run after that');
        const cron = { schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'UTC' }, runCount: 0, lastRunAt: null };
        assert.strictEqual(new Date(jobs.nextRunAt(cron, NOW)).toISOString(), '2026-09-03T09:00:00.000Z');
        assert.strictEqual(jobs.nextRunAt({ schedule: { kind: 'webhook' } }, NOW), null);
    });

    await check('a job is created with a next time, the parking policy, and a token only for a webhook', () => {
        const made = jobs.create({ agentId: 'a', name: 'Disks', schedule: 'every 1h', prompt: 'Check disks' }, NOW);
        assert.ok(!made.error, made.error);
        assert.strictEqual(made.job.nextRunAt, NOW + 3600000);
        assert.strictEqual(made.job.policy.approvals, 'park');
        assert.strictEqual(made.job.token, '');
        assert.strictEqual(made.job.scheduleText, 'every 1h');
        const hook = jobs.create({ agentId: 'a', name: 'Alerts', schedule: { kind: 'webhook' }, prompt: 'Look into this' }, NOW);
        assert.ok(hook.job.token.length > 20);
        assert.strictEqual(hook.job.nextRunAt, null);
        assert.strictEqual(jobs.byToken(hook.job.id, hook.job.token).id, hook.job.id);
        assert.strictEqual(jobs.byToken(hook.job.id, 'wrong'), null);
        assert.ok(jobs.create({ agentId: 'a', name: '', schedule: 'every 1h', prompt: 'x' }).error);
        assert.ok(jobs.create({ agentId: 'a', name: 'No prompt', schedule: 'every 1h' }).error);
    });

    await check('firing moves the next time on and counts; success resets failures', () => {
        const job = jobs.create({ agentId: 'a', name: 'Tick', schedule: 'every 1h', prompt: 'x' }, NOW).job;
        const fired = jobs.fired(job.id, NOW + 3600000);
        assert.strictEqual(fired.runCount, 1);
        assert.strictEqual(fired.lastStatus, 'running');
        assert.strictEqual(fired.nextRunAt, NOW + 2 * 3600000, 'the next tick is an hour after this one');
        const done = jobs.completed(job.id, 'done', NOW + 3600000 + 5000).job;
        assert.strictEqual(done.lastStatus, 'done');
        assert.strictEqual(done.failures, 0);
    });

    await check('failures climb the backoff ladder and switch the job off at ten', () => {
        const job = jobs.create({ agentId: 'a', name: 'Flaky', schedule: 'every 1d', prompt: 'x' }, NOW).job;
        let at = NOW;
        const expected = [30000, 60000, 300000, 900000, 3600000, 3600000];
        for (let index = 0; index < expected.length; index += 1) {
            jobs.fired(job.id, at);
            const after = jobs.completed(job.id, 'failed', at).job;
            assert.strictEqual(after.failures, index + 1);
            assert.strictEqual(after.nextRunAt, at + expected[index], `retry ${index + 1} waits ${expected[index]}ms`);
            at = after.nextRunAt;
        }
        for (let index = expected.length; index < jobs.MAX_FAILURES - 1; index += 1) {
            jobs.fired(job.id, at);
            at = jobs.completed(job.id, 'failed', at).job.nextRunAt;
        }
        jobs.fired(job.id, at);
        const last = jobs.completed(job.id, 'failed', at);
        assert.strictEqual(last.disabled, true);
        assert.strictEqual(last.job.enabled, false);
        assert.strictEqual(last.job.nextRunAt, null);
        // Switching it back on clears the count.
        const back = jobs.update(job.id, { enabled: true }, at).job;
        assert.strictEqual(back.failures, 0);
        assert.ok(back.nextRunAt > at);
    });

    await check('a one-shot job is deleted after success and kept, disabled, after a failure', () => {
        const gone = jobs.create({ agentId: 'a', name: 'Once', schedule: 'in 5m', prompt: 'x' }, NOW).job;
        jobs.fired(gone.id, NOW + 300000);
        assert.strictEqual(jobs.completed(gone.id, 'done', NOW + 300000).removed, true);
        assert.strictEqual(jobs.get(gone.id), null);
        const kept = jobs.create({ agentId: 'a', name: 'Once more', schedule: 'in 5m', prompt: 'x', keepAfterRun: true }, NOW).job;
        jobs.fired(kept.id, NOW + 300000);
        const after = jobs.completed(kept.id, 'done', NOW + 300000);
        assert.strictEqual(after.removed, false);
        assert.strictEqual(after.job.enabled, false);
        const broken = jobs.create({ agentId: 'a', name: 'Once broken', schedule: 'in 5m', prompt: 'x' }, NOW).job;
        jobs.fired(broken.id, NOW + 300000);
        const failedOnce = jobs.completed(broken.id, 'failed', NOW + 300000);
        assert.strictEqual(failedOnce.job.enabled, false);
        assert.strictEqual(failedOnce.job.lastStatus, 'failed');
    });

    await check('missed ticks are skipped or caught up once, never replayed', () => {
        const skip = jobs.create({ agentId: 'a', name: 'Skip', schedule: 'every 1h', prompt: 'x' }, NOW - 5 * 3600000).job;
        const catchup = jobs.create({ agentId: 'a', name: 'Catch', schedule: 'every 1h', prompt: 'x', missed: 'catchup' }, NOW - 5 * 3600000).job;
        const caught = jobs.reconcile(NOW);
        assert.deepStrictEqual(caught, [catchup.id]);
        assert.ok(jobs.get(skip.id).nextRunAt > NOW, 'skipped forward past now');
        assert.ok(jobs.get(catchup.id).nextRunAt <= NOW, 'still due, once');
        assert.ok(jobs.due(NOW).some(job => job.id === catchup.id));
        assert.ok(!jobs.due(NOW).some(job => job.id === skip.id));
    });

    await check('event listeners match the event and, when named, the host', () => {
        const any = jobs.create({ agentId: 'a', name: 'Any down', schedule: { kind: 'event', event: 'host-offline' }, prompt: 'x' }).job;
        const one = jobs.create({ agentId: 'a', name: 'Web down', schedule: { kind: 'event', event: 'host-offline', hostId: 'web' }, prompt: 'x' }).job;
        const ids = (event, host) => jobs.listeners(event, host).map(job => job.id).sort();
        assert.deepStrictEqual(ids('host-offline', 'web'), [any.id, one.id].sort());
        assert.deepStrictEqual(ids('host-offline', 'db'), [any.id]);
        assert.deepStrictEqual(ids('host-online', 'web'), []);
    });

    console.log('\nscheduler');

    const started = [];
    const toasts = [];
    scheduler.start({
        runJob: async (job, options) => {
            started.push({ job: job.name, ...options });
            const run = runs.create({ agentId: job.agentId, kind: 'scheduled', jobId: job.id, title: job.name });
            runs.start(run.id);
            return { runId: run.id };
        },
        probe: async (job, probe) => (probe.command.includes('quiet')
            ? { success: true, exitCode: 0, stdout: '', stderr: '' }
            : { success: true, exitCode: 1, stdout: '/dev/sda1 97%', stderr: '' }),
        notifyUser: (toast) => toasts.push(toast),
        jobsNotifier: () => {},
    });
    scheduler.stop(); // The tick loop is not wanted in a test; the pieces are driven by hand.

    await check('a due job fires through the runner with its source, and is not fired again while its run is open', async () => {
        const job = jobs.create({ agentId: 'a', name: 'Report', schedule: 'every 1h', prompt: 'Report' }, NOW - 7200000).job;
        const first = await scheduler._test.fire(job, { source: 'schedule' });
        assert.ok(first.runId, 'a run was started');
        assert.ok(started.some(entry => entry.job === 'Report' && entry.source === 'schedule'), 'the runner saw it');
        assert.strictEqual(scheduler._test.busy(job), true);
        const second = await scheduler._test.fire(jobs.get(job.id), { source: 'schedule' });
        assert.strictEqual(second.skipped, true, 'the second tick is skipped, not stacked');
        assert.strictEqual(started.filter(entry => entry.job === 'Report').length, 1);
        // The run ends; the job hears about it through the run log and delivers.
        runs.finish(first.runId, { summary: 'All disks fine.' });
        assert.strictEqual(jobs.get(job.id).lastStatus, 'done');
        assert.ok(toasts.some(toast => toast.title === 'Report finished' && toast.body === 'All disks fine.'));
        assert.strictEqual(scheduler._test.busy(job), false);
    });

    await check('a heartbeat wakes the agent only when the probe has something to say', async () => {
        const quiet = jobs.create({ agentId: 'a', name: 'Quiet', schedule: { kind: 'heartbeat', every: '5m', probe: 'check quiet' }, prompt: 'Look' }, NOW).job;
        const before = started.length;
        const result = await scheduler._test.heartbeat(quiet);
        assert.strictEqual(result.quiet, true);
        assert.strictEqual(started.length, before, 'no run for a quiet probe');
        assert.strictEqual(jobs.get(quiet.id).lastStatus, 'done');

        const loud = jobs.create({ agentId: 'a', name: 'Loud', schedule: { kind: 'heartbeat', every: '5m', probe: 'check disks' }, prompt: 'Look' }, NOW).job;
        await scheduler._test.heartbeat(loud);
        const last = started[started.length - 1];
        assert.strictEqual(last.job, 'Loud');
        assert.strictEqual(last.source, 'heartbeat');
        assert.ok(/97%/.test(last.context), 'the probe output reaches the agent');
    });

    await check('a failed run is delivered with its reason and a failing runner counts as a failure', async () => {
        const job = jobs.create({ agentId: 'a', name: 'Breaks', schedule: 'every 1h', prompt: 'x' }, NOW).job;
        const fired = await scheduler._test.fire(job, {});
        runs.fail(fired.runId, 'The provider exploded.');
        assert.strictEqual(jobs.get(job.id).failures, 1);
        assert.ok(toasts.some(toast => toast.title === 'Breaks failed' && /exploded/.test(toast.body)));
    });

    await check('an event fires the jobs waiting on it with what happened', async () => {
        const job = jobs.create({ agentId: 'a', name: 'On down', schedule: { kind: 'event', event: 'host-offline' }, prompt: 'Investigate' }).job;
        const before = started.length;
        // `event` only answers while the loop is started; start it and stop it around the call.
        scheduler.start({});
        scheduler.event('host-offline', { hostId: 'web', detail: 'web-01 (10.0.0.1) is offline: timed out.' });
        await new Promise(resolve => setTimeout(resolve, 50));
        scheduler.stop();
        const fired = started.slice(before).find(entry => entry.job === 'On down');
        assert.ok(fired, 'the listener fired');
        assert.strictEqual(fired.source, 'event:host-offline');
        assert.ok(/web-01/.test(fired.context));
        assert.strictEqual(jobs.get(job.id).runCount, 1);
    });

    await check('keepAlive says whether any job is switched on', () => {
        assert.strictEqual(scheduler.keepAlive(), true);
        for (const job of jobs.list({ enabled: true })) jobs.update(job.id, { enabled: false });
        assert.strictEqual(scheduler.keepAlive(), false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    db.close();
    fs.rmSync(userData, { recursive: true, force: true });
    if (failed > 0) process.exit(1);
})();
