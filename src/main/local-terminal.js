const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { createPipe } = require('./session-pipe');
const transcript = require('./transcript');
const agents = require('./agents');

/**
 * Shells on this computer, in a panel beside a conversation.
 *
 * Working on an app with the agent means running it too: `npm run dev` in one
 * terminal and the tests in another while the chat edits the code. That needs
 * real terminals on this machine, not the agent's run_local_command, which
 * runs one command and returns. So these are pseudo-terminals: the user's own
 * shells, whichever ones this machine has, with job control, colours, Ctrl+C,
 * and a dev server that keeps running.
 *
 * Same shape as the other transports (one session per id, a MessagePort
 * carrying the bytes, the transcript fed on the way through) with three
 * differences:
 *
 *   There is no host record. A terminal belongs to a project's panel, so
 *   it is opened by id, with the shell the user picked from `listShells`, and
 *   starts in the agent's first granted folder, the project it is working on,
 *   or the home folder when it has none.
 *
 *   A project has several, shared by all of its chats. Their ids are
 *   `<group>:<n>`, the group being the project's (see `groupForAgent`), so
 *   removing the project ends all of them at once while closing a chat ends
 *   none.
 *
 *   It outlives its pane. The panel is remounted whenever a conversation moves
 *   in or out of the split view, and hidden whenever the user puts it away; a
 *   dev server killed by either would be a terminal nobody could rely on. So
 *   unmounting only lets go of the port, opening the same id again attaches
 *   to the running shell with its recent output replayed, and the shell ends
 *   when it exits, when its tab is closed, or when the app quits or locks.
 *
 * `@lydell/node-pty` is loaded lazily and its absence reported, like the
 * serial binding: a missing native build costs this panel, never the app.
 */

// id -> { pty, pipe, agentId, cwd, shell, backlog, owner, openedAt }; `owner`
// is the id of the webContents drawing it.
const sessions = new Map();

/** Raw output kept for a re-attach: a screenful of history, with its colours. */
const BACKLOG_CHARS = 200000;

let binding = null;
let bindingError = '';

function load() {
    if (binding || bindingError) return binding;
    try {
        // eslint-disable-next-line global-require
        binding = require('@lydell/node-pty');
    } catch (error) {
        bindingError = `The local terminal could not be loaded: ${error.message}`;
        console.error('node-pty unavailable:', error.message);
    }
    return binding;
}

/* ------------------------------------------------------------------ *
 * Which shells there are
 * ------------------------------------------------------------------ */

const isFile = (file) => {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
};

/** Where a program is on PATH, or ''. `paths` is the platform's path rules. */
function findOnPath(program, env = process.env, exists = isFile, paths = path) {
    const dirs = String(env.PATH || env.Path || '').split(paths.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = paths.join(dir, program);
        if (exists(candidate)) return candidate;
    }
    return '';
}

/**
 * Git Bash, wherever Git for Windows was put. The installer's default folders
 * first, then whichever Git is on PATH: its `cmd` or `mingw64\bin` folder sits
 * inside the same install as `bin\bash.exe`.
 */
function findGitBash(env = process.env, exists = isFile, paths = path.win32) {
    const roots = [
        env.ProgramFiles && paths.join(env.ProgramFiles, 'Git'),
        env['ProgramFiles(x86)'] && paths.join(env['ProgramFiles(x86)'], 'Git'),
        env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, 'Programs', 'Git'),
    ].filter(Boolean);
    const git = findOnPath('git.exe', env, exists, paths);
    if (git) {
        const dir = paths.dirname(git);
        roots.push(paths.resolve(dir, '..'), paths.resolve(dir, '..', '..'));
    }
    for (const root of roots) {
        const bash = paths.join(root, 'bin', 'bash.exe');
        if (exists(bash)) return bash;
    }
    return '';
}

/**
 * The WSL distributions a person would open a shell in. Docker Desktop keeps
 * two of its own in the same list, which are machinery rather than places to
 * work, so they are left out. `wsl -l -q` answers in UTF-16; a machine
 * without WSL, or one that takes too long to answer, has none.
 */
