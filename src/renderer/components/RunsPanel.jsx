import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown01Icon, RefreshIcon, StopCircleIcon, Delete02Icon, TimelineIcon } from 'hugeicons-react';
import EmptyFrame from './ui/EmptyFrame';
import Button, { IconButton } from './ui/Button';
import { useT } from '../i18n';

/**
 * The runs: every unit of work the agent has done or is doing, newest first.
 *
 * A run is one turn a person sent, or (later) one firing of a scheduled job.
 * The page reads the log the main process keeps and cannot add to it; what
 * it can do is stop a run that is going and throw away one that is over.
 * Opening a row shows its steps: the turn, each tool call with what went in
 * and what came back, and the ones whose outcome was lost to a restart.
 */

const STATUS_DOT = {
    queued: 'bg-gray-400',
    running: 'bg-blue-500 animate-pulse',
    parked: 'bg-amber-500',
    done: 'bg-emerald-500',
    failed: 'bg-red-500',
    cancelled: 'bg-gray-400 dark:bg-gray-600',
};

const STEP_DOT = {
    pending: 'bg-blue-500 animate-pulse',
    complete: 'bg-emerald-500',
    failed: 'bg-red-500',
    interrupted: 'bg-gray-400',
    unknown: 'bg-amber-500',
};

const PAGE = 100;

