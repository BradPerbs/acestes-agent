import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import {
    ArrowRight01Icon,
    BubbleChatAddIcon,
    Cancel01Icon,
    Delete02Icon,
    PinIcon,
    PinOffIcon,
    Layers01Icon,
    PencilEdit02Icon,
    PlusSignIcon,
    Search01Icon,
    Settings01Icon,
    UnfoldMoreIcon,
} from 'hugeicons-react';
import { setSidebar, slideSidebar } from '../lib/panelMotion';
import { APP_GUTTER, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../lib/layout';
import { agentGlow, agentInk } from '../lib/agent-colors';
import { agentLook } from '../lib/agent-look';
import { cubicBezier, prefersReducedMotion, seconds } from '../lib/motion';
import AgentMark from './assistant/AgentMark';
import PanelMenu from './assistant/PanelMenu';
import MarqueeText from './ui/MarqueeText';
import { useT } from '../i18n';

/**
 * The column down the left: which agent, and the agent's own things.
 *
 * The agent is the thing the app is about, so it is the first thing in the
 * column and everything under it is that agent's: the inventory it works
 * from, its settings, and its conversations, newest first, with the one on
 * screen lit. Changing the agent changes all of it.
 */

/**
 * The column has no background, cards or borders of its own. It stands on the
 * window's ground, which carries the agent's faint wash (`.app-ground` in
 * input.css), and everything in it is a translucent fill on that ground: a
 * whisper on hover, a little more for the one you are on. Translucent rather
 * than solid so the wash runs on under a lit row instead of stopping at it.
 * In dark mode the fills are the ramp's control step, so they keep the
 * theme's hue rather than going grey.
 */
const ACTIVE = 'bg-gray-900/[0.06] dark:bg-surface-control/80 text-gray-900 dark:text-white';
const HOVER = 'hover:bg-gray-900/[0.04] dark:hover:bg-surface-control/50';
const IDLE = `text-gray-600 dark:text-gray-400 ${HOVER} hover:text-gray-900 dark:hover:text-gray-200`;

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25';

/** How many chats the column lists before it is a page's job. */
const LIST_LIMIT = 40;

/**
 * How tall the fade at the foot of the list is, in pixels, while there is more
 * of the list below it. It gives way as the end is scrolled into view, so the
 * last chat is never left half see-through with nothing under it.
 */
const LIST_FADE = 72;

/** The width the column was last dragged to, kept across launches. */
const WIDTH_KEY = 'sidebar.width';

/** How far one arrow key moves the column's edge. */
const WIDTH_STEP = 16;

const clampWidth = (width) => Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));

function storedWidth() {
    try {
        const stored = Number(window.localStorage.getItem(WIDTH_KEY));
        return stored > 0 ? clampWidth(stored) : SIDEBAR_DEFAULT_WIDTH;
    } catch {
        return SIDEBAR_DEFAULT_WIDTH;
    }
}

/**
 * The column's right edge, which can be dragged to make it wider or narrower.
 *
 * It sits in the gutter between the column and the content panel, so it takes
 * no room from either, and draws the same grip the split panes do: nothing
 * until the pointer finds it, then a short bar. Double-click, or Enter, puts
 * the column back to its default width; the arrow keys move it a step.
 *
 * The drag writes the width straight onto the column through GSAP, which owns
 * it (see `lib/panelMotion`), and tells React only where it ended, so the
 * column follows the pointer without the list re-rendering on every move.
 *
 * Rendered as a zero-width item after the column in the shell's row, with the
 * handle hung back over the gutter: inside the column it would be clipped by
 * the column's own overflow, which is what hides its contents as it shuts.
 */
