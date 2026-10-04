import { useCallback, useEffect, useRef, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import ConfirmDialog from '../ui/ConfirmDialog';
import VoiceCard from './VoiceCard';
import DoneSoundCard from './DoneSoundCard';
import useAssistantSettings, { FIELD_CLASS } from './useAssistantSettings';
import { SETTINGS_JUMP } from './SettingsNav';
import { useT } from '../../i18n';

/**
 * The conversation itself: the one-click questions on an empty chat, whether
 * the agent has a memory at all and writes down what it learned after a turn,
 * how long the history is kept, and speaking a message instead of typing it.
 */

const toText = (list) => (list || []).join('\n');

/** The periods the history can be kept for. 0 is forever, and the default. */
const HISTORY_PERIODS = [0, 30, 90, 365];

export default function ChatSection() {
    const t = useT();
    const { settings, update } = useAssistantSettings();
    const [prompts, setPrompts] = useState('');

    /**
     * The card a jump from the chat asked for. "Create quick prompts" on an
     * empty conversation lands here, and the card is scrolled into view, lit
     * for a moment, and its box given focus, once the settings are in and the
     * card exists. Asked again on a jump made while this page is already open,
     * since nothing remounts then.
     */
    const promptsRef = useRef(null);
    const promptsBoxRef = useRef(null);
    const [litPrompts, setLitPrompts] = useState(false);
    const [jumps, setJumps] = useState(0);

    useEffect(() => {
        const onJump = () => setJumps(count => count + 1);
        window.addEventListener(SETTINGS_JUMP, onJump);
        return () => window.removeEventListener(SETTINGS_JUMP, onJump);
    }, []);

    const loaded = Boolean(settings);
    useEffect(() => {
        if (!loaded) return undefined;
        let wanted = '';
        try {
            wanted = window.sessionStorage.getItem('settings.focus') || '';
            if (wanted === 'quickPrompts') window.sessionStorage.removeItem('settings.focus');
        } catch {
            // No session storage: nothing to land on.
        }
        if (wanted !== 'quickPrompts') return undefined;

        promptsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        promptsBoxRef.current?.focus({ preventScroll: true });
        setLitPrompts(true);
        const timer = setTimeout(() => setLitPrompts(false), 1800);
        return () => clearTimeout(timer);
    }, [loaded, jumps]);

    // Filled when the settings arrive and when the agent changes under the
    // page, never on an ordinary settings push, which would take away what
    // someone is halfway through typing.
    const agentId = settings?.agentId;
    useEffect(() => {
        if (settings) setPrompts(toText(settings.quickPrompts));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agentId, loaded]);

    const savePrompts = useCallback(async () => {
        const list = prompts.split('\n').map(line => line.trim()).filter(Boolean);
        const next = await update({ quickPrompts: list });
        setPrompts(toText(next.quickPrompts));
    }, [prompts, update]);

    /**
     * A shorter period deletes conversations the moment it is chosen, so it
     * is asked about first. A longer one, or forever, deletes nothing.
     */
    const [confirming, setConfirming] = useState(null);
    const currentDays = Number(settings?.historyDays) || 0;
    const chooseHistory = useCallback((next) => {
        const shorter = next > 0 && (currentDays === 0 || next < currentDays);
        if (!shorter) {
            update({ historyDays: next });
            return;
        }
        setConfirming({
            title: t('settings.chat.historyConfirmTitle'),
            message: t('settings.chat.historyConfirmMessage', { count: next }),
            confirmLabel: t('settings.chat.historyConfirm'),
            onConfirm: () => {
                setConfirming(null);
                update({ historyDays: next });
            },
        });
    }, [currentDays, update, t]);

    if (!settings) return <LoadingCard />;

    // On unless switched off: a config from before the setting existed has none.
    const memoryOn = settings.memory !== false;

    return (
        <>
            <div
                ref={promptsRef}
                className={`rounded-xl transition-shadow duration-500 ${litPrompts
                    ? 'ring-2 ring-offset-2 ring-gray-900/40 dark:ring-white/50 ring-offset-white dark:ring-offset-neutral-900'
                    : ''}`}
            >
                <SettingCard>
                    <SettingRow
                        title={t('settings.assistant.quickPrompts')}
                        description={t('settings.assistant.quickPromptsDesc')}
                    >
                        <div className="space-y-3">
                            <textarea
                                ref={promptsBoxRef}
                                aria-label={t('settings.assistant.quickPrompts')}
                                rows={5}
                                spellCheck={false}
                                placeholder={t('settings.assistant.quickPromptsPlaceholder')}
                                className={`${FIELD_CLASS} text-xs leading-relaxed resize-y
                                    placeholder:text-gray-500 dark:placeholder:text-neutral-400`}
                                value={prompts}
                                onChange={(event) => setPrompts(event.target.value)}
                            />
                            <div className="flex items-center gap-3">
                                <Button size="sm" variant="secondary" onClick={savePrompts}>
                                    {t('settings.assistant.savePrompts')}
                                </Button>
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                    {t('settings.assistant.quickPromptsNote')}
                                </span>
                            </div>
                        </div>
                    </SettingRow>
                </SettingCard>
            </div>

            <SettingCard>
                <SettingRow
                    title={t('settings.assistant.memory')}
                    description={t(memoryOn ? 'settings.assistant.memoryDesc' : 'settings.assistant.memoryOffDesc')}
                    control={
                        <Toggle
                            ariaLabel={t('settings.assistant.memory')}
                            checked={memoryOn}
                            onChange={(value) => update({ memory: value })}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.assistant.autoRemember')}
                    description={t('settings.assistant.autoRememberDesc')}
                    control={
                        <Toggle
                            ariaLabel={t('settings.assistant.autoRemember')}
                            checked={memoryOn && Boolean(settings.autoRemember)}
                            disabled={!memoryOn}
                            onChange={(value) => update({ autoRemember: value })}
                        />
                    }
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.assistant.groupToolCalls')}
                    description={t('settings.assistant.groupToolCallsDesc')}
                    control={
                        <Toggle
                            ariaLabel={t('settings.assistant.groupToolCalls')}
                            checked={settings.groupToolCalls !== false}
                            onChange={(value) => update({ groupToolCalls: value })}
                        />
                    }
                />
            </SettingCard>

            <SettingCard>
                <SettingRow
                    align="center"
                    title={t('settings.chat.history')}
                    description={t(currentDays > 0
                        ? 'settings.chat.historyDescLimited'
                        : 'settings.chat.historyDesc')}
                    control={
                        <SegmentedControl
                            ariaLabel={t('settings.chat.history')}
                            value={HISTORY_PERIODS.includes(currentDays) ? currentDays : 0}
                            onChange={chooseHistory}
                            segments={HISTORY_PERIODS.map(days => ({
                                value: days,
                                label: days === 0
                                    ? t('settings.chat.historyForever')
                                    : days === 365
                                        ? t('settings.chat.historyYear')
                                        : t('settings.chat.historyDays', { count: days }),
                            }))}
                        />
                    }
                />
            </SettingCard>

            <DoneSoundCard settings={settings} update={update} fieldClass={FIELD_CLASS} />

            <VoiceCard settings={settings} update={update} fieldClass={FIELD_CLASS} />

            {confirming && <ConfirmDialog {...confirming} onCancel={() => setConfirming(null)} />}
        </>
    );
}
