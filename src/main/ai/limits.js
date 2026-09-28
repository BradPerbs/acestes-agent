const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/**
 * How much of each account's plan is left, and what this machine has spent.
 *
 * Two kinds of figure, kept apart because they come from different places and
 * mean different things.
 *
 * Windows are the plan's own limits: Claude's five-hour and weekly windows,
 * Codex's primary and secondary. They are the runtime's answer, read two ways:
 * on demand, by asking the runtime without sending a message (see each
 * provider's `readLimits`), and in passing, from the rate-limit events a turn
 * carries. Either way the figure is the plan's, so it counts use from every
 * device on the account, not just this one.
 *
 * Usage is what this app sent through each account, tallied per day from the
 * turn results: turns, tokens and, where the runtime prices them, dollars.
 * It is the only figure the runtimes without a plan API have at all, and it is
 * this machine only.
 *
 * Both are keyed by runtime and account, `claude-code:default` and so on, and
 * written to their own file, debounced: a turn can carry several events and
 * none of them is worth a write of its own.
 */

const VERSION = 1;
/** Long enough for a weekly view with room over, short enough to stay small. */
const KEEP_DAYS = 35;
const SAVE_DELAY = 800;

const filePath = () => path.join(app.getPath('userData'), 'ai-limits.json');

let state = null;
let notify = () => {};
let saveTimer = null;
let notifyTimer = null;

function setNotifier(fn) {
    notify = fn;
}

const key = (provider, accountId = 'default') => `${provider}:${accountId || 'default'}`;

const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

/** A window's figure, 0 to 100, or null when the runtime gave none. */
const percent = (value) => {
    const n = number(value);
    return n === null ? null : Math.max(0, Math.min(100, n));
};

