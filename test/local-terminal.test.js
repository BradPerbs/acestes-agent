/**
 * The shells beside a conversation: which shells a machine offers, where one
 * starts, what it inherits, that a panel remounting gets its running shell
 * back rather than a new one, and that a conversation's terminals end
 * together.
 *
 * `electron` and the pty binding are stubbed, so it runs under plain node
 * and never starts a real shell.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-local-terminal-'));

/** Ports that record what was posted, so a test can read what a pane got. */
class FakePort {
    constructor() { this.posted = []; this.closed = false; this.listeners = {}; }
    on(name, fn) { this.listeners[name] = fn; }
    start() {}
    postMessage(message) { if (this.closed) throw new Error('closed'); this.posted.push(message); }
    close() { this.closed = true; }
}

const spawned = [];
const fakePty = {
    spawn(file, args, options) {
        const pty = {
            file, args, options, written: [], killed: false, size: [options.cols, options.rows],
            dataHandler: null, exitHandler: null,
            onData(fn) { this.dataHandler = fn; },
            onExit(fn) { this.exitHandler = fn; },
            write(data) { this.written.push(data); },
            resize(cols, rows) { this.size = [cols, rows]; },
            kill() { this.killed = true; },
        };
        spawned.push(pty);
        return pty;
    },
};

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    MessageChannelMain: class { constructor() { this.port1 = new FakePort(); this.port2 = new FakePort(); } },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: { handle: () => {}, on: () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === '@lydell/node-pty') return fakePty;
    return realLoad.call(this, request, parent, isMain);
};

const local = require(path.join(ROOT, 'local-terminal'));
const transcript = require(path.join(ROOT, 'transcript'));

let passed = 0;
let failed = 0;
const check = async (label, fn) => {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        failed++;
    }
};

/** A window whose posted ports are kept, the way webContents hands them over. */
function fakeWindow(id = 1) {
    const ports = [];
    const listeners = {};
    return {
        ports,
        listeners,
        isDestroyed: () => false,
        webContents: {
            id,
            postMessage: (channel, payload, transfer) => ports.push({ channel, payload, port: transfer[0] }),
            on: (name, fn) => { listeners[name] = fn; },
            once: (name, fn) => { listeners[name] = fn; },
        },
    };
}

/** Two shells, so a test can pick one that is not the default. */
const SHELLS = async () => [
    { id: 'powershell', label: 'PowerShell', file: 'powershell.exe', args: ['-NoLogo'] },
    { id: 'git-bash', label: 'Git Bash', file: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } },
];

const WIN_ENV = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Tools' };
const has = (...files) => (file) => files.includes(file);

