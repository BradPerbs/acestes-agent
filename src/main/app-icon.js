const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * The window icon.
 *
 * A packaged build carries its icon in the executable (Windows), the bundle
 * (macOS) or the desktop entry (Linux), so the windows inherit it without
 * being told. A dev run is plain `electron .`, whose windows show Electron's
 * own logo unless each is handed the icon, which is what this is for. The
 * file is the same `build/icon.png` electron-builder packages from, copied
 * into the resources folder of a packaged app for the Linux case, where the
 * window manager wants the window itself to say.
 */
function appIconPath() {
    const candidate = app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(__dirname, '..', '..', 'build', 'icon.png');
    return fs.existsSync(candidate) ? candidate : null;
}

/**
 * The `icon` entry for a BrowserWindow's options, or nothing where no file is
 * to hand: spreading `{}` leaves Electron to its defaults.
 */
function windowIcon() {
    const icon = appIconPath();
    return icon ? { icon } : {};
}

module.exports = { appIconPath, windowIcon };
