/**
 * Find in a conversation.
 *
 * This searches what the transcript has drawn, not the items behind it, for
 * the same reason the settings search does: the words on screen are the ones
 * the user is looking for, already formatted, already translated, and a
 * markdown reply's source is not what anyone remembers reading. It is what
 * Ctrl+F means in every browser, and it has the same edge: a tool call's
 * output is only searched while it is open, because until then it is not
 * drawn at all.
 *
 * Every row is in the document, even off screen (see Transcript), so one walk
 * of the scroller finds everything that has been loaded. The matches are marked
 * with the CSS Custom Highlight API rather than <mark> elements: the rows
 * belong to React, and anything spliced into them would be lost, or worse, on
 * their next render.
 *
 * The pure parts (the pattern, the matching, mapping an offset back to a text
 * node) take no DOM, so they can be tested in node.
 */

/** More than anyone will step through, and few enough to paint at once. */
export const FIND_LIMIT = 2000;

/** Marked on anything inside the transcript that is chrome rather than content. */
export const FIND_SKIP = 'data-find-skip';

/** The scroller the rows are drawn in; see AssistantConversation. */
export const TRANSCRIPT = '[data-transcript]';

/**
 * Sent to the scroller before find moves it. Going to a match is the reader
 * leaving the bottom, as a wheel turned up is, and the conversation has to
 * know before the next streamed word pins the view back down.
 */
export const TRANSCRIPT_HOLD = 'transcript-hold';

const SPECIAL = /[.*+?^${}()|[\]\\]/g;

/**
 * The query as a global RegExp, or null for an empty one. Throws on a pattern
 * that does not compile, which is someone halfway through typing a regex.
 *
 * A plain query matches any run of whitespace where it has a space: a reply
 * wrapped over two lines, or two words with a code span between them, still
 * reads as "one two" to the person searching for it.
 *
 * Compiled with the `u` flag where the pattern allows it, so case folding and
 * word boundaries understand more than ASCII. A regex that is only valid
 * without it (a lone `{`, say) is still taken, with ASCII word boundaries.
 */
export function buildPattern(query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
    if (!query) return null;
    const source = regex
        ? query
        : query.replace(SPECIAL, '\\$&').replace(/\s+/g, '\\s+');
    const flags = caseSensitive ? 'g' : 'gi';

    try {
        return new RegExp(
            wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source,
            `${flags}u`,
        );
    } catch {
        // Fall through to the forgiving dialect.
    }
    return new RegExp(wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, flags);
}

/**
 * Every match of `pattern` in `text` as `[start, end]`, in order, up to
 * `limit`. `more` says the limit cut it short. Empty matches are stepped over:
 * `a*` matches nothing everywhere, and nothing is not something to show.
 */
export function findSpans(text, pattern, limit = FIND_LIMIT) {
    const spans = [];
    if (!pattern || !text) return { spans, more: false };

    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
        if (match[0].length === 0) {
            pattern.lastIndex += 1;
        } else {
            if (spans.length === limit) return { spans, more: true };
            spans.push([match.index, match.index + match[0].length]);
        }
        match = pattern.exec(text);
    }
    return { spans, more: false };
}

/**
 * Which piece an offset into the joined text falls in, and where within it.
 *
 * `starts` are each piece's offset in the joined text and `lengths` their
 * lengths; between pieces there can be a separator that belongs to neither.
 * An offset in such a gap moves forward to the next piece when it starts a
 * match and back to the end of the last one when it ends one, so a match is
 * never drawn over a separator that is not there on screen. Null when there
 * is nowhere to move to.
 */
export function locate(starts, lengths, offset, edge = 'start') {
    let low = 0;
    let high = starts.length - 1;
    if (high < 0) return null;

    // The last piece starting at or before the offset.
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (starts[mid] <= offset) low = mid;
        else high = mid - 1;
    }
    const index = low;
    if (offset < starts[index]) {
        return edge === 'start' ? { index, at: 0 } : null;
    }

    const within = offset - starts[index];
    if (within < lengths[index] || (edge === 'end' && within === lengths[index])) {
        return { index, at: within };
    }
    // In the gap after this piece.
    if (edge === 'end') return { index, at: lengths[index] };
    return index + 1 < starts.length ? { index: index + 1, at: 0 } : null;
}

/**
 * The index to start on for a new query: a match on screen if there is one,
 * otherwise the nearest above, since in a conversation what you are looking
 * for is almost always something already said. Only when every match is
 * below is it the first of those.
 *
 * `measure(i)` gives match i's `{ top, bottom }`. Matches come in document
 * order, which in a column of rows is also top to bottom, so this is a binary
 * search and only a handful of them are ever measured.
 */
