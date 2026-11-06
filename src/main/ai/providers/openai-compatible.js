const zodModule = require('zod');
const catalog = require('../tools');

// As in `tools.js`: zod 4 answers to either name depending on how it is
// reached, and taking whichever exists keeps this working on both builds.
const z = zodModule.z || zodModule;

/**
 * The agent loop, for servers that speak the OpenAI chat API and nothing else.
 *
 * The other three providers each drive a coding agent that someone installed:
 * the agent owns the loop, the tool calling and the model, and the file next to
 * this one is a translator between its stream and this app's transcript. There
 * is no such agent behind a model server. LM Studio, Ollama, llama.cpp and vLLM
 * answer one request with one completion, so the loop has to live here: send
 * the conversation with the tool definitions attached, run whatever tools come
 * back, send the results, repeat until the model stops asking for tools.
 *
 * That is the whole of this file, and it is deliberately not specific to any
 * one of them. `local.js` points it at a server on this machine and `grok.js`
 * at api.x.ai when the Grok Build CLI is not installed. Anything else that
 * speaks the same shape is a caller away.
 *
 * Two consequences worth knowing.
 *
 * There are no local tools here. The model gets the tools this app hands it and
 * has no others, so the "may it touch this machine" switch has nothing to turn
 * off: every call goes to a server through `tools.js`, and every one of them
 * passes the same approval gate the other providers stop at.
 *
 * The conversation lives in this process. An agent CLI keeps its own history on
 * disk and takes a session id to resume; here the messages are the history, so
 * they are kept in `histories` below and a conversation that is parked and
 * picked up again finds them.
 */

/** How long one request may take before it is abandoned. */
const REQUEST_TIMEOUT = 10 * 60 * 1000;

/**
 * How many messages a conversation carries into the next request.
 *
 * Local models are the reason there is a cap at all: a 8k context is common,
 * and a conversation that has run for twenty tool calls will not fit in one.
 * The oldest go first, which loses the beginning of a long session rather than
 * failing the next request outright.
 */
const MAX_MESSAGES = 80;

/** How many conversations keep their history once they are parked. */
const MAX_HISTORIES = 12;

/** sessionId -> the message array that is that conversation. */
const histories = new Map();

let counter = 0;

function nextSessionId(prefix) {
    counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/* ------------------------------------------------------------------ *
 * The tools, as this API wants them
 * ------------------------------------------------------------------ */

const toolCaches = new Map();

/** Bundle signature for the function-tool cache: one entry per toggle set. */
function bundleKey(settings) {
    if (!settings) return 'all';
    const bundles = settings.toolBundles;
    if (!bundles || typeof bundles !== 'object') return 'all';
    return catalog.BUNDLES.map(bundle => (bundles[bundle.id] !== false ? '1' : '0')).join('')
        + (settings.allowLocalTools === false ? '0' : '1')
        + (settings.computerUse ? '1' : '0')
        + (settings.memory === false ? '0' : '1');
}

/**
 * The catalog as OpenAI function definitions.
 *
 * `tools.js` describes its arguments in zod, because that is what the Claude
 * SDK and the MCP server both take. This API wants JSON Schema, and zod 4
 * writes it, so the shapes are converted once rather than maintained twice.
 * The `$schema` line goes: it says which dialect the document is in, which is
 * true and which several servers reject as an unknown key.
 *
 * Cached per bundle-toggle set: bundle switches change what is offered.
 */
function functionTools(settings) {
    const key = bundleKey(settings);
    const cached = toolCaches.get(key);
    if (cached) return cached;

    const definitions = settings ? catalog.visibleTools(settings) : catalog.TOOLS;
    const built = definitions.map((definition) => {
        const { $schema, ...parameters } = z.toJSONSchema(z.object(definition.shape), {
            target: 'draft-7',
            io: 'input',
        });
        return {
            type: 'function',
            function: {
                name: definition.name,
                description: definition.description,
                parameters,
            },
        };
    });

    toolCaches.set(key, built);
    // A handful of toggle sets at most; cap paranoia against unbounded growth.
    if (toolCaches.size > 16) toolCaches.delete(toolCaches.keys().next().value);
    return built;
}

/* ------------------------------------------------------------------ *
 * Reading the stream
 * ------------------------------------------------------------------ */

/**
 * Server-sent events, one JSON payload at a time.
 *
 * Chunks arrive on byte boundaries rather than line boundaries, so a payload
 * routinely spans two of them. This holds the tail until it has a whole line.
 * `[DONE]` is the sentinel that ends the stream and is not JSON, so it is
 * dropped here rather than at every call site.
 */
function createSseReader() {
    let buffer = '';

    return {
        push(text) {
            buffer += text;
            const payloads = [];

            let index = buffer.indexOf('\n');
            while (index >= 0) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');

                if (!line.startsWith('data:')) continue;
                const body = line.slice(5).trim();
                if (!body || body === '[DONE]') continue;
                try {
                    payloads.push(JSON.parse(body));
                } catch {
                    // A half-written payload, or a server writing something
                    // that is not JSON on this channel. Neither is worth
                    // ending a turn over.
                }
            }

            return payloads;
        },
    };
}

