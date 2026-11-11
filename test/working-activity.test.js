/**
 * The chat's working line: which state it shows, from the calls in the
 * transcript and what the draft says the model is doing. The words are the
 * component's; this checks the state and its key, which is what the clock
 * beside it counts from.
 *
 * The module is ESM for the bundler, so it is imported dynamically.
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

const user = { kind: 'user', id: 1, text: 'Check nginx' };
const call = (id, extra = {}) => ({ kind: 'tool', id, name: 'run_command', input: { command: `cmd ${id}` }, status: 'done', ...extra });
const draft = (activity = null) => ({ text: '', thinking: '', activity });

async function main() {
    const { workingActivity, DESKTOP_VERBS } = await import(
        pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'working-activity.js')).href
    );

    console.log('working activity');

    check('with nothing running and nothing said, it is waiting on the model', () => {
        const state = workingActivity([user, call('a')], draft());
        assert.strictEqual(state.kind, 'waiting');
        assert.strictEqual(state.key, 'waiting');
    });

    check('a running call is named, newest first, with how many others run beside it', () => {
        const items = [user, call('a', { status: 'running' }), call('b'), call('c', { status: 'running' })];
        const state = workingActivity(items, draft());
        assert.strictEqual(state.kind, 'tool');
        assert.strictEqual(state.call.id, 'c');
        assert.strictEqual(state.more, 1);
        assert.strictEqual(state.key, 'call:c');
    });

    check('a running call wins over what the draft says', () => {
        const state = workingActivity([user, call('a', { status: 'running' })], draft({ phase: 'thinking' }));
        assert.strictEqual(state.kind, 'tool');
    });

    check('a call from an earlier turn is not this turn\'s work', () => {
        const items = [call('old', { status: 'running' }), user];
        assert.strictEqual(workingActivity(items, draft()).kind, 'waiting');
    });

    check('summarising, writing a call and thinking each say so', () => {
        assert.strictEqual(workingActivity([user], draft({ phase: 'compacting' })).kind, 'compacting');
        const composing = workingActivity([user], draft({ phase: 'composing', tool: 'write_file' }));
        assert.strictEqual(composing.kind, 'composing');
        assert.strictEqual(composing.tool, 'write_file');
        assert.strictEqual(composing.key, 'composing:write_file');
        assert.strictEqual(workingActivity([user], draft({ phase: 'thinking' })).kind, 'thinking');
    });

    check('a subagent in the foreground is a subagent, not a call', () => {
        const items = [user, call('s', { name: 'Agent', status: 'running', task: { status: 'running', activity: 'Reading the repo' } })];
        const state = workingActivity(items, draft());
        assert.strictEqual(state.kind, 'subagent');
        assert.strictEqual(state.key, 'call:s');
    });

    check('a background subagent shows when the model has nothing else going', () => {
        const items = [user, call('s', { name: 'Agent', status: 'done', task: { status: 'running' } })];
        assert.strictEqual(workingActivity(items, draft()).kind, 'subagent');
        assert.strictEqual(workingActivity(items, draft({ phase: 'thinking' })).kind, 'thinking', 'the model at work comes first');
    });

    check('the key stays the same while the same work goes on', () => {
        const items = [user, call('a', { status: 'running' })];
        assert.strictEqual(workingActivity(items, draft()).key, workingActivity([...items], draft({ phase: 'thinking' })).key);
    });

    check('a draft from before activity existed reads as waiting', () => {
        assert.strictEqual(workingActivity([user], { text: '', thinking: '' }).kind, 'waiting');
        assert.strictEqual(workingActivity([user]).kind, 'waiting');
    });

    check('the desktop verbs are the buddy\'s keys', () => {
        assert.strictEqual(DESKTOP_VERBS.click, 'activity.clicking');
        assert.strictEqual(DESKTOP_VERBS.do_steps, 'activity.steps');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
