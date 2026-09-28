import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown01Icon, Loading03Icon, Refresh01Icon, Search01Icon, Tick02Icon } from 'hugeicons-react';
import EffortSlider from './EffortSlider';
import ProviderMark from '../../lib/provider-marks';
import {
    PROVIDER_NAMES,
    PROVIDER_ORDER,
    mergedModelRows,
    currentModelRow,
    effortStops,
    effortLabel,
    nearestEffort,
    isDiscovered,
} from '../../lib/ai-catalog';
import { chosenAccount, headlineWindows, keyOf, toneOf } from '../../lib/usage-limits';
import useUsageLimits from '../../hooks/useUsageLimits';
import { useEnterOn } from '../../hooks/useEnter';
import { useT } from '../../i18n';

/**
 * The model and how hard it should think, as one chip in the composer.
 *
 * They are repeated here, beside the settings page, because they are the two
 * things people change mid-conversation, and one control holds both because
 * "which model, how hard" is one decision about what the next question is
 * worth.
 *
 * Every switched-on agent's models are in one list, grouped under the agent
 * they belong to, and picking a row moves the agent as well as the model. With
 * several agents on that list is long, so the menu is three parts that behave
 * differently: a search field that stays at the top, the groups in between
 * that scroll under their own sticky headings, and the effort dial fixed at
 * the bottom, where it can always be reached without scrolling past forty
 * models to find it.
 *
 * Each heading carries the plan figure for the account that agent runs under,
 * so the choice between two agents can be made knowing which one has room.
 *
 * Nothing in the list is written here: each agent reports what it can run, and
 * the effort scale is narrowed to the levels the chosen model takes. An agent
 * that has not answered yet says so under its heading rather than being
 * padded out with a guess.
 *
 * The keyboard works the way a command palette does: type to filter, arrows
 * to move, Enter to pick, Escape to close.
 */

const WIDTH = 'w-[21rem]';

/** Every word typed has to appear somewhere in the row, in any order. */
function matches(row, words) {
    if (words.length === 0) return true;
    const haystack = `${row.label} ${row.short} ${row.value} ${row.hint || ''} ${PROVIDER_NAMES[row.provider] || ''}`.toLowerCase();
    return words.every(word => haystack.includes(word));
}

/** The qualifier a runtime puts in brackets, `(1M context)`, as a tag. */
const qualifier = (row) => /\(([^)]+)\)\s*$/.exec(row.label || '')?.[1] || '';

const TONE = {
    ok: 'text-gray-400 dark:text-neutral-500',
    warn: 'text-amber-600 dark:text-amber-400',
    over: 'text-red-600 dark:text-red-400',
};

/** The plan figure beside an agent's heading: `5h 34% · 7d 5%`, or nothing. */
function PlanFigure({ provider, settings, overview }) {
    const account = chosenAccount(overview, settings, provider);
    if (!account) return null;
    const windows = headlineWindows(overview.limits?.[keyOf(provider, account.id)]?.windows);
    if (windows.length === 0) return null;
    return (
        <span className="flex items-center gap-1.5 text-[10px] font-medium tabular-nums normal-case tracking-normal">
            {windows.map((window, index) => (
                <span key={window.id} className={TONE[toneOf(window)]}>
                    {index > 0 && <span className="text-gray-300 dark:text-neutral-600 mr-1.5">·</span>}
                    {window.id.endsWith('five_hour') ? '5h' : '7d'} {Math.round(window.used)}%
                </span>
            ))}
        </span>
    );
}

