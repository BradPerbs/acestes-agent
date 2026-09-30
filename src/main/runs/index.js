const database = require('./db');

/**
 * Runs: the unit of work the app can start, stop, budget, resume and show.
 *
 * A conversation is one way a run gets its turns; a scheduled job is another;
 * an agent delegating to another agent is a third. Whatever started it, a run
 * has a trigger, a policy, a status, a log of steps and a result, and it is
 * written to SQLite as it goes rather than when it ends.
 *
 * The step log is the durability story. A step is written `pending` before
 * its effect and `complete` after, so a crash between the two leaves a row
 * that says so. On the next launch a run that was still going is closed out
 * (interactive) or re-queued (scheduled, see phase two), and a tool step
 * left pending is marked `unknown`: never replayed, because a command on a
 * server is not idempotent, and reported to the agent on resume so it can
 * check before repeating it.
 *
 * Budgets live on the policy: turns, tool calls, cost and wall-clock. The
 * conversation layer asks `overBudget` after each event and interrupts the
 * provider when one is hit; this module only counts.
 */

const KINDS = new Set(['interactive', 'scheduled', 'triggered', 'delegated']);
const STATUSES = new Set(['queued', 'running', 'parked', 'done', 'failed', 'cancelled']);
const STEP_KINDS = new Set(['turn', 'tool', 'wait', 'delivery']);

const OPEN_STATUSES = ['queued', 'running', 'parked'];

/** How much of a step's input and output is written down. */
const MAX_STEP_TEXT = 20000;

/** Defaults for a policy nobody set: interactive work has no ceilings. */
const DEFAULT_POLICY = Object.freeze({
    approvals: 'inherit',
    budget: { maxTurns: 0, maxToolCalls: 0, maxCostUsd: 0, maxMinutes: 0 },
});

let notify = () => {};
let counter = 0;
// Who to tell when a run reaches a terminal state: the scheduler, so a job
// can count the outcome and deliver it. Kept here so the scheduler need not
// be required by the assistant core, nor the core by the scheduler.
const endedHooks = [];

function setNotifier(fn) {
    notify = fn || (() => {});
}

function onEnded(fn) {
    if (typeof fn === 'function') endedHooks.push(fn);
}

function nextId() {
    counter += 1;
    return `run-${Date.now().toString(36)}-${counter.toString(36)}`;
}

const json = (value) => JSON.stringify(value ?? {});
const parse = (text, fallback = {}) => {
    try {
        return text ? JSON.parse(text) : fallback;
    } catch {
        return fallback;
    }
};
const clip = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return text.length > MAX_STEP_TEXT ? `${text.slice(0, MAX_STEP_TEXT)}…` : text;
};

function normalizePolicy(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const budget = source.budget && typeof source.budget === 'object' ? source.budget : {};
    const number = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
    return {
        approvals: typeof source.approvals === 'string' ? source.approvals : DEFAULT_POLICY.approvals,
        budget: {
            maxTurns: number(budget.maxTurns),
            maxToolCalls: number(budget.maxToolCalls),
            maxCostUsd: number(budget.maxCostUsd),
            maxMinutes: number(budget.maxMinutes),
        },
        ...(Array.isArray(source.tools) ? { tools: source.tools.map(String) } : {}),
    };
}

function rowToRun(row) {
    if (!row) return null;
    return {
        id: row.id,
        agentId: row.agent_id,
        kind: row.kind,
        status: row.status,
        trigger: parse(row.trigger),
        policy: parse(row.policy, DEFAULT_POLICY),
        conversationId: row.conversation_id,
        parentId: row.parent_id,
        jobId: row.job_id,
        title: row.title,
        progress: row.progress,
        result: parse(row.result),
        costUsd: row.cost_usd,
        turns: row.turns,
        toolCalls: row.tool_calls,
        createdAt: row.created_at,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        updatedAt: row.updated_at,
    };
}

function rowToStep(row) {
    return {
        seq: row.seq,
        kind: row.kind,
        status: row.status,
        name: row.name,
        input: row.input,
        output: row.output,
        attempts: row.attempts,
        startedAt: row.started_at,
        endedAt: row.ended_at,
    };
}

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

