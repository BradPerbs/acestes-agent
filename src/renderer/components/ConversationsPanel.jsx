import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Delete02Icon,
    Download04Icon,
    HelpCircleIcon,
    PinIcon,
    PinOffIcon,
    PlusSignIcon,
    SearchRemoveIcon,
} from 'hugeicons-react';
import AgentMark from './assistant/AgentMark';
import EmptyFrame from './ui/EmptyFrame';
import SearchField from './ui/SearchField';
import ConfirmDialog from './ui/ConfirmDialog';
import { CollapsingButton } from './ui/Button';
import useNarrow from '../hooks/useNarrow';
import { useT } from '../i18n';

/**
 * Every conversation the app still has, pinned first, then newest first,
 * and a search over what was said in them.
 *
 * The agent's home page: the chats are what the app is for, so they get the
 * page the hosts used to have. Opening one puts it in the tab strip, or brings
 * it forward if it is already there; the list itself never holds a
 * conversation, only names it.
 *
 * With nothing typed, the list. With a query, the main process searches the
 * conversations' contents (see `ai/search.js` for the words and operators)
 * and this page draws what it found: the same rows, each with the passages
 * that matched underneath and the hits marked. The chips under the box are
 * the operators people reach for most, as toggles that edit the query, so
 * the query stays the one source of truth and can be read back and typed.
 */

/** Where the New button drops its label and keeps its plus. */
const COMPACT_AT = 420;

/** How long typing settles before a search is asked for. */
const SEARCH_DELAY = 160;

/** The chips: each is one operator token added to, or taken out of, the query. */
const CHIPS = [
    { id: 'pinned', token: 'is:pinned' },
    { id: 'open', token: 'is:open' },
    { id: 'errors', token: 'has:error' },
    { id: 'week', token: 'after:7d' },
    { id: 'mine', token: 'from:me' },
];

/** The rows of the help panel: the operator as typed, and what it does. */
const HELP = [
    ['"exact phrase"', 'conversations.searchHelp.phrase'],
    ['-word', 'conversations.searchHelp.exclude'],
    ['is:pinned  is:open  is:working', 'conversations.searchHelp.is'],
    ['has:error  has:tool  has:image  has:approval', 'conversations.searchHelp.has'],
    ['from:me  from:agent', 'conversations.searchHelp.from'],
    ['tool:run_command', 'conversations.searchHelp.tool'],
    ['host:web-01', 'conversations.searchHelp.host'],
    ['after:7d  before:yesterday', 'conversations.searchHelp.when'],
];

/** Ages in the list are minutes and hours, not dates. */
function when(t, timestamp) {
    const age = Date.now() - timestamp;
    if (!timestamp || age < 60_000) return t('monitor.justNow');

    const minutes = Math.floor(age / 60_000);
    if (minutes < 60) return t('monitor.minutesAgo', { count: minutes });

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('monitor.hoursAgo', { count: hours });

    return t('monitor.daysAgo', { count: Math.floor(hours / 24) });
}

/** Whether a query already carries a token, as a whole word. */
const hasToken = (query, token) => query.split(/\s+/).includes(token);

/** The query with a token added, or with it taken out. */
function toggleToken(query, token) {
    const words = query.split(/\s+/).filter(Boolean);
    const next = words.includes(token) ? words.filter(word => word !== token) : [...words, token];
    return next.join(' ');
}

