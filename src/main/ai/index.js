const settings = require('./settings');
const agents = require('../agents');
const accounts = require('./accounts');
const limits = require('./limits');
const memory = require('./memory');
const prompt = require('./prompt');
const catalog = require('./tools');
const secrets = require('./secrets');
const diff = require('./diff');
const checkpoints = require('./checkpoints');
const archive = require('./archive');
const searchModule = require('./search');
const { readImages } = require('./images');
const { readMentions, mentionBlock, stripMentions } = require('./mentions');
const store = require('../store');
const transcript = require('../transcript');
const activity = require('../activity');
const runs = require('../runs');
const jobs = require('../runs/jobs');
const scheduler = require('../runs/scheduler');
const headless = require('./headless');
const local = require('./local');
const modelMatch = require('./model-match');
const ssh = require('../ssh');
const localTerminal = require('../local-terminal');

/**
 * The assistant, from the app's point of view.
 *
 * Owns conversations and the two things a conversation needs that a provider
 * cannot do for itself: putting a tool call in front of a person and waiting
 * for an answer, and asking the renderer to do something only it can, like
 * open a tab.
 *
 * Everything the renderer sees is one event stream per conversation. That is
 * also what makes a window reload survivable: the events are kept here, and a
 * panel that comes back asks for them and rebuilds itself. The conversation
 * itself never lived in the window.
 *
 * The same stream is what `archive.js` writes to disk, so it survives the app
 * closing as well as the window. Only the cheap half is kept: a restored
 * conversation has a transcript and the agent's own id for it, and starts its
 * query again on the next message, exactly as a parked one does.
 */

const PROVIDERS = {
    'claude-code': require('./providers/claude-code'),
    codex: require('./providers/codex'),
    cursor: require('./providers/cursor'),
    antigravity: require('./providers/antigravity'),
    muse: require('./providers/muse'),
    opencode: require('./providers/opencode'),
    grok: require('./providers/grok'),
    kimi: require('./providers/kimi'),
    qwen: require('./providers/qwen'),
    vibe: require('./providers/vibe'),
    pi: require('./providers/pi'),
    local: require('./providers/local'),
    openai: require('./providers/openai'),
};

/** Kept per conversation, so a long session cannot grow without bound. */
const MAX_EVENTS = 4000;

/**
 * How many conversations stay reachable from the history menu.
 *
 * They cost a page of events each once parked, not a process, so this is a
 * generous number. It exists because a Map that only ever grows is a leak with
 * a nice name.
 */
const MAX_CONVERSATIONS = 20;

/** How long a tool call waits for a person before it gives up. */
/**
 * How long an approval card holds a turn before it is answered "no". The
 * tool server keeps the runtime alive for as long as the card is up, so
 * this is only about how long a conversation may sit blocked on one call.
 */
const APPROVAL_TIMEOUT = 45 * 60 * 1000;
/** How long a question to the user holds the turn before the turn is handed back. */
const QUESTION_WAIT = 15 * 60 * 1000;

/**
 * The same, for a runtime reached over the tool server rather than in this
 * process.
 *
 * Those clients put their own limit on a tool call, and it is short: OpenCode
 * gives one twenty seconds. Past that it reports a timeout to the agent and
 * stops listening, and because the server is stateless per request its
 * cancellation reaches a fresh instance rather than the call that is waiting,
 * so nothing on this side ever learns the answer is no longer wanted. A user
 * who answered forty seconds later had their answer settled into a call that
 * was already dead, and the agent never saw it.
 *
 * So the call does not wait that long. It waits for an answer given straight
 * away, and otherwise hands the turn back with the card still up, and the
 * answer arrives as the user's next message. Twelve seconds is under every
 * client limit seen so far and long enough for someone already reading.
 */
const QUESTION_HOLD = 12 * 1000;

/** How long the renderer gets to open or close a session. */
const ACTION_TIMEOUT = 90 * 1000;

// conversationId -> conversation
const conversations = new Map();
// requestId -> { resolve, timer }
const pendingApprovals = new Map();
const pendingActions = new Map();
// requestId -> { resolve, timer, conversationId }, for ask_user
const pendingQuestions = new Map();

let counter = 0;
let notify = () => {};
// Whether a window is up. Set by ipc; without it the assistant assumes none,
// which is the safe reading: a session is then opened headless rather than
// by asking a window that is not there.
let hasWindow = () => false;
let windowFocused = () => false;
// An OS notification, provided by ipc, for a run that finished or stopped
// on a question while nobody was looking at the window.
let toast = () => {};

function setWindowProbe(fn, focused) {
    hasWindow = typeof fn === 'function' ? fn : () => false;
    if (typeof focused === 'function') windowFocused = focused;
}

function setToaster(fn) {
    toast = typeof fn === 'function' ? fn : () => {};
}

/**
 * How the runtime last reported it was authenticating: a plan, a key, or a
 * third-party provider. Kept at module level rather than per conversation
 * because it describes the machine, not the chat, and the settings page needs
 * to be able to say so without one being open.
 */
let lastAccount = null;

/**
 * What an agent said it can run: `{ provider, rows }`, one row per model, each
 * carrying the effort levels that model actually takes.
 *
 * Keyed by provider, and that is the whole point. This used to be a bare list
 * plus a "forget it" message sent when the agent changed, and the two of them
 * raced: reading a catalog means starting a runtime, which takes seconds, so
 * an answer for the agent you just left could arrive after the switch, and a
 * clearing message could arrive after a fresh answer. Both were seen. Keyed,
 * a list for the wrong agent is not stale data to be cleared in time, it is
 * simply not an answer to the question being asked.
 *
 * One entry per agent rather than one slot, so switching back and forth asks
 * each of them once. A `null` value is an answer too: that agent was asked and
 * publishes nothing.
 */
const modelCatalogs = new Map();

/**
 * The in-flight asks, so ten panels opening at once do not start ten of them.
 *
 * One per agent rather than one slot, for the same reason the catalogs are
 * keyed: a panel opening with four agents switched on asks all four at once,
 * and a single slot would have three of them waiting on an answer to somebody
 * else's question.
 */
const modelsPending = new Map();

function setNotifier(fn) {
    notify = fn;
}

