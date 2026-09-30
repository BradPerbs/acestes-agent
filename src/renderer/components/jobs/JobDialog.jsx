import { useEffect, useMemo, useState } from 'react';
import Dialog from '../ui/Dialog';
import Button from '../ui/Button';
import Field, { FIELD_CLASS } from '../ui/Field';
import Select from '../ui/Select';
import Disclosure from '../ui/Disclosure';
import Toggle from '../settings/ui/Toggle';
import { useT } from '../../i18n';
import { CHIP, CHIP_OFF, CHIP_ON, CRON_PRESETS, EVERY_PRESETS, describeEvery, moment } from './schedule';

/**
 * The job editor: a new job, an existing one, or one a template filled in.
 *
 * The four things every job has are laid out flat: its name, when it fires,
 * what it is told, and how far it may go on its own. Everything else (the
 * pinned model, the ceilings, where the result goes, what happens when the
 * app was closed) is folded away with a line saying what is set, so the
 * common job is four fields and an unusual one loses nothing.
 *
 * Under the schedule is what it means: the next few times it fires, asked
 * of the same parser that will fire it, so "0 9 * * 1-5" reads back as three
 * weekday mornings before anything is saved.
 */

const SCHEDULE_KINDS = ['every', 'cron', 'at', 'heartbeat', 'event', 'webhook'];
const APPROVALS = ['park', 'read-only', 'allowlist', 'full'];
const EVENTS = ['host-offline', 'host-online'];

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
    template: '',
    // The runtime, model and effort the run is pinned to, as the user typed
    // them ("grok 4.6 xhigh") and as main resolved them.
    modelQuery: '',
    pinned: null,
});

/** A saved job, or a spec a template made, to the form's fields. */
function draftFrom(job) {
    const draft = emptyDraft();
    if (!job) return draft;
    const schedule = job.schedule || {};
    const local = (stamp) => {
        const date = new Date(stamp);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    };
    return {
        ...draft,
        name: job.name || '',
        kind: schedule.kind || 'every',
        every: schedule.everyMs ? describeEvery(schedule.everyMs) : draft.every,
        cron: schedule.expr || draft.cron,
        tz: schedule.tz || draft.tz,
        at: schedule.at ? local(schedule.at) : '',
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
        template: job.template || '',
        modelQuery: job.model ? [job.model, job.effort].filter(Boolean).join(' ') : '',
        pinned: job.model ? { provider: job.provider || '', model: job.model, label: job.model, effort: job.effort || '' } : null,
    };
}

function scheduleFrom(draft) {
    switch (draft.kind) {
        case 'every': return { kind: 'every', every: draft.every };
        case 'cron': return { kind: 'cron', expr: draft.cron, tz: draft.tz };
        case 'at': return { kind: 'at', at: draft.at };
        case 'heartbeat': return { kind: 'heartbeat', every: draft.every, probe: { command: draft.probe } };
        case 'event': return { kind: 'event', event: draft.event, hostId: draft.hostId };
        case 'webhook': return { kind: 'webhook' };
        default: return { kind: 'every', every: draft.every };
    }
}

export function specFrom(draft, agentId) {
    const number = (value) => (value === '' || value === null ? undefined : Number(value));
    return {
        agentId,
        name: draft.name,
        schedule: scheduleFrom(draft),
        prompt: draft.prompt,
        policy: {
            approvals: draft.approvals,
            tools: draft.tools.split(',').map(entry => entry.trim()).filter(Boolean),
            budget: { maxToolCalls: number(draft.maxToolCalls), maxCostUsd: number(draft.maxCostUsd), maxMinutes: number(draft.maxMinutes) },
        },
        delivery: { notify: draft.notify, webhook: draft.webhook, file: draft.file },
        missed: draft.missed,
        keepAfterRun: draft.keepAfterRun,
        template: draft.template,
        provider: draft.pinned?.provider || '',
        model: draft.pinned?.model || '',
        effort: draft.pinned?.effort || '',
    };
}

