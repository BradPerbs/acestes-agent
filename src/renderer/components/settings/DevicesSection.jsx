import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import SettingCard from './ui/SettingCard';
import SettingRow, { DIVIDED } from './ui/SettingRow';
import LoadingCard from './ui/LoadingCard';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import Disclosure from '../ui/Disclosure';
import ConfirmDialog from '../ui/ConfirmDialog';
import { FIELD_CLASS } from './useAssistantSettings';
import { toastOptions } from '../../lib/toast';
import { formatDateTime } from '../../lib/format';
import { useT } from '../../i18n';

/**
 * Devices: this Acestes and the user's other installs, as one fleet.
 *
 * Three states, one page: not in a fleet (join with a code, or start here),
 * joining (waiting for the computer that made the code), and in one (the
 * devices, connect and disconnect, a code to add another, leaving).
 * Everything comes from main as one status object, pushed on `fleet-changed`
 * as devices come and go. See src/main/fleet.
 *
 * The thing this page has to get across is reach: the devices meet at a
 * relay address, and whether a computer can get to it depends on what kind
 * of address it is. So every address shown says who can connect to it
 * (main classifies it, reach.js), and can be tested from here before
 * anyone waits on a "Connecting" that will never finish.
 */

const DEFAULT_PORT = 7377;

const TONES = {
    online: 'bg-emerald-500',
    busy: 'bg-amber-400',
    off: 'bg-gray-300 dark:bg-neutral-600',
    bad: 'bg-red-500',
};

function Dot({ tone = 'off' }) {
    return <span aria-hidden="true" className={`inline-block w-2 h-2 rounded-full shrink-0 ${TONES[tone] || TONES.off}`} />;
}

const MONO = 'font-jetbrains text-xs text-gray-900 dark:text-white';
const CHIP = 'inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium '
    + 'bg-gray-100 dark:bg-white/[0.08] text-gray-600 dark:text-gray-300';
const NOTE = 'rounded-lg px-3 py-2.5 text-xs leading-relaxed';
const WARN = `${NOTE} bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300`;

/** Kind of address, as a short label: "Tailscale", "Same network". */
const kindLabel = (t, kind) => t(`settings.devices.reach.${kind || 'unknown'}`);

/** Who can connect to an address of this kind, in a sentence. */
const kindWho = (t, reach) => (reach?.kind ? t(`settings.devices.reach.${reach.kind}Who`, { port: reach.port || '' }) : '');

