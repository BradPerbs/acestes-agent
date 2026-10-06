const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
// Called through the module rather than destructured, so a test can keep a
// real watchdog from starting against the test runner.
const childProcess = require('child_process');

/**
 * Failover: the app coming back by itself, and carrying on.
 *
 * Off by default, switched on under Settings, General. With it on:
 *
 *   The app dies (a crash, the process killed, the main thread hung). A
 *   watchdog started beside it (failover-watchdog.js) sees it go and starts
 *   it again. A hang is a main thread that has stopped beating for three
 *   minutes; the watchdog ends it and treats it as a crash.
 *
 *   The window's own process dies or hangs. The window is reloaded; the
 *   conversations live in this process, so nothing is lost but the frame.
 *
 *   The machine goes down. Nothing on it survives that, so the app comes
 *   back when the system starts it, which is the login item ("Start at
 *   login", startup.js). Turning failover on offers to turn that on too.
 *
 * And on the way back up, the work that was cut short is picked up: a
 * conversation whose turn was still running is sent on again, told which of
 * its tool calls never reported back so it checks them rather than repeating
 * them blindly. Scheduled jobs already resume on their own (scheduler.js).
 *
 * Telling a crash from a quit is the lease: a small file this process writes
 * on launch and marks clean, synchronously, as it quits. A lease still open
 * at the next launch belongs to a process that did not get to say goodbye.
 * A system shutting down leaves it open on purpose (marked `ending`), so work
 * cut off by a reboot resumes after it, while the watchdog, told the same
 * thing, does not try to restart an app the system is closing.
 *
 * The limits, so a fault cannot turn into a loop: three restarts in ten
 * minutes, then the watchdog gives up and the next launch says so; a turn is
 * resumed at most twice; a turn older than a day is left closed; the window
 * is reloaded at most three times a minute.
 */

const BEAT_MS = 10 * 1000;
const HANG_MS = 3 * 60 * 1000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESUMES = 2;
const RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RENDERER_RELOADS = 3;
const RENDERER_WINDOW_MS = 60 * 1000;
const UNRESPONSIVE_MS = 60 * 1000;
const MAX_WATCHDOG_RESPAWNS = 3;
const LOG_LIMIT = 256 * 1024;

const RESTART_FLAG = '--failover-restart';

let initialized = false;
let settings = { enabled: false, restarts: [], resumes: {}, lastRecovery: null };
// What this launch found when it started. Fixed once `init` has run.
let launch = { endedUncleanly: false, restartReason: '', gaveUp: null, resumeWanted: false };
let watchdog = null;
let beatTimer = null;
let respawns = 0;
let systemEnding = false;
let quitting = false;
let launchedAt = Date.now();

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

function dir() {
    return app.getPath('userData');
}

const files = () => ({
    settings: path.join(dir(), 'failover.json'),
    lease: path.join(dir(), 'failover-lease.json'),
    gaveUp: path.join(dir(), 'failover-gave-up.json'),
    log: path.join(dir(), 'logs', 'failover.log'),
});

function readJson(file, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
}

/** Written whole and renamed into place, so a crash mid-write leaves the old file rather than half a new one. */
function writeJson(file, value) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(value));
        fs.renameSync(temp, file);
        return true;
    } catch (error) {
        console.error(`Failover could not write ${path.basename(file)}:`, error.message);
        return false;
    }
}