/**
 * One completion, assembled from however many chunks it arrived in.
 *
 * Both shapes are read: a streamed `delta` and, for the servers that ignore
 * `stream`, a whole `message`. The reasoning field has three spellings in the
 * wild and they are all taken, since which one a server uses is a property of
 * whose fork it was built from rather than of anything the user chose.
 */
function createCollector(onEvent) {
    const calls = new Map();
    let content = '';
    let usage = null;
    let finish = '';

    const readCall = (raw, position) => {
        const key = raw.index ?? raw.id ?? position;
        const call = calls.get(key) || { id: '', name: '', args: '' };
        if (raw.id) call.id = raw.id;
        if (raw.function?.name) call.name = raw.function.name;
        if (typeof raw.function?.arguments === 'string') call.args += raw.function.arguments;
        calls.set(key, call);
    };

    return {
        chunk(payload) {
            if (payload?.usage) usage = payload.usage;

            const choice = payload?.choices?.[0];
            if (!choice) return;
            if (choice.finish_reason) finish = choice.finish_reason;

            const part = choice.delta || choice.message;
            if (!part) return;

            const thinking = part.reasoning_content ?? part.reasoning ?? part.thinking;
            if (typeof thinking === 'string' && thinking) {
                onEvent({ type: 'thinking-delta', text: thinking });
            }

            if (typeof part.content === 'string' && part.content) {
                content += part.content;
                onEvent({ type: 'text-delta', text: part.content });
            }

            (part.tool_calls || []).forEach(readCall);
        },
        result() {
            return {
                content,
                usage,
                finish,
                // Anything without a name is a fragment of a call the stream
                // never finished, which is what a cut-off response looks like.
                toolCalls: [...calls.values()]
                    .filter(call => call.name)
                    .map((call, position) => ({ ...call, id: call.id || `call-${position}` })),
            };
        },
    };
}

/**
 * What the server said went wrong, in a sentence rather than a status code.
 *
 * Model servers put the reason in a JSON body far more often than in the
 * status line, and "400" on its own sends people to the wrong place entirely
 * when the actual answer is "this model was loaded without tool support".
 */
async function httpFailure(response, label) {
    let detail = '';
    try {
        const body = (await response.text()).slice(0, 2000);
        try {
            const parsed = JSON.parse(body);
            detail = parsed?.error?.message || parsed?.error || parsed?.message || body;
        } catch {
            detail = body;
        }
    } catch {
        // Nothing readable on the wire.
    }
    detail = String(detail || '').trim();
    return new Error(`${label} answered ${response.status}${detail ? `: ${detail}` : ''}`);
}

/**
 * One request, streamed if the server is willing.
 *
 * A server that ignores `stream` and answers with one JSON document is not
 * broken, it is just older, and the collector reads that shape too. So the
 * content type decides how the body is read rather than which code path the
 * conversation is on.
 */
async function complete({ endpoint, messages, model, tools, extra, signal, onEvent }) {
    const headers = { 'Content-Type': 'application/json', ...(endpoint.headers || {}) };
    if (endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

    const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        signal,
        body: JSON.stringify({
            model,
            messages,
            stream: true,
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
            ...extra,
        }),
    });

    if (!response.ok) throw await httpFailure(response, endpoint.label);

    const collector = createCollector(onEvent);
    const streaming = String(response.headers.get('content-type') || '').includes('event-stream');

    if (!streaming) {
        const payload = await response.json();
        collector.chunk(payload);
        return collector.result();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = createSseReader();

    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const payload of sse.push(decoder.decode(value, { stream: true }))) {
            collector.chunk(payload);
        }
    }

    return collector.result();
}

