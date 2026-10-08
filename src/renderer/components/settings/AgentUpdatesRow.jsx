import { useCallback, useState } from 'react';
import { Loading03Icon, Refresh01Icon } from 'hugeicons-react';
import Button from '../ui/Button';
import CopyButton from '../ui/CopyButton';
import SettingRow from './ui/SettingRow';
import ProviderMark from '../../lib/provider-marks';
import { PROVIDER_NAMES } from '../../lib/ai-catalog';
import { useT } from '../../i18n';

/**
 * Whether each switched-on agent's CLI is the newest one out.
 *
 * Checked when asked, never on its own: the answer means starting every
 * installed runtime once and asking the registry each is published to (see
 * main's agent-versions.js). Nothing is installed from here. Most of these
 * update themselves, and the one command that updates a stale one is shown
 * beside it to copy.
 */

/** The agents that are an address and a key rather than a program here. */
const NO_CLI = new Set(['local', 'openai']);

function statusLine(t, result) {
    switch (result.status) {
        case 'available':
            return t('settings.assistant.updatesAvailable', { installed: result.installed, latest: result.latest });
        case 'current':
            return t('settings.assistant.updatesCurrent', { version: result.installed });
        case 'missing':
            return t('settings.assistant.updatesMissing');
        case 'error':
            return result.installed
                ? t('settings.assistant.updatesOffline', { version: result.installed })
                : t('settings.assistant.updatesFailed');
        default:
            return result.installed
                ? t('settings.assistant.updatesInstalledOnly', { version: result.installed })
                : t('settings.assistant.updatesUnreadable');
    }
}

export default function AgentUpdatesRow({ activated, className = '' }) {
    const t = useT();
    const agents = activated.filter(provider => !NO_CLI.has(provider));
    const [checking, setChecking] = useState(false);
    const [results, setResults] = useState(null);

    const check = useCallback(async () => {
        setChecking(true);
        try {
            const answer = await window.api.ai.agentVersions({ providers: agents });
            setResults(Array.isArray(answer) ? answer : []);
        } catch {
            setResults([]);
        } finally {
            setChecking(false);
        }
        // `agents` is derived from `activated`; its joined names are the key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agents.join(' ')]);

    if (agents.length === 0) return null;

    // In the order the page lists the agents, and only those still on.
    const shown = results
        ? agents.map(provider => results.find(result => result.provider === provider)).filter(Boolean)
        : [];

    return (
        <SettingRow
            className={className}
            title={t('settings.assistant.updates')}
            description={t('settings.assistant.updatesDesc')}
            control={
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={checking}
                    icon={checking
                        ? <Loading03Icon size={13} strokeWidth={2} className="animate-spin" />
                        : <Refresh01Icon size={13} strokeWidth={2} />}
                    onClick={check}
                >
                    {checking ? t('settings.assistant.updatesChecking') : t('settings.assistant.updatesCheck')}
                </Button>
            }
        >
            {results && (
                shown.length === 0 ? (
                    <p className="text-[13px] text-gray-500 dark:text-gray-400">{t('settings.assistant.updatesFailed')}</p>
                ) : (
                    <ul className="space-y-1">
                        {shown.map(result => (
                            <li
                                key={result.provider}
                                className="group rounded-xl px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-white/[0.03] transition-colors"
                            >
                                <div className="flex items-center gap-2.5">
                                    <span className="shrink-0 leading-none">
                                        <ProviderMark provider={result.provider} size={18} />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-900 dark:text-gray-100">
                                        {PROVIDER_NAMES[result.provider] || result.provider}
                                    </span>
                                    <span
                                        title={result.path || undefined}
                                        className={`shrink-0 text-xs tabular-nums ${result.status === 'available'
                                            ? 'font-medium text-gray-900 dark:text-white'
                                            : 'text-gray-400 dark:text-neutral-500'}`}
                                    >
                                        {statusLine(t, result)}
                                    </span>
                                </div>
                                {result.status === 'available' && result.update && (
                                    <div className="mt-1 ml-[1.75rem] flex items-center gap-1.5 min-w-0">
                                        <code className="min-w-0 truncate font-jetbrains text-[11px] text-gray-500 dark:text-gray-400">
                                            {result.update}
                                        </code>
                                        <CopyButton text={result.update} label={t('settings.assistant.updatesCopy')} />
                                    </div>
                                )}
                                {result.status === 'available' && result.managedBy && (
                                    <p className="mt-1 ml-[1.75rem] text-[11px] text-gray-500 dark:text-gray-400">
                                        {result.managedBy === 'editor'
                                            ? t('settings.assistant.updatesByEditor')
                                            : t('settings.assistant.updatesByApp', { agent: PROVIDER_NAMES[result.provider] || result.provider })}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                )
            )}
        </SettingRow>
    );
}
