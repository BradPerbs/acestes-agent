import SettingsPage from '../ui/SettingsPage';
import LoadingCard from '../ui/LoadingCard';
import VoiceCard from '../VoiceCard';
import SpokenVoiceCard from '../SpokenVoiceCard';
import useAssistantSettings, { FIELD_CLASS } from '../useAssistantSettings';
import { useT } from '../../../i18n';

/**
 * Everything to do with voice, both ways: speaking to the agent (the
 * composer's microphone and the buddy's Ctrl+Alt, VoiceCard), and the voice
 * it answers in out loud (this computer's, ElevenLabs or OpenRouter,
 * SpokenVoiceCard). Both are the machine's, like the microphone and the
 * speakers they use.
 */
export default function VoicePage() {
    const t = useT();
    const { settings, update } = useAssistantSettings();

    return (
        <SettingsPage title={t('settings.voicePage.title')} description={t('settings.voicePage.desc')}>
            {settings ? (
                <>
                    <VoiceCard settings={settings} update={update} fieldClass={FIELD_CLASS} />
                    <SpokenVoiceCard settings={settings} update={update} />
                </>
            ) : (
                <LoadingCard />
            )}
        </SettingsPage>
    );
}
