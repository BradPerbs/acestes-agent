const assert = require('assert');

const provider = require('../src/main/ai/providers/codex');

/**
 * A filesystem made of nothing but the paths given, so a lookup can be asked
 * "what would you find on a machine that installed Codex this way".
 */
function fakeFs(files, sep) {
    const known = new Map(Object.entries(files));
    const all = [...known.keys()];

    return {
        readdirSync(dir) {
            const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
            const names = new Map();
            for (const file of all) {
                if (!file.startsWith(prefix)) continue;
                const rest = file.slice(prefix.length);
                const cut = rest.indexOf(sep);
                if (cut < 0) names.set(rest, false);
                else names.set(rest.slice(0, cut), true);
            }
            if (!names.size) throw new Error(`ENOENT: ${dir}`);
            return [...names].map(([name, directory]) => ({ name, isDirectory: () => directory }));
        },
        statSync(file) {
            if (!known.has(file)) throw new Error(`ENOENT: ${file}`);
            return { mtimeMs: known.get(file) };
        },
        accessSync(file) {
            if (!known.has(file)) throw new Error(`ENOENT: ${file}`);
        },
    };
}

const WINDOWS_HOME = 'C:\\Users\\Mario';
const UNIX_HOME = '/Users/mario';

function onWindows(files, env = {}) {
    return provider.findCodex({
        platform: 'win32',
        home: WINDOWS_HOME,
        env,
        ...fakeFs(files, '\\'),
    });
}

function onUnix(files, env = {}, home = UNIX_HOME) {
    return provider.findCodex({
        platform: 'darwin',
        home,
        env,
        ...fakeFs(files, '/'),
    });
}

