import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InformationCircleIcon } from 'hugeicons-react';
import Dialog from './ui/Dialog';
import Button from './ui/Button';
import Field, { FIELD_CLASS } from './ui/Field';
import SegmentedControl from './ui/SegmentedControl';
import AgentMark from './assistant/AgentMark';
import { AGENT_COLORS } from '../lib/agent-colors';
import { AGENT_CRESTS, agentLook } from '../lib/agent-look';
import { useT } from '../i18n';

/**
 * Naming an agent, new or renamed, and picking how its mark looks.
 *
 * The look (a colour, and the crest or none) is what tells one agent's mark
 * from another's across the app, so it is chosen here, where the agent is
 * made, with the mark itself drawn in each choice on offer rather than a row
 * of paint chips and a list of names.
 *
 * A new agent is also asked where its local work runs: on this computer,
 * inside the folders it is granted, or in a container of its own. Asked here
 * because it is the one choice that changes what the agent *is* rather than
 * how it is tuned, and because the person creating an agent for unattended
 * work should meet the container before the first conversation, not find it
 * on a settings page later. Everything else about the envelope (folders,
 * network, sessions) stays on the Sandbox card in Settings, where it can be
 * changed at any time, as can this.
 */

const MODES = ['host', 'container'];
const FOLDER_MODES = ['read', 'write'];

/**
 * What each mode can and cannot do, spelled out. Shown behind the info mark
 * rather than under the options, because the options want one line each and
 * the honest version is six.
 */
const MODE_NOTES = {
    host: {
        can: ['agents.mode.host.can1', 'agents.mode.host.can2', 'agents.mode.host.can3'],
        cannot: ['agents.mode.host.cannot1', 'agents.mode.host.cannot2'],
    },
    container: {
        can: ['agents.mode.container.can1', 'agents.mode.container.can2', 'agents.mode.container.can3'],
        cannot: ['agents.mode.container.cannot1', 'agents.mode.container.cannot2', 'agents.mode.container.cannot3'],
    },
};

/** How wide the panel is, and how close it may come to the window edge. */
const PANEL_WIDTH = 560;
const PANEL_EDGE = 12;
const PANEL_GAP = 8;

/**
 * The info mark and the panel it opens.
 *
 * The panel is portalled to the body rather than drawn inside the dialog:
 * the dialog's content scrolls, so anything positioned inside it is clipped
 * at its edge, and a panel that is half hidden is worse than none. It sits
 * under the mark, or above it when the window has no room below, and is
 * kept inside the viewport either way. Closed by a click elsewhere or by
 * Escape, which is swallowed so the dialog behind does not close with it.
 */
