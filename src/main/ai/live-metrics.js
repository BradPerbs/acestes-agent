const { spawn, spawnSync } = require('child_process');
const ssh = require('../ssh');
const exec = require('./exec');
const local = require('./local');
const container = require('./container');
const sandboxModule = require('./sandbox');

/**
 * Live metrics: a command watched, numbers pulled out of what it prints, and
 * a chart in the conversation that follows them as they come.
 *
 * A ```chart block is a snapshot written once into a reply. This is the other
 * kind: the agent names a command, a regular expression whose capture groups
 * are the numbers, and where to run it, and the chart keeps moving after the
 * turn that started it is over. The regex is the agent's on purpose. Nothing
 * here knows what ping, vmstat or a log line look like, so anything that
 * prints a number can be watched without this file learning about it.
 *
 * Two ways to read a command:
 *
 *   stream   run once and read line by line, for a command that keeps
 *            printing (ping, vmstat 1, tail -f). Every line the pattern
 *            matches is a sample.
 *   poll     run every N seconds and read its whole output, for one that
 *            prints once and exits (cat /proc/loadavg, a curl timing). One
 *            sample per run.
 *
 * On a server it runs on its own exec channel, never the terminal the user is
 * typing in. A stream gets a pseudo-terminal there, which does two jobs: the
 * program writes a line at a time instead of holding output back in a pipe
 * buffer, and closing the channel hangs it up, so `ping` does not outlive the
 * chart. On this computer it runs inside the agent's granted folders, or in
 * its container, as run_local_command does.
 *
 * The samples stay in this process. The window is sent them as they come, a
 * few times a second, on a channel of their own that is never written to the
 * conversation's log; the log gets one event when a watch starts and one when
 * it ends, carrying the last window of points, so a conversation read back
 * later still shows what was seen.
 */

/** How many watches may run at once, across the app. */
const MAX_WATCHES = 8;
/** Points on the chart: the rolling window. */
const DEFAULT_WINDOW = 120;
const MAX_WINDOW = 600;
/** Samples kept for read_metric and the percentiles, beyond the window. */
const KEEP = 1200;
/** How long a watch runs before it stops by itself. */
const DEFAULT_DURATION = 10 * 60 * 1000;
const MAX_DURATION = 6 * 60 * 60 * 1000;
/** A poll's bounds, in seconds. */
const MIN_EVERY = 1;
const MAX_EVERY = 3600;
/** How often the window is sent what arrived. */
const PUSH_MS = 250;
/** How long starting a watch waits for its first sample before answering. */
const PROBE_MS = 5000;
/** A line longer than this is cut before the pattern sees it. */
const MAX_LINE = 4000;
/** Series one chart can carry: the palette's length. */
const MAX_SERIES = 8;
/** Polls in a row that may fail before the watch gives up. */
const MAX_POLL_FAILURES = 5;
/** Unmatched lines kept, to show why nothing is being drawn. */
const UNMATCHED_KEPT = 5;

const watches = new Map();
let counter = 0;

/* ------------------------------------------------------------------ *
 * The pattern
 * ------------------------------------------------------------------ */

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** A line as the pattern sees it: no colour codes, no carriage returns, not endless. */
function cleanLine(line) {
    return String(line).replace(ANSI, '').replace(/\r/g, '').slice(0, MAX_LINE);
}

/** A number from what a group captured, or null. `1,284` and `1_284` read as 1284. */
function toNumber(raw) {
    if (raw === undefined || raw === null) return null;
    const value = Number.parseFloat(String(raw).replace(/[,_\s]/g, ''));
    return Number.isFinite(value) ? value : null;
}

/** Flags a pattern may carry. `g` and `y` keep state between lines, so they are left out. */
const FLAGS = new Set(['i', 'm', 's', 'u']);

/**
 * The agent's pattern, made ready: the regex, which of its groups are the
 * numbers, and what each series is called.
 *
 * Named groups name their series. Otherwise every numbered group is a series,
 * named from `series` when given. A pattern with no group at all is read as
 * one number, the whole match.
 */
