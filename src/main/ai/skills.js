/**
 * Slash skills: the `SKILL.md` folders other harnesses keep, read here so a
 * leading `/` in the composer can invoke one.
 *
 * Sources are the two places the user keeps them: `~/.claude/skills` and
 * `~/.agents/skills` (`~/.pi/agent/skills` is usually a link into the second,
 * and is covered by de-duplication rather than a third entry). Each skill is
 * a directory holding a `SKILL.md` with frontmatter (`name`, `description`,
 * `argument-hint`) and Markdown instructions below it.
 *
 * The renderer lists metadata only; the full text is resolved in main when a
 * message carrying `{ kind: 'skill', id }` is sent (see `mentions.js`), so a
 * sixty-kilobyte skill never crosses the bridge until it is actually invoked.
 * Kept free of Electron so it can be tested on its own.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** How much of a skill rides along. Past this it is a file, not a mention. */
const MAX_TEXT = 60000;

/** Where skills are looked for, first wins when two hold the same id. */
function skillDirs() {
    const home = os.homedir();
    return [
        path.join(home, '.agents', 'skills'),
        path.join(home, '.claude', 'skills'),
        path.join(home, '.pi', 'agent', 'skills'),
    ];
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * The frontmatter of a SKILL.md: the `---` block at the top. Parsed by hand
 * rather than with a YAML dependency: the fields read here (`name`,
 * `description`, `argument-hint`, `user-invocable`, `category`) are single
 * lines, optionally quoted, and anything fancier is ignored rather than
 * choking the whole list.
 */
function parseFrontmatter(text) {
    const found = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
    if (!found) return {};
    const fields = {};
    for (const line of found[1].split(/\r?\n/)) {
        const mark = line.indexOf(':');
        if (mark <= 0) continue;
        const key = line.slice(0, mark).trim().toLowerCase();
        let value = line.slice(mark + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key && value && !(key in fields)) fields[key] = value;
    }
    return fields;
}

/** The directories holding a SKILL.md, de-duplicated by skill id. */
function discover() {
    const seen = new Set();
    const found = [];
    for (const base of skillDirs()) {
        let entries = [];
        try {
            entries = fs.readdirSync(base, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
            const id = entry.name;
            const key = id.toLowerCase();
            if (!id || id.startsWith('.') || seen.has(key)) continue;
            const file = path.join(base, id, 'SKILL.md');
            try {
                if (!fs.statSync(file).isFile()) continue;
            } catch {
                continue;
            }
            seen.add(key);
            found.push({ id, file, source: path.basename(path.dirname(base)) === 'skills' ? base : base });
        }
    }
    return found;
}

/**
 * What the `/` picker shows: one row per skill, no instruction text. Frontmatter
 * only, so listing thirty skills does not read thirty files whole.
 */
function list() {
    const rows = [];
    for (const { id, file, source } of discover()) {
        let head = '';
        try {
            const handle = fs.openSync(file, 'r');
            const buffer = Buffer.alloc(4096);
            const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
            fs.closeSync(handle);
            head = buffer.slice(0, read).toString('utf8');
        } catch {
            continue;
        }
        const front = parseFrontmatter(head);
        // An agent-only skill is not something a person invokes with `/`.
        if (String(front['user-invocable'] || '').toLowerCase() === 'false') continue;
        const name = clean(front.name) || id;
        rows.push({
            id,
            name,
            description: clean(front.description),
            hint: clean(front['argument-hint']),
            source,
        });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}

/** A skill with its instructions, or null when no such skill exists. */
function get(id) {
    const wanted = String(id || '').toLowerCase();
    if (!wanted) return null;
    for (const { id: found, file } of discover()) {
        if (found.toLowerCase() !== wanted) continue;
        let text = '';
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
        const front = parseFrontmatter(text);
        if (String(front['user-invocable'] || '').toLowerCase() === 'false') return null;
        return {
            id: found,
            name: clean(front.name) || found,
            description: clean(front.description),
            hint: clean(front['argument-hint']),
            text: text.slice(0, MAX_TEXT),
            path: file,
        };
    }
    return null;
}

module.exports = { skillDirs, parseFrontmatter, list, get, MAX_TEXT };
