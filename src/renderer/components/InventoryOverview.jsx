import { memo, useEffect, useMemo, useState } from 'react';
import {
    ArrowRight01Icon,
    BrainIcon,
    FlashIcon,
    Key01Icon,
    Note01Icon,
    PackageIcon,
    PlugSocketIcon,
    PlusSignIcon,
    Route02Icon,
    ServerStack03Icon,
    SquareLock02Icon,
} from 'hugeicons-react';
import AgentMark from './assistant/AgentMark';
import { OsIcon, hostOs } from '../lib/os-icons';
import { isPackage, isSpec } from '../lib/snippets';
import { useProxies } from '../hooks/useProxies';
import { useSnippets } from '../hooks/useSnippets';
import { useT } from '../i18n';

/**
 * The inventory at a glance, drawn the way a game draws one: the agent's
 * card, and beside it a bag per class of thing it carries.
 *
 * The bags are laid out on a grid that packs them rather than stacks them:
 * a bag with a lot in it takes two columns, the rest take one, and they flow
 * around each other. Inside a bag is a grid of slots, the items in the first
 * ones and the rest of the last row left empty, so every bag is whole rows
 * of squares the way an inventory screen is. Each class keeps its colour, but
 * only as a wash: a soft tint of it behind the mark, no ring, no bevel, the
 * same flat tile the host and key cards put their icons on. A bag with
 * nothing in it is one row of empty slots, the first with a plus. Any slot,
 * and any bag's header, opens the page for that class.
 */

/** Slots per row, and how many rows a bag shows before its last slot says "+N". */
const COLUMNS = 6;
const ROWS = 3;

/** Past two rows' worth of items a bag spreads across two columns of the page. */
const WIDE_AT = COLUMNS * 2 + 1;

const inAgent = (agentId) => (record) => !record.agentId || !agentId || record.agentId === agentId;

/**
 * The square itself. The corner keeps IconTile's proportion (a third of the
 * side), so a slot here and an icon on a host card are the same shape.
 */
const SLOT = 'w-11 h-11 rounded-[14px] flex items-center justify-center transition-colors';

/** The same card surface as the host and key cards' pages: rounded-2xl, hairline edge. */
const CARD = `flex flex-col rounded-2xl border min-w-0
    border-black/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.02]`;

/** The name line under a slot, or the space it would take so rows stay level. */
const CAPTION = 'w-full h-3.5 text-center text-[11px] leading-[14px] truncate';

/** A slot with nothing in it, or, as the first of an empty bag, the way to add one. */
function EmptySlot({ onClick, label }) {
    return (
        <div className="flex flex-col items-center gap-1.5 w-full min-w-0">
            {onClick ? (
                <button
                    type="button"
                    aria-label={label}
                    title={label}
                    onClick={onClick}
                    className={`${SLOT} outline-none border border-dashed border-gray-900/[0.14] dark:border-white/[0.14]
                        text-gray-400 dark:text-neutral-500 hover:text-gray-900 dark:hover:text-white
                        hover:border-gray-900/30 dark:hover:border-white/30
                        focus-visible:ring-2 focus-visible:ring-gray-900/25 dark:focus-visible:ring-white/30`}
                >
                    <PlusSignIcon size={16} strokeWidth={1.75} />
                </button>
            ) : (
                <span aria-hidden="true" className={`${SLOT} bg-gray-900/[0.03] dark:bg-white/[0.03]`} />
            )}
            <span className={CAPTION} aria-hidden="true" />
        </div>
    );
}

function Slot({ icon, label, title, tint, onClick }) {
    return (
        <button
            type="button"
            title={title || label}
            onClick={onClick}
            className="group/slot flex flex-col items-center gap-1.5 w-full min-w-0 outline-none"
        >
            <span className={`${SLOT} ${tint}
                group-focus-visible/slot:ring-2 group-focus-visible/slot:ring-gray-900/25 dark:group-focus-visible/slot:ring-white/30`}>
                {icon}
            </span>
            <span className={`${CAPTION} transition-colors text-gray-500 dark:text-neutral-500
                group-hover/slot:text-gray-900 dark:group-hover/slot:text-white`}>
                {label}
            </span>
        </button>
    );
}