function compile({ pattern, flags = '', series = [], gap = '', scale = 1, rate = false, title = '' } = {}) {
    const source = String(pattern ?? '');
    if (!source) return { error: 'A pattern is needed: a regular expression whose capture groups are the numbers.' };
    const flagText = [...new Set(String(flags || '').split(''))].filter(flag => FLAGS.has(flag)).join('');

    let regex;
    let probe;
    try {
        regex = new RegExp(source, flagText);
        // An empty alternative that always matches, so the shape of the
        // groups can be read without any output to read it from.
        probe = new RegExp(`(?:${source})|`, flagText).exec('');
    } catch (error) {
        return { error: `That pattern is not a valid regular expression: ${error.message}` };
    }

    const groupCount = probe.length - 1;
    const named = probe.groups ? Object.keys(probe.groups) : [];
    const given = Array.isArray(series) ? series.map(name => String(name ?? '').trim().slice(0, 60)) : [];

    let pick;
    let names;
    if (named.length > 0) {
        pick = match => named.map(name => match.groups?.[name]);
        names = named.map((name, index) => given[index] || name);
    } else if (groupCount === 0) {
        pick = match => [match[0]];
        names = [given[0] || title || 'Value'];
    } else {
        pick = match => Array.from({ length: groupCount }, (_, index) => match[index + 1]);
        names = Array.from({ length: groupCount }, (_, index) => (
            given[index] || (groupCount === 1 ? (title || 'Value') : `Value ${index + 1}`)
        ));
    }
    if (names.length > MAX_SERIES) {
        return { error: `The pattern has ${names.length} groups; a chart takes at most ${MAX_SERIES} series. Make the others non-capturing: (?:...).` };
    }

    let gapRegex = null;
    if (gap) {
        try {
            gapRegex = new RegExp(String(gap), flagText.includes('i') ? 'i' : '');
        } catch (error) {
            return { error: `The gap pattern is not a valid regular expression: ${error.message}` };
        }
    }

    const factor = Number(scale);
    return {
        regex,
        pick,
        names,
        gap: gapRegex,
        scale: Number.isFinite(factor) && factor !== 0 ? factor : 1,
        rate: Boolean(rate),
    };
}

/**
 * The numbers in one piece of output, or what it was instead.
 *
 * `{ values }` for a match, `{ gap: true }` for a line the gap pattern
 * matched (ping's "Request timed out"), and null for anything else.
 */
function extract(compiled, text) {
    const match = compiled.regex.exec(text);
    if (match) {
        const values = compiled.pick(match).map((raw) => {
            const value = toNumber(raw);
            return value === null ? null : value * compiled.scale;
        });
        return { values };
    }
    if (compiled.gap && compiled.gap.test(text)) return { gap: true };
    return null;
}

/* ------------------------------------------------------------------ *
 * A watch's figures
 * ------------------------------------------------------------------ */

function emptyStats(count) {
    return Array.from({ length: count }, () => ({ count: 0, sum: 0, min: null, max: null, last: null }));
}

/** The p95 of what is kept, per series. Worked out on demand: it needs a sort. */
function percentile(samples, index, share) {
    const values = samples.map(sample => sample.v[index]).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length === 0) return null;
    return values[Math.min(values.length - 1, Math.floor(share * values.length))];
}

/** One series' figures, rounded for a reader. */
function seriesStats(watch, index) {
    const own = watch.stats[index];
    const round = value => (value === null ? null : Math.round(value * 1000) / 1000);
    return {
        name: watch.names[index],
        last: round(own.last),
        min: round(own.min),
        avg: own.count ? round(own.sum / own.count) : null,
        max: round(own.max),
        p95: round(percentile(watch.samples, index, 0.95)),
        count: own.count,
    };
}

