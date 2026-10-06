/**
 * Find in a conversation: the parts that take no DOM.
 *
 * The query as a pattern (plain, whole word, regex, case), the matches in the
 * joined transcript text, mapping a match's ends back onto the text node they
 * fall in (across the separators put between blocks), and which match a new
 * search starts on. The module is ESM for the bundler, so it is imported
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

async function main() {
    const {
        buildPattern, findSpans, locate, nearestIndex, FIND_LIMIT,
    } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'transcript-find.js')).href);

    const spans = (text, query, options) => findSpans(text, buildPattern(query, options)).spans;

    console.log('\ntranscript find: patterns');

    check('an empty query is no pattern', () => {
        assert.strictEqual(buildPattern('', {}), null);
        assert.deepStrictEqual(findSpans('anything', null), { spans: [], more: false });
    });

    check('plain text is literal, regex characters and all', () => {
        assert.deepStrictEqual(spans('run (a.b) or aXb', '(a.b)'), [[4, 9]]);
        assert.deepStrictEqual(spans('C:\\Users\\brad', 'C:\\Users'), [[0, 8]]);
    });

    check('case is ignored unless asked for', () => {
        assert.deepStrictEqual(spans('Nginx nginx NGINX', 'nginx'), [[0, 5], [6, 11], [12, 17]]);
        assert.deepStrictEqual(spans('Nginx nginx NGINX', 'nginx', { caseSensitive: true }), [[6, 11]]);
    });

    check('a space in the query matches any run of whitespace', () => {
        assert.deepStrictEqual(spans('restart the\n  service', 'the service'), [[8, 21]]);
    });

    check('whole word skips a match inside a longer word', () => {
        assert.deepStrictEqual(spans('log logs catalog log_x log.', 'log', { wholeWord: true }), [[0, 3], [23, 26]]);
    });

    check('whole word knows letters past ASCII', () => {
        assert.deepStrictEqual(spans('café cafés', 'café', { wholeWord: true }), [[0, 4]]);
    });

    check('a regex is a regex', () => {
        assert.deepStrictEqual(spans('exit 0, exit 127', 'exit \\d+', { regex: true }), [[0, 6], [8, 16]]);
    });

    check('a regex only valid without the u flag still runs', () => {
        assert.deepStrictEqual(spans('{"a": 1}', '{"a"', { regex: true }), [[0, 4]]);
    });

    check('an unfinished regex throws, for the bar to call a bad pattern', () => {
        assert.throws(() => buildPattern('(unclosed', { regex: true }));
        assert.throws(() => buildPattern('[a-', { regex: true }));
    });

    check('empty matches are stepped over, not looped on', () => {
        assert.deepStrictEqual(spans('aa b aaa', 'a*', { regex: true }), [[0, 2], [5, 8]]);
    });

    check('the limit cuts the list and says so', () => {
        const text = 'x '.repeat(FIND_LIMIT + 5);
        const found = findSpans(text, buildPattern('x', {}));
        assert.strictEqual(found.spans.length, FIND_LIMIT);
        assert.strictEqual(found.more, true);
        assert.strictEqual(findSpans('x x', buildPattern('x', {})).more, false);
    });

    console.log('\ntranscript find: offsets to nodes');

    // "abc" + "\n" + "def" + "gh": three nodes, a block break after the first.
    const starts = [0, 4, 7];
    const lengths = [3, 3, 2];

    check('an offset inside a node maps into it', () => {
        assert.deepStrictEqual(locate(starts, lengths, 1, 'start'), { index: 0, at: 1 });
        assert.deepStrictEqual(locate(starts, lengths, 5, 'start'), { index: 1, at: 1 });
        assert.deepStrictEqual(locate(starts, lengths, 8, 'end'), { index: 2, at: 1 });
    });

    check('an end on a node boundary stays at the end of that node', () => {
        assert.deepStrictEqual(locate(starts, lengths, 3, 'end'), { index: 0, at: 3 });
        assert.deepStrictEqual(locate(starts, lengths, 9, 'end'), { index: 2, at: 2 });
    });

    check('two nodes that run on: a boundary starts the next one', () => {
        assert.deepStrictEqual(locate(starts, lengths, 7, 'start'), { index: 2, at: 0 });
    });

    check('a start in the separator moves on to the next node', () => {
        assert.deepStrictEqual(locate(starts, lengths, 3, 'start'), { index: 1, at: 0 });
    });

    check('nothing to move on to past the last node', () => {
        assert.strictEqual(locate(starts, lengths, 9, 'start'), null);
        assert.strictEqual(locate([], [], 0, 'start'), null);
    });

    console.log('\ntranscript find: where a new search starts');

    // Twenty matches, one every 100px; the view shows 1000 to 1300.
    const rows = Array.from({ length: 20 }, (_, i) => ({ top: i * 100, bottom: i * 100 + 20 }));
    let measured = 0;
    const measure = (i) => {
        measured += 1;
        return rows[i];
    };

    check('a match on screen is the one', () => {
        measured = 0;
        assert.strictEqual(nearestIndex(rows.length, measure, 1000, 1300), 10);
        assert.ok(measured <= 8, `measured ${measured} matches, expected a binary search`);
    });

    check('with none on screen, the nearest above', () => {
        assert.strictEqual(nearestIndex(rows.length, measure, 1030, 1090), 10);
        assert.strictEqual(nearestIndex(rows.length, measure, 5000, 5300), 19);
    });

    check('with every match below, the first of them', () => {
        assert.strictEqual(nearestIndex(rows.length, measure, -500, -100), 0);
    });

    check('no matches, no index', () => {
        assert.strictEqual(nearestIndex(0, measure, 0, 100), -1);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
