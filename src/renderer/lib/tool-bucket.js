/**
 * What a tool call is, in one word, for the transcript row.
 *
 * The row leads with a verb and an icon ("Read package.json", "Run npm
 * test") rather than the tool's raw name, so a burst of calls scans like
 * the reference timeline: the kind of action first, the target after it.
 * Anything this does not recognise gets no verb, and the row falls back to
 * the tool name it always showed.
 */

/** Which summary bucket a tool belongs in, by name. Lower-cased. */
export function toolBucket(name = '') {
    const lower = String(name || '').toLowerCase();
    if (!lower) return 'other';
    // Edits first: an "edit" that also mentions a file is still an edit.
    if (lower.includes('edit') || lower.includes('write') || lower.includes('apply_patch')
        || lower.includes('replace') || lower.startsWith('save_') || lower.startsWith('delete_')
        || lower === 'create' || lower === 'todowrite' || lower === 'todo') return 'edits';
    if (lower.includes('search') || lower === 'grep' || lower === 'glob' || lower === 'find'
        || lower === 'recall' || lower === 'lookup' || lower.startsWith('search_')) return 'searches';
    if (lower.includes('run') || lower.includes('exec') || lower.includes('bash')
        || lower.includes('command') || lower.includes('shell') || lower.includes('terminal')
        || lower === 'send_input' || lower === 'type_text' || lower === 'press_keys') return 'commands';
    if (lower.includes('read') || lower.includes('list') || lower.includes('view')
        || lower.includes('cat') || lower === 'ls'
        || lower.startsWith('list_') || lower.startsWith('read_')) return 'views';
    return 'other';
}

/** The todo tools, which get their own verb and progress instead of "Edit". */
const TODO_TOOLS = new Set(['todowrite', 'todo_write', 'todo']);

/**
 * The row's verb and icon, or null when the tool has none and the row shows
 * the tool name as before. Keys are i18n labels; icons are hugeicons-react
 * components, resolved by the caller so this file stays free of JSX.
 */
export function verbFor(name = '') {
    const lower = String(name || '').toLowerCase();
    if (TODO_TOOLS.has(lower)) return { key: 'assistant.verbTodo', icon: 'todo' };
    switch (toolBucket(name)) {
        case 'views': return { key: 'assistant.verbRead', icon: 'read' };
        case 'edits': return { key: 'assistant.verbEdit', icon: 'edit' };
        case 'searches': return { key: 'assistant.verbSearch', icon: 'search' };
        case 'commands': return { key: 'assistant.verbRun', icon: 'run' };
        default: return null;
    }
}

const CHIP_TOOLS = new Set([
    'read_file', 'write_file', 'edit_file',
    'read_local_file', 'write_local_file', 'edit_local_file',
]);
const NATIVE_FILE_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'notebookread']);

/**
 * The file a call targets, as a chip: the base name to draw, the full path
 * for the tooltip. Only when the tool names exactly one file — a query or a
 * command line is not a chip. Null otherwise.
 */
export function chipFor(name = '', input = {}) {
    const lower = String(name || '').toLowerCase();
    let full = '';
    if (CHIP_TOOLS.has(lower)) {
        full = input?.path || '';
    } else if (NATIVE_FILE_TOOLS.has(lower)) {
        full = input?.file_path ?? input?.filePath ?? input?.path ?? '';
    } else {
        return null;
    }
    if (typeof full !== 'string' || !full.trim()) return null;
    full = full.trim();
    const base = full.split(/[/\\]/).filter(Boolean).pop() || full;
    return { base, full };
}

/**
 * A todo tool's progress ("1/3 done"), or '' when the input carries no todo
 * list to count. Counts a todo as done when its status says completed.
 */
export function todoProgress(input = {}) {
    const todos = Array.isArray(input?.todos) ? input.todos : null;
    if (!todos) return null;
    const done = todos.filter(todo => String(todo?.status || '').toLowerCase() === 'completed').length;
    return { done, total: todos.length };
}
