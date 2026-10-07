/**
 * Several sign-ins per runtime, and the limits kept for each.
 *
 * An account is a folder the runtime is pointed at by one variable, so the
 * registry is checked for what it hands the runtime, what it refuses, and
 * what it deletes. The limits are checked against the shapes Claude Code and
 * Codex actually answer with.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-accounts-'));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-accounts-home-'));

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {}, whenReady: () => new Promise(() => {}) },
    safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (text) => Buffer.from(`enc:${text}`, 'utf8'),
        decryptString: (buffer) => buffer.toString('utf8').slice(4),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: class { show() {} },
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return originalLoad.call(this, request, ...rest);
};

// The machine's own Claude folder, moved somewhere this test owns so the
// "that is already this computer's login" refusal can be checked.
const machineClaude = path.join(fakeHome, '.claude');
fs.mkdirSync(machineClaude);
process.env.CLAUDE_CONFIG_DIR = machineClaude;

const accounts = require(path.join(ROOT, 'ai', 'accounts'));
const limits = require(path.join(ROOT, 'ai', 'limits'));
const settings = require(path.join(ROOT, 'ai', 'settings'));
const claude = require(path.join(ROOT, 'ai', 'providers', 'claude-code'));
const codex = require(path.join(ROOT, 'ai', 'providers', 'codex'));

/* ---------------- The registry ---------------- */

// The machine's own login is always there and moves nothing.
assert.deepStrictEqual(accounts.list('claude-code').map(account => account.id), ['default']);
assert.deepStrictEqual(accounts.envFor('claude-code', 'default'), {});
assert.deepStrictEqual(accounts.list('grok').map(account => account.id), ['default'], 'one login, so the weekly limit has a row');

// A fresh account gets a folder of its own under userData, and the variable.
const work = accounts.add({ provider: 'claude-code', label: 'Work' }).account;
assert.ok(work.managed);
assert.ok(work.home.startsWith(path.join(userData, 'ai-accounts')));
assert.ok(fs.statSync(work.home).isDirectory());
assert.deepStrictEqual(accounts.envFor('claude-code', work.id), { CLAUDE_CONFIG_DIR: work.home });
assert.deepStrictEqual(accounts.envFor('codex', work.id), {}, 'an account belongs to one runtime');

// An existing folder is taken as it is, once.
const existing = path.join(fakeHome, '.claude-client');
fs.mkdirSync(existing);
fs.writeFileSync(path.join(existing, '.claude.json'), '{}');
const client = accounts.add({ provider: 'claude-code', label: 'Client', home: existing }).account;
assert.strictEqual(client.managed, false);
assert.strictEqual(client.home, path.resolve(existing));
assert.match(accounts.add({ provider: 'claude-code', home: existing }).error, /already an account/);
assert.match(accounts.add({ provider: 'claude-code', home: machineClaude }).error, /own login/);
assert.match(accounts.add({ provider: 'claude-code', home: path.join(fakeHome, 'nope') }).error, /does not exist/);
assert.match(accounts.add({ provider: 'claude-code', home: 'relative/path' }).error, /full path/);
// A home-relative path is expanded rather than refused as relative.
assert.doesNotMatch(accounts.add({ provider: 'claude-code', home: '~/cb-no-such-folder-here' }).error, /full path/);
assert.match(accounts.add({ provider: 'grok' }).error, /cannot hold more than one/);

// A removed id resolves to the machine's own rather than to nothing.
assert.strictEqual(accounts.resolve('claude-code', 'acct-gone').id, 'default');

// Discovery: folders named like another login with a marker file, and not
// already listed. A folder with the right name and nothing in it is not one.
fs.mkdirSync(path.join(fakeHome, '.claude-personal'));
fs.writeFileSync(path.join(fakeHome, '.claude-personal', '.credentials.json'), '{}');
fs.mkdirSync(path.join(fakeHome, '.claude-empty'));
fs.mkdirSync(path.join(fakeHome, '.codex-work'));
fs.writeFileSync(path.join(fakeHome, '.codex-work', 'auth.json'), '{}');
assert.deepStrictEqual(accounts.discover('claude-code', { home: fakeHome }), [path.join(fakeHome, '.claude-personal')]);
assert.deepStrictEqual(accounts.discover('codex', { home: fakeHome }), [path.join(fakeHome, '.codex-work')]);

