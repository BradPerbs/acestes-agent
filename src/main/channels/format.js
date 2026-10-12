/**
 * The agent's Markdown, as each chat app can show it.
 *
 * Everything the gateway says is Markdown, the agent's replies and its own
 * cards alike, and each channel turns it into what its app draws:
 *
 *   telegram  Telegram's HTML subset (b, i, s, code, pre, a, blockquote).
 *             It refuses a whole message over one unknown or unclosed tag,
 *             and its MarkdownV2 wants every `.` and `-` escaped, so HTML.
 *   matrix    The same HTML, with line breaks as <br>, since a Matrix
 *             client renders formatted_body as HTML.
 *   discord   Markdown, which Discord draws itself, less what it does not
 *             (tables).
 *   slack     Slack's mrkdwn: *bold*, _italic_, ~strike~, <url|text>.
 *
 * The reply is read into blocks first (paragraphs, lists, code, quotes,
 * tables), each line of prose converted on its own with every tag opened
 * and closed on that line, which is what makes the result safe to cut
 * between any two lines. Messages are cut on block boundaries, a block too
 * long for one message on its lines, and a code block cut that way is closed
 * and reopened around each piece. Only a single line longer than a message
 * is cut inside itself, as plain text.
 *
 * What a chat app cannot draw is said rather than dropped: a ```chart block
 * becomes a line naming the chart, and a table is kept in a monospaced block
 * where its columns still line up.
 */

/** Telegram's 4096, with room for the entities its count may differ on. */
const MESSAGE_LIMIT = 3800;

/** Under each app's own ceiling: Discord 2000, Slack about 4000 shown, Matrix's event size. */
const LIMITS = { telegram: MESSAGE_LIMIT, discord: 1900, slack: 3800, matrix: 16000 };

const escapeHtml = (text) => String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeAttribute = (text) => escapeHtml(text).replace(/"/g, '&quot;');

/** Slack's three: everything else in mrkdwn is literal. */
const escapeSlack = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Back to plain text: for a message an app refused to parse, and Matrix's `body`. */
function htmlToText(html) {
    return String(html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&');
}

/**
 * Text that goes into Markdown as written: a host name, a question, an
 * option. Its asterisks and underscores are not emphasis.
 */
function escapeMarkdown(text) {
    return String(text ?? '').replace(/([\\`*_~[\]|])/g, '\\$1');
}

/** A fence longer than any run of backticks in the text, so the text cannot close it. */
function fence(text) {
    const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map(run => run.length));
    return '`'.repeat(Math.max(3, longest + 1));
}

/** A code block holding the text exactly as written. */
function codeBlock(text, language = '') {
    const marker = fence(text);
    return `${marker}${language}\n${text}\n${marker}`;
}

const SAFE_URL = /^(https?:\/\/|mailto:|tg:\/\/|matrix:)/i;

/* ------------------------------------------------------------------ *
 * Inline
 * ------------------------------------------------------------------ */

/**
 * One line of prose for an HTML target: escapes, code spans and links lifted
 * out first so nothing inside them is read as emphasis, the rest escaped,
 * then bold, italic and strike.
 */
function inlineHtml(text) {
    const held = [];
    const hold = (html) => {
        held.push(html);
        return `\u0000${held.length - 1}\u0000`;
    };

    let out = String(text);
    out = out.replace(/\\([\\`*_~[\]()#>|!-])/g, (whole, char) => hold(escapeHtml(char)));
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

/** The same line in Slack's mrkdwn. */
function inlineSlack(text) {
    const held = [];
    const hold = (value) => {
        held.push(value);
        return `\u0000${held.length - 1}\u0000`;
    };

    let out = String(text);
    out = out.replace(/\\([\\`*_~[\]()#>|!-])/g, (whole, char) => hold(escapeSlack(char)));
    out = out.replace(/`([^`\n]+)`/g, (whole, code) => hold(`\`${escapeSlack(code)}\``));
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) => (
        SAFE_URL.test(url)
            ? hold(`<${url.replace(/[<>|]/g, '')}|${escapeSlack(label).replace(/\|/g, '/')}>`)
            : whole
    ));
    out = escapeSlack(out);
    // Bold first, held so its single asterisks are not then read as italic.
    out = out.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, (whole, inner) => hold(`*${inner}*`));
    out = out.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, (whole, inner) => hold(`*${inner}*`));
    out = out.replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, (whole, before, inner) => `${before}${hold(`_${inner}_`)}`);
    out = out.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, (whole, inner) => hold(`~${inner}~`));
    // eslint-disable-next-line no-control-regex
    for (let pass = 0; pass < 3 && /\u0000\d+\u0000/.test(out); pass += 1) {
        // eslint-disable-next-line no-control-regex
        out = out.replace(/\u0000(\d+)\u0000/g, (whole, index) => held[Number(index)] ?? '');
    }
    return out;
}