/** "100.112.44.103:7377"; the port left off when it is the scheme's own. */
function hostPort(reach) {
    if (!reach?.host) return '';
    const plain = !reach.port || (reach.secure ? reach.port === '443' : reach.port === '80');
    return plain ? reach.host : `${reach.host}:${reach.port}`;
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

/** What a failed probe means, with a nudge for the kind of address it was. */
function probeMessage(t, result) {
    const values = { host: result.host, port: result.port, ms: result.ms };
    if (result.ok) return t('settings.devices.probe.ok', values);
    const key = {
        refused: 'refused',
        timeout: 'timeout',
        unreachable: 'unreachable',
        notfound: 'notfound',
        tls: 'tls',
        'not-relay': 'notRelay',
        'bad-address': 'badAddress',
    }[result.code] || 'failed';
    const base = t(`settings.devices.probe.${key}`, values);
    const hint = ['timeout', 'unreachable', 'failed'].includes(key) && ['tailscale', 'lan', 'public'].includes(result.kind)
        ? ` ${t(`settings.devices.hint.${result.kind}`)}`
        : '';
    return base + hint;
}

/**
 * Test whether a relay answers from this computer. `auto` runs it once when
 * the address appears or changes; the button runs it again.
 */
function useProbe(url, auto = false) {
    const [result, setResult] = useState(null);
    const [checking, setChecking] = useState(false);
    const latest = useRef(url);
    // Read when the address changes, not watched: a flag that flips with
    // every reconnect attempt would test again on each one.
    const autoRef = useRef(auto);
    autoRef.current = auto;

    const check = useCallback(async () => {
        if (!url) return;
        latest.current = url;
        setChecking(true);
        try {
            const next = await window.api.fleet.probe(url);
            if (latest.current === url) setResult(next);
        } catch (error) {
            if (latest.current === url) setResult({ ok: false, code: 'failed', detail: error?.message });
        } finally {
            if (latest.current === url) setChecking(false);
        }
    }, [url]);

    useEffect(() => {
        setResult(null);
        setChecking(false);
        latest.current = url;
        if (autoRef.current && url) check();
    }, [url, check]);

    return { result, checking, check };
}

/** One address: what kind it is, the address, and who can connect to it. */
function Address({ reach, suffix = '' }) {
    const t = useT();
    if (!reach) return null;
    return (
        <div className="flex flex-col gap-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
                <span className={CHIP}>{kindLabel(t, reach.kind)}</span>
                <span className={`${MONO} truncate`}>{hostPort(reach) || reach.url}</span>
                {suffix && <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">{suffix}</span>}
            </div>
            {kindWho(t, reach) && <p className="text-xs text-gray-500 dark:text-gray-400">{kindWho(t, reach)}</p>}
        </div>
    );
}

/** The test button and what it found. */
function ProbeLine({ probe, selfHosted = false }) {
    const t = useT();
    const { result, checking, check } = probe;
    let text = '';
    let tone = 'text-gray-500 dark:text-gray-400';
    if (result) {
        text = result.ok && selfHosted ? t('settings.devices.probe.okSelf') : probeMessage(t, result);
        tone = result.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-800 dark:text-amber-300';
    }
    return (
        <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" disabled={checking} onClick={check}>
                {checking ? t('settings.devices.testing') : t('settings.devices.test')}
            </Button>
            {text && !checking && <p className={`text-xs ${tone}`}>{text}</p>}
        </div>
    );
}

/** A choice drawn as a card: a title, a sentence, and whatever goes with it when picked. */
function Choice({ selected, onSelect, title, description, children }) {
    return (
        <div
            className={`rounded-xl border transition-colors ${selected
                ? 'border-gray-900 dark:border-white/70'
                : 'border-gray-200 dark:border-neutral-700 hover:border-gray-400 dark:hover:border-neutral-500'}`}
        >
            <button
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={onSelect}
                className="w-full text-left flex items-start gap-3 px-4 py-3 outline-none rounded-xl
                    focus-visible:ring-2 focus-visible:ring-gray-900/25 dark:focus-visible:ring-white/30"
            >
                <span
                    aria-hidden="true"
                    className={`mt-0.5 w-4 h-4 rounded-full border shrink-0 flex items-center justify-center ${selected
                        ? 'border-gray-900 dark:border-white'
                        : 'border-gray-300 dark:border-neutral-600'}`}
                >
                    {selected && <span className="w-2 h-2 rounded-full bg-gray-900 dark:bg-white" />}
                </span>
                <span className="min-w-0">
                    <span className="block text-sm font-semibold text-gray-900 dark:text-white">{title}</span>
                    {description && <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</span>}
                </span>
            </button>
            {selected && children && <div className="px-4 pb-4 pl-11 flex flex-col gap-3">{children}</div>}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Not in a fleet
 * ------------------------------------------------------------------ */

function JoinForm({ run, busy, name }) {
    const t = useT();
    const [code, setCode] = useState('');
    const [peek, setPeek] = useState(null);

    useEffect(() => {
        const text = code.trim();
        if (!text) {
            setPeek(null);
            return undefined;
        }
        let alive = true;
        const timer = setTimeout(() => {
            window.api.fleet.peek(text)
                .then((next) => { if (alive) setPeek(next); })
                .catch(() => { if (alive) setPeek({ error: true }); });
        }, 200);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [code]);

    const valid = peek && !peek.error;
    const probe = useProbe(valid ? peek.relay : '', true);
    const failed = probe.result && !probe.result.ok;

    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (valid) run('join', () => window.api.fleet.join({ code: code.trim(), name }));
            }}
        >
            <label className="flex flex-col gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                <span>{t('settings.devices.code')}</span>
                <textarea
                    value={code}
                    onChange={event => setCode(event.target.value)}
                    placeholder="ACESTES1.…"
                    rows={3}
                    spellCheck={false}
                    className={`${FIELD_CLASS} font-jetbrains text-xs resize-none`}
                    aria-label={t('settings.devices.code')}
                />
            </label>
            {!code.trim() && <p className="text-xs text-gray-500 dark:text-gray-400">{t('settings.devices.codeWhere')}</p>}
            {peek?.error && <p className="text-xs text-amber-800 dark:text-amber-300">{t('settings.devices.codeInvalid')}</p>}

            {valid && (
                <div className="flex flex-col gap-3 rounded-lg border border-gray-200 dark:border-neutral-700 p-3">
                    <p className="text-sm font-semibold text-gray-900 dark:text-white">
                        {peek.from ? t('settings.devices.codeFrom', { name: peek.from }) : t('settings.devices.codeFromUnknown')}
                    </p>
                    <Address reach={peek.reach} />
                    <ProbeLine probe={probe} />
                </div>
            )}

            <div>
                <Button type="submit" variant="primary" disabled={!valid || busy === 'join' || probe.checking}>
                    {failed ? t('settings.devices.joinAnyway') : t('settings.devices.join')}
                </Button>
            </div>
        </form>
    );
}

function StartForm({ status, run, busy, name }) {
    const t = useT();
    const networks = status.hub?.networks || [];
    const [where, setWhere] = useState('here');
    const [port, setPort] = useState(String(status.hub?.port || DEFAULT_PORT));
    const [publicUrl, setPublicUrl] = useState(status.hub?.publicUrl || '');
    const [relay, setRelay] = useState('');
    const portNumber = Number(port) || DEFAULT_PORT;
    const suggested = networks[0] ? `ws://${networks[0].address}:${portNumber}` : `ws://127.0.0.1:${portNumber}`;
    const relayUrl = relay.trim();
    const relayOk = /^wss?:\/\/\S+/i.test(relayUrl);
    const probe = useProbe(where === 'online' && relayOk ? relayUrl : '', false);
    const hasTailscale = networks.some(entry => entry.kind === 'tailscale');

    const canStart = where === 'here' ? Boolean(Number(port)) : relayOk;
    const start = () => run('create', () => window.api.fleet.create(where === 'here'
        ? { hostHere: true, port: portNumber, publicUrl: publicUrl.trim() || suggested, name }
        : { relay: relayUrl, name }), t('settings.devices.started'));

    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                if (canStart) start();
            }}
        >
            <p className="text-sm text-gray-700 dark:text-gray-300">{t('settings.devices.meetTitle')}</p>
            <div role="radiogroup" aria-label={t('settings.devices.meetTitle')} className="flex flex-col gap-2">
                <Choice
                    selected={where === 'here'}
                    onSelect={() => setWhere('here')}
                    title={t('settings.devices.meetHere')}
                    description={t('settings.devices.meetHereDesc')}
                >
                    {networks.length > 0 ? (
                        <>
                            <p className="text-xs text-gray-600 dark:text-gray-300">{t('settings.devices.reachableAt')}</p>
                            {networks.map(entry => (
                                <Address
                                    key={entry.address}
                                    reach={{ kind: entry.kind, host: entry.address, port: String(portNumber) }}
                                />
                            ))}
                        </>
                    ) : (
                        <p className="text-xs text-amber-800 dark:text-amber-300">{t('settings.devices.noNetworks')}</p>
                    )}
                    {!hasTailscale && <p className={WARN}>{t('settings.devices.tailscaleTip')}</p>}
                    <Disclosure title={t('settings.devices.advanced')} summary={t('settings.devices.advancedSummary', { port: portNumber })}>
                        <label className="flex flex-col gap-1.5 w-28 text-sm text-gray-700 dark:text-gray-300">
                            <span>{t('settings.devices.port')}</span>
                            <input
                                value={port}
                                onChange={event => setPort(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                                className={`${FIELD_CLASS} font-jetbrains`}
                                aria-label={t('settings.devices.port')}
                            />
                        </label>
                        <label className="flex flex-col gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                            <span>{t('settings.devices.publicUrl')}</span>
                            <input
                                value={publicUrl}
                                onChange={event => setPublicUrl(event.target.value)}
                                placeholder={suggested}
                                spellCheck={false}
                                className={`${FIELD_CLASS} font-jetbrains`}
                                aria-label={t('settings.devices.publicUrl')}
                            />
                            <span className="text-xs text-gray-500 dark:text-gray-400">{t('settings.devices.publicUrlHint')}</span>
                        </label>
                    </Disclosure>
                </Choice>

                <Choice
                    selected={where === 'online'}
                    onSelect={() => setWhere('online')}
                    title={t('settings.devices.meetOnline')}
                    description={t('settings.devices.meetOnlineDesc')}
                >
                    <input
                        value={relay}
                        onChange={event => setRelay(event.target.value)}
                        placeholder="wss://acestes-relay.example.workers.dev"
                        spellCheck={false}
                        className={`${FIELD_CLASS} font-jetbrains`}
                        aria-label={t('settings.devices.relayAddress')}
                    />
                    {relayOk && <ProbeLine probe={probe} />}
                </Choice>
            </div>

            <div className="mt-1">
                <Button type="submit" variant="primary" disabled={!canStart || busy === 'create'}>
                    {busy === 'create' ? t('settings.devices.starting') : t('settings.devices.start')}
                </Button>
            </div>
        </form>
    );
}

function SetUp({ status, run, busy }) {
    const t = useT();
    const [mode, setMode] = useState('');
    const [name, setName] = useState(status.name || '');

    return (
        <SettingCard>
            <SettingRow title={t('settings.devices.setupTitle')} description={t('settings.devices.setupDesc')}>
                <div className="flex flex-col gap-4">
                    <div role="radiogroup" aria-label={t('settings.devices.setupTitle')} className="flex flex-col gap-2">
                        <Choice
                            selected={mode === 'join'}
                            onSelect={() => setMode('join')}
                            title={t('settings.devices.choiceJoin')}
                            description={t('settings.devices.choiceJoinDesc')}
                        />
                        <Choice
                            selected={mode === 'start'}
                            onSelect={() => setMode('start')}
                            title={t('settings.devices.choiceStart')}
                            description={t('settings.devices.choiceStartDesc')}
                        />
                    </div>

                    {mode && (
                        <label className="flex flex-col gap-1.5 text-sm text-gray-700 dark:text-gray-300">
                            <span>{t('settings.devices.thisName')}</span>
                            <input
                                value={name}
                                onChange={event => setName(event.target.value)}
                                placeholder={status.name}
                                className={FIELD_CLASS}
                                aria-label={t('settings.devices.thisName')}
                            />
                        </label>
                    )}

                    {mode === 'join' && <JoinForm run={run} busy={busy} name={name} />}
                    {mode === 'start' && <StartForm status={status} run={run} busy={busy} name={name} />}
                </div>
            </SettingRow>
        </SettingCard>
    );
}

function Joining({ status, run }) {
    const t = useT();
    const state = status.connection?.state || 'connecting';
    const from = status.joining.from || t('settings.devices.anotherComputer');
    const reached = state === 'waiting';
    const probe = useProbe(status.joining.relay, false);

    return (
        <SettingCard>
            <SettingRow
                title={t('settings.devices.joiningTitle', { name: from })}
                description={reached
                    ? t('settings.devices.joiningWaiting', { name: from })
                    : t('settings.devices.joiningConnecting', { name: from })}
                control={(
                    <Button variant="ghost" onClick={() => run('leave', () => window.api.fleet.leave())}>
                        {t('settings.devices.cancel')}
                    </Button>
                )}
            >
                <div className="flex flex-col gap-3">
                    <span className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                        <Dot tone={state === 'error' ? 'bad' : 'busy'} />
                        {t(`settings.devices.state.${state}`)}
                    </span>
                    {state === 'error' && status.connection?.message && <p className={WARN}>{status.connection.message}</p>}
                    <Address reach={status.reach} />
                    {!reached && <ProbeLine probe={probe} />}
                </div>
            </SettingRow>
        </SettingCard>
    );
}

/* ------------------------------------------------------------------ *
 * In a fleet
 * ------------------------------------------------------------------ */

function DeviceRow({ device, onRemove, onRename }) {
    const t = useT();
    const [editing, setEditing] = useState(false);
    const [name, setName] = useState(device.name);
    const info = device.info || {};
    const details = [info.os, info.version ? `Acestes ${info.version}` : '', info.user].filter(Boolean).join(' · ');
    const seen = device.self
        ? ''
        : device.online
            ? t('settings.devices.online')
            : (device.seenAt ? t('settings.devices.lastSeen', { when: formatDateTime(device.seenAt) }) : t('settings.devices.neverSeen'));

    return (
        <div className="flex items-center justify-between gap-4 py-3 border-t border-gray-200 dark:border-neutral-700 first:border-t-0">
            <div className="flex items-start gap-3 min-w-0">
                <span className="mt-1.5"><Dot tone={device.online ? 'online' : 'off'} /></span>
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
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-gray-900 dark:text-white">
                            <span className="truncate">{device.name}</span>
                            {device.self && <span className={CHIP}>{t('settings.devices.thisComputer')}</span>}
                            {info.hub && <span className={CHIP}>{t('settings.devices.hostsRelay')}</span>}
                            {info.locked && <span className={CHIP}>{t('settings.devices.lockedBadge')}</span>}
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

/** The fleet's state in one line, the way to switch it, and why it cannot connect when it cannot. */
function ConnectionCard({ status, run, busy, setConfirm }) {
    const t = useT();
    const connection = status.connection || {};
    const hub = status.hub || {};
    const hostedHere = Boolean(hub.enabled);
    const state = status.paused ? 'paused' : (connection.state || 'offline');

    // Retrying goes offline, connecting, offline, connecting: once it has
    // failed, it stays "cannot reach" until it is through, rather than
    // flickering between the two.
    const [struggling, setStruggling] = useState(false);
    useEffect(() => {
        if (state === 'offline' || state === 'error') setStruggling(true);
        else if (state === 'online' || state === 'paused') setStruggling(false);
    }, [state]);
    const probe = useProbe(struggling ? status.fleet.relay : '', true);

    const shown = struggling && state === 'connecting' ? 'offline' : state;
    const tone = shown === 'online' ? 'online' : shown === 'paused' ? 'off' : shown === 'error' ? 'bad' : 'busy';
    const label = shown === 'online'
        ? t('settings.devices.connected')
        : shown === 'paused' ? t('settings.devices.disconnected') : t(`settings.devices.state.${shown}`);

    const disconnect = () => {
        if (hostedHere && status.devices.length > 1) setConfirm({ action: 'disconnect' });
        else run('connect', () => window.api.fleet.setConnected(false));
    };

    return (
        <SettingCard>
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex flex-col gap-2">
                    <h4 className="text-base font-semibold text-gray-900 dark:text-white">{t('settings.devices.fleetTitle')}</h4>
                    <span className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <Dot tone={tone} />
                        {label}
                    </span>
                </div>
                <div className="shrink-0">
                    {status.paused ? (
                        <Button variant="primary" disabled={busy === 'connect'} onClick={() => run('connect', () => window.api.fleet.setConnected(true))}>
                            {busy === 'connect' ? t('settings.devices.connecting') : t('settings.devices.connect')}
                        </Button>
                    ) : (
                        <Button variant="outline" disabled={busy === 'connect'} onClick={disconnect}>
                            {t('settings.devices.disconnect')}
                        </Button>
                    )}
                </div>
            </div>

            <div className="mt-4">
                <Address reach={status.reach} suffix={hostedHere ? `(${t('settings.devices.hostedHere')})` : ''} />
            </div>

            {status.paused && <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{t('settings.devices.pausedDesc')}</p>}
            {hostedHere && hub.error && <p className={`mt-3 ${WARN}`}>{hub.error}</p>}
            {state === 'error' && connection.message && <p className={`mt-3 ${WARN}`}>{connection.message}</p>}
            {struggling && (
                <div className="mt-3 flex flex-col gap-2">
                    {!hostedHere && <p className={WARN}>{t('settings.devices.cantReach', { address: hostPort(status.reach) || status.fleet.relay })}</p>}
                    <ProbeLine probe={probe} selfHosted={hostedHere} />
                </div>
            )}

            <div className="mt-5">
                {status.devices.map(device => (
                    <DeviceRow
                        key={device.id}
                        device={device}
                        onRename={name => run('rename', () => window.api.fleet.rename(name))}
                        onRemove={target => setConfirm({ action: 'remove', device: target })}
                    />
                ))}
                {status.devices.length <= 1 && (
                    <p className="pt-3 border-t border-gray-200 dark:border-neutral-700 text-xs text-gray-500 dark:text-gray-400">
                        {t('settings.devices.onlyThis')}
                    </p>
                )}
            </div>
        </SettingCard>
    );
}

/**
 * The addresses a code can carry. A relay hosted here listens on every network,
 * so the code says the one the other computer can use; a relay elsewhere has
 * one address and every code carries it.
 */
function useInviteOptions(status) {
    return useMemo(() => {
        const hub = status.hub || {};
        const own = status.fleet.relay;
        if (!hub.enabled) return [{ url: own, reach: status.reach }];
        const port = String(hub.port || DEFAULT_PORT);
        const list = (hub.networks || []).map(entry => ({
            url: `ws://${entry.address}:${port}`,
            reach: { kind: entry.kind, host: entry.address, port, url: `ws://${entry.address}:${port}` },
        }));
        // A name or forwarded port the user set up stays on offer.
        if (own && !list.some(entry => entry.url === own)) list.push({ url: own, reach: status.reach });
        return list;
    }, [status.hub, status.fleet.relay, status.reach]);
}

function AddComputer({ status, run, busy }) {
    const t = useT();
    const options = useInviteOptions(status);
    const [picked, setPicked] = useState('');
    const chosen = options.find(entry => entry.url === picked)
        || options.find(entry => entry.url === status.fleet.relay)
        || options[0];
    const invite = status.invite;
    const minutesLeft = useMinutesLeft(invite?.expiresAt || 0);
    const online = status.connection?.state === 'online' && !status.paused;
    const inviteReach = invite && (options.find(entry => entry.url === invite.relay)?.reach || null);

    const make = () => run('invite', () => window.api.fleet.invite({ relay: chosen?.url || '' }));

    return (
        <SettingCard>
            <SettingRow title={t('settings.devices.addTitle')} description={t('settings.devices.addDesc')}>
                <div className="flex flex-col gap-4">
                    {options.length > 1 ? (
                        <div className="flex flex-col gap-2">
                            <p className="text-sm text-gray-700 dark:text-gray-300">{t('settings.devices.addWhere')}</p>
                            <div role="radiogroup" aria-label={t('settings.devices.addWhere')} className="flex flex-col gap-2">
                                {options.map(entry => (
                                    <Choice
                                        key={entry.url}
                                        selected={entry.url === chosen?.url}
                                        onSelect={() => setPicked(entry.url)}
                                        title={`${kindLabel(t, entry.reach?.kind)} · ${hostPort(entry.reach) || entry.url}`}
                                        description={kindWho(t, entry.reach)}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : (
                        chosen && <Address reach={chosen.reach} />
                    )}

                    <div>
                        <Button variant={invite ? 'outline' : 'primary'} disabled={busy === 'invite' || !online} onClick={make}>
                            {invite ? t('settings.devices.newCode') : t('settings.devices.makeCode')}
                        </Button>
                    </div>

                    {invite && (
                        <div className="flex flex-col gap-3 rounded-xl border border-gray-200 dark:border-neutral-700 p-4">
                            <code className="break-all px-2.5 py-1.5 rounded-lg font-jetbrains text-xs text-gray-900 dark:text-white
                                bg-gray-100 dark:bg-white/[0.06] select-all"
                            >
                                {invite.code}
                            </code>
                            <div className="flex flex-wrap items-center gap-3">
                                <Button
                                    size="sm"
                                    variant="primary"
                                    onClick={() => navigator.clipboard.writeText(invite.code)
                                        .then(() => toast.success(t('settings.devices.copied'), toastOptions()))
                                        .catch(() => toast.error(t('settings.devices.failed'), toastOptions()))}
                                >
                                    {t('settings.devices.copy')}
                                </Button>
                                <span className="text-xs text-gray-500 dark:text-gray-400">
                                    {t('settings.devices.codeExpires', { count: minutesLeft })}
                                    {invite.relay && ` · ${t('settings.devices.codeVia', {
                                        address: inviteReach ? `${hostPort(inviteReach)} (${kindLabel(t, inviteReach.kind)})` : invite.relay,
                                    })}`}
                                </span>
                            </div>
                            <p className="text-sm text-gray-700 dark:text-gray-300">{t('settings.devices.codeHow')}</p>
                        </div>
                    )}
                </div>
            </SettingRow>
        </SettingCard>
    );
}

function InFleet({ status, run, busy, setConfirm }) {
    const t = useT();
    const online = status.connection?.state === 'online' && !status.paused;

    return (
        <>
            <ConnectionCard status={status} run={run} busy={busy} setConfirm={setConfirm} />
            <AddComputer status={status} run={run} busy={busy} />

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
                    description={status.paused ? t('settings.devices.syncPaused') : syncLine(t, status.sync)}
                    control={(
                        <Button
                            variant="outline"
                            disabled={busy === 'sync' || !online}
                            onClick={() => run('sync', () => window.api.fleet.syncNow())}
                        >
                            {busy === 'sync' ? t('settings.devices.syncing') : t('settings.devices.syncNow')}
                        </Button>
                    )}
                />
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

/* ------------------------------------------------------------------ */

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
        body = <Joining status={status} run={run} />;
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
                <SettingRow title={t('settings.devices.howTitle')}>
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
            {confirm?.action === 'disconnect' && (
                <ConfirmDialog
                    title={t('settings.devices.disconnectTitle')}
                    message={t('settings.devices.disconnectHubMessage')}
                    confirmLabel={t('settings.devices.disconnect')}
                    onConfirm={() => {
                        setConfirm(null);
                        run('connect', () => window.api.fleet.setConnected(false));
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