/** Text with `[start, end)` ranges wrapped in marks. */
function Marked({ text, ranges = [] }) {
    if (!ranges.length) return text;
    const parts = [];
    let cursor = 0;
    ranges.forEach(([start, end], index) => {
        if (start > cursor) parts.push(text.slice(cursor, start));
        parts.push(
            <mark
                key={index}
                className="rounded-[3px] px-0.5 bg-amber-200/70 dark:bg-amber-400/25 text-inherit"
            >
                {text.slice(start, end)}
            </mark>,
        );
        cursor = end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
}

/** The small heading over each half of the list. */
function GroupLabel({ children }) {
    return (
        <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider
            text-gray-500 dark:text-neutral-500">
            {children}
        </div>
    );
}

/** One hover action beside a row: the pin and the bin share this shape. */
const ROW_ACTION = `w-8 h-8 rounded-lg flex items-center justify-center transition-colors
    text-gray-400 dark:text-neutral-500`;

const CHIP = `h-7 px-2.5 rounded-lg text-[11px] font-medium transition-colors outline-none
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;
const CHIP_ON = 'bg-gray-900 text-white dark:bg-white dark:text-gray-900';
const CHIP_OFF = `bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-gray-300
    hover:bg-gray-200 dark:hover:bg-neutral-700`;

function ConversationsPanel({
    /** The selected agent's conversations, pinned first, kept current by App. */
    conversations = [],
    /** Whose they are, for the search. */
    agentId = '',
    /** The colour the agent's mark wears. */
    agentLook = null,
    onRefresh,
    /** The conversations already held by a tab, so the row can say so. */
    openIds = [],
    onOpen,
    onNew,
    onDelete,
    /** `(conversationId, pinned)`: keep at the top, or let go. */
    onPin,
}) {
    const t = useT();
    // Handed over from the sidebar's quick search when Enter is pressed
    // there: one shot, so coming back to the page later starts clean.
    const [query, setQuery] = useState(() => {
        try {
            const handed = window.sessionStorage.getItem('conversations.query') || '';
            if (handed) window.sessionStorage.removeItem('conversations.query');
            return handed;
        } catch {
            return '';
        }
    });
    const [confirming, setConfirming] = useState(null);
    const [helpOpen, setHelpOpen] = useState(false);
    const searchRef = useRef(null);
    const helpRef = useRef(null);
    const [panelRef, cramped] = useNarrow(COMPACT_AT);

    const trimmed = query.trim();
    const searching = trimmed.length > 0;

    /* ------------------------------------------------------------------ *
     * Searching
     * ------------------------------------------------------------------ */

    const [found, setFound] = useState(null);
    const [pending, setPending] = useState(false);
    // The query the answer on screen is for, so a slow answer to an old
    // query cannot land on top of a fast answer to the current one.
    const asked = useRef('');

    useEffect(() => {
        if (!searching) {
            asked.current = '';
            setFound(null);
            setPending(false);
            return undefined;
        }
        setPending(true);
        const timer = setTimeout(async () => {
            const wanted = trimmed;
            asked.current = wanted;
            try {
                const answer = await window.api.ai.search({ agentId, query: wanted, openIds });
                if (asked.current !== wanted) return;
                setFound(answer);
            } catch {
                if (asked.current === wanted) setFound({ results: [], total: 0, meaning: 'off' });
            } finally {
                if (asked.current === wanted) setPending(false);
            }
        }, SEARCH_DELAY);
        return () => clearTimeout(timer);
        // `openIds` and `conversations` change as chats move; a search that is
        // on screen follows them so `is:open` and the counts stay right.
    }, [searching, trimmed, agentId, openIds, conversations]);

    useEffect(() => {
        if (!helpOpen) return undefined;
        const onPointer = (event) => {
            if (!helpRef.current?.contains(event.target)) setHelpOpen(false);
        };
        const onKey = (event) => {
            if (event.key === 'Escape') setHelpOpen(false);
        };
        document.addEventListener('mousedown', onPointer);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onPointer);
            document.removeEventListener('keydown', onKey);
        };
    }, [helpOpen]);

    const toggleChip = useCallback((token) => {
        setQuery(current => toggleToken(current.trim(), token));
        searchRef.current?.focus();
    }, []);

    /* ------------------------------------------------------------------ *
     * The list
     * ------------------------------------------------------------------ */

    // Two halves, drawn with a heading each only when both exist: a list with
    // nothing pinned is just a list, and a heading over all of it says nothing.
    const pinned = useMemo(() => conversations.filter(entry => entry.pinned), [conversations]);
    const rest = useMemo(() => conversations.filter(entry => !entry.pinned), [conversations]);
    const grouped = pinned.length > 0 && rest.length > 0;

    const open = useMemo(() => new Set(openIds), [openIds]);

    const confirmDelete = useCallback((conversation) => {
        setConfirming({
            title: t('conversations.deleteTitle'),
            message: t('conversations.deleteMessage', {
                name: conversation.title || t('assistant.newConversation'),
            }),
            confirmLabel: t('common.delete'),
            onConfirm: async () => {
                setConfirming(null);
                await onDelete?.(conversation.conversationId);
                onRefresh?.();
            },
        });
    }, [onDelete, onRefresh, t]);

    const togglePin = useCallback(async (conversation) => {
        await onPin?.(conversation.conversationId, !conversation.pinned);
        onRefresh?.();
    }, [onPin, onRefresh]);

    /** A row of the list, or of the results when `hit` carries the passages. */
    const row = (conversation, hit = null) => {
        const held = open.has(conversation.conversationId);
        const name = conversation.title || t('assistant.newConversation');
        const meta = [
            when(t, conversation.updatedAt),
            t('conversations.messages', { count: conversation.messages || 0 }),
            conversation.busy ? t('assistant.working') : '',
            hit && hit.matches > 0 ? t('conversations.matches', { count: hit.matches }) : '',
        ].filter(Boolean).join(' · ');

        return (
            <div key={conversation.conversationId} className="relative group/row">
                <button
                    type="button"
                    onClick={() => onOpen?.(conversation.conversationId)}
                    className="w-full flex items-start gap-3 pl-3 pr-20 py-2.5 rounded-xl text-left
                        transition-colors
                        hover:bg-gray-900/[0.04] dark:hover:bg-surface-control"
                >
                    <span className="w-7 h-7 flex items-center justify-center shrink-0">
                        <AgentMark
                            size={20}
                            look={agentLook}
                            className={conversation.busy ? 'animate-pulse' : ''}
                        />
                    </span>

                    <span className="flex flex-col min-w-0 flex-1 gap-0.5">
                        <span className="flex items-center gap-2 min-w-0">
                            <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                                {hit ? <Marked text={name} ranges={hit.titleRanges} /> : name}
                            </span>
                            {hit?.byMeaning && (
                                <span className="shrink-0 px-1.5 py-px rounded-md text-[10px] font-medium uppercase tracking-wide
                                    bg-violet-500/10 text-violet-700 dark:text-violet-300">
                                    {t('conversations.related')}
                                </span>
                            )}
                            {held && (
                                <span className="shrink-0 px-2 py-0.5 rounded-lg text-[11px] font-medium
                                    bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                                    {t('conversations.open')}
                                </span>
                            )}
                        </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{meta}</span>

                        {hit?.snippets?.length > 0 && (
                            <span className="mt-1 flex flex-col gap-1">
                                {hit.snippets.map(snippet => (
                                    <span
                                        key={`${snippet.index}`}
                                        className="flex items-baseline gap-2 min-w-0 text-xs leading-snug"
                                    >
                                        <span className={`shrink-0 w-9 text-[10px] font-semibold uppercase tracking-wide
                                            ${snippet.isError
                                                ? 'text-red-500 dark:text-red-400'
                                                : 'text-gray-400 dark:text-neutral-500'}`}
                                        >
                                            {t(`conversations.snippet.${snippet.kind}`)}
                                        </span>
                                        <span className={`min-w-0 truncate text-gray-700 dark:text-gray-300
                                            ${snippet.kind === 'tool' || snippet.kind === 'result' ? 'font-mono text-[11px]' : ''}`}
                                        >
                                            <Marked text={snippet.text} ranges={snippet.ranges} />
                                        </span>
                                    </span>
                                ))}
                            </span>
                        )}
                    </span>
                </button>

                {/* Beside the row rather than inside it, since a button in a
                    button is not a thing, and only on hover: a bin on every
                    row of a list you are scanning is an invitation to
                    misclick. The pin of a pinned row is the exception: it is
                    always shown, at the far right, because it is also how the
                    row says it is pinned, and it turns into the unpin button
                    under the pointer. */}
                <div className="absolute right-2 top-3 flex items-center gap-0.5">
                    <button
                        type="button"
                        aria-label={conversation.pinned ? t('conversations.unpin') : t('conversations.pin')}
                        aria-pressed={Boolean(conversation.pinned)}
                        title={conversation.pinned ? t('conversations.unpin') : t('conversations.pin')}
                        onClick={() => togglePin(conversation)}
                        className={`${ROW_ACTION}
                            focus-visible:opacity-100
                            hover:bg-gray-900/[0.06] hover:text-gray-900
                            dark:hover:bg-white/[0.08] dark:hover:text-white
                            ${conversation.pinned ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'}`}
                    >
                        {conversation.pinned ? (
                            <>
                                <PinIcon size={15} strokeWidth={1.75} className="group-hover/row:hidden" />
                                <PinOffIcon size={15} strokeWidth={1.5} className="hidden group-hover/row:block" />
                            </>
                        ) : (
                            <PinIcon size={15} strokeWidth={1.5} />
                        )}
                    </button>
                    <button
                        type="button"
                        aria-label={t('conversations.export')}
                        title={t('conversations.export')}
                        onClick={() => window.api.ai.export?.(conversation.conversationId)}
                        className={`${ROW_ACTION}
                            opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100
                            hover:bg-gray-900/[0.06] hover:text-gray-900
                            dark:hover:bg-white/[0.08] dark:hover:text-white`}
                    >
                        <Download04Icon size={15} strokeWidth={1.5} />
                    </button>
                    <button
                        type="button"
                        aria-label={t('common.deleteNamed', { name })}
                        title={t('common.delete')}
                        onClick={() => confirmDelete(conversation)}
                        className={`${ROW_ACTION}
                            opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100
                            hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400`}
                    >
                        <Delete02Icon size={15} strokeWidth={1.5} />
                    </button>
                </div>
            </div>
        );
    };

    /* ------------------------------------------------------------------ *
     * What is on screen
     * ------------------------------------------------------------------ */

    let body;
    if (searching) {
        const results = found?.results || [];
        if (results.length === 0) {
            body = (
                <EmptyFrame
                    icon={<SearchRemoveIcon size={28} strokeWidth={1.5} />}
                    title={pending && !found ? t('conversations.searching') : t('conversations.noResults')}
                    note={pending && !found ? '' : t('conversations.noResultsNote')}
                />
            );
        } else {
            body = (
                <div className={`flex flex-col gap-1 transition-opacity ${pending ? 'opacity-60' : ''}`}>
                    {results.map(hit => row(hit, hit))}
                </div>
            );
        }
    } else if (conversations.length === 0) {
        body = (
            <EmptyFrame
                icon={<AgentMark size={40} mono />}
                title={t('conversations.empty')}
                note={t('conversations.emptyNote')}
            />
        );
    } else {
        body = (
            <div className="flex flex-col gap-1">
                {grouped && <GroupLabel>{t('conversations.pinned')}</GroupLabel>}
                {pinned.map(entry => row(entry))}
                {grouped && <GroupLabel>{t('conversations.others')}</GroupLabel>}
                {rest.map(entry => row(entry))}
            </div>
        );
    }

    return (
        <div ref={panelRef} className="flex flex-col gap-3 h-full min-h-0" id="conversations-panel">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <SearchField
                    ref={searchRef}
                    value={query}
                    onChange={setQuery}
                    ariaLabel={t('conversations.search')}
                    placeholder={t('conversations.searchPlaceholder')}
                    onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
                />

                <div className="flex items-center gap-2 shrink-0 ml-auto">
                    <CollapsingButton
                        compact={cramped}
                        onClick={onNew}
                        label={t('conversations.new')}
                        icon={<PlusSignIcon size={16} strokeWidth={2.5} />}
                    />
                </div>
            </div>

            {/* The chips and the help, in one row under the box. */}
            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                {CHIPS.map(chip => {
                    const on = hasToken(trimmed, chip.token);
                    return (
                        <button
                            key={chip.id}
                            type="button"
                            aria-pressed={on}
                            onClick={() => toggleChip(chip.token)}
                            className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
                        >
                            {t(`conversations.filter.${chip.id}`)}
                        </button>
                    );
                })}

                <span ref={helpRef} className="relative ml-auto">
                    <button
                        type="button"
                        aria-label={t('conversations.searchHelp')}
                        aria-expanded={helpOpen}
                        title={t('conversations.searchHelp')}
                        onClick={() => setHelpOpen(value => !value)}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors outline-none
                            focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                            ${helpOpen
                                ? 'bg-gray-900/[0.08] dark:bg-surface-control text-gray-900 dark:text-white'
                                : 'text-gray-400 dark:text-neutral-500 hover:text-gray-700 dark:hover:text-gray-200'}`}
                    >
                        <HelpCircleIcon size={16} strokeWidth={1.75} />
                    </button>
                    {helpOpen && (
                        <div
                            role="dialog"
                            aria-label={t('conversations.searchHelpTitle')}
                            className="absolute right-0 top-9 z-30 w-[26rem] max-w-[calc(100vw-3rem)] p-4 rounded-2xl
                                bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700
                                shadow-xl text-[12px] leading-snug text-gray-700 dark:text-gray-300"
                        >
                            <div className="text-[13px] font-semibold text-gray-900 dark:text-white">
                                {t('conversations.searchHelpTitle')}
                            </div>
                            <p className="mt-1 text-gray-500 dark:text-neutral-400">
                                {t('conversations.searchHelpIntro')}
                            </p>
                            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                {HELP.map(([syntax, key]) => (
                                    <div key={key} className="contents">
                                        <dt>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setQuery(current => `${current.trim()} ${syntax.split(/\s{2,}/)[0]}`.trim());
                                                    searchRef.current?.focus();
                                                }}
                                                className="font-mono text-[11px] whitespace-nowrap text-left
                                                    text-gray-900 dark:text-white hover:underline"
                                            >
                                                {syntax}
                                            </button>
                                        </dt>
                                        <dd className="text-gray-600 dark:text-gray-400">{t(key)}</dd>
                                    </div>
                                ))}
                            </dl>
                            <p className="mt-3 pt-3 border-t border-gray-200 dark:border-neutral-700 text-[11px] text-gray-500 dark:text-neutral-400">
                                {t('conversations.searchHelpMeaning')}
                            </p>
                        </div>
                    )}
                </span>
            </div>

            {searching && found?.meaning === 'loading' && (
                <p className="shrink-0 px-1 text-[11px] text-gray-500 dark:text-neutral-500">
                    {t('conversations.meaningLoading')}
                </p>
            )}

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                {body}
            </div>

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(ConversationsPanel);
