import SettingsPage from '../ui/SettingsPage';
import BackupSection from '../BackupSection';
import { useT } from '../../../i18n';

/**
 * Encrypted export and restore only. Importing from OpenSSH and from other
 * apps used to live here too; those are SSH setup and sit under SSH & Servers
 * as the Import tab now, so this page stays about backups.
 */
export default function BackupPage({ onDataImported }) {
    const t = useT();

    return (
        <SettingsPage title={t('settings.backup.title')} description={t('settings.backup.desc')}>
            <BackupSection onRestored={onDataImported} />
        </SettingsPage>
    );
}