function nextId(prefix) {
    counter += 1;
    return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/* ------------------------------------------------------------------ *
 * Conversations
 * ------------------------------------------------------------------ */

/**
 * Read the stored conversations back, once per run.
 *
 * Lazy rather than done at startup: this needs `app.getPath`, and every path
 * into this module arrives from the renderer, which is long past ready. Every
 * public function that touches the map calls it, so no caller has to remember.
 */
let hydrated = false;

function hydrate() {
    if (hydrated) return;
    hydrated = true;

    // What the last process left running is closed out before anything can
    // start: an interactive run cannot continue without the person who was
    // driving it, and a tool step that never reported is marked unknown.
    // Scheduled runs will be picked up here instead once there are any.
    try {
        // A job's run is worth resuming as long as its job still exists; the
        // scheduler hands the re-queued ones back to `resumeJobRun`.
        runs.recover({ resumable: run => run.kind !== 'interactive' && Boolean(run.jobId && jobs.get(run.jobId)) });
    } catch (error) {
        console.error('Could not recover the run log:', error.message);
    }

    // Writing is safe again from here: this is the moment the map holds the
    // conversations rather than nothing. A shutdown stopped it precisely
    // because an empty map is not an empty history, and this is the other end
    // of that. See `shutdown`.
    archive.resume();

    for (const record of archive.read()) {
        // Resumable only under the runtime its own agent is set to now.
        const conversation = archive.unpack(record, settings.get(record.agentId || undefined).provider);
        if (conversation && !conversations.has(conversation.id)) {
            // A chat written before there were agents belongs to whoever is
            // selected: it has to be listed somewhere.
            if (!agents.get(conversation.agentId)) conversation.agentId = agents.activeId();
            conversations.set(conversation.id, conversation);
        }
    }
}

/**
 * What is written out: the most recent conversations that have something in
 * them. A panel opens a conversation the moment it is mounted, so without the
 * title check the history menu would fill up with blank entries nobody started.
 */
archive.setSource(() => [...conversations.values()]
    .filter(conversation => conversation.title || conversation.events.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, archive.MAX_CONVERSATIONS)
    .map(archive.pack));

/**
 * Which servers a conversation is about, in the one shape the rest of this
 * module reads.
 *
 *   global    everything, with nothing ruled out.
 *
 *   session   the session the panel is following. A default for tool calls that
 *             name none, and deliberately not a fence: a question about one
 *             server is often answered by looking at the one beside it.
 *
 *   targets   an explicit set of sessions and saved hosts, and nothing else.
 *             This one is a fence, enforced in the tool handlers rather than
 *             asked for in the prompt, because "only these two" is a promise
 *             the app can keep and a sentence the model can only agree with.
 *
 * `boundSessionId` is what a call falls back to when it names no session. A
 * pinned set has one only when there is a single session in it: guessing which
 * of two servers "restart nginx" meant is the failure the set exists to
 * prevent, so with two the tools ask for a name instead.
 */
function normalizeScope({ scope, sessionId = '', sessionIds = [], hostIds = [] } = {}) {
    const sessions = Array.isArray(sessionIds) ? sessionIds.filter(Boolean).map(String) : [];
    const hosts = Array.isArray(hostIds) ? hostIds.filter(Boolean).map(String) : [];

    if (scope === 'global') {
        return { scope: 'global', boundSessionId: '', sessionIds: [], hostIds: [] };
    }

    // An empty set is not a fence around nothing, it is someone who unpinned
    // the last row. It falls back to following, which is where the panel puts
    // itself in the same situation.
    if (scope === 'targets' && sessions.length + hosts.length > 0) {
        return {
            scope: 'targets',
            boundSessionId: sessions.length === 1 ? sessions[0] : '',
            sessionIds: sessions,
            hostIds: hosts,
        };
    }

    return {
        scope: 'session',
        boundSessionId: String(sessionId || ''),
        sessionIds: [],
        hostIds: [],
    };
}

function create(target = {}) {
    hydrate();

    const id = nextId('conv');
    const scope = normalizeScope(target);
    // Room is made before the new one goes in, never after: with the list
    // at its cap, trimming afterwards took the youngest untitled one, which
    // was this one, and the first message into it found it gone.
    trim();
    // Whose conversation this is: the agent the panel named, else the one
    // selected, since that is who a new chat is to.
    const agentId = agents.get(target.agentId)?.id || agents.activeId();
    conversations.set(id, {
        id,
        agentId,
        ...scope,
        session: null,
        starting: null,
        events: [],
        busy: false,
        lastContext: '',
        providerSessionId: '',
        // Which agent owns `providerSessionId`, set when a query actually
        // starts. Kept because an id from one agent means nothing to another,
        // and after a restart the selected agent may not be the one that
        // held this conversation.
        provider: '',
        // And which of its sign-ins, for the same reason: see accounts.js.
        accountId: '',
        needsRestart: false,
        costUsd: 0,
        // Taken from the first thing the user says, which is what the history
        // menu has to label the entry with. Nothing else here knows what a
        // conversation was about.
        title: '',
        // Kept at the top of the list by the user: see `pin`.
        pinned: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // The run the current turn is written to, and what a run started
        // here inherits. Interactive by default; a job sets its own.
        runId: '',
        runKind: 'interactive',
        runTrigger: null,
        runPolicy: null,
        jobId: '',
        // Settings a job pins over the agent's: the model and effort it was
        // made with, so a changed default does not change what it costs.
        settingsPatch: null,
        // For a conversation one agent opened to delegate to another: whose
        // it is, and how deep the chain is. See delegateApiFor.
        parentId: '',
        depth: 0,
    });
    return { conversationId: id, agentId, ...scope };
}

/* ------------------------------------------------------------------ *
 * Hooks
 *
 * A command the user attached to the agent, run on this computer inside
 * the agent's folders, with the event as JSON on its stdin. Four moments:
 * before and after a tool call, and when a run starts and ends. A pre-tool
 * hook that exits 2 blocks the call, and what it wrote is what the model
 * reads. Everything else is observation. Hooks run for every provider,
 * because they run here rather than in any of them.
 * ------------------------------------------------------------------ */

const HOOK_TIMEOUT = 30000;

async function runHooks(conversation, event, payload = {}) {
    let list;
    try {
        list = agents.hooks(conversation.agentId).filter(hook => (
            hook.event === event && (hook.tools.length === 0 || !payload.tool || hook.tools.includes(payload.tool))
        ));
    } catch {
        return { blocked: false };
    }
    if (list.length === 0) return { blocked: false };

    const ctx = { agentId: conversation.agentId, sandbox: agents.sandbox(conversation.agentId) };
    const message = JSON.stringify({
        event,
        ...payload,
        input: payload.input ? catalog.redactInput(payload.input) : undefined,
        agentId: conversation.agentId,
        conversationId: conversation.id,
        runId: conversation.runId || '',
    });

    for (const hook of list) {
        let result;
        try {
            result = await local.run(ctx, hook.command, {
                timeout: HOOK_TIMEOUT,
                stdin: message,
                env: { ACESTES_EVENT: event, ACESTES_TOOL: payload.tool || '', ACESTES_AGENT: conversation.agentId },
            });
        } catch (error) {
            result = { success: false, message: error.message };
        }
        if (!result.success) {
            console.error(`Hook "${hook.command}" could not run: ${result.message}`);
            emit(conversation, { type: 'notice', tone: 'warn', text: `The ${event} hook could not run: ${result.message}` });
            continue;
        }
        if (event === 'pre-tool' && result.exitCode === 2) {
            const reason = `${result.stderr || ''}${result.stdout || ''}`.trim() || `A hook blocked ${payload.tool}.`;
            emit(conversation, { type: 'notice', tone: 'warn', text: `Blocked by a hook: ${reason.slice(0, 300)}` });
            return { blocked: true, message: `Blocked by the user's hook: ${reason.slice(0, 1000)}` };
        }
    }
    return { blocked: false };
}

/**
 * The settings a conversation actually runs under.
 *
 * The agent's, with a job's pinned model over them, and the run's policy
 * translated into the approval gate the providers already consult:
 *
 *   read-only   reads run free, and requestApproval refuses every write
 *               without a card: there is no answer that would let one
 *               through, so asking would only spam a background run with
 *               questions that have a single button
 *   allowlist   writes ask, except commands on the job's own list
 *   park        writes ask, and the question waits for a person with no
 *               timeout (see requestApproval)
 *   full        nothing asks; the blocked list still applies
 *
 * Done here rather than in each provider so all of them get it, and so the
 * existing gate is the only gate.
 */
function effectiveSettings(conversation) {
    const patch = conversation.settingsPatch || {};
    // A pinned runtime is resolved as that runtime, key and all, not as the
    // agent's default with a name swapped in.
    const agentSettings = patch.provider && PROVIDERS[patch.provider]
        ? resolvedFor(patch.provider, conversation.agentId)
        : resolved(conversation.agentId);
    const base = { ...agentSettings, ...(patch.model ? { model: patch.model } : {}), ...(patch.effort ? { effort: patch.effort } : {}) };
    const policy = conversation.runPolicy;
    if (!policy || !policy.approvals || policy.approvals === 'inherit') return base;
    switch (policy.approvals) {
        case 'read-only':
            // Reads run free under 'writes', and a write never reaches a
            // card: requestApproval refuses it outright. 'always' here used
            // to park a background run on its very first read, which read as
            // a yolo session endlessly asking for permission.
            //
            // The flag rides along because 'writes' on its own no longer says
            // which run this is, and a tool that is auto-approved but still
            // writes (save_secret) has to be turned down here rather than run.
            return { ...base, approval: 'writes', readOnlyRun: true };
        case 'allowlist':
            return {
                ...base,
                approval: 'writes',
                autoApproveCommands: (policy.tools || []).map(entry => String(entry).trim().toLowerCase()).filter(Boolean),
            };
        case 'park':
            return { ...base, approval: 'writes' };
        case 'full':
            return { ...base, approval: 'never' };
        default:
            return base;
    }
}

/**
 * Forget the oldest parked conversations, once there are more than the cap.
 *
 * Only ones that are properly asleep are candidates: a conversation with a
 * running query, or one waiting on an approval, is in use whatever its age.
 */
function trim() {
    let excess = conversations.size - MAX_CONVERSATIONS;
    if (excess <= 0) return;

    // A conversation opened in the last minute is one somebody is about to
    // type into, whatever the list looks like.
    const fresh = Date.now() - 60 * 1000;
    const parked = [...conversations.values()]
        .filter(conversation => !conversation.session && !conversation.starting && !conversation.busy)
        .filter(conversation => !(conversation.createdAt > fresh && conversation.events.length === 0))
        // Untitled first, then oldest. Nothing was ever said in an untitled
        // one: the panel opens a conversation the moment it is mounted, and a
        // scratch conversation nobody typed into should not be able to push a
        // week of real history off the end of the list.
        .sort((a, b) => (
            Number(Boolean(a.title)) - Number(Boolean(b.title)) || a.updatedAt - b.updatedAt
        ));

    for (const conversation of parked) {
        if (excess <= 0) break;
        conversations.delete(conversation.id);
        excess -= 1;
    }
}

/** The ids of the live conversations, for the backup preview to count against. */
function conversationIds() {
    return [...conversations.keys()];
}

/**
 * Bring conversations from a backup into the live map, the same way `hydrate`
 * adopts the ones from disk: unpacked under the runtime their agent is set to
 * now, repaired onto the selected agent when theirs is gone, matched on id.
 * The archive picks them up from the map on its next write.
 */
function importConversations(records, { overwrite = false } = {}) {
    const result = { added: 0, replaced: 0, skipped: 0 };
    for (const record of Array.isArray(records) ? records : []) {
        let conversation;
        try {
            conversation = archive.unpack(record, settings.get(record?.agentId || undefined).provider);
        } catch {
            conversation = null;
        }
        if (!conversation) {
            result.skipped++;
            continue;
        }
        if (!agents.get(conversation.agentId)) conversation.agentId = agents.activeId();
        if (conversations.has(conversation.id)) {
            if (!overwrite) {
                result.skipped++;
                continue;
            }
            result.replaced++;
        } else {
            result.added++;
        }
        conversations.set(conversation.id, conversation);
    }
    if (result.added > 0 || result.replaced > 0) {
        while (conversations.size > archive.MAX_CONVERSATIONS) {
            let oldest = null;
            for (const conversation of conversations.values()) {
                if (conversation.pinned) continue;
                if (!oldest || conversation.updatedAt < oldest.updatedAt) oldest = conversation;
            }
            if (!oldest) break;
            conversations.delete(oldest.id);
        }
        archive.save();
    }
    return result;
}

function get(conversationId) {
    return conversations.get(conversationId);
}

/**
 * Record an event and pass it on.
 *
 * Everything the panel renders goes through here, which is why the log and the
 * push cannot drift apart: a panel restoring after a reload replays exactly
 * what a panel that stayed open received.
 */
/**
 * What a child conversation's parent is shown of it.
 *
 * A delegated run works in a conversation of its own that no window has
 * open. Its questions would go unseen there, so they are drawn on the
 * parent as well, marked with where they came from; the answer is by
 * request id, which is global, so it lands whichever card it is given on.
 */
const FORWARDED = new Set(['approval-request', 'approval-settled', 'question-request', 'question-settled']);

/** Fragments of a block still streaming, merged in the log. See `emit`. */
const DELTAS = new Set(['text-delta', 'thinking-delta']);

/**
 * Mask a newly stored secret out of everything already recorded.
 *
 * `emit` scrubs what is recorded from now on; this is for the copies that
 * were written before the store knew the value, such as the user's own
 * message that pasted a key. Every open window is told to read the
 * conversation again, so its copy is refreshed too.
 */
function scrubHistory() {
    let touched = 0;
    for (const conversation of conversations.values()) {
        let changed = false;
        conversation.events = conversation.events.map((event) => {
            const clean = secrets.scrubDeep(event);
            if (clean !== event) changed = true;
            return clean;
        });
        // The title is the first message, cut short: a key pasted as the
        // opening line was the title of the conversation in every list.
        const title = secrets.scrub(conversation.title || '');
        if (title !== (conversation.title || '')) {
            conversation.title = title;
            changed = true;
        }
        if (changed) {
            touched += 1;
            notify('ai-history-scrubbed', { conversationId: conversation.id });
        }
    }
    // The runs log keeps its own copy of every title, and of every tool
    // call's arguments and output.
    try {
        runs.scrubTitles(secrets.scrub);
        runs.scrubSteps(secrets.scrub);
    } catch (error) {
        console.error('Could not scrub the runs log:', error.message);
    }
    if (touched > 0) archive.save();
    return touched;
}

function emit(conversation, event) {
    // A tool call or an approval card carrying a password is masked here,
    // before it reaches the log, the file or a window. See `redactInput`.
    // Then every value in the secrets store is masked wherever it appears,
    // in an input, a result, a reply: a secret that reached the agent by
    // some other road is not repeated by the transcript.
    const stamped = secrets.scrubDeep({ ...event, at: Date.now() });
    if (stamped.input) stamped.input = catalog.redactInput(stamped.input);

    // An edit carries what it changes, so the transcript and the approval
    // card can show the change rather than two blobs of JSON. Worked out
    // from the arguments, which every runtime's edit tool spells with the
    // same two halves in it. See diff.js.
    if ((stamped.type === 'tool-call' || stamped.type === 'approval-request') && !stamped.diff) {
        try {
            const change = diff.fromToolInput(stamped.name || stamped.rawName, stamped.input);
            if (change) stamped.diff = change;
        } catch (error) {
            console.error('Could not describe an edit:', error.message);
        }
    }

    trackEdits(conversation, stamped);

    if (conversation.parentId && FORWARDED.has(stamped.type) && !stamped.via) {
        const parent = conversations.get(conversation.parentId);
        if (parent) emit(parent, { ...event, via: conversation.id, viaTitle: conversation.title || '' });
    }
    // A reply streams in as hundreds of fragments. Each still goes to the
    // windows as it comes, but the log keeps one growing fragment rather
    // than hundreds: the panel folds them into the same draft either way,
    // and in the log they were most of the 4000 events a conversation is
    // allowed, pushing its real history out and all of it into every replay.
    const last = conversation.events[conversation.events.length - 1];
    if (DELTAS.has(stamped.type) && last?.type === stamped.type && !stamped.via && !last.via) {
        conversation.events[conversation.events.length - 1] = { ...last, text: `${last.text || ''}${stamped.text || ''}` };
        conversation.updatedAt = stamped.at;
        notify('ai-event', { conversationId: conversation.id, event: stamped });
        return;
    }

    conversation.updatedAt = stamped.at;
    conversation.events.push(stamped);
    if (conversation.events.length > MAX_EVENTS) {
        conversation.events.splice(0, conversation.events.length - MAX_EVENTS);
    }
    notify('ai-event', { conversationId: conversation.id, event: stamped });

    // A stream preview is not worth a write of its own: the finished block that
    // replaces it is an event in its own right, and that one schedules one.
    if (!archive.isTransient(stamped.type)) archive.save();
}

/* ------------------------------------------------------------------ *
 * What a turn did to files
 *
 * Each turn is watched for edits as its events go past, and closed with
 * one `turn-changes` event listing the files it changed, which is the card
 * at the foot of the turn. The snapshots behind it, and the undo they make
 * possible, are in checkpoints.js.
 * ------------------------------------------------------------------ */

/** What closes a turn's record of edits, emitted just before it lands. */
const CLOSES_EDITS = new Set(['result', 'error', 'interrupted', 'closed']);

function closeEdits(conversation) {
    const summary = checkpoints.finish(conversation.id);
    if (summary) emit(conversation, { type: 'turn-changes', ...summary });
}

function trackEdits(conversation, event) {
    try {
        if (event.type === 'user-message') {
            // A message sent into a turn still going closes the one before.
            closeEdits(conversation);
            checkpoints.begin(conversation.id, event.at);
        } else if (CLOSES_EDITS.has(event.type)) {
            closeEdits(conversation);
        } else if (event.type === 'tool-call' && event.local) {
            // A runtime's own edit tool. Ours record themselves, in the
            // handler, which is the only place a server's file can be read.
            checkpoints.callStarted(conversation.id, event);
        } else if (event.type === 'tool-result') {
            checkpoints.callFinished(conversation.id, event);
        }
    } catch (error) {
        console.error('Could not record an edit:', error.message);
    }
}

/** A turn's changes as lines, for the card's review. */
function turnChanges(conversationId, turnId) {
    return checkpoints.changes(String(conversationId || ''), turnId);
}

/**
 * Undo what a turn did to files. The agent is told on its next message,
 * or it would carry on from files that are no longer what it wrote.
 */
async function revertTurn(conversationId, turnId) {
    hydrate();
    const conversation = conversations.get(conversationId);
    if (!conversation) return { success: false, message: 'That conversation is gone' };

    const result = await checkpoints.revert(conversationId, turnId);
    if (!result.success || result.already) return result;

    emit(conversation, { type: 'turn-reverted', turnId, reverted: result.reverted, failed: result.failed });
    if (result.reverted.length > 0) {
        conversation.pendingNote = [
            conversation.pendingNote,
            'The user undid the file changes from one of your earlier turns. These files are back as they '
                + `were before it, so read them again before relying on what you wrote:\n${result.reverted.map(file => `- ${file}`).join('\n')}`,
        ].filter(Boolean).join('\n\n');
        archive.save();
    }
    return result;
}

/** How much of the earlier conversation a branch carries into its first message. */
const MAX_CARRY_OVER = 60000;

/**
 * A new conversation holding this one up to the end of a turn.
 *
 * The runtime behind the new one has never seen any of it, so what was said
 * goes with its first message instead. The edit cards come along to be read,
 * not undone: the files are shared, and undoing belongs to the conversation
 * that made the change.
 */
function branch(conversationId, turnId) {
    hydrate();
    const source = conversations.get(conversationId);
    if (!source) return { success: false, message: 'That conversation is gone' };

    const start = source.events.findIndex(event => event.type === 'user-message' && String(event.at) === String(turnId));
    if (start < 0) return { success: false, message: 'That turn is no longer in the conversation' };
    let end = source.events.findIndex((event, index) => index > start && event.type === 'user-message');
    if (end < 0) end = source.events.length;

    const created = create({
        agentId: source.agentId,
        scope: source.scope,
        sessionId: source.boundSessionId,
        sessionIds: source.sessionIds,
        hostIds: source.hostIds,
    });
    const copy = conversations.get(created.conversationId);
    copy.events = source.events.slice(0, end)
        .filter(event => !archive.isTransient(event.type))
        .map(event => (event.type === 'turn-changes' || event.type === 'turn-reverted'
            ? { ...event, from: event.from || source.id }
            : event));
    copy.title = source.title;
    copy.settingsPatch = source.settingsPatch ? { ...source.settingsPatch } : null;
    copy.updatedAt = Date.now();
    const said = exportMarkdown(copy.id, { messagesOnly: true }) || '';
    copy.carryOver = said.length > MAX_CARRY_OVER ? said.slice(-MAX_CARRY_OVER) : said;
    archive.save();
    return { success: true, conversationId: copy.id, agentId: copy.agentId };
}

/** Point an existing conversation at a different session, set, or all of them. */
function setScope(conversationId, target) {
    hydrate();

    const conversation = conversations.get(conversationId);
    if (!conversation) return { success: false, message: 'That conversation is gone' };

    const scope = normalizeScope(target);
    Object.assign(conversation, scope);
    archive.save();
    return { success: true, ...scope };
}

/**
 * The settings as one agent sees them: its own name, and its own key.
 *
 * Named rather than assumed, because the agent being asked something is no
 * longer always the agent that is answering the conversation. Reading the model
 * list of one that is switched on but not selected has to hand it the key
 * stored for it, or the ask goes out with somebody else's credential on it.
 */
function resolvedFor(provider, agentId) {
    const base = settings.get(agentId);
    const accountId = accountIdFor(base, provider);
    return {
        ...base,
        provider,
        apiKey: settings.readApiKey(provider),
        // Which sign-in runs it, and the variables that point the runtime at
        // it. Empty for the machine's own login, so nothing changes for a
        // machine that never adds an account.
        accountId,
        accountEnv: accounts.envFor(provider, accountId),
    };
}

/**
 * The account one runtime runs under for these settings, resolved: an id
 * that names an account that has since been removed is the machine's own.
 */
function accountIdFor(current, provider) {
    if (!accounts.supports(provider)) return accounts.DEFAULT_ID;
    return accounts.resolve(provider, current?.accounts?.[provider])?.id || accounts.DEFAULT_ID;
}

/** The settings as the agent behind a conversation sees them. */
function resolved(agentId) {
    return resolvedFor(settings.get(agentId).provider, agentId);
}

/**
 * Settings the SDK bakes into a running query and cannot be told about later.
 * Changing one of these means the query has to be started again.
 */
const RESTART_ON = ['provider', 'maxTurns', 'allowLocalTools'];

/**
 * Whether a change of settings moved the runtime a conversation is on to
 * another sign-in. The account is fixed in the process's environment when it
 * starts, so, like the fields above, the query has to start again.
 */
function accountMoved(conversation, before, after) {
    const provider = conversation.provider || after.provider;
    return accountIdFor(before, provider) !== accountIdFor(after, provider);
}

/**
 * Note that the configuration moved.
 *
 * Three kinds of setting, three answers. The approval policy and the safe
 * command list are read live on every tool call, so they need nothing here.
 * The model and the effort are live control requests, so they are pushed at
 * the running session and take effect on its next response. Only the handful
 * the SDK fixes when a query starts need the query started again, and that is
 * deferred to the next message: doing it here would kill a turn halfway
 * through a command on a live server because someone touched a dropdown while
 * watching it run.
 */
function reconfigure(before, after, agentId = '') {
    // The account describes a runtime rather than the app, so it does not
    // survive a change of agent. The model catalog needs no clearing: it is
    // keyed by provider, so the one held for the agent just left simply stops
    // matching, and switching back finds it still there.
    //
    // What is sent is the new agent's catalog if it has already been read, and
    // otherwise nothing, so a panel drops the old list at once rather than
    // showing it until the first ask comes back.
    // A different address is a different machine with different models on it,
    // so what was read from the last one is not an answer about this one. The
    // list is dropped rather than refreshed here: reading it means a request,
    // and someone typing an address has not finished typing it.
    if (before.localBaseUrl !== after.localBaseUrl) modelCatalogs.delete('local');
    if (before.apiBaseUrl !== after.apiBaseUrl || before.apiKeys?.openai !== after.apiKeys?.openai) modelCatalogs.delete('openai');

    if (before.provider !== after.provider || before.localBaseUrl !== after.localBaseUrl || before.apiBaseUrl !== after.apiBaseUrl) {
        if (before.provider !== after.provider) lastAccount = null;
        notify('ai-models', {
            provider: after.provider,
            models: modelCatalogs.get(after.provider) ?? null,
        });
    }

    for (const conversation of conversations.values()) {
        // A change to one agent's settings is that agent's conversations'
        // business and nobody else's.
        if (agentId && conversation.agentId !== agentId) continue;
        const session = conversation.session;
        // A conversation with a model of its own keeps it: the agent's default
        // moving is news only to the ones still following it.
        const own = conversation.settingsPatch || {};
        if (session) {
            // Only when it is still the same agent's session. Picking a model
            // out of the composer's merged menu can move both at once, and a
            // model name belonging to one agent means nothing to the one that
            // is running: the query is restarted below, which is what actually
            // applies the pair. Effort has no such trouble, since a level is a
            // level whoever is listening.
            if (!own.provider && !own.model && before.provider === after.provider && before.model !== after.model) {
                session.setModel?.(after.model);
            }
            if (!own.effort && before.effort !== after.effort) session.setEffort?.(after.effort);
        }
        if (RESTART_ON.some(field => before[field] !== after[field]) || accountMoved(conversation, before, after)) {
            if (session || conversation.starting) conversation.needsRestart = true;
        }
    }
}

/** Drop the running query, keeping the id that lets the next one resume it. */
async function restart(conversation) {
    // A query that is still coming up is waited for rather than ignored.
    // Otherwise it finishes after this returns, hands itself to a conversation
    // nobody is looking at any more, and stays open until the app quits.
    if (conversation.starting) await conversation.starting.catch(() => {});

    const session = conversation.session;
    conversation.session = null;
    conversation.needsRestart = false;
    // The situational block goes again with the first message on the new
    // query, which has never been told where the user is.
    conversation.lastContext = '';
    try {
        await session?.close();
    } catch {
        // Already gone.
    }
}

/**
 * Ask the user about one tool call.
 *
 * Resolves rather than rejects on a timeout or a missing window, because the
 * answer to "may I restart this service" when nobody is there to say yes is
 * no, not an exception somewhere up the stack.
 */
function requestApproval(conversation, { toolName, name, input, local, signal = null }) {
    return new Promise((resolve) => {
        const definition = catalog.BY_NAME.get(name);
        const requestId = nextId('approve');
        const policy = conversation.runPolicy;

        // A read-only run refuses every write before anyone is asked: there
        // is no answer that would let it through, so a card would be a
        // question with one button. `changesNothing` rather than `readOnly`,
        // so a tool that is waved through and still writes is refused here
        // too rather than let past on the strength of the wave.
        if (policy?.approvals === 'read-only' && !catalog.changesNothing(name)) {
            resolve({ approved: false, message: 'This run is read-only: it may look but not change anything. Report what you would have done.' });
            return;
        }

        // A job's run has nobody watching. Its question is parked: the run
        // is marked so, the person is told, and there is no timeout, because
        // the card is still there in the morning and the answer still counts.
        const parked = Boolean(policy && policy.approvals !== 'inherit' && conversation.runId);

        const settle = (verdict, status) => {
            const entry = pendingApprovals.get(requestId);
            if (!entry) return;
            if (entry.timer) clearTimeout(entry.timer);
            pendingApprovals.delete(requestId);
            // Recorded, not just sent. The request itself is in the event log,
            // so without this a window that reloads after answering replays the
            // card as though it were still waiting, and clicking it does
            // nothing because the id it names is long gone.
            emit(conversation, { type: 'approval-settled', requestId, status });
            if (parked && conversation.runId && status !== 'expired') {
                try {
                    const run = runs.get(conversation.runId);
                    if (run?.status === 'parked') {
                        runs.start(conversation.runId);
                        emit(conversation, { type: 'run-resumed', runId: conversation.runId });
                    }
                } catch (error) {
                    console.error('Could not resume a parked run:', error.message);
                }
            }
            resolve(verdict);
        };

        const timer = parked ? null : setTimeout(() => {
            settle({
                approved: false,
                message: 'The user has not answered this approval in 45 minutes. Do not ask again: end your turn, '
                    + 'saying in one line what is waiting for their go-ahead, and call it when they say so.',
            }, 'expired');
        }, APPROVAL_TIMEOUT);

        pendingApprovals.set(requestId, { resolve: settle, timer, conversationId: conversation.id });

        // The runtime gave up on the call: the card is taken down rather than
        // left standing over a question whose answer can no longer be acted on.
        if (signal) {
            const giveUp = () => settle(
                { approved: false, message: 'The runtime stopped waiting for this approval.' },
                'expired',
            );
            if (signal.aborted) {
                giveUp();
                return;
            }
            signal.addEventListener('abort', giveUp, { once: true });
        }

        if (parked) {
            try {
                const summary = name === 'run_command' ? String(input?.command || '') : summarise(catalog.redactInput(input));
                runs.park(conversation.runId, `Waiting for approval: ${name} ${summary}`.slice(0, 400));
                emit(conversation, { type: 'run-parked', runId: conversation.runId, name });
                toast({
                    title: `${conversation.title || 'A run'} is waiting for you`,
                    body: `The agent wants to ${name.replace(/_/g, ' ')}${summary ? `: ${summary.slice(0, 120)}` : ''}`,
                    conversationId: conversation.id,
                    runId: conversation.runId,
                });
            } catch (error) {
                console.error('Could not park a run:', error.message);
            }
        }

        const target = input?.session || conversation.boundSessionId || '';
        const info = target ? transcript.info(target) : null;

        emit(conversation, {
            type: 'approval-request',
            requestId,
            name,
            rawName: toolName,
            title: definition?.title || (local ? `Local: ${toolName}` : toolName),
            local: Boolean(local),
            readOnly: Boolean(definition?.readOnly),
            input,
            // Both, because they answer different questions. The id is what the
            // panel resolves against the sessions it can see, so a card can
            // draw the server the way the tab strip does, with its OS and the
            // name it goes by. The name is what is left when that lookup fails:
            // a session closed since, or a transcript read back from disk.
            sessionId: info ? info.sessionId : '',
            host: info ? (info.hostName || info.address) : '',
        });
    });
}

/**
 * Put a question from the agent in front of the user, and wait.
 *
 * The same shape as an approval: an event the panel draws as a card, a
 * request id the answer comes back on, and a timer so a question nobody
 * answers does not hold the turn open for ever. It differs in what it
 * carries: a question and its options rather than a tool call, and the
 * answer is text rather than a verdict.
 */
function requestQuestion(conversation, { question, options = [], secret = '', signal = null }) {
    return new Promise((resolve) => {
        const requestId = nextId('ask');
        // A secret answer is stored under this name and never reaches the
        // agent: it gets a reference, the transcript gets a mask.
        const name = secret && secrets.NAME.test(String(secret).trim()) ? String(secret).trim() : '';

        const settle = (reply, status) => {
            const entry = pendingQuestions.get(requestId);
            if (!entry) return;
            clearTimeout(entry.timer);
            pendingQuestions.delete(requestId);
            let shown = reply.answer || '';
            let outcome = reply;
            if (name && reply.answered) {
                // The agent that asked for it is the one it belongs to.
                const kept = secrets.set(name, reply.answer, conversation.agentId);
                shown = secrets.MASK;
                outcome = kept.error
                    ? { answered: false, message: `The answer could not be stored: ${kept.error}` }
                    : { answered: true, stored: true, name: kept.name, reference: kept.reference };
            }
            emit(conversation, { type: 'question-settled', requestId, status, answer: shown });
            resolve(outcome);
        };

        // Not an error when the person is away: the turn is handed back with
        // the question still on screen. The card stays open; an answer given
        // later arrives as the next message. Told to the agent as what to do
        // next, since a bare "timed out" had it retrying or giving up.
        // A runtime on the tool server is the one with a short leash: see
        // QUESTION_HOLD. In this process the turn can wait properly.
        const timer = setTimeout(() => {
            settle({
                answered: false,
                parked: true,
                message: 'The user has not answered yet. End your turn now: say in one line what you are waiting for. '
                    + 'The question stays on their screen, and their answer will reach you as their next message.',
            }, 'parked');
        }, signal ? QUESTION_HOLD : QUESTION_WAIT);

        pendingQuestions.set(requestId, { resolve: settle, timer, conversationId: conversation.id });

        // The runtime stopped waiting for the answer, which some do in
        // twenty seconds. The card stays up and the question is parked, so
        // the answer reaches the agent as the user's next message instead of
        // being settled into a call that is already dead.
        if (signal) {
            if (signal.aborted) {
                settle({ answered: false, parked: true, message: 'The runtime stopped waiting for this answer.' }, 'parked');
                return;
            }
            signal.addEventListener('abort', () => {
                settle({
                    answered: false,
                    parked: true,
                    message: 'The runtime stopped waiting for this answer before the user gave one. '
                        + 'End your turn now, saying in one line what you asked. Their answer arrives as their next message.',
                }, 'parked');
            }, { once: true });
        }

        emit(conversation, {
            type: 'question-request',
            requestId,
            question: String(question || '').slice(0, 500),
            // A secret is typed, not picked: the options would be values.
            options: name ? [] : options.slice(0, 6),
            secret: Boolean(name),
            secretName: name,
        });
    });
}

function respondToQuestion({ requestId, answer, chosen }) {
    const entry = pendingQuestions.get(requestId);
    if (!entry) return false;
    const text = String(answer || '').trim();
    if (!text) {
        entry.resolve({ answered: false, message: 'The user dismissed the question without answering.' }, 'dismissed');
        return true;
    }
    entry.resolve({ answered: true, answer: text, chosen: Boolean(chosen) }, 'answered');
    return true;
}

/**
 * Ask the renderer to do something only it can.
 *
 * Opening a session means creating a tab, and tabs live in the pane tree in
 * the window. So the main process asks, the same way it asks about an unknown
 * host key, and waits for the window to report back.
 */
function requestAction(conversation, payload) {
    return new Promise((resolve) => {
        const requestId = nextId('action');

        const settle = (result) => {
            const entry = pendingActions.get(requestId);
            if (!entry) return;
            clearTimeout(entry.timer);
            pendingActions.delete(requestId);
            resolve(result);
        };

        const timer = setTimeout(() => {
            settle({ success: false, message: 'The app did not finish that in time.' });
        }, ACTION_TIMEOUT);

        pendingActions.set(requestId, { resolve: settle, timer });
        notify('ai-action', { conversationId: conversation.id, requestId, ...payload });
    });
}

function respondToApproval({ requestId, approved, message }) {
    const entry = pendingApprovals.get(requestId);
    if (!entry) return false;
    entry.resolve(
        { approved: Boolean(approved), message: message || '' },
        approved ? 'approved' : 'denied'
    );
    return true;
}

function respondToAction({ requestId, success, sessionId, message }) {
    const entry = pendingActions.get(requestId);
    if (!entry) return false;
    entry.resolve({ success: Boolean(success), sessionId: sessionId || '', message: message || '' });
    return true;
}

/** Start the provider for a conversation, once, on the first message. */
function ensureProvider(conversation) {
    if (conversation.session) return Promise.resolve(conversation.session);
    if (conversation.starting) return conversation.starting;

    const current = effectiveSettings(conversation);
    const provider = PROVIDERS[current.provider];
    if (!provider) {
        return Promise.reject(new Error(`No provider named "${current.provider}" is available`));
    }

    const context = () => ({
        scope: conversation.scope,
        boundSessionId: conversation.boundSessionId,
        sessionIds: conversation.sessionIds,
        hostIds: conversation.hostIds,
        commandMode: current.commandMode,
        blockedCommands: current.blockedCommands,
        instructions: current.instructions,
        // What the agent may touch on this computer, so the prompt can say so
        // before the tools have to refuse.
        sandbox: agents.sandbox(conversation.agentId),
        // As it stands when the query starts; notes written mid-conversation
        // are reached with recall until the next one.
        memory: memory.summary(conversation.agentId),
    });

    // A session id belongs to the agent that issued it. Switching agents
    // mid-conversation, or coming back to a stored one after the setting
    // changed, leaves an id that the new agent would either refuse or, worse,
    // resolve to something else entirely. So it is dropped, and the transcript
    // is what carries on rather than the model's memory of it.
    if (conversation.provider && conversation.provider !== current.provider) {
        conversation.providerSessionId = '';
    }
    // The same for a change of account on the same runtime: a Claude Code
    // session lives in the folder of the account that made it, and the other
    // account's CLI has never heard of it.
    if (conversation.provider === current.provider
        && (conversation.accountId || accounts.DEFAULT_ID) !== current.accountId) {
        conversation.providerSessionId = '';
    }

    // Whose session id the conversation is about to be holding. Recorded before
    // the start rather than after it, because a query that fails on the way up
    // can still have announced a session first.
    conversation.provider = current.provider;
    conversation.accountId = current.accountId;

    conversation.starting = provider.start({
        settings: current,
        // Read again on every tool call, so tightening the approval policy
        // mid-run takes effect on the next call rather than the next
        // conversation. The snapshot above is only for the options the SDK
        // fixes when the query starts.
        getSettings: () => effectiveSettings(conversation),
        systemPrompt: prompt.build(context()),
        toolContext: () => ({
            scope: conversation.scope,
            boundSessionId: conversation.boundSessionId,
            // Read fresh on every call, like the settings above, so unticking a
            // server mid-run takes it out of reach on the next tool call rather
            // than the next conversation.
            sessionIds: conversation.sessionIds,
            hostIds: conversation.hostIds,
            settings: effectiveSettings(conversation),
            // Whose inventory the host tools look in.
            agentId: conversation.agentId,
            // What kind of run this is, so a scheduled run cannot schedule.
            runKind: conversation.runKind,
            jobs: jobsApiFor(conversation),
            // The user's hooks, around every tool call. See runHooks.
            hooks: (event, payload) => runHooks(conversation, event, payload),
            // Handing work to another agent, or to many hosts. See delegateApiFor.
            delegate: delegateApiFor(conversation),
            // The envelope, read fresh too: a folder granted or a container
            // switched on mid-run applies to the next call.
            sandbox: agents.sandbox(conversation.agentId),
            // The inventory tools write to the store behind the renderer's
            // state, the way an import does, so every window is told which
            // collection to read again.
            inventoryChanged: (kind) => notify('inventory-changed', { kind, agentId: conversation.agentId }),
            // Whose conversation this is, so a search can mark itself.
            conversationId: conversation.id,
            // Our edit tools record the file on either side of the write, so
            // the turn can be undone. See checkpoints.js.
            checkpoint: {
                before: (file, state) => checkpoints.before(conversation.id, withHost(file), state),
                after: (file, state) => checkpoints.after(conversation.id, withHost(file), state),
                passage: (file, change) => checkpoints.passage(conversation.id, withHost(file), change),
            },
            // The agent's own past, through the same search the history page
            // uses. Given as a function because this module owns the map
            // and the tool catalog must not require it back.
            searchConversations: (args) => search({ ...args, agentId: conversation.agentId }),
            // And one of them in full, once search has found it.
            readConversation: (conversationId, options = {}) => (
                readConversation(conversationId, { ...options, agentId: conversation.agentId })
            ),
            // A question to the person, answered on a card. See requestQuestion.
            askUser: (payload) => requestQuestion(conversation, payload || {}),
            // The secrets store as this conversation's agent sees it, minus
            // reading: it lists its own names and the shared ones, resolves
            // references at the moment of use, and deletes its own on
            // request. Another agent's secrets are not there to name, and
            // the values never come this way.
            secrets: (() => {
                const scoped = secrets.forAgent(conversation.agentId);
                return {
                    ...scoped,
                    // Storing one the agent already holds, which is the case
                    // for a key pasted into chat. Once stored it is masked out
                    // of every event already recorded, this conversation's
                    // included.
                    set: (name, value) => {
                        const kept = scoped.set(name, value);
                        if (kept.stored) scrubHistory();
                        return kept;
                    },
                };
            })(),
            sessionAction: async (payload) => {
                // Through a window when there is one, so the person sees the
                // tab open; through the main process when there is none. A
                // session opened headless is adopted by the next window up.
                if (payload?.action === 'connect' && !hasWindow()) {
                    return headless.open({ hostId: payload.hostId, agentId: conversation.agentId });
                }
                // Typing and closing need no window at all for an SSH session
                // the main process holds, which is every session this agent
                // opened headless and most it opened through a pane.
                if (payload?.action === 'input' && ssh.get(payload.sessionId)) {
                    return ssh.write(payload.sessionId, payload.data)
                        ? { success: true }
                        : { success: false, message: 'That session is not accepting input' };
                }
                // The shell beside a conversation is typed into the same way,
                // so run_command can start the dev server in the terminal the
                // user is watching. It is theirs to close, though, not the
                // agent's: see local-terminal.js.
                if (localTerminal.get(payload?.sessionId)) {
                    if (payload.action === 'input') {
                        return localTerminal.write(payload.sessionId, payload.data)
                            ? { success: true }
                            : { success: false, message: 'That terminal is not accepting input' };
                    }
                    if (payload.action === 'disconnect') {
                        return { success: false, message: 'That is the user\'s own terminal. Ask them to close it if it should go.' };
                    }
                }
                if (payload?.action === 'disconnect' && !hasWindow() && ssh.get(payload.sessionId)) {
                    ssh.destroy(payload.sessionId);
                    return { success: true };
                }
                const result = await requestAction(conversation, payload);
                // A session this agent opened is this agent's. Claimed here,
                // where the id first comes back, rather than in the transport,
                // which does not know who asked for the tab.
                if (payload?.action === 'connect' && result?.success && result.sessionId) {
                    transcript.claim(result.sessionId, conversation.agentId);
                }
                return result;
            },
        }),
        requestApproval: (request) => requestApproval(conversation, request),
        onEvent: (event) => handleProviderEvent(conversation, event),
        // Continues the same SDK session after a restart, which is what lets
        // the model be switched without losing the conversation.
        resumeSessionId: conversation.providerSessionId,
    }).then((session) => {
        conversation.session = session;
        conversation.starting = null;
        return session;
    }).catch((error) => {
        conversation.starting = null;
        throw error;
    });

    return conversation.starting;
}

/** A server's file, named with the host it is on, for the card. */
function withHost(file) {
    if (file?.where !== 'remote' || file.host) return file;
    return { ...file, host: transcript.info(file.sessionId)?.hostName || '' };
}

function handleProviderEvent(conversation, event) {
    // Not a transcript item: it says what this machine can run, not what
    // happened in this chat. Held here and pushed on its own channel rather
    // than emitted, so it is not replayed into a panel as a message and does
    // not spend a slot in the conversation's event log.
    if (event.type === 'models') {
        if (event.models?.length) {
            const provider = resolved().provider;
            modelCatalogs.set(provider, event.models);
            notify('ai-models', { provider, models: event.models });
        }
        return;
    }

    // A refusal belongs in the audit trail rather than in the chat. The model
    // is told why in the tool result and will say so in its reply, so putting
    // it in the transcript as well would be the same sentence twice; what is
    // actually worth keeping is the record that something tried, next to the
    // commands that did run.
    if (event.type === 'tool-blocked') {
        const target = conversation.boundSessionId || '';
        const info = target ? transcript.info(target) : null;
        activity.record({
            category: 'security',
            action: 'assistant.blocked',
            outcome: 'warning',
            target: info?.hostName || '',
            subject: info?.address || '',
            detail: `The assistant tried to run a command matching the blocked rule "${event.rule}"`,
            hostId: info?.hostId || '',
            hostName: info?.hostName || '',
        });
        return;
    }

    if (event.type === 'session') {
        conversation.providerSessionId = event.sessionId;
    }
    // Held so a panel can be told how this conversation is being paid for
    // without waiting for the next turn to say so again.
    if (event.type === 'account') {
        conversation.account = event;
        lastAccount = event;
    }
    // Plan windows a runtime reports as it goes, already in the limits
    // page's shape. Not a transcript item: it describes the account.
    if (event.type === 'limits') {
        if (Array.isArray(event.windows) && event.windows.length) {
            limits.recordWindows(conversation.provider, conversation.accountId, event.windows);
        }
        return;
    }
    if (event.type === 'rate-limit') {
        conversation.rateLimit = event;
        // The plan's own figure, so it is the account's, not the chat's: kept
        // where the settings page reads every account's limits from.
        const window = limits.fromClaudeEvent(event);
        if (window) limits.recordWindows(conversation.provider, conversation.accountId, [window]);
    }
    if (event.type === 'result') {
        conversation.busy = false;
        conversation.costUsd += event.costUsd || 0;
        limits.recordTurn(conversation.provider, conversation.accountId, {
            usage: event.usage,
            costUsd: event.costUsd,
            isError: event.isError,
        });
    }
    if (event.type === 'error' || event.type === 'closed') {
        conversation.busy = false;
    }
    if (event.type === 'tool-call' && !event.local) {
        recordToolActivity(conversation, event);
    }
    emit(conversation, event);
    recordRunEvent(conversation, event);
}

/* ------------------------------------------------------------------ *
 * Runs
 *
 * Every turn a person sends is a run: created when the message goes, closed
 * by the provider's result. The tool calls in between are its steps, written
 * pending before they run and complete after, which is what the run log is
 * for. Nothing here changes what a conversation does; it writes down what it
 * did, and stops it when a budget says so.
 * ------------------------------------------------------------------ */

function beginRun(conversation, { kind = 'interactive', trigger = { source: 'window' }, policy, title, resumeRunId = '' } = {}) {
    try {
        let runId = resumeRunId;
        if (runId) {
            runs.start(runId);
        } else {
            const run = runs.create({
                agentId: conversation.agentId,
                kind,
                trigger,
                policy,
                conversationId: conversation.id,
                jobId: conversation.jobId || '',
                title: title || conversation.title || '',
            });
            runs.start(run.id);
            runId = run.id;
        }
        runs.beginStep(runId, { kind: 'turn', name: 'turn' });
        conversation.runId = runId;
        emit(conversation, { type: 'run-started', runId, kind });
        runHooks(conversation, 'run-start', { kind, title: conversation.title || '' }).catch(() => {});
        return runId;
    } catch (error) {
        console.error('Could not start a run:', error.message);
        return '';
    }
}

// conversationId -> resolve, for a parent waiting on a delegated run.
const runWaiters = new Map();

/**
 * The follow-up that asks the agent to keep what it learned, when the
 * setting is on and the turn did real work. Off by default; see settings.
 */
const REMEMBER_PROMPT = 'Before we move on: if this turn taught you anything worth keeping for next time '
    + '(a fact about a machine or a project, how the user likes things done, what a fix turned out to be), '
    + 'save it with remember, one fact per note. If there is nothing worth keeping, reply with exactly: nothing to keep.';

/** The agent's last reply in a conversation, for a run's result. */
function lastReply(conversation) {
    for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
        const event = conversation.events[index];
        if (event.type === 'user-message') break;
        if (event.type === 'assistant-text' && event.text) return String(event.text).slice(0, 4000);
    }
    return '';
}

