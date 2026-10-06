/**
 * Failover's watchdog: a small process beside the app that starts it again
 * when it dies or stops answering.
 *
 * Run by the app's own executable as plain Node (ELECTRON_RUN_AS_NODE), and
 * detached, so it is not in the job object libuv puts ordinary children in on
 * Windows and outlives the process it watches. Nothing from Electron is
 * available here and nothing is needed: a pid to watch, a command to run, and
 * two files.
 *
 * What it is told, over the IPC channel:
 *   beat    the app's main thread is alive (every few seconds)
 *   stop    failover was switched off, or an update is installing: go quietly
 *
 * What it reads, once the app has gone: the lease (see failover.js), written
 * synchronously by the app as it quits. A message on the channel can be lost
 * when the process exits straight after sending it; a file written before the
 * exit cannot, so the lease is what decides between "the user quit" and "it
 * died".
 *
 * A hang is a main thread that has not beaten for `hangMs`. The app is killed
 * and treated as crashed. A watchdog that was itself suspended (the machine
 * asleep) does not count the time it was not running.
 *
 * Restarts are capped: `recent` is when the app was last restarted, as the
 * app recorded it, and past `maxRestarts` inside the window the watchdog gives
 * up and leaves a note the next launch reads. A crash that comes back every
 * time it starts is not healed by starting it again.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
    tickMs: 2000,
    hangMs: 3 * 60 * 1000,
    maxRestarts: 3,
    windowMs: 10 * 60 * 1000,
    relaunchDelayMs: 1500,
    killWaitMs: 15000,
});

/** Variables that would make the relaunched app start as Node, or think it has a parent channel. */
const CHILD_ONLY_ENV = ['ELECTRON_RUN_AS_NODE', 'NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE', 'NODE_UNIQUE_ID'];

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: there, and not ours to signal. Still alive.
        return error.code === 'EPERM';
    }
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function cleanEnv(env) {
    const out = { ...env };
    for (const key of CHILD_ONLY_ENV) delete out[key];
    return out;
}

/** The restarts inside the window, newest last. */
function recentRestarts(recent, now, windowMs) {
    return (Array.isArray(recent) ? recent : [])
        .map(Number)
        .filter(at => Number.isFinite(at) && now - at < windowMs && at <= now);
}

/**
 * How the app ended, from its lease: 'quit' when the user closed it,
 * 'ending' when the system was shutting down, and 'died' otherwise. A lease
 * that belongs to another pid says nothing about this one.
 */
function howItEnded(lease, parentPid) {
    if (!lease || Number(lease.pid) !== parentPid) return 'died';
    if (lease.clean) return 'quit';
    if (lease.ending) return 'ending';
    return 'died';
}

/**
 * One look at the app. Pure, so the decisions can be tested without a
 * process to kill:
 *
 *   wait      nothing to do yet
 *   exit      the app went the way it meant to, or failover was stopped
 *   kill      alive and silent past the hang limit
 *   relaunch  gone without meaning to be
 *   give-up   gone, but restarted too often already
 */
function decide({ alive, connected, stopped, ended, now, lastBeat, hangMs, recent, maxRestarts }) {
    if (stopped) return 'exit';
    if (alive) {
        if (connected && hangMs > 0 && now - lastBeat > hangMs) return 'kill';
        return 'wait';
    }
    if (ended === 'quit' || ended === 'ending') return 'exit';
    if (recent.length >= maxRestarts) return 'give-up';
    return 'relaunch';
}

function decodeConfig(arg) {
    const raw = JSON.parse(Buffer.from(String(arg || ''), 'base64').toString('utf8'));
    return { ...DEFAULTS, ...raw };
}

