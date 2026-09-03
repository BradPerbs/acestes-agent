import { useCallback, useEffect, useState } from 'react';
import { Delete02Icon, PlusSignIcon } from 'hugeicons-react';
import SettingCard from './ui/SettingCard';
import Button, { IconButton } from '../ui/Button';
import { FIELD_CLASS } from '../ui/Field';
import { useT } from '../../i18n';

/**
 * The secrets store, as the settings page shows it: names, when each was
 * last set, and a way to add or replace one. Values are typed into a
 * masked field, go over the bridge once, and never come back; the agent
 * refers to a secret as `{{secret:name}}` and the app fills it in at the
 * moment of use.
 */

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/;

function when(t, at) {
    if (!at) return '';
    const date = new Date(at);
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function SecretsCard() {
    const t = useT();
    const [secrets, setSecrets] = useState(null);
    const [name, setName] = useState('');
    const [value, setValue] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        const list = await window.api.secrets?.list?.();
        setSecrets(Array.isArray(list) ? list : []);
    }, []);

    useEffect(() => { load().catch(() => {}); }, [load]);

    const valid = NAME.test(name.trim()) && value.length > 0;
    const exists = secrets?.some(entry => entry.name === name.trim());

    const add = async () => {
        if (!valid || saving) return;
        setSaving(true);
        setError('');
        try {
            const result = await window.api.secrets.set(name.trim(), value);
            if (result?.error) {
                setError(result.error);
                return;
            }
            setName('');
            setValue('');
            await load();
        } finally {
            setSaving(false);
        }
    };

    const remove = async (entry) => {
        await window.api.secrets.remove(entry.name);
        await load();
    };

    if (!secrets) return null;

    return (
        <SettingCard>
            <div className="mb-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('settings.assistant.secrets')}</h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('settings.assistant.secretsDesc')}</p>
            </div>

            {secrets.length === 0 ? (
                <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t('settings.assistant.secretsEmpty')}</p>
            ) : (
                <ul className="space-y-2 mb-3">
                    {secrets.map(entry => (
                        <li
                            key={entry.name}
                            className="flex items-center gap-3 rounded-lg px-3 py-2 bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700"
                        >
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-gray-900 dark:text-white truncate">{entry.name}</div>
                                <div className="text-[11px] font-mono text-gray-500 dark:text-gray-400 truncate">
                                    {entry.reference}
                                    <span className="font-sans"> · {t('settings.assistant.secretUpdated', { when: when(t, entry.updatedAt) })}</span>
                                </div>
                            </div>
                            <IconButton
                                size="sm"
                                aria-label={t('common.deleteNamed', { name: entry.name })}
                                icon={<Delete02Icon size={14} strokeWidth={1.5} />}
                                onClick={() => remove(entry)}
                            />
                        </li>
                    ))}
                </ul>
            )}

            <form
                onSubmit={(event) => { event.preventDefault(); add(); }}
                className="flex flex-wrap items-center gap-2"
            >
                <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('settings.assistant.secretName')}
                    spellCheck={false}
                    autoComplete="off"
                    className={`${FIELD_CLASS} w-44 font-mono`}
                />
                <input
                    type="password"
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder={t('settings.assistant.secretValue')}
                    autoComplete="new-password"
                    className={`${FIELD_CLASS} flex-1 min-w-[12rem]`}
                />
                <Button
                    type="submit"
                    variant="secondary"
                    size="sm"
                    icon={<PlusSignIcon size={14} strokeWidth={2.5} />}
                    disabled={!valid || saving}
                >
                    {exists ? t('settings.assistant.secretReplace') : t('settings.assistant.secretAdd')}
                </Button>
            </form>
            {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
        </SettingCard>
    );
}
