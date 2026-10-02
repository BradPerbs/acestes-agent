import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
    Delete02Icon,
    Download04Icon,
    Edit02Icon,
    File01Icon,
    FileScriptIcon,
    FileUploadIcon,
    FileZipIcon,
    FolderOpenIcon,
    Image01Icon,
    Pdf01Icon,
    PlusSignIcon,
    SearchRemoveIcon,
    SquareArrowUpRightIcon,
} from 'hugeicons-react';
import Dialog from './ui/Dialog';
import Button from './ui/Button';
import Checkbox from './ui/Checkbox';
import ConfirmDialog from './ui/ConfirmDialog';
import EmptyFrame from './ui/EmptyFrame';
import Field, { FIELD_CLASS } from './ui/Field';
import SearchField from './ui/SearchField';
import { useT } from '../i18n';
import { toastOptions } from '../lib/toast';

/**
 * The selected agent's files: what it carries that is bytes rather than a
 * record. Its own and the shared ones, which every agent can read and send.
 *
 * The agent fills most of this from its conversations; this page is where
 * the user hands it something (a drop on the page, or the Add button), opens
 * or saves a copy of what it made, renames, shares and deletes. The bytes
 * never cross into the page: main opens them, reveals them and copies them.
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

export function sizeLabel(bytes = 0) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

const CODE = /^(text\/|application\/(json|xml|yaml|toml|sql|javascript|x-pem-file))/;
const ARCHIVE = /(zip|gzip|x-tar|7z|rar)/;

/** The glyph for a kind of file. */
export function FileGlyph({ mime = '', size = 20 }) {
    const props = { size, strokeWidth: 1.5 };
    if (mime.startsWith('image/')) return <Image01Icon {...props} />;
    if (mime === 'application/pdf') return <Pdf01Icon {...props} />;
    if (ARCHIVE.test(mime)) return <FileZipIcon {...props} />;
    if (CODE.test(mime)) return <FileScriptIcon {...props} />;
    return <File01Icon {...props} />;
}