/** Discord draws Markdown itself; a line goes as written. */
const inlineDiscord = text => String(text);

/* ------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------ */

/**
 * The reply as blocks: `prose` (lines, each `{ kind: 'text'|'heading'|
 * 'bullet', depth, text }`), `code` (raw lines and a language), `quote`
 * (raw lines), `table` (raw rows) and `chart` (its title).
 */
function parse(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let prose = null;

    const closeProse = () => {
        if (prose && prose.lines.length) blocks.push(prose);
        prose = null;
    };
    const addProse = (line) => {
        if (!prose) prose = { kind: 'prose', lines: [] };
        prose.lines.push(line);
    };

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        const opening = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line);
        if (opening) {
            closeProse();
            const marker = opening[1];
            const closing = new RegExp(`^\\s*${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
            const language = opening[2].toLowerCase();
            const body = [];
            index += 1;
            while (index < lines.length && !closing.test(lines[index])) {
                body.push(lines[index]);
                index += 1;
            }
            if (language === 'chart') {
                let title = '';
                try {
                    title = String(JSON.parse(body.join('\n'))?.title || '').trim();
                } catch {
                    title = '';
                }
                blocks.push({ kind: 'chart', title });
            } else {
                blocks.push({ kind: 'code', language, lines: body });
            }
            continue;
        }

        if (!line.trim()) {
            closeProse();
            continue;
        }

        if (/^\s*\|.*\|\s*$/.test(line)) {
            closeProse();
            const rows = [];
            while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
                if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[index])) rows.push(lines[index].trim());
                index += 1;
            }
            index -= 1;
            blocks.push({ kind: 'table', lines: rows });
            continue;
        }

        if (/^\s*>/.test(line)) {
            closeProse();
            const quoted = [];
            while (index < lines.length) {
                const match = /^\s*>\s?(.*)$/.exec(lines[index]);
                if (!match) break;
                quoted.push(match[1]);
                index += 1;
            }
            index -= 1;
            blocks.push({ kind: 'quote', lines: quoted });
            continue;
        }

        const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            addProse({ kind: 'heading', depth: 0, text: heading[1] });
            continue;
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            closeProse();
            continue;
        }

        const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
        if (bullet) {
            const depth = Math.min(4, Math.floor(bullet[1].replace(/\t/g, '    ').length / 2));
            addProse({ kind: 'bullet', depth, text: bullet[2] });
            continue;
        }

        addProse({ kind: 'text', depth: 0, text: line.replace(/\s+$/, '') });
    }
    closeProse();
    return blocks;
}

const CHART_NOTE = 'Open the conversation in Acestes to see it.';

/**
 * How each target draws a block. `lines` turns a block's lines into the
 * target's own lines; `wrap` puts a run of those lines back into the block,
 * so a block cut in two is wrapped the same way twice.
 */
const TARGETS = {
    telegram: {
        newline: '\n',
        prose: line => (line.kind === 'heading'
            ? `<b>${inlineHtml(line.text)}</b>`
            : line.kind === 'bullet' ? `${'  '.repeat(line.depth)}• ${inlineHtml(line.text)}` : inlineHtml(line.text)),
        quote: line => inlineHtml(line),
        code: line => escapeHtml(line),
        wrap: (block, body) => {
            if (block.kind === 'code' || block.kind === 'table') {
                return block.language
                    ? `<pre><code class="language-${escapeAttribute(block.language)}">${body}</code></pre>`
                    : `<pre>${body}</pre>`;
            }
            if (block.kind === 'quote') return `<blockquote>${body}</blockquote>`;
            return body;
        },
        chart: title => `<i>[Chart${title ? `: ${escapeHtml(title)}` : ''}. ${CHART_NOTE}]</i>`,
        plain: text => escapeHtml(text),
        join: '\n\n',
    },
    discord: {
        newline: '\n',
        prose: line => (line.kind === 'heading'
            ? `**${line.text}**`
            : line.kind === 'bullet' ? `${'  '.repeat(line.depth)}- ${line.text}` : inlineDiscord(line.text)),
        quote: line => `> ${line}`,
        code: line => line,
        wrap: (block, body) => {
            if (block.kind === 'code' || block.kind === 'table') {
                const marker = fence(body);
                return `${marker}${block.language || ''}\n${body}\n${marker}`;
            }
            return body;
        },
        chart: title => `*[Chart${title ? `: ${title}` : ''}. ${CHART_NOTE}]*`,
        plain: text => String(text).replace(/([\\`*_~|>])/g, '\\$1'),
        join: '\n\n',
    },
    slack: {
        newline: '\n',
        prose: line => (line.kind === 'heading'
            ? `*${inlineSlack(line.text)}*`
            : line.kind === 'bullet' ? `${'  '.repeat(line.depth)}• ${inlineSlack(line.text)}` : inlineSlack(line.text)),
        quote: line => `&gt; ${inlineSlack(line)}`,
        code: line => escapeSlack(line),
        wrap: (block, body) => ((block.kind === 'code' || block.kind === 'table') ? `\`\`\`\n${body}\n\`\`\`` : body),
        chart: title => `_[Chart${title ? `: ${escapeSlack(title)}` : ''}. ${CHART_NOTE}]_`,
        plain: text => escapeSlack(text),
        join: '\n\n',
    },
    matrix: {
        newline: '<br>',
        prose: line => (line.kind === 'heading'
            ? `<b>${inlineHtml(line.text)}</b>`
            : line.kind === 'bullet' ? `${'&nbsp;&nbsp;'.repeat(line.depth)}• ${inlineHtml(line.text)}` : inlineHtml(line.text)),
        quote: line => inlineHtml(line),
        code: line => escapeHtml(line),
        wrap: (block, body) => {
            if (block.kind === 'code' || block.kind === 'table') {
                const text = body.split('<br>').join('\n');
                return block.language
                    ? `<pre><code class="language-${escapeAttribute(block.language)}">${text}</code></pre>`
                    : `<pre><code>${text}</code></pre>`;
            }
            if (block.kind === 'quote') return `<blockquote>${body}</blockquote>`;
            return body;
        },
        chart: title => `<i>[Chart${title ? `: ${escapeHtml(title)}` : ''}. ${CHART_NOTE}]</i>`,
        plain: text => escapeHtml(text),
        join: '<br><br>',
    },
};

