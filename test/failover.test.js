/**
 * Failover: telling a crash from a quit, which runs come back, the limits,
 * and the watchdog itself, run for real under node against a stand-in app:
 * a crash relaunches it, a quit does not, a hang is ended and relaunched,
 * too many restarts give up, and a stop is obeyed.
 *
 * `electron` is stubbed; everything is written under a temporary directory
 * and deleted at the end.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { fork, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-failover-'));

const quitHandlers = [];
const electronStub = {
    app: {
        getPath: () => userData,
        getVersion: () => '1.0.0',
        on: (event, fn) => { if (event === 'will-quit') quitHandlers.push(fn); },
        whenReady: () => new Promise(() => {}),
        isPackaged: false,
    },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: { handle: () => {}, on: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const watchdog = require(path.join(ROOT, 'failover-watchdog'));
const failover = require(path.join(ROOT, 'failover'));
const runs = require(path.join(ROOT, 'runs'));
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
        console.log(`       ${error.stack || error.message}`);
        failed++;
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, { timeout = 8000, every = 50 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = fn();
        if (value) return value;
        await sleep(every);
    }
    return fn();
}

/** A pid that is certainly not running: a child that has already exited. */
async function deadPid() {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise(resolve => child.on('exit', resolve));
    return child.pid;
}