function log(line) {
    try {
        const file = files().log;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.old`);
        } catch {
            // No log yet.
        }
        fs.appendFileSync(file, `${new Date().toISOString()} app[${process.pid}] ${line}\n`);
    } catch {
        // The log is for reading afterwards; failing to write it changes nothing.
    }
}

function normalizeSettings(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const resumes = {};
    if (value.resumes && typeof value.resumes === 'object') {
        for (const [runId, count] of Object.entries(value.resumes)) {
            if (typeof runId === 'string' && Number.isInteger(count) && count > 0) resumes[runId] = count;
        }
    }
    return {
        enabled: value.enabled === true,
        restarts: (Array.isArray(value.restarts) ? value.restarts : [])
            .filter(entry => entry && Number.isFinite(entry.at))
            .slice(-20),
        resumes,
        lastRecovery: value.lastRecovery && Number.isFinite(value.lastRecovery.at) ? value.lastRecovery : null,
    };
}

function saveSettings() {
    // Only the newest resume counts matter: a run resumed twice a month ago
    // is long closed either way.
    const entries = Object.entries(settings.resumes);
    if (entries.length > 100) settings.resumes = Object.fromEntries(entries.slice(-100));
    writeJson(files().settings, settings);
}

/* ------------------------------------------------------------------ *
 * The lease
 * ------------------------------------------------------------------ */

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

/**
 * Whether the process that wrote this lease went without quitting.
 *
 * A pid still alive is another copy of the app running now, not a crash,
 * unless the lease is older than the machine's last boot: pids are reused
 * after a restart, and nothing from before one can still be running.
 */
function endedUncleanly(lease, { pid = process.pid, now = Date.now(), bootTime = now - os.uptime() * 1000, alive = isAlive } = {}) {
    if (!lease || typeof lease !== 'object') return false;
    const leasePid = Number(lease.pid);
    if (!Number.isInteger(leasePid) || leasePid <= 0 || leasePid === pid) return false;
    if (lease.clean === true) return false;
    if (Number(lease.startedAt) < bootTime) return true;
    return !alive(leasePid);
}

/** The reason the watchdog started this launch with, or ''. */
function restartReason(argv = process.argv) {
    for (const arg of argv || []) {
        const text = String(arg);
        if (text === RESTART_FLAG) return 'crash';
        if (text.startsWith(`${RESTART_FLAG}=`)) return text.slice(RESTART_FLAG.length + 1) || 'crash';
    }
    return '';
}

function writeLease(patch = {}) {
    writeJson(files().lease, { pid: process.pid, startedAt: launchedAt, clean: false, ending: false, ...patch });
}

/* ------------------------------------------------------------------ *
 * The watchdog
 * ------------------------------------------------------------------ */

/**
 * What the watchdog runs to bring the app back. An installed build is started
 * the way the system starts it, by its executable and nothing else: a portable
 * build by the .exe the user has (the one running is a copy unpacked to the
 * temp folder, gone once it exits), an AppImage by the image rather than its
 * mount. A run from a checkout is started with the arguments it was given.
 */
function relaunchCommand() {
    if (app.isPackaged) {
        const command = process.env.APPIMAGE || process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        return { command, args: [], cwd: path.dirname(command) };
    }
    return {
        command: process.execPath,
        args: process.argv.slice(1).filter(arg => !String(arg).startsWith(RESTART_FLAG)),
        cwd: process.cwd(),
    };
}

/** Outside the asar in a packaged app, where Node can be sure of reading it. */
function watchdogScript() {
    return path.join(__dirname, 'failover-watchdog.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function recentRestarts(now = Date.now()) {
    return settings.restarts.map(entry => entry.at).filter(at => now - at < RESTART_WINDOW_MS && at <= now);
}

function beat() {
    if (!watchdog?.connected) return;
    try {
        watchdog.send({ type: 'beat' });
    } catch {
        // The channel closed between the check and the send.
    }
}

function startWatchdog() {
    if (watchdog || quitting) return;
    const paths = files();
    const config = {
        parentPid: process.pid,
        ...relaunchCommand(),
        hangMs: HANG_MS,
        recent: recentRestarts(),
        maxRestarts: MAX_RESTARTS,
        windowMs: RESTART_WINDOW_MS,
        leaseFile: paths.lease,
        gaveUpFile: paths.gaveUp,
        logFile: paths.log,
    };

    let child;
    try {
        child = childProcess.fork(watchdogScript(), [Buffer.from(JSON.stringify(config)).toString('base64')], {
            execPath: process.execPath,
            execArgv: [],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            // Detached: outside libuv's kill-on-close job on Windows, and its
            // own session elsewhere, so it is still there when the app is not.
            detached: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            windowsHide: true,
        });
    } catch (error) {
        log(`could not start the watchdog: ${error.message}`);
        console.error('Failover could not start its watchdog:', error.message);
        return;
    }

    watchdog = child;
    child.unref();
    child.on('error', (error) => log(`watchdog error: ${error.message}`));
    child.on('exit', (code) => {
        if (watchdog !== child) return;
        watchdog = null;
        // The healer healed, a few times: a watchdog that dies while the app
        // is fine leaves failover switched on and doing nothing.
        if (settings.enabled && !quitting && respawns < MAX_WATCHDOG_RESPAWNS) {
            respawns += 1;
            log(`watchdog exited (${code}); starting another`);
            setTimeout(startWatchdog, 5000).unref?.();
        }
    });

    if (!beatTimer) {
        beatTimer = setInterval(beat, BEAT_MS);
        beatTimer.unref?.();
    }
    beat();
}

function stopWatchdog(reason) {
    const child = watchdog;
    watchdog = null;
    if (beatTimer) clearInterval(beatTimer);
    beatTimer = null;
    if (!child) return;
    try {
        if (child.connected) child.send({ type: 'stop', reason });
    } catch {
        // Gone already.
    }
    // In case the message is lost: the watchdog has nothing worth finishing.
    setTimeout(() => {
        try { child.kill(); } catch { /* gone */ }
    }, 1000).unref?.();
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Read what the last launch left, open this one's lease, and start the
 * watchdog when failover is on. Once, after the app is ready and before the
 * first window, so `resumable` has its answer before anything asks.
 */
function init({ argv = process.argv } = {}) {
    if (initialized) return;
    initialized = true;
    launchedAt = Date.now();

    const paths = files();
    settings = normalizeSettings(readJson(paths.settings));
    const previous = readJson(paths.lease);

    launch.endedUncleanly = endedUncleanly(previous);
    launch.restartReason = restartReason(argv);

    let changed = false;
    if (launch.restartReason) {
        settings.restarts.push({ at: launchedAt, reason: launch.restartReason });
        settings.lastRecovery = { at: launchedAt, reason: launch.restartReason };
        changed = true;
        log(`started by the watchdog after a ${launch.restartReason}`);
    } else if (launch.endedUncleanly && settings.enabled) {
        // Back by the login item or by hand, after a power cut, a reboot or a
        // crash the watchdog could not outlive.
        const reason = previous?.ending ? 'shutdown' : 'unclean';
        settings.lastRecovery = { at: launchedAt, reason };
        changed = true;
        log(`the last run ended without quitting (${reason})`);
    }

    const gaveUp = readJson(paths.gaveUp);
    if (gaveUp) {
        launch.gaveUp = gaveUp;
        settings.lastRecovery = { at: Number(gaveUp.at) || launchedAt, reason: 'gave-up' };
        changed = true;
        try { fs.unlinkSync(paths.gaveUp); } catch { /* read once is enough */ }
        log('the watchdog had given up restarting the app');
    }
    if (changed) saveSettings();

    launch.resumeWanted = settings.enabled && (launch.endedUncleanly || Boolean(launch.restartReason));

    writeLease();

    app.on('will-quit', () => {
        quitting = true;
        // Synchronous, so it is on disk before the process is gone: this is
        // what the watchdog and the next launch read.
        writeLease(systemEnding ? { ending: true } : { clean: true });
        stopWatchdog(systemEnding ? 'the system is shutting down' : 'the app quit');
    });

    try {
        // Linux and macOS say so here; Windows says it to the window, which
        // main.js passes on through `watchWindow`.
        require('electron').powerMonitor?.on?.('shutdown', markSystemEnding);
    } catch {
        // Not available before ready, or at all: the window event remains.
    }

    if (settings.enabled) startWatchdog();
}

/** The system is going down: keep the lease open for the next boot, and keep the watchdog from restarting the app. */
function markSystemEnding() {
    if (systemEnding) return;
    systemEnding = true;
    log('the system is shutting down');
    writeLease({ ending: true });
    stopWatchdog('the system is shutting down');
}

/**
 * Stand the watchdog down for a quit that is not a crash but may not look
 * like a quit: the updater's installer replacing the app.
 */
function standDown(reason) {
    quitting = true;
    log(`standing down: ${reason}`);
    writeLease({ clean: true });
    stopWatchdog(reason);
}

/**
 * Keep the window alive: reload it when its process dies, and end a renderer
 * that has stopped answering for a minute so it can be reloaded.
 */
function watchWindow(window) {
    if (!window || window.isDestroyed?.()) return;
    const reloads = [];
    let unresponsive = null;

    const clear = () => {
        if (unresponsive) clearTimeout(unresponsive);
        unresponsive = null;
    };

    window.webContents.on('render-process-gone', (event, details = {}) => {
        clear();
        if (!settings.enabled || quitting || details.reason === 'clean-exit') return;
        const now = Date.now();
        while (reloads.length && now - reloads[0] > RENDERER_WINDOW_MS) reloads.shift();
        if (reloads.length >= RENDERER_RELOADS) {
            log(`window process gone (${details.reason}); not reloading, ${reloads.length} reloads in the last minute`);
            return;
        }
        reloads.push(now);
        log(`window process gone (${details.reason}, exit ${details.exitCode}); reloading`);
        setTimeout(() => {
            if (!window.isDestroyed()) window.webContents.reload();
        }, 1000);
    });

    window.on('unresponsive', () => {
        if (!settings.enabled || unresponsive) return;
        unresponsive = setTimeout(() => {
            unresponsive = null;
            if (window.isDestroyed() || !settings.enabled) return;
            log('window not responding for a minute; restarting its process');
            // Its `render-process-gone` reloads it.
            window.webContents.forcefullyCrashRenderer();
        }, UNRESPONSIVE_MS);
    });
    window.on('responsive', clear);
    window.on('closed', clear);
    // Windows: the session is ending (shutdown, restart, sign-out).
    window.on('session-end', markSystemEnding);
}

/* ------------------------------------------------------------------ *
 * Resuming work
 * ------------------------------------------------------------------ */

/**
 * Whether a run the last process left open is one failover picks up: a
 * conversation's turn, from a launch that ended without quitting, recent
 * enough that carrying on is still what the user would want.
 */
function resumable(run, now = Date.now()) {
    if (!launch.resumeWanted || !run) return false;
    if (run.kind !== 'interactive' || run.jobId || !run.conversationId) return false;
    const at = Number(run.updatedAt) || Number(run.startedAt) || 0;
    return now - at < RESUME_MAX_AGE_MS;
}

/** Count one more resume of a run, and say whether it is still allowed. */
function noteResume(runId) {
    const count = (settings.resumes[runId] || 0) + 1;
    settings.resumes[runId] = count;
    saveSettings();
    return { count, allowed: count <= MAX_RESUMES };
}

function resumeWanted() {
    return launch.resumeWanted;
}

/**
 * What the user is told about this launch, or null. The conversations that
 * were picked up say so themselves (resumeInterrupted's toast); this covers a
 * restart with nothing to resume, and the watchdog having given up.
 */
function announcement({ restartReason = '', gaveUp = null, resumed = 0 } = {}) {
    if (gaveUp) {
        const minutes = Math.round((Number(gaveUp.windowMs) || RESTART_WINDOW_MS) / 60000);
        return {
            title: 'Failover stopped restarting Acestes',
            body: `It stopped unexpectedly ${Number(gaveUp.restarts) || MAX_RESTARTS} times in ${minutes} minutes, `
                + 'so it was left closed. logs/failover.log in the app\'s data folder says what happened.',
        };
    }
    if (resumed > 0 || !restartReason) return null;
    return {
        title: 'Acestes restarted',
        body: restartReason === 'hang'
            ? 'It stopped responding, so failover restarted it.'
            : 'It stopped unexpectedly, so failover restarted it.',
    };
}

let announced = false;

/**
 * Once the window is up: send on whatever was cut short, through `resume`
 * (the assistant's `resumeInterrupted`), and say what happened.
 */
async function afterLaunch(resume) {
    if (announced) return { resumed: 0 };
    announced = true;

    let resumed = 0;
    if (launch.resumeWanted && typeof resume === 'function') {
        try {
            resumed = Number((await resume())?.resumed) || 0;
        } catch (error) {
            log(`could not resume the work: ${error.message}`);
        }
        log(`resumed ${resumed} conversation turn(s)`);
    }

    const message = announcement({ ...launch, resumed });
    if (message) {
        try {
            const { Notification } = require('electron');
            if (Notification?.isSupported?.()) new Notification({ ...message, silent: true }).show();
        } catch (error) {
            console.error('Failover could not show a notification:', error.message);
        }
    }
    return { resumed };
}

/* ------------------------------------------------------------------ *
 * The setting
 * ------------------------------------------------------------------ */

function status() {
    return {
        supported: true,
        enabled: settings.enabled,
        watching: Boolean(watchdog?.connected),
        lastRecovery: settings.lastRecovery,
        restartsRecent: recentRestarts().length,
        maxRestarts: MAX_RESTARTS,
        gaveUp: Boolean(launch.gaveUp),
    };
}

function setEnabled(enabled) {
    const wanted = Boolean(enabled);
    settings.enabled = wanted;
    saveSettings();
    log(wanted ? 'switched on' : 'switched off');
    if (wanted) {
        respawns = 0;
        startWatchdog();
    } else {
        stopWatchdog('failover was switched off');
    }
    return { success: true, ...status() };
}

const isEnabled = () => settings.enabled;
const isSystemEnding = () => systemEnding;

module.exports = {
    init,
    status,
    setEnabled,
    isEnabled,
    isSystemEnding,
    watchWindow,
    standDown,
    markSystemEnding,
    resumable,
    resumeWanted,
    noteResume,
    afterLaunch,
    log,
    // For the tests.
    _test: { endedUncleanly, restartReason, normalizeSettings, relaunchCommand, watchdogScript, announcement },
    MAX_RESUMES,
};
