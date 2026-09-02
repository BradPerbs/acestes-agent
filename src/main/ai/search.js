const embeddings = require('./embeddings');

/**
 * Searching the conversations.
 *
 * A title filter is not a search. What people remember about a conversation
 * is what was said in it: the command that fixed it, the host it was about,
 * the error the agent hit. So this reads through the events themselves, the
 * user's messages, the agent's replies, the tool calls and what came back,
 * and answers with the conversations ranked and the passages that matched,
 * marked up so the page can highlight them.
 *
 * The query is words plus a small set of operators, the kind a mail client
 * teaches without a manual:
 *
 *   "exact phrase"        the words in that order
 *   -word                 conversations without the word
 *   is:pinned  is:open  is:working
 *   has:error  has:tool  has:image  has:approval
 *   from:me    from:agent           where the words must appear
 *   tool:run_command                a tool that was called
 *   host:web-01                     a host the conversation touched
 *   after:7d  after:2026-08-01  before:yesterday
 *
 * Every plain word must appear somewhere in a conversation for it to count,
 * which is what makes adding a word narrow the list rather than widen it.
 * Ranking weighs where the word was found: a title beats a message, a
 * message beats a tool result, a phrase beats scattered words, and recent
 * beats old among equals.
 *
 * Underneath the words there is a second reading, by meaning, through the
 * same small model the agent's memory uses: the query and a sketch of each
 * conversation (its title and the user's first and last messages) are
 * embedded, and a conversation close enough in meaning is offered even when
 * none of the words match, marked as such. That is the part that finds "the
 * disk space thing" when the conversation said "volume at 97%". It is a
 * bonus rather than the basis: while the model is still loading, or on a
 * machine where it cannot, search is by words alone and says so.
 */

/** How much of a passage is shown either side of the first hit. */
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 100;

/** Passages per conversation, and results in total. */
const MAX_SNIPPETS = 3;
const DEFAULT_LIMIT = 30;

/** Where a cosine score starts meaning something for a sketch this short. */
const MEANING_FLOOR = 0.42;

/** Where a hit counts, and for how much. Title is scored separately. */
const WEIGHTS = {
    user: 3,
    agent: 2,
    tool: 1.5,
    result: 1,
};

const TITLE_WEIGHT = 10;
const PHRASE_BONUS = 2;

/* ------------------------------------------------------------------ *
 * The query
 * ------------------------------------------------------------------ */

const DAY = 24 * 60 * 60 * 1000;

/**
 * A date operand: an ISO date, a relative span like `7d` or `2w`, or one of
 * the words people actually type. Null when it is none of those, in which
 * case the operator is ignored rather than refusing the whole search.
 */
function parseDate(value, now = Date.now()) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    if (text === 'today') return startOfDay(now);
    if (text === 'yesterday') return startOfDay(now - DAY);
    const relative = /^(\d+)\s*([hdwm])$/.exec(text);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = { h: DAY / 24, d: DAY, w: 7 * DAY, m: 30 * DAY }[relative[2]];
        return now - amount * unit;
    }
    const absolute = Date.parse(text);
    return Number.isFinite(absolute) ? absolute : null;
}

function startOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
}

/**
 * The query taken apart. Pure, and exported for the test: what each operator
 * means is the contract the page's help text describes, and it should not
 * drift.
 */
function parse(query, now = Date.now()) {
    const out = {
        terms: [],
        phrases: [],
        excluded: [],
        pinned: null,
        open: null,
        working: null,
        has: new Set(),
        from: null,
        tool: null,
        host: null,
        after: null,
        before: null,
    };

    const text = String(query || '');
    const pattern = /(-)?"([^"]*)"|(\S+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match[2] !== undefined) {
            const phrase = match[2].trim().toLowerCase();
            if (!phrase) continue;
            if (match[1]) out.excluded.push(phrase);
            else out.phrases.push(phrase);
            continue;
        }

        const token = match[3];
        const lower = token.toLowerCase();

        if (lower.startsWith('-') && lower.length > 1) {
            out.excluded.push(lower.slice(1));
            continue;
        }

        const colon = lower.indexOf(':');
        if (colon > 0 && colon < lower.length - 1) {
            const key = lower.slice(0, colon);
            const value = lower.slice(colon + 1);
            if (key === 'is') {
                if (value === 'pinned') out.pinned = true;
                else if (value === 'unpinned') out.pinned = false;
                else if (value === 'open') out.open = true;
                else if (value === 'closed') out.open = false;
                else if (value === 'working' || value === 'busy') out.working = true;
                else out.terms.push(lower);
                continue;
            }
            if (key === 'has') {
                if (['error', 'errors', 'tool', 'tools', 'image', 'images', 'approval', 'approvals'].includes(value)) {
                    out.has.add(value.replace(/s$/, ''));
                } else {
                    out.terms.push(lower);
                }
                continue;
            }
            if (key === 'from') {
                if (['me', 'user', 'you'].includes(value)) out.from = 'user';
                else if (['agent', 'assistant', 'ai'].includes(value)) out.from = 'agent';
                else out.terms.push(lower);
                continue;
            }
            if (key === 'tool') { out.tool = value; continue; }
            if (key === 'host' || key === 'server') { out.host = value; continue; }
            if (key === 'after' || key === 'since') { out.after = parseDate(value, now); continue; }
            if (key === 'before' || key === 'until') { out.before = parseDate(value, now); continue; }
        }

        out.terms.push(lower);
    }

    return out;
}

