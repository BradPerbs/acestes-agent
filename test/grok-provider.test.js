const Module = require('module');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-grok-'));
const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

const provider = require('../src/main/ai/providers/grok');
const mcpHost = require('../src/main/ai/mcp-host');

/**
 * The Grok Build provider: where its CLI is found, how one headless run is
 * described, and what its stream turns into.
 *
 * The stream is the part worth testing hardest. Everything the panel draws for
 * this agent comes out of `createTranslator`, and it is reading a format that
 * is not this app's to define, so the cases below are the shapes it has to
 * survive rather than one blessed spelling.
 */

/** A filesystem made of nothing but the paths given. */
function fakeAccess(files) {
    const known = new Set(files);
    return {
        accessSync(file) {
            if (!known.has(file)) throw new Error(`ENOENT: ${file}`);
        },
    };
}

const WINDOWS_HOME = 'C:\\Users\\Mario';
const UNIX_HOME = '/Users/mario';

function collect() {
    const events = [];
    return { events, onEvent: event => events.push(event) };
}

async function run() {
    /* ---------------- Finding the CLI ---------------- */

    const windowsRoots = provider.grokRoots({
        platform: 'win32',
        home: WINDOWS_HOME,
        env: { PATH: 'C:\\tools;C:\\other', LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local' },
    });
    assert.strictEqual(windowsRoots[0], 'C:\\tools', 'a PATH the user arranged comes first');
    assert.ok(
        windowsRoots.includes('C:\\Users\\Mario\\.grok\\bin'),
        'the install script\'s own folder is looked in, since a packaged app has a short PATH'
    );
    assert.ok(windowsRoots.includes('C:\\Users\\Mario\\AppData\\Local\\Programs\\grok'));

    const unixRoots = provider.grokRoots({
        platform: 'darwin',
        home: UNIX_HOME,
        env: { PATH: '/usr/local/bin' },
    });
    assert.ok(unixRoots.includes('/Users/mario/.grok/bin'));
    assert.ok(unixRoots.includes('/opt/homebrew/bin'));

    assert.strictEqual(
        provider.findGrok({
            platform: 'darwin',
            home: UNIX_HOME,
            env: { PATH: '/usr/local/bin' },
            ...fakeAccess(['/Users/mario/.grok/bin/grok']),
        }),
        '/Users/mario/.grok/bin/grok'
    );

    assert.strictEqual(
        provider.findGrok({
            platform: 'win32',
            home: WINDOWS_HOME,
            env: { PATH: 'C:\\tools', APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming' },
            ...fakeAccess(['C:\\Users\\Mario\\AppData\\Roaming\\npm\\grok.cmd']),
        }),
        'C:\\Users\\Mario\\AppData\\Roaming\\npm\\grok.cmd',
        'an npm shim counts, because this provider spawns through cross-spawn'
    );

    assert.strictEqual(
        provider.findGrok({
            platform: 'darwin',
            home: UNIX_HOME,
            env: { PATH: '/usr/local/bin' },
            ...fakeAccess(['/usr/local/bin/codex']),
        }),
        '',
        'a machine without it says so rather than guessing at a path'
    );

    /* ---------------- One headless run ---------------- */

    const base = {
        maxTurns: 25,
        model: 'grok-build-0.1',
        effort: 'high',
        allowLocalTools: false,
    };

    const first = provider.runArguments({
        current: base,
        sessionId: 'abc-123',
        resume: false,
        directory: '/tmp/work',
        prompt: 'do the thing',
    });

    assert.deepStrictEqual(first.slice(0, 2), ['-p', 'do the thing']);
    assert.ok(first.includes('--output-format') && first.includes('streaming-json'));
    assert.strictEqual(first[first.indexOf('--session-id') + 1], 'abc-123', 'a new session gets our id');
    assert.ok(!first.includes('--resume'));
    assert.strictEqual(first[first.indexOf('--max-turns') + 1], '25');
    assert.strictEqual(first[first.indexOf('--model') + 1], 'grok-build-0.1');
    assert.strictEqual(first[first.indexOf('--effort') + 1], 'high');
    assert.ok(first.includes('--always-approve'), 'our own gate is the one that asks');
    assert.ok(first.includes('--no-auto-update'), 'no downloads in the middle of a turn');
    assert.strictEqual(
        first[first.indexOf('--disallowed-tools') + 1],
        provider.LOCAL_TOOLS.join(','),
        'the agent\'s own tools on this machine are denied while the switch is off'
    );

    const later = provider.runArguments({
        current: { ...base, allowLocalTools: true, model: '', effort: 'ultra' },
        sessionId: 'abc-123',
        resume: true,
        directory: '/tmp/work',
        prompt: 'and again',
    });
    assert.strictEqual(later[later.indexOf('--resume') + 1], 'abc-123', 'the second turn resumes');
    assert.ok(!later.includes('--session-id'));
    assert.ok(!later.includes('--model'), 'nothing pinned means whatever the agent is set to');
    assert.ok(!later.includes('--disallowed-tools'), 'the switch being on lets its own tools through');
    assert.strictEqual(later[later.indexOf('--effort') + 1], 'max', 'a level above this scale rounds down');

    assert.strictEqual(provider.effortFor({ effort: 'medium' }), 'medium');
    assert.strictEqual(provider.effortFor({ effort: 'ultra' }), 'max');
    assert.strictEqual(provider.effortFor({ effort: '' }), '', 'no setting means no flag');

    /* ---------------- The working directory ---------------- */

    // A writable grant is where the run works; `--cwd` and the spawn carry
    // the same folder, so proving the one proves the other.
    const grant = path.join(os.tmpdir(), 'grok-grant-site');
    const readOnly = path.join(os.tmpdir(), 'grok-grant-docs');
    const fallback = provider._test.workspace();
    const grantedSettings = {
        allowLocalTools: true,
        sandbox: { folders: [{ path: readOnly, mode: 'read' }, { path: grant, mode: 'write' }] },
    };
    assert.strictEqual(provider._test.directoryFor(grantedSettings), grant, 'the first writable grant');
    assert.strictEqual(
        provider._test.directoryFor({ allowLocalTools: true, sandbox: { folders: [{ path: readOnly, mode: 'read' }] } }),
        fallback,
        'a read-only grant is never the working directory'
    );
    assert.strictEqual(provider._test.directoryFor({ allowLocalTools: true }), fallback, 'no grant keeps the old fallback');
    assert.strictEqual(
        provider._test.directoryFor({ allowLocalTools: false, sandbox: { folders: [{ path: grant, mode: 'write' }] } }),
        fallback,
        'local tools off keeps the old fallback'
    );

    const grantedArgs = provider.runArguments({
        current: { ...base, allowLocalTools: true },
        sessionId: 'abc-123',
        resume: false,
        directory: provider._test.directoryFor(grantedSettings),
        prompt: 'do the thing',
    });
    assert.strictEqual(grantedArgs[grantedArgs.indexOf('--cwd') + 1], grant, 'a writable grant becomes --cwd');

    // No servers to publish: a bare run writes nothing into the user config.
    assert.strictEqual(provider._test.mcpFragment(null), '');
    assert.strictEqual(provider._test.mcpFragment(''), '');

    /* ---------------- Naming our tools apart from its own ---------------- */

    assert.strictEqual(provider.stripServer('remote__run_command'), 'run_command');
    assert.strictEqual(provider.stripServer('mcp__remote__read_file'), 'read_file');
    assert.strictEqual(provider.stripServer('remote.list_hosts'), 'list_hosts');
    assert.strictEqual(provider.stripServer('Bash'), 'Bash', 'its own tools keep their names');

    /* ---------------- The stream, as a transcript ---------------- */

    const { events, onEvent } = collect();
    const translator = provider.createTranslator(onEvent);

    translator.event({ type: 'text', text: 'Looking' });
    translator.event({ type: 'thought', content: 'which host' });
    translator.event({ type: 'text', text: ' at it.' });
    translator.event({
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'remote__run_command',
        status: 'in_progress',
        rawInput: { command: 'uptime' },
    });
    translator.event({
        type: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'up 3 days' } }],
    });
    translator.event({ type: 'usage', costUsd: 0.02 });
    translator.event({ type: 'plan', entries: [] });
    translator.event({ type: 'text', text: 'It is fine.' });
    translator.finish();

    assert.deepStrictEqual(
        events.map(event => event.type),
        [
            'text-delta', 'thinking-delta', 'text-delta',
            'assistant-text', 'tool-call', 'tool-result',
            'text-delta', 'assistant-text', 'result',
        ],
        'text is flushed as a block before the call it precedes, and again at the end'
    );

    assert.strictEqual(events[3].text, 'Looking at it.', 'the deltas make one block');
    assert.strictEqual(events[4].name, 'run_command', 'the server prefix is taken off');
    assert.strictEqual(events[4].local, false, 'a prefixed call is one of ours');
    assert.deepStrictEqual(events[4].input, { command: 'uptime' });
    assert.strictEqual(events[5].text, 'up 3 days', 'the result is read out of the content blocks');
    assert.strictEqual(events[5].isError, false);
    assert.strictEqual(events.at(-1).costUsd, 0.02, 'what the run cost is carried through');
    assert.strictEqual(events.at(-1).isError, false);

    /* ---------------- The spelling the CLI actually uses ---------------- */

    // Replayed verbatim from `grok -p ... --output-format streaming-json` on
    // 1.0.4. Every line here was captured off the wire rather than written from
    // the shape this file expected, which is how the two came to disagree: the
    // words arrive under `data`, and while nothing read that key a turn ran to
    // a clean exit and put nothing on the screen at all.
    const wire = collect();
    const real = provider.createTranslator(wire.onEvent);

    real.event({ type: 'available_commands', tools: ['read_file'], commands: ['compact'] });
    real.event({ type: 'thought', data: 'The user wants me to say ok.' });
    real.event({ type: 'text', data: 'ok' });
    real.event({
        type: 'tool_call',
        toolCallId: 'call-1',
        title: 'list_dir',
        kind: 'list',
        status: 'pending',
        toolName: 'list_dir',
        rawInput: { target_directory: '.' },
        content: [],
        locations: [],
    });
    // The CLI sends one of these with no status at all before the real one.
    real.event({ type: 'tool_call_update', toolCallId: 'call-1', status: null, content: [], rawOutput: null });
    real.event({
        type: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [],
        rawOutput: { type: 'ListDir', Content: { content: '- note.txt', absolute_root_path: 'C:\\tmp' } },
    });
    real.event({ type: 'usage', usage: { input_tokens: 8455, output_tokens: 67 } });
    real.event({
        type: 'end',
        stopReason: 'end_turn',
        sessionId: '01a0',
        usage: { input_tokens: 11256, output_tokens: 111, total_tokens: 28647 },
        num_turns: 2,
        total_cost_usd: 0.00540906,
    });
    real.finish();

    assert.deepStrictEqual(
        wire.events.map(event => event.type),
        ['thinking-delta', 'text-delta', 'assistant-text', 'tool-call', 'tool-result', 'result'],
        'the answer reaches the panel, which is what a turn is for'
    );
    assert.strictEqual(wire.events[1].text, 'ok', 'the words are under `data` on this CLI');
    assert.strictEqual(
        wire.events.find(event => event.type === 'tool-result').text,
        '- note.txt',
        'a result is unwrapped out of the struct the tool names it with'
    );
    assert.strictEqual(
        wire.events.at(-1).costUsd,
        0.00540906,
        'the cost is stated once, on the last line, and nowhere else'
    );
    assert.strictEqual(
        wire.events.at(-1).usage.total_tokens,
        28647,
        'and so is the total for the turn, rather than the last call of several'
    );

    /* ---------------- The same events, spelled differently ---------------- */

    const other = collect();
    const lenient = provider.createTranslator(other.onEvent);
    lenient.event({ type: 'text', content: 'Hello.' });
    lenient.event({
        type: 'tool_call',
        id: 'x1',
        tool: 'Bash',
        status: 'running',
        input: { command: 'ls' },
    });
    lenient.event({ type: 'tool_call_update', id: 'x1', status: 'failed', output: 'permission denied' });
    lenient.finish();

    const call = other.events.find(event => event.type === 'tool-call');
    assert.strictEqual(call.name, 'Bash');
    assert.strictEqual(call.local, true, 'an unprefixed call acts on this machine, and the panel says so');
    assert.strictEqual(call.id, 'x1', 'the id is read from whichever key carries it');

    const failure = other.events.find(event => event.type === 'tool-result');
    assert.strictEqual(failure.isError, true);
    assert.strictEqual(failure.text, 'permission denied');

    /* ---------------- A run that reported an error ---------------- */

    const bad = collect();
    const failing = provider.createTranslator(bad.onEvent);
    failing.event({ type: 'text', text: 'Trying.' });
    failing.event({ type: 'error', message: 'not logged in' });
    failing.finish();

    const notice = bad.events.find(event => event.type === 'error');
    assert.match(notice.message, /sign in|signed in/i, 'the fix is in the message, not just the failure');
    assert.strictEqual(bad.events.at(-1).isError, true, 'the turn ends as a failure');

    // A call announced twice is still one row, or the transcript grows a
    // duplicate for every progress update the agent sends.
    const repeated = collect();
    const once = provider.createTranslator(repeated.onEvent);
    once.event({ type: 'tool_call', toolCallId: 'r1', toolName: 'remote__read_file', status: 'pending' });
    once.event({ type: 'tool_call_update', toolCallId: 'r1', status: 'in_progress' });
    once.event({ type: 'tool_call_update', toolCallId: 'r1', status: 'completed', output: 'contents' });
    once.finish();
    assert.strictEqual(
        repeated.events.filter(event => event.type === 'tool-call').length,
        1,
        'progress updates land on the call that is already there'
    );

    /* ---------------- The composer's ring ---------------- */

    // Pi reports a context reading per reply and Grok Build reported none,
    // so the ring beside the model chip stayed empty on this runtime. The
    // window comes from the CLI's own model cache; the tokens from the
    // usage lines the stream already carries.
    const metered = collect();
    const meter = provider.createTranslator(metered.onEvent, {
        model: 'grok-4.6',
        contextLimit: (name) => (name === 'grok-4.6' ? 256000 : 0),
    });
    meter.event({ type: 'usage', usage: { input_tokens: 8455, output_tokens: 67 } });
    meter.event({
        type: 'end',
        usage: { input_tokens: 11256, output_tokens: 111, total_tokens: 28647 },
        total_cost_usd: 0.00540906,
    });
    meter.finish();

    const readings = metered.events.filter(event => event.type === 'context');
    assert.strictEqual(readings.length, 2, 'each step moves the ring, like Pi');
    assert.deepStrictEqual(
        readings.map(reading => reading.used),
        [8522, 28647],
        'per call the fields as stated; at the end the fuller total wins, since the total counts the cached tokens the fields omit'
    );
    assert.strictEqual(readings[0].limit, 256000);
    assert.strictEqual(readings[0].percent, Math.round((8522 / 256000) * 100));
    assert.strictEqual(readings[0].model, 'grok-4.6');

    const sameAgain = collect();
    const steady = provider.createTranslator(sameAgain.onEvent, {
        model: 'grok-4.6',
        contextLimit: () => 256000,
    });
    steady.event({ type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } });
    steady.event({ type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } });
    steady.finish();
    assert.strictEqual(
        sameAgain.events.filter(event => event.type === 'context').length,
        1,
        'an unchanged reading is not said twice'
    );

    const windowless = collect();
    const blind = provider.createTranslator(windowless.onEvent, { model: 'grok-4.6' });
    blind.event({ type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } });
    blind.finish();
    assert.ok(
        !windowless.events.some(event => event.type === 'context'),
        'without a window there is no reading, and the ring stays empty as before'
    );

    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-windows-'));
    try {
        assert.strictEqual(provider.contextWindows({ source: cacheHome }).size, 0, 'no cache is no windows');
        fs.writeFileSync(path.join(cacheHome, 'models_cache.json'), JSON.stringify({
            models: {
                'grok-4.6': { info: { id: 'grok-4.6', model: 'grok-4.6', context_window: 256000 } },
                'odd': { info: { id: 'odd' } },
            },
        }), 'utf8');
        const windows = provider.contextWindows({ source: cacheHome });
        assert.strictEqual(windows.get('grok-4.6'), 256000, 'the window is the cache\'s own');
        assert.ok(!windows.has('odd'), 'a model with no window offers none');
    } finally {
        fs.rmSync(cacheHome, { recursive: true, force: true });
    }

    assert.deepStrictEqual(
        provider.usageTokens({ input_tokens: 100, output_tokens: 10 }),
        { used: 110, cached: 0 },
        'the fields as stated'
    );
    assert.deepStrictEqual(
        provider.usageTokens({ input_tokens: 11256, output_tokens: 111, total_tokens: 28647 }),
        { used: 28647, cached: 0 },
        'the total wins when it counts more'
    );
    assert.deepStrictEqual(
        provider.usageTokens({ type: 'usage', costUsd: 0.02 }),
        { used: 0, cached: 0 },
        'a cost-only line reads as nothing'
    );

    /* ---------------- Pointing it at our tools ---------------- */

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-config-'));
    try {
        const url = 'http://127.0.0.1:51234/mcp/deadbeef';
        provider.writeMcpConfig(directory, url);

        const toml = fs.readFileSync(path.join(directory, '.grok', 'config.toml'), 'utf8');
        assert.match(toml, /\[mcp_servers\.remote\]/);
        assert.doesNotMatch(toml, /type = /, 'the TOML spelling is the address alone');
        assert.ok(toml.includes(url), 'the address carries the token, so no header has to be spelled');

        const json = JSON.parse(fs.readFileSync(path.join(directory, '.mcp.json'), 'utf8'));
        assert.strictEqual(json.mcpServers.remote.url, url);
        assert.strictEqual(json.mcpServers.remote.type, 'http');

        // The agent's own servers go in beside ours; one named like ours does not.
        provider.writeMcpConfig(directory, url, { servers: [
            { name: 'Playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} },
            { name: 'remote', transport: 'http', url: 'https://impostor.example/mcp' },
        ] });
        const withOwn = fs.readFileSync(path.join(directory, '.grok', 'config.toml'), 'utf8');
        assert.ok(withOwn.includes('[mcp_servers.Playwright]'), 'the inventory server is written');
        assert.ok(withOwn.includes('mcp-launch.js'), 'through the launcher');
        assert.strictEqual((withOwn.match(/\[mcp_servers\.remote\]/g) || []).length, 1, 'ours once, the impostor never');
        assert.ok(withOwn.includes(url));
        const ownJson = JSON.parse(fs.readFileSync(path.join(directory, '.mcp.json'), 'utf8'));
        assert.ok(ownJson.mcpServers.Playwright, 'and in the JSON spelling');
        assert.strictEqual(ownJson.mcpServers.remote.url, url);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }

    /* ---------------- Publishing servers into the user config ---------------- */

    // The run starts in the repo, so the servers go in ~/.grok/config.toml,
    // which Grok loads for every directory. Only our tables move.
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-user-'));
    try {
        const file = path.join(userHome, 'config.toml');
        const prior = '[cli]\ninstaller = "internal"\n\n[mcp_servers.runpod]\nurl = "https://mcp.getrunpod.io/"\n\n[mcp_servers.remote]\nurl = "https://old.example/mcp"\n';
        fs.writeFileSync(file, prior, 'utf8');
        const fragment = provider._test.mcpFragment('http://127.0.0.1:9/mcp/token', {
            servers: [{ name: 'Playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {} }],
        });
        const restore = provider.publishUserMcp(fragment, { source: userHome });
        const published = fs.readFileSync(file, 'utf8');
        assert.match(published, /\[cli\]/);
        assert.match(published, /\[mcp_servers\.runpod\]/);
        assert.match(published, /\[mcp_servers\.remote\]/);
        assert.ok(published.includes('http://127.0.0.1:9/mcp/token'), 'our address replaces the one that was there');
        assert.ok(!published.includes('https://old.example/mcp'));
        assert.match(published, /\[mcp_servers\.Playwright\]/);

        // An edit made while the session is open survives the restore.
        fs.appendFileSync(file, '\n[ui]\ntheme = "groknight"\n');
        restore();
        restore();
        const after = fs.readFileSync(file, 'utf8');
        assert.match(after, /\[cli\]/);
        assert.match(after, /\[mcp_servers\.runpod\]/);
        assert.match(after, /\[ui\]/);
        assert.ok(after.includes('https://old.example/mcp'), 'the user\'s own remote server comes back');
        assert.ok(!after.includes('127.0.0.1:9'), 'our address is gone');
        assert.ok(!after.includes('[mcp_servers.Playwright]'), 'a server we added is gone');

        const absent = path.join(userHome, 'missing');
        fs.mkdirSync(absent);
        const empty = provider.publishUserMcp('', { source: absent });
        empty();
        assert.ok(!fs.existsSync(path.join(absent, 'config.toml')), 'nothing to publish writes no file');
    } finally {
        fs.rmSync(userHome, { recursive: true, force: true });
    }

    /* ---------------- Trusting the workspace ---------------- */

    // The CLI ignores a folder's config until the folder is trusted, and in
    // headless mode nobody is there to say so. The app says so itself, in
    // the CLI's own file, once.
    const trustHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-trust-'));
    try {
        const folder = path.join(trustHome, 'workspace');
        assert.strictEqual(provider.trustWorkspace(folder, { source: trustHome, now: 1700000000000 }), true);
        const trusted = fs.readFileSync(path.join(trustHome, 'trusted_folders.toml'), 'utf8');
        assert.ok(trusted.includes(`[folders.'${folder}']`), 'the folder is the key, in the CLI\'s own spelling');
        assert.match(trusted, /trusted = true/);
        assert.match(trusted, /decided_at = 1700000000/);

        assert.strictEqual(provider.trustWorkspace(folder, { source: trustHome }), false, 'once is enough');
        assert.strictEqual(fs.readFileSync(path.join(trustHome, 'trusted_folders.toml'), 'utf8'), trusted, 'and the file is then left alone');

        // An entry that is already there, whatever it says, is not ours to change.
        const declined = path.join(trustHome, 'declined');
        fs.appendFileSync(path.join(trustHome, 'trusted_folders.toml'), `\n[folders.'${declined}']\ntrusted = false\ndecided_at = 1\n`);
        assert.strictEqual(provider.trustWorkspace(declined, { source: trustHome }), false);
        assert.match(fs.readFileSync(path.join(trustHome, 'trusted_folders.toml'), 'utf8'), /trusted = false/);

        // Appended after an existing file that has other folders in it, on
        // its own paragraph, so the CLI's parser still reads the whole file.
        const another = path.join(trustHome, 'another');
        provider.trustWorkspace(another, { source: trustHome });
        const whole = fs.readFileSync(path.join(trustHome, 'trusted_folders.toml'), 'utf8');
        assert.ok(whole.includes(`\n\n[folders.'${another}']\ntrusted = true`), 'a blank line before the new table');
    } finally {
        fs.rmSync(trustHome, { recursive: true, force: true });
    }

    /* ---------------- The token, however it is offered ---------------- */

    const { offeredToken } = mcpHost._test;
    assert.strictEqual(
        offeredToken({ headers: { authorization: 'Bearer abc123' }, url: '/mcp' }),
        'abc123',
        'the header is still what the other providers use'
    );
    assert.strictEqual(
        offeredToken({ headers: {}, url: '/mcp/abc123' }),
        'abc123',
        'a client that can only be given an address carries it in the path'
    );
    assert.strictEqual(offeredToken({ headers: {}, url: '/mcp' }), '', 'no token offered is no token');
    assert.strictEqual(offeredToken({ headers: {}, url: '/mcp/abc123?x=1' }), 'abc123');

    /* ---------------- Failures that say what to do ---------------- */

    assert.match(provider.describeFailure('401 unauthorized'), /sign in|signed in/i);
    assert.match(provider.describeFailure('spawn grok ENOENT'), /could not be started/);
    assert.match(provider.describeFailure('error: unexpected argument --effort'), /Update the CLI/);
    assert.match(provider.describeFailure('429 rate limit exceeded'), /rate limiting/);
    assert.strictEqual(provider.describeFailure('a plain failure'), 'a plain failure');

    /* ---------------- The models, read from the CLI's own home ---------- */

    assert.strictEqual(
        provider.grokHome({ env: {}, home: UNIX_HOME }),
        path.join(UNIX_HOME, '.grok'),
        'the CLI\'s own default is where its setup is expected to be'
    );
    assert.strictEqual(
        provider.grokHome({ env: { GROK_HOME: '/elsewhere' }, home: UNIX_HOME }),
        '/elsewhere',
        'a home they moved is the one the CLI would read, so it is the one we read'
    );

    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
    try {
        assert.strictEqual(provider.signedIn({ source: grokHome }), false, 'no auth file is no login');
        assert.strictEqual(provider.cachedModels({ source: grokHome }), null, 'and nothing to offer');

        fs.writeFileSync(path.join(grokHome, 'auth.json'), '{}', 'utf8');
        assert.strictEqual(provider.signedIn({ source: grokHome }), true);

        fs.writeFileSync(path.join(grokHome, 'config.toml'), [
            '[cli]',
            'installer = "internal"',
            '',
            '[models]',
            'default = "grok-4.6"',
            'default_reasoning_effort = "xhigh"',
            '',
            '[ui]',
            'yolo = false',
        ].join('\n'), 'utf8');
        assert.strictEqual(
            provider.configuredModel(grokHome),
            'grok-4.6',
            'the model it is set to is the row the menu should land on'
        );

        fs.writeFileSync(path.join(grokHome, 'models_cache.json'), JSON.stringify({
            models: {
                'grok-4.6': {
                    info: {
                        id: 'grok-4.6',
                        model: 'grok-4.6',
                        name: 'Grok 4.6',
                        description: 'The frontier one',
                        hidden: false,
                        supports_reasoning_effort: true,
                        reasoning_efforts: [
                            { value: 'xhigh' }, { value: 'high' }, { value: 'medium' },
                            { value: 'low' }, { value: 'glacial' },
                        ],
                    },
                },
                'grok-4.5': {
                    info: {
                        id: 'grok-4.5',
                        name: 'Grok 4.5',
                        hidden: false,
                        supports_reasoning_effort: true,
                        reasoning_efforts: [{ value: 'high' }, { value: 'low' }],
                    },
                },
                'grok-internal': { info: { id: 'grok-internal', name: 'Internal', hidden: true } },
                'muse-spark-1.3': {
                    info: {
                        id: 'muse-spark-1.3',
                        model: 'muse-spark-1.3',
                        model_family: 'meta',
                        name: 'Muse Spark 1.3',
                        hidden: false,
                    },
                },
                'gpt-5.3-codex-spark': {
                    info: {
                        id: 'gpt-5.3-codex-spark',
                        model: 'gpt-5.3-codex-spark',
                        model_family: 'openai-codex',
                        name: 'GPT-5.3 Codex Spark',
                        hidden: false,
                    },
                },
            },
        }), 'utf8');

        const rows = provider.cachedModels({ source: grokHome });
        assert.deepStrictEqual(
            rows.map(row => row.value),
            ['grok-4.6', 'grok-4.5'],
            'a model the CLI hides is not one this app offers'
        );
        assert.ok(
            !rows.some(row => String(row.value).includes('muse-spark') || String(row.value).includes('codex')),
            'third-party models from a shared proxy never land on the Grok Build menu'
        );
        assert.strictEqual(provider.isGrokModel('grok-4.7', { model_family: 'xai' }), true);
        assert.strictEqual(provider.isGrokModel('grok-4.7-build-fast', { model: 'grok-4.7-build-fast' }), true);
        assert.strictEqual(provider.isGrokModel('muse-spark-1.3', { model_family: 'meta' }), false);
        assert.strictEqual(provider.isGrokModel('gpt-5.3-codex-spark', { model_family: 'openai-codex' }), false);
        assert.strictEqual(rows[0].short, 'Grok 4.6', 'the name it goes by is the name shown');
        assert.deepStrictEqual(
            rows[0].effort,
            ['xhigh', 'high', 'medium', 'low'],
            'a level this app has no name for is not a stop it can offer'
        );
        assert.deepStrictEqual(
            rows[1].effort,
            ['high', 'low'],
            'the scale is the model\'s own, not the union of every model\'s'
        );
        // Which is the bug this reader exists for: with the CLI on the machine
        // and no key stored, the only list came from an API there was nothing
        // to ask with, so the menu offered one row and never filled in.
        assert.strictEqual(rows[0].preferred, true);
        assert.strictEqual(rows[1].preferred, false);
    } finally {
        fs.rmSync(grokHome, { recursive: true, force: true });
    }

    console.log('grok provider tests passed');
    fs.rmSync(userData, { recursive: true, force: true });
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
