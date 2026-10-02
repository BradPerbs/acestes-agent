import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loading03Icon } from 'hugeicons-react';
import Tooltip from './ui/Tooltip';
import UsagePanel from './usage/UsagePanel';
import AppResources from './usage/AppResources';
import ProviderMark from '../lib/provider-marks';
import { PROVIDER_ORDER } from '../lib/ai-catalog';
import { foldOut, growIn } from '../lib/barMotion';
import {
    PLAN_RUNTIMES, STALE_AFTER, accountName, barWindows, chosenAccount, keyOf, lastRead, tickedAccounts, toneOf,
    windowShort, worstTone,
} from '../lib/usage-limits';
import useUsageLimits, { useAgentSettings } from '../hooks/useUsageLimits';
import { useT } from '../i18n';

/**
 * The strip along the bottom of the window.
 *
 * Its left end is the plan limits of the agents that are switched on, for
 * every account ticked for each one: the five-hour window as a hairline meter
 * and a figure, one runtime after another, close enough to glance at without
 * going anywhere. With two accounts ticked for a runtime, both are there,
 * each named. The week joins a meter only once it is close to its limit.
 * Clicking it opens the whole picture above it: every window with its reset,
 * what this computer sent today, the other accounts and how much each has
 * left, and the boxes that choose which accounts are used.
 *
 * Its right end is the app itself: what it holds in memory, how many tabs are
 * open, and a coffee cup that keeps the computer from sleeping. That end stays
 * when the agent is switched off; the plan figures go with it.
 *
 * Nothing in it appears or goes at a stroke. A meter ticked on grows in and
 * one cleared folds away, with its neighbours sliding over, and the names
 * arrive and leave the same way as a second account comes and goes; an
 * account not read yet takes its place at once as an empty meter and fills
 * in when the read lands (`lib/barMotion`).
 *
 * It keeps the figures fresh on its own. The accounts in use are read when
 * the app opens and again whenever what is held is older than a quarter of an
 * hour; a read starts the runtime for a couple of seconds and sends nothing
 * to a model. Between reads, every turn's own rate-limit events move it.
 */

/** How often the bar looks for a figure gone stale. */
const TICK = 60 * 1000;
/**
 * How soon an account is read again when the last check failed, or when a
 * turn named a window the last check did not have (a five-hour window that
 * opened since) without giving its figure. A quarter of an hour of a missing
 * meter for either is too long.
 */
const RETRY_AFTER = 3 * 60 * 1000;

/** A window only a turn has named, with no figure yet. */
const unread = (entry) => (entry?.windows || []).some(window => window.source === 'event'
    && (window.used === null || window.used === undefined));
/** Older than this and a figure is drawn faded, as one that may have moved. */
const FADED_AFTER = 60 * 60 * 1000;

const FILL = {
    ok: 'bg-gray-500 dark:bg-neutral-300/80',
    warn: 'bg-amber-500',
    over: 'bg-red-500',
};

const TEXT = {
    ok: 'text-gray-600 dark:text-gray-300',
    warn: 'text-amber-600 dark:text-amber-400',
    over: 'text-red-600 dark:text-red-400',
};

/** One window at the bar's size: `5h ▬▬ 34%`. */
function Meter({ window }) {
    const tone = toneOf(window);
    const used = Math.round(window.used ?? 0);
    return (
        <span className="flex items-center gap-1.5">
            <span className="text-gray-400 dark:text-neutral-500">{windowShort(window)}</span>
            <span className="relative w-7 h-[3px] rounded-full bg-gray-300/80 dark:bg-white/[0.09] overflow-hidden">
                <span
                    className={`absolute inset-y-0 left-0 rounded-full ${FILL[tone]} transition-[width] duration-700`}
                    style={{ width: `${Math.max(used, used > 0 ? 4 : 0)}%` }}
                />
            </span>
            <span className={`${TEXT[tone]} min-w-[1.9em]`}>{used}%</span>
        </span>
    );
}

