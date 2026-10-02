/**
 * Plain files on their way into the composer.
 *
 * Images keep their own road (`lib/images`): they travel as bytes the model
 * looks at. Everything else travels as words the model reads, so it is read
 * here as text and sent as `{ name, mediaType, text }`. Anything that cannot
 * be read as text is refused with 'not text' rather than guessed at, since a
 * binary file decoded as UTF-8 is mojibake the model still bills for.
 */

/** How much text one file may bring, in characters (roughly bytes for prose). */
export const MAX_FILE_CHARS = 64 * 1024;

/** How many files one message may carry. */
export const MAX_FILES = 5;

/** Extensions read as text when the picker gives no type for them. */
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.mdown', '.json', '.jsonc', '.js', '.jsx',
    '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.rb', '.go',
    '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.css',
    '.scss', '.less', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml',
    '.toml', '.ini', '.cfg', '.conf', '.env', '.sh', '.bash', '.zsh',
    '.fish', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.astro',
    '.log', '.csv', '.tsv', '.dockerfile', '.gitignore', '.gitattributes',
    '.editorconfig', '.properties', '.gradle', '.kt', '.swift', '.php',
    '.pl', '.r', '.lua', '.vim', '.diff', '.patch', '.tex', '.rst',
]);

/** Types always read as text, whatever the extension. */
const TEXT_TYPES = new Set([
    'application/json', 'application/javascript', 'application/xml',
    'application/toml', 'application/yaml', 'application/x-sh',
    'application/x-httpd-php', 'application/sql',
]);

function extensionOf(name) {
    const dot = String(name || '').lastIndexOf('.');
    if (dot < 0) return '';
    return String(name).slice(dot).toLowerCase();
}

/** Whether `file` can be tried as text. Images have their own road. */
export function isTextFile(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (type.startsWith('text/')) return true;
    if (TEXT_TYPES.has(type)) return true;
    if (!type || type === 'application/octet-stream') return TEXT_EXTENSIONS.has(extensionOf(file.name));
    return false;
}

/**
 * One file, ready to send: `{ name, mediaType, text }`.
 * Rejects with 'not text' when the file is not text-like.
 */
export async function readTextFile(file) {
    if (!isTextFile(file)) throw new Error('not text');
    const name = file.name || 'file.txt';
    const text = await file.text();
    if (!text.trim()) throw new Error('empty');
    const mediaType = String(file.type || '').toLowerCase() || 'text/plain';
    const clipped = text.length > MAX_FILE_CHARS
        ? `${text.slice(0, MAX_FILE_CHARS)}\n\n…(truncated, file was longer)`
        : text;
    return { name, mediaType, text: clipped };
}

/** The text files among what was picked, dropped or pasted, in order. */
export function textFiles(list) {
    if (!list) return [];
    return Array.from(list).filter(isTextFile);
}
