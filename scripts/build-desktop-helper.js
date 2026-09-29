/**
 * Compile the desktop helper: the agent's hands on this computer.
 *
 * The same recipe as the Windows Hello helper (build-hello-helper.js): the C#
 * compiler that ships inside Windows, against the .NET Framework assemblies
 * that also ship inside Windows. UI Automation is one of them, which is what
 * lets this be a small exe rather than a Python install or a native addon.
 *
 * Run by `npm run build:desktop`, and folded into `npm run build`. On anything
 * other than Windows it does nothing and says so.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'tools', 'DesktopHelper.cs');
const OUTPUT_DIR = path.join(ROOT, 'resources');
const OUTPUT = path.join(OUTPUT_DIR, 'desktop-helper.exe');

const FRAMEWORK = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319',
);
const WPF = path.join(FRAMEWORK, 'WPF');

const REFERENCES = [
    path.join(WPF, 'UIAutomationClient.dll'),
    path.join(WPF, 'UIAutomationTypes.dll'),
    path.join(WPF, 'WindowsBase.dll'),
    path.join(FRAMEWORK, 'System.Drawing.dll'),
    path.join(FRAMEWORK, 'System.Windows.Forms.dll'),
    path.join(FRAMEWORK, 'System.Web.Extensions.dll'),
];

/**
 * A running app keeps its helper open, and Windows will not let an open exe
 * be overwritten. It will let one be renamed, so the old one is moved aside:
 * the app keeps using it until it restarts, and the next start gets the new
 * one. Leftovers from earlier builds go when nothing holds them.
 */
function setAside() {
    for (const name of fs.readdirSync(OUTPUT_DIR)) {
        if (name.startsWith('desktop-helper.old-')) {
            try { fs.unlinkSync(path.join(OUTPUT_DIR, name)); } catch { /* still running */ }
        }
    }
    if (!fs.existsSync(OUTPUT)) return;
    try {
        fs.unlinkSync(OUTPUT);
    } catch {
        fs.renameSync(OUTPUT, path.join(OUTPUT_DIR, `desktop-helper.old-${Date.now()}.exe`));
    }
}

function main() {
    if (process.platform !== 'win32') {
        console.log('build-desktop-helper: not Windows, nothing to build.');
        return;
    }

    const compiler = path.join(FRAMEWORK, 'csc.exe');
    const missing = [compiler, ...REFERENCES].filter(file => !fs.existsSync(file));
    if (missing.length > 0) {
        for (const file of missing) console.error(`  missing: ${file}`);
        throw new Error('build-desktop-helper: cannot compile the desktop helper');
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    setAside();

    execFileSync(compiler, [
        '/nologo',
        // A Windows program rather than a console one: no console window
        // flashes up when it starts, and stdin and stdout still work when the
        // app gives it pipes.
        '/target:winexe',
        '/platform:x64',
        '/optimize+',
        `/out:${OUTPUT}`,
        ...REFERENCES.map(file => `/reference:${file}`),
        SOURCE,
    ], { stdio: 'inherit' });

    const { size } = fs.statSync(OUTPUT);
    console.log(`build-desktop-helper: wrote ${path.relative(ROOT, OUTPUT)} (${(size / 1024).toFixed(1)} KB)`);
}

try {
    main();
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
