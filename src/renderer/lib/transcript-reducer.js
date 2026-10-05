/**
 * The transcript, as a fold over the conversation's events.
 *
 * The only place the shape of a transcript item is decided, so a panel that
 * replays a conversation from disk and one that watched it happen cannot
 * disagree. Kept out of the hook so it can be tested on its own and read
 * without the subscription wrapped round it. See `useAssistant`.
 */

/** A blank turn-in-progress, for the streaming text bubble. */
function emptyDraft() {
    return { text: '', thinking: '' };
}

/** Output tokens, however the runtime spelled its usage. */
function outputTokensOf(usage) {
    if (!usage || typeof usage !== 'object') return 0;
    for (const key of ['output_tokens', 'completion_tokens', 'outputTokens', 'output']) {
        const n = Number(usage[key]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
}

/**
 * A turn's answer rate, for the number beside its branch icon.
 *
 * The main process stamps exact figures on the result (active time: wall
 * minus approval waits minus tool runs, with the wall time alongside); a result
 * read back from before that carry them is worked out here from the turn's
 * first message instead. Nothing when there is no usage to divide or no
 * time to divide by, and the row then shows no number rather than a wrong
 * one.
 */
function turnRate(event, startAt) {
    const tokens = Number(event.outputTokens) || outputTokensOf(event.usage);
    const ms = Number(event.durationMs)
        || (Number.isFinite(event.at) && Number.isFinite(startAt) && event.at > startAt
            ? event.at - startAt
            : 0);
    if (!(tokens > 0) || !(ms > 0)) return null;
    const rate = {
        tps: Number(event.tokensPerSec) || Math.round((tokens / (ms / 1000)) * 10) / 10,
        tokens,
        seconds: Math.round((ms / 1000) * 10) / 10,
    };
    // The wall time alongside, when the turn spent longer than generating:
    // tools running, approvals waiting. Old turns measured the wall itself
    // and carry no second figure.
    const wallMs = Number(event.wallMs);
    if (wallMs > ms) rate.wall = Math.round((wallMs / 1000) * 10) / 10;
    return rate;
}

/** The last index whose item passes, searching from the newest. */
function lastIndexWhere(items, test) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        if (test(items[index])) return index;
    }
    return -1;
}

/** The row of the call that started a subagent, by the call or by the task. */
function taskRow(items, event) {
    return lastIndexWhere(items, item => item.kind === 'tool'
        && ((event.toolUseId && item.id === event.toolUseId) || (item.task && item.task.id === event.taskId)));
}

/**
 * Every subagent still marked running, marked stopped: the turn it belonged
 * to is over, so nothing is going to say it finished. Leaves the list as it
 * was when there is none, which is nearly always.
 */
function settleTasks(items, edit) {
    if (!items.some(item => item.task?.status === 'running')) return;
    const list = edit();
    list.forEach((item, index) => {
        if (item.task?.status === 'running') list[index] = { ...item, task: { ...item.task, status: 'stopped' } };
    });
}

/**
 * Fold one event into the transcript.
 *
 * Pure, and the only place the shape of an item is decided, so replaying
 * history and receiving live events cannot drift.
 *
 * The list is copied the first time an event changes it and not at all when
 * it does not. A streamed word only moves the draft, so the list, and every
 * item in it, is the same object it was: the transcript can tell from that
 * alone that none of its rows need drawing again. An edit replaces the one
 * item it touches and leaves the others as they were, for the same reason.
 *
 * `owned` says the list already belongs to the caller and may be changed in
 * place: a replay building one from nothing, or a batch that has already
 * made its copy. Without it, replaying a long conversation copied the whole
 * list once per event.
 */