function SidebarEdge({ navRef, width, onWidth }) {
    const t = useT();
    const drag = useRef(null);
    const [dragging, setDragging] = useState(false);

    // A drag cut short by the column shutting must not leave the whole window
    // with a resize cursor and no text selection.
    useEffect(() => () => document.body.classList.remove('pane-resizing-x'), []);

    const handlePointerDown = (event) => {
        const node = navRef.current;
        if (event.button !== 0 || !node) return;

        // Mid-slide, the slide gives way to the hand.
        gsap.killTweensOf(node);
        setSidebar(node, true, width);

        drag.current = { origin: event.clientX, from: width, live: width };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        document.body.classList.add('pane-resizing-x');
    };

    const handlePointerMove = (event) => {
        const live = drag.current;
        if (!live) return;
        const next = clampWidth(live.from + event.clientX - live.origin);
        if (next === live.live) return;
        live.live = next;
        setSidebar(navRef.current, true, next);
    };

    const endDrag = (event) => {
        const live = drag.current;
        if (!live) return;
        drag.current = null;
        setDragging(false);
        document.body.classList.remove('pane-resizing-x');
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // The capture is already gone; nothing left to release.
        }
        onWidth(live.live);
    };

    /** A width chosen in one go rather than dragged to, eased there. */
    const settle = (next) => {
        const target = clampWidth(next);
        if (target === width) return;
        slideSidebar(navRef.current, true, target);
        onWidth(target);
    };

    const handleKeyDown = (event) => {
        const moves = {
            ArrowLeft: width - WIDTH_STEP,
            ArrowRight: width + WIDTH_STEP,
            Home: SIDEBAR_MIN_WIDTH,
            End: SIDEBAR_MAX_WIDTH,
            Enter: SIDEBAR_DEFAULT_WIDTH,
            ' ': SIDEBAR_DEFAULT_WIDTH,
        };
        if (!(event.key in moves)) return;
        event.preventDefault();
        settle(moves[event.key]);
    };

    return (
        <div className="relative shrink-0 w-0 z-20">
            <div
                role="separator"
                aria-orientation="vertical"
                aria-controls="sidebar"
                aria-label={t('sidebar.resize')}
                aria-valuenow={width}
                aria-valuemin={SIDEBAR_MIN_WIDTH}
                aria-valuemax={SIDEBAR_MAX_WIDTH}
                tabIndex={0}
                data-dragging={dragging ? 'true' : 'false'}
                className="pane-divider pane-divider-x absolute inset-y-0"
                style={{ left: -APP_GUTTER, width: APP_GUTTER }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
                onDoubleClick={() => settle(SIDEBAR_DEFAULT_WIDTH)}
                onKeyDown={handleKeyDown}
            >
                <span className="pane-grip" aria-hidden="true" />
            </div>
        </div>
    );
}

function NavItem({ label, icon, active, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            // Inset 12px like every row in the column, so the icons, the
            // heading and the chat titles all start on one line.
            className={`nav-item group/nav w-full flex items-center gap-2.5 h-8 px-3 rounded-lg text-left
                text-[13px] font-medium transition-colors ${FOCUS} ${active ? ACTIVE : IDLE}`}
        >
            {/* The page you are on has its icon in the agent's colour: the
                one touch of it below the helmet. */}
            <span className={`shrink-0 flex transition-colors
                ${active
                    ? 'agent-accent'
                    : 'text-gray-400 dark:text-neutral-500 group-hover/nav:text-gray-700 dark:group-hover/nav:text-gray-300'}`}>
                {icon}
            </span>
            <span className="truncate">{label}</span>
        </button>
    );
}

/** The house curve, for the pill settling into place rather than stopping. */
const EASE_SOFT = cubicBezier(0.16, 1, 0.3, 1);
const EASE_OUT = cubicBezier(0, 0, 0.58, 1);

/** The magnifier button's size, which is the pill's size before it grows. */
const PILL_START = 28;

/**
 * The conversations heading, which is also the quick search.
 *
 * Two faces in one row, both always mounted, so the change between them is
 * a movement rather than a swap. Open, the magnifier button itself grows:
 * the pill starts exactly over it, the same 28px circle, and widens across
 * the row to the left while the heading text slides out under it and the
 * plus fades. The magnifier never moves, which is what makes the pill read
 * as the button having opened rather than a box having appeared. The text
 * and the cross come in a beat later, once there is room for them. Close
 * runs it backwards.
 *
 * Borderless and soft, like everything else in the column: the sidebar's
 * controls are translucent fills on the column's own ground, and a bordered
 * white box would be the one thing in it drawn in another hand.
 */