function listWslDistros(wsl, run = execFile) {
    return new Promise((resolve) => {
        run(wsl, ['-l', '-q'], { encoding: 'buffer', timeout: 4000, windowsHide: true }, (error, stdout) => {
            if (error || !stdout) {
                resolve([]);
                return;
            }
            const text = Buffer.from(stdout).toString('utf16le').replace(/\u0000/g, '').replace(/^\uFEFF/, '');
            resolve(text.split(/\r?\n/)
                .map(line => line.trim())
                .filter(name => name && !/^docker-desktop/i.test(name)));
        });
    });
}

/**
 * Every shell this machine can open, the default first.
 *
 * Windows: PowerShell 7 when it is installed, then Windows PowerShell, which
 * every Windows has, Git Bash, Command Prompt, and a shell in each WSL
 * distribution. Elsewhere: the shells /etc/shells lists that are there, the
 * user's own first, each started as a login shell so the PATH their profile
 * builds (nvm, Homebrew, pyenv) is there. A GUI app on macOS inherits almost
 * none of it, and `npm` not being found would be the first thing anyone saw.
 *
 * `{ id, label, file, args, env }`; the id is what the renderer remembers.
 */
async function detectShells({
    platform = process.platform,
    env = process.env,
    exists = isFile,
    readShells = () => fs.readFileSync('/etc/shells', 'utf8'),
    wslDistros = listWslDistros,
} = {}) {
    if (platform === 'win32') {
        // Windows path rules whatever this runs on, so the answer does not
        // depend on the machine asking.
        const win = path.win32;
        const system = win.join(env.SystemRoot || 'C:\\Windows', 'System32');
        const shells = [];

        const pwsh = findOnPath('pwsh.exe', env, exists, win)
            || [env.ProgramFiles && win.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe')].find(file => file && exists(file));
        if (pwsh) shells.push({ id: 'pwsh', label: 'PowerShell', file: pwsh, args: ['-NoLogo'] });

        shells.push({
            id: 'powershell',
            label: pwsh ? 'Windows PowerShell' : 'PowerShell',
            file: win.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            args: ['-NoLogo'],
        });

        const gitBash = findGitBash(env, exists, win);
        if (gitBash) {
            // CHERE_INVOKING keeps the login profile from moving to home: the
            // shell has to start in the project, which is the point of it.
            shells.push({ id: 'git-bash', label: 'Git Bash', file: gitBash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } });
        }

        shells.push({ id: 'cmd', label: 'Command Prompt', file: env.ComSpec || win.join(system, 'cmd.exe'), args: [] });

        const wsl = win.join(system, 'wsl.exe');
        if (exists(wsl)) {
            for (const distro of await wslDistros(wsl)) {
                shells.push({ id: `wsl:${distro}`, label: `${distro} (WSL)`, file: wsl, args: ['-d', distro] });
            }
        }
        return shells;
    }

    // /etc/shells also lists shells that are not for people: the ones that
    // refuse logins, and restricted variants.
    const unwanted = new Set(['nologin', 'false', 'git-shell', 'rbash']);
    let listed = [];
    try {
        listed = String(readShells()).split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('/'));
    } catch {
        listed = [];
    }
    const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    const own = env.SHELL || fallback;
    const byName = new Map();
    for (const file of [own, ...listed, fallback]) {
        const name = path.posix.basename(file);
        if (unwanted.has(name) || byName.has(name) || !exists(file)) continue;
        byName.set(name, { id: name, label: name, file, args: ['-l'] });
    }
    if (byName.size === 0) {
        const name = path.posix.basename(own);
        byName.set(name, { id: name, label: name, file: own, args: ['-l'] });
    }
    return [...byName.values()];
}

/**
 * The shells, detected once per run: a menu opened ten times should not ask
 * WSL ten times. `fresh` looks again, for a shell installed since.
 */
let shellCache = null;
function listShells({ fresh = false } = {}) {
    if (!shellCache || fresh) {
        shellCache = detectShells().catch((error) => {
            console.error('Could not list the shells:', error.message);
            shellCache = null;
            return [];
        });
    }
    return shellCache;
}

/**
 * The agent's folders a shell can start in: the ones granted for writing
 * first, then the rest, leaving out any that have gone missing. The panel
 * starts a shell in the only one without asking, and asks which when there
 * are several.
 */
