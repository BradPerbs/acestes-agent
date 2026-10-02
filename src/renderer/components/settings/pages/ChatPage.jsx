import SettingsPage from '../ui/SettingsPage';
import ChatSection from '../ChatSection';
import { useAgents } from '../../../hooks/useAgents';
import { useT } from '../../../i18n';

/** Quick prompts, memory after a turn, and voice input. See ChatSection. */
export default function ChatPage() {
    const t = useT();
    const { active } = useAgents();

    return (
        <SettingsPage
            title={t('settings.chat.title')}
            description={t('settings.chat.desc', { name: active?.name || t('settings.assistant.title') })}
        >
            <ChatSection />
        </SettingsPage>
    );
}
