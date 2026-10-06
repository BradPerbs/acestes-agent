/**
 * Live charts (watch_metric): the agent's pattern, read against what a
 * command prints, on a server's channel and on this computer, with the
 * rules every other command answers to, and the transcript's side of it.
 *
 * A server is a fake SSH session whose `exec` hands back a channel the test
 * writes into, so the stream's line handling, the pseudo-terminal it asks
 * for and the way it is stopped are all checked without a network. This
 * computer is real: a Node script that prints, read as it prints.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-metrics-'));

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

const live = require(path.join(ROOT, 'ai', 'live-metrics'));
const tools = require(path.join(ROOT, 'ai', 'tools'));
const metricTools = require(path.join(ROOT, 'ai', 'metric-tools'));
const settingsModule = require(path.join(ROOT, 'ai', 'settings'));
const ssh = require(path.join(ROOT, 'ssh'));
const transcript = require(path.join(ROOT, 'transcript'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.stack || error.message}`);
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Wait until `test` passes, or fail after `ms`. */
async function until(test, ms = 3000, what = 'the condition') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (test()) return;
        await sleep(20);
    }
    throw new Error(`Timed out waiting for ${what}`);
}

/**
 * A server: `exec` answers with a channel the test drives. Each call is
 * recorded with its command and options, and `respond` decides what the
 * channel does once it is handed back.
 */
function fakeServer(sessionId, respond) {
    const calls = [];
    const client = {
        exec(command, options, callback) {
            const channel = new EventEmitter();
            channel.stderr = new EventEmitter();
            channel.signals = [];
            channel.closed = false;
            channel.signal = name => channel.signals.push(name);
            channel.close = () => {
                if (channel.closed) return;
                channel.closed = true;
                setImmediate(() => channel.emit('close', null, 'HUP'));
            };
            calls.push({ command, options, channel });
            setImmediate(() => {
                callback(null, channel);
                respond?.(channel, command, calls.length);
            });
        },
    };
    ssh.sessions.set(sessionId, { client });
    transcript.open(sessionId, { hostName: `host-${sessionId}`, address: '10.0.0.9:22', protocol: 'ssh' });
    return calls;
}

/** The hooks a conversation gives a watch, recording what they were told. */
function recorder() {
    const seen = { started: [], batches: [], ended: [] };
    return {
        seen,
        hooks: {
            onStart: watch => seen.started.push(watch.id),
            onSamples: (watch, batch) => seen.batches.push(batch),
            onEnd: (watch, final) => seen.ended.push(final),
        },
    };
}

