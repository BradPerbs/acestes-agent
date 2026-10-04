/**
 * A turn's answer rate, for the number beside its branch icon.
 *
 * The result's output tokens over the turn's active time: wall time from
 * the user's message minus approval waits minus tool runs. Turns whose
 * runtime reports no usage get nothing, as do turns too fast to measure
 * or past any plausible model pace; the panel shows no number rather than
 * a wrong one.
 */
const assert = require('assert');
const { stampTurnRate, noteEvent, createTracker, toolBusyMs } = require('../src/main/ai/turn-rate');

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
    stampTurnRate(events, result, createTracker());
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
    stampTurnRate(events, result, createTracker());
    // Four wall seconds, two of them waiting on the user.
    assert.strictEqual(result.durationMs, 2000);
    assert.strictEqual(result.tokensPerSec, 20);
});

check('tool runs come out of the time, and the wall stays alongside', () => {
    const events = [
        { type: 'user-message', text: 'go', at: 0 },
        { type: 'tool-call', id: 'c1', at: 1000 },
        { type: 'tool-result', id: 'c1', at: 6000 },
    ];
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 100 }, at: 10000 };
    stampTurnRate(events, result, createTracker());
    // Ten wall seconds, five of them a tool run: a buffered flush of the
    // whole reply at the end reads 20 tok/sec, not 2000.
    assert.strictEqual(result.durationMs, 5000);
    assert.strictEqual(result.tokensPerSec, 20);
    assert.strictEqual(result.wallMs, 10000);
});

check('overlapping tools count once', () => {
    const events = [
        { type: 'user-message', text: 'go', at: 0 },
        { type: 'tool-call', id: 'c1', at: 1000 },
        { type: 'tool-call', id: 'c2', at: 2000 },
        { type: 'tool-result', id: 'c1', at: 4000 },
        { type: 'tool-result', id: 'c2', at: 5000 },
    ];
    assert.strictEqual(toolBusyMs(events, 0, 10000), 4000);
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 120 }, at: 10000 };
    stampTurnRate(events, result, createTracker());
    assert.strictEqual(result.durationMs, 6000);
    assert.strictEqual(result.tokensPerSec, 20);
});

check('a tool call never answered counts to the end of the turn', () => {
    const events = [
        { type: 'user-message', text: 'go', at: 0 },
        { type: 'tool-call', id: 'c1', at: 8000 },
    ];
    assert.strictEqual(toolBusyMs(events, 0, 10000), 2000);
});

check('tools from an earlier turn are not subtracted', () => {
    const events = [
        { type: 'user-message', text: 'first', at: 0 },
        { type: 'tool-call', id: 'c1', at: 1000 },
        { type: 'tool-result', id: 'c1', at: 9000 },
        { type: 'user-message', text: 'second', at: 20000 },
    ];
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 40 }, at: 22000 };
    stampTurnRate(events, result, createTracker());
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
    stampTurnRate([], result, createTracker());
    assert.strictEqual(result.tokensPerSec, undefined);
});

check('only the latest turn is measured', () => {
    const events = [
        { type: 'user-message', text: 'first', at: 1000 },
        { type: 'user-message', text: 'second', at: 9000 },
    ];
    const result = { type: 'result', subtype: 'success', usage: { output_tokens: 20 }, at: 11000 };
    stampTurnRate(events, result, createTracker());
    assert.strictEqual(result.durationMs, 2000);
    assert.strictEqual(result.tokensPerSec, 10);
});

check('a turn too fast to measure gets no number', () => {
    const result = stamped(0, 300, { usage: { output_tokens: 100 } });
    assert.strictEqual(result.tokensPerSec, undefined);
    assert.strictEqual(result.durationMs, undefined);
});

check('an absurd pace is a clock artifact, not a measurement', () => {
    const result = stamped(0, 1000, { usage: { output_tokens: 5000 } });
    assert.strictEqual(result.tokensPerSec, undefined);
    assert.strictEqual(result.durationMs, undefined);
});

check('deltas mark the turn streamed', () => {
    const tracker = createTracker();
    assert.strictEqual(tracker.sawDelta, false);
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    assert.strictEqual(tracker.sawDelta, true);
});

check('a new message restarts the timing', () => {
    const tracker = createTracker();
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    noteEvent(tracker, { type: 'user-message', at: 3000 });
    assert.strictEqual(tracker.sawDelta, false);
});

check('stamping spends the tracker for the next turn', () => {
    const tracker = createTracker();
    noteEvent(tracker, { type: 'text-delta', at: 1000 });
    stampTurnRate([], { type: 'result', usage: { output_tokens: 10 }, at: 3000 }, tracker);
    assert.strictEqual(tracker.sawDelta, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
