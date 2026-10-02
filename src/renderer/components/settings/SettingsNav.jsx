import { Fragment, memo, useCallback, useRef } from 'react';
import {
    SlidersHorizontalIcon,
    PaintBoardIcon,
    ServerStack01Icon,
    ShieldKeyIcon,
    Archive01Icon,
    InformationCircleIcon,
    UserShield01Icon,
    CursorMagicSelection01Icon,
    BubbleChatIcon,
} from 'hugeicons-react';
import AgentMark from '../assistant/AgentMark';
import Tooltip from '../ui/Tooltip';
import { useT } from '../../i18n';

/**
 * The agent's own mark, rather than a generic sparkle.
 *
 * The same cloud that sits on the rail button, in the same `mono` treatment, so
 * the row that configures the agent is recognisably about the thing the button
 * opens. A few pixels larger than its neighbours because the artwork is wider
 * than it is tall and letterboxes inside a square box.
 */
const AgentIcon = ({ size = 17, className = '' }) => (
    <AgentMark size={size + 3} mono className={className} />
);

/**
 * The categories, in the order they are shown. Adding a page means adding an
 * entry here, a matching component in the panel's page map, and a
 * `settings.nav.<id>` string in the catalogs. The nav and the router read from
 * the same list, so the two cannot drift apart.
 *
 * `group` draws a rule above the first category of each run, so the agent's
 * pages read as one block between the app's own.
 */
export const SETTINGS_CATEGORIES = [
    { id: 'general', icon: SlidersHorizontalIcon, group: 'app' },
    // The agent second, right under the app's own basics: it is what the
    // app is about. It was one page of twenty cards, which nobody could find
    // a setting on, so it is four: the agent and its models, what it may do
    // without asking, what it can reach and operate (computer use, the
    // browser), and the chat itself.
    { id: 'assistant', icon: AgentIcon, group: 'agent' },
    { id: 'permissions', icon: UserShield01Icon, group: 'agent' },
    { id: 'agentic', icon: CursorMagicSelection01Icon, group: 'agent' },
    { id: 'chat', icon: BubbleChatIcon, group: 'agent' },
    // Everything to do with terminals, sessions and servers is one category,
    // as tabs of a single page.
    { id: 'appearance', icon: PaintBoardIcon, group: 'machine' },
    { id: 'servers', icon: ServerStack01Icon, group: 'machine' },
    { id: 'security', icon: ShieldKeyIcon, group: 'machine' },
    { id: 'backup', icon: Archive01Icon, group: 'machine' },
    { id: 'about', icon: InformationCircleIcon, group: 'machine' },
];

/**
 * Which page a jump into settings for one card lands on. The chat's "create
 * quick prompts" and the usage popover's "manage accounts" name a card; the
 * card decides the page, so the caller does not need to know the layout.
 */
const FOCUS_CATEGORY = {
    quickPrompts: 'chat',
    accounts: 'assistant',
};

export const categoryForFocus = (focus) => FOCUS_CATEGORY[focus] || 'assistant';

/**
 * Sent on the window when something outside settings asks for one of its
 * pages. Settings stays mounted behind a conversation tab, so a jump made
 * while it is already open would otherwise land on whatever page was up.
 */
export const SETTINGS_JUMP = 'settings-jump';

/**
 * The category list, or the same list as a rail of icons.
 *
 * `collapsed` is the panel saying the page is short of width. 160px of names
 * beside a card whose rows have stopped fitting is the easiest 124px on the
 * screen to give back: the icons are the part people navigate by once they know
 * the list, and the names come back as tooltips for the times they do not.
 *
 * The names are tooltips rather than nothing, and the buttons keep their
 * `aria-current` and their place in the arrow-key walk, so the only thing that
 * changes is how much of it is drawn.
 */
function SettingsNav({ active, onChange, collapsed = false }) {
    const listRef = useRef(null);
    const t = useT();

    /**
     * Arrow keys walk the list and wrap, with only the active item in the tab
     * order. Tab therefore steps past the whole nav into the page, rather than
     * through six stops before reaching the setting you came for.
     */
    const handleKeyDown = useCallback((event) => {
        const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;

        event.preventDefault();

        const total = SETTINGS_CATEGORIES.length;
        const current = SETTINGS_CATEGORIES.findIndex(category => category.id === active);
        const next = (current + step + total) % total;

        onChange(SETTINGS_CATEGORIES[next].id);
        listRef.current?.querySelectorAll('button')[next]?.focus();
    }, [active, onChange]);

    return (
        <nav
            ref={listRef}
            aria-label={t('settings.nav.aria')}
            onKeyDown={handleKeyDown}
            className={`sticky top-0 shrink-0 flex flex-col gap-0.5 ${collapsed ? 'w-9' : 'w-40'}`}
        >
            {SETTINGS_CATEGORIES.map(({ id, icon: Icon, group }, index) => {
                const isActive = id === active;
                const label = t(`settings.nav.${id}`);
                // Not a button, so the arrow-key walk (which indexes buttons)
                // steps straight over it.
                const startsGroup = index > 0 && SETTINGS_CATEGORIES[index - 1].group !== group;
                const rule = startsGroup && (
                    <div
                        role="separator"
                        aria-hidden="true"
                        className={`my-1.5 h-px bg-gray-900/[0.08] dark:bg-white/[0.08] ${collapsed ? 'mx-1.5' : 'mx-3'}`}
                    />
                );

                const button = (
                    <button
                        key={id}
                        type="button"
                        aria-current={isActive ? 'page' : undefined}
                        aria-label={collapsed ? label : undefined}
                        tabIndex={isActive ? 0 : -1}
                        onClick={() => onChange(id)}
                        className={`flex items-center h-9 rounded-xl text-left outline-none
                            text-sm transition-colors
                            focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                            ${collapsed ? 'w-9 justify-center' : 'gap-2.5 px-3'}
                            ${isActive
                                ? 'bg-gray-900/[0.08] dark:bg-surface-control text-gray-900 dark:text-white font-semibold'
                                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-900/[0.04] dark:hover:bg-surface-raised'
                            }`}
                    >
                        <Icon size={17} strokeWidth={isActive ? 2 : 1.5} className="shrink-0" />
                        {!collapsed && label}
                    </button>
                );

                // To the side rather than below: a rail is a column of ten of
                // these, and a bubble under one covers the next.
                return (
                    <Fragment key={id}>
                        {rule}
                        {collapsed
                            ? <Tooltip label={label} placement="right">{button}</Tooltip>
                            : button}
                    </Fragment>
                );
            })}
        </nav>
    );
}

export default memo(SettingsNav);
