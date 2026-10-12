import SettingsPage from '../ui/SettingsPage';
import ChannelsSection from '../ChannelsSection';
import { useT } from '../../../i18n';

/** The agent reached from a chat app: Telegram, Discord, Slack, Matrix. See ChannelsSection. */
export default function ChannelsPage() {
    const t = useT();

    return (
        <SettingsPage title={t('settings.channels.title')} description={t('settings.channels.desc')}>
            <ChannelsSection />
        </SettingsPage>
    );
}