async function run() {
    console.log('\nlocal terminal');

    await check('Windows offers Windows PowerShell and Command Prompt, always', async () => {
        const shells = await local.detectShells({ platform: 'win32', env: WIN_ENV, exists: () => false, wslDistros: async () => [] });
        assert.deepStrictEqual(shells.map(shell => shell.id), ['powershell', 'cmd']);
        assert.strictEqual(shells[0].label, 'PowerShell', 'with no PowerShell 7 it is just PowerShell');
    });

    await check('PowerShell 7 leads when it is installed, and Git Bash is found where Git put it', async () => {
        const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
        const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
        const shells = await local.detectShells({
            platform: 'win32', env: WIN_ENV, exists: has(pwsh, bash), wslDistros: async () => [],
        });
        assert.deepStrictEqual(shells.map(shell => shell.id), ['pwsh', 'powershell', 'git-bash', 'cmd']);
        assert.strictEqual(shells[1].label, 'Windows PowerShell');
        const gitBash = shells.find(shell => shell.id === 'git-bash');
        assert.deepStrictEqual(gitBash.args, ['--login', '-i']);
        assert.strictEqual(gitBash.env.CHERE_INVOKING, '1', 'so the login profile does not move it to home');
    });

    await check('a Git on PATH leads to its own bash', async () => {
        const git = 'D:\\Apps\\Git\\cmd\\git.exe';
        const bash = 'D:\\Apps\\Git\\bin\\bash.exe';
        const shells = await local.detectShells({
            platform: 'win32', env: { ...WIN_ENV, PATH: 'D:\\Apps\\Git\\cmd' }, exists: has(git, bash), wslDistros: async () => [],
        });
        assert.strictEqual(shells.find(shell => shell.id === 'git-bash')?.file, bash);
    });

    await check('each WSL distribution is a shell, Docker\'s own are not', async () => {
        const wsl = 'C:\\Windows\\System32\\wsl.exe';
        const utf16 = Buffer.from('\uFEFFUbuntu\r\ndocker-desktop\r\ndocker-desktop-data\r\nDebian\r\n', 'utf16le');
        const distros = await local.listWslDistros(wsl, (file, args, options, callback) => callback(null, utf16));
        assert.deepStrictEqual(distros, ['Ubuntu', 'Debian']);
        const shells = await local.detectShells({ platform: 'win32', env: WIN_ENV, exists: has(wsl), wslDistros: async () => distros });
        const ubuntu = shells.find(shell => shell.id === 'wsl:Ubuntu');
        assert.strictEqual(ubuntu.label, 'Ubuntu (WSL)');
        assert.deepStrictEqual(ubuntu.args, ['-d', 'Ubuntu']);
        const none = await local.listWslDistros(wsl, (file, args, options, callback) => callback(new Error('no wsl')));
        assert.deepStrictEqual(none, []);
    });

    await check('elsewhere it is /etc/shells, the user\'s own first, as login shells', async () => {
        const shells = await local.detectShells({
            platform: 'darwin',
            env: { SHELL: '/opt/homebrew/bin/fish' },
            exists: has('/bin/zsh', '/bin/bash', '/opt/homebrew/bin/fish', '/usr/bin/false'),
            readShells: () => '# shells\n/bin/bash\n/bin/zsh\n/usr/bin/false\n/bin/nowhere\n/bin/zsh\n',
        });
        assert.deepStrictEqual(shells.map(shell => shell.id), ['fish', 'bash', 'zsh']);
        assert.ok(shells.every(shell => shell.args[0] === '-l'));
    });

    await check('it starts in the folder the agent may write, then any granted one, then home', () => {
        const exists = () => true;
        const read = { path: '/srv/docs', mode: 'read' };
        const write = { path: '/home/me/app', mode: 'write' };
        assert.strictEqual(local.startFolder({ folders: [read, write] }, exists), write.path);
        assert.strictEqual(local.startFolder({ folders: [read] }, exists), read.path);
        assert.strictEqual(local.startFolder({ folders: [] }, exists), os.homedir());
        assert.strictEqual(local.startFolder(null, exists), os.homedir());
        assert.strictEqual(local.startFolder({ folders: [write] }, () => false), os.homedir(), 'a folder gone missing is skipped');
    });

    await check('the folders offered are the agent\'s, writable first, and only ones that are there', () => {
        const sandbox = { folders: [{ path: '/srv/docs', mode: 'read' }, { path: '/home/me/app', mode: 'write' }, { path: '/gone', mode: 'write' }] };
        const choices = local.folderChoices(sandbox, dir => dir !== '/gone');
        assert.deepStrictEqual(choices.map(folder => folder.path), ['/home/me/app', '/srv/docs']);
        assert.strictEqual(choices[0].name, 'app');
    });

    await check('a folder picked is honoured when it is the agent\'s, and ignored when it is not', () => {
        const sandbox = { folders: [{ path: '/home/me/app', mode: 'write' }, { path: '/home/me/site', mode: 'write' }] };
        const exists = () => true;
        assert.strictEqual(local.startFolder(sandbox, exists, '/home/me/site'), '/home/me/site');
        assert.strictEqual(local.startFolder(sandbox, exists, '/etc'), '/home/me/app', 'a path the agent was never given falls back');
        assert.strictEqual(local.startFolder(sandbox, exists, ''), '/home/me/app');
    });

    await check('an Electron app started from the shell is not turned into plain Node', () => {
        const env = local.shellEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }, { CHERE_INVOKING: '1' });
        assert.strictEqual(env.ELECTRON_RUN_AS_NODE, undefined);
        assert.strictEqual(env.PATH, '/bin');
        assert.strictEqual(env.CHERE_INVOKING, '1', 'and the shell\'s own additions are there');
        assert.strictEqual(env.TERM, 'xterm-256color');
    });

    await check('opening a terminal starts the shell picked, and hands its window a port', async () => {
        const window = fakeWindow();
        const result = await local.open({ id: 'local-t1:1', shellId: 'git-bash', cols: 100, rows: 30 }, { window, shells: SHELLS });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.attached, false);
        assert.strictEqual(result.shell, 'git-bash');
        const pty = spawned[spawned.length - 1];
        assert.strictEqual(pty.file, 'C:\\Git\\bin\\bash.exe');
        assert.strictEqual(pty.options.env.CHERE_INVOKING, '1');
        assert.deepStrictEqual(pty.size, [100, 30]);
        assert.strictEqual(window.ports[0].payload.tabId, 'local-t1:1');
    });

    await check('a shell that is not there, or none, is the default', async () => {
        const result = await local.open({ id: 'local-t1:2', shellId: 'zsh' }, { window: fakeWindow(), shells: SHELLS });
        assert.strictEqual(result.shell, 'powershell');
    });

    await check('what is typed reaches the shell, and what it prints is recorded', () => {
        const pty = spawned[0];
        const session = local.get('local-t1:1');
        session.pipe.port.listeners.message({ data: { type: 'input', data: 'npm run dev\r' } });
        assert.deepStrictEqual(pty.written, ['npm run dev\r']);
        pty.dataHandler('  Local:   http://localhost:5173/\r\n');
        assert.ok(transcript.read('local-t1:1').text.includes('localhost:5173'), 'the agent can read it like any session');
        assert.strictEqual(local.write('local-t1:1', 'git status\r'), true, 'and type into it, for run_command');
        assert.deepStrictEqual(pty.written, ['npm run dev\r', 'git status\r']);
        assert.strictEqual(local.write('local-nope', 'x'), false);
    });

    await check('a remounted panel gets the same shell back, with what it showed', async () => {
        const count = spawned.length;
        const result = await local.open({ id: 'local-t1:1', shellId: 'git-bash', cols: 120, rows: 40 }, { window: fakeWindow(), shells: SHELLS });
        assert.strictEqual(result.attached, true);
        assert.strictEqual(spawned.length, count, 'no second shell was started');
        assert.deepStrictEqual(spawned[0].size, [120, 40], 'and it took the new size');
        assert.ok(String(local.get('local-t1:1').pipe.port.posted[0]).includes('localhost:5173'), 'the backlog comes first');
    });

    await check('closing one terminal ends only its shell', () => {
        assert.strictEqual(local.destroy('local-t1:2'), true);
        assert.strictEqual(spawned[1].killed, true);
        assert.ok(local.get('local-t1:1'), 'its neighbour runs on');
        assert.strictEqual(local.destroy('local-t1:2'), false);
    });

    await check('closing the project ends all of its terminals and nobody else\'s', async () => {
        await local.open({ id: `${local.groupForAgent('agent-1')}:1` }, { window: fakeWindow(), shells: SHELLS });
        await local.open({ id: `${local.groupForAgent('agent-1')}:2` }, { window: fakeWindow(), shells: SHELLS });
        await local.open({ id: `${local.groupForAgent('agent-2')}:1` }, { window: fakeWindow(), shells: SHELLS });
        assert.strictEqual(local.destroyGroup(local.groupForAgent('agent-1')), 2);
        assert.strictEqual(local.get(`${local.groupForAgent('agent-1')}:1`), undefined);
        assert.strictEqual(local.get(`${local.groupForAgent('agent-1')}:2`), undefined);
        assert.ok(local.get(`${local.groupForAgent('agent-2')}:1`), 'another project\'s terminal is untouched');
        assert.strictEqual(local.destroyGroup('local-agent'), 0, 'a prefix of a group is not the group');
        assert.strictEqual(local.destroyGroup(local.groupForAgent('agent-1')), 0, 'ending it twice ends nothing');
        local.destroy(`${local.groupForAgent('agent-2')}:1`);
    });

    await check('one project\'s group never matches another\'s longer id', async () => {
        await local.open({ id: `${local.groupForAgent('agent-1')}:1` }, { window: fakeWindow(), shells: SHELLS });
        await local.open({ id: `${local.groupForAgent('agent-12')}:1` }, { window: fakeWindow(), shells: SHELLS });
        assert.strictEqual(local.destroyGroup(local.groupForAgent('agent-1')), 1);
        assert.ok(local.get(`${local.groupForAgent('agent-12')}:1`), 'agent-12 survives agent-1 going');
        local.destroyAll();
    });

    await check('a shell that exits on its own tells the pane and is gone', async () => {
        await local.open({ id: 'local-t3:1' }, { window: fakeWindow(), shells: SHELLS });
        const pty = spawned[spawned.length - 1];
        const port = local.get('local-t3:1').pipe.port;
        pty.exitHandler({ exitCode: 0 });
        assert.ok(port.posted.some(message => message?.type === 'disconnected'));
        assert.strictEqual(local.get('local-t3:1'), undefined);
    });

    await check('a window that reloads takes its shells with it, and a hash change does not', async () => {
        const window = fakeWindow(7);
        await local.open({ id: 'local-t4:1' }, { window, shells: SHELLS });
        window.listeners['did-start-navigation']({ isMainFrame: true, isSameDocument: true });
        assert.ok(local.get('local-t4:1'));
        window.listeners['did-start-navigation']({ isMainFrame: true, isSameDocument: false });
        assert.strictEqual(local.get('local-t4:1'), undefined);
        local.destroyAll();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