/** One question and its answer, with no tools and no history: how a conversation's name is asked for. */
async function ask({ endpoint, model, instruction, prompt, signal }) {
    const reply = await complete({
        endpoint,
        model,
        messages: [
            { role: 'system', content: instruction },
            { role: 'user', content: prompt },
        ],
        tools: [],
        extra: {},
        signal,
        onEvent: () => {},
    });
    return String(reply.content || '');
}

/* ------------------------------------------------------------------ *
 * The conversation
 * ------------------------------------------------------------------ */

/**
 * The messages to send, once the oldest have been dropped to fit.
 *
 * The system message is kept whatever happens: it is what tells the model it
 * is operating servers rather than writing code, and a conversation that
 * forgets that is worse than one that forgets its first ten turns.
 *
 * The one rule about where to cut is that a `tool` message must answer a call
 * that is still in the list. Left at the front it answers nothing, and every
 * server refuses the request rather than ignoring the orphan.
 */
function trimHistory(messages, max = MAX_MESSAGES) {
    if (messages.length <= max) return messages;

    const head = messages[0]?.role === 'system' ? [messages[0]] : [];
    const rest = messages.slice(head.length).slice(-(max - head.length));
    while (rest.length > 0 && rest[0].role === 'tool') rest.shift();
    return [...head, ...rest];
}

/* ------------------------------------------------------------------ *
 * Compaction
 *
 * Dropping the oldest messages loses the start of the task, which is the
 * part that says what the task was. So before the cap bites, the middle
 * of the conversation is summarised by the same model and folded into one
 * message, with every tool call's command and outcome kept as a line of
 * provenance. The most recent messages stay verbatim, because that is
 * where the work is. Rules that must survive are in the system prompt
 * already and are never entrusted to the summary.
 *
 * Triggered well before the window is full, as the harness literature
 * says to: by message count here, since a local model's window is not
 * known to this code, and by characters as a second guard.
 * ------------------------------------------------------------------ */

/** Compact once the history grows past this many messages ... */
const COMPACT_AT = 48;
/** ... or this many characters of content, whichever comes first. */
const COMPACT_CHARS = 120000;
/** How many recent messages stay verbatim after a compaction. */
const KEEP_TAIL = 12;
/**
 * Over on characters, how much a summary has to fold away to be worth one.
 * When the weight is in what stays verbatim (the system prompt, the summary,
 * the last few messages) a summary frees nothing, and the very next step is
 * over again: that is how it came to summarise after every single call.
 */
const MIN_FOLD_CHARS = 40000;
/** Provenance lines the summary carries, newest kept: one per tool call ever made would grow forever. */
const MAX_PROVENANCE = 40;
/** A summary is asked for in under 400 words; this is the backstop if the model ignores that. */
const MAX_SUMMARY_CHARS = 8000;

const SUMMARY_MARK = '[Earlier in this conversation, summarised]';
const PROVENANCE_MARK = 'Tool calls so far, in order';

function contentLength(message) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
    return text.length + JSON.stringify(message.tool_calls ?? '').length;
}

/** The summary a previous compaction left, which a new one replaces rather than frees. */
const isSummary = message => message?.role === 'user' && String(message.content || '').startsWith(SUMMARY_MARK);

/*
 * The limits above are for a window nobody has said: a local server reports
 * none, and 120k characters is safe for the small contexts those run with.
 * When the window is known (picked on the composer's context ring, or listed
 * by the server for the model, as OpenRouter does), the history gets its real
 * share of it instead.
 */

/** Characters per token, low on purpose: code and JSON run near 3, prose near 4. */
const CHARS_PER_TOKEN = 3;
/** How full the window gets before the middle is summarised, leaving room for the reply. */
const COMPACT_SHARE = 0.75;
/** However small the window, a history is allowed this much before it is summarised. */
const MIN_COMPACT_CHARS = 20000;
/** With a known window, message counts stop mattering; these are backstops only. */
const WINDOWED_COMPACT_AT = 600;
const WINDOWED_MAX_MESSAGES = 1000;

const DEFAULT_LIMITS = Object.freeze({
    compactAt: COMPACT_AT,
    compactChars: COMPACT_CHARS,
    minFold: MIN_FOLD_CHARS,
    maxMessages: MAX_MESSAGES,
});

/**
 * The history's limits for a window of `window` tokens, after the tool
 * definitions sent beside it on every request (`overheadChars`). No window,
 * the defaults.
 */
