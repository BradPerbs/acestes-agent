import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    collectPanes,
    createSplit,
    equalizeSplit,
    findPane,
    movePane,
    normalize,
    paneCount,
    removePane,
    resizeSplit,
    splitPane,
    swapPanes,
} from '../lib/panes';

/**
 * Split view for conversations.
 *
 * Terminal tabs already split via the pane tree in `lib/panes.js` plus
 * `SplitLayout.jsx` (absolute boxes, pointer-capture dividers, smooth
 * 0.22s geometry easing that is disabled mid-drag). Conversations were
 * single tabs only, so this hook gives them the same engine without
 * touching the tab model: a layout whose leaves are
 * `{ kind: 'pane', id, tabId }`, where `tabId` names a conversation tab
 * or is null for a picker.
 *
 * Only geometry plus the conversation behind each pane is persisted
 * (`assistant.split.v1`): tab ids are transient, so each pane stores the
 * `conversationId` and is reconciled against the open tabs on load.
 */

export const CONVERSATION_SPLIT_KEY = 'assistant.split.v1';

/** More than four chats side by side stops being useful. */
export const MAX_CONVERSATION_PANES = 4;

let sequence = 0;
const paneUid = () => {
    sequence += 1;
    return `csplit-${Date.now().toString(36)}-${sequence.toString(36)}`;
};

export const makeConversationPane = (tabId = null) => ({
    kind: 'pane',
    id: paneUid(),
    mode: 'conversation',
    tabId,
});

const isConversationPane = (node) => node?.kind === 'pane';

function readStoredSplit() {
    try {
        const raw = localStorage.getItem(CONVERSATION_SPLIT_KEY);
        if (!raw) return null;
        const stored = JSON.parse(raw);
        if (!stored?.layout) return null;
        return stored;
    } catch {
        return null;
    }
}

/**
 * Rebuild a layout from persisted `{ conversationId, sizes, direction }`
 * data, matching panes to currently open tabs. Panes with no match become
 * pickers so the geometry survives even when the chat does not.
 */
function rebuildLayout(node, tabByConversation) {
    if (!node || typeof node !== 'object') return null;
    if (node.kind === 'pane') {
        const tabId = node.conversationId ? tabByConversation.get(node.conversationId) || null : null;
        return { ...makeConversationPane(tabId), ...(node.conversationId ? { conversationId: node.conversationId } : {}) };
    }
    if (node.kind === 'split' && Array.isArray(node.children)) {
        const children = node.children.map((child) => rebuildLayout(child, tabByConversation)).filter(Boolean);
        if (children.length === 0) return null;
        if (children.length === 1) return children[0];
        const sizes = Array.isArray(node.sizes) && node.sizes.length === children.length
            ? normalize(node.sizes)
            : children.map(() => 1 / children.length);
        return createSplit(node.direction === 'column' ? 'column' : 'row', children, sizes);
    }
    return null;
}

function serializeLayout(node, conversationByTab) {
    if (!node) return null;
    if (isConversationPane(node)) {
        const conversationId = node.tabId ? conversationByTab.get(node.tabId) || '' : '';
        return { kind: 'pane', conversationId };
    }
    return {
        kind: 'split',
        direction: node.direction,
        sizes: [...node.sizes],
        children: node.children.map((child) => serializeLayout(child, conversationByTab)),
    };
}

/**
 * The layout a header drop produces, worked out without committing it.
 *
 * The drag overlay previews exactly this tree measured out, which is what
 * keeps the preview honest: removing the dragged pane can collapse the
 * tree first (two side-by-side panes stacked become full-width halves, not
 * quarters of the old slot), and only the simulated result shows that.
 */
export function applyConversationDrop(root, paneId, drop) {
    if (!root || !drop) return root;
    if (drop.kind === 'swap') {
        return swapPanes(root, paneId, drop.targetId);
    }
    if (drop.kind === 'edge') {
        const carried = findPane(root, paneId);
        const base = removePane(root, paneId);
        if (!carried || !base) return root;
        return createSplit(
            drop.direction,
            drop.before ? [carried, base] : [base, carried],
        );
    }
    return movePane(root, paneId, drop.targetId, drop.direction, drop.before);
}