export function nearestIndex(count, measure, viewTop, viewBottom) {
    if (count === 0) return -1;
    let low = 0;
    let high = count;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (measure(mid).bottom <= viewTop) low = mid + 1;
        else high = mid;
    }
    if (low < count && measure(low).top < viewBottom) return low;
    return low > 0 ? low - 1 : 0;
}

/* ------------------------------------------------------------------ *
 * The DOM side
 * ------------------------------------------------------------------ */

const HTML = 'http://www.w3.org/1999/xhtml';

/** Fields hold what is being typed, not what was said. */
const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/**
 * What separates two pieces of text that do not run on from each other. A
 * paragraph's last word and the next one's first are not one word, and a
 * whole-word search for the second should find it.
 */
const BLOCKS = 'p,div,li,td,th,pre,h1,h2,h3,h4,h5,h6,blockquote,tr,dt,dd,summary,figcaption,table,ul,ol';

/**
 * The transcript's text, joined, with the node each piece came from.
 *
 * Skipped: fields, SVG (icons and charts), anything aria-hidden (decoration,
 * gutters, the phrase on its way out), and anything marked FIND_SKIP. A <br>
 * and a change of block both put a newline between the pieces either side.
 */
export function collectText(root) {
    const nodes = [];
    const starts = [];
    const lengths = [];
    let text = '';
    if (!root) return { text, nodes, starts, lengths };

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            if (node.nodeType === Node.TEXT_NODE) {
                return node.data.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
            if (node.namespaceURI !== HTML || SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
            if (node.hasAttribute(FIND_SKIP) || node.getAttribute('aria-hidden') === 'true') {
                return NodeFilter.FILTER_REJECT;
            }
            return node.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    });

    let block = null;
    let broken = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType !== Node.TEXT_NODE) {
            broken = true;
            continue;
        }
        const own = node.parentElement?.closest(BLOCKS) || null;
        if (nodes.length && (broken || own !== block)) text += '\n';
        block = own;
        broken = false;

        nodes.push(node);
        starts.push(text.length);
        lengths.push(node.data.length);
        text += node.data;
    }
    return { text, nodes, starts, lengths };
}

/** The spans as Ranges over the nodes they came from. */
export function toRanges(collected, spans) {
    const { nodes, starts, lengths } = collected;
    const ranges = [];
    for (const [from, to] of spans) {
        const start = locate(starts, lengths, from, 'start');
        const end = locate(starts, lengths, to, 'end');
        if (!start || !end) continue;
        if (end.index < start.index || (end.index === start.index && end.at <= start.at)) continue;

        const range = new Range();
        range.setStart(nodes[start.index], start.at);
        range.setEnd(nodes[end.index], end.at);
        ranges.push(range);
    }
    return ranges;
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/** See `::highlight` in input.css. */
const ALL = 'conversation-find';
const CURRENT = 'conversation-find-current';

/**
 * A highlight name is one per document, and two panes of a split can each
 * have a search open, so each search paints as an owner and the highlights
 * are rebuilt from every owner's ranges.
 */
const painted = new Map();

const supported = () => typeof window !== 'undefined'
    && Boolean(window.CSS?.highlights)
    && typeof Highlight !== 'undefined';

function repaint(which) {
    if (!supported()) return;
    const name = which === 'current' ? CURRENT : ALL;
    const ranges = [];
    for (const entry of painted.values()) {
        if (which === 'current') {
            if (entry.current) ranges.push(entry.current);
        } else {
            ranges.push(...entry.ranges);
        }
    }
    if (!ranges.length) {
        CSS.highlights.delete(name);
        return;
    }
    const highlight = new Highlight(...ranges);
    // Over the others where they overlap, whatever order they were set in.
    if (which === 'current') highlight.priority = 1;
    CSS.highlights.set(name, highlight);
}

/** Marks every match one search found. */
export function paintMatches(owner, ranges) {
    const entry = painted.get(owner) || { ranges: [], current: null };
    entry.ranges = ranges;
    painted.set(owner, entry);
    repaint('all');
}

/** Marks the one it is on. */
export function paintCurrent(owner, range) {
    const entry = painted.get(owner) || { ranges: [], current: null };
    entry.current = range || null;
    painted.set(owner, entry);
    repaint('current');
}

/** Takes one search's marks down, leaving any other pane's. */
export function clearMatches(owner) {
    if (!painted.delete(owner)) return;
    repaint('all');
    repaint('current');
}