/** A block's lines, as the target draws them. */
function linesOf(block, target) {
    switch (block.kind) {
        case 'prose': return block.lines.map(target.prose);
        case 'quote': return block.lines.map(target.quote);
        case 'code':
        case 'table': return block.lines.map(target.code);
        default: return [];
    }
}

function render(block, target, lines = linesOf(block, target)) {
    if (block.kind === 'chart') return target.chart(block.title);
    return target.wrap(block, lines.join(target.newline));
}

/** A block cut into pieces that each fit, on line boundaries. */
function cutBlock(block, target, limit) {
    const wrapper = render(block, target, []).length;
    const room = Math.max(200, limit - wrapper);
    const pieces = [];
    let current = [];
    let size = 0;
    const flush = () => {
        if (current.length) pieces.push(render(block, target, current));
        current = [];
        size = 0;
    };
    const raw = block.kind === 'prose' ? block.lines.map(line => line.text) : block.lines;
    linesOf(block, target).forEach((line, index) => {
        if (line.length > room) {
            // One line longer than a message: plain text, cut where it falls.
            flush();
            const plain = String(raw[index] ?? '');
            for (let at = 0; at < plain.length; at += room) {
                const slice = plain.slice(at, at + room);
                pieces.push(block.kind === 'prose' ? target.plain(slice) : render(block, target, [target.code(slice)]));
            }
            return;
        }
        if (size + line.length + target.newline.length > room) flush();
        current.push(line);
        size += line.length + target.newline.length;
    });
    flush();
    return pieces;
}

/**
 * The reply as messages for one app: strings, each under its limit, cut
 * between blocks wherever possible.
 */
function toMessages(markdown, { target: name = 'telegram', limit } = {}) {
    const target = TARGETS[name] || TARGETS.telegram;
    const ceiling = limit || LIMITS[name] || MESSAGE_LIMIT;
    const messages = [];
    let current = '';
    const push = (piece) => {
        if (!piece) return;
        if (current && current.length + target.join.length + piece.length <= ceiling) {
            current = `${current}${target.join}${piece}`;
            return;
        }
        if (current) messages.push(current);
        current = piece;
    };

    for (const block of parse(markdown)) {
        const drawn = render(block, target);
        if (drawn.length <= ceiling) {
            push(drawn);
            continue;
        }
        for (const piece of cutBlock(block, target, ceiling)) push(piece);
    }
    if (current) messages.push(current);
    return messages;
}

/** One short piece of Markdown as a single message's text, for a card or a note. */
function toText(markdown, target = 'telegram') {
    return toMessages(markdown, { target, limit: 1e9 })[0] || '';
}

/** Text cut to a length as written, line breaks and all, with an ellipsis when it was cut. */
function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

/** Plain text cut to a length, with an ellipsis when it was cut. */
function clip(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

module.exports = {
    toMessages,
    toText,
    parse,
    inline: inlineHtml,
    inlineSlack,
    escapeHtml,
    escapeMarkdown,
    codeBlock,
    htmlToText,
    clip,
    truncate,
    MESSAGE_LIMIT,
    LIMITS,
};
