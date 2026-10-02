const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

/**
 * Browser use: the agent driving a real web browser, through the Playwright
 * MCP server (`npx @playwright/mcp`).
 *
 * The browser is not a tool of the app's own. It is an MCP server on the
 * agent's inventory like any other, and this module only answers the
 * questions the settings page needs to make switching it on one click:
 * whether a server record is the browser, whether this computer has what the
 * server needs (Node.js with npx, and a browser for it to open), and, when
 * Node.js is missing, installing it with the system's own package manager.
 *
 * Whether the agent is handed its browser servers at all is the per-agent
 * `browserUse` setting (settings.js). Switching it off keeps the record, so a
 * server set up by hand, with its own flags, is still there when it comes
 * back on.
 */

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

/** Where progress of an install goes: set by ipc, to every window. */
let notify = () => {};
function setNotifier(fn) {
    notify = typeof fn === 'function' ? fn : () => {};
}

/**
 * Whether a server record is the Playwright browser: made from the library's
 * template, or typed in by hand with the package in its arguments.
 */
function isBrowserServer(server) {
    if (!server || typeof server !== 'object') return false;
    if (server.template === 'playwright') return true;
    return (server.args || []).some(arg => /@playwright\/mcp\b/.test(String(arg)));
}

/**
 * The file a bare command name stands for on PATH, or '' if there is none.
 * On Windows each PATHEXT extension is tried, since `npx` there is
 * `npx.cmd`; elsewhere the file has to be executable.
 */
function findOnPath(name, extraDirs = []) {
    const dirs = [...String(process.env.PATH || '').split(path.delimiter), ...extraDirs].filter(Boolean);
    const exts = isWindows
        ? String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    for (const dir of dirs) {
        for (const ext of exts) {
            const candidate = path.join(dir, name + ext);
            try {
                const stat = fs.statSync(candidate);
                if (!stat.isFile()) continue;
                if (!isWindows) fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            } catch (error) {
                // An app execution alias (winget, in WindowsApps) is a link
                // that cannot be followed from here: stat says EACCES and
                // only lstat sees it. Starting it works all the same.
                if (isWindows && error?.code === 'EACCES') {
                    try {
                        if (fs.lstatSync(candidate).isSymbolicLink()) return candidate;
                    } catch {
                        // Not here either.
                    }
                }
            }
        }
    }
    return '';
}

/**
 * Where Node.js lands when it is installed, for a process whose PATH was
 * read before the install: the app does not see a PATH change until it is
 * restarted, and a Node.js installed a minute ago should work now.
 */
function nodeHomes() {
    if (isWindows) {
        return [
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
            process.env.NVM_SYMLINK || '',
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs'),
        ].filter(Boolean);
    }
    if (isMac) return ['/opt/homebrew/bin', '/usr/local/bin'];
    return ['/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin')];
}

/**
 * Put a directory on this process's PATH, so what it starts from now on
 * (the MCP launcher among them) finds what was just installed there.
 */
function addToPath(dir) {
    const parts = String(process.env.PATH || '').split(path.delimiter);
    const same = (a, b) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
    if (parts.some(part => same(part, dir))) return;
    process.env.PATH = [dir, ...parts].filter(Boolean).join(path.delimiter);
}

function run(file, args, { timeout = 15000 } = {}) {
    return new Promise((resolve) => {
        // A `.cmd` shim can only run through the shell on Windows.
        const shell = isWindows && /\.(cmd|bat)$/i.test(file);
        const target = shell ? `"${file}"` : file;
        execFile(target, args, { timeout, windowsHide: true, shell }, (error, stdout, stderr) => {
            resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
        });
    });
}

/** Node.js and npx, as this process would find them. */
async function findNode() {
    let npx = findOnPath('npx');
    if (!npx) {
        npx = findOnPath('npx', nodeHomes());
        if (npx) addToPath(path.dirname(npx));
    }
    if (!npx) return { found: false, version: '', npx: '' };

    const node = findOnPath('node', [path.dirname(npx)]);
    const answer = node ? await run(node, ['--version']) : { ok: false, stdout: '' };
    const version = answer.ok ? answer.stdout.replace(/^v/, '') : '';
    // Playwright needs a Node.js that is still supported; 18 is the floor.
    const major = Number(version.split('.')[0]) || 0;
    return { found: true, version, npx, recent: !version || major >= 18 };
}

