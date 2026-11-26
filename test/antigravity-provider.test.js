/**
 * The Antigravity provider against a scripted `agy`.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-agy-'));
const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: async () => {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const agy = require('../src/main/ai/providers/antigravity');
agy._test.useCommand({ command: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-agy.js')] });

const until = async (check, what, timeout = 8000) => {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
};

let passed = 0;
async function test(name, fn) {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
}

(async () => {
    await test('skipped actions are said in one sentence', () => {
        assert.match(agy._test.deniedNotice([{ tool: 'write_file', target: 'a.txt' }, 'run_command']), /skipped 2 actions.*write_file \(a\.txt\), run_command/);
        assert.strictEqual(agy._test.deniedNotice([]), '');
    });

    await test('the model list groups each tier into its base model', async () => {
        const rows = await agy.listModels();
        assert.deepStrictEqual(rows.map(row => row.value), ['gemini-3.8-flash', 'claude-opus-4.6']);
        assert.strictEqual(rows[0].label, 'Gemini 3.8 Flash');
        assert.strictEqual(rows[1].short, 'Claude Opus 4.6');
        assert.deepStrictEqual(rows[0].effort, ['low', 'medium', 'high']);
        // A base seen with no tier carries none, and runs with its default.
        assert.deepStrictEqual(rows[1].effort, []);
        // The real TSV shape parses too, including a Fetching line on stderr.
        const tsv = agy._test.describeModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n');
        assert.strictEqual(tsv[0].value, 'gemini-3.8-flash');
        assert.deepStrictEqual(tsv[0].effort, ['high']);
    });

    await test('the tier rides as --effort on the base model, never as a suffixed slug', () => {
        // The reported failure: a medium slug with --effort high conflicted.
        const args = agy._test.runArguments({ model: 'claude-opus-5-5-medium', effort: 'high' });
        assert.ok(!args.some(arg => String(arg).includes('claude-opus-5-5-medium')), 'no suffixed slug');
        assert.strictEqual(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
        assert.strictEqual(args[args.indexOf('--effort') + 1], 'high');
        // Higher stored stops ride as the lineup's top instead of erroring.
        const capped = agy._test.runArguments({ model: 'gemini-3.8-flash', effort: 'xhigh' });
        assert.strictEqual(capped[capped.indexOf('--effort') + 1], 'high');
        // No effort stored: the base runs with its default.
        assert.ok(!agy._test.runArguments({ model: 'gemini-3.8-flash' }).includes('--effort'));
    });

    await test('/usage becomes a five-hour and a weekly window, without a turn', async () => {
        const answer = await agy.readLimits();
        assert.strictEqual(answer.identity.email, 'me@example.com');
        assert.strictEqual(answer.identity.plan, 'pro');
        const byId = Object.fromEntries(answer.windows.map(window => [window.id, window.used]));
        assert.deepStrictEqual(byId, { five_hour: 25, seven_day: 60 });
    });

    const events = [];
    let current = { approval: 'writes', allowLocalTools: true, mcpServers: [], model: 'gemini-3.8-flash', effort: 'high' };
    const session = await agy.start({
        settings: current,
        getSettings: () => current,
        systemPrompt: 'SYSTEM',
        toolContext: () => ({ settings: current }),
        requestApproval: async () => ({ approved: true }),
        onEvent: event => events.push(event),
    });

    await test('a turn runs one process with the workspace MCP config, and streams text and our tools', async () => {
        session.send('hello');
        await until(() => events.some(event => event.type === 'result'), 'the first result');
        const texts = events.filter(event => event.type === 'assistant-text').map(event => event.text);
        assert.strictEqual(texts[0], 'Looking. ');
        assert.ok(texts[1].includes('servers=remote'), texts[1]);
        assert.ok(texts[1].includes('model=gemini-3.8-flash'), 'the base model passes to the CLI');
        assert.ok(texts[1].includes('effort=high'), 'the tier passes as --effort');
        assert.ok(texts[1].includes('prompt=with-system'));
        assert.ok(texts[1].includes('skip=false'));
        const call = events.find(event => event.type === 'tool-call');
        assert.strictEqual(call.name, 'list_hosts');
        assert.strictEqual(call.local, false);
        assert.ok(events.some(event => event.type === 'session' && event.sessionId === 'conv-1'));
        assert.deepStrictEqual(events.find(event => event.type === 'result').usage, { input_tokens: 500, output_tokens: 75, cache_read_input_tokens: 100 });
        assert.ok(!events.some(event => event.type === 'notice'), 'no warning when the tools loaded');
    });

    await test('the next turn continues the conversation and says what was skipped', async () => {
        events.length = 0;
        session.send('please write notes');
        await until(() => events.some(event => event.type === 'result'), 'the second result');
        const reply = events.filter(event => event.type === 'assistant-text').pop().text;
        assert.ok(reply.includes('conversation=conv-1'), reply);
        assert.ok(reply.includes('prompt=plain'), 'the system prompt goes once');
        assert.match(events.find(event => event.type === 'notice').text, /skipped 1 action/);
    });

    await test('"Never ask" runs with permissions skipped', async () => {
        events.length = 0;
        current = { ...current, approval: 'never' };
        session.send('hello');
        await until(() => events.some(event => event.type === 'result'), 'the third result');
        assert.ok(events.filter(event => event.type === 'assistant-text').pop().text.includes('skip=true'));
    });

    await test('a write grant is --add-dir, and the process stays in the app workspace', async () => {
        events.length = 0;
        const grant = path.join(os.tmpdir(), 'agy-grant');
        const extra = path.join(os.tmpdir(), 'agy-grant-2');
        const readOnly = path.join(os.tmpdir(), 'agy-ro');
        current = {
            ...current,
            approval: 'writes',
            allowLocalTools: true,
            sandbox: { folders: [
                { path: grant, mode: 'write' },
                { path: extra, mode: 'write' },
                { path: readOnly, mode: 'read' },
            ] },
        };
        session.send('hello');
        await until(() => events.some(event => event.type === 'result'), 'the granted result');
        const reply = events.filter(event => event.type === 'assistant-text').pop().text;
        const workspace = path.join(userData, 'agent-workspaces', 'antigravity');
        assert.ok(reply.includes(`cwd=${fs.realpathSync(workspace)}`), reply);
        assert.ok(reply.includes(`dirs=${grant}|${extra}`), reply);
        assert.ok(!reply.includes(readOnly), 'a read-only grant is not added');
        assert.ok(fs.existsSync(path.join(workspace, '.agents', 'mcp_config.json')));
        assert.ok(!fs.existsSync(path.join(grant, '.agents', 'mcp_config.json')));
        assert.ok(!events.some(event => event.type === 'error'));
    });

    await test('local tools off adds no project directory', () => {
        const grant = path.join(os.tmpdir(), 'agy-grant');
        const settings = { allowLocalTools: false, sandbox: { folders: [{ path: grant, mode: 'write' }] } };
        assert.deepStrictEqual(agy._test.addedDirectories(settings), []);
        assert.ok(!agy._test.runArguments({ directories: agy._test.addedDirectories(settings) }).includes('--add-dir'));
    });

    await test('a failed run is an error with its reason', async () => {
        events.length = 0;
        session.send('this will fail');
        await until(() => events.some(event => event.type === 'result'), 'the failed result');
        assert.strictEqual(events.find(event => event.type === 'result').isError, true);
        assert.match(events.find(event => event.type === 'error').message, /model unavailable/);
    });

    await session.close();
    agy._test.useCommand(null);

    await test('desktopCandidates lists the standard Windows, macOS and Linux Antigravity desktop paths', () => {
        const win = agy.desktopCandidates({
            platform: 'win32',
            home: 'C:\\Users\\Brad',
            env: { LOCALAPPDATA: 'C:\\Users\\Brad\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
        });
        assert.ok(win.some(entry => entry.exe === 'C:\\Users\\Brad\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe'
            && entry.asar === 'C:\\Users\\Brad\\AppData\\Local\\Programs\\antigravity\\resources\\app.asar'));
        assert.ok(win.some(entry => entry.exe === 'C:\\Program Files\\Antigravity\\Antigravity.exe'));

        const mac = agy.desktopCandidates({ platform: 'darwin', home: '/Users/brad', env: {} });
        assert.ok(mac.some(entry => entry.exe === '/Applications/Antigravity.app/Contents/MacOS/Antigravity'
            && entry.asar === '/Applications/Antigravity.app/Contents/Resources/app.asar'));
        assert.ok(mac.some(entry => entry.exe === '/Users/brad/Applications/Antigravity.app/Contents/MacOS/Antigravity'));

        const linux = agy.desktopCandidates({ platform: 'linux', home: '/home/brad', env: {} });
        assert.ok(linux.some(entry => entry.exe === '/opt/Antigravity/Antigravity'));
        assert.ok(linux.some(entry => entry.exe === '/usr/bin/antigravity'));
    });

    await test('findAntigravityDesktop detects standard installs and custom shim installs, ignoring stale shims', () => {
        const winExe = 'C:\\Users\\Brad\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe';
        const direct = agy.findAntigravityDesktop({
            platform: 'win32',
            home: 'C:\\Users\\Brad',
            env: { LOCALAPPDATA: 'C:\\Users\\Brad\\AppData\\Local' },
            accessSync(target) {
                if (target !== winExe) throw new Error('missing');
            },
            readFileSync() { throw new Error('missing'); },
        });
        assert.ok(direct);
        assert.strictEqual(direct.exe, winExe);

        // Custom install folder recorded in agy-node.cmd / agentapi.bat.
        const customExe = 'D:\\Apps\\Antigravity\\Antigravity.exe';
        const shim = 'C:\\Users\\Brad\\AppData\\Roaming\\Antigravity\\bin\\agy-node.cmd';
        const viaShim = agy.findAntigravityDesktop({
            platform: 'win32',
            home: 'C:\\Users\\Brad',
            env: { APPDATA: 'C:\\Users\\Brad\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Brad\\AppData\\Local' },
            readFileSync(target) {
                if (target === shim) return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${customExe}" %*\r\n`;
                throw new Error('missing');
            },
            accessSync(target) {
                if (target !== customExe) throw new Error('missing');
            },
        });
        assert.ok(viaShim);
        assert.strictEqual(viaShim.exe, customExe);
        assert.strictEqual(viaShim.asar, 'D:\\Apps\\Antigravity\\resources\\app.asar');

        // Stale shim pointing to a deleted executable is ignored.
        const stale = agy.findAntigravityDesktop({
            platform: 'win32',
            home: 'C:\\Users\\Brad',
            env: { APPDATA: 'C:\\Users\\Brad\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Brad\\AppData\\Local' },
            readFileSync(target) {
                if (target === shim) return `@echo off\r\n"${customExe}" %*\r\n`;
                throw new Error('missing');
            },
            accessSync() { throw new Error('missing'); },
        });
        assert.strictEqual(stale, null);
    });

    await test('platformSlug maps every supported desktop platform and rejects unknown ones', () => {
        assert.strictEqual(agy._test.platformSlug({ platform: 'win32', arch: 'x64' }), 'windows_amd64');
        assert.strictEqual(agy._test.platformSlug({ platform: 'win32', arch: 'arm64' }), 'windows_arm64');
        assert.strictEqual(agy._test.platformSlug({ platform: 'darwin', arch: 'arm64' }), 'darwin_arm64');
        assert.strictEqual(agy._test.platformSlug({ platform: 'darwin', arch: 'x64' }), 'darwin_amd64');
        assert.strictEqual(agy._test.platformSlug({ platform: 'linux', arch: 'x64', isMusl: false }), 'linux_amd64');
        assert.strictEqual(agy._test.platformSlug({ platform: 'linux', arch: 'arm64', isMusl: true }), 'linux_arm64_musl');
        assert.strictEqual(agy._test.platformSlug({ platform: 'win32', arch: 'ia32' }), '');
    });

    await test('installAgy verifies SHA-512 and installs the companion CLI into the user bin directory', async () => {
        const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-agy-home-'));
        const fakeLocal = path.join(fakeHome, 'AppData', 'Local');
        const payload = Buffer.from('fake-agy-binary-bytes');
        const sha512 = crypto.createHash('sha512').update(payload).digest('hex');
        const isWin = process.platform === 'win32';
        const downloadUrl = isWin
            ? 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.17/windows-x64/cli_windows_x64.exe'
            : 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.17/linux-x64/cli_linux_x64.tar.gz';
        const expectedDest = isWin
            ? path.join(fakeLocal, 'agy', 'bin', 'agy.exe')
            : path.join(fakeHome, '.local', 'bin', 'agy');
        const mockFetch = async (url) => {
            if (url.endsWith('.json')) {
                return { ok: true, status: 200, json: async () => ({ version: '1.5.17', url: downloadUrl, sha512 }) };
            }
            if (url === downloadUrl) {
                return {
                    ok: true,
                    status: 200,
                    body: (async function* () { yield payload.subarray(0, 8); yield payload.subarray(8); })(),
                };
            }
            return { ok: false, status: 404 };
        };
        try {
            const installed = await agy._test.installAgy({
                platform: process.platform,
                arch: 'x64',
                home: fakeHome,
                env: isWin ? { LOCALAPPDATA: fakeLocal } : {},
                userData,
                fetchFn: mockFetch,
                extractTarFn: async (_archive, dir) => {
                    const out = path.join(dir, 'antigravity');
                    fs.writeFileSync(out, payload);
                    return out;
                },
            });
            assert.strictEqual(installed, expectedDest);
            assert.deepStrictEqual(fs.readFileSync(installed), payload);

            // Checksum mismatch is refused and leaves no broken binary behind.
            const badHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-agy-bad-'));
            try {
                await assert.rejects(() => agy._test.installAgy({
                    platform: process.platform,
                    arch: 'x64',
                    home: badHome,
                    env: isWin ? { LOCALAPPDATA: path.join(badHome, 'Local') } : {},
                    userData: path.join(badHome, 'ud'),
                    fetchFn: async (url) => (url.endsWith('.json')
                        ? { ok: true, status: 200, json: async () => ({ version: '1.5.17', url: downloadUrl, sha512: '0'.repeat(128) }) }
                        : { ok: true, status: 200, arrayBuffer: async () => payload }),
                }), /checksum/i);
                assert.ok(!fs.existsSync(isWin
                    ? path.join(badHome, 'Local', 'agy', 'bin', 'agy.exe')
                    : path.join(badHome, '.local', 'bin', 'agy')));
            } finally {
                fs.rmSync(badHome, { recursive: true, force: true });
            }
        } finally {
            fs.rmSync(fakeHome, { recursive: true, force: true });
        }
    });

    await test('detect returns notFound without CLI or desktop app, and auto-provisions when the desktop app is installed', async () => {
        const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-agy-detect-'));
        const isWin = process.platform === 'win32';
        const fakeLocal = path.join(fakeHome, 'AppData', 'Local');
        const desktopExe = isWin
            ? path.join(fakeLocal, 'Programs', 'antigravity', 'Antigravity.exe')
            : process.platform === 'darwin'
                ? path.join(fakeHome, 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Antigravity')
                : path.join(fakeHome, '.local', 'share', 'antigravity', 'Antigravity');
        const cliDest = isWin
            ? path.join(fakeLocal, 'agy', 'bin', 'agy.exe')
            : path.join(fakeHome, '.local', 'bin', 'agy');
        const baseOpts = {
            platform: process.platform,
            home: fakeHome,
            env: isWin ? { LOCALAPPDATA: fakeLocal, APPDATA: path.join(fakeHome, 'AppData', 'Roaming'), ProgramFiles: path.join(fakeHome, 'PF') } : {},
            userData: path.join(fakeHome, 'ud'),
        };
        try {
            // Neither CLI nor desktop app: notFound without touching the network.
            let fetched = 0;
            const none = agy.detect({
                ...baseOpts,
                accessSync() { throw new Error('missing'); },
                fetchFn: async () => { fetched += 1; throw new Error('should not fetch'); },
            });
            assert.deepStrictEqual(none, { ok: false, reason: 'notFound' });
            assert.strictEqual(fetched, 0);

            // Create an installed desktop app executable with no `agy` CLI yet.
            fs.mkdirSync(path.dirname(desktopExe), { recursive: true });
            fs.writeFileSync(desktopExe, 'desktop-app');

            // Sync probe (install: false) recognises the desktop app without downloading.
            assert.deepStrictEqual(agy.detect({
                ...baseOpts,
                install: false,
            }), { ok: true, reason: '' });

            // Interactive detect provisions the companion CLI and succeeds.
            let provisioned = 0;
            const ok = await agy.detect({
                ...baseOpts,
                installFn: async () => {
                    provisioned += 1;
                    fs.mkdirSync(path.dirname(cliDest), { recursive: true });
                    fs.writeFileSync(cliDest, 'agy');
                    return cliDest;
                },
            });
            assert.deepStrictEqual(ok, { ok: true, reason: '' });
            assert.strictEqual(provisioned, 1);

            // Subsequent detect finds the installed CLI immediately without reinstalling.
            const again = agy.detect({
                ...baseOpts,
                installFn: async () => { provisioned += 1; return ''; },
            });
            assert.deepStrictEqual(again, { ok: true, reason: '' });
            assert.strictEqual(provisioned, 1);

            // Offline failure when only the desktop app is present reports an error rather than notFound.
            fs.rmSync(path.dirname(cliDest), { recursive: true, force: true });
            const offline = await agy.detect({
                ...baseOpts,
                installFn: async () => { throw new Error('offline'); },
            });
            assert.deepStrictEqual(offline, { ok: false, reason: 'error' });
        } finally {
            fs.rmSync(fakeHome, { recursive: true, force: true });
        }
    });

    console.log(`${passed} passed, 0 failed`);
    fs.rmSync(userData, { recursive: true, force: true });
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 3000).unref();
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
