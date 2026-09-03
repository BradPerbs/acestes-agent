const http = require('http');
const fs = require('fs');
const jobs = require('./jobs');
const runs = require('./index');

/**
 * The scheduler: the loop that turns a job's time into a run.
 *
 * Lives in the main process and never in the model, as both reference
 * harnesses do it. One tick every few seconds reads the jobs whose time has
 * come and fires each through `runJob`, which the assistant core supplies:
 * it opens a conversation for the job, applies the job's policy and sends
 * the prompt. The scheduler never touches a provider itself.
 *
 * What it owns beyond the tick: the overlap rule (a job whose last run is
 * still going is skipped, not stacked), the heartbeat probe (a command run
 * first, so a quiet check costs no tokens), the event and webhook doors,
 * and delivery of a finished run's result to a notification, a webhook or
 * a file. The backoff and the ten-strikes rule are the jobs module's.
 */

const TICK_MS = 5000;
const MAX_WEBHOOK_BODY = 64 * 1024;
const MAX_CONTEXT = 20000;

let timer = null;
let server = null;
let serverPort = 0;
let started = false;
let deps = {
    runJob: async () => ({ error: 'No runner' }),
    notifyUser: () => {},
    probe: async () => ({ success: false, message: 'No probe runner' }),
    summaryOf: () => '',
};

/* ------------------------------------------------------------------ *
 * Firing
 * ------------------------------------------------------------------ */

/** Whether the job's last run is still going. */
function busy(job) {
    return runs.list({ status: runs.OPEN_STATUSES, limit: 500 }).some(run => run.jobId === job.id);
}

/**
 * Fire one job.
 *
 * The job is marked fired before the run starts, so a crash in between
 * cannot fire it again on the next launch. `context` is what the door that
 * opened it has to say: the event, the webhook body, the probe's output.
 */
async function fire(job, { context = '', source = 'schedule' } = {}) {
    if (busy(job)) {
        // Skipped, and moved on: the next tick must not find it due again.
        jobs.fired(job.id);
        jobs.completed(job.id, 'skipped');
        return { skipped: true };
    }
    jobs.fired(job.id);
    try {
        const result = await deps.runJob(job, { context: String(context || '').slice(0, MAX_CONTEXT), source });
        if (result?.error) {
            jobs.completed(job.id, 'failed');
            deps.notifyUser({ title: `${job.name} could not start`, body: result.error, jobId: job.id });
            return result;
        }
        return result;
    } catch (error) {
        jobs.completed(job.id, 'failed');
        deps.notifyUser({ title: `${job.name} could not start`, body: error.message, jobId: job.id });
        return { error: error.message };
    }
}

/**
 * A heartbeat runs its probe first and wakes the agent only if the probe
 * had something to say: a non-zero exit, or output that is not empty and
 * not the word SKIP. That is what keeps a fifteen-minute check from
 * costing tokens four times an hour.
 */
async function heartbeat(job) {
    jobs.fired(job.id);
    const probe = job.schedule.probe || {};
    let result;
    try {
        result = await deps.probe(job, probe);
    } catch (error) {
        result = { success: false, message: error.message };
    }
    const output = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
    const quiet = result.success && (result.exitCode === 0 || result.exitCode === undefined) && (!output || output === 'SKIP');
    if (quiet) {
        jobs.completed(job.id, 'done');
        return { skipped: true, quiet: true };
    }
    if (busy(job)) {
        jobs.completed(job.id, 'skipped');
        return { skipped: true };
    }
    const context = result.success
        ? `The probe \`${probe.command}\` exited with ${result.exitCode ?? '?'} and printed:\n\n${output.slice(0, MAX_CONTEXT)}`
        : `The probe \`${probe.command}\` could not run: ${result.message || 'unknown error'}`;
    try {
        const started = await deps.runJob(job, { context, source: 'heartbeat' });
        if (started?.error) jobs.completed(job.id, 'failed');
        return started;
    } catch (error) {
        jobs.completed(job.id, 'failed');
        return { error: error.message };
    }
}

async function tick() {
    let due;
    try {
        due = jobs.due();
    } catch (error) {
        console.error('The scheduler could not read its jobs:', error.message);
        return;
    }
    for (const job of due) {
        try {
            if (job.schedule.kind === 'heartbeat') await heartbeat(job);
            else await fire(job);
        } catch (error) {
            console.error(`Job ${job.name} failed to fire:`, error.message);
        }
    }
    syncWebhookServer();
}

/* ------------------------------------------------------------------ *
 * Doors: events and webhooks
 * ------------------------------------------------------------------ */

/** Something happened in the app that a job may be waiting for. */
function event(name, { hostId = '', detail = '' } = {}) {
    if (!started) return;
    for (const job of jobs.listeners(name, hostId)) {
        fire(job, { context: detail, source: `event:${name}` }).catch(() => {});
    }
}

function webhookUrl(job) {
    if (!server || !serverPort || job.schedule.kind !== 'webhook') return '';
    return `http://127.0.0.1:${serverPort}/jobs/${job.id}`;
}

function readBody(request) {
    return new Promise((resolve) => {
        let body = '';
        let over = false;
        request.on('data', (chunk) => {
            if (over) return;
            body += chunk.toString('utf8');
            if (body.length > MAX_WEBHOOK_BODY) {
                over = true;
                body = body.slice(0, MAX_WEBHOOK_BODY);
            }
        });
        request.on('end', () => resolve(body));
        request.on('error', () => resolve(body));
    });
}

