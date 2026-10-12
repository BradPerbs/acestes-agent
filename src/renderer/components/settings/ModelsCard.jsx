import { useCallback, useEffect, useState } from 'react';
import { Loading03Icon, Refresh01Icon, Tick02Icon } from 'hugeicons-react';
import Dialog, { DialogButton } from '../ui/Dialog';
import Button from '../ui/Button';
import Checkbox from '../ui/Checkbox';
import Select from '../ui/Select';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import AgentUpdatesRow from './AgentUpdatesRow';
import { FIELD_CLASS } from './useAssistantSettings';
import ProviderMark from '../../lib/provider-marks';
import { EFFORTS, PROVIDER_NAMES, PROVIDER_ORDER, effortLabel, effortStops } from '../../lib/ai-catalog';
import { useT } from '../../i18n';

/**
 * Which models each agent offers in the composer's menu.
 *
 * Some runtimes report dozens of aliases and dated snapshots, and the menu
 * has to hold all of them beside every other agent's. One row per switched-on
 * agent opens a small dialog with that agent's models as ticks: unticked ones
 * disappear from the menu, ticking a few after "deselect all" keeps just
 * those, and "select all" puts the runtime back the way it was.
 *
 * Hiding is display only. A model a conversation is already pinned to keeps
 * being offered whatever is ticked here, so this page can never strand the
 * composer on a row that is gone.
 */

function summary(t, total, hidden) {
    if (total === null) {
        return hidden > 0
            ? t('settings.assistant.modelsSomeHidden', { count: hidden })
            : t('settings.assistant.modelsAll');
    }
    return hidden > 0
        ? t('settings.assistant.modelsShown', { shown: total - hidden, count: total })
        : t('settings.assistant.modelsAllShown', { count: total });
}

