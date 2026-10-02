import { useEffect, useState } from 'react';
import AgentMark from './AgentMark';
import { describeCall } from './ToolCall';
import { INITIAL_THEME } from '../../lib/app-colors';
import { useT } from '../../i18n';

/**
 * The agents at work, in the bottom-right corner of the screen.
 *
 * A window of its own (see main/ai/overlay.js): transparent, click-through,
 * never focused, and kept out of screen capture. While an agent drives the
 * desktop, Acestes is usually behind the app it is working in, so this is
 * how the person watching knows it is still at it between one click and the
 * next. One card per conversation at work, stacked from the bottom: whose it
 * is, what it is doing this moment, and the last thing it said. Nothing to
 * press; the chat itself is in Acestes.
 */

/** What an agent is doing, by the tool it is in, as a live verb. */
const DOING = {
    click: 'activity.clicking',
    type_text: 'activity.typing',
    press_keys: 'activity.pressing',
    scroll: 'activity.scrolling',
    drag: 'activity.dragging',
    read_screen: 'activity.reading',
    read_text: 'activity.reading',
    screenshot: 'activity.looking',
    zoom: 'activity.looking',
    wait_for: 'activity.waitingFor',
    do_steps: 'activity.steps',
    open_app: 'activity.opening',
    arrange_windows: 'activity.arranging',
    list_windows: 'activity.looking',
};

/** The dot beside the title: moving, thinking, waiting on you, finished. */
const DOTS = {
    acting: 'bg-[#2f7bf6] animate-pulse',
    thinking: 'bg-gray-400 dark:bg-gray-500 animate-pulse',
    waiting: 'bg-amber-500',
    done: 'bg-emerald-500',
};

function status(t, row) {
    if (row.phase === 'waiting') return t('activity.waitingForYou');
    if (row.phase === 'done') return t('activity.done');
    if (row.phase === 'thinking' || !row.tool) return t('activity.thinking');
    const verb = DOING[row.tool.name];
    // What it is aimed at by name, once found; the call's own words until then.
    const detail = row.tool.aim
        || (row.tool.name === 'do_steps'
            ? t('activity.stepCount', { count: (row.tool.input?.steps || []).length })
            : describeCall(row.tool.name, row.tool.input || {}).text);
    if (!verb) return t('activity.using', { tool: row.tool.name.replace(/_/g, ' ') });
    return detail ? `${t(verb)} · ${detail}` : t(verb);
}

/** Theme changes made in the main window, followed here, the way the assistant's own windows do. */
function useFollowTheme() {
    useEffect(() => {
        const apply = () => {
            const stored = localStorage.getItem('theme') || INITIAL_THEME;
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.classList.toggle(
                'dark',
                stored === 'dark' || stored === 'custom' || (stored === 'system' && prefersDark),
            );
        };
        const onStorage = (event) => {
            if (event.key === 'theme' || event.key === null) apply();
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);
}

function Card({ row }) {
    const t = useT();
    // In from a few pixels below, once: the card arriving is the news.
    const [shown, setShown] = useState(false);
    useEffect(() => {
        const frame = requestAnimationFrame(() => setShown(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    return (
        <div
            className={`w-full rounded-2xl px-3 py-2.5 transition-all duration-300 ease-out
                bg-white/95 dark:bg-[#17171e]/95
                ring-1 ring-black/[0.06] dark:ring-white/[0.08]
                shadow-[0_6px_24px_rgba(0,0,0,0.18)]
                ${shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1.5'}
                ${row.done ? 'opacity-70' : ''}`}
        >
            <div className="flex items-center gap-2 min-w-0">
                <AgentMark size={16} look={row.look} />
                <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-gray-900 dark:text-gray-100">
                    {row.title || row.agent || t('activity.untitled')}
                </span>
                <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${DOTS[row.phase] || DOTS.thinking}`} />
            </div>
            <div className="mt-1 truncate text-[11px] text-gray-600 dark:text-gray-300">
                {status(t, row)}
            </div>
            {row.said && (
                <div className="mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400 line-clamp-2">
                    {row.said}
                </div>
            )}
        </div>
    );
}

export default function ActivityOverlay() {
    useFollowTheme();
    const [rows, setRows] = useState([]);

    useEffect(() => window.api.ai.onActivity?.((payload) => {
        setRows(Array.isArray(payload?.rows) ? payload.rows : []);
    }), []);

    // Stacked from the bottom, newest nearest the corner; three at most, which
    // is all a glance takes in.
    const shown = rows.slice(-3);

    return (
        <div className="h-full w-full flex flex-col justify-end gap-2 p-2.5 font-inter select-none pointer-events-none">
            {shown.map(row => <Card key={row.id} row={row} />)}
        </div>
    );
}
