/**
 * Plain files on their way into the composer.
 *
 * Images keep their own road (`lib/images`): they travel as bytes the model
 * looks at. Documents travel as words the model reads, and are sent as
 * `{ name, mediaType, text }`: text straight, PDFs via PDF.js (`readTextFile`
 * below), Office documents via `lib/office`. Anything else is tried as text
 * and kept when it reads like it; a binary file decoded as UTF-8 is mojibake
 * the model still bills for, so those are refused with 'not text' instead.
 */

import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { IMAGE_TYPES } from './images';
import { isOfficeFile, officeMediaType, extractOfficeText, stripRtf, looksLikeText } from './office';

/** How much text one file may bring, in characters (roughly bytes for prose). */
export const MAX_FILE_CHARS = 64 * 1024;

/** How many files one message may carry. */
export const MAX_FILES = 5;

/** How many bytes of PDF one file may bring in for text extraction. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

/** How many PDF pages are read before giving up; the text cap lands first. */
export const MAX_PDF_PAGES = 100;

/** How many bytes of an unknown file are decoded before calling it binary. */
export const MAX_UNKNOWN_BYTES = 8 * 1024 * 1024;

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

/**
 * Extensions never tried as text: archives, executables, disk images, media
 * and legacy Office binaries, which unzip to nothing this reader knows.
 * Anything else unknown is attempted and judged on its words instead.
 */
const BINARY_EXTENSIONS = new Set([
    '.zip', '.gz', '.tgz', '.tar', '.rar', '.7z', '.bz2', '.xz', '.zst',
    '.exe', '.msi', '.dll', '.so', '.dylib', '.dmg', '.iso', '.pkg', '.apk',
    '.mp3', '.mp4', '.m4a', '.wav', '.flac', '.aac', '.ogg', '.oga',
    '.avi', '.mov', '.mkv', '.webm', '.wmv', '.mpg', '.mpeg',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.doc', '.xls', '.ppt',
]);

/** Types never tried as text, whatever the extension. */
const BINARY_TYPES = new Set([
    'application/zip', 'application/x-rar-compressed', 'application/x-7z-compressed',
    'application/x-tar', 'application/gzip', 'application/x-msdownload',
    'application/x-shockwave-flash',
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

/** Whether `file` is a PDF document, read via text extraction. */
export function isPdfFile(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (type.includes('pdf')) return true;
    if (!type || type === 'application/octet-stream') return extensionOf(file.name) === '.pdf';
    return false;
}

/**
 * Whether `file` can go with a message. Text, PDFs and Office documents go
 * by kind; anything else unknown goes on trial, and is refused later if its
 * words turn out to be binary. Pictures have their own road, and known
 * binaries never board.
 */
export function isAttachableFile(file) {
    if (!file) return false;
    const type = String(file.type || '').toLowerCase();
    if (IMAGE_TYPES.includes(type)) return false;
    if (type.startsWith('video/') || type.startsWith('audio/')) return false;
    if (isTextFile(file) || isPdfFile(file) || isOfficeFile(file)) return true;
    if (BINARY_TYPES.has(type)) return false;
    if (BINARY_EXTENSIONS.has(extensionOf(file.name))) return false;
    return true;
}

/** PDF.js, loaded only when a PDF is attached, so startup stays light. */
let pdfLibPromise = null;
function loadPdfLib() {
    if (!pdfLibPromise) {
        pdfLibPromise = import('pdfjs-dist').then((lib) => {
            try {
                lib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
            } catch {
                // Without the worker the read below fails and the file is
                // refused like any other unreadable one.
            }
            return lib;
        });
    }
    return pdfLibPromise;
}

/** Clip extracted words to what one file may bring. */
function clip(text) {
    return text.length > MAX_FILE_CHARS
        ? `${text.slice(0, MAX_FILE_CHARS)}\n\n…(truncated, file was longer)`
        : text;
}

/**
 * A PDF's words, in page order. Rejects with 'empty' when the document has
 * no text to give (a scan without OCR), and with 'too large' when the file
 * itself is past what extraction takes on.
 */
async function extractPdfText(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) throw new Error('too large');
    const lib = await loadPdfLib();
    const document = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
        const count = Math.min(document.numPages, MAX_PDF_PAGES);
        const pages = [];
        let length = 0;
        for (let number = 1; number <= count; number += 1) {
            const page = await document.getPage(number);
            try {
                const content = await page.getTextContent();
                const line = content.items
                    .map(item => (typeof item?.str === 'string' ? item.str : ''))
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (line) {
                    pages.push(line);
                    length += line.length;
                }
            } finally {
                page.cleanup?.();
            }
            if (length > MAX_FILE_CHARS) break;
        }
        const text = pages.join('\n\n').trim();
        if (!text) throw new Error('empty');
        return text;
    } finally {
        await document.destroy?.();
    }
}

/**
 * One file, ready to send: `{ name, mediaType, text }`.
 * Rejects with 'not text' when the file holds no words, 'empty' when it
 * holds none at all, and 'too large' past what extraction takes on.
 */
export async function readTextFile(file) {
    if (isPdfFile(file)) {
        const name = file.name || 'document.pdf';
        const text = await extractPdfText(file);
        return { name, mediaType: 'application/pdf', text: clip(text) };
    }
    if (isOfficeFile(file)) {
        const name = file.name || 'document';
        const text = await extractOfficeText(file);
        return { name, mediaType: officeMediaType(file), text: clip(text) };
    }
    if (isTextFile(file)) {
        const name = file.name || 'file.txt';
        const text = await file.text();
        if (!text.trim()) throw new Error('empty');
        const mediaType = String(file.type || '').toLowerCase() || 'text/plain';
        return { name, mediaType, text: clip(text) };
    }
    if (!isAttachableFile(file)) throw new Error('not text');
    const name = file.name || 'file.txt';
    if (file.size > MAX_UNKNOWN_BYTES) throw new Error('too large');
    const raw = await file.text();
    if (!raw.trim()) throw new Error('empty');
    const plain = stripRtf(raw) ?? raw;
    if (plain !== raw) {
        if (!plain.trim()) throw new Error('empty');
    } else if (!looksLikeText(raw)) {
        throw new Error('not text');
    }
    const mediaType = String(file.type || '').toLowerCase() || 'text/plain';
    return { name, mediaType, text: clip(plain) };
}

/** The text files among what was picked, dropped or pasted, in order. */
export function textFiles(list) {
    if (!list) return [];
    return Array.from(list).filter(isTextFile);
}

/** The files that can go with a message, in order. */
export function attachableFiles(list) {
    if (!list) return [];
    return Array.from(list).filter(isAttachableFile);
}
