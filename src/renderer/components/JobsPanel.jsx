import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowDown01Icon, Copy01Icon, Delete02Icon, LibraryIcon, MoreVerticalIcon, PencilEdit02Icon, PlayIcon, PlusSignIcon,
} from 'hugeicons-react';
import Button, { IconButton } from './ui/Button';
import ConfirmDialog from './ui/ConfirmDialog';
import MenuButton from './ui/MenuButton';
import SearchField from './ui/SearchField';
import Select from './ui/Select';
import { FIELD_CLASS } from './ui/Field';
import IconTile from './hosts/IconTile';
import Toggle from './settings/ui/Toggle';
import JobDialog from './jobs/JobDialog';
import JobLibrary, { TemplateCard } from './jobs/JobLibrary';
import { CARD_GRID } from '../lib/layout';
import { CHIP, CHIP_OFF, CHIP_ON, KIND_ICON, LIVE_STATUSES, STATUS_DOT, duration, moment, when } from './jobs/schedule';
import { useT } from '../i18n';

/**
 * Jobs: the agent's work on a schedule.
 *
 * A job is a prompt, a schedule and a policy for the run it starts with
 * nobody watching. The page leads with how the whole set is doing (what is
 * on, what fires next, how the last week went, what needs a look), then the
 * jobs themselves, searchable and sortable, each with its recent runs drawn
 * as a row of dots. Opening a job shows its brief, its settings and those
 * runs, with the report each one wrote and a way into its conversation.
 *
 * New work comes from two places: the editor, for a job written from
 * scratch, and the library, for the ones most people want (the morning
 * issues digest, the disk check, the certificate expiry report).
 */

const FILTERS = ['all', 'active', 'paused', 'attention'];
const SORTS = ['next', 'name', 'last', 'updated'];
const HISTORY = 12;
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** A job needs a look when it keeps failing, or its last run did. */
const needsAttention = (job) => job.failures > 0 || job.lastStatus === 'failed' || (!job.enabled && job.failures >= 10);