/** One class as a bag: its name and count across the top, its slots beneath. */
function Shelf({ shelf, onOpen, t }) {
    const wide = shelf.items.length >= WIDE_AT;
    const columns = wide ? COLUMNS * 2 : COLUMNS;
    const limit = columns * ROWS;
    const count = shelf.items.length;
    const shown = count > limit ? shelf.items.slice(0, limit - 1) : shelf.items;
    const rest = count - shown.length;
    const open = () => onOpen(shelf.page);

    // Whatever the last row does not use stays as empty slots, so the bag is
    // always whole rows. An empty bag is one row of them.
    const used = shown.length + (rest > 0 ? 1 : 0);
    const vacant = used === 0 ? columns : (columns - (used % columns)) % columns;

    return (
        <section className={`${CARD} ${wide ? 'sm:col-span-2' : ''}`}>
            <button
                type="button"
                onClick={open}
                className="group flex items-center gap-2 w-full h-11 px-4 text-left rounded-t-2xl outline-none
                    focus-visible:bg-gray-900/[0.03] dark:focus-visible:bg-white/[0.04]"
            >
                <span className={`flex items-center justify-center ${shelf.mark}`}>{shelf.icon}</span>
                <span className="text-[13px] font-semibold text-gray-900 dark:text-white truncate">{shelf.title}</span>
                <span className="text-xs font-medium tabular-nums text-gray-400 dark:text-neutral-500">{count}</span>
                <span className="ml-auto flex items-center gap-1 text-xs font-medium text-gray-400 dark:text-neutral-500
                    group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                    <span className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">
                        {t('inventory.open')}
                    </span>
                    <ArrowRight01Icon size={14} strokeWidth={2} />
                </span>
            </button>

            <div className={`grid gap-x-1 gap-y-2 px-3 pb-3 ${wide ? 'grid-cols-6 sm:grid-cols-12' : 'grid-cols-6'}`}>
                {shown.map(item => (
                    <Slot key={item.key} {...item} tint={shelf.tint} onClick={open} />
                ))}
                {rest > 0 && (
                    <div className="flex flex-col items-center gap-1.5 w-full min-w-0">
                        <button
                            type="button"
                            title={t('inventory.more', { count: rest })}
                            onClick={open}
                            className={`${SLOT} outline-none text-[11px] font-semibold tabular-nums
                                bg-gray-900/[0.06] dark:bg-white/[0.07] text-gray-500 dark:text-gray-400
                                hover:bg-gray-900/[0.1] dark:hover:bg-white/[0.11] hover:text-gray-900 dark:hover:text-white
                                focus-visible:ring-2 focus-visible:ring-gray-900/25 dark:focus-visible:ring-white/30`}
                        >
                            +{rest}
                        </button>
                        <span className={CAPTION} aria-hidden="true" />
                    </div>
                )}
                {Array.from({ length: vacant }, (_, index) => (
                    <EmptySlot
                        key={`empty:${index}`}
                        onClick={count === 0 && index === 0 ? open : undefined}
                        label={t('inventory.add', { what: shelf.title })}
                    />
                ))}
            </div>
        </section>
    );
}

