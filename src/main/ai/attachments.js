/**
 * Plain files attached to a message, checked before anything is done with them.
 *
 * Images travel as bytes the model looks at (see `images.js`). These travel
 * as words the model reads, inlined into the prompt as `<attached-file>`
 * blocks, so they work on every runtime: no capability to negotiate, just
 * text like the message itself.
 *
 * The limits keep one message from eating the context: five files of 64 KB
 * each is already a long read. Anything over is refused with the file named,
 * so the user can trim it rather than wondering what the model saw.
 */

const MAX_FILES = 5;
const MAX_FILE_CHARS = 64 * 1024;

/**
 * The attachments as `{ name, mediaType, text }`, or the reason one of them
 * cannot be sent. All or nothing, like images: a question written about two
 * files should not be answered with one silently missing.
 */
function readFiles(raw) {
    if (raw === undefined || raw === null) return { files: [], error: '' };
    if (!Array.isArray(raw)) return { files: [], error: 'The files were not a list' };
    if (raw.length > MAX_FILES) {
        return { files: [], error: `A message can carry at most ${MAX_FILES} files` };
    }

    const files = [];
    for (const entry of raw) {
        const name = String(entry?.name || 'file.txt').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file.txt';
        const mediaType = String(entry?.mediaType || 'text/plain').toLowerCase().slice(0, 120);
        const text = typeof entry?.text === 'string' ? entry.text : '';

        if (!text.trim()) {
            return { files: [], error: `${name} is empty` };
        }
        if (text.length > MAX_FILE_CHARS + 200) {
            return { files: [], error: `${name} is larger than the ${MAX_FILE_CHARS / 1024} KB a file may be` };
        }
        files.push({ name, mediaType, text });
    }
    return { files, error: '' };
}

/** The files as prompt text: context first, question last, like the rest. */
function fileBlock(files) {
    return (files || [])
        .map(entry => `<attached-file name="${entry.name}" type="${entry.mediaType}">\n${entry.text}\n</attached-file>`)
        .join('\n\n');
}

/** The files without their words, for a transcript on disk. */
function stripFiles(files) {
    return (files || []).map(({ name, mediaType }) => ({ name, mediaType }));
}

module.exports = { readFiles, fileBlock, stripFiles, MAX_FILES, MAX_FILE_CHARS };