/** Close the run a conversation is on, whichever way the turn ended. */
function endRun(conversation, status, detail = {}) {
    const runId = conversation.runId;
    if (!runId) return;
    conversation.runId = '';
    const unattended = conversation.runKind !== 'interactive';
    try {
        const turn = runs.openStep(runId, 'turn');
        if (turn) runs.endStep(runId, turn.seq, { status: status === 'done' ? 'complete' : 'interrupted', output: detail.reason || '' });
        const result = { ...detail, summary: lastReply(conversation) };
        if (status === 'done') runs.finish(runId, result);
        else if (status === 'cancelled') runs.cancel(runId, detail.reason || '');
        else runs.fail(runId, detail.reason || '', result);
        emit(conversation, { type: status === 'done' ? 'run-finished' : status === 'cancelled' ? 'run-cancelled' : 'run-failed', runId, ...detail });
    } catch (error) {
        console.error('Could not close a run:', error.message);
    }

    runHooks(conversation, 'run-end', { status, title: conversation.title || '', summary: lastReply(conversation).slice(0, 2000) }).catch(() => {});

    // A parent waiting on this delegated run is told, whichever way it went.
    const waiter = runWaiters.get(conversation.id);
    if (waiter) {
        runWaiters.delete(conversation.id);
        waiter({ status, runId, summary: lastReply(conversation), reason: detail.reason || '' });
    }

    if (unattended) {
        // The job's conversation is put down once its turn is over: the
        // process behind it is the expensive half, and the transcript stays
        // for the Runs page and the history menu. Delivery is the
        // scheduler's, through the run-ended hook.
        setTimeout(() => { park(conversation.id).catch(() => {}); }, 0);
        return;
    }

    if (status === 'done' && hasWindow() && !windowFocused()) {
        // Finished while the person was elsewhere.
        toast({
            title: `${conversation.title || 'The agent'} is done`,
            body: lastReply(conversation).replace(/\s+/g, ' ').slice(0, 200),
            conversationId: conversation.id,
            runId,
        });
    }

    // The built-in run-end hook: one more turn to write down what was
    // learned, only after a turn that did real work, and never after itself.
    if (status === 'done' && !conversation.remembering && resolved(conversation.agentId).autoRemember) {
        let calls = 0;
        try { calls = runs.get(runId)?.toolCalls || 0; } catch { calls = 0; }
        if (calls >= 3) {
            conversation.remembering = true;
            setTimeout(() => {
                send(conversation.id, REMEMBER_PROMPT)
                    .catch(() => {})
                    .finally(() => { conversation.remembering = false; });
            }, 0);
            return;
        }
    }
    conversation.remembering = false;
}

