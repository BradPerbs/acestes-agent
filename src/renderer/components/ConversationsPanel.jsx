import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Delete02Icon, PlusSignIcon, SearchRemoveIcon } from 'hugeicons-react';
import AgentMark from './assistant/AgentMark';
import EmptyFrame from './ui/EmptyFrame';
import SearchField from './ui/SearchField';
import ConfirmDialog from './ui/ConfirmDialog';
import { CollapsingButton } from './ui/Button';
import useNarrow from '../hooks/useNarrow';
import { useT } from '../i18n';

/**
 * Every conversation the app still has, newest first.
 *
 * The agent's home page: the chats are what the app is for, so they get the
 * page the hosts used to have. Opening one puts it in the tab strip, or brings
 * it forward if it is already there; the list itself never holds a
 * conversation, only names it.
 */

/** Where the New button drops its label and keeps its plus. */
const COMPACT_AT = 420;

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

function ConversationsPanel({
    /** The selected agent's conversations, newest first, kept current by App. */
    conversations = [],
    /** The colour the agent's mark wears. */
    agentColor = '',
    onRefresh,
    /** The conversations already held by a tab, so the row can say so. */
    openIds = [],
    onOpen,
    onNew,
    onDelete,
}) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [confirming, setConfirming] = useState(null);
    const searchRef = useRef(null);
    const [panelRef, cramped] = useNarrow(COMPACT_AT);

    const needle = query.trim().toLowerCase();
    const visible = useMemo(() => (
        needle
            ? conversations.filter(entry => (entry.title || '').toLowerCase().includes(needle))
            : conversations
    ), [conversations, needle]);

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

    return (
        <div ref={panelRef} className="flex flex-col gap-4 h-full min-h-0" id="conversations-panel">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <SearchField
                    ref={searchRef}
                    value={query}
                    onChange={setQuery}
                    ariaLabel={t('conversations.search')}
                    placeholder={t('conversations.search')}
                />

                <div className="flex items-center gap-2 shrink-0 ml-auto">
                    <span className="text-xs tabular-nums text-gray-400 dark:text-neutral-500">
                        {t('conversations.count', { count: conversations.length })}
                    </span>
                    <CollapsingButton
                        compact={cramped}
                        onClick={onNew}
                        label={t('conversations.new')}
                        icon={<PlusSignIcon size={16} strokeWidth={2.5} />}
                    />
                </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                {visible.length === 0 ? (
                    <EmptyFrame
                        icon={needle
                            ? <SearchRemoveIcon size={28} strokeWidth={1.5} />
                            : <AgentMark size={40} mono />}
                        title={needle ? t('common.noMatchesTitle') : t('conversations.empty')}
                        note={needle ? `“${query.trim()}”` : t('conversations.emptyNote')}
                    />
                ) : (
                    <div className="flex flex-col gap-1">
                        {visible.map((conversation) => {
                            const held = open.has(conversation.conversationId);
                            return (
                                <div key={conversation.conversationId} className="relative group/row">
                                    <button
                                        type="button"
                                        onClick={() => onOpen?.(conversation.conversationId)}
                                        className="w-full flex items-center gap-3 pl-3 pr-12 py-2.5 rounded-xl text-left
                                            transition-colors
                                            hover:bg-gray-900/[0.04] dark:hover:bg-surface-control"
                                    >
                                        <span className="w-7 h-7 flex items-center justify-center shrink-0">
                                            <AgentMark
                                                size={20}
                                                color={agentColor}
                                                className={conversation.busy ? 'animate-pulse' : ''}
                                            />
                                        </span>

                                        <span className="flex flex-col min-w-0 flex-1">
                                            <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                                                {conversation.title || t('assistant.newConversation')}
                                            </span>
                                            <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                                                {[
                                                    when(t, conversation.updatedAt),
                                                    t('conversations.messages', { count: conversation.messages || 0 }),
                                                    conversation.busy ? t('assistant.working') : '',
                                                ].filter(Boolean).join(' · ')}
                                            </span>
                                        </span>

                                        {held && (
                                            <span className="shrink-0 px-2 py-0.5 rounded-lg text-[11px] font-medium
                                                bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                                                {t('conversations.open')}
                                            </span>
                                        )}
                                    </button>

                                    {/* Beside the row rather than inside it, since a
                                        button in a button is not a thing, and only
                                        on hover: a bin on every row of a list you are
                                        scanning is an invitation to misclick. */}
                                    <button
                                        type="button"
                                        aria-label={t('common.deleteNamed', {
                                            name: conversation.title || t('assistant.newConversation'),
                                        })}
                                        title={t('common.delete')}
                                        onClick={() => confirmDelete(conversation)}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg
                                            flex items-center justify-center transition-colors
                                            opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100
                                            text-gray-400 dark:text-neutral-500
                                            hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400"
                                    >
                                        <Delete02Icon size={15} strokeWidth={1.5} />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(ConversationsPanel);