/** The agent's own card: who carries all this, and how much of each class there is. */
function AgentCard({ agent, shelves, total, onOpen, t }) {
    return (
        // Two rows of the page tall, so the bags beside it stay the height of
        // what is in them rather than stretching to match it.
        <section className={`${CARD} sm:row-span-2`}>
            <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                <AgentMark size={40} animated color={agent?.color} />
                <div className="min-w-0">
                    <div className="text-[15px] font-semibold text-gray-900 dark:text-white truncate">
                        {agent?.name || t('agents.agent')}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-neutral-500">
                        {t('inventory.carrying', { count: total })}
                    </div>
                </div>
            </div>

            {/* One line per class, its mark in its colour and the count at the
                far end; each opens its page. */}
            <div className="px-2 pb-2">
                {shelves.map(shelf => (
                    <button
                        key={shelf.page}
                        type="button"
                        onClick={() => onOpen(shelf.page)}
                        className="flex items-center gap-2.5 w-full h-8 px-2 rounded-lg text-left text-[13px]
                            outline-none transition-colors hover:bg-gray-900/[0.04] dark:hover:bg-white/[0.05]
                            focus-visible:ring-2 focus-visible:ring-gray-900/25 dark:focus-visible:ring-white/30"
                    >
                        <span className={`flex items-center justify-center ${shelf.mark}`}>{shelf.icon}</span>
                        <span className="flex-1 min-w-0 truncate text-gray-600 dark:text-gray-300">{shelf.title}</span>
                        <span className={`tabular-nums font-medium
                            ${shelf.items.length ? 'text-gray-900 dark:text-white' : 'text-gray-400 dark:text-neutral-500'}`}>
                            {shelf.items.length}
                        </span>
                    </button>
                ))}
            </div>
        </section>
    );
}