/* ------------------------------------------------------------------ *
 * Delegation
 *
 * One primitive: a conversation opens a child conversation, sends it a
 * brief, and waits for its run to end. The child is another agent's when
 * the brief names one, and the same agent's otherwise; a fan-out is the
 * same thing once per host, each child pinned to its host, run a few at
 * a time. A child never gets a looser policy than its parent, and the
 * chain stops at two deep: a hand-off is where work goes silent, and a
 * chain nobody is reading is already too long at three.
 * ------------------------------------------------------------------ */

const MAX_DELEGATION_DEPTH = 2;
const FAN_OUT_CONCURRENCY = 4;
const DELEGATION_TIMEOUT = 60 * 60 * 1000;

function findAgent(nameOrId) {
    const wanted = String(nameOrId || '').trim().toLowerCase();
    if (!wanted) return null;
    return agents.snapshot().agents.find(agent => agent.id === nameOrId || agent.name.toLowerCase() === wanted) || null;
}

async function runChild(parent, { agentId, brief, hostIds = [], title = '' }) {
    const created = create({
        agentId,
        scope: hostIds.length ? 'targets' : (parent.scope === 'targets' ? 'targets' : 'global'),
        hostIds: hostIds.length ? hostIds : parent.hostIds,
        sessionIds: hostIds.length ? [] : parent.sessionIds,
    });
    const child = conversations.get(created.conversationId);
    child.parentId = parent.id;
    child.depth = (parent.depth || 0) + 1;
    child.title = secrets.scrub(title || `${parent.title || 'Delegated'} → ${agents.get(agentId)?.name || 'agent'}`);
    child.runKind = 'delegated';
    child.runTrigger = { source: 'delegate', parentRunId: parent.runId || '', parentConversationId: parent.id };
    // Never looser than the parent: the parent's policy, or, for a person's
    // conversation, the agent's own settings, which are what the parent has.
    child.runPolicy = parent.runPolicy || null;
    child.settingsPatch = parent.settingsPatch || null;

    const ended = new Promise((resolve) => {
        runWaiters.set(child.id, resolve);
        setTimeout(() => {
            if (runWaiters.delete(child.id)) {
                interrupt(child.id).catch(() => {});
                resolve({ status: 'failed', reason: 'The delegated run took too long.', summary: lastReply(child) });
            }
        }, DELEGATION_TIMEOUT);
    });

    const sent = await send(child.id, brief);
    if (!sent.success) {
        runWaiters.delete(child.id);
        return { conversationId: child.id, status: 'failed', reason: sent.message || 'The brief could not be sent.', summary: '' };
    }
    const outcome = await ended;
    // The child's cost is the parent's cost.
    try {
        const childRun = runs.get(outcome.runId);
        if (parent.runId && childRun) runs.tally(parent.runId, { costUsd: childRun.costUsd });
    } catch { /* counted nowhere, which is the lesser harm */ }
    setTimeout(() => { park(child.id).catch(() => {}); }, 0);
    return { conversationId: child.id, agentId, ...outcome };
}