/**
 * The browsers the server can open without downloading one: Chrome, or
 * Edge, which every Windows has. Playwright's own Chromium and Firefox
 * need an install of their own, so they are not offered here.
 */
function findBrowsers() {
    const local = process.env.LOCALAPPDATA || '';
    const programs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], local].filter(Boolean);
    const exists = (file) => {
        try { return fs.statSync(file).isFile() || fs.statSync(file).isDirectory(); } catch { return false; }
    };
    const first = (candidates) => candidates.find(exists) || '';

    if (isWindows) {
        return {
            chrome: first(programs.map(root => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))),
            msedge: first(programs.map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))),
        };
    }
    if (isMac) {
        const apps = ['/Applications', path.join(os.homedir(), 'Applications')];
        return {
            chrome: first(apps.map(dir => path.join(dir, 'Google Chrome.app'))),
            msedge: first(apps.map(dir => path.join(dir, 'Microsoft Edge.app'))),
        };
    }
    return {
        chrome: first(['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']),
        msedge: first(['/opt/microsoft/msedge/msedge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']),
    };
}

/**
 * How Node.js can be installed from here: winget on Windows, Homebrew on a
 * Mac that has it. Anything else is a download page, which the settings page
 * opens instead of running anything.
 */
function nodeInstaller() {
    if (isWindows) {
        const winget = findOnPath('winget', [path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps')]);
        if (winget) {
            return {
                name: 'winget',
                file: winget,
                args: ['install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--source', 'winget',
                    '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
            };
        }
    }
    if (isMac) {
        const brew = findOnPath('brew', ['/opt/homebrew/bin', '/usr/local/bin']);
        if (brew) return { name: 'brew', file: brew, args: ['install', 'node'] };
    }
    return null;
}

/** Everything the settings page needs to say what is missing, in one read. */
async function status() {
    const node = await findNode();
    const browsers = findBrowsers();
    const installer = nodeInstaller();
    return {
        platform: process.platform,
        node,
        browsers: { chrome: Boolean(browsers.chrome), msedge: Boolean(browsers.msedge) },
        // The browser a new server is set up with: the one people already
        // have open, else the one Windows ships.
        preferred: browsers.chrome ? 'chrome' : (browsers.msedge ? 'msedge' : ''),
        installer: installer ? installer.name : '',
    };
}

/**
 * Install Node.js with the package manager there is, its output passed along
 * a line at a time. Started only by the button that says so.
 */
function installNode() {
    const installer = nodeInstaller();
    if (!installer) return Promise.resolve({ ok: false, error: 'No package manager was found to install Node.js with.' });

    return new Promise((resolve) => {
        const child = spawn(installer.file, installer.args, { windowsHide: true });
        const lines = [];
        const hear = (chunk) => {
            for (const line of String(chunk).split(/\r?\n|\r/)) {
                const text = line.replace(/[\u0000-\u001f]/g, '').trim();
                // winget draws its progress bar with block characters; a
                // line of nothing but those says nothing as text.
                if (!text || /^[\s█▒░\-\\|/]+$/.test(text)) continue;
                lines.push(text);
                notify({ state: 'installing', line: text.slice(0, 200) });
            }
        };
        child.stdout.on('data', hear);
        child.stderr.on('data', hear);
        child.on('error', error => resolve({ ok: false, error: error.message }));
        child.on('exit', async (code) => {
            const node = await findNode();
            // winget says "already installed" with a non-zero code; what
            // matters is whether Node.js is there now.
            if (node.found) {
                notify({ state: 'installed' });
                resolve({ ok: true, node });
            } else {
                resolve({ ok: false, error: lines.slice(-4).join('\n') || `${installer.name} stopped with code ${code}` });
            }
        });
    });
}

module.exports = { setNotifier, isBrowserServer, status, installNode, findOnPath };
