import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Search01Icon, ArrowUp01Icon, ArrowDown01Icon, Cancel01Icon } from 'hugeicons-react';
import useEnter from '../../hooks/useEnter';
import Tooltip from '../ui/Tooltip';
import { useT } from '../../i18n';
import { IS_MAC } from '../../lib/platform';
import {
    TRANSCRIPT,
    TRANSCRIPT_HOLD,
    buildPattern,
    clearMatches,
    collectText,
    findSpans,
    nearestIndex,
    paintCurrent,
    paintMatches,
    toRanges,
} from '../../lib/transcript-find';

/**
 * Find in this conversation: Ctrl+F (Cmd+F on a Mac), or the magnifier in the
 * header.
 *
 * The terminal's find bar, as near to the letter as a different kind of
 * content allows: the same three toggles, Enter and Shift+Enter to step, Esc
 * to put it away. F3 and Shift+F3 step too, from anywhere in the tab, as they
 * do in a browser.
 *
 * The search runs over what the transcript has drawn (see lib/transcript-find)
 * and keeps up with it: a reply streaming in while the bar is open is searched
 * as it arrives, without moving the view off the match being read.
 *
 * The chord is taken only while this conversation is the one in front, and
 * never from a terminal (the shell's Ctrl+F is forward-char) or from a dialog
 * that has its own field.
 */

/** Room left at the top of the view for the bar, so a match never lands under it. */
const BAR_CLEARANCE = 56;

/** The quickest a streamed reply is searched again. Slower if a pass is costly. */
const REFRESH_MS = 200;

/** A selection longer than this is not something anyone meant to search for. */
const SEED_MAX = 200;

