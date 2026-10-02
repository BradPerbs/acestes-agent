import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Cancel01Icon, CommandLineIcon, Copy01Icon, SplitIcon, LinkSquare02Icon, Tick01Icon, Unlink01Icon } from 'hugeicons-react';
import AgentMark from './AgentMark';
import ConversationPaneSwitcher from './ConversationPaneSwitcher';
import ScopeMenu from './ScopeMenu';
import LocalTerminalPanel from './LocalTerminalPanel';
import useLocalTerminals from '../../hooks/useLocalTerminals';
import AssistantConversation, { HAIRLINE, HeaderButton } from './AssistantConversation';
import { PANE_HEADER_HEIGHT } from '../../lib/layout';
import { useT } from '../../i18n';

/**
 * A conversation as the thing on screen.
 *
 * The chat used to be a column beside the terminal, drawn narrow and shown
 * only while something else was in front. It is a tab of the window now, and
 * this is what that tab shows: a header naming the conversation and the
 * servers it is about, and the conversation itself underneath.
 *
 * The transcript and the composer are held to a reading measure rather than
 * stretched to the window. A reply is prose, and prose at 1600px is one long
 * line; the width that is left over goes to the margins, the way the empty
 * state inside the conversation already caps itself.
 *
 * The header is the pane headers' row: the same height, the same 32px
 * controls. The scope selector sits on the right, at the width the old tab
 * gave it, because it is the one control here that decides what the next
 * message can touch, and the mark and the title on the left are what the tab
 * strip is already saying, repeated where there is room to read it.
 */
/** How long the tick stays up after a copy. */
const CONFIRM_MS = 1400;

/**
 * The whole conversation to the clipboard, as the debugging cut of the
 * export: settings, every tool input, results untruncated. The button is
 * the tick for a moment afterwards, the way the copy on a code block is;
 * a toast for a thing you just did with your own hand is noise.
 */
function CopyConversationButton({ conversationId }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const timer = useRef(0);
    useEffect(() => () => clearTimeout(timer.current), []);

    const copy = useCallback(async () => {
        if (!conversationId) return;
        const text = await window.api.ai.markdown?.(conversationId, { full: true });
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            try {
                await window.api.clipboard?.writeText?.(text);
            } catch {
                return;
            }
        }
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
    }, [conversationId]);

    return (
        <HeaderButton
            title={copied ? t('assistant.copied') : t('assistant.copyConversation')}
            hint={copied ? undefined : t('assistant.copyConversationHint')}
            icon={copied
                ? <Tick01Icon size={16} strokeWidth={2.25} className="text-emerald-600 dark:text-emerald-400" />
                : <Copy01Icon size={16} strokeWidth={1.75} />}
            onClick={copy}
        />
    );
}

/* ------------------------------------------------------------------ *
 * The terminal beside the chat
 * ------------------------------------------------------------------ */

/** Wide enough for the terminal to sit beside the chat rather than under it. */
const SIDE_BY_SIDE_WIDTH = 960;

/** Neither side of the split is ever squeezed below this share. */
const MIN_SHARE = 0.2;
const MAX_SHARE = 0.8;

const SHARE_KEY = 'assistant.localTerminal.share.v1';

/** The panel's slide: long enough to follow, short enough not to wait on. */
const DOCK_MS = 380;
const DOCK_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

const clampShare = (value) => Math.min(MAX_SHARE, Math.max(MIN_SHARE, value));

