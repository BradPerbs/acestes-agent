const { app, powerSaveBlocker } = require('electron');
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

/** `{ awake, since }`: whether the machine is being kept up, and from when. */
function awakeStatus() {
    const awake = blocker !== null && powerSaveBlocker.isStarted(blocker);
    return { awake, since: awake ? since : 0 };
}

/**
 * Keep the machine from sleeping, or let it again.
 *
 * `prevent-app-suspension` keeps the system itself running, which is what a
 * long job or an open session needs, and still lets the screen go dark on its
 * usual timer: nobody asked for the display to stay lit on an empty desk.
 */
function setAwake(on) {
    const { awake } = awakeStatus();
    if (on && !awake) {
        blocker = powerSaveBlocker.start('prevent-app-suspension');
        since = Date.now();
    } else if (!on && blocker !== null) {
        if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
        blocker = null;
        since = 0;
    }
    return awakeStatus();
}

module.exports = { memory, awakeStatus, setAwake };