function handleRequest(request, response) {
    const found = /^\/jobs\/([A-Za-z0-9_-]+)$/.exec(request.url || '');
    if (!found || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
    }
    const auth = String(request.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : String(request.headers['x-token'] || '');
    const job = jobs.byToken(found[1], token);
    if (!job) {
        response.writeHead(401).end();
        return;
    }
    readBody(request).then((body) => {
        fire(job, { context: body, source: 'webhook' }).then((result) => {
            response.setHeader('Content-Type', 'application/json');
            response.writeHead(result?.error ? 500 : 202);
            response.end(JSON.stringify(result?.error ? { error: result.error } : { accepted: true, runId: result?.runId || '' }));
        });
    });
}

/** Up while any enabled webhook job exists, and only then. */
function syncWebhookServer() {
    let wanted = false;
    try {
        wanted = jobs.list({ enabled: true }).some(job => job.schedule.kind === 'webhook');
    } catch {
        wanted = false;
    }
    if (wanted && !server) {
        server = http.createServer(handleRequest);
        server.on('error', (error) => console.error('Webhook server:', error.message));
        server.listen(0, '127.0.0.1', () => {
            serverPort = server.address().port;
            // The URL just came into existence; the Jobs page shows it.
            deps.jobsNotifier?.('jobs-changed', { webhook: true });
        });
    } else if (!wanted && server) {
        try { server.close(); } catch { /* already closed */ }
        server = null;
        serverPort = 0;
    }
}

/* ------------------------------------------------------------------ *
 * Delivery
 * ------------------------------------------------------------------ */

function deliver(job, run) {
    const status = run.status;
    const summary = run.result?.summary || run.result?.reason || '';
    const delivery = job.delivery || {};

    if (delivery.notify !== false) {
        const title = status === 'done' ? `${job.name} finished` : `${job.name} ${status}`;
        deps.notifyUser({ title, body: summary.slice(0, 300) || 'See the Runs page.', jobId: job.id, runId: run.id });
    }

    if (delivery.webhook) {
        const payload = JSON.stringify({
            job: { id: job.id, name: job.name, agentId: job.agentId },
            run: { id: run.id, status, startedAt: run.startedAt, endedAt: run.endedAt, costUsd: run.costUsd, toolCalls: run.toolCalls },
            summary,
        });
        fetch(delivery.webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
            signal: AbortSignal.timeout(15000),
        }).catch((error) => {
            console.error(`Delivery to ${delivery.webhook} failed:`, error.message);
            runs.beginStep(run.id, { kind: 'delivery', name: 'webhook', input: delivery.webhook });
            const step = runs.openStep(run.id, 'delivery', 'webhook');
            if (step) runs.endStep(run.id, step.seq, { status: 'failed', output: error.message });
        });
    }

    if (delivery.file) {
        const line = [
            `## ${job.name} · ${new Date(run.endedAt || Date.now()).toISOString()} · ${status}`,
            '',
            summary || '(no summary)',
            '',
        ].join('\n');
        try {
            fs.appendFileSync(delivery.file, `${line}\n`, 'utf8');
        } catch (error) {
            console.error(`Delivery to ${delivery.file} failed:`, error.message);
        }
    }
}

/** A run that belongs to a job has ended; the job hears about it. */
function runEnded(run) {
    if (!run?.jobId) return;
    const job = jobs.get(run.jobId);
    if (!job) return;
    const outcome = jobs.completed(job.id, run.status === 'cancelled' ? 'cancelled' : run.status);
    deliver(job, run);
    if (outcome.disabled && job.schedule.kind !== 'at') {
        deps.notifyUser({
            title: `${job.name} was switched off`,
            body: `It failed ${jobs.MAX_FAILURES} times in a row. Fix it and switch it back on from the Jobs page.`,
            jobId: job.id,
        });
    }
    syncWebhookServer();
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * Start the loop.
 *
 *   runJob      (job, { context, source }) => { runId } | { error }
 *   probe       (job, probe) => { success, exitCode, stdout, stderr }
 *   notifyUser  ({ title, body, jobId, runId }) => void
 *   resumeRun   (run) => void, for runs re-queued on launch
 */
function start(options = {}) {
    deps = { ...deps, ...options };
    if (started) return;
    started = true;

    runs.onEnded(runEnded);

    // Runs a job left open when the app last closed: re-queued by the run
    // log's recovery, and handed back to the runner here, one by one.
    if (typeof deps.resumeRun === 'function') {
        for (const run of runs.list({ status: 'queued', limit: 100 })) {
            if (!run.jobId) continue;
            Promise.resolve(deps.resumeRun(run)).catch((error) => {
                console.error(`Could not resume run ${run.id}:`, error.message);
            });
        }
    }

    const caught = jobs.reconcile();
    if (caught.length) console.log(`Scheduler: ${caught.length} job(s) will catch up on a missed run.`);

    syncWebhookServer();
    timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    tick().catch(() => {});
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    if (server) {
        try { server.close(); } catch { /* already closed */ }
        server = null;
        serverPort = 0;
    }
}

/** Whether the app has a reason to stay up with no window: an enabled job. */
function keepAlive() {
    try {
        return jobs.list({ enabled: true }).length > 0;
    } catch {
        return false;
    }
}

/** Fire a job now, from the page or the agent. */
function runNow(jobId) {
    const job = jobs.get(jobId);
    if (!job) return Promise.resolve({ error: 'No such job.' });
    return job.schedule.kind === 'heartbeat' ? heartbeat(job) : fire(job, { source: 'manual' });
}

module.exports = { start, stop, tick, event, runNow, keepAlive, webhookUrl, _test: { fire, heartbeat, deliver, runEnded, busy } };
