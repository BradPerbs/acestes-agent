/**
 * Tidying an agent's notebook, the question half. See memory.js for what a
 * tidy may change and how it is undone.
 *
 * A notebook written one note at a time drifts: the same rule saved twice in
 * two conversations, a change noted as uncommitted and again as committed, a
 * long log of a finished task that no later conversation needs, a preference
 * filed as a fact so it never reaches the prompt. Agents that keep memory well
 * all have a step for this, off to the side of the work: Letta's sleep-time
 * agent, Claude Code's Auto Dream, ChatGPT's Dreaming, mem0's update phase.
 *
 * Here it is one question, put to the runtime the agent runs on the way a
 * conversation's title is (see titles.js): no tools, one turn, no session in
 * the user's history. It is shown the notes and answers with operations,
 * which memory.js checks and applies; it never writes anything itself.
 */

/** How long the runtime gets to answer one batch of notes (see tidyBatches in memory.js). */
const TIMEOUT = 5 * 60 * 1000;

/**
 * How much the model may think before answering, for a runtime that lets it
 * be set (Claude Code). Left to itself a small model thought for two minutes
 * over eight notes; with no thinking it answered in eight seconds but filed
 * notes worse. A cap keeps most of the judgement at a fraction of the wait.
 */
const THINK = 2048;

function instruction({ today, ruleChars, ruleBudget }) {
    return [
        'You keep the long-term memory of an AI agent that works for one person: a notebook of short notes the agent reads in later conversations.',
        'You are given the notebook, or the part of it that changed, as JSON lines. Return the changes that make it accurate, small and easy to search. Change nothing that is fine as it is.',
        '',
        'Each note has a kind:',
        '- rule: a standing instruction or preference that applies to every task this agent does ("Never add a co-author line to commits", "Reply in short sentences"). Every rule is put into every conversation, so keep rules few and short. A preference that only matters for one project, tool or kind of task is a fact, not a rule.',
        '- fact: something that stays true until it changes: how a machine, project or service is set up, where something lives, how a procedure goes, what a fix turned out to be.',
        '- event: something that happened at a time: a release, a deploy, an incident. Keep its date in the text.',
        '',
        'Operations, as JSON objects:',
        '- {"op":"merge","ids":["a","b"],"text":"...","kind":"...","tags":["..."],"reason":"..."}: two or more notes say the same thing, or one continues another (a change noted as uncommitted and the later note that it was committed). The text keeps every detail that still holds, as things stand now.',
        '- {"op":"edit","id":"a","text":"...","kind":"...","tags":["..."],"reason":"..."}: fix a note\'s kind, shorten it, or bring it up to date with what a later note says. Leave out "text" to change only the kind or tags.',
        '- {"op":"delete","id":"a","reason":"..."}: a note that is wrong now, superseded by another, or of no use to a later conversation (a step-by-step log of a finished task, a commit hash only git needs).',
        '',
        'Work through the notebook in this order:',
        `1. Rules. Every rule is put into every conversation, and together they should fit in about ${ruleBudget} characters (they are ${ruleChars} now). Merge rules that say the same thing into one. A rule that only matters for one project, one tool or one kind of task (a website's fonts, one repository's conventions, how to word one customer's tickets) is a fact: refile it, and it will still be found whenever that subject comes up. The notebook belongs to one agent, so a rule about how this agent should work with the person (how much to ask, how to explain, what never to do) stays a rule.`,
        '2. Duplicates and sequels. Merge notes about the same thing into one that says how things stand now: a change noted as uncommitted and a later note that it was committed become one note that it was committed.',
        '3. Kinds. A note about how something is now (where code lives, how a feature behaves, how a procedure goes, a lesson learned) is a fact, even when it also says which commit or day it came with. An event is a note whose point is that something happened at a time.',
        '4. Length. Rewrite a note over 400 characters to its lasting content in under 300: drop commit hashes, run ids and step-by-step logs unless they are the point of the note.',
        '5. Stale notes. Delete a note only when a later note supersedes it, or when it can be of no use in a later conversation. Age alone is not a reason: an old fix is how the next one goes faster.',
        '',
        'Constraints:',
        '- Never invent anything. Every fact in a note you write must come from the notes given.',
        '- Keep names exactly as written: hosts, paths, commands, ids, versions, URLs, people.',
        '- A note with "source":"user" was written by the person: do not change its text, merge it or delete it. You may change its kind or tags.',
        '- Delete a rule only when it says the same as another rule that stays, and name that rule\'s id in the reason; better, merge them.',
        '- One subject per note. When unsure, leave a note alone.',
        '- Tags: one to five short lowercase words for what the note is about (a project, a system, a tool), not its state ("fixed", "uncommitted"). Only change tags when they are missing or wrong.',
        `- Today is ${today}.`,
        '',
        'Reply with JSON only, no prose and no code fence: {"ops":[...]}. Reply {"ops":[]} if nothing needs to change.',
    ].join('\n');
}

/** The question: the notes, one JSON object a line, fenced. */
function request(notes) {
    const lines = notes.map(note => JSON.stringify({
        id: note.id,
        kind: note.kind,
        source: note.source,
        created: note.created,
        updated: note.updated,
        tags: note.tags,
        text: note.text,
    }));
    return `Tidy this notebook. Reply with the JSON only.\n\n<notes>\n${lines.join('\n')}\n</notes>`;
}

/**
 * The runtime's answer, as operations. Models wrap JSON however they were
 * told not to: a fence, a sentence before it, a reasoning block. Those come
 * off; what is left has to be an object with an `ops` list, or a bare list.
 */
function parse(reply) {
    const text = String(reply || '')
        .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
        .replace(/```(?:json)?/gi, '')
        .trim();
    if (!text) return { ok: false, error: 'The runtime gave no answer.' };
    const candidates = [];
    const object = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    if (object) candidates.push(object);
    const array = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    if (array) candidates.push(array);
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate);
            const ops = Array.isArray(value) ? value : value?.ops;
            if (Array.isArray(ops)) {
                return { ok: true, ops: ops.filter(op => op && typeof op === 'object' && ['merge', 'edit', 'delete'].includes(op.op)) };
            }
        } catch {
            // Try the next reading.
        }
    }
    return { ok: false, error: 'The runtime\'s answer was not a list of changes.' };
}

/**
 * Ask the runtime what to change. Resolves `{ ok, ops }` or `{ ok: false,
 * error }`; never rejects, since a tidy that fails changes nothing.
 */
async function ask(provider, { settings, notes, ruleChars = 0, ruleBudget = 0, today = new Date().toISOString().slice(0, 10) }) {
    if (typeof provider?.title !== 'function') return { ok: false, error: 'This agent\'s runtime cannot be asked to tidy its notes.' };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT);
    timer.unref?.();
    try {
        const reply = await provider.title({
            settings,
            instruction: instruction({ today, ruleChars, ruleBudget }),
            prompt: request(notes),
            signal: abort.signal,
            think: THINK,
        });
        if (abort.signal.aborted) return { ok: false, error: 'The runtime took too long to answer.' };
        return parse(reply);
    } catch (error) {
        if (abort.signal.aborted) return { ok: false, error: 'The runtime took too long to answer.' };
        return { ok: false, error: error?.message || 'The runtime could not be asked.' };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { ask, _test: { instruction, request, parse } };