const isFindChord = (event) => {
    if (event.altKey || event.shiftKey) return false;
    if (IS_MAC ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return false;
    const key = String(event.key || '').toLowerCase();
    // The letter where the layout has one; the key's place where it does not
    // (Cyrillic, Greek), so the chord is where the hand expects it.
    return key === 'f' || (!/^[a-z]$/.test(key) && event.code === 'KeyF');
};

const isField = (element) => Boolean(element?.matches?.('input, textarea, [contenteditable="true"]'));

/** What is selected in the transcript, if it is a short run of one line. */
function selectedText(scroller) {
    const selection = window.getSelection?.();
    if (!scroller || !selection || selection.isCollapsed) return '';
    if (!scroller.contains(selection.anchorNode)) return '';
    const text = selection.toString().trim();
    return text && text.length <= SEED_MAX && !text.includes('\n') ? text : '';
}

/**
 * Brings a match into view, a third of the way down so there is context above
 * it, unless it is already comfortably on screen.
 */
function revealRange(scroller, range) {
    if (!scroller || !range) return;
    const place = () => {
        if (!range.startContainer.isConnected) return;
        const box = range.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        if (!box.width && !box.height) return;
        if (box.top >= view.top + BAR_CLEARANCE && box.bottom <= view.bottom - 16) return;
        scroller.dispatchEvent(new Event(TRANSCRIPT_HOLD));
        scroller.scrollTop += box.top - (view.top + Math.max(BAR_CLEARANCE, view.height / 3));
    };
    place();
    // A row brought out of content-visibility is laid out for real a frame
    // later, and may not be the height it was guessed at.
    requestAnimationFrame(() => requestAnimationFrame(place));
}

const TOGGLES = [
    { id: 'caseSensitive', label: 'Aa', title: 'assistant.findMatchCase' },
    { id: 'wholeWord', label: 'ab', title: 'assistant.findWholeWord' },
    { id: 'regex', label: '.*', title: 'assistant.findRegex' },
];

const ICON_BUTTON = 'w-6 h-6 flex items-center justify-center rounded-md text-gray-500 '
    + 'hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-surface-control '
    + 'transition-colors disabled:opacity-30';

function FindBar({ top, query, onQuery, options, onToggle, result, onStep, onClose, focusTick }) {
    const t = useT();
    const barRef = useEnter('fade');
    const inputRef = useRef(null);

    // On opening, and each time the chord is pressed again while open: the
    // term is selected so typing replaces it.
    useEffect(() => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
    }, [focusTick]);

    const onKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? 'previous' : 'next');
        }
    };

    const toggle = (id) => {
        onToggle(id);
        inputRef.current?.focus({ preventScroll: true });
    };
    const step = (direction) => {
        onStep(direction);
        inputRef.current?.focus({ preventScroll: true });
    };

    const missing = result.invalid || (query && result.count === 0);
    const counter = result.invalid
        ? t('assistant.findBadPattern')
        : !query
            ? ''
            : result.count === 0
                ? t('assistant.findNoResults')
                : `${result.index >= 0 ? `${result.index + 1}/` : ''}${result.count}${result.more ? '+' : ''}`;

    return (
        <div
            ref={barRef}
            style={{ top }}
            className="absolute right-3 z-30 flex items-center gap-1 pl-2.5 pr-1.5 py-1.5
                rounded-xl bg-white/95 dark:bg-surface-raised/95 backdrop-blur
                border border-gray-200 dark:border-surface-control shadow-lg"
            role="search"
        >
            <Search01Icon size={14} strokeWidth={2} className="shrink-0 text-gray-400" />

            <input
                ref={inputRef}
                value={query}
                onChange={(event) => onQuery(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('assistant.find')}
                aria-label={t('assistant.find')}
                spellCheck={false}
                className={`w-44 bg-transparent outline-none text-sm placeholder:text-gray-400 ${
                    result.invalid ? 'text-red-500 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}
            />

            <span
                aria-live="polite"
                className={`shrink-0 min-w-[4rem] text-right text-[11px] tabular-nums whitespace-nowrap ${
                    missing ? 'text-red-500 dark:text-red-400' : 'text-gray-400 dark:text-neutral-500'}`}
            >
                {counter}
            </span>

            <div className="flex items-center gap-0.5 pl-1 ml-0.5 border-l border-gray-200 dark:border-surface-control">
                {TOGGLES.map(({ id, label, title }) => (
                    <Tooltip key={id} label={t(title)}>
                        <button
                            type="button"
                            aria-label={t(title)}
                            aria-pressed={options[id]}
                            onClick={() => toggle(id)}
                            className={`w-6 h-6 flex items-center justify-center rounded-md text-[11px] font-mono font-semibold transition-colors ${
                                options[id]
                                    ? 'bg-gray-900 dark:bg-white text-white dark:text-black'
                                    : 'text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-surface-control'
                            }`}
                        >
                            {label}
                        </button>
                    </Tooltip>
                ))}
            </div>

            <div className="flex items-center gap-0.5 pl-1 ml-0.5 border-l border-gray-200 dark:border-surface-control">
                <Tooltip label={t('assistant.findPrevious')} hint="Shift+Enter">
                    <button
                        type="button"
                        aria-label={t('assistant.findPrevious')}
                        onClick={() => step('previous')}
                        disabled={!result.count}
                        className={ICON_BUTTON}
                    >
                        <ArrowUp01Icon size={14} strokeWidth={2.5} />
                    </button>
                </Tooltip>
                <Tooltip label={t('assistant.findNext')} hint="Enter">
                    <button
                        type="button"
                        aria-label={t('assistant.findNext')}
                        onClick={() => step('next')}
                        disabled={!result.count}
                        className={ICON_BUTTON}
                    >
                        <ArrowDown01Icon size={14} strokeWidth={2.5} />
                    </button>
                </Tooltip>
                <Tooltip label={t('common.close')} hint="Esc">
                    <button
                        type="button"
                        aria-label={t('common.close')}
                        onClick={onClose}
                        className="w-6 h-6 flex items-center justify-center rounded-md text-gray-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                    >
                        <Cancel01Icon size={14} strokeWidth={2.5} />
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}

const EMPTY = { index: -1, count: 0, more: false, invalid: false };

/**
 * `rootRef` is the element the conversation is drawn in; the transcript is
 * the scroller inside it, looked up each time rather than held, since a
 * conversation switched in a pane brings a new one. The bar is drawn here, so
 * this wants to sit inside a positioned box. `open()` on the ref opens it, for
 * a button that does what the chord does.
 */
const ConversationFind = forwardRef(function ConversationFind({ rootRef, active, top = 8 }, ref) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false });
    const [result, setResult] = useState(EMPTY);
    const [focusTick, setFocusTick] = useState(0);

    /** Who this search's marks belong to; another pane's search has its own. */
    const [owner] = useState(() => ({}));
    const rangesRef = useRef([]);
    const indexRef = useRef(-1);
    const returnFocus = useRef(null);
    const openRef = useRef(open);
    openRef.current = open;

    const transcript = useCallback(() => rootRef.current?.querySelector(TRANSCRIPT) || null, [rootRef]);

    const reset = useCallback((next = EMPTY) => {
        rangesRef.current = [];
        indexRef.current = -1;
        clearMatches(owner);
        setResult(next);
    }, [owner]);

    /**
     * Search again. `fresh` is a new query: it starts from where the reader
     * is and brings the match into view. Otherwise it is the transcript
     * having changed under the same query, and the match being looked at is
     * held on to and the view left where it is.
     */
    const run = useCallback((fresh) => {
        const scroller = transcript();
        let pattern;
        try {
            pattern = buildPattern(query, options);
        } catch {
            // An unfinished regex: the user mid-typing, not an error.
            reset({ ...EMPTY, invalid: true });
            return;
        }
        if (!pattern || !scroller) {
            reset();
            return;
        }

        const collected = collectText(scroller);
        const { spans, more } = findSpans(collected.text, pattern);
        const ranges = toRanges(collected, spans);

        let index;
        if (fresh) {
            const view = scroller.getBoundingClientRect();
            index = nearestIndex(ranges.length, i => ranges[i].getBoundingClientRect(), view.top, view.bottom);
        } else {
            const before = rangesRef.current[indexRef.current];
            index = before
                ? ranges.findIndex(range => range.startContainer === before.startContainer
                    && range.startOffset === before.startOffset)
                : -1;
            if (index < 0) index = Math.min(Math.max(indexRef.current, 0), ranges.length - 1);
        }

        rangesRef.current = ranges;
        indexRef.current = index;
        paintMatches(owner, ranges);
        paintCurrent(owner, ranges[index] || null);
        setResult({ index, count: ranges.length, more, invalid: false });
        if (fresh && ranges[index]) revealRange(scroller, ranges[index]);
    }, [query, options, owner, transcript, reset]);

    const runRef = useRef(run);
    runRef.current = run;

    const step = useCallback((direction) => {
        let ranges = rangesRef.current;
        // A match whose row has gone (a conversation switched, a reply
        // rewritten) is no place to step from: look again first.
        if (ranges.length && !ranges[Math.max(indexRef.current, 0)]?.startContainer.isConnected) {
            runRef.current(false);
            ranges = rangesRef.current;
        }
        const count = ranges.length;
        if (!count) return;

        const current = indexRef.current;
        const next = direction === 'previous'
            ? (current <= 0 ? count - 1 : current - 1)
            : (current + 1) % count;
        indexRef.current = next;
        paintCurrent(owner, ranges[next]);
        setResult(previous => ({ ...previous, index: next }));
        revealRange(transcript(), ranges[next]);
    }, [owner, transcript]);

    const stepRef = useRef(step);
    stepRef.current = step;

    const show = useCallback(() => {
        const seed = selectedText(transcript());
        if (!openRef.current) {
            const focused = document.activeElement;
            returnFocus.current = isField(focused) ? focused : null;
        }
        if (seed) setQuery(seed);
        setOpen(true);
        setFocusTick(tick => tick + 1);
    }, [transcript]);

    const close = useCallback(() => {
        setOpen(false);
        reset(EMPTY);
        // Back to the field it was opened from, or the composer: after Esc,
        // the next thing typed is a message more often than anything else.
        const back = returnFocus.current;
        returnFocus.current = null;
        const target = back?.isConnected ? back : rootRef.current?.querySelector('textarea');
        target?.focus({ preventScroll: true });
    }, [reset, rootRef]);

    useImperativeHandle(ref, () => ({ open: show, close }), [show, close]);

    // A new query, new toggles, or the bar opening: search from here.
    useEffect(() => {
        if (open) run(true);
    }, [open, run]);

    // Keep up with what is drawn while the bar is open: a reply streaming in,
    // earlier rows being brought in, a tool call opened. In a pane that is not
    // the focused one too, since it is still on screen. The pass is timed, and
    // a long transcript that takes a while to search is searched less often
    // rather than every 200ms.
    useEffect(() => {
        const root = rootRef.current;
        if (!open || !query || !root) return undefined;
        let timer = 0;
        let cost = 0;
        const observer = new MutationObserver((mutations) => {
            if (timer) return;
            const scroller = transcript();
            if (!scroller) return;
            const touched = mutations.some(mutation => scroller.contains(mutation.target)
                || mutation.target.contains?.(scroller));
            if (!touched) return;
            timer = setTimeout(() => {
                timer = 0;
                const began = performance.now();
                runRef.current(false);
                cost = performance.now() - began;
            }, Math.max(REFRESH_MS, cost * 10));
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        return () => {
            observer.disconnect();
            clearTimeout(timer);
        };
    }, [open, query, rootRef, transcript]);

    // The marks are on the document, not in this tree, so they are taken
    // down by hand when it goes.
    useEffect(() => () => clearMatches(owner), [owner]);

    // Ctrl+F opens (or re-selects), F3 steps. Bubble phase and only when no
    // one else has claimed the key, the way the library pages take theirs.
    useEffect(() => {
        if (!active) return undefined;
        const handler = (event) => {
            if (event.defaultPrevented) return;
            if (event.target?.closest?.('.xterm, [role="dialog"], [aria-modal="true"]')) return;

            if (isFindChord(event)) {
                event.preventDefault();
                show();
                return;
            }
            if (event.key === 'F3' && openRef.current && !event.ctrlKey && !event.altKey && !event.metaKey) {
                event.preventDefault();
                stepRef.current(event.shiftKey ? 'previous' : 'next');
            }
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [active, show]);

    const toggleOption = useCallback((id) => {
        setOptions(previous => ({ ...previous, [id]: !previous[id] }));
    }, []);

    if (!open) return null;
    return (
        <FindBar
            top={top}
            query={query}
            onQuery={setQuery}
            options={options}
            onToggle={toggleOption}
            result={result}
            onStep={step}
            onClose={close}
            focusTick={focusTick}
        />
    );
});

export default memo(ConversationFind);
