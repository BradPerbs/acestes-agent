import Tooltip from '../ui/Tooltip';
import { compact, span, toneOf, windowLabel } from '../../lib/usage-limits';
import { useT } from '../../i18n';

/**
 * One plan window, full size: its name, how much is used, when it resets,
 * and a bar. Used on the settings card and in the status bar's panel.
 */

export const BAR = {
    ok: 'bg-emerald-500',
    warn: 'bg-amber-500',
    over: 'bg-red-500',
};

export const FIGURE = {
    ok: 'text-gray-700 dark:text-gray-300',
    warn: 'text-amber-600 dark:text-amber-400',
    over: 'text-red-600 dark:text-red-400',
};

export default function LimitBar({ window, now }) {
    const t = useT();
    const tone = toneOf(window);
    const used = window.used === null || window.used === undefined ? null : Math.round(window.used);
    const resets = window.resetsAt && window.resetsAt > now
        ? t('settings.accounts.resetsIn', { span: span(window.resetsAt - now) })
        : window.lapsed ? t('settings.accounts.reset') : '';

    return (
        <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-gray-500 dark:text-gray-400 truncate">{windowLabel(window, t)}</span>
                <span className={`tabular-nums shrink-0 ${FIGURE[tone]}`}>
                    {used === null ? '—' : `${used}%`}
                    {resets && <span className="text-gray-400 dark:text-neutral-500"> · {resets}</span>}
                </span>
            </div>
            <div
                className="mt-1 h-1.5 rounded-full bg-gray-100 dark:bg-neutral-700/60 overflow-hidden"
                role="meter"
                aria-label={windowLabel(window, t)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={used ?? 0}
            >
                <div className={`h-full rounded-full ${BAR[tone]} transition-[width] duration-500`} style={{ width: `${used ?? 0}%` }} />
            </div>
        </div>
    );
}

/** What this computer sent through one account, today and over the week. */
export function UsageLine({ usage, priced, className = '' }) {
    const t = useT();
    if (!usage || (!usage.week?.turns && !usage.today?.turns)) {
        return <p className={`text-xs text-gray-400 dark:text-neutral-500 ${className}`}>{t('settings.accounts.noUsage')}</p>;
    }
    const part = (bucket) => {
        const tokens = (bucket.input || 0) + (bucket.output || 0);
        const bits = [t('settings.accounts.turns', { count: bucket.turns })];
        if (tokens) bits.push(t('settings.accounts.tokens', { amount: compact(tokens) }));
        if (priced && bucket.costUsd) bits.push(`$${bucket.costUsd.toFixed(2)}`);
        return bits.join(' · ');
    };
    return (
        <Tooltip label={t('settings.accounts.usageHint')} placement="top">
            <p className={`text-xs text-gray-500 dark:text-gray-400 tabular-nums ${className}`}>
                {t('settings.accounts.today')} {part(usage.today)}
                <span className="text-gray-400 dark:text-neutral-500"> · {t('settings.accounts.week')} {part(usage.week)}</span>
            </p>
        </Tooltip>
    );
}
