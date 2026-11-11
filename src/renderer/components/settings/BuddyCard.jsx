import { useCallback, useEffect, useState } from 'react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import Toggle from './ui/Toggle';
import Select from '../ui/Select';
import Button from '../ui/Button';
import Reveal from '../ui/Reveal';
import { FIELD_CLASS } from './useAssistantSettings';
import useTrySay, { spokenEngine, voiceOptions } from './useTrySay';
import { SETTINGS_JUMP } from './SettingsNav';
import { useAgents } from '../../hooks/useAgents';
import { useT } from '../../i18n';

/** The tones, by the name main knows them by (main/ai/buddy-tone.js). */
const TONES = ['neutral', 'friendly', 'funny', 'memer', 'hype', 'serious'];
/** The most of the person's own words for it that are kept. */
const TONE_NOTE_CHARS = 200;

/**
 * How it talks: a tone (plain, friendly, funny, memer, hype, serious), and
 * the person's own words for it. It shapes the words of the spoken recap and
 * questions, and how lively the voice is (ElevenLabs' settings, OpenRouter's
 * direction to the models that take it). The voice itself is on the Voice page.
 */
function ToneSettings({ settings, update }) {
    const t = useT();
    const tone = TONES.includes(settings.buddyTone) ? settings.buddyTone : 'neutral';
    const saved = String(settings.buddyToneNote || '');
    const [note, setNote] = useState(saved);
    const trySay = useTrySay();

    // Changed elsewhere (another window): what is here follows.
    useEffect(() => setNote(saved), [saved]);

    const saveNote = () => {
        const clean = note.replace(/\s+/g, ' ').trim().slice(0, TONE_NOTE_CHARS);
        if (clean !== saved) update({ buddyToneNote: clean });
    };

    return (
        <SettingRow
            className={DIVIDED}
            title={t('settings.buddy.tone')}
            description={t('settings.buddy.toneDesc')}
        >
            <div className="space-y-2">
                <div className="w-72 max-w-full">
                    <Select
                        value={tone}
                        onChange={(value) => update({ buddyTone: value })}
                        className={FIELD_CLASS}
                        aria-label={t('settings.buddy.tone')}
                        options={TONES.map(name => ({ value: name, label: t(`settings.buddy.tone.${name}`) }))}
                    />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <input
                        type="text"
                        value={note}
                        maxLength={TONE_NOTE_CHARS}
                        spellCheck={false}
                        onChange={event => setNote(event.target.value)}
                        onBlur={saveNote}
                        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                        placeholder={t('settings.buddy.toneNotePlaceholder')}
                        aria-label={t('settings.buddy.toneNote')}
                        className={`${FIELD_CLASS} min-w-0 flex-1 max-w-md`}
                    />
                    {/* The tone's own sample line, in the voice as set: the words
                        above shape what the agent writes, not this line. */}
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={trySay.trying}
                        onClick={() => trySay.run({ ...voiceOptions(settings), tone, note })}
                    >
                        {trySay.trying ? t('settings.buddy.voiceTrying') : t('settings.buddy.voiceTry')}
                    </Button>
                </div>
                {trySay.error && <p className="text-xs text-red-600 dark:text-red-400">{trySay.error}</p>}
            </div>
        </SettingRow>
    );
}

/** Settings' Voice page, from here: where the voice it speaks in is picked. */
function openVoicePage() {
    try {
        window.localStorage.setItem('settings.category', 'voice');
    } catch {
        // No storage: the event alone does nothing, and the nav is still there.
    }
    window.dispatchEvent(new Event(SETTINGS_JUMP));
}

/**
 * Which voice says the recap, as set on the Voice page, with the way there:
 * the voice is the machine's, and is picked beside the microphone's.
 */
function VoiceSettings({ settings }) {
    const t = useT();
    const engine = spokenEngine(settings);
    return (
        <SettingRow
            className={DIVIDED}
            align="center"
            title={t('settings.buddy.voice')}
            description={t('settings.buddy.voiceOn', { voice: t(`settings.speech.engineName.${engine}`) })}
            control={(
                <Button size="sm" variant="secondary" onClick={openVoicePage}>
                    {t('settings.buddy.voiceOpen')}
                </Button>
            )}
        />
    );
}

/**
 * The buddy (main/ai/buddy.js): how an agent using this computer shows
 * itself, a notch at the top of the screen and a mark beside the cursor that
 * say what it is doing, whether it was asked in a chat or by voice. That part
 * has nothing to switch: it is there whenever an agent drives the desktop.
 *
 * Always on (Windows), it stays beside the cursor at rest too, and Ctrl+Alt
 * held anywhere talks to the agent, which sees the screen and where you
 * point and acts. Those settings are the machine's, like the voice it listens
 * with: which agent it talks to, how it sounds, whether its recap is read
 * aloud. What would stop it working is said here, with the way to fix it: an
 * agent that may not use this computer can answer but not act, and with
 * voice input off it cannot hear anything at all. Whether the notch shows
 * goes for both.
 */
export default function BuddyCard({ settings, update }) {
    const t = useT();
    const { agents } = useAgents();
    const [status, setStatus] = useState(null);
    const [allowing, setAllowing] = useState(false);
    // On for good needs the Windows helper's chord; a Mac shows the agents at work only.
    const always = window.api.platform === 'win32';

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

    const on = always && Boolean(settings.buddy);

    return (
        <SettingCard>
            <SettingRow
                title={t('settings.buddy.title')}
                description={t('settings.buddy.desc')}
            />

            {always && (
                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.buddy.always')}
                    description={t('settings.buddy.alwaysDesc')}
                    control={(
                        <Toggle
                            ariaLabel={t('settings.buddy.always')}
                            checked={on}
                            onChange={(value) => update({ buddy: value })}
                        />
                    )}
                />
            )}

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

                <ToneSettings settings={settings} update={update} />

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
                    <VoiceSettings settings={settings} />
                </Reveal>
            </Reveal>

            {/* For the agents at work as much as for always on. */}
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
            {/* Moved by dragging the notch itself; put back from here. */}
            <Reveal open={settings.buddyNotch !== false}>
                <SettingRow
                    className={DIVIDED}
                    align="center"
                    title={t('settings.buddy.notchPlace')}
                    description={t(settings.buddyNotchPlace ? 'settings.buddy.notchPlaceMoved' : 'settings.buddy.notchPlaceDesc')}
                    control={(
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={!settings.buddyNotchPlace}
                            onClick={() => update({ buddyNotchPlace: null })}
                        >
                            {t('settings.buddy.notchPlaceReset')}
                        </Button>
                    )}
                />
            </Reveal>
        </SettingCard>
    );
}