/** What a watch is now, for the window and for the agent. */
function view(watch, { points = 0 } = {}) {
    const now = Date.now();
    return {
        watchId: watch.id,
        title: watch.title,
        status: watch.status,
        reason: watch.reason || undefined,
        where: watch.where,
        command: watch.command,
        mode: watch.mode,
        every: watch.mode === 'poll' ? watch.every : undefined,
        unit: watch.unit || undefined,
        series: watch.names,
        startedAt: watch.startedAt,
        endedAt: watch.endedAt || undefined,
        endsAt: watch.status === 'running' ? watch.endsAt : undefined,
        runningFor: Math.round(((watch.endedAt || now) - watch.startedAt) / 1000),
        samples: watch.sampleCount,
        matched: watch.matched,
        gaps: watch.gaps,
        linesRead: watch.lines,
        stats: watch.names.map((_, index) => seriesStats(watch, index)),
        ...(watch.matched === 0 && watch.unmatched.length
            ? { unmatched: watch.unmatched.slice() }
            : {}),
        ...(watch.lastError ? { lastError: watch.lastError } : {}),
        ...(watch.exitCode !== undefined ? { exitCode: watch.exitCode } : {}),
        ...(points > 0 ? { recent: watch.samples.slice(-points).map(sample => ({ t: sample.t, v: sample.v })) } : {}),
    };
}

/** The figures the chart's footer shows, sent with every batch. */
function liveStats(watch) {
    return {
        samples: watch.sampleCount,
        matched: watch.matched,
        gaps: watch.gaps,
        series: watch.stats.map(own => ({
            last: own.last,
            min: own.min,
            max: own.max,
            avg: own.count ? own.sum / own.count : null,
        })),
    };
}

/* ------------------------------------------------------------------ *
 * Taking samples
 * ------------------------------------------------------------------ */

function remember(watch, sample) {
    // Numbered, so a window that read the points so far and then hears a
    // batch that overlaps them can tell which it already has.
    sample.n = watch.sampleCount + 1;
    watch.samples.push(sample);
    if (watch.samples.length > KEEP) watch.samples.splice(0, watch.samples.length - KEEP);
    watch.pending.push(sample);
    watch.sampleCount += 1;
    if (sample.v.every(value => value === null)) watch.gaps += 1;
    sample.v.forEach((value, index) => {
        if (!Number.isFinite(value)) return;
        const own = watch.stats[index];
        own.count += 1;
        own.sum += value;
        own.last = value;
        own.min = own.min === null ? value : Math.min(own.min, value);
        own.max = own.max === null ? value : Math.max(own.max, value);
    });
    for (const waiter of watch.waiters.splice(0)) waiter();
}

/**
 * One reading in. A rate turns two readings of a counter into the change
 * per second between them; the first reading only sets the baseline, and a
 * counter that went backwards (a restart) is a gap rather than a negative
 * rate nobody saw.
 */
function take(watch, found, at = Date.now()) {
    if (found.gap) {
        remember(watch, { t: at, v: watch.names.map(() => null) });
        return;
    }
    // The pattern caught something: from here on, the lines it skips are
    // the ordinary noise around the numbers, not a sign that it is wrong.
    watch.matched += 1;
    let values = found.values;
    if (watch.compiled.rate) {
        const before = watch.previous;
        watch.previous = { t: at, v: values };
        if (!before) return;
        const seconds = (at - before.t) / 1000;
        values = values.map((value, index) => {
            const prior = before.v[index];
            if (!Number.isFinite(value) || !Number.isFinite(prior) || seconds <= 0 || value < prior) return null;
            return (value - prior) / seconds;
        });
    }
    remember(watch, { t: at, v: values });
}

/** A line read from a stream. */
function line(watch, raw) {
    if (watch.status !== 'running') return;
    const text = cleanLine(raw);
    if (!text.trim()) return;
    watch.lines += 1;
    const found = extract(watch.compiled, text);
    if (found) {
        take(watch, found);
        return;
    }
    watch.unmatched.push(text.slice(0, 300));
    if (watch.unmatched.length > UNMATCHED_KEPT) watch.unmatched.shift();
}