function ConversationsHeading({
    active,
    open,
    onOpen,
    onClose,
    onOpenPage,
    onNew,
    query,
    onQuery,
    onSubmit,
}) {
    const t = useT();
    const rowRef = useRef(null);
    const titleRef = useRef(null);
    const magnifierRef = useRef(null);
    const plusRef = useRef(null);
    const pillRef = useRef(null);
    const insideRef = useRef(null);
    const inputRef = useRef(null);
    const timeline = useRef(null);
    const shown = useRef(open);

    useLayoutEffect(() => {
        const row = rowRef.current;
        const pill = pillRef.current;
        if (!row || !pill) return;

        // The first paint lays the faces out for the state they are in,
        // without playing anything.
        if (shown.current === open && !timeline.current) {
            gsap.set(pill, open
                ? { visibility: 'visible', left: 0, width: '100%' }
                : { visibility: 'hidden', left: magnifierRef.current?.offsetLeft || 0, width: PILL_START });
            gsap.set(insideRef.current, { opacity: open ? 1 : 0 });
            gsap.set([titleRef.current, plusRef.current, magnifierRef.current], { opacity: open ? 0 : 1, x: 0 });
            return;
        }
        shown.current = open;

        timeline.current?.kill();
        const from = magnifierRef.current?.offsetLeft || 0;
        const full = row.clientWidth;
        const tl = gsap.timeline({ defaults: { overwrite: 'auto' } });
        timeline.current = tl;

        if (open) {
            // The pill's own magnifier lands on the button's the same frame
            // the pill appears, so the button is hidden outright rather than
            // faded: two magnifiers a hair apart is the one thing this must
            // never show.
            tl.set(pill, { visibility: 'visible' }, 0);
            tl.set(magnifierRef.current, { opacity: 0 }, 0);
            tl.to(titleRef.current, { opacity: 0, x: -8, duration: seconds(110), ease: EASE_OUT }, 0);
            tl.to(plusRef.current, { opacity: 0, scale: 0.6, duration: seconds(100), ease: EASE_OUT }, 0);
            tl.fromTo(pill,
                { left: from, width: PILL_START },
                { left: 0, width: full, duration: seconds(240), ease: EASE_SOFT }, 0);
            tl.fromTo(insideRef.current,
                { opacity: 0, x: 6 },
                { opacity: 1, x: 0, duration: seconds(140), ease: EASE_OUT }, 0.07);
            tl.call(() => inputRef.current?.focus({ preventScroll: true }), null, 0.05);
            // Grown, it is as wide as the row rather than as wide as the row
            // was, so it follows the column's edge being dragged while open.
            tl.set(pill, { width: '100%' });
        } else {
            tl.to(insideRef.current, { opacity: 0, x: 6, duration: seconds(80), ease: EASE_OUT }, 0);
            tl.to(pill, { left: from, width: PILL_START, duration: seconds(200), ease: EASE_SOFT }, 0.02);
            tl.to(plusRef.current, { opacity: 1, scale: 1, duration: seconds(140), ease: EASE_SOFT }, 0.08);
            tl.to(titleRef.current, { opacity: 1, x: 0, duration: seconds(160), ease: EASE_SOFT }, 0.06);
            tl.set(magnifierRef.current, { opacity: 1 });
            tl.set(pill, { visibility: 'hidden' });
        }

        return () => {
            if (timeline.current === tl) {
                tl.progress(1);
                timeline.current = null;
            }
        };
    }, [open]);

    return (
        <div ref={rowRef} className="relative mt-4 mx-1.5 h-9">
            {/* The heading face. Inert while the search is open, since it is
                still there under the pill. */}
            <div className={`absolute inset-0 flex items-center ${open ? 'pointer-events-none' : ''}`}>
                <button
                    ref={titleRef}
                    type="button"
                    tabIndex={open ? -1 : 0}
                    onClick={onOpenPage}
                    // Said in the column's own voice rather than as a label
                    // stamped over it; the chevron on hover is what says the
                    // heading goes somewhere.
                    className={`group/title flex-1 min-w-0 flex items-center gap-1 pl-1.5 py-1.5 text-left
                        text-[12px] font-medium transition-colors ${FOCUS} rounded-md
                        ${active
                            ? 'text-gray-900 dark:text-white'
                            : 'text-gray-500 dark:text-neutral-500 hover:text-gray-900 dark:hover:text-gray-200'}`}
                >
                    <span className="truncate">{t('nav.conversations')}</span>
                    <ArrowRight01Icon
                        size={12}
                        strokeWidth={2}
                        className="shrink-0 transition-all duration-150 opacity-0 -translate-x-1
                            group-hover/title:opacity-100 group-hover/title:translate-x-0
                            group-focus-visible/title:opacity-100 group-focus-visible/title:translate-x-0"
                    />
                </button>
                <button
                    ref={magnifierRef}
                    type="button"
                    tabIndex={open ? -1 : 0}
                    aria-label={t('conversations.quickSearch')}
                    title={t('conversations.quickSearch')}
                    onClick={onOpen}
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full transition-colors
                        text-gray-500 dark:text-gray-400
                        hover:bg-gray-900/[0.06] hover:text-gray-900
                        dark:hover:bg-surface-control/80 dark:hover:text-white"
                >
                    <Search01Icon size={15} strokeWidth={2} />
                </button>
                <button
                    ref={plusRef}
                    type="button"
                    tabIndex={open ? -1 : 0}
                    aria-label={t('conversations.new')}
                    title={t('conversations.new')}
                    onClick={onNew}
                    className="shrink-0 w-7 h-7 flex items-center justify-center rounded-full transition-colors
                        text-gray-500 dark:text-gray-400
                        hover:bg-gray-900/[0.06] hover:text-gray-900
                        dark:hover:bg-surface-control/80 dark:hover:text-white"
                >
                    <PlusSignIcon size={15} strokeWidth={2.5} />
                </button>
            </div>

            {/* The search face: the pill, which is the magnifier grown. */}
            <div
                ref={pillRef}
                // The same fill as the magnifier's hover, which is what it
                // grows out of, and translucent like the rest of the column.
                className="absolute top-1/2 -translate-y-1/2 h-7 rounded-full overflow-hidden
                    bg-gray-900/[0.06] dark:bg-surface-control/80
                    focus-within:bg-gray-900/[0.05] dark:focus-within:bg-surface-control/60
                    transition-colors"
                style={{ visibility: 'hidden', width: PILL_START }}
            >
                <Search01Icon
                    size={15}
                    strokeWidth={2}
                    className="absolute left-[6.5px] top-1/2 -translate-y-1/2 pointer-events-none
                        text-gray-500 dark:text-gray-400"
                />
                <div ref={insideRef} className="absolute inset-0 pl-7 pr-7">
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={(event) => onQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') { event.preventDefault(); onClose(); }
                            if (event.key === 'Enter') { event.preventDefault(); onSubmit(); }
                        }}
                        tabIndex={open ? 0 : -1}
                        placeholder={t('conversations.quickSearchPlaceholder')}
                        aria-label={t('conversations.quickSearch')}
                        spellCheck={false}
                        autoComplete="off"
                        className="w-full h-full bg-transparent text-[13px] font-medium normal-case tracking-normal
                            outline-none border-0 p-0 m-0 shadow-none appearance-none
                            text-gray-900 dark:text-white caret-gray-900 dark:caret-white
                            placeholder:text-gray-500 dark:placeholder:text-neutral-400 placeholder:font-normal"
                    />
                    <button
                        type="button"
                        tabIndex={open ? 0 : -1}
                        aria-label={t('common.close')}
                        title={t('common.close')}
                        onClick={onClose}
                        className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full
                            flex items-center justify-center transition-colors
                            text-gray-400 dark:text-neutral-500
                            hover:bg-gray-900/[0.08] hover:text-gray-900 dark:hover:bg-white/[0.1] dark:hover:text-white"
                    >
                        <Cancel01Icon size={11} strokeWidth={2.5} />
                    </button>
                </div>
            </div>
        </div>
    );
}

