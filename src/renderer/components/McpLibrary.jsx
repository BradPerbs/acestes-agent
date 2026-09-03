import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft01Icon, LinkSquare02Icon, PlugSocketIcon, Search01Icon } from 'hugeicons-react';
import Dialog from './ui/Dialog';
import Button from './ui/Button';
import Field, { FIELD_CLASS } from './ui/Field';
import { useT } from '../i18n';

/**
 * The MCP library: servers ready to switch on.
 *
 * Two shelves in one list. The curated templates come first, filtered by
 * the search box and the category chips; typing also asks the official
 * registry, whose results follow under their own heading. Choosing a
 * template turns the dialog into a short form for the fields it needs (a
 * folder, a token), and Add puts the filled-in server on the agent.
 *
 * Nothing is fetched until the dialog opens, and the registry is only asked
 * once the box has a word in it: the curated shelf is enough to be useful
 * offline.
 */

const CATEGORIES = ['files', 'code', 'web', 'data', 'ops', 'chat', 'agent', 'other'];

function TemplateCard({ template, taken, onPick, t }) {
    return (
        <button
            type="button"
            onClick={() => onPick(template)}
            className="text-left flex items-start gap-3 px-3.5 py-3 rounded-xl border transition-colors outline-none
                bg-white dark:bg-neutral-800/50 border-gray-200 dark:border-neutral-800
                hover:border-gray-400 dark:hover:border-neutral-600
                focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
        >
            <PlugSocketIcon size={18} strokeWidth={1.5} className="shrink-0 mt-0.5 text-gray-400 dark:text-neutral-500" />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold text-gray-900 dark:text-white truncate">{template.name}</span>
                    <span className="shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider
                        bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                        {template.transport === 'http' ? t('mcp.http') : t('mcp.stdio')}
                    </span>
                    {taken && (
                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                            {t('mcp.library.added')}
                        </span>
                    )}
                </div>
                <p className="mt-0.5 text-xs leading-snug text-gray-500 dark:text-gray-400 line-clamp-2">{template.description}</p>
                {template.fields.length > 0 && (
                    <p className="mt-1 text-[11px] text-gray-400 dark:text-neutral-500">
                        {t('mcp.library.needs', { fields: template.fields.map(field => field.label).join(', ') })}
                    </p>
                )}
            </div>
        </button>
    );
}

