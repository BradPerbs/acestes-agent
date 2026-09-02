import { memo, useCallback, useEffect, useState } from 'react';
import { BrainIcon, Delete02Icon, Edit02Icon, PlusSignIcon, SearchRemoveIcon } from 'hugeicons-react';
import Dialog from './ui/Dialog';
import Button from './ui/Button';
import ConfirmDialog from './ui/ConfirmDialog';
import EmptyFrame from './ui/EmptyFrame';
import Field, { FIELD_CLASS } from './ui/Field';
import SearchField from './ui/SearchField';
import { useT } from '../i18n';

/**
 * What the selected agent remembers, as a list a person can read and edit.
 *
 * The agent writes most of this from inside conversations; the page is where
 * a wrong note gets corrected or deleted, and where the user tells the agent
 * something once rather than at the start of every chat.
 */

/** Ages are minutes and hours, not dates. */
function when(t, timestamp) {
    const age = Date.now() - timestamp;
    if (!timestamp || age < 60_000) return t('monitor.justNow');
    const minutes = Math.floor(age / 60_000);
    if (minutes < 60) return t('monitor.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('monitor.hoursAgo', { count: hours });
    return t('monitor.daysAgo', { count: Math.floor(hours / 24) });
}

const parseTags = (text) => String(text || '').split(/[,\s]+/).map(tag => tag.trim()).filter(Boolean);

function NoteDialog({ note, onClose, onSave }) {
    const t = useT();
    const [text, setText] = useState(note?.text || '');
    const [tags, setTags] = useState((note?.tags || []).join(', '));
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        if (!text.trim() || saving) return;
        setSaving(true);
        try {
            await onSave({ id: note?.id, text: text.trim(), tags: parseTags(tags) });
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            title={note ? t('memory.editTitle') : t('memory.newTitle')}
            subtitle={note ? undefined : t('memory.newSubtitle')}
            onClose={onClose}
            width="32rem"
            footer={(
                <>
                    <Button onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" onClick={submit} disabled={!text.trim() || saving}>
                        {t('common.save')}
                    </Button>
                </>
            )}
        >
            <div className="flex flex-col gap-4">
                <Field label={t('memory.text')}>
                    <textarea
                        autoFocus
                        value={text}
                        maxLength={1000}
                        rows={4}
                        onChange={(event) => setText(event.target.value)}
                        placeholder={t('memory.textPlaceholder')}
                        className={`${FIELD_CLASS} resize-y`}
                    />
                </Field>
                <Field label={t('memory.tags')} hint={t('memory.tagsHint')}>
                    <input
                        type="text"
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        className={FIELD_CLASS}
                        placeholder="preference, nginx"
                    />
                </Field>
            </div>
        </Dialog>
    );
}

function MemoryPanel({ agentId = '' }) {
    const t = useT();
    const [entries, setEntries] = useState([]);
    const [query, setQuery] = useState('');
    /** `{ note }` to edit, `{ note: null }` to add. */
    const [editing, setEditing] = useState(null);
    const [confirming, setConfirming] = useState(null);

    const refresh = useCallback(async () => {
        if (!agentId) return;
        try {
            setEntries(await window.api.memory.list(agentId) || []);
        } catch {
            // The list just shows what it had.
        }
    }, [agentId]);

    // Read for the agent selected, and again whenever the agent writes a note
    // from inside a conversation.
    useEffect(() => {
        refresh();
        return window.api.memory.onChange?.((change) => {
            if (!change?.agentId || change.agentId === agentId) refresh();
        });
    }, [refresh, agentId]);

    const needle = query.trim();

    /**
     * What the search answered: by meaning as well as by word, the same
     * search the agent's recall tool runs, so the page finds what the agent
     * would. Asked a moment after typing stops, since every keystroke would
     * otherwise be an embedding.
     */
    const [results, setResults] = useState([]);
    useEffect(() => {
        if (!needle) return undefined;
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const found = await window.api.memory.search(agentId, needle);
                if (!cancelled) setResults(found || []);
            } catch {
                if (!cancelled) setResults([]);
            }
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [needle, agentId, entries]);

    const visible = needle ? results : entries;

    const save = useCallback(async ({ id, text, tags }) => {
        await window.api.memory.save({ agentId, id, text, tags });
        refresh();
    }, [agentId, refresh]);

    const confirmDelete = useCallback((entry) => {
        setConfirming({
            title: t('memory.deleteTitle'),
            message: t('memory.deleteMessage'),
            confirmLabel: t('common.delete'),
            onConfirm: async () => {
                setConfirming(null);
                await window.api.memory.remove(agentId, entry.id);
                refresh();
            },
        });
    }, [agentId, refresh, t]);

    return (
        <div className="flex flex-col gap-4 h-full min-h-0" id="memory-panel">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <SearchField
                    value={query}
                    onChange={setQuery}
                    ariaLabel={t('memory.search')}
                    placeholder={t('memory.search')}
                />
                <div className="flex items-center gap-2 shrink-0 ml-auto">
                    <Button
                        variant="primary"
                        icon={<PlusSignIcon size={16} strokeWidth={2.5} />}
                        onClick={() => setEditing({ note: null })}
                    >
                        {t('memory.new')}
                    </Button>
                </div>
            </div>

            <p className="shrink-0 -mt-2 text-[13px] text-gray-500 dark:text-gray-400">
                {t('memory.note')}
            </p>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                {visible.length === 0 ? (
                    <EmptyFrame
                        icon={needle
                            ? <SearchRemoveIcon size={28} strokeWidth={1.5} />
                            : <BrainIcon size={28} strokeWidth={1.5} />}
                        title={needle ? t('common.noMatchesTitle') : t('memory.empty')}
                        note={needle ? `“${query.trim()}”` : t('memory.emptyNote')}
                    />
                ) : (
                    <div className="flex flex-col gap-2">
                        {visible.map(entry => (
                            <div
                                key={entry.id}
                                className="group/row flex items-start gap-3 px-4 py-3 rounded-xl
                                    bg-white dark:bg-neutral-800/50 border border-gray-200 dark:border-neutral-800"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap break-words">
                                        {entry.text}
                                    </p>
                                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-neutral-400">
                                        <span>{when(t, entry.updatedAt)}</span>
                                        <span>·</span>
                                        <span>{entry.source === 'user' ? t('memory.byUser') : t('memory.byAgent')}</span>
                                        {entry.tags.map(tag => (
                                            <span
                                                key={tag}
                                                className="px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400"
                                            >
                                                #{tag}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover/row:opacity-100 focus-within:opacity-100 transition-opacity">
                                    <button
                                        type="button"
                                        aria-label={t('common.edit')}
                                        onClick={() => setEditing({ note: entry })}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                                            text-gray-400 dark:text-neutral-500
                                            hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-surface-control dark:hover:text-white"
                                    >
                                        <Edit02Icon size={15} strokeWidth={1.5} />
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t('common.delete')}
                                        onClick={() => confirmDelete(entry)}
                                        className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                                            text-gray-400 dark:text-neutral-500
                                            hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400"
                                    >
                                        <Delete02Icon size={15} strokeWidth={1.5} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {editing && (
                <NoteDialog note={editing.note} onClose={() => setEditing(null)} onSave={save} />
            )}

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(MemoryPanel);
