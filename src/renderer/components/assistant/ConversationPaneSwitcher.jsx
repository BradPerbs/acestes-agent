import { memo } from 'react';
import { ArrowDown01Icon, PlusSignIcon } from 'hugeicons-react';
import PanelMenu from './PanelMenu';
import AgentMark from './AgentMark';
import { useT } from '../../i18n';

/**
 * Which conversation a split pane shows.
 *
 * A split pane used to be stuck with the chat it opened with: the only way
 * to see another one was to close the pane and split again. This is the
 * pane title as a menu, the way the scope selector is the panel title as a
 * menu: the thing you read to know which chat you are looking at is the
 * thing you click to look at another one.
 *
 * Portalled, because a split pane clips everything inside it and a menu
 * hanging below the header would be cut off at the pane edge.
 */

const NEW_VALUE = '__new__';

function ConversationPaneSwitcher({
    tab,
    title,
    agentLook = null,
    busy = false,
    tabs = [],
    onSwitch,
    onNew,
}) {
    const t = useT();

    const options = [
        ...tabs.map((entry) => ({
            value: entry.id,
            label: entry.title,
            icon: <AgentMark size={14} look={entry.agentLook} />,
        })),
        {
            value: NEW_VALUE,
            label: t('assistant.splitPickNew'),
            icon: <PlusSignIcon size={14} strokeWidth={2} />,
        },
    ];

    return (
        <PanelMenu
            portal
            align="left"
            menuClassName="w-72"
            className="min-w-0 flex-1"
            trigger={({ open, toggle }) => (
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={open}
                    aria-haspopup="menu"
                    title={t('assistant.switchConversationHint')}
                    className="w-full min-w-0 flex items-center gap-2 rounded-lg px-1 py-0.5
                        text-left transition-colors outline-none
                        hover:bg-gray-100 dark:hover:bg-surface-control
                        focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
                >
                    <AgentMark size={18} look={agentLook} className={busy ? 'animate-pulse' : ''} />
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-900 dark:text-white">
                        {title}
                    </span>
                    <ArrowDown01Icon
                        size={13}
                        strokeWidth={2.25}
                        className={`shrink-0 text-gray-400 dark:text-neutral-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                    />
                </button>
            )}
            sections={[
                {
                    heading: t('assistant.switchConversation'),
                    value: tab.id,
                    onChange: (value) => {
                        if (value === NEW_VALUE) onNew?.();
                        else onSwitch?.(value);
                    },
                    options,
                },
            ]}
        />
    );
}

export default memo(ConversationPaneSwitcher);