function sortJobs(list, sort) {
    const sorted = [...list];
    switch (sort) {
        case 'name': return sorted.sort((a, b) => a.name.localeCompare(b.name));
        case 'last': return sorted.sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
        case 'updated': return sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        default:
            // What fires soonest first; switched-off and waiting jobs after.
            return sorted.sort((a, b) => {
                const left = a.enabled && a.nextRunAt ? a.nextRunAt : Infinity;
                const right = b.enabled && b.nextRunAt ? b.nextRunAt : Infinity;
                if (left !== right) return left - right;
                if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
    }
}

function Stat({ label, value, note, tone = '' }) {
    return (
        <div className="min-w-0 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-surface-raised px-3 py-2.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">{label}</p>
            <p className={`mt-0.5 text-lg leading-tight font-semibold tabular-nums truncate ${tone || 'text-gray-900 dark:text-white'}`}>{value}</p>
            {note && <p className="text-[11px] text-gray-500 dark:text-gray-400 truncate">{note}</p>}
        </div>
    );
}

/** The job's recent runs, oldest on the left, as one dot each. */
function History({ runs, t }) {
    const recent = runs.slice(0, HISTORY).reverse();
    if (recent.length === 0) return null;
    return (
        <span className="hidden md:flex items-center gap-[3px] shrink-0" aria-label={t('jobs.history', { count: recent.length })}>
            {recent.map(run => (
                <span
                    key={run.id}
                    title={`${t(`runs.status.${run.status}`)} · ${moment(run.startedAt || run.updatedAt)}`}
                    className={`w-1.5 h-3.5 rounded-full ${STATUS_DOT[run.status] || STATUS_DOT.done}`}
                />
            ))}
        </span>
    );
}

function Detail({ label, children }) {
    return (
        <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">{label}</dt>
            <dd className="mt-0.5 text-xs text-gray-700 dark:text-gray-300 break-words">{children}</dd>
        </div>
    );
}

function RunLine({ run, onOpenConversation, t }) {
    const summary = run.result?.summary || run.result?.reason || run.progress || '';
    return (
        <div className="rounded-lg bg-gray-50 dark:bg-white/[0.035] px-2.5 py-2">
            <div className="flex items-center gap-2 text-[11px]">
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[run.status] || STATUS_DOT.done}`} />
                <span className="font-medium text-gray-700 dark:text-gray-300">{t(`runs.status.${run.status}`)}</span>
                <span className="text-gray-500 tabular-nums">{moment(run.startedAt || run.updatedAt)}</span>
                {run.trigger?.source && run.trigger.source !== 'schedule' && (
                    <span className="text-gray-400">
                        {t(`jobs.trigger.${run.trigger.source.startsWith('event:') ? 'event' : run.trigger.source}`)}
                    </span>
                )}
                <span className="ml-auto flex items-center gap-3 text-gray-500 tabular-nums">
                    {duration(run) && <span>{duration(run)}</span>}
                    {run.toolCalls > 0 && <span>{t('runs.calls', { count: run.toolCalls })}</span>}
                    {run.costUsd > 0 && <span>${run.costUsd.toFixed(3)}</span>}
                    {run.conversationId && onOpenConversation && (
                        <button
                            type="button"
                            onClick={() => onOpenConversation(run.conversationId)}
                            className="font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white"
                        >
                            {t('jobs.openRun')}
                        </button>
                    )}
                </span>
            </div>
            {summary && (
                <p className="mt-1 text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words line-clamp-4">{summary}</p>
            )}
        </div>
    );
}

function JobRow({ job, runs, expanded, onExpand, onEdit, onToggle, onRun, onDuplicate, onRemove, onCopyToken, onOpenConversation, t }) {
    const Icon = KIND_ICON[job.schedule?.kind] || KIND_ICON.every;
    const live = runs.some(run => LIVE_STATUSES.has(run.status));
    const attention = needsAttention(job);
    const budget = job.policy?.budget || {};
    const limits = [
        budget.maxToolCalls && t('jobs.summary.calls', { count: budget.maxToolCalls }),
        budget.maxCostUsd && `$${budget.maxCostUsd}`,
        budget.maxMinutes && t('jobs.summary.minutes', { count: budget.maxMinutes }),
    ].filter(Boolean).join(' · ');
    const delivery = [
        job.delivery?.notify !== false && t('jobs.summary.notify'),
        job.delivery?.webhook,
        job.delivery?.file,
    ].filter(Boolean).join(' · ');

    const menu = [
        { label: t('jobs.duplicate'), icon: <Copy01Icon size={14} strokeWidth={2} />, onSelect: () => onDuplicate(job) },
        ...(job.webhookUrl ? [{ label: t('jobs.copyCurl'), icon: <Copy01Icon size={14} strokeWidth={2} />, onSelect: () => onCopyToken(job) }] : []),
        { separator: true },
        { label: t('common.delete'), icon: <Delete02Icon size={14} strokeWidth={2} />, danger: true, onSelect: () => onRemove(job) },
    ];

    return (
        <div
            className={`rounded-xl border bg-white dark:bg-surface-raised overflow-hidden transition-colors
                ${attention ? 'border-amber-300/70 dark:border-amber-500/30' : 'border-gray-200 dark:border-neutral-800'}`}
        >
            <div className="px-3 py-2.5 flex items-center gap-3">
                <Toggle checked={job.enabled} onChange={value => onToggle(job, value)} ariaLabel={t('jobs.toggle', { name: job.name })} />
                <button
                    type="button"
                    onClick={onExpand}
                    aria-expanded={expanded}
                    className="min-w-0 flex-1 flex items-center gap-3 text-left outline-none rounded-lg
                        focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
                >
                    <IconTile size="sm">
                        <Icon size={16} strokeWidth={1.5} className={job.enabled ? 'text-gray-600 dark:text-gray-300' : 'text-gray-400 dark:text-neutral-600'} />
                        {live && (
                            <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse ring-2 ring-white dark:ring-surface-raised" />
                        )}
                    </IconTile>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                            <span className={`truncate text-sm font-medium ${job.enabled ? 'text-gray-900 dark:text-white' : 'text-gray-500 dark:text-gray-400'}`}>
                                {job.name}
                            </span>
                            {job.createdBy === 'agent' && (
                                <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400">{t('jobs.byAgent')}</span>
                            )}
                            {job.policy?.approvals && job.policy.approvals !== 'park' && (
                                <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider
                                    bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                                    {t(`jobs.approvals.${job.policy.approvals}`)}
                                </span>
                            )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
                            <span className="first-letter:uppercase">{job.scheduleText}</span>
                            {live && <span className="text-blue-600 dark:text-blue-400">{t('jobs.runningNow')}</span>}
                            {!live && job.enabled && job.nextRunAt && <span>{t('jobs.next', { when: when(job.nextRunAt) })}</span>}
                            {!job.enabled && <span>{t('jobs.paused')}</span>}
                            {job.lastStatus && job.lastRunAt && !live && (
                                <span className={job.lastStatus === 'failed' ? 'text-red-600 dark:text-red-400' : ''}>
                                    {t('jobs.last', { status: t(`jobs.status.${job.lastStatus}`), when: when(job.lastRunAt) })}
                                </span>
                            )}
                            {job.failures > 0 && <span className="text-amber-600 dark:text-amber-400">{t('jobs.failures', { count: job.failures })}</span>}
                        </div>
                    </div>
                    <History runs={runs} t={t} />
                    <ArrowDown01Icon size={14} strokeWidth={2} className={`shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
                <div className="flex items-center gap-0.5 shrink-0">
                    <IconButton title={t('jobs.runNow')} icon={<PlayIcon size={15} strokeWidth={2} />} onClick={() => onRun(job)} disabled={live} />
                    <IconButton title={t('common.edit')} icon={<PencilEdit02Icon size={15} strokeWidth={2} />} onClick={() => onEdit(job)} />
                    <MenuButton icon={<MoreVerticalIcon size={15} strokeWidth={2} />} title={t('jobs.more')} items={menu} />
                </div>
            </div>

            {expanded && (
                <div className="px-3 pb-3 pt-3 border-t border-gray-100 dark:border-neutral-800 flex flex-col gap-3">
                    {job.prompt && (
                        <p className="text-xs leading-relaxed text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words line-clamp-6">
                            {job.prompt}
                        </p>
                    )}
                    {job.schedule?.kind === 'heartbeat' && job.schedule.probe?.command && (
                        <p className="text-[11px] font-jetbrains break-all text-gray-600 dark:text-gray-300">
                            {t('jobs.library.probe', { command: job.schedule.probe.command })}
                        </p>
                    )}
                    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2.5">
                        <Detail label={t('jobs.detail.schedule')}>
                            <span className="first-letter:uppercase block">{job.scheduleText}</span>
                            {job.enabled && job.nextRunAt && <span className="text-gray-500 tabular-nums">{moment(job.nextRunAt)}</span>}
                        </Detail>
                        <Detail label={t('jobs.approvals')}>{t(`jobs.approvals.${job.policy?.approvals || 'park'}`)}</Detail>
                        <Detail label={t('jobs.detail.limits')}>{limits || t('jobs.detail.none')}</Detail>
                        <Detail label={t('jobs.detail.delivery')}>{delivery || t('jobs.summary.silent')}</Detail>
                        <Detail label={t('jobs.detail.runsOn')}>
                            {job.model ? [job.provider, job.model, job.effort].filter(Boolean).join(' · ') : t('jobs.detail.agentDefault')}
                        </Detail>
                        <Detail label={t('jobs.detail.missed')}>{t(`jobs.missed.${job.missed || 'skip'}`)}</Detail>
                        <Detail label={t('jobs.detail.runs')}>{t('jobs.detail.runCount', { count: job.runCount || 0 })}</Detail>
                        <Detail label={t('jobs.detail.created')}>
                            {job.createdBy === 'agent' ? t('jobs.detail.byAgent', { when: moment(job.createdAt) }) : moment(job.createdAt)}
                        </Detail>
                    </dl>
                    {job.webhookUrl && (
                        <button type="button" onClick={() => onCopyToken(job)} className="self-start flex items-center gap-1.5 text-[11px] font-jetbrains text-gray-500 hover:text-gray-900 dark:hover:text-white break-all text-left">
                            <Copy01Icon size={12} strokeWidth={2} className="shrink-0" /> POST {job.webhookUrl}
                        </button>
                    )}
                    <div className="flex flex-col gap-1.5">
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
                            {t('jobs.recentRuns')}
                        </h4>
                        {runs.length === 0 ? (
                            <p className="text-xs text-gray-400">{t('jobs.noRuns')}</p>
                        ) : (
                            runs.slice(0, 5).map(run => (
                                <RunLine key={run.id} run={run} onOpenConversation={onOpenConversation} t={t} />
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

function JobsPanel({ agentId = '', hosts = [], reachedForPage = 0, onOpenConversation }) {
    const t = useT();
    const [jobs, setJobs] = useState([]);
    const [runs, setRuns] = useState([]);
    const [featured, setFeatured] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null); // null | { job } | { seed }
    const [library, setLibrary] = useState(null); // null | { initial }
    const [confirming, setConfirming] = useState(null);
    const [expanded, setExpanded] = useState(() => new Set());
    const [notice, setNotice] = useState('');
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('all');
    const [sort, setSort] = useState('next');
    const [, setClock] = useState(0);

    const load = useCallback(async () => {
        if (!window.api?.jobs) {
            setLoading(false);
            return;
        }
        try {
            const [list, history] = await Promise.all([
                window.api.jobs.list({ agentId }),
                window.api.runs?.list?.({ agentId, jobs: true, limit: 500 }) ?? [],
            ]);
            setJobs(list || []);
            setRuns(history || []);
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    // Runs change on every step; the page is redrawn at most twice a second.
    const pending = useRef(null);
    const loadSoon = useCallback(() => {
        if (pending.current) return;
        pending.current = setTimeout(() => {
            pending.current = null;
            load();
        }, 500);
    }, [load]);

    useEffect(() => {
        load();
        const offJobs = window.api.jobs?.onChange?.(() => loadSoon());
        const offRuns = window.api.runs?.onChange?.(() => loadSoon());
        return () => {
            offJobs?.();
            offRuns?.();
            clearTimeout(pending.current);
            pending.current = null;
        };
    }, [load, loadSoon]);

    // "in 12m" has to keep counting down while the page is open.
    useEffect(() => {
        const timer = setInterval(() => setClock(value => value + 1), 30000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        window.api.jobs?.templates?.({})
            .then(list => setFeatured((list || []).filter(template => ['github-open-issues', 'disk-space', 'tls-certificates', 'website-down', 'morning-briefing', 'github-failed-workflows'].includes(template.id))))
            .catch(() => {});
    }, []);

    useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(''), 6000);
        return () => clearTimeout(timer);
    }, [notice]);

    const runsByJob = useMemo(() => {
        const grouped = new Map();
        for (const run of runs) {
            if (!grouped.has(run.jobId)) grouped.set(run.jobId, []);
            grouped.get(run.jobId).push(run);
        }
        for (const list of grouped.values()) list.sort((a, b) => (b.startedAt || b.createdAt || 0) - (a.startedAt || a.createdAt || 0));
        return grouped;
    }, [runs]);

    const stats = useMemo(() => {
        const since = Date.now() - WEEK;
        const week = runs.filter(run => (run.startedAt || run.createdAt || 0) >= since && !LIVE_STATUSES.has(run.status));
        const ok = week.filter(run => run.status === 'done').length;
        const cost = week.reduce((sum, run) => sum + (run.costUsd || 0), 0);
        const upcoming = jobs.filter(job => job.enabled && job.nextRunAt).sort((a, b) => a.nextRunAt - b.nextRunAt)[0] || null;
        return {
            active: jobs.filter(job => job.enabled).length,
            paused: jobs.filter(job => !job.enabled).length,
            attention: jobs.filter(needsAttention).length,
            week: week.length,
            rate: week.length ? Math.round((ok / week.length) * 100) : null,
            cost,
            upcoming,
        };
    }, [jobs, runs]);

    const shown = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = jobs.filter((job) => {
            if (filter === 'active' && !job.enabled) return false;
            if (filter === 'paused' && job.enabled) return false;
            if (filter === 'attention' && !needsAttention(job)) return false;
            if (!needle) return true;
            return [job.name, job.prompt, job.scheduleText, job.model].some(text => String(text || '').toLowerCase().includes(needle));
        });
        return sortJobs(filtered, sort);
    }, [jobs, query, filter, sort]);

    const toggle = useCallback(async (job, enabled) => {
        const result = await window.api.jobs.update(job.id, { enabled });
        if (result?.error) setNotice(result.error);
        load();
    }, [load]);

    const runNow = useCallback(async (job) => {
        const result = await window.api.jobs.runNow(job.id);
        setNotice(result?.error ? result.error : (result?.skipped ? t('jobs.skipped') : t('jobs.started', { name: job.name })));
        setExpanded(current => new Set(current).add(job.id));
        load();
    }, [load, t]);

    const duplicate = useCallback(async (job) => {
        const { id, token, webhookUrl, scheduleText, lastRunAt, lastStatus, nextRunAt, failures, runCount, createdAt, updatedAt, createdBy, ...rest } = job;
        // A copy starts switched off, so it never fires twice alongside the original.
        const result = await window.api.jobs.create({ ...rest, name: t('jobs.copyName', { name: job.name }).slice(0, 120), enabled: false });
        setNotice(result?.error ? result.error : t('jobs.duplicated', { name: job.name }));
        load();
    }, [load, t]);

    const remove = useCallback((job) => {
        setConfirming({
            title: t('jobs.deleteTitle'),
            message: t('jobs.deleteMessage', { name: job.name }),
            confirmLabel: t('common.delete'),
            onConfirm: async () => {
                setConfirming(null);
                await window.api.jobs.remove(job.id);
                load();
            },
        });
    }, [load, t]);

    const copyToken = useCallback(async (job) => {
        const token = await window.api.jobs.token(job.id);
        const example = `curl -X POST ${job.webhookUrl} -H "Authorization: Bearer ${token}" -H "Content-Type: text/plain" --data "what happened"`;
        try {
            await navigator.clipboard.writeText(example);
            setNotice(t('jobs.copied'));
        } catch {
            setNotice(example);
        }
    }, [t]);

    const toggleExpanded = useCallback((jobId) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(jobId)) next.delete(jobId);
            else next.add(jobId);
            return next;
        });
    }, []);

    const mine = useMemo(() => hosts.filter(host => !host.agentId || host.agentId === agentId), [hosts, agentId]);

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex flex-wrap items-center gap-3 mb-4 shrink-0">
                <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('jobs.title')}</h2>
                    <p className="text-xs text-gray-500 min-h-4" aria-live="polite">{notice || t('jobs.hint')}</p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="secondary" icon={<PlusSignIcon size={16} strokeWidth={2.5} />} onClick={() => setEditing({})}>
                        {t('jobs.new')}
                    </Button>
                    <Button variant="primary" icon={<LibraryIcon size={16} strokeWidth={2} />} onClick={() => setLibrary({ initial: null })}>
                        {t('jobs.library.open')}
                    </Button>
                </div>
            </div>

            {!loading && jobs.length === 0 ? (
                <div className="flex-1 min-h-0 overflow-y-auto -mx-2 px-2 pb-1 flex flex-col gap-5">
                    <div className="rounded-2xl border border-dashed border-gray-300 dark:border-white/[0.12] px-6 py-8 text-center">
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('jobs.emptyTitle')}</h3>
                        <p className="mt-1 mx-auto max-w-md text-[13px] text-gray-500 dark:text-gray-400">{t('jobs.emptyNote')}</p>
                    </div>
                    {featured.length > 0 && (
                        <section className="flex flex-col gap-2.5">
                            <div className="flex items-center gap-2">
                                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">{t('jobs.startWith')}</h3>
                                <button
                                    type="button"
                                    onClick={() => setLibrary({ initial: null })}
                                    className="ml-auto text-xs font-medium text-gray-500 hover:text-gray-900 dark:hover:text-white"
                                >
                                    {t('jobs.library.seeAll')}
                                </button>
                            </div>
                            <div className={CARD_GRID}>
                                {featured.map(template => (
                                    <TemplateCard key={template.id} template={template} added={false} onPick={(picked) => setLibrary({ initial: picked })} t={t} />
                                ))}
                            </div>
                        </section>
                    )}
                </div>
            ) : (
                <>
                    {jobs.length > 0 && (
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3 shrink-0">
                            <Stat
                                label={t('jobs.stats.active')}
                                value={stats.active}
                                note={stats.paused ? t('jobs.stats.paused', { count: stats.paused }) : t('jobs.stats.nonePaused')}
                            />
                            <Stat
                                label={t('jobs.stats.next')}
                                value={stats.upcoming ? when(stats.upcoming.nextRunAt) : '—'}
                                note={stats.upcoming ? stats.upcoming.name : t('jobs.stats.nothingScheduled')}
                            />
                            <Stat
                                label={t('jobs.stats.week')}
                                value={stats.rate === null ? '—' : `${stats.rate}%`}
                                note={t('jobs.stats.weekNote', { count: stats.week, cost: stats.cost.toFixed(2) })}
                                tone={stats.rate !== null && stats.rate < 80 ? 'text-amber-600 dark:text-amber-400' : ''}
                            />
                            <Stat
                                label={t('jobs.stats.attention')}
                                value={stats.attention}
                                note={stats.attention ? t('jobs.stats.attentionNote') : t('jobs.stats.allWell')}
                                tone={stats.attention ? 'text-amber-600 dark:text-amber-400' : ''}
                            />
                        </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 mb-3 shrink-0">
                        <SearchField value={query} onChange={setQuery} ariaLabel={t('jobs.search')} placeholder={t('jobs.searchPlaceholder')} />
                        <div className="flex gap-1.5">
                            {FILTERS.map(id => (
                                <button
                                    key={id}
                                    type="button"
                                    aria-pressed={filter === id}
                                    onClick={() => setFilter(id)}
                                    className={`${CHIP} ${filter === id ? CHIP_ON : CHIP_OFF}`}
                                >
                                    {t(`jobs.filter.${id}`)}
                                    {id === 'attention' && stats.attention > 0 && ` · ${stats.attention}`}
                                </button>
                            ))}
                        </div>
                        <div className="w-44">
                            <Select
                                value={sort}
                                onChange={setSort}
                                className={`${FIELD_CLASS} !py-1.5 text-xs`}
                                aria-label={t('jobs.sort')}
                                options={SORTS.map(id => ({ value: id, label: t(`jobs.sort.${id}`) }))}
                            />
                        </div>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto space-y-2 -mx-2 px-2 pb-1">
                        {shown.map(job => (
                            <JobRow
                                key={job.id}
                                job={job}
                                runs={runsByJob.get(job.id) || []}
                                expanded={expanded.has(job.id)}
                                onExpand={() => toggleExpanded(job.id)}
                                t={t}
                                onEdit={(entry) => setEditing({ job: entry })}
                                onToggle={toggle}
                                onRun={runNow}
                                onDuplicate={duplicate}
                                onRemove={remove}
                                onCopyToken={copyToken}
                                onOpenConversation={onOpenConversation}
                            />
                        ))}
                        {!loading && shown.length === 0 && jobs.length > 0 && (
                            <p className="py-10 text-center text-xs text-gray-500 dark:text-gray-400">{t('jobs.noneMatch')}</p>
                        )}
                    </div>
                </>
            )}

            {editing && (
                <JobDialog
                    job={editing.job || null}
                    seed={editing.seed || null}
                    agentId={agentId}
                    hosts={mine}
                    onClose={() => setEditing(null)}
                    onSaved={() => load()}
                />
            )}

            {library && (
                <JobLibrary
                    agentId={agentId}
                    jobs={jobs}
                    hosts={mine}
                    initial={library.initial}
                    dismiss={reachedForPage}
                    onClose={() => setLibrary(null)}
                    onAdded={(job) => {
                        setNotice(t('jobs.added', { name: job?.name || '' }));
                        load();
                    }}
                    onCustomise={(seed) => {
                        setLibrary(null);
                        setEditing({ seed });
                    }}
                />
            )}

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </div>
    );
}

export default memo(JobsPanel);