/** One chat in the list: its title, whether it is working, and a bin on hover. */
function ConversationRow({ conversation, active, onOpen, onDelete, onPin, deleteLabel }) {
    const t = useT();
    const title = conversation.title || t('assistant.newConversation');
    const pinLabel = conversation.pinned ? t('conversations.unpin') : t('conversations.pin');
    const [hovered, setHovered] = useState(false);
    const rowRef = useRef(null);

    // A row drawn under a pointer that is already there gets no enter event.
    useEffect(() => {
        if (rowRef.current?.matches(':hover')) setHovered(true);
    }, []);

    return (
        <div
            ref={rowRef}
            className="relative group/row"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
        >
            <button
                type="button"
                onClick={onOpen}
                // The marquee shows the whole title; the tooltip is for
                // whoever has asked for things on screen not to move.
                title={prefersReducedMotion() ? title : undefined}
                // The title has the row to itself until the actions are asked
                // for: a pinned row keeps room for its pin, and hover or focus
                // makes room for both. Held back all the time, the gap cut
                // every title short for buttons that were not there.
                // Lit the way the rows above it are, a fill on the ground
                // rather than a white tile lifted off it.
                className={`w-full flex items-center gap-2 pl-3 h-8 rounded-[10px] text-left text-[13px]
                    transition-colors ${FOCUS}
                    ${conversation.pinned ? 'pr-8' : 'pr-3'} group-hover/row:pr-14 group-focus-within/row:pr-14
                    ${active ? ACTIVE : IDLE}`}
            >
                {/* Working, said as a dot, the way the tab strip says it. */}
                {conversation.busy && (
                    <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                )}
                <MarqueeText text={title} playing={hovered} />
            </button>

            {/* The pin of a pinned row is always shown, at the far right where
                the actions live, and is the unpin button on hover: one glyph
                in one place, rather than a marker in the row and a button
                beside it. */}
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                <button
                    type="button"
                    aria-label={pinLabel}
                    aria-pressed={Boolean(conversation.pinned)}
                    title={pinLabel}
                    onClick={onPin}
                    // No tile behind it on hover: the glyph itself comes up to
                    // full colour, which is all the row needs to say "this one".
                    className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors
                        focus-visible:opacity-100
                        text-gray-400 dark:text-neutral-500
                        hover:text-gray-900 dark:hover:text-white
                        focus-visible:text-gray-900 dark:focus-visible:text-white
                        ${conversation.pinned ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'}`}
                >
                    {conversation.pinned ? (
                        <>
                            <PinIcon size={13} strokeWidth={1.75} className="group-hover/row:hidden" />
                            <PinOffIcon size={13} strokeWidth={1.5} className="hidden group-hover/row:block" />
                        </>
                    ) : (
                        <PinIcon size={13} strokeWidth={1.5} />
                    )}
                </button>
                <button
                    type="button"
                    aria-label={deleteLabel}
                    onClick={onDelete}
                    className="w-6 h-6 rounded-md flex items-center justify-center transition-colors
                        opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100
                        text-gray-400 dark:text-neutral-500
                        hover:text-red-500 dark:hover:text-red-400
                        focus-visible:text-red-500 dark:focus-visible:text-red-400"
                >
                    <Delete02Icon size={13} strokeWidth={1.5} />
                </button>
            </div>
        </div>
    );
}

function Sidebar({
    agents = [],
    activeAgent = null,
    onSelectAgent,
    onNewAgent,
    onRenameAgent,
    onDeleteAgent,
    activeNav,
    onNavChange,
    collapsed,
    conversations = [],
    activeConversationId = '',
    onOpenConversation,
    onNewConversation,
    onDeleteConversation,
    onPinConversation,
    onNewConversationWith,
}) {
    const t = useT();

    const navRef = useRef(null);

    /**
     * The state the sidebar has been drawn in, so the first render lays it out
     * rather than animating it from itself to itself, and so StrictMode's
     * second mount does not read as the sidebar having been asked to move.
     */
    const shown = useRef(!collapsed);

    /**
     * The width the column opens to, as last dragged. The edge writes the
     * width onto the column itself while it is being moved; this is only where
     * it came to rest, for the next time the column opens and the next launch.
     */
    const [width, setWidth] = useState(storedWidth);
    const widthRef = useRef(width);
    widthRef.current = width;

    const commitWidth = useCallback((next) => {
        setWidth(next);
        try { window.localStorage.setItem(WIDTH_KEY, String(next)); } catch { /* no storage */ }
    }, []);

    /**
     * Opening and shutting is GSAP's, from `lib/panelMotion`. Nothing is set
     * here in a `style` prop: a re-render mid-slide would write the far end of
     * the movement straight onto the element and the column would jump there.
     * The width is read rather than depended on, since a change of width has
     * already been drawn by the edge that made it.
     */
    useLayoutEffect(() => {
        const node = navRef.current;
        if (!node) return;

        const open = !collapsed;
        if (shown.current === open) {
            setSidebar(node, open, widthRef.current);
            return;
        }
        shown.current = open;
        slideSidebar(node, open, widthRef.current);
    }, [collapsed]);

    /**
     * The list's foot fading out while there is more of it below. The fade's
     * height is the scroll left to go, up to `LIST_FADE`, so it gives way as
     * the end comes into view and is not there at all for a list that fits.
     * Written straight onto the element: it changes on every scroll frame.
     */
    const listRef = useRef(null);
    const updateFade = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const below = list.scrollHeight - list.clientHeight - list.scrollTop;
        list.style.setProperty('--list-fade', `${Math.max(0, Math.min(LIST_FADE, Math.round(below)))}px`);
    }, []);

    // Every render, since the rows the list holds may be what changed.
    useLayoutEffect(updateFade);

    // And whenever the list's own box changes: the window, or the column's
    // other contents, growing or shrinking.
    useEffect(() => {
        const list = listRef.current;
        if (!list || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(updateFade);
        observer.observe(list);
        return () => observer.disconnect();
    }, [updateFade]);

    /**
     * The agent menu: every agent, the one selected ticked, and under them
     * the way to make another. Each row does its own things on hover: start
     * a chat with that agent there and then, without switching the column
     * to it, and edit it. A bin is offered only while there is another agent
     * to fall back to.
     */
    const agentSections = useMemo(() => [
        {
            heading: t('agents.heading'),
            value: activeAgent?.id || '',
            onChange: (id) => onSelectAgent?.(id),
            options: agents.map(agent => ({
                value: agent.id,
                label: agent.name,
                icon: <AgentMark size={14} look={agent} />,
                actions: [
                    {
                        key: 'chat',
                        label: t('agents.chatWith', { name: agent.name }),
                        icon: <BubbleChatAddIcon size={14} strokeWidth={1.6} />,
                        onClick: () => onNewConversationWith?.(agent.id),
                    },
                    {
                        key: 'edit',
                        label: t('agents.editNamed', { name: agent.name }),
                        icon: <PencilEdit02Icon size={13} strokeWidth={1.6} />,
                        onClick: () => onRenameAgent?.(agent.id),
                    },
                ],
                onRemove: agents.length > 1 ? () => onDeleteAgent?.(agent.id) : undefined,
            })),
        },
        {
            value: '',
            onChange: () => onNewAgent?.(),
            options: [
                { value: 'new', label: t('agents.new'), icon: <PlusSignIcon size={14} strokeWidth={2} /> },
            ],
        },
    ], [agents, activeAgent, onSelectAgent, onNewAgent, onRenameAgent, onDeleteAgent, onNewConversationWith, t]);

    /**
     * The quick search: a box under the heading that narrows the column by
     * title as you type, and hands the words to the page's full search on
     * Enter. Quick because it is local and instant; the page is where the
     * contents are searched, and Enter is the way there.
     */
    const [searchOpen, setSearchOpen] = useState(false);
    const [query, setQuery] = useState('');

    // Closing clears: the list goes back to all of it as the pill shrinks.
    useEffect(() => {
        if (!searchOpen) setQuery('');
    }, [searchOpen]);

    const needle = query.trim().toLowerCase();
    const listed = (needle
        ? conversations.filter(conversation => (conversation.title || '').toLowerCase().includes(needle))
        : conversations
    ).slice(0, LIST_LIMIT);

    const searchEverything = () => {
        if (!needle) return;
        try { window.sessionStorage.setItem('conversations.query', query.trim()); } catch { /* no storage */ }
        setSearchOpen(false);
        onNavChange('conversations');
    };

    /**
     * The agent's colour, as the accent on the lit page's icon. Left unset for
     * white and black, which have no hue to lend and whose ink would vanish
     * into one theme or the other as an icon colour.
     */
    const ink = agentInk(agentLook(activeAgent).color);
    const accent = agentGlow(agentLook(activeAgent).color)
        ? { '--agent-accent': ink.line, '--agent-accent-dark': ink.lineDark }
        : undefined;

    return (
        <>
            <nav
                id="sidebar"
                ref={navRef}
                // No background of its own: the window's ground, and the agent's
                // wash on it, is the column's background.
                className="flex flex-col shrink-0 overflow-hidden"
            >
                <div className="flex flex-col gap-0.5 flex-1 min-h-0" style={accent}>
                    {/* Who this column is about. Drawn as a menu rather than a
                        page, since choosing an agent is a switch, not a place to
                        go. Portalled: the column clips, and a list of agents
                        hanging off its foot would be cut off at the first row.

                        The mark sits 6px in, so its middle lines up with the
                        icons under it. */}
                    <PanelMenu
                        portal
                        menuClassName="w-64"
                        sections={agentSections}
                        trigger={({ open, toggle }) => (
                            <button
                                type="button"
                                aria-haspopup="menu"
                                aria-expanded={open}
                                onClick={toggle}
                                className={`group/agent w-full flex items-center gap-2.5 pl-1.5 pr-2.5 py-1.5 rounded-xl
                                    text-left transition-colors ${FOCUS} ${open ? ACTIVE : HOVER}`}
                            >
                                <AgentMark size={28} look={activeAgent} />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] leading-5 font-semibold tracking-[-0.01em]
                                        truncate text-gray-900 dark:text-white">
                                        {activeAgent?.name || t('agents.agent')}
                                    </span>
                                    <span className="block text-[11px] leading-4 truncate text-gray-500 dark:text-neutral-500">
                                        {t('agents.agent')}
                                    </span>
                                </span>
                                {/* Up and down rather than down: this opens a
                                    list to switch between, not a section. */}
                                <UnfoldMoreIcon
                                    size={14}
                                    strokeWidth={2}
                                    className="shrink-0 transition-colors text-gray-400 dark:text-neutral-500
                                        group-hover/agent:text-gray-700 dark:group-hover/agent:text-gray-300"
                                />
                            </button>
                        )}
                    />

                    {/* The agent's two places, straight under it with a breath of
                        space between rather than a rule or a box. */}
                    <div className="mt-1.5 flex flex-col gap-0.5">
                        <NavItem
                            label={t('nav.inventory')}
                            icon={<Layers01Icon size={17} strokeWidth={1.6} />}
                            active={activeNav === 'inventory'}
                            onClick={() => onNavChange('inventory')}
                        />
                        <NavItem
                            label={t('nav.settings')}
                            icon={<Settings01Icon size={17} strokeWidth={1.6} />}
                            active={activeNav === 'settings'}
                            onClick={() => onNavChange('settings')}
                        />
                    </div>

                    {/* The conversations: a heading that is also the way to the
                        page listing all of them, the plus beside it, and the
                        newest underneath. */}
                    <ConversationsHeading
                        active={activeNav === 'conversations'}
                        open={searchOpen}
                        onOpen={() => setSearchOpen(true)}
                        onClose={() => setSearchOpen(false)}
                        onOpenPage={() => onNavChange('conversations')}
                        onNew={onNewConversation}
                        query={query}
                        onQuery={setQuery}
                        onSubmit={searchEverything}
                    />

                    <div
                        ref={listRef}
                        onScroll={updateFade}
                        className="sidebar-list-fade flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 pb-4"
                    >
                        {listed.length === 0 ? (
                            <p className="px-3 py-1.5 text-xs text-gray-500 dark:text-neutral-500">
                                {t('conversations.empty')}
                            </p>
                        ) : listed.map(conversation => (
                            <ConversationRow
                                key={conversation.conversationId}
                                conversation={conversation}
                                active={conversation.conversationId === activeConversationId}
                                onOpen={() => onOpenConversation?.(conversation.conversationId)}
                                onDelete={() => onDeleteConversation?.(conversation.conversationId, conversation.title)}
                                onPin={() => onPinConversation?.(conversation.conversationId, !conversation.pinned)}
                                deleteLabel={t('common.deleteNamed', {
                                    name: conversation.title || t('assistant.newConversation'),
                                })}
                            />
                        ))}
                    </div>
                </div>
            </nav>
            {/* Only while the column is out: there is no edge to a column that
                has been put away. */}
            {!collapsed && <SidebarEdge navRef={navRef} width={width} onWidth={commitWidth} />}
        </>
    );
}

export default memo(Sidebar);