/** The terminal's share of the view, per orientation, as last dragged. */
function readShares() {
    try {
        const stored = JSON.parse(localStorage.getItem(SHARE_KEY) || '{}');
        return {
            row: Number.isFinite(stored.row) ? clampShare(stored.row) : 0.45,
            column: Number.isFinite(stored.column) ? clampShare(stored.column) : 0.4,
        };
    } catch {
        return { row: 0.45, column: 0.4 };
    }
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Where the panel's content sits inside its sliding slot.
 *
 * At rest it fills the slot. During a slide it is held at the size it will
 * have when open, pinned to the far edge, and the slot's own width reveals
 * it: a drawer rather than a squash, and a terminal that is laid out once.
 */
function dockContentBox(animating, direction, body, share) {
    if (!animating || !body) return { inset: 0 };
    const rect = body.getBoundingClientRect();
    return direction === 'row'
        ? { top: 0, bottom: 0, right: 0, width: Math.round(rect.width * share) }
        : { left: 0, right: 0, bottom: 0, height: Math.round(rect.height * share) };
}

/**
 * The panel sliding in and out.
 *
 *   mounted    whether the panel is in the tree at all; it stays through the
 *              closing slide and goes when that ends
 *   expanded   the target the slide is heading for: the chat and the panel
 *              trade flex-grow, which the browser eases
 *   animating  a slide is under way. The panel's content is held at its
 *              final size for the length of it, so the terminal is measured
 *              once and the shell sees one size, not every frame of the slide
 *
 * A toggle mid-slide simply turns it around. With reduced motion there is no
 * slide at all.
 */
function useDockMotion(open) {
    const [mounted, setMounted] = useState(open);
    const [expanded, setExpanded] = useState(open);
    const [animating, setAnimating] = useState(false);
    const openRef = useRef(open);
    openRef.current = open;
    const timer = useRef(0);

    const settle = useCallback(() => {
        clearTimeout(timer.current);
        setAnimating(false);
        if (!openRef.current) setMounted(false);
    }, []);

    useEffect(() => {
        if (reducedMotion()) {
            setMounted(open);
            setExpanded(open);
            setAnimating(false);
            return undefined;
        }
        if (open === expanded && !animating) {
            if (open && !mounted) setMounted(true);
            return undefined;
        }
        let frame = 0;
        setAnimating(true);
        if (open) {
            setMounted(true);
            // Two frames: one to lay the collapsed panel out, one to let the
            // browser see the change it is to ease towards.
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(() => setExpanded(true));
            });
        } else {
            setExpanded(false);
        }
        // transitionend is not promised: a tab hidden mid-slide may not get it.
        clearTimeout(timer.current);
        timer.current = setTimeout(settle, DOCK_MS + 120);
        return () => cancelAnimationFrame(frame);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => () => clearTimeout(timer.current), []);

    const onTransitionEnd = useCallback((event) => {
        if (event.target !== event.currentTarget || event.propertyName !== 'flex-grow') return;
        settle();
    }, [settle]);

    return { mounted, expanded, animating, onTransitionEnd };
}

/**
 * The handle between the chat and the terminal: the split view's own
 * divider, so it looks and drags the way the others do.
 */