/** A chunk of a stream, cut into lines; what follows the last break waits for the rest. */
function chunk(watch, data) {
    // What was already in the pipe when it was stopped still arrives. The
    // chart has ended; it is not added to.
    if (watch.status !== 'running') return;
    watch.partial += data.toString('utf8');
    const parts = watch.partial.split(/\r\n|\n|\r/);
    watch.partial = parts.pop() || '';
    if (watch.partial.length > MAX_LINE * 4) watch.partial = watch.partial.slice(-MAX_LINE);
    for (const part of parts) line(watch, part);
}

/** One poll's whole output: stdout first, then stderr, which is where some tools print. */
function pollOutput(watch, stdout, stderr) {
    const out = cleanLine(String(stdout || '').slice(-MAX_LINE * 4));
    const err = cleanLine(String(stderr || '').slice(-MAX_LINE * 4));
    watch.lines += 1;
    const found = extract(watch.compiled, String(stdout || '').replace(ANSI, '').replace(/\r/g, ''))
        || (stderr ? extract(watch.compiled, String(stderr).replace(ANSI, '').replace(/\r/g, '')) : null);
    if (found) {
        take(watch, found);
        return;
    }
    const shown = (out || err).trim().split('\n').slice(-3).join(' ⏎ ');
    if (shown) {
        watch.unmatched.push(shown.slice(0, 300));
        if (watch.unmatched.length > UNMATCHED_KEPT) watch.unmatched.shift();
    }
    // A poll that printed nothing usable is a missed sample: the chart shows
    // the hole, where a skipped tick would just look like a slower clock.
    remember(watch, { t: Date.now(), v: watch.names.map(() => null) });
}

/* ------------------------------------------------------------------ *
 * Running the command
 * ------------------------------------------------------------------ */

/**
 * Stop a local process and everything it started. On Windows that takes
 * taskkill, run without waiting for it: it takes a few hundred milliseconds,
 * and this is the main process, where waiting is a frozen window.
 */
function killTree(child) {
    if (!child || child.exitCode !== null) return;
    try {
        if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => {
                try { child.kill(); } catch { /* gone */ }
            });
        } else {
            try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        }
    } catch {
        // Already gone.
    }
}