function ModelsDialog({ provider, settings, onSettings, onKnown, onClose }) {
    const t = useT();
    const [rows, setRows] = useState(null);
    const hidden = settings.hiddenModels?.[provider] || [];

    const load = useCallback(async (refresh) => {
        setRows(null);
        const list = await window.api.ai.models({ provider, refresh }).catch(() => null);
        setRows(Array.isArray(list) ? list : []);
    }, [provider]);

    useEffect(() => { load(false); }, [load]);

    useEffect(() => {
        if (rows !== null) onKnown(provider, rows.length);
    }, [rows, provider, onKnown]);

    const setHidden = (next) => {
        const map = { ...(settings.hiddenModels || {}) };
        if (next.length === 0) delete map[provider];
        else map[provider] = next;
        onSettings({ hiddenModels: map });
    };

    const toggle = (value) => {
        setHidden(hidden.includes(value)
            ? hidden.filter(entry => entry !== value)
            : [...hidden, value]);
    };

    return (
        <Dialog
            title={t('settings.assistant.modelsTitle', { agent: PROVIDER_NAMES[provider] || provider })}
            subtitle={t('settings.assistant.modelsSubtitle')}
            onClose={onClose}
            width="24rem"
            footer={
                <>
                    <DialogButton onClick={() => setHidden([])}>
                        {t('settings.assistant.modelsSelectAll')}
                    </DialogButton>
                    <DialogButton
                        onClick={() => setHidden(rows ? rows.map(row => row.value) : hidden)}
                        disabled={!rows || rows.length === 0}
                    >
                        {t('settings.assistant.modelsDeselectAll')}
                    </DialogButton>
                    <DialogButton variant="primary" onClick={onClose}>
                        {t('common.close')}
                    </DialogButton>
                </>
            }
        >
            {rows === null ? (
                <div className="flex items-center gap-2 py-4 text-[13px] text-gray-400 dark:text-neutral-500">
                    <Loading03Icon size={14} strokeWidth={2} className="animate-spin" />
                    {t('settings.assistant.modelsLoading')}
                </div>
            ) : rows.length === 0 ? (
                <div className="py-2">
                    <p className="text-[13px] text-gray-500 dark:text-gray-400">
                        {t('settings.assistant.modelsEmpty')}
                    </p>
                    <Button
                        size="sm"
                        variant="secondary"
                        icon={<Refresh01Icon size={13} strokeWidth={2} />}
                        onClick={() => load(true)}
                        className="mt-3"
                    >
                        {t('settings.assistant.modelsRetry')}
                    </Button>
                </div>
            ) : (
                <ul className="py-1 space-y-0.5">
                    {rows.map(row => (
                        <li key={row.value}>
                            <Checkbox
                                checked={!hidden.includes(row.value)}
                                onChange={() => toggle(row.value)}
                                className="w-full rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-white/[0.04]"
                                label={
                                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900 dark:text-gray-100">
                                        {row.short || row.label || row.value}
                                    </span>
                                }
                                description={row.hint ? (
                                    <span className="block truncate text-xs text-gray-400 dark:text-neutral-500">
                                        {row.hint}
                                    </span>
                                ) : undefined}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </Dialog>
    );
}

/**
 * One model out of every switched-on agent's list, for the two rows below
 * that name one: the agent's default and its star. `current` is
 * `provider:model`; `noneLabel`, when given, is a first row that names none.
 */
function ModelPickDialog({ activated, title, subtitle, current, noneLabel, onChoose, onClose }) {
    const t = useT();
    const [catalogs, setCatalogs] = useState(null);
    const key = activated.join(' ');

    // Asked for rather than waited for, the way the composer does it: main
    // holds each answer, so this costs one start per runtime at most.
    const load = useCallback(async (refresh) => {
        setCatalogs(null);
        const answers = await Promise.all(key.split(' ').filter(Boolean).map(provider => (
            window.api.ai.models({ provider, refresh })
                .then(rows => [provider, Array.isArray(rows) ? rows : []])
                .catch(() => [provider, []])
        )));
        setCatalogs(Object.fromEntries(answers));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    useEffect(() => { load(false); }, [load]);

    const choose = (provider, model) => {
        onChoose(provider, model);
        onClose();
    };

    return (
        <Dialog
            title={title}
            subtitle={subtitle}
            onClose={onClose}
            width="24rem"
            footer={
                <DialogButton variant="primary" onClick={onClose}>
                    {t('common.close')}
                </DialogButton>
            }
        >
            {catalogs === null ? (
                <div className="flex items-center gap-2 py-4 text-[13px] text-gray-400 dark:text-neutral-500">
                    <Loading03Icon size={14} strokeWidth={2} className="animate-spin" />
                    {t('settings.assistant.modelsLoading')}
                </div>
            ) : (
                <>
                    {noneLabel && (
                        <button
                            type="button"
                            onClick={() => choose('', '')}
                            className={`w-full h-8 px-2.5 flex items-center gap-2 rounded-lg text-left transition-colors
                                hover:bg-gray-100 dark:hover:bg-white/[0.06]`}
                        >
                            <span className="truncate text-[13px] font-medium text-gray-700 dark:text-gray-200">
                                {noneLabel}
                            </span>
                            <span className="flex-1" />
                            {!current && <Tick02Icon size={13} strokeWidth={2.5} className="shrink-0 text-gray-900 dark:text-white" />}
                        </button>
                    )}
                    {key.split(' ').filter(Boolean).map(provider => {
                        const rows = catalogs[provider] || [];
                        if (rows.length === 0) return null;
                        return (
                            <div key={provider} className="mt-2">
                                <p className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider
                                    text-gray-400 dark:text-neutral-500"
                                >
                                    {PROVIDER_NAMES[provider]}
                                </p>
                                {rows.map(row => {
                                    const selected = current === `${provider}:${row.value}`;
                                    return (
                                        <button
                                            key={row.value}
                                            type="button"
                                            onClick={() => choose(provider, row.value)}
                                            className={`w-full h-8 px-2.5 flex items-center gap-2 rounded-lg text-left transition-colors
                                                hover:bg-gray-100 dark:hover:bg-white/[0.06]`}
                                        >
                                            <span className={`min-w-0 truncate text-[13px] ${selected
                                                ? 'font-semibold text-gray-900 dark:text-white'
                                                : 'font-medium text-gray-700 dark:text-gray-200'}`}
                                            >
                                                {row.short || row.label || row.value}
                                            </span>
                                            <span className="flex-1" />
                                            {selected && <Tick02Icon size={13} strokeWidth={2.5} className="shrink-0 text-gray-900 dark:text-white" />}
                                        </button>
                                    );
                                })}
                            </div>
                        );
                    })}
                    {Object.values(catalogs).every(rows => rows.length === 0) && (
                        <div className="py-2">
                            <p className="text-[13px] text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.modelsEmpty')}
                            </p>
                            <Button
                                size="sm"
                                variant="secondary"
                                icon={<Refresh01Icon size={13} strokeWidth={2} />}
                                onClick={() => load(true)}
                                className="mt-3"
                            >
                                {t('settings.assistant.modelsRetry')}
                            </Button>
                        </div>
                    )}
                </>
            )}
        </Dialog>
    );
}

/** The approval modes, as the composer's menu names them. */
const MODES = [
    { value: 'always', labelKey: 'assistant.approvalAlways' },
    { value: 'writes', labelKey: 'assistant.approvalWrites' },
    { value: 'never', labelKey: 'assistant.approvalNever' },
    { value: 'full', labelKey: 'assistant.approvalFull' },
];

/**
 * What this agent's new chats start on, when a model is starred: the model,
 * the effort and the mode. Set by the star in a chat's model menu, which
 * takes all three as they are in that chat; here each can be changed on its
 * own, or the star taken off. An effort or mode left on "Last used" is the
 * one last picked in any tab, as without a star (see main's start-model.js).
 */
function StarredRow({ activated, settings, onSettings, onChoose }) {
    const t = useT();
    const starred = settings.starred || null;
    const provider = starred?.provider || '';
    const model = starred?.model || '';
    // The starred model's row, for its name and the efforts it takes. One
    // runtime's list, which main holds once it has been read.
    const [row, setRow] = useState(null);
    useEffect(() => {
        setRow(null);
        if (!provider || !model) return undefined;
        let live = true;
        window.api.ai.models({ provider })
            .then((rows) => {
                if (live) setRow((Array.isArray(rows) ? rows : []).find(entry => entry?.value === model) || null);
            })
            .catch(() => {});
        return () => { live = false; };
    }, [provider, model]);

    const patch = (fields) => {
        const next = { ...starred, ...fields };
        for (const key of Object.keys(fields)) if (!next[key]) delete next[key];
        onSettings({ starred: next });
    };
    const off = Boolean(starred) && !activated.includes(provider);
    const lastUsed = { value: '', label: t('settings.assistant.starredLastUsed') };
    // The model's own scale, and the saved level even where it is not on it
    // (the runtime rounds that down), so the field never shows blank.
    const stops = effortStops(row);
    const efforts = starred?.effort && !stops.some(stop => stop.value === starred.effort)
        ? EFFORTS.filter(stop => stop.value === starred.effort || stops.includes(stop))
        : stops;

    return (
        <SettingRow
            className={DIVIDED}
            title={t('settings.assistant.starred')}
            description={t('settings.assistant.starredDesc')}
            control={
                <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate max-w-[12rem] text-[13px] text-gray-500 dark:text-gray-400">
                        {starred
                            ? `${PROVIDER_NAMES[provider] || provider} · ${row?.short || row?.label || model}`
                            : t('settings.assistant.starredNone')}
                    </span>
                    <Button size="sm" variant="secondary" onClick={onChoose}>
                        {starred ? t('settings.assistant.defaultModelChange') : t('settings.assistant.starredChoose')}
                    </Button>
                    {starred && (
                        <Button size="sm" variant="ghost" onClick={() => onSettings({ starred: null })}>
                            {t('settings.assistant.starredClear')}
                        </Button>
                    )}
                </div>
            }
        >
            {starred && (
                <>
                    <div className="flex gap-3">
                        <label className="flex-1 min-w-0">
                            <span className="block mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.starredEffort')}
                            </span>
                            <Select
                                value={starred.effort || ''}
                                onChange={value => patch({ effort: value })}
                                className={FIELD_CLASS}
                                aria-label={t('settings.assistant.starredEffort')}
                                options={[lastUsed, ...efforts.map(stop => ({ value: stop.value, label: effortLabel(stop) }))]}
                            />
                        </label>
                        <label className="flex-1 min-w-0">
                            <span className="block mb-1.5 text-xs font-medium text-gray-500 dark:text-gray-400">
                                {t('settings.assistant.starredMode')}
                            </span>
                            <Select
                                value={starred.approval || ''}
                                onChange={value => patch({ approval: value })}
                                className={FIELD_CLASS}
                                aria-label={t('settings.assistant.starredMode')}
                                options={[lastUsed, ...MODES.map(mode => ({ value: mode.value, label: t(mode.labelKey) }))]}
                            />
                        </label>
                    </div>
                    {off && (
                        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                            {t('settings.assistant.starredOff', { agent: PROVIDER_NAMES[provider] || provider })}
                        </p>
                    )}
                </>
            )}
        </SettingRow>
    );
}

export default function ModelsCard({ settings, onSettings }) {
    const t = useT();
    const [open, setOpen] = useState(null);
    const [defaultOpen, setDefaultOpen] = useState(false);
    const [starOpen, setStarOpen] = useState(false);
    // Totals each dialog reports once its runtime has answered, so the rows
    // can say "3 of 12 shown". Unknown until opened: reading every runtime
    // just to render this card would start them all.
    const [totals, setTotals] = useState({});
    const onKnown = useCallback((provider, total) => {
        setTotals(held => (held[provider] === total ? held : { ...held, [provider]: total }));
    }, []);

    const activated = PROVIDER_ORDER.filter(name => (settings.providers || []).includes(name));
    if (activated.length === 0) return null;

    return (
        <>
            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.defaultModel')}
                    description={t('settings.assistant.defaultModelDesc')}
                    control={
                        <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate max-w-[12rem] text-[13px] text-gray-500 dark:text-gray-400">
                                {settings.model
                                    ? `${PROVIDER_NAMES[settings.provider] || settings.provider} · ${settings.model}`
                                    : t('settings.assistant.defaultModelAgent')}
                            </span>
                            <Button size="sm" variant="secondary" onClick={() => setDefaultOpen(true)}>
                                {t('settings.assistant.defaultModelChange')}
                            </Button>
                        </div>
                    }
                />
                <StarredRow
                    activated={activated}
                    settings={settings}
                    onSettings={onSettings}
                    onChoose={() => setStarOpen(true)}
                />
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.models')}
                    description={t('settings.assistant.modelsDesc')}
                >
                    <ul className="space-y-1">
                        {activated.map(provider => {
                            const hidden = settings.hiddenModels?.[provider] || [];
                            return (
                                <li
                                    key={provider}
                                    className="flex items-center gap-2.5 rounded-xl px-2 py-1.5
                                        hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors"
                                >
                                    <span className="shrink-0 leading-none">
                                        <ProviderMark provider={provider} size={18} />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium
                                        text-gray-900 dark:text-gray-100"
                                    >
                                        {PROVIDER_NAMES[provider]}
                                    </span>
                                    <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500 tabular-nums">
                                        {summary(t, totals[provider] ?? null, hidden.length)}
                                    </span>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => setOpen(provider)}
                                    >
                                        {t('settings.assistant.modelsChoose')}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                </SettingRow>
                <AgentUpdatesRow className={DIVIDED} activated={activated} />
            </SettingCard>

            {/* The agent's own default: its jobs, and new chats before
                anything has been used or starred. Writes the agent's
                `provider` and `model`, which the composer's chip never moves. */}
            {defaultOpen && (
                <ModelPickDialog
                    activated={activated}
                    title={t('settings.assistant.defaultModelTitle')}
                    subtitle={t('settings.assistant.defaultModelSubtitle')}
                    current={settings.model ? `${settings.provider}:${settings.model}` : ''}
                    noneLabel={t('settings.assistant.defaultModelAgent')}
                    onChoose={(provider, model) => onSettings({ provider: provider || settings.provider, model })}
                    onClose={() => setDefaultOpen(false)}
                />
            )}

            {/* The star, picked here rather than in a chat: a new model keeps
                the effort and mode already starred. This list names no
                accounts, so moving to another model drops the star's one. */}
            {starOpen && (
                <ModelPickDialog
                    activated={activated}
                    title={t('settings.assistant.starredTitle')}
                    subtitle={t('settings.assistant.starredSubtitle')}
                    current={settings.starred ? `${settings.starred.provider}:${settings.starred.model}` : ''}
                    onChoose={(provider, model) => {
                        const held = settings.starred || {};
                        const same = held.provider === provider && held.model === model;
                        const next = { ...held, provider, model };
                        if (!same) delete next.account;
                        onSettings({ starred: next });
                    }}
                    onClose={() => setStarOpen(false)}
                />
            )}

            {open && (
                <ModelsDialog
                    provider={open}
                    settings={settings}
                    onSettings={onSettings}
                    onKnown={onKnown}
                    onClose={() => setOpen(null)}
                />
            )}
        </>
    );
}
