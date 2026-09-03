import { memo } from 'react';
import { useT } from '../i18n';

/**
 * The pages of the inventory, as a row of tabs above whichever is up.
 *
 * Everything an agent works from is one place in the sidebar and several
 * pages here: the hosts it can reach, the keys and proxies those need, the
 * snippets and specs it can be handed, the MCP servers whose tools it gets,
 * and the log of what was done. One row rather than six sidebar entries, so
 * the column stays about the agent and this stays about its things.
 */
export const INVENTORY_PAGES = ['overview', 'hosts', 'keychain', 'proxies', 'snippets', 'memory', 'mcp', 'jobs', 'runs', 'logs'];

function InventoryTabs({ active, onChange }) {
    const t = useT();

    return (
        <div role="tablist" className="shrink-0 flex items-center gap-1 mb-4 -mt-1 overflow-x-auto scrollbar-none">
            {INVENTORY_PAGES.map(page => (
                <button
                    key={page}
                    type="button"
                    role="tab"
                    aria-selected={active === page}
                    onClick={() => onChange(page)}
                    className={`shrink-0 px-3 h-8 rounded-lg text-sm font-medium transition-colors
                        ${active === page
                            ? 'bg-gray-900/[0.08] dark:bg-surface-control text-gray-900 dark:text-white'
                            : 'text-gray-500 dark:text-gray-400 hover:bg-gray-900/[0.04] dark:hover:bg-surface-control '
                                + 'hover:text-gray-900 dark:hover:text-white'}`}
                >
                    {t(`nav.${page}`)}
                </button>
            ))}
        </div>
    );
}

export default memo(InventoryTabs);
