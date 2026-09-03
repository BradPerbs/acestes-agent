import { useCallback, useEffect, useState } from 'react';
import { PlusSignIcon, Delete02Icon } from 'hugeicons-react';
import SettingCard from './ui/SettingCard';
import Toggle from './ui/Toggle';
import Button, { IconButton } from '../ui/Button';
import Select from '../ui/Select';
import { FIELD_CLASS } from '../ui/Field';
import { useT } from '../../i18n';

/**
 * The hooks one agent runs: a command of the user's at four moments of the
 * agent's work. Stored on the agent record beside its MCP servers, and run
 * by the main process inside the agent's granted folders, so they apply to
 * every runtime the agent may be on.
 */

const EVENTS = ['pre-tool', 'post-tool', 'run-start', 'run-end'];

export default function HooksCard({ agentId }) {
    const t = useT();
    const [hooks, setHooks] = useState(null);

    const load = useCallback(async () => {
        const snapshot = await window.api.agents.list();
        const agent = snapshot?.agents?.find(entry => entry.id === agentId);
        setHooks(agent?.hooks || []);
    }, [agentId]);

    useEffect(() => {
        if (!agentId) return undefined;
        load().catch(() => {});
        return window.api.agents.onChange(() => { load().catch(() => {}); });
    }, [agentId, load]);

    const save = useCallback(async (next) => {
        setHooks(next);
        await window.api.agents.save({ id: agentId, hooks: next });
    }, [agentId]);

    if (!hooks) return null;

    const patch = (index, change) => save(hooks.map((hook, at) => (at === index ? { ...hook, ...change } : hook)));

    return (
        <SettingCard>
            <div className="mb-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{t('settings.assistant.hooks')}</h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('settings.assistant.hooksDesc')}</p>
            </div>

            {hooks.length > 0 && (
                <ul className="space-y-2 mb-3">
                    {hooks.map((hook, index) => (
                        <li key={hook.id} className="flex flex-col gap-2 rounded-lg px-3 py-2 bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700">
                            <div className="flex items-center gap-2">
                                <Select
                                    value={hook.event}
                                    onChange={(next) => patch(index, { event: next })}
                                    className={FIELD_CLASS}
                                    containerClassName="w-44 shrink-0"
                                    aria-label={t('settings.assistant.hooks.event')}
                                    options={EVENTS.map(event => ({ value: event, label: t(`settings.assistant.hooks.${event}`) }))}
                                />
                                {(hook.event === 'pre-tool' || hook.event === 'post-tool') && (
                                    <input
                                        type="text"
                                        defaultValue={hook.tools.join(', ')}
                                        onBlur={(event) => patch(index, { tools: event.target.value.split(',').map(entry => entry.trim()).filter(Boolean) })}
                                        placeholder={t('settings.assistant.hooks.toolsPlaceholder')}
                                        className={`${FIELD_CLASS} flex-1 font-jetbrains`}
                                        aria-label={t('settings.assistant.hooks.tools')}
                                    />
                                )}
                                <Toggle checked={hook.enabled} onChange={(value) => patch(index, { enabled: value })} ariaLabel={t('settings.assistant.hooks.enabled')} />
                                <IconButton label={t('common.delete')} onClick={() => save(hooks.filter((entry, at) => at !== index))}>
                                    <Delete02Icon size={15} strokeWidth={2} />
                                </IconButton>
                            </div>
                            <input
                                type="text"
                                defaultValue={hook.command}
                                onBlur={(event) => patch(index, { command: event.target.value })}
                                placeholder="python check.py"
                                className={`${FIELD_CLASS} font-jetbrains`}
                                aria-label={t('settings.assistant.hooks.command')}
                            />
                        </li>
                    ))}
                </ul>
            )}

            <Button
                size="sm"
                variant="secondary"
                onClick={() => save([...hooks, { id: `hook-${Date.now().toString(36)}`, event: 'pre-tool', command: '', tools: [], enabled: true }])}
            >
                <PlusSignIcon size={14} strokeWidth={2.5} /> {t('settings.assistant.hooks.add')}
            </Button>
            <p className="mt-3 text-[11px] text-gray-500 dark:text-gray-500">{t('settings.assistant.hooks.contract')}</p>
        </SettingCard>
    );
}
