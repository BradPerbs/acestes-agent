import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';

/**
 * The line under the transcript while a turn is open and nothing is on screen
 * yet: no words streaming, no question standing.
 *
 * It says what kind of work is going on, not just that some is. The phrase is
 * drawn from the tool that is running right now, so a shell command reads as
 * poking the shell and an edit as writing code, and between tools it falls back
 * to thinking. The phrase turns over every few seconds, because a line that
 * never changes looks stuck by the tenth second, and after a few seconds the
 * elapsed time shows beside it for the same reason.
 *
 * Its parts (the ring, the rolling phrase, the phrase that turns over, the
 * clock) are exported for the card in the corner of the screen while an agent
 * drives the desktop (ActivityOverlay.jsx), so the two read as one thing.
 */

/** Our own tools, by what the work looks like from the outside. */
const ACTIVITY = {
    run_command: 'shell',
    send_input: 'shell',
    read_terminal: 'shell',
    read_file: 'read',
    list_directory: 'read',
    search_local_files: 'read',
    search_conversations: 'read',
    read_conversation: 'read',
    recall: 'read',
    list_hosts: 'read',
    list_sessions: 'read',
    list_snippets: 'read',
    read_snippet: 'read',
    list_inventory: 'read',
    write_file: 'write',
    edit_file: 'write',
    edit_local_file: 'write',
    save_snippet: 'write',
    save_host: 'write',
    save_proxy: 'write',
    save_key: 'write',
    save_mcp_server: 'write',
    save_folder: 'write',
    remember: 'write',
    connect_host: 'connect',
    disconnect_session: 'connect',
    Agent: 'agent',
    Task: 'agent',
};

/** A runtime's own tools (Bash, Edit, Grep…), guessed from the name. */
function guess(name = '') {
    const lower = name.toLowerCase();
    if (/bash|shell|exec|command|terminal|powershell/.test(lower)) return 'shell';
    if (/edit|write|patch|create|save|notebook/.test(lower)) return 'write';
    if (/read|list|search|grep|glob|find|fetch|recall|view/.test(lower)) return 'read';
    if (/connect|ssh/.test(lower)) return 'connect';
    return 'think';
}

/** Which phrase list a tool's work is drawn from: shell, read, write, connect, agent or think. */
export function activityOf(name) {
    return name ? (ACTIVITY[name] || guess(name)) : 'think';
}

/** The newest call still running, or null between calls. */
function runningTool(items) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.kind === 'user') return null;
        if (item.kind === 'tool' && item.status === 'running') return item;
        // A subagent sent off in the background: its call came back at
        // once, and the turn is open because of what it is still doing.
        if (item.kind === 'tool' && item.task?.status === 'running') return item;
    }
    return null;
}

const TURN_EVERY = 2600;

/** How long one phrase takes to roll out and the next to roll in, in ms. */
const ROLL = 240;

const stillMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Seconds as "12s" or "1m 04s". */
export function elapsed(seconds) {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Whole seconds from `since` to now, ticking; or to `until`, standing still, once there is one. */
export function useSeconds(since, until = 0) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (until) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [until]);
    return Math.max(0, Math.floor(((until || now) - since) / 1000));
}

/** A thin ring with a quarter of it drawn in, turning. */
export function Ring({ className = '' }) {
    return (
        <svg viewBox="0 0 12 12" className={`working-ring w-3 h-3 shrink-0 ${className}`} aria-hidden="true">
            <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
            <circle
                cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeDasharray="7.5 30"
            />
        </svg>
    );
}

/**
 * One phrase from the list for a kind of work, turning over every few
 * seconds. A new kind of work starts on a random phrase, so two turns in a
 * row do not open with the same word.
 */
export function usePhrase(activity) {
    const t = useT();
    const phrases = useMemo(
        () => t(`assistant.working.${activity}`).split('|').map(phrase => phrase.trim()).filter(Boolean),
        [t, activity],
    );

    const [turn, setTurn] = useState(() => Math.floor(Math.random() * 1000));
    useEffect(() => {
        setTurn(Math.floor(Math.random() * 1000));
        if (stillMotion()) return undefined;
        const timer = setInterval(() => setTurn(value => value + 1), TURN_EVERY);
        return () => clearInterval(timer);
    }, [activity]);

    return `${phrases[turn % phrases.length] || t('assistant.working')}…`;
}

/**
 * A phrase with the glint passing over it, rolling up out of the cell when
 * `cue` changes and the new one rolling in under it.
 *
 * `cue` is what counts as a new phrase, and is the text itself unless said
 * otherwise. The overlay names an action and then, a moment later, what it
 * is aimed at; that is the same action said better, so it changes in place
 * rather than rolling.
 *
 * `fit` is for a row with nothing beside the phrase: the cell takes the rest
 * of the row and cuts a phrase too long for it with an ellipsis, instead of
 * easing its width to each one.
 */
export function RollingPhrase({ text, cue = text, fit = false }) {
    // The outgoing phrase stays for one roll, sharing the cell with the new
    // one, so the change reads as a single motion rather than a swap.
    // Laid out before paint, so the new phrase is never seen standing still
    // for a frame before its entrance starts.
    const shownText = useRef(text);
    const lastCue = useRef(cue);
    const rolls = useRef(0);
    const [leaving, setLeaving] = useState(null);
    useLayoutEffect(() => {
        if (lastCue.current === cue) return undefined;
        lastCue.current = cue;
        if (stillMotion()) return undefined;
        rolls.current += 1;
        setLeaving({ text: shownText.current, key: rolls.current });
        const timer = setTimeout(() => setLeaving(null), ROLL);
        return () => clearTimeout(timer);
    }, [cue]);
    // After the cue's check above, so on a change that one reads the text
    // the old cue last showed.
    useLayoutEffect(() => {
        shownText.current = text;
    });

    // The cell's width is eased to the new phrase's, so whatever sits beside
    // it glides over instead of jumping when the old one leaves.
    const current = useRef(null);
    const [width, setWidth] = useState(null);
    useLayoutEffect(() => {
        if (!fit) setWidth(current.current?.offsetWidth ?? null);
    }, [text, fit]);

    return (
        <span
            className={`working-cell ${fit ? 'working-fit' : ''}`}
            style={width && !fit ? { width } : undefined}
        >
            {leaving && (
                <span key={`out:${leaving.key}`} className="working-phrase working-out" aria-hidden="true">
                    {leaving.text}
                </span>
            )}
            <span
                key={`in:${cue}`}
                ref={current}
                className={`working-phrase ${leaving ? 'working-in' : ''}`}
            >
                {text}
            </span>
        </span>
    );
}

export default function WorkingIndicator({ items }) {
    const t = useT();
    const tool = runningTool(items);
    const phrase = usePhrase(tool ? activityOf(tool.name) : 'think');

    const [started] = useState(() => Date.now());
    const seconds = useSeconds(started);

    return (
        <div
            role="status"
            // A rolling phrase is not something said in the conversation, and
            // a find for "reading" should not land on it. See lib/transcript-find.
            data-find-skip=""
            aria-label={t('assistant.working')}
            className="flex items-center gap-2 h-8 px-2.5 text-[11px] select-none
                text-gray-400 dark:text-gray-500"
        >
            <Ring />
            <RollingPhrase text={phrase} />
            {seconds >= 3 && (
                <span className="tabular-nums text-gray-400/70 dark:text-gray-600">
                    {elapsed(seconds)}
                </span>
            )}
        </div>
    );
}
