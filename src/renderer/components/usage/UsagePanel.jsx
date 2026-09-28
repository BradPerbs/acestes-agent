import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cancel01Icon, Loading03Icon, Refresh01Icon, Settings02Icon } from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import { IconButton } from '../ui/Button';
import ProviderMark from '../../lib/provider-marks';
import { PROVIDER_NAMES } from '../../lib/ai-catalog';
import { PLAN_RUNTIMES, compact, keyOf, lastRead, sortWindows, span, toneOf, windowLabel, windowShort } from '../../lib/usage-limits';
import { useEnterOn } from '../../hooks/useEnter';
import { localeTag, useT } from '../../i18n';

/**
 * The status bar's expanded view: every account of every agent, side by side.
 *
 * Laid out as a table per agent, because the question it answers is a
 * comparison: which of my accounts has room left. Each agent names its two
 * windows once, as column heads, and every account is a row under them with
 * its figures in the same place, the one in use marked rather than drawn
 * bigger. A per-model window (Fable's weekly, Opus's) is a quieter row under
 * its account, in the column it belongs to.
 *
 * Switching is on the row: "Use" moves the selected agent to that account,
 * which is the thing to do when the one in use is near its limit.
 */

const PANEL_WIDTH = 520;
const EDGE = 12;

/** The column template every row of an agent shares, so the figures line up. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] gap-x-5';

const FILL = {
    ok: 'bg-gray-800/80 dark:bg-white/75',
    warn: 'bg-amber-500',
    over: 'bg-red-500',
};

const FIGURE = {
    ok: 'text-gray-900 dark:text-white',
    warn: 'text-amber-600 dark:text-amber-400',
    over: 'text-red-600 dark:text-red-400',
};

const MUTED = 'text-gray-400 dark:text-neutral-500';

const capital = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');

/** A reset moment as the user reads a clock: `Tue 14:20`. */
function when(ms) {
    try {
        return new Date(ms).toLocaleString(localeTag(), { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } catch {
        return new Date(ms).toLocaleString();
    }
}

/** One window in its column: the figure, when it resets, and a hairline. */
function WindowCell({ window, now, small = false }) {
    const t = useT();
    if (!window || window.used === null || window.used === undefined) {
        return <span className={`text-xs ${MUTED}`}>—</span>;
    }
    const tone = toneOf(window);
    const used = Math.round(window.used);
    const future = window.resetsAt && window.resetsAt > now;
    const reset = future
        ? t('statusBar.resetsShort', { span: span(window.resetsAt - now) })
        : window.lapsed ? t('settings.accounts.reset') : '';

    const resetText = reset && <span className={`text-[10px] tabular-nums truncate ${MUTED}`}>{reset}</span>;

    // The tooltip goes on the reset alone: it wraps what it is given in an
    // inline box, and around the whole cell that would shrink the cell to its
    // text and put every bar in the column at a different length.
    return (
        <div className="min-w-0 w-full">
            <div className="flex items-baseline justify-between gap-2">
                <span className={`${small ? 'text-[11px]' : 'text-[13px]'} font-semibold tabular-nums ${FIGURE[tone]}`}>
                    {used}%
                </span>
                {future
                    ? <Tooltip label={t('statusBar.resetsAt', { when: when(window.resetsAt) })} placement="top">{resetText}</Tooltip>
                    : resetText}
            </div>
            <div className={`${small ? 'mt-1' : 'mt-1.5'} h-[3px] rounded-full bg-gray-200/80 dark:bg-white/[0.07] overflow-hidden`}>
                <div
                    className={`h-full rounded-full ${FILL[tone]} transition-[width] duration-700`}
                    style={{ width: `${Math.max(used, used > 0 ? 3 : 0)}%` }}
                />
            </div>
        </div>
    );
}

/**
 * An account's windows, split the way the table reads them: the plan's own
 * five-hour and weekly in the two columns, and anything narrower (a model's
 * weekly, extra usage) as a row of its own under them.
 */
function splitWindows(windows) {
    const sorted = sortWindows(windows);
    const base = (window) => window.id.split(':').pop();
    const short = sorted.find(window => base(window) === 'five_hour');
    const week = sorted.find(window => base(window) === 'seven_day' || base(window) === 'seven_day_overage_included');
    const extra = sorted.filter(window => window !== short && window !== week);
    return { short, week, extra };
}

function extraLabel(window, t) {
    if (window.id.startsWith('model:')) return window.label;
    if (window.id === 'seven_day_opus') return 'Opus';
    if (window.id === 'seven_day_sonnet') return 'Sonnet';
    return windowLabel(window, t);
}

function AccountRow({ provider, account, entry, inUse, login, agentName, now, onUse, onSignIn, onCancelSignIn }) {
    const t = useT();
    const identity = entry?.identity;
    const email = identity?.email || '';
    const primary = email || (account.builtIn ? t('settings.accounts.machineLogin') : account.label);
    // What the address does not already say: that it is this computer's own
    // login, or the name it was given, when that is not just the address again.
    const secondary = account.builtIn
        ? t('statusBar.machine')
        : (account.label && account.label !== email ? account.label : '');
    const signedOut = identity && !identity.signedIn;
    const { short, week, extra } = splitWindows(entry?.windows);
    const nothingRead = !short && !week && extra.length === 0;

    let state = null;
    if (login) {
        state = (
            <span className="flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300">
                <Loading03Icon size={12} className="animate-spin shrink-0" />
                <span className="truncate">
                    {login.code ? t('settings.accounts.enterCode', { code: login.code }) : t('statusBar.waiting')}
                </span>
                <button type="button" onClick={onCancelSignIn} className={`ml-auto shrink-0 hover:text-gray-900 dark:hover:text-white ${MUTED}`} aria-label={t('common.cancel')}>
                    <Cancel01Icon size={12} strokeWidth={2} />
                </button>
            </span>
        );
    } else if (signedOut) {
        state = (
            <span className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-amber-600 dark:text-amber-400">{t('settings.accounts.signedOut')}</span>
                <button
                    type="button"
                    onClick={onSignIn}
                    className="px-2 h-6 rounded-md text-[11px] font-semibold bg-gray-900 dark:bg-white text-white dark:text-black hover:opacity-90"
                >
                    {t('settings.accounts.signIn')}
                </button>
            </span>
        );
    } else if (nothingRead && entry?.error) {
        state = (
            <Tooltip label={entry.error} placement="top">
                <span className={`block text-[11px] truncate ${MUTED}`}>{t('statusBar.unreadable')}</span>
            </Tooltip>
        );
    }

    return (
        <div className={`group -mx-2.5 px-2.5 py-2.5 rounded-xl transition-colors ${inUse
            ? 'bg-gray-50 dark:bg-white/[0.035]'
            : 'hover:bg-gray-50/70 dark:hover:bg-white/[0.02]'}`}
        >
            <div className={`${COLUMNS} items-center`}>
                <div className="flex items-start gap-2.5 min-w-0">
                    <Tooltip label={inUse ? t('statusBar.inUseBy', { name: agentName }) : t('statusBar.useHint', { name: agentName })} placement="top">
                        <button
                            type="button"
                            role="radio"
                            aria-checked={inUse}
                            disabled={inUse || signedOut}
                            onClick={onUse}
                            className="mt-[5px] w-2.5 h-2.5 shrink-0 rounded-full flex items-center justify-center outline-none
                                focus-visible:ring-2 focus-visible:ring-gray-900/25 dark:focus-visible:ring-white/30"
                        >
                            <span className={`block rounded-full transition-all ${inUse
                                ? 'w-2 h-2 bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]'
                                : 'w-2 h-2 border border-gray-300 dark:border-neutral-600 group-hover:border-gray-500 dark:group-hover:border-gray-400'}`}
                            />
                        </button>
                    </Tooltip>
                    <div className="min-w-0">
                        <div className="text-[13px] font-medium text-gray-900 dark:text-white truncate" title={primary}>{primary}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 min-w-0 text-[11px] text-gray-500 dark:text-gray-400">
                            {identity?.plan && (
                                <span className="shrink-0 px-1.5 py-px rounded-[5px] text-[9.5px] font-semibold uppercase tracking-[0.06em]
                                    bg-gray-200/70 dark:bg-white/[0.08] text-gray-600 dark:text-gray-300"
                                >
                                    {capital(identity.plan)}
                                </span>
                            )}
                            {secondary && <span className="truncate">{secondary}</span>}
                            {!identity && !login && <span className={`truncate ${MUTED}`}>{t('settings.accounts.notChecked')}</span>}
                            {inUse ? (
                                <span className="shrink-0 font-medium text-emerald-600 dark:text-emerald-400">{t('statusBar.inUse')}</span>
                            ) : !signedOut && !login && (
                                <button
                                    type="button"
                                    onClick={onUse}
                                    className="shrink-0 font-semibold text-gray-500 dark:text-gray-400 opacity-0 group-hover:opacity-100
                                        focus-visible:opacity-100 hover:text-gray-900 dark:hover:text-white transition-opacity"
                                >
                                    {t('statusBar.use')}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {state ? (
                    <div className="col-span-2 min-w-0">{state}</div>
                ) : (
                    <>
                        <WindowCell window={short} now={now} />
                        <WindowCell window={week} now={now} />
                    </>
                )}
            </div>

            {!state && extra.map(window => (
                <div key={window.id} className={`${COLUMNS} items-center mt-2`}>
                    <span className={`pl-5 text-[11px] truncate ${MUTED}`}>{extraLabel(window, t)}</span>
                    {windowShort(window) === '5h'
                        ? <><WindowCell window={window} now={now} small /><span /></>
                        : <><span /><WindowCell window={window} now={now} small /></>}
                </div>
            ))}
        </div>
    );
}

/** One agent that reports plan limits: its accounts as rows under two column heads. */
function AgentBlock({ row, overview, agentName, now, first }) {
    const t = useT();
    const { provider, account: current } = row;
    const accounts = overview.accounts?.[provider] || [];
    const logins = overview.logins || [];

    // What this computer sent through the agent today, over all its accounts.
    const today = accounts.reduce((sum, account) => {
        const bucket = overview.limits?.[keyOf(provider, account.id)]?.usage?.today;
        return { turns: sum.turns + (bucket?.turns || 0), tokens: sum.tokens + (bucket?.input || 0) + (bucket?.output || 0) };
    }, { turns: 0, tokens: 0 });

    const use = (id) => window.api.ai.setSettings({ accounts: { [provider]: id } }).catch(() => {});

    return (
        <section className={`px-5 py-4 ${first ? '' : 'border-t border-gray-100 dark:border-white/[0.06]'}`}>
            <div className={`${COLUMNS} items-end mb-1.5`}>
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-gray-800 dark:text-gray-100 leading-none"><ProviderMark provider={provider} size={14} /></span>
                    <span className="text-[13px] font-semibold text-gray-900 dark:text-white truncate">{PROVIDER_NAMES[provider]}</span>
                    {accounts.length > 1 && (
                        <span className={`text-[11px] ${MUTED}`}>{t('statusBar.accounts', { count: accounts.length })}</span>
                    )}
                </div>
                <span className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${MUTED}`}>{t('settings.accounts.window.fiveHour')}</span>
                <span className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${MUTED}`}>{t('settings.accounts.window.week')}</span>
            </div>

            <div className="space-y-0.5">
                {accounts.map(account => (
                    <AccountRow
                        key={account.id}
                        provider={provider}
                        account={account}
                        entry={overview.limits?.[keyOf(provider, account.id)]}
                        inUse={account.id === current?.id}
                        login={logins.find(entry => entry.provider === provider && entry.accountId === account.id)}
                        agentName={agentName}
                        now={now}
                        onUse={() => use(account.id)}
                        onSignIn={() => window.api.ai.accounts.login(provider, account.id).catch(() => {})}
                        onCancelSignIn={() => window.api.ai.accounts.cancelLogin(provider, account.id).catch(() => {})}
                    />
                ))}
            </div>

            {today.turns > 0 && (
                <p className={`mt-2 text-[11px] tabular-nums ${MUTED}`}>
                    {t('statusBar.fromHere', { summary: t('statusBar.todayShort', { tokens: compact(today.tokens), count: today.turns }) })}
                </p>
            )}
        </section>
    );
}

/** The agents with no plan to report, one quiet line each. */
function OtherAgents({ rows, overview, first }) {
    const t = useT();
    if (rows.length === 0) return null;
    return (
        <section className={`px-5 py-3.5 ${first ? '' : 'border-t border-gray-100 dark:border-white/[0.06]'}`}>
            <div className="flex items-baseline justify-between mb-1.5">
                <span className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${MUTED}`}>{t('statusBar.otherAgents')}</span>
                <span className={`text-[10px] ${MUTED}`}>{t('statusBar.noPlan')}</span>
            </div>
            <ul>
                {rows.map(({ provider, account }) => {
                    const today = overview.limits?.[keyOf(provider, account?.id || 'default')]?.usage?.today;
                    const tokens = (today?.input || 0) + (today?.output || 0);
                    return (
                        <li key={provider} className="flex items-center gap-2.5 h-7">
                            <span className="text-gray-500 dark:text-gray-400 leading-none"><ProviderMark provider={provider} size={12} /></span>
                            <span className="flex-1 min-w-0 text-xs text-gray-700 dark:text-gray-300 truncate">{PROVIDER_NAMES[provider]}</span>
                            <span className={`text-[11px] tabular-nums ${today?.turns ? 'text-gray-600 dark:text-gray-300' : MUTED}`}>
                                {today?.turns
                                    ? t('statusBar.todayShort', { tokens: compact(tokens), count: today.turns })
                                    : t('statusBar.quietToday')}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

export default function UsagePanel({ anchor, rows, overview, checking, now, agentName, onCheck, onClose, onManage }) {
    const t = useT();
    const panelRef = useRef(null);
    const [pos, setPos] = useState(null);

    useEnterOn(panelRef, pos && 'fade');

    // Measured before paint, so the panel never flashes in a corner first.
    useLayoutEffect(() => {
        const rect = anchor.current?.getBoundingClientRect();
        if (!rect) return;
        setPos({
            bottom: window.innerHeight - rect.top + 8,
            left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - EDGE)),
        });
    }, [anchor]);

    useEffect(() => {
        const handlePointer = (event) => {
            if (panelRef.current?.contains(event.target)) return;
            if (anchor.current?.contains(event.target)) return;
            onClose();
        };
        const handleKey = (event) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('mousedown', handlePointer);
        document.addEventListener('keydown', handleKey);
        window.addEventListener('resize', onClose);
        window.addEventListener('blur', onClose);
        return () => {
            document.removeEventListener('mousedown', handlePointer);
            document.removeEventListener('keydown', handleKey);
            window.removeEventListener('resize', onClose);
            window.removeEventListener('blur', onClose);
        };
    }, [anchor, onClose]);

    const planned = rows.filter(row => row.multi && PLAN_RUNTIMES.has(row.provider));
    const quiet = rows.filter(row => !planned.includes(row));
    const every = planned.flatMap(row => (overview.accounts?.[row.provider] || []).map(account => ({ provider: row.provider, account })));
    const busy = every.some(({ provider, account }) => checking.has(keyOf(provider, account.id)));
    const newest = Math.max(0, ...every.map(({ provider, account }) => lastRead(overview.limits?.[keyOf(provider, account.id)])));

    const refreshAll = useCallback(() => {
        for (const { provider, account } of every) onCheck(provider, account.id);
    }, [every, onCheck]);

    return createPortal(
        <div
            ref={panelRef}
            role="dialog"
            aria-label={t('statusBar.title')}
            className="fixed z-[9999] app-no-drag flex flex-col rounded-2xl overflow-hidden
                bg-white/95 dark:bg-neutral-900/95 backdrop-blur-xl
                border border-gray-200/80 dark:border-white/[0.08]
                shadow-[0_24px_64px_-12px_rgba(0,0,0,0.35)] dark:shadow-[0_24px_64px_-12px_rgba(0,0,0,0.7)]"
            style={{
                bottom: pos?.bottom ?? -9999,
                left: pos?.left ?? EDGE,
                width: PANEL_WIDTH,
                maxHeight: 'calc(100vh - 120px)',
                visibility: pos ? 'visible' : 'hidden',
            }}
        >
            <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-3.5 border-b border-gray-100 dark:border-white/[0.06]">
                <div className="min-w-0">
                    <h3 className="text-[15px] font-semibold tracking-tight text-gray-900 dark:text-white">{t('statusBar.title')}</h3>
                    <p className={`mt-0.5 text-[11px] ${MUTED}`}>
                        {busy
                            ? t('settings.accounts.checking')
                            : newest > 0 ? t('statusBar.checked', { span: span(now - newest) }) : t('statusBar.desc')}
                        <span> · {t('statusBar.subtitle')}</span>
                    </p>
                </div>
                {every.length > 0 && (
                    <IconButton
                        size="sm"
                        variant="ghost"
                        title={t('settings.accounts.checkAll')}
                        disabled={busy}
                        icon={busy
                            ? <Loading03Icon size={14} className="animate-spin" />
                            : <Refresh01Icon size={14} strokeWidth={2} />}
                        onClick={refreshAll}
                    />
                )}
            </header>

            <div className="overflow-y-auto">
                {planned.map((row, index) => (
                    <AgentBlock key={row.provider} row={row} overview={overview} agentName={agentName} now={now} first={index === 0} />
                ))}
                <OtherAgents rows={quiet} overview={overview} first={planned.length === 0} />
            </div>

            <footer className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-100 dark:border-white/[0.06]
                bg-gray-50/60 dark:bg-white/[0.02]"
            >
                <span className={`text-[11px] truncate ${MUTED}`}>
                    {agentName ? t('statusBar.forAgent', { name: agentName }) : ''}
                </span>
                <button
                    type="button"
                    onClick={onManage}
                    className="flex items-center gap-1.5 shrink-0 text-[11px] font-semibold text-gray-600 dark:text-gray-300
                        hover:text-gray-900 dark:hover:text-white transition-colors"
                >
                    <Settings02Icon size={12} strokeWidth={2} />
                    {t('statusBar.manage')}
                </button>
            </footer>
        </div>,
        document.body,
    );
}