function step(state, event, owned) {
    let items = state.items;
    const edit = () => {
        if (!owned && items === state.items) items = items.slice();
        return items;
    };
    let draft = state.draft;
    let busy = state.busy;
    let costUsd = state.costUsd;
    let turnStartAt = state.turnStartAt;
    let turnRates = state.turnRates;

    /**
     * The row a question belongs to.
     *
     * By session first, because the same command sent to three servers is three
     * rows of the same tool with the same title, and the last one started is not
     * the one being asked about. A row carrying a question already is not
     * running, so no two questions can land on the same row. The last row of
     * that tool is the fallback for a call that named no session, which is the
     * ordinary single-server case.
     */
    const findRunningTool = (name, session) => {
        let fallback = -1;
        for (let index = items.length - 1; index >= 0; index -= 1) {
            const item = items[index];
            if (item.kind !== 'tool' || item.name !== name || item.status !== 'running') continue;
            if (session && item.input?.session === session) return index;
            if (fallback < 0) fallback = index;
        }
        return fallback;
    };

    switch (event.type) {
        case 'user-message':
            // Images carry their bytes while the app runs; one read back from
            // disk has only a name and a type, and is drawn as a chip. A
            // mention is only ever a kind, an id and a name here: the record
            // itself lives in the inventory. `specs` is what a message written
            // before mentions existed carries, read as the snippets they were.
            edit().push({
                kind: 'user',
                id: event.at,
                text: event.text,
                images: event.images || [],
                files: event.files || [],
                mentions: event.mentions
                    || (event.specs || []).map(spec => ({ ...spec, kind: 'snippet' })),
            });
            busy = true;
            draft = emptyDraft();
            turnStartAt = event.at;
            break;

        case 'thinking-start':
            draft = { ...draft, thinking: draft.thinking || '' };
            break;

        case 'thinking-delta':
            draft = { ...draft, thinking: draft.thinking + (event.text || '') };
            break;

        case 'text-delta':
            draft = { ...draft, text: draft.text + (event.text || '') };
            break;

        case 'assistant-text':
            if (event.parentId) break;
            // The finished block replaces whatever streamed into the draft.
            // Deltas are a preview; this is the authoritative text.
            // …except when it arrives twice: stopping mid-stream flushes the
            // draft as an item plus a `Stopped.` notice, and Pi's aborted
            // message_end lands a moment later with the same partial text.
            // The same double-arrival happens when narration flushed ahead
            // of a tool call repeats in the step's closing block. A finished
            // block identical to the nearest assistant item above (past only
            // notices) adds nothing, so it is dropped instead of drawn twice.
            {
                let cursor = items.length - 1;
                while (cursor >= 0 && items[cursor].kind === 'notice') cursor -= 1;
                const prev = cursor >= 0 ? items[cursor] : null;
                if (prev?.kind === 'assistant'
                    && String(prev.text || '') === String(event.text || '')
                    && String(prev.thinking || '') === String(draft.thinking || '')) {
                    draft = emptyDraft();
                    break;
                }
            }
            edit().push({
                kind: 'assistant',
                id: `a-${event.at}-${items.length}`,
                text: event.text,
                thinking: draft.thinking,
            });
            draft = emptyDraft();
            break;

        case 'tool-call':
            // A subagent's own work is its transcript, which opens from the
            // row of the call that started it; the parent shows that row.
            if (event.parentId) break;
            edit().push({
                kind: 'tool',
                id: event.id,
                name: event.name,
                local: event.local,
                input: event.input || {},
                // What an edit changes, worked out in the main process from
                // the call's own arguments. Absent on everything else.
                diff: event.diff || null,
                status: 'running',
                result: '',
                isError: false,
            });
            // Anything that streamed before the call belongs above it: the
            // narration and, where the model thought without speaking, its
            // thinking on its own. Thinking-only used to be dropped here,
            // which is why work between calls never showed a thought.
            if (draft.text.trim() || draft.thinking.trim()) {
                edit().splice(items.length - 1, 0, {
                    kind: 'assistant',
                    id: `a-${event.at}-pre`,
                    text: draft.text,
                    thinking: draft.thinking,
                });
            }
            draft = emptyDraft();
            break;

        case 'tool-result': {
            if (event.parentId) break;
            const index = lastIndexWhere(items, item => item.kind === 'tool' && item.id === event.id);
            if (index >= 0) {
                edit()[index] = {
                    ...items[index],
                    status: event.isError ? 'error' : 'done',
                    result: event.text || '',
                    isError: Boolean(event.isError),
                };
            }
            break;
        }

        // A subagent, on the row of the call that started it. A background
        // one's call returns at once, so the row says it is done while the
        // subagent is still at work; the task is what says otherwise.
        case 'task-started': {
            const index = taskRow(items, event);
            if (index >= 0) {
                edit()[index] = {
                    ...items[index],
                    task: {
                        id: event.taskId,
                        status: 'running',
                        background: Boolean(event.background),
                        description: event.description || '',
                        agent: event.agent || '',
                        activity: '',
                        toolUses: 0,
                    },
                };
            }
            break;
        }

        case 'task-progress':
        case 'task-ended': {
            const index = taskRow(items, event);
            const task = index >= 0 ? items[index].task : null;
            if (task) {
                edit()[index] = {
                    ...items[index],
                    task: event.type === 'task-ended'
                        ? { ...task, status: event.status || 'completed', toolUses: event.toolUses || task.toolUses }
                        : { ...task, activity: event.description || task.activity, toolUses: event.toolUses || task.toolUses },
                };
            }
            break;
        }

        // The runtime picked the conversation up again by itself, to pass on
        // what a subagent brought back after the turn that sent it was over.
        case 'turn-resumed':
            busy = true;
            draft = emptyDraft();
            break;

        case 'approval-request': {
            const approval = {
                requestId: event.requestId,
                name: event.name,
                title: event.title,
                input: event.input || {},
                diff: event.diff || null,
                local: event.local,
                readOnly: event.readOnly,
                sessionId: event.sessionId || '',
                host: event.host,
                status: 'pending',
                feedback: '',
            };

            // The question belongs to the call, so it is attached to the row
            // that call already has rather than living beside it. The panel
            // draws its card from this and holds the row back while it stands,
            // so the command is on screen once; answering it puts the row back
            // with the answer recorded on it. The row is marked waiting rather
            // than running meanwhile, so nothing claims work is happening while
            // it is actually stopped on a question.
            const index = findRunningTool(event.name, event.input?.session);
            if (index >= 0) {
                edit()[index] = { ...items[index], status: 'waiting', approval };
            } else {
                // No row to land on: a call the transcript never saw start.
                // Rare, and a card of its own is better than a lost question.
                edit().push({ kind: 'approval', id: event.requestId, ...approval });
            }
            break;
        }

        case 'approval-settled': {
            const index = lastIndexWhere(items, item => (
                item.kind === 'approval'
                    ? item.requestId === event.requestId
                    : item.kind === 'tool' && item.approval?.requestId === event.requestId
            ));
            if (index >= 0) {
                const item = items[index];
                // The answer may be applied twice: once by the click, which is
                // what makes the card settle without waiting for a round trip,
                // and once by the main process when it resolves. Only the
                // first carries what the user typed, so it is kept.
                const feedback = event.feedback || item.approval?.feedback || item.feedback || '';
                edit()[index] = item.kind === 'approval'
                    ? { ...item, status: event.status, feedback }
                    : {
                        ...item,
                        // Answered, so the row goes back to reporting the call.
                        // A refused one never runs, and `tool-result` closes it
                        // out either way.
                        status: event.status === 'approved' ? 'running' : item.status,
                        approval: { ...item.approval, status: event.status, feedback },
                    };
            }
            break;
        }

        // A question the agent asked, as opposed to a call it wants to make.
        // Its own kind of row: nothing in the transcript is waiting on it the
        // way a tool row waits on an approval, so it stands on its own.
        case 'question-request':
            edit().push({
                kind: 'question',
                id: event.requestId,
                requestId: event.requestId,
                question: event.question || '',
                options: event.options || [],
                // A secret is typed into a masked field and never shown back.
                secret: Boolean(event.secret),
                secretName: event.secretName || '',
                status: 'pending',
                answer: '',
            });
            break;

        case 'question-settled': {
            const index = lastIndexWhere(items, item => item.kind === 'question' && item.requestId === event.requestId);
            if (index >= 0) {
                const item = items[index];
                edit()[index] = {
                    ...item,
                    status: event.status,
                    answer: event.answer || item.answer || '',
                };
            }
            break;
        }

        // What the turn did to files, as the card at its foot. `from` is set
        // on a branch's copy: the card is there to read, and undoing it
        // belongs to the conversation that made the change.
        case 'turn-changes':
            edit().push({
                kind: 'changes',
                id: `c-${event.turnId}-${items.length}`,
                turnId: event.turnId,
                files: event.files || [],
                from: event.from || '',
                status: 'applied',
                failed: [],
            });
            break;

        case 'turn-reverted': {
            const index = lastIndexWhere(items, item => item.kind === 'changes' && String(item.turnId) === String(event.turnId));
            if (index >= 0) {
                const failed = event.failed || [];
                edit()[index] = {
                    ...items[index],
                    status: failed.length === 0 ? 'reverted' : 'partial',
                    failed,
                };
            }
            break;
        }

        // The runtime's name for the conversation, once it has given one.
        case 'title':
            return { ...state, title: event.title || '' };

        case 'account':
            return { ...state, account: event };

        case 'rate-limit':
            return { ...state, rateLimit: event };

        // How full the model's context is after the latest reply.
        case 'context':
            return { ...state, context: event };

        case 'result':
            // Thinking left over when the turn ends with no reply to carry
            // it (no assistant-text follows) is kept as a thought of its own
            // rather than dropped with the draft.
            if (draft.text.trim() || draft.thinking.trim()) {
                edit().push({
                    kind: 'assistant',
                    id: `a-${event.at}-end`,
                    text: draft.text,
                    thinking: draft.thinking,
                });
                draft = emptyDraft();
            }
            busy = false;
            costUsd += event.costUsd || 0;
            // The turn's answer rate, keyed by the message that started it,
            // which is the id `findTurnEnds` knows the turn by.
            const rate = turnRate(event, turnStartAt);
            if (rate && turnStartAt) turnRates = { ...turnRates, [turnStartAt]: rate };
            if (event.isError && event.subtype !== 'success') {
                edit().push({
                    kind: 'notice',
                    id: `n-${event.at}`,
                    tone: 'warn',
                    text: event.subtype === 'error_max_turns'
                        ? 'The assistant reached its step limit for this turn. Ask it to continue if it was on the right track.'
                        : `The run ended early (${event.subtype}).`,
                });
            }
            break;

        case 'error':
            busy = false;
            settleTasks(items, edit);
            if (draft.text.trim() || draft.thinking.trim()) {
                edit().push({
                    kind: 'assistant',
                    id: `a-${event.at}-end`,
                    text: draft.text,
                    thinking: draft.thinking,
                });
            }
            edit().push({ kind: 'notice', id: `e-${event.at}`, tone: 'error', text: event.message });
            draft = emptyDraft();
            break;

        // A line the app wrote into the transcript itself, rather than anything
        // the model said. The main process uses it to close out a conversation
        // read back from disk whose last turn never finished, because the
        // process running it went away.
        case 'notice':
            busy = false;
            settleTasks(items, edit);
            edit().push({
                kind: 'notice',
                id: `nx-${event.at}-${items.length}`,
                tone: event.tone || 'info',
                text: event.text,
            });
            draft = emptyDraft();
            break;

        // The composer's chip moved this chat to another model, effort or
        // account. A divider rather than a notice, and the turn is left as it
        // is: the change can land in the middle of one.
        case 'model-changed':
            edit().push({ kind: 'divider', id: `mc-${event.at}-${items.length}`, text: event.text || '' });
            break;

        // Something the provider wanted said that is not the end of the turn,
        // so the turn is left running.
        case 'warning':
            edit().push({ kind: 'notice', id: `w-${event.at}-${items.length}`, tone: 'warn', text: event.message });
            break;

        case 'tool-failed':
            edit().push({
                kind: 'notice',
                id: `tf-${event.at}`,
                tone: 'warn',
                text: `${event.name} failed: ${event.message}`,
            });
            break;

        case 'interrupted':
            busy = false;
            settleTasks(items, edit);
            if (draft.text.trim() || draft.thinking.trim()) {
                edit().push({
                    kind: 'assistant',
                    id: `a-${event.at}-end`,
                    text: draft.text,
                    thinking: draft.thinking,
                });
            }
            edit().push({ kind: 'notice', id: `i-${event.at}`, tone: 'info', text: 'Stopped.' });
            draft = emptyDraft();
            break;

        case 'closed':
            busy = false;
            settleTasks(items, edit);
            break;

        default:
            break;
    }

    return { ...state, items, draft, busy, costUsd, turnStartAt, turnRates };
}

