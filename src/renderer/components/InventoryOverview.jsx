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
} from 'hugeicons-react';
import AgentMark from './assistant/AgentMark';
import { OsIcon, hostOs } from '../lib/os-icons';
import { isPackage, isSpec } from '../lib/snippets';
import { useProxies } from '../hooks/useProxies';
import { useSnippets } from '../hooks/useSnippets';
import { useT } from '../i18n';

/**
 * The inventory at a glance, drawn the way a game draws one: the agent's
 * card, and around it a pouch per class of thing it carries.
 *
 * The pouches are laid out on a grid that packs them rather than stacks
 * them: a pouch with a lot in it takes two columns, the rest take one, and
 * they flow around each other so the page reads as a bag with compartments
 * rather than as a list of lists. Inside a pouch the items are small round
 * tokens, packed close, each with its mark and its name. A pouch with nothing
 * in it shows a few empty slots and a plus, so the shape of what is missing
 * is as visible as what is there. Any token, and any pouch, opens the page
 * for that class.
 */

/**
 * Tokens per row, and how many rows a pouch shows before it says "+N". A
 * pouch is a grid of full rows: the last cell of a full pouch is the count
 * of what did not fit, so a row is never left ragged.
 */
const COLUMNS = 5;
const ROWS = 4;

/** Past this many items a pouch spreads across two columns. */
const WIDE_AT = 8;

const inAgent = (agentId) => (record) => !record.agentId || !agentId || record.agentId === agentId;

/** The token itself: a small rounded tile in the class colour, the mark on it. */
const TILE = `w-11 h-11 rounded-[14px] flex items-center justify-center transition-all
    ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]
    shadow-[inset_0_-3px_6px_rgba(0,0,0,0.08),inset_0_1px_0_rgba(255,255,255,0.5)]
    dark:shadow-[inset_0_-3px_6px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.08)]`;

function Token({ icon, label, tint, title, onClick }) {
    return (
        <button
            type="button"
            title={title || label}
            onClick={onClick}
            className="group flex flex-col items-center gap-0.5 w-full min-w-0 outline-none"
        >
            <span
                className={`${TILE} ${tint}
                    group-hover:-translate-y-0.5 group-hover:shadow-lg group-hover:shadow-black/15
                    dark:group-hover:shadow-black/50 group-hover:ring-black/20 dark:group-hover:ring-white/30
                    group-focus-visible:ring-2 group-focus-visible:ring-gray-900/40 dark:group-focus-visible:ring-white/50`}
            >
                {icon}
            </span>
            <span className="w-full text-center text-[10px] leading-tight truncate
                text-gray-500 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-white">
                {label}
            </span>
        </button>
    );
}

/** A slot with nothing in it: the outline of where a token would go. */
function EmptySlot({ onClick, first, label }) {
    return (
        <div className="flex flex-col items-center gap-0.5 w-full min-w-0">
            <button
                type="button"
                aria-label={first ? label : undefined}
                aria-hidden={first ? undefined : true}
                tabIndex={first ? 0 : -1}
                onClick={onClick}
                className={`w-11 h-11 rounded-[14px] border border-dashed flex items-center justify-center
                    transition-colors outline-none border-black/[0.12] dark:border-white/[0.12]
                    ${first
                        ? 'text-gray-400 dark:text-neutral-500 hover:border-black/30 dark:hover:border-white/30 '
                            + 'hover:text-gray-900 dark:hover:text-white cursor-pointer'
                        : 'pointer-events-none opacity-50'}`}
            >
                {first && <PlusSignIcon size={15} strokeWidth={2} />}
            </button>
            <span className="h-[12px]" aria-hidden="true" />
        </div>
    );
}

/** A token standing in for the items past the limit. */
function MoreToken({ count, onClick, label }) {
    return (
        <div className="flex flex-col items-center gap-0.5 w-full min-w-0">
            <button
                type="button"
                title={label}
                onClick={onClick}
                className="w-11 h-11 rounded-[14px] flex items-center justify-center text-[11px] font-semibold
                    tabular-nums transition-colors ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.1]
                    text-gray-500 dark:text-gray-400
                    hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:text-gray-900 dark:hover:text-white"
            >
                +{count}
            </button>
            <span className="h-[12px]" aria-hidden="true" />
        </div>
    );
}

/** One class as a compartment: its name and count across the top, its tokens packed inside. */
function Pouch({ shelf, onOpen, t }) {
    const wide = shelf.items.length >= WIDE_AT;
    // A wide pouch is two columns of the page, so it takes two rows' worth
    // of tokens per row and shows the same number of rows.
    const columns = wide ? COLUMNS * 2 : COLUMNS;
    const limit = columns * ROWS;
    const shown = shelf.items.length > limit ? shelf.items.slice(0, limit - 1) : shelf.items;
    const rest = shelf.items.length - shown.length;
    const open = () => onOpen(shelf.page);

    return (
        <section
            className={`flex flex-col rounded-2xl border p-3 gap-3 min-w-0
                border-black/[0.06] dark:border-white/[0.07]
                bg-white/50 dark:bg-white/[0.025]
                ${wide ? 'sm:col-span-2' : ''}`}
        >
            <button
                type="button"
                onClick={open}
                className="group flex items-center gap-2 w-full text-left rounded-lg outline-none
                    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
            >
                <span className={`flex items-center justify-center ${shelf.mark}`}>{shelf.icon}</span>
                <span className="text-[13px] font-semibold text-gray-900 dark:text-white truncate">{shelf.title}</span>
                <span className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold tabular-nums
                    bg-black/[0.06] dark:bg-white/[0.08] text-gray-600 dark:text-gray-300">
                    {shelf.items.length}
                </span>
                <span className="ml-auto flex items-center text-gray-400 dark:text-neutral-500
                    group-hover:text-gray-900 dark:group-hover:text-white transition-colors">
                    <ArrowRight01Icon size={14} strokeWidth={2} />
                </span>
            </button>

            <div className={`grid gap-1 ${wide ? 'grid-cols-5 sm:grid-cols-10' : 'grid-cols-5'}`}>
                {shown.map(item => (
                    <Token key={item.key} icon={item.icon} label={item.label} title={item.title} tint={shelf.tint} onClick={open} />
                ))}
                {rest > 0 && <MoreToken count={rest} onClick={open} label={t('inventory.more', { count: rest })} />}
                {shelf.items.length === 0 && Array.from({ length: COLUMNS }, (_, index) => (
                    <EmptySlot key={index} first={index === 0} onClick={open} label={t('inventory.add', { what: shelf.title })} />
                ))}
            </div>
        </section>
    );
}

