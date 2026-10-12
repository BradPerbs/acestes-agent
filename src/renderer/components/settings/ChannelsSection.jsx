import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { TelegramIcon } from 'hugeicons-react';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import Select from '../ui/Select';
import SegmentedControl from '../ui/SegmentedControl';
import ConfirmDialog from '../ui/ConfirmDialog';
import { FIELD_CLASS } from './useAssistantSettings';
import { useAgents } from '../../hooks/useAgents';
import { toastOptions } from '../../lib/toast';
import { formatDate } from '../../lib/format';
import { useT } from '../../i18n';

/**
 * Talking to the agent from the phone, through the user's own Telegram bot.
 *
 * Three states, one card: no bot yet (how to make one, and where the token
 * goes), a bot with nobody paired (the one-time link), and a paired account
 * (what it may do from there). The status is main's: the poll runs there,
 * and is pushed here on `channels-changed` as it moves. The token is sent
 * once, on Connect, and never comes back.
 */

const STATE_TONES = {
    running: 'bg-emerald-500',
    starting: 'bg-amber-400',
    locked: 'bg-amber-400',
    offline: 'bg-amber-400',
    conflict: 'bg-red-500',
    webhook: 'bg-red-500',
    unauthorized: 'bg-red-500',
    error: 'bg-red-500',
    off: 'bg-gray-400 dark:bg-neutral-600',
};