function ModeInfo() {
    const t = useT();
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState(null);
    const markRef = useRef(null);
    const panelRef = useRef(null);

    const measure = () => {
        const rect = markRef.current?.getBoundingClientRect();
        if (!rect) return;
        const width = Math.min(PANEL_WIDTH, window.innerWidth - PANEL_EDGE * 2);
        const left = Math.min(Math.max(rect.left, PANEL_EDGE), window.innerWidth - PANEL_EDGE - width);
        const panelHeight = panelRef.current?.offsetHeight || 0;
        const below = rect.bottom + PANEL_GAP;
        const fitsBelow = panelHeight === 0 || below + panelHeight <= window.innerHeight - PANEL_EDGE;
        setPosition(fitsBelow
            ? { left, top: below, width, maxHeight: window.innerHeight - PANEL_EDGE - below }
            : { left, bottom: window.innerHeight - rect.top + PANEL_GAP, width, maxHeight: rect.top - PANEL_GAP - PANEL_EDGE });
    };

    // Once on open, then again after the panel has painted so its height is
    // known for the flip; and on resize, because the mark moves.
    useLayoutEffect(() => {
        if (!open) return undefined;
        measure();
        const frame = requestAnimationFrame(measure);
        window.addEventListener('resize', measure);
        return () => {
            cancelAnimationFrame(frame);
            window.removeEventListener('resize', measure);
        };
    }, [open]);

    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
            if (markRef.current?.contains(event.target)) return;
            if (panelRef.current?.contains(event.target)) return;
            setOpen(false);
        };
        const onKey = (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onPointer);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('mousedown', onPointer);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);

    const panel = open && createPortal(
        <div
            ref={panelRef}
            role="dialog"
            aria-label={t('agents.mode.info')}
            style={{
                position: 'fixed',
                left: position?.left ?? PANEL_EDGE,
                top: position?.top,
                bottom: position?.bottom,
                width: position?.width ?? PANEL_WIDTH,
                maxHeight: position?.maxHeight,
                visibility: position ? 'visible' : 'hidden',
            }}
            className="z-[300] overflow-y-auto p-4 rounded-2xl text-[12px] leading-snug
                bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700
                shadow-xl text-gray-700 dark:text-gray-300"
        >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {MODES.map(mode => (
                    <section key={mode} className="min-w-0">
                        <h4 className="text-[13px] font-semibold text-gray-900 dark:text-white">
                            {t(`agents.mode.${mode}`)}
                        </h4>
                        <p className="mt-0.5 mb-2.5 text-[11px] text-gray-500 dark:text-neutral-400">
                            {t(`agents.mode.${mode}.desc`)}
                        </p>

                        <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                            {t('agents.mode.can')}
                        </div>
                        <ul className="mt-1 mb-2.5 space-y-1">
                            {MODE_NOTES[mode].can.map(key => (
                                <li key={key} className="flex gap-1.5">
                                    <span className="text-emerald-600 dark:text-emerald-400 shrink-0">✓</span>
                                    <span>{t(key)}</span>
                                </li>
                            ))}
                        </ul>

                        <div className="text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                            {t('agents.mode.cannot')}
                        </div>
                        <ul className="mt-1 space-y-1">
                            {MODE_NOTES[mode].cannot.map(key => (
                                <li key={key} className="flex gap-1.5">
                                    <span className="text-red-500 dark:text-red-400 shrink-0">✕</span>
                                    <span>{t(key)}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
            <p className="mt-4 pt-3 border-t border-gray-200 dark:border-neutral-700 text-[11px] text-gray-500 dark:text-neutral-400">
                {t('agents.mode.footnote')}
            </p>
        </div>,
        document.body,
    );

    return (
        <>
            <button
                ref={markRef}
                type="button"
                aria-label={t('agents.mode.info')}
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
                className="inline-flex items-center justify-center w-5 h-5 rounded-full
                    text-gray-400 dark:text-neutral-500
                    hover:text-gray-700 dark:hover:text-gray-200
                    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25 outline-none"
            >
                <InformationCircleIcon size={15} strokeWidth={1.75} />
            </button>
            {panel}
        </>
    );
}

/**
 * One row of choices for a part of the look, each drawn as the mark wearing
 * it, in the colour already picked, so what is being chosen is the whole
 * face and not a word for part of it.
 */
function LookChoice({ label, options, value, look, part, onChange }) {
    const t = useT();
    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">{label}</span>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={label}>
                {options.map(option => (
                    <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={value === option}
                        onClick={() => onChange(option)}
                        className={`flex items-center gap-2 px-2.5 py-2 rounded-xl border transition-colors outline-none
                            focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                            ${value === option
                                ? 'border-gray-900 dark:border-white bg-gray-50 dark:bg-white/[0.06]'
                                : 'border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600'}`}
                    >
                        <AgentMark size={30} look={{ ...look, [part]: option }} />
                        <span className="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                            {t(`agents.${part}.${option}`)}
                        </span>
                    </button>
                ))}
            </div>
        </div>
    );
}

export default function AgentDialog({ agent = null, suggestedLook = null, onClose, onSave }) {
    const t = useT();
    const [name, setName] = useState(agent?.name || '');
    const [look, setLook] = useState(() => agentLook(agent || suggestedLook));
    const setPart = (part) => (value) => setLook(current => ({ ...current, [part]: value }));
    const [mode, setMode] = useState('host');
    // The folders on this computer the agent is confined to. Asked here as
    // well as on the Sandbox card, because "this agent works in this folder"
    // is the first thing most people want to say about one, and the card is
    // three pages away. Same record either way: the envelope on the agent.
    const [folders, setFolders] = useState(() => (agent?.sandbox?.folders || []).map(folder => ({ ...folder })));
    const [saving, setSaving] = useState(false);

    const addFolder = async () => {
        const picked = await window.api.agents.chooseFolder();
        if (!picked?.path) return;
        setFolders(current => (current.some(folder => folder.path === picked.path)
            ? current
            : [...current, { path: picked.path, mode: 'write' }]));
    };

    const setFolderMode = (index, next) => setFolders(current => current.map((folder, at) => (
        at === index ? { ...folder, mode: next } : folder
    )));

    const removeFolder = (index) => setFolders(current => current.filter((folder, at) => at !== index));

    const submit = async () => {
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
            await onSave(trimmed, look, agent ? { folders } : { execution: mode, folders });
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            title={agent ? t('agents.renameTitle') : t('agents.newTitle')}
            subtitle={agent ? undefined : t('agents.newSubtitle')}
            onClose={onClose}
            footer={(
                <>
                    <Button onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" onClick={submit} disabled={!name.trim() || saving}>
                        {agent ? t('common.save') : t('agents.create')}
                    </Button>
                </>
            )}
        >
            <form
                onSubmit={(event) => { event.preventDefault(); submit(); }}
                className="flex flex-col gap-5"
            >
                <div className="flex items-center gap-4">
                    <AgentMark size={56} look={look} animated />
                    <Field label={t('agents.nameLabel')} className="flex-1">
                        <input
                            autoFocus
                            type="text"
                            value={name}
                            maxLength={60}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t('agents.namePlaceholder')}
                            className={FIELD_CLASS}
                        />
                    </Field>
                </div>

                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {t('agents.colorLabel')}
                    </span>
                    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('agents.colorLabel')}>
                        {AGENT_COLORS.map(option => (
                            <button
                                key={option.id}
                                type="button"
                                role="radio"
                                aria-checked={look.color === option.id}
                                title={option.label}
                                onClick={() => setPart('color')(option.id)}
                                className={`w-8 h-8 rounded-full flex items-center justify-center transition-all
                                    hover:scale-110 active:scale-95 outline-none
                                    ${look.color === option.id
                                        ? 'ring-2 ring-offset-2 ring-gray-900 dark:ring-white ring-offset-white dark:ring-offset-surface-raised'
                                        : 'focus-visible:ring-2 focus-visible:ring-gray-900/30 dark:focus-visible:ring-white/40'}`}
                            >
                                <AgentMark size={28} look={{ ...look, color: option.id }} />
                            </button>
                        ))}
                    </div>
                </div>

                <LookChoice
                    label={t('agents.crestLabel')}
                    part="crest"
                    options={AGENT_CRESTS}
                    value={look.crest}
                    look={look}
                    onChange={setPart('crest')}
                />

                {!agent && (
                    <div className="flex flex-col gap-1.5">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300">
                            {t('agents.modeLabel')}
                            <ModeInfo />
                        </span>
                        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('agents.modeLabel')}>
                            {MODES.map(option => (
                                <button
                                    key={option}
                                    type="button"
                                    role="radio"
                                    aria-checked={mode === option}
                                    onClick={() => setMode(option)}
                                    className={`text-left p-3 rounded-xl border transition-colors outline-none
                                        focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                                        ${mode === option
                                            ? 'border-gray-900 dark:border-white bg-gray-50 dark:bg-white/[0.06]'
                                            : 'border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600'}`}
                                >
                                    <div className="text-sm font-semibold text-gray-900 dark:text-white">
                                        {t(`agents.mode.${option}`)}
                                    </div>
                                    <div className="mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-neutral-400">
                                        {t(`agents.mode.${option}.desc`)}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {t('agents.foldersLabel')}
                    </span>
                    <p className="text-[11px] leading-snug text-gray-500 dark:text-neutral-400">
                        {t('agents.foldersHint')}
                    </p>
                    {folders.length > 0 && (
                        <ul className="space-y-1.5">
                            {folders.map((folder, index) => (
                                <li
                                    key={folder.path}
                                    className="flex items-center gap-2 rounded-lg px-3 py-2
                                        bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700"
                                >
                                    <span
                                        className="flex-1 min-w-0 truncate font-mono text-xs text-gray-800 dark:text-gray-200"
                                        title={folder.path}
                                    >
                                        {folder.path}
                                    </span>
                                    <SegmentedControl
                                        size="sm"
                                        ariaLabel={t('agents.foldersLabel')}
                                        segments={FOLDER_MODES.map(value => ({
                                            value,
                                            label: t(`agents.folder.${value}`),
                                        }))}
                                        value={folder.mode}
                                        onChange={(value) => setFolderMode(index, value)}
                                    />
                                    <Button size="sm" variant="ghost" onClick={() => removeFolder(index)}>
                                        {t('common.remove')}
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div>
                        <Button size="sm" variant="secondary" onClick={addFolder}>
                            {t('agents.addFolder')}
                        </Button>
                    </div>
                </div>
            </form>
        </Dialog>
    );
}
