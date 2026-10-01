/**
 * Compile the desktop helper: the agent's hands on this computer.
 *
 * On Windows, the same recipe as the Windows Hello helper
 * (build-hello-helper.js): the C# compiler that ships inside Windows, against
 * the .NET Framework assemblies that also ship inside Windows. UI Automation is
 * one of them, which is what lets this be a small exe rather than a Python
 * install or a native addon.
 *
 * On macOS, tools/mac/*.swift with the swiftc of the Xcode command line tools,
 * against the frameworks inside macOS: one binary holding both an Apple
 * silicon and an Intel build, so one package runs on either.
 *
 * Run by `npm run build:desktop`, and folded into `npm run build` and
 * `npm run build:mac`. On Linux it does nothing and says so.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'tools', 'DesktopHelper.cs');
const OUTPUT_DIR = path.join(ROOT, 'resources');
const OUTPUT = path.join(OUTPUT_DIR, 'desktop-helper.exe');
const MAC_SOURCES = path.join(ROOT, 'tools', 'mac');
const MAC_OUTPUT = path.join(OUTPUT_DIR, 'desktop-helper');
// ScreenCaptureKit's first release. Electron itself needs macOS 12.
const MAC_TARGET = '12.3';

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

function buildMac() {
    try {
        execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' });
    } catch {
        throw new Error('build-desktop-helper: swiftc not found. Install the Xcode command line tools: xcode-select --install');
    }
    const sources = fs.readdirSync(MAC_SOURCES)
        .filter(name => name.endsWith('.swift'))
        .map(name => path.join(MAC_SOURCES, name));
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const slices = [];
    for (const arch of ['arm64', 'x86_64']) {
        const slice = path.join(os.tmpdir(), `desktop-helper-${arch}-${process.pid}`);
        execFileSync('xcrun', [
            'swiftc',
            '-O',
            '-swift-version', '5',
            '-target', `${arch}-apple-macos${MAC_TARGET}`,
            '-o', slice,
            ...sources,
        ], { stdio: 'inherit' });
        slices.push(slice);
    }
    // Built beside the old one and renamed over it: a running app keeps the
    // file it started, where writing into it would break its signature and
    // have macOS kill it.
    const fresh = `${MAC_OUTPUT}.new`;
    execFileSync('xcrun', ['lipo', '-create', '-output', fresh, ...slices], { stdio: 'inherit' });
    for (const slice of slices) fs.rmSync(slice, { force: true });
    // Apple silicon runs nothing unsigned. An ad hoc signature is enough for
    // a checkout; a package is signed again with the app.
    execFileSync('codesign', ['--force', '--sign', '-', fresh], { stdio: 'inherit' });
    fs.renameSync(fresh, MAC_OUTPUT);

    const { size } = fs.statSync(MAC_OUTPUT);
    console.log(`build-desktop-helper: wrote ${path.relative(ROOT, MAC_OUTPUT)} (${(size / 1024).toFixed(1)} KB)`);
}

function main() {
    if (process.platform === 'darwin') {
        buildMac();
        return;
    }
    if (process.platform !== 'win32') {
        console.log('build-desktop-helper: not Windows or macOS, nothing to build.');
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