/** Under a heading whose agent has not answered: still reading, or ask again. */
function Pending({ loading, onRefresh }) {
    const t = useT();
    if (loading) {
        return (
            <div className="flex items-center gap-2 h-8 px-3 text-[11px] text-gray-400 dark:text-neutral-500">
                <Loading03Icon size={12} strokeWidth={2} className="animate-spin" />
                {t('assistant.readingModels')}
            </div>
        );
    }
    return (
        <button
            type="button"
            onClick={onRefresh}
            className="w-full flex items-center gap-2 h-8 px-3 rounded-lg text-left text-[11px]
                text-gray-400 dark:text-neutral-500 hover:text-gray-900 dark:hover:text-white
                hover:bg-gray-100 dark:hover:bg-white/[0.05] transition-colors"
        >
            <Refresh01Icon size={12} strokeWidth={2} />
            {t('assistant.noModels')}
        </button>
    );
}

function MenuBody({ rows, model, settings, providers, catalogs, loading, onRefresh, onPick, onEffort, onClose }) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(-1);
    const listRef = useRef(null);
    const { overview } = useUsageLimits();

    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const groups = useMemo(() => {
        const on = new Set(providers?.length ? providers : [settings.provider]);
        return PROVIDER_ORDER.filter(provider => on.has(provider)).map(provider => ({
            provider,
            rows: rows.filter(row => row.provider === provider && matches(row, words)),
            pending: !isDiscovered(catalogs?.[provider]),
        })).filter(group => group.rows.length > 0 || (words.length === 0 && group.pending));
        // `words` is derived from `query`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, providers, catalogs, settings.provider, query]);

    const flat = groups.flatMap(group => group.rows);

    // Land on the model in use when the menu opens, and on the first match
    // once something is typed.
    useEffect(() => {
        if (words.length > 0) setActive(flat.length > 0 ? 0 : -1);
        else setActive(Math.max(-1, flat.findIndex(row => row.key === model?.key)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query]);

    // The highlighted row stays in view as the arrows move it.
    useEffect(() => {
        const node = listRef.current?.querySelector(`[data-index="${active}"]`);
        node?.scrollIntoView({ block: 'nearest' });
    }, [active]);

    const onKeyDown = (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (flat.length === 0) return;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive(current => (current < 0 ? 0 : (current + step + flat.length) % flat.length));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (flat[active]) onPick(flat[active]);
        } else if (event.key === 'Escape') {
            // Claimed, or Escape would also blur the composer behind it.
            event.preventDefault();
            event.stopPropagation();
            if (query) setQuery('');
            else onClose();
        }
    };

    const stops = effortStops(model);
    const shown = nearestEffort(stops, settings.effort);
    const effort = stops.find(option => option.value === shown);
    const described = flat[active] || model;
    // Headings whenever more than one agent is on, even when a search has
    // narrowed the list to one of them: the rows still need to say whose.
    const marked = (providers?.length || 0) > 1;

    let index = -1;

    return (
        <>
            <div className="shrink-0 px-2 pt-2 pb-1.5">
                <label className="flex items-center gap-2 h-8 px-2.5 rounded-lg bg-gray-100/80 dark:bg-white/[0.05]
                    focus-within:ring-1 focus-within:ring-gray-900/15 dark:focus-within:ring-white/15 transition-shadow"
                >
                    <Search01Icon size={13} strokeWidth={2} className="shrink-0 text-gray-400 dark:text-neutral-500" />
                    <input
                        autoFocus
                        type="text"
                        spellCheck={false}
                        autoComplete="off"
                        aria-label={t('assistant.searchModels')}
                        aria-controls="model-menu-list"
                        placeholder={t('assistant.searchModels')}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={onKeyDown}
                        className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] text-gray-900 dark:text-white
                            placeholder:text-gray-400 dark:placeholder:text-neutral-500"
                    />
                    {flat.length > 0 && words.length > 0 && (
                        <span className="shrink-0 text-[10px] tabular-nums text-gray-400 dark:text-neutral-500">{flat.length}</span>
                    )}
                </label>
            </div>

            <div
                ref={listRef}
                id="model-menu-list"
                role="listbox"
                aria-label={t('assistant.model')}
                className="flex-1 min-h-0 max-h-[19rem] overflow-y-auto overscroll-contain px-1.5 pb-1.5"
            >
                {groups.length === 0 && (
                    <div className="px-3 py-6 text-center text-[11px] text-gray-400 dark:text-neutral-500">
                        {words.length > 0 ? t('assistant.noModelMatch', { query }) : t('assistant.noModels')}
                    </div>
                )}

                {groups.map(group => (
                    <div key={group.provider} role="group" aria-label={PROVIDER_NAMES[group.provider]}>
                        {marked && (
                            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 h-7 px-2 mt-1 first:mt-0
                                bg-white/95 dark:bg-surface-raised/95 backdrop-blur-sm"
                            >
                                <span className="flex items-center gap-1.5 min-w-0 text-[10px] font-semibold uppercase tracking-[0.08em]
                                    text-gray-500 dark:text-neutral-400"
                                >
                                    <span className="leading-none text-gray-600 dark:text-gray-300"><ProviderMark provider={group.provider} size={11} /></span>
                                    <span className="truncate">{PROVIDER_NAMES[group.provider]}</span>
                                </span>
                                <PlanFigure provider={group.provider} settings={settings} overview={overview} />
                            </div>
                        )}

                        {group.rows.map((row) => {
                            index += 1;
                            const position = index;
                            const selected = row.key === model?.key;
                            const highlighted = position === active;
                            const tag = qualifier(row);
                            return (
                                <button
                                    key={row.key}
                                    type="button"
                                    role="option"
                                    aria-selected={selected}
                                    data-index={position}
                                    onMouseMove={() => { if (active !== position) setActive(position); }}
                                    onClick={() => onPick(row)}
                                    className={`w-full h-8 px-2.5 flex items-center gap-2 rounded-lg text-left transition-colors
                                        ${highlighted ? 'bg-gray-100 dark:bg-white/[0.06]' : ''}`}
                                >
                                    <span className={`min-w-0 truncate text-[13px] ${selected
                                        ? 'font-semibold text-gray-900 dark:text-white'
                                        : 'font-medium text-gray-700 dark:text-gray-200'}`}
                                    >
                                        {row.short || row.label}
                                    </span>
                                    {tag && (
                                        <span className="shrink-0 px-1.5 py-px rounded-[5px] text-[9.5px] font-semibold tracking-wide
                                            bg-gray-100 dark:bg-white/[0.07] text-gray-500 dark:text-gray-400"
                                        >
                                            {tag}
                                        </span>
                                    )}
                                    {row.preferred && !tag && (
                                        <span className="shrink-0 text-[10px] text-gray-400 dark:text-neutral-500">{t('assistant.defaultModel')}</span>
                                    )}
                                    <span className="flex-1" />
                                    {selected && <Tick02Icon size={13} strokeWidth={2.5} className="shrink-0 text-gray-900 dark:text-white" />}
                                </button>
                            );
                        })}

                        {group.pending && group.rows.length === 0 && <Pending loading={loading} onRefresh={onRefresh} />}
                    </div>
                ))}
            </div>

            {/* The highlighted model in a sentence, and the dial, both fixed
                below the list so neither has to be scrolled to. */}
            <div className="shrink-0 border-t border-gray-100 dark:border-white/[0.06] bg-gray-50/70 dark:bg-black/10">
                {described?.hint && (
                    <p className="px-3.5 pt-2.5 text-[11px] leading-snug text-gray-500 dark:text-neutral-400 line-clamp-2">
                        {described.hint}
                    </p>
                )}
                {stops.length > 1 ? (
                    <div className="pt-2">
                        <div className="px-3.5 pb-1.5 flex items-baseline justify-between text-[11px]">
                            <span className="font-semibold text-gray-500 dark:text-neutral-400">{t('assistant.effort')}</span>
                            <span className="font-medium text-gray-900 dark:text-white">{effortLabel(effort)}</span>
                        </div>
                        <div className="px-1">
                            <EffortSlider options={stops} value={shown} onChange={onEffort} />
                        </div>
                    </div>
                ) : (
                    <p className="px-3.5 py-2.5 text-[11px] text-gray-400 dark:text-neutral-500">
                        {model ? t('assistant.noEffort') : t('assistant.pickModel')}
                    </p>
                )}
            </div>
        </>
    );
}

export default function ModelMenu({ settings, catalogs, providers, loading, onRefresh, onChange }) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef(null);
    const menuRef = useRef(null);

    useEnterOn(menuRef, open && 'dialog');

    const rows = useMemo(
        () => mergedModelRows(catalogs, providers, settings),
        [catalogs, providers, settings]
    );

    // Undefined when nothing is pinned and the agent has not named a default.
    // The chip names the agent then, since that much is known.
    const model = currentModelRow(rows, settings);
    const stops = useMemo(() => effortStops(model), [model]);
    const shown = nearestEffort(stops, settings.effort);
    const effort = stops.find(option => option.value === shown);
    const marked = (providers?.length || 0) > 1;

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
            if (wrapperRef.current?.contains(event.target)) return;
            setOpen(false);
        };
        // Escape closes from anywhere in the menu, the dial included. In the
        // search field it clears what was typed first, which the field does
        // itself, so a field with text in it is left to it.
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            const field = event.target?.tagName === 'INPUT' && menuRef.current?.contains(event.target);
            if (field && event.target.value) return;
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
        };
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
        };
    }, [open]);

    // The effort travels with the model, because the scales differ, and the
    // agent travels with it too: a row names one model of one agent's.
    const pick = (row) => {
        setOpen(false);
        if (row.key === model?.key) return;
        onChange({
            provider: row.provider,
            model: row.value,
            effort: nearestEffort(effortStops(row), settings.effort),
        });
    };

    return (
        <div ref={wrapperRef} className="relative">
            <button
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen(value => !value)}
                title={t('assistant.modelAndEffort')}
                className={`h-7 pl-2 pr-1.5 rounded-xl flex items-center gap-1 transition-colors
                    text-[11px] outline-none focus-visible:ring-2
                    focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                    ${open
                        ? 'bg-gray-100 dark:bg-white/[0.08] text-gray-900 dark:text-gray-100'
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06] '
                            + 'hover:text-gray-700 dark:hover:text-gray-200'}`}
            >
                {/* Which agent as well as which model, once there is more than
                    one it could be: two of them can offer a model called
                    `sonnet`, and the name alone would not say whose plan the
                    next question spends. */}
                {marked && (
                    <span className="shrink-0 flex items-center">
                        <ProviderMark provider={model?.provider || settings.provider} size={13} />
                    </span>
                )}
                <span className="font-medium">{model?.short || PROVIDER_NAMES[settings.provider] || ''}</span>
                {effort && <span className="opacity-60">{effortLabel(effort)}</span>}
                <ArrowDown01Icon
                    size={11}
                    strokeWidth={2}
                    className={`shrink-0 opacity-60 transition-transform ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {open && (
                <div
                    ref={menuRef}
                    role="dialog"
                    aria-label={t('assistant.modelAndEffort')}
                    className={`absolute z-40 bottom-full mb-1.5 right-0 ${WIDTH} flex flex-col overflow-hidden rounded-2xl
                        bg-white dark:bg-surface-raised
                        border border-gray-200 dark:border-white/[0.08]
                        shadow-[0_20px_48px_-12px_rgba(0,0,0,0.3)] dark:shadow-[0_20px_48px_-12px_rgba(0,0,0,0.65)]`}
                >
                    <MenuBody
                        rows={rows}
                        model={model}
                        settings={settings}
                        providers={providers}
                        catalogs={catalogs}
                        loading={loading}
                        onRefresh={onRefresh}
                        onPick={pick}
                        onEffort={(value) => onChange({ effort: value })}
                        onClose={() => setOpen(false)}
                    />
                </div>
            )}
        </div>
    );
}