function InventoryOverview({ hosts = [], keys = [], agentId = '', activeAgent = null, onOpen }) {
    const t = useT();
    const { proxies: allProxies } = useProxies();
    const { snippets: allSnippets } = useSnippets();
    const [notes, setNotes] = useState([]);

    // The keychain page holds keys and secrets behind one switch, so the bag
    // that stands for it counts both. Names and dates only, the way the page
    // itself shows them; the values never leave the main process.
    const [secrets, setSecrets] = useState([]);

    useEffect(() => {
        let cancelled = false;
        window.api.secrets?.list?.()
            .then(list => { if (!cancelled) setSecrets(Array.isArray(list) ? list : []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const read = () => window.api.memory.list(agentId)
            .then(list => { if (!cancelled) setNotes(list || []); })
            .catch(() => {});
        if (agentId) read();
        const off = window.api.memory.onChange?.((change) => {
            if (!change?.agentId || change.agentId === agentId) read();
        });
        return () => {
            cancelled = true;
            off?.();
        };
    }, [agentId]);

    const mine = useMemo(() => inAgent(agentId), [agentId]);
    const proxies = useMemo(() => allProxies.filter(mine), [allProxies, mine]);
    const snippets = useMemo(() => allSnippets.filter(mine), [allSnippets, mine]);
    const servers = activeAgent?.mcpServers || [];

    const shelves = [
        {
            page: 'hosts',
            title: t('nav.hosts'),
            icon: <ServerStack03Icon size={15} strokeWidth={1.75} />,
            tint: 'bg-sky-500/10 text-sky-600 group-hover/slot:bg-sky-500/[0.18] '
                + 'dark:bg-sky-400/10 dark:text-sky-300 dark:group-hover/slot:bg-sky-400/[0.18]',
            mark: 'text-sky-600 dark:text-sky-300',
            items: hosts.map(host => ({
                key: host.id,
                label: host.name || host.host,
                title: `${host.name || ''} ${host.username ? `${host.username}@` : ''}${host.host || host.serial?.path || ''}`.trim(),
                icon: <OsIcon os={hostOs(host)} distro={host.distro} className="w-5 h-5" />,
            })),
        },
        {
            page: 'keychain',
            title: t('nav.keychain'),
            icon: <Key01Icon size={15} strokeWidth={1.75} />,
            tint: 'bg-amber-500/10 text-amber-600 group-hover/slot:bg-amber-500/[0.18] '
                + 'dark:bg-amber-400/10 dark:text-amber-300 dark:group-hover/slot:bg-amber-400/[0.18]',
            mark: 'text-amber-600 dark:text-amber-300',
            items: [
                ...keys.map(key => ({
                    key: key.id,
                    label: key.name,
                    title: `${key.name}${key.type ? ` · ${key.type}` : ''}`,
                    icon: <Key01Icon size={20} strokeWidth={1.5} />,
                })),
                // Told apart by their glyph rather than by a heading, because
                // the bag is one grid and a padlock among the keys is
                // already the whole distinction.
                ...secrets.map(secret => ({
                    key: `secret:${secret.name}`,
                    label: secret.name,
                    title: secret.reference,
                    icon: <SquareLock02Icon size={20} strokeWidth={1.5} />,
                })),
            ],
        },
        {
            page: 'proxies',
            title: t('nav.proxies'),
            icon: <Route02Icon size={15} strokeWidth={1.75} />,
            tint: 'bg-violet-500/10 text-violet-600 group-hover/slot:bg-violet-500/[0.18] '
                + 'dark:bg-violet-400/10 dark:text-violet-300 dark:group-hover/slot:bg-violet-400/[0.18]',
            mark: 'text-violet-600 dark:text-violet-300',
            items: proxies.map(proxy => ({
                key: proxy.id,
                label: proxy.name || proxy.host,
                title: `${proxy.type?.toUpperCase() || ''} ${proxy.host}:${proxy.port}`.trim(),
                icon: <Route02Icon size={20} strokeWidth={1.5} />,
            })),
        },
        {
            page: 'snippets',
            title: t('nav.snippets'),
            icon: <FlashIcon size={15} strokeWidth={1.75} />,
            tint: 'bg-emerald-500/10 text-emerald-600 group-hover/slot:bg-emerald-500/[0.18] '
                + 'dark:bg-emerald-400/10 dark:text-emerald-300 dark:group-hover/slot:bg-emerald-400/[0.18]',
            mark: 'text-emerald-600 dark:text-emerald-300',
            items: snippets.map(snippet => ({
                key: snippet.id,
                label: snippet.name,
                title: snippet.description || snippet.name,
                icon: isSpec(snippet)
                    ? <Note01Icon size={20} strokeWidth={1.5} />
                    : isPackage(snippet)
                        ? <PackageIcon size={20} strokeWidth={1.5} />
                        : <FlashIcon size={20} strokeWidth={1.5} />,
            })),
        },
        {
            page: 'memory',
            title: t('nav.memory'),
            icon: <BrainIcon size={15} strokeWidth={1.75} />,
            tint: 'bg-pink-500/10 text-pink-600 group-hover/slot:bg-pink-500/[0.18] '
                + 'dark:bg-pink-400/10 dark:text-pink-300 dark:group-hover/slot:bg-pink-400/[0.18]',
            mark: 'text-pink-600 dark:text-pink-300',
            items: notes.map(note => ({
                key: note.id,
                label: note.tags[0] ? `#${note.tags[0]}` : note.text,
                title: note.text,
                icon: <BrainIcon size={20} strokeWidth={1.5} />,
            })),
        },
        {
            page: 'mcp',
            title: t('nav.mcp'),
            icon: <PlugSocketIcon size={15} strokeWidth={1.75} />,
            tint: 'bg-orange-500/10 text-orange-600 group-hover/slot:bg-orange-500/[0.18] '
                + 'dark:bg-orange-400/10 dark:text-orange-300 dark:group-hover/slot:bg-orange-400/[0.18]',
            mark: 'text-orange-600 dark:text-orange-300',
            items: servers.map(server => ({
                key: server.id,
                label: server.name,
                title: server.transport === 'http' ? server.url : [server.command, ...(server.args || [])].join(' '),
                icon: <PlugSocketIcon size={20} strokeWidth={1.5} />,
            })),
        },
    ];

    const total = shelves.reduce((sum, shelf) => sum + shelf.items.length, 0);

    return (
        <div
            id="inventory-overview"
            // Packed, not stacked: wide bags take two columns and the rest
            // fill in around them.
            className="grid gap-3 pb-2 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 [grid-auto-flow:dense]"
        >
            <AgentCard agent={activeAgent} shelves={shelves} total={total} onOpen={onOpen} t={t} />
            {shelves.map(shelf => (
                <Shelf key={shelf.page} shelf={shelf} onOpen={onOpen} t={t} />
            ))}
        </div>
    );
}

export default memo(InventoryOverview);
