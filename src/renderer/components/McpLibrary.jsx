import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft01Icon, GlobalIcon, LinkSquare02Icon, PlugSocketIcon, Tick02Icon } from 'hugeicons-react';
import Sheet from './ui/Sheet';
import Button from './ui/Button';
import Field, { FIELD_CLASS } from './ui/Field';
import SearchField from './ui/SearchField';
import IconTile from './hosts/IconTile';
import { CARD_GRID } from '../lib/layout';
import { HEADING } from '../lib/text-styles';
import { useT } from '../i18n';

/**
 * The MCP library: servers ready to switch on.
 *
 * A sheet over the MCP page, the way the snippet and host editors are sheets
 * over theirs, so it is the same object as every other editor in the app
 * rather than a dialog of its own. The cards are the inventory's cards: the
 * tile, the name, the one identifying line, laid out on the same grid the
 * hosts and keys use. Two shelves share it: the curated templates, and the
 * official registry, which is asked once the search has a word in it and
 * answers under its own heading.
 *
 * Picking a card turns the sheet into the short form for what that server
 * needs. The footer follows: Close while browsing, Back and Add on a form.
 */

const CATEGORIES = ['files', 'code', 'web', 'data', 'ops', 'chat', 'agent', 'other'];

const CHIP = `h-7 px-2.5 rounded-lg text-[11px] font-medium transition-colors outline-none shrink-0
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;
const CHIP_ON = 'bg-gray-900 text-white dark:bg-white dark:text-gray-900';
const CHIP_OFF = `bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-gray-300
    hover:bg-gray-200 dark:hover:bg-neutral-700`;

/** What a card says on its second line: what the server needs, or that it needs nothing. */
function needsLine(template, t) {
    const required = template.fields.filter(field => field.required);
    if (required.length === 0) return t('mcp.library.needsNothing');
    return t('mcp.library.needs', { fields: required.map(field => field.label).join(', ') });
}

function TemplateCard({ template, added, onPick, t }) {
    const remote = template.transport === 'http';
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
                {remote
                    ? <GlobalIcon size={18} strokeWidth={1.5} className="text-gray-600 dark:text-gray-300" />
                    : <PlugSocketIcon size={18} strokeWidth={1.5} className="text-gray-600 dark:text-gray-300" />}
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
                    <span className="ml-auto shrink-0 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
                        {remote ? t('mcp.http') : t('mcp.stdio')}
                    </span>
                </div>
                <p className="mt-0.5 text-xs leading-snug text-gray-600 dark:text-gray-400 line-clamp-2">
                    {template.description}
                </p>
                <p className="mt-1.5 text-[11px] text-gray-400 dark:text-neutral-500 truncate">
                    {added ? t('mcp.library.added') : needsLine(template, t)}
                </p>
            </div>
        </button>
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

export default function McpLibrary({ servers = [], dismiss, onClose, onAdd }) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('');
    const [curated, setCurated] = useState([]);
    const [registry, setRegistry] = useState({ templates: [], error: '', searching: false });
    const [picked, setPicked] = useState(null);

    // The form's state lives here so the footer, which the sheet owns, can
    // drive it.
    const [values, setValues] = useState({});
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [adding, setAdding] = useState(false);

    useEffect(() => {
        let cancelled = false;
        window.api.agents.library({ query, category }).then((list) => { if (!cancelled) setCurated(list || []); }).catch(() => {});
        return () => { cancelled = true; };
    }, [query, category]);

    // The registry is asked once typing pauses, never on every keystroke.
    useEffect(() => {
        const needle = query.trim();
        if (needle.length < 2) {
            setRegistry({ templates: [], error: '', searching: false });
            return undefined;
        }
        let cancelled = false;
        setRegistry(current => ({ ...current, searching: true }));
        const timer = setTimeout(() => {
            window.api.agents.librarySearch(needle).then((found) => {
                if (cancelled) return;
                setRegistry({ templates: found?.templates || [], error: found?.error || '', searching: false });
            }).catch((failure) => {
                if (!cancelled) setRegistry({ templates: [], error: failure.message, searching: false });
            });
        }, 400);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query]);

    const added = useCallback((template) => servers.some(server => server.template === template.id), [servers]);
    const names = useMemo(() => new Set(servers.map(server => server.name.toLowerCase())), [servers]);

    const pick = useCallback((template) => {
        setPicked(template);
        setValues(Object.fromEntries(template.fields.map(field => [field.key, field.default || ''])));
        setName(template.name);
        setError('');
    }, []);

    const back = useCallback(() => {
        setPicked(null);
        setError('');
    }, []);

    const clash = picked ? names.has(name.trim().toLowerCase()) : false;
    const missing = picked ? picked.fields.filter(field => field.required && !String(values[field.key] || '').trim()) : [];
    const canAdd = Boolean(picked) && !adding && missing.length === 0 && Boolean(name.trim()) && !clash;

    const add = useCallback(async () => {
        if (!canAdd) return;
        setAdding(true);
        setError('');
        try {
            const made = await window.api.agents.libraryInstantiate({ template: picked.id, values, name: name.trim(), fallback: picked });
            if (made?.error) {
                setError(made.error);
                return;
            }
            await onAdd(made.server);
            onClose();
        } finally {
            setAdding(false);
        }
    }, [canAdd, picked, values, name, onAdd, onClose]);

    const empty = curated.length === 0 && !registry.searching && registry.templates.length === 0;

    return (
        <Sheet
            title={picked ? picked.name : t('mcp.library.title')}
            subtitle={picked ? picked.description : t('mcp.library.subtitle')}
            dismiss={dismiss}
            onClose={onClose}
            footer={picked ? (
                <>
                    <Button onClick={back} icon={<ArrowLeft01Icon size={14} strokeWidth={2} />}>{t('mcp.library.back')}</Button>
                    <Button variant="primary" onClick={add} disabled={!canAdd}>{t('mcp.library.add')}</Button>
                </>
            ) : (
                <Button onClick={onClose}>{t('common.close')}</Button>
            )}
        >
            {picked ? (
                <form onSubmit={(event) => { event.preventDefault(); add(); }} className="flex flex-col gap-5">
                    {/* What will run, verbatim, in the same place a tool row
                        shows its command: the person is about to hand a
                        process their token, and should see the process. */}
                    <div className="rounded-xl px-3.5 py-2.5 bg-gray-50 dark:bg-black/30 border border-gray-200 dark:border-neutral-800">
                        <p className="text-[11px] font-jetbrains leading-relaxed break-all text-gray-700 dark:text-gray-300">
                            {picked.transport === 'http' ? picked.url : [picked.command, ...picked.args].join(' ')}
                        </p>
                        {picked.homepage && (
                            <a
                                href={picked.homepage}
                                onClick={(event) => { event.preventDefault(); window.api.links?.open?.(picked.homepage); }}
                                className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-900 dark:hover:text-white"
                            >
                                <LinkSquare02Icon size={12} strokeWidth={2} />
                                {picked.homepage.replace(/^https?:\/\/(www\.)?/, '')}
                            </a>
                        )}
                    </div>

                    <Field label={t('mcp.name')} error={clash ? t('mcp.library.nameTaken') : ''}>
                        <input
                            autoFocus={picked.fields.length === 0}
                            type="text"
                            value={name}
                            maxLength={60}
                            onChange={(event) => setName(event.target.value)}
                            className={FIELD_CLASS}
                        />
                    </Field>

                    {picked.fields.map((field, index) => (
                        <Field
                            key={field.key}
                            label={field.required ? field.label : t('mcp.library.optionalField', { label: field.label })}
                            hint={field.help}
                        >
                            <input
                                autoFocus={index === 0}
                                type={field.secret ? 'password' : 'text'}
                                value={values[field.key] || ''}
                                onChange={(event) => setValues(current => ({ ...current, [field.key]: event.target.value }))}
                                className={`${FIELD_CLASS} ${field.secret ? '' : 'font-jetbrains'}`}
                                placeholder={field.placeholder}
                                autoComplete="off"
                                spellCheck={false}
                            />
                        </Field>
                    ))}

                    {picked.fields.length === 0 && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">{t('mcp.library.nothingToFill')}</p>
                    )}
                    {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
                </form>
            ) : (
                <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                        <SearchField
                            value={query}
                            onChange={setQuery}
                            ariaLabel={t('mcp.library.search')}
                            placeholder={t('mcp.library.searchPlaceholder')}
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
                                {value ? t(`mcp.library.category.${value}`) : t('mcp.library.category.all')}
                            </button>
                        ))}
                    </div>

                    {curated.length > 0 && (
                        <Shelf title={t('mcp.library.shelfCurated')}>
                            {curated.map(template => (
                                <TemplateCard key={template.id} template={template} added={added(template)} onPick={pick} t={t} />
                            ))}
                        </Shelf>
                    )}

                    {(registry.searching || registry.templates.length > 0 || registry.error) && (
                        <Shelf title={registry.searching ? t('mcp.library.registrySearching') : t('mcp.library.registry', { count: registry.templates.length })}>
                            {registry.error && (
                                <p className="col-span-full text-xs text-amber-600 dark:text-amber-400">{registry.error}</p>
                            )}
                            {registry.templates.map(template => (
                                <TemplateCard key={template.id} template={template} added={added(template)} onPick={pick} t={t} />
                            ))}
                        </Shelf>
                    )}

                    {empty && (
                        <p className="py-10 text-center text-xs text-gray-500 dark:text-gray-400">{t('mcp.library.none')}</p>
                    )}
                </div>
            )}
        </Sheet>
    );
}
