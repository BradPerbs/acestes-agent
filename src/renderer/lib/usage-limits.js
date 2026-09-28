/**
 * How the plan limits and usage kept by the main process are read and named.
 *
 * Shared by the settings card and the status bar, which draw the same
 * figures at two sizes and must never disagree about which window is which
 * or when one counts as close to its limit.
 */

/** Older than this and a figure is worth reading again. */
export const STALE_AFTER = 15 * 60 * 1000;

/**
 * The runtimes whose plan reports its own windows. The rest are counted here
 * (turns, tokens) but have no limit of theirs to show.
 */
export const PLAN_RUNTIMES = new Set(['claude-code', 'codex', 'muse', 'antigravity']);

const WINDOW_ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'];

export const keyOf = (provider, accountId) => `${provider}:${accountId || 'default'}`;

/** A span of time as its two largest units: `2h 10m`, `3d 4h`, `45m`. */
export function span(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const rest = minutes % 60;
    if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return rest ? `${hours}h ${rest}m` : `${hours}h`;
    return `${rest}m`;
}

const baseOf = (window) => (window.id.includes(':') && !window.id.startsWith('model:') ? window.id.split(':').pop() : window.id);

export function windowLabel(window, t) {
    const base = baseOf(window);
    let name;
    if (base === 'five_hour') name = t('settings.accounts.window.fiveHour');
    else if (base === 'seven_day' || base === 'seven_day_overage_included') name = t('settings.accounts.window.week');
    else if (base === 'seven_day_opus') name = t('settings.accounts.window.weekModel', { model: 'Opus' });
    else if (base === 'seven_day_sonnet') name = t('settings.accounts.window.weekModel', { model: 'Sonnet' });
    else if (base === 'seven_day_oauth_apps') name = t('settings.accounts.window.weekModel', { model: t('settings.accounts.window.apps') });
    else if (base === 'extra_usage') name = t('settings.accounts.window.extra');
    else if (window.id.startsWith('model:')) name = t('settings.accounts.window.weekModel', { model: window.label });
    else if (window.minutes) name = t('settings.accounts.window.span', { span: span(window.minutes * 60000) });
    else name = window.label || window.id;
    // A second metered bucket keeps its own name in front.
    return window.label && !window.id.startsWith('model:') ? `${window.label} · ${name}` : name;
}

/** The two-letter name the status bar has room for: `5h`, `7d`. */
export function windowShort(window) {
    const base = baseOf(window);
    if (base === 'five_hour') return '5h';
    if (base.startsWith('seven_day') || window.id.startsWith('model:')) return '7d';
    if (window.minutes) return span(window.minutes * 60000).split(' ')[0];
    return '';
}

export function sortWindows(windows) {
    const rank = (window) => {
        const index = WINDOW_ORDER.indexOf(window.id.startsWith('model:') ? 'seven_day_opus' : baseOf(window));
        return index < 0 ? WINDOW_ORDER.length : index;
    };
    return [...(windows || [])].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/**
 * The two windows the status bar shows: the plan's five-hour and its weekly
 * one, each the plan-wide figure rather than a per-model one. Where a plan
 * has only per-model weeks, the tightest of them stands in.
 */
export function headlineWindows(windows) {
    const list = sortWindows(windows).filter(window => window.used !== null && window.used !== undefined);
    const short = list.find(window => baseOf(window) === 'five_hour');
    const week = list.find(window => baseOf(window) === 'seven_day')
        || list.filter(window => windowShort(window) === '7d').sort((a, b) => b.used - a.used)[0];
    return [short, week].filter(Boolean);
}

/** How loud a window is: over, close, or fine. */
export function toneOf(window) {
    if (!window) return 'ok';
    if (window.status === 'rejected' || (window.used ?? 0) >= 100) return 'over';
    if (window.status === 'allowed_warning' || (window.used ?? 0) >= 80) return 'warn';
    return 'ok';
}

/** The loudest tone of several windows, for a row that speaks for all of them. */
export function worstTone(windows) {
    const tones = (windows || []).map(toneOf);
    if (tones.includes('over')) return 'over';
    if (tones.includes('warn')) return 'warn';
    return 'ok';
}

export const compact = (n) => {
    if (!n) return '0';
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(n);
};

/**
 * The account a runtime runs under for these settings: the one chosen, if
 * it still exists, and the machine's own otherwise. Mirrors the main
 * process's resolution so the bar names the account that will answer.
 */
export function chosenAccount(overview, settings, provider) {
    const list = overview?.accounts?.[provider];
    if (!Array.isArray(list)) return null;
    const wanted = settings?.accounts?.[provider];
    return list.find(account => account.id === wanted) || list.find(account => account.builtIn) || list[0] || null;
}

/** When one account's figures were last read, from a check or a turn. */
export function lastRead(entry) {
    return Math.max(entry?.checkedAt || 0, ...((entry?.windows || []).map(window => window.at || 0)));
}

/** Who an account is, in one line: its email, plan and organisation. */
export function identityLine(entry, t) {
    const identity = entry?.identity;
    if (!identity) return entry?.error || t('settings.accounts.notChecked');
    if (!identity.signedIn) return t('settings.accounts.signedOut');
    const plan = identity.plan ? identity.plan.charAt(0).toUpperCase() + identity.plan.slice(1) : '';
    return [identity.email, plan && t('settings.accounts.plan', { plan }), identity.organization]
        .filter(Boolean)
        .join(' · ') || t('settings.accounts.signedIn');
}
