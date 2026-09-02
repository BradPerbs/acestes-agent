import SettingsPage from '../ui/SettingsPage';
import AgentIdentitySection from '../AgentIdentitySection';
import AssistantSection from '../AssistantSection';
import { useAgents } from '../../../hooks/useAgents';
import { useT } from '../../../i18n';

/**
 * The selected agent: who it is, which model runs it, and what it is allowed
 * to do unattended. Everything on this page is that agent's; the sidebar's
 * agent menu is what changes which.
 */
export default function AssistantPage() {
    const t = useT();
    const { active } = useAgents();

    return (
        <SettingsPage
            title={active?.name || t('settings.assistant.title')}
            description={t('settings.assistant.desc')}
        >
            <AgentIdentitySection />
            <AssistantSection />
        </SettingsPage>
    );
}
