import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import SegmentedControl from '../ui/SegmentedControl';
import ConfirmDialog from '../ui/ConfirmDialog';
import { FIELD_CLASS } from './useAssistantSettings';
import { toastOptions } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../i18n';

/**
 * Devices: this Acestes and the user's other installs, as one fleet.
 *
 * Three states, one page: not in a fleet (start one here, or join with a code
 * from another computer), joining (waiting for the computer that made the
 * code), and in one (the devices, a code to add another, the relay, leaving).
 * Everything comes from main as one status object, pushed on `fleet-changed`
 * as devices come and go. See src/main/fleet.
 */

const DEFAULT_PORT = 7377;

const STATE_TONES = {
    online: 'bg-emerald-500',
    connecting: 'bg-amber-400',
    waiting: 'bg-amber-400',
    offline: 'bg-gray-400',
    error: 'bg-red-500',
};

function Dot({ on, tone }) {
    return (
        <span
            aria-hidden="true"
            className={`inline-block w-2 h-2 rounded-full shrink-0 ${tone || (on ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-neutral-600')}`}
        />
    );
}

/** "Synced 2 minutes ago · 214 items", or what is still waiting to go. */
function syncLine(t, sync) {
    if (!sync) return t('settings.devices.syncStarting');
    if (sync.lastError) return t('settings.devices.syncError', { message: sync.lastError });
    if (!sync.primed) return t('settings.devices.syncFirst');
    const items = Object.values(sync.counts || {}).reduce((sum, count) => sum + count, 0);
    const when = sync.lastSyncAt ? formatDateTime(sync.lastSyncAt) : '';
    const base = when ? t('settings.devices.syncedAt', { when, count: items }) : t('settings.devices.syncedItems', { count: items });
    return sync.pending ? `${base} · ${t('settings.devices.syncPending', { count: sync.pending })}` : base;
}

function useMinutesLeft(expiresAt) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!expiresAt) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 15000);
        return () => clearInterval(timer);
    }, [expiresAt]);
    return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 60000)) : 0;
}

