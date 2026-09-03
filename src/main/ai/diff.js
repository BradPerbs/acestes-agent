/**
 * What an edit changed, as lines to draw.
 *
 * Every runtime edits files, and each spells its tool differently: our own
 * `edit_file`, Claude Code's `Edit` and `MultiEdit`, OpenCode's `edit`,
 * Grok's `search_replace`. All of them carry the same two things in their
 * arguments, the passage before and the passage after, so the change can be
 * worked out from the call itself without reading the file back. That is
 * what `fromToolInput` does, and what the transcript draws instead of two
 * blobs of JSON.
 *
 * The comparison is by line and nothing cleverer. A word-level diff reads
 * better on a one-character change and worse on everything else, and the
 * thing being answered here is "what did it just do to my file", which
 * lines answer.
 */

/** Above this, a diff is a wall rather than a thing to read. */
const MAX_LINES = 2000;
/** Lines of unchanged context kept around each run of changes. */
const CONTEXT = 3;

/**
 * Lines to compare. Empty is no lines rather than one empty line, so a new
 * file reads as every line added and not as one blank line replaced.
 */
const splitLines = (text) => {
    const body = String(text ?? '');
    return body === '' ? [] : body.split('\n');
};

/**
 * The longest common subsequence of two line arrays, as a list of steps.
 *
 * The plain dynamic-programming table, which is O(n*m) and fine at the size
 * a single edit is. Anything larger is cut off before it gets here.
 */
function lcsDiff(before, after) {
    const rows = before.length;
    const columns = after.length;
    // One row at a time would be enough for the length, but the walk back
    // needs the whole table, and at these sizes it costs nothing.
    const table = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1));
    for (let i = rows - 1; i >= 0; i -= 1) {
        for (let j = columns - 1; j >= 0; j -= 1) {
            table[i][j] = before[i] === after[j]
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    const steps = [];
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
        if (before[i] === after[j]) {
            steps.push({ type: 'same', text: before[i] });
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            steps.push({ type: 'remove', text: before[i] });
            i += 1;
        } else {
            steps.push({ type: 'add', text: after[j] });
            j += 1;
        }
    }
    while (i < rows) {
        steps.push({ type: 'remove', text: before[i] });
        i += 1;
    }
    while (j < columns) {
        steps.push({ type: 'add', text: after[j] });
        j += 1;
    }
    return steps;
}

/**
 * The steps, with long runs of unchanged lines dropped.
 *
 * Each hunk carries the line numbers it starts at on both sides, so the
 * lines can be numbered the way a diff on the command line numbers them.
 */
function toHunks(steps, { context = CONTEXT, startBefore = 1, startAfter = 1 } = {}) {
    const changed = steps.map(step => step.type !== 'same');
    const keep = steps.map((step, index) => {
        if (changed[index]) return true;
        for (let near = index - context; near <= index + context; near += 1) {
            if (changed[near]) return true;
        }
        return false;
    });

    const hunks = [];
    let current = null;
    let beforeLine = startBefore;
    let afterLine = startAfter;

    steps.forEach((step, index) => {
        const numbered = {
            type: step.type,
            text: step.text,
            before: step.type === 'add' ? null : beforeLine,
            after: step.type === 'remove' ? null : afterLine,
        };
        if (step.type !== 'add') beforeLine += 1;
        if (step.type !== 'remove') afterLine += 1;

        if (!keep[index]) {
            current = null;
            return;
        }
        if (!current) {
            current = { before: numbered.before ?? beforeLine, after: numbered.after ?? afterLine, lines: [] };
            hunks.push(current);
        }
        current.lines.push(numbered);
    });

    return hunks;
}

/** The change between two passages, or null when there is none. */
function between(before, after, options = {}) {
    const beforeLines = splitLines(before);
    const afterLines = splitLines(after);
    if (beforeLines.length + afterLines.length > MAX_LINES) {
        return {
            tooLarge: true,
            added: afterLines.length,
            removed: beforeLines.length,
            hunks: [],
        };
    }
    const steps = lcsDiff(beforeLines, afterLines);
    if (!steps.some(step => step.type !== 'same')) return null;
    return {
        added: steps.filter(step => step.type === 'add').length,
        removed: steps.filter(step => step.type === 'remove').length,
        hunks: toHunks(steps, options),
    };
}

/** The first value any of these keys has, as a string. */
function pick(input, keys) {
    for (const key of keys) {
        const value = input?.[key];
        if (typeof value === 'string') return value;
    }
    return undefined;
}

const PATH_KEYS = ['path', 'file_path', 'filePath', 'target_file', 'targetFile', 'file'];
const OLD_KEYS = ['old', 'old_string', 'oldString', 'old_str', 'search'];
const NEW_KEYS = ['new', 'new_string', 'newString', 'new_str', 'replace'];
const CONTENT_KEYS = ['content', 'contents', 'text', 'file_text'];

/** Tools that replace a file whole, across the runtimes. */
const WRITE_TOOLS = new Set(['write_file', 'write', 'create_file', 'write_local_file']);
/** Tools that replace a passage, across the runtimes. */
const EDIT_TOOLS = new Set([
    'edit_file', 'edit_local_file', 'edit', 'multiedit', 'search_replace', 'str_replace', 'apply_patch',
]);

/**
 * The change a tool call is about to make, from its arguments alone.
 *
 * Answers `{ path, added, removed, hunks }`, or null when the call is not
 * an edit or carries nothing to compare. A whole-file write has no before
 * to compare against, so it is reported as every line added, which is what
 * it is.
 */
function fromToolInput(toolName, input) {
    if (!input || typeof input !== 'object') return null;
    const bare = String(toolName || '').toLowerCase().replace(/^mcp__[^_]+__/, '');
    const path = pick(input, PATH_KEYS) || '';

    if (Array.isArray(input.edits) && input.edits.length > 0) {
        // MultiEdit: every passage in the one call, in order.
        const parts = input.edits
            .map(edit => between(pick(edit, OLD_KEYS) ?? '', pick(edit, NEW_KEYS) ?? ''))
            .filter(Boolean);
        if (parts.length === 0) return null;
        return {
            path,
            added: parts.reduce((total, part) => total + part.added, 0),
            removed: parts.reduce((total, part) => total + part.removed, 0),
            hunks: parts.flatMap(part => part.hunks),
            partial: true,
        };
    }

    const old = pick(input, OLD_KEYS);
    const next = pick(input, NEW_KEYS);
    if (old !== undefined && next !== undefined) {
        const change = between(old, next);
        if (!change) return null;
        // The passage, not the file: the line numbers of a hunk taken out of
        // the middle of a file would be wrong, so they are left off.
        return { path, ...change, partial: true };
    }

    if (WRITE_TOOLS.has(bare)) {
        const content = pick(input, CONTENT_KEYS);
        if (content === undefined) return null;
        const change = between('', content);
        if (!change) return null;
        return { path, ...change, whole: true };
    }

    if (!EDIT_TOOLS.has(bare)) return null;
    return null;
}

module.exports = { between, fromToolInput, MAX_LINES, CONTEXT, _test: { lcsDiff, toHunks } };
