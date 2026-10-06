const settings = require('./settings');
const agents = require('../agents');
const accounts = require('./accounts');
const limits = require('./limits');
const memory = require('./memory');
const memoryTidy = require('./memory-tidy');
const prompt = require('./prompt');
const catalog = require('./tools');
const secrets = require('./secrets');
const diff = require('./diff');
const checkpoints = require('./checkpoints');
const turnRate = require('./turn-rate');
const sendTiming = require('./send-timing');
const embeddings = require('./embeddings');
const archive = require('./archive');
const searchModule = require('./search');
const titles = require('./titles');
const computer = require('./computer');
const overlay = require('./overlay');
const { readImages } = require('./images');
const { readFiles, fileBlock } = require('./attachments');
const { readMentions, mentionBlock, stripMentions } = require('./mentions');
const skills = require('./skills');
const store = require('../store');
const transcript = require('../transcript');
const activity = require('../activity');
const runs = require('../runs');
const jobs = require('../runs/jobs');
const scheduler = require('../runs/scheduler');
const failover = require('../failover');
const headless = require('./headless');
const local = require('./local');
const workspaceFiles = require('./workspace-files');
const modelMatch = require('./model-match');
const startModel = require('./start-model');
const ssh = require('../ssh');
const localTerminal = require('../local-terminal');
const liveMetrics = require('./live-metrics');

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
 *
 * Every conversation is kept, whole, for as long as the user wants it: none is
 * dropped for being old or long or for there being many. The one way one goes
 * other than being deleted is the history setting, which is off unless the
 * user chose a period (see `sweepHistory`).
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the history setting is applied again while the app stays open. */
const HISTORY_SWEEP_INTERVAL = 6 * 60 * 60 * 1000;

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
// Where a conversation stands with the person: 'front', 'behind' or ''. See
// `windows.sight`.
let sight = () => '';
// An OS notification, provided by ipc, for a run that finished or stopped
// on a question while nobody was looking at it.
let toast = () => {};

function setWindowProbe(fn, focused, sees) {
    hasWindow = typeof fn === 'function' ? fn : () => false;
    if (typeof focused === 'function') windowFocused = focused;
    if (typeof sees === 'function') sight = sees;
}

/** A conversation and the ones its questions are forwarded up to, nearest first. */
function lineOf(conversation) {
    const line = [];
    for (let at = conversation; at && line.length <= MAX_DELEGATION_DEPTH; at = conversations.get(at.parentId || '')) {
        line.push(at);
    }
    return line;
}

/**
 * Whether nobody is looking at a conversation, and so whether to say so
 * through the OS: no window focused, or its tab behind another. On screen
 * through the chat its questions are forwarded to counts as seen, and one
 * in no tab at all is left to the chat that started it, which is.
 */
function unseen(conversation) {
    if (!hasWindow()) return false;
    if (!windowFocused()) return true;
    const places = lineOf(conversation).map(entry => sight(entry.id));
    return !places.includes('front') && places.includes('behind');
}

/** The chat a notification about a conversation opens: its own tab, or the nearest showing its cards. */
function tabFor(conversation) {
    return (lineOf(conversation).find(entry => sight(entry.id)) || conversation).id;
}

function setToaster(fn) {
    toast = typeof fn === 'function' ? fn : () => {};
}

// Opening conversations as tabs, and whether one is in a tab anywhere.
// Provided by ipc, which knows which window holds what. See `windows.show`.
let openTabs = () => ({ success: false, message: 'No window is open.' });
let inTab = () => false;

function setTabOpener(open, showing) {
    openTabs = typeof open === 'function' ? open : () => ({ success: false, message: 'No window is open.' });
    inTab = typeof showing === 'function' ? showing : () => false;
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
 * When an agent was last asked and had nothing to report, by agent.
 *
 * A `null` in the catalogs above used to be kept for the life of the app,
 * so one read that landed while its runtime was still coming up \u2013 Pi
 * still indexing on a cold start, a binary mid-update \u2013 left its menu
 * section empty until the retry button was found and pressed. A miss is
 * now kept only here, and only briefly: a later ask past the window tries
 * again, while asks inside it answer at once instead of starting the
 * runtime over and over.
 */
const modelMisses = new Map();

/** How long a miss counts before the next ask tries the runtime again. */
const MODEL_MISS_TTL = 2 * 60 * 1000;

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
let historyTimer = null;

function hydrate() {
    if (hydrated) return;
    hydrated = true;

    // What the last process left running is closed out before anything can
    // start: an interactive run cannot continue without the person who was
    // driving it, and a tool step that never reported is marked unknown.
    // Scheduled runs will be picked up here instead once there are any.
    try {
        // A job's run is worth resuming as long as its job still exists; the
        // scheduler hands the re-queued ones back to `resumeJobRun`. With
        // failover on, a conversation's turn cut short by the app dying is
        // kept too, and sent on by `resumeInterrupted`.
        runs.recover({
            resumable: run => (run.kind !== 'interactive' && Boolean(run.jobId && jobs.get(run.jobId)))
                || failover.resumable(run),
        });
    } catch (error) {
        console.error('Could not recover the run log:', error.message);
    }

    // Writing is safe again from here: this is the moment the map holds the
    // conversations rather than nothing. A shutdown stopped it precisely
    // because an empty map is not an empty history, and this is the other end
    // of that. See `shutdown`.
    archive.resume();

    // Every one of them, as a stub: what the lists need now, the events when
    // somebody opens it. See archive.js.
    const providerOf = new Map();
    for (const meta of archive.load()) {
        // Resumable only under the runtime its own agent is set to now.
        const agentKey = meta.agentId || '';
        if (!providerOf.has(agentKey)) providerOf.set(agentKey, settings.get(agentKey || undefined).provider);
        const conversation = archive.stub(meta, providerOf.get(agentKey));
        if (!conversation || conversations.has(conversation.id)) continue;
        conversations.set(conversation.id, conversation);
        // A chat written before there were agents belongs to whoever is
        // selected: it has to be listed somewhere.
        if (!agents.get(conversation.agentId)) {
            conversation.agentId = agents.activeId();
            archive.save(conversation.id);
        }
        // Cut short by the app closing mid-turn: read in now, so the line
        // saying so is written once rather than added on every read.
        if (meta.busy) {
            void conversation.events;
            archive.save(conversation.id);
        }
    }

    // The user's own retention choice, if they made one, applied at launch
    // and every few hours after. Nothing goes otherwise.
    sweepHistory();
    if (!historyTimer) {
        historyTimer = setInterval(() => {
            try {
                sweepHistory();
            } catch (error) {
                console.error('Could not apply the history setting:', error.message);
            }
        }, HISTORY_SWEEP_INTERVAL);
        historyTimer.unref?.();
    }
}

/**
 * Where the archive reads from: the map, and whether a conversation is in use
 * (a query running or starting), which is what keeps its events in memory.
 */
archive.setSource({
    get: id => conversations.get(id),
    all: () => conversations.values(),
    canRelease: conversation => !conversation.session && !conversation.starting && !conversation.busy,
});

/**
 * Delete the conversations older than the history setting allows, when the
 * user has set one. 0, the default, is forever, and this does nothing at all.
 *
 * Old means not touched: a conversation from a year ago that was carried on
 * yesterday is yesterday's. Never one the user pinned, and never one in use.
 */
function sweepHistory() {
    const days = Number(settings.get().historyDays) || 0;
    if (days <= 0) return 0;
    const cutoff = Date.now() - days * DAY_MS;
    let deleted = 0;
    for (const conversation of [...conversations.values()]) {
        if (conversation.pinned || conversation.session || conversation.starting || conversation.busy) continue;
        if (!(Number(conversation.updatedAt) < cutoff)) continue;
        conversations.delete(conversation.id);
        checkpoints.forget(conversation.id);
        computer.forget(conversation.id);
        archive.remove(conversation.id);
        deleted += 1;
    }
    if (deleted > 0) {
        activity.record({
            category: 'security',
            action: 'assistant.history-retention',
            outcome: 'info',
            target: 'Assistant',
            detail: `Deleted ${deleted} conversation${deleted === 1 ? '' : 's'} not touched in ${days} days, as the history setting asks`,
        });
    }
    return deleted;
}

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
    // Whose conversation this is: the agent the panel named, else the one
    // selected, since that is who a new chat is to.
    const agentId = agents.get(target.agentId)?.id || agents.activeId();
    // Tracked by the archive from the start, so its events can be let go of
    // and read back like any other once it is written and put down.
    conversations.set(id, archive.track({
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
        // Drafted from the first thing the user says, then replaced by the
        // runtime's own few words for it: see `nameConversation`.
        title: '',
        // Where the title came from: 'draft' (the first message, tidied,
        // still to be named), 'naming' (the runtime has been asked),
        // 'model' or 'message' (settled). Empty for one set outright, by a
        // job or a delegation, which is never renamed.
        titleSource: '',
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
        // it is, and how deep the chain is. See delegateApiFor. `parentId`
        // is also where its questions are forwarded; `spawnedFrom` is only
        // who started it, for one the agent opened in the open. See
        // conversationsApiFor.
        parentId: '',
        spawnedFrom: '',
        depth: 0,
    }, []));
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
 *   allowlist   writes ask, except commands on the job's own list (a job's
 *               own list narrows the shipped one, so the workspace rule
 *               stays off there and the containment reads as written)
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
    // The pinned account goes with it: the menu can offer one runtime's
    // models under more than one sign-in.
    const agentSettings = patch.provider && PROVIDERS[patch.provider]
        ? resolvedFor(patch.provider, conversation.agentId, patch.account)
        : resolvedFor(settings.get(conversation.agentId).provider, conversation.agentId, patch.account);
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

/** The ids of the live conversations, for the backup preview to count against. */
function conversationIds() {
    hydrate();
    return [...conversations.keys()];
}

/**
 * Bring conversations from a backup into the live map, the same way `hydrate`
 * adopts the ones from disk: unpacked under the runtime their agent is set to
 * now, repaired onto the selected agent when theirs is gone, matched on id.
 * All of them: a restore adds to the history, it does not make room in it.
 */
