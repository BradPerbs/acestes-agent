import { useCallback, useEffect, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Button from '../ui/Button';
import { useAgents } from '../../hooks/useAgents';
import { useT } from '../../i18n';

/**
 * Who the selected agent is: its name, and the standing instructions every
 * conversation it has is opened with.
 *
 * Above the runtime settings rather than among them, because those describe
 * how the agent runs and this describes what it is. Both are the selected
 * agent's, which is what the sidebar's agent menu changes.
 */

const FIELD_CLASS = `w-full px-3 py-2 rounded-xl text-sm bg-white dark:bg-neutral-800
    border border-gray-300 dark:border-neutral-700
    text-gray-900 dark:text-gray-100 outline-none
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;

export default function AgentIdentitySection() {
    const t = useT();
    const { active, save } = useAgents();
    const [name, setName] = useState('');
    const [instructions, setInstructions] = useState('');
    const [savedInstructions, setSavedInstructions] = useState('');

    // The name follows the agent selected; a rename typed but not yet saved
    // is dropped when the agent changes under it, since it was for the other.
    useEffect(() => {
        setName(active?.name || '');
    }, [active?.id, active?.name]);

    useEffect(() => {
        let cancelled = false;
        window.api.ai.status().then((status) => {
            if (cancelled) return;
            const text = status?.settings?.instructions || '';
            setInstructions(text);
            setSavedInstructions(text);
        }).catch(() => {});
        // The settings on screen are the selected agent's, so a change of
        // agent arrives here as a change of settings.
        const off = window.api.ai.onSettings((next) => {
            const text = next?.instructions || '';
            setInstructions(text);
            setSavedInstructions(text);
        });
        return () => {
            cancelled = true;
            off?.();
        };
    }, [active?.id]);

    const saveName = useCallback(async () => {
        const trimmed = name.trim();
        if (!active || !trimmed || trimmed === active.name) return;
        await save({ id: active.id, name: trimmed });
    }, [active, name, save]);

    const saveInstructions = useCallback(async () => {
        if (instructions === savedInstructions) return;
        const next = await window.api.ai.setSettings({ instructions });
        setSavedInstructions(next?.instructions || '');
    }, [instructions, savedInstructions]);

    return (
        <SettingCard>
            <SettingRow
                title={t('settings.agent.name')}
                description={t('settings.agent.nameDesc')}
                control={(
                    <div className="flex items-center gap-2 w-full max-w-xs">
                        <input
                            type="text"
                            value={name}
                            maxLength={60}
                            onChange={(event) => setName(event.target.value)}
                            onBlur={saveName}
                            onKeyDown={(event) => { if (event.key === 'Enter') saveName(); }}
                            className={FIELD_CLASS}
                        />
                    </div>
                )}
            />
            <SettingRow
                title={t('settings.agent.instructions')}
                description={t('settings.agent.instructionsDesc')}
                className={DIVIDED}
            >
                <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    rows={5}
                    maxLength={4000}
                    spellCheck={false}
                    placeholder={t('settings.agent.instructionsPlaceholder')}
                    className={`${FIELD_CLASS} resize-y font-mono text-xs leading-relaxed`}
                />
                <div className="mt-2 flex justify-end">
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={instructions === savedInstructions}
                        onClick={saveInstructions}
                    >
                        {t('common.save')}
                    </Button>
                </div>
            </SettingRow>
        </SettingCard>
    );
}
