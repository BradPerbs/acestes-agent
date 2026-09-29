/**
 * Just enough markdown for a reply in a side panel.
 *
 * A library was not worth it here. The assistant writes prose, short lists and
 * code blocks, and that is the whole grammar this needs; the alternative was a
 * dependency whose main feature, HTML passthrough, is the one thing we would
 * have had to turn off anyway.
 *
 * Everything is built as React elements. Nothing goes near
 * dangerouslySetInnerHTML: the text here is model output that has quoted
 * arbitrary log lines and file contents from a server, and that is precisely
 * the input you do not hand to an HTML parser.
 *
 * The one thing here that is not self-contained is the copy button on a code
 * block, which is the same control the tool rows and approval cards use. A
 * second copy of it living in this file would be the worse trade.
 */

import { memo } from 'react';
import CopyButton from '../components/ui/CopyButton';

const FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;

/**
 * The rule under a table's header: `|---|---|`, `| :-- | --: |`, and so on.
 *
 * This is the whole of what makes a table a table. A line with pipes in it is
 * just a sentence with pipes in it, which is why the header row is never
 * matched on its own: the rule underneath is the thing that says the line above
 * it was a header, and the two are only believed together, with the same number
 * of cells in each.
 */
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Inline spans: code first, so nothing inside backticks is styled further. */
function inline(text, keyPrefix) {
    const nodes = [];
    // Code, bold, then italic. Ordered so `**` is never mistaken for two `*`.
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)/g;
    let last = 0;
    let match;
    let index = 0;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) {
            nodes.push(text.slice(last, match.index));
        }
        const token = match[0];
        const key = `${keyPrefix}-i${index++}`;

        if (token.startsWith('`')) {
            nodes.push(
                <code
                    key={key}
                    className="px-1 py-0.5 rounded bg-gray-900/[0.06] dark:bg-white/10 font-jetbrains text-[0.85em] break-words"
                >
                    {token.slice(1, -1)}
                </code>
            );
        } else if (token.startsWith('**') || token.startsWith('__')) {
            nodes.push(<strong key={key} className="font-semibold">{token.slice(2, -2)}</strong>);
        } else {
            nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
        }
        last = match.index + token.length;
    }

    if (last < text.length) nodes.push(text.slice(last));
    return nodes.length > 0 ? nodes : [text];
}

function CodeBlock({ code, language }) {
    return (
        <div className="group relative [&:not(:first-child)]:mt-2 rounded-lg overflow-hidden
            border border-gray-200 dark:border-surface-control">
            {language && (
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-surface-base border-b border-gray-200 dark:border-surface-control">
                    {language}
                </div>
            )}

            {/* Most of what lands in one of these is a command somebody is
                about to run, so it is worth a click rather than a careful
                drag across three wrapped lines. Pinned to the block rather
                than dropped in the language bar, because half of them arrive
                with no language on the fence and would have nowhere to sit. */}
            <CopyButton
                text={code}
                label="Copy code"
                className={`absolute right-1 ${language ? 'top-1' : 'top-1.5'}`}
            />

            {/* The block scrolls on its own rather than widening the panel: a
                long command line must not push the whole conversation sideways. */}
            <pre className="px-3 py-2 overflow-x-auto bg-gray-50 dark:bg-surface-base">
                <code className="font-jetbrains text-xs leading-relaxed whitespace-pre">{code}</code>
            </pre>
        </div>
    );
}

/**
 * One row's cells.
 *
 * Split on pipes, with the border pair at each end dropped as delimiters rather
 * than as empty cells: `| | b |` is a blank first column, not a single column
 * called `b`. A pipe that is part of the text is written `\|` and is put back
 * here, which is the only escape this needs to understand.
 */
function splitCells(line) {
    let text = line.trim();
    if (text.startsWith('|')) text = text.slice(1);
    if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);

    const cells = [];
    let current = '';

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\\' && text[index + 1] === '|') {
            current += '|';
            index += 1;
        } else if (text[index] === '|') {
            cells.push(current);
            current = '';
        } else {
            current += text[index];
        }
    }
    cells.push(current);

    return cells.map(cell => cell.trim());
}

/** Which way a column is set, from the colons on its rule cell. */
function alignmentOf(cell) {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'text-center';
    if (right) return 'text-right';
    return 'text-left';
}

/** A short row is padded and a long one is cut, so every row is one width. */
function fitRow(cells, width) {
    const row = cells.slice(0, width);
    while (row.length < width) row.push('');
    return row;
}

/**
 * A table, sized for a side panel.
 *
 * The table takes the panel's width and its cells wrap, rather than running to
 * their natural width and scrolling: what the assistant puts in a table here is
 * usually sentences (a host and what is wrong with it), and a column of prose
 * that has to be scrolled sideways one line at a time is worse than a narrow
 * one that wraps. The wrapper still scrolls, for the table with six columns
 * that cannot be squeezed into 340px however hard it wraps.
 */