function run(config) {
    const parentPid = Number(config.parentPid);
    let lastBeat = Date.now();
    let lastTick = Date.now();
    let stopped = false;
    let reason = 'crash';
    let finishing = false;
    let killing = false;

    const log = (line) => {
        if (!config.logFile) return;
        try {
            fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
            fs.appendFileSync(config.logFile, `${new Date().toISOString()} watchdog[${process.pid}] ${line}\n`);
        } catch {
            // Nowhere to say it. The relaunch matters more than the line.
        }
    };

    const finish = (code = 0) => {
        finishing = true;
        clearInterval(timer);
        try { process.disconnect?.(); } catch { /* already gone */ }
        // A beat at most: the log line above has been written synchronously.
        setTimeout(() => process.exit(code), 50);
    };

    process.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'beat') lastBeat = Date.now();
        if (message.type === 'stop') {
            stopped = true;
            log(`told to stop (${message.reason || 'no reason given'})`);
            finish(0);
        }
    });
    // The channel closing is the fastest news of the app going: look now
    // rather than at the next tick.
    process.on('disconnect', () => { if (!finishing) setTimeout(tick, 250); });

    const relaunch = () => {
        const args = [...(config.args || []), `--failover-restart=${reason}`];
        log(`relaunching after a ${reason}: ${config.command} ${args.join(' ')}`);
        let child;
        try {
            child = spawn(config.command, args, {
                cwd: config.cwd || undefined,
                detached: true,
                stdio: 'ignore',
                env: cleanEnv(process.env),
                windowsHide: false,
            });
        } catch (error) {
            log(`could not relaunch: ${error.message}`);
            finish(1);
            return;
        }
        child.once('error', (error) => {
            log(`could not relaunch: ${error.message}`);
            finish(1);
        });
        child.once('spawn', () => {
            log(`relaunched as pid ${child.pid}`);
            child.unref();
            finish(0);
        });
    };

    const giveUp = (recent) => {
        log(`not relaunching: ${recent.length} restarts in the last ${Math.round(config.windowMs / 60000)} minutes`);
        try {
            fs.writeFileSync(config.gaveUpFile, JSON.stringify({
                at: Date.now(),
                reason,
                restarts: recent.length,
                windowMs: config.windowMs,
            }));
        } catch (error) {
            log(`could not leave the note: ${error.message}`);
        }
        finish(0);
    };

    const kill = () => {
        reason = 'hang';
        log(`no heartbeat for ${Math.round((Date.now() - lastBeat) / 1000)}s; ending pid ${parentPid}`);
        try {
            process.kill(parentPid);
        } catch (error) {
            log(`could not end it: ${error.message}`);
        }
        // Not relaunched until it is actually gone: a second app over the
        // same files while the first is still dying would fight it for them.
        const deadline = Date.now() + config.killWaitMs;
        const waitGone = () => {
            if (!isAlive(parentPid) || Date.now() > deadline) {
                tick();
                return;
            }
            setTimeout(waitGone, 250);
        };
        waitGone();
    };

    function tick() {
        if (finishing) return;
        const now = Date.now();
        // Asleep, or starved for that long: the app was not running either,
        // so its silence is not a hang.
        if (now - lastTick > config.tickMs * 5) lastBeat = now;
        lastTick = now;

        const alive = isAlive(parentPid);
        const recent = recentRestarts(config.recent, now, config.windowMs);
        const ended = alive ? '' : howItEnded(readJson(config.leaseFile), parentPid);
        const action = decide({
            alive,
            connected: Boolean(process.connected),
            stopped,
            ended,
            now,
            lastBeat,
            hangMs: Number(config.hangMs) || 0,
            recent,
            maxRestarts: Number(config.maxRestarts) || DEFAULTS.maxRestarts,
        });

        if (action === 'wait') return;
        if (action === 'exit') {
            if (!stopped) log(ended === 'ending' ? 'the system is shutting down; not relaunching' : 'the app quit; nothing to do');
            finish(0);
            return;
        }
        if (action === 'kill') {
            // Once: the ticks that come while it dies only wait for it.
            if (killing) return;
            killing = true;
            clearInterval(timer);
            kill();
            return;
        }
        if (action === 'give-up') {
            giveUp(recent);
            return;
        }
        finishing = true;
        clearInterval(timer);
        log(`pid ${parentPid} is gone without quitting`);
        setTimeout(relaunch, config.relaunchDelayMs);
    }

    const timer = setInterval(tick, config.tickMs);
    log(`watching pid ${parentPid}`);
}

if (require.main === module) {
    let config;
    try {
        config = decodeConfig(process.argv[2]);
    } catch (error) {
        process.stderr.write(`failover watchdog: unreadable config: ${error.message}\n`);
        process.exit(2);
    }
    run(config);
}

module.exports = { decide, howItEnded, recentRestarts, cleanEnv, isAlive, decodeConfig, DEFAULTS };