function delegateApiFor(conversation) {
    const tooDeep = () => (conversation.depth || 0) >= MAX_DELEGATION_DEPTH;
    return {
        /** Hand a brief to an agent (by name) or to this one, and wait. */
        run: async ({ agent = '', brief, title = '' }) => {
            if (tooDeep()) return { error: `Delegation stops ${MAX_DELEGATION_DEPTH} levels deep. Do this part yourself.` };
            const target = agent ? findAgent(agent) : agents.get(conversation.agentId);
            if (!target) return { error: `There is no agent called "${agent}".` };
            return runChild(conversation, { agentId: target.id, brief, title });
        },
        /** The same brief once per host, each child pinned to its host. */
        fanOut: async ({ hostIds, brief, title = '' }) => {
            if (tooDeep()) return { error: `Delegation stops ${MAX_DELEGATION_DEPTH} levels deep. Do this part yourself.` };
            const hosts = store.getHosts();
            const wanted = hostIds.map(id => hosts.find(host => host.id === id)).filter(Boolean);
            if (wanted.length === 0) return { error: 'None of those host ids are saved.' };
            const results = [];
            let index = 0;
            const worker = async () => {
                while (index < wanted.length) {
                    const host = wanted[index];
                    index += 1;
                    const outcome = await runChild(conversation, {
                        agentId: conversation.agentId,
                        brief: `On the host "${host.name}" (id ${host.id}), and only there:\n\n${brief}`,
                        hostIds: [host.id],
                        title: title ? `${title} · ${host.name}` : `${conversation.title || 'Fan-out'} · ${host.name}`,
                    });
                    results.push({ hostId: host.id, host: host.name, ...outcome });
                }
            };
            await Promise.all(Array.from({ length: Math.min(FAN_OUT_CONCURRENCY, wanted.length) }, worker));
            return { results };
        },
        agents: () => agents.snapshot().agents.map(agent => ({ id: agent.id, name: agent.name })),
    };
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/**
 * A conversation as Markdown, for a ticket or a hand-over.
 *
 * `full` is the debugging cut: the runtime, model and policy the turn ran
 * under, every tool input as it was sent, and results as they came back
 * rather than the first screen of them. Inputs are the stored events'
 * inputs, which were redacted on the way in, so a password the agent set on
 * a host is a mask here as everywhere else.
 *
 * `messagesOnly` is the conversation as it was spoken: what the user said,
 * what the agent answered and the questions between them, without the tool
 * calls that are most of a long one.
 */
function exportMarkdown(conversationId, { full = false, messagesOnly = false } = {}) {
    hydrate();
    const conversation = conversations.get(conversationId);
    if (!conversation) return null;
    const agent = agents.get(conversation.agentId);
    const lines = [
        `# ${conversation.title || 'Conversation'}`,
        '',
        `Agent: ${agent?.name || conversation.agentId} · ${new Date(conversation.createdAt).toISOString()} · exported ${new Date().toISOString()}`,
        '',
    ];
    if (full) {
        const current = effectiveSettings(conversation);
        const scope = conversation.scope || {};
        lines.push(
            `Runtime: ${current.provider || '?'} · model ${current.model || 'default'} · effort ${current.effort || 'default'}`,
            `Approvals: ${current.approval || '?'}${conversation.runPolicy?.approvals ? ` (run policy ${conversation.runPolicy.approvals})` : ''}`
                + ` · kind ${conversation.runKind || 'chat'}${conversation.jobId ? ` · job ${conversation.jobId}` : ''}`,
            `Scope: ${scope.mode || 'front'}${Array.isArray(scope.targets) && scope.targets.length ? ` · ${scope.targets.length} targets` : ''}`,
            `Servers: ${(agent?.mcpServers || []).map(server => server.name).join(', ') || 'none'}`,
            `Conversation: ${conversation.id}${conversation.runId ? ` · run ${conversation.runId}` : ''}`,
            '',
        );
    }
    const resultCap = full ? 20000 : 4000;
    const fence = (text, lang = '') => `\`\`\`${lang}\n${String(text || '').replace(/```/g, '``​`')}\n\`\`\``;
    const stamp = (event) => (full && event.at ? ` <sub>${new Date(event.at).toISOString().slice(11, 19)}</sub>` : '');

    /**
     * A result printed under the call it answers, rather than where it fell.
     *
     * An agent that makes three calls at once produces three calls and then
     * three results, and in a flat transcript each result reads as the answer
     * to the call above it, which is the one before. Someone debugging from
     * an export then reasons about the wrong pair. Both events carry the
     * call's id, so they are put back together here.
     */
    const resultFor = new Map();
    for (const event of conversation.events) {
        if (event.type === 'tool-result' && event.id) resultFor.set(event.id, event);
    }
    const printed = new Set();
    const pushResult = (event) => {
        if (!event?.text) return;
        const text = String(event.text);
        lines.push(fence(text.slice(0, resultCap)), '');
        if (text.length > resultCap) lines.push(`_… ${text.length - resultCap} more characters not shown._`, '');
    };

    const spoken = new Set(['user-message', 'assistant-text', 'question-request', 'question-settled', 'notice']);
    for (const event of conversation.events) {
        if (messagesOnly && !spoken.has(event.type)) continue;
        switch (event.type) {
            case 'user-message':
                lines.push(`## You${stamp(event)}`, '', event.text || '', '');
                break;
            case 'assistant-text':
                lines.push(`## Agent${stamp(event)}`, '', event.text || '', '');
                break;
            case 'tool-call': {
                if (full) {
                    lines.push(`**${event.name}**${stamp(event)}`, '');
                    if (event.input && Object.keys(event.input).length) {
                        lines.push(fence(JSON.stringify(event.input, null, 2), 'json'), '');
                    }
                } else {
                    const input = event.name === 'run_command' ? String(event.input?.command || '') : summarise(event.input);
                    lines.push(`**${event.name}** ${input ? `\`${input.replace(/`/g, '\'')}\`` : ''}`, '');
                }
                // Its own answer, here, whether or not other calls were made
                // in between.
                const answer = resultFor.get(event.id);
                if (answer) {
                    printed.add(answer);
                    pushResult(answer);
                }
                break;
            }
            case 'tool-result':
                // Only the ones no call claimed: a result from a call this
                // conversation no longer holds is still worth reading.
                if (!printed.has(event)) pushResult(event);
                break;
            case 'error':
                lines.push(`> **Error:** ${event.text || event.message || ''}`, '');
                break;
            case 'approval-settled':
                lines.push(`_Approval: ${event.status}_`, '');
                break;
            case 'question-request':
                lines.push(`> **Agent asked:** ${event.question}`, '');
                break;
            case 'question-settled':
                if (event.answer) lines.push(`> **Answer:** ${event.answer}`, '');
                break;
            case 'notice':
                lines.push(`_${event.text}_`, '');
                break;
            default:
                break;
        }
    }
    return lines.join('\n');
}

/**
 * One of an agent's own conversations, for it to read back.
 *
 * Search hands back a line or two around each hit, which is enough to find a
 * conversation and not enough to use it: ten drafts a chat ended on were one
 * long message the search showed a sentence of, and the agent took the
 * sentence for all there was. This is the export the user would otherwise
 * have pasted in. Another agent's conversation is not found, the way search
 * never lists it.
 */
function readConversation(conversationId, { agentId = '', messagesOnly = false } = {}) {
    hydrate();
    const conversation = conversations.get(String(conversationId || ''));
    if (!conversation || (agentId && conversation.agentId !== agentId)) return null;
    return {
        conversationId: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        text: exportMarkdown(conversation.id, { messagesOnly }),
    };
}

/* ------------------------------------------------------------------ *
 * Jobs: the scheduler's way in
 * ------------------------------------------------------------------ */

const JOB_KINDS = { at: 'scheduled', every: 'scheduled', cron: 'scheduled', heartbeat: 'triggered', event: 'triggered', webhook: 'triggered' };

/** The prompt a job's run starts with: the task, and what the door said. */
function jobPrompt(job, { context = '', source = '', unknown = [] } = {}) {
    const parts = [];
    if (unknown.length) {
        parts.push(
            '<resumed>\nThis run was interrupted by the app closing and is resuming. The outcome of these tool calls '
            + 'was lost, so they may or may not have happened. Check before repeating any of them:\n'
            + `${unknown.map(step => `- ${step.name}: ${step.input}`).join('\n')}\n</resumed>`,
        );
    }
    if (context) {
        parts.push(`<trigger source="${source}">\n${context}\n</trigger>`);
    }
    parts.push(
        `<job name="${job.name.replace(/"/g, '\'')}">\nThis is an unattended run started by a job, not a message from the user. `
        + 'Do the task below, then finish with a short report of what you found and what you did: it is delivered to the user as the result. '
        + (job.policy?.approvals === 'read-only'
            ? 'This run is read-only: look, do not change anything, and say what you would have done.'
            : job.policy?.approvals === 'park'
                ? 'Anything that changes a system will wait for the user to approve it, possibly for hours; prefer to gather and report, and ask for a change only when it is the point of the task.'
                : '')
        + '\n</job>',
    );
    parts.push(job.prompt || 'Run the probe result above through your judgement and report.');
    return parts.join('\n\n');
}

