import SettingsPage from '../ui/SettingsPage';
import PermissionsSection from '../PermissionsSection';
import { useAgents } from '../../../hooks/useAgents';
import { useT } from '../../../i18n';

/** What the selected agent may do without asking. See PermissionsSection. */
export default function PermissionsPage() {
    const t = useT();
    const { active } = useAgents();

    return (
        <SettingsPage
            title={t('settings.permissions.title')}
            description={t('settings.permissions.desc', { name: active?.name || t('settings.assistant.title') })}
        >
            <PermissionsSection />
        </SettingsPage>
    );
}