// Removing: a folder this app made is deleted, one the user pointed at is not.
accounts.remove(client.id);
assert.ok(fs.existsSync(existing), 'a folder the user owns survives');
accounts.remove(work.id);
assert.ok(!fs.existsSync(work.home), 'a managed folder goes with its account');

// A hand-edited record claiming to be managed cannot aim a delete outside
// this app's own folder.
const victim = path.join(fakeHome, 'precious');
fs.mkdirSync(victim);
fs.writeFileSync(path.join(userData, 'ai-accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: 'acct-evil', provider: 'claude-code', label: 'Evil', home: victim, managed: true }],
}));
accounts._test.reset();
accounts.remove('acct-evil');
assert.ok(fs.existsSync(victim), 'a managed flag on a foreign folder does not delete it');

/* ---------------- The limits ---------------- */

// Claude's /usage answer, trimmed from a real one. Undeclared buckets under
// code names are ignored; a null window is not a window.
const claudeWindows = limits.fromClaudeUsage({
    subscription_type: 'team',
    rate_limits_available: true,
    rate_limits: {
        five_hour: { utilization: 2, resets_at: '2026-09-28T08:20:00.049373+00:00' },
        seven_day: { utilization: 0, resets_at: '2026-09-29T23:00:00.049393+00:00' },
        seven_day_opus: null,
        nimbus_quill: { utilization: 0, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 40, resets_at: '2026-09-29T23:00:00+00:00' }],
        extra_usage: { is_enabled: false, utilization: null },
    },
});
assert.deepStrictEqual(claudeWindows.map(window => window.id), ['five_hour', 'seven_day', 'model:fable']);
assert.strictEqual(claudeWindows[0].used, 2);
assert.strictEqual(claudeWindows[0].minutes, 300);
assert.strictEqual(claudeWindows[0].resetsAt, Date.parse('2026-09-28T08:20:00.049Z'));
assert.strictEqual(claudeWindows[2].label, 'Fable');

// Codex's answer: seconds, and windows named by their length.
const codexWindows = limits.fromCodexLimits({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1790578427 } },
    rateLimitsByLimitId: {
        codex: {
            limitId: 'codex',
            primary: { usedPercent: 34, windowDurationMins: 300, resetsAt: 1790578427 },
            secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1791165227 },
            rateLimitReachedType: null,
        },
    },
});
assert.deepStrictEqual(codexWindows.map(window => [window.id, window.used]), [['five_hour', 34], ['seven_day', 5]]);
assert.strictEqual(codexWindows[0].resetsAt, 1790578427000);

// A turn's event: already a percentage by the time it gets here.
assert.deepStrictEqual(
    (({ id, used, status }) => ({ id, used, status }))(limits.fromClaudeEvent({ window: 'five_hour', utilization: 91, status: 'allowed_warning', resetsAt: 1790578427 })),
    { id: 'five_hour', used: 91, status: 'allowed_warning' },
);

// A probe replaces; an event merges and keeps its status.
const future = Date.now() + 3600000;
limits.recordWindows('claude-code', 'default', [{ id: 'five_hour', used: 10, resetsAt: future }], { replace: true, source: 'probe' });
limits.recordWindows('claude-code', 'default', [{ id: 'seven_day', used: 80, resetsAt: future, status: 'allowed_warning' }]);
let entry = limits.snapshot()['claude-code:default'];
assert.deepStrictEqual(entry.windows.map(window => window.id).sort(), ['five_hour', 'seven_day']);
assert.ok(entry.checkedAt > 0);
limits.recordWindows('claude-code', 'default', [{ id: 'five_hour', used: 12, resetsAt: future }], { replace: true, source: 'probe' });
entry = limits.snapshot()['claude-code:default'];
assert.deepStrictEqual(entry.windows.map(window => window.id), ['five_hour'], 'a full answer drops windows it no longer has');