/**
 * Start a run for a job: a conversation of its own, the job's policy and
 * pinned model on it, and the prompt sent. Resolves once the turn has been
 * sent; the outcome reaches the scheduler through the run-ended hook.
 */
async function startJobRun(job, { context = '', source = 'schedule', resumeRun = null } = {}) {
    hydrate();
    if (!agents.get(job.agentId)) return { error: 'The agent this job belongs to no longer exists.' };

    let conversation;
    if (job.session && job.session !== 'isolated' && conversations.has(job.session)) {
        conversation = conversations.get(job.session);
        if (conversation.busy) return { error: 'The conversation this job continues is busy.' };
    } else {
        const created = create({ agentId: job.agentId, scope: 'global' });
        conversation = conversations.get(created.conversationId);
    }

    conversation.title = job.name;
    conversation.runKind = JOB_KINDS[job.schedule?.kind] || 'scheduled';
    conversation.runTrigger = { source, jobId: job.id };
    conversation.runPolicy = runs.normalizePolicy(job.policy);
    conversation.jobId = job.id;
    conversation.settingsPatch = {
        ...(job.provider ? { provider: job.provider } : {}),
        ...(job.model ? { model: job.model } : {}),
        ...(job.effort ? { effort: job.effort } : {}),
    };
    // A pinned model applies from the next query; a conversation continued
    // by a job may be holding a session on another one.
    if (conversation.session) conversation.needsRestart = true;

    const unknown = resumeRun ? runs.unknownSteps(resumeRun.id) : [];
    if (resumeRun) {
        // The turn is re-sent from scratch under the same run: the provider
        // session that held the half-finished turn died with the process.
        conversation.providerSessionId = '';
        beginRun(conversation, { resumeRunId: resumeRun.id });
    }

    const sent = await send(conversation.id, jobPrompt(job, { context, source, unknown }));
    if (!sent.success) return { error: sent.message || 'The prompt could not be sent.' };
    return { runId: conversation.runId, conversationId: conversation.id };
}

/** A job's run re-queued on launch. The job decides the context afresh. */
function resumeJobRun(run) {
    const job = jobs.get(run.jobId);
    if (!job) {
        runs.fail(run.id, 'The job this run belonged to is gone.');
        return Promise.resolve({ error: 'No such job' });
    }
    return startJobRun(job, { source: 'resume', resumeRun: run });
}

/** A heartbeat's probe: a local command inside the agent's own folders. */
function probeForJob(job, probe) {
    const ctx = { agentId: job.agentId, sandbox: agents.sandbox(job.agentId) };
    return local.run(ctx, probe.command, { cwd: probe.cwd || '', timeout: 60000 });
}

/**
 * What the schedule tools may do, on behalf of one conversation.
 *
 * Bound to the conversation's agent so a job always lands in the right
 * bag, and refused outright from a run a job started: a job that makes
 * jobs is how a scheduler eats a machine.
 */
/**
 * Which model a person meant, across the runtimes the agent has on.
 *
 * Each runtime's list is asked for (cached after the first time), and the
 * query is matched against all of them: "grok 4.6 xhigh" finds the row on
 * Grok, "opus" on Claude Code, and a name two runtimes both offer is
 * reported as ambiguous rather than guessed.
 */
/**
 * The live model rows of every runtime this agent has on, one catalog each.
 * What the runtimes report now, not a list anyone typed: this is what the
 * agent reads before it names a model.
 */
async function catalogsFor(agentId) {
    const enabled = settings.get(agentId).providers || [];
    const catalogs = [];
    for (const provider of enabled) {
        let rows = null;
        try {
            rows = await models({ provider });
        } catch {
            rows = null;
        }
        catalogs.push({ provider, rows: rows || [] });
    }
    return catalogs;
}

async function resolveModel(agentId, query) {
    const enabled = settings.get(agentId).providers || [];
    return modelMatch.matchModel(await catalogsFor(agentId), query, { providerOrder: enabled });
}

/**
 * Pin a conversation to a runtime, a model and an effort, or change the pin
 * it has. This is what the composer's chip changes: the pin, not the agent's
 * default behind it, so each conversation keeps the model it was left on.
 * Like a change of settings, a new model or effort on the same runtime is
 * pushed at the running session, and another runtime restarts the query on
 * the next message.
 */
function setConversationModel(conversationId, patch = {}) {
    hydrate();
    const conversation = conversations.get(conversationId);
    if (!conversation) return { error: 'No such conversation.' };
    const before = effectiveSettings(conversation);
    const current = conversation.settingsPatch || {};
    const next = {};
    const provider = patch.provider !== undefined ? patch.provider : current.provider;
    if (provider && PROVIDERS[provider]) next.provider = provider;
    const model = patch.model !== undefined ? patch.model : current.model;
    if (model) next.model = String(model).slice(0, 120);
    const effort = patch.effort !== undefined ? patch.effort : current.effort;
    if (effort) next.effort = String(effort).slice(0, 20);
    conversation.settingsPatch = Object.keys(next).length ? next : null;
    archive.save();

    const after = effectiveSettings(conversation);
    const session = conversation.session;
    if (before.provider !== after.provider || accountMoved(conversation, before, after)) {
        if (session || conversation.starting) conversation.needsRestart = true;
    } else if (session) {
        if (before.model !== after.model) session.setModel?.(after.model);
        if (before.effort !== after.effort) session.setEffort?.(after.effort);
    }
    return { pinned: conversation.settingsPatch };
}

