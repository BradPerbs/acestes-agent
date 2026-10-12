import SettingsPage from '../ui/SettingsPage';
import ChannelsSection from '../ChannelsSection';
import { useT } from '../../../i18n';

/** The agent reached from somewhere other than the app: Telegram, for now. See ChannelsSection. */
export default function ChannelsPage() {
    const t = useT();

    return (
        <SettingsPage title={t('settings.channels.title')} description={t('settings.channels.desc')}>
            <ChannelsSection />
        </SettingsPage>
    );
}
