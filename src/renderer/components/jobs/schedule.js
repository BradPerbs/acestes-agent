import { Activity01Icon, Calendar03Icon, Clock01Icon, WebhookIcon, ZapIcon } from 'hugeicons-react';

/**
 * What the Jobs page, its editor and its library share about time: how a
 * moment reads, how a run's length reads, the icon each kind of schedule
 * wears, and the presets offered under the schedule fields.
 */

/** "in 12m", "in 3h 5m", or a short date and time. */
export function when(stamp, now = Date.now()) {
    if (!stamp) return '';
    const delta = stamp - now;
    if (delta > 0 && delta < 86400000) {
        const minutes = Math.max(1, Math.round(delta / 60000));
        if (minutes < 60) return `in ${minutes}m`;
        return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
    if (delta <= 0 && delta > -86400000) {
        const minutes = Math.round(-delta / 60000);
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        return `${Math.floor(minutes / 60)}h ago`;
    }
    return new Date(stamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** A moment in full, for the schedule preview: "Tue 1 Oct, 09:00". */
export function moment(stamp) {
    return new Date(stamp).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function duration(run) {
    if (!run?.startedAt) return '';
    const end = run.endedAt || Date.now();
    const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export function describeEvery(ms) {
    if (ms % 86400000 === 0) return `${ms / 86400000}d`;
    if (ms % 3600000 === 0) return `${ms / 3600000}h`;
    return `${Math.round(ms / 60000)}m`;
}

export const KIND_ICON = {
    every: Clock01Icon,
    cron: Calendar03Icon,
    at: Calendar03Icon,
    heartbeat: Activity01Icon,
    event: ZapIcon,
    webhook: WebhookIcon,
};

/** One click to the schedules people ask for most. */
export const CRON_PRESETS = [
    { id: 'hourly', expr: '0 * * * *' },
    { id: 'daily', expr: '0 9 * * *' },
    { id: 'weekdays', expr: '0 9 * * 1-5' },
    { id: 'weekly', expr: '0 9 * * 1' },
    { id: 'monthly', expr: '0 9 1 * *' },
];

export const EVERY_PRESETS = ['5m', '15m', '30m', '1h', '6h', '1d'];

/** Run statuses to a dot colour, the same ones the Runs page uses. */
export const STATUS_DOT = {
    queued: 'bg-gray-400',
    running: 'bg-blue-500 animate-pulse',
    parked: 'bg-amber-500',
    done: 'bg-emerald-500',
    failed: 'bg-red-500',
    cancelled: 'bg-gray-400 dark:bg-gray-600',
    skipped: 'bg-gray-300 dark:bg-neutral-600',
};

export const LIVE_STATUSES = new Set(['queued', 'running', 'parked']);

/** The selectable chip row the MCP library uses for its categories. */
export const CHIP = `h-7 px-2.5 rounded-lg text-[11px] font-medium transition-colors outline-none shrink-0
    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25`;
export const CHIP_ON = 'bg-gray-900 text-white dark:bg-white dark:text-gray-900';
export const CHIP_OFF = `bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-gray-300
    hover:bg-gray-200 dark:hover:bg-neutral-700`;