/* ------------------------------------------------------------------ *
 * The passages
 * ------------------------------------------------------------------ */

/**
 * The searchable text of one event, with the side it came from. Null for
 * the events that are bookkeeping rather than content.
 */
function passageOf(event) {
    switch (event?.type) {
        case 'user-message':
            return { kind: 'user', text: String(event.text || '') };
        case 'assistant-text':
            return { kind: 'agent', text: String(event.text || '') };
        case 'tool-call': {
            const input = event.input && typeof event.input === 'object' ? event.input : {};
            // The command or path is what someone remembers, not the JSON
            // around it. Values only, so a search for "session" does not hit
            // every call ever made.
            const values = Object.values(input)
                .filter(value => typeof value === 'string' || typeof value === 'number')
                .map(String)
                .join(' ');
            return { kind: 'tool', text: `${event.name || ''} ${values}`.trim(), tool: String(event.name || '').toLowerCase() };
        }
        case 'tool-result':
            return { kind: 'result', text: String(event.text || ''), isError: Boolean(event.isError) };
        default:
            return null;
    }
}

/** Every `[start, end)` of a needle in a haystack, both already lowercase. */
function occurrences(haystack, needle) {
    const out = [];
    if (!needle) return out;
    let from = 0;
    while (from <= haystack.length - needle.length) {
        const at = haystack.indexOf(needle, from);
        if (at === -1) break;
        out.push([at, at + needle.length]);
        from = at + needle.length;
    }
    return out;
}

/** Sorted, merged ranges, so overlapping hits do not double-mark. */
function mergeRanges(ranges) {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else out.push([range[0], range[1]]);
    }
    return out;
}

/**
 * A window of text around the first hit, with the hits inside it re-based
 * to the window. Whitespace is collapsed first so a tool result full of
 * newlines reads as one line on the page.
 */
function excerpt(text, ranges) {
    const flat = text.replace(/\s+/g, ' ');
    if (ranges.length === 0) {
        const head = flat.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER);
        return { text: head, ranges: [], truncated: flat.length > head.length };
    }
    // The ranges were found on the collapsed lowercase text, which has the
    // same length as `flat` (lowercasing does not change ASCII length; for
    // the rare script where it does, the marks land a character off, which
    // is a highlight slightly wrong rather than a search that is).
    const first = ranges[0][0];
    const start = Math.max(0, first - SNIPPET_BEFORE);
    const end = Math.min(flat.length, first + SNIPPET_AFTER);
    const window = flat.slice(start, end);
    const inside = ranges
        .filter(range => range[0] < end && range[1] > start)
        .map(range => [Math.max(range[0], start) - start, Math.min(range[1], end) - start]);
    return {
        text: (start > 0 ? '…' : '') + window + (end < flat.length ? '…' : ''),
        ranges: start > 0 ? inside.map(range => [range[0] + 1, range[1] + 1]) : inside,
    };
}

/* ------------------------------------------------------------------ *
 * The scan
 * ------------------------------------------------------------------ */

/**
 * One conversation against one parsed query: null when it is out, else its
 * score and the passages that put it in.
 */
