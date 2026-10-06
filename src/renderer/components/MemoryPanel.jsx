import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
    BrainIcon,
    Delete02Icon,
    Download04Icon,
    Edit02Icon,
    FileImportIcon,
    MagicWand01Icon,
    PlusSignIcon,
    SearchRemoveIcon,
} from 'hugeicons-react';
import Dialog from './ui/Dialog';
import Button, { IconButton } from './ui/Button';
import ConfirmDialog from './ui/ConfirmDialog';
import EmptyFrame from './ui/EmptyFrame';
import Field, { FIELD_CLASS } from './ui/Field';
import SearchField from './ui/SearchField';
import SegmentedControl from './ui/SegmentedControl';
import { useT } from '../i18n';
import { toastOptions } from '../lib/toast';

/**
 * What the selected agent remembers, as a list a person can read and edit.
 *
 * The agent writes most of this from inside conversations; the page is where
 * a wrong note gets corrected or deleted, and where the user tells the agent
 * something once rather than at the start of every chat. Each note is a rule
 * (in every conversation), a fact or an event (sent with a message they bear
 * on); the page says which rules fit in the prompt, and shows what the last
 * tidy changed, with a way to take it back. See ai/memory.js.
 */

const KINDS = ['rule', 'fact', 'event'];

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

const KIND_DOT = {
    rule: 'bg-violet-500',
    fact: 'bg-gray-400 dark:bg-neutral-500',
    event: 'bg-sky-500',
};

function KindBadge({ kind, carried, over }) {
    const t = useT();
    return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-300">
            <span className={`w-1.5 h-1.5 rounded-full ${KIND_DOT[kind] || KIND_DOT.fact}`} />
            {t(`memory.kind.${kind}`)}
            {kind === 'rule' && carried && <span className="text-gray-400 dark:text-neutral-500">· {t('memory.inEveryChat')}</span>}
            {kind === 'rule' && over && <span className="text-amber-600 dark:text-amber-400">· {t('memory.doesNotFit')}</span>}
        </span>
    );
}

function NoteDialog({ note, onClose, onSave }) {
    const t = useT();
    const [text, setText] = useState(note?.text || '');
    const [tags, setTags] = useState((note?.tags || []).join(', '));
    // A note the user writes here is most often something to hold to in every
    // conversation, which is what a rule is.
    const [kind, setKind] = useState(note?.kind || 'rule');
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        if (!text.trim() || saving) return;
        setSaving(true);
        try {
            await onSave({ id: note?.id, text: text.trim(), tags: parseTags(tags), kind });
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
                <Field label={t('memory.kindLabel')} hint={t(`memory.kindHint.${kind}`)}>
                    <SegmentedControl
                        ariaLabel={t('memory.kindLabel')}
                        value={kind}
                        onChange={setKind}
                        segments={KINDS.map(value => ({ value, label: t(`memory.kind.${value}`) }))}
                    />
                </Field>
                <Field label={t('memory.tags')} hint={t('memory.tagsHint')}>
                    <input
                        type="text"
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        className={FIELD_CLASS}
                        placeholder="nginx, web-01"
                    />
                </Field>
            </div>
        </Dialog>
    );
}

const OP_LABEL = { merge: 'memory.tidyOp.merge', edit: 'memory.tidyOp.edit', delete: 'memory.tidyOp.delete' };

