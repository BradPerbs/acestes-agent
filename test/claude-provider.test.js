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
        statSync: () => ({ size: 1 }),
    }), 'C:\\Tools\\claude.exe');

    assert.strictEqual(provider.findClaude({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Tools' },
        readdirSync: NONE,
        accessSync(candidate) {
            if (candidate !== native) throw new Error('missing');
        },
        statSync: () => ({ size: 1 }),
    }), native);

    // A stalled self-update leaves a real file of zero bytes, which exists and
    // will not launch. It gets skipped rather than chosen.
    assert.strictEqual(provider.findClaude({
        platform: 'win32',
        home: 'C:\\Users\\Mario',
        env: { Path: 'C:\\Tools' },
        readdirSync: NONE,
        accessSync() {},
        statSync: candidate => ({ size: candidate === 'C:\\Tools\\claude.exe' ? 0 : 1 }),
    }), native);

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

    console.log('claude-provider tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