function limitsFor(window, overheadChars = 0) {
    const tokens = Number(window);
    if (!Number.isFinite(tokens) || tokens <= 0) return DEFAULT_LIMITS;
    const compactChars = Math.max(MIN_COMPACT_CHARS, Math.round(tokens * CHARS_PER_TOKEN * COMPACT_SHARE) - overheadChars);
    return {
        compactAt: WINDOWED_COMPACT_AT,
        compactChars,
        minFold: Math.min(MIN_FOLD_CHARS, Math.round(compactChars / 3)),
        maxMessages: WINDOWED_MAX_MESSAGES,
    };
}

function historyChars(messages) {
    let total = 0;
    for (const message of messages) total += contentLength(message);
    return total;
}

/**
 * The composer's context ring, after one reply: what the request held and
 * what came back, over the window. From the server's own count when it sends
 * one (OpenRouter always does); otherwise estimated from the characters, at
 * four to a token, and marked so, rather than leaving the ring empty.
 *
 * `limit` is the window the turn ran on; `modelLimit` the one the server
 * lists for the model, which the ring's menu offers as the default.
 */
function contextReading({ usage, messages, overheadChars = 0, window = 0, listed = 0, model = '' }) {
    const prompt = Number(usage?.prompt_tokens) || 0;
    const reported = prompt > 0;
    const used = reported
        ? prompt + (Number(usage.completion_tokens) || 0)
        : Math.round((historyChars(messages) + overheadChars) / 4);
    const cached = Number(usage?.prompt_tokens_details?.cached_tokens) || 0;
    return {
        type: 'context',
        used,
        limit: window || 0,
        percent: window ? Math.round((used / window) * 100) : null,
        model,
        modelLimit: listed || 0,
        ...(cached > 0 ? { cached } : {}),
        ...(reported ? {} : { estimated: true }),
    };
}

function needsCompaction(messages, limits = DEFAULT_LIMITS) {
    if (messages.length >= limits.compactAt) return true;
    if (historyChars(messages) < limits.compactChars) return false;
    let foldable = 0;
    for (const message of splitForCompaction(messages).middle) {
        if (!isSummary(message)) foldable += contentLength(message);
    }
    return foldable >= limits.minFold;
}

/**
 * Split a history into what to summarise and what to keep.
 *
 * The tail starts on a `user` or `assistant` message that is not a tool
 * answer, so no `tool` message is left answering a call that was folded.
 */
function splitForCompaction(messages, keepTail = KEEP_TAIL) {
    const head = messages[0]?.role === 'system' ? [messages[0]] : [];
    const body = messages.slice(head.length);
    if (body.length <= keepTail + 2) return { head, middle: [], tail: body };
    let cut = body.length - keepTail;
    while (cut > 0 && (body[cut].role === 'tool' || (body[cut].role === 'assistant' && body[cut - 1]?.role === 'assistant'))) cut -= 1;
    return { head, middle: body.slice(0, cut), tail: body.slice(cut) };
}

/** The lines of provenance a summary must keep: what was run, what came back. */
function provenance(middle) {
    const lines = [];
    const calls = new Map();
    for (const message of middle) {
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                calls.set(call.id, `${call.function?.name || 'tool'} ${String(call.function?.arguments || '').slice(0, 200)}`);
            }
        } else if (message.role === 'tool') {
            const what = calls.get(message.tool_call_id) || 'tool';
            const outcome = String(message.content || '').replace(/\s+/g, ' ').slice(0, 160);
            lines.push(`- ${what} → ${outcome}`);
        }
    }
    return lines;
}

/** The provenance lines a previous summary carried, to be continued rather than repeated. */
function previousProvenance(content) {
    const at = String(content || '').indexOf(`\n${PROVENANCE_MARK}`);
    if (at < 0) return [];
    return content.slice(at + 1).split('\n').slice(1).filter(line => line.startsWith('- '));
}

/**
 * Fold a summary and the tail back into one history. Pure.
 *
 * The new summary replaces the previous one: it was written with the previous
 * one in front of it (see summaryRequest), so nothing is lost by not carrying
 * the old text along too. Carrying it along is what made the summary grow by
 * a whole summary every time, until it alone kept the history over the
 * limit. The provenance continues the previous list, newest kept.
 */