/** What the last tidy changed, note by note, as it was and as it is. */
function TidyReview({ last, onClose, onUndo }) {
    const t = useT();
    const changes = last?.changes || [];
    return (
        <Dialog
            title={t('memory.reviewTitle')}
            subtitle={t('memory.reviewSubtitle', { when: when(t, last?.at) })}
            onClose={onClose}
            width="40rem"
            footer={(
                <>
                    {!last?.undone && changes.length > 0 && (
                        <Button onClick={onUndo}>{t('memory.undoTidy')}</Button>
                    )}
                    <Button variant="primary" onClick={onClose}>{t('common.close')}</Button>
                </>
            )}
        >
            {changes.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-neutral-400">{t('memory.reviewNothing')}</p>
            ) : (
                <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto -mx-1 px-1">
                    {changes.map((change, index) => {
                        // Same words: only the kind or the tags moved, so the
                        // note is shown once, with what moved, not struck out.
                        const kept = change.op === 'edit' && change.after && change.before[0]?.text === change.after.text;
                        const refiled = kept && change.before[0]?.kind !== change.after.kind;
                        const label = refiled ? 'memory.tidyOp.kind' : kept ? 'memory.tidyOp.tags' : OP_LABEL[change.op];
                        const moved = (before) => {
                            if (refiled) return `${t(`memory.kind.${before.kind}`)} → ${t(`memory.kind.${change.after.kind}`)}: `;
                            if (kept) return `${(change.after.tags || []).map(tag => `#${tag}`).join(' ')}: `;
                            return '';
                        };
                        return (
                            <div
                                key={`${change.ids.join('-')}-${index}`}
                                className="rounded-xl border border-gray-200 dark:border-neutral-800 px-3 py-2.5"
                            >
                                <div className="flex items-center gap-2 text-[11px] font-medium text-gray-500 dark:text-neutral-400">
                                    <span>{t(label)}</span>
                                    {change.reason && <span className="font-normal truncate">· {change.reason}</span>}
                                </div>
                                {change.before.map(before => (
                                    <p
                                        key={before.id}
                                        className={`mt-1.5 text-[13px] break-words ${kept
                                            ? 'text-gray-700 dark:text-neutral-300'
                                            : 'text-gray-400 dark:text-neutral-500 line-through decoration-gray-300 dark:decoration-neutral-600'}`}
                                    >
                                        {moved(before)}
                                        {before.text}
                                    </p>
                                ))}
                                {change.after && !kept && (
                                    <p className="mt-1.5 text-[13px] text-gray-900 dark:text-white break-words">
                                        {change.after.text}
                                    </p>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </Dialog>
    );
}

function MemoryPanel({ agentId = '' }) {
    const t = useT();
    const [entries, setEntries] = useState([]);
    const [status, setStatus] = useState(null);
    const [tidy, setTidy] = useState(null);
    const [query, setQuery] = useState('');
    const [kind, setKind] = useState('all');
    /** `{ note }` to edit, `{ note: null }` to add. */
    const [editing, setEditing] = useState(null);
    const [confirming, setConfirming] = useState(null);
    const [reviewing, setReviewing] = useState(false);

    const refresh = useCallback(async () => {
        if (!agentId) return;
        try {
            const [list, stand, tidied] = await Promise.all([
                window.api.memory.list(agentId),
                window.api.memory.status?.(agentId),
                window.api.memory.tidyState?.(agentId),
            ]);
            setEntries(list || []);
            setStatus(stand || null);
            setTidy(tidied || null);
        } catch {
            // The list just shows what it had.
        }
    }, [agentId]);

    // Read for the agent selected, and again whenever the agent writes a note
    // from inside a conversation, or a tidy starts or ends.
    useEffect(() => {
        refresh();
        const offChange = window.api.memory.onChange?.((change) => {
            if (!change?.agentId || change.agentId === agentId) refresh();
        });
        const offTidy = window.api.memory.onTidy?.((change) => {
            if (!change?.agentId || change.agentId === agentId) refresh();
        });
        return () => {
            offChange?.();
            offTidy?.();
        };
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

    const counts = useMemo(() => {
        const out = { rule: 0, fact: 0, event: 0 };
        for (const entry of entries) out[entry.kind] = (out[entry.kind] || 0) + 1;
        return out;
    }, [entries]);

    const over = useMemo(() => new Set(status?.rulesOver || []), [status]);
    const visible = (needle ? results : entries).filter(entry => kind === 'all' || entry.kind === kind);

    const save = useCallback(async ({ id, text, tags, kind: noteKind }) => {
        await window.api.memory.save({ agentId, id, text, tags, kind: noteKind });
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
                toast((item) => (
                    <span className="flex items-center gap-3">
                        {t('memory.deleted')}
                        <button
                            type="button"
                            className="font-medium underline underline-offset-2"
                            onClick={async () => {
                                toast.dismiss(item.id);
                                await window.api.memory.restore(agentId, entry.id);
                                refresh();
                            }}
                        >
                            {t('memory.restore')}
                        </button>
                    </span>
                ), toastOptions({ duration: 5000 }));
            },
        });
    }, [agentId, refresh, t]);

    const tidyNow = useCallback(async () => {
        setTidy(current => ({ ...(current || {}), running: true }));
        const result = await window.api.memory.tidy(agentId);
        refresh();
        if (!result?.success) {
            toast.error(result?.message || t('memory.tidyFailed'), toastOptions());
            return;
        }
        if (!result.changes) {
            toast(t('memory.tidyNothing'), toastOptions({ duration: 2400 }));
            return;
        }
        toast.success(t('memory.tidyDone', { count: result.changes }), toastOptions({ duration: 2400 }));
    }, [agentId, refresh, t]);

    const undoTidy = useCallback(async () => {
        const result = await window.api.memory.undoTidy(agentId);
        setReviewing(false);
        refresh();
        if (result?.undone) {
            toast.success(
                result.kept ? t('memory.undoneKept', { count: result.kept }) : t('memory.undone'),
                toastOptions({ duration: 3200 }),
            );
        }
    }, [agentId, refresh, t]);

    // The notebook as a file, and a file like it into this agent's notebook.
    // Main owns the dialogs; a cancelled one comes back as `canceled`.
    const exportNotes = useCallback(async () => {
        const result = await window.api.memory.exportFile(agentId);
        if (result?.canceled) return;
        if (result?.success) {
            toast.success(t('memory.exported', { count: result.count }), toastOptions({ duration: 2400 }));
        } else {
            toast.error(result?.message || t('memory.exportFailed'), toastOptions());
        }
    }, [agentId, t]);

    const importNotes = useCallback(async () => {
        const result = await window.api.memory.importFile(agentId);
        if (result?.canceled) return;
        if (!result?.success) {
            toast.error(result?.message || t('memory.importFailed'), toastOptions());
            return;
        }
        refresh();
        if (!result.added && !result.updated) {
            toast(t('memory.importNothing'), toastOptions({ duration: 2400 }));
            return;
        }
        const parts = [t('memory.imported', { count: result.added })];
        if (result.updated) parts.push(t('memory.importUpdated', { count: result.updated }));
        if (result.skipped) parts.push(t('memory.importSkipped', { count: result.skipped }));
        toast.success(parts.join(' · '), toastOptions({ duration: 3200 }));
    }, [agentId, refresh, t]);

    const last = tidy?.last;
    const tidyCounts = last?.counts || {};
    const tidySummary = [
        tidyCounts.merged ? t('memory.tidyMerged', { count: tidyCounts.merged }) : '',
        tidyCounts.edited ? t('memory.tidyEdited', { count: tidyCounts.edited }) : '',
        tidyCounts.reclassified ? t('memory.tidyRefiled', { count: tidyCounts.reclassified }) : '',
        tidyCounts.retagged ? t('memory.tidyRetagged', { count: tidyCounts.retagged }) : '',
        tidyCounts.removed ? t('memory.tidyRemoved', { count: tidyCounts.removed }) : '',
    ].filter(Boolean).join(', ');
    const failedSince = tidy?.failedAt && tidy.failedAt > (tidy.lastAt || 0);
    const rest = entries.length - (status?.rulesCarried || 0);

    return (
        <div className="flex flex-col gap-4 h-full min-h-0" id="memory-panel">
            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <SearchField
                    value={query}
                    onChange={setQuery}
                    ariaLabel={t('memory.search')}
                    placeholder={t('memory.search')}
                />
                <SegmentedControl
                    ariaLabel={t('memory.kindLabel')}
                    value={kind}
                    onChange={setKind}
                    segments={[
                        { value: 'all', label: t('memory.kindAll') },
                        ...KINDS.map(value => ({ value, label: `${t(`memory.kinds.${value}`)} ${counts[value] || 0}` })),
                    ]}
                />
                <div className="flex items-center gap-2 shrink-0 ml-auto">
                    <IconButton
                        onClick={tidyNow}
                        disabled={entries.length < 2 || tidy?.running}
                        title={tidy?.running ? t('memory.tidying') : t('memory.tidyNow')}
                        icon={<MagicWand01Icon size={18} strokeWidth={1.75} />}
                    />
                    <IconButton
                        onClick={importNotes}
                        title={t('memory.import')}
                        icon={<FileImportIcon size={18} strokeWidth={1.75} />}
                    />
                    <IconButton
                        onClick={exportNotes}
                        disabled={entries.length === 0}
                        title={t('memory.export')}
                        icon={<Download04Icon size={18} strokeWidth={1.75} />}
                    />
                    <Button
                        variant="primary"
                        icon={<PlusSignIcon size={16} strokeWidth={2.5} />}
                        onClick={() => setEditing({ note: null })}
                    >
                        {t('memory.new')}
                    </Button>
                </div>
            </div>

            <div className="shrink-0 -mt-2 flex flex-col gap-1 text-[13px] text-gray-500 dark:text-gray-400">
                <p>
                    {entries.length === 0
                        ? t('memory.note')
                        : t('memory.coreLine', {
                            rules: status?.rulesCarried || 0,
                            chars: status?.ruleChars || 0,
                            budget: status?.ruleBudget || 0,
                            rest,
                        })}
                    {over.size > 0 && (
                        <span className="text-amber-600 dark:text-amber-400"> {t('memory.overBudget', { count: over.size })}</span>
                    )}
                </p>
                {entries.length > 1 && (
                    <p className="flex flex-wrap items-center gap-x-2">
                        {tidy?.running ? (
                            <span>{t('memory.tidying')}</span>
                        ) : failedSince ? (
                            <span>{t('memory.tidyFailedAt', { when: when(t, tidy.failedAt), reason: tidy.failure })}</span>
                        ) : last?.undone ? (
                            <span>{t('memory.tidyUndone', { when: when(t, last.at) })}</span>
                        ) : last ? (
                            <span>
                                {tidySummary
                                    ? t('memory.tidiedLine', { when: when(t, last.at), summary: tidySummary })
                                    : t('memory.tidiedNothing', { when: when(t, last.at) })}
                            </span>
                        ) : (
                            <span>{t('memory.neverTidied')}</span>
                        )}
                        {!tidy?.running && last && !last.undone && (last.changes || []).length > 0 && (
                            <>
                                <button
                                    type="button"
                                    onClick={() => setReviewing(true)}
                                    className="font-medium text-gray-700 dark:text-neutral-200 hover:underline underline-offset-2"
                                >
                                    {t('memory.review')}
                                </button>
                                <button
                                    type="button"
                                    onClick={undoTidy}
                                    className="font-medium text-gray-700 dark:text-neutral-200 hover:underline underline-offset-2"
                                >
                                    {t('memory.undoTidy')}
                                </button>
                            </>
                        )}
                    </p>
                )}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                {visible.length === 0 ? (
                    <EmptyFrame
                        icon={needle || kind !== 'all'
                            ? <SearchRemoveIcon size={28} strokeWidth={1.5} />
                            : <BrainIcon size={28} strokeWidth={1.5} />}
                        title={needle || (kind !== 'all' && entries.length) ? t('common.noMatchesTitle') : t('memory.empty')}
                        note={needle ? `“${query.trim()}”` : kind !== 'all' && entries.length ? undefined : t('memory.emptyNote')}
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
                                        <KindBadge
                                            kind={entry.kind}
                                            carried={entry.kind === 'rule' && !over.has(entry.id)}
                                            over={over.has(entry.id)}
                                        />
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

            {reviewing && last && (
                <TidyReview last={last} onClose={() => setReviewing(false)} onUndo={undoTidy} />
            )}

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(MemoryPanel);
