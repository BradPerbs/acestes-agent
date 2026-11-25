import { useCallback, useEffect, useState } from 'react';
import { CloudServerIcon } from 'hugeicons-react';
import Toggle from './ui/Toggle';
import Select from '../ui/Select';
import Button from '../ui/Button';
import Capability, { Detail } from './Capability';
import { FIELD_CLASS as FIELD } from './useAssistantSettings';
import { useT } from '../../i18n';

/**
 * Cloud sandboxes: Spaceyard desktops the agent can start and work in with
 * the same computer tools it uses here (see main/ai/spaceyard.js). A switch,
 * then what there is to set once it is on: the key (typed once, kept in the
 * keychain as `spaceyard`, never shown again), how long an unused sandbox
 * runs before it stops, and how long a stopped one is kept.
 *
 * Shown on every system: a sandbox needs no desktop helper on this computer.
 */

const IDLE_CHOICES = [5, 15, 30, 60, 240];
const DESTROY_CHOICES = [0, 60, 1440, 10080, -1];

const ERROR_CLASS = 'text-xs text-red-600 dark:text-red-400';
const NOTE_CLASS = 'text-xs text-gray-500 dark:text-gray-400';

export default function SpaceyardCapability({ settings, update, className = '' }) {
    const t = useT();
    const agentId = settings.agentId;
    const [hasKey, setHasKey] = useState(null);
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [checked, setChecked] = useState(null);
    const [checking, setChecking] = useState(false);

    useEffect(() => {
        let live = true;
        window.api.spaceyard.status(agentId).then((status) => {
            if (live) setHasKey(Boolean(status?.hasKey));
        }).catch(() => {});
        return () => { live = false; };
    }, [agentId]);

    const check = useCallback(async () => {
        setChecking(true);
        try {
            setChecked(await window.api.spaceyard.check(agentId));
        } finally {
            setChecking(false);
        }
    }, [agentId]);

    const save = async (value) => {
        setSaving(true);
        setError('');
        setChecked(null);
        try {
            const next = await window.api.spaceyard.setKey(value, agentId);
            setHasKey(Boolean(next?.hasKey));
            if (next?.keyError) {
                setError(next.keyError);
            } else {
                setKey('');
                if (next?.hasKey) check();
            }
        } finally {
            setSaving(false);
        }
    };

    const destroyLabel = (minutes) => {
        if (minutes === -1) return t('settings.spaceyard.destroy.never');
        if (minutes === 0) return t('settings.spaceyard.destroy.atOnce');
        const when = minutes < 1440
            ? t('settings.spaceyard.hours', { count: Math.round(minutes / 60) })
            : t('settings.spaceyard.days', { count: Math.round(minutes / 1440) });
        return t('settings.spaceyard.after', { when });
    };

    const idle = settings.spaceyardIdle ?? 15;
    const destroy = settings.spaceyardDestroy ?? 1440;

    return (
        <Capability
            className={className}
            icon={CloudServerIcon}
            title={t('settings.spaceyard.title')}
            description={t('settings.spaceyard.desc')}
            open={Boolean(settings.spaceyard)}
            control={(
                <Toggle
                    ariaLabel={t('settings.spaceyard.title')}
                    checked={Boolean(settings.spaceyard)}
                    onChange={(value) => update({ spaceyard: value })}
                />
            )}
        >
            <div className="space-y-5">
                <p className={NOTE_CLASS}>{t('settings.spaceyard.about')}</p>

                <Detail
                    title={t('settings.spaceyard.key')}
                    description={hasKey ? t('settings.spaceyard.keySaved') : t('settings.spaceyard.keyDesc')}
                >
                    <div className="space-y-2 w-full">
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                                value={key}
                                onChange={event => setKey(event.target.value)}
                                onKeyDown={(event) => { if (event.key === 'Enter' && key.trim()) save(key); }}
                                placeholder={hasKey ? t('settings.spaceyard.keyReplace') : t('settings.spaceyard.keyPlaceholder')}
                                aria-label={t('settings.spaceyard.key')}
                                className={`${FIELD} max-w-sm`}
                            />
                            <Button size="sm" variant="secondary" onClick={() => save(key)} disabled={saving || !key.trim()}>
                                {t('settings.spaceyard.keySave')}
                            </Button>
                            {hasKey && (
                                <>
                                    <Button size="sm" variant="secondary" onClick={check} disabled={checking}>
                                        {checking ? t('settings.spaceyard.checking') : t('settings.spaceyard.check')}
                                    </Button>
                                    <Button size="sm" variant="secondary" onClick={() => save('')} disabled={saving}>
                                        {t('settings.spaceyard.keyRemove')}
                                    </Button>
                                </>
                            )}
                        </div>
                        {error && <p className={ERROR_CLASS}>{error}</p>}
                        {checked && !checked.ok && <p className={ERROR_CLASS}>{checked.error}</p>}
                        {checked?.ok && (
                            <p className="text-xs text-emerald-700 dark:text-emerald-400">
                                {t('settings.spaceyard.checkedOk', {
                                    startable: checked.startable,
                                    images: checked.images,
                                    used: checked.running?.used ?? 0,
                                    max: checked.running?.max ?? 0,
                                })}
                            </p>
                        )}
                    </div>
                </Detail>

                <Detail title={t('settings.spaceyard.idle')} description={t('settings.spaceyard.idleDesc')}>
                    <Select
                        value={String(IDLE_CHOICES.includes(idle) ? idle : 15)}
                        onChange={(value) => update({ spaceyardIdle: Number(value) })}
                        className={`${FIELD} max-w-[12rem]`}
                        aria-label={t('settings.spaceyard.idle')}
                        options={IDLE_CHOICES.map(minutes => ({
                            value: String(minutes),
                            label: minutes < 60
                                ? t('settings.spaceyard.minutes', { count: minutes })
                                : t('settings.spaceyard.hours', { count: minutes / 60 }),
                        }))}
                    />
                </Detail>

                <Detail title={t('settings.spaceyard.destroy')} description={t('settings.spaceyard.destroyDesc')}>
                    <Select
                        value={String(DESTROY_CHOICES.includes(destroy) ? destroy : 1440)}
                        onChange={(value) => update({ spaceyardDestroy: Number(value) })}
                        className={`${FIELD} max-w-[12rem]`}
                        aria-label={t('settings.spaceyard.destroy')}
                        options={DESTROY_CHOICES.map(minutes => ({ value: String(minutes), label: destroyLabel(minutes) }))}
                    />
                </Detail>
            </div>
        </Capability>
    );
}
