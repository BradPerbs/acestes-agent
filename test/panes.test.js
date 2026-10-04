/**
 * Carrying a pane to another pane's side, in the abstract.
 *
 * The conversation split view drags chats between slots, and the slots are
 * the same pane tree the terminals split. These are the tree operations a
 * drop boils down to: inserting before as well as after, moving (remove
 * then insert, so every share rule stays in one place), and swapping two
 * slots without touching the shape at all.
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

async function main() {
    const panes = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'lib', 'panes.js')).href);
    const { collectPanes, createPane, createSplit, insertPane, movePane, splitPane, swapPanes } = panes;

    console.log('panes');

    const orderOf = (root) => collectPanes(root).map((pane) => pane.title);
    const leaf = (title) => createPane({ title, mode: 'conversation' });

    check('inserting after on the same axis halves the target share', () => {
        const a = leaf('a');
        const b = leaf('b');
        const root = createSplit('row', [a, b]);
        const next = insertPane(root, a.id, 'row', leaf('x'));
        assert.deepStrictEqual(orderOf(next), ['a', 'x', 'b']);
        const sizes = next.sizes;
        assert.ok(Math.abs(sizes[0] - 0.25) < 1e-9);
        assert.ok(Math.abs(sizes[1] - 0.25) < 1e-9);
        assert.ok(Math.abs(sizes[2] - 0.5) < 1e-9);
    });

    check('inserting before on the same axis lands ahead of the target', () => {
        const a = leaf('a');
        const b = leaf('b');
        const root = createSplit('row', [a, b]);
        const next = insertPane(root, b.id, 'row', leaf('x'), true);
        assert.deepStrictEqual(orderOf(next), ['a', 'x', 'b']);
    });

    check('inserting across the axis subdivides only the target slot', () => {
        const a = leaf('a');
        const b = leaf('b');
        const root = createSplit('row', [a, b]);
        const next = insertPane(root, a.id, 'column', leaf('x'), true);
        assert.deepStrictEqual(orderOf(next), ['x', 'a', 'b']);
        assert.strictEqual(next.children[0].direction, 'column');
    });

    check('moving a pane docks it beside the target and frees its old slot', () => {
        const root = createSplit('row', [leaf('a'), leaf('b'), leaf('c')]);
        const bId = collectPanes(root)[1].id;
        const cId = collectPanes(root)[2].id;
        const next = movePane(root, cId, collectPanes(root)[0].id, 'row', true);
        assert.deepStrictEqual(orderOf(next), ['c', 'a', 'b']);
        assert.strictEqual(collectPanes(next).length, 3);
        void bId;
    });

    check('moving a pane onto itself or nowhere known changes nothing', () => {
        const root = createSplit('row', [leaf('a'), leaf('b')]);
        const aId = collectPanes(root)[0].id;
        assert.strictEqual(movePane(root, aId, aId, 'row'), root);
        assert.strictEqual(movePane(root, 'missing', aId, 'row'), root);
        assert.strictEqual(movePane(root, aId, 'missing', 'row'), root);
    });

    check('moving the last pane out collapses back to a single pane', () => {
        const a = leaf('a');
        const b = leaf('b');
        const root = createSplit('row', [a, b]);
        const next = movePane(root, a.id, b.id, 'column', true);
        assert.deepStrictEqual(orderOf(next), ['a', 'b']);
        assert.strictEqual(next.direction, 'column');
    });

    check('swapping exchanges the chats and keeps every share', () => {
        const root = createSplit('row', [leaf('a'), leaf('b'), leaf('c')]);
        const ids = collectPanes(root).map((pane) => pane.id);
        const before = [...root.sizes];
        const next = swapPanes(root, ids[0], ids[2]);
        assert.deepStrictEqual(orderOf(next), ['c', 'b', 'a']);
        assert.deepStrictEqual(next.sizes, before);
    });

    check('swapping with itself or an unknown pane changes nothing', () => {
        const root = createSplit('row', [leaf('a'), leaf('b')]);
        const aId = collectPanes(root)[0].id;
        assert.strictEqual(swapPanes(root, aId, aId), root);
        assert.strictEqual(swapPanes(root, aId, 'missing'), root);
    });

    check('splitPane still lands after the target, as before', () => {
        const a = leaf('a');
        const root = createSplit('row', [a, leaf('b')]);
        const next = splitPane(root, a.id, 'row', leaf('x'));
        assert.deepStrictEqual(orderOf(next), ['a', 'x', 'b']);
    });

    // Resolve one of our calc() strings against a parent of `size` px.
    const resolve = (css, size) => {
        const match = /calc\((-?[\d.]+)% \+ (-?[\d.]+)px\)/.exec(css);
        return (Number(match[1]) / 100) * size + Number(match[2]);
    };

    check('insetBoxStyle lands an outside overlay on the pane SplitLayout draws', () => {
        const { measureLayout, insetBoxStyle, DIVIDER_SIZE } = panes;
        const a = leaf('a');
        const b = leaf('b');
        const root = createSplit('row', [a, b], [0.5, 0.5]);
        const W = 1000;
        const H = 600;
        const I = 6;
        const inner = W - 2 * I;
        const box = measureLayout(root).panes.find((pane) => pane.id === b.id).box;
        const style = insetBoxStyle(box, I, 30);
        // Where SplitLayout puts b: inset, then a's half and the divider.
        const half = (inner - DIVIDER_SIZE) / 2;
        assert.ok(Math.abs(resolve(style.left, W) - (I + half + DIVIDER_SIZE)) < 0.05);
        assert.ok(Math.abs(resolve(style.width, W) - half) < 0.05);
        assert.ok(Math.abs(resolve(style.top, H) - (I + 30)) < 0.05);
        assert.ok(Math.abs(resolve(style.height, H) - (H - 2 * I - 30)) < 0.05);
    });

    if (failed > 0) {
        console.log(`panes: ${passed} passed, ${failed} failed`);
        process.exitCode = 1;
    } else {
        console.log(`panes: ${passed} passed`);
    }
}

main().catch((error) => {
    console.log(`  FAIL panes harness\n       ${error.message}`);
    process.exitCode = 1;
});
