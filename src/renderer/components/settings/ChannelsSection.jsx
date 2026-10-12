import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { ArrowDown01Icon } from 'hugeicons-react';
import ChannelMark from '../../lib/channel-marks';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import Select from '../ui/Select';
import ConfirmDialog from '../ui/ConfirmDialog';
import CopyButton from '../ui/CopyButton';
import { FIELD_CLASS } from './useAssistantSettings';
import { useAgents } from '../../hooks/useAgents';
import { toastOptions } from '../../lib/toast';
import { formatDate } from '../../lib/format';
import { useT } from '../../i18n';

/**
 * Talking to the agent from a chat app, through a bot of the user's own:
 * Telegram, Discord, Slack and Matrix, one card each.
 *
 * Each card has three states: no bot yet (how to make one, and where its
 * credentials go), a bot with nobody paired (the one-time code), and a
 * paired account (what it may do from there). The status is main's: the
 * listeners run there, and push it here on `channels-changed` as it moves.
 * Credentials are sent once, on Connect, and never come back.
 */

const CHANNELS = [
    {
        name: 'telegram',
        steps: [
            { key: 'step1', link: 'https://t.me/BotFather', linkKey: 'openBotFather' },
            { key: 'step2', fields: [{ key: 'token', placeholder: '123456789:AA...' }] },
        ],
    },
    {
        name: 'discord',
        steps: [
            { key: 'step1', link: 'https://discord.com/developers/applications', linkKey: 'openPortal' },
            { key: 'step2', fields: [{ key: 'token', placeholder: 'MTA...' }] },
        ],
    },
    {
        name: 'slack',
        steps: [
            { key: 'step1', link: 'https://api.slack.com/apps?new_app=1', linkKey: 'openSlackApps', manifest: true },
            { key: 'step2', fields: [{ key: 'botToken', placeholder: 'xoxb-...' }] },
            { key: 'step3', fields: [{ key: 'appToken', placeholder: 'xapp-...' }] },
        ],
    },
    {
        name: 'matrix',
        steps: [
            { key: 'step1', link: 'https://app.element.io/#/register', linkKey: 'openElement' },
            { key: 'step2', fields: [{ key: 'homeserver', placeholder: 'matrix.org', plain: true }, { key: 'accessToken', placeholder: 'syt_...' }] },
        ],
    },
];

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

const PROBLEMS = new Set(['conflict', 'webhook', 'unauthorized', 'error', 'offline', 'locked']);

