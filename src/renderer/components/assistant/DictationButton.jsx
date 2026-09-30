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
 */

const clock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export default function DictationButton({ live = false, onText, onNotice }) {
    const t = useT();
    const meterRef = useRef(null);
    const { state, seconds, download, start, stop, cancel } = useDictation({ live, onText, onNotice, meterRef });

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

    if (state === 'recording') {
        return (
            <Tooltip label={t('assistant.dictateStop')} hint="Esc" placement="top">
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
    }

    if (state === 'transcribing') {
        return (
            <span
                role="status"
                className="h-7 shrink-0 flex items-center gap-1.5 px-2.5 rounded-full
                    text-[11px] text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-surface-control"
            >
                <Loading03Icon size={12} strokeWidth={2} className="animate-spin" />
                {download !== null ? t('assistant.speechModel', { percent: download }) : t('assistant.transcribing')}
            </span>
        );
    }

    return (
        <Tooltip label={t('assistant.dictate')} placement="top">
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
