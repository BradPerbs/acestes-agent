import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Analytics01Icon, ArrowLeft01Icon, Folder01Icon, GithubIcon, GlobalIcon, ServerStack01Icon, Shield01Icon, Tick02Icon,
} from 'hugeicons-react';
import Sheet from '../ui/Sheet';
import Button from '../ui/Button';
import Field, { FIELD_CLASS } from '../ui/Field';
import Select from '../ui/Select';
import SearchField from '../ui/SearchField';
import Disclosure from '../ui/Disclosure';
import IconTile from '../hosts/IconTile';
import { CARD_GRID } from '../../lib/layout';
import { HEADING } from '../../lib/text-styles';
import { useT } from '../../i18n';
import { CHIP, CHIP_OFF, CHIP_ON, moment } from './schedule';

/**
 * The job library: work worth doing on a schedule, ready to switch on.
 *
 * The same object as the MCP library, a sheet over its page with the
 * inventory's cards on the inventory's grid, because it is the same idea:
 * something ready-made, a couple of blanks, and it is yours. The templates
 * live in the main process (runs/job-templates.js), where the agent can
 * reach them too; this only browses them and fills them in.
 *
 * Picking a card turns the sheet into the short form for that template,
 * with what it will do underneath: when it fires next, how far it may go,
 * and the brief the agent will be handed, filled in as you type. Add saves
 * it as it stands; Customise hands the filled-in job to the full editor.
 */

const CATEGORIES = ['code', 'servers', 'security', 'web', 'files', 'reports'];

export const CATEGORY_ICON = {
    code: GithubIcon,
    servers: ServerStack01Icon,
    security: Shield01Icon,
    web: GlobalIcon,
    files: Folder01Icon,
    reports: Analytics01Icon,
};

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || '';

/** `showCategory` is off on a shelf that is already headed by the category. */
export function TemplateCard({ template, added, onPick, showCategory = true, t }) {
    const Icon = CATEGORY_ICON[template.category] || Analytics01Icon;
    return (
        <button
            type="button"
            onClick={() => onPick(template)}
            className="group/card text-left flex items-start gap-3 p-3.5 rounded-2xl border transition-colors outline-none
                bg-white dark:bg-surface-raised
                border-gray-200 dark:border-neutral-800
                hover:border-gray-300 dark:hover:border-neutral-700
                focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
        >
            <IconTile>
                <Icon size={18} strokeWidth={1.5} className="text-gray-600 dark:text-gray-300" />
                {added && (
                    <span
                        aria-hidden="true"
                        className="absolute -right-1 -bottom-1 w-4 h-4 rounded-full flex items-center justify-center
                            bg-emerald-500 text-white ring-2 ring-white dark:ring-surface-raised"
                    >
                        <Tick02Icon size={10} strokeWidth={3} />
                    </span>
                )}
            </IconTile>
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">{template.name}</span>
                    {showCategory && (
                        <span className="ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
                            {t(`jobs.library.category.${template.category}`)}
                        </span>
                    )}
                </div>
                <p className="mt-0.5 text-xs leading-snug text-gray-600 dark:text-gray-400 line-clamp-2">
                    {template.description}
                </p>
                <p className="mt-1.5 text-[11px] text-gray-400 dark:text-neutral-500 truncate first-letter:uppercase">
                    {added ? t('jobs.library.added') : template.scheduleText}
                    {!added && template.approvals === 'read-only' && ` · ${t('jobs.approvals.read-only').toLowerCase()}`}
                </p>
            </div>
        </button>
    );
}

function TemplateField({ field, value, onChange, hosts, autoFocus, t }) {
    const label = field.required || field.type === 'host' || field.type === 'time'
        ? field.label
        : t('jobs.library.optionalField', { label: field.label });

    if (field.type === 'host') {
        return (
            <Field label={label} hint={field.help}>
                <Select
                    value={value}
                    onChange={onChange}
                    className={FIELD_CLASS}
                    aria-label={field.label}
                    options={[
                        ...(field.local ? [{ value: '@local', label: t('jobs.library.thisComputer') }] : []),
                        { value: '', label: t('jobs.library.allHosts', { count: hosts.length }) },
                        ...hosts.map(host => ({ value: host.name, label: host.name })),
                    ]}
                />
            </Field>
        );
    }
    return (
        <Field label={label} hint={field.help}>
            <input
                autoFocus={autoFocus}
                type={field.type === 'time' ? 'time' : field.type === 'number' ? 'number' : 'text'}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className={`${FIELD_CLASS} ${field.type === 'text' || field.type === 'url' ? 'font-jetbrains' : ''}`}
                placeholder={field.placeholder}
                autoComplete="off"
                spellCheck={false}
            />
        </Field>
    );
}

