import SettingsPage from '../ui/SettingsPage';
import AgenticSection from '../AgenticSection';
import { useAgents } from '../../../hooks/useAgents';
import { useT } from '../../../i18n';

/**
 * What the selected agent can reach and operate: the servers, this computer,
 * its desktop apps and a browser. See AgenticSection.
 */
export default function AgenticPage() {
    const t = useT();
    const { active } = useAgents();

    return (
        <SettingsPage
            title={t('settings.agentic.title')}
            description={t('settings.agentic.desc', { name: active?.name || t('settings.assistant.title') })}
        >
            <AgenticSection />
        </SettingsPage>
    );
}
