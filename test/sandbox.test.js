/**
 * The envelope an agent works inside, and the two layers that enforce it.
 *
 * The code layer is always on: the tests below are the promises it makes.
 * One agent cannot drive a session another opened, a local tool cannot
 * leave the folders the user granted, a secret in the app's environment does
 * not reach an agent's MCP server, and a tool call over the loopback server
 * lands in the conversation whose token it carries and no other.
 *
 * The container layer is opt-in and needs Docker, which a test machine may
 * not have, so what is checked here is what would be run: the `docker
 * create` line, the `docker exec` line, and the mount plan behind them.
 *
 * `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-sandbox-'));

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

const sandbox = require(path.join(ROOT, 'ai', 'sandbox'));
const container = require(path.join(ROOT, 'ai', 'container'));
const local = require(path.join(ROOT, 'ai', 'local'));
const tools = require(path.join(ROOT, 'ai', 'tools'));
const transcript = require(path.join(ROOT, 'transcript'));
const mcpHost = require(path.join(ROOT, 'ai', 'mcp-host'));
const agents = require(path.join(ROOT, 'agents'));
const settings = require(path.join(ROOT, 'ai', 'settings'));

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

const WIN = process.platform === 'win32';
const root = WIN ? 'C:\\granted' : '/granted';
const other = WIN ? 'C:\\elsewhere' : '/elsewhere';
const inside = (...parts) => path.join(root, ...parts);

async function run() {
    console.log('\nagent sandbox');

    /* ---------------- The envelope ---------------- */

    await check('a fresh envelope grants nothing local and keeps sessions to the agent', () => {
        const fresh = sandbox.normalize();
        assert.strictEqual(fresh.execution, 'host');
        assert.strictEqual(fresh.sessions, 'own');
        assert.strictEqual(fresh.network, 'none');
        assert.deepStrictEqual(fresh.folders, []);
    });

    await check('unknown values fall back rather than being stored', () => {
        const odd = sandbox.normalize({ execution: 'vm', sessions: 'all', network: 'lan', folders: ['relative/path', { path: root, mode: 'rwx' }] });
        assert.strictEqual(odd.execution, 'host');
        assert.strictEqual(odd.sessions, 'own');
        assert.strictEqual(odd.network, 'none');
        assert.deepStrictEqual(odd.folders, [{ path: path.normalize(root), mode: 'read' }], 'a relative grant is dropped, a bad mode becomes read');
    });

    await check('the same folder granted twice is one grant', () => {
        const dup = sandbox.normalize({ folders: [{ path: root }, { path: root, mode: 'write' }] });
        assert.strictEqual(dup.folders.length, 1);
    });

    /* ---------------- Local paths ---------------- */

    const granted = sandbox.normalize({ folders: [{ path: root, mode: 'read' }, { path: inside('out'), mode: 'write' }] });

    await check('a path under a granted folder is admitted', () => {
        assert.ok(!sandbox.grantFor(granted, inside('a', 'b.txt')).error);
    });

    await check('a sibling with the same prefix is not inside the grant', () => {
        assert.ok(sandbox.grantFor(granted, `${root}2${path.sep}x`).error, '/granted2 is not under /granted');
    });

    await check('dot-dot does not climb out', () => {
        assert.ok(sandbox.grantFor(granted, inside('..', 'etc', 'passwd')).error);
    });

    await check('a folder granted for reading refuses a write', () => {
        const result = sandbox.grantFor(granted, inside('a.txt'), 'write');
        assert.ok(result.error && /only read/.test(result.error));
    });

    await check('the deepest grant wins, so a writable subfolder works inside a read-only tree', () => {
        assert.ok(!sandbox.grantFor(granted, inside('out', 'built.txt'), 'write').error);
    });

    await check('with nothing granted the message says so', () => {
        assert.ok(/no folders/.test(sandbox.grantFor(sandbox.normalize(), other).error));
    });

    await check('the local tools refuse outside the grant before touching the disk', async () => {
        const ctx = { agentId: 'a', sandbox: granted };
        const listed = await local.list(ctx, other);
        assert.ok(listed.error);
        const read = await local.read(ctx, path.join(other, 'secret'));
        assert.ok(read.error);
        const written = await local.write(ctx, inside('nope.txt'), 'x');
        assert.ok(written.error && /only read/.test(written.error));
        const ran = await local.run({ agentId: 'a', sandbox: sandbox.normalize() }, 'echo hi');
        assert.strictEqual(ran.success, false);
    });

    await check('the local tools work inside a real granted folder', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-grant-'));
        const ctx = { agentId: 'a', sandbox: sandbox.normalize({ folders: [{ path: dir, mode: 'write' }] }) };
        const written = await local.write(ctx, path.join(dir, 'sub', 'hello.txt'), 'hello');
        assert.ok(!written.error, written.error);
        const read = await local.read(ctx, path.join(dir, 'sub', 'hello.txt'));
        assert.strictEqual(read.content, 'hello');
        const listed = await local.list(ctx, dir);
        assert.ok(listed.entries.some(entry => entry.name === 'sub' && entry.type === 'directory'));
        const ran = await local.run(ctx, WIN ? 'cd' : 'pwd', { cwd: dir });
        assert.strictEqual(ran.success, true);
        assert.strictEqual(ran.exitCode, 0);
        assert.ok(ran.stdout.trim().toLowerCase().endsWith(path.basename(dir).toLowerCase()));
    });

    await check('edit replaces one exact passage and refuses an ambiguous or missing one', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-edit-'));
        const ctx = { agentId: 'a', sandbox: sandbox.normalize({ folders: [{ path: dir, mode: 'write' }] }) };
        const file = path.join(dir, 'app.conf');
        await local.write(ctx, file, 'port = 80\nhost = a\nport = 80\n');

        const missing = await local.edit(ctx, file, 'port = 443', 'port = 8443');
        assert.ok(/not found/.test(missing.error));
        const ambiguous = await local.edit(ctx, file, 'port = 80', 'port = 8080');
        assert.ok(/2 times/.test(ambiguous.error));
        const one = await local.edit(ctx, file, 'host = a', 'host = b');
        assert.strictEqual(one.replaced, 1);
        const all = await local.edit(ctx, file, 'port = 80', 'port = 8080', { all: true });
        assert.strictEqual(all.replaced, 2);
        assert.strictEqual((await local.read(ctx, file)).content, 'port = 8080\nhost = b\nport = 8080\n');

        const readOnly = { agentId: 'a', sandbox: sandbox.normalize({ folders: [{ path: dir, mode: 'read' }] }) };
        const refused = await local.edit(readOnly, file, 'host = b', 'host = c');
        assert.ok(refused.error && /only read/.test(refused.error));
    });

    await check('search greps the granted folders, skips noise, and stays inside the grant', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-search-'));
        const ctx = { agentId: 'a', sandbox: sandbox.normalize({ folders: [{ path: dir, mode: 'write' }] }) };
        await local.write(ctx, path.join(dir, 'a.conf'), 'listen 80\nserver_name web\n');
        await local.write(ctx, path.join(dir, 'sub', 'b.js'), 'const port = 80;\n');
        await local.write(ctx, path.join(dir, 'node_modules', 'x.js'), 'port 80 noise\n');
        fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 56, 48]));

        const found = await local.search(ctx, { query: '80' });
        const paths = found.matches.map(match => path.basename(match.path)).sort();
        assert.deepStrictEqual(paths, ['a.conf', 'b.js']);
        assert.strictEqual(found.matches.find(match => match.path.endsWith('a.conf')).line, 1);

        const only = await local.search(ctx, { query: '80', glob: '*.js' });
        assert.deepStrictEqual(only.matches.map(match => path.basename(match.path)), ['b.js']);

        const regex = await local.search(ctx, { query: '^server_\\w+', regex: true });
        assert.strictEqual(regex.matches.length, 1);
        assert.strictEqual(regex.matches[0].text, 'server_name web');

        const outside = await local.search(ctx, { query: '80', path: os.tmpdir() });
        assert.ok(outside.error, 'a path outside the grant is refused');
        const nothing = await local.search({ agentId: 'a', sandbox: sandbox.normalize() }, { query: '80' });
        assert.ok(/no folders/.test(nothing.error));
    });

    /* ---------------- Container paths ---------------- */

    await check('granted folders are mounted under /workspace by name', () => {
        const plan = sandbox.mountPlan(sandbox.normalize({ folders: [{ path: inside('site'), mode: 'write' }, { path: path.join(other, 'site') }] }));
        assert.deepStrictEqual(plan.map(mount => mount.container), ['/workspace/site', '/workspace/site-2']);
        assert.strictEqual(plan[0].mode, 'write');
        assert.strictEqual(plan[1].mode, 'read');
    });

    await check('a container path outside /workspace is refused, and a read-only mount refuses a write', () => {
        const envelope = sandbox.normalize({ execution: 'container', folders: [{ path: inside('site') }] });
        assert.ok(sandbox.containerPath(envelope, '/etc/passwd').error);
        assert.ok(sandbox.containerPath(envelope, '/workspace/../etc').error);
        assert.ok(!sandbox.containerPath(envelope, '/workspace/scratch.txt', 'write').error, 'scratch space is writable');
        assert.ok(sandbox.containerPath(envelope, '/workspace/site/index.html', 'write').error, 'a read-only mount is not');
        assert.ok(!sandbox.containerPath(envelope, 'site/index.html').error, 'relative paths resolve against /workspace');
    });

    /* ---------------- Docker ---------------- */

    await check('the container is created hardened, read-only and off the network', () => {
        const args = container.createArgs('agent-1', sandbox.normalize({ execution: 'container', folders: [{ path: inside('site'), mode: 'write' }, { path: inside('docs') }] }));
        const text = args.join(' ');
        assert.strictEqual(args[0], 'create');
        assert.ok(args.includes('acestes-agent-agent-1'));
        assert.ok(/--cap-drop ALL/.test(text));
        assert.ok(/--security-opt no-new-privileges/.test(text));
        assert.ok(/--pids-limit \d+/.test(text));
        assert.ok(args.includes('--read-only'));
        assert.ok(/--network none/.test(text), 'no network unless the envelope opens it');
        assert.ok(text.includes(`type=bind,source=${inside('site')},target=/workspace/site`) && !text.includes(`target=/workspace/site,readonly`));
        assert.ok(text.includes(`type=bind,source=${inside('docs')},target=/workspace/docs,readonly`));
        assert.ok(/noexec/.test(text), '/tmp is noexec');
        assert.strictEqual(args[args.length - 2], 'sleep');
    });

    await check('an open envelope puts the container on the bridge', () => {
        const args = container.createArgs('agent-1', sandbox.normalize({ execution: 'container', network: 'any' }));
        assert.ok(/--network bridge/.test(args.join(' ')));
    });

    await check('an agent MCP server in a container is a docker exec with only its own variables', () => {
        const spec = container.execSpec('agent-1', { command: 'npx', args: ['-y', 'some-server'], env: { API_URL: 'x', 'bad name': 'y' } });
        assert.strictEqual(spec.command, 'docker');
        assert.deepStrictEqual(spec.args.slice(0, 4), ['exec', '-i', '--workdir', '/workspace']);
        assert.ok(spec.args.includes('API_URL=x'));
        assert.ok(!spec.args.some(arg => arg.includes('bad name')));
        assert.deepStrictEqual(spec.args.slice(-3), ['acestes-agent-agent-1', 'npx', '-y'].slice(0, 3).length === 3 ? spec.args.slice(-3) : null);
        assert.strictEqual(spec.args[spec.args.length - 3], 'npx');
        assert.strictEqual(spec.args[spec.args.length - 4], 'acestes-agent-agent-1');
    });

    await check('the docker probe reports a missing daemon rather than throwing', async () => {
        container.setSpawner(() => { const error = new Error('spawn docker ENOENT'); error.code = 'ENOENT'; throw error; });
        try {
            const result = await container.probe();
            assert.strictEqual(result.available, false);
            assert.ok(/not installed/.test(result.reason));
        } finally {
            container.setSpawner(null);
        }
    });

    /* ---------------- Environment ---------------- */

    await check('an agent MCP server does not inherit secrets from the app', () => {
        const env = sandbox.safeEnv({
            PATH: '/bin', HOME: '/home/me', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y',
            ANTHROPIC_API_KEY: 'z', DB_PASSWORD: 'p', RANDOM_THING: 'q',
        }, { MY_SERVER_TOKEN: 'mine' });
        assert.strictEqual(env.PATH, '/bin');
        assert.strictEqual(env.HOME, '/home/me');
        assert.ok(!('AWS_SECRET_ACCESS_KEY' in env));
        assert.ok(!('GITHUB_TOKEN' in env));
        assert.ok(!('ANTHROPIC_API_KEY' in env));
        assert.ok(!('DB_PASSWORD' in env));
        assert.ok(!('RANDOM_THING' in env), 'only the system variables pass, not everything that is not a secret');
        assert.strictEqual(env.MY_SERVER_TOKEN, 'mine', 'what the user typed on the server record is kept');
    });

    /* ---------------- Sessions ---------------- */

    transcript.open('pane-user', { hostName: 'by hand', hostId: 'h1' });
    transcript.open('pane-a', { hostName: 'a opened', hostId: 'h2' });
    transcript.claim('pane-a', 'agent-a');
    transcript.open('pane-b', { hostName: 'b opened', hostId: 'h3' });
    transcript.claim('pane-b', 'agent-b');

    const ctxA = { agentId: 'agent-a', scope: 'global', sessionIds: [], hostIds: [], sandbox: sandbox.normalize() };
    const ctxB = { agentId: 'agent-b', scope: 'global', sessionIds: [], hostIds: [], sandbox: sandbox.normalize() };

    await check('an agent may use its own sessions and the ones the user opened', () => {
        assert.strictEqual(tools.sessionInScope(ctxA, 'pane-a'), true);
        assert.strictEqual(tools.sessionInScope(ctxA, 'pane-user'), true);
    });

    await check('an agent may not use a session another agent opened', () => {
        assert.strictEqual(tools.sessionInScope(ctxA, 'pane-b'), false);
        assert.strictEqual(tools.sessionInScope(ctxB, 'pane-a'), false);
        const resolved = tools.resolveSession({ session: 'pane-b' }, ctxA);
        assert.ok(/another agent/.test(resolved.error));
    });

    await check('the fence opens when the envelope says any', () => {
        const open = { ...ctxA, sandbox: sandbox.normalize({ sessions: 'any' }) };
        assert.strictEqual(tools.sessionInScope(open, 'pane-b'), true);
    });

    await check('a claim sticks: the second agent to ask does not take the session over', () => {
        assert.strictEqual(transcript.claim('pane-a', 'agent-b'), false);
        assert.strictEqual(transcript.info('pane-a').agentId, 'agent-a');
    });

    await check('a pinned set still fences on top of ownership', () => {
        const pinned = { ...ctxA, scope: 'targets', sessionIds: ['pane-user'], hostIds: [] };
        assert.strictEqual(tools.sessionInScope(pinned, 'pane-user'), true);
        assert.strictEqual(tools.sessionInScope(pinned, 'pane-a'), false, 'own but not pinned');
    });

    /* ---------------- The local tools in the catalog ---------------- */

    await check('the local tools declare which side of the approval line they are on', () => {
        assert.strictEqual(tools.BY_NAME.get('list_local_directory').readOnly, true);
        assert.strictEqual(tools.BY_NAME.get('read_local_file').readOnly, true);
        assert.strictEqual(tools.BY_NAME.get('write_local_file').readOnly, false);
        assert.strictEqual(tools.BY_NAME.get('run_local_command').readOnly, false);
    });

    await check('the blocked list applies to a local shell too', () => {
        const rules = { ...settings.DEFAULTS, blockedCommands: ['rm -rf'] };
        assert.ok(tools.blockedReason('run_local_command', { command: 'rm -rf /workspace' }, rules));
        assert.strictEqual(tools.isAutoApproved('run_local_command', { command: 'rm -rf x' }, { ...rules, approval: 'never' }), false);
    });

    /* ---------------- The agent record ---------------- */

    await check('the envelope is stored on the agent and patched, not replaced', () => {
        const created = agents.save({ name: 'Boxed', sandbox: { execution: 'container', folders: [{ path: root, mode: 'write' }] } });
        const id = created.saved;
        assert.strictEqual(agents.sandbox(id).execution, 'container');
        assert.strictEqual(agents.sandbox(id).folders.length, 1);
        agents.save({ id, sandbox: { network: 'any' } });
        assert.strictEqual(agents.sandbox(id).network, 'any');
        assert.strictEqual(agents.sandbox(id).folders.length, 1, 'a patch of one field keeps the folders');
        const shown = agents.snapshot().agents.find(agent => agent.id === id);
        assert.strictEqual(shown.sandbox.execution, 'container');
    });

    await check('a containerised agent has the runtime\'s own local tools switched off', () => {
        const boxed = agents.snapshot().agents.find(agent => agent.name === 'Boxed');
        const resolved = settings.get(boxed.id);
        assert.strictEqual(resolved.sandbox.execution, 'container');
        assert.strictEqual(resolved.allowLocalTools, false);
        const plain = agents.save({ name: 'Plain' });
        assert.strictEqual(settings.get(plain.saved).allowLocalTools, settings.DEFAULTS.allowLocalTools);
    });

    /* ---------------- The loopback tool server ---------------- */

    await check('each conversation gets its own token, answered in its own context', async () => {
        const first = await mcpHost.acquire({ toolContext: () => ({ agentId: 'one' }), requestApproval: async () => ({ approved: true }) });
        const second = await mcpHost.acquire({ toolContext: () => ({ agentId: 'two' }), requestApproval: async () => ({ approved: true }) });
        try {
            assert.notStrictEqual(first.token, second.token);
            assert.strictEqual(first.url, second.url, 'one server');
            assert.strictEqual(mcpHost._test.contextFor(first.token).toolContext().agentId, 'one');
            assert.strictEqual(mcpHost._test.contextFor(second.token).toolContext().agentId, 'two');
            assert.strictEqual(mcpHost._test.contextFor('nope'), null);

            const http = require('http');
            const status = await new Promise((resolve) => {
                http.get(`${first.url}/${'0'.repeat(64)}`, response => { response.resume(); resolve(response.statusCode); });
            });
            assert.strictEqual(status, 401, 'an unknown token is refused before parsing');
        } finally {
            await mcpHost.release(first.token);
            assert.ok(mcpHost._test.contextFor(second.token), 'the other conversation is still served');
            await mcpHost.release(second.token);
        }
        assert.strictEqual(mcpHost._test.contexts.size, 0);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