async function main() {
    console.log('\nlive metrics: the pattern');

    await check('one group is one series, named from the title', () => {
        const compiled = live.compile({ pattern: 'time=([\\d.]+) ms', title: 'Ping' });
        assert.deepStrictEqual(compiled.names, ['Ping']);
        const found = live.extract(compiled, '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.4 ms');
        assert.deepStrictEqual(found, { values: [12.4] });
    });

    await check('named groups name their series, in order', () => {
        const compiled = live.compile({ pattern: 'rx=(?<rx>\\d+) tx=(?<tx>\\d+)' });
        assert.deepStrictEqual(compiled.names, ['rx', 'tx']);
        assert.deepStrictEqual(live.extract(compiled, 'rx=10 tx=20').values, [10, 20]);
    });

    await check('numbered groups take the names given, and a default for the rest', () => {
        const compiled = live.compile({ pattern: 'load average: ([\\d.]+), ([\\d.]+), ([\\d.]+)', series: ['1m', '5m'] });
        assert.deepStrictEqual(compiled.names, ['1m', '5m', 'Value 3']);
        assert.deepStrictEqual(live.extract(compiled, ' 10:00 up 3 days, load average: 0.42, 0.30, 0.10').values, [0.42, 0.3, 0.1]);
    });

    await check('no group reads the whole match as the number', () => {
        const compiled = live.compile({ pattern: '\\d+\\.\\d+' });
        assert.deepStrictEqual(live.extract(compiled, 'took 3.25s').values, [3.25]);
    });

    await check('thousands separators are read through, and scale applies', () => {
        const compiled = live.compile({ pattern: '([\\d,]+) bytes', scale: 0.001 });
        assert.deepStrictEqual(live.extract(compiled, 'sent 1,284,000 bytes').values, [1284]);
    });

    await check('a group that caught something that is not a number is a gap in that series', () => {
        const compiled = live.compile({ pattern: 'a=(\\S+) b=(\\S+)' });
        assert.deepStrictEqual(live.extract(compiled, 'a=1.5 b=n/a').values, [1.5, null]);
    });

    await check('a gap line is a missed sample; anything else is nothing', () => {
        const compiled = live.compile({ pattern: 'time[=<]([\\d.]+) ?ms', gap: 'timed out|unreachable', flags: 'i' });
        assert.deepStrictEqual(live.extract(compiled, 'Request timed out.'), { gap: true });
        assert.deepStrictEqual(live.extract(compiled, 'Reply from 1.1.1.1: bytes=32 time<1ms TTL=57').values, [1]);
        assert.strictEqual(live.extract(compiled, 'Pinging 1.1.1.1 with 32 bytes of data:'), null);
    });

    await check('a global flag is dropped, so the same line matches every time', () => {
        const compiled = live.compile({ pattern: 'v=(\\d+)', flags: 'gi' });
        assert.ok(live.extract(compiled, 'v=1'));
        assert.ok(live.extract(compiled, 'v=1'));
    });

    await check('a bad pattern, a bad gap and too many groups are refused with the reason', () => {
        assert.match(live.compile({ pattern: '(' }).error, /not a valid regular expression/);
        assert.match(live.compile({ pattern: 'x', gap: '[' }).error, /gap pattern/);
        assert.match(live.compile({ pattern: '(\\d)'.repeat(9) }).error, /at most 8 series/);
        assert.match(live.compile({ pattern: '' }).error, /pattern is needed/);
    });

    await check('colour codes and carriage returns are gone before the pattern looks', () => {
        assert.strictEqual(live.cleanLine('\x1b[32mtime=5 ms\x1b[0m\r'), 'time=5 ms');
    });

    console.log('\nlive metrics: a stream on a server');

    await check('lines split across chunks are put back together, on a pty, and the first sample answers the call', async () => {
        const calls = fakeServer('s-stream', (channel) => {
            channel.emit('data', Buffer.from('PING 1.1.1.1\n64 bytes: time=1'));
            setTimeout(() => channel.emit('data', Buffer.from('0.5 ms\r\n64 bytes: time=11 ms\n')), 30);
        });
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: 'ping 1.1.1.1', pattern: 'time=([\\d.]+) ms', title: 'Ping', unit: 'ms', conversationId: 'c1' },
            { sessionId: 's-stream', where: 'web1' },
            hooks,
        );
        assert.ok(!result.error, result.error);
        assert.strictEqual(seen.started.length, 1);
        assert.ok(calls[0].options.pty, 'a stream asks for a pseudo-terminal');
        await until(() => result.watch.sampleCount === 2, 2000, 'two samples');
        assert.deepStrictEqual(result.watch.samples.map(sample => sample.v[0]), [10.5, 11]);
        assert.deepStrictEqual(result.watch.samples.map(sample => sample.n), [1, 2]);
        await until(() => seen.batches.some(batch => batch.points.length > 0), 1000, 'a batch to the window');

        const view = live.read(result.watch.id, { points: 5 });
        assert.strictEqual(view.status, 'running');
        assert.strictEqual(view.stats[0].min, 10.5);
        assert.strictEqual(view.stats[0].max, 11);
        assert.strictEqual(view.stats[0].avg, 10.75);
        assert.strictEqual(view.recent.length, 2);
        assert.strictEqual(live.ownerOf(result.watch.id), 'c1');

        assert.strictEqual(live.stop(result.watch.id, 'Stopped by the test.'), true);
        assert.deepStrictEqual(calls[0].channel.signals, ['INT'], 'interrupted first');
        assert.ok(calls[0].channel.closed, 'then the channel is closed');
        assert.strictEqual(seen.ended.length, 1);
        assert.strictEqual(seen.ended[0].status, 'stopped');
        assert.strictEqual(seen.ended[0].points.length, 2);
        assert.strictEqual(live.stop(result.watch.id), false, 'stopping twice does nothing');
        await sleep(50);
        assert.strictEqual(seen.ended.length, 1, 'the close after a stop does not end it again');
    });

    await check('gap lines count as missed samples and draw as nulls', async () => {
        fakeServer('s-gap', (channel) => {
            channel.emit('data', Buffer.from('time=5 ms\nRequest timed out.\ntime=7 ms\n'));
        });
        const { hooks } = recorder();
        const result = await live.start(
            { command: 'ping -t x', pattern: 'time=(\\d+) ms', gap: 'timed out', conversationId: 'c1' },
            { sessionId: 's-gap' },
            hooks,
        );
        await until(() => result.watch.sampleCount === 3, 2000, 'three samples');
        assert.deepStrictEqual(result.watch.samples.map(sample => sample.v[0]), [5, null, 7]);
        assert.strictEqual(live.read(result.watch.id).gaps, 1);
        live.stop(result.watch.id);
    });

    await check('a rate turns a counter into change per second, skipping a reset', async () => {
        fakeServer('s-rate', (channel) => {
            channel.emit('data', Buffer.from('requests 100\n'));
            setTimeout(() => channel.emit('data', Buffer.from('requests 300\n')), 200);
            setTimeout(() => channel.emit('data', Buffer.from('requests 50\n')), 400);
        });
        const { hooks } = recorder();
        const result = await live.start(
            { command: 'watch-counter', pattern: 'requests (\\d+)', rate: true, conversationId: 'c1' },
            { sessionId: 's-rate' },
            hooks,
        );
        await until(() => result.watch.sampleCount === 2, 2000, 'two rates');
        const [first, second] = result.watch.samples.map(sample => sample.v[0]);
        assert.ok(first > 700 && first < 1300, `about 1000/s, got ${first}`);
        assert.strictEqual(second, null, 'a counter going backwards is a gap');
        live.stop(result.watch.id);
    });

    await check('a stream that ends without a match fails, saying what it printed', async () => {
        fakeServer('s-nomatch', (channel) => {
            channel.emit('data', Buffer.from('ping: unknown host nowhere.invalid\n'));
            channel.emit('exit', 2);
            setTimeout(() => channel.emit('close', 2), 10);
        });
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: 'ping nowhere.invalid', pattern: 'time=([\\d.]+)', conversationId: 'c1' },
            { sessionId: 's-nomatch' },
            hooks,
        );
        assert.strictEqual(result.view.status, 'failed');
        assert.match(result.view.reason, /unknown host/);
        assert.strictEqual(seen.ended[0].status, 'failed');
    });

    await check('a stream that finishes on its own after matching is done', async () => {
        fakeServer('s-done', (channel) => {
            channel.emit('data', Buffer.from('time=1 ms\ntime=2 ms\n--- statistics ---\n'));
            channel.emit('exit', 0);
            setTimeout(() => channel.emit('close', 0), 10);
        });
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: 'ping -c 2 x', pattern: 'time=(\\d+) ms', conversationId: 'c1' },
            { sessionId: 's-done' },
            hooks,
        );
        await until(() => seen.ended.length === 1, 2000, 'the end');
        assert.strictEqual(seen.ended[0].status, 'done');
        assert.strictEqual(result.watch.sampleCount, 2);
    });

    console.log('\nlive metrics: a poll on a server');

    await check('a poll runs on a plain channel, one sample per run, until stopped', async () => {
        const calls = fakeServer('s-poll', (channel, command, count) => {
            channel.emit('data', Buffer.from(`10:00 up 3 days, load average: 0.${count}0, 0.30, 0.10\n`));
            channel.emit('close', 0);
        });
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: 'uptime', pattern: 'load average: ([\\d.]+), ([\\d.]+), ([\\d.]+)', series: ['1m', '5m', '15m'], every: 1, conversationId: 'c1' },
            { sessionId: 's-poll' },
            hooks,
        );
        assert.strictEqual(result.view.mode, 'poll');
        assert.strictEqual(result.view.samples, 1);
        assert.strictEqual(calls[0].options.pty, false, 'a poll needs no terminal');
        await until(() => result.watch.sampleCount === 2, 2500, 'the second poll');
        assert.deepStrictEqual(result.watch.samples.map(sample => sample.v[0]), [0.1, 0.2]);
        live.stop(result.watch.id);
        const runs = calls.length;
        await sleep(1300);
        assert.strictEqual(calls.length, runs, 'no poll after the stop');
        assert.strictEqual(seen.ended.length, 1);
    });

    await check('a poll whose pattern never matches draws gaps and still says what it saw', async () => {
        fakeServer('s-poll-miss', (channel) => {
            channel.emit('data', Buffer.from(' 10:00:01 up 3 days,  2 users,  load averages: 0.42 0.30 0.10\n'));
            channel.emit('close', 0);
        });
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: 'uptime', pattern: 'load average: ([\\d.]+)', every: 1, conversationId: 'c1' },
            { sessionId: 's-poll-miss' },
            hooks,
        );
        assert.strictEqual(result.view.samples, 1);
        assert.strictEqual(result.view.matched, 0);
        assert.strictEqual(result.view.gaps, 1);
        assert.match(result.view.unmatched[0], /load averages: 0.42/);
        await until(() => seen.batches.length > 0, 1000, 'a batch');
        assert.match(seen.batches[0].unmatched, /load averages/);
        live.stop(result.watch.id);
    });

    console.log('\nlive metrics: a stream on this computer');

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-metrics-local-'));
    const ctx = { agentId: 'a', sandbox: { execution: 'host', folders: [{ path: folder, mode: 'write' }] } };
    const script = path.join(folder, 'emit.js');
    fs.writeFileSync(script, [
        'let n = 0;',
        'const limit = Number(process.argv[2] || 0);',
        'const timer = setInterval(() => {',
        '    n += 1;',
        '    console.log(`sample value=${n * 1.5} units`);',
        '    if (limit && n >= limit) { clearInterval(timer); console.log("bye"); }',
        '}, 40);',
    ].join('\n'));
    const node = JSON.stringify(process.execPath);

    await check('a real process is read as it prints and ends done', async () => {
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: `${node} emit.js 6`, pattern: 'value=([\\d.]+)', conversationId: 'c2' },
            { local: true, ctx, cwd: folder },
            hooks,
        );
        assert.ok(!result.error, result.error);
        await until(() => seen.ended.length === 1, 5000, 'the process to end');
        assert.strictEqual(seen.ended[0].status, 'done', seen.ended[0].reason);
        assert.deepStrictEqual(result.watch.samples.map(sample => sample.v[0]), [1.5, 3, 4.5, 6, 7.5, 9]);
    });

    await check('stopping a process that would run for ever stops its samples', async () => {
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: `${node} emit.js`, pattern: 'value=([\\d.]+)', conversationId: 'c2' },
            { local: true, ctx, cwd: folder },
            hooks,
        );
        await until(() => result.watch.sampleCount >= 3, 5000, 'three samples');
        live.stop(result.watch.id, 'Stopped by the test.');
        const count = result.watch.sampleCount;
        await sleep(400);
        assert.strictEqual(result.watch.sampleCount, count, 'nothing arrives after the stop');
        assert.strictEqual(seen.ended[0].status, 'stopped');
    });

    await check('outside the granted folders nothing runs', async () => {
        const { seen, hooks } = recorder();
        const result = await live.start(
            { command: `${node} emit.js 2`, pattern: 'value=([\\d.]+)', conversationId: 'c2' },
            { local: true, ctx, cwd: os.homedir() },
            hooks,
        );
        assert.strictEqual(result.view.status, 'failed');
        assert.match(seen.ended[0].reason, /outside the folders/);
    });

    await check('a local poll goes through the same door as run_local_command', async () => {
        const { hooks } = recorder();
        const result = await live.start(
            { command: `${node} -e "console.log('depth 42')"`, pattern: 'depth (\\d+)', every: 1, conversationId: 'c2' },
            { local: true, ctx, cwd: folder },
            hooks,
        );
        assert.strictEqual(result.view.samples, 1, JSON.stringify(result.view));
        assert.strictEqual(result.watch.samples[0].v[0], 42);
        live.stop(result.watch.id);
    });

    await check('stopAll by conversation leaves the others running', async () => {
        fakeServer('s-a', channel => channel.emit('data', Buffer.from('v=1\n')));
        fakeServer('s-b', channel => channel.emit('data', Buffer.from('v=2\n')));
        const one = await live.start({ command: 'a', pattern: 'v=(\\d)', conversationId: 'keep' }, { sessionId: 's-a' }, {});
        const two = await live.start({ command: 'b', pattern: 'v=(\\d)', conversationId: 'drop' }, { sessionId: 's-b' }, {});
        assert.strictEqual(live.stopAll({ conversationId: 'drop' }), 1);
        assert.strictEqual(live.read(one.watch.id).status, 'running');
        assert.strictEqual(live.read(two.watch.id).status, 'stopped');
        live.stop(one.watch.id);
    });

    console.log('\nlive metrics: the tools');

    const defaults = {
        ...settingsModule.DEFAULTS,
        autoApproveCommands: [...settingsModule.DEFAULTS.autoApproveCommands],
        blockedCommands: ['rm -rf'],
        approval: 'auto',
    };

    await check('a watched command is approved as the command it is', () => {
        assert.strictEqual(tools.isAutoApproved('watch_metric', { command: 'cat /proc/loadavg' }, defaults), true);
        assert.strictEqual(tools.isAutoApproved('watch_metric', { command: 'ping 1.1.1.1' }, defaults), false);
        assert.strictEqual(tools.isAutoApproved('watch_metric', { command: 'cat /proc/loadavg; reboot' }, defaults), false);
        assert.strictEqual(tools.isAutoApproved('read_metric', {}, defaults), true);
        assert.strictEqual(tools.isAutoApproved('stop_metric', {}, defaults), true);
    });

    await check('the blocked list reaches a watched command', () => {
        assert.strictEqual(tools.blockedReason('watch_metric', { command: 'rm -rf /tmp/x && ping x' }, defaults), 'rm -rf');
        assert.strictEqual(tools.isAutoApproved('watch_metric', { command: 'rm -rf /tmp/x' }, { ...defaults, approval: 'never' }), false);
    });

    const watchTool = tools.BY_NAME.get('watch_metric');
    const readTool = tools.BY_NAME.get('read_metric');
    const stopTool = tools.BY_NAME.get('stop_metric');

    /** A conversation's metrics API, as index.js builds it, without the log. */
    const metricsFor = (conversationId) => {
        const owned = watchId => live.ownerOf(watchId) === conversationId;
        return {
            canExec: sessionId => live.canExec(sessionId),
            start: (spec, target) => live.start({ ...spec, conversationId }, target, {}),
            stop: watchId => owned(watchId) && live.stop(watchId),
            stopAll: () => live.stopAll({ conversationId }),
            read: (watchId, options) => (owned(watchId) ? live.read(watchId, options) : null),
            list: () => live.list(conversationId),
        };
    };
    const toolCtx = (extra = {}) => ({
        scope: 'all', sessionIds: [], hostIds: [], boundSessionId: '', settings: defaults, ...extra,
    });

    await check('the tools are in the catalog, and offered', () => {
        const names = tools.visibleTools(defaults).map(tool => tool.name);
        for (const name of ['watch_metric', 'read_metric', 'stop_metric']) assert.ok(names.includes(name), name);
    });

    await check('without a conversation to draw in, the tool says so', async () => {
        const result = await watchTool.handler({ command: 'x', pattern: 'y', session: 's-stream' }, toolCtx());
        assert.ok(result.isError);
        assert.match(result.text, /not available/);
    });

    await check('a session that cannot exec is refused before anything runs', async () => {
        ssh.sessions.set('s-telnet', {});
        transcript.open('s-telnet', { hostName: 'switch', protocol: 'telnet' });
        const result = await watchTool.handler(
            { command: 'x', pattern: 'y', session: 's-telnet' },
            toolCtx({ metrics: metricsFor('c3') }),
        );
        assert.ok(result.isError);
        assert.match(result.text, /not an SSH connection/);
    });

    await check('a blocked command is refused by the handler too', async () => {
        const result = await watchTool.handler(
            { command: 'rm -rf /tmp/x', pattern: 'y', session: 's-stream' },
            toolCtx({ metrics: metricsFor('c3') }),
        );
        assert.ok(result.isError);
        assert.match(result.text, /blocked command list/);
    });

    await check('started, the agent is told the first samples; read and stop work by id', async () => {
        fakeServer('s-tool', channel => channel.emit('data', Buffer.from('time=9.5 ms\n')));
        const ctxWith = toolCtx({ metrics: metricsFor('c4') });
        const started = await watchTool.handler(
            { command: 'ping 1.1.1.1', pattern: 'time=([\\d.]+) ms', title: 'Ping', unit: 'ms', session: 's-tool' },
            ctxWith,
        );
        assert.ok(!started.isError, started.text);
        const body = JSON.parse(started.text);
        assert.strictEqual(body.status, 'running');
        assert.strictEqual(body.where, 'host-s-tool');
        assert.deepStrictEqual(body.recent.map(sample => sample.Ping), [9.5]);
        assert.match(body.note, /live in the chat/);

        const read = JSON.parse((await readTool.handler({ watchId: body.watchId }, ctxWith)).text);
        assert.strictEqual(read.stats[0].last, 9.5);
        const listed = JSON.parse((await readTool.handler({}, ctxWith)).text);
        assert.ok(listed.watches.some(watch => watch.watchId === body.watchId));

        const other = await readTool.handler({ watchId: body.watchId }, toolCtx({ metrics: metricsFor('someone-else') }));
        assert.ok(other.isError, 'another conversation cannot read it');

        const stopped = JSON.parse((await stopTool.handler({ watchId: body.watchId }, ctxWith)).text);
        assert.strictEqual(stopped.status, 'stopped');
        const again = JSON.parse((await stopTool.handler({ watchId: body.watchId }, ctxWith)).text);
        assert.match(again.note, /already ended/);
    });

    await check('a pattern that catches nothing comes back with the lines it saw', async () => {
        fakeServer('s-miss', channel => channel.emit('data', Buffer.from('Reply from 1.1.1.1: bytes=32 time=12ms TTL=57\n')));
        const ctxWith = toolCtx({ metrics: metricsFor('c5') });
        const started = await watchTool.handler(
            { command: 'ping -t 1.1.1.1', pattern: 'time=([\\d.]+) ms', session: 's-miss' },
            { ...ctxWith },
        );
        const body = JSON.parse(started.text);
        assert.strictEqual(body.samples, 0);
        assert.match(body.unmatched[0], /time=12ms/);
        assert.match(body.note, /no line has matched/);
        await stopTool.handler({}, ctxWith);
    });

    console.log('\nlive metrics: the transcript');

    const reducer = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'transcript-reducer.js')).href);
    const lib = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'live-metric.js')).href);

    await check('a start is a chart in the transcript, and its end fills it in', () => {
        const state = reducer.replay([
            { type: 'user-message', text: 'watch ping', at: 1 },
            { type: 'tool-call', id: 't1', name: 'watch_metric', input: { command: 'ping x' }, at: 2 },
            { type: 'metric-started', watchId: 'w1', spec: { title: 'Ping', series: ['Ping'] }, at: 3 },
            { type: 'tool-result', id: 't1', text: '{}', at: 4 },
            { type: 'result', subtype: 'success', at: 5 },
            { type: 'metric-ended', watchId: 'w1', status: 'stopped', reason: 'Stopped by the user.', points: [{ n: 1, t: 10, v: [3] }], stats: { samples: 1 }, at: 6 },
        ]);
        const chart = state.items.find(item => item.kind === 'metric');
        assert.ok(chart);
        assert.strictEqual(state.items.indexOf(chart), 2, 'right under the call that started it');
        assert.strictEqual(chart.status, 'stopped');
        assert.strictEqual(chart.points.length, 1);
        assert.strictEqual(chart.reason, 'Stopped by the user.');
    });

    await check('a batch overlapping what is held is merged without doubles, and trimmed to the window', () => {
        const held = [{ n: 1, t: 1, v: [1] }, { n: 2, t: 2, v: [2] }];
        const merged = lib.mergePoints(held, [{ n: 2, t: 2, v: [2] }, { n: 3, t: 3, v: [3] }], 2);
        assert.deepStrictEqual(merged.map(point => point.n), [2, 3]);
        assert.strictEqual(lib.mergePoints(held, [{ n: 1, t: 1, v: [1] }], 10), held, 'nothing new keeps the same list');
    });

    await check('the chart is a live line chart with gaps kept as gaps', () => {
        const chart = lib.chartOf(
            { title: 'Ping', series: ['rtt'], unit: 'ms', where: 'web1', limits: [{ value: 50, label: 'SLO' }] },
            [{ n: 1, t: Date.UTC(2026, 0, 1, 10, 0, 5), v: [12] }, { n: 2, t: Date.UTC(2026, 0, 1, 10, 0, 6), v: [null] }],
        );
        assert.strictEqual(chart.type, 'line');
        assert.strictEqual(chart.live, true);
        assert.deepStrictEqual(chart.series[0].values, [12, null]);
        assert.strictEqual(chart.labels.length, 2);
        assert.match(chart.labels[0], /^\d\d:\d\d:05$/);
        assert.strictEqual(chart.limits[0].value, 50);
    });

    live.stopAll({ reason: 'The test is over.' });
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* Windows may hold it a moment */ }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
    // Timers kept for late reads would hold the process open.
    setTimeout(() => process.exit(process.exitCode || 0), 50);
}

main();
