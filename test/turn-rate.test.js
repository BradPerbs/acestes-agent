/**
 * A turn's answer rate, for the number beside its branch icon.
 *
 * No harness reports tokens-per-second itself: the result's output tokens
 * are divided by the turn's active time, which is the wall time from the
 * user's message minus whatever the turn spent waiting on approvals. Turns
 * whose runtime reports no usage get nothing, and the panel shows no number
 * rather than a wrong one.
 */
const assert = require('assert');
const { stampTurnRate, noteEvent, createTracker } = require('../src/main/ai/turn-rate');

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  ok   ${name}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL ${name}\n       ${error.message}`);
    }
}

/** A result stamped `ms` after `start`, on a log holding one message. */
function stamped(start, ms, extra = {}) {
    const events = [{ type: 'user-message', text: 'go', at: start }];
    const result = { type: 'result', subtype: 'success', at: start + ms, ...extra };
    stampTurnRate(events, result);
    return result;
}

console.log('turn rate');

check('output tokens over wall time is the rate', () => {
    const result = stamped(1000, 4000, { usage: { output_tokens: 80 } });
    assert.strictEqual(result.outputTokens, 80);
    assert.strictEqual(result.durationMs, 4000);
    assert.strictEqual(result.tokensPerSec, 20);
});

check('every usage spelling the runtimes use is read', () => {
    assert.strictEqual(stamped(0, 2000, { usage: { completion_tokens: 40 } }).tokensPerSec, 20);
    assert.strictEqual(stamped(0, 2000, { usage: { outputTokens: 40 } }).tokensPerSec, 20);
    assert.strictEqual(stamped(0, 2000, { usage: { output: 40 } }).tokensPerSec, 20);
});

check('approval waits come out of the time', () => {
    const events = [
        { type: 'user-message', text: 'go', at: 1000 },
        { type: 'approval-request', requestId: 'r1', at: 1500 },
        { type: 'approval-settled', requestId: 'r1', status: 'approved', at: 3500 },
    ];
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 40 }, at: 5000 };
    stampTurnRate(events, result);
    // Four wall seconds, two of them waiting on the user.
    assert.strictEqual(result.durationMs, 2000);
    assert.strictEqual(result.tokensPerSec, 20);
});

check('a turn with no usage gets no number', () => {
    const result = stamped(1000, 4000, { usage: null });
    assert.strictEqual(result.tokensPerSec, undefined);
    assert.strictEqual(result.durationMs, undefined);
});

check('a turn with no message to measure from is left alone', () => {
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 40 }, at: 5000 };
    stampTurnRate([], result);
    assert.strictEqual(result.tokensPerSec, undefined);
});

check('only the latest turn is measured', () => {
    const events = [
        { type: 'user-message', text: 'first', at: 1000 },
        { type: 'user-message', text: 'second', at: 9000 },
    ];
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 20 }, at: 11000 };
    stampTurnRate(events, result);
    assert.strictEqual(result.durationMs, 2000);
    assert.strictEqual(result.tokensPerSec, 10);
});

check('consecutive deltas add up their gaps', () => {
    const tracker = createTracker();
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    noteEvent(tracker, { type: 'text-delta', at: 1100 });
    noteEvent(tracker, { type: 'thinking-delta', at: 1250 });
    assert.strictEqual(tracker.genMs, 250);
});

check('anything between tokens closes the burst', () => {
    const tracker = createTracker();
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    noteEvent(tracker, { type: 'text-delta', at: 1100 });
    noteEvent(tracker, { type: 'tool-call', at: 1200 });
    noteEvent(tracker, { type: 'text-delta', at: 5000 });
    noteEvent(tracker, { type: 'text-delta', at: 5100 });
    // A tenth of generation either side of a four-second tool run.
    assert.strictEqual(tracker.genMs, 200);
});

check('a new message restarts the timing', () => {
    const tracker = createTracker();
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    noteEvent(tracker, { type: 'text-delta', at: 2000 });
    noteEvent(tracker, { type: 'user-message', at: 3000 });
    assert.strictEqual(tracker.genMs, 0);
    assert.strictEqual(tracker.sawDelta, false);
});

check('the stamp counts generation, and keeps the wall alongside', () => {
    const events = [{ type: 'user-message', text: 'go', at: 0 }];
    const tracker = createTracker();
    for (const at of [1000, 1500, 2000, 2500, 3000]) {
        noteEvent(tracker, { type: 'text-delta', at });
    }
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 100 }, at: 10000 };
    stampTurnRate(events, result, tracker);
    assert.strictEqual(result.durationMs, 2000);
    assert.strictEqual(result.tokensPerSec, 50);
    assert.strictEqual(result.wallMs, 10000);
});

check('too little generation falls back to the wall', () => {
    const events = [{ type: 'user-message', text: 'go', at: 0 }];
    const tracker = createTracker();
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    noteEvent(tracker, { type: 'text-delta', at: 1100 });
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 100 }, at: 10000 };
    stampTurnRate(events, result, tracker);
    assert.strictEqual(result.durationMs, 10000);
    assert.strictEqual(result.wallMs, undefined);
});

check('stamping spends the tracker for the next turn', () => {
    const tracker = createTracker();
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    noteEvent(tracker, { type: 'text-delta', at: 2000 });
    stampTurnRate([], { type: 'result', usage: { output_tokens: 10 }, at: 3000 }, tracker);
    assert.strictEqual(tracker.genMs, 0);
    assert.strictEqual(tracker.sawDelta, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