/** The five-hour window of an account that has not been read yet. */
function PendingMeter() {
    return (
        <span className="flex items-center gap-1.5 text-gray-400 dark:text-neutral-500">
            <span>5h</span>
            <span className="w-7 h-[3px] rounded-full bg-gray-300/80 dark:bg-white/[0.09] animate-pulse" />
            <span className="min-w-[1.9em]">–</span>
        </span>
    );
}

/**
 * Something in the bar that grows in when it arrives and folds away when it
 * goes. `show` false folds it and then takes it out; true again before it
 * has gone grows it back from wherever it had got to. `appear` false is for
 * a piece drawn as part of something bigger that is already growing in, so
 * the two do not race each other for the width.
 */
function Unfold({ show = true, appear = true, onGone, className = '', children }) {
    const ref = useRef(null);
    const [present, setPresent] = useState(show);
    if (show && !present) setPresent(true);

    const goneRef = useRef(onGone);
    useLayoutEffect(() => { goneRef.current = onGone; });

    // The `show` last acted on, null before the first draw. Guarding on it
    // rather than on mounting is what keeps StrictMode's second run of the
    // effect from starting the movement over.
    const acted = useRef(null);
    useLayoutEffect(() => {
        if (acted.current === show) return;
        const first = acted.current === null;
        acted.current = show;
        if (show) {
            if (!first || appear) growIn(ref.current);
        } else if (!first) {
            foldOut(ref.current, () => {
                setPresent(false);
                goneRef.current?.();
            });
        }
    }, [show, appear]);

    if (!present) return null;
    return <span ref={ref} className={`flex items-center shrink-0 ${className}`}>{children}</span>;
}

/**
 * Where something that has just left a list goes back in, so it folds where
 * it stood: after the nearest member it followed that is still there.
 */
function merge(drawn, items, latest) {
    const now = new Set(items.map(item => item.key));
    const was = new Map(drawn.map(entry => [entry.key, entry]));
    const out = items.map(item => ({ key: item.key, item, leaving: false, initial: Boolean(was.get(item.key)?.initial) }));
    drawn.forEach((entry, index) => {
        if (now.has(entry.key)) return;
        let at = 0;
        for (let before = index - 1; before >= 0; before -= 1) {
            const found = out.findIndex(other => other.key === drawn[before].key);
            if (found >= 0) {
                at = found + 1;
                break;
            }
        }
        const item = entry.leaving ? entry.item : (latest.get(entry.key) ?? entry.item);
        out.splice(at, 0, { ...entry, item, leaving: true });
    });
    return out;
}

/**
 * A list as the bar draws it while its members come and go: everything in
 * `items` (each with a `key`), and with them whatever has just left, kept
 * where it stood and marked `leaving` until `gone(key)` says its fold has
 * played. What was there when the list was first drawn is marked `initial`,
 * so it is simply there rather than growing in.
 */
function usePresence(items) {
    const signature = items.map(item => item.key).join('\n');
    const [state, setState] = useState(() => ({
        signature,
        drawn: items.map(item => ({ key: item.key, item, leaving: false, initial: true })),
    }));
    // Each member as it was last drawn, so one that leaves folds away with
    // its figures as they stood rather than as they were when it arrived.
    const latest = useRef(new Map());

    let { drawn } = state;
    if (state.signature !== signature) {
        drawn = merge(state.drawn, items, latest.current);
        setState({ signature, drawn });
    }

    const current = new Map(items.map(item => [item.key, item]));
    useEffect(() => { latest.current = current; });

    const gone = useCallback((key) => setState(previous => ({
        ...previous,
        drawn: previous.drawn.filter(entry => !(entry.key === key && entry.leaving)),
    })), []);

    return [drawn.map(entry => (entry.leaving ? entry : { ...entry, item: current.get(entry.key) })), gone];
}

