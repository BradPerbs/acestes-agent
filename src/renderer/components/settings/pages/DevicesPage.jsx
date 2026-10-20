import SettingsPage from '../ui/SettingsPage';
import DevicesSection from '../DevicesSection';
import { useT } from '../../../i18n';

/** The user's other computers with Acestes on them, as one fleet. See DevicesSection. */
export default function DevicesPage() {
    const t = useT();

    return (
        <SettingsPage title={t('settings.devices.title')} description={t('settings.devices.desc')}>
            <DevicesSection />
        </SettingsPage>
    );
}
