import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    FOLLOW,
    GLOBAL,
    describe,
    describeSession,
    followScope,
    fromWire,
    globalScope,
    prune,
    toggle,
} from '../lib/assistant-scope';
import { useT } from '../i18n';

/**
 * The conversations open in the tab strip.
 *
 * A conversation used to live in a column beside the terminal, in a strip of
 * its own. It is a tab of the window now, next to the sessions, because the
 * agent is what the window is for and the sessions are what it works with.
 * The tab list itself is the app's, one array holding both kinds, so a chat
 * can be dragged past a session and filed in a group with it; what this hook
 * owns is everything about a conversation tab that is not the strip's
 * business: which servers it is pointed at, what it reports about itself, how
 * it is remembered between runs, and the handshake with the windows a
 * conversation can be lifted into.
 *
 * The conversations themselves never leave the main process. A tab holds an
 * id, and `AssistantConversation` rebuilds the transcript from the event log
 * behind it, which is what makes a restart survivable: the ids are written
 * out, the events are already on disk, and the next run reads both back.
 */

/** Where the open conversations are remembered. */
export const CONVERSATION_TABS_KEY = 'assistant.tabs';

/** The key the single conversation was kept under, adopted as the first tab. */
const LEGACY_KEY = 'assistant.conversation';

let sequence = 0;

/**
 * A conversation tab, holding the id of a conversation or nothing yet: the
 * component inside it starts one the moment it mounts, and reports the id.
 */
export function createConversationTab(conversationId = '', agentId = '') {
    sequence += 1;
    return {
        id: `chat-${Date.now().toString(36)}-${sequence.toString(36)}`,
        type: 'conversation',
        conversationId,
        // Whose it is: the tab hands it to the conversation it starts.
        agentId,
        // Which servers the tab is about. Owned by the tab because the tab is
        // where it is shown and changed.
        scope: followScope(),
    };
}

/**
 * The conversation tabs as they were left, or one fresh tab.
 *
 * `activeId` is empty when something other than a conversation was in front
 * at the last close, so the caller can leave the choice to the sessions being
 * restored rather than dragging the window back to a chat nobody was reading.
 */
export function readStoredConversationTabs() {
    try {
        // The same switch that gates the terminal tabs. "Restore tabs" in
        // Settings means every kind of tab, and a conversation coming back
        // while the sessions do not would make the switch look half broken.
        // The conversations themselves are kept either way: this only decides
        // whether they are open when the window appears.
        const stored = localStorage.getItem('restoreSessions') === 'false'
            ? null
            : JSON.parse(localStorage.getItem(CONVERSATION_TABS_KEY) || 'null');
        if (stored && Array.isArray(stored.tabs) && stored.tabs.length > 0) {
            const tabs = stored.tabs
                .filter(entry => entry && typeof entry === 'object')
                .map(entry => createConversationTab(String(entry.conversationId || ''), String(entry.agentId || '')));
            if (tabs.length > 0) {
                const active = Number(stored.active);
                const valid = Number.isInteger(active) && active >= 0 && active < tabs.length;
                return { tabs, activeId: valid ? tabs[active].id : '' };
            }
        }
    } catch {
        // Unreadable: start again below.
    }

    // The old single slot is only adopted when restoring is on: with it off,
    // a fresh tab is a fresh conversation, not the last one under another name.
    const restoring = localStorage.getItem('restoreSessions') !== 'false';
    const first = createConversationTab(restoring ? (localStorage.getItem(LEGACY_KEY) || '') : '');
    return { tabs: [first], activeId: first.id };
}