/** Start a fleet here, or join one with a code. */
function SetUp({ status, run, busy }) {
    const t = useT();
    const firstAddress = status.hub?.addresses?.[0] || '127.0.0.1';
    const [where, setWhere] = useState('here');
    const [port, setPort] = useState(String(status.hub?.port || DEFAULT_PORT));
    const [publicUrl, setPublicUrl] = useState(status.hub?.publicUrl || '');
    const [relay, setRelay] = useState('');
    const [name, setName] = useState(status.name || '');
    const [code, setCode] = useState('');

    const suggested = `ws://${firstAddress}:${Number(port) || DEFAULT_PORT}`;

    const start = () => run('create', () => window.api.fleet.create(where === 'here'
        ? { hostHere: true, port: Number(port) || DEFAULT_PORT, publicUrl: publicUrl.trim() || suggested, name }
        : { relay: relay.trim(), name }), t('settings.devices.started'));

    const canStart = where === 'here' ? Boolean(Number(port)) : /^wss?:\/\/\S+/i.test(relay.trim());

    return (
        <>
            <SettingCard>
                <SettingRow title={t('settings.devices.startTitle')} description={t('settings.devices.startDesc')}>
                    <form
                        className="flex flex-col gap-4 text-sm text-gray-700 dark:text-gray-300"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (canStart) start();
                        }}
                    >
                        <label className="flex flex-col gap-1.5">
                            <span>{t('settings.devices.thisName')}</span>
                            <input
                                value={name}
                                onChange={event => setName(event.target.value)}
                                placeholder={status.name}
                                className={FIELD_CLASS}
                                aria-label={t('settings.devices.thisName')}
                            />
                        </label>

                        <div className="flex flex-col gap-2">
                            <span>{t('settings.devices.relayWhere')}</span>
                            <SegmentedControl
                                ariaLabel={t('settings.devices.relayWhere')}
                                value={where}
                                onChange={setWhere}
                                segments={[
                                    { value: 'here', label: t('settings.devices.relayHere') },
                                    { value: 'address', label: t('settings.devices.relayAddress') },
                                ]}
                                className="self-start"
                            />
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {where === 'here' ? t('settings.devices.relayHereDesc') : t('settings.devices.relayAddressDesc')}
                            </p>
                        </div>

                        {where === 'here' ? (
                            <div className="flex flex-wrap gap-3">
                                <label className="flex flex-col gap-1.5 w-28">
                                    <span>{t('settings.devices.port')}</span>
                                    <input
                                        value={port}
                                        onChange={event => setPort(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                                        className={`${FIELD_CLASS} font-jetbrains`}
                                        aria-label={t('settings.devices.port')}
                                    />
                                </label>
                                <label className="flex flex-col gap-1.5 flex-1 min-w-[16rem]">
                                    <span>{t('settings.devices.publicUrl')}</span>
                                    <input
                                        value={publicUrl}
                                        onChange={event => setPublicUrl(event.target.value)}
                                        placeholder={suggested}
                                        spellCheck={false}
                                        className={`${FIELD_CLASS} font-jetbrains`}
                                        aria-label={t('settings.devices.publicUrl')}
                                    />
                                </label>
                            </div>
                        ) : (
                            <input
                                value={relay}
                                onChange={event => setRelay(event.target.value)}
                                placeholder="wss://relay.example.com"
                                spellCheck={false}
                                className={`${FIELD_CLASS} font-jetbrains`}
                                aria-label={t('settings.devices.relayAddress')}
                            />
                        )}

                        <div>
                            <Button type="submit" variant="primary" disabled={!canStart || busy === 'create'}>
                                {busy === 'create' ? t('settings.devices.starting') : t('settings.devices.start')}
                            </Button>
                        </div>
                    </form>
                </SettingRow>
            </SettingCard>

            <SettingCard>
                <SettingRow title={t('settings.devices.joinTitle')} description={t('settings.devices.joinDesc')}>
                    <form
                        className="flex flex-col gap-3"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (code.trim()) run('join', () => window.api.fleet.join({ code: code.trim(), name }));
                        }}
                    >
                        <textarea
                            value={code}
                            onChange={event => setCode(event.target.value)}
                            placeholder="ACESTES1.…"
                            rows={3}
                            spellCheck={false}
                            className={`${FIELD_CLASS} font-jetbrains text-xs resize-none`}
                            aria-label={t('settings.devices.code')}
                        />
                        <div>
                            <Button type="submit" variant="primary" disabled={!code.trim() || busy === 'join'}>
                                {t('settings.devices.join')}
                            </Button>
                        </div>
                    </form>
                </SettingRow>
            </SettingCard>
        </>
    );
}