function StatePill({ telegram, t }) {
    const state = telegram.enabled ? telegram.state : 'off';
    return (
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${STATE_TONES[state] || STATE_TONES.off}`} />
            {t(`settings.channels.state.${state}`)}
        </span>
    );
}

/** Minutes left on a pairing link, ticking down while it is on screen. */
function useMinutesLeft(expiresAt) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!expiresAt) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(timer);
    }, [expiresAt]);
    return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 60000)) : 0;
}

export default function ChannelsSection() {
    const t = useT();
    const { agents } = useAgents();
    const [status, setStatus] = useState(null);
    const [token, setToken] = useState('');
    const [busy, setBusy] = useState('');
    const [confirm, setConfirm] = useState('');

    useEffect(() => {
        let alive = true;
        window.api.channels.status()
            .then((next) => { if (alive) setStatus(next); })
            .catch(() => { if (alive) setStatus({ telegram: null }); });
        const off = window.api.channels.onChanged((next) => setStatus(next));
        return () => {
            alive = false;
            off?.();
        };
    }, []);

    const telegram = status?.telegram || null;
    const minutesLeft = useMinutesLeft(telegram?.pairing?.expiresAt || 0);

    /** One call to main, with the button that made it marked busy and any error toasted. */
    const run = useCallback(async (key, call, success = '') => {
        setBusy(key);
        try {
            const result = await call();
            if (result?.error) {
                toast.error(result.error, toastOptions());
                return null;
            }
            if (result?.telegram) setStatus(result);
            if (success) toast.success(success, toastOptions());
            return result;
        } catch (error) {
            toast.error(error?.message || t('settings.channels.failed'), toastOptions());
            return null;
        } finally {
            setBusy('');
        }
    }, [t]);

    const connect = async () => {
        const result = await run('connect', () => window.api.channels.telegram.connect(token.trim()), t('settings.channels.connected'));
        if (result) setToken('');
    };

    const openLink = (url) => window.api.links.open(url);

    if (!status) return <LoadingCard />;
    if (!telegram) {
        return (
            <SettingCard>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.channels.unavailable')}</p>
            </SettingCard>
        );
    }

    const bot = telegram.bot ? `@${telegram.bot.username}` : '';
    const problem = ['conflict', 'webhook', 'unauthorized', 'error', 'offline', 'locked'].includes(telegram.state) && telegram.enabled
        ? telegram.message
        : '';

    return (
        <>
            <SettingCard>
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                        <TelegramIcon size={22} strokeWidth={1.5} className="shrink-0 mt-0.5 text-gray-900 dark:text-white" />
                        <div className="min-w-0">
                            <h4 className="text-base font-semibold text-gray-900 dark:text-white">{t('settings.channels.telegram')}</h4>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('settings.channels.telegramDesc')}</p>
                        </div>
                    </div>
                    {telegram.connected && <StatePill telegram={telegram} t={t} />}
                </div>

                {problem && (
                    <div className="mt-4 rounded-lg px-3 py-2 text-xs leading-relaxed bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300">
                        {problem}
                    </div>
                )}

                {!telegram.connected && (
                    <div className={DIVIDED}>
                        <ol className="flex flex-col gap-4 text-sm text-gray-700 dark:text-gray-300">
                            <li className="flex flex-col gap-2">
                                <span>{t('settings.channels.step1')}</span>
                                <div>
                                    <Button size="sm" variant="outline" onClick={() => openLink('https://t.me/BotFather')}>
                                        {t('settings.channels.openBotFather')}
                                    </Button>
                                </div>
                            </li>
                            <li className="flex flex-col gap-2">
                                <span>{t('settings.channels.step2')}</span>
                                <form
                                    className="flex gap-2"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        if (token.trim()) connect();
                                    }}
                                >
                                    <input
                                        type="password"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={token}
                                        onChange={event => setToken(event.target.value)}
                                        placeholder="123456789:AA..."
                                        aria-label={t('settings.channels.token')}
                                        className={`${FIELD_CLASS} font-jetbrains`}
                                    />
                                    <Button type="submit" variant="primary" disabled={!token.trim() || busy === 'connect'}>
                                        {busy === 'connect' ? t('settings.channels.connecting') : t('settings.channels.connect')}
                                    </Button>
                                </form>
                                <span className="text-xs text-gray-500 dark:text-gray-400">{t('settings.channels.tokenNote')}</span>
                            </li>
                        </ol>
                    </div>
                )}

                {telegram.connected && !telegram.owner && (
                    <SettingRow
                        className={DIVIDED}
                        title={t('settings.channels.pairTitle')}
                        description={t('settings.channels.pairDesc', { bot })}
                        control={!telegram.pairing && (
                            <Button variant="primary" disabled={busy === 'pair'} onClick={() => run('pair', () => window.api.channels.telegram.pair())}>
                                {t('settings.channels.pair')}
                            </Button>
                        )}
                    >
                        {telegram.pairing && (
                            <div className="flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-neutral-700 p-4">
                                <p className="text-sm text-gray-700 dark:text-gray-300">{t('settings.channels.pairHow')}</p>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button variant="primary" onClick={() => openLink(telegram.pairing.link)}>
                                        {t('settings.channels.openTelegram')}
                                    </Button>
                                    <Button variant="ghost" onClick={() => run('cancel', () => window.api.channels.telegram.cancelPair())}>
                                        {t('settings.channels.cancel')}
                                    </Button>
                                </div>
                                <p className="text-xs text-gray-500 dark:text-gray-400 break-all">
                                    {t('settings.channels.pairManual', { bot })}{' '}
                                    <code className="font-jetbrains text-gray-900 dark:text-white select-all">/start {telegram.pairing.code}</code>
                                </p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">
                                    {t('settings.channels.pairExpires', { count: minutesLeft })}
                                </p>
                            </div>
                        )}
                    </SettingRow>
                )}

                {telegram.connected && telegram.owner && (
                    <>
                        <SettingRow
                            className={DIVIDED}
                            title={t('settings.channels.pairedWith', {
                                name: telegram.owner.username ? `${telegram.owner.name} (@${telegram.owner.username})` : telegram.owner.name,
                            })}
                            description={t('settings.channels.pairedDesc', {
                                bot,
                                when: telegram.owner.pairedAt ? formatDate(telegram.owner.pairedAt) : '',
                            })}
                            control={(
                                <div className="flex gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={busy === 'test' || !telegram.enabled}
                                        onClick={() => run('test', () => window.api.channels.telegram.test(), t('settings.channels.testSent'))}
                                    >
                                        {t('settings.channels.test')}
                                    </Button>
                                    <Button variant="dangerGhost" onClick={() => setConfirm('unpair')}>
                                        {t('settings.channels.unpair')}
                                    </Button>
                                </div>
                            )}
                        />

                        <SettingRow
                            className={DIVIDED}
                            align="center"
                            title={t('settings.channels.enabled')}
                            description={t('settings.channels.enabledDesc')}
                            control={(
                                <Toggle
                                    checked={telegram.enabled}
                                    ariaLabel={t('settings.channels.enabled')}
                                    onChange={value => run('enabled', () => window.api.channels.telegram.update({ enabled: value }))}
                                />
                            )}
                        />

                        <SettingRow
                            className={DIVIDED}
                            title={t('settings.channels.agent')}
                            description={t('settings.channels.agentDesc')}
                            control={(
                                <div className="w-56">
                                    <Select
                                        value={telegram.agentId || ''}
                                        onChange={value => run('agent', () => window.api.channels.telegram.update({ agentId: value }))}
                                        className={FIELD_CLASS}
                                        aria-label={t('settings.channels.agent')}
                                        options={[
                                            { value: '', label: t('settings.channels.agentSelected') },
                                            ...agents.map(agent => ({ value: agent.id, label: agent.name })),
                                        ]}
                                    />
                                </div>
                            )}
                        />

                        <SettingRow
                            className={DIVIDED}
                            title={t('settings.channels.approvals')}
                            description={t('settings.channels.approvalsDesc')}
                        >
                            <SegmentedControl
                                ariaLabel={t('settings.channels.approvals')}
                                value={telegram.approvals}
                                onChange={value => run('approvals', () => window.api.channels.telegram.update({ approvals: value }))}
                                segments={[
                                    { value: 'ask', label: t('settings.channels.approvalsAsk') },
                                    { value: 'agent', label: t('settings.channels.approvalsAgent') },
                                ]}
                            />
                        </SettingRow>
                    </>
                )}

                {telegram.connected && (
                    <SettingRow
                        className={DIVIDED}
                        title={t('settings.channels.bot', { bot })}
                        description={t('settings.channels.botDesc')}
                        control={(
                            <Button variant="dangerOutline" onClick={() => setConfirm('disconnect')}>
                                {t('settings.channels.disconnect')}
                            </Button>
                        )}
                    />
                )}
            </SettingCard>

            <SettingCard>
                <SettingRow title={t('settings.channels.howTitle')} description={t('settings.channels.howDesc')}>
                    <ul className="flex flex-col gap-2 text-sm text-gray-600 dark:text-gray-400 list-disc pl-5">
                        <li>{t('settings.channels.howCommands')}</li>
                        <li>{t('settings.channels.howTray')}</li>
                        <li>{t('settings.channels.howStale')}</li>
                        <li>{t('settings.channels.howSecrets')}</li>
                        <li>{t('settings.channels.howJobs')}</li>
                    </ul>
                </SettingRow>
            </SettingCard>

            {confirm === 'unpair' && (
                <ConfirmDialog
                    title={t('settings.channels.unpairTitle')}
                    message={t('settings.channels.unpairMessage')}
                    confirmLabel={t('settings.channels.unpair')}
                    onConfirm={() => {
                        setConfirm('');
                        run('unpair', () => window.api.channels.telegram.unpair(), t('settings.channels.unpaired'));
                    }}
                    onCancel={() => setConfirm('')}
                />
            )}
            {confirm === 'disconnect' && (
                <ConfirmDialog
                    title={t('settings.channels.disconnectTitle')}
                    message={t('settings.channels.disconnectMessage', { bot })}
                    confirmLabel={t('settings.channels.disconnect')}
                    onConfirm={() => {
                        setConfirm('');
                        run('disconnect', () => window.api.channels.telegram.disconnect(), t('settings.channels.disconnected'));
                    }}
                    onCancel={() => setConfirm('')}
                />
            )}
        </>
    );
}
