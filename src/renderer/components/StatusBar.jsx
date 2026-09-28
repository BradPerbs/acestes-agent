import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Loading03Icon } from 'hugeicons-react';
import Tooltip from './ui/Tooltip';
import UsagePanel from './usage/UsagePanel';
import AppResources from './usage/AppResources';
import ProviderMark from '../lib/provider-marks';
import { PROVIDER_ORDER } from '../lib/ai-catalog';
import {
    PLAN_RUNTIMES, STALE_AFTER, chosenAccount, compact, headlineWindows, keyOf, lastRead, toneOf, windowShort, worstTone,
} from '../lib/usage-limits';
import useUsageLimits, { useAgentSettings } from '../hooks/useUsageLimits';
import { useT } from '../i18n';

/**
 * The strip along the bottom of the window.
 *
 * Its left end is the plan limits of the agents that are switched on, for the
 * account each one runs under: the five-hour and weekly windows as a hairline
 * meter and a figure, one runtime after another, close enough to glance at
 * without going anywhere. Clicking it opens the whole picture above it: every
 * window with its reset, what this computer sent, the other accounts and how
 * much each has left, and a way to switch to one.
 *
 * Its right end is the app itself: what it holds in memory, how many tabs are
 * open, and a coffee cup that keeps the computer from sleeping. That end stays
 * when the agent is switched off; the plan figures go with it.
 *
 * It keeps the figures fresh on its own. The accounts in use are read when
 * the app opens and again whenever what is held is older than a quarter of an
 * hour; a read starts the runtime for a couple of seconds and sends nothing
 * to a model. Between reads, every turn's own rate-limit events move it.
 */

/** How often the bar looks for a figure gone stale. */
const TICK = 60 * 1000;
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

/** The runtimes the bar speaks for, each with the account it runs under and its figures. */
function useRows(overview, settings) {
    return useMemo(() => {
        const on = new Set(settings?.providers || []);
        return PROVIDER_ORDER.filter(provider => on.has(provider)).map((provider) => {
            const account = chosenAccount(overview, settings, provider);
            const entry = overview.limits?.[keyOf(provider, account?.id)];
            const others = (overview.accounts?.[provider] || []).filter(other => other.id !== account?.id);
            return { provider, account, entry, others, multi: Boolean(account) };
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
                const at = row.entry?.checkedAt || 0;
                if (Date.now() - at > STALE_AFTER && !checking.has(keyOf(row.provider, row.account.id))) {
                    check(row.provider, row.account.id);
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

    const shown = rows
        .map(row => ({ ...row, headline: headlineWindows(row.entry?.windows) }))
        .filter(row => row.headline.length > 0);
    const busy = rows.some(row => row.multi && checking.has(keyOf(row.provider, row.account.id)));

    // What every runtime sent from here today, for the end of the strip.
    const today = Object.values(overview.limits || {}).reduce((sum, entry) => {
        const bucket = entry?.usage?.today;
        return {
            turns: sum.turns + (bucket?.turns || 0),
            tokens: sum.tokens + (bucket?.input || 0) + (bucket?.output || 0),
        };
    }, { turns: 0, tokens: 0 });

    const tone = worstTone(shown.flatMap(row => row.headline));

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
                        className={`h-5 -ml-1.5 px-1.5 flex items-center gap-2.5 rounded-md text-[10.5px] leading-none
                            tabular-nums font-medium transition-colors outline-none
                            focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                            ${open ? 'bg-gray-200 dark:bg-white/[0.08]' : 'hover:bg-gray-200/80 dark:hover:bg-white/[0.06]'}`}
                    >
                        {shown.length === 0 && (
                            <span className="flex items-center gap-1.5 text-gray-400 dark:text-neutral-500">
                                {busy
                                    ? <Loading03Icon size={11} className="animate-spin" />
                                    : <span className={`w-1.5 h-1.5 rounded-full ${tone === 'ok' ? 'bg-gray-400 dark:bg-neutral-500' : FILL[tone]}`} />}
                                {t('statusBar.usage')}
                            </span>
                        )}
                        {shown.map((row, index) => {
                            const faded = now - lastRead(row.entry) > FADED_AFTER;
                            return (
                                <Fragment key={row.provider}>
                                    {index > 0 && <span aria-hidden="true" className="w-px h-2.5 bg-gray-300 dark:bg-white/10" />}
                                    <span className={`flex items-center gap-2 transition-opacity ${faded ? 'opacity-50' : ''}`}>
                                        <span className="text-gray-500 dark:text-neutral-400 leading-none">
                                            <ProviderMark provider={row.provider} size={11} />
                                        </span>
                                        {row.headline.map(window => <Meter key={window.id} window={window} />)}
                                    </span>
                                </Fragment>
                            );
                        })}
                        {today.turns > 0 && (
                            <>
                                <span aria-hidden="true" className="w-px h-2.5 bg-gray-300 dark:bg-white/10" />
                                <span className="text-gray-400 dark:text-neutral-500">
                                    {t('statusBar.today', { tokens: compact(today.tokens), count: today.turns })}
                                </span>
                            </>
                        )}
                        {busy && shown.length > 0 && <Loading03Icon size={10} className="animate-spin text-gray-400 dark:text-neutral-500" />}
                    </button>
                </Tooltip>
            )}

            <AppResources tabs={tabs} />

            {open && planned && (
                <UsagePanel
                    anchor={buttonRef}
                    rows={rows}
                    overview={overview}
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