function jobsApiFor(conversation) {
    const refuse = () => ({ error: 'A run started by a job cannot manage jobs. Ask the user to do it from the Jobs page.' });
    const unattended = () => conversation.runKind !== 'interactive';
    return {
        resolveModel: (query) => resolveModel(conversation.agentId, query),
        listModels: () => catalogsFor(conversation.agentId),
        /**
         * Start a run now, in the background, on the model the user named.
         * A one-shot job fired at once: it gets the job machinery (policy,
         * budget, delivery, a conversation of its own, the Runs page) and
         * the record goes when the run is done; the run stays.
         */
        startTask: async (spec) => {
            if (unattended()) return refuse();
            const result = jobs.create({
                ...spec,
                agentId: conversation.agentId,
                createdBy: 'agent',
                schedule: { kind: 'at', at: Date.now() },
                keepAfterRun: false,
            });
            if (result.error) return result;
            const started = await scheduler.runNow(result.job.id);
            if (started?.error) return { error: started.error };
            return { job: publicJob(jobs.get(result.job.id) || result.job), runId: started.runId || '', conversationId: started.conversationId || '' };
        },
        list: () => jobs.list({ agentId: conversation.agentId }).map(publicJob),
        create: (spec) => {
            if (unattended()) return refuse();
            const result = jobs.create({ ...spec, agentId: conversation.agentId, createdBy: 'agent' });
            return result.error ? result : { job: publicJob(result.job) };
        },
        update: (jobId, patch) => {
            if (unattended()) return refuse();
            const job = jobs.get(jobId);
            if (!job || job.agentId !== conversation.agentId) return { error: 'No such job in your inventory.' };
            const result = jobs.update(jobId, patch);
            return result.error ? result : { job: publicJob(result.job) };
        },
        remove: (jobId) => {
            if (unattended()) return refuse();
            const job = jobs.get(jobId);
            if (!job || job.agentId !== conversation.agentId) return { error: 'No such job in your inventory.' };
            return { removed: jobs.remove(jobId) };
        },
        runNow: async (jobId) => {
            if (unattended()) return refuse();
            const job = jobs.get(jobId);
            if (!job || job.agentId !== conversation.agentId) return { error: 'No such job in your inventory.' };
            return scheduler.runNow(jobId);
        },
    };
}

/** A job as the agent and the page see it: no token. */
function publicJob(job) {
    if (!job) return null;
    const { token, ...rest } = job;
    return { ...rest, webhookUrl: scheduler.webhookUrl(job) };
}

function recordRunEvent(conversation, event) {
    const runId = conversation.runId;
    if (!runId) return;
    try {
        switch (event.type) {
            // Masked the way the transcript is: the runs log is read on the
            // Runs page and by the trace, and a password typed into a form
            // was in it in the clear.
            case 'tool-call': {
                runs.beginStep(runId, {
                    kind: 'tool',
                    name: event.name,
                    input: secrets.scrubDeep(catalog.redactInput(event.input)),
                });
                runs.tally(runId, { toolCalls: 1 });
                stopIfOverBudget(conversation);
                break;
            }
            case 'tool-result': {
                const step = runs.openStep(runId, 'tool', event.name || '');
                if (step) runs.endStep(runId, step.seq, { status: event.isError ? 'failed' : 'complete', output: secrets.scrub(event.text || '') });
                break;
            }
            case 'result': {
                runs.tally(runId, { costUsd: event.costUsd || 0, turns: 1 });
                if (event.isError && event.subtype !== 'success') {
                    endRun(conversation, 'failed', { reason: `The run ended early (${event.subtype}).`, subtype: event.subtype });
                } else {
                    endRun(conversation, 'done', { costUsd: event.costUsd || 0 });
                }
                break;
            }
            case 'error':
                endRun(conversation, 'failed', { reason: event.message || 'The provider reported an error.' });
                break;
            case 'closed':
                endRun(conversation, 'failed', { reason: 'The provider closed before the turn finished.' });
                break;
            default:
                break;
        }
    } catch (error) {
        console.error('Could not record a run step:', error.message);
    }
}

/** Stop the turn when the run's policy says it has spent enough. */
function stopIfOverBudget(conversation) {
    const reason = conversation.runId ? runs.overBudget(conversation.runId) : '';
    if (!reason) return;
    emit(conversation, { type: 'notice', tone: 'warn', text: `Stopped: ${reason}.` });
    const runId = conversation.runId;
    conversation.runId = '';
    // Interrupt is asynchronous and would otherwise close the run as
    // cancelled; it is closed here first, with the reason that matters.
    try {
        const turn = runs.openStep(runId, 'turn');
        if (turn) runs.endStep(runId, turn.seq, { status: 'interrupted', output: reason });
        runs.fail(runId, reason, { budget: true });
        emit(conversation, { type: 'run-failed', runId, reason });
    } catch (error) {
        console.error('Could not close a run on budget:', error.message);
    }
    interrupt(conversation.id).catch(() => {});
}

/** Stop a run from the runs page: the conversation it is on is interrupted. */
async function cancelRun(runId) {
    hydrate();
    const run = runs.get(runId);
    if (!run) return { success: false, message: 'No such run' };
    const conversation = [...conversations.values()].find(entry => entry.runId === runId);
    if (conversation) {
        await interrupt(conversation.id);
        return { success: true };
    }
    if (runs.OPEN_STATUSES.includes(run.status)) {
        runs.cancel(runId, 'Cancelled from the runs page.');
        return { success: true };
    }
    return { success: false, message: 'That run has already ended' };
}

/**
 * Log the calls that change something, in the app's own activity log.
 *
 * The chat transcript is not an audit trail: it lives in a window and it is
 * the model's account of events. A command the assistant ran on a server
 * belongs in the same log as one the user ran, next to the connection it
 * happened on.
 */
function recordToolActivity(conversation, event) {
    const definition = catalog.BY_NAME.get(event.name);
    if (!definition || definition.readOnly) return;

    const target = event.input?.session || conversation.boundSessionId || '';
    const info = target ? transcript.info(target) : null;
    const summary = event.name === 'run_command'
        ? String(event.input?.command || '').slice(0, 300)
        : summarise(catalog.redactInput(event.input));

    activity.record({
        category: 'connection',
        action: `assistant.${event.name}`,
        outcome: 'info',
        target: info?.hostName || '',
        subject: info?.address || '',
        detail: summary,
        hostId: info?.hostId || '',
        hostName: info?.hostName || '',
    });
}

function summarise(input) {
    if (!input || typeof input !== 'object') return '';
    return Object.entries(input)
        .filter(([key]) => key !== 'session')
        .map(([key, value]) => `${key}: ${String(value).slice(0, 120)}`)
        .join(', ')
        .slice(0, 300);
}

/**
 * Send a message.
 *
 * The situational block goes in front of the user's text, and only when it has
 * changed since the last turn. It cannot live in the system prompt: that is
 * fixed when the conversation starts, and which session is in front of the
 * user is exactly the thing that moves while they work. Sending it only on
 * change keeps the cached prefix intact for the turns where nothing moved.
 */
async function send(conversationId, text, attachments = [], tagged = []) {
    hydrate();

    const conversation = conversations.get(conversationId);
    if (!conversation) return { success: false, message: 'That conversation is gone' };

    const body = String(text || '').trim();
    const { images, error } = readImages(attachments);
    if (error) return { success: false, message: error };

    // What the message tagged is looked up here, against the inventory as it
    // stands, rather than trusted as text from the renderer. See `mentions.js`.
    const attached = readMentions(tagged, {
        hosts: store.getHosts(),
        snippets: store.getSnippets(),
        proxies: store.getProxies(),
        keys: store.getKeys(),
        notes: memory.list(conversation.agentId),
        servers: agents.get(conversation.agentId)?.mcpServers || [],
    });
    if (attached.error) return { success: false, message: attached.error };
    const { mentions } = attached;

    if (!body && images.length === 0 && mentions.length === 0) {
        return { success: false, message: 'Nothing to send' };
    }

    // Refused here rather than quietly dropped: a question about a screenshot
    // the model never saw would get an answer that reads as if it had.
    if (images.length > 0 && PROVIDERS[resolved(conversation.agentId).provider]?.supportsImages !== true) {
        return { success: false, message: 'This agent cannot read images. Claude Code and Codex can.' };
    }

    if (!conversation.title) {
        // Scrubbed like the message itself: the first line is the title in
        // every list, and "my api key is ..." is a common first line.
        conversation.title = secrets.scrub((body || mentions[0]?.name || images[0].name).replace(/\s+/g, ' ').slice(0, 80));
    }

    // The transcript keeps what was tagged and not what it said: the records
    // are in the inventory, and a chip is what the bubble draws for them.
    emit(conversation, {
        type: 'user-message',
        text: body,
        ...(images.length ? { images } : {}),
        ...(mentions.length ? { mentions: stripMentions(mentions) } : {}),
    });
    conversation.busy = true;

    // A message sent into a turn still going is a new turn of the same run
    // as far as the log is concerned; one sent into a quiet conversation
    // starts a run.
    if (!conversation.runId) {
        beginRun(conversation, {
            kind: conversation.runKind || 'interactive',
            trigger: conversation.runTrigger || { source: 'window' },
            policy: conversation.runPolicy,
            title: conversation.title,
        });
    }

    try {
        // A model or effort change since the last message. Restarting here,
        // rather than when the setting changed, means it lands between turns
        // instead of on top of one.
        if (conversation.needsRestart) await restart(conversation);
        // A runtime that keeps one process for the conversation (the ACP
        // agents) can lose it between turns. It is started again here, and
        // resumes the same session where the agent can.
        else if (conversation.session?.stopped) await restart(conversation);

        const session = await ensureProvider(conversation);

        const context = prompt.situation({
            scope: conversation.scope,
            boundSessionId: conversation.boundSessionId,
            sessionIds: conversation.sessionIds,
            hostIds: conversation.hostIds,
            commandMode: resolved(conversation.agentId).commandMode,
        });

        // Context first, then the attached documents, then what the user
        // wrote: the question comes last so it is the thing the model is
        // answering, with everything above it as the material to answer from.
        const parts = [];
        // A branch's first message carries what was said before it.
        if (conversation.carryOver) {
            parts.push(
                '<earlier-conversation>\nThis chat was branched from an earlier one, which you have no memory of. '
                + 'This is what was said there, up to the point it was branched. Carry on from it.\n\n'
                + `${conversation.carryOver}\n</earlier-conversation>`,
            );
            conversation.carryOver = '';
        }
        if (conversation.pendingNote) {
            parts.push(`<app-note>\n${conversation.pendingNote}\n</app-note>`);
            conversation.pendingNote = '';
        }
        if (context !== conversation.lastContext) {
            conversation.lastContext = context;
            parts.push(`<app-context>\n${context}\n</app-context>`);
        }

        // What the agent remembers that bears on this message, found by
        // meaning. The newest notes are in the system prompt already; this is
        // how the rest of a notebook too big for a prompt still reaches it.
        const remembered = body ? await memory.relevant(conversation.agentId, body) : [];
        if (remembered.length > 0) {
            parts.push(
                '<memory>\nNotes from your memory that may bear on this message:\n'
                + `${remembered.map(entry => `- (${entry.id}) ${entry.text}`).join('\n')}\n</memory>`,
            );
        }

        if (mentions.length > 0) parts.push(mentionBlock(mentions));
        if (body) parts.push(body);

        session.send(parts.join('\n\n'), images);
        return { success: true };
    } catch (error) {
        conversation.busy = false;
        emit(conversation, { type: 'error', message: error.message });
        endRun(conversation, 'failed', { reason: error.message });
        return { success: false, message: error.message };
    }
}

async function interrupt(conversationId) {
    const conversation = conversations.get(conversationId);
    if (!conversation?.session) return { success: false };

    // Anything this conversation is waiting on a person for is refused first.
    // Otherwise "stop" leaves a card on screen whose approval would start work
    // the user just cancelled. Scoped by conversation: a second panel's pending
    // question is not this one's to answer.
    for (const entry of [...pendingApprovals.values()]) {
        if (entry.conversationId !== conversationId) continue;
        entry.resolve({ approved: false, message: 'The user stopped the run.' }, 'denied');
    }
    for (const entry of [...pendingQuestions.values()]) {
        if (entry.conversationId !== conversationId) continue;
        entry.resolve({ answered: false, message: 'The user stopped the run.' }, 'dismissed');
    }

    await conversation.session.interrupt();
    conversation.busy = false;
    emit(conversation, { type: 'interrupted' });
    endRun(conversation, 'cancelled', { reason: 'The user stopped the run.' });
    return { success: true };
}