function StatePill({ status, t }) {
    const state = status.enabled ? status.state : 'off';
    return (
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 shrink-0">
            <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${STATE_TONES[state] || STATE_TONES.off}`} />
            {t(`settings.channels.state.${state}`)}
        </span>
    );
}

/** Minutes left on a pairing code, ticking down while it is on screen. */
function useMinutesLeft(expiresAt) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!expiresAt) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(timer);
    }, [expiresAt]);
    return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 60000)) : 0;
}

/** How the bot is named in a sentence: @handle, or its Matrix id. */
const botName = status => (status.identity
    ? (status.name === 'matrix' ? status.identity.id : `@${status.identity.username || status.identity.name}`)
    : '');

function ChannelCard({ channel, status, agents, run, busy, setConfirm }) {
    const t = useT();
    const key = `settings.channels.${channel.name}`;
    const [open, setOpen] = useState(false);
    const [fields, setFields] = useState({});
    const minutesLeft = useMinutesLeft(status.pairing?.expiresAt || 0);
    const bot = botName(status);
    const working = (what) => busy === `${channel.name}:${what}`;
    const expanded = status.connected || open;
    const problem = PROBLEMS.has(status.state) && status.enabled ? status.message : '';
    const needed = channel.steps.flatMap(step => step.fields || []);
    const complete = needed.every(field => String(fields[field.key] || '').trim());

    const connect = async () => {
        const credentials = Object.fromEntries(needed.map(field => [field.key, String(fields[field.key] || '').trim()]));
        const result = await run(channel.name, 'connect', () => window.api.channels.connect(channel.name, credentials), t('settings.channels.connected'));
        if (result) setFields({});
    };

    const openLink = url => window.api.links.open(url);

    return (
        <SettingCard>
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                    <span className="flex shrink-0 mt-0.5 text-gray-900 dark:text-white">
                        <ChannelMark name={channel.name} size={22} />
                    </span>
                    <div className="min-w-0">
                        <h4 className="text-base font-semibold text-gray-900 dark:text-white">{t(`${key}.title`)}</h4>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t(`${key}.desc`)}</p>
                    </div>
                </div>
                {status.connected ? (
                    <StatePill status={status} t={t} />
                ) : (
                    <Button
                        variant="outline"
                        size="sm"
                        aria-expanded={open}
                        onClick={() => setOpen(value => !value)}
                        icon={<ArrowDown01Icon size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />}
                    >
                        {t('settings.channels.setUp')}
                    </Button>
                )}
            </div>

            {problem && (
                <div className="mt-4 rounded-lg px-3 py-2 text-xs leading-relaxed bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300">
                    {problem}
                </div>
            )}

            {expanded && !status.connected && (
                <div className={DIVIDED}>
                    <form
                        className="flex flex-col gap-5 text-sm text-gray-700 dark:text-gray-300"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (complete) connect();
                        }}
                    >
                        {channel.steps.map((step, index) => (
                            <div key={step.key} className="flex flex-col gap-2">
                                <span>{`${index + 1}. ${t(`${key}.${step.key}`)}`}</span>
                                {step.link && (
                                    <div>
                                        <Button size="sm" variant="outline" onClick={() => openLink(step.link)}>
                                            {t(`settings.channels.${step.linkKey}`)}
                                        </Button>
                                    </div>
                                )}
                                {step.manifest && status.manifest && (
                                    <div className="relative">
                                        <pre className="max-h-40 overflow-auto rounded-lg p-3 pr-10 text-[11px] leading-relaxed font-jetbrains
                                            bg-gray-50 dark:bg-black/40 border border-gray-200 dark:border-neutral-800 text-gray-700 dark:text-gray-300"
                                        >
                                            {JSON.stringify(status.manifest, null, 2)}
                                        </pre>
                                        <div className="absolute top-2 right-2">
                                            <CopyButton text={JSON.stringify(status.manifest, null, 2)} />
                                        </div>
                                    </div>
                                )}
                                {(step.fields || []).map(field => (
                                    <input
                                        key={field.key}
                                        type={field.plain ? 'text' : 'password'}
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={fields[field.key] || ''}
                                        onChange={event => setFields(previous => ({ ...previous, [field.key]: event.target.value }))}
                                        placeholder={field.placeholder}
                                        aria-label={t(`${key}.${field.key}`)}
                                        className={`${FIELD_CLASS} font-jetbrains`}
                                    />
                                ))}
                            </div>
                        ))}
                        <div className="flex items-center gap-3">
                            <Button type="submit" variant="primary" disabled={!complete || working('connect')}>
                                {working('connect') ? t('settings.channels.connecting') : t('settings.channels.connect')}
                            </Button>
                            <span className="text-xs text-gray-500 dark:text-gray-400">{t('settings.channels.tokenNote')}</span>
                        </div>
                    </form>
                </div>
            )}

            {status.connected && !status.owner && status.setup?.inviteUrl && (
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.channels.discord.inviteTitle')}
                    description={t('settings.channels.discord.inviteDesc')}
                    control={(
                        <Button variant="outline" onClick={() => openLink(status.setup.inviteUrl)}>
                            {t('settings.channels.discord.invite')}
                        </Button>
                    )}
                />
            )}

            {status.connected && !status.owner && (
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.channels.pairTitle', { app: status.label })}
                    description={t('settings.channels.pairDesc', { bot })}
                    control={!status.pairing && (
                        <Button variant="primary" disabled={working('pair')} onClick={() => run(channel.name, 'pair', () => window.api.channels.pair(channel.name))}>
                            {t('settings.channels.pair')}
                        </Button>
                    )}
                >
                    {status.pairing && (
                        <div className="flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-neutral-700 p-4">
                            <p className="text-sm text-gray-700 dark:text-gray-300">{t(`${key}.pairHow`, { bot })}</p>
                            <div className="flex flex-wrap items-center gap-2">
                                <code className="px-2.5 py-1.5 rounded-lg font-jetbrains text-sm text-gray-900 dark:text-white
                                    bg-gray-100 dark:bg-white/[0.06] select-all"
                                >
                                    {status.pairing.text}
                                </code>
                                <CopyButton text={status.pairing.text} />
                                {status.pairing.link && (
                                    <Button variant="primary" onClick={() => openLink(status.pairing.link)}>
                                        {t(`${key}.openChat`)}
                                    </Button>
                                )}
                                <Button variant="ghost" onClick={() => run(channel.name, 'cancel', () => window.api.channels.cancelPair(channel.name))}>
                                    {t('settings.channels.cancel')}
                                </Button>
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t('settings.channels.pairExpires', { count: minutesLeft })}
                            </p>
                        </div>
                    )}
                </SettingRow>
            )}

            {status.connected && status.owner && (
                <>
                    <SettingRow
                        className={DIVIDED}
                        title={t('settings.channels.pairedWith', {
                            name: status.owner.username && status.owner.username !== status.owner.name
                                ? `${status.owner.name} (${status.name === 'matrix' ? status.owner.username : `@${status.owner.username}`})`
                                : status.owner.name,
                        })}
                        description={t('settings.channels.pairedDesc', {
                            bot,
                            when: status.owner.pairedAt ? formatDate(status.owner.pairedAt) : '',
                        })}
                        control={(
                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    disabled={working('test') || !status.enabled}
                                    onClick={() => run(channel.name, 'test', () => window.api.channels.test(channel.name), t('settings.channels.testSent', { app: status.label }))}
                                >
                                    {t('settings.channels.test')}
                                </Button>
                                <Button variant="dangerGhost" onClick={() => setConfirm({ name: channel.name, action: 'unpair', label: status.label, bot })}>
                                    {t('settings.channels.unpair')}
                                </Button>
                            </div>
                        )}
                    />

                    <SettingRow
                        className={DIVIDED}
                        align="center"
                        title={t('settings.channels.enabled')}
                        description={t('settings.channels.enabledDesc', { app: status.label })}
                        control={(
                            <Toggle
                                checked={status.enabled}
                                ariaLabel={t('settings.channels.enabled')}
                                onChange={value => run(channel.name, 'enabled', () => window.api.channels.update(channel.name, { enabled: value }))}
                            />
                        )}
                    />

                    <SettingRow
                        className={DIVIDED}
                        title={t('settings.channels.agent')}
                        description={t('settings.channels.agentDesc', { app: status.label, command: `${status.prefix}agent` })}
                        control={(
                            <div className="w-56">
                                <Select
                                    value={status.agentId || ''}
                                    onChange={value => run(channel.name, 'agent', () => window.api.channels.update(channel.name, { agentId: value }))}
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
                </>
            )}

            {status.connected && (
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.channels.bot', { bot })}
                    description={t('settings.channels.botDesc', { app: status.label })}
                    control={(
                        <Button variant="dangerOutline" onClick={() => setConfirm({ name: channel.name, action: 'disconnect', label: status.label, bot })}>
                            {t('settings.channels.disconnect')}
                        </Button>
                    )}
                />
            )}
        </SettingCard>
    );
}

export default function ChannelsSection() {
    const t = useT();
    const { agents } = useAgents();
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState('');
    const [confirm, setConfirm] = useState(null);

    useEffect(() => {
        let alive = true;
        window.api.channels.status()
            .then((next) => { if (alive) setStatus(next); })
            .catch(() => { if (alive) setStatus({}); });
        const off = window.api.channels.onChanged((next) => setStatus(next));
        return () => {
            alive = false;
            off?.();
        };
    }, []);

    /** One call to main, with the button that made it marked busy and any error toasted. */
    const run = useCallback(async (name, what, call, success = '') => {
        setBusy(`${name}:${what}`);
        try {
            const result = await call();
            if (result?.error) {
                toast.error(result.error, toastOptions());
                return null;
            }
            if (result?.name) setStatus(previous => ({ ...(previous || {}), [result.name]: result }));
            if (success) toast.success(success, toastOptions());
            return result;
        } catch (error) {
            toast.error(error?.message || t('settings.channels.failed'), toastOptions());
            return null;
        } finally {
            setBusy('');
        }
    }, [t]);

    if (!status) return <LoadingCard />;
    if (!CHANNELS.some(channel => status[channel.name])) {
        return (
            <SettingCard>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.channels.unavailable')}</p>
            </SettingCard>
        );
    }

    return (
        <>
            {CHANNELS.filter(channel => status[channel.name]).map(channel => (
                <ChannelCard
                    key={channel.name}
                    channel={channel}
                    status={status[channel.name]}
                    agents={agents}
                    run={run}
                    busy={busy}
                    setConfirm={setConfirm}
                />
            ))}

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

            {confirm?.action === 'unpair' && (
                <ConfirmDialog
                    title={t('settings.channels.unpairTitle', { app: confirm.label })}
                    message={t('settings.channels.unpairMessage')}
                    confirmLabel={t('settings.channels.unpair')}
                    onConfirm={() => {
                        const { name } = confirm;
                        setConfirm(null);
                        run(name, 'unpair', () => window.api.channels.unpair(name), t('settings.channels.unpaired'));
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {confirm?.action === 'disconnect' && (
                <ConfirmDialog
                    title={t('settings.channels.disconnectTitle')}
                    message={t('settings.channels.disconnectMessage', { bot: confirm.bot })}
                    confirmLabel={t('settings.channels.disconnect')}
                    onConfirm={() => {
                        const { name } = confirm;
                        setConfirm(null);
                        run(name, 'disconnect', () => window.api.channels.disconnect(name), t('settings.channels.disconnected'));
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </>
    );
}
