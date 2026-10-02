/**
 * How the transcript folds its items into rows.
 *
 * Back-to-back tool calls fold into one group. A thought (narration or
 * thinking) stands outside, ends the group above it, and the calls after it
 * start a new one. The module is ESM for the bundler, so it is imported
 * dynamically, as in the reducer's test.
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

const SUBAGENTS = new Set(['Agent', 'Task']);
const tool = (id, name = 'read_file', extra = {}) => ({ kind: 'tool', id, name, status: 'done', ...extra });
const said = (id, text, thinking = '') => ({ kind: 'assistant', id, text, thinking });
const user = id => ({ kind: 'user', id, text: 'hi' });

/** The rows as short labels: an item's id, or a group as kind[ids]. */
const shape = rows => rows.map(row => (row.items ? `${row.kind}[${row.items.map(item => item.id).join(',')}]` : row.id));

async function main() {
    const { groupRows } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'group-rows.js')).href);
    const fold = (items, options = {}) => groupRows(items, { subagentTools: SUBAGENTS, ...options });

    console.log('\ngroup rows');

    check('a thought between calls stands outside and starts a new group', () => {
        const { rows } = fold([
            user('u'), tool('t1'), tool('t2'), said('a1', 'Now the config.'), tool('t3'), tool('t4'), said('a2', 'Done.'),
        ]);
        assert.deepStrictEqual(shape(rows), ['u', 'tools[t1,t2]', 'a1', 'tools[t3,t4]', 'a2']);
    });

    check('thinking with no words splits the run the same way', () => {
        const { rows } = fold([tool('t1'), tool('t2'), said('a1', '', 'hmm'), tool('t3'), tool('t4')]);
        assert.deepStrictEqual(shape(rows), ['tools[t1,t2]', 'a1', 'tools[t3,t4]']);
    });

    check('a lone call between thoughts stays its own row', () => {
        const { rows } = fold([said('a0', 'Looking.'), tool('t1'), said('a1', 'Next.'), tool('t2'), tool('t3')]);
        assert.deepStrictEqual(shape(rows), ['a0', 't1', 'a1', 'tools[t2,t3]']);
    });

    check('an empty assistant message does not split a run', () => {
        const { rows } = fold([tool('t1'), said('a1', '  '), tool('t2'), tool('t3')]);
        assert.deepStrictEqual(shape(rows), ['tools[t1,t2,t3]']);
    });

    check('a call waiting on approval ends the group above it', () => {
        const pending = tool('t3', 'run_command', { approval: { status: 'pending' } });
        const { rows } = fold([tool('t1'), tool('t2'), pending, tool('t4'), tool('t5')]);
        assert.deepStrictEqual(shape(rows), ['tools[t1,t2]', 't3', 'tools[t4,t5]']);
    });

    check('back-to-back subagent calls fold into one subagents group', () => {
        const { rows } = fold([tool('t1'), tool('s1', 'Agent'), tool('s2', 'Task'), tool('t2'), tool('t3')]);
        assert.deepStrictEqual(shape(rows), ['t1', 'subagents[s1,s2]', 'tools[t2,t3]']);
    });

    check('switched off, calls are not grouped but subagents still are', () => {
        const items = [tool('t1'), tool('t2'), said('a1', '', ''), tool('s1', 'Agent'), tool('s2', 'Agent')];
        const { rows } = fold(items, { enabled: false });
        assert.deepStrictEqual(shape(rows), ['t1', 't2', 'a1', 'subagents[s1,s2]']);
    });

    check('a group is the same object while its members are, a new one once one changes', () => {
        const t1 = tool('t1');
        const t2 = tool('t2');
        const first = fold([t1, t2]);
        const again = fold([t1, t2], { previous: first.kept });
        assert.strictEqual(again.rows[0], first.rows[0]);
        const changed = fold([t1, { ...t2, status: 'error' }], { previous: again.kept });
        assert.notStrictEqual(changed.rows[0], first.rows[0]);
        assert.strictEqual(changed.rows[0].id, first.rows[0].id, 'same id, so the row keeps its open state');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
