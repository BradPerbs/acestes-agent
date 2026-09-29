/**
 * The transcript fold, held to the promises the panel's speed rests on.
 *
 * A long conversation stays quick because the fold leaves alone whatever an
 * event does not touch: a streamed word keeps the same list, a tool result
 * replaces one item and keeps the rest. Replaying a log and folding a batch
 * are shortcuts that change the list in place, so each is checked against
 * the plain one-event-at-a-time fold it stands in for.
 *
 * The module under test is ESM for the bundler, so it is imported
 * dynamically; everything else follows the repo's test style.
 */
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');

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

/** Frozen all the way down, so a fold that writes to its input throws. */
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

/** A turn with everything in it the transcript knows how to draw. */
function conversation() {
    let at = 1000;
    const next = event => ({ ...event, at: at++ });
    return [
        next({ type: 'user-message', text: 'Restart nginx on both' }),
        next({ type: 'text-delta', text: 'Checking ' }),
        next({ type: 'text-delta', text: 'first.' }),
        next({ type: 'tool-call', id: 't1', name: 'run_command', input: { command: 'systemctl status nginx', session: 's1' } }),
        next({ type: 'tool-call', id: 't2', name: 'run_command', input: { command: 'systemctl status nginx', session: 's2' } }),
        next({ type: 'approval-request', requestId: 'r1', name: 'run_command', input: { command: 'systemctl status nginx', session: 's2' }, sessionId: 's2' }),
        next({ type: 'tool-result', id: 't1', text: 'active (running)' }),
        next({ type: 'approval-settled', requestId: 'r1', status: 'approved' }),
        next({ type: 'tool-result', id: 't2', text: 'inactive', isError: true }),
        next({ type: 'question-request', requestId: 'q1', question: 'Restart it?', options: ['Yes', 'No'] }),
        next({ type: 'question-settled', requestId: 'q1', status: 'answered', answer: 'Yes' }),
        next({ type: 'assistant-text', text: 'Restarted web-02.' }),
        next({ type: 'turn-changes', turnId: 1000, files: [{ path: '/etc/nginx/nginx.conf', added: 1, removed: 1 }] }),
        next({ type: 'turn-reverted', turnId: 1000, reverted: ['/etc/nginx/nginx.conf'], failed: [] }),
        next({ type: 'result', costUsd: 0.01 }),
        next({ type: 'user-message', text: 'And the logs?' }),
        next({ type: 'thinking-delta', text: 'Look at journalctl' }),
        next({ type: 'tool-failed', name: 'read_file', message: 'no such file' }),
        next({ type: 'error', message: 'The run ended' }),
        next({ type: 'notice', text: 'Picked up after a restart.' }),
        next({ type: 'interrupted' }),
    ];
}

async function main() {
    const reducer = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'transcript-reducer.js')).href);
    const { INITIAL, applyEvent, applyBatch, replay } = reducer;
    const events = conversation();
    const oneByOne = events.reduce((state, event) => applyEvent(state, event), INITIAL);

    console.log('transcript reducer');

    check('replaying a log gives what folding it one event at a time gives', () => {
        assert.deepStrictEqual(replay(events), oneByOne);
    });

    check('replaying does not touch the shared starting state', () => {
        replay(events);
        assert.deepStrictEqual(INITIAL.items, []);
    });

    check('a batch gives what its events one at a time give, however it is cut', () => {
        for (const size of [1, 2, 3, 5, 8, events.length]) {
            let state = INITIAL;
            for (let from = 0; from < events.length; from += size) {
                state = applyBatch(state, events.slice(from, from + size));
            }
            assert.deepStrictEqual(state, oneByOne, `batches of ${size}`);
        }
    });

    check('neither a single event nor a batch writes to the state it was given', () => {
        const frozen = deepFreeze(replay(events.slice(0, 8)));
        const rest = events.slice(8);
        assert.doesNotThrow(() => rest.reduce((state, event) => applyEvent(state, event), frozen));
        assert.doesNotThrow(() => applyBatch(frozen, rest));
    });

    check('a streamed word leaves the list, and every item in it, as it was', () => {
        const state = replay(events.slice(0, 4));
        const after = applyEvent(state, { type: 'text-delta', text: 'more', at: 1 });
        assert.strictEqual(after.items, state.items);
        assert.strictEqual(after.draft.text, 'more');
    });

    check('a result replaces its own item and keeps every other one', () => {
        const state = replay(events.slice(0, 6));
        const after = applyEvent(state, { type: 'tool-result', id: 't1', text: 'ok', at: 1 });
        assert.notStrictEqual(after.items, state.items);
        const changed = after.items.filter((item, index) => item !== state.items[index]);
        assert.strictEqual(changed.length, 1);
        assert.strictEqual(changed[0].id, 't1');
        assert.strictEqual(changed[0].status, 'done');
    });

    check('a result lands on the call it answers, not the newest one', () => {
        const state = replay(events.slice(0, 5));
        const after = applyEvent(state, { type: 'tool-result', id: 't1', text: 'ok', at: 1 });
        assert.strictEqual(after.items.find(item => item.id === 't1').status, 'done');
        assert.strictEqual(after.items.find(item => item.id === 't2').status, 'running');
    });

    check('fragments merged into one are drawn exactly as the fragments were', () => {
        // The main process keeps a streaming block as one growing fragment
        // in the log; replaying that must match having watched it stream.
        const apart = replay([
            { type: 'user-message', text: 'hi', at: 1 },
            { type: 'text-delta', text: 'Hel', at: 2 },
            { type: 'text-delta', text: 'lo', at: 3 },
            { type: 'tool-call', id: 'x', name: 'list_hosts', input: {}, at: 4 },
        ]);
        const merged = replay([
            { type: 'user-message', text: 'hi', at: 1 },
            { type: 'text-delta', text: 'Hello', at: 2 },
            { type: 'tool-call', id: 'x', name: 'list_hosts', input: {}, at: 4 },
        ]);
        assert.deepStrictEqual(merged, apart);
        assert.strictEqual(merged.items[1].text, 'Hello');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