export default function useConversationSplit({ tabs, activeTabId }) {
    const [layout, setLayout] = useState(null);
    const [focusedPaneId, setFocusedPaneId] = useState(null);

    const layoutRef = useRef(layout);
    layoutRef.current = layout;
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    const conversationTabs = useMemo(() => tabs.filter((t) => t.type === 'conversation'), [tabs]);
    const tabIds = useMemo(() => new Set(conversationTabs.map((t) => t.id)), [conversationTabs]);

    const panes = useMemo(() => (layout ? collectPanes(layout) : []), [layout]);
    const active = layout !== null;
    const split = panes.length > 1;

    // Restore once: match persisted conversationIds to the tabs that came back.
    const restored = useRef(false);
    useEffect(() => {
        if (restored.current) return;
        if (conversationTabs.length === 0) return;
        restored.current = true;
        const stored = readStoredSplit();
        if (!stored) return;
        const tabByConversation = new Map(
            conversationTabs.filter((t) => t.conversationId).map((t) => [t.conversationId, t.id]),
        );
        const next = rebuildLayout(stored.layout, tabByConversation);
        if (!next || paneCount(next) < 2) return;
        setLayout(next);
        const leaves = collectPanes(next);
        setFocusedPaneId(leaves[0]?.id || null);
    }, [conversationTabs]);

    // Persist geometry + which conversation each pane holds. Trailing
    // debounce: a divider drag commits a layout per pointer move, and a
    // synchronous storage write on each one would jank the drag it is
    // tracking. The last state still lands shortly after the pointer stops.
    useEffect(() => {
        if (!layout) {
            try { localStorage.removeItem(CONVERSATION_SPLIT_KEY); } catch { /* ignore */ }
            return undefined;
        }
        const timer = setTimeout(() => {
            try {
                const conversationByTab = new Map(
                    tabsRef.current
                        .filter((t) => t.type === 'conversation' && t.conversationId)
                        .map((t) => [t.id, t.conversationId]),
                );
                localStorage.setItem(CONVERSATION_SPLIT_KEY, JSON.stringify({
                    layout: serializeLayout(layoutRef.current, conversationByTab),
                }));
            } catch { /* ignore */ }
        }, 400);
        return () => clearTimeout(timer);
    }, [layout]);

    // A closed tab leaves a picker behind rather than collapsing the split
    // the user arranged. The conversation itself is parked by the tab close;
    // the geometry stays so another chat can be dropped into the slot.
    useEffect(() => {
        if (!layout) return;
        let changed = false;
        const walk = (node) => {
            if (node.kind === 'pane') {
                if (node.tabId && !tabIds.has(node.tabId)) {
                    changed = true;
                    return { ...node, tabId: null, conversationId: '' };
                }
                return node;
            }
            const children = node.children.map(walk);
            if (children.some((child, index) => child !== node.children[index])) {
                changed = true;
                return { ...node, children };
            }
            return node;
        };
        if (changed) setLayout((current) => (current ? walk(current) : current));
    }, [layout, tabIds]);

    const startSplit = useCallback((tabId, direction = 'row', otherTabId = null) => {
        const tabsNow = tabsRef.current.filter((t) => t.type === 'conversation');
        const current = tabsNow.find((t) => t.id === tabId) || tabsNow[0];
        if (!current) return;
        // Prefer a chat not already on screen so the split shows two
        // conversations, not one twice.
        const shown = new Set(layoutRef.current ? collectPanes(layoutRef.current).map((p) => p.tabId) : []);
        const other = (otherTabId && tabsNow.find((t) => t.id === otherTabId))
            || tabsNow.find((t) => t.id !== current.id && !shown.has(t.id))
            || null;
        const left = { ...makeConversationPane(current.id), conversationId: current.conversationId || '' };
        const right = { ...makeConversationPane(other?.id || null), conversationId: other?.conversationId || '' };
        const next = createSplit(direction, [left, right]);
        setLayout(next);
        setFocusedPaneId(left.id);
    }, []);

    const splitPaneById = useCallback((paneId, direction = 'row', otherTabId = null) => {
        const current = layoutRef.current;
        if (!current) return;
        if (paneCount(current) >= MAX_CONVERSATION_PANES) return;
        const tabsNow = tabsRef.current.filter((t) => t.type === 'conversation');
        const shown = new Set(collectPanes(current).map((p) => p.tabId));
        const other = (otherTabId && tabsNow.find((t) => t.id === otherTabId))
            || tabsNow.find((t) => !shown.has(t.id))
            || null;
        const addition = { ...makeConversationPane(other?.id || null), conversationId: other?.conversationId || '' };
        setLayout(splitPane(current, paneId, direction, addition));
        setFocusedPaneId(addition.id);
    }, []);

    const closePane = useCallback((paneId) => {
        const current = layoutRef.current;
        if (!current) return;
        const next = removePane(current, paneId);
        if (!next || paneCount(next) < 2) {
            // Back to single-tab mode; the remaining chat stays in front.
            const remaining = next ? collectPanes(next)[0] : null;
            setLayout(null);
            setFocusedPaneId(null);
            return remaining?.tabId || null;
        }
        setLayout(next);
        setFocusedPaneId(collectPanes(next)[0]?.id || null);
        return null;
    }, []);

    const exitSplit = useCallback(() => {
        setLayout(null);
        setFocusedPaneId(null);
    }, []);

    const setPaneTab = useCallback((paneId, tabId) => {
        const tab = tabsRef.current.find((t) => t.id === tabId && t.type === 'conversation');
        if (!tab) return;
        setLayout((current) => {
            if (!current) return current;
            // One conversation, one pane: move it rather than showing it twice.
            const holder = collectPanes(current).find((p) => p.tabId === tabId && p.id !== paneId);
            const base = holder ? removePane(current, holder.id) || current : current;
            const walk = (node) => {
                if (node.kind === 'pane') {
                    if (node.id !== paneId) return node;
                    return { ...node, tabId: tab.id, conversationId: tab.conversationId || '' };
                }
                return { ...node, children: node.children.map(walk) };
            };
            return walk(base);
        });
        setFocusedPaneId(paneId);
    }, []);

    const focusPane = useCallback((paneId) => {
        setFocusedPaneId(paneId);
    }, []);

    /**
     * A header drop, from the drag overlay in ConversationSplitView.
     *
     * `dock` carries a pane beside another pane's side, `edge` docks it
     * against the whole view (the Windows snap), and `swap` exchanges two
     * slots without touching the shape. Moves never add panes, so the max
     * needs no check here. The dropped pane takes focus, the way a window
     * you just placed stays in your hand.
     */
    const movePaneTo = useCallback((paneId, drop) => {
        if (!drop) return;
        setLayout((current) => applyConversationDrop(current, paneId, drop));
        setFocusedPaneId(paneId);
    }, []);

    const handleResizeSplit = useCallback((splitId, sizes) => {
        setLayout((current) => (current ? resizeSplit(current, splitId, sizes) : current));
    }, []);

    const handleEqualizeSplit = useCallback((splitId) => {
        setLayout((current) => (current ? equalizeSplit(current, splitId) : current));
    }, []);

    // One identity until something in it moves: every handler below is
    // stable, so without this the object itself would still be new on each
    // render and take every consumer's memo and effect with it.
    return useMemo(() => ({
        layout,
        panes,
        active,
        split,
        focusedPaneId,
        startSplit,
        splitPaneById,
        closePane,
        exitSplit,
        setPaneTab,
        focusPane,
        movePaneTo,
        handleResizeSplit,
        handleEqualizeSplit,
    }), [
        layout,
        panes,
        active,
        split,
        focusedPaneId,
        startSplit,
        splitPaneById,
        closePane,
        exitSplit,
        setPaneTab,
        focusPane,
        movePaneTo,
        handleResizeSplit,
        handleEqualizeSplit,
    ]);
}
