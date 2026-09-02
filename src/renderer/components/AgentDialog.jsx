import { useState } from 'react';
import Dialog from './ui/Dialog';
import Button from './ui/Button';
import Field, { FIELD_CLASS } from './ui/Field';
import AgentMark from './assistant/AgentMark';
import { AGENT_COLORS } from '../lib/agent-colors';
import { useT } from '../i18n';

/**
 * Naming an agent, new or renamed, and picking its colour.
 *
 * The colour is what tells one agent's mark from another's across the app,
 * so it is chosen here, where the agent is made, with the mark itself drawn
 * in each colour on offer rather than a row of paint chips.
 */
export default function AgentDialog({ agent = null, suggestedColor = '', onClose, onSave }) {
    const t = useT();
    const [name, setName] = useState(agent?.name || '');
    const [color, setColor] = useState(agent?.color || suggestedColor || AGENT_COLORS[0].id);
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        try {
            await onSave(trimmed, color);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog
            title={agent ? t('agents.renameTitle') : t('agents.newTitle')}
            subtitle={agent ? undefined : t('agents.newSubtitle')}
            onClose={onClose}
            footer={(
                <>
                    <Button onClick={onClose}>{t('common.cancel')}</Button>
                    <Button variant="primary" onClick={submit} disabled={!name.trim() || saving}>
                        {agent ? t('common.save') : t('agents.create')}
                    </Button>
                </>
            )}
        >
            <form
                onSubmit={(event) => { event.preventDefault(); submit(); }}
                className="flex flex-col gap-5"
            >
                <div className="flex items-center gap-4">
                    <AgentMark size={56} color={color} animated />
                    <Field label={t('agents.nameLabel')} className="flex-1">
                        <input
                            autoFocus
                            type="text"
                            value={name}
                            maxLength={60}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t('agents.namePlaceholder')}
                            className={FIELD_CLASS}
                        />
                    </Field>
                </div>

                <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {t('agents.colorLabel')}
                    </span>
                    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('agents.colorLabel')}>
                        {AGENT_COLORS.map(option => (
                            <button
                                key={option.id}
                                type="button"
                                role="radio"
                                aria-checked={color === option.id}
                                title={option.label}
                                onClick={() => setColor(option.id)}
                                className={`w-9 h-9 rounded-full flex items-center justify-center transition-all
                                    hover:scale-110 active:scale-95 outline-none
                                    ${color === option.id
                                        ? 'ring-2 ring-offset-2 ring-gray-900 dark:ring-white ring-offset-white dark:ring-offset-surface-raised'
                                        : 'focus-visible:ring-2 focus-visible:ring-gray-900/30 dark:focus-visible:ring-white/40'}`}
                            >
                                <AgentMark size={30} color={option.id} />
                            </button>
                        ))}
                    </div>
                </div>
            </form>
        </Dialog>
    );
}