export default function useConversationTabs({
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    sessions,
    hosts,
    activeSessionId,
    /** False while the agent is switched off in Settings. */
    enabled = true,
}) {
    const t = useT();

    /** What each tab reports about itself: `{ title, busy }`, by tab id. */
    const [statuses, setStatuses] = useState({});

    // The list as it stands, for callbacks that must not close over a render.
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;
    const activeRef = useRef(activeTabId);
    activeRef.current = activeTabId;

    const conversationTabs = useMemo(
        () => tabs.filter(tab => tab.type === 'conversation'),
        [tabs],
    );

    /**
     * The ids held, as one string. Two arrays are two identities on every
     * render; the string only changes when the set does, which is what the
     * effects below should be keyed on.
     */
    const openKey = conversationTabs.map(tab => tab.conversationId).filter(Boolean).join(' ');
    const openConversationIds = useMemo(() => (openKey ? openKey.split(' ') : []), [openKey]);

    /* ------------------------------------------------------------------ *
     * Remembering
     * ------------------------------------------------------------------ */

    useEffect(() => {
        if (!enabled) return;
        const active = conversationTabs.findIndex(tab => tab.id === activeTabId);
        localStorage.setItem(CONVERSATION_TABS_KEY, JSON.stringify({
            tabs: conversationTabs.map(tab => ({ conversationId: tab.conversationId, agentId: tab.agentId || '' })),
            active,
        }));
        // The old single slot is what an older build would read, so it follows
        // the conversation in front.
        const current = conversationTabs[active]?.conversationId;
        if (current) localStorage.setItem(LEGACY_KEY, current);
    }, [conversationTabs, activeTabId, enabled]);

    // Every window reports what it holds, this one included: main is where "a
    // conversation is shown in one place" is enforced, and it can only do
    // that knowing both sides.
    useEffect(() => {
        if (!enabled) return;
        window.api.ai.setWindowTabs?.(openConversationIds);
    }, [openConversationIds, enabled]);

    /* ------------------------------------------------------------------ *
     * What a tab says about itself
     * ------------------------------------------------------------------ */

    const reportStatus = useCallback((tabId, status) => {
        setStatuses(current => {
            const held = current[tabId];
            if (held && held.title === status.title && held.busy === status.busy) return current;
            return { ...current, [tabId]: status };
        });
    }, []);

    const patch = useCallback((tabId, fn) => {
        setTabs(current => current.map(tab => (
            tab.id === tabId && tab.type === 'conversation' ? fn(tab) : tab
        )));
    }, [setTabs]);

    /** A tab learning which conversation it holds, or moving to another. */
    const setConversation = useCallback((tabId, conversationId) => {
        patch(tabId, tab => (tab.conversationId === conversationId ? tab : { ...tab, conversationId }));
    }, [patch]);

    /* ------------------------------------------------------------------ *
     * Scope: which servers each tab is about
     * ------------------------------------------------------------------ */

    const setScope = useCallback((tabId, next) => {
        patch(tabId, tab => ({ ...tab, scope: typeof next === 'function' ? next(tab.scope) : next }));
    }, [patch]);

    /**
     * A tab that takes on an existing conversation is pointed back at the
     * servers that conversation was about. Main keeps the selection per
     * conversation, so a tab moved from another window, opened from the
     * Conversations page, or restored after a restart reads it back rather
     * than starting from "follow". Each tab is read once; the answer is
     * applied only if nobody has touched the selection in the meantime, since
     * a choice made while the read was in flight beats what was stored.
     */
    const restored = useRef(new Set());
    useEffect(() => {
        for (const tab of conversationTabs) {
            if (!tab.conversationId || restored.current.has(tab.id)) continue;
            restored.current.add(tab.id);
            window.api.ai.history(tab.conversationId).then((past) => {
                if (!past?.found) return;
                const scope = fromWire(past);
                if (scope.mode === FOLLOW) return;
                setTabs(current => current.map(entry => (
                    entry.id === tab.id && entry.type === 'conversation' && entry.scope.mode === FOLLOW
                        ? { ...entry, scope }
                        : entry
                )));
            }).catch(() => {});
        }
    }, [conversationTabs, setTabs]);

    // A session a tab was pinned to can be closed underneath it, which would
    // otherwise leave it pointed at nothing with no sign of why. Pinned hosts
    // survive: an unconnected host is still somewhere to work.
    useEffect(() => {
        const open = sessions.map(session => session.sessionId);
        setTabs(current => {
            let changed = false;
            const next = current.map((tab) => {
                if (tab.type !== 'conversation') return tab;
                const pruned = prune(tab.scope, open);
                if (pruned === tab.scope) return tab;
                changed = true;
                return { ...tab, scope: pruned };
            });
            return changed ? next : current;
        });
    }, [sessions, setTabs]);

    /**
     * What the "current session" option names. Derived from the active
     * session rather than from any tab's scope: read off the scope it would
     * relabel itself the moment "All hosts" was picked.
     */
    const followLabel = useMemo(() => describeSession(
        sessions.find(session => session.sessionId === activeSessionId),
        t('assistant.nothingConnected'),
    ), [sessions, activeSessionId, t]);

    /** The selector's props for one tab, minus the scope itself. */
    const scopePropsFor = useCallback((tab) => ({
        onSetMode: (mode) => setScope(tab.id, mode === GLOBAL ? globalScope() : followScope()),
        onToggle: (kind, id) => setScope(tab.id, current => toggle(current, kind, id)),
        sessions,
        hosts,
        activeSessionId,
        followLabel,
        scopeLabel: describe(tab.scope, { sessions, hosts, activeSessionId }).label,
    }), [setScope, sessions, hosts, activeSessionId, followLabel]);

    /* ------------------------------------------------------------------ *
     * Opening and closing
     * ------------------------------------------------------------------ */

    /** A new tab at the end of the strip, brought to the front. */
    const addTab = useCallback((conversationId = '', agentId = '') => {
        const tab = createConversationTab(conversationId, agentId);
        setTabs(current => [...current, tab]);
        setActiveTabId(tab.id);
        return tab.id;
    }, [setTabs, setActiveTabId]);

    /**
     * A conversation asked for by id: brought to the front if a tab already
     * holds it, opened in a new one otherwise. What the Conversations page
     * does.
     */
    const openConversation = useCallback((conversationId, agentId = '') => {
        const holder = tabsRef.current.find(tab => (
            tab.type === 'conversation' && tab.conversationId === conversationId
        ));
        if (holder) {
            setActiveTabId(holder.id);
            return holder.id;
        }
        return addTab(conversationId, agentId);
    }, [addTab, setActiveTabId]);

    /**
     * Take tabs out of the strip. The conversation behind each is parked, not
     * closed: it stays on the Conversations page and can be resumed. Only the
     * query it was running is let go.
     *
     * The tab after the one in front takes its place, then the one before,
     * the way a browser does it; Home is the one before everything, so the
     * strip is never left pointing at nothing.
     */
    const dropTabs = useCallback((tabIds, { park = true } = {}) => {
        const going = new Set(tabIds);
        if (going.size === 0) return;

        const held = tabsRef.current;
        if (park) {
            for (const tab of held) {
                if (going.has(tab.id) && tab.type === 'conversation' && tab.conversationId) {
                    window.api.ai.park(tab.conversationId);
                }
            }
        }

        if (going.has(activeRef.current)) {
            const index = held.findIndex(tab => tab.id === activeRef.current);
            const next = held.slice(index + 1).find(tab => !going.has(tab.id))
                || [...held.slice(0, index)].reverse().find(tab => !going.has(tab.id));
            setActiveTabId(next ? next.id : 'home');
        }

        setTabs(current => current.filter(tab => !going.has(tab.id)));
        setStatuses(current => {
            const next = { ...current };
            for (const id of going) delete next[id];
            return next;
        });
    }, [setTabs, setActiveTabId]);

    /**
     * Throw a conversation away for good. Any tab holding it goes too, and
     * neither is parked first: there is nothing left to come back to.
     */
    const removeConversation = useCallback(async (conversationId) => {
        const holders = tabsRef.current
            .filter(tab => tab.type === 'conversation' && tab.conversationId === conversationId)
            .map(tab => tab.id);
        dropTabs(holders, { park: false });
        await window.api.ai.close(conversationId);
    }, [dropTabs]);

    /* ------------------------------------------------------------------ *
     * Windows of the agent's own
     * ------------------------------------------------------------------ */

    /** Lift these tabs into a window of their own. */
    const detachTabs = useCallback(async (tabIds) => {
        const ids = tabsRef.current
            .filter(tab => tabIds.includes(tab.id) && tab.type === 'conversation')
            .map(tab => tab.conversationId)
            .filter(Boolean);
        if (ids.length === 0) return;
        const result = await window.api.ai.detach(ids);
        if (result?.success) dropTabs(tabIds, { park: false });
    }, [dropTabs]);

    // Tabs handed to this strip from a window that closed or gave them back.
    // Anything already open here is only brought forward.
    useEffect(() => window.api.ai.onAdoptTabs?.(({ conversationIds }) => {
        if (!Array.isArray(conversationIds) || conversationIds.length === 0) return;
        const open = new Map(tabsRef.current
            .filter(tab => tab.type === 'conversation')
            .map(tab => [tab.conversationId, tab.id]));
        const fresh = conversationIds
            .filter(id => id && !open.has(id))
            .map(id => createConversationTab(id));
        if (fresh.length > 0) setTabs(current => [...current, ...fresh]);
        const first = fresh[0]?.id || open.get(conversationIds[0]);
        if (first) setActiveTabId(first);
    }), [setTabs, setActiveTabId]);

    // Another window has opened one of these, so it goes from here: neither
    // parked nor closed, since the other window is carrying it on.
    useEffect(() => window.api.ai.onReleaseTabs?.(({ conversationIds }) => {
        if (!Array.isArray(conversationIds) || conversationIds.length === 0) return;
        const holders = tabsRef.current
            .filter(tab => tab.type === 'conversation' && conversationIds.includes(tab.conversationId))
            .map(tab => tab.id);
        if (holders.length > 0) dropTabs(holders, { park: false });
    }), [dropTabs]);

    return {
        conversationTabs,
        openConversationIds,
        statuses,
        reportStatus,
        scopePropsFor,
        setConversation,
        addTab,
        openConversation,
        dropTabs,
        removeConversation,
        detachTabs,
    };
}