/** The next times the schedule fires, or why it never will, as it is typed. */
function useSchedulePreview(schedule) {
    const [preview, setPreview] = useState(null);
    const key = JSON.stringify(schedule);
    useEffect(() => {
        if (!window.api?.jobs?.preview) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            window.api.jobs.preview(JSON.parse(key), 3)
                .then(found => { if (!cancelled) setPreview(found); })
                .catch(() => {});
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [key]);
    return preview;
}

function Presets({ items, active, onPick }) {
    return (
        <div className="flex flex-wrap gap-1.5 -mt-1">
            {items.map(item => (
                <button
                    key={item.value}
                    type="button"
                    aria-pressed={active === item.value}
                    onClick={() => onPick(item.value)}
                    className={`${CHIP} ${active === item.value ? CHIP_ON : CHIP_OFF}`}
                >
                    {item.label}
                </button>
            ))}
        </div>
    );
}

function SchedulePreview({ preview, kind, t }) {
    if (kind === 'event' || kind === 'webhook') return null;
    if (!preview) return <p className="text-[11px] text-gray-400 min-h-4">&nbsp;</p>;
    if (preview.error) return <p className="text-[11px] text-red-600 dark:text-red-400">{preview.error}</p>;
    return (
        <div className="rounded-xl px-3 py-2 bg-gray-50 dark:bg-black/20 border border-gray-200 dark:border-neutral-800">
            <p className="text-xs font-medium text-gray-800 dark:text-gray-200 first-letter:uppercase">{preview.text}</p>
            {preview.next?.length > 0 && (
                <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                    {t('jobs.preview.next', { times: preview.next.map(moment).join(' · ') })}
                </p>
            )}
        </div>
    );
}

export default function JobDialog({ job, seed, agentId, hosts, onClose, onSaved }) {
    const t = useT();
    const [draft, setDraft] = useState(() => draftFrom(job || seed));
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [resolving, setResolving] = useState(false);
    const [modelNote, setModelNote] = useState('');
    const set = (key, value) => setDraft(current => ({ ...current, [key]: value }));

    const schedule = useMemo(() => scheduleFrom(draft), [draft]);
    const preview = useSchedulePreview(schedule);

    /** "grok 4.6 xhigh" to a runtime, a model and an effort, through main. */
    const resolveModel = async () => {
        const query = draft.modelQuery.trim();
        if (!query) {
            set('pinned', null);
            setModelNote('');
            return;
        }
        setResolving(true);
        try {
            const found = await window.api.jobs.resolveModel(agentId, query);
            if (found?.error) {
                set('pinned', null);
                setModelNote(found.error);
                return;
            }
            set('pinned', { provider: found.provider, model: found.model, label: found.label, effort: found.effort });
            setModelNote(found.effortDropped
                ? t('jobs.effortDropped', { effort: found.effortDropped, offered: (found.effortOffered || []).join(', ') || '—' })
                : '');
        } finally {
            setResolving(false);
        }
    };

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

    const limits = [
        draft.maxToolCalls && t('jobs.summary.calls', { count: Number(draft.maxToolCalls) }),
        draft.maxCostUsd && `$${draft.maxCostUsd}`,
        draft.maxMinutes && t('jobs.summary.minutes', { count: Number(draft.maxMinutes) }),
    ].filter(Boolean).join(' · ');
    const delivery = [
        draft.notify && t('jobs.summary.notify'),
        draft.webhook && t('jobs.summary.webhook'),
        draft.file && t('jobs.summary.file'),
    ].filter(Boolean).join(' · ');
    const pinnedSummary = draft.pinned ? [draft.pinned.label || draft.pinned.model, draft.pinned.effort].filter(Boolean).join(' · ') : '';

    return (
        <Dialog
            title={job ? t('jobs.editTitle') : (seed ? t('jobs.fromTemplateTitle') : t('jobs.newTitle'))}
            subtitle={t('jobs.subtitle')}
            onClose={onClose}
            width="36rem"
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

                {(draft.kind === 'every' || draft.kind === 'heartbeat') && (
                    <Presets
                        active={draft.every}
                        onPick={(value) => set('every', value)}
                        items={EVERY_PRESETS.map(value => ({ value, label: t('jobs.preset.every', { span: value }) }))}
                    />
                )}
                {draft.kind === 'cron' && (
                    <>
                        <Presets
                            active={draft.cron}
                            onPick={(value) => set('cron', value)}
                            items={CRON_PRESETS.map(preset => ({ value: preset.expr, label: t(`jobs.preset.${preset.id}`) }))}
                        />
                        <Field label={t('jobs.timezone')}>
                            <input type="text" value={draft.tz} onChange={e => set('tz', e.target.value)} className={FIELD_CLASS} placeholder="Europe/Rome" />
                        </Field>
                    </>
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
                {draft.kind === 'webhook' && !job?.webhookUrl && (
                    <p className="text-xs text-gray-500">{t('jobs.webhookAfterSave')}</p>
                )}

                <SchedulePreview preview={preview} kind={draft.kind} t={t} />

                <Field label={t('jobs.prompt')} hint={t('jobs.promptHint')}>
                    <textarea
                        rows={draft.prompt.length > 400 ? 10 : 5}
                        value={draft.prompt}
                        onChange={e => set('prompt', e.target.value)}
                        className={`${FIELD_CLASS} resize-y leading-relaxed`}
                        placeholder={t('jobs.promptPlaceholder')}
                    />
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

                <Disclosure title={t('jobs.section.model')} summary={pinnedSummary} defaultOpen={Boolean(draft.pinned)}>
                    <Field
                        label={t('jobs.model')}
                        hint={modelNote || (draft.pinned
                            ? t('jobs.modelPinned', { model: draft.pinned.label || draft.pinned.model, runtime: draft.pinned.provider, effort: draft.pinned.effort || 'default' })
                            : t('jobs.modelHint'))}
                    >
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={draft.modelQuery}
                                onChange={e => set('modelQuery', e.target.value)}
                                onBlur={resolveModel}
                                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); resolveModel(); } }}
                                className={`${FIELD_CLASS} flex-1`}
                                placeholder="grok 4.6 xhigh"
                            />
                            <Button size="sm" variant="secondary" onClick={resolveModel} disabled={resolving}>
                                {t('jobs.modelResolve')}
                            </Button>
                        </div>
                    </Field>
                </Disclosure>

                <Disclosure title={t('jobs.section.limits')} summary={limits} defaultOpen={false}>
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
                </Disclosure>

                <Disclosure title={t('jobs.section.delivery')} summary={delivery || t('jobs.summary.silent')} defaultOpen={Boolean(draft.webhook || draft.file)}>
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
                </Disclosure>

                <Disclosure title={t('jobs.section.missed')} summary={t(`jobs.missed.${draft.missed}`)} defaultOpen={false}>
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
                </Disclosure>

                {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
            </form>
        </Dialog>
    );
}