/** One account's meters, under its name once there are two to tell apart. */
function AccountMeter({ meter, named, lead, now }) {
    const t = useT();
    const { account, entry, windows, pending } = meter;
    // Faded per account: one can be fresh while the other has not been read.
    const faded = !pending && now - lastRead(entry) > FADED_AFTER;
    return (
        <span className={`flex items-center shrink-0 ${lead} transition-[padding,opacity] duration-200 ${faded ? 'opacity-50' : ''}`}>
            <Unfold show={named} appear={false}>
                {/* An account named after its address goes by the part
                    before the @. */}
                <span className="shrink-0 max-w-[7rem] pr-1.5 truncate text-gray-500 dark:text-neutral-400">
                    {accountName(account, entry, t).short.split('@')[0]}
                </span>
            </Unfold>
            <span className="flex items-center gap-1.5 shrink-0">
                {pending ? <PendingMeter /> : windows.map(window => <Meter key={window.id} window={window} />)}
            </span>
        </span>
    );
}

/** One runtime: its mark and a meter for each ticked account. */
function ProviderGroup({ row, first, now }) {
    const [meters, gone] = usePresence(row.meters);
    return (
        <span className="flex items-center shrink-0">
            <Unfold show={!first} appear={false}>
                <span aria-hidden="true" className="shrink-0 w-px h-2.5 mx-2.5 bg-gray-300 dark:bg-white/10" />
            </Unfold>
            <span className="shrink-0 text-gray-500 dark:text-neutral-400 leading-none">
                <ProviderMark provider={row.provider} size={11} />
            </span>
            {meters.map(({ key, item, leaving, initial }, index) => (
                <Unfold key={key} show={!leaving} appear={!initial} onGone={() => gone(key)}>
                    <AccountMeter meter={item} named={row.named} lead={index === 0 ? 'pl-2' : 'pl-3'} now={now} />
                </Unfold>
            ))}
        </span>
    );
}

/**
 * The runtimes the bar speaks for, each with the account it runs under, its
 * figures, and every account ticked for it (`ticked`, the one in use among
 * them), each with its own figures.
 */
function useRows(overview, settings) {
    return useMemo(() => {
        const on = new Set(settings?.providers || []);
        return PROVIDER_ORDER.filter(provider => on.has(provider)).map((provider) => {
            const account = chosenAccount(overview, settings, provider);
            const entry = overview.limits?.[keyOf(provider, account?.id)];
            const others = (overview.accounts?.[provider] || []).filter(other => other.id !== account?.id);
            const ticked = tickedAccounts(overview, settings, provider)
                .map(each => ({ account: each, entry: overview.limits?.[keyOf(provider, each.id)] }));
            return { provider, account, entry, others, ticked, multi: Boolean(account) };
        });
    }, [overview, settings]);
}