(async () => {
    console.log('\nfailover: the watchdog\'s decisions');

    const base = { alive: false, connected: true, stopped: false, ended: 'died', now: 10000, lastBeat: 10000, hangMs: 1000, recent: [], maxRestarts: 3 };

    await check('a dead app that did not quit is relaunched', () => {
        assert.strictEqual(watchdog.decide(base), 'relaunch');
    });
    await check('a quit, or a system going down, is left alone', () => {
        assert.strictEqual(watchdog.decide({ ...base, ended: 'quit' }), 'exit');
        assert.strictEqual(watchdog.decide({ ...base, ended: 'ending' }), 'exit');
    });
    await check('a stop is obeyed whatever else is true', () => {
        assert.strictEqual(watchdog.decide({ ...base, stopped: true }), 'exit');
        assert.strictEqual(watchdog.decide({ ...base, alive: true, stopped: true, lastBeat: 0 }), 'exit');
    });
    await check('alive and beating is left alone; alive and silent past the limit is a hang', () => {
        assert.strictEqual(watchdog.decide({ ...base, alive: true, lastBeat: 9500 }), 'wait');
        assert.strictEqual(watchdog.decide({ ...base, alive: true, lastBeat: 8000 }), 'kill');
    });
    await check('no hang is called without a channel to beat over, or with the check off', () => {
        assert.strictEqual(watchdog.decide({ ...base, alive: true, connected: false, lastBeat: 0 }), 'wait');
        assert.strictEqual(watchdog.decide({ ...base, alive: true, hangMs: 0, lastBeat: 0 }), 'wait');
    });
    await check('the restart limit gives up rather than looping', () => {
        assert.strictEqual(watchdog.decide({ ...base, recent: [1, 2] }), 'relaunch');
        assert.strictEqual(watchdog.decide({ ...base, recent: [1, 2, 3] }), 'give-up');
    });
    await check('only restarts inside the window count', () => {
        assert.deepStrictEqual(watchdog.recentRestarts([1000, 50000, 95000, 'x'], 100000, 60000), [50000, 95000]);
    });
    await check('the lease says how it ended, and only for its own pid', () => {
        assert.strictEqual(watchdog.howItEnded({ pid: 7, clean: true }, 7), 'quit');
        assert.strictEqual(watchdog.howItEnded({ pid: 7, ending: true }, 7), 'ending');
        assert.strictEqual(watchdog.howItEnded({ pid: 7, clean: false }, 7), 'died');
        assert.strictEqual(watchdog.howItEnded({ pid: 8, clean: true }, 7), 'died');
        assert.strictEqual(watchdog.howItEnded(null, 7), 'died');
    });
    await check('the relaunched app does not inherit the variables that would start it as node', () => {
        const env = watchdog.cleanEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_CHANNEL_FD: '3', PATH: '/bin' });
        assert.deepStrictEqual(env, { PATH: '/bin' });
    });

    console.log('\nfailover: the lease');
    const { endedUncleanly, restartReason, announcement } = failover._test;
    const now = 1_000_000;

    await check('a lease marked clean was a quit', () => {
        assert.strictEqual(endedUncleanly({ pid: 4242, startedAt: now, clean: true }, { pid: 1, now, bootTime: 0, alive: () => false }), false);
    });
    await check('an open lease whose process is gone was a crash', () => {
        assert.strictEqual(endedUncleanly({ pid: 4242, startedAt: now, clean: false }, { pid: 1, now, bootTime: 0, alive: () => false }), true);
    });
    await check('an open lease whose process is still running is another copy of the app, not a crash', () => {
        assert.strictEqual(endedUncleanly({ pid: 4242, startedAt: now, clean: false }, { pid: 1, now, bootTime: 0, alive: () => true }), false);
    });
    await check('an open lease from before the last boot was cut off, whoever has its pid now', () => {
        assert.strictEqual(endedUncleanly({ pid: 4242, startedAt: now - 10, clean: false }, { pid: 1, now, bootTime: now - 5, alive: () => true }), true);
    });
    await check('no lease, an unreadable one, or our own is not a crash', () => {
        assert.strictEqual(endedUncleanly(null), false);
        assert.strictEqual(endedUncleanly({ pid: 'x' }), false);
        assert.strictEqual(endedUncleanly({ pid: process.pid, clean: false }), false);
    });
    await check('the watchdog\'s flag is read back with its reason', () => {
        assert.strictEqual(restartReason(['app', '--failover-restart=hang']), 'hang');
        assert.strictEqual(restartReason(['app', '--failover-restart']), 'crash');
        assert.strictEqual(restartReason(['app', '--other']), '');
    });
    await check('what the user is told: a give-up, a bare restart, and nothing when the conversations say it', () => {
        assert.match(announcement({ gaveUp: { restarts: 3, windowMs: 600000 } }).title, /stopped restarting/);
        assert.match(announcement({ restartReason: 'hang' }).body, /stopped responding/);
        assert.match(announcement({ restartReason: 'crash' }).body, /stopped unexpectedly/);
        assert.strictEqual(announcement({ restartReason: 'crash', resumed: 2 }), null);
        assert.strictEqual(announcement({}), null);
    });

    console.log('\nfailover: a launch after a crash');

    // The last launch: failover on, and a lease left open by a process
    // that is gone.
    const goneParent = await deadPid();
    fs.writeFileSync(path.join(userData, 'failover.json'), JSON.stringify({ enabled: true }));
    fs.writeFileSync(path.join(userData, 'failover-lease.json'), JSON.stringify({ pid: goneParent, startedAt: Date.now() - 1000, clean: false }));

    // The run log as that process left it: a conversation mid-turn with a
    // tool call that never reported, a job's run, an old one, and a child.
    const turn = runs.create({ agentId: 'a', kind: 'interactive', conversationId: 'c1', title: 'Fix nginx' });
    runs.start(turn.id);
    runs.beginStep(turn.id, { kind: 'turn', name: 'turn' });
    runs.beginStep(turn.id, { kind: 'tool', name: 'run_command', input: 'systemctl restart nginx' });
    const stale = runs.create({ agentId: 'a', kind: 'interactive', conversationId: 'c2' });
    runs.start(stale.id);
    db.open().prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(Date.now() - 2 * 24 * 60 * 60 * 1000, stale.id);

    // No real watchdog here: it would watch the test runner, and outlive it.
    const childProcess = require('child_process');
    const realFork = childProcess.fork;
    let forked = 0;
    childProcess.fork = () => {
        forked += 1;
        throw new Error('no watchdog in this part of the test');
    };
    failover.init({ argv: ['electron', '.', '--failover-restart=crash'] });
    childProcess.fork = realFork;

    await check('with failover on, the launch starts a watchdog', () => {
        assert.strictEqual(forked, 1);
    });

    await check('the launch knows it follows a crash and wants the work resumed', () => {
        assert.strictEqual(failover.resumeWanted(), true);
        assert.strictEqual(failover.status().lastRecovery.reason, 'crash');
        assert.strictEqual(failover.status().restartsRecent, 1);
    });
    await check('its own lease is open, under its own pid', () => {
        const lease = JSON.parse(fs.readFileSync(path.join(userData, 'failover-lease.json'), 'utf8'));
        assert.strictEqual(lease.pid, process.pid);
        assert.strictEqual(lease.clean, false);
    });
    await check('a recent conversation turn is resumable; a job\'s, an old one, or a run without a conversation is not', () => {
        assert.strictEqual(failover.resumable(runs.get(turn.id)), true);
        assert.strictEqual(failover.resumable({ ...runs.get(turn.id), jobId: 'j1' }), false);
        assert.strictEqual(failover.resumable({ ...runs.get(turn.id), kind: 'scheduled' }), false);
        assert.strictEqual(failover.resumable(runs.get(stale.id)), false);
        assert.strictEqual(failover.resumable({ ...runs.get(turn.id), conversationId: '' }), false);
    });
    await check('recovery keeps the resumable turn queued with its lost call marked unknown, and closes the old one', () => {
        const result = runs.recover({ resumable: run => failover.resumable(run) });
        assert.deepStrictEqual(result.requeued, [turn.id]);
        assert.ok(result.closed.includes(stale.id));
        assert.strictEqual(runs.get(turn.id).status, 'queued');
        const unknown = runs.unknownSteps(turn.id);
        assert.strictEqual(unknown.length, 1);
        assert.strictEqual(unknown[0].name, 'run_command');
    });
    await check('a turn is resumed at most twice', () => {
        assert.deepStrictEqual(failover.noteResume(turn.id), { count: 1, allowed: true });
        assert.deepStrictEqual(failover.noteResume(turn.id), { count: 2, allowed: true });
        assert.deepStrictEqual(failover.noteResume(turn.id), { count: 3, allowed: false });
    });
    await check('quitting marks the lease clean, so neither the watchdog nor the next launch takes it for a crash', () => {
        for (const fn of quitHandlers) fn();
        const lease = JSON.parse(fs.readFileSync(path.join(userData, 'failover-lease.json'), 'utf8'));
        assert.strictEqual(lease.clean, true);
        assert.strictEqual(endedUncleanly(lease, { pid: 1, bootTime: 0, alive: () => false }), false);
    });

    console.log('\nfailover: the watchdog, run for real');

    const script = path.join(ROOT, 'failover-watchdog.js');
    const marker = path.join(userData, 'relaunched.json');
    const recorder = path.join(userData, 'recorder.js');
    // The "app" the watchdog starts again: writes down how it was started.
    fs.writeFileSync(recorder, `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`);

    /** A stand-in app: a node process that sits there until killed. */
    const standIn = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

    const startWatchdog = (parent, extra = {}) => {
        const lease = path.join(userData, `lease-${parent.pid}.json`);
        const config = {
            parentPid: parent.pid,
            command: process.execPath,
            args: [recorder],
            cwd: userData,
            tickMs: 100,
            hangMs: 0,
            relaunchDelayMs: 50,
            killWaitMs: 3000,
            recent: [],
            maxRestarts: 3,
            windowMs: 600000,
            leaseFile: lease,
            gaveUpFile: path.join(userData, 'gave-up.json'),
            logFile: path.join(userData, 'logs', 'failover.log'),
            ...extra,
        };
        fs.writeFileSync(lease, JSON.stringify({ pid: parent.pid, clean: false }));
        const child = fork(script, [Buffer.from(JSON.stringify(config)).toString('base64')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
        return { child, lease, exited };
    };
    const reset = () => {
        for (const file of [marker, path.join(userData, 'gave-up.json')]) {
            try { fs.unlinkSync(file); } catch { /* not there */ }
        }
    };

    await check('the app dying is followed by a relaunch, flagged as a crash', async () => {
        reset();
        const app = standIn();
        const { exited } = startWatchdog(app);
        await sleep(300);
        app.kill();
        const argv = await until(() => fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')));
        assert.deepStrictEqual(argv, ['--failover-restart=crash']);
        assert.strictEqual(await exited, 0);
    });

    await check('the app quitting is not followed by a relaunch', async () => {
        reset();
        const app = standIn();
        const { lease, exited } = startWatchdog(app);
        await sleep(300);
        fs.writeFileSync(lease, JSON.stringify({ pid: app.pid, clean: true }));
        app.kill();
        assert.strictEqual(await exited, 0);
        await sleep(200);
        assert.strictEqual(fs.existsSync(marker), false);
    });

    await check('an app that stops beating is ended and relaunched, flagged as a hang', async () => {
        reset();
        const app = standIn();
        const appGone = new Promise(resolve => app.on('exit', resolve));
        const { child, exited } = startWatchdog(app, { hangMs: 600 });
        // A beat or two, then silence.
        child.send({ type: 'beat' });
        await sleep(200);
        child.send({ type: 'beat' });
        await appGone;
        const argv = await until(() => fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')));
        assert.deepStrictEqual(argv, ['--failover-restart=hang']);
        assert.strictEqual(await exited, 0);
    });

    await check('past the restart limit it gives up and leaves a note instead', async () => {
        reset();
        const app = standIn();
        const t = Date.now();
        const { exited } = startWatchdog(app, { recent: [t - 3000, t - 2000, t - 1000] });
        await sleep(300);
        app.kill();
        assert.strictEqual(await exited, 0);
        await sleep(200);
        assert.strictEqual(fs.existsSync(marker), false);
        const note = JSON.parse(fs.readFileSync(path.join(userData, 'gave-up.json'), 'utf8'));
        assert.strictEqual(note.restarts, 3);
    });

    await check('told to stop, it goes and does nothing when the app dies after', async () => {
        reset();
        const app = standIn();
        const { child, exited } = startWatchdog(app);
        await sleep(200);
        child.send({ type: 'stop', reason: 'test' });
        assert.strictEqual(await exited, 0);
        app.kill();
        await sleep(300);
        assert.strictEqual(fs.existsSync(marker), false);
    });

    db.close();
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
