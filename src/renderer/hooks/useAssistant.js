import { useCallback, useEffect, useRef, useState } from 'react';
import { questionKey } from '../lib/approvals';
import { INITIAL, applyEvent, applyBatch, replay } from '../lib/transcript-reducer';

/**
 * One assistant conversation, as the panel sees it.
 *
 * The conversation itself lives in the main process. This hook holds an id, a
 * subscription to its event stream, and the reduction of that stream into
 * something renderable. Nothing here is the source of truth, which is what
 * makes a window reload survivable: on mount it asks for the events it missed
 * and replays them through the same reducer the live stream uses, so a
 * restored panel and one that never closed cannot disagree.
 *
 * Which conversation it is on is the caller's to remember: the tab that owns
 * this hook hands in the id it was left with and is told whenever the hook
 * moves to another one. The hook used to keep that in localStorage itself,
 * which was fine for one conversation and wrong for several.
 */

/**
 * What ends a turn, and with it any answer being held for calls that were
 * emitted but never asked. Consent does not cross a turn: whatever the model
 * was doing when it was told yes is over, and the next thing it tries is a new
 * question even if it is spelled the same way.
 */
const ENDS_TURN = new Set(['result', 'error', 'interrupted', 'closed', 'user-message']);

/** How often typing in one conversation asks main to have its runtime up. See `warm`. */
const WARM_EVERY = 5000;

/**
 * A conversation read back, named the way the list names it. The log is
 * capped, so a long chat has lost its first message and the event that
 * named it, and the tab would otherwise fall back to a recent message.
 */
function restore(past) {
    const state = replay(past.events);
    return past.title ? { ...state, title: past.title } : state;
}

/**
 * The panel's target, as the main process takes it: a mode, the session a tool
 * call falls back to when it names none, and the explicit set a pinned scope
 * fences the conversation to. Built by `lib/assistant-scope`.
 */
