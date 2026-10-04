import { memo, useEffect, useMemo, useRef } from 'react';
import {
    BrainIcon,
    CommandLineIcon,
    FlashIcon,
    Key01Icon,
    Note01Icon,
    PackageIcon,
    PlugSocketIcon,
    Route02Icon,
    ServerStack03Icon,
} from 'hugeicons-react';
import { OsIcon } from '../../lib/os-icons';
import { HEADING } from '../../lib/text-styles';
import { useT } from '../../i18n';

/**
 * What `@` opens: everything in the agent's inventory, filtered by what has
 * been typed after it.
 *
 * A list rather than a menu, and drawn over the composer rather than in it,
 * because it is answering a question the user is halfway through asking. The
 * keyboard drives it from the textarea, which keeps the caret where it is: the
 * arrows move the highlight, Enter and Tab take the highlighted row, Escape
 * puts the list away and leaves what was typed alone.
 *
 * The rows are grouped by class with a small heading each, so a query that
 * matches a host and a note reads as two answers rather than one jumbled list.
 */

/** What each class looks like in the list, and what its heading says. */
export const KIND_META = {
    host: { icon: ServerStack03Icon, tint: 'text-sky-600 dark:text-sky-300', label: 'nav.hosts' },
    snippet: { icon: FlashIcon, tint: 'text-emerald-600 dark:text-emerald-300', label: 'nav.snippets' },
    memory: { icon: BrainIcon, tint: 'text-pink-600 dark:text-pink-300', label: 'nav.memory' },
    proxy: { icon: Route02Icon, tint: 'text-violet-600 dark:text-violet-300', label: 'nav.proxies' },
    key: { icon: Key01Icon, tint: 'text-amber-600 dark:text-amber-300', label: 'nav.keychain' },
    mcp: { icon: PlugSocketIcon, tint: 'text-orange-600 dark:text-orange-300', label: 'nav.mcp' },
    skill: { icon: CommandLineIcon, tint: 'text-violet-600 dark:text-violet-300', label: 'skills.title' },
};

const ORDER = ['host', 'snippet', 'memory', 'proxy', 'key', 'mcp', 'skill'];

/**
 * One item's mark. A host wears its own OS icon, since that is how it is drawn
 * everywhere else; a snippet's depends on which of the three kinds it is.
 */
export function MentionIcon({ item, size = 14 }) {
    const meta = KIND_META[item.kind] || KIND_META.host;

    if (item.kind === 'host') {
        return <OsIcon os={item.os} distro={item.distro} className="w-3.5 h-3.5 shrink-0" />;
    }

    const Icon = item.kind === 'snippet' && item.snippetKind === 'spec'
        ? Note01Icon
        : item.kind === 'snippet' && item.snippetKind === 'package'
            ? PackageIcon
            : meta.icon;

    return <Icon size={size} strokeWidth={1.75} className={`shrink-0 ${meta.tint}`} />;
}

/** How well an item answers what has been typed after the `@`. */
function score(item, needle) {
    if (!needle) return 1;
    const name = item.name.toLowerCase();
    if (name.startsWith(needle)) return 3;
    if (name.includes(needle)) return 2;
    if ((item.hint || '').toLowerCase().includes(needle)) return 1;
    if (item.tags?.some(tag => tag.toLowerCase().includes(needle))) return 1;
    return 0;
}

/** The items worth showing, best first, kept to a list that fits on screen. */
export function matchMentions(items, query, limit = 40) {
    const needle = String(query || '').trim().toLowerCase();
    return items
        .map(item => ({ item, rank: score(item, needle) }))
        .filter(entry => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit)
        .map(entry => entry.item);
}

function MentionPicker({ items, query, active, onPick, onHover }) {
    const t = useT();
    const listRef = useRef(null);

    // The highlighted row stays in view while the arrows walk past the end of
    // what is drawn.
    useEffect(() => {
        listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    /** The rows in the order the keyboard walks them, split into class runs. */
    const groups = useMemo(() => {
        const byKind = new Map();
        items.forEach((item, index) => {
            if (!byKind.has(item.kind)) byKind.set(item.kind, []);
            byKind.get(item.kind).push({ item, index });
        });
        return ORDER.filter(kind => byKind.has(kind)).map(kind => ({ kind, rows: byKind.get(kind) }));
    }, [items]);

    return (
        <div
            role="listbox"
            className="absolute bottom-full left-0 right-0 mb-2 z-40 rounded-xl overflow-hidden
                bg-white dark:bg-surface-raised
                border border-gray-200 dark:border-surface-control
                shadow-xl shadow-black/10 dark:shadow-black/40"
        >
            <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
                {items.length === 0 ? (
                    <p className="px-2.5 py-3 text-center text-[11px] text-gray-500 dark:text-neutral-400">
                        {query
                            ? t('mentions.noMatches', { query })
                            : t('mentions.emptyInventory')}
                    </p>
                ) : groups.map(group => (
                    <div key={group.kind}>
                        <div className={`px-2.5 pt-1.5 pb-1 ${HEADING}`}>
                            {t(KIND_META[group.kind]?.label || 'nav.inventory')}
                        </div>
                        {group.rows.map(({ item, index }) => (
                            <button
                                key={`${item.kind}:${item.id}`}
                                type="button"
                                role="option"
                                aria-selected={index === active}
                                data-active={index === active ? 'true' : 'false'}
                                onMouseMove={() => onHover(index)}
                                // The pointer must not take the caret out of the
                                // textarea before the click lands on the row.
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => onPick(item)}
                                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left
                                    transition-colors
                                    ${index === active
                                        ? 'bg-gray-100 dark:bg-surface-control'
                                        : 'hover:bg-gray-50 dark:hover:bg-white/[0.04]'}`}
                            >
                                <MentionIcon item={item} />
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] font-medium truncate
                                        text-gray-900 dark:text-white">
                                        {item.name}
                                    </span>
                                    {item.hint && (
                                        <span className="block text-[11px] truncate
                                            text-gray-500 dark:text-neutral-400">
                                            {item.hint}
                                        </span>
                                    )}
                                </span>
                            </button>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

export default memo(MentionPicker);