function importConversations(records, { overwrite = false } = {}) {
    hydrate();
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
        conversations.set(conversation.id, archive.track(conversation, conversation.events));
        archive.save(conversation.id);
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
    hydrate();
    let touched = 0;
    for (const conversation of conversations.values()) {
        // Every conversation, including the ones whose events are only on
        // disk: those are rewritten where they are rather than read in.
        let changed = archive.rewriteEvents(conversation, events => events.map(event => secrets.scrubDeep(event)));
        // The title is the first message, cut short: a key pasted as the
        // opening line was the title of the conversation in every list.
        const title = secrets.scrub(conversation.title || '');
        if (title !== (conversation.title || '')) {
            conversation.title = title;
            changed = true;
        }
        if (changed) {
            touched += 1;
            archive.save(conversation.id);
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

    // The turn's answer rate, for the number beside its branch icon. The
    // stamp lands on the stored result so every window agrees. See
    // turn-rate.js for what it means and when there is nothing to say.
    const timing = conversation.rateTracker || (conversation.rateTracker = turnRate.createTracker());
    if (stamped.type === 'result') turnRate.stampTurnRate(conversation.events, stamped, timing);
    else turnRate.noteEvent(timing, stamped);

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

    // The corner card for an agent at work on the desktop. See overlay.js.
    if (overlay.watching(conversation.id)) overlay.event(conversation.id, stamped, conversation.title);

    if (conversation.parentId && FORWARDED.has(stamped.type) && !stamped.via) {
        const parent = conversations.get(conversation.parentId);
        if (parent) emit(parent, { ...event, via: conversation.id, viaTitle: conversation.title || '' });
    }
    // A reply streams in as hundreds of fragments. Each still goes to the
    // windows as it comes, but the log keeps one growing fragment rather
    // than hundreds: the panel folds them into the same draft either way,
    // and hundreds of them would go into every replay of the conversation.
    const last = conversation.events[conversation.events.length - 1];
    if (DELTAS.has(stamped.type) && last?.type === stamped.type && !stamped.via && !last.via) {
        conversation.events[conversation.events.length - 1] = { ...last, text: `${last.text || ''}${stamped.text || ''}` };
        conversation.updatedAt = stamped.at;
        notify('ai-event', { conversationId: conversation.id, event: stamped });
        return;
    }

    // How full the context is: only the latest reading is ever shown, so it
    // replaces the one before rather than adding one per step to the log.
    if (stamped.type === 'context' && !stamped.via) {
        const previous = conversation.events.findIndex(entry => entry.type === 'context' && !entry.via);
        if (previous >= 0) conversation.events.splice(previous, 1);
    }

    conversation.updatedAt = stamped.at;
    // All of it: nothing is dropped off the front of a long conversation.
    conversation.events.push(stamped);
    notify('ai-event', { conversationId: conversation.id, event: stamped });
    tellSubagents(conversation, stamped);

    // A stream preview is not worth a write of its own: the finished block that
    // replaces it is an event in its own right, and that one schedules one.
    if (!archive.isTransient(stamped.type)) archive.save(conversation.id);
}

/* ------------------------------------------------------------------ *
 * Subagents
 *
 * A runtime's own subagents (Claude Code's Agent tool) work inside the
 * conversation's turn, and their events are in its log, each marked with the
 * call that started its subagent. Each is also a conversation of its own to
 * read: a tab on `<conversation>/<call>` is that subagent's transcript, read
 * back from the parent's log and told of new events as they land.
 *
 * Nothing is stored for one beyond the parent's log. Ten subagents are not
 * ten conversations in the history, pushing real ones off the end of it, and
 * there is nothing to keep in step. It is read only: the subagent's session
 * lives inside the parent's, and the parent is where to talk to it.
 * ------------------------------------------------------------------ */

const SUBAGENT_MARK = '/';

function subagentConversationId(conversationId, callId) {
    return `${conversationId}${SUBAGENT_MARK}${callId}`;
}

/** `<conversation>/<call>` as its two halves, or null for an ordinary id. */
function parseSubagentId(id) {
    const text = String(id || '');
    const at = text.indexOf(SUBAGENT_MARK);
    return at > 0 ? { parentId: text.slice(0, at), callId: text.slice(at + 1) } : null;
}

/** How a subagent's end reads in its own transcript. */
function subagentEnd(status, at) {
    if (status === 'failed') return { type: 'error', message: 'The subagent stopped on an error.', at };
    if (status === 'stopped' || status === 'killed') return { type: 'interrupted', at };
    return { type: 'result', subtype: 'success', isError: false, costUsd: 0, at };
}

/** A parent's event as one of its subagents has it, with that subagent's call, or null. */
function subagentEvent(event) {
    if (event.parentId && !event.via) {
        const { parentId, ...own } = event;
        return { callId: parentId, event: own };
    }
    if (event.type === 'task-ended' && event.toolUseId) {
        return { callId: event.toolUseId, event: subagentEnd(event.status, event.at) };
    }
    return null;
}

/** Every subagent of the turn now running that has not said it is done. */
function openSubagents(conversation) {
    const ended = new Set();
    const open = [];
    for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
        const event = conversation.events[index];
        if (event.type === 'user-message') break;
        if (event.type === 'task-ended') ended.add(event.toolUseId);
        else if (event.type === 'task-started' && event.toolUseId && !ended.has(event.toolUseId)) open.push(event.toolUseId);
    }
    return open;
}

/** Pass a parent's event on to the tab of the subagent it belongs to, if any is open. */
function tellSubagents(conversation, stamped) {
    const own = subagentEvent(stamped);
    if (own) {
        notify('ai-event', { conversationId: subagentConversationId(conversation.id, own.callId), event: own.event });
        return;
    }
    // The parent's turn ended under them: stopped, or its process gone.
    // Whatever they were doing is over too.
    if (stamped.type === 'interrupted' || stamped.type === 'closed' || stamped.type === 'error') {
        for (const callId of openSubagents(conversation)) {
            notify('ai-event', {
                conversationId: subagentConversationId(conversation.id, callId),
                event: subagentEnd('stopped', stamped.at),
            });
        }
    }
}

/** A subagent's transcript, read back from its parent's log, in the shape `history` answers with. */
function subagentHistory(ref) {
    const parent = conversations.get(ref.parentId);
    const call = parent?.events.find(event => event.type === 'tool-call' && event.id === ref.callId && !event.parentId);
    if (!call) return { found: false, events: [] };

    const started = parent.events.find(event => event.type === 'task-started' && event.toolUseId === ref.callId);
    // The parent's brief, as the message the subagent was given.
    const events = [{ type: 'user-message', text: String(call.input?.prompt || started?.prompt || ''), at: call.at }];
    let ended = false;
    for (const event of parent.events) {
        const own = subagentEvent(event);
        if (!own || own.callId !== ref.callId) continue;
        events.push(own.event);
        if (own.event.type === 'result' || own.event.type === 'interrupted' || own.event.type === 'error') ended = true;
    }
    // The parent's turn is over and nothing said this one finished: an older
    // runtime that never reports it, or a turn cut off. Either way it is not
    // running, and the tab should not say it is.
    if (!ended && !parent.busy) events.push({ type: 'closed', at: parent.updatedAt });

    return {
        found: true,
        events,
        scope: parent.scope,
        sessionId: parent.boundSessionId,
        sessionIds: parent.sessionIds,
        hostIds: parent.hostIds,
        busy: !ended && parent.busy,
        costUsd: 0,
        title: String(call.input?.description || started?.description || 'Subagent'),
        agentId: parent.agentId,
        pinned: null,
        runPolicy: null,
        subagent: { parentId: parent.id, parentTitle: parent.title || '' },
    };
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
        archive.save(conversation.id);
    }
    return result;
}

/** How much of the earlier conversation a branch carries into its first message. */
const MAX_CARRY_OVER = 60000;

/**
 * What was said in a conversation before its latest message, for a runtime
 * taking it over with no memory of it. The latest message is left out
 * because it is about to be sent on its own.
 */
function saidBefore(conversation) {
    const events = (conversation.events || []).filter(event => !event.parentId);
    let end = events.length;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].type === 'user-message') {
            end = index;
            break;
        }
    }
    const lines = [];
    for (const event of events.slice(0, end)) {
        if (event.type === 'user-message') lines.push('## You', '', event.text || '', '');
        else if (event.type === 'assistant-text') lines.push('## Agent', '', event.text || '', '');
    }
    const said = lines.join('\n').trim();
    return said.length > MAX_CARRY_OVER ? said.slice(-MAX_CARRY_OVER) : said;
}

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

    return copyUpTo(source, end);
}

/**
 * Where a branch after turn `turn` ends, for the agent, which knows turns by
 * their number rather than by a timestamp: 1 is the first message and what
 * came of it, -1 the latest, and none at all is everything so far.
 */
function turnEnd(events, turn) {
    const starts = [];
    events.forEach((event, index) => {
        if (event.type === 'user-message') starts.push(index);
    });
    if (!turn) return { end: events.length, turns: starts.length };
    const number = turn > 0 ? turn : starts.length + turn + 1;
    if (number < 1 || number > starts.length) {
        return { error: `That conversation has ${starts.length} turn${starts.length === 1 ? '' : 's'}.` };
    }
    return { end: number < starts.length ? starts[number] : events.length, turns: number };
}

/** A new conversation holding `source` up to the event at `end`. */
function copyUpTo(source, end) {
    const created = create({
        agentId: source.agentId,
        scope: source.scope,
        sessionId: source.boundSessionId,
        sessionIds: source.sessionIds,
        hostIds: source.hostIds,
    });
    const copy = conversations.get(created.conversationId);
    const kept = source.events.slice(0, end).filter(event => !archive.isTransient(event.type));
    // Taken mid-turn, which is when the agent branches its own conversation,
    // the range holds calls still waiting on a result and questions only the
    // source can answer. In the copy they would spin, or ask, for ever.
    const answered = new Set(kept.filter(event => event.type === 'tool-result').map(event => event.id));
    const settled = new Set(kept
        .filter(event => event.type === 'approval-settled' || event.type === 'question-settled')
        .map(event => event.requestId));
    copy.events = kept
        .filter((event) => {
            if (event.type === 'tool-call') return answered.has(event.id);
            if (event.type === 'approval-request' || event.type === 'question-request') return settled.has(event.requestId);
            return true;
        })
        .map(event => (event.type === 'turn-changes' || event.type === 'turn-reverted'
            ? { ...event, from: event.from || source.id }
            : event));
    copy.title = source.title;
    copy.settingsPatch = source.settingsPatch ? { ...source.settingsPatch } : null;
    copy.updatedAt = Date.now();
    const said = exportMarkdown(copy.id, { messagesOnly: true }) || '';
    copy.carryOver = said.length > MAX_CARRY_OVER ? said.slice(-MAX_CARRY_OVER) : said;
    archive.save(copy.id);
    return { success: true, conversationId: copy.id, agentId: copy.agentId };
}