function Table({ header, rows, align }) {
    return (
        <div className="[&:not(:first-child)]:mt-2 overflow-x-auto rounded-lg
            border border-gray-200 dark:border-surface-control">
            <table className="w-full border-collapse text-[12px] leading-snug">
                <thead>
                    <tr className="bg-gray-50 dark:bg-surface-base">
                        {header.map((cell, column) => (
                            <th
                                key={`th${column}`}
                                scope="col"
                                className={`px-2.5 py-1.5 align-top break-words font-semibold
                                    text-gray-900 dark:text-white ${align[column]}`}
                            >
                                {inline(cell, `th${column}`)}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr
                            key={`tr${index}`}
                            className="border-t border-gray-200 dark:border-surface-control"
                        >
                            {row.map((cell, column) => (
                                <td
                                    key={`td${index}-${column}`}
                                    className={`px-2.5 py-1.5 align-top break-words ${align[column]}`}
                                >
                                    {inline(cell, `td${index}-${column}`)}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** Group consecutive list lines so a list renders as one element. */
function flushList(items, ordered, key) {
    if (items.length === 0) return null;
    const className = '[&:not(:first-child)]:mt-2 pl-5 space-y-1 ' + (ordered ? 'list-decimal' : 'list-disc');
    const children = items.map((item, index) => (
        <li key={`${key}-li${index}`} className="pl-0.5">{inline(item, `${key}-li${index}`)}</li>
    ));
    return ordered
        ? <ol key={key} className={className}>{children}</ol>
        : <ul key={key} className={className}>{children}</ul>;
}

/**
 * The text as a list of blocks, each with a signature of what it holds.
 *
 * Kept apart from the drawing so a reply that is still streaming in can be
 * drawn block by block: every frame adds a few letters to the last block and
 * none to the others, and a block whose signature has not moved is not drawn
 * again. Parsing is a pass over the lines, which is cheap; building the
 * elements for every paragraph of a long reply sixty times a second was not.
 */
function parse(text) {
    const lines = String(text).split('\n');
    const blocks = [];

    let listItems = [];
    let listOrdered = false;
    let paragraph = [];

    const closeList = () => {
        if (listItems.length === 0) return;
        blocks.push({ kind: 'list', ordered: listOrdered, items: listItems, sig: `${listOrdered}\u0000${listItems.join('\u0000')}` });
        listItems = [];
    };

    const closeParagraph = () => {
        if (paragraph.length === 0) return;
        const body = paragraph.join(' ');
        blocks.push({ kind: 'p', text: body, sig: body });
        paragraph = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = line.match(FENCE);

        if (fence) {
            closeParagraph();
            closeList();
            const language = fence[1] || '';
            const collected = [];
            index += 1;
            while (index < lines.length && !FENCE.test(lines[index])) {
                collected.push(lines[index]);
                index += 1;
            }
            const code = collected.join('\n');
            blocks.push({ kind: 'code', code, language, sig: `${language}\u0000${code}` });
            continue;
        }

        if (!line.trim()) {
            closeParagraph();
            closeList();
            continue;
        }

        // A table, if the line under this one is a rule of the same width.
        // Checked before the block kinds below, because a header row is
        // otherwise indistinguishable from a paragraph with pipes in it.
        if (line.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1])) {
            const header = splitCells(line);
            const rule = splitCells(lines[index + 1]);

            if (header.length > 1 && header.length === rule.length) {
                closeParagraph();
                closeList();

                const rows = [];
                const start = index;
                index += 2;
                // Runs to the blank line that ends the block, or to the first
                // line with no pipe in it: the assistant writes a sentence
                // straight under a table often enough that swallowing it as a
                // one-cell row would be the more surprising reading.
                while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
                    rows.push(fitRow(splitCells(lines[index]), header.length));
                    index += 1;
                }
                blocks.push({
                    kind: 'table',
                    header,
                    rows,
                    align: rule.map(alignmentOf),
                    sig: lines.slice(start, index).join('\n'),
                });
                index -= 1;
                continue;
            }
        }

        const heading = line.match(HEADING);
        if (heading) {
            closeParagraph();
            closeList();
            blocks.push({ kind: 'h', text: heading[2], sig: heading[2] });
            continue;
        }

        const bullet = line.match(BULLET);
        const numbered = line.match(NUMBERED);
        if (bullet || numbered) {
            closeParagraph();
            const ordered = Boolean(numbered);
            if (listItems.length > 0 && ordered !== listOrdered) closeList();
            listOrdered = ordered;
            listItems.push(ordered ? numbered[2] : bullet[1]);
            continue;
        }

        closeList();
        paragraph.push(line.trim());
    }

    closeParagraph();
    closeList();
    return blocks;
}

/** One block, drawn again only when what it holds has changed. */
const Block = memo(function Block({ block, prefix }) {
    switch (block.kind) {
        case 'code':
            return <CodeBlock code={block.code} language={block.language} />;
        case 'table':
            return <Table header={block.header} rows={block.rows} align={block.align} />;
        case 'h':
            return (
                <div className="[&:not(:first-child)]:mt-3 mb-1 font-semibold text-gray-900 dark:text-white">
                    {inline(block.text, prefix)}
                </div>
            );
        case 'list':
            return flushList(block.items, block.ordered, prefix);
        default:
            return <p className="[&:not(:first-child)]:mt-2 break-words">{inline(block.text, prefix)}</p>;
    }
}, (previous, next) => previous.block.sig === next.block.sig
    && previous.block.kind === next.block.kind
    && previous.prefix === next.prefix);

function Markdown({ text = '' }) {
    const blocks = parse(text);

    // Sized for a side panel rather than a page: 13px at a generous line height
    // reads better in a 400px column than the app's 14px body text.
    return (
        <div className="text-[13px] leading-[1.65] text-gray-700 dark:text-gray-200">
            {blocks.map((block, index) => (
                <Block key={`${block.kind}${index}`} block={block} prefix={`b${index}`} />
            ))}
        </div>
    );
}

/**
 * Drawn again only when the text changes: a finished reply in a long
 * transcript is never parsed twice.
 */
export default memo(Markdown);