function folderChoices(sandbox, exists = (dir) => fs.existsSync(dir)) {
    const folders = Array.isArray(sandbox?.folders) ? sandbox.folders : [];
    return [
        ...folders.filter(folder => folder?.mode === 'write'),
        ...folders.filter(folder => folder?.mode !== 'write'),
    ]
        .filter(folder => folder?.path && exists(folder.path))
        .map(folder => ({ path: folder.path, name: path.basename(folder.path) || folder.path, mode: folder.mode }));
}

/** The folders for an agent by id, for the panel's picker. */
function listFolders(agentId) {
    const agent = agents.get(agentId);
    return agent ? folderChoices(agents.sandbox(agent.id)) : [];
}

/**
 * Where a shell starts: the folder the user picked when it is one of the
 * agent's, else the agent's first folder, else home. The pick is checked
 * rather than trusted, so a stale or made-up path cannot put a shell
 * somewhere the agent was never given.
 */
function startFolder(sandbox, exists = (dir) => fs.existsSync(dir), chosen = '') {
    const choices = folderChoices(sandbox, exists);
    if (chosen) {
        const fold = (value) => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
        const match = choices.find(folder => fold(folder.path) === fold(chosen));
        if (match) return match.path;
    }
    return choices[0]?.path || os.homedir();
}

/**
 * The environment a shell gets: the app's own, which is the user's, minus
 * what would change how a program run in it behaves, plus what the chosen
 * shell asks for. ELECTRON_RUN_AS_NODE turns any Electron app started from
 * the shell into plain Node, which is exactly the app somebody working on an
 * Electron project runs first.
 */
function shellEnv(base = process.env, extra = {}) {
    const env = { ...base, ...extra };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    return env;
}

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

function get(id) {
    return sessions.get(id);
}

function describe(id) {
    const session = sessions.get(id);
    return { hostId: '', hostName: session ? 'This computer' : '', subject: session?.cwd || '' };
}

/**
 * End a window's shells when it reloads or closes.
 *
 * A remount inside the page attaches again by id, but a reload starts the
 * page over with new tab ids, so nothing would ever ask for these shells
 * again: they would run on out of sight, a dev server holding its port,
 * until the app quit. Watched once per window.
 */
const watched = new Set();
function watchOwner(contents) {
    if (!contents || watched.has(contents.id)) return;
    watched.add(contents.id);
    const id = contents.id;
    const endAll = () => {
        for (const [key, session] of [...sessions]) {
            if (session.owner === id) destroy(key);
        }
    };
    // The page itself going away, not a frame in it or a hash change.
    contents.on('did-start-navigation', (details) => {
        if (details?.isMainFrame && !details.isSameDocument) endAll();
    });
    contents.once('destroyed', () => {
        watched.delete(id);
        endAll();
    });
}

const clampSize = (value, fallback) => {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 1 && number < 1000 ? number : fallback;
};

/**
 * Open a terminal for a panel, or give the panel back the one it already has.
 *
 * `id` is the terminal's, stable across remounts. `shellId` is one of
 * `listShells`; one that is not there, or none, is the default. The window
 * asking gets the port, as for any session.
 */