/**
 * Put a conversation down without ending it.
 *
 * Starting a new chat used to close the old one, which is why there was nothing
 * to go back to. Parking releases the expensive half, the provider session and
 * the process behind it, and keeps the cheap half: the event log the panel
 * rebuilds itself from, and the provider's own session id. Sending into a
 * parked conversation resumes it where it stopped, because `ensureProvider`
 * already passes that id back as `resumeSessionId`.
 */
async function park(conversationId) {
    hydrate();

    const conversation = conversations.get(conversationId);
    if (!conversation) return { success: true };

    // A turn still running is stopped first, and anything it has left waiting
    // for an answer is refused. Walking away from a question is a no.
    if (conversation.busy && conversation.session) await interrupt(conversationId);

    await restart(conversation);
    return { success: true };
}

async function close(conversationId) {
    hydrate();

    const conversation = conversations.get(conversationId);
    if (!conversation) return { success: true };
    conversations.delete(conversationId);
    checkpoints.forget(conversationId);
    // Thrown away for good, so it goes from the file too. Suspended during a
    // shutdown, which closes every conversation without meaning to forget any
    // of them.
    archive.save();
    try {
        // As in `restart`: a query still coming up has to be waited for, or it
        // outlives the conversation it belonged to.
        if (conversation.starting) await conversation.starting.catch(() => {});
        await conversation.session?.close();
    } catch {
        // Already gone.
    }
    return { success: true };
}

/** Everything a panel needs to rebuild itself after a window reload. */
function history(conversationId) {
    hydrate();

    const conversation = conversations.get(conversationId);
    if (!conversation) return { found: false, events: [] };
    return {
        found: true,
        events: conversation.events,
        scope: conversation.scope,
        sessionId: conversation.boundSessionId,
        sessionIds: conversation.sessionIds,
        hostIds: conversation.hostIds,
        busy: conversation.busy,
        costUsd: conversation.costUsd,
        title: conversation.title,
        agentId: conversation.agentId,
        // The runtime, model and effort this conversation is pinned to, when
        // a task or a job started it on a named one. Null means the agent's
        // own settings, which is what the composer shows otherwise.
        pinned: conversation.settingsPatch || null,
        // The run policy overriding the approval menu, if any. The composer
        // shows this instead of the agent's own mode while it is set, so a
        // background run never reads as yolo while it asks on everything.
        runPolicy: conversation.runPolicy?.approvals || null,
    };
}

/**
 * Every conversation the app still holds, newest first.
 *
 * The ones with a query running, the ones parked, and the ones read back off
 * disk from an earlier run, because from the panel's side those differences are
 * invisible: picking any of them reads the same event log back, and only
 * sending into it starts anything.
 */
function list({ agentId = '' } = {}) {
    hydrate();

    return [...conversations.values()]
        // One agent's, when asked; the sidebar and the Conversations page
        // only ever show the agent that is selected. Nothing that was never
        // spoken into: a tab opened and left is not a conversation yet.
        .filter(conversation => !agentId || conversation.agentId === agentId)
        .filter(conversation => conversation.title || conversation.events.length > 0)
        .map(conversation => ({
            conversationId: conversation.id,
            agentId: conversation.agentId,
            title: conversation.title,
            scope: conversation.scope,
            sessionId: conversation.boundSessionId,
            busy: conversation.busy,
            live: Boolean(conversation.session || conversation.starting),
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            pinned: Boolean(conversation.pinned),
            messages: conversation.events.filter(event => event.type === 'user-message').length,
        }))
        // The pinned ones first, newest within each half. Ordered here rather
        // than in each list that draws it, so the sidebar and the page agree.
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.updatedAt - a.updatedAt));
}

/** One row of `list`, for one conversation. */
function describe(conversation) {
    return {
        conversationId: conversation.id,
        agentId: conversation.agentId,
        title: conversation.title,
        scope: conversation.scope,
        sessionId: conversation.boundSessionId,
        busy: conversation.busy,
        live: Boolean(conversation.session || conversation.starting),
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        pinned: Boolean(conversation.pinned),
        messages: conversation.events.filter(event => event.type === 'user-message').length,
    };
}

/**
 * Search one agent's conversations by what was said in them. See search.js
 * for the query language; this only hands it the conversations and the
 * lookups it needs.
 */
async function search({ agentId = '', query = '', limit, openIds = [] } = {}) {
    hydrate();
    const rows = [...conversations.values()]
        .filter(conversation => !agentId || conversation.agentId === agentId)
        .filter(conversation => conversation.title || conversation.events.length > 0);
    const hostsById = new Map(store.getHosts().map(host => [host.id, host]));
    return searchModule.search(rows, {
        query,
        limit,
        openIds: new Set(Array.isArray(openIds) ? openIds.map(String) : []),
        hostName: (id) => hostsById.get(id)?.name || '',
        live: (conversation) => Boolean(conversation.session || conversation.starting),
        describe,
    });
}

/**
 * Keep a conversation at the top of the list, or let it go.
 *
 * A pin is the user's, not the conversation's: it does not touch
 * `updatedAt`, so unpinning drops the chat back to wherever its last
 * message put it rather than to the top as if something had just happened.
 */
function pin(conversationId, pinned) {
    hydrate();
    const conversation = conversations.get(conversationId);
    if (!conversation) return { ok: false };
    const next = Boolean(pinned);
    if (conversation.pinned !== next) {
        conversation.pinned = next;
        archive.save();
    }
    return { ok: true, pinned: next };
}

/** Hand every conversation of a deleted agent to another, so none is stranded. */
function reassign(fromAgentId, toAgentId) {
    hydrate();
    let moved = 0;
    for (const conversation of conversations.values()) {
        if (conversation.agentId !== fromAgentId) continue;
        conversation.agentId = toAgentId;
        moved += 1;
    }
    if (moved > 0) archive.save();
    return moved;
}

/**
 * The models one agent can run, asked for rather than waited for.
 *
 * Which agent is named by the caller now that several can be switched on at
 * once, and defaults to the one answering. Cached per agent, so a panel opening
 * with four of them on asks each once and never again for the life of the app
 * unless something forces it. A conversation reports the same list when it
 * starts, which is free and keeps this honest if someone changes their agent's
 * own setup while the app is open.
 */
function models({ refresh = false, provider: wanted = '' } = {}) {
    const asked = PROVIDERS[wanted] ? wanted : resolved().provider;

    // A forced ask drops what is held for this agent and starts again. The
    // menu offers it when a read came back with nothing, which is usually a
    // runtime that was not up yet rather than an agent with no models.
    if (refresh) modelCatalogs.delete(asked);

    if (modelCatalogs.has(asked)) return Promise.resolve(modelCatalogs.get(asked));
    if (!refresh && modelsPending.has(asked)) return modelsPending.get(asked);

    const provider = PROVIDERS[asked];
    if (!provider?.listModels) return Promise.resolve(null);

    const promise = provider.listModels({ settings: resolvedFor(asked) })
        .then((rows) => {
            const list = rows?.length ? rows : null;
            // Stored against the agent that answered, whether or not that is
            // still the one selected. A later ask for a different agent reads
            // its own entry, and a switch back does not have to ask again.
            modelCatalogs.set(asked, list);
            notify('ai-models', { provider: asked, models: list });
            return list;
        })
        .catch((error) => {
            // Said out loud rather than swallowed: an empty model menu with no
            // reason anywhere is the kind of thing that gets blamed on the
            // menu. Not cached either, so the next ask tries again rather than
            // inheriting one bad start for the life of the app.
            console.error(`Could not read the model list from ${asked}:`, error.message);
            return null;
        })
        .finally(() => {
            if (modelsPending.get(asked) === promise) modelsPending.delete(asked);
        });

    modelsPending.set(asked, promise);
    return promise;
}

/**
 * Whether one agent could actually run here, asked before it is switched on.
 *
 * The rule the whole feature rests on: the assistant drives the agents already
 * installed and already signed in on this machine, so being on the machine is
 * what a tick is asking about. Each agent answers for itself, because what
 * counts as being here differs: five of them are a binary to find, and a local
 * model is a server that either answers at the address or does not.
 *
 * An agent with no `detect` of its own passes, which is the right default for
 * one that has nothing to look for.
 *
 * Never throws. A check that fails is an answer of "no" with a reason on it,
 * not an exception for a settings page to work out what to do with.
 */
async function detect(provider) {
    const agent = PROVIDERS[provider];
    if (!agent) return { provider, ok: false, reason: 'unknown' };
    if (!agent.detect) return { provider, ok: true, reason: '' };

    try {
        const verdict = await agent.detect({ settings: resolvedFor(provider) });
        return {
            provider,
            ok: Boolean(verdict?.ok),
            reason: verdict?.ok ? '' : (verdict?.reason || 'notFound'),
        };
    } catch (error) {
        console.error(`Could not check whether ${provider} is installed:`, error.message);
        return { provider, ok: false, reason: 'error' };
    }
}

function status() {
    const current = settings.get();
    return {
        ready: Boolean(PROVIDERS[current.provider]),
        provider: current.provider,
        providers: Object.keys(PROVIDERS),
        // Which of them can be sent a picture, so the composer offers the
        // attach button only where it would work.
        imageProviders: Object.keys(PROVIDERS).filter(name => PROVIDERS[name].supportsImages === true),
        settings: current,
        // Null until a conversation has run once. The settings page says so
        // rather than guessing, because "no plan found" and "not asked yet"
        // are different answers.
        account: lastAccount,
        // Only if it belongs to the agent currently selected. Null otherwise,
        // which reads as "not asked yet" and is exactly what it is.
        models: modelCatalogs.get(current.provider) ?? null,
        // Every list read so far, keyed by the agent that answered, for the
        // composer's menu: it offers the models of every agent that is
        // switched on, so one list is not the question it is asking. Agents
        // that have not been asked are absent rather than null, which is how
        // the panel knows which of them it still has to ask.
        catalogs: Object.fromEntries(modelCatalogs),
        tools: catalog.TOOLS.map(tool => ({
            name: tool.name,
            title: tool.title,
            readOnly: tool.readOnly,
        })),
    };
}

/**
 * Tear every conversation down, for a lock or a quit.
 *
 * Written out first, and then no further writes at all: `close` empties the map
 * the archive reads from, so a save landing any time after this point would
 * faithfully record that there is nothing left. Writing stays off until
 * `hydrate` fills the map again, which is deliberately not something this
 * function does on its way out: `will-quit` flushes a moment later, and by then
 * the only honest answer is the one already on disk.
 */
async function shutdown() {
    archive.flush();
    archive.suspend();

    const ids = [...conversations.keys()];
    await Promise.all(ids.map(id => close(id)));
    for (const entry of [...pendingApprovals.values()]) {
        entry.resolve({ approved: false, message: 'The app closed the conversation.' }, 'denied');
    }
    for (const [requestId, entry] of [...pendingActions]) {
        entry.resolve({ success: false, message: 'The app closed the conversation.' });
        pendingActions.delete(requestId);
    }

    // Nothing is held in memory any more, so the next window reads the file
    // again, and turns writing back on when it does. That is not only the next
    // launch: on macOS the window closes through here and the app stays running
    // to be reopened from the dock.
    hydrated = false;
}

module.exports = {
    setNotifier,
    setWindowProbe,
    setToaster,
    cancelRun,
    startJobRun,
    resumeJobRun,
    probeForJob,
    publicJob,
    exportMarkdown,
    readConversation,
    setConversationModel,
    secrets,
    resolveModel,
    reconfigure,
    create,
    get,
    conversationIds,
    importConversations,
    send,
    interrupt,
    park,
    close,
    setScope,
    history,
    turnChanges,
    revertTurn,
    branch,
    list,
    search,
    pin,
    reassign,
    status,
    models,
    detect,
    shutdown,
    // Exported for the approval tests: the policy-to-gate translation is
    // the whole safety story for background runs, and it must stay pinned.
    effectiveSettings,
    respondToApproval,
    respondToAction,
    respondToQuestion,
    settings,
    // For the checkpoint tests, which play a turn's events through without
    // a runtime behind them.
    _test: { emit: (conversationId, event) => emit(conversations.get(conversationId), event) },
};