let stdbufFound = null;
/** Whether `stdbuf` is here to make a piped program write a line at a time. */
function hasStdbuf() {
    if (stdbufFound !== null) return stdbufFound;
    if (process.platform === 'win32') return (stdbufFound = false);
    try {
        stdbufFound = spawnSync('stdbuf', ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0;
    } catch {
        stdbufFound = false;
    }
    return stdbufFound;
}

/** A stream on a server: its own exec channel, with a pseudo-terminal. */
function streamRemote(watch, sessionId) {
    const session = ssh.sessions.get(sessionId);
    if (!session?.client) {
        end(watch, 'failed', 'That session is not an SSH connection, so nothing can run on a channel of its own.');
        return;
    }
    session.client.exec(watch.command, { pty: { term: 'dumb', cols: 400, rows: 50 } }, (error, channel) => {
        if (error) {
            end(watch, 'failed', error.message);
            return;
        }
        if (watch.status !== 'running') {
            try { channel.close(); } catch { /* gone */ }
            return;
        }
        watch.halt = () => {
            // Interrupt first, as a person would with Ctrl+C; closing the
            // channel then hangs up whatever is left on the terminal.
            try { channel.signal('INT'); } catch { /* not every server takes signals */ }
            try { channel.close(); } catch { /* gone */ }
        };
        channel.on('data', data => chunk(watch, data));
        channel.stderr?.on('data', data => chunk(watch, data));
        channel.on('exit', (code) => {
            if (typeof code === 'number') watch.exitCode = code;
        });
        channel.on('close', () => {
            if (watch.partial) line(watch, watch.partial);
            watch.partial = '';
            finished(watch);
        });
        channel.on('error', channelError => end(watch, 'failed', channelError.message));
    });
}

/** A stream on this computer: in the agent's container, or in a granted folder. */
async function streamLocal(watch, ctx, cwd) {
    let command;
    let args;
    let options;
    if (ctx?.sandbox?.execution === 'container') {
        const ready = await container.ensure(ctx.agentId, ctx.sandbox);
        if (!ready.ok) {
            end(watch, 'failed', `The agent's container is not available: ${ready.message}`);
            return;
        }
        ({ command, args } = container.execSpec(ctx.agentId, { command: 'sh', args: ['-c', watch.command] }));
        options = { windowsHide: true };
    } else {
        const folders = ctx?.sandbox?.folders || [];
        const grant = folders.length
            ? sandboxModule.grantFor(ctx.sandbox, cwd || folders[0].path)
            : sandboxModule.grantFor(ctx?.sandbox, cwd || '.');
        if (grant.error) {
            end(watch, 'failed', grant.error);
            return;
        }
        if (process.platform === 'win32') {
            // Quoted whole and passed as it is, the way Node's own `shell`
            // option does it: cmd strips the outer pair under /s and reads the
            // rest untouched. Left to Node's quoting, a command starting with a
            // quoted path reached cmd as \"C:\...\" and was not recognised.
            command = process.env.ComSpec || 'cmd.exe';
            args = ['/d', '/s', '/c', `"${watch.command}"`];
            options = { cwd: grant.path, windowsHide: true, windowsVerbatimArguments: true };
        } else {
            // A program writing into a pipe holds its output back in blocks;
            // stdbuf asks it to write a line at a time, where it is there.
            [command, args] = hasStdbuf()
                ? ['stdbuf', ['-oL', '-eL', '/bin/sh', '-c', watch.command]]
                : ['/bin/sh', ['-c', watch.command]];
            options = { cwd: grant.path, detached: true };
        }
    }
    if (watch.status !== 'running') return;

    let child;
    try {
        child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        end(watch, 'failed', error.message);
        return;
    }
    watch.halt = () => killTree(child);
    child.stdout.on('data', data => chunk(watch, data));
    child.stderr.on('data', data => chunk(watch, data));
    child.on('error', error => end(watch, 'failed', error.message));
    child.on('close', (code) => {
        if (typeof code === 'number') watch.exitCode = code;
        if (watch.partial) line(watch, watch.partial);
        watch.partial = '';
        finished(watch);
    });
}

/** A poll: run, read, wait out the rest of the interval, again. */
function poll(watch, run) {
    let failures = 0;
    let timer = null;
    const tick = async () => {
        if (watch.status !== 'running') return;
        const started = Date.now();
        const timeout = Math.max(5000, Math.min(watch.every * 1000, 60000));
        let result;
        try {
            result = await run(timeout);
        } catch (error) {
            result = { success: false, message: error.message };
        }
        if (watch.status !== 'running') return;
        if (result.success) {
            failures = 0;
            watch.lastError = '';
            if (typeof result.exitCode === 'number') watch.exitCode = result.exitCode;
            pollOutput(watch, result.stdout, result.stderr);
        } else {
            failures += 1;
            watch.lastError = String(result.message || 'The command failed').slice(0, 300);
            remember(watch, { t: Date.now(), v: watch.names.map(() => null) });
            if (failures >= MAX_POLL_FAILURES) {
                end(watch, 'failed', `${MAX_POLL_FAILURES} runs in a row failed. The last said: ${watch.lastError}`);
                return;
            }
        }
        const wait = Math.max(200, watch.every * 1000 - (Date.now() - started));
        timer = setTimeout(tick, wait);
    };
    watch.halt = () => clearTimeout(timer);
    tick();
}

/* ------------------------------------------------------------------ *
 * A watch's life
 * ------------------------------------------------------------------ */

function flush(watch) {
    if (watch.pending.length === 0 && !watch.dirty) return;
    const points = watch.pending.splice(0);
    watch.dirty = false;
    watch.hooks.onSamples?.(watch, {
        points,
        stats: liveStats(watch),
        unmatched: watch.matched === 0 ? watch.unmatched.slice(-1)[0] || '' : '',
        lastError: watch.lastError || '',
    });
}

/** The command ended by itself: a `ping -c 30` that is done, or one that failed. */
function finished(watch) {
    if (watch.status !== 'running') return;
    if (watch.sampleCount === 0) {
        const said = watch.unmatched.slice(-2).join(' ⏎ ');
        end(watch, 'failed', said
            ? `The command ended without printing a line the pattern matched. It last printed: ${said}`
            : 'The command ended without printing anything.');
        return;
    }
    end(watch, 'done', watch.exitCode ? `The command exited with ${watch.exitCode}.` : 'The command finished.');
}

/** Stop a watch, once, and tell everyone who is waiting on it. */
function end(watch, status, reason = '') {
    if (watch.status !== 'running') return;
    watch.status = status;
    watch.reason = String(reason || '').slice(0, 500);
    watch.endedAt = Date.now();
    clearTimeout(watch.deadline);
    clearInterval(watch.pusher);
    try { watch.halt?.(); } catch { /* gone */ }
    watch.dirty = true;
    flush(watch);
    for (const waiter of watch.waiters.splice(0)) waiter();
    watch.hooks.onEnd?.(watch, {
        status: watch.status,
        reason: watch.reason,
        points: watch.samples.slice(-watch.window),
        stats: liveStats(watch),
        summary: view(watch),
    });
    // Kept a while so a late read_metric still has the figures; the
    // conversation's log has the chart from here on.
    setTimeout(() => {
        if (watches.get(watch.id) === watch) watches.delete(watch.id);
    }, 10 * 60 * 1000).unref?.();
}

/**
 * Start watching.
 *
 * `target` is `{ sessionId }` for a server or `{ local: true, ctx, cwd }` for
 * this computer. `hooks` are how the samples leave: `onStart(watch)`,
 * `onSamples(watch, batch)` and `onEnd(watch, final)`.
 *
 * Resolves once the first sample is in, the command has ended, or a few
 * seconds have passed, with the watch as it stands: the agent learns from
 * the answer to its own call whether the pattern caught anything.
 */
async function start(spec, target, hooks = {}) {
    const running = [...watches.values()].filter(watch => watch.status === 'running');
    if (running.length >= MAX_WATCHES) {
        return {
            error: `${MAX_WATCHES} watches are already running. Stop one with stop_metric first: `
                + running.map(watch => `${watch.id} (${watch.title})`).join(', '),
        };
    }

    const command = String(spec.command || '').trim();
    if (!command) return { error: 'A command is needed.' };
    const compiled = compile(spec);
    if (compiled.error) return { error: compiled.error };

    const every = spec.every === undefined || spec.every === null || spec.every === 0
        ? 0
        : Math.max(MIN_EVERY, Math.min(MAX_EVERY, Number(spec.every) || 0));
    const duration = Math.max(10000, Math.min(MAX_DURATION, Number(spec.durationMs) || DEFAULT_DURATION));
    const now = Date.now();

    counter += 1;
    const watch = {
        id: `watch-${now.toString(36)}-${counter}`,
        conversationId: spec.conversationId || '',
        title: String(spec.title || command).slice(0, 120),
        unit: String(spec.unit || '').slice(0, 12),
        command,
        where: target.local ? 'this computer' : (target.where || target.sessionId || ''),
        mode: every ? 'poll' : 'stream',
        every,
        window: Math.max(10, Math.min(MAX_WINDOW, Number(spec.window) || DEFAULT_WINDOW)),
        names: compiled.names,
        compiled,
        // How the chart is drawn, which the window needs and the watch does not.
        chart: {
            limits: Array.isArray(spec.limits)
                ? spec.limits.filter(entry => Number.isFinite(Number(entry?.value))).slice(0, 4)
                    .map(entry => ({ value: Number(entry.value), label: String(entry.label || '').slice(0, 40) }))
                : [],
            ...(Number.isFinite(Number(spec.min)) && spec.min !== null && spec.min !== undefined ? { min: Number(spec.min) } : {}),
            ...(Number.isFinite(Number(spec.max)) && spec.max !== null && spec.max !== undefined ? { max: Number(spec.max) } : {}),
        },
        status: 'running',
        reason: '',
        startedAt: now,
        endsAt: now + duration,
        endedAt: 0,
        samples: [],
        pending: [],
        stats: emptyStats(compiled.names.length),
        sampleCount: 0,
        matched: 0,
        gaps: 0,
        lines: 0,
        unmatched: [],
        partial: '',
        previous: null,
        lastError: '',
        exitCode: undefined,
        waiters: [],
        dirty: false,
        hooks,
        halt: null,
    };
    watches.set(watch.id, watch);

    hooks.onStart?.(watch);
    watch.deadline = setTimeout(() => end(watch, 'done', 'Reached the end of its time.'), duration);
    watch.pusher = setInterval(() => flush(watch), PUSH_MS);

    if (watch.mode === 'poll') {
        poll(watch, target.local
            ? timeout => local.run(target.ctx, command, { cwd: target.cwd || '', timeout })
            : timeout => exec.run(target.sessionId, command, { timeout }));
    } else if (target.local) {
        streamLocal(watch, target.ctx, target.cwd || '').catch(error => end(watch, 'failed', error.message));
    } else {
        streamRemote(watch, target.sessionId);
    }

    // The first answer: wait for a sample (two for a rate, which needs a
    // baseline first), the end, or the probe's time, whichever is sooner.
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, spec.probeMs ?? PROBE_MS);
        const check = () => {
            if (watch.sampleCount > 0 || watch.status !== 'running') {
                clearTimeout(timer);
                resolve();
                return;
            }
            watch.waiters.push(check);
        };
        check();
    });
    return { watch, view: view(watch, { points: 5 }) };
}