function DeviceRow({ device, onRemove, onRename }) {
    const t = useT();
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(device.name);
    const info = device.info || {};
    const details = [info.os, info.version ? `Acestes ${info.version}` : '', info.user].filter(Boolean).join(' · ');
    const seen = device.self || device.online
        ? ''
        : (device.seenAt ? t('settings.devices.lastSeen', { when: formatDateTime(device.seenAt) }) : t('settings.devices.neverSeen'));

    return (
        <div className={`flex items-center justify-between gap-4 ${DIVIDED}`}>
            <div className="flex items-start gap-3 min-w-0">
                <span className="mt-1.5"><Dot on={device.online} /></span>
                <div className="min-w-0">
                    {editing ? (
                        <form
                            className="flex items-center gap-2"
                            onSubmit={(event) => {
                                event.preventDefault();
                                onRename(name);
                                setEditing(false);
                            }}
                        >
                            <input
                                value={name}
                                autoFocus
                                onChange={event => setName(event.target.value)}
                                className={`${FIELD_CLASS} h-8`}
                                aria-label={t('settings.devices.thisName')}
                            />
                            <Button type="submit" size="sm" variant="primary">{t('settings.devices.save')}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('settings.devices.cancel')}</Button>
                        </form>
                    ) : (
                        <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {device.name}
                            {device.self && <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">{t('settings.devices.thisComputer')}</span>}
                            {info.hub && <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">{t('settings.devices.hostsRelay')}</span>}
                            {info.locked && <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">{t('settings.devices.lockedBadge')}</span>}
                        </p>
                    )}
                    {details && <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">{details}</p>}
                    {seen && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{seen}</p>}
                </div>
            </div>
            {!editing && (
                device.self
                    ? <Button size="sm" variant="ghost" onClick={() => { setName(device.name); setEditing(true); }}>{t('settings.devices.rename')}</Button>
                    : <Button size="sm" variant="dangerGhost" onClick={() => onRemove(device)}>{t('settings.devices.remove')}</Button>
            )}
        </div>
    );
}

function InFleet({ status, run, busy, setConfirm }) {
    const t = useT();
    const minutesLeft = useMinutesLeft(status.invite?.expiresAt || 0);
    const connection = status.connection || {};
    const hub = status.hub || {};

    return (
        <>
            <SettingCard>
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h4 className="text-base font-semibold text-gray-900 dark:text-white">{t('settings.devices.fleetTitle')}</h4>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('settings.devices.fleetDesc')}</p>
                    </div>
                    <span className="flex items-center gap-2 shrink-0 text-xs text-gray-600 dark:text-gray-300">
                        <Dot tone={STATE_TONES[connection.state] || STATE_TONES.offline} />
                        {t(`settings.devices.state.${connection.state || 'offline'}`)}
                    </span>
                </div>
                {connection.state === 'error' && connection.message && (
                    <div className="mt-4 rounded-lg px-3 py-2 text-xs leading-relaxed bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300">
                        {connection.message}
                    </div>
                )}
                {status.devices.map(device => (
                    <DeviceRow
                        key={device.id}
                        device={device}
                        onRename={name => run('rename', () => window.api.fleet.rename(name))}
                        onRemove={target => setConfirm({ action: 'remove', device: target })}
                    />
                ))}
            </SettingCard>

            <SettingCard>
                <SettingRow
                    align="center"
                    title={t('settings.devices.lockTitle')}
                    description={status.deviceLocked ? t('settings.devices.lockOnDesc') : t('settings.devices.lockDesc')}
                    control={(
                        <Toggle
                            checked={Boolean(status.deviceLocked)}
                            ariaLabel={t('settings.devices.lockTitle')}
                            onChange={value => run('lock', () => window.api.fleet.setLock(value))}
                        />
                    )}
                />
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.devices.syncTitle')}
                    description={syncLine(t, status.sync)}
                    control={(
                        <Button
                            variant="outline"
                            disabled={busy === 'sync' || connection.state !== 'online'}
                            onClick={() => run('sync', () => window.api.fleet.syncNow())}
                        >
                            {busy === 'sync' ? t('settings.devices.syncing') : t('settings.devices.syncNow')}
                        </Button>
                    )}
                />
            </SettingCard>

            <SettingCard>
                <SettingRow
                    title={t('settings.devices.addTitle')}
                    description={t('settings.devices.addDesc')}
                    control={!status.invite && (
                        <Button
                            variant="primary"
                            disabled={busy === 'invite' || connection.state !== 'online'}
                            onClick={() => run('invite', () => window.api.fleet.invite())}
                        >
                            {t('settings.devices.makeCode')}
                        </Button>
                    )}
                >
                    {status.invite && (
                        <div className="flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-neutral-700 p-4">
                            <p className="text-sm text-gray-700 dark:text-gray-300">{t('settings.devices.codeHow')}</p>
                            <code className="break-all px-2.5 py-1.5 rounded-lg font-jetbrains text-xs text-gray-900 dark:text-white
                                bg-gray-100 dark:bg-white/[0.06] select-all"
                            >
                                {status.invite.code}
                            </code>
                            <div>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => navigator.clipboard.writeText(status.invite.code)
                                        .then(() => toast.success(t('settings.devices.copied'), toastOptions()))
                                        .catch(() => toast.error(t('settings.devices.failed'), toastOptions()))}
                                >
                                    {t('settings.devices.copy')}
                                </Button>
                            </div>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                {t('settings.devices.codeExpires', { count: minutesLeft })}
                            </p>
                        </div>
                    )}
                </SettingRow>
            </SettingCard>

            <SettingCard>
                <SettingRow
                    title={t('settings.devices.relayTitle')}
                    description={hub.enabled
                        ? t('settings.devices.relayHosted', { port: hub.port })
                        : t('settings.devices.relayElsewhere')}
                >
                    <code className="self-start px-2.5 py-1.5 rounded-lg font-jetbrains text-xs text-gray-900 dark:text-white bg-gray-100 dark:bg-white/[0.06] select-all">
                        {status.fleet.relay}
                    </code>
                    {hub.enabled && hub.error && (
                        <p className="text-xs text-red-600 dark:text-red-400">{hub.error}</p>
                    )}
                </SettingRow>
                <SettingRow
                    className={DIVIDED}
                    title={t('settings.devices.leaveTitle')}
                    description={t('settings.devices.leaveDesc')}
                    control={(
                        <Button variant="dangerOutline" disabled={busy === 'leave'} onClick={() => setConfirm({ action: 'leave' })}>
                            {t('settings.devices.leave')}
                        </Button>
                    )}
                />
            </SettingCard>
        </>
    );
}

export default function DevicesSection() {
    const t = useT();
    const [status, setStatus] = useState(null);
    const [busy, setBusy] = useState('');
    const [confirm, setConfirm] = useState(null);

    useEffect(() => {
        let alive = true;
        window.api.fleet.status()
            .then((next) => { if (alive) setStatus(next); })
            .catch(() => { if (alive) setStatus({ devices: [] }); });
        const off = window.api.fleet.onChanged(next => setStatus(next));
        return () => {
            alive = false;
            off?.();
        };
    }, []);

    /** One call to main, with its button marked busy and any error toasted. */
    const run = useCallback(async (what, call, success = '') => {
        setBusy(what);
        try {
            const result = await call();
            if (result?.error) {
                toast.error(result.error, toastOptions());
                return null;
            }
            if (result?.devices) setStatus(previous => ({ ...(previous || {}), ...result }));
            else window.api.fleet.status().then(setStatus).catch(() => {});
            if (success) toast.success(success, toastOptions());
            return result;
        } catch (error) {
            toast.error(error?.message || t('settings.devices.failed'), toastOptions());
            return null;
        } finally {
            setBusy('');
        }
    }, [t]);

    if (!status) return <LoadingCard />;

    if (status.appLocked) {
        return (
            <SettingCard>
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('settings.devices.locked')}</p>
            </SettingCard>
        );
    }

    let body;
    if (status.fleet) {
        body = <InFleet status={status} run={run} busy={busy} setConfirm={setConfirm} />;
    } else if (status.joining) {
        const state = status.connection?.state || 'connecting';
        const from = status.joining.from || t('settings.devices.anotherComputer');
        body = (
            <SettingCard>
                <SettingRow
                    title={t('settings.devices.joiningTitle', { name: from })}
                    description={state === 'waiting' ? t('settings.devices.joiningWaiting', { name: from }) : t(`settings.devices.state.${state}`)}
                    control={(
                        <Button variant="ghost" onClick={() => run('leave', () => window.api.fleet.leave())}>
                            {t('settings.devices.cancel')}
                        </Button>
                    )}
                />
            </SettingCard>
        );
    } else {
        body = (
            <>
                {status.connection?.state === 'error' && status.connection.message && (
                    <SettingCard>
                        <p className="text-sm text-amber-800 dark:text-amber-300">{status.connection.message}</p>
                    </SettingCard>
                )}
                <SetUp status={status} run={run} busy={busy} />
            </>
        );
    }

    return (
        <>
            {body}

            <SettingCard>
                <SettingRow title={t('settings.devices.howTitle')} description={t('settings.devices.howDesc')}>
                    <ul className="flex flex-col gap-2 text-sm text-gray-600 dark:text-gray-400 list-disc pl-5">
                        <li>{t('settings.devices.howSealed')}</li>
                        <li>{t('settings.devices.howCode')}</li>
                        <li>{t('settings.devices.howSync')}</li>
                        <li>{t('settings.devices.howTray')}</li>
                        <li>{t('settings.devices.howRemove')}</li>
                    </ul>
                </SettingRow>
            </SettingCard>

            {confirm?.action === 'remove' && (
                <ConfirmDialog
                    title={t('settings.devices.removeTitle', { name: confirm.device.name })}
                    message={t('settings.devices.removeMessage')}
                    confirmLabel={t('settings.devices.remove')}
                    onConfirm={() => {
                        const { id } = confirm.device;
                        setConfirm(null);
                        run('remove', () => window.api.fleet.remove(id), t('settings.devices.removed'));
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
            {confirm?.action === 'leave' && (
                <ConfirmDialog
                    title={t('settings.devices.leaveConfirmTitle')}
                    message={t('settings.devices.leaveMessage')}
                    confirmLabel={t('settings.devices.leave')}
                    onConfirm={() => {
                        setConfirm(null);
                        run('leave', () => window.api.fleet.leave(), t('settings.devices.left'));
                    }}
                    onCancel={() => setConfirm(null)}
                />
            )}
        </>
    );
}
