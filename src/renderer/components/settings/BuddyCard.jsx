import { useCallback, useEffect, useRef, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Toggle from './ui/Toggle';
import Select from '../ui/Select';
import Button from '../ui/Button';
import Reveal from '../ui/Reveal';
import SegmentedControl from '../ui/SegmentedControl';
import { FIELD_CLASS } from './useAssistantSettings';
import { useAgents } from '../../hooks/useAgents';
import { bytesOf, createPcmPlayer } from '../../lib/pcm-player';
import { useT } from '../../i18n';

/** ElevenLabs' models, by id, as offered (see main/ai/elevenlabs.js). */
const MODELS = [
    { value: 'eleven_v4', label: 'Eleven v4' },
    { value: 'eleven_flash_v2_5', label: 'Flash v2.5' },
];

/**
 * Whose voice says the recap: this computer's, or ElevenLabs', with the
 * key (typed once, kept in the keychain as `elevenlabs`, never shown again),
 * the model, the voice from the account's own list, and a sentence to try it.
 */
function VoiceSettings({ settings, update, status, onStatus }) {
    const t = useT();
    const engine = settings.buddyVoice === 'elevenlabs' ? 'elevenlabs' : 'system';
    const hasKey = Boolean(status?.voiceKey);
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const [keyError, setKeyError] = useState('');
    const [voices, setVoices] = useState(null);
    const [voicesError, setVoicesError] = useState('');
    const [trying, setTrying] = useState(false);
    const [tryError, setTryError] = useState('');
    const player = useRef(null);

    const loadVoices = useCallback(async () => {
        setVoicesError('');
        const result = await window.api.buddy.voices();
        if (result?.error) {
            setVoices(null);
            setVoicesError(result.error);
        } else {
            setVoices(result?.voices || []);
        }
    }, []);

    useEffect(() => {
        if (engine === 'elevenlabs' && hasKey) loadVoices();
    }, [engine, hasKey, loadVoices]);

    useEffect(() => () => player.current?.stop(), []);

    const saveKey = async (value) => {
        setSaving(true);
        setKeyError('');
        try {
            const next = await window.api.buddy.setVoiceKey(value);
            if (next?.keyError) setKeyError(next.keyError);
            else setKey('');
            onStatus(next);
        } finally {
            setSaving(false);
        }
    };

    const tryVoice = async () => {
        setTrying(true);
        setTryError('');
        try {
            const result = await window.api.buddy.tryVoice({ voiceId: settings.buddyVoiceId || '', model: settings.buddyVoiceModel || 'eleven_v4' });
            if (result?.error) {
                setTryError(result.error);
                return;
            }
            player.current?.stop();
            const next = createPcmPlayer(result.rate);
            player.current = next;
            next.push(bytesOf(result.data));
            next.end(() => {});
        } finally {
            setTrying(false);
        }
    };

    return (
        <>
            <SettingRow
                className={DIVIDED}
                title={t('settings.buddy.voice')}
                description={t(`settings.buddy.voice.${engine}`)}
            >
                <SegmentedControl
                    ariaLabel={t('settings.buddy.voice')}
                    segments={[
                        { value: 'system', label: t('settings.buddy.voiceSystem') },
                        { value: 'elevenlabs', label: 'ElevenLabs' },
                    ]}
                    value={engine}
                    onChange={(value) => update({ buddyVoice: value })}
                />
            </SettingRow>

            <Reveal open={engine === 'elevenlabs'}>
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.buddy.voiceKey')}
                    description={hasKey ? t('settings.buddy.voiceKeySaved') : t('settings.buddy.voiceKeyDesc')}
                >
                    <div className="space-y-2">
                        <div className="flex items-center gap-2">
                            <input
                                type="password"
                                autoComplete="off"
                                spellCheck={false}
                                value={key}
                                onChange={event => setKey(event.target.value)}
                                placeholder={hasKey ? t('settings.buddy.voiceKeyReplace') : 'sk_...'}
                                aria-label={t('settings.buddy.voiceKey')}
                                className={`${FIELD_CLASS} max-w-sm`}
                            />
                            <Button size="sm" variant="secondary" onClick={() => saveKey(key)} disabled={saving || !key.trim()}>
                                {t('settings.buddy.voiceKeySave')}
                            </Button>
                            {hasKey && (
                                <Button size="sm" variant="secondary" onClick={() => saveKey('')} disabled={saving}>
                                    {t('settings.buddy.voiceKeyRemove')}
                                </Button>
                            )}
                        </div>
                        {keyError && <p className="text-xs text-red-600 dark:text-red-400">{keyError}</p>}
                    </div>
                </SettingRow>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.buddy.voiceModel')}
                    description={t('settings.buddy.voiceModelDesc')}
                >
                    <SegmentedControl
                        ariaLabel={t('settings.buddy.voiceModel')}
                        segments={MODELS}
                        value={settings.buddyVoiceModel || 'eleven_v4'}
                        onChange={(value) => update({ buddyVoiceModel: value })}
                    />
                </SettingRow>

                {hasKey && (
                    <SettingRow
                        className={DIVIDED}
                        title={t('settings.buddy.voicePick')}
                        description={t('settings.buddy.voicePickDesc')}
                    >
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="w-64">
                                    <Select
                                        value={settings.buddyVoiceId || ''}
                                        onChange={(value) => update({ buddyVoiceId: value })}
                                        className={FIELD_CLASS}
                                        aria-label={t('settings.buddy.voicePick')}
                                        options={[
                                            { value: '', label: t('settings.buddy.voiceFirst') },
                                            ...(voices || []).map(voice => ({
                                                value: voice.id,
                                                label: voice.category ? `${voice.name} · ${voice.category}` : voice.name,
                                            })),
                                        ]}
                                    />
                                </div>
                                <Button size="sm" variant="secondary" onClick={tryVoice} disabled={trying}>
                                    {trying ? t('settings.buddy.voiceTrying') : t('settings.buddy.voiceTry')}
                                </Button>
                            </div>
                            {voicesError && <p className="text-xs text-red-600 dark:text-red-400">{voicesError}</p>}
                            {tryError && <p className="text-xs text-red-600 dark:text-red-400">{tryError}</p>}
                        </div>
                    </SettingRow>
                )}
            </Reveal>
        </>
    );
}

/**
 * The buddy (main/ai/buddy.js): Acestes in the background, a notch at the
 * top of the screen and a mark beside the cursor, Ctrl+Alt held anywhere to
 * talk to the agent, which sees the screen and where you point and acts.
 *
 * Its settings are the machine's, like the voice it listens with: whether it
 * is on, which agent it talks to, whether replies are read aloud, and whether
 * the notch shows. What would stop it working is said here, with the way to
 * fix it: an agent that may not use this computer can answer but not act,
 * and with voice input off it cannot hear anything at all.
 */
export default function BuddyCard({ settings, update }) {
    const t = useT();
    const { agents } = useAgents();
    const [status, setStatus] = useState(null);
    const [allowing, setAllowing] = useState(false);

    const check = useCallback(() => {
        window.api.buddy?.status().then(setStatus).catch(() => setStatus(null));
    }, []);

    // Read again whenever a setting changes, here or anywhere.
    useEffect(() => {
        check();
    }, [check, settings.buddy, settings.buddyAgent, settings.buddyVoice, settings.computerUse, settings.agentId, settings.voiceInput]);

    const allow = async () => {
        setAllowing(true);
        try {
            setStatus(await window.api.buddy.allowComputer());
        } finally {
            setAllowing(false);
        }
    };

    const on = Boolean(settings.buddy);

    return (
        <SettingCard>
            <SettingRow
                align="center"
                title={t('settings.buddy.title')}
                description={t('settings.buddy.desc')}
                control={(
                    <Toggle
                        ariaLabel={t('settings.buddy.title')}
                        checked={on}
                        onChange={(value) => update({ buddy: value })}
                    />
                )}
            />

            <Reveal open={on}>
                <div className="mt-3 space-y-3 text-xs">
                    <p className="text-gray-500 dark:text-gray-400">{t('settings.buddy.background')}</p>
                    {status && !status.computerUse && (
                        <div className="space-y-2">
                            <p className="text-amber-600 dark:text-amber-400">{t('settings.buddy.needsComputer')}</p>
                            <Button size="sm" variant="secondary" onClick={allow} disabled={allowing}>
                                {t('settings.buddy.allowComputer')}
                            </Button>
                        </div>
                    )}
                    {status && !status.voiceInput && (
                        <p className="text-amber-600 dark:text-amber-400">{t('settings.buddy.needsVoice')}</p>
                    )}
                </div>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.buddy.agent')}
                    description={t('settings.buddy.agentDesc')}
                    control={(
                        <div className="w-56">
                            <Select
                                value={settings.buddyAgent || ''}
                                onChange={(value) => update({ buddyAgent: value })}
                                className={FIELD_CLASS}
                                aria-label={t('settings.buddy.agent')}
                                options={[
                                    { value: '', label: t('settings.buddy.agentSelected') },
                                    ...agents.map(agent => ({ value: agent.id, label: agent.name })),
                                ]}
                            />
                        </div>
                    )}
                />

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.buddy.speak')}
                    description={t('settings.buddy.speakDesc')}
                    control={(
                        <Toggle
                            ariaLabel={t('settings.buddy.speak')}
                            checked={settings.buddySpeak !== false}
                            onChange={(value) => update({ buddySpeak: value })}
                        />
                    )}
                />
                <Reveal open={settings.buddySpeak !== false}>
                    <VoiceSettings settings={settings} update={update} status={status} onStatus={setStatus} />
                </Reveal>

                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.buddy.notch')}
                    description={t('settings.buddy.notchDesc')}
                    control={(
                        <Toggle
                            ariaLabel={t('settings.buddy.notch')}
                            checked={settings.buddyNotch !== false}
                            onChange={(value) => update({ buddyNotch: value })}
                        />
                    )}
                />
            </Reveal>
        </SettingCard>
    );
}
