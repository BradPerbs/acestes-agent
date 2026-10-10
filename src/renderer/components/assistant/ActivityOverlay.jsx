import { useEffect, useState } from 'react';
import AgentMark from './AgentMark';
import { describeCall } from './ToolCall';
import { Ring, RollingPhrase, activityOf, elapsed, usePhrase, useSeconds } from './WorkingIndicator';
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
 * is and for how long, what it is doing this moment, and the last thing it
 * said. Nothing to press; the chat itself is in Acestes.
 *
 * The working line is the one under a turn in the app (WorkingIndicator.jsx):
 * the turning ring and a phrase with the glint over it, rolling over to the
 * next. Between actions it is the app's own thinking phrases; during one it
 * names the action and what it is aimed at, which is what the person
 * watching wants to know while the cursor is moving.
 */

/** What an agent is doing, by the tool it is in, as a live verb. */
const DOING = {
    click: 'activity.clicking',
    type_text: 'activity.typing',
    press_keys: 'activity.pressing',
    scroll: 'activity.scrolling',
    drag: 'activity.dragging',
    hover: 'activity.pointing',
    mouse_button: 'activity.pressing',
    hold_key: 'activity.holding',
    read_clipboard: 'activity.reading',
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

/** A desktop action as words: the verb, and what it is aimed at by name once found, the call's own words until then. */
function action(t, tool) {
    const verb = DOING[tool.name];
    const detail = tool.aim
        || (tool.name === 'do_steps'
            ? t('activity.stepCount', { count: (tool.input?.steps || []).length })
            : describeCall(tool.name, tool.input || {}).text);
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

/**
 * The ring and the rolling phrase, while the agent is thinking or acting.
 *
 * A desktop action is named for as long as it runs, and keeps its place in
 * the cell when what it is aimed at turns up a moment later. Any other tool
 * (a shell command, a file read) gets the app's phrases for that kind of
 * work, the way the line under a turn does.
 */
function Working({ row }) {
    const tool = row.phase === 'acting' ? row.tool : null;
    const named = Boolean(tool && DOING[tool.name]);
    const t = useT();
    const phrase = usePhrase(tool && !named ? activityOf(tool.name) : 'think');
    const text = named ? action(t, tool) : phrase;

    return (
        <div className="working-loud mt-1.5 flex items-center gap-2 min-w-0 text-[11.5px]">
            <Ring className={tool ? 'text-[#2f7bf6]' : 'text-gray-500 dark:text-gray-400'} />
            <RollingPhrase fit text={text} cue={named ? `act:${tool.seq}` : phrase} />
        </div>
    );
}

/** Waiting on an answer in Acestes: the one state that wants the person watching. */
function Waiting() {
    const t = useT();
    return (
        <div className="mt-1.5 flex items-center gap-2 min-w-0 text-[11.5px] text-amber-600 dark:text-amber-400">
            <span aria-hidden="true" className="relative w-3 h-3 shrink-0 flex items-center justify-center">
                <span className="absolute inset-0.5 rounded-full bg-amber-500/40 motion-safe:animate-ping" />
                <span className="relative w-1.5 h-1.5 rounded-full bg-amber-500" />
            </span>
            <span className="truncate">{t('activity.waitingForYou')}</span>
        </div>
    );
}

function Done() {
    const t = useT();
    return (
        <div className="mt-1.5 flex items-center gap-2 min-w-0 text-[11.5px] text-gray-500 dark:text-gray-400">
            <svg viewBox="0 0 12 12" className="w-3 h-3 shrink-0 text-emerald-500" aria-hidden="true">
                <path
                    d="M2.75 6.25 5 8.5l4.25-4.75" fill="none" stroke="currentColor"
                    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                />
            </svg>
            <span className="truncate">{t('activity.done')}</span>
        </div>
    );
}

function Card({ row }) {
    const t = useT();
    // In from a few pixels below, once: the card arriving is the news.
    const [shown, setShown] = useState(false);
    useEffect(() => {
        const frame = requestAnimationFrame(() => setShown(true));
        return () => cancelAnimationFrame(frame);
    }, []);

    // How long it has been at it, after the first few seconds, as under a
    // turn in the app; stopped where it let go.
    const seconds = useSeconds(row.since || Date.now(), row.ended);

    return (
        <div
            role="status"
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
                {seconds >= 3 && (
                    <span className="shrink-0 tabular-nums text-[10.5px] text-gray-400 dark:text-gray-500">
                        {elapsed(seconds)}
                    </span>
                )}
            </div>
            {row.phase === 'waiting'
                ? <Waiting />
                : row.phase === 'done'
                    ? <Done />
                    : <Working row={row} />}
            {row.said && (
                <div className="mt-1 text-[11px] leading-snug text-gray-500 dark:text-gray-400 line-clamp-2">
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