function scan(conversation, parsed, { openIds, hostName, live }) {
    // The filters first, since they are cheap and most of the list fails one.
    if (parsed.pinned !== null && Boolean(conversation.pinned) !== parsed.pinned) return null;
    if (parsed.open !== null && openIds.has(conversation.id) !== parsed.open) return null;
    if (parsed.working !== null && Boolean(conversation.busy) !== parsed.working) return null;
    if (parsed.after !== null && conversation.updatedAt < parsed.after) return null;
    if (parsed.before !== null && conversation.createdAt > parsed.before) return null;

    const events = Array.isArray(conversation.events) ? conversation.events : [];
    const passages = [];
    let hasError = false;
    let hasTool = false;
    let hasImage = false;
    let hasApproval = false;
    const toolsCalled = new Set();

    events.forEach((event, index) => {
        if (event?.type === 'approval-request') hasApproval = true;
        if (event?.type === 'error') hasError = true;
        if (Array.isArray(event?.images) && event.images.length > 0) hasImage = true;
        const passage = passageOf(event);
        if (!passage) return;
        if (passage.kind === 'tool') {
            hasTool = true;
            toolsCalled.add(passage.tool);
        }
        if (passage.isError) hasError = true;
        passages.push({ ...passage, index, at: event.at || 0, lower: passage.text.replace(/\s+/g, ' ').toLowerCase() });
    });

    if (parsed.has.has('error') && !hasError) return null;
    if (parsed.has.has('tool') && !hasTool) return null;
    if (parsed.has.has('image') && !hasImage) return null;
    if (parsed.has.has('approval') && !hasApproval) return null;
    if (parsed.tool && ![...toolsCalled].some(name => name.includes(parsed.tool))) return null;

    if (parsed.host) {
        const names = [
            ...(conversation.hostIds || []).map(id => hostName(id)),
            ...passages.map(passage => passage.lower),
        ].map(name => String(name || '').toLowerCase());
        if (!names.some(name => name.includes(parsed.host))) return null;
    }

    const title = String(conversation.title || '');
    const titleLower = title.toLowerCase();
    const everything = titleLower + '\n' + passages.map(passage => passage.lower).join('\n');

    for (const word of parsed.excluded) {
        if (everything.includes(word)) return null;
    }

    const needles = [...parsed.terms, ...parsed.phrases];
    // Filters only, no words: everything that passed the filters is in,
    // ordered by recency below, with its opening lines as the passage.
    if (needles.length === 0) {
        return {
            score: 0,
            matches: 0,
            titleRanges: [],
            snippets: passages
                .filter(passage => passage.kind === 'user' && passage.text.trim())
                .slice(0, 1)
                .map(passage => ({ kind: passage.kind, index: passage.index, at: passage.at, ...excerpt(passage.text, []) })),
        };
    }

    // Every word somewhere, or the conversation is out.
    for (const needle of needles) {
        if (!everything.includes(needle)) return null;
    }

    let score = 0;
    let matches = 0;

    const titleRanges = mergeRanges(needles.flatMap(needle => occurrences(titleLower, needle)));
    if (titleRanges.length > 0) {
        score += TITLE_WEIGHT * titleRanges.length;
        matches += titleRanges.length;
    }

    const scored = [];
    for (const passage of passages) {
        if (parsed.from && passage.kind !== parsed.from) continue;
        const ranges = mergeRanges(needles.flatMap(needle => occurrences(passage.lower, needle)));
        if (ranges.length === 0) continue;
        const phraseHits = parsed.phrases.reduce((sum, phrase) => sum + occurrences(passage.lower, phrase).length, 0);
        const weight = WEIGHTS[passage.kind] || 1;
        const passageScore = weight * ranges.length + PHRASE_BONUS * phraseHits;
        score += passageScore;
        matches += ranges.length;
        scored.push({ passage, ranges, passageScore });
    }

    // `from:` said where the words must be, and they were not there.
    if (parsed.from && scored.length === 0 && titleRanges.length === 0) return null;

    // The best passages, but told in the order they happened, which is how
    // the conversation reads.
    const snippets = scored
        .sort((a, b) => b.passageScore - a.passageScore)
        .slice(0, MAX_SNIPPETS)
        .sort((a, b) => a.passage.index - b.passage.index)
        .map(({ passage, ranges }) => ({
            kind: passage.kind,
            index: passage.index,
            at: passage.at,
            isError: passage.isError || undefined,
            ...excerpt(passage.text, ranges),
        }));

    return { score, matches, titleRanges, snippets, live: live(conversation) };
}

/* ------------------------------------------------------------------ *
 * By meaning
 * ------------------------------------------------------------------ */

let modelReady = false;
let modelFailed = false;
let modelAsked = false;

// conversationId -> { updatedAt, vector }
const sketches = new Map();

/** Start the model the first time search wants it, without waiting. */
function warm() {
    if (modelAsked) return;
    modelAsked = true;
    embeddings.load().then(() => { modelReady = true; }).catch(() => { modelFailed = true; });
}

/** The sentence or two that stands for a conversation. */
function sketchText(conversation) {
    const users = (conversation.events || []).filter(event => event.type === 'user-message' && event.text);
    const parts = [conversation.title || '', users[0]?.text || '', users.length > 1 ? users[users.length - 1].text : ''];
    return parts.map(part => String(part).replace(/\s+/g, ' ').trim()).filter(Boolean).join('. ').slice(0, 600);
}