export default function StatusBar({ agentId, agentName = '', tabs, onOpenSettings }) {
    const t = useT();
    const settings = useAgentSettings(agentId);
    const { overview, checking, check } = useUsageLimits();
    const rows = useRows(overview, settings);
    const [open, setOpen] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    const buttonRef = useRef(null);

    // Keep the figures for the accounts in use from going stale, and the
    // reset countdowns moving.
    useEffect(() => {
        const sweep = () => {
            setNow(Date.now());
            for (const row of rows) {
                // Only the plans that have windows to keep fresh; the others
                // are read when their settings card is opened.
                if (!row.multi || !PLAN_RUNTIMES.has(row.provider)) continue;
                // Every ticked account, since the bar shows each of them.
                for (const { account, entry } of row.ticked) {
                    const at = entry?.checkedAt || 0;
                    const after = entry?.error || unread(entry) ? RETRY_AFTER : STALE_AFTER;
                    if (Date.now() - at > after && !checking.has(keyOf(row.provider, account.id))) {
                        check(row.provider, account.id);
                    }
                }
            }
        };
        sweep();
        const timer = setInterval(sweep, TICK);
        return () => clearInterval(timer);
        // `checking` is read, not followed: a check finishing is not a reason
        // to look again, and following it would loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, check]);

    const planned = Boolean(settings) && settings.enabled !== false;

    // Each runtime with the ticked accounts that have a figure to draw, or
    // are about to. Named only when there are two or more, where the meters
    // need telling apart.
    const shown = rows
        .map(row => ({
            ...row,
            key: row.provider,
            named: row.ticked.length > 1,
            meters: row.ticked
                .map(({ account, entry }) => {
                    const windows = barWindows(entry?.windows);
                    // An account just ticked has nothing read yet. It takes
                    // its place at once and fills in when the read lands,
                    // rather than turning up seconds after the click.
                    const pending = windows.length === 0 && PLAN_RUNTIMES.has(row.provider) && !entry?.error
                        && (!entry || checking.has(keyOf(row.provider, account.id)));
                    return { key: account.id, account, entry, windows, pending };
                })
                .filter(meter => meter.windows.length > 0 || meter.pending),
        }))
        .filter(row => row.meters.length > 0);
    const [groups, groupGone] = usePresence(shown);
    const busy = rows.some(row => row.multi
        && row.ticked.some(({ account }) => checking.has(keyOf(row.provider, account.id))));

    const tone = worstTone(shown.flatMap(row => row.meters.flatMap(meter => meter.windows)));

    return (
        <footer
            className="h-5 shrink-0 flex items-center justify-between gap-4 app-no-drag select-none"
            // Tucked into the gutter below the content rather than adding a
            // row of its own: the window's frame already has the room.
            style={{ margin: '-6px 0 -8px' }}
        >
            {!planned && <span />}
            {planned && (
                <Tooltip label={t('statusBar.usageHint')} placement="top" enabled={!open}>
                    <button
                        ref={buttonRef}
                        type="button"
                        aria-haspopup="dialog"
                        aria-expanded={open}
                        aria-label={t('statusBar.usageLabel')}
                        onClick={() => setOpen(value => !value)}
                        className={`h-5 -ml-1.5 px-1.5 flex items-center rounded-md text-[10.5px] leading-none
                            tabular-nums font-medium transition-colors outline-none
                            focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                            ${open ? 'bg-gray-200 dark:bg-white/[0.08]' : 'hover:bg-gray-200/80 dark:hover:bg-white/[0.06]'}`}
                    >
                        {groups.length === 0 && (
                            <span className="flex items-center gap-1.5 text-gray-400 dark:text-neutral-500">
                                {busy
                                    ? <Loading03Icon size={11} className="animate-spin" />
                                    : <span className={`w-1.5 h-1.5 rounded-full ${tone === 'ok' ? 'bg-gray-400 dark:bg-neutral-500' : FILL[tone]}`} />}
                                {t('statusBar.usage')}
                            </span>
                        )}
                        {groups.map(({ key, item, leaving, initial }, index) => (
                            <Unfold key={key} show={!leaving} appear={!initial} onGone={() => groupGone(key)}>
                                <ProviderGroup row={item} first={index === 0} now={now} />
                            </Unfold>
                        ))}
                        <Unfold show={busy && groups.length > 0} appear={false}>
                            <Loading03Icon size={10} className="ml-2.5 shrink-0 animate-spin text-gray-400 dark:text-neutral-500" />
                        </Unfold>
                    </button>
                </Tooltip>
            )}

            <AppResources tabs={tabs} />

            {open && planned && (
                <UsagePanel
                    anchor={buttonRef}
                    rows={rows}
                    overview={overview}
                    settings={settings}
                    checking={checking}
                    now={now}
                    agentName={agentName}
                    onCheck={check}
                    onClose={() => setOpen(false)}
                    onManage={() => { setOpen(false); onOpenSettings?.('accounts'); }}
                />
            )}
        </footer>
    );
}
