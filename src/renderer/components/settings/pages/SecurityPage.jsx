import SettingsPage from '../ui/SettingsPage';
import AppLockSection from '../AppLockSection';
import { useT } from '../../../i18n';

/**
 * Who can open the app. The server keys it trusts used to be here too; they
 * are a property of the servers, and live on that page now.
 */
export default function SecurityPage() {
    const t = useT();

    return (
        <SettingsPage title={t('settings.security.title')} description={t('settings.security.desc')}>
            <AppLockSection />
        </SettingsPage>
    );
}