function foldHistory(messages, summary, keepTail = KEEP_TAIL) {
    const { head, middle, tail } = splitForCompaction(messages, keepTail);
    if (middle.length === 0) return messages;
    const previous = isSummary(middle[0]) ? middle[0].content : '';
    const lines = [...previousProvenance(previous), ...provenance(middle)];
    const kept = lines.slice(-MAX_PROVENANCE);
    const dropped = lines.length - kept.length;
    const header = `${PROVENANCE_MARK}${dropped > 0 ? ` (the latest ${kept.length}; ${dropped} earlier not listed)` : ''}:`;
    const folded = {
        role: 'user',
        content: `${SUMMARY_MARK}\n\n${summary.trim().slice(0, MAX_SUMMARY_CHARS)}\n\n${header}\n${kept.join('\n') || '- none'}`,
    };
    return [...head, folded, ...tail];
}

/**
 * The request that writes the summary: the middle, and an instruction.
 *
 * A previous summary leads the middle and goes in whole, not cut like the
 * other messages, since the new summary replaces it and has to carry it.
 */
function summaryRequest(middle) {
    const transcript = middle.map((message) => {
        if (isSummary(message)) return `PREVIOUS SUMMARY (carry everything in it forward):\n${String(message.content).slice(SUMMARY_MARK.length).trim()}`;
        if (message.role === 'tool') return `TOOL RESULT: ${String(message.content || '').slice(0, 600)}`;
        const calls = Array.isArray(message.tool_calls)
            ? message.tool_calls.map(call => `CALL ${call.function?.name}(${String(call.function?.arguments || '').slice(0, 200)})`).join('\n')
            : '';
        return `${message.role.toUpperCase()}: ${String(message.content || '').slice(0, 1500)}${calls ? `\n${calls}` : ''}`;
    }).join('\n\n');
    return [
        { role: 'system', content: 'You write a compact working summary of an agent conversation so the agent can continue it. Keep: the task as the user stated it, decisions taken, facts learned about the systems, what was tried and what happened, and what is still to do. When the span opens with a previous summary, write one summary that replaces it: carry forward what still matters from it, merged with what happened since, not appended after it. Do not list tool calls; those are kept separately. Drop pleasantries. Write in plain prose with short lists, under 400 words.' },
        { role: 'user', content: `Summarise this span of the conversation:\n\n${transcript.slice(0, 60000)}` },
    ];
}

/**
 * Compact in place if the history has grown enough, using the model to
 * write the summary. Falls back to trimming if the summary request fails,
 * which loses more than a summary would but never leaves the loop stuck.
 */
async function compactHistory(messages, { endpoint: target, model: name, extra: params, signal, limits = DEFAULT_LIMITS }) {
    if (!needsCompaction(messages, limits)) return false;
    const { middle } = splitForCompaction(messages);
    if (middle.length === 0) return false;
    try {
        const reply = await complete({
            endpoint: target,
            messages: summaryRequest(middle),
            model: name,
            tools: [],
            extra: params,
            signal,
            onEvent: () => {},
        });
        const summary = String(reply.content || '').trim();
        if (!summary) throw new Error('empty summary');
        messages.splice(0, messages.length, ...foldHistory(messages, summary));
        return true;
    } catch {
        messages.splice(0, messages.length, ...trimHistory(messages, limits.maxMessages));
        return false;
    }
}

/** Whatever a tool handler returned, as the string a `tool` message carries. */
function resultText(result) {
    const text = String(result?.text ?? '');
    return text.trim() ? text : '(the tool returned nothing)';
}

/**
 * Run one tool call, under the same policy every other provider stops at.
 *
 * The order matters and is the same as in `mcp-host.js`: blocked outright,
 * then the approval gate, then the handler. A blocked command never becomes a
 * card, because there is no answer to that card that would let it run.
 */
