import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cancel01Icon, CommandLineIcon, PlusSignIcon, Unlink01Icon } from 'hugeicons-react';
import SplitLayout from '../panes/SplitLayout';
import ConversationView from './ConversationView';
import ConversationPaneSwitcher from './ConversationPaneSwitcher';
import AgentMark from './AgentMark';
import { OsIcon, hostOs } from '../../lib/os-icons';
import { PANE_HEADER_HEIGHT } from '../../lib/layout';
import { HAIRLINE, HeaderButton } from './AssistantConversation';
import { useT } from '../../i18n';
import { MAX_CONVERSATION_PANES, SPLIT_SESSION_HEADER, applyConversationDrop } from '../../hooks/useConversationSplit';
import { collectPanes, measureLayout, paneCount } from '../../lib/panes';

/**
 * Two or more conversations side by side, resizable the same smooth way
 * terminal panes are: the same `SplitLayout` (absolute boxes, so a chat
 * never remounts mid-drag) and the same divider (pointer capture, shares
 * committed per move, geometry eased at 0.22s when not dragging).
 */

/** A press becomes a drag past this many pixels, so clicks still click. */
const DRAG_THRESHOLD = 6;

/** How close to the view edge a drag counts as docking to that edge. */
const EDGE_SIZE = 28;

/** Anything interactive never starts a pane drag, whatever it sits in. */
const INTERACTIVE = 'button,input,select,textarea,a,[role="menu"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]';

const pxBox = (box, rect) => {
    const left = box.fracX * rect.width + box.pxX;
    const top = box.fracY * rect.height + box.pxY;
    return {
        left,
        top,
        right: left + box.fracW * rect.width + box.pxW,
        bottom: top + box.fracH * rect.height + box.pxH,
    };
};

/**
 * What the pointer is offering, in layout terms.
 *
 * Near a view edge it is a Windows-style snap against that edge. Over a
 * pane it is one of four docks beside it, or a swap when aimed at its
 * middle. Over the dragged pane itself, or nowhere at all, it is nothing
 * and releasing lets go without touching the layout.
 */
