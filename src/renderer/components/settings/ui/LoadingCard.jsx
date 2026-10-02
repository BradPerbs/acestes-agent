import SettingCard from './SettingCard';
import { useT } from '../../../i18n';

/** What an agent page shows for the moment before its settings arrive. */
export default function LoadingCard() {
    const t = useT();

    return (
        <SettingCard>
            <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('settings.assistant.loading')}
            </p>
        </SettingCard>
    );
}
