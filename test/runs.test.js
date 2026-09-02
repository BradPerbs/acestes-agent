/**
 * The run log: what a run records, how budgets bite, and what a restart
 * does to whatever was left open.
 *
 * `electron` is stubbed so it runs under plain node; the database goes in a
 * temporary directory and is deleted at the end.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-runs-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: { handle: () => {}, on: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const runs = require(path.join(ROOT, 'runs'));
const db = require(path.join(ROOT, 'runs', 'db'));

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

console.log('\nruns');

const changes = [];
runs.setNotifier((channel, payload) => changes.push({ channel, payload }));

check('a run is created queued, started running, and its steps are logged in order', () => {
    const run = runs.create({ agentId: 'a', kind: 'interactive', trigger: { source: 'window' }, conversationId: 'conv-1', title: 'Check disks' });
    assert.strictEqual(run.status, 'queued');
    assert.strictEqual(run.policy.budget.maxTurns, 0, 'no ceilings by default');
    runs.start(run.id);
    assert.strictEqual(runs.get(run.id).status, 'running');
    assert.ok(runs.get(run.id).startedAt, 'started_at is stamped once');

    const turn = runs.beginStep(run.id, { kind: 'turn', name: 'turn' });
    const tool = runs.beginStep(run.id, { kind: 'tool', name: 'run_command', input: { command: 'df -h' } });
    assert.strictEqual(turn, 1);
    assert.strictEqual(tool, 2);
    assert.strictEqual(runs.openStep(run.id, 'tool', 'run_command').seq, 2);
    runs.endStep(run.id, tool, { status: 'complete', output: 'Filesystem ...' });
    runs.tally(run.id, { toolCalls: 1 });
    runs.endStep(run.id, turn, { status: 'complete' });
    runs.tally(run.id, { costUsd: 0.02, turns: 1 });
    runs.finish(run.id, { costUsd: 0.02 });

    const done = runs.get(run.id);
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.toolCalls, 1);
    assert.strictEqual(done.turns, 1);
    assert.ok(Math.abs(done.costUsd - 0.02) < 1e-9);
    assert.ok(done.endedAt >= done.startedAt);
    const steps = runs.steps(run.id);
    assert.deepStrictEqual(steps.map(step => [step.seq, step.kind, step.status]), [[1, 'turn', 'complete'], [2, 'tool', 'complete']]);
    assert.ok(steps[1].input.includes('df -h'));
    assert.ok(changes.some(change => change.channel === 'runs-changed' && change.payload.status === 'done'));
});

check('a budget names the ceiling it hit, and none when there is none', () => {
    const run = runs.create({ agentId: 'a', policy: { budget: { maxToolCalls: 2, maxCostUsd: 1 } } });
    runs.start(run.id);
    assert.strictEqual(runs.overBudget(run.id), '');
    runs.tally(run.id, { toolCalls: 2 });
    assert.ok(/2 tool calls/.test(runs.overBudget(run.id)));
    const free = runs.create({ agentId: 'a' });
    runs.tally(free.id, { toolCalls: 500, costUsd: 40 });
    assert.strictEqual(runs.overBudget(free.id), '', 'zero means no ceiling');
});

check('a policy is normalised: unknown fields dropped, negatives ignored', () => {
    const policy = runs.normalizePolicy({ approvals: 'park', budget: { maxTurns: -3, maxMinutes: '15', nonsense: 1 }, tools: ['run_command'] });
    assert.deepStrictEqual(policy, { approvals: 'park', budget: { maxTurns: 0, maxToolCalls: 0, maxCostUsd: 0, maxMinutes: 15 }, tools: ['run_command'] });
});

check('listing filters by agent, status and conversation, newest first', () => {
    runs.create({ agentId: 'b', conversationId: 'conv-b' });
    const mine = runs.list({ agentId: 'a' });
    assert.ok(mine.length >= 3);
    assert.ok(mine.every(run => run.agentId === 'a'));
    assert.ok(mine.every((run, index) => index === 0 || mine[index - 1].updatedAt >= run.updatedAt));
    assert.strictEqual(runs.list({ conversationId: 'conv-b' }).length, 1);
    assert.strictEqual(runs.list({ status: 'done' }).every(run => run.status === 'done'), true);
});

check('recovery fails what was running, marks lost tool steps unknown, and re-queues what a caller can resume', () => {
    // Everything the checks above left open is closed first, so what this
    // one finds is exactly what it opens.
    for (const stale of runs.open()) runs.cancel(stale.id, 'test');

    const lost = runs.create({ agentId: 'a', kind: 'interactive' });
    runs.start(lost.id);
    runs.beginStep(lost.id, { kind: 'turn' });
    runs.beginStep(lost.id, { kind: 'tool', name: 'run_command', input: { command: 'systemctl restart nginx' } });

    const scheduled = runs.create({ agentId: 'a', kind: 'scheduled', jobId: 'job-1' });
    runs.start(scheduled.id);
    runs.beginStep(scheduled.id, { kind: 'tool', name: 'read_file' });

    const report = runs.recover({ resumable: run => run.kind === 'scheduled' });
    assert.deepStrictEqual(report.closed, [lost.id]);
    assert.deepStrictEqual(report.requeued, [scheduled.id]);

    const failedRun = runs.get(lost.id);
    assert.strictEqual(failedRun.status, 'failed');
    assert.ok(/app closed/i.test(failedRun.result.reason));
    const unknown = runs.unknownSteps(lost.id);
    assert.strictEqual(unknown.length, 1);
    assert.strictEqual(unknown[0].name, 'run_command');
    assert.ok(unknown[0].input.includes('systemctl restart nginx'), 'the lost command is named so the agent can check it');
    assert.strictEqual(runs.steps(lost.id)[0].status, 'interrupted', 'a turn step is interrupted, not unknown');

    assert.strictEqual(runs.get(scheduled.id).status, 'queued');
    assert.strictEqual(runs.unknownSteps(scheduled.id).length, 1);
    assert.strictEqual(runs.open().length, 1, 'only the re-queued run is still open');
});

check('usage totals cost, turns and tool calls for an agent', () => {
    const total = runs.usage({ agentId: 'a' });
    assert.ok(total.runs >= 5);
    assert.ok(total.costUsd > 0);
    assert.ok(total.failed >= 1);
    assert.strictEqual(runs.usage({ agentId: 'nobody' }).runs, 0);
});

check('the database survives a reopen with its schema version', () => {
    const before = runs.list({ limit: 500 }).length;
    db.close();
    assert.strictEqual(runs.list({ limit: 500 }).length, before);
    assert.ok(fs.existsSync(db.file()));
});

check('a run can be removed with its steps', () => {
    const run = runs.create({ agentId: 'a' });
    runs.beginStep(run.id, { kind: 'turn' });
    assert.strictEqual(runs.remove(run.id), true);
    assert.strictEqual(runs.get(run.id), null);
    assert.strictEqual(runs.steps(run.id).length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
db.close();
fs.rmSync(userData, { recursive: true, force: true });
if (failed > 0) process.exit(1);