async function runTool({ call, toolContext, requestApproval, onEvent }) {
    const definition = catalog.BY_NAME.get(call.name);
    if (!definition) {
        return `There is no tool called ${call.name}. Use one of the tools you were given.`;
    }

    let input;
    try {
        input = call.args.trim() ? JSON.parse(call.args) : {};
    } catch {
        return `The arguments for ${call.name} were not valid JSON, so nothing was run. `
            + 'Send the call again with a well-formed JSON object.';
    }

    onEvent({ type: 'tool-call', id: call.id, name: call.name, input, local: false });

    const context = toolContext();
    const settings = context.settings;

    const blocked = catalog.blockedReason(call.name, input, settings);
    if (blocked) {
        onEvent({ type: 'tool-blocked', name: call.name, rule: blocked });
        const message = catalog.blockedMessage(blocked);
        onEvent({ type: 'tool-result', id: call.id, text: message, isError: true });
        return message;
    }

    if (!catalog.isAutoApproved(call.name, input, settings)) {
        const verdict = await requestApproval({
            toolName: call.name,
            name: call.name,
            input,
            local: false,
        });
        if (!verdict.approved) {
            const message = verdict.message || 'The user declined that.';
            onEvent({ type: 'tool-result', id: call.id, text: message, isError: true });
            return message;
        }
    }

    try {
        const result = await catalog.invoke(definition, input, context);
        const text = resultText(result);
        onEvent({ type: 'tool-result', id: call.id, text, isError: Boolean(result?.isError) });
        return text;
    } catch (error) {
        // Handed back rather than thrown, for the reason the Claude provider
        // gives: a returned error lets the model read what went wrong and try
        // something else, where a thrown one ends the turn.
        onEvent({ type: 'tool-failed', name: call.name, message: error.message });
        const text = `The ${call.name} tool failed: ${error.message}`;
        onEvent({ type: 'tool-result', id: call.id, text, isError: true });
        return text;
    }
}

/**
 * Start a conversation against an OpenAI-shaped endpoint.
 *
 *   label       what to call this server when something goes wrong
 *   prefix      what its session ids look like, for the history above
 *   endpoint    a function of the current settings returning
 *               `{ baseUrl, apiKey, headers, label }`. Read per turn, so an
 *               address or a key changed in settings lands on the next message
 *   model       a function of the current settings returning the model id to
 *               ask for, since what "no choice" means differs by provider. It
 *               may answer with a promise: a local server has to be asked what
 *               it has loaded before anything can be sent to it
 *   extra       a function of the current settings returning fields to merge
 *               into the request body, for reasoning effort and its friends
 *
 * The rest is the shape every provider in this folder is started with.
 */
