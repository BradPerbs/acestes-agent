import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import {
    ArrowDown01Icon,
    Delete02Icon,
    Layers01Icon,
    PencilEdit02Icon,
    PlusSignIcon,
    Settings01Icon,
} from 'hugeicons-react';
import { setSidebar, slideSidebar } from '../lib/panelMotion';
import AgentMark from './assistant/AgentMark';
import PanelMenu from './assistant/PanelMenu';
import { useT } from '../i18n';

/**
 * The column down the left: which agent, and the agent's own things.
 *
 * The agent is the thing the app is about, so it is the first thing in the
 * column and everything under it is that agent's: the inventory it works
 * from, its settings, and its conversations, newest first, with the one on
 * screen lit. Changing the agent changes all of it.
 */

const ITEM = 'nav-item flex items-center gap-3 rounded-xl cursor-pointer transition-colors';
const ACTIVE = 'bg-gray-900/[0.08] dark:bg-surface-control text-gray-900 dark:text-white';
const IDLE = 'text-gray-600 dark:text-gray-400 hover:bg-gray-900/[0.04] dark:hover:bg-surface-raised';

/** How many chats the column lists before it is a page's job. */
const LIST_LIMIT = 40;

function NavItem({ label, icon, active, onClick }) {
    return (
        <div className={`${ITEM} px-3 py-2.5 ${active ? ACTIVE : IDLE}`} onClick={onClick}>
            {icon}
            <span className="text-sm">{label}</span>
        </div>
    );
}

/** One chat in the list: its title, whether it is working, and a bin on hover. */
function ConversationRow({ conversation, active, onOpen, onDelete, deleteLabel }) {
    const t = useT();
    const title = conversation.title || t('assistant.newConversation');

    return (
        <div className="relative group/row">
            <button
                type="button"
                onClick={onOpen}
                title={title}
                className={`w-full flex items-center gap-2 pl-3 pr-8 py-1.5 rounded-lg text-left text-[13px]
                    transition-colors outline-none
                    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                    ${active
                        ? 'bg-gray-900/[0.08] dark:bg-surface-control text-gray-900 dark:text-white'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-900/[0.04] dark:hover:bg-surface-raised '
                            + 'hover:text-gray-900 dark:hover:text-gray-200'}`}
            >
                {/* Working, said as a dot, the way the tab strip says it. */}
                {conversation.busy && (
                    <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                )}
                <span className="min-w-0 flex-1 truncate">{title}</span>
            </button>

            <button
                type="button"
                aria-label={deleteLabel}
                onClick={onDelete}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md
                    flex items-center justify-center transition-colors
                    opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100
                    text-gray-400 dark:text-neutral-500
                    hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400"
            >
                <Delete02Icon size={13} strokeWidth={1.5} />
            </button>
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
                    icon: <AgentMark size={14} color={agent.color} />,
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

    const listed = conversations.slice(0, LIST_LIMIT);

    return (
        <nav
            id="sidebar"
            ref={navRef}
            className="bg-gray-100 dark:bg-surface-base flex flex-col shrink-0 overflow-hidden"
        >
            <div className="flex flex-col gap-1 flex-1 min-h-0">
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
                            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left
                                transition-colors outline-none
                                focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                                ${open ? ACTIVE : 'hover:bg-gray-900/[0.04] dark:hover:bg-surface-raised'}`}
                        >
                            <AgentMark size={26} color={activeAgent?.color} />
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-semibold truncate text-gray-900 dark:text-white">
                                    {activeAgent?.name || t('agents.agent')}
                                </span>
                                <span className="block text-[11px] leading-tight truncate text-gray-500 dark:text-gray-500">
                                    {t('agents.agent')}
                                </span>
                            </span>
                            <ArrowDown01Icon
                                size={14}
                                strokeWidth={2}
                                className={`shrink-0 text-gray-400 dark:text-gray-500 transition-transform
                                    ${open ? 'rotate-180' : ''}`}
                            />
                        </button>
                    )}
                />

                <NavItem
                    label={t('nav.inventory')}
                    icon={<Layers01Icon className="w-5 h-5" size={20} strokeWidth={1.5} />}
                    active={activeNav === 'inventory'}
                    onClick={() => onNavChange('inventory')}
                />
                <NavItem
                    label={t('nav.settings')}
                    icon={<Settings01Icon className="w-5 h-5" size={20} strokeWidth={1.5} />}
                    active={activeNav === 'settings'}
                    onClick={() => onNavChange('settings')}
                />

                {/* The conversations: a heading that is also the way to the
                    page listing all of them, the plus beside it, and the
                    newest underneath. */}
                <div className="mt-2 flex items-center pl-3 pr-1.5">
                    <button
                        type="button"
                        onClick={() => onNavChange('conversations')}
                        className={`flex-1 min-w-0 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider
                            transition-colors truncate
                            ${activeNav === 'conversations'
                                ? 'text-gray-900 dark:text-white'
                                : 'text-gray-500 dark:text-neutral-500 hover:text-gray-900 dark:hover:text-gray-200'}`}
                    >
                        {t('nav.conversations')}
                    </button>
                    <button
                        type="button"
                        aria-label={t('conversations.new')}
                        title={t('conversations.new')}
                        onClick={onNewConversation}
                        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-colors
                            text-gray-500 dark:text-gray-400
                            hover:bg-gray-900/[0.06] hover:text-gray-900
                            dark:hover:bg-surface-control dark:hover:text-white"
                    >
                        <PlusSignIcon size={15} strokeWidth={2.5} />
                    </button>
                </div>

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
