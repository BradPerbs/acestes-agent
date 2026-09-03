import { memo, useCallback, useEffect, useState } from 'react';
import { PlusSignIcon, PlayIcon, Delete02Icon, PencilEdit02Icon, Copy01Icon, Clock01Icon } from 'hugeicons-react';
import Dialog from './ui/Dialog';
import Button, { IconButton } from './ui/Button';
import Field, { FIELD_CLASS } from './ui/Field';
import Select from './ui/Select';
import EmptyFrame from './ui/EmptyFrame';
import Toggle from './settings/ui/Toggle';
import { useT } from '../i18n';

/**
 * Jobs: the agent's work on a schedule.
 *
 * A job is a prompt, a schedule and a policy for the run it starts with
 * nobody watching. The page lists an agent's jobs with when each fires
 * next and how its last run went, and the dialog makes or edits one. The
 * runs themselves are on the Runs page; a job row links to them by name.
 */

const SCHEDULE_KINDS = ['every', 'cron', 'at', 'heartbeat', 'event', 'webhook'];
const APPROVALS = ['park', 'read-only', 'allowlist', 'full'];
const EVENTS = ['host-offline', 'host-online'];

function when(stamp) {
    if (!stamp) return '';
    const date = new Date(stamp);
    const now = Date.now();
    const delta = stamp - now;
    if (delta > 0 && delta < 86400000) {
        const minutes = Math.round(delta / 60000);
        if (minutes < 60) return `in ${minutes}m`;
        return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const emptyDraft = () => ({
    name: '',
    kind: 'every',
    every: '1h',
    cron: '0 9 * * 1-5',
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    at: '',
    probe: '',
    event: 'host-offline',
    hostId: '',
    prompt: '',
    approvals: 'park',
    tools: '',
    maxToolCalls: '',
    maxCostUsd: '',
    maxMinutes: '',
    notify: true,
    webhook: '',
    file: '',
    missed: 'skip',
    keepAfterRun: false,
});

function draftFrom(job) {
    const draft = emptyDraft();
    if (!job) return draft;
    const schedule = job.schedule || {};
    return {
        ...draft,
        name: job.name,
        kind: schedule.kind || 'every',
        every: schedule.everyMs ? describeEvery(schedule.everyMs) : draft.every,
        cron: schedule.expr || draft.cron,
        tz: schedule.tz || draft.tz,
        at: schedule.at ? new Date(schedule.at).toISOString().slice(0, 16) : '',
        probe: schedule.probe?.command || '',
        event: schedule.event || 'host-offline',
        hostId: schedule.hostId || '',
        prompt: job.prompt || '',
        approvals: job.policy?.approvals || 'park',
        tools: (job.policy?.tools || []).join(', '),
        maxToolCalls: job.policy?.budget?.maxToolCalls || '',
        maxCostUsd: job.policy?.budget?.maxCostUsd || '',
        maxMinutes: job.policy?.budget?.maxMinutes || '',
        notify: job.delivery?.notify !== false,
        webhook: job.delivery?.webhook || '',
        file: job.delivery?.file || '',
        missed: job.missed || 'skip',
        keepAfterRun: Boolean(job.keepAfterRun),
    };
}

function describeEvery(ms) {
    if (ms % 86400000 === 0) return `${ms / 86400000}d`;
    if (ms % 3600000 === 0) return `${ms / 3600000}h`;
    return `${Math.round(ms / 60000)}m`;
}

function specFrom(draft, agentId) {
    let schedule;
    switch (draft.kind) {
        case 'every': schedule = { kind: 'every', every: draft.every }; break;
        case 'cron': schedule = { kind: 'cron', expr: draft.cron, tz: draft.tz }; break;
        case 'at': schedule = { kind: 'at', at: draft.at }; break;
        case 'heartbeat': schedule = { kind: 'heartbeat', every: draft.every, probe: { command: draft.probe } }; break;
        case 'event': schedule = { kind: 'event', event: draft.event, hostId: draft.hostId }; break;
        case 'webhook': schedule = { kind: 'webhook' }; break;
        default: schedule = { kind: 'every', every: draft.every };
    }
    const number = (value) => (value === '' || value === null ? undefined : Number(value));
    return {
        agentId,
        name: draft.name,
        schedule,
        prompt: draft.prompt,
        policy: {
            approvals: draft.approvals,
            tools: draft.tools.split(',').map(entry => entry.trim()).filter(Boolean),
            budget: { maxToolCalls: number(draft.maxToolCalls), maxCostUsd: number(draft.maxCostUsd), maxMinutes: number(draft.maxMinutes) },
        },
        delivery: { notify: draft.notify, webhook: draft.webhook, file: draft.file },
        missed: draft.missed,
        keepAfterRun: draft.keepAfterRun,
    };
}

function JobDialog({ job, agentId, hosts, onClose, onSaved }) {
    const t = useT();
    const [draft, setDraft] = useState(() => draftFrom(job));
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const set = (key, value) => setDraft(current => ({ ...current, [key]: value }));

    const submit = async () => {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
            const spec = specFrom(draft, agentId);
            const result = job
                ? await window.api.jobs.update(job.id, spec)
                : await window.api.jobs.create(spec);
            if (result?.error) {
                setError(result.error);
                return;
            }
            onSaved?.(result.job);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            title={job ? t('jobs.editTitle') : t('jobs.newTitle')}
            subtitle={t('jobs.subtitle')}
            onClose={onClose}
            footer={(
                <>
                    <Button onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" onClick={submit} disabled={saving || !draft.name.trim()}>
                        {job ? t('common.save') : t('jobs.create')}
                    </Button>
                </>
            )}
        >
            <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="flex flex-col gap-4">
                <Field label={t('jobs.name')}>
                    <input autoFocus type="text" value={draft.name} maxLength={120} onChange={e => set('name', e.target.value)} className={FIELD_CLASS} placeholder={t('jobs.namePlaceholder')} />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                    <Field label={t('jobs.kind')}>
                        <Select
                            value={draft.kind}
                            onChange={(next) => set('kind', next)}
                            className={FIELD_CLASS}
                            aria-label={t('jobs.kind')}
                            options={SCHEDULE_KINDS.map(kind => ({ value: kind, label: t(`jobs.kind.${kind}`) }))}
                        />
                    </Field>
                    {(draft.kind === 'every' || draft.kind === 'heartbeat') && (
                        <Field label={t('jobs.every')}>
                            <input type="text" value={draft.every} onChange={e => set('every', e.target.value)} className={FIELD_CLASS} placeholder="30m, 2h, 1d" />
                        </Field>
                    )}
                    {draft.kind === 'cron' && (
                        <Field label={t('jobs.cron')}>
                            <input type="text" value={draft.cron} onChange={e => set('cron', e.target.value)} className={`${FIELD_CLASS} font-jetbrains`} placeholder="0 9 * * 1-5" />
                        </Field>
                    )}
                    {draft.kind === 'at' && (
                        <Field label={t('jobs.at')}>
                            <input type="datetime-local" value={draft.at} onChange={e => set('at', e.target.value)} className={FIELD_CLASS} />
                        </Field>
                    )}
                    {draft.kind === 'event' && (
                        <Field label={t('jobs.event')}>
                            <Select
                                value={draft.event}
                                onChange={(next) => set('event', next)}
                                className={FIELD_CLASS}
                                aria-label={t('jobs.event')}
                                options={EVENTS.map(event => ({ value: event, label: t(`jobs.event.${event}`) }))}
                            />
                        </Field>
                    )}
                </div>
                {draft.kind === 'cron' && (
                    <Field label={t('jobs.timezone')}>
                        <input type="text" value={draft.tz} onChange={e => set('tz', e.target.value)} className={FIELD_CLASS} placeholder="Europe/Rome" />
                    </Field>
                )}
                {draft.kind === 'heartbeat' && (
                    <Field label={t('jobs.probe')} hint={t('jobs.probeHint')}>
                        <input type="text" value={draft.probe} onChange={e => set('probe', e.target.value)} className={`${FIELD_CLASS} font-jetbrains`} placeholder="df -h / | awk 'NR==2 && $5+0 > 90'" />
                    </Field>
                )}
                {draft.kind === 'event' && (
                    <Field label={t('jobs.host')}>
                        <Select
                            value={draft.hostId}
                            onChange={(next) => set('hostId', next)}
                            className={FIELD_CLASS}
                            aria-label={t('jobs.host')}
                            options={[
                                { value: '', label: t('jobs.anyHost') },
                                ...hosts.map(host => ({ value: host.id, label: host.name })),
                            ]}
                        />
                    </Field>
                )}
                {draft.kind === 'webhook' && job?.webhookUrl && (
                    <p className="text-xs text-gray-500 font-jetbrains break-all">POST {job.webhookUrl}</p>
                )}

                <Field label={t('jobs.prompt')} hint={t('jobs.promptHint')}>
                    <textarea rows={5} value={draft.prompt} onChange={e => set('prompt', e.target.value)} className={`${FIELD_CLASS} resize-y`} placeholder={t('jobs.promptPlaceholder')} />
                </Field>

                <div className="grid grid-cols-2 gap-3">
                    <Field label={t('jobs.approvals')} hint={t(`jobs.approvals.${draft.approvals}.note`)}>
                        <Select
                            value={draft.approvals}
                            onChange={(next) => set('approvals', next)}
                            className={FIELD_CLASS}
                            aria-label={t('jobs.approvals')}
                            options={APPROVALS.map(value => ({ value, label: t(`jobs.approvals.${value}`) }))}
                        />
                    </Field>
                    {draft.approvals === 'allowlist' && (
                        <Field label={t('jobs.allowlist')}>
                            <input type="text" value={draft.tools} onChange={e => set('tools', e.target.value)} className={`${FIELD_CLASS} font-jetbrains`} placeholder="systemctl restart nginx, apt update" />
                        </Field>
                    )}
                </div>

                <div className="grid grid-cols-3 gap-3">
                    <Field label={t('jobs.maxCalls')}>
                        <input type="number" min="1" value={draft.maxToolCalls} onChange={e => set('maxToolCalls', e.target.value)} className={FIELD_CLASS} placeholder="∞" />
                    </Field>
                    <Field label={t('jobs.maxCost')}>
                        <input type="number" min="0" step="0.5" value={draft.maxCostUsd} onChange={e => set('maxCostUsd', e.target.value)} className={FIELD_CLASS} placeholder="∞" />
                    </Field>
                    <Field label={t('jobs.maxMinutes')}>
                        <input type="number" min="1" value={draft.maxMinutes} onChange={e => set('maxMinutes', e.target.value)} className={FIELD_CLASS} placeholder="∞" />
                    </Field>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="flex items-center justify-between gap-3 text-sm text-gray-800 dark:text-gray-200">
                        <span>{t('jobs.notify')}</span>
                        <Toggle checked={draft.notify} onChange={value => set('notify', value)} />
                    </label>
                    <Field label={t('jobs.webhookOut')}>
                        <input type="text" value={draft.webhook} onChange={e => set('webhook', e.target.value)} className={FIELD_CLASS} placeholder="https://" />
                    </Field>
                    <Field label={t('jobs.fileOut')}>
                        <input type="text" value={draft.file} onChange={e => set('file', e.target.value)} className={`${FIELD_CLASS} font-jetbrains`} placeholder="C:\\reports\\nightly.md" />
                    </Field>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <Field label={t('jobs.missed')}>
                        <Select
                            value={draft.missed}
                            onChange={(next) => set('missed', next)}
                            className={FIELD_CLASS}
                            aria-label={t('jobs.missed')}
                            options={[
                                { value: 'skip', label: t('jobs.missed.skip') },
                                { value: 'catchup', label: t('jobs.missed.catchup') },
                            ]}
                        />
                    </Field>
                    {draft.kind === 'at' && (
                        <label className="flex items-center justify-between gap-3 text-sm text-gray-800 dark:text-gray-200 pt-6">
                            <span>{t('jobs.keepAfterRun')}</span>
                            <Toggle checked={draft.keepAfterRun} onChange={value => set('keepAfterRun', value)} />
                        </label>
                    )}
                </div>

                {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            </form>
        </Dialog>
    );
}

const STATUS_TONE = {
    done: 'text-emerald-600 dark:text-emerald-400',
    running: 'text-blue-600 dark:text-blue-400',
    failed: 'text-red-600 dark:text-red-400',
    cancelled: 'text-gray-500',
    skipped: 'text-gray-500',
};

function JobRow({ job, onEdit, onToggle, onRun, onRemove, onCopyToken, t }) {
    return (
        <div className="rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-surface-raised px-3 py-2.5 flex items-center gap-3">
            <Toggle checked={job.enabled} onChange={value => onToggle(job, value)} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm font-medium text-gray-900 dark:text-white">{job.name}</span>
                    {job.createdBy === 'agent' && (
                        <span className="text-[10px] uppercase tracking-wide text-gray-400">{t('jobs.byAgent')}</span>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
                    <span className="flex items-center gap-1"><Clock01Icon size={12} strokeWidth={2} /> {job.scheduleText}</span>
                    <span>{t(`jobs.approvals.${job.policy?.approvals || 'park'}`)}</span>
                    {job.enabled && job.nextRunAt && <span>{t('jobs.next', { when: when(job.nextRunAt) })}</span>}
                    {job.lastStatus && (
                        <span className={STATUS_TONE[job.lastStatus] || ''}>
                            {t('jobs.last', { status: job.lastStatus, when: when(job.lastRunAt) })}
                        </span>
                    )}
                    {job.failures > 0 && <span className="text-amber-600 dark:text-amber-400">{t('jobs.failures', { count: job.failures })}</span>}
                    {job.webhookUrl && (
                        <button type="button" onClick={() => onCopyToken(job)} className="flex items-center gap-1 font-jetbrains hover:text-gray-900 dark:hover:text-white">
                            <Copy01Icon size={12} strokeWidth={2} /> {job.webhookUrl}
                        </button>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
                <IconButton label={t('jobs.runNow')} onClick={() => onRun(job)}><PlayIcon size={15} strokeWidth={2} /></IconButton>
                <IconButton label={t('common.edit')} onClick={() => onEdit(job)}><PencilEdit02Icon size={15} strokeWidth={2} /></IconButton>
                <IconButton label={t('common.delete')} onClick={() => onRemove(job)}><Delete02Icon size={15} strokeWidth={2} /></IconButton>
            </div>
        </div>
    );
}

function JobsPanel({ agentId = '', hosts = [] }) {
    const t = useT();
    const [jobs, setJobs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editing, setEditing] = useState(null); // null | { job }
    const [notice, setNotice] = useState('');

    const load = useCallback(async () => {
        if (!window.api?.jobs) {
            setLoading(false);
            return;
        }
        try {
            setJobs((await window.api.jobs.list({ agentId })) || []);
        } finally {
            setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        load();
        return window.api.jobs?.onChange?.(() => load());
    }, [load]);

    const toggle = useCallback(async (job, enabled) => {
        const result = await window.api.jobs.update(job.id, { enabled });
        if (result?.error) setNotice(result.error);
        load();
    }, [load]);

    const runNow = useCallback(async (job) => {
        const result = await window.api.jobs.runNow(job.id);
        setNotice(result?.error ? result.error : (result?.skipped ? t('jobs.skipped') : t('jobs.started', { name: job.name })));
        load();
    }, [load, t]);

    const remove = useCallback(async (job) => {
        await window.api.jobs.remove(job.id);
        load();
    }, [load]);

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

    const mine = hosts.filter(host => !host.agentId || host.agentId === agentId);

    return (
        <div className="flex flex-col h-full min-h-0">
            <div className="flex items-center gap-3 mb-4">
                <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('jobs.title')}</h2>
                    <p className="text-xs text-gray-500">{notice || t('jobs.hint')}</p>
                </div>
                <div className="ml-auto">
                    <Button size="sm" variant="primary" onClick={() => setEditing({ job: null })}>
                        <PlusSignIcon size={14} strokeWidth={2.5} /> {t('jobs.new')}
                    </Button>
                </div>
            </div>

            {!loading && jobs.length === 0 ? (
                <EmptyFrame icon={<Clock01Icon size={28} strokeWidth={1.5} />} title={t('jobs.emptyTitle')} note={t('jobs.emptyNote')}>
                    <Button size="sm" variant="secondary" onClick={() => setEditing({ job: null })}>{t('jobs.new')}</Button>
                </EmptyFrame>
            ) : (
                <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                    {jobs.map(job => (
                        <JobRow
                            key={job.id}
                            job={job}
                            t={t}
                            onEdit={(entry) => setEditing({ job: entry })}
                            onToggle={toggle}
                            onRun={runNow}
                            onRemove={remove}
                            onCopyToken={copyToken}
                        />
                    ))}
                </div>
            )}

            {editing && (
                <JobDialog
                    job={editing.job}
                    agentId={agentId}
                    hosts={mine}
                    onClose={() => setEditing(null)}
                    onSaved={() => load()}
                />
            )}
        </div>
    );
}

export default memo(JobsPanel);
