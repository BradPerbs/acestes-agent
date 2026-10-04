/**
 * How fast a turn generated its answer, for the number beside its branch icon.
 *
 * No harness reports tokens-per-second itself, so it is worked out here:
 * the result's output tokens over the turn's active time. Active time is
 * the wall time from the user's message minus approval waits minus the
 * time spent waiting on tool runs, so it is the model's own time: queue,
 * time-to-first-token, streaming and server-side stalls all stay in, tool
 * execution and user pauses come out.
 *
 * The previous method timed the reply's streaming bursts (the gaps between
 * token deltas). That number is the transport's pace, not the model's: when
 * a runtime buffers and flushes in a few large chunks, the burst span is
 * short while the server spent seconds generating, and the division blows
 * up to hundreds or thousands of tok/sec. Turns that never streamed fell
 * back to wall time instead, so the same model showed ~50 one turn and
 * ~2000 the next. Measuring wall-minus-excluded fixes both: buffered and
 * steady turns divide by the same ruler, and tool-heavy turns no longer
 * read fast just because their bursts were brief.
 *
 * A turn whose runtime reports no usage (Codex, Kimi, OpenCode, Cursor)
 * gets nothing, and so does a turn under half a second of active time
 * (millisecond stamps say nothing reliable there) or past a thousand
 * tok/sec (a clock artifact, not a model). The panel shows no number
 * rather than a wrong one.
 *
 * The usage shapes are the same ones `limits.js` reads; the picker here is
 * deliberately small and dependency-free so this module stays testable on
 * its own.
 */

/** Output tokens, however the runtime spelled its usage. */
function outputTokens(usage) {
    if (!usage || typeof usage !== 'object') return 0;
    for (const name of ['output_tokens', 'completion_tokens', 'outputTokens', 'output']) {
        const n = Number(usage[name]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
}

/**
 * What a turn spent waiting on the user, from its approval cards.
 *
 * Request and settlement carry the same id and are both stamped, so each
 * answered card contributes its own pause. Cards never answered (a turn cut
 * off mid-question) contribute nothing: the wait never ended.
 */
function waitingMs(events, start) {
    const asked = new Map();
    let waiting = 0;
    for (const event of events) {
        if (!event || event.at < start) continue;
        if (event.type === 'approval-request' && event.requestId) {
            asked.set(event.requestId, event.at);
        } else if (event.type === 'approval-settled' && asked.has(event.requestId)) {
            waiting += Math.max(0, event.at - asked.get(event.requestId));
            asked.delete(event.requestId);
        }
    }
    return waiting;
}

/**
 * What a turn spent waiting on tool runs, as the union of its
 * tool-call to tool-result intervals.
 *
 * Calls and results share an id. Overlapping calls (parallel tools) count
 * once: it is wall time the turn lost, not the sum of each tool's clock.
 * A call never answered counts through to the end of the turn. Results
 * with no call, and calls outside this turn, contribute nothing.
 */
function toolBusyMs(events, start, end) {
    const pending = new Map();
    const spans = [];
    for (const event of events) {
        if (!event || !Number.isFinite(event.at)) continue;
        if (event.at < start || event.at > end) continue;
        if (event.type === 'tool-call' && event.id !== undefined && event.id !== null) {
            if (!pending.has(event.id) || event.at < pending.get(event.id)) {
                pending.set(event.id, event.at);
            }
        } else if (event.type === 'tool-result' && event.id !== undefined && event.id !== null && pending.has(event.id)) {
            const from = Math.max(pending.get(event.id), start);
            const to = Math.min(Math.max(event.at, pending.get(event.id)), end);
            pending.delete(event.id);
            if (to > from) spans.push([from, to]);
        }
    }
    for (const callAt of pending.values()) {
        const from = Math.max(callAt, start);
        if (end > from) spans.push([from, end]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let open = null;
    for (const span of spans) {
        if (!open) {
            open = span;
        } else if (span[0] <= open[1]) {
            if (span[1] > open[1]) open[1] = span[1];
        } else {
            total += open[1] - open[0];
            open = span;
        }
    }
    if (open) total += open[1] - open[0];
    return total;
}

/** Token deltas: the reply arriving as it is generated. */
const DELTA_TYPES = new Set(['text-delta', 'thinking-delta']);

/** Active time under this long is stamp noise, not a measurement. */
const MIN_ACTIVE_MS = 500;

/** Past this the clock slipped, not the model sprinted: say nothing. */
const MAX_TPS = 1000;

/**
 * A turn's streaming presence so far: kept per conversation, reset per turn.
 *
 * Timing itself now comes from the event log at stamp time (wall minus
 * approvals minus tool runs), so the tracker only notes whether the turn
 * streamed. It is kept because `index.js` folds one tracker per
 * conversation through every event, and the tests and callers already
 * speak this shape.
 */
function createTracker() {
    return { sawDelta: false };
}

/**
 * Fold one stamped event into the streaming presence.
 *
 * A token delta marks the turn streamed; anything else leaves that alone.
 * A new message starts the next turn's timing from nothing.
 */
function noteEvent(tracker, stamped) {
    if (!tracker || !stamped) return tracker;
    if (DELTA_TYPES.has(stamped.type)) {
        tracker.sawDelta = true;
        return tracker;
    }
    if (stamped.type === 'user-message') {
        tracker.sawDelta = false;
        return tracker;
    }
    return tracker;
}

/**
 * Stamp a result event with its answer rate, in place.
 *
 * `events` is the conversation's log so far (the result itself not yet in
 * it); `stamped` is the result, already carrying its `at`; `tracker` is
 * accepted for its callers and spent for the next turn. Adds
 * `outputTokens`, `durationMs` (the active time) and `tokensPerSec`, plus
 * `wallMs` when tool runs made the wall time meaningfully longer, so the
 * panel can say both. Leaves the event alone when there is nothing honest
 * to say.
 */
function stampTurnRate(events, stamped, tracker) {
    try {
        if (!stamped || stamped.type !== 'result') return stamped;
        const tokens = Number(stamped.outputTokens) || outputTokens(stamped.usage);
        if (!(tokens > 0)) return stamped;
        let start = null;
        const log = Array.isArray(events) ? events : [];
        for (let index = log.length - 1; index >= 0; index -= 1) {
            const event = log[index];
            if (event && event.type === 'user-message' && !event.via) {
                start = event.at;
                break;
            }
        }
        if (start === null || !(stamped.at > start)) return stamped;
        const wall = Math.max(0, stamped.at - start - waitingMs(log, start));
        if (!(wall > 0)) return stamped;
        const tools = Math.min(Math.max(0, toolBusyMs(log, start, stamped.at)), wall);
        const active = wall - tools;
        if (!(active >= MIN_ACTIVE_MS)) return stamped;
        const tps = Math.round((tokens / (active / 1000)) * 10) / 10;
        if (!(tps > 0) || tps > MAX_TPS) return stamped;
        stamped.outputTokens = tokens;
        stamped.durationMs = active;
        if (wall > active) stamped.wallMs = wall;
        stamped.tokensPerSec = tps;
    } catch {
        // A missing number is never worth breaking a turn over.
    } finally {
        if (tracker) {
            tracker.sawDelta = false;
        }
    }
    return stamped;
}

module.exports = { stampTurnRate, noteEvent, createTracker, outputTokens, toolBusyMs };