function create({ agentId, kind = 'interactive', trigger = {}, policy, conversationId = '', parentId = '', jobId = '', title = '' } = {}) {
    const db = database.open();
    const now = Date.now();
    const run = {
        id: nextId(),
        agentId: String(agentId || ''),
        kind: KINDS.has(kind) ? kind : 'interactive',
        status: 'queued',
        trigger: trigger && typeof trigger === 'object' ? trigger : {},
        policy: normalizePolicy(policy),
        conversationId: String(conversationId || ''),
        parentId: String(parentId || ''),
        jobId: String(jobId || ''),
        title: String(title || '').slice(0, 200),
    };
    db.prepare(`
        INSERT INTO runs (id, agent_id, kind, status, trigger, policy, conversation_id, parent_id, job_id, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.agentId, run.kind, run.status, json(run.trigger), json(run.policy),
        run.conversationId, run.parentId, run.jobId, run.title, now, now);
    const saved = get(run.id);
    notify('runs-changed', { runId: run.id, agentId: run.agentId, status: 'queued' });
    return saved;
}

function get(runId) {
    const db = database.open();
    return rowToRun(db.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
}

function steps(runId) {
    const db = database.open();
    return db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY seq').all(runId).map(rowToStep);
}

function setStatus(runId, status, patch = {}) {
    if (!STATUSES.has(status)) throw new Error(`Unknown run status "${status}"`);
    const db = database.open();
    const now = Date.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const values = [status, now];
    if (status === 'running') {
        sets.push('started_at = COALESCE(started_at, ?)');
        values.push(now);
    }
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
        sets.push('ended_at = ?');
        values.push(now);
    }
    if (patch.result !== undefined) {
        sets.push('result = ?');
        values.push(json(patch.result));
    }
    if (patch.progress !== undefined) {
        sets.push('progress = ?');
        values.push(String(patch.progress).slice(0, 4000));
    }
    if (patch.title !== undefined) {
        sets.push('title = ?');
        values.push(String(patch.title).slice(0, 200));
    }
    values.push(runId);
    db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    const run = get(runId);
    if (run) notify('runs-changed', { runId, agentId: run.agentId, status });
    if (run && (status === 'done' || status === 'failed' || status === 'cancelled')) {
        for (const hook of endedHooks) {
            try {
                hook(run);
            } catch (error) {
                console.error('A run-ended hook failed:', error.message);
            }
        }
    }
    return run;
}

const start = (runId) => setStatus(runId, 'running');
const park = (runId, progress) => setStatus(runId, 'parked', progress !== undefined ? { progress } : {});
const finish = (runId, result) => setStatus(runId, 'done', { result });
const fail = (runId, reason, result = {}) => setStatus(runId, 'failed', { result: { ...result, reason: String(reason || '') } });
const cancel = (runId, reason = '') => setStatus(runId, 'cancelled', { result: { reason } });

function setProgress(runId, progress) {
    const db = database.open();
    db.prepare('UPDATE runs SET progress = ?, updated_at = ? WHERE id = ?')
        .run(String(progress || '').slice(0, 4000), Date.now(), runId);
    const run = get(runId);
    if (run) notify('runs-changed', { runId, agentId: run.agentId, status: run.status });
    return run;
}

function setTitle(runId, title) {
    const db = database.open();
    db.prepare('UPDATE runs SET title = ?, updated_at = ? WHERE id = ?')
        .run(String(title || '').slice(0, 200), Date.now(), runId);
}

/**
 * Every title passed through `fn`, and the ones it changed written back.
 * For the secrets store: a run is titled with the first line of its
 * conversation, and a key pasted as that line was in this log too.
 */
function scrubTitles(fn) {
    const db = database.open();
    const rows = db.prepare("SELECT id, title FROM runs WHERE title <> ''").all();
    let changed = 0;
    const update = db.prepare('UPDATE runs SET title = ? WHERE id = ?');
    for (const row of rows) {
        const clean = fn(row.title);
        if (clean === row.title) continue;
        update.run(String(clean || '').slice(0, 200), row.id);
        changed += 1;
    }
    if (changed > 0) notify('runs-changed', {});
    return changed;
}

/**
 * Every step's arguments and output passed through `fn`, as the text they
 * are stored as, and the ones it changed written back. For the same store:
 * a value that reached a tool call before it was a secret is in here too.
 */
function scrubSteps(fn) {
    const db = database.open();
    const rows = db.prepare("SELECT run_id, seq, input, output FROM steps WHERE input <> '' OR output <> ''").all();
    let changed = 0;
    const update = db.prepare('UPDATE steps SET input = ?, output = ? WHERE run_id = ? AND seq = ?');
    for (const row of rows) {
        const input = fn(row.input);
        const output = fn(row.output);
        if (input === row.input && output === row.output) continue;
        update.run(input, output, row.run_id, row.seq);
        changed += 1;
    }
    return changed;
}

/** Add to the counters. Cost is accumulated, turns and calls incremented. */
function tally(runId, { costUsd = 0, turns = 0, toolCalls = 0 } = {}) {
    const db = database.open();
    db.prepare(`
        UPDATE runs SET cost_usd = cost_usd + ?, turns = turns + ?, tool_calls = tool_calls + ?, updated_at = ?
        WHERE id = ?
    `).run(Number(costUsd) || 0, Number(turns) || 0, Number(toolCalls) || 0, Date.now(), runId);
}

/**
 * Which ceiling a run has hit, or '' if none.
 *
 * Wall-clock counts from the start of the run; the rest are the counters.
 * A zero ceiling means none, which is what interactive work gets.
 */
function overBudget(runId) {
    const run = get(runId);
    if (!run) return '';
    const { budget } = run.policy;
    if (budget.maxTurns && run.turns >= budget.maxTurns) return `the run reached its limit of ${budget.maxTurns} turns`;
    if (budget.maxToolCalls && run.toolCalls >= budget.maxToolCalls) return `the run reached its limit of ${budget.maxToolCalls} tool calls`;
    if (budget.maxCostUsd && run.costUsd >= budget.maxCostUsd) return `the run reached its cost limit of $${budget.maxCostUsd.toFixed(2)}`;
    if (budget.maxMinutes && run.startedAt && Date.now() - run.startedAt >= budget.maxMinutes * 60000) {
        return `the run reached its time limit of ${budget.maxMinutes} minutes`;
    }
    return '';
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

function nextSeq(db, runId) {
    const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM steps WHERE run_id = ?').get(runId);
    return (row?.seq || 0) + 1;
}

/** Record that a step is about to happen. Returns its sequence number. */
function beginStep(runId, { kind, name = '', input = '' } = {}) {
    if (!STEP_KINDS.has(kind)) throw new Error(`Unknown step kind "${kind}"`);
    const db = database.open();
    const seq = nextSeq(db, runId);
    db.prepare(`
        INSERT INTO steps (run_id, seq, kind, status, name, input, started_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?)
    `).run(runId, seq, kind, String(name || ''), clip(input), Date.now());
    db.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(Date.now(), runId);
    return seq;
}

function endStep(runId, seq, { status = 'complete', output = '' } = {}) {
    const db = database.open();
    db.prepare(`
        UPDATE steps SET status = ?, output = ?, ended_at = ? WHERE run_id = ? AND seq = ?
    `).run(status, clip(output), Date.now(), runId, seq);
}

/** The latest pending step of a kind (and name, if given), or null. */
function openStep(runId, kind, name = '') {
    const db = database.open();
    const row = name
        ? db.prepare("SELECT * FROM steps WHERE run_id = ? AND kind = ? AND name = ? AND status = 'pending' ORDER BY seq DESC LIMIT 1").get(runId, kind, name)
        : db.prepare("SELECT * FROM steps WHERE run_id = ? AND kind = ? AND status = 'pending' ORDER BY seq DESC LIMIT 1").get(runId, kind);
    return row ? rowToStep(row) : null;
}

/* ------------------------------------------------------------------ *
 * Listing and recovery
 * ------------------------------------------------------------------ */

/**
 * `jobId` narrows to one job's runs; `jobs: true` to the runs any job
 * started, which is how the Jobs page reads every job's history at once.
 */
function list({ agentId = '', status = '', conversationId = '', jobId = '', jobs = false, limit = 100, offset = 0 } = {}) {
    const db = database.open();
    const where = [];
    const values = [];
    if (agentId) { where.push('agent_id = ?'); values.push(agentId); }
    if (conversationId) { where.push('conversation_id = ?'); values.push(conversationId); }
    if (jobId) { where.push('job_id = ?'); values.push(jobId); }
    else if (jobs) where.push("job_id != ''");
    if (status) {
        const wanted = Array.isArray(status) ? status : [status];
        where.push(`status IN (${wanted.map(() => '?').join(', ')})`);
        values.push(...wanted);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM runs ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .all(...values, Math.max(1, Math.min(Number(limit) || 100, 500)), Math.max(0, Number(offset) || 0));
    return rows.map(rowToRun);
}

function open() {
    return list({ status: OPEN_STATUSES, limit: 500 });
}

/**
 * Close out what the last process left running.
 *
 * Called once on launch, before anything can start a run. An interactive
 * run cannot continue without the person who was driving it, so it is
 * failed with the reason. Every pending tool step of every open run is
 * marked unknown, whatever becomes of the run, because the effect may or
 * may not have happened and nothing here can know.
 *
 * Returns what was found, so a caller with a resume story (scheduled runs,
 * phase two) can pick the survivors up rather than have them closed here.
 */
function recover({ resumable = () => false } = {}) {
    const db = database.open();
    const now = Date.now();
    const found = open();
    const closed = [];
    const kept = [];

    db.exec('BEGIN');
    try {
        for (const run of found) {
            db.prepare(`
                UPDATE steps SET status = 'unknown', ended_at = ?
                WHERE run_id = ? AND status = 'pending' AND kind = 'tool'
            `).run(now, run.id);
            db.prepare(`
                UPDATE steps SET status = 'interrupted', ended_at = ?
                WHERE run_id = ? AND status = 'pending' AND kind != 'tool'
            `).run(now, run.id);

            if (resumable(run)) {
                db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?').run('queued', now, run.id);
                kept.push(run.id);
                continue;
            }
            db.prepare('UPDATE runs SET status = ?, result = ?, ended_at = ?, updated_at = ? WHERE id = ?')
                .run('failed', json({ reason: 'The app closed while this run was going.' }), now, now, run.id);
            closed.push(run.id);
        }
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }

    if (closed.length || kept.length) notify('runs-changed', { recovered: true });
    return { closed, requeued: kept };
}

/** The tool steps whose outcome was lost, phrased for the agent. */
function unknownSteps(runId) {
    const db = database.open();
    return db.prepare("SELECT * FROM steps WHERE run_id = ? AND status = 'unknown' ORDER BY seq").all(runId).map(rowToStep);
}

/** Totals for the usage view: by agent, over a window. */
function usage({ agentId = '', since = 0 } = {}) {
    const db = database.open();
    const where = ['created_at >= ?'];
    const values = [Number(since) || 0];
    if (agentId) { where.push('agent_id = ?'); values.push(agentId); }
    const row = db.prepare(`
        SELECT COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS costUsd, COALESCE(SUM(turns), 0) AS turns,
               COALESCE(SUM(tool_calls), 0) AS toolCalls,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM runs WHERE ${where.join(' AND ')}
    `).get(...values);
    return {
        runs: row.runs || 0,
        costUsd: row.costUsd || 0,
        turns: row.turns || 0,
        toolCalls: row.toolCalls || 0,
        failed: row.failed || 0,
    };
}

/**
 * A run as a span tree, in the shape the OpenTelemetry GenAI conventions
 * describe: `invoke_agent` at the root, a `chat` span per turn, an
 * `execute_tool` span per call, nested. The conventions are still marked
 * Development, so nothing here is exported anywhere; it is the shape the
 * major coding agents already emit, and the shape a usage page reads.
 */
function trace(runId) {
    const run = get(runId);
    if (!run) return null;
    const all = steps(runId);
    const root = {
        name: 'invoke_agent',
        attributes: {
            'gen_ai.operation.name': 'invoke_agent',
            'gen_ai.agent.id': run.agentId,
            'acestes.run.id': run.id,
            'acestes.run.kind': run.kind,
            'acestes.run.status': run.status,
            'gen_ai.usage.cost_usd': run.costUsd,
            'acestes.run.tool_calls': run.toolCalls,
        },
        startTime: run.startedAt || run.createdAt,
        endTime: run.endedAt || null,
        children: [],
    };
    let turn = null;
    for (const step of all) {
        if (step.kind === 'turn') {
            turn = {
                name: 'chat',
                attributes: { 'gen_ai.operation.name': 'chat', 'acestes.step.status': step.status },
                startTime: step.startedAt,
                endTime: step.endedAt,
                children: [],
            };
            root.children.push(turn);
            continue;
        }
        const span = {
            name: step.kind === 'tool' ? 'execute_tool' : step.kind,
            attributes: {
                'gen_ai.operation.name': step.kind === 'tool' ? 'execute_tool' : step.kind,
                'gen_ai.tool.name': step.name,
                'acestes.step.status': step.status,
                'gen_ai.tool.call.arguments': step.input,
                'gen_ai.tool.call.result': step.output.slice(0, 2000),
            },
            startTime: step.startedAt,
            endTime: step.endedAt,
            children: [],
        };
        (turn || root).children.push(span);
    }
    return root;
}

function remove(runId) {
    const db = database.open();
    db.prepare('DELETE FROM steps WHERE run_id = ?').run(runId);
    const result = db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
    if (result.changes) notify('runs-changed', { runId, removed: true });
    return Boolean(result.changes);
}

module.exports = {
    setNotifier,
    onEnded,
    create,
    get,
    steps,
    start,
    park,
    finish,
    fail,
    cancel,
    setStatus,
    setProgress,
    setTitle,
    scrubTitles,
    scrubSteps,
    tally,
    overBudget,
    beginStep,
    endStep,
    openStep,
    list,
    open,
    recover,
    unknownSteps,
    usage,
    trace,
    remove,
    normalizePolicy,
    KINDS,
    STATUSES,
    OPEN_STATUSES,
    DEFAULT_POLICY,
};
