/**
 * How fast a turn generated its answer, for the number beside its branch icon.
 *
 * No harness reports tokens-per-second itself, so it is worked out here:
 * the result's output tokens over the turn's generation time. Generation
 * time is measured from the reply streaming itself: each burst of
 * consecutive token deltas contributes the gaps between its tokens, and
 * anything else (a tool call, the finished block, an approval) closes the
 * burst. Tool runs, approval waits and pauses between rounds are therefore
 * never counted; the number is the model's own pace, not the turn's.
 *
 * A turn that never streamed (a runtime handing over the whole reply at
 * once) has no bursts to measure and falls back to wall time from the
 * user's message minus approval waits, as does anything under half a
 * second of generation, where millisecond stamps say nothing reliable. A
 * turn whose runtime reports no usage (Codex, Kimi, OpenCode, Cursor) gets
 * nothing, and the panel shows no number rather than a wrong one.
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

/** Token deltas: the reply arriving as it is generated. */
const DELTA_TYPES = new Set(['text-delta', 'thinking-delta']);

/** Generation under this long is stamp noise, not a measurement. */
const MIN_GEN_MS = 500;

/** A turn's generation bursts so far: kept per conversation, reset per turn. */
function createTracker() {
    return { lastDeltaAt: 0, genMs: 0, sawDelta: false };
}

/**
 * Fold one stamped event into the generation timing.
 *
 * A token delta extends the open burst by the gap since the previous token;
 * anything else closes it, so tool runs and pauses never leak in. A new
 * message starts the next turn's timing from nothing.
 */
function noteEvent(tracker, stamped) {
    if (!tracker || !stamped) return tracker;
    if (DELTA_TYPES.has(stamped.type)) {
        tracker.sawDelta = true;
        if (tracker.lastDeltaAt && stamped.at >= tracker.lastDeltaAt) {
            tracker.genMs += stamped.at - tracker.lastDeltaAt;
        }
        tracker.lastDeltaAt = stamped.at;
        return tracker;
    }
    if (stamped.type === 'user-message') {
        tracker.genMs = 0;
        tracker.lastDeltaAt = 0;
        tracker.sawDelta = false;
        return tracker;
    }
    tracker.lastDeltaAt = 0;
    return tracker;
}

/**
 * Stamp a result event with its answer rate, in place.
 *
 * `events` is the conversation's log so far (the result itself not yet in
 * it); `stamped` is the result, already carrying its `at`; `tracker` holds
 * the turn's generation bursts. Adds `outputTokens`, `durationMs` (the
 * generation time) and `tokensPerSec`, plus `wallMs` when the wall time is
 * meaningfully longer, so the panel can say both. Leaves the event alone
 * when there is nothing honest to say, and spends the tracker either way:
 * the next turn measures from nothing.
 */
function stampTurnRate(events, stamped, tracker) {
    try {
        if (!stamped || stamped.type !== 'result') return stamped;
        const tokens = Number(stamped.outputTokens) || outputTokens(stamped.usage);
        if (!(tokens > 0)) return stamped;
        let start = null;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event && event.type === 'user-message' && !event.via) {
                start = event.at;
                break;
            }
        }
        const wall = start !== null && stamped.at > start
            ? Math.max(0, stamped.at - start - waitingMs(events, start))
            : 0;
        const gen = tracker && tracker.sawDelta && tracker.genMs >= MIN_GEN_MS ? tracker.genMs : 0;
        const active = gen || wall;
        if (!(active > 0)) return stamped;
        stamped.outputTokens = tokens;
        stamped.durationMs = active;
        if (wall > active) stamped.wallMs = wall;
        stamped.tokensPerSec = Math.round((tokens / (active / 1000)) * 10) / 10;
    } catch {
        // A missing number is never worth breaking a turn over.
    } finally {
        if (tracker) {
            tracker.genMs = 0;
            tracker.lastDeltaAt = 0;
            tracker.sawDelta = false;
        }
    }
    return stamped;
}

module.exports = { stampTurnRate, noteEvent, createTracker, outputTokens };