function Shelf({ title, children }) {
    return (
        <section className="flex flex-col gap-2.5">
            <h3 className={HEADING}>{title}</h3>
            <div className={CARD_GRID}>{children}</div>
        </section>
    );
}

export default function JobLibrary({ agentId, jobs = [], hosts = [], initial = null, dismiss, onClose, onAdded, onCustomise }) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('');
    const [templates, setTemplates] = useState([]);
    const [picked, setPicked] = useState(null);

    const [values, setValues] = useState({});
    const [name, setName] = useState('');
    const [made, setMade] = useState(null); // { spec } | { error }
    const [next, setNext] = useState([]);
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        window.api.jobs.templates({ query, category })
            .then((list) => { if (!cancelled) setTemplates(list || []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [query, category]);

    const pick = useCallback((template) => {
        setPicked(template);
        setValues(Object.fromEntries(template.fields.map(field => [field.key, field.default || ''])));
        setName(template.name);
        setMade(null);
        setNext([]);
        setError('');
    }, []);

    // Opened from a card on the empty Jobs page: straight to its form.
    useEffect(() => {
        if (initial) pick(initial);
    }, [initial, pick]);

    // The template filled in as it is typed: the brief the agent will get,
    // and when it fires, from the same code that will save and fire it.
    useEffect(() => {
        if (!picked) return undefined;
        let cancelled = false;
        const timer = setTimeout(async () => {
            const result = await window.api.jobs.fromTemplate({ template: picked.id, values, tz: TIME_ZONE, agentId, name });
            if (cancelled) return;
            setMade(result);
            if (result?.spec && window.api.jobs.preview) {
                const found = await window.api.jobs.preview(result.spec.schedule, 3);
                if (!cancelled) setNext(found?.next || []);
            } else {
                setNext([]);
            }
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [picked, values, name, agentId]);

    const usedTemplates = useMemo(() => new Set(jobs.map(job => job.template).filter(Boolean)), [jobs]);
    const missing = picked ? picked.fields.filter(field => field.required && !String(values[field.key] || '').trim()) : [];
    const ready = Boolean(picked) && !adding && missing.length === 0 && Boolean(name.trim()) && Boolean(made?.spec);

    const add = useCallback(async () => {
        if (!ready) return;
        setAdding(true);
        setError('');
        try {
            const result = await window.api.jobs.create(made.spec);
            if (result?.error) {
                setError(result.error);
                return;
            }
            onAdded?.(result.job);
            onClose();
        } finally {
            setAdding(false);
        }
    }, [ready, made, onAdded, onClose]);

    const customise = useCallback(() => {
        if (!made?.spec) return;
        onCustomise?.(made.spec);
    }, [made, onCustomise]);

    const back = useCallback(() => {
        setPicked(null);
        setError('');
    }, []);

    // Grouped by category when nothing narrows the list, one shelf otherwise.
    const shelves = useMemo(() => {
        if (query.trim() || category) return [{ id: 'results', templates }];
        return CATEGORIES
            .map(id => ({ id, templates: templates.filter(template => template.category === id) }))
            .filter(shelf => shelf.templates.length > 0);
    }, [templates, query, category]);

    const shownError = error || (missing.length === 0 ? made?.error : '');

    return (
        <Sheet
            title={picked ? picked.name : t('jobs.library.title')}
            subtitle={picked ? picked.description : t('jobs.library.subtitle')}
            dismiss={dismiss}
            onClose={onClose}
            footer={picked ? (
                <>
                    <Button onClick={back} icon={<ArrowLeft01Icon size={14} strokeWidth={2} />}>{t('jobs.library.back')}</Button>
                    <Button onClick={customise} disabled={!made?.spec}>{t('jobs.library.customise')}</Button>
                    <Button variant="primary" onClick={add} disabled={!ready}>{t('jobs.library.add')}</Button>
                </>
            ) : (
                <Button onClick={onClose}>{t('common.close')}</Button>
            )}
        >
            {picked ? (
                <form onSubmit={(event) => { event.preventDefault(); add(); }} className="flex flex-col gap-5 max-w-2xl">
                    <div className="rounded-xl px-3.5 py-3 bg-gray-50 dark:bg-black/30 border border-gray-200 dark:border-neutral-800 flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                            <span className="font-medium text-gray-800 dark:text-gray-200 first-letter:uppercase">
                                {made?.scheduleText || picked.scheduleText}
                            </span>
                            <span className="text-gray-500">{t(`jobs.approvals.${picked.approvals}`)}</span>
                            {picked.budget?.maxToolCalls && (
                                <span className="text-gray-500">{t('jobs.summary.calls', { count: picked.budget.maxToolCalls })}</span>
                            )}
                        </div>
                        {next.length > 0 && (
                            <p className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                                {t('jobs.preview.next', { times: next.map(moment).join(' · ') })}
                            </p>
                        )}
                        {picked.needs && (
                            <p className="text-[11px] text-gray-500 dark:text-gray-400">{t('jobs.library.needs', { what: picked.needs })}</p>
                        )}
                        {picked.schedule?.kind === 'heartbeat' && made?.spec?.schedule?.probe?.command && (
                            <p className="text-[11px] font-jetbrains break-all text-gray-600 dark:text-gray-300">
                                {t('jobs.library.probe', { command: made.spec.schedule.probe.command })}
                            </p>
                        )}
                    </div>

                    <Field label={t('jobs.name')}>
                        <input
                            type="text"
                            value={name}
                            maxLength={120}
                            onChange={(event) => setName(event.target.value)}
                            className={FIELD_CLASS}
                        />
                    </Field>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {picked.fields.map((field, index) => (
                            <div key={field.key} className={field.type === 'text' || field.type === 'url' ? 'sm:col-span-2' : ''}>
                                <TemplateField
                                    field={field}
                                    value={values[field.key] ?? ''}
                                    onChange={(value) => setValues(current => ({ ...current, [field.key]: value }))}
                                    hosts={hosts}
                                    autoFocus={index === 0}
                                    t={t}
                                />
                            </div>
                        ))}
                    </div>

                    {made?.spec?.prompt && (
                        <Disclosure title={t('jobs.library.brief')} summary={t('jobs.library.briefSummary', { count: made.spec.prompt.length })}>
                            <pre className="max-h-80 overflow-auto text-[11px] leading-relaxed font-jetbrains whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
                                {made.spec.prompt}
                            </pre>
                        </Disclosure>
                    )}

                    {shownError && <p className="text-xs text-red-600 dark:text-red-400">{shownError}</p>}
                </form>
            ) : (
                <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <SearchField
                            value={query}
                            onChange={setQuery}
                            ariaLabel={t('jobs.library.search')}
                            placeholder={t('jobs.library.searchPlaceholder')}
                        />
                    </div>
                    <div className="flex gap-1.5 overflow-x-auto scrollbar-none -mx-1 px-1">
                        {['', ...CATEGORIES].map(value => (
                            <button
                                key={value || 'all'}
                                type="button"
                                aria-pressed={category === value}
                                onClick={() => setCategory(value)}
                                className={`${CHIP} ${category === value ? CHIP_ON : CHIP_OFF}`}
                            >
                                {value ? t(`jobs.library.category.${value}`) : t('jobs.library.category.all')}
                            </button>
                        ))}
                    </div>

                    {shelves.map(shelf => (
                        <Shelf key={shelf.id} title={shelf.id === 'results' ? t('jobs.library.results', { count: shelf.templates.length }) : t(`jobs.library.category.${shelf.id}`)}>
                            {shelf.templates.map(template => (
                                <TemplateCard
                                    key={template.id}
                                    template={template}
                                    added={usedTemplates.has(template.id)}
                                    onPick={pick}
                                    showCategory={shelf.id === 'results'}
                                    t={t}
                                />

                            ))}
                        </Shelf>
                    ))}

                    {templates.length === 0 && (
                        <p className="py-10 text-center text-xs text-gray-500 dark:text-gray-400">{t('jobs.library.none')}</p>
                    )}
                </div>
            )}
        </Sheet>
    );
}