function zoneForPoint(x, y, width, height, rects, draggedId) {
    if (x < EDGE_SIZE) return { kind: 'edge', direction: 'row', before: true };
    if (x > width - EDGE_SIZE) return { kind: 'edge', direction: 'row', before: false };
    if (y < EDGE_SIZE) return { kind: 'edge', direction: 'column', before: true };
    if (y > height - EDGE_SIZE) return { kind: 'edge', direction: 'column', before: false };

    const hit = rects.find(
        (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
    );
    if (!hit || hit.id === draggedId) return null;

    const w = hit.right - hit.left;
    const h = hit.bottom - hit.top;
    if (Math.hypot(x - (hit.left + w / 2), y - (hit.top + h / 2)) < 0.22 * Math.min(w, h)) {
        return { kind: 'swap', targetId: hit.id };
    }

    const distances = [
        [x - hit.left, { kind: 'dock', targetId: hit.id, direction: 'row', before: true }],
        [hit.right - x, { kind: 'dock', targetId: hit.id, direction: 'row', before: false }],
        [y - hit.top, { kind: 'dock', targetId: hit.id, direction: 'column', before: true }],
        [hit.bottom - y, { kind: 'dock', targetId: hit.id, direction: 'column', before: false }],
    ];
    distances.sort((a, b) => a[0] - b[0]);
    return distances[0][1];
}

const sameZone = (a, b) => (
    (a === null && b === null)
    || (a && b && a.kind === b.kind && a.targetId === b.targetId
        && a.direction === b.direction && a.before === b.before)
);

const PICK_ROW = `w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-left transition-colors
    hover:bg-gray-100 dark:hover:bg-surface-control outline-none
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;

const PICK_HEADING = 'px-2.5 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500';

function ConversationPanePicker({ tabs, sessionTabs = [], usedTabIds, onPick, onNew, onClose }) {
    const t = useT();
    const choices = tabs.filter((tab) => !usedTabIds.has(tab.id));
    const sessions = sessionTabs.filter((tab) => !usedTabIds.has(tab.id));
    return (
        <div className="absolute inset-0 flex flex-col">
            <div
                data-pane-header="true"
                className={`shrink-0 px-3 flex items-center gap-2 border-b ${HAIRLINE} conv-pane-header`}
                style={{ height: PANE_HEADER_HEIGHT }}
            >
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-500 dark:text-neutral-400">
                    {t('assistant.splitPickTitle')}
                </span>
                {onClose && (
                    <HeaderButton
                        title={t('assistant.closeSplitPane')}
                        icon={<Cancel01Icon size={16} strokeWidth={1.75} />}
                        onClick={onClose}
                    />
                )}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
                {sessionTabs.length > 0 && (
                    <div className={PICK_HEADING}>{t('assistant.splitPickConversations')}</div>
                )}
                {choices.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => onPick(tab.id)}
                        className="w-full flex items-center gap-2 px-2.5 py-2 rounded-xl text-left transition-colors
                            hover:bg-gray-100 dark:hover:bg-surface-control outline-none
                            focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
                    >
                        <AgentMark size={16} look={tab.agentLook} />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-900 dark:text-white">
                            {tab.title}
                        </span>
                        {tab.busy && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                    </button>
                ))}
                {choices.length === 0 && sessions.length === 0 && (
                    <p className="px-2 py-4 text-xs text-gray-500 dark:text-neutral-400">
                        {t('assistant.splitPickEmpty')}
                    </p>
                )}
                <button
                    type="button"
                    onClick={onNew}
                    className={`${PICK_ROW} text-xs font-medium text-gray-600 dark:text-neutral-300`}
                >
                    <PlusSignIcon size={15} strokeWidth={2} />
                    {t('assistant.splitPickNew')}
                </button>

                {sessions.length > 0 && (
                    <>
                        <div className={PICK_HEADING}>{t('assistant.splitPickSessions')}</div>
                        {sessions.map((tab) => (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => onPick(tab.id)}
                                className={PICK_ROW}
                            >
                                <OsIcon os={hostOs(tab.host)} distro={tab.host?.distro} className="w-4 h-4 shrink-0" />
                                <span className="min-w-0 flex-1 truncate text-xs font-medium text-gray-900 dark:text-white">
                                    {tab.title}
                                </span>
                                <span
                                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.connected ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-neutral-600'}`}
                                />
                            </button>
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

/**
 * A terminal tab's pane in a conversation split.
 *
 * Only the head is drawn here. The terminal itself stays mounted where
 * terminal tabs live and is laid over the rest of this pane from App.jsx,
 * so it keeps its session and scrollback through every rearrangement. This
 * strip is what makes it a pane of the split: it drags like a chat header,
 * switches what the pane shows, and closes the pane without closing the
 * session.
 */
function SessionPaneHeader({ tab, conversationTabs, sessionTabs, onSwitch, onNew, onClose, onExit }) {
    const t = useT();
    return (
        <div className="absolute inset-0 flex flex-col bg-white dark:bg-surface-raised">
            <div
                data-pane-header="true"
                className={`shrink-0 pl-2 pr-1 flex items-center gap-1 border-b ${HAIRLINE} conv-pane-header`}
                style={{ height: SPLIT_SESSION_HEADER }}
            >
                <ConversationPaneSwitcher
                    tab={tab}
                    title={tab.title}
                    icon={<CommandLineIcon size={15} strokeWidth={1.75} className="shrink-0 text-gray-500 dark:text-neutral-400" />}
                    tabs={conversationTabs}
                    sessionTabs={sessionTabs}
                    onSwitch={onSwitch}
                    onNew={onNew}
                />
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        title={t('assistant.closeSplitPane')}
                        className="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg text-gray-500 dark:text-neutral-400
                            hover:bg-gray-100 dark:hover:bg-surface-control transition-colors"
                    >
                        <Cancel01Icon size={14} strokeWidth={1.75} />
                    </button>
                )}
                {onExit && (
                    <button
                        type="button"
                        onClick={onExit}
                        title={t('assistant.exitSplit')}
                        className="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg text-gray-500 dark:text-neutral-400
                            hover:bg-gray-100 dark:hover:bg-surface-control transition-colors"
                    >
                        <Unlink01Icon size={14} strokeWidth={1.75} />
                    </button>
                )}
            </div>
        </div>
    );
}