function cosine(a, b) {
    let sum = 0;
    for (let index = 0; index < a.length && index < b.length; index += 1) sum += a[index] * b[index];
    return sum;
}

/**
 * Cosine between the query and each conversation's sketch, by id. Empty
 * when the model is not there yet, which is the ordinary case for the first
 * few seconds of a session.
 */
async function meanings(conversations, queryText) {
    if (!modelReady || !queryText.trim()) return new Map();

    const stale = conversations.filter((conversation) => {
        const held = sketches.get(conversation.id);
        return !held || held.updatedAt !== conversation.updatedAt;
    });
    if (stale.length > 0) {
        const vectors = await embeddings.embed(stale.map(sketchText));
        stale.forEach((conversation, index) => {
            sketches.set(conversation.id, { updatedAt: conversation.updatedAt, vector: vectors[index] });
        });
    }
    // The ones that are gone, so a long session does not hold every
    // conversation it ever saw.
    const alive = new Set(conversations.map(conversation => conversation.id));
    for (const id of sketches.keys()) if (!alive.has(id)) sketches.delete(id);

    const [query] = await embeddings.embed([queryText]);
    const out = new Map();
    for (const conversation of conversations) {
        const held = sketches.get(conversation.id);
        if (held) out.set(conversation.id, cosine(query, held.vector));
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * The search
 * ------------------------------------------------------------------ */

/**
 * Search a list of conversations.
 *
 * `describe(conversation)` is the row the list would show for it, so the
 * page draws a result the same way it draws any other conversation and adds
 * the passages underneath. The rest are the lookups the scan needs that this
 * module does not own.
 */
async function search(conversations, {
    query = '',
    limit = DEFAULT_LIMIT,
    openIds = new Set(),
    hostName = () => '',
    live = () => false,
    describe = (conversation) => ({ conversationId: conversation.id }),
    now = Date.now(),
    withMeaning = true,
} = {}) {
    const parsed = parse(query, now);
    if (withMeaning) warm();

    const byWords = [];
    for (const conversation of conversations) {
        const hit = scan(conversation, parsed, { openIds, hostName, live });
        if (hit) byWords.push({ conversation, hit });
    }

    const freeText = [...parsed.terms, ...parsed.phrases].join(' ');
    let similarity = new Map();
    let meaning = 'off';
    if (withMeaning && freeText) {
        if (modelFailed) meaning = 'unavailable';
        else if (!modelReady) meaning = 'loading';
        else {
            try {
                similarity = await meanings(conversations, freeText);
                meaning = 'on';
            } catch {
                meaning = 'unavailable';
            }
        }
    }

    const results = byWords.map(({ conversation, hit }) => ({
        ...describe(conversation),
        score: hit.score + (similarity.get(conversation.id) || 0) * 5,
        matches: hit.matches,
        titleRanges: hit.titleRanges,
        snippets: hit.snippets,
        byMeaning: false,
    }));

    // Conversations the words missed but the meaning did not. The filters
    // still apply: they are re-run with no words so `is:pinned disk space`
    // does not offer an unpinned chat about disks.
    if (similarity.size > 0) {
        const found = new Set(results.map(result => result.conversationId));
        const filtersOnly = { ...parsed, terms: [], phrases: [] };
        for (const conversation of conversations) {
            if (found.has(conversation.id)) continue;
            const closeness = similarity.get(conversation.id) || 0;
            if (closeness < MEANING_FLOOR) continue;
            const passes = scan(conversation, filtersOnly, { openIds, hostName, live });
            if (!passes) continue;
            results.push({
                ...describe(conversation),
                score: closeness * 5,
                matches: 0,
                titleRanges: [],
                snippets: passes.snippets,
                byMeaning: true,
                closeness,
            });
        }
    }

    const hasWords = freeText.length > 0;
    results.sort((a, b) => {
        if (hasWords && b.score !== a.score) return b.score - a.score;
        return (Number(b.pinned) - Number(a.pinned)) || ((b.updatedAt || 0) - (a.updatedAt || 0));
    });

    return {
        query,
        parsed: {
            terms: parsed.terms,
            phrases: parsed.phrases,
            excluded: parsed.excluded,
            filters: {
                pinned: parsed.pinned,
                open: parsed.open,
                working: parsed.working,
                has: [...parsed.has],
                from: parsed.from,
                tool: parsed.tool,
                host: parsed.host,
                after: parsed.after,
                before: parsed.before,
            },
        },
        meaning,
        total: results.length,
        results: results.slice(0, limit),
    };
}

module.exports = { search, parse, parseDate, scan, excerpt, passageOf, _test: { sketchText } };
