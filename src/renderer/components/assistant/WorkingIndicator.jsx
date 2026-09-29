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

/** The newest call still running, or null between calls. */
function runningTool(items) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.kind === 'user') return null;
        if (item.kind === 'tool' && item.status === 'running') return item;
    }
    return null;
}

const TURN_EVERY = 2600;

/** How long one phrase takes to roll out and the next to roll in, in ms. */
const ROLL = 240;

const stillMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Seconds as "12s" or "1m 04s". */
function elapsed(seconds) {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** A thin ring with a quarter of it drawn in, turning. */
function Ring() {
    return (
        <svg viewBox="0 0 12 12" className="working-ring w-3 h-3 shrink-0" aria-hidden="true">
            <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
            <circle
                cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeDasharray="7.5 30"
            />
        </svg>
    );
}

export default function WorkingIndicator({ items }) {
    const t = useT();
    const tool = runningTool(items);
    const activity = tool ? (ACTIVITY[tool.name] || guess(tool.name)) : 'think';

    const phrases = useMemo(
        () => t(`assistant.working.${activity}`).split('|').map(phrase => phrase.trim()).filter(Boolean),
        [t, activity],
    );

    // A new kind of work starts on a random phrase, so two turns in a row do
    // not open with the same word.
    const [turn, setTurn] = useState(() => Math.floor(Math.random() * 1000));
    useEffect(() => {
        setTurn(Math.floor(Math.random() * 1000));
        if (stillMotion()) return undefined;
        const timer = setInterval(() => setTurn(value => value + 1), TURN_EVERY);
        return () => clearInterval(timer);
    }, [activity]);

    const phrase = `${phrases[turn % phrases.length] || t('assistant.working')}…`;

    // The outgoing phrase stays for one roll, sharing the cell with the new
    // one, so the change reads as a single motion rather than a swap.
    // Laid out before paint, so the new phrase is never seen standing still
    // for a frame before its entrance starts.
    const last = useRef(phrase);
    const [leaving, setLeaving] = useState(null);
    useLayoutEffect(() => {
        const previous = last.current;
        if (previous === phrase) return undefined;
        last.current = phrase;
        if (stillMotion()) return undefined;
        setLeaving(previous);
        const timer = setTimeout(() => setLeaving(null), ROLL);
        return () => clearTimeout(timer);
    }, [phrase]);

    // The cell's width is eased to the new phrase's, so the timer beside it
    // glides over instead of jumping when the old one leaves.
    const current = useRef(null);
    const [width, setWidth] = useState(null);
    useLayoutEffect(() => {
        setWidth(current.current?.offsetWidth ?? null);
    }, [phrase]);

    const [started] = useState(() => Date.now());
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [started]);

    return (
        <div
            role="status"
            aria-label={t('assistant.working')}
            className="flex items-center gap-2 h-8 px-2.5 text-[11px] select-none
                text-gray-400 dark:text-gray-500"
        >
            <Ring />
            <span className="working-cell" style={width ? { width } : undefined}>
                {leaving && (
                    <span key={`out:${leaving}`} className="working-phrase working-out" aria-hidden="true">
                        {leaving}
                    </span>
                )}
                <span
                    key={`in:${phrase}`}
                    ref={current}
                    className={`working-phrase ${leaving ? 'working-in' : ''}`}
                >
                    {phrase}
                </span>
            </span>
            {seconds >= 3 && (
                <span className="tabular-nums text-gray-400/70 dark:text-gray-600">
                    {elapsed(seconds)}
                </span>
            )}
        </div>
    );
}