async function open({ id, agentId = '', shellId = '', cwd: chosen = '', cols = 80, rows = 24 } = {}, { window, shells = listShells } = {}) {
    if (!id || typeof id !== 'string') return { success: false, message: 'No terminal id' };

    const contents = window && !window.isDestroyed() ? window.webContents : null;
    watchOwner(contents);

    const existing = sessions.get(id);
    if (existing) {
        existing.owner = contents?.id ?? existing.owner;
        existing.pipe.attach(window, existing.backlog);
        try {
            existing.pty.resize(clampSize(cols, 80), clampSize(rows, 24));
        } catch {
            // Exited in the moment between the two calls; its exit closes it.
        }
        return { success: true, attached: true, cwd: existing.cwd, home: existing.cwd === os.homedir(), shell: existing.shell };
    }

    if (!load()) return { success: false, message: bindingError };

    const available = await shells();
    const shell = available.find(entry => entry.id === shellId) || available[0];
    if (!shell) return { success: false, message: 'No shell was found on this computer' };

    // Opened again while the shell list was being read: the first one won.
    if (sessions.has(id)) return open({ id, agentId, shellId, cwd: chosen, cols, rows }, { window, shells });

    const agent = agents.get(agentId);
    const cwd = startFolder(agent ? agents.sandbox(agent.id) : null, undefined, chosen);

    let pty;
    try {
        pty = binding.spawn(shell.file, shell.args, {
            name: 'xterm-256color',
            cols: clampSize(cols, 80),
            rows: clampSize(rows, 24),
            cwd,
            env: shellEnv(process.env, shell.env),
        });
    } catch (error) {
        return { success: false, message: `Could not start ${shell.label}: ${error.message}` };
    }

    const pipe = createPipe({
        tabId: id,
        window,
        label: { hostName: `This computer (${shell.label})`, address: cwd, hostId: '' },
        protocol: 'local',
        onInput: (data) => {
            try {
                pty.write(data);
            } catch {
                // The shell has exited; onExit is already tearing this down.
            }
        },
        onResize: (nextCols, nextRows) => {
            try {
                pty.resize(clampSize(nextCols, 80), clampSize(nextRows, 24));
            } catch {
                // Same as above.
            }
        },
    });

    // The agent that owns the conversation may read what this shows, and
    // others may not, the same rule as a session an agent opened itself.
    if (agent) transcript.claim(id, agent.id);

    const session = {
        pty,
        pipe,
        agentId: agent?.id || '',
        cwd,
        shell: shell.id,
        backlog: '',
        owner: contents?.id ?? null,
        openedAt: Date.now(),
    };
    sessions.set(id, session);

    pty.onData((data) => {
        session.backlog = (session.backlog + data).slice(-BACKLOG_CHARS);
        pipe.deliver(data);
    });

    pty.onExit(({ exitCode }) => {
        if (sessions.get(id) !== session) return;
        pipe.deliver(`\r\n\x1b[2m>> The shell exited${exitCode ? ` with code ${exitCode}` : ''}.\x1b[0m\r\n`);
        pipe.disconnected();
        sessions.delete(id);
        pipe.close();
    });

    // `home`: none of the agent's folders was there to start in, which the
    // tab says, so a shell in the wrong place is noticed at a glance.
    return { success: true, attached: false, cwd, home: cwd === os.homedir(), shell: shell.id };
}

/**
 * Type into a running shell, for the agent's run_command. What the user
 * types arrives through the pane's port instead; both reach the same pty.
 */
function write(id, data) {
    const session = sessions.get(id);
    if (!session) return false;
    try {
        session.pty.write(String(data ?? ''));
        return true;
    } catch {
        return false;
    }
}

/** End one terminal's shell, and whatever it is running. */
function destroy(id) {
    const session = sessions.get(id);
    if (!session) return false;
    sessions.delete(id);
    session.pipe.close();
    try {
        session.pty.kill();
    } catch {
        // Already gone.
    }
    return true;
}

/**
 * The group one project's terminal ids share: `<group>:<n>`. Mirrored in the
 * renderer (see useLocalTerminals `localTerminalGroupForAgent`); the two
 * have to agree, since the renderer names the ids and main ends the group.
 */
function groupForAgent(agentId) {
    return `local-agent-${agentId}`;
}

/** End every terminal of one project: the ids `<group>:<n>`. */
function destroyGroup(group) {
    if (!group) return 0;
    let ended = 0;
    for (const id of [...sessions.keys()]) {
        if (id.startsWith(`${group}:`) && destroy(id)) ended += 1;
    }
    return ended;
}

function destroyAll() {
    for (const id of [...sessions.keys()]) destroy(id);
}

/**
 * Not dialled through a host record, so the transport's connect never routes
 * here; `open` is the way in. Present so this sits in the transport's table
 * with the others and is closed, described and listed with them.
 */
function connect() {
    return Promise.resolve({ success: false, message: 'A local terminal is opened from its panel' });
}

module.exports = {
    open,
    write,
    connect,
    get,
    describe,
    destroy,
    destroyGroup,
    groupForAgent,
    destroyAll,
    listShells,
    listFolders,
    detectShells,
    listWslDistros,
    folderChoices,
    startFolder,
    shellEnv,
};