async function run() {
    const windowsRoots = provider.codexRoots({
        platform: 'win32',
        home: WINDOWS_HOME,
        env: {
            Path: 'C:\\Tools;D:\\Bin',
            APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming',
            LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local',
            ChocolateyInstall: 'C:\\ProgramData\\chocolatey',
            SCOOP: 'D:\\Scoop',
        },
    });
    assert(windowsRoots.includes('C:\\Tools'));
    assert(windowsRoots.includes('D:\\Bin'));
    assert(windowsRoots.includes('C:\\Users\\Mario\\AppData\\Roaming\\npm'));
    assert(windowsRoots.includes('D:\\Scoop\\shims'));
    assert(windowsRoots.includes('C:\\ProgramData\\chocolatey\\bin'));
    assert(windowsRoots.includes('C:\\Users\\Mario\\AppData\\Local\\OpenAI\\Codex\\bin'));

    const unixRoots = provider.codexRoots({
        platform: 'darwin',
        home: UNIX_HOME,
        env: { PATH: '/opt/bin:/usr/sbin' },
    });
    assert(unixRoots.includes('/opt/bin'));
    assert(unixRoots.includes('/usr/sbin'));
    assert(unixRoots.includes('/opt/homebrew/bin'));
    assert(unixRoots.includes('/usr/local/bin'));
    assert(unixRoots.includes(`${UNIX_HOME}/.local/bin`));

    // The desktop app's newest hashed folder still wins, and still beats PATH.
    assert.strictEqual(onWindows({
        'C:\\Users\\Mario\\AppData\\Local\\OpenAI\\Codex\\bin\\aaa\\codex.exe': 100,
        'C:\\Users\\Mario\\AppData\\Local\\OpenAI\\Codex\\bin\\bbb\\codex.exe': 200,
        'C:\\Tools\\codex.exe': 300,
    }, {
        Path: 'C:\\Tools',
        LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local',
    }), 'C:\\Users\\Mario\\AppData\\Local\\OpenAI\\Codex\\bin\\bbb\\codex.exe');

    // No desktop app, only a CLI on PATH.
    assert.strictEqual(onWindows({
        'D:\\Bin\\codex.exe': 1,
    }, { Path: 'D:\\Bin' }), 'D:\\Bin\\codex.exe');

    // An npm install resolves through the shim to the vendored executable,
    // because the shim itself cannot be spawned without a shell.
    const vendored = 'C:\\Users\\Mario\\AppData\\Roaming\\npm\\node_modules\\@openai'
        + '\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe';
    assert.strictEqual(onWindows({
        'C:\\Users\\Mario\\AppData\\Roaming\\npm\\codex.cmd': 1,
        'C:\\Users\\Mario\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex-sdk\\package.json': 1,
        [vendored]: 1,
    }, { APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming' }), vendored);

    // With no executable anywhere the shim is still better than reporting that
    // Codex is not installed.
    assert.strictEqual(onWindows({
        'C:\\Users\\Mario\\AppData\\Roaming\\npm\\codex.cmd': 1,
    }, { APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming' }), 'C:\\Users\\Mario\\AppData\\Roaming\\npm\\codex.cmd');

    assert.strictEqual(onWindows({}, { Path: 'C:\\Tools' }), '');

    // Homebrew, with nothing on the PATH the packaged app inherited.
    assert.strictEqual(onUnix({ '/opt/homebrew/bin/codex': 1 }), '/opt/homebrew/bin/codex');

    // The official install script.
    assert.strictEqual(onUnix({ [`${UNIX_HOME}/.local/bin/codex`]: 1 }), `${UNIX_HOME}/.local/bin/codex`);

    // A binary sitting directly in one of the app's own folders rather than in
    // a hashed subfolder of it, which the old lookup skipped as "not a folder".
    assert.strictEqual(onUnix({ [`${UNIX_HOME}/.codex/bin/codex`]: 1 }), `${UNIX_HOME}/.codex/bin/codex`);

    // PATH leads: someone who arranged their own has already chosen.
    assert.strictEqual(onUnix({
        '/opt/homebrew/bin/codex': 1,
        '/opt/mine/codex': 1,
    }, { PATH: '/opt/mine' }), '/opt/mine/codex');

    assert.strictEqual(onUnix({}), '');

    // Where Codex may write follows the agent's grants, not the temp folder.
    const temp = require('os').tmpdir();
    const repo = { path: 'C:\\Users\\Mario\\repo', mode: 'write' };
    const docs = { path: 'C:\\Users\\Mario\\docs', mode: 'read' };
    const site = { path: 'C:\\Users\\Mario\\site', mode: 'write' };

    const granted = provider.threadOptions({ allowLocalTools: true, sandbox: { folders: [docs, repo, site] } });
    assert.strictEqual(granted.sandboxMode, 'workspace-write');
    assert.strictEqual(granted.workingDirectory, repo.path, 'it works in the first folder it may write');
    assert.deepStrictEqual(granted.additionalDirectories, [site.path, temp], 'the other writable ones are added, and temp stays');
    assert.ok(![granted.workingDirectory, ...granted.additionalDirectories].includes(docs.path),
        'a read-only grant is never made writable');

    const readOnlyGrant = provider.threadOptions({ allowLocalTools: true, sandbox: { folders: [docs] } });
    assert.strictEqual(readOnlyGrant.workingDirectory, temp, 'with nothing to write it works in temp, as before');
    assert.strictEqual(readOnlyGrant.additionalDirectories, undefined);

    const none = provider.threadOptions({ allowLocalTools: true });
    assert.strictEqual(none.workingDirectory, temp);

    const off = provider.threadOptions({ allowLocalTools: false, sandbox: { folders: [repo, site] } });
    assert.strictEqual(off.sandboxMode, 'read-only');
    assert.strictEqual(off.workingDirectory, temp, 'local tools off writes nowhere, whatever was granted');
    assert.strictEqual(off.additionalDirectories, undefined);
    assert.strictEqual(off.networkAccessEnabled, false);

    // Codex's error item is a warning, and the answer follows it. As an error
    // it ended the turn and stood where the answer should have been.
    const said = [];
    provider.translate({
        type: 'item.completed',
        item: { id: 'item_0', type: 'error', message: 'clamping SessionEnd hook timeout to 3s in hooks.json' },
    }, event => said.push(event));
    assert.deepStrictEqual(said, [{ type: 'warning', message: 'clamping SessionEnd hook timeout to 3s in hooks.json' }]);

    const failedTurn = [];
    provider.translate({ type: 'turn.failed', error: { message: 'boom' } }, event => failedTurn.push(event));
    assert.deepStrictEqual(failedTurn, [{ type: 'error', message: 'boom' }], 'a failed turn is still an error');

    console.log('codex-provider tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