// An event with no figure, only that the turn was allowed, keeps the one held.
limits.recordWindows('claude-code', 'default', [limits.fromClaudeEvent({ window: 'five_hour', utilization: null, status: 'allowed', resetsAt: Math.round(future / 1000) })]);
entry = limits.snapshot()['claude-code:default'];
assert.strictEqual(entry.windows.find(window => window.id === 'five_hour').used, 12, 'a figureless event does not blank the meter');
assert.strictEqual(entry.windows.find(window => window.id === 'five_hour').status, 'allowed');
// One with a figure still moves it.
limits.recordWindows('claude-code', 'default', [limits.fromClaudeEvent({ window: 'five_hour', utilization: 40, status: 'allowed', resetsAt: Math.round(future / 1000) })]);
assert.strictEqual(limits.snapshot()['claude-code:default'].windows.find(window => window.id === 'five_hour').used, 40);
// A figureless event after the held window closed leaves it reading as reset.
limits.recordWindows('claude-code', 'closed', [{ id: 'five_hour', used: 70, resetsAt: Date.now() - 1000 }], { replace: true, source: 'probe' });
limits.recordWindows('claude-code', 'closed', [limits.fromClaudeEvent({ window: 'five_hour', utilization: null, status: 'allowed', resetsAt: Math.round(future / 1000) })]);
const reopened = limits.snapshot()['claude-code:closed'].windows[0];
assert.strictEqual(reopened.used, 0);
assert.strictEqual(reopened.lapsed, true);
limits.forget('claude-code', 'closed');

// A window whose reset has passed reads as reset, not as its old figure.
limits.recordWindows('codex', 'default', [{ id: 'five_hour', used: 100, resetsAt: Date.now() - 1000, status: 'rejected' }]);
const lapsed = limits.snapshot()['codex:default'].windows[0];
assert.strictEqual(lapsed.used, 0);
assert.strictEqual(lapsed.status, '');
assert.strictEqual(lapsed.lapsed, true);

// Turns tally per account, whichever usage shape the runtime reports.
limits.recordTurn('claude-code', 'acct-x', { usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 }, costUsd: 0.01 });
limits.recordTurn('claude-code', 'acct-x', { usage: { prompt_tokens: 50, completion_tokens: 10 }, costUsd: 0.02, isError: true });
const usage = limits.snapshot()['claude-code:acct-x'].usage;
assert.deepStrictEqual(usage.today, { turns: 2, errors: 1, input: 150, output: 30, cached: 5, costUsd: 0.03 });
assert.deepStrictEqual(usage.week, usage.today);

limits.forget('claude-code', 'acct-x');
assert.strictEqual(limits.snapshot()['claude-code:acct-x'], undefined);

limits.flush();
assert.ok(fs.existsSync(path.join(userData, 'ai-limits.json')));

/* ---------------- The per-agent choice ---------------- */

const sanitized = settings._test.sanitize({ accounts: { 'claude-code': 'acct-1', bogus: 'x', codex: '' } });
assert.deepStrictEqual(sanitized.accounts, { 'claude-code': 'acct-1' });

// One runtime at a time lands over the others.
settings.set({ accounts: { 'claude-code': 'acct-1' } });
const after = settings.set({ accounts: { codex: 'acct-2' } });
assert.deepStrictEqual(after.accounts, { 'claude-code': 'acct-1', codex: 'acct-2' });

/* ---------------- The runtimes' own answers ---------------- */

assert.deepStrictEqual(claude.describeAuthStatus(JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: 'Org', subscriptionType: 'max',
})), { signedIn: true, email: 'a@b.c', plan: 'max', organization: 'Org', method: 'claude.ai' });
assert.deepStrictEqual(claude.describeAuthStatus('{"loggedIn":false,"authMethod":"none"}'),
    { signedIn: false, email: '', plan: '', organization: '', method: '' });
assert.strictEqual(claude.describeAuthStatus('not json'), null);

assert.deepStrictEqual(codex.describeAccount({ account: { type: 'chatgpt', email: 'x@y.z', planType: 'plus' } }),
    { signedIn: true, email: 'x@y.z', plan: 'plus', organization: '', method: 'chatgpt' });
assert.strictEqual(codex.describeAccount({ account: null }).signedIn, false);

fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log('accounts-limits tests passed');