/** Stop one watch. Answers whether there was one running to stop. */
function stop(watchId, reason = 'Stopped.') {
    const watch = watches.get(watchId);
    if (!watch || watch.status !== 'running') return false;
    end(watch, 'stopped', reason);
    return true;
}

/** Stop every watch, or every one a conversation started. */
function stopAll({ conversationId = '', reason = 'Stopped.' } = {}) {
    let count = 0;
    for (const watch of [...watches.values()]) {
        if (conversationId && watch.conversationId !== conversationId) continue;
        if (stop(watch.id, reason)) count += 1;
    }
    return count;
}

/** A watch as the agent reads it, with its last `points` samples. */
function read(watchId, { points = 20 } = {}) {
    const watch = watches.get(watchId);
    return watch ? view(watch, { points: Math.max(0, Math.min(200, points)) }) : null;
}

/** The watches one conversation has, newest first. */
function list(conversationId = '') {
    return [...watches.values()]
        .filter(watch => !conversationId || watch.conversationId === conversationId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(watch => view(watch));
}

/** What a window needs to pick up a chart it was not watching: the window of points so far. */
function snapshot(watchId) {
    const watch = watches.get(watchId);
    if (!watch) return { found: false };
    return {
        found: true,
        status: watch.status,
        reason: watch.reason,
        window: watch.window,
        points: watch.samples.slice(-watch.window),
        stats: liveStats(watch),
        unmatched: watch.matched === 0 ? watch.unmatched.slice(-1)[0] || '' : '',
        lastError: watch.lastError || '',
        endsAt: watch.endsAt,
    };
}

/** The conversation a watch belongs to, or '' for none. */
function ownerOf(watchId) {
    return watches.get(watchId)?.conversationId || '';
}

/** Whether a session can run a command on a channel of its own: an SSH one can. */
function canExec(sessionId) {
    return Boolean(ssh.sessions.get(sessionId)?.client);
}

module.exports = {
    start,
    stop,
    stopAll,
    read,
    list,
    snapshot,
    ownerOf,
    canExec,
    compile,
    extract,
    cleanLine,
    MAX_WATCHES,
    MAX_WINDOW,
    DEFAULT_WINDOW,
    MAX_DURATION,
    DEFAULT_DURATION,
};