/** The agent's own card: who carries all this, and how much of it there is. */
function AgentCard({ agent, shelves, total, t }) {
    return (
        <section
            className="flex flex-col rounded-2xl border p-4 gap-4 min-w-0
                border-black/[0.06] dark:border-white/[0.07]
                bg-gradient-to-br from-white/70 to-white/30 dark:from-white/[0.05] dark:to-white/[0.01]"
        >
            <div className="flex items-center gap-3">
                <AgentMark size={44} animated color={agent?.color} />
                <div className="min-w-0">
                    <div className="text-base font-semibold text-gray-900 dark:text-white truncate">
                        {agent?.name || t('agents.agent')}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400">
                        {t('inventory.carrying', { count: total })}
                    </div>
                </div>
            </div>

            {/* The stat lines of a character sheet: one per class, the mark
                in its colour and the count at the far end. */}
            <dl className="flex flex-col gap-1.5">
                {shelves.map(shelf => (
                    <div key={shelf.page} className="flex items-center gap-2 text-xs">
                        <span className={`flex items-center justify-center ${shelf.mark}`}>{shelf.icon}</span>
                        <dt className="text-gray-600 dark:text-gray-300">{shelf.title}</dt>
                        <span className="flex-1 border-b border-dotted border-black/[0.12] dark:border-white/[0.12] mx-1" />
                        <dd className="tabular-nums font-semibold text-gray-900 dark:text-white">{shelf.items.length}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}

function InventoryOverview({ hosts = [], keys = [], agentId = '', activeAgent = null, onOpen }) {
    const t = useT();
    const { proxies: allProxies } = useProxies();
    const { snippets: allSnippets } = useSnippets();
    const [notes, setNotes] = useState([]);

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
            tint: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
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
            tint: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
            mark: 'text-amber-600 dark:text-amber-300',
            items: keys.map(key => ({
                key: key.id,
                label: key.name,
                title: `${key.name}${key.type ? ` · ${key.type}` : ''}`,
                icon: <Key01Icon size={19} strokeWidth={1.75} />,
            })),
        },
        {
            page: 'proxies',
            title: t('nav.proxies'),
            icon: <Route02Icon size={15} strokeWidth={1.75} />,
            tint: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
            mark: 'text-violet-600 dark:text-violet-300',
            items: proxies.map(proxy => ({
                key: proxy.id,
                label: proxy.name || proxy.host,
                title: `${proxy.type?.toUpperCase() || ''} ${proxy.host}:${proxy.port}`.trim(),
                icon: <Route02Icon size={19} strokeWidth={1.75} />,
            })),
        },
        {
            page: 'snippets',
            title: t('nav.snippets'),
            icon: <FlashIcon size={15} strokeWidth={1.75} />,
            tint: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            mark: 'text-emerald-600 dark:text-emerald-300',
            items: snippets.map(snippet => ({
                key: snippet.id,
                label: snippet.name,
                title: snippet.description || snippet.name,
                icon: isSpec(snippet)
                    ? <Note01Icon size={19} strokeWidth={1.75} />
                    : isPackage(snippet)
                        ? <PackageIcon size={19} strokeWidth={1.75} />
                        : <FlashIcon size={19} strokeWidth={1.75} />,
            })),
        },
        {
            page: 'memory',
            title: t('nav.memory'),
            icon: <BrainIcon size={15} strokeWidth={1.75} />,
            tint: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',
            mark: 'text-pink-600 dark:text-pink-300',
            items: notes.map(note => ({
                key: note.id,
                label: note.tags[0] ? `#${note.tags[0]}` : note.text,
                title: note.text,
                icon: <BrainIcon size={19} strokeWidth={1.75} />,
            })),
        },
        {
            page: 'mcp',
            title: t('nav.mcp'),
            icon: <PlugSocketIcon size={15} strokeWidth={1.75} />,
            tint: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
            mark: 'text-orange-600 dark:text-orange-300',
            items: servers.map(server => ({
                key: server.id,
                label: server.name,
                title: server.transport === 'http' ? server.url : [server.command, ...(server.args || [])].join(' '),
                icon: <PlugSocketIcon size={19} strokeWidth={1.75} />,
            })),
        },
    ];

    const total = shelves.reduce((sum, shelf) => sum + shelf.items.length, 0);

    return (
        <div
            id="inventory-overview"
            // Packed, not stacked: wide pouches take two columns and the rest
            // fill in around them, so the page is a bag of compartments.
            className="grid gap-3 pb-2 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 [grid-auto-flow:dense]"
        >
            <AgentCard agent={activeAgent} shelves={shelves} total={total} t={t} />
            {shelves.map(shelf => (
                <Pouch key={shelf.page} shelf={shelf} onOpen={onOpen} t={t} />
            ))}
        </div>
    );
}

export default memo(InventoryOverview);