/** Any of the time shapes the runtimes use, as epoch milliseconds, or null. */
function toMillis(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Seconds until the year 2286; nothing here is that far out.
    return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

/** The window names Claude uses, as the length of the window. */
const CLAUDE_WINDOWS = {
    five_hour: 300,
    seven_day: 10080,
    seven_day_opus: 10080,
    seven_day_sonnet: 10080,
    seven_day_oauth_apps: 10080,
    seven_day_overage_included: 10080,
};

/** A window id for a length, so Codex's primary and Claude's five-hour line up. */
function idForMinutes(minutes) {
    if (minutes === 300) return 'five_hour';
    if (minutes === 10080) return 'seven_day';
    return minutes ? `window_${minutes}` : 'window';
}

/**
 * Claude's on-demand usage answer, as windows.
 *
 * Only the fields its type declares are read. The response carries more
 * (a `limits` array, internal buckets under code names) and those are not
 * a contract; a window that is null or has neither a figure nor a reset is
 * not one the plan has, and is left out.
 */
function fromClaudeUsage(response) {
    const limits = response?.rate_limits;
    if (!limits || typeof limits !== 'object') return [];
    const windows = [];
    for (const [id, minutes] of Object.entries(CLAUDE_WINDOWS)) {
        const entry = limits[id];
        if (!entry || typeof entry !== 'object') continue;
        const used = percent(entry.utilization);
        const resetsAt = toMillis(entry.resets_at);
        if (used === null && resetsAt === null) continue;
        windows.push({ id, label: '', minutes, used, resetsAt, status: '' });
    }
    for (const entry of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
        const name = String(entry?.display_name || '').trim().slice(0, 40);
        if (!name) continue;
        const used = percent(entry.utilization);
        const resetsAt = toMillis(entry.resets_at);
        if (used === null && resetsAt === null) continue;
        windows.push({ id: `model:${name.toLowerCase()}`, label: name, minutes: 10080, used, resetsAt, status: '' });
    }
    const extra = limits.extra_usage;
    if (extra?.is_enabled && percent(extra.utilization) !== null) {
        windows.push({ id: 'extra_usage', label: '', minutes: null, used: percent(extra.utilization), resetsAt: null, status: '' });
    }
    return windows;
}

/**
 * One `rate-limit` event from a Claude turn, as a window. The provider has
 * already turned the SDK's fraction into a percentage: see its `translate`.
 */
function fromClaudeEvent(event) {
    const id = String(event?.window || '');
    if (!id) return null;
    return {
        id,
        label: '',
        minutes: CLAUDE_WINDOWS[id] || null,
        used: percent(event.utilization),
        resetsAt: toMillis(event.resetsAt),
        status: ['allowed', 'allowed_warning', 'rejected'].includes(event.status) ? event.status : '',
    };
}

/** Codex's `account/rateLimits/read` answer, or one update of it, as windows. */
function fromCodexLimits(snapshot) {
    const buckets = snapshot?.rateLimitsByLimitId && typeof snapshot.rateLimitsByLimitId === 'object'
        ? Object.values(snapshot.rateLimitsByLimitId).filter(Boolean)
        : [snapshot?.rateLimits || snapshot].filter(Boolean);
    const windows = [];
    for (const bucket of buckets) {
        const reached = Boolean(bucket.rateLimitReachedType);
        // A second metered bucket (anything but the main `codex` one) keeps
        // its name on the window, so two five-hour windows do not collide.
        const prefix = bucket.limitId && bucket.limitId !== 'codex' ? `${bucket.limitId}:` : '';
        const label = prefix ? String(bucket.limitName || bucket.limitId).slice(0, 40) : '';
        for (const slot of ['primary', 'secondary']) {
            const entry = bucket[slot];
            if (!entry || typeof entry !== 'object') continue;
            const minutes = number(entry.windowDurationMins);
            const used = percent(entry.usedPercent);
            windows.push({
                id: `${prefix}${idForMinutes(minutes)}`,
                label,
                minutes,
                used,
                resetsAt: toMillis(entry.resetsAt),
                status: used !== null && used >= 100 && reached ? 'rejected' : '',
            });
        }
    }
    return windows;
}

/** Token counts from whichever usage shape a runtime reports. */
function tokens(usage) {
    if (!usage || typeof usage !== 'object') return { input: 0, output: 0, cached: 0 };
    const pick = (...names) => {
        for (const name of names) {
            const n = number(usage[name]);
            if (n !== null) return n;
        }
        return 0;
    };
    return {
        input: pick('input_tokens', 'prompt_tokens', 'inputTokens', 'input'),
        output: pick('output_tokens', 'completion_tokens', 'outputTokens', 'output'),
        cached: pick('cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens', 'cache_read'),
    };
}

function load() {
    if (state) return state;
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    } catch {
        // Nothing tracked yet.
    }
    state = {
        version: VERSION,
        accounts: parsed?.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
        usage: parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : {},
    };
    return state;
}

function schedule() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
    saveTimer.unref?.();
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => notify('ai-limits', snapshot()), 150);
    notifyTimer.unref?.();
}

function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!state) return;
    try {
        fs.mkdirSync(path.dirname(filePath()), { recursive: true });
        fs.writeFileSync(filePath(), JSON.stringify(state));
    } catch (error) {
        console.error('Could not save the usage limits:', error.message);
    }
}

function entryFor(provider, accountId) {
    const current = load();
    const id = key(provider, accountId);
    if (!current.accounts[id]) current.accounts[id] = { windows: {}, identity: null, checkedAt: 0, error: '' };
    return current.accounts[id];
}

/**
 * Windows for one account.
 *
 * `replace` is for a full answer from the runtime, which is the plan as it
 * stands: a window it no longer mentions is gone. An event names one window
 * and merges over what is there, keeping the status a probe cannot give.
 */
function recordWindows(provider, accountId, windows, { replace = false, source = 'event' } = {}) {
    const entry = entryFor(provider, accountId);
    const now = Date.now();
    const next = replace ? {} : { ...entry.windows };
    for (const window of windows || []) {
        if (!window?.id) continue;
        const before = entry.windows[window.id];
        next[window.id] = {
            ...window,
            // A probe does not say whether the runtime is refusing; an event
            // from the same window does, and that is kept until it resets.
            status: window.status || (before && before.resetsAt === window.resetsAt ? before.status || '' : ''),
            at: now,
            source,
        };
    }
    entry.windows = next;
    if (source === 'probe') {
        entry.checkedAt = now;
        entry.error = '';
    }
    schedule();
}