async function start({
    label,
    prefix = 'chat',
    endpoint,
    model,
    extra = () => ({}),
    settings,
    getSettings = () => settings,
    systemPrompt,
    toolContext,
    requestApproval,
    onEvent,
    resumeSessionId = '',
}) {
    const sessionId = resumeSessionId && histories.has(resumeSessionId)
        ? resumeSessionId
        : nextSessionId(prefix);

    const messages = histories.get(sessionId) || [{ role: 'system', content: systemPrompt }];
    // Deleted before it is set so it moves to the end of the map: a
    // conversation being picked up again is the last thing that should be
    // forgotten, and a plain `set` would leave it where it first landed.
    histories.delete(sessionId);
    histories.set(sessionId, messages);

    // Oldest first, so the map is capped by forgetting conversations nobody
    // has been near rather than the one being started.
    for (const key of [...histories.keys()].slice(0, Math.max(0, histories.size - MAX_HISTORIES))) {
        histories.delete(key);
    }

    onEvent({ type: 'session', sessionId, model: settings.model || '' });

    const tools = functionTools(toolContext?.()?.settings);
    // Sent beside the history on every request, so it comes off the window.
    const toolChars = JSON.stringify(tools).length;
    let abort = null;
    let running = Promise.resolve();
    let closed = false;
    // Stop is not only about the request in flight. A turn spends most of its
    // time in a tool call, waiting on an approval or on a command running over
    // ssh, and aborting the fetch does nothing to either: without this the loop
    // would come back from the tool and cheerfully start the next request.
    let stopped = false;

    async function turn(text) {
        const current = getSettings();
        const target = endpoint(current);
        const name = await model(current);
        // The window: the size picked on the composer's context ring, else
        // the one the server lists for the model, else unknown and the
        // defaults. Read each turn, so a pick applies from the next one.
        const listed = await modelWindow(target, name);
        const window = Number(current.contextWindow) > 0 ? Number(current.contextWindow) : listed;
        const limits = limitsFor(window, toolChars);

        stopped = false;
        messages.push({ role: 'user', content: text });

        // The step cap is the same setting the other agents are given, and it
        // does the same job: a model that has decided to read one more file
        // forever stops on its own rather than when somebody notices.
        // 0 is no ceiling: the loop ends when the model stops calling tools.
        const limit = current.maxTurns === 0 ? Infinity : Math.max(1, current.maxTurns || 40);

        // Every request's tokens, added up for the turn. The usage rides on
        // each reply, so a turn that only ever answered straight away could
        // report the last reply's; one that called tools would otherwise end
        // with nothing, and the limits page and the answer rate with it.
        let sawUsage = false;
        const turnUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        const collectUsage = (usage) => {
            if (!usage || typeof usage !== 'object') return;
            sawUsage = true;
            turnUsage.prompt_tokens += Number(usage.prompt_tokens) || 0;
            turnUsage.completion_tokens += Number(usage.completion_tokens) || 0;
            turnUsage.total_tokens += Number(usage.total_tokens) || 0;
        };

        for (let step = 0; step < limit; step += 1) {
            if (stopped) return;

            abort = new AbortController();
            const timer = setTimeout(() => abort?.abort(), REQUEST_TIMEOUT);
            let reply;
            try {
                // Summarised before it is cut, so the start of the task is
                // carried forward rather than dropped. See compactHistory.
                const compacted = await compactHistory(messages, {
                    endpoint: target, model: name, extra: extra(current), signal: abort.signal, limits,
                });
                // Said in the middle of the turn, which goes on after it.
                if (compacted) onEvent({ type: 'notice', tone: 'info', keepTurn: true, text: 'Earlier turns were summarised to keep the conversation within the model\'s context.' });
                messages.splice(0, messages.length, ...trimHistory(messages, limits.maxMessages));

                reply = await complete({
                    endpoint: target,
                    messages,
                    model: name,
                    tools,
                    extra: extra(current),
                    signal: abort.signal,
                    onEvent,
                });
            } finally {
                clearTimeout(timer);
            }

            messages.push({
                role: 'assistant',
                content: reply.content,
                ...(reply.toolCalls.length > 0 ? {
                    tool_calls: reply.toolCalls.map(call => ({
                        id: call.id,
                        type: 'function',
                        function: { name: call.name, arguments: call.args || '{}' },
                    })),
                } : {}),
            });

            // Before the tool calls, as the Claude provider does: the panel
            // treats the finished block as authoritative and clears whatever
            // streamed, so a call announced first would have the text land
            // underneath it.
            if (reply.content.trim()) onEvent({ type: 'assistant-text', text: reply.content });

            collectUsage(reply.usage);
            onEvent(contextReading({ usage: reply.usage, messages, overheadChars: toolChars, window, listed, model: name }));

            if (reply.toolCalls.length === 0) {
                onEvent({
                    type: 'result',
                    subtype: 'success',
                    isError: false,
                    costUsd: 0,
                    usage: sawUsage ? { ...turnUsage } : null,
                });
                return;
            }

            for (const call of reply.toolCalls) {
                // Every call still gets an answer, even once the user has
                // stopped: the model's next request has to see a result for
                // each call it made, or the conversation cannot be resumed at
                // all. What stops is the next request, at the top of the loop.
                const text = stopped
                    ? 'The user stopped the run before this could be done.'
                    : await runTool({ call, toolContext, requestApproval, onEvent });
                messages.push({ role: 'tool', tool_call_id: call.id, content: text });
            }
        }

        onEvent({
            type: 'result',
            subtype: 'error_max_turns',
            isError: true,
            costUsd: 0,
            usage: sawUsage ? { ...turnUsage } : null,
        });
    }

    return {
        send(text) {
            running = running
                .then(() => turn(text))
                .catch((error) => {
                    // A request the user aborted is not a failure to report.
                    // The panel has already said "Stopped."
                    if (closed || stopped || abort?.signal.aborted) return;
                    onEvent({ type: 'error', message: describeFailure(error, label) });
                })
                .finally(() => { abort = null; });
        },
        // Both are read from the settings when the next request is built, so
        // there is nothing to push at a running query.
        async setModel() {},
        async setEffort() {},
        async interrupt() {
            stopped = true;
            abort?.abort();
        },
        async close() {
            closed = true;
            stopped = true;
            abort?.abort();
            await running.catch(() => {});
            // The history stays: parking a conversation is meant to be
            // survivable, and for this provider the messages are the only
            // copy of it there is.
        },
    };
}

/**
 * What a server says it can run.
 *
 * Every one of these publishes `/models`, and it is the only honest source for
 * the menu: which models are loaded is a decision the user made in LM Studio
 * or Ollama a minute ago, and no list written here could know it.
 */
