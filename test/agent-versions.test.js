/**
 * The agent update check: the installed CLI's `--version` against the newest
 * release, read from npm, PyPI or the CLI's own check. Every CLI and registry
 * is stubbed, so this runs offline under plain node.
 */
const assert = require('assert');
const path = require('path');

const {
    SOURCES,
    parseVersion,
    compareVersions,
    createVersionChecker,
} = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'agent-versions'));

let failures = 0;
async function test(name, body) {
    try {
        await body();
        console.log(`  ok  ${name}`);
    } catch (error) {
        failures += 1;
        console.error(`  FAIL ${name}\n${error.stack}`);
    }
}

(async () => {
    console.log('agent-versions');

    await test('reads the version out of what each CLI prints', () => {
        assert.strictEqual(parseVersion('2.1.287 (Claude Code)'), '2.1.287');
        assert.strictEqual(parseVersion('grok 1.0.13 (5e9a58528b76) [stable]'), '1.0.13');
        assert.strictEqual(parseVersion('codex-cli 0.161.0'), '0.161.0');
        assert.strictEqual(parseVersion('0.1.151-alpha.2'), '0.1.151-alpha.2');
        assert.strictEqual(parseVersion('no version here'), '');
        assert.strictEqual(parseVersion(undefined), '');
    });

    await test('compares segment by segment, pre-releases below their release', () => {
        assert.ok(compareVersions('2.1.293', '2.1.99') > 0);
        assert.ok(compareVersions('2.1.287', '2.1.293') < 0);
        assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
        assert.ok(compareVersions('1.2.0-alpha.1', '1.2.0') < 0);
        assert.ok(compareVersions('1.2.0', '1.2.0-alpha.1') > 0);
        assert.ok(compareVersions('1.2.1-alpha.1', '1.2.0') > 0);
    });

    await test('every agent with a CLI has a source', () => {
        for (const provider of ['claude-code', 'codex', 'cursor', 'antigravity', 'muse', 'opencode', 'grok', 'kimi', 'qwen', 'vibe', 'pi']) {
            assert.ok(SOURCES[provider], `no source for ${provider}`);
        }
    });

    const runs = [];
    const fetched = [];
    const checker = createVersionChecker({
        locate: provider => ({
            'claude-code': { command: '/bin/claude' },
            codex: { command: '/bin/codex' },
            vibe: { command: '/bin/vibe' },
            grok: { command: '/bin/grok' },
            cursor: { command: '/cursor/node.exe', prefix: ['/cursor/index.js'] },
            pi: { command: '/bin/pi' },
        }[provider] || null),
        run: async ({ command, args }) => {
            runs.push([command, ...args]);
            if (command === '/bin/claude') return '2.1.287 (Claude Code)\n';
            if (command === '/bin/codex') return 'codex-cli 0.161.0\n';
            if (command === '/bin/vibe') return 'vibe 2.20.1\n';
            if (command === '/bin/grok' && args[0] === '--version') return 'grok 1.0.13 (5e9a585) [stable]\n';
            if (command === '/bin/grok') return 'checking...\n{"currentVersion":"1.0.13","latestVersion":"1.0.46","updateAvailable":true}\n';
            if (command === '/cursor/node.exe') return '2026.09.30-0a1b2c3\n';
            if (command === '/bin/pi') return '1.1.0\n';
            return '';
        },
        fetchJson: async (url) => {
            fetched.push(url);
            if (url.includes('@anthropic-ai/claude-code')) return { version: '2.1.293' };
            if (url.includes('@openai/codex')) return { version: '0.161.0' };
            if (url.includes('pypi.org/pypi/mistral-vibe')) return { info: { version: '2.26.0' } };
            throw new Error('offline');
        },
    });

    const results = Object.fromEntries((await checker.check(
        ['claude-code', 'codex', 'vibe', 'grok', 'cursor', 'pi', 'qwen', 'local']
    )).map(result => [result.provider, result]));

    await test('a newer npm release is an update, with the command that installs it', () => {
        assert.strictEqual(results['claude-code'].status, 'available');
        assert.strictEqual(results['claude-code'].installed, '2.1.287');
        assert.strictEqual(results['claude-code'].latest, '2.1.293');
        assert.strictEqual(results['claude-code'].update, 'claude update');
        assert.ok(fetched.includes('https://registry.npmjs.org/@anthropic-ai/claude-code/latest'));
    });

    await test('the same version is up to date', () => {
        assert.strictEqual(results.codex.status, 'current');
    });

    await test('PyPI answers for the agents published there', () => {
        assert.strictEqual(results.vibe.status, 'available');
        assert.strictEqual(results.vibe.latest, '2.26.0');
    });

    await test("Grok's own check, past any line that is not JSON", () => {
        assert.strictEqual(results.grok.status, 'available');
        assert.strictEqual(results.grok.latest, '1.0.46');
        assert.ok(runs.some(run => run.join(' ') === '/bin/grok update --check --json'));
    });

    await test('a launcher prefix comes before --version', () => {
        assert.ok(runs.some(run => run.join(' ') === '/cursor/node.exe /cursor/index.js --version'));
        assert.strictEqual(results.cursor.status, 'unknown');
        assert.strictEqual(results.cursor.installed, '2026.09.30-0a1b2c3');
    });

    await test('a registry that cannot be reached is an error, not "up to date"', () => {
        assert.strictEqual(results.pi.status, 'error');
        assert.strictEqual(results.pi.installed, '1.1.0');
    });

    await test("an editor extension's copy says to update the extension, not the CLI", async () => {
        const [result] = await createVersionChecker({
            locate: () => ({ command: 'C:\\Users\\me\\.vscode\\extensions\\anthropic.claude-code-2.1.280-win32-x64\\resources\\native-binary\\claude.exe' }),
            run: async () => '2.1.280 (Claude Code)',
            fetchJson: async () => ({ version: '2.1.293' }),
        }).check(['claude-code']);
        assert.strictEqual(result.status, 'available');
        assert.strictEqual(result.managedBy, 'editor');
        assert.strictEqual(result.update, '');
    });

    await test("a desktop app's copy is read off disk and never started", async () => {
        const started = [];
        const check = (version) => createVersionChecker({
            locate: () => ({ command: 'C:\\Apps\\OpenCode\\OpenCode.exe', version, managedBy: 'app' }),
            run: async ({ command }) => { started.push(command); return ''; },
            fetchJson: async () => ({ version: '1.18.35' }),
        }).check(['opencode']).then(([result]) => result);

        const read = await check('1.18.27');
        assert.strictEqual(read.status, 'available');
        assert.strictEqual(read.installed, '1.18.27');
        assert.strictEqual(read.managedBy, 'app');
        assert.strictEqual(read.update, '');

        const unread = await check('');
        assert.strictEqual(unread.status, 'unknown');
        assert.deepStrictEqual(started, []);
    });

    await test('an agent not on the machine is missing, and one with no CLI unsupported', () => {
        assert.strictEqual(results.qwen.status, 'missing');
        assert.strictEqual(results.local.status, 'unsupported');
    });

    if (failures > 0) {
        console.error(`${failures} failed`);
        process.exit(1);
    }
})();
