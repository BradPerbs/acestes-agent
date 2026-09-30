import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { gsap } from 'gsap';
import {
    ArrowRight01Icon,
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

const ACTIVE = 'bg-gray-900/[0.06] dark:bg-surface-control text-gray-900 dark:text-white';
const IDLE = 'text-gray-600 dark:text-gray-400 hover:bg-gray-900/[0.04] dark:hover:bg-surface-control/60 '
    + 'hover:text-gray-900 dark:hover:text-gray-200';

/**
 * The agent's card at the top of the column: who it is and its two places,
 * lifted one step off the column's ground so they read as one thing, the
 * agent, rather than three rows that happen to sit together. The
 * conversations under it stay on the ground, since they are the column's
 * running list rather than part of the agent.
 */
const CARD = `flex flex-col p-1 rounded-2xl
    bg-white dark:bg-surface-raised
    ring-1 ring-black/[0.05] dark:ring-white/[0.05]
    shadow-[0_1px_2px_rgba(16,24,40,0.04),0_1px_3px_rgba(16,24,40,0.03)] dark:shadow-none`;

const FOCUS = 'outline-none focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25';

/** How many chats the column lists before it is a page's job. */
const LIST_LIMIT = 40;

function NavItem({ label, icon, active, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-current={active ? 'page' : undefined}
            className={`nav-item group/nav w-full flex items-center gap-2.5 h-9 px-2 rounded-xl text-left
                text-[13px] font-medium transition-colors ${FOCUS} ${active ? ACTIVE : IDLE}`}
        >
            <span className={`shrink-0 flex transition-colors
                ${active
                    ? 'text-gray-900 dark:text-white'
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
                ? { visibility: 'visible', left: 0, width: row.clientWidth }
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
                        dark:hover:bg-surface-control dark:hover:text-white"
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
                        dark:hover:bg-surface-control dark:hover:text-white"
                >
                    <PlusSignIcon size={15} strokeWidth={2.5} />
                </button>
            </div>

            {/* The search face: the pill, which is the magnifier grown. */}
            <div
                ref={pillRef}
                className="absolute top-1/2 -translate-y-1/2 h-7 rounded-full overflow-hidden
                    bg-gray-200 dark:bg-surface-control
                    focus-within:bg-gray-200/80 dark:focus-within:bg-surface-control/80
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
                className={`w-full flex items-center gap-2 pl-3 h-8 rounded-lg text-left text-[13px]
                    transition-colors ${FOCUS}
                    ${conversation.pinned ? 'pr-8' : 'pr-3'} group-hover/row:pr-14 group-focus-within/row:pr-14
                    ${active
                        ? 'bg-white dark:bg-surface-control text-gray-900 dark:text-white '
                            + 'ring-1 ring-black/[0.05] dark:ring-0 shadow-[0_1px_2px_rgba(16,24,40,0.05)] dark:shadow-none'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-900/[0.04] dark:hover:bg-surface-raised '
                            + 'hover:text-gray-900 dark:hover:text-gray-200'}`}
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
                    className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors
                        focus-visible:opacity-100
                        text-gray-400 dark:text-neutral-500
                        hover:bg-gray-900/[0.06] hover:text-gray-900 dark:hover:bg-white/[0.08] dark:hover:text-white
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
                        hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400"
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
     * Opening and shutting is GSAP's, from `lib/panelMotion`, which also holds
     * the width the sidebar opens to. Nothing is set here in a `style` prop:
     * a re-render mid-slide would write the far end of the movement straight
     * onto the element and the column would jump there.
     */
    useLayoutEffect(() => {
        const node = navRef.current;
        if (!node) return;

        const open = !collapsed;
        if (shown.current === open) {
            setSidebar(node, open);
            return;
        }
        shown.current = open;
        slideSidebar(node, open);
    }, [collapsed]);

    /**
     * The agent menu: every agent, the one selected ticked, and under them
     * the two things done to the list itself. A bin on an agent's row is
     * offered only while there is another to fall back to.
     */
    const agentSections = useMemo(() => {
        const actions = { new: onNewAgent, rename: onRenameAgent };
        return [
            {
                heading: t('agents.heading'),
                value: activeAgent?.id || '',
                onChange: (id) => onSelectAgent?.(id),
                options: agents.map(agent => ({
                    value: agent.id,
                    label: agent.name,
                    icon: <AgentMark size={14} look={agent} />,
                    onRemove: agents.length > 1 ? () => onDeleteAgent?.(agent.id) : undefined,
                })),
            },
            {
                value: '',
                onChange: (value) => actions[value]?.(),
                options: [
                    { value: 'new', label: t('agents.new'), icon: <PlusSignIcon size={14} strokeWidth={2} /> },
                    { value: 'rename', label: t('agents.rename'), icon: <PencilEdit02Icon size={14} strokeWidth={1.5} /> },
                ],
            },
        ];
    }, [agents, activeAgent, onSelectAgent, onNewAgent, onRenameAgent, onDeleteAgent, t]);

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

    return (
        <nav
            id="sidebar"
            ref={navRef}
            className="bg-gray-100 dark:bg-surface-base flex flex-col shrink-0 overflow-hidden"
        >
            <div className="flex flex-col gap-0.5 flex-1 min-h-0">
                <div className={CARD}>
                    {/* Who this column is about. Drawn as a menu rather than a
                        page, since choosing an agent is a switch, not a place to
                        go. Portalled: the column clips, and a list of agents
                        hanging off its foot would be cut off at the first row. */}
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
                                className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left
                                    transition-colors ${FOCUS}
                                    ${open ? ACTIVE : 'hover:bg-gray-900/[0.04] dark:hover:bg-surface-control/60'}`}
                            >
                                <AgentMark size={28} look={activeAgent} />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] leading-5 font-semibold truncate
                                        text-gray-900 dark:text-white">
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
                                    className="shrink-0 text-gray-400 dark:text-neutral-500"
                                />
                            </button>
                        )}
                    />

                    <div aria-hidden="true" className="mx-2 my-1 h-px bg-gray-900/[0.06] dark:bg-white/[0.05]" />

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

                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 pb-2">
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
    );
}

export default memo(Sidebar);
