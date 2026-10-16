import { useEffect, useRef } from 'react';
import { Loading03Icon, Mic01Icon } from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import useDictation from '../../hooks/useDictation';
import { useT } from '../../i18n';

/**
 * The composer's microphone.
 *
 * A mic like the other round buttons beside it. Pressed, it becomes a small
 * pill with a dot that swells with your voice and the time so far; pressed
 * again, what was said is in the message, to read over and send. Live (the
 * Parakeet engine), the words appear in the message as they are spoken.
 * Esc throws the recording away. The first use waits for the speech model to
 * download, and the pill says how far that has got.
 *
 * Ctrl+S starts it and, pressed again, stops it, from anywhere in this
 * conversation's pane. A terminal or an editor keeps its own Ctrl+S (a save,
 * nano's write-out), and so does a pane the focus is not in. While an agent
 * drives the desktop the same keys are the corner card's instead, to steer it
 * by voice (see main/ai/overlay.js); the helper keeps them from the app then.
 */

const clock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** The shortcut, as the tooltips show it. */
export const DICTATE_HINT = 'Ctrl+S';

/** Ctrl+S with nothing else held. Ctrl on a Mac too, where Cmd+S stays a save. */
function isDictateKey(event) {
    return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && (event.code === 'KeyS' || String(event.key).toLowerCase() === 's');
}

/** Places that have a Ctrl+S of their own. */
const OWN_KEYS = '.xterm, .cm-editor, .monaco-editor, [data-own-ctrl-s]';

/** The conversation pane a node is in: the nearest ancestor holding a transcript. */
function paneOf(node) {
    for (let current = node?.parentElement; current; current = current.parentElement) {
        if (current.querySelector?.('[data-transcript]')) return current;
    }
    return null;
}

export default function DictationButton({ live = false, onText, onNotice }) {
    const t = useT();
    const meterRef = useRef(null);
    const anchorRef = useRef(null);
    const { state, seconds, download, start, stop, cancel } = useDictation({ live, onText, onNotice, meterRef });

    // Ctrl+S: start, or stop and write it down. The first composer to claim
    // the keys takes them, so two panes side by side never both listen.
    useEffect(() => {
        const onKey = (event) => {
            if (!isDictateKey(event) || event.repeat || event.defaultPrevented) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(OWN_KEYS)) return;
            const pane = paneOf(anchorRef.current);
            if (!pane) return;
            const focused = document.activeElement;
            const inPane = focused && focused !== document.body && pane.contains(focused);
            // Focus outside every pane (the tab strip, nothing at all): the
            // first composer on screen answers.
            const firstShown = [...document.querySelectorAll('[data-dictation]')]
                .find(node => node.offsetParent !== null) === anchorRef.current;
            const inSomePane = focused && focused !== document.body
                && [...document.querySelectorAll('[data-dictation]')].some(node => paneOf(node)?.contains(focused));
            if (!inPane && (inSomePane || !firstShown)) return;
            event.preventDefault();
            if (state === 'recording') stop();
            else if (state === 'idle') start();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [state, start, stop]);

    // Esc, anywhere in the window, while listening: throw it away.
    useEffect(() => {
        if (state !== 'recording') return undefined;
        const onKey = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            cancel();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [state, cancel]);

    let content;
    if (state === 'recording') {
        content = (
            <Tooltip label={t('assistant.dictateStop')} hint={DICTATE_HINT} placement="top">
                <button
                    type="button"
                    aria-label={t('assistant.dictateStop')}
                    onClick={stop}
                    className="h-7 shrink-0 flex items-center gap-2 pl-2.5 pr-3 rounded-full transition-colors
                        bg-red-500/10 dark:bg-red-500/15 text-red-600 dark:text-red-400
                        hover:bg-red-500/15 dark:hover:bg-red-500/25"
                >
                    <span
                        ref={meterRef}
                        aria-hidden="true"
                        className="w-2 h-2 rounded-full bg-red-500 transition-transform duration-75"
                        style={{ transform: 'scale(calc(1 + var(--level, 0) * 0.9))' }}
                    />
                    <span className="text-[11px] font-medium tabular-nums">
                        {download !== null ? t('assistant.speechModel', { percent: download }) : clock(seconds)}
                    </span>
                </button>
            </Tooltip>
        );
    } else if (state === 'transcribing') {
        content = (
            <span
                role="status"
                className="h-7 shrink-0 flex items-center gap-1.5 px-2.5 rounded-full
                    text-[11px] text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-surface-control"
            >
                <Loading03Icon size={12} strokeWidth={2} className="animate-spin" />
                {download !== null ? t('assistant.speechModel', { percent: download }) : t('assistant.transcribing')}
            </span>
        );
    } else {
        content = (
            <Tooltip label={t('assistant.dictate')} hint={DICTATE_HINT} placement="top">
                <button
                    type="button"
                    aria-label={t('assistant.dictate')}
                    onClick={start}
                    disabled={state === 'starting'}
                    className="w-7 h-7 shrink-0 flex items-center justify-center rounded-full transition-colors
                        text-gray-500 dark:text-gray-400
                        hover:bg-gray-100 dark:hover:bg-surface-control
                        hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
                >
                    <Mic01Icon size={15} strokeWidth={2} />
                </button>
            </Tooltip>
        );
    }

    // One element whatever the state, for the shortcut to find this composer by.
    return (
        <span ref={anchorRef} data-dictation="" className="inline-flex shrink-0">
            {content}
        </span>
    );
}
