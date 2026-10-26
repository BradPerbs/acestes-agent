const assert = require('assert');

const provider = require('../src/main/ai/providers/claude-code');

/** A readdir that answers from a map and 404s everywhere else. */
function readdirMap(directories) {
    return (asked) => {
        if (Object.prototype.hasOwnProperty.call(directories, asked)) return directories[asked];
        throw new Error('ENOENT');
    };
}

const NONE = () => { throw new Error('ENOENT'); };

async function run() {
    const windowsCandidates = provider.claudeCandidates({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: {
            Path: 'C:\\Tools;D:\\Bin',
            LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local',
        },
        readdirSync: NONE,
    });
    assert(windowsCandidates.includes('C:\\Tools\\claude.exe'));
    assert(windowsCandidates.includes('D:\\Bin\\claude.exe'));
    // Where the native installer puts it, which is the copy most machines have.
    assert(windowsCandidates.includes('C:\\Users\\Mario\\.local\\bin\\claude.exe'));
    assert(windowsCandidates.includes('C:\\Users\\Mario\\AppData\\Local\\Programs\\claude\\claude.exe'));
    assert(windowsCandidates.includes('C:\\Users\\Mario\\.claude\\local\\claude.exe'));

    // An npm shim is deliberately not a candidate: the SDK spawns without a
    // shell, and Node will not start a .cmd that way.
    assert(!windowsCandidates.some(candidate => candidate.endsWith('.cmd')));
    assert(!windowsCandidates.some(candidate => candidate.endsWith('.bat')));

    const posixCandidates = provider.claudeCandidates({
        platform: 'darwin',
        home: '/Users/mario',
        env: { PATH: '/opt/tools/bin' },
        readdirSync: NONE,
    });
    assert(posixCandidates.includes('/opt/tools/bin/claude'));
    assert(posixCandidates.includes('/Users/mario/.local/bin/claude'));
    assert(posixCandidates.includes('/opt/homebrew/bin/claude'));
    assert(posixCandidates.includes('/usr/local/bin/claude'));
    assert(!posixCandidates.some(candidate => candidate.endsWith('.exe')));

    // The copy an editor extension carries comes first, and among several the
    // newest wins. 2.1.221 over 2.1.99 is the case a string sort gets wrong.
    const extensions = provider.claudeCandidates({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Tools' },
        readdirSync: readdirMap({
            'C:\\Users\\Mario\\.vscode\\extensions': [
                'anthropic.claude-code-2.1.99-win32-x64',
                'anthropic.claude-code-2.1.221-win32-x64',
                'ms-python.python-2024.1.0',
            ],
        }),
    });
    const base = 'C:\\Users\\Mario\\.vscode\\extensions\\anthropic.claude-code-';
    assert.deepStrictEqual(extensions.slice(0, 3), [
        `${base}2.1.221-win32-x64\\resources\\native-binary\\claude.exe`,
        `${base}2.1.99-win32-x64\\resources\\native-binary\\claude.exe`,
        'C:\\Tools\\claude.exe',
    ]);
    // Extensions that are not Claude Code are left alone.
    assert(!extensions.some(candidate => candidate.includes('ms-python')));

    // The extension keeps its binary under one of two layouts, and prefers a
    // directory per platform and architecture over the flat one. The musl
    // suffix on the Linux builds is why those names are read off the disk
    // rather than reconstructed.
    const extensions2 = 'anthropic.claude-code-2.1.221-linux-x64';
    const resources = `/home/mario/.vscode/extensions/${extensions2}/resources`;
    const linux = provider.claudeCandidates({
        platform: 'linux',
        home: '/home/mario',
        env: { PATH: '/usr/bin' },
        readdirSync: readdirMap({
            '/home/mario/.vscode/extensions': [extensions2],
            [`${resources}/native-binaries`]: ['linux-x64-musl', 'linux-x64'],
        }),
    });
    assert.deepStrictEqual(linux.slice(0, 4), [
        `${resources}/native-binaries/linux-x64-musl/claude`,
        `${resources}/native-binaries/linux-x64/claude`,
        `${resources}/native-binary/claude`,
        '/usr/bin/claude',
    ]);

    // A build that is not platform-specific has no suffix after the version,
    // and still reads as one of these.
    const universal = provider.claudeCandidates({
        platform: 'darwin',
        home: '/Users/mario',
        env: {},
        readdirSync: readdirMap({
            '/Users/mario/.vscode/extensions': ['anthropic.claude-code-2.1.221'],
        }),
    });
    assert(universal.includes(
        '/Users/mario/.vscode/extensions/anthropic.claude-code-2.1.221/resources/native-binary/claude'
    ));

    // An npm install leaves only .cmd shims on PATH; the real binary is the
    // package's bin/claude.exe, looked for under every PATH folder (an npm
    // prefix) and under npm's default prefix even when PATH predates it.
    const npmInstall = provider.claudeCandidates({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: {
            Path: 'C:\\nvm4w\\nodejs',
            APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming',
        },
        readdirSync: NONE,
    });
    assert(npmInstall.includes('C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
    assert(npmInstall.includes('C:\\Users\\Mario\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));
    // The native installer's copy is still preferred to an npm one.
    assert(npmInstall.indexOf('C:\\Users\\Mario\\.local\\bin\\claude.exe')
        < npmInstall.indexOf('C:\\Users\\Mario\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'));

    // winget: the link under Links, and the portable package's own folder,
    // per user and machine-wide. Other packages there are left alone.
    const wingetPackages = 'C:\\Users\\Mario\\AppData\\Local\\Microsoft\\WinGet\\Packages';
    const winget = provider.claudeCandidates({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: {
            LOCALAPPDATA: 'C:\\Users\\Mario\\AppData\\Local',
            ProgramFiles: 'C:\\Program Files',
        },
        readdirSync: readdirMap({
            [wingetPackages]: [
                'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe',
                'BurntSushi.ripgrep.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe',
            ],
        }),
    });
    assert(winget.includes('C:\\Users\\Mario\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'));
    assert(winget.includes(`${wingetPackages}\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe`));
    assert(winget.includes('C:\\Program Files\\WinGet\\Links\\claude.exe'));
    assert(!winget.some(candidate => candidate.includes('ripgrep')));

    // The Claude desktop app's own copy, for a machine that has nothing else.
    // The Store build keeps it inside its package (its %APPDATA% is
    // redirected there); the downloaded installer in the real %APPDATA%.
    // Newest version first, the build-hash folder before the flat layout.
    // These are the Claude Desktop agent's, and only its.
    const local = 'C:\\Users\\Mario\\AppData\\Local';
    const msixStore = `${local}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code`;
    const exeStore = 'C:\\Users\\Mario\\AppData\\Roaming\\Claude\\claude-code';
    const desktopMachine = {
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { LOCALAPPDATA: local, APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming' },
        readdirSync: readdirMap({
            [`${local}\\Packages`]: ['Claude_pzs8sxrjxfjjc', 'Microsoft.WindowsCalculator_8wekyb3d8bbwe'],
            [msixStore]: ['2.1.99', '2.1.295', 'downloads'],
            [`${msixStore}\\2.1.295`]: ['d2e29494ec83', 'claude.exe.zst'],
            [`${msixStore}\\2.1.99`]: ['claude.exe'],
            [exeStore]: ['2.1.280'],
            [`${exeStore}\\2.1.280`]: ['claude.exe'],
        }),
    };
    assert.deepStrictEqual(provider.desktopClaudeCandidates(desktopMachine), [
        `${msixStore}\\2.1.295\\d2e29494ec83\\claude.exe`,
        `${msixStore}\\2.1.295\\claude.exe`,
        `${exeStore}\\2.1.280\\claude.exe`,
        `${msixStore}\\2.1.99\\claude.exe`,
    ]);
    // Claude Code never runs the desktop app's copy: that is a separate agent.
    assert(!provider.claudeCandidates(desktopMachine).some(candidate => candidate.includes('\\Claude\\claude-code\\')));

    // And the lookup each agent uses picks only its own.
    const real = `${msixStore}\\2.1.295\\d2e29494ec83\\claude.exe`;
    const onlyDesktop = {
        ...desktopMachine,
        accessSync(candidate) { if (candidate !== real) throw new Error('missing'); },
        statSync: () => ({ size: 250 * 1024 * 1024 }),
    };
    assert.strictEqual(provider.findDesktopClaude(onlyDesktop), real);
    assert.strictEqual(provider.findClaude(onlyDesktop), '', 'Claude Code is not installed here');

    // The same store on a Mac, where the binary is inside an app bundle.
    const macStore = '/Users/mario/Library/Application Support/Claude/claude-code';
    const mac = provider.desktopClaudeCandidates({
        platform: 'darwin',
        home: '/Users/mario',
        env: { PATH: '/usr/bin' },
        readdirSync: readdirMap({ [macStore]: ['2.1.78'], [`${macStore}/2.1.78`]: ['claude.app'] }),
    });
    assert(mac.includes(`${macStore}/2.1.78/claude.app/Contents/MacOS/claude`));

    // There is no desktop app on Linux, so nothing is looked for.
    assert.deepStrictEqual(provider.desktopClaudeCandidates({
        platform: 'linux',
        home: '/home/mario',
        env: { PATH: '/usr/bin' },
        readdirSync: readdirMap({ '/home/mario/Library/Application Support/Claude/claude-code': ['2.1.78'] }),
    }), []);

    /* ---------------- Claude Desktop, the agent ---------------- */

    // Every entry point that starts the CLI runs as Claude Desktop whatever the
    // caller passed, including the account actions, which pass no provider.
    const desktopAgent = require('../src/main/ai/providers/claude-desktop');
    const seen = [];
    const originals = {};
    for (const name of ['start', 'title', 'listModels', 'readLimits', 'authStatus', 'login', 'logout']) {
        originals[name] = provider[name];
        provider[name] = (options) => { seen.push([name, options?.settings?.provider, options?.settings?.accountEnv]); return null; };
    }
    try {
        desktopAgent.start({ settings: { provider: 'claude-code' }, onEvent() {} });
        desktopAgent.title({ settings: {} });
        desktopAgent.listModels({ settings: {} });
        desktopAgent.readLimits({ settings: { accountEnv: { X: '1' } } });
        desktopAgent.authStatus();
        desktopAgent.login({ settings: {} });
        desktopAgent.logout({});
    } finally {
        Object.assign(provider, originals);
    }
    assert.deepStrictEqual(seen.map(([name]) => name), ['start', 'title', 'listModels', 'readLimits', 'authStatus', 'login', 'logout']);
    assert(seen.every(([, pinned]) => pinned === 'claude-desktop'), 'always the desktop agent');
    assert.deepStrictEqual(seen[3][2], { X: '1' }, 'the rest of the settings are passed on');
    assert.strictEqual(desktopAgent.PROVIDER, 'claude-desktop');
    assert.strictEqual(typeof desktopAgent.detect, 'function');
    assert.strictEqual(desktopAgent.supportsImages, provider.supportsImages, 'the rest is Claude Code\'s');

    // Signed out, the CLI answers with a canned reply flagged on the message
    // and a result that says success with is_error set (shapes as Claude Code
    // 2.1.295 sends them). That is a sign-in for the chat to offer, not a
    // reply to print, and the turn is a failure.
    const signedOut = [];
    provider.translate({
        type: 'assistant',
        error: 'authentication_failed',
        is_api_error_message: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
        parent_tool_use_id: null,
    }, event => signedOut.push(event));
    provider.translate({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
        num_turns: 1,
    }, event => signedOut.push(event));
    assert.strictEqual(signedOut.length, 2);
    assert.strictEqual(signedOut[0].type, 'error');
    assert.strictEqual(signedOut[0].code, 'signInNeeded');
    assert.strictEqual(signedOut[0].provider, 'claude-code');
    assert(!/\/login|terminal/.test(signedOut[0].message), 'no advice that cannot be followed here');
    assert(!signedOut.some(event => event.type === 'assistant-text'), 'the canned reply is not printed');
    assert.strictEqual(signedOut[1].type, 'result');
    assert.strictEqual(signedOut[1].isError, true);

    // An ordinary reply is untouched.
    const ordinary = [];
    provider.translate({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
        parent_tool_use_id: null,
    }, event => ordinary.push(event));
    provider.translate({ type: 'result', subtype: 'success', is_error: false, result: 'Hello.' }, event => ordinary.push(event));
    assert.deepStrictEqual(ordinary.map(event => event.type), ['assistant-text', 'result']);
    assert.strictEqual(ordinary[1].isError, false);

    // None of this on the other platforms, where npm and Homebrew put a real
    // `claude` on PATH.
    const posixNpm = provider.claudeCandidates({
        platform: 'linux',
        home: '/home/mario',
        env: { PATH: '/usr/bin', APPDATA: '/nope', LOCALAPPDATA: '/nope' },
        readdirSync: NONE,
    });
    assert(!posixNpm.some(candidate => candidate.includes('node_modules') || candidate.includes('WinGet')));

    // A real Windows binary, for the lookups below: anything under 4 KB is
    // the npm package's placeholder, not Claude Code.
    const BINARY = 250 * 1024 * 1024;

    // PATH wins over the installer locations, so a copy the user put somewhere
    // of their own is the one that runs.
    const native = 'C:\\Users\\Mario\\.local\\bin\\claude.exe';
    assert.strictEqual(provider.findClaude({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Tools' },
        readdirSync: NONE,
        accessSync(candidate) {
            if (candidate !== 'C:\\Tools\\claude.exe' && candidate !== native) throw new Error('missing');
        },
        statSync: () => ({ size: BINARY }),
    }), 'C:\\Tools\\claude.exe');

    assert.strictEqual(provider.findClaude({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Tools' },
        readdirSync: NONE,
        accessSync(candidate) {
            if (candidate !== native) throw new Error('missing');
        },
        statSync: () => ({ size: BINARY }),
    }), native);

    // A stalled self-update leaves a real file of zero bytes, which exists and
    // will not launch. It gets skipped rather than chosen.
    assert.strictEqual(provider.findClaude({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Tools' },
        readdirSync: NONE,
        accessSync() {},
        statSync: candidate => ({ size: candidate === 'C:\\Tools\\claude.exe' ? 0 : BINARY }),
    }), native);

    // An npm install is found with nothing on PATH but its shims.
    const npmBinary = 'C:\\Users\\Mario\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    assert.strictEqual(provider.findClaude({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming' },
        readdirSync: NONE,
        accessSync(candidate) {
            if (candidate !== npmBinary) throw new Error('missing');
        },
        statSync: () => ({ size: BINARY }),
    }), npmBinary);

    // Unless its postinstall never ran, which leaves a ~500 byte script where
    // the binary should be. That is not an install, and nothing is found.
    assert.strictEqual(provider.findClaude({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Windows', APPDATA: 'C:\\Users\\Mario\\AppData\\Roaming' },
        readdirSync: NONE,
        accessSync(candidate) {
            if (candidate !== npmBinary) throw new Error('missing');
        },
        statSync: () => ({ size: 500 }),
    }), '');

    // A small `claude` elsewhere can be a real launcher script, and is kept.
    assert.strictEqual(provider.findClaude({
        platform: 'linux',
        home: '/home/mario',
        env: { PATH: '/usr/bin' },
        readdirSync: NONE,
        accessSync(candidate) {
            if (candidate !== '/home/mario/.claude/local/claude') throw new Error('missing');
        },
        statSync: () => ({ size: 120 }),
    }), '/home/mario/.claude/local/claude');

    // Nothing installed is an empty string, not a throw and not a guess.
    assert.strictEqual(provider.findClaude({
        platform: 'linux',
        home: '/home/mario',
        env: { PATH: '/usr/bin' },
        readdirSync: NONE,
        accessSync() { throw new Error('missing'); },
        statSync: () => ({ size: 1 }),
    }), '');

    /* ---------------- The approval mode, on the CLI's own tools ---------------- */

    const policy = { autoApproveCommands: ['ls', 'git status'], blockedCommands: ['rm -rf'] };
    const never = { ...policy, approval: 'never' };
    const always = { ...policy, approval: 'always' };
    const writes = { ...policy, approval: 'writes' };

    // "Never" waits for nothing, ours or the CLI's or a server's.
    assert.strictEqual(provider.nativeAutoApproved('Edit', { file_path: 'a.js' }, never), true);
    assert.strictEqual(provider.nativeAutoApproved('Bash', { command: 'npm test' }, never), true);
    assert.strictEqual(provider.nativeAutoApproved('mcp__Playwright__browser_click', {}, never), true);
    // "Always" waits for everything.
    assert.strictEqual(provider.nativeAutoApproved('Read', { file_path: 'a.js' }, always), false);
    assert.strictEqual(provider.nativeAutoApproved('mcp__Playwright__browser_snapshot', {}, always), false);
    // The default: reads run, changes stop, the shell goes by the allow list.
    assert.strictEqual(provider.nativeAutoApproved('Read', {}, writes), true);
    assert.strictEqual(provider.nativeAutoApproved('Grep', {}, writes), true);
    assert.strictEqual(provider.nativeAutoApproved('Edit', {}, writes), false);
    assert.strictEqual(provider.nativeAutoApproved('Write', {}, writes), false);
    assert.strictEqual(provider.nativeAutoApproved('Bash', { command: 'git status' }, writes), true);
    assert.strictEqual(provider.nativeAutoApproved('Bash', { command: 'git push' }, writes), false);
    assert.strictEqual(provider.nativeAutoApproved('Bash', { command: 'ls; rm x' }, writes), false);
    assert.strictEqual(provider.nativeAutoApproved('mcp__Playwright__browser_snapshot', {}, writes), true);
    assert.strictEqual(provider.nativeAutoApproved('mcp__Playwright__browser_take_screenshot', {}, writes), true);
    assert.strictEqual(provider.nativeAutoApproved('mcp__Playwright__browser_click', {}, writes), false);
    assert.strictEqual(provider.nativeAutoApproved('mcp__github__list_issues', {}, writes), true);
    assert.strictEqual(provider.nativeAutoApproved('mcp__github__create_issue', {}, writes), false);

    // Subagents are not local tools: with the switch off a subagent can still
    // be started, and what it does is gated call by call.
    for (const name of provider.AGENT_TOOLS) {
        assert(!provider.LOCAL_TOOLS.includes(name), `${name} is not behind the local-tools switch`);
        assert.strictEqual(provider.nativeAutoApproved(name, {}, writes), true, `${name} is not asked about`);
    }

    // A turn that sends a subagent to the background, recorded from the CLI.
    // The first result lands while the subagent is out: the turn is held open,
    // and closes on the result after it, once the CLI says it is idle.
    {
        const events = [];
        const turns = provider.createTurnTracker(event => events.push(event));
        const system = (subtype, extra = {}) => ({ type: 'system', subtype, session_id: 's', ...extra });
        const result = cost => ({ type: 'result', subtype: 'success', result: '', total_cost_usd: cost, session_id: 's' });

        turns.began();
        turns.handle(system('session_state_changed', { state: 'running' }));
        turns.handle(system('init', { model: 'opus' }));
        turns.handle({
            type: 'assistant',
            parent_tool_use_id: null,
            message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'Disk check', run_in_background: true } }] },
        });
        turns.handle(system('background_tasks_changed', { tasks: [{ task_id: 't1', task_type: 'local_agent', description: 'Disk check' }] }));
        turns.handle(system('task_started', { task_id: 't1', tool_use_id: 'agent-1', description: 'Disk check', task_type: 'local_agent', is_backgrounded: true }));
        // The subagent's own work: its call is passed on under the parent,
        // its words are not.
        turns.handle({
            type: 'assistant',
            parent_tool_use_id: 'agent-1',
            message: { content: [{ type: 'text', text: 'Looking now' }, { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'df -h' } }] },
        });
        turns.handle({ type: 'stream_event', parent_tool_use_id: 'agent-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } } });
        // A shell the CLI runs for the subagent is not a subagent.
        turns.handle(system('task_started', { task_id: 'b1', tool_use_id: 'bash-1', task_type: 'local_bash', is_backgrounded: false }));
        turns.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'I will report back.' }] } });
        turns.handle(result(0.05));

        assert.deepStrictEqual(turns.agents(), ['t1']);
        assert(!events.some(event => event.type === 'result'), 'the first result is held');
        // The subagent's words go on, marked as its own, for its transcript.
        const said = events.filter(event => event.type === 'assistant-text' && event.text === 'Looking now');
        assert.deepStrictEqual(said.map(event => event.parentId), ['agent-1']);
        assert(!events.some(event => event.type === 'text-delta'), 'subagent deltas stay out of the draft');
        assert.strictEqual(events.find(event => event.id === 'bash-1').parentId, 'agent-1');
        assert.strictEqual(events.filter(event => event.type === 'task-started').length, 1);

        turns.handle(system('background_tasks_changed', { tasks: [] }));
        turns.handle(system('task_notification', { task_id: 't1', tool_use_id: 'agent-1', status: 'completed', summary: 'Disks are fine' }));
        turns.handle(system('init', { model: 'opus' }));
        turns.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Disks are fine.' }] } });
        turns.handle(result(0.06));
        turns.handle(system('session_state_changed', { state: 'idle' }));

        const results = events.filter(event => event.type === 'result');
        assert.strictEqual(results.length, 1, 'one result for the whole turn');
        assert.strictEqual(results[0].costUsd, 0.06);
        assert(!events.some(event => event.type === 'turn-resumed'), 'the turn never looked over');
        assert.strictEqual(events.find(event => event.type === 'task-ended').status, 'completed');
    }

    // Every subagent finished before the parent's reply did, so none is out
    // when the result lands, and the CLI starts its report a moment later.
    // Still one turn: the held result gives way to the report's.
    {
        const events = [];
        const turns = provider.createTurnTracker(event => events.push(event));
        turns.began();
        turns.handle({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
        turns.handle({ type: 'system', subtype: 'init', session_id: 's' });
        turns.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Done.' }] } });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.02 });
        turns.handle({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        assert.deepStrictEqual(events.map(event => event.type), ['session', 'assistant-text', 'result']);
        assert.strictEqual(events[2].costUsd, 0.02);
    }

    // Without a CLI, the same turn ends the old way: a result, then the
    // report announced as a turn of its own.
    {
        const events = [];
        const turns = provider.createTurnTracker(event => events.push(event));
        turns.began();
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
        turns.handle({ type: 'system', subtype: 'init', session_id: 's' });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.02 });
        assert.deepStrictEqual(events.map(event => event.type), ['result', 'turn-resumed', 'session', 'result']);
    }

    // Nothing out, no idle and no report: the held result stands after a while.
    {
        const events = [];
        const turns = provider.createTurnTracker(event => events.push(event), { settle: 5 });
        turns.began();
        turns.handle({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
        assert.strictEqual(events.length, 0);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepStrictEqual(events.map(event => event.type), ['result']);
    }

    // A held result is let go when the CLI goes idle without another one.
    {
        const events = [];
        const turns = provider.createTurnTracker(event => events.push(event));
        turns.began();
        turns.handle({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        turns.handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent' }] });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
        assert.strictEqual(events.length, 0);
        turns.handle({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        assert.deepStrictEqual(events.map(event => event.type), ['result']);
    }

    // Stopped with a subagent out: the turn the CLI starts to report the
    // stopped subagent is cut short and not shown, until the user speaks.
    {
        const events = [];
        let cut = 0;
        const turns = provider.createTurnTracker(event => events.push(event), { onUnwanted: () => { cut += 1; } });
        turns.began();
        turns.handle({ type: 'system', subtype: 'session_state_changed', state: 'running' });
        turns.handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent' }] });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
        turns.stopped();
        turns.handle({ type: 'system', subtype: 'init', session_id: 's' });
        turns.handle({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'The agent was stopped.' }] } });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.02 });
        assert.strictEqual(cut, 1);
        assert.deepStrictEqual(events, []);

        turns.began();
        turns.handle({ type: 'system', subtype: 'init', session_id: 's' });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.03 });
        turns.handle({ type: 'system', subtype: 'session_state_changed', state: 'idle' });
        assert.deepStrictEqual(events.map(event => event.type), ['session', 'result']);
    }

    // A CLI that never reports idle is never held for: nothing would let go.
    {
        const events = [];
        const turns = provider.createTurnTracker(event => events.push(event));
        turns.began();
        turns.handle({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_agent' }] });
        turns.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.01 });
        assert.deepStrictEqual(events.map(event => event.type), ['result']);
    }

    // The tools a conversation reaches for are loaded up front, so the model
    // does not spend a round trip on ToolSearch before using them. Every
    // name on the list is a real tool: a rename would otherwise quietly put
    // it back behind the search.
    {
        const catalog = require('../src/main/ai/tools');
        const names = new Set(catalog.TOOLS.map(tool => tool.name));
        for (const name of provider.ALWAYS_LOADED) assert(names.has(name), `${name} is in the catalog`);
        const tool = name => catalog.TOOLS.find(entry => entry.name === name);
        assert.strictEqual(provider.alwaysLoaded(tool('run_command')), true);
        assert.strictEqual(provider.alwaysLoaded(tool('remember')), true);
        assert.strictEqual(provider.alwaysLoaded(tool('ask_user')), true);
        // The rest stays deferred.
        const deferred = catalog.TOOLS.filter(entry => entry.group !== 'computer' && !provider.ALWAYS_LOADED.has(entry.name));
        assert(deferred.length > 0);
        for (const entry of deferred) assert.strictEqual(provider.alwaysLoaded(entry), false, entry.name);
        // Computer use: up front when it is on, deferred when it is off.
        const computer = catalog.TOOLS.find(entry => entry.group === 'computer');
        assert(computer, 'the catalog has computer tools');
        assert.strictEqual(provider.alwaysLoaded(computer, { computerUse: true }), true);
        assert.strictEqual(provider.alwaysLoaded(computer, { computerUse: false }), false);
    }

    // `claude setup-token` in a pseudo-terminal: spaces arrive as cursor
    // steps, the address as a hyperlink, and the token is picked out whole,
    // not glued to the word after it.
    {
        const raw = 'Paste\x1b[1Ccode\x1b[1Chere\x1b[1Cif\x1b[1Cprompted\x1b[1C>\r\n'
            + '\x1b]8;id=u1;https://claude.com/cai/oauth/authorize?code=true\x1b\\https://claude.com/cai/oauth/authorize?code=true\x1b]8;;\x1b\\\r\n'
            + '\x1b[32mYour\x1b[1COAuth\x1b[1Ctoken:\x1b[39m\r\n\x1b[1msk-ant-oat01-AbC_dEf-123456789012345678901234567890\x1b[22m\x1b[1CStore\x1b[1Cthis\r\n';
        const text = provider.plainTerminalText(raw);
        assert(/Paste code here if prompted/.test(text), text);
        assert(text.includes('https://claude.com/cai/oauth/authorize?code=true'));
        assert(!text.includes('\x1b'));
        assert.strictEqual(provider.TOKEN_PATTERN.exec(text)?.[0], 'sk-ant-oat01-AbC_dEf-123456789012345678901234567890');
        assert.strictEqual(provider.TOKEN_PATTERN.exec('sk-ant-api03-notatoken'), null);
        // As the CLI really prints it: the next line reached by a cursor move,
        // not a newline. The word after must not end up on the token.
        for (const move of ['\x1b[1B', '\x1b[2;1H', '\x1b[G', '\x1b[2K', '\x1b[1E']) {
            const moved = provider.plainTerminalText(`\x1b[1msk-ant-oat01-AbC_dEf-1234567890123456789012345678AA\x1b[22m${move}Store\x1b[1Cthis`);
            assert.strictEqual(provider.TOKEN_PATTERN.exec(moved)?.[0], 'sk-ant-oat01-AbC_dEf-1234567890123456789012345678AA', JSON.stringify(move));
        }
    }

    console.log('claude-provider tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
