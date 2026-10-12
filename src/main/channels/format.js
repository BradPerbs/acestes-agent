/**
 * The agent's Markdown, as Telegram can show it.
 *
 * Telegram's HTML mode takes a short list of tags (b, i, s, u, code, pre,
 * a, blockquote) and refuses the whole message over one it does not know or
 * one left open. Its MarkdownV2 mode is worse for this: every `.`, `-` and
 * `!` outside an entity has to be escaped, and the agent's replies are full
 * of them. So the reply is converted to that HTML subset here, line by line,
 * with every tag opened and closed on the same line, which is what makes the
 * result safe to cut between any two lines.
 *
 * A message holds 4096 characters. A reply is cut into messages on block
 * boundaries (paragraphs, lists, code), a block too long for one message on
 * its line boundaries, and a code block cut that way is closed and reopened
 * around each piece. Only a single line longer than a message is cut inside
 * itself, as plain text.
 *
 * What a phone cannot draw is said rather than dropped: a ```chart block
 * becomes a line naming the chart, and a table is kept in a monospaced block
 * where its columns still line up.
 */

/** Under Telegram's 4096, with room for the entities its count may differ on. */
const MESSAGE_LIMIT = 3800;

const escapeHtml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, '&quot;');

/** Back to plain text: for a message Telegram refused to parse. */
function htmlToText(html) {
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
}

const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/)/i;

/**
 * One line of prose: code spans and links lifted out first so nothing inside
 * them is read as emphasis, the rest escaped, then bold, italic and strike.
 */
function inline(text) {
    const held = [];
    const hold = (html) => {
        held.push(html);
        return `\u0000${held.length - 1}\u0000`;
    };

    let out = String(text);
    out = out.replace(/`([^`\n]+)`/g, (whole, code) => hold(`<code>${escapeHtml(code)}</code>`));
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) => (
        SAFE_URL.test(url)
            ? hold(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`)
            : whole
    ));
    out = escapeHtml(out);
    out = out.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<b>$1</b>');
    out = out.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, '<b>$1</b>');
    out = out.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1<i>$2</i>');
    // Underscores only at word edges, so snake_case names stay as written.
    out = out.replace(/(^|[^_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![_\w])/g, '$1<i>$2</i>');
    out = out.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '<s>$1</s>');
    // eslint-disable-next-line no-control-regex
    return out.replace(/\u0000(\d+)\u0000/g, (whole, index) => held[Number(index)] ?? '');
}

/** What a ```chart block becomes: its title, since a phone gets no chart. */
function chartLine(body) {
    let title = '';
    try {
        title = String(JSON.parse(body)?.title || '').trim();
    } catch {
        title = '';
    }
    return `<i>[Chart${title ? `: ${escapeHtml(title)}` : ''}. Open the conversation in Acestes to see it.]</i>`;
}

/**
 * The reply as blocks, each `{ kind, lines }` of finished HTML lines, every
 * line with its tags balanced. `code` blocks keep their language so a piece
 * cut from one can be wrapped the same way.
 */
function toBlocks(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let prose = null;

    const closeProse = () => {
        if (prose && prose.lines.length) blocks.push(prose);
        prose = null;
    };
    const addProse = (html) => {
        if (!prose) prose = { kind: 'prose', lines: [] };
        prose.lines.push(html);
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
        if (fence) {
            closeProse();
            const marker = fence[1];
            const language = fence[2].toLowerCase();
            const body = [];
            index += 1;
            while (index < lines.length && !lines[index].trim().startsWith(marker[0].repeat(3))) {
                body.push(lines[index]);
                index += 1;
            }
            if (language === 'chart') {
                blocks.push({ kind: 'prose', lines: [chartLine(body.join('\n'))] });
            } else {
                blocks.push({ kind: 'code', language, lines: body.map(escapeHtml) });
            }
            continue;
        }

        if (!line.trim()) {
            closeProse();
            continue;
        }

        // A table, kept as text in a monospaced block where it still lines up.
        if (/^\s*\|.*\|\s*$/.test(line)) {
            closeProse();
            const rows = [];
            while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
                if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[index])) rows.push(escapeHtml(lines[index].trim()));
                index += 1;
            }
            index -= 1;
            blocks.push({ kind: 'code', language: '', lines: rows });
            continue;
        }

        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote) {
            closeProse();
            const quoted = [];
            while (index < lines.length) {
                const match = /^\s*>\s?(.*)$/.exec(lines[index]);
                if (!match) break;
                quoted.push(inline(match[1]));
                index += 1;
            }
            index -= 1;
            blocks.push({ kind: 'quote', lines: quoted });
            continue;
        }

        const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            addProse(`<b>${inline(heading[1])}</b>`);
            continue;
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            closeProse();
            continue;
        }

        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            const depth = Math.min(4, Math.floor(bullet[1].replace(/\t/g, '    ').length / 2));
            addProse(`${'  '.repeat(depth)}• ${inline(bullet[2])}`);
            continue;
        }

        addProse(inline(line.replace(/\s+$/, '')));
    }
    closeProse();
    return blocks;
}

/** One block as HTML, from some of its lines. */
function render(block, lines = block.lines) {
    const body = lines.join('\n');
    if (block.kind === 'code') {
        return block.language
            ? `<pre><code class="language-${escapeAttribute(block.language)}">${body}</code></pre>`
            : `<pre>${body}</pre>`;
    }
    if (block.kind === 'quote') return `<blockquote>${body}</blockquote>`;
    return body;
}

/** A block cut into pieces that each fit, on line boundaries. */
function cutBlock(block, limit) {
    const wrapper = render(block, []).length;
    const room = Math.max(200, limit - wrapper);
    const pieces = [];
    let current = [];
    let size = 0;
    const flush = () => {
        if (current.length) pieces.push(render(block, current));
        current = [];
        size = 0;
    };
    for (const line of block.lines) {
        if (line.length > room) {
            // One line longer than a message: plain text, cut where it falls.
            flush();
            const plain = htmlToText(line);
            for (let at = 0; at < plain.length; at += room) {
                pieces.push(render(block, [escapeHtml(plain.slice(at, at + room))]));
            }
            continue;
        }
        if (size + line.length + 1 > room) flush();
        current.push(line);
        size += line.length + 1;
    }
    flush();
    return pieces;
}

/**
 * The reply as Telegram messages: HTML strings, each under the limit, cut
 * between blocks wherever possible.
 */
function toMessages(markdown, { limit = MESSAGE_LIMIT } = {}) {
    const messages = [];
    let current = '';
    const push = (html) => {
        if (!html) return;
        if (current && current.length + 2 + html.length <= limit) {
            current = `${current}\n\n${html}`;
            return;
        }
        if (current) messages.push(current);
        current = html;
    };

    for (const block of toBlocks(markdown)) {
        const html = render(block);
        if (html.length <= limit) {
            push(html);
            continue;
        }
        for (const piece of cutBlock(block, limit)) push(piece);
    }
    if (current) messages.push(current);
    return messages;
}

/** Plain text cut to a length, with an ellipsis when it was cut. */
function clip(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

module.exports = { toMessages, toBlocks, inline, escapeHtml, htmlToText, clip, MESSAGE_LIMIT };