function ConversationSplitView({
    layout,
    focusedPaneId,
    stripTabs,
    tabById,
    /** Terminal tabs in strip form, and the same keyed by id. */
    sessionTabs = [],
    sessionById = new Map(),
    conversationStatuses,
    sessions,
    hosts,
    activeSessionId,
    activeAgentId,
    lookFor,
    scopePropsFor,
    setConversation,
    reportConversationStatus,
    onOpenSettings,
    onOpenSnippets,
    onDetachTab,
    onCloseTab,
    onNewConversation,
    onOpenConversation,
    onPickTab,
    onNewIntoPane,
    onFocusPane,
    onSplitPane,
    onMovePane,
    onClosePane,
    onExitSplit,
    canSplit,
    onResizeSplit,
    onEqualizeSplit,
}) {
    const count = paneCount(layout);
    const usedTabIds = new Set(
        collectPanes(layout).map((pane) => pane.tabId).filter(Boolean),
    );

    // The overlay shares SplitLayout's own coordinate space (same inset),
    // so measured boxes land on the panes without any conversion.
    const overlayRef = useRef(null);
    const ghostRef = useRef(null);
    const zoneRef = useRef(null);
    const dragRef = useRef(null);
    const [drag, setDrag] = useState(null);
    const suppressClick = useRef(false);

    const titleOf = useCallback((paneId) => {
        const pane = collectPanes(layout).find((entry) => entry.id === paneId);
        const session = pane?.tabId ? sessionById.get(pane.tabId) : null;
        if (session) return { title: session.title || '', look: null, session: true };
        const tab = pane?.tabId ? tabById.get(pane.tabId) : null;
        const strip = tab ? stripTabs.find((entry) => entry.id === tab.id) : null;
        return {
            title: strip?.title || tab?.title || '',
            look: tab?.agentLook || lookFor(tab?.agentId),
            session: false,
        };
    }, [layout, tabById, sessionById, stripTabs, lookFor]);

    // One global click trap: a drag released over a header button must not
    // click it. Armed only by a real drag, so ordinary clicks pass through.
    useEffect(() => {
        const trap = (event) => {
            if (!suppressClick.current) return;
            suppressClick.current = false;
            event.stopPropagation();
            event.preventDefault();
        };
        document.addEventListener('click', trap, true);
        return () => document.removeEventListener('click', trap, true);
    }, []);

    useEffect(() => () => document.body.classList.remove('conv-pane-dragging'), []);

    const endDrag = useCallback((dropped) => {
        const dragState = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        document.body.classList.remove('conv-pane-dragging');
        // The highlight is positioned through a ref, so React will not take
        // it away: releasing must hide it, on a drop and on a cancel alike.
        if (zoneRef.current) zoneRef.current.style.display = 'none';
        if (dragState?.lifted) suppressClick.current = true;
        if (dropped && dragState?.drop) onMovePane(dragState.paneId, dragState.drop);
    }, [onMovePane]);

    const updateGhost = useCallback((clientX, clientY) => {
        const ghost = ghostRef.current;
        if (ghost) ghost.style.transform = `translate(${clientX + 14}px, ${clientY + 10}px)`;
    }, []);

    const updateZone = useCallback((clientX, clientY) => {
        const dragState = dragRef.current;
        const overlay = overlayRef.current;
        if (!dragState || !overlay) return;
        const rect = dragState.rect;
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const zone = (x >= 0 && x <= rect.width && y >= 0 && y <= rect.height)
            ? zoneForPoint(x, y, rect.width, rect.height, dragState.rects, dragState.paneId)
            : null;
        if (sameZone(zone, dragState.drop)) return;
        dragState.drop = zone;
        const highlight = zoneRef.current;
        if (!highlight) return;
        // Preview the simulated result's own box, not a share of the old
        // one: the removal ahead of the insertion can collapse the tree,
        // and only the measured outcome shows where the pane will land.
        const simulated = zone ? applyConversationDrop(layout, dragState.paneId, zone) : null;
        const box = simulated
            ? measureLayout(simulated).panes.find((pane) => pane.id === dragState.paneId)?.box
            : null;
        if (!box) {
            highlight.style.display = 'none';
            return;
        }
        // In window pixels: the highlight lives on the body, above the
        // terminals that are laid over their panes from outside this view.
        const px = pxBox(box, rect);
        highlight.style.display = 'block';
        highlight.style.left = `${rect.left + px.left}px`;
        highlight.style.top = `${rect.top + px.top}px`;
        highlight.style.width = `${px.right - px.left}px`;
        highlight.style.height = `${px.bottom - px.top}px`;
        highlight.dataset.variant = zone.kind === 'swap' ? 'swap' : 'dock';
    }, [layout]);

    const beginPaneDrag = useCallback((paneId, event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        // Controls keep working: only the bare header grabs the pane.
        if (event.target.closest(INTERACTIVE)) return;
        if (!event.target.closest('[data-pane-header]')) return;

        const overlay = overlayRef.current;
        if (!overlay) return;
        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;

        const geometry = measureLayout(layout);
        const pending = {
            paneId,
            pointerId: event.pointerId,
            originX: event.clientX,
            originY: event.clientY,
            lifted: false,
            drop: null,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            rects: geometry.panes.map((pane) => ({ id: pane.id, ...pxBox(pane.box, rect) })),
        };
        dragRef.current = pending;

        const onMove = (moveEvent) => {
            const current = dragRef.current;
            if (!current || moveEvent.pointerId !== current.pointerId) return;
            if (!current.lifted) {
                if (Math.hypot(moveEvent.clientX - current.originX, moveEvent.clientY - current.originY) < DRAG_THRESHOLD) return;
                current.lifted = true;
                const { title, look, session } = titleOf(current.paneId);
                setDrag({ paneId: current.paneId, title, look, session });
                document.body.classList.add('conv-pane-dragging');
                updateGhost(moveEvent.clientX, moveEvent.clientY);
            }
            updateGhost(moveEvent.clientX, moveEvent.clientY);
            updateZone(moveEvent.clientX, moveEvent.clientY);
        };
        const onUp = (upEvent) => {
            if (upEvent.pointerId !== pending.pointerId) return;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            endDrag(true);
        };
        const onKey = (keyEvent) => {
            if (keyEvent.key !== 'Escape') return;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            window.removeEventListener('keydown', onKey, true);
            endDrag(false);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        window.addEventListener('keydown', onKey, true);
        pending.cancelKey = onKey;
    }, [layout, titleOf, updateGhost, updateZone, endDrag]);

    // The key listener is registered per drag and removed with it; this only
    // covers unmount mid-drag, which should never strand the body class.
    useEffect(() => () => {
        if (dragRef.current?.cancelKey) window.removeEventListener('keydown', dragRef.current.cancelKey, true);
    }, []);

    // Split along the pane's long axis: a wide chat opens a neighbour, a
    // tall narrow one opens below. One button, no guessing.
    const splitSmart = useCallback((paneId) => {
        const overlay = overlayRef.current;
        const geometry = measureLayout(layout);
        const pane = geometry.panes.find((entry) => entry.id === paneId);
        let direction = 'row';
        if (overlay && pane) {
            const rect = overlay.getBoundingClientRect();
            const w = pane.box.fracW * rect.width + pane.box.pxW;
            const h = pane.box.fracH * rect.height + pane.box.pxH;
            direction = w >= h ? 'row' : 'column';
        }
        onSplitPane(paneId, direction);
    }, [layout, onSplitPane]);

    return (
        <div className="absolute inset-0 conv-split-enter">
        <SplitLayout
            layout={layout}
            focusedPaneId={focusedPaneId}
            zoomedPaneId={null}
            onResizeSplit={onResizeSplit}
            onEqualizeSplit={onEqualizeSplit}
            renderPane={(pane, { focused }) => {
                const session = pane.tabId ? sessionById.get(pane.tabId) : null;
                if (session) {
                    return (
                        <div
                            className="absolute inset-0"
                            onPointerDownCapture={() => { if (!focused) onFocusPane(pane.id, session.id); }}
                            onPointerDown={(event) => beginPaneDrag(pane.id, event)}
                        >
                            <SessionPaneHeader
                                tab={session}
                                conversationTabs={stripTabs}
                                sessionTabs={sessionTabs}
                                onSwitch={(tabId) => onPickTab(pane.id, tabId)}
                                onNew={() => onNewIntoPane(pane.id)}
                                onClose={() => onClosePane(pane.id, null)}
                                onExit={count <= 2 ? onExitSplit : undefined}
                            />
                        </div>
                    );
                }
                const tab = pane.tabId ? tabById.get(pane.tabId) : null;
                if (!tab) {
                    return (
                        <div className="absolute inset-0" onPointerDown={(event) => beginPaneDrag(pane.id, event)}>
                            <ConversationPanePicker
                                tabs={stripTabs}
                                sessionTabs={sessionTabs}
                                usedTabIds={usedTabIds}
                                onPick={(tabId) => onPickTab(pane.id, tabId)}
                                onNew={() => onNewIntoPane(pane.id)}
                                onClose={() => onClosePane(pane.id, null)}
                            />
                        </div>
                    );
                }
                return (
                    <div
                        className="absolute inset-0"
                        onPointerDownCapture={() => { if (!focused) onFocusPane(pane.id, tab.id); }}
                        onPointerDown={(event) => beginPaneDrag(pane.id, event)}
                    >
                        <ConversationView
                            tab={tab}
                            active={focused}
                            status={conversationStatuses[tab.id]}
                            sessions={sessions}
                            hosts={hosts}
                            activeSessionId={activeSessionId}
                            agentId={tab.agentId || activeAgentId}
                            agentLook={lookFor(tab.agentId)}
                            scopeProps={scopePropsFor(tab)}
                            onConversationChange={(id) => setConversation(tab.id, id)}
                            onStatus={reportConversationStatus}
                            onOpenSettings={onOpenSettings}
                            onOpenSnippets={onOpenSnippets}
                            onDetach={() => onDetachTab(tab.id)}
                            onClose={() => onCloseTab(tab.id)}
                            onNewTab={onNewConversation}
                            onOpenConversation={onOpenConversation}
                            inSplit
                            splitFocused={focused}
                            canSplit={canSplit && count < MAX_CONVERSATION_PANES}
                            paneCount={count}
                            onSplit={() => splitSmart(pane.id)}
                            onClosePane={() => onClosePane(pane.id, tab.id)}
                            onExitSplit={count <= 2 ? onExitSplit : undefined}
                            switchTabs={stripTabs}
                            switchSessions={sessionTabs}
                            onSwitchTab={(tabId) => onPickTab(pane.id, tabId)}
                            onNewIntoPane={() => onNewIntoPane(pane.id)}
                        />
                    </div>
                );
            }}
        />
        {/* Drop overlay: same inset as the panes, so measured boxes land on
            them. Only measured; the highlight itself is on the body. */}
        <div ref={overlayRef} className="pointer-events-none absolute" style={{ inset: 6 }} aria-hidden="true" />
        {createPortal(
            <div
                ref={zoneRef}
                className="conv-drop-preview"
                style={{ display: 'none', position: 'fixed', zIndex: 9998 }}
                aria-hidden="true"
            />,
            document.body,
        )}
        {drag && createPortal(
            <div ref={ghostRef} className="conv-drag-ghost" aria-hidden="true">
                {drag.session
                    ? <CommandLineIcon size={14} strokeWidth={2} />
                    : <AgentMark size={14} look={drag.look} />}
                <span>{drag.title}</span>
            </div>,
            document.body,
        )}
        </div>
    );
}

export default memo(ConversationSplitView);