/** One event, on a list that is not the caller's to change. */
export function applyEvent(state, event) {
    return step(state, event, false);
}

/** A whole log, folded onto a list of its own in one pass. */
export function replay(events) {
    let state = { ...INITIAL, items: [] };
    for (const event of events) state = step(state, event, true);
    return state;
}

/**
 * A batch of live events onto the state as it stands: copied once, by the
 * first event that changes the list, and changed in place from there.
 */
export function applyBatch(previous, events) {
    let state = previous;
    for (const event of events) state = step(state, event, state.items !== previous.items);
    return state;
}

export const INITIAL = {
    items: [],
    draft: emptyDraft(),
    busy: false,
    costUsd: 0,
    // When the running turn's first message arrived, and each finished
    // turn's answer rate by that message's id, for the number beside the
    // turn's branch icon. Rebuilt by replay, so old turns get theirs too.
    turnStartAt: 0,
    turnRates: {},
    // How this conversation is paid for, and where the plan's window stands.
    // Both arrive from the runtime rather than being configured here.
    account: null,
    rateLimit: null,
    // `{ used, limit, percent, model, provider }`: the latest reply's tokens
    // against the model's context window, for the composer's ring.
    context: null,
    // What the runtime named the conversation. Empty until it has, and for
    // one it never named, where the first message stands in.
    title: '',
};
