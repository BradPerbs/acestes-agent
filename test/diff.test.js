/**
 * The change an edit makes, worked out from the call's own arguments.
 *
 * The point of the module is that one rule covers every runtime, so most of
 * this is the same edit spelled the four ways the runtimes spell it.
 */
const path = require('path');
const assert = require('assert');

const diff = require(path.join(__dirname, '..', 'src', 'main', 'ai', 'diff'));

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

console.log('diff');

const shape = (change) => change.hunks.flatMap(hunk => hunk.lines.map(line => `${line.type[0]} ${line.text}`));

check('a changed line reads as one removed and one added, in place', () => {
    const change = diff.between('a\nb\nc', 'a\nB\nc');
    assert.strictEqual(change.added, 1);
    assert.strictEqual(change.removed, 1);
    assert.deepStrictEqual(shape(change), ['s a', 'r b', 'a B', 's c']);
});

check('an unchanged passage is no change at all, not an empty one', () => {
    assert.strictEqual(diff.between('same\ntext', 'same\ntext'), null);
});

check('the lines are numbered on both sides', () => {
    const change = diff.between('a\nb', 'a\nb\nc');
    const last = change.hunks[0].lines[change.hunks[0].lines.length - 1];
    assert.strictEqual(last.type, 'add');
    assert.strictEqual(last.before, null, 'an added line is on no line of the old file');
    assert.strictEqual(last.after, 3);
});

check('untouched stretches are dropped, leaving context around each change', () => {
    const before = Array.from({ length: 40 }, (unused, index) => `line ${index}`).join('\n');
    const after = before.replace('line 5', 'LINE 5').replace('line 30', 'LINE 30');
    const change = diff.between(before, after);
    assert.strictEqual(change.hunks.length, 2, 'two changes, two hunks, not forty lines');
    for (const hunk of change.hunks) {
        assert.ok(hunk.lines.length <= 2 + diff.CONTEXT * 2, 'a hunk is its change plus context');
    }
});

check('a change too big to read is reported as such rather than drawn', () => {
    const huge = Array.from({ length: diff.MAX_LINES + 10 }, (unused, index) => `line ${index}`).join('\n');
    const change = diff.between(huge, `${huge}\nmore`);
    assert.strictEqual(change.tooLarge, true);
    assert.deepStrictEqual(change.hunks, []);
});

check('the same edit is found however the runtime spells its tool', () => {
    const calls = [
        ['edit_file', { path: 'a.js', old: 'const a = 1;', new: 'const a = 2;' }],
        ['edit_local_file', { path: 'a.js', old: 'const a = 1;', new: 'const a = 2;' }],
        ['Edit', { file_path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }],
        ['edit', { filePath: 'a.js', oldString: 'const a = 1;', newString: 'const a = 2;' }],
        ['search_replace', { file_path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }],
        ['mcp__somewhere__edit', { file_path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }],
    ];
    for (const [name, input] of calls) {
        const change = diff.fromToolInput(name, input);
        assert.ok(change, `${name} is an edit`);
        assert.strictEqual(change.path, 'a.js', `${name} names its file`);
        assert.strictEqual(change.added, 1, `${name} adds one line`);
        assert.strictEqual(change.removed, 1, `${name} removes one line`);
        assert.strictEqual(change.partial, true, 'a passage, so the file\'s line numbers are not claimed');
    }
});

check('several passages in one call are one change with a hunk each', () => {
    const change = diff.fromToolInput('MultiEdit', {
        file_path: 'a.js',
        edits: [
            { old_string: 'one', new_string: 'ONE' },
            { old_string: 'two', new_string: 'TWO' },
        ],
    });
    assert.strictEqual(change.hunks.length, 2);
    assert.strictEqual(change.added, 2);
    assert.strictEqual(change.removed, 2);
});

check('a whole-file write is every line added, and says so', () => {
    const change = diff.fromToolInput('write_file', { path: 'new.js', content: 'one\ntwo\nthree' });
    assert.strictEqual(change.added, 3);
    assert.strictEqual(change.removed, 0);
    assert.strictEqual(change.whole, true);
    assert.strictEqual(diff.fromToolInput('write', { filePath: 'n.js', content: 'x' }).added, 1);
});

check('anything that is not an edit has no diff', () => {
    assert.strictEqual(diff.fromToolInput('Read', { file_path: 'a.js' }), null);
    assert.strictEqual(diff.fromToolInput('run_command', { command: 'ls' }), null);
    assert.strictEqual(diff.fromToolInput('Edit', { file_path: 'a.js', old_string: 'x', new_string: 'x' }), null);
    assert.strictEqual(diff.fromToolInput('Edit', null), null);
    assert.strictEqual(diff.fromToolInput('Edit', { file_path: 'a.js' }), null, 'nothing to compare');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