function TerminalDivider({ direction, containerRef, share, onShare }) {
    const horizontal = direction === 'row';
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef(null);

    const onPointerDown = (event) => {
        if (event.button !== 0) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        dragRef.current = { rect };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        document.body.classList.add(horizontal ? 'pane-resizing-x' : 'pane-resizing-y');
    };
    const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        // The terminal is the second of the two, so its share is what lies
        // after the pointer.
        const next = horizontal
            ? (drag.rect.right - event.clientX) / drag.rect.width
            : (drag.rect.bottom - event.clientY) / drag.rect.height;
        onShare(clampShare(next));
    };
    const endDrag = (event) => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        document.body.classList.remove('pane-resizing-x', 'pane-resizing-y');
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // Already released.
        }
    };
    const onKeyDown = (event) => {
        const back = horizontal ? 'ArrowLeft' : 'ArrowUp';
        const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        onShare(clampShare(share + (event.key === back ? 0.03 : -0.03)));
    };

    return (
        <div
            role="separator"
            aria-orientation={horizontal ? 'vertical' : 'horizontal'}
            tabIndex={0}
            data-dragging={dragging ? 'true' : 'false'}
            // On the panel's leading edge rather than a flex item of its own,
            // so it slides in with the panel and takes no room from either side.
            className={`pane-divider absolute z-20 ${horizontal
                ? 'pane-divider-x left-0 top-0 bottom-0 w-2'
                : 'pane-divider-y top-0 left-0 right-0 h-2'}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={onKeyDown}
        >
            <span className="pane-grip" aria-hidden="true" />
        </div>
    );
}

function ConversationView({
    tab,
    /** Whether this tab is the one in front. The others stay mounted. */
    active,
    /** What the conversation last reported: `{ title, busy }`. */
    status,
    sessions,
    hosts = [],
    activeSessionId,
    /** Whose conversation this is, for the one it starts, and its colour. */
    agentId = '',
    agentLook = null,
    /** The scope selector's props, minus the scope itself. See useConversationTabs. */
    scopeProps,
    onConversationChange,
    onStatus,
    onOpenSettings,
    onOpenSnippets,
    onDetach,
    onClose,
    onNewTab,
    /** Bring a conversation to the front by id: where a branch opens. */
    onOpenConversation,
    /** Split-view controls. Absent outside a split; see ConversationSplitView. */
    inSplit = false,
    splitFocused = false,
    canSplit = true,
    paneCount = 1,
    onSplit,
    onClosePane,
    onExitSplit,
    /** The chats a split pane can be pointed at; enables the title switcher. */
    switchTabs = null,
    onSwitchTab,
    onNewIntoPane,
}) {
    const t = useT();
    const title = tab.customTitle || status?.title || t('assistant.newConversation');

    // The terminal panel: the project's tabs, whether it is showing, which way
    // it sits, how much of the view it has, and where its slide is. Scoped to
    // the project rather than this chat, so every chat of it shares the same
    // terminals.
    const terminals = useLocalTerminals(agentId, tab.id);
    const dock = useDockMotion(terminals.open);
    const [shares, setShares] = useState(readShares);
    const [sideBySide, setSideBySide] = useState(true);
    const bodyRef = useRef(null);

    useEffect(() => {
        const element = bodyRef.current;
        if (!element) return undefined;
        const observer = new ResizeObserver(([entry]) => {
            setSideBySide(entry.contentRect.width >= SIDE_BY_SIDE_WIDTH);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const direction = sideBySide ? 'row' : 'column';
    const share = shares[direction];
    const setShare = useCallback((next) => {
        setShares((previous) => {
            const updated = { ...previous, [direction]: next };
            try {
                localStorage.setItem(SHARE_KEY, JSON.stringify(updated));
            } catch {
                // Storage full or blocked; the size still holds this run.
            }
            return updated;
        });
    }, [direction]);

    // Ctrl+T opens a conversation and Ctrl+W closes this one, but only while
    // the focus is inside it: a terminal keeps both chords for its own shell.
    const onKeyDown = useCallback((event) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'w') {
            event.preventDefault();
            event.stopPropagation();
            onClose?.();
        } else if (event.key === 't') {
            event.preventDefault();
            event.stopPropagation();
            onNewTab?.();
        }
    }, [onClose, onNewTab]);

    return (
        <div className="absolute inset-0 flex flex-col" onKeyDown={onKeyDown}>
            <div
                data-pane-header={inSplit ? 'true' : undefined}
                className={`shrink-0 px-3 flex items-center gap-3 border-b ${HAIRLINE} ${inSplit ? 'conv-pane-header' : ''}`}
                style={{ height: PANE_HEADER_HEIGHT }}
            >
                {inSplit && switchTabs ? (
                    <ConversationPaneSwitcher
                        tab={tab}
                        title={title}
                        agentLook={agentLook}
                        busy={status?.busy}
                        tabs={switchTabs}
                        onSwitch={onSwitchTab}
                        onNew={onNewIntoPane}
                    />
                ) : (
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                        {/* Working, said by the mark: a conversation answering
                            while you read it should be visibly doing so. */}
                        <AgentMark size={18} look={agentLook} className={status?.busy ? 'animate-pulse' : ''} />
                        <span className="text-xs font-semibold text-gray-900 dark:text-white truncate">
                            {title}
                        </span>
                    </div>
                )}

                <div className="shrink-0 w-64 max-w-[40%]">
                    <ScopeMenu scope={tab.scope} {...scopeProps} />
                </div>

                {tab.conversationId && <CopyConversationButton conversationId={tab.conversationId} />}

                <HeaderButton
                    title={terminals.open ? t('assistant.localTerminalHide') : t('assistant.localTerminalShow')}
                    hint={terminals.open ? undefined : t('assistant.localTerminalHint')}
                    icon={<CommandLineIcon size={16} strokeWidth={1.75} className={terminals.open ? 'text-gray-900 dark:text-white' : ''} />}
                    onClick={terminals.toggle}
                />

                {canSplit && onSplit && (
                    <HeaderButton
                        title={t('assistant.splitView')}
                        hint={t('assistant.splitViewHint')}
                        icon={<SplitIcon size={16} strokeWidth={1.75} />}
                        onClick={() => onSplit()}
                    />
                )}

                {inSplit && onClosePane && paneCount > 1 && (
                    <HeaderButton
                        title={t('assistant.closeSplitPane')}
                        icon={<Cancel01Icon size={16} strokeWidth={1.75} />}
                        onClick={onClosePane}
                    />
                )}

                {inSplit && onExitSplit && (
                    <HeaderButton
                        title={t('assistant.exitSplit')}
                        icon={<Unlink01Icon size={16} strokeWidth={1.75} />}
                        onClick={onExitSplit}
                    />
                )}

                <HeaderButton
                    title={t('assistant.detachOnly')}
                    icon={<LinkSquare02Icon size={16} strokeWidth={1.75} />}
                    onClick={onDetach}
                />
            </div>

            <div ref={bodyRef} className={`flex-1 min-h-0 flex ${direction === 'row' ? 'flex-row' : 'flex-col'}`}>
                <div
                    className="min-w-0 min-h-0 flex flex-col"
                    style={{
                        flex: `${dock.expanded ? 1 - share : 1} 1 0`,
                        transition: dock.animating ? `flex-grow ${DOCK_MS}ms ${DOCK_EASE}` : 'none',
                    }}
                >
                    <div className="flex-1 min-h-0 flex flex-col w-full max-w-3xl mx-auto">
                        <AssistantConversation
                            tabId={tab.id}
                            conversationId={tab.conversationId}
                            active={active}
                            scope={tab.scope}
                            sessions={sessions}
                            hosts={hosts}
                            activeSessionId={activeSessionId}
                            agentId={agentId}
                            agentLook={agentLook}
                            onConversationChange={onConversationChange}
                            onStatus={onStatus}
                            onOpenSettings={onOpenSettings}
                            onOpenSnippets={onOpenSnippets}
                            onOpenConversation={onOpenConversation}
                        />
                    </div>
                </div>

                {dock.mounted && (
                    <div
                        className="relative min-w-0 min-h-0 overflow-hidden"
                        style={{
                            flex: `${dock.expanded ? share : 0} 1 0`,
                            transition: dock.animating ? `flex-grow ${DOCK_MS}ms ${DOCK_EASE}` : 'none',
                        }}
                        onTransitionEnd={dock.onTransitionEnd}
                    >
                        <div
                            className={`local-term-dock absolute ${direction === 'row' ? `border-l ${HAIRLINE}` : `border-t ${HAIRLINE}`}`}
                            data-expanded={dock.expanded ? 'true' : 'false'}
                            data-direction={direction}
                            style={dockContentBox(dock.animating, direction, bodyRef.current, share)}
                        >
                            <LocalTerminalPanel
                                terminals={terminals}
                                agentId={agentId}
                                visible={active && dock.expanded}
                                settled={dock.expanded && !dock.animating}
                                direction={direction}
                            />
                        </div>
                        {dock.expanded && !dock.animating && (
                            <TerminalDivider direction={direction} containerRef={bodyRef} share={share} onShare={setShare} />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default memo(ConversationView);