/** Who an account is signed in as, from the runtime's own answer. */
function recordIdentity(provider, accountId, identity) {
    const entry = entryFor(provider, accountId);
    entry.identity = identity && typeof identity === 'object'
        ? {
            signedIn: Boolean(identity.signedIn),
            email: String(identity.email || '').slice(0, 200),
            plan: String(identity.plan || '').slice(0, 40),
            organization: String(identity.organization || '').slice(0, 200),
            method: String(identity.method || '').slice(0, 40),
        }
        : null;
    entry.identityAt = Date.now();
    schedule();
}

function recordError(provider, accountId, message) {
    const entry = entryFor(provider, accountId);
    entry.error = String(message || '').slice(0, 300);
    entry.checkedAt = Date.now();
    schedule();
}

const dayOf = (at = Date.now()) => {
    const date = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** One finished turn, added to today's tally for the account that ran it. */
function recordTurn(provider, accountId, { usage, costUsd = 0, isError = false } = {}) {
    const current = load();
    const id = key(provider, accountId);
    const days = current.usage[id] || (current.usage[id] = {});
    const today = dayOf();
    const bucket = days[today] || (days[today] = { turns: 0, errors: 0, input: 0, output: 0, cached: 0, costUsd: 0 });
    const counted = tokens(usage);
    bucket.turns += 1;
    if (isError) bucket.errors += 1;
    bucket.input += counted.input;
    bucket.output += counted.output;
    bucket.cached += counted.cached;
    bucket.costUsd = Math.round((bucket.costUsd + (number(costUsd) || 0)) * 1e6) / 1e6;

    const cutoff = dayOf(Date.now() - KEEP_DAYS * 86400000);
    for (const day of Object.keys(days)) {
        if (day < cutoff) delete days[day];
    }
    schedule();
}

/** The days from `since` onward, summed. */
function sum(days, since) {
    const total = { turns: 0, errors: 0, input: 0, output: 0, cached: 0, costUsd: 0 };
    for (const [day, bucket] of Object.entries(days || {})) {
        if (day < since) continue;
        for (const field of Object.keys(total)) total[field] += number(bucket[field]) || 0;
    }
    total.costUsd = Math.round(total.costUsd * 1e4) / 1e4;
    return total;
}

/**
 * Everything, as the settings page draws it.
 *
 * A window whose reset has passed is shown as reset rather than as the
 * figure it had: the plan has started it again whether or not anything here
 * has asked since, and a red bar for a limit that lifted an hour ago is the
 * one thing this page must not say.
 */
function snapshot(now = Date.now()) {
    const current = load();
    const today = dayOf(now);
    const week = dayOf(now - 6 * 86400000);
    const ids = new Set([...Object.keys(current.accounts), ...Object.keys(current.usage)]);
    const out = {};
    for (const id of ids) {
        const entry = current.accounts[id] || { windows: {}, identity: null, checkedAt: 0, error: '' };
        const windows = Object.values(entry.windows || {}).map((window) => {
            const lapsed = window.resetsAt && window.resetsAt <= now;
            return lapsed ? { ...window, used: 0, status: '', lapsed: true } : window;
        });
        out[id] = {
            identity: entry.identity || null,
            checkedAt: entry.checkedAt || 0,
            error: entry.error || '',
            windows,
            usage: {
                today: sum(current.usage[id], today),
                week: sum(current.usage[id], week),
            },
        };
    }
    return out;
}

/** Forget an account's figures, for when the account itself goes. */
function forget(provider, accountId) {
    const current = load();
    const id = key(provider, accountId);
    delete current.accounts[id];
    delete current.usage[id];
    schedule();
}

module.exports = {
    setNotifier,
    key,
    recordWindows,
    recordIdentity,
    recordError,
    recordTurn,
    snapshot,
    forget,
    flush,
    fromClaudeUsage,
    fromClaudeEvent,
    fromCodexLimits,
    _test: { tokens, toMillis, idForMinutes, dayOf, reset: () => { state = null; } },
};