export default function useAssistant({
    scope,
    sessionId,
    sessionIds = [],
    hostIds = [],
    /** Whose conversation to start. Left out, the selected agent's. */
    agentId = '',
    enabled = true,
    /** The conversation to pick up, if the caller was left holding one. */
    conversationId: given = '',
    /** Told the id whenever this hook starts or switches to a conversation. */
    onConversationChange,
    /**
     * The runtime, model and effort a new conversation starts pinned to, or
     * null for the agent's default. One picked up from the history keeps its own.
     */
    startPin = null,
}) {
    const [state, setState] = useState(INITIAL);

    /**
     * Events in, one render per frame out.
     *
     * A runtime streams a reply a few words at a time, and a busy turn lands a
     * tool call and its result in the same breath, dozens a second. Each used
     * to be a render of its own. They are queued here and folded in together
     * on the next frame, in the order they came, so a burst of forty is one
     * render and a quiet trickle is no slower than before. The timeout is for
     * a minimised window, where frames stop coming.
     *
     * Everything that changes the transcript goes through the same queue, the
     * user's own clicks included, so an answer cannot overtake the question
     * it answers.
     */
    const pending = useRef([]);
    const scheduled = useRef({ frame: 0, timeout: 0 });
    const flush = useCallback(() => {
        cancelAnimationFrame(scheduled.current.frame);
        clearTimeout(scheduled.current.timeout);
        scheduled.current = { frame: 0, timeout: 0 };
        const batch = pending.current;
        if (batch.length === 0) return;
        pending.current = [];
        setState(previous => applyBatch(previous, batch));
    }, []);
    const dispatch = useCallback((event) => {
        pending.current.push(event);
        if (scheduled.current.frame || scheduled.current.timeout) return;
        scheduled.current = {
            frame: requestAnimationFrame(flush),
            timeout: setTimeout(flush, 100),
        };
    }, [flush]);
    /** A whole transcript in place of this one: what was queued for it goes. */
    const replaceState = useCallback((next) => {
        pending.current = [];
        setState(next);
    }, []);
    useEffect(() => () => {
        cancelAnimationFrame(scheduled.current.frame);
        clearTimeout(scheduled.current.timeout);
    }, []);
    const [pinned, setPinned] = useState(null);
    const startPinRef = useRef(null);
    startPinRef.current = startPin;
    // A tab with no conversation yet shows the pick it will start on.
    const [conversationId, setConversationId] = useState('');
    const shownPin = pinned || (conversationId ? null : startPin);
    const pinnedRef = useRef(null);
    pinnedRef.current = shownPin;
    // The run policy overriding the approval menu ('read-only', 'park',
    // 'full'), or null for the agent's own mode. Mirrors `pinned` above.
    const [runPolicy, setRunPolicy] = useState(null);
    // `{ parentId, parentTitle }` when this is a subagent's transcript, read
    // only, opened from the conversation that started it. Null otherwise.
    const [subagent, setSubagent] = useState(null);
    const [starting, setStarting] = useState(true);
    const [failure, setFailure] = useState('');
    const [conversations, setConversations] = useState([]);
    const conversationRef = useRef('');

    // The callback as it stands, so the effects below need not be rebuilt for
    // a caller that passes a new function each render.
    const onChangeRef = useRef(onConversationChange);
    onChangeRef.current = onConversationChange;

    /** Adopt an id: locally, and by telling whoever remembers it. */
    const adopt = useCallback((id) => {
        setConversationId(id);
        onChangeRef.current?.(id);
    }, []);

    /**
     * Answers given for calls that have not asked yet.
     *
     * A card covers every call the model has already emitted asking the same
     * thing, and names each of their servers on it, because "run this on those
     * three" is one decision. An agent that runs its tool calls one at a time
     * only asks about the second once the first has been answered, so the
     * answer waits here for it: question key -> the verdict and the exact set of
     * sessions it was given for.
     *
     * Deliberately narrow. It matches only a call whose tool, arguments and
     * target were all on the card that was answered, and it is dropped the
     * moment the turn ends. Anything else asks.
     */
    const held = useRef(new Map());

    // Kept in a ref as well so the event subscription, which is set up once,
    // can filter on the current id without being torn down and rebuilt every
    // time the id changes.
    conversationRef.current = conversationId;

    /**
     * The target, as one value and as one dependency.
     *
     * Two arrays in a dependency list are two new identities on every render,
     * which would push the scope over IPC on each one. The key is what the
     * effect watches; the ref is what it sends, so a caller that does not
     * memoise its arrays still gets exactly one call per real change.
     */
    const targetKey = `${scope}|${sessionId}|${sessionIds.join(',')}|${hostIds.join(',')}`;
    const targetRef = useRef(null);
    targetRef.current = { scope, sessionId, sessionIds, hostIds, agentId };

    /* Adopt the conversation from before a reload, or open a new one. */
    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;

        (async () => {
            try {
                if (given) {
                    const past = await window.api.ai.history(given);
                    if (cancelled) return;
                    if (past?.found) {
                        adopt(given);
                        replaceState(restore(past));
                        setPinned(past.pinned || null);
                        setRunPolicy(past.runPolicy || null);
                        setSubagent(past.subagent || null);
                        setStarting(false);
                        return;
                    }
                }

                // Nothing is started for a fresh tab. The conversation is made
                // on the first message, so a tab opened and left leaves nothing
                // behind in the list.
                setStarting(false);
            } catch (error) {
                if (!cancelled) {
                    setFailure(error.message || 'The assistant could not be started');
                    setStarting(false);
                }
            }
        })();

        return () => { cancelled = true; };
        // Deliberately once: a scope change moves the existing conversation
        // rather than starting a new one, which is handled below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled]);

    /**
     * Answer one approval, in the transcript and over IPC.
     *
     * The card is marked locally straight away. It is the thing the user just
     * clicked, and waiting for the round trip to grey it out reads as a dropped
     * click.
     */
    const settle = useCallback((requestId, approved, message) => {
        dispatch({
            type: 'approval-settled',
            requestId,
            status: approved ? 'approved' : 'denied',
            feedback: approved ? '' : message,
            at: Date.now(),
        });
        window.api.ai.approve(
            requestId,
            approved,
            approved ? '' : (message || 'The user declined that.')
        );
    }, [dispatch]);

    /**
     * Answer one question, in the transcript and over IPC. Marked locally
     * first for the same reason an approval is: the click should land.
     */
    // `send` is defined further down; the answer below reaches it through a
    // ref so a question the agent stopped waiting on can still be answered.
    const sendRef = useRef(null);

    const answer = useCallback(async (requestId, text, chosen = false, secret = false) => {
        const reply = String(text || '').trim();
        dispatch({
            type: 'question-settled',
            requestId,
            status: reply ? 'answered' : 'dismissed',
            // A secret is never in the transcript, not even this window's copy.
            answer: secret && reply ? '••••' : reply,
            at: Date.now(),
        });
        const taken = await window.api.ai.answer(requestId, reply, chosen);
        // Nobody was waiting any more: the agent handed the turn back while
        // the card sat there. The answer goes as the next message instead,
        // which is what the agent was told would happen. Never a secret,
        // though: a message is exactly where one must not go.
        if (taken === false && reply && !secret) await sendRef.current?.(reply);
    }, [dispatch]);

    /* A secret stored mid-conversation was masked out of its past: replay it. */
    useEffect(() => {
        if (!enabled || !window.api.ai.onHistoryScrubbed) return undefined;
        return window.api.ai.onHistoryScrubbed(({ conversationId: id }) => {
            if (id !== conversationRef.current) return;
            window.api.ai.history(id).then((past) => {
                if (past?.found && id === conversationRef.current) {
                    replaceState(previous => ({ ...restore(past), busy: previous.busy, draft: previous.draft }));
                }
            }).catch(() => {});
        });
    }, [enabled]);

    /* The live stream. */
    useEffect(() => {
        if (!enabled) return undefined;
        const off = window.api.ai.onEvent(({ conversationId: id, event }) => {
            if (id !== conversationRef.current) return;
            dispatch(event);

            if (ENDS_TURN.has(event.type)) {
                held.current.clear();
                return;
            }

            // A question already answered on a card that named this server.
            // Applied after the event above, so the transcript has the row
            // before it is told the row has been answered.
            if (event.type === 'approval-request') {
                const answer = held.current.get(questionKey(event));
                if (answer && event.sessionId && answer.sessions.has(event.sessionId)) {
                    settle(event.requestId, answer.approved, answer.message);
                }
            }
        });
        return off;
    }, [enabled, settle, dispatch]);

    /**
     * Follow the pane the panel is pointed at, or the set it is pinned to.
     *
     * Not on the turn a conversation is adopted: main already holds that
     * conversation's selection, and it is the one the tab is about to read
     * back and show. Pushing the tab's own starting point first would
     * overwrite the stored selection with "follow" before it was read, which
     * is how a pinned set used to be lost on the way to another window.
     */
    const scopedFor = useRef('');
    useEffect(() => {
        if (!conversationId) return;
        if (scopedFor.current !== conversationId) {
            scopedFor.current = conversationId;
            return;
        }
        window.api.ai.setScope(conversationId, targetRef.current);
        // `targetKey` is the target, flattened to something a dependency list
        // can compare. See the note where it is built.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conversationId, targetKey]);

    /**
     * The conversation this tab is on, made now if it has none yet.
     *
     * Made when there is something to say rather than when the tab opened:
     * the first keystroke (see `warm`) or the send. The ref is set here as
     * well as through state, so an event arriving on the heels of the send is
     * not filtered out by a render that has not happened. One at a time, so a
     * warm-up and a quick send share the one being made.
     */
    const creating = useRef(null);
    const ensureConversation = useCallback(async () => {
        if (conversationRef.current) return conversationRef.current;
        if (!creating.current) {
            creating.current = (async () => {
                const created = await window.api.ai.start(targetRef.current);
                const id = created.conversationId;
                conversationRef.current = id;
                adopt(id);
                // A model picked, or remembered, before there was a
                // conversation to pin it to.
                const pin = pinnedRef.current;
                if (pin) {
                    setPinned(pin);
                    await window.api.ai.setModel?.(id, pin);
                }
                return id;
            })().finally(() => { creating.current = null; });
        }
        return creating.current;
    }, [adopt]);

    /** `mentions` are `{ kind, id }`; main reads each record itself. Files are `{ name, mediaType, text }`. */
    const send = useCallback(async (text, images = [], mentions = [], files = []) => {
        let id;
        try {
            id = await ensureConversation();
        } catch (error) {
            setFailure(error.message || 'The assistant could not be started');
            return;
        }
        const result = await window.api.ai.send(id, text, images, mentions, files);
        if (!result?.success && result?.message) {
            dispatch({
                type: 'error', message: result.message, at: Date.now(),
            });
        }
    }, [ensureConversation, dispatch]);

    /**
     * Start the runtime while the message is still being written.
     *
     * The composer calls this as the person types. Bringing a runtime up is
     * most of what a first message waits for (the CLI, then its MCP servers),
     * and typing the message takes longer than that, so by the send it is
     * done. Nothing goes to a model; main leaves a running or busy
     * conversation alone. Once per conversation every few seconds: the rest
     * of the keystrokes stop here rather than crossing to main for nothing.
     */
    const lastWarm = useRef({ id: '', at: 0 });
    const warm = useCallback(async () => {
        if (!enabled || subagent || !window.api.ai.warm) return;
        const at = Date.now();
        if (lastWarm.current.id === (conversationRef.current || '') && at - lastWarm.current.at < WARM_EVERY) return;
        lastWarm.current = { id: conversationRef.current || '', at };
        try {
            const id = await ensureConversation();
            lastWarm.current = { id, at };
            await window.api.ai.warm(id);
        } catch {
            // The send starts it and says what is wrong.
        }
    }, [enabled, subagent, ensureConversation]);

    const interrupt = useCallback(() => {
        if (conversationId) window.api.ai.interrupt(conversationId);
    }, [conversationId]);

    /**
     * Answer one card, which is one question however many calls it covers.
     *
     * `message` is what to do instead, when the user turned the call down with
     * something to say. It goes back as the tool's own result, so the model
     * reads it as the answer to the call it just made rather than as a new
     * instruction that arrived from nowhere.
     *
     * The calls still queued behind this question are not answered here, since
     * they have not asked yet. The verdict is held for them under the servers
     * the card named, and applied as each one arrives. See `held`.
     */
    const respond = useCallback((group, approved, message = '') => {
        if (group.queued.length > 0) {
            held.current.set(group.key, {
                approved,
                message,
                sessions: new Set(group.queued.map(entry => entry.sessionId)),
            });
        }
        for (const approval of group.items) settle(approval.requestId, approved, message);
    }, [settle]);

    /** What the history menu lists. Asked for rather than pushed. */
    const refreshConversations = useCallback(async () => {
        try {
            setConversations(await window.api.ai.list() || []);
        } catch {
            // The menu just shows what it had.
        }
    }, []);

    useEffect(() => {
        if (enabled && conversationId) refreshConversations();
    }, [enabled, conversationId, refreshConversations]);

    /** Pin a conversation just made to the pick new ones start on, if any. */
    const startOn = useCallback(async (id) => {
        const pin = startPinRef.current;
        if (!pin) return null;
        const result = await window.api.ai.setModel?.(id, pin);
        return result && !result.error ? result.pinned || null : null;
    }, []);

    /**
     * Start a new conversation, parking the one on screen.
     *
     * Parked, not closed: the transcript stays reachable from the history menu
     * and can be resumed. Only the running query is given up.
     */
    const reset = useCallback(async () => {
        // Whatever was being held for the old conversation's last turn belongs
        // to a conversation nobody is looking at any more.
        held.current.clear();
        if (conversationId) await window.api.ai.park(conversationId);
        const created = await window.api.ai.start(targetRef.current);
        adopt(created.conversationId);
        replaceState(INITIAL);
        setPinned(await startOn(created.conversationId));
        setRunPolicy(null);
        setSubagent(null);
    }, [conversationId, adopt, startOn]);

    /** Go back to an earlier conversation, replaying it through the reducer. */
    const open = useCallback(async (id) => {
        if (!id || id === conversationId) return;
        held.current.clear();
        const past = await window.api.ai.history(id);
        if (!past?.found) {
            await refreshConversations();
            return;
        }
        if (conversationId) await window.api.ai.park(conversationId);
        adopt(id);
        replaceState(restore(past));
        setPinned(past.pinned || null);
        setRunPolicy(past.runPolicy || null);
        setSubagent(past.subagent || null);
    }, [conversationId, refreshConversations, adopt]);

    /**
     * Pin this conversation to a runtime, model and effort, over the agent's
     * defaults. A fresh tab has no conversation yet, so the pick is held here
     * and goes with the first message, which is what makes one.
     */
    const pinModel = useCallback(async (patch) => {
        if (!conversationId) {
            const picked = Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value));
            setPinned((previous) => {
                const next = { ...(previous || startPinRef.current || {}), ...picked };
                // An empty account is a choice too: back to the agent's own,
                // rather than keeping the one picked before.
                if (patch && 'account' in patch && !patch.account) delete next.account;
                return next;
            });
            return;
        }
        const result = await window.api.ai.setModel?.(conversationId, patch);
        if (result && !result.error) setPinned(result.pinned || null);
    }, [conversationId]);

    /**
     * Throw one away for good. Deleting the conversation being read leaves the
     * panel pointed at nothing, so it opens a fresh one in its place.
     */
    const remove = useCallback(async (id) => {
        if (!id) return;
        held.current.clear();
        await window.api.ai.close(id);
        if (id === conversationId) {
            const created = await window.api.ai.start(targetRef.current);
            adopt(created.conversationId);
            replaceState(INITIAL);
            setPinned(await startOn(created.conversationId));
            setRunPolicy(null);
            setSubagent(null);
        }
        await refreshConversations();
    }, [conversationId, refreshConversations, adopt, startOn]);

    /**
     * Put back the files a turn changed. The card follows the event main
     * sends when it is done, so every window showing this conversation
     * changes together; the answer is returned for what went wrong.
     */
    const revertTurn = useCallback(async (turnId) => {
        if (!conversationId) return { success: false };
        return window.api.ai.revertTurn(conversationId, turnId);
    }, [conversationId]);

    /** A new conversation holding this one up to the end of a turn. */
    const branchTurn = useCallback(async (turnId) => {
        if (!conversationId) return { success: false };
        return window.api.ai.branch(conversationId, turnId);
    }, [conversationId]);

    sendRef.current = send;

    return {
        revertTurn,
        branchTurn,
        items: state.items,
        draft: state.draft,
        busy: state.busy,
        costUsd: state.costUsd,
        turnRates: state.turnRates,
        account: state.account,
        rateLimit: state.rateLimit,
        context: state.context,
        title: state.title,
        conversationId,
        conversations,
        // The runtime, model and effort this conversation is pinned to, or
        // null for the agent's own settings.
        pinned: shownPin,
        pinModel,
        // The run policy overriding the approval menu, or null. The
        // composer shows this while it is set (see ApprovalMenu).
        runPolicy,
        subagent,
        starting,
        failure,
        send,
        warm,
        interrupt,
        respond,
        answer,
        reset,
        open,
        remove,
        refreshConversations,
    };
}

export { applyEvent };