const parseTags = (text) => String(text || '').split(/[,\s]+/).map(tag => tag.trim().replace(/^#/, '')).filter(Boolean);

function FileDialog({ file, onClose, onSave }) {
    const t = useT();
    const [name, setName] = useState(file.name);
    const [description, setDescription] = useState(file.description || '');
    const [tags, setTags] = useState((file.tags || []).join(', '));
    const [shared, setShared] = useState(Boolean(file.shared));
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        if (!name.trim() || saving) return;
        setSaving(true);
        try {
            const ok = await onSave({ name: name.trim(), description: description.trim(), tags: parseTags(tags), shared });
            if (ok) onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            title={t('files.editTitle')}
            onClose={onClose}
            width="32rem"
            footer={(
                <>
                    <Button onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" onClick={submit} disabled={!name.trim() || saving}>
                        {t('common.save')}
                    </Button>
                </>
            )}
        >
            <div className="flex flex-col gap-4">
                <Field label={t('files.name')}>
                    <input
                        autoFocus
                        type="text"
                        value={name}
                        maxLength={120}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
                        className={FIELD_CLASS}
                    />
                </Field>
                <Field label={t('files.description')}>
                    <textarea
                        value={description}
                        maxLength={500}
                        rows={3}
                        onChange={(event) => setDescription(event.target.value)}
                        placeholder={t('files.descriptionPlaceholder')}
                        className={`${FIELD_CLASS} resize-y`}
                    />
                </Field>
                <Field label={t('files.tags')} hint={t('files.tagsHint')}>
                    <input
                        type="text"
                        value={tags}
                        onChange={(event) => setTags(event.target.value)}
                        className={FIELD_CLASS}
                        placeholder="config, backup"
                    />
                </Field>
                <Checkbox
                    variant="card"
                    checked={shared}
                    onChange={(event) => setShared(event.target.checked)}
                    label={t('files.sharedLabel')}
                    description={t('files.sharedHint')}
                />
            </div>
        </Dialog>
    );
}

/** One of the row's actions: a square button that shows on hover. */
function RowAction({ label, onClick, danger = false, children }) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors
                text-gray-400 dark:text-neutral-500
                ${danger
                    ? 'hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400'
                    : 'hover:bg-gray-100 hover:text-gray-900 dark:hover:bg-surface-control dark:hover:text-white'}`}
        >
            {children}
        </button>
    );
}

function FilesPanel({ agentId = '' }) {
    const t = useT();
    const [entries, setEntries] = useState([]);
    const [query, setQuery] = useState('');
    const [editing, setEditing] = useState(null);
    const [confirming, setConfirming] = useState(null);
    const [dragging, setDragging] = useState(false);
    const depth = useRef(0);

    const refresh = useCallback(async () => {
        try {
            setEntries(await window.api.files.list(agentId) || []);
        } catch {
            // The list just shows what it had.
        }
    }, [agentId]);

    // Read for the agent selected, and again whenever the agent (or another
    // window) changes the files.
    useEffect(() => {
        refresh();
        return window.api.inventory?.onChange?.((change) => {
            if (change?.kind === 'files' && (!change.agentId || !agentId || change.agentId === agentId)) refresh();
        });
    }, [refresh, agentId]);

    const needle = query.trim().toLowerCase();
    const visible = useMemo(() => (needle
        ? entries.filter(file => [file.name, file.description, ...(file.tags || [])].join(' ').toLowerCase().includes(needle))
        : entries), [entries, needle]);

    /** What came back from an add, said once. */
    const report = useCallback((result) => {
        if (!result || result.canceled) return;
        const added = result.added?.length || 0;
        if (added) toast.success(t('files.added', { count: added }), toastOptions({ duration: 2400 }));
        for (const problem of result.errors || []) toast.error(problem.message, toastOptions());
        refresh();
    }, [refresh, t]);

    const addFiles = useCallback(async () => {
        try {
            report(await window.api.files.add(agentId));
        } catch (error) {
            toast.error(error.message, toastOptions());
        }
    }, [agentId, report]);

    // Files dragged in from the desktop or Explorer. Counted in and out, since
    // every child the pointer crosses fires its own enter and leave.
    const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    const onDragEnter = (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
    };
    const onDragOver = (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event) => {
        if (!carriesFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
    };
    const onDrop = async (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        try {
            report(await window.api.files.addDropped(agentId, event.dataTransfer.files));
        } catch (error) {
            toast.error(error.message, toastOptions());
        }
    };

    const act = useCallback(async (call, failure) => {
        try {
            const result = await call();
            if (result?.canceled) return result;
            if (result?.error || result?.success === false) {
                toast.error(result.error || result.message || failure, toastOptions());
            }
            return result;
        } catch (error) {
            toast.error(error.message || failure, toastOptions());
            return null;
        }
    }, []);

    const open = (file) => act(() => window.api.files.open(agentId, file.id), t('files.openFailed'));
    const reveal = (file) => act(() => window.api.files.reveal(agentId, file.id), t('files.openFailed'));
    const saveCopy = async (file) => {
        const result = await act(() => window.api.files.exportFile(agentId, file.id), t('files.exportFailed'));
        if (result?.success) toast.success(t('files.exported'), toastOptions({ duration: 2400 }));
    };

    const save = useCallback(async (patch) => {
        const result = await act(() => window.api.files.update(agentId, editing.file.id, patch), t('files.saveFailed'));
        if (result && !result.error) {
            refresh();
            return true;
        }
        return false;
    }, [act, agentId, editing, refresh, t]);

    const confirmDelete = useCallback((file) => {
        setConfirming({
            title: t('files.deleteTitle', { name: file.name }),
            message: file.shared ? t('files.deleteSharedMessage') : t('files.deleteMessage'),
            confirmLabel: t('common.delete'),
            onConfirm: async () => {
                setConfirming(null);
                await act(() => window.api.files.remove(agentId, file.id), t('files.deleteFailed'));
                refresh();
            },
        });
    }, [act, agentId, refresh, t]);

    const total = entries.reduce((sum, file) => sum + (file.size || 0), 0);

    return (
        <div
            className="relative flex flex-col gap-4 h-full min-h-0"
            id="files-panel"
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            <div className="flex flex-wrap items-center gap-2 shrink-0">
                <SearchField
                    value={query}
                    onChange={setQuery}
                    ariaLabel={t('files.search')}
                    placeholder={t('files.search')}
                />
                <div className="flex items-center gap-2 shrink-0 ml-auto">
                    <Button
                        variant="primary"
                        icon={<PlusSignIcon size={16} strokeWidth={2.5} />}
                        onClick={addFiles}
                    >
                        {t('files.add')}
                    </Button>
                </div>
            </div>

            <p className="shrink-0 -mt-2 text-[13px] text-gray-500 dark:text-gray-400">
                {t('files.note')}
                {entries.length > 0 && (
                    <span className="ml-1 tabular-nums">
                        {t('files.summary', { count: entries.length, size: sizeLabel(total) })}
                    </span>
                )}
            </p>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1">
                {visible.length === 0 ? (
                    <EmptyFrame
                        icon={needle
                            ? <SearchRemoveIcon size={28} strokeWidth={1.5} />
                            : <FileUploadIcon size={28} strokeWidth={1.5} />}
                        title={needle ? t('common.noMatchesTitle') : t('files.empty')}
                        note={needle ? `“${query.trim()}”` : t('files.emptyNote')}
                    />
                ) : (
                    <div className="flex flex-col gap-2">
                        {visible.map(file => (
                            <div
                                key={file.id}
                                onDoubleClick={() => open(file)}
                                className="group/row flex items-center gap-3 px-4 py-3 rounded-xl
                                    bg-white dark:bg-neutral-800/50 border border-gray-200 dark:border-neutral-800"
                            >
                                <span className="shrink-0 w-10 h-10 rounded-[13px] flex items-center justify-center
                                    bg-cyan-500/10 text-cyan-600 dark:bg-cyan-400/10 dark:text-cyan-300">
                                    <FileGlyph mime={file.mime} />
                                </span>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate" title={file.name}>
                                            {file.name}
                                        </span>
                                        {file.shared && (
                                            <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wide
                                                bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                                                {t('files.shared')}
                                            </span>
                                        )}
                                    </div>
                                    {file.description && (
                                        <p className="mt-0.5 text-[13px] text-gray-600 dark:text-gray-300 truncate" title={file.description}>
                                            {file.description}
                                        </p>
                                    )}
                                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500 dark:text-neutral-400">
                                        <span className="tabular-nums">{sizeLabel(file.size)}</span>
                                        <span>·</span>
                                        <span>{when(t, file.updatedAt)}</span>
                                        <span>·</span>
                                        <span className="font-mono select-all" title={t('files.referenceHint')}>{file.reference}</span>
                                        {(file.tags || []).map(tag => (
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
                                    <RowAction label={t('files.open')} onClick={() => open(file)}>
                                        <SquareArrowUpRightIcon size={15} strokeWidth={1.5} />
                                    </RowAction>
                                    <RowAction label={t('files.reveal')} onClick={() => reveal(file)}>
                                        <FolderOpenIcon size={15} strokeWidth={1.5} />
                                    </RowAction>
                                    <RowAction label={t('files.saveCopy')} onClick={() => saveCopy(file)}>
                                        <Download04Icon size={15} strokeWidth={1.5} />
                                    </RowAction>
                                    <RowAction label={t('common.edit')} onClick={() => setEditing({ file })}>
                                        <Edit02Icon size={15} strokeWidth={1.5} />
                                    </RowAction>
                                    <RowAction label={t('common.delete')} danger onClick={() => confirmDelete(file)}>
                                        <Delete02Icon size={15} strokeWidth={1.5} />
                                    </RowAction>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {dragging && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl
                    border-2 border-dashed border-cyan-500/60 bg-cyan-500/[0.06] dark:bg-cyan-400/[0.06]">
                    <div className="flex flex-col items-center gap-2 text-cyan-700 dark:text-cyan-200">
                        <FileUploadIcon size={32} strokeWidth={1.5} />
                        <span className="text-sm font-medium">{t('files.dropHere')}</span>
                    </div>
                </div>
            )}

            {editing && (
                <FileDialog file={editing.file} onClose={() => setEditing(null)} onSave={save} />
            )}

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(FilesPanel);