/** Point an existing conversation at a different session, set, or all of them. */
function setScope(conversationId, target) {
    hydrate();

    const conversation = conversations.get(conversationId);
    if (!conversation) return { success: false, message: 'That conversation is gone' };

    const scope = normalizeScope(target);
    Object.assign(conversation, scope);
    archive.save(conversation.id);
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
function resolvedFor(provider, agentId, accountOverride = '') {
    let base = settings.get(agentId);
    // A conversation the composer put on one particular sign-in runs on it,
    // while that account is still ticked for the agent. One unticked or
    // removed since falls back to the agent's own choice rather than to the
    // machine's login, which is the nearer answer.
    const pinned = pinnedAccountFor(base, provider, accountOverride);
    if (pinned) base = { ...base, accounts: { ...(base.accounts || {}), [provider]: pinned } };
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

/**
 * A conversation's own account, when it still counts: it exists, and it is
 * one of the accounts ticked for the agent (the one in use, or one beside it
 * in `menuAccounts`). Empty otherwise, which is the agent's choice.
 */
function pinnedAccountFor(current, provider, id) {
    if (!id || !accounts.supports(provider)) return '';
    if (accounts.resolve(provider, id)?.id !== id) return '';
    const ticked = id === accountIdFor(current, provider) || (current?.menuAccounts?.[provider] || []).includes(id);
    return ticked ? id : '';
}

/** The account a conversation runs on under these settings, its pin included. */
function conversationAccount(current, provider, pinned) {
    return pinnedAccountFor(current, provider, pinned) || accountIdFor(current, provider);
}

/** The settings as the agent behind a conversation sees them. */
function resolved(agentId) {
    return resolvedFor(settings.get(agentId).provider, agentId);
}

/**
 * Settings the SDK bakes into a running query and cannot be told about later.
 * Changing one of these means the query has to be started again.
 */
// computerUse among them: Claude Code loads the computer tools up front only
// while it is on (see providers/claude-code.js). browserUse too: it decides
// whether the browser's MCP server is in the set the query was started with.
// memory as well: the notes and the memory section are in the system prompt,
// which is only written when a query starts.
const RESTART_ON = ['provider', 'maxTurns', 'allowLocalTools', 'computerUse', 'browserUse', 'memory', 'toolBundles', 'bareProvider'];

/** Bundle toggles compared by value: a fresh object per sanitize. */
function bundlesChanged(before, after) {
    const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const id of ids) {
        if ((before?.[id] !== false) !== (after?.[id] !== false)) return true;
    }
    return false;
}

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
    // A history period chosen, or shortened, applies now rather than at the
    // next launch: it is what the user just asked for.
    if (before?.historyDays !== after?.historyDays) {
        hydrate();
        sweepHistory();
    }

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
    if (before.localBaseUrl !== after.localBaseUrl) { modelCatalogs.delete('local'); modelMisses.delete('local'); }
    if (before.apiBaseUrl !== after.apiBaseUrl || before.apiKeys?.openai !== after.apiKeys?.openai) { modelCatalogs.delete('openai'); modelMisses.delete('openai'); }

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
        // A conversation pinned to an account of its own is not moved by the
        // agent's account moving, any more than its model is, unless its own
        // was the one unticked.
        const provider = conversation.provider || after.provider;
        const accountChanged = conversationAccount(before, provider, own.account)
            !== conversationAccount(after, provider, own.account);
        const toolBundlesChanged = bundlesChanged(before.toolBundles, after.toolBundles);
        if (RESTART_ON.some(field => field === 'toolBundles' ? toolBundlesChanged : before[field] !== after[field]) || accountChanged) {
            if (session || conversation.starting) conversation.needsRestart = true;
        }
        // What the model is offered changed (bare mode or bundles): resuming
        // the CLI-side session would silently keep the old prompt and tools,
        // so the next query starts a fresh provider session instead. The
        // transcript carries on via movedOver, as with an account move.
        const offeringChanged = before.bareProvider !== after.bareProvider || toolBundlesChanged;
        if (offeringChanged && conversation.providerSessionId) {
            conversation.movedOver = saidBefore(conversation);
            conversation.providerSessionId = '';
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

        // A job's parked run always says so; a chat's, when nobody is
        // looking at it, since the turn stands still until they answer.
        if (parked || unseen(conversation)) {
            try {
                const summary = name === 'run_command' ? String(input?.command || '') : summarise(catalog.redactInput(input));
                if (parked) {
                    runs.park(conversation.runId, `Waiting for approval: ${name} ${summary}`.slice(0, 400));
                    emit(conversation, { type: 'run-parked', runId: conversation.runId, name });
                }
                toast({
                    title: `${conversation.title || 'A run'} is waiting for you`,
                    body: secrets.scrub(`The agent wants to ${name.replace(/_/g, ' ')}${summary ? `: ${summary.slice(0, 120)}` : ''}`),
                    conversationId: tabFor(conversation),
                    runId: conversation.runId,
                });
            } catch (error) {
                console.error(parked ? 'Could not park a run:' : 'Could not announce an approval:', error.message);
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

        // A question nobody sees holds the turn until it times out.
        if (unseen(conversation)) {
            toast({
                title: `${conversation.title || 'The agent'} has a question`,
                body: secrets.scrub(String(question || '').replace(/\s+/g, ' ')).slice(0, 200),
                conversationId: tabFor(conversation),
            });
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

    const context = () => {
        // The core of the notebook (its rules and the topics of the rest) as
        // it stands when the query starts; a rule written mid-conversation
        // reaches the model by meaning until the next one. What it carries is
        // kept, so the notes sent with each message leave those out. Nothing
        // while the agent's memory is switched off.
        const core = current.memory === false ? null : memory.core(conversation.agentId);
        conversation.memoryPinned = core ? core.ids : [];
        return {
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
            memory: core?.text || '',
            memoryOff: current.memory === false,
        };
    };

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
    //
    // Moving accounts is what the model menu offers when one runtime is
    // listed under several sign-ins, usually because one is near its limit,
    // so what was said goes with the next message instead: the conversation
    // carries on rather than starting over with a model that remembers none
    // of it. Held only until that message, so it is not archived.
    if (conversation.provider === current.provider
        && (conversation.accountId || accounts.DEFAULT_ID) !== current.accountId) {
        if (conversation.providerSessionId) conversation.movedOver = saidBefore(conversation);
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
        // Bare provider CLI: no Acestes prompt at all. Providers also skip the app tools (see bareProvider in settings).
        systemPrompt: current.bareProvider ? '' : prompt.build(context()),
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
            // Conversations started, branched and opened in the open. See
            // conversationsApiFor.
            conversations: conversationsApiFor(conversation),
            // This computer's apps, with the real mouse and keyboard. See
            // computerApiFor.
            computer: computerApiFor(conversation),
            // Live charts in this conversation. See metricsApiFor.
            metrics: metricsApiFor(conversation),
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
    // Started early for a draft nobody has sent yet (see `warm`). What the
    // runtime says on the way up is kept above as state, and none of it
    // reaches the transcript before a message does: an event would make an
    // empty conversation one with content, listed and saved, for a draft the
    // person may well delete.
    if (conversation.warmOnly) {
        // Gone before the message: the send starts it again rather than
        // writing into a query that is no longer there.
        if (event.type === 'closed' || event.type === 'error') conversation.session = null;
        return;
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
    // A turn the runtime started by itself, to pass on what a subagent
    // brought back after the turn that sent it had ended. It is work like
    // any other, so it is shown as work and logged as a run.
    if (event.type === 'turn-resumed') {
        conversation.busy = true;
        if (!conversation.runId) {
            beginRun(conversation, {
                kind: conversation.runKind || 'interactive',
                trigger: { source: 'subagent' },
                policy: conversation.runPolicy,
                title: conversation.title,
            });
        }
    }
    if (event.type === 'tool-call' && !event.local) {
        recordToolActivity(conversation, event);
    }
    // Whose window it is, so a panel shows it only while that runtime is the
    // one answering: a reading from before a switch is about another model.
    if (event.type === 'context') {
        emit(conversation, { ...event, provider: conversation.provider || '' });
        return;
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
        conversation.quietRunId = conversation.remembering ? runId : '';
        emit(conversation, { type: 'run-started', runId, kind });
        runHooks(conversation, 'run-start', { kind, title: conversation.title || '' }).catch(() => {});
        return runId;
    } catch (error) {
        console.error('Could not start a run:', error.message);
        return '';
    }
}

// conversationId -> Set of resolve, for a parent waiting on a child's run.
const runWaiters = new Map();

/**
 * The follow-up that asks the agent to keep what it learned, when the
 * setting is on and the turn did real work. Off by default; see settings.
 */
const REMEMBER_PROMPT = 'Before we move on: if this turn taught you anything worth keeping for next time, '
    + 'save it with remember, one subject per note: a rule for how the user wants things done in every task, '
    + 'a fact about a machine or a project, or what a fix turned out to be. Keep the lasting lesson, not the '
    + 'steps, and if a note you were shown is now out of date, rewrite it with replaces instead of adding '
    + 'another. If there is nothing worth keeping, reply with exactly: nothing to keep.';

/**
 * What the user said before the message being sent (which is already in the
 * log), for the memory search: "ok, commit it" is about what came before.
 */
function previousMessage(conversation) {
    let seen = 0;
    for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
        const event = conversation.events[index];
        if (event.type !== 'user-message' || !event.text) continue;
        seen += 1;
        if (seen === 2) return String(event.text).slice(0, 1000);
    }
    return '';
}

/** The agent's last reply in a conversation, for a run's result. */
function lastReply(conversation) {
    for (let index = conversation.events.length - 1; index >= 0; index -= 1) {
        const event = conversation.events[index];
        if (event.type === 'user-message') break;
        // A subagent's words are its report to the agent, not the reply.
        if (event.type === 'assistant-text' && event.text && !event.parentId) return String(event.text).slice(0, 4000);
    }
    return '';
}

/** Close the run a conversation is on, whichever way the turn ended. */
function endRun(conversation, status, detail = {}) {
    // The mouse is held for a turn, never longer: the badge goes and the
    // person has their desk back, whichever way the turn ended.
    computer.release(conversation.id);
    const runId = conversation.runId;
    if (!runId) return;
    conversation.runId = '';
    // The note-taking turn after a real one is not news of its own.
    const quiet = runId === conversation.quietRunId;
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

    // A finished turn is when the notebook may have grown; whether it is
    // worth tidying, and when, is scheduleMemoryTidy's to say.
    if (status === 'done') scheduleMemoryTidy(conversation.agentId);

    // A parent waiting on this run is told, whichever way it went.
    const waiting = runWaiters.get(conversation.id);
    if (waiting) {
        runWaiters.delete(conversation.id);
        const outcome = { status, runId, summary: lastReply(conversation), reason: detail.reason || '' };
        for (const settle of waiting) settle(outcome);
    } else {
        reportToParent(conversation, status);
    }

    if (unattended) {
        // The job's conversation is put down once its turn is over: the
        // process behind it is the expensive half, and the transcript stays
        // for the Runs page and the history menu. Delivery is the
        // scheduler's, through the run-ended hook.
        setTimeout(() => { park(conversation.id).catch(() => {}); }, 0);
        return;
    }

    // Finished while the person was elsewhere.
    if (status === 'done' && !quiet && unseen(conversation)) {
        toast({
            title: `${conversation.title || 'The agent'} is done`,
            body: lastReply(conversation).replace(/\s+/g, ' ').slice(0, 200),
            conversationId: tabFor(conversation),
            runId,
            // Played with the sound picked in Settings rather than the chime.
            kind: 'done',
        });
    }

    // The built-in run-end hook: one more turn to write down what was
    // learned, only after a turn that did real work, and never after itself.
    const remembers = resolved(conversation.agentId);
    if (status === 'done' && !conversation.remembering && remembers.memory !== false && remembers.autoRemember) {
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
 * Tidying the memory
 * ------------------------------------------------------------------ */

/**
 * How long an agent has to be quiet before its notebook is tidied: long
 * enough that a tidy does not land between two turns of the same task, and
 * so does not change a note the agent is about to be shown.
 */
const TIDY_QUIET = 3 * 60 * 1000;
const tidyTimers = new Map();
const tidying = new Set();

/** Whether a conversation of this agent is mid-turn, so a tidy waits for it. */
function agentBusy(agentId) {
    for (const conversation of conversations.values()) {
        if (conversation.agentId === agentId && conversation.busy) return true;
    }
    return false;
}

/**
 * Tidy this agent's notes once it has been quiet a while, if they are due
 * (see `tidyState` in memory.js: about once a day, and only once enough has
 * changed). Off with the agent's memory, or with `memoryTidy`.
 */
function scheduleMemoryTidy(agentId) {
    if (!agentId) return;
    let current;
    try {
        current = resolved(agentId);
    } catch {
        return;
    }
    if (current.memory === false || current.memoryTidy === false) return;
    if (!memory.tidyState(agentId).due) return;
    clearTimeout(tidyTimers.get(agentId));
    const timer = setTimeout(() => {
        tidyTimers.delete(agentId);
        if (agentBusy(agentId)) {
            scheduleMemoryTidy(agentId);
            return;
        }
        tidyMemory(agentId).catch(() => {});
    }, TIDY_QUIET);
    timer.unref?.();
    tidyTimers.set(agentId, timer);
}

/**
 * Tidy one agent's notes now: the runtime it runs on is asked what to merge,
 * rewrite, refile and put away (see memory-tidy.js), and memory.js applies
 * what it is allowed to. Asked from the Memory page, every note is shown;
 * on a schedule, a big notebook is tidied where it changed.
 */
async function tidyMemory(agentId, { manual = false } = {}) {
    const id = String(agentId || agents.activeId());
    if (tidying.has(id)) return { success: false, message: 'These notes are being tidied already.' };
    const current = resolved(id);
    if (current.memory === false) return { success: false, message: 'This agent\'s memory is switched off.' };
    const provider = PROVIDERS[current.provider];
    if (typeof provider?.title !== 'function') {
        return { success: false, message: 'This agent\'s runtime cannot be asked to tidy its notes.' };
    }
    const batches = memory.tidyBatches(id, { full: manual });
    if (batches.reduce((sum, batch) => sum + batch.length, 0) < 2) return { success: true, applied: false, counts: {}, changes: 0 };

    const core = memory.core(id);
    tidying.add(id);
    notify('memory-tidy', { agentId: id, running: true });
    try {
        // One question a batch, one after the other, and what they decided
        // applied together, so the tidy is one change to review and undo. A
        // batch that fails costs only its own notes.
        const ops = [];
        let failure = '';
        let answered = 0;
        for (const notes of batches) {
            const plan = await memoryTidy.ask(provider, {
                settings: current,
                notes,
                ruleChars: core.ruleChars,
                ruleBudget: core.ruleBudget,
            });
            if (plan.ok) {
                answered += 1;
                ops.push(...plan.ops);
            } else {
                failure = plan.error;
            }
        }
        if (answered === 0) {
            memory.tidyFailed(id, failure);
            return { success: false, message: failure };
        }
        const result = memory.applyTidy(id, ops, { by: current.provider });
        if (!result.applied) return { success: false, message: result.message };
        return { success: true, ...result };
    } catch (error) {
        memory.tidyFailed(id, error.message);
        return { success: false, message: error.message };
    } finally {
        tidying.delete(id);
        notify('memory-tidy', { agentId: id, running: false });
    }
}

/** Whether a tidy of this agent's notes is under way, for the page's button. */
function memoryTidyRunning(agentId) {
    return tidying.has(String(agentId || agents.activeId()));
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

/**
 * Wait for a conversation's run to end, whichever way.
 *
 * Registered before the message goes, so a turn that ends at once is not
 * missed. `cancel` is for a message that never went. Out of time, a hidden
 * run is stopped (`stop`), since nobody else is watching it; one in a tab is
 * only no longer waited for.
 */
function waitForRun(conversation, { reason = 'The run took too long.', stop = true } = {}) {
    let settle = null;
    let timer = null;
    const forget = () => {
        const waiting = runWaiters.get(conversation.id);
        if (!waiting) return;
        waiting.delete(settle);
        if (waiting.size === 0) runWaiters.delete(conversation.id);
    };
    const ended = new Promise((resolve) => {
        settle = (outcome) => {
            clearTimeout(timer);
            resolve(outcome);
        };
        timer = setTimeout(() => {
            forget();
            if (stop) interrupt(conversation.id).catch(() => {});
            resolve({ status: 'failed', reason, summary: lastReply(conversation) });
        }, DELEGATION_TIMEOUT);
        if (!runWaiters.has(conversation.id)) runWaiters.set(conversation.id, new Set());
        runWaiters.get(conversation.id).add(settle);
    });
    const cancel = () => {
        forget();
        clearTimeout(timer);
    };
    return { ended, cancel };
}

/**
 * A conversation this one started, finishing a turn nobody was waiting on.
 * The parent gets a line in its chat saying so, with the start of what the
 * child said, and the whole of it for its next turn. So the parent is free
 * to report its own part and stop, rather than sit waiting for the other to
 * finish, and nothing the child found is lost.
 */
function reportToParent(child, status) {
    if (!child.spawnedFrom) return;
    const parent = conversations.get(child.spawnedFrom);
    if (!parent) return;
    const said = lastReply(child);
    const title = child.title || 'The conversation you started';
    const how = status === 'done' ? 'finished' : status === 'cancelled' ? 'was stopped' : 'stopped on an error';
    const opening = said.replace(/\s+/g, ' ').slice(0, 280);
    emit(parent, {
        type: 'notice',
        tone: status === 'done' ? 'info' : 'warn',
        text: `"${title}" ${how}.${opening ? ` ${opening}${said.length > 280 ? '…' : ''}` : ''}`,
    });
    parent.pendingNote = [
        parent.pendingNote,
        `The conversation you started, "${title}" (${child.id}), ${how}. What it said last:\n${said.slice(0, 4000)}`,
    ].filter(Boolean).join('\n\n');
    archive.save(parent.id);
}

/** The child's cost is the parent's cost. */
function tallyChild(parent, outcome) {
    try {
        const childRun = runs.get(outcome.runId);
        if (parent.runId && childRun) runs.tally(parent.runId, { costUsd: childRun.costUsd });
    } catch { /* counted nowhere, which is the lesser harm */ }
}

/** Most tabs one fan-out opens: past that it is a wall of tabs, not a view. */
const MAX_OPENED_FAN_OUT = 12;

async function runChild(parent, { agentId, brief, hostIds = [], title = '', open = false }) {
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

    // In a tab while it works, when asked: the brief lands where the user
    // can watch it. Its questions still come to the parent as well, since
    // the parent is where the user is waiting.
    const shown = open ? showConversations(parent, [child.id]) : null;

    const waiting = waitForRun(child, { reason: 'The delegated run took too long.' });
    const sent = await send(child.id, brief);
    if (!sent.success) {
        waiting.cancel();
        return { conversationId: child.id, status: 'failed', reason: sent.message || 'The brief could not be sent.', summary: '' };
    }
    const outcome = await waiting.ended;
    tallyChild(parent, outcome);
    setTimeout(() => { park(child.id).catch(() => {}); }, 0);
    return { conversationId: child.id, agentId, ...outcome, ...(shown ? { opened: shown.opened } : {}) };
}

function delegateApiFor(conversation) {
    const tooDeep = () => (conversation.depth || 0) >= MAX_DELEGATION_DEPTH;
    return {
        /** Hand a brief to an agent (by name) or to this one, and wait. */
        run: async ({ agent = '', brief, title = '', open = false }) => {
            if (tooDeep()) return { error: `Delegation stops ${MAX_DELEGATION_DEPTH} levels deep. Do this part yourself.` };
            const target = agent ? findAgent(agent) : agents.get(conversation.agentId);
            if (!target) return { error: `There is no agent called "${agent}".` };
            return runChild(conversation, { agentId: target.id, brief, title, open });
        },
        /** The same brief once per host, each child pinned to its host. */
        fanOut: async ({ hostIds, brief, title = '', open = false }) => {
            if (tooDeep()) return { error: `Delegation stops ${MAX_DELEGATION_DEPTH} levels deep. Do this part yourself.` };
            const hosts = store.getHosts();
            const wanted = hostIds.map(id => hosts.find(host => host.id === id)).filter(Boolean);
            if (wanted.length === 0) return { error: 'None of those host ids are saved.' };
            const results = [];
            let index = 0;
            const worker = async () => {
                while (index < wanted.length) {
                    const position = index;
                    const host = wanted[position];
                    index += 1;
                    const outcome = await runChild(conversation, {
                        agentId: conversation.agentId,
                        brief: `On the host "${host.name}" (id ${host.id}), and only there:\n\n${brief}`,
                        hostIds: [host.id],
                        title: title ? `${title} · ${host.name}` : `${conversation.title || 'Fan-out'} · ${host.name}`,
                        open: open && position < MAX_OPENED_FAN_OUT,
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
 * Conversations beside this one
 *
 * What delegate does out of sight, done in the open: a conversation the
 * agent starts or branches is a chat like one the user starts, in a tab of
 * its own when there is a window, and it carries on after this turn unless
 * the agent waits for it. The rules are a hand-off's: never a looser policy
 * than the conversation that made it, two deep at most, and a handful
 * working at once, since each is a runtime of its own.
 * ------------------------------------------------------------------ */

const MAX_WORKING_CHILDREN = 6;

/** How long check_conversations waits for a conversation before saying how far it has got. */
let CHECK_WAIT = 60 * 1000;

/** Conversations this one started, branched or delegated to. */
function childrenOf(conversation) {
    return [...conversations.values()].filter(entry => (
        entry.spawnedFrom === conversation.id || entry.parentId === conversation.id
    ));
}

/** Open conversations as tabs, beside the one that asked. */
function showConversations(asker, conversationIds, { focus = false } = {}) {
    if (!hasWindow()) return { opened: false, reason: 'No window is open; it is on the Conversations page.' };
    const result = openTabs(conversationIds, { near: asker.id, focus });
    return result?.success
        ? { opened: true }
        : { opened: false, reason: result?.message || 'The window did not open it.' };
}

/**
 * This computer's apps, for one conversation. The rules are computer.js's;
 * what it needs from here is what only the conversation knows, read fresh on
 * every call: its title, what kind of run it is, the agent's settings and
 * name, a question card to ask the user on, and its secrets to type from.
 */
function computerApiFor(conversation) {
    return computer.apiFor({
        id: conversation.id,
        title: () => conversation.title,
        runKind: () => conversation.runKind,
        settings: () => effectiveSettings(conversation),
        agentName: () => agents.get(conversation.agentId)?.name || '',
        ask: payload => requestQuestion(conversation, payload),
        resolveSecrets: text => secrets.forAgent(conversation.agentId).resolve(text),
        // Whether the runtime answering can be shown a screenshot.
        canSee: () => PROVIDERS[effectiveSettings(conversation).provider]?.supportsImages === true,
        // The conversations that started this one, nearest first: an agent
        // started to work beside its parent may control what the parent was
        // allowed to, without the user being asked again.
        lineage: () => {
            const chain = [];
            let current = conversation;
            while (chain.length < 3) {
                const up = current.spawnedFrom || current.parentId;
                if (!up || chain.includes(up)) break;
                chain.push(up);
                current = conversations.get(up);
                if (!current) break;
            }
            return chain;
        },
    });
}

/**
 * Live charts, for one conversation. See live-metrics.js.
 *
 * A watch's start and end are events in the conversation's log, so the chart
 * is in the transcript where the call made it and is still there when the
 * conversation is read back. The samples in between are not: they go to the
 * windows on `ai-metric`, a few times a second, and a window that opens the
 * conversation mid-watch asks for the points so far (`metricSnapshot`). The
 * end event carries the last window of points, which is what a conversation
 * read back later draws.
 *
 * Looked up by id rather than held, so a watch outliving its conversation
 * (deleted mid-watch) writes nowhere.
 */
function metricsApiFor(conversation) {
    const id = conversation.id;
    const owned = watchId => liveMetrics.ownerOf(watchId) === id;
    const hooks = {
        onStart: (watch) => {
            const owner = conversations.get(id);
            if (!owner) return;
            emit(owner, {
                type: 'metric-started',
                watchId: watch.id,
                spec: {
                    title: watch.title,
                    unit: watch.unit,
                    series: watch.names,
                    where: watch.where,
                    command: watch.command,
                    mode: watch.mode,
                    every: watch.every || 0,
                    window: watch.window,
                    startedAt: watch.startedAt,
                    endsAt: watch.endsAt,
                    ...watch.chart,
                },
            });
        },
        onSamples: (watch, batch) => notify('ai-metric', { conversationId: id, watchId: watch.id, ...batch }),
        onEnd: (watch, final) => {
            notify('ai-metric', {
                conversationId: id,
                watchId: watch.id,
                points: [],
                stats: final.stats,
                ended: { status: final.status, reason: final.reason },
            });
            const owner = conversations.get(id);
            if (!owner) return;
            emit(owner, {
                type: 'metric-ended',
                watchId: watch.id,
                status: final.status,
                reason: final.reason,
                points: final.points,
                stats: final.stats,
            });
        },
    };
    return {
        canExec: sessionId => liveMetrics.canExec(sessionId),
        start: (spec, target) => liveMetrics.start({ ...spec, conversationId: id }, target, hooks),
        stop: watchId => owned(watchId) && liveMetrics.stop(watchId, 'Stopped by the agent.'),
        stopAll: () => liveMetrics.stopAll({ conversationId: id, reason: 'Stopped by the agent.' }),
        read: (watchId, options) => (owned(watchId) ? liveMetrics.read(watchId, options) : null),
        list: () => liveMetrics.list(id),
    };
}

/** The points so far of one watch, for a window opening its chart mid-watch. */
function metricSnapshot(watchId) {
    return liveMetrics.snapshot(String(watchId || ''));
}

/** The chart's stop button. */
function stopMetric(watchId) {
    return { stopped: liveMetrics.stop(String(watchId || ''), 'Stopped by the user.') };
}

// The desktop is held by one conversation while it works, and Esc stops that
// conversation's turn.
computer.configure({
    isBusy: conversationId => Boolean(conversations.get(conversationId)?.busy),
    interrupt: conversationId => interrupt(conversationId),
    // Who is at work on the desktop, for the card in the corner of the screen.
    driversChanged: ids => overlay.drivers(ids.map((id) => {
        const conversation = conversations.get(id);
        const agent = conversation ? agents.get(conversation.agentId) : null;
        return { id, title: conversation?.title || '', agent: agent?.name || '', look: agent?.look || null };
    })),
    aimed: (conversationId, label) => overlay.aimed(conversationId, label),
});

function conversationsApiFor(conversation) {
    const isChild = (entry) => Boolean(entry)
        && (entry.spawnedFrom === conversation.id || entry.parentId === conversation.id);

    const refusal = () => {
        if ((conversation.depth || 0) >= MAX_DELEGATION_DEPTH) {
            return `Conversations stop ${MAX_DELEGATION_DEPTH} levels deep. Do this part yourself.`;
        }
        if (childrenOf(conversation).filter(entry => entry.busy).length >= MAX_WORKING_CHILDREN) {
            return `${MAX_WORKING_CHILDREN} of the conversations you started are still working. Wait for one to finish.`;
        }
        return '';
    };

    /** What a new conversation takes from this one, before anything is sent. */
    const adopt = (child, title = '') => {
        child.spawnedFrom = conversation.id;
        child.depth = (conversation.depth || 0) + 1;
        // A chat like the user's when this is one; out of sight like a
        // delegated run when this is a job's, which also keeps a job from
        // reaching the job tools through a conversation it started.
        child.runKind = conversation.runKind === 'interactive' ? 'interactive' : 'delegated';
        // Never looser than this one.
        child.runPolicy = conversation.runPolicy || null;
        // Told as an event, like a name the runtime gives it, so the tab
        // and a panel rebuilt from the log say it too.
        if (title) {
            child.title = secrets.scrub(title);
            child.titleSource = '';
            emit(child, { type: 'title', title: child.title });
        }
    };

    /**
     * A message into a child, waited on when asked. While the agent waits,
     * the child's questions come here as well, where the user is; one in no
     * tab at all sends them here for good, or nobody would see them.
     */
    const drive = async (child, message, { wait = false, visible = false } = {}) => {
        if (wait || !visible) child.parentId = conversation.id;
        child.runTrigger = { source: 'agent', parentRunId: conversation.runId || '', parentConversationId: conversation.id };
        const waiting = wait ? waitForRun(child, { stop: !visible }) : null;
        const sent = await send(child.id, message);
        // What the user sends in the tab later is theirs.
        if (child.runKind === 'interactive') child.runTrigger = null;
        if (!sent.success) {
            waiting?.cancel();
            return { error: sent.message || 'The message could not be sent.' };
        }
        if (!waiting) return { status: 'working' };
        const outcome = await waiting.ended;
        tallyChild(conversation, outcome);
        if (visible) child.parentId = '';
        return { status: outcome.status, report: outcome.summary || '', ...(outcome.reason ? { reason: outcome.reason } : {}) };
    };

    /** Open it, send the first message if there is one, and report. */
    const launch = async (child, { message = '', open = true, focus = false, wait = false }) => {
        const shown = open ? showConversations(conversation, [child.id], { focus }) : { opened: false };
        archive.save(child.id);
        const driven = message ? await drive(child, message, { wait, visible: shown.opened }) : { status: 'idle' };
        if (driven.error) return { error: `${driven.error} (conversation ${child.id})` };
        return {
            conversationId: child.id,
            title: child.title || '',
            opened: shown.opened,
            ...(open && shown.reason ? { note: shown.reason } : {}),
            ...driven,
        };
    };

    return {
        /** A new conversation, this agent's or another's, with a first message. */
        start: async ({ agent = '', message = '', title = '', open = true, focus = false, wait = false }) => {
            const refused = refusal();
            if (refused) return { error: refused };
            const target = agent ? findAgent(agent) : agents.get(conversation.agentId);
            if (!target) return { error: `There is no agent called "${agent}".` };
            // Pointed where this one is: "another chat" is about the same machines.
            const created = create({
                agentId: target.id,
                scope: conversation.scope,
                sessionId: conversation.boundSessionId,
                sessionIds: conversation.sessionIds,
                hostIds: conversation.hostIds,
            });
            const child = conversations.get(created.conversationId);
            adopt(child, title);
            // On this chat's model when it is the same agent's; otherwise on
            // the model new conversations start on, like a tab opened by hand.
            if (target.id === conversation.agentId && conversation.settingsPatch) {
                child.settingsPatch = { ...conversation.settingsPatch };
            } else {
                startOnPick(child.id);
            }
            return launch(child, { message, open, focus, wait });
        },

        /** One of this agent's conversations, copied up to a turn, carrying on from there. */
        branch: async ({ conversationId = '', turn = 0, message = '', title = '', open = true, focus = false, wait = false }) => {
            const refused = refusal();
            if (refused) return { error: refused };
            hydrate();
            const source = conversations.get(conversationId || conversation.id);
            if (!source || source.agentId !== conversation.agentId) {
                return { error: `There is no conversation ${conversationId} of this agent's. search_conversations lists what there is.` };
            }
            const cut = turnEnd(source.events, turn);
            if (cut.error) return { error: cut.error };
            const copied = copyUpTo(source, cut.end);
            if (!copied.success) return { error: copied.message };
            const child = conversations.get(copied.conversationId);
            adopt(child, title);
            const launched = await launch(child, { message, open, focus, wait });
            return launched.error ? launched : { ...launched, from: source.id, turns: cut.turns };
        },

        /** Conversations shown in tabs: this agent's, or ones this one started. */
        open: ({ conversationIds = [], focus = false }) => {
            hydrate();
            const found = [];
            const missing = [];
            for (const id of conversationIds) {
                const entry = conversations.get(id);
                if (entry && (entry.agentId === conversation.agentId || isChild(entry))) found.push(id);
                else missing.push(id);
            }
            if (found.length === 0) return { error: 'None of those are conversations of this agent\'s or ones you started.' };
            return {
                ...showConversations(conversation, found, { focus }),
                conversationIds: found,
                ...(missing.length ? { notFound: missing } : {}),
            };
        },

        /** A follow-up to a conversation this one started. */
        message: async ({ conversationId, message, wait = false }) => {
            const child = conversations.get(conversationId);
            if (!isChild(child)) {
                return { error: 'Only a conversation you started, branched or delegated to from here can be sent a message.' };
            }
            if (child.busy) {
                return { error: 'It is still working on the last message. Wait for it with check_conversations first.' };
            }
            const driven = await drive(child, message, { wait, visible: inTab(child.id) });
            return driven.error ? driven : { conversationId: child.id, ...driven };
        },

        /**
         * What this conversation started and how each is doing, waiting first
         * for the one named in `waitFor` if it is still working.
         */
        check: async ({ waitFor = '' } = {}) => {
            const awaited = waitFor ? conversations.get(waitFor) : null;
            if (waitFor && !isChild(awaited)) return { error: `${waitFor} is not a conversation you started.` };
            let stillGoing = false;
            if (awaited?.busy) {
                // A minute at most. Waiting out a long job in silence left the
                // user looking at an agent that had finished its own part and
                // said nothing for minutes; better to come back with how far
                // the other one has got, and say so.
                const visible = inTab(awaited.id);
                const waiting = waitForRun(awaited, { stop: !visible });
                const outcome = await Promise.race([
                    waiting.ended,
                    new Promise(resolve => setTimeout(() => resolve(null), CHECK_WAIT)),
                ]);
                if (outcome) {
                    tallyChild(conversation, outcome);
                } else {
                    waiting.cancel();
                    stillGoing = true;
                }
            }
            return {
                ...(stillGoing ? {
                    stillWorking: `"${awaited.title || awaited.id}" is still at it; its latest word is below. Tell the user what `
                        + 'you have and where it stands rather than waiting on in silence: its report comes to this '
                        + 'conversation by itself when it finishes.',
                } : {}),
                conversations: childrenOf(conversation).map(entry => ({
                    conversationId: entry.id,
                    title: entry.title || '',
                    agent: agents.get(entry.agentId)?.name || entry.agentId,
                    kind: entry.spawnedFrom === conversation.id ? 'started' : 'delegated',
                    working: Boolean(entry.busy),
                    inTab: inTab(entry.id),
                    lastReply: lastReply(entry).slice(0, 1500),
                })),
            };
        },
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
        // A subagent's work is its own transcript; the messages are the
        // conversation's.
        if (messagesOnly && event.parentId) continue;
        switch (event.type) {
            case 'user-message':
                lines.push(`## You${stamp(event)}`, '', [
                    ...(Array.isArray(event.files) && event.files.length
                        ? event.files.map(entry => `[attached file: ${entry.name}]`) : []),
                    event.text || '',
                ].filter(Boolean).join('\n'), '');
                break;
            case 'assistant-text':
                lines.push(`## ${event.parentId ? 'Subagent' : 'Agent'}${stamp(event)}`, '', event.text || '', '');
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
            case 'warning':
                lines.push(`> **Warning:** ${event.message || ''}`, '');
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
            // A live chart: what it watched, and how it ended. The points
            // are a picture's worth of numbers, not a document's.
            case 'metric-started':
                lines.push(`> **Live chart:** ${event.spec?.title || ''} (\`${String(event.spec?.command || '').replace(/`/g, '\'')}\` on ${event.spec?.where || 'unknown'})`, '');
                break;
            case 'metric-ended':
                lines.push(`_Live chart ${event.status || 'ended'}: ${event.reason || ''} ${event.stats?.samples ?? 0} samples._`, '');
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

/* ------------------------------------------------------------------ *
 * Failover
 *
 * A conversation's turn cut short by the app dying, sent on again once the
 * app is back. The run log kept it open (see `hydrate` and failover.js);
 * this is the half that sends. Not replayed: the agent is told what
 * happened and which of its calls never reported back, and carries on from
 * its own memory of the turn, which its runtime kept as it went.
 * ------------------------------------------------------------------ */

/** What the transcript shows as the message that sent it on. */
const RESUME_MESSAGE = 'Failover restarted the app after it stopped unexpectedly. Carry on from where you were cut off.';

/** What the agent is told with it, out of the bubble. */
function resumeNote(unknown = []) {
    const parts = [
        'The app stopped unexpectedly (a crash, a hang, or the computer going down) in the middle of your last turn, '
        + 'and failover has started it again. Pick the work up where it stopped rather than starting over. If it was '
        + 'already finished, say so briefly instead of redoing it.',
        'Terminal sessions you had open before are gone or were reopened under new ids: look with list_sessions, or '
        + 'connect again, before running anything on a server.',
    ];
    if (unknown.length) {
        parts.push(
            'These tool calls never reported back, so they may or may not have happened. Check their effect before '
            + `repeating any of them:\n${unknown.map(step => `- ${step.name}: ${String(step.input || '').slice(0, 500)}`).join('\n')}`,
        );
    }
    return parts.join('\n\n');
}

/**
 * One cut-short turn, sent on. Resolves the conversation when it went, or
 * null with the run closed and the reason on it.
 */
async function resumeCutShort(run, queuedIds) {
    const close = (reason) => {
        runs.fail(run.id, reason);
        return null;
    };

    // Started by another conversation that is being resumed as well: that
    // one decides whether it is still needed (it is told its call never
    // reported back), rather than two copies of the same work running.
    const parentRunId = run.trigger?.parentRunId;
    if (parentRunId && queuedIds.has(parentRunId)) {
        return close('Left to the conversation that started it, which failover resumed.');
    }
    const conversation = conversations.get(run.conversationId);
    if (!conversation) return close('The conversation this run belonged to is gone.');
    // Somebody got there first: a message typed into it since the launch.
    if (conversation.busy || conversation.runId) {
        return close('Its conversation had moved on by the time failover came to resume it.');
    }

    const { count, allowed } = failover.noteResume(run.id);
    if (!allowed) {
        emit(conversation, {
            type: 'notice',
            tone: 'warn',
            text: `Failover did not pick this turn up again: the app stopped during it ${count} times.`,
        });
        archive.save(conversation.id);
        return close(`Failover stopped resuming it after the app stopped during it ${count} times.`);
    }

    // Read back from disk, a conversation carries no run kind, and one with
    // none is put down after its turn as if it were a job's.
    conversation.runKind = 'interactive';
    emit(conversation, {
        type: 'notice',
        tone: 'info',
        text: 'The app stopped unexpectedly during this turn. Failover restarted it and is carrying on.',
    });
    const noteBefore = conversation.pendingNote || '';
    conversation.pendingNote = [noteBefore, resumeNote(runs.unknownSteps(run.id))].filter(Boolean).join('\n\n');
    beginRun(conversation, { kind: 'interactive', resumeRunId: run.id });

    const sent = await send(conversation.id, RESUME_MESSAGE);
    if (!sent.success) {
        // Not left waiting for the user's next message, which is not a resume.
        conversation.pendingNote = noteBefore;
        // `send` closes a run it got as far as starting; an early refusal is ours.
        if (conversation.runId === run.id) endRun(conversation, 'failed', { reason: sent.message || 'It could not be sent.' });
        return null;
    }
    return conversation;
}

/**
 * Every conversation turn the last process left cut short, sent on, oldest
 * first. Called once the window is up after a launch failover says follows
 * a crash; a launch that does not has nothing queued, and this does nothing.
 */
async function resumeInterrupted() {
    hydrate();
    let queued;
    try {
        queued = runs.list({ status: 'queued', limit: 100 }).filter(run => run.kind === 'interactive' && !run.jobId);
    } catch (error) {
        console.error('Could not read the runs to resume:', error.message);
        return { resumed: 0 };
    }
    if (queued.length === 0) return { resumed: 0 };

    const queuedIds = new Set(queued.map(run => run.id));
    const resumed = [];
    for (const run of queued.reverse()) {
        try {
            const conversation = await resumeCutShort(run, queuedIds);
            if (conversation) resumed.push(conversation);
        } catch (error) {
            console.error(`Could not resume run ${run.id}:`, error.message);
            try { runs.fail(run.id, `Failover could not resume it: ${error.message}`); } catch { /* left for the next launch */ }
        }
    }

    if (resumed.length > 0) {
        const first = resumed[0];
        toast({
            title: 'Acestes restarted and carried on',
            body: resumed.length === 1
                ? `Picked "${first.title || 'a conversation'}" up where it was cut short.`
                : `Picked ${resumed.length} conversations up where they were cut short.`,
            conversationId: tabFor(first),
        });
    }
    return { resumed: resumed.length };
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
    // Which sign-in, when the menu offered the runtime under more than one.
    // An account belongs to its runtime, so a change of runtime that does not
    // name one drops it, and an empty one goes back to the agent's choice.
    const account = patch.account !== undefined
        ? patch.account
        : (next.provider === current.provider ? current.account : '');
    // Kept only when this conversation's own agent would actually run on it.
    // A menu built from another agent's ticks can offer an account this one
    // does not have ticked; storing that pin anyway would have the chip name
    // one account while every turn went to the agent's own, which is how a
    // conversation stuck on a plan at its limit looked switched and was not.
    if (account && typeof account === 'string' && next.provider && accounts.supports(next.provider)
        && pinnedAccountFor(settings.get(conversation.agentId), next.provider, account.slice(0, 80))) {
        next.account = account.slice(0, 80);
    }
    conversation.settingsPatch = Object.keys(next).length ? next : null;
    archive.save(conversation.id);

    const after = effectiveSettings(conversation);
    // A line in the chat saying what moved, so the turns after it read as the
    // new model's. Only once something has been said: an empty chat has no
    // "before" for the line to divide it from.
    const change = describeModelChange(before, after);
    if (change && conversation.events.some(event => event.type === 'user-message')) {
        emit(conversation, { type: 'model-changed', text: change });
        archive.save(conversation.id);
    }
    const session = conversation.session;
    if (before.provider !== after.provider || accountMoved(conversation, before, after)) {
        if (session || conversation.starting) conversation.needsRestart = true;
    } else if (session) {
        if (before.model !== after.model) session.setModel?.(after.model);
        if (before.effort !== after.effort) session.setEffort?.(after.effort);
    }
    return { pinned: conversation.settingsPatch };
}

/**
 * What a new conversation of this agent starts on: the starred model, else
 * the last one used, anywhere in the app (see start-model.js). Null leaves
 * it on the agent's own default.
 */
function startPick(agentId) {
    const current = settings.get(agentId);
    return startModel.pickFor(current, (provider, account) => Boolean(pinnedAccountFor(current, provider, account)));
}

/**
 * Put a conversation someone just opened on the model new ones start on.
 * For the conversations a person opens (a tab, a fork); the ones an agent
 * or a job makes keep the model they were made with.
 */
function startOnPick(conversationId) {
    hydrate();
    const conversation = conversations.get(conversationId);
    if (!conversation) return null;
    const pick = startPick(conversation.agentId);
    if (!pick) return conversation.settingsPatch || null;
    return setConversationModel(conversationId, pick).pinned || null;
}

/** The model a person just sent a message with is the one the next tab starts on. */
function rememberUsed(conversationId) {
    const conversation = conversations.get(conversationId);
    if (!conversation) return;
    const patch = conversation.settingsPatch || {};
    const own = settings.get(conversation.agentId);
    const current = effectiveSettings(conversation);
    // The agent's default model counts only on the agent's own runtime: a
    // conversation moved to another runtime without naming a model runs on
    // that runtime's default, which has no name to keep.
    const model = patch.model || (!patch.provider || patch.provider === own.provider ? own.model : '');
    startModel.remember({
        provider: current.provider,
        model,
        effort: current.effort,
        account: patch.account || '',
    });
}

const EFFORT_NAMES ={ low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max', ultra: 'ultra' };

/**
 * What a pick in the composer changed, as one short line for the chat:
 * `Opus 5.5 · high effort · Work`, naming only the parts that moved. Empty
 * when nothing that answers the next message is different.
 */
function describeModelChange(before, after) {
    const parts = [];
    if (before.provider !== after.provider || before.model !== after.model) {
        const rows = modelCatalogs.get(after.provider) || [];
        const row = rows.find(entry => entry?.value === after.model);
        const runtime = PROVIDERS[after.provider]?.label || PROVIDERS[after.provider]?.name || after.provider;
        parts.push(row?.label || after.model || `${runtime} default`);
    }
    if ((before.effort || '') !== (after.effort || '') && after.effort) {
        parts.push(`${EFFORT_NAMES[after.effort] || after.effort} effort`);
    }
    if (before.provider === after.provider && (before.accountId || '') !== (after.accountId || '')) {
        const account = accounts.resolve(after.provider, after.accountId);
        parts.push(account?.builtIn ? 'this computer\'s login' : (account?.label || 'another account'));
    }
    return parts.length ? `Switched to ${parts.join(' · ')}` : '';
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
async function send(conversationId, text, attachments = [], tagged = [], attachedFiles = []) {
    hydrate();

    if (parseSubagentId(conversationId)) {
        return { success: false, message: 'This is a subagent\'s work, read only. Reply in the conversation that started it.' };
    }
    const conversation = conversations.get(conversationId);
    if (!conversation) return { success: false, message: 'That conversation is gone' };

    const body = String(text || '').trim();
    const { images, error } = readImages(attachments);
    if (error) return { success: false, message: error };
    const { files, error: filesError } = readFiles(attachedFiles);
    if (filesError) return { success: false, message: filesError };

    // What the message tagged is looked up here, against the inventory as it
    // stands, rather than trusted as text from the renderer. See `mentions.js`.
    // Skills are resolved by id only, so invoking one reads its own file rather
    // than every skill installed. See `skills.js`.
    const taggedSkills = (Array.isArray(tagged) ? tagged : [])
        .filter(entry => entry?.kind === 'skill' && entry?.id)
        .map(entry => skills.get(String(entry.id)))
        .filter(Boolean);
    // A tagged file is resolved here and not in `mentions.js`: the content
    // lives on disk (or in the agent's container), behind the same grant the
    // local tools check, and the mention carries only the path. Outside the
    // granted folders, or gone since it was tagged, the message is refused
    // rather than answered against half of what it named.
    const sandbox = agents.sandbox(conversation.agentId);
    const seenFile = new Set();
    const taggedWorkspaceFiles = [];
    let workspaceError = '';
    for (const entry of Array.isArray(tagged) ? tagged : []) {
        if (entry?.kind !== 'file' || !entry?.id) continue;
        const id = String(entry.id);
        if (seenFile.has(id)) continue;
        seenFile.add(id);
        const target = workspaceFiles.toAgentPath(sandbox, id);
        if (target.error) { workspaceError = target.error; break; }
        const read = await local.read({ agentId: conversation.agentId, sandbox }, target.path);
        if (read.error) { workspaceError = read.error; break; }
        const text = String(read.content || '');
        const name = workspaceFiles.displayRel(sandbox, id);
        if (!text.trim()) { workspaceError = `"${name}" is empty`; break; }
        taggedWorkspaceFiles.push({ id, name, text });
    }
    if (workspaceError) return { success: false, message: workspaceError };
    const attached = readMentions(tagged, {
        hosts: store.getHosts(),
        snippets: store.getSnippets(),
        proxies: store.getProxies(),
        keys: store.getKeys(),
        notes: memory.list(conversation.agentId),
        servers: agents.get(conversation.agentId)?.mcpServers || [],
        skills: taggedSkills,
        workspaceFiles: taggedWorkspaceFiles,
    });
    if (attached.error) return { success: false, message: attached.error };
    const { mentions } = attached;

    if (!body && images.length === 0 && files.length === 0 && mentions.length === 0) {
        return { success: false, message: 'Nothing to send' };
    }

    // Refused here rather than quietly dropped: a question about a screenshot
    // the model never saw would get an answer that reads as if it had. Pinned
    // like the run itself, so a conversation put on another runtime is judged
    // by the one answering it rather than by the agent's default.
    if (images.length > 0 && PROVIDERS[effectiveSettings(conversation).provider]?.supportsImages !== true) {
        return { success: false, message: 'This agent cannot read images.' };
    }

    // The first message, tidied, names the chat until the runtime has named
    // it properly (see `nameConversation`). A draft that was only "hi" gives
    // way to the next message. Scrubbed like the message itself: the title is
    // in every list, and "my api key is ..." is a common first line.
    const drafted = !conversation.title
        || (conversation.titleSource === 'draft' && titles.tooThin(conversation.title) && body && !titles.tooThin(body));
    if (drafted) {
        conversation.title = secrets.scrub(titles.fromMessage(body || mentions[0]?.name || images[0]?.name || files[0]?.name));
        conversation.titleSource = 'draft';
    }

    // A message is going, so a runtime started early for the draft is this
    // conversation's in the open from here (see `warm`).
    conversation.warmOnly = false;
    // From the click to the runtime, stage by stage. See send-timing.js.
    const timer = sendTiming.createTimer();
    const cold = !conversation.session;

    // The transcript keeps what was tagged and not what it said: the records
    // are in the inventory, and a chip is what the bubble draws for them.
    emit(conversation, {
        type: 'user-message',
        text: body,
        ...(images.length ? { images } : {}),
        ...(files.length ? { files } : {}),
        ...(mentions.length ? { mentions: stripMentions(mentions) } : {}),
    });
    // Told to the panel like the runtime's name will be, so the tab and the
    // header say what the list says from the first moment.
    if (drafted) emit(conversation, { type: 'title', title: conversation.title });
    conversation.busy = true;
    nameConversation(conversation);

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
    timer.mark('record');

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
        timer.mark('runtime');

        // Bare provider CLI: this briefing is Acestes context too (which
        // session is pinned, what is open). The message goes as typed.
        const bare = effectiveSettings(conversation).bareProvider;
        const context = bare ? '' : prompt.situation({
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
        // A conversation just moved to another sign-in of the same runtime,
        // whose sessions the new one cannot read. See ensureProvider.
        if (conversation.movedOver) {
            parts.push(
                '<earlier-conversation>\nThis chat has just moved to another account of the same agent, whose '
                + 'sessions are kept apart, so you have no memory of it. This is what was said before this '
                + `message. Carry on from it.\n\n${conversation.movedOver}\n</earlier-conversation>`,
            );
            conversation.movedOver = '';
        }
        if (conversation.pendingNote) {
            parts.push(`<app-note>\n${conversation.pendingNote}\n</app-note>`);
            conversation.pendingNote = '';
        }
        if (!bare && context !== conversation.lastContext) {
            conversation.lastContext = context;
            parts.push(`<app-context>\n${context}\n</app-context>`);
        }
        timer.mark('context');

        // What the agent remembers that bears on this message, found by
        // meaning. The rules are in the system prompt already; this is how the
        // rest of the notebook reaches it, a few notes at a time, each once a
        // conversation. A short follow-up is searched with the message before
        // it. Given a moment and no more: see `relevant` in memory.js. A bare
        // runtime has no prompt of ours, so its rules are found like the rest.
        // Not for the note-taking turn after a real one: its words are ours,
        // and about remembering in general, not about anything in the notes.
        const remembered = body && !conversation.remembering && resolved(conversation.agentId).memory !== false
            ? await memory.relevant(conversation.agentId, body, {
                previous: previousMessage(conversation),
                conversationId: conversation.id,
                session: conversation.providerSessionId || '',
                exclude: bare ? [] : conversation.memoryPinned,
            })
            : [];
        timer.mark('memory');
        if (remembered.length > 0) {
            parts.push(
                '<memory>\nNotes from your memory that may bear on this message:\n'
                + `${remembered.map(memory.line).join('\n')}\n</memory>`,
            );
        }

        if (files.length > 0) parts.push(fileBlock(files));
        if (mentions.length > 0) parts.push(mentionBlock(mentions));
        if (body) parts.push(body);

        session.send(parts.join('\n\n'), images);
        timer.mark('handoff');
        sendTiming.record(timer.entry({ provider: conversation.provider || '', cold, chars: body.length }));
        return { success: true };
    } catch (error) {
        conversation.busy = false;
        emit(conversation, { type: 'error', message: error.message });
        endRun(conversation, 'failed', { reason: error.message });
        return { success: false, message: error.message };
    }
}

/**
 * Name a conversation by what it is about, once enough has been said to.
 *
 * Asked of the runtime the conversation runs on, under the same account, so
 * nothing goes anywhere the chat itself does not. Off to the side of the
 * turn: the draft is up already, and the answer replaces it when it comes. A
 * first message too thin to name ("hi") waits for the second. Asked once; a
 * runtime with no way to ask, or a question that fails, leaves the draft.
 */
function nameConversation(conversation) {
    if (conversation.titleSource !== 'draft') return;
    const said = conversation.events
        .filter(event => event.type === 'user-message' && event.text)
        .map(event => event.text)
        .slice(0, 2);
    if (said.length === 0) return;
    if (said.length === 1 && titles.tooThin(said[0])) return;

    const current = effectiveSettings(conversation);
    const provider = PROVIDERS[current.provider];
    if (typeof provider?.title !== 'function') {
        conversation.titleSource = 'message';
        return;
    }

    conversation.titleSource = 'naming';
    const draft = conversation.title;
    titles.generate(provider, { settings: current, messages: said }).then((name) => {
        // Closed, or retitled some other way, while the question was out.
        if (conversations.get(conversation.id) !== conversation) return;
        if (conversation.titleSource !== 'naming' || conversation.title !== draft) return;

        const title = secrets.scrub(name);
        conversation.titleSource = title ? 'model' : 'message';
        if (!title) {
            archive.save(conversation.id);
            return;
        }
        conversation.title = title;
        if (conversation.runId) {
            try {
                runs.setTitle(conversation.runId, title);
            } catch (error) {
                console.error('Could not retitle the run:', error.message);
            }
        }
        // An event rather than a quiet change, so every panel showing this
        // conversation, and every list of them, is told; and in the log, so
        // a panel rebuilt from it arrives at the same name.
        emit(conversation, { type: 'title', title });
    });
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
 * Bring a conversation's runtime up while its message is still being typed.
 *
 * Starting one is the slowest thing a message waits for: the CLI starts, its
 * MCP servers answer, and only then is the message read. A week of sends had
 * a third of them waiting on that, a second and a half typically and five
 * at worst; Claude Code started four seconds before its first message read
 * that message in fifty milliseconds instead of two thousand. So the
 * composer asks for this on the first keystroke, and the start happens while
 * the person is still writing.
 *
 * Only what `send` would do anyway, a little earlier. Nothing goes to a
 * model; a conversation already running or in the middle of a turn is left
 * alone; a model or account change waiting for the next message is applied
 * now, which is still between turns. A conversation with nothing in it yet
 * keeps what its runtime reports on the way up out of the transcript until
 * a message goes (`warmOnly`), so a draft typed and deleted leaves nothing
 * behind in the history. The memory model is started too, when the agent
 * has memory on, so the first message after launch does not wait for it.
 *
 * Resolves `{ success }` and never rejects: a runtime that fails to start
 * here is tried again by the send, which is where the reason belongs.
 */
async function warm(conversationId) {
    hydrate();
    if (parseSubagentId(conversationId)) return { success: false };
    const conversation = conversations.get(conversationId);
    if (!conversation || conversation.busy) return { success: false };

    if (resolved(conversation.agentId).memory !== false) embeddings.warm();

    try {
        if (conversation.needsRestart || conversation.session?.stopped) await restart(conversation);
        if (conversation.busy) return { success: false };
        if (!conversation.session && !conversation.starting && conversation.events.length === 0) {
            conversation.warmOnly = true;
        }
        await ensureProvider(conversation);
        return { success: true };
    } catch {
        return { success: false };
    }
}

/**
 * What is worth loading before anyone asks, once the window is up: the
 * memory model, whose load is two seconds of the first message after launch
 * otherwise. Only for an agent with memory on.
 */
function warmUp() {
    try {
        if (resolved(agents.activeId()).memory !== false) embeddings.warm();
    } catch (error) {
        console.error('Could not warm up the assistant:', error.message);
    }
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
    computer.forget(conversationId);
    // Which notes it was shown, which no later message will ask about.
    memory.forgetConversation(conversationId);
    // Its live charts have nowhere to be drawn, and their commands no reader.
    liveMetrics.stopAll({ conversationId, reason: 'The conversation was closed.' });
    // Thrown away for good, so its file goes too. Suspended during a
    // shutdown, which closes every conversation without meaning to forget any
    // of them.
    archive.remove(conversationId);
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

    const subagent = parseSubagentId(conversationId);
    if (subagent) return subagentHistory(subagent);

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
 * Every conversation the app holds, newest first: every one ever had on this
 * machine and not deleted.
 *
 * The ones with a query running, the ones parked, and the ones read back off
 * disk from an earlier run, because from the panel's side those differences are
 * invisible: picking any of them reads the same event log back, and only
 * sending into it starts anything. Listing one does not read its events in;
 * the archive keeps what a row needs.
 */
function list({ agentId = '' } = {}) {
    hydrate();

    return [...conversations.values()]
        // One agent's, when asked; the sidebar and the Conversations page
        // only ever show the agent that is selected. Nothing that was never
        // spoken into: a tab opened and left is not a conversation yet.
        .filter(conversation => !agentId || conversation.agentId === agentId)
        .filter(archive.hasContent)
        .map(describe)
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
        messages: archive.messageCount(conversation),
    };
}

/**
 * Search one agent's conversations by what was said in them. See search.js
 * for the query language; this only hands it the conversations and the
 * lookups it needs. All of them, however old: the ones whose events are on
 * disk only are read one at a time and let go again, so a search across a
 * long history does not end up holding all of it.
 */
async function search({ agentId = '', query = '', limit, openIds = [] } = {}) {
    hydrate();
    const rows = [...conversations.values()]
        .filter(conversation => !agentId || conversation.agentId === agentId)
        .filter(archive.hasContent);
    const hostsById = new Map(store.getHosts().map(host => [host.id, host]));
    return searchModule.search(rows, {
        query,
        limit,
        openIds: new Set(Array.isArray(openIds) ? openIds.map(String) : []),
        hostName: (id) => hostsById.get(id)?.name || '',
        live: (conversation) => Boolean(conversation.session || conversation.starting),
        describe,
        eventsOf: archive.peekEvents,
        sketchOf: (conversation) => {
            const { firstMessage, lastMessage } = archive.summaryOf(conversation);
            return searchModule.sketchFrom(conversation.title, firstMessage, lastMessage);
        },
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
        archive.save(conversation.id);
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
        archive.save(conversation.id);
        moved += 1;
    }
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
    if (refresh) {
        modelCatalogs.delete(asked);
        modelMisses.delete(asked);
    }

    if (modelCatalogs.has(asked)) return Promise.resolve(modelCatalogs.get(asked));
    // A recent miss answers at once rather than starting the runtime again
    // for every panel that opens; past the window the next ask retries, so
    // a runtime that was still coming up heals on its own. See modelMisses.
    if (!refresh && modelMisses.has(asked) && Date.now() - modelMisses.get(asked) < MODEL_MISS_TTL) {
        return Promise.resolve(null);
    }
    if (!refresh && modelsPending.has(asked)) return modelsPending.get(asked);

    const provider = PROVIDERS[asked];
    if (!provider?.listModels) return Promise.resolve(null);

    const promise = provider.listModels({ settings: resolvedFor(asked) })
        .then((rows) => {
            if (rows?.length) {
                // Stored against the agent that answered, whether or not that
                // is still the one selected. A later ask for a different agent
                // reads its own entry, and a switch back does not have to ask
                // again.
                modelCatalogs.set(asked, rows);
                modelMisses.delete(asked);
                notify('ai-models', { provider: asked, models: rows });
                return rows;
            }
            // Asked, and nothing to report: remembered briefly rather than
            // kept, so the next ask past the window tries again instead of
            // inheriting one bad start for the life of the app. Providers
            // resolve rather than reject on a failure (Pi's listModels
            // returns null when its runtime never answered), which is why
            // this lives here and not only in the catch below.
            modelMisses.set(asked, Date.now());
            notify('ai-models', { provider: asked, models: null });
            return null;
        })
        .catch((error) => {
            // Said out loud rather than swallowed: an empty model menu with no
            // reason anywhere is the kind of thing that gets blamed on the
            // menu. Not cached either, so the next ask tries again rather than
            // inheriting one bad start for the life of the app.
            console.error(`Could not read the model list from ${asked}:`, error.message);
            modelMisses.set(asked, Date.now());
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

function status(agentId = '') {
    const current = settings.get();
    return {
        // The settings of the agent a tab belongs to, which need not be the
        // one selected: the composer's menu offers that agent's accounts,
        // since those are the ones its conversations can run on.
        agentSettings: agentId ? settings.get(agentId) : current,
        ready: Boolean(PROVIDERS[current.provider]),
        provider: current.provider,
        providers: Object.keys(PROVIDERS),
        // Which of them can be sent a picture, so the composer offers the
        // attach button only where it would work.
        imageProviders: Object.keys(PROVIDERS).filter(name => PROVIDERS[name].supportsImages === true),
        // Whose runtime each agent answers on, so a tab for one agent does
        // not take the attach gate of whichever agent happens to be selected.
        agentProviders: Object.fromEntries(
            (agents.snapshot()?.agents || []).map(entry => [entry.id, settings.get(entry.id).provider])
        ),
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
            bundle: catalog.bundleOf(tool.name),
        })),
        toolBundles: catalog.BUNDLES.map(bundle => ({
            id: bundle.id,
            title: bundle.title,
            always: bundle.always || undefined,
            tools: catalog.TOOLS.filter(tool => catalog.bundleOf(tool.name) === bundle.id).length,
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
    // With failover on, a turn ended by closing the window or locking the app
    // is over, not cut short, and is closed as such: left open, a crash later
    // in the same process would bring it back. The system going down is the
    // other case, and stays open to be resumed after the restart.
    if (failover.isEnabled() && !failover.isSystemEnding()) {
        for (const conversation of conversations.values()) {
            if (!conversation.runId || (conversation.runKind || 'interactive') !== 'interactive') continue;
            try {
                runs.cancel(conversation.runId, 'The window was closed during this turn.');
            } catch {
                // Left open, it is closed out at the next launch instead.
            }
        }
    }

    // Before the flush, so each chart's last points are in its
    // conversation's log and it reads back as it was when the app went.
    liveMetrics.stopAll({ reason: 'Stopped when the app closed.' });
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
    metricSnapshot,
    stopMetric,
    setNotifier,
    setWindowProbe,
    setToaster,
    setTabOpener,
    cancelRun,
    startJobRun,
    resumeJobRun,
    resumeInterrupted,
    probeForJob,
    publicJob,
    exportMarkdown,
    readConversation,
    setConversationModel,
    startModel,
    startPick,
    startOnPick,
    rememberUsed,
    tidyMemory,
    memoryTidyRunning,
    secrets,
    resolveModel,
    reconfigure,
    create,
    get,
    conversationIds,
    importConversations,
    send,
    warm,
    warmUp,
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
    sweepHistory,
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
    // a runtime behind them, and the conversation tools' tests, which drive
    // one conversation's API the way its tools do.
    _test: {
        emit: (conversationId, event) => emit(conversations.get(conversationId), event),
        providers: PROVIDERS,
        conversationsApi: (conversationId) => conversationsApiFor(conversations.get(conversationId)),
        conversation: (conversationId) => conversations.get(conversationId),
        turnEnd,
        saidBefore: (conversationId) => saidBefore(conversations.get(conversationId)),
        reportToParent: (conversationId, status) => reportToParent(conversations.get(conversationId), status),
        setCheckWait: (ms) => { CHECK_WAIT = ms; },
    },
};
