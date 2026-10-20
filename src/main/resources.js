const { app, powerMonitor, powerSaveBlocker } = require('electron');
const os = require('os');

/**
 * What the app costs the machine, and the switch that keeps the machine up.
 *
 * Memory is Electron's own reading of its processes: the main process, one per
 * window, the GPU process and the helpers. The agent runtimes are programs of
 * their own that this app starts, not Electron processes, so they are not in
 * it; Task Manager lists them under their own names.
 *
 * Keeping awake is held here rather than in the renderer so that a reload, or
 * the window going to the tray, does not quietly let the machine sleep. It is
 * never written anywhere: it lasts until it is switched off or the app quits,
 * because a machine that will not sleep a week after someone forgot is worse
 * than having to switch it on again.
 */

/** Electron's process types, folded into the four worth telling apart. */
const KIND = { Browser: 'main', Tab: 'windows', GPU: 'gpu' };

/** `{ total, parts: { main, windows, gpu, other }, processes, system }`, in bytes. */
function memory() {
    const parts = { main: 0, windows: 0, gpu: 0, other: 0 };
    let processes = 0;
    for (const metric of app.getAppMetrics()) {
        // Kilobytes, and the resident figure: what Task Manager's Memory
        // column is closest to on every platform this runs on.
        parts[KIND[metric.type] || 'other'] += (metric.memory?.workingSetSize || 0) * 1024;
        processes += 1;
    }
    return {
        total: parts.main + parts.windows + parts.gpu + parts.other,
        parts,
        processes,
        system: { total: os.totalmem(), free: os.freemem() },
    };
}

let blocker = null;
let since = 0;
let nudger = null;

/**
 * The nudge, in seconds: looked for every `every`, given once nobody has
 * touched the mouse or keyboard for `idle`. Windows' shortest timer for the
 * screen, sleep or the lock is a minute, so the desk never looks empty for
 * longer than `idle + every`, well inside it.
 */
const NUDGE = { every: 15, idle: 30 };

/** `{ awake, since }`: whether the machine is being kept up, and from when. */
function awakeStatus() {
    const awake = blocker !== null && powerSaveBlocker.isStarted(blocker);
    return { awake, since: awake ? since : 0 };
}

/**
 * Nudge the cursor if the desk has been quiet. Not while someone is using it,
 * not on a locked screen (Windows drops the input there), and not while an
 * agent is using the computer: computer.js and the helper both refuse then.
 */
function nudgeIfIdle() {
    if (process.platform !== 'win32') return;
    try {
        if (powerMonitor.getSystemIdleTime() < NUDGE.idle) return;
        if (powerMonitor.getSystemIdleState(NUDGE.idle) === 'locked') return;
    } catch {
        return;
    }
    require('./ai/computer').nudge()
        .then((answer) => {
            if (answer && answer.ok === false) console.error('Keep awake: could not nudge the cursor:', answer.error);
        })
        .catch(() => {});
}

/**
 * Keep the machine from sleeping, or let it again.
 *
 * Two holds, because one is not enough on Windows. `prevent-display-sleep` is
 * a request Windows honours: `prevent-app-suspension` there only keeps this
 * process from being suspended, and a laptop with Modern Standby goes to
 * standby as soon as the screen turns off, whatever else is asked. And on
 * Windows the cursor is nudged a pixel and back while the desk is idle, which
 * also holds off the screen saver, the lock and an "away" status, none of
 * which a power request touches.
 */
function setAwake(on) {
    const { awake } = awakeStatus();
    if (on && !awake) {
        blocker = powerSaveBlocker.start('prevent-display-sleep');
        since = Date.now();
        if (process.platform === 'win32' && !nudger) {
            nudger = setInterval(nudgeIfIdle, NUDGE.every * 1000);
            nudger.unref?.();
        }
    } else if (!on && blocker !== null) {
        if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
        blocker = null;
        since = 0;
        if (nudger) {
            clearInterval(nudger);
            nudger = null;
        }
    }
    return awakeStatus();
}

module.exports = { memory, awakeStatus, setAwake };
