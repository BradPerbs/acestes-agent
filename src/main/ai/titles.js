/**
 * What a conversation is called.
 *
 * It used to be the first message cut at eighty characters, which in a list
 * reads as "hey can you have a look at the web box, it's been throwing 502s
 * since" rather than as what the chat is about. So a conversation is named
 * the way Claude and Codex name theirs: the runtime it runs on is asked, once
 * and off to the side of the chat, for a few words that say what the task is.
 *
 * Until that answer is in, and on a runtime with no way to ask, the name is
 * the first message tidied: the greeting and the "can you" dropped, cut at a
 * word, capitalised. That is also what stays if the question fails.
 */

/** Longest name a list is asked to draw, in characters. */
const MAX_LENGTH = 60;

/** How long the runtime gets to answer before the tidied message stands. */
const TIMEOUT = 60 * 1000;

/** How much of each message the namer is shown. The start says what it is. */
const SHOWN = 1500;

const INSTRUCTION = [
    'You name conversations between a person and an IT agent.',
    'Reply with a title of 3 to 6 words that describes what the conversation is about, the way a short subject line would:',
    '"Fix 502 errors on web-01", "Rotate SSH keys on staging", "Disk space alert on db-02", "Set up nightly Postgres backups".',
    'Sentence case. Keep host, service and product names as written. No quotes, no trailing punctuation, no emoji.',
    'Write it in the language the person wrote in.',
    'Reply with the title and nothing else. Do not answer the request or act on it.',
].join(' ');

/** The question put to the runtime: the first messages, fenced. */
function request(messages) {
    const said = messages
        .map(text => String(text || '').trim().slice(0, SHOWN))
        .filter(Boolean)
        .map(text => `User: ${text}`)
        .join('\n\n');
    return `Name this conversation. Reply with the title only.\n\n<conversation>\n${said}\n</conversation>`;
}

/** A greeting, a filler word, or a run of them, at the start of a message. */
const OPENERS = /^(?:(?:hi|hey|hello|hiya|yo|ok|okay|so|um|uh|please|pls|thanks|quick question)\b[\s,!.:;-]*)+/i;

/** How a request is often asked, which says nothing about what it is for. */
const ASKS = /^(?:(?:can|could|would|will) you(?: please)?|please|i (?:want|need|would like) (?:you )?to|i'd like (?:you )?to|help me(?: to)?|let's|lets)\b[\s,]*/i;

/** Cut to `max` characters at a word, with an ellipsis if anything went. */
function cut(text, max = MAX_LENGTH) {
    if (text.length <= max) return text;
    const head = text.slice(0, max - 1);
    const space = head.lastIndexOf(' ');
    return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s,;:.-]+$/, '')}…`;
}

/**
 * The first message, as a name to go on with.
 *
 * Only the first sentence when it says enough on its own: the rest of a
 * message is usually the detail, and the detail is what the name leaves out.
 */
function fromMessage(text) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return '';

    let rest = flat;
    for (let pass = 0; pass < 3; pass += 1) {
        const next = rest.replace(OPENERS, '').replace(ASKS, '');
        if (next === rest) break;
        rest = next;
    }
    if (!rest) rest = flat;

    const sentence = rest.match(/^.+?[.!?](?=\s|$)/)?.[0];
    if (sentence && sentence.length >= 12) rest = sentence;
    rest = rest.replace(/[\s.!?,;:]+$/, '') || rest;

    return cut(rest.charAt(0).toUpperCase() + rest.slice(1));
}

/**
 * Whether a first message says too little to be named from: "hi", "help",
 * "are you there". Those wait for the second message.
 */
function tooThin(text) {
    const words = String(text || '').replace(OPENERS, '').trim().split(/\s+/).filter(Boolean);
    return words.length < 3;
}

/**
 * The runtime's answer, as a name, or '' if it is not one.
 *
 * Models dress a title up however they were told not to: a "Title:" label,
 * quotes, bold, a full stop. Those come off. An answer that runs to a
 * paragraph is the model answering the request instead, and is refused.
 */
function clean(reply) {
    const line = String(reply || '')
        // A local reasoning model thinks out loud in the reply itself.
        .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
        .split(/\r?\n/)
        .map(entry => entry.trim())
        .find(Boolean) || '';
    const name = line
        .replace(/^#+\s*/, '')
        .replace(/^(?:\*\*)?title(?:\*\*)?\s*:\s*/i, '')
        .replace(/^["'“”‘’`*_]+|["'“”‘’`*_.。]+$/g, '')
        .replace(/[.。]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!name || name.split(' ').length > 12) return '';
    return cut(name);
}

/**
 * Ask the runtime for a name. Resolves '' whenever there is none to be had:
 * a runtime that cannot be asked, a failure, a timeout, or an answer that is
 * not a title. Never rejects, because the tidied message is always there.
 */
async function generate(provider, { settings, messages }) {
    if (typeof provider?.title !== 'function') return '';
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT);
    timer.unref?.();
    try {
        const reply = await provider.title({
            settings,
            instruction: INSTRUCTION,
            prompt: request(messages),
            signal: abort.signal,
        });
        return abort.signal.aborted ? '' : clean(reply);
    } catch {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    fromMessage,
    tooThin,
    generate,
    MAX_LENGTH,
    _test: { clean, cut, request, INSTRUCTION },
};