function TemplateForm({ template, existingNames, onBack, onAdd, t }) {
    const [values, setValues] = useState(() => Object.fromEntries(template.fields.map(field => [field.key, field.default || ''])));
    const [name, setName] = useState(template.name);
    const [error, setError] = useState('');
    const [adding, setAdding] = useState(false);

    const clash = existingNames.some(entry => entry.toLowerCase() === name.trim().toLowerCase());
    const missing = template.fields.filter(field => field.required && !String(values[field.key] || '').trim());

    const submit = async () => {
        if (adding || missing.length > 0 || !name.trim()) return;
        setAdding(true);
        setError('');
        try {
            const made = await window.api.agents.libraryInstantiate({ template: template.id, values, name: name.trim(), fallback: template });
            if (made?.error) {
                setError(made.error);
                return;
            }
            await onAdd(made.server);
        } finally {
            setAdding(false);
        }
    };

    return (
        <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="flex flex-col gap-4">
            <button type="button" onClick={onBack} className="self-start flex items-center gap-1 text-xs text-gray-500 hover:text-gray-900 dark:hover:text-white">
                <ArrowLeft01Icon size={14} strokeWidth={2} /> {t('mcp.library.back')}
            </button>
            <div>
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">{template.name}</h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{template.description}</p>
                {template.homepage && (
                    <a
                        href={template.homepage}
                        onClick={(event) => { event.preventDefault(); window.api.links?.open?.(template.homepage); }}
                        className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-900 dark:hover:text-white"
                    >
                        <LinkSquare02Icon size={12} strokeWidth={2} /> {template.homepage.replace(/^https?:\/\//, '')}
                    </a>
                )}
            </div>
            <p className="text-[11px] font-mono text-gray-500 dark:text-gray-400 break-all">
                {template.transport === 'http' ? template.url : [template.command, ...template.args].join(' ')}
            </p>

            <Field label={t('mcp.name')} error={clash ? t('mcp.library.nameTaken') : ''}>
                <input type="text" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} className={FIELD_CLASS} />
            </Field>

            {template.fields.map(field => (
                <Field key={field.key} label={`${field.label}${field.required ? '' : ` (${t('mcp.library.optional')})`}`} hint={field.help}>
                    <input
                        type={field.secret ? 'password' : 'text'}
                        value={values[field.key] || ''}
                        onChange={(event) => setValues(current => ({ ...current, [field.key]: event.target.value }))}
                        className={`${FIELD_CLASS} ${field.secret ? '' : 'font-mono'}`}
                        placeholder={field.placeholder}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </Field>
            ))}

            {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

            <div className="flex justify-end gap-2">
                <Button onClick={onBack}>{t('common.cancel')}</Button>
                <Button variant="primary" onClick={submit} disabled={adding || missing.length > 0 || !name.trim() || clash}>
                    {t('mcp.library.add')}
                </Button>
            </div>
        </form>
    );
}

export default function McpLibrary({ servers = [], onClose, onAdd }) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('');
    const [curated, setCurated] = useState([]);
    const [registry, setRegistry] = useState({ templates: [], error: '', searching: false });
    const [picked, setPicked] = useState(null);

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
            }).catch((error) => {
                if (!cancelled) setRegistry({ templates: [], error: error.message, searching: false });
            });
        }, 400);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [query]);

    const names = useMemo(() => servers.map(server => server.name), [servers]);
    const taken = useCallback((template) => servers.some(server => server.template === template.id), [servers]);

    const add = useCallback(async (record) => {
        await onAdd(record);
        onClose();
    }, [onAdd, onClose]);

    return (
        <Dialog title={t('mcp.library.title')} subtitle={picked ? undefined : t('mcp.library.subtitle')} onClose={onClose} width="44rem">
            {picked ? (
                <TemplateForm template={picked} existingNames={names} onBack={() => setPicked(null)} onAdd={add} t={t} />
            ) : (
                <div className="flex flex-col gap-3">
                    <div className="relative">
                        <Search01Icon size={15} strokeWidth={2} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input
                            autoFocus
                            type="text"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t('mcp.library.searchPlaceholder')}
                            className={`${FIELD_CLASS} pl-9`}
                        />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {['', ...CATEGORIES].map(value => (
                            <button
                                key={value || 'all'}
                                type="button"
                                onClick={() => setCategory(value)}
                                className={`h-7 px-2.5 rounded-lg text-[11px] font-medium transition-colors ${category === value
                                    ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                                    : 'bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-neutral-700'}`}
                            >
                                {value ? t(`mcp.library.category.${value}`) : t('mcp.library.category.all')}
                            </button>
                        ))}
                    </div>

                    <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1 space-y-2">
                        {curated.map(template => (
                            <TemplateCard key={template.id} template={template} taken={taken(template)} onPick={setPicked} t={t} />
                        ))}
                        {curated.length === 0 && !registry.searching && registry.templates.length === 0 && (
                            <p className="py-6 text-center text-xs text-gray-500">{t('mcp.library.none')}</p>
                        )}

                        {(registry.searching || registry.templates.length > 0 || registry.error) && (
                            <div className="pt-2">
                                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500">
                                    {registry.searching ? t('mcp.library.registrySearching') : t('mcp.library.registry', { count: registry.templates.length })}
                                </p>
                                {registry.error && <p className="text-xs text-amber-600 dark:text-amber-400">{registry.error}</p>}
                                <div className="space-y-2">
                                    {registry.templates.map(template => (
                                        <TemplateCard key={template.id} template={template} taken={taken(template)} onPick={setPicked} t={t} />
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </Dialog>
    );
}