/** The server's `/models`, every row, as it sent them. */
async function fetchModelRows({ baseUrl, apiKey = '', headers = {}, label = 'The server' }) {
    const request = { ...headers };
    if (apiKey) request.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/models`, {
        headers: request,
        // Long enough for a machine that is busy loading a model, short enough
        // that a menu is not left spinning on an address nobody is listening at.
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw await httpFailure(response, label);

    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    return rows.filter(row => row && typeof row.id === 'string' && row.id);
}

/**
 * A model's context window in tokens, as its row says: OpenRouter's
 * `context_length`, LM Studio's `max_context_length`. 0 when it says nothing,
 * which is what most local servers say.
 */
function windowOf(row) {
    const value = Number(row?.context_length ?? row?.max_context_length ?? row?.top_provider?.context_length);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** baseUrl -> { at, windows: Map<model, tokens> }, so a turn does not list hundreds of models each time. */
const knownWindows = new Map();
const WINDOWS_TTL = 60 * 60 * 1000;

/**
 * The window the server lists for a model, or 0. Read once an hour per
 * address; a failure is remembered as nothing known, not retried every turn.
 */
async function modelWindow(endpoint, model) {
    if (!endpoint?.baseUrl || !model) return 0;
    let entry = knownWindows.get(endpoint.baseUrl);
    if (!entry || Date.now() - entry.at > WINDOWS_TTL) {
        let windows = new Map();
        try {
            const rows = await fetchModelRows(endpoint);
            windows = new Map(rows.map(row => [row.id, windowOf(row)]));
        } catch {
            // Nothing known; the defaults apply.
        }
        entry = { at: Date.now(), windows };
        knownWindows.set(endpoint.baseUrl, entry);
    }
    return entry.windows.get(model) || 0;
}

async function listModels({ baseUrl, apiKey = '', headers = {}, label = 'The server' }) {
    if (!baseUrl) return null;

    const rows = await fetchModelRows({ baseUrl, apiKey, headers, label });
    // The menu fetched them anyway: the windows are kept for the turns.
    knownWindows.set(baseUrl, { at: Date.now(), windows: new Map(rows.map(row => [row.id, windowOf(row)])) });

    return rows
        .map(row => ({
            value: row.id,
            resolved: row.id,
            label: row.id,
            // LM Studio and Ollama name a model by the repository it came
            // from, which is a path. The chip in the composer has room for the
            // last part of it, and the menu still shows the whole thing.
            short: row.id.split('/').pop(),
            description: String(row.owned_by || row.publisher || '').slice(0, 200),
            // Tokens, or 0 when the server does not say.
            context: windowOf(row),
            // Reasoning effort is not a field this API has. A model that thinks
            // does it because of how it was built, and a dial that changed
            // nothing would be a lie in the composer.
            effort: [],
        }))
        .slice(0, 100);
}

/**
 * A failure, in words that say what to do about it.
 *
 * The two that matter are the two that happen: nothing listening on the
 * address, and a model that was loaded without tool support. Both look like
 * "the assistant is broken" from the panel, and neither is.
 */
function describeFailure(error, label = 'The model server') {
    const text = String(error?.message || error || 'Unknown error');

    if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|network|Failed to fetch/i.test(text)) {
        return `${label} could not be reached. Check that it is running and that the address in the `
            + `assistant settings is the one it is listening on. (${text})`;
    }
    if (/timeout|timed out|aborted/i.test(text)) {
        return `${label} did not answer in time. A large model on a busy machine can take a while; `
            + 'if it never answers, check the server\'s own log.';
    }
    if (/tool|function.*(not|un)support|does not support tools/i.test(text)) {
        return `${label} refused the tool definitions. This assistant works by calling tools, so it `
            + 'needs a model with tool support. Load one that has it, then try again.';
    }
    if (/401|403|unauthor|invalid.*api.?key|missing.*api.?key/i.test(text)) {
        return `${label} rejected the credentials. Add or correct the API key in the assistant settings.`;
    }
    if (/404|no such model|model.*not found/i.test(text)) {
        return `${label} does not have the selected model loaded. Pick another one from the model menu, `
            + 'or load it on the server.';
    }
    return text;
}

module.exports = {
    start,
    ask,
    listModels,
    functionTools,
    describeFailure,
    createSseReader,
    createCollector,
    trimHistory,
    foldHistory,
    needsCompaction,
    splitForCompaction,
    limitsFor,
    contextReading,
    windowOf,
    _test: { histories, runTool, summaryRequest, knownWindows, COMPACT_AT, COMPACT_CHARS, KEEP_TAIL, MIN_FOLD_CHARS, MAX_PROVENANCE, SUMMARY_MARK },
};