function when(stamp) {
    if (!stamp) return '';
    const date = new Date(stamp);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function duration(run) {
    if (!run.startedAt) return '';
    const end = run.endedAt || Date.now();
    const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function Step({ step }) {
    const [open, setOpen] = useState(step.status === 'unknown' || step.status === 'failed');
    const expandable = Boolean(step.input || step.output);
    return (
        <div className="rounded-lg bg-gray-50 dark:bg-white/[0.035] overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(value => !value)}
                disabled={!expandable}
                className="w-full h-8 px-2.5 flex items-center gap-2 text-left select-none
                    hover:bg-gray-100 dark:hover:bg-white/[0.06] disabled:hover:bg-transparent disabled:cursor-default"
            >
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${STEP_DOT[step.status] || STEP_DOT.complete}`} />
                <span className="text-[11px] font-medium text-gray-600 dark:text-gray-400 shrink-0">
                    {step.kind === 'tool' ? step.name.replace(/_/g, ' ') : step.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-jetbrains text-gray-500">
                    {step.input}
                </span>
                <span className="text-[11px] text-gray-400 shrink-0">{step.status}</span>
                {expandable && (
                    <ArrowDown01Icon size={13} strokeWidth={2} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
                )}
            </button>
            {open && expandable && (
                <div className="px-2.5 pb-2 space-y-1.5">
                    {step.input && (
                        <pre className="max-h-40 overflow-auto rounded-md bg-white dark:bg-black/30 px-2 py-1.5 text-[11px] font-jetbrains whitespace-pre-wrap break-words text-gray-800 dark:text-gray-200">{step.input}</pre>
                    )}
                    {step.output && (
                        <pre className="max-h-60 overflow-auto rounded-md bg-white dark:bg-black/30 px-2 py-1.5 text-[11px] font-jetbrains whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{step.output}</pre>
                    )}
                </div>
            )}
        </div>
    );
}

function RunRow({ run, onCancel, onRemove, t }) {
    const [open, setOpen] = useState(false);
    const [detail, setDetail] = useState(null);

    useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        const read = () => window.api.runs.get(run.id).then(found => { if (!cancelled) setDetail(found); }).catch(() => {});
        read();
        const off = window.api.runs.onChange?.((change) => {
            if (!change || change.runId === run.id || change.recovered) read();
        });
        return () => { cancelled = true; off?.(); };
    }, [open, run.id, run.updatedAt]);

    const live = run.status === 'running' || run.status === 'queued' || run.status === 'parked';
    const reason = run.result?.reason || '';

    return (
        <div className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-surface-raised overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(value => !value)}
                className="w-full px-3 h-11 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-white/[0.03]"
            >
                <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[run.status] || STATUS_DOT.done}`} />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-white">
                    {run.title || t('runs.untitled')}
                </span>
                <span className="hidden sm:inline text-xs text-gray-500 shrink-0">{t(`runs.kind.${run.kind}`)}</span>
                <span className="text-xs text-gray-500 shrink-0 tabular-nums">{duration(run)}</span>
                <span className="text-xs text-gray-500 shrink-0 tabular-nums">
                    {run.toolCalls ? t('runs.calls', { count: run.toolCalls }) : ''}
                </span>
                {run.costUsd > 0 && (
                    <span className="text-xs text-gray-500 shrink-0 tabular-nums">${run.costUsd.toFixed(3)}</span>
                )}
                <span className="text-xs text-gray-400 shrink-0 tabular-nums">{when(run.updatedAt)}</span>
                <ArrowDown01Icon size={14} strokeWidth={2} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div className="px-3 pb-3 space-y-2 border-t border-gray-100 dark:border-neutral-800">
                    <div className="pt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                        <span>{t(`runs.status.${run.status}`)}</span>
                        {run.trigger?.source && <span>{t('runs.trigger', { source: run.trigger.source })}</span>}
                        {reason && <span className="text-amber-600 dark:text-amber-400">{reason}</span>}
                        <span className="ml-auto flex items-center gap-1">
                            {live && (
                                <Button size="sm" variant="ghost" onClick={() => onCancel(run.id)}>
                                    <StopCircleIcon size={14} strokeWidth={2} /> {t('runs.stop')}
                                </Button>
                            )}
                            {!live && (
                                <Button size="sm" variant="ghost" onClick={() => onRemove(run.id)}>
                                    <Delete02Icon size={14} strokeWidth={2} /> {t('common.delete')}
                                </Button>
                            )}
                        </span>
                    </div>
                    {run.progress && (
                        <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap">{run.progress}</p>
                    )}
                    <div className="space-y-1">
                        {(detail?.steps || []).map(step => <Step key={step.seq} step={step} />)}
                        {detail && detail.steps.length === 0 && (
                            <p className="text-xs text-gray-400">{t('runs.noSteps')}</p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function RunsPanel({ agentId = '' }) {
    const t = useT();
    const [runs, setRuns] = useState([]);
    const [usage, setUsage] = useState(null);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');

    const load = useCallback(async () => {
        if (!window.api?.runs) {
            setLoading(false);
            return;
        }
        try {
            const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const [list, totals] = await Promise.all([
                window.api.runs.list({ agentId, limit: PAGE }),
                window.api.runs.usage({ agentId, since }),
            ]);
            setRuns(list || []);
            setUsage(totals);
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        load();
        return window.api.runs?.onChange?.(() => load());
    }, [load]);

    const shown = useMemo(() => {
        if (filter === 'live') return runs.filter(run => ['queued', 'running', 'parked'].includes(run.status));
        if (filter === 'failed') return runs.filter(run => run.status === 'failed');
        return runs;
    }, [runs, filter]);

    const cancel = useCallback(async (runId) => {
        await window.api.runs.cancel(runId);
        load();
    }, [load]);

    const remove = useCallback(async (runId) => {
        await window.api.runs.remove(runId);
        load();
    }, [load]);

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex items-center gap-3 mb-4">
                <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('runs.title')}</h2>
                    {usage && (
                        <p className="text-xs text-gray-500 tabular-nums">
                            {t('runs.summary', { runs: usage.runs, calls: usage.toolCalls, cost: usage.costUsd.toFixed(2), failed: usage.failed })}
                        </p>
                    )}
                </div>
                <div className="ml-auto flex items-center gap-1">
                    {['all', 'live', 'failed'].map(id => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setFilter(id)}
                            className={`px-2.5 h-8 rounded-lg text-xs font-medium transition-colors ${filter === id
                                ? 'bg-gray-900/[0.08] dark:bg-surface-control text-gray-900 dark:text-white'
                                : 'text-gray-500 hover:text-gray-900 dark:hover:text-white'}`}
                        >
                            {t(`runs.filter.${id}`)}
                        </button>
                    ))}
                    <IconButton label={t('common.refresh')} onClick={load}>
                        <RefreshIcon size={16} strokeWidth={2} />
                    </IconButton>
                </div>
            </div>

            {!loading && shown.length === 0 ? (
                <EmptyFrame icon={<TimelineIcon size={28} strokeWidth={1.5} />} title={t('runs.emptyTitle')} note={t('runs.emptyNote')} />
            ) : (
                <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                    {shown.map(run => (
                        <RunRow key={run.id} run={run} onCancel={cancel} onRemove={remove} t={t} />
                    ))}
                </div>
            )}
        </div>
    );
}

export default memo(RunsPanel);
