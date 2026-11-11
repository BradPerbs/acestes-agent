import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { describeCall } from './ToolCall';
import { chipFor, todoProgress, toolBucket, verbFor } from '../../lib/tool-bucket';
import { DESKTOP_VERBS, workingActivity } from '../../lib/working-activity';

/**
 * The line under the transcript while a turn is open and nothing is on screen
 * yet: no words streaming, no question standing.
 *
 * It says what the agent is doing, in the words of the call itself: the
 * command running, the file being edited, what a subagent is on. Between
 * calls it says what the model is in the middle of when the runtime tells
 * us (thinking, writing its next call, summarising the history), and that it
 * is waiting on the model when nothing has. All of it is read off events the
 * chat already has, so it costs no request. The rows above can be folded
 * into a group, which leaves this as the one place the running call is named.
 *
 * The clock beside it counts from when the work last changed, so a command
 * that has run for two minutes says so, and a model that has not answered for
 * two minutes says that.
 *
 * Its parts (the ring, the rolling phrase, the phrase that turns over, the
 * clock) are exported for the buddy's notch while an agent drives the
 * desktop (BuddyOverlay.jsx), so the two read as one thing.
 */

/** Calls that say themselves better than their bucket's verb does. */
const VERBS = {
    ...DESKTOP_VERBS,
    read_terminal: 'assistant.doing.readTerminal',
    send_input: 'activity.typing',
    Agent: 'assistant.doing.subagent',
    Task: 'assistant.doing.subagent',
    connect_host: 'assistant.doing.connect',
    disconnect_session: 'assistant.doing.disconnect',
    remember: 'assistant.doing.remember',
    delegate: 'assistant.doing.handOff',
    fan_out: 'assistant.doing.handOff',
    run_on_device: 'assistant.doing.handOff',
    start_task: 'assistant.doing.handOff',
    new_conversation: 'assistant.doing.handOff',
    branch_conversation: 'assistant.doing.handOff',
    message_conversation: 'assistant.doing.message',
    check_conversations: 'assistant.doing.checkConversations',
    solve_captcha: 'assistant.doing.captcha',
};

/** Calls whose own words add nothing to the verb: an id, a wait condition. */
const BARE = new Set([
    'connect_host', 'disconnect_session', 'check_conversations', 'list_windows', 'read_clipboard', 'read_terminal',
]);

/** A call being written, by the bucket the transcript sorts it into. */
const COMPOSING = {
    commands: 'assistant.doing.composeCommand',
    edits: 'assistant.doing.composeEdit',
    searches: 'assistant.doing.composeSearch',
    views: 'assistant.doing.composeRead',
};

/** A tool's own name, readable: `mcp__server__do_thing` as "do thing". */
function toolLabel(name = '') {
    return String(name).replace(/^mcp__.+?__/, '').replace(/_/g, ' ');
}

/** A call's own words on one line, or '' when they would only be noise. */
function oneLine(text) {
    const line = String(text || '').replace(/\s+/g, ' ').trim();
    // An argument that was an object, which the row's generic summary
    // cannot spell: better no detail than "todos: [object Object]".
    return line.includes('[object Object]') ? '' : line.slice(0, 200);
}

/** What a call is doing: a verb, and what it is aimed at. */
function callLine(call, t) {
    const input = call.input || {};
    const verb = verbFor(call.name);
    // list_hosts, list_sessions…: "Listing hosts" says more than "Reading".
    const listing = /^list_(.+)$/.exec(String(call.name).replace(/^mcp__.+?__/, ''));
    const said = VERBS[call.name] ? t(VERBS[call.name])
        : listing ? t('assistant.doing.list', { what: listing[1].replace(/_/g, ' ') })
            : verb ? t(`assistant.doing.${verb.icon}`)
                : t('activity.using', { tool: toolLabel(call.name) });

    if (BARE.has(call.name)) return { verb: said, detail: '', mono: false };
    // A runtime's own tools spell what they look for or fetch in a field
    // of their own; the row's generic summary would list every argument.
    if (toolBucket(call.name) === 'searches' && (input.pattern || input.query)) {
        return { verb: said, detail: oneLine(input.query || input.pattern), mono: Boolean(input.pattern && !input.query) };
    }
    if (typeof input.url === 'string' && input.url) return { verb: said, detail: oneLine(input.url), mono: true };
    if (call.name === 'do_steps') {
        return { verb: said, detail: t('activity.stepCount', { count: (input.steps || []).length }), mono: false };
    }
    if (call.name === 'remember') return { verb: said, detail: oneLine(input.text), mono: false };
    if (verb?.icon === 'todo') {
        const progress = todoProgress(input);
        return {
            verb: said,
            detail: progress ? t('assistant.todoProgress', { done: progress.done, total: progress.total }) : '',
            mono: false,
        };
    }
    const chip = chipFor(call.name, input);
    if (chip) return { verb: said, detail: chip.base, mono: true };
    const summary = describeCall(call.name, input);
    return { verb: said, detail: oneLine(summary.text), mono: Boolean(summary.mono) };
}

/** The working line's words for a state from workingActivity. */
function lineOf(activity, t) {
    switch (activity.kind) {
        case 'tool':
            return callLine(activity.call, t);
        case 'subagent': {
            const task = activity.call.task || {};
            const detail = task.activity || task.description || describeCall(activity.call.name, activity.call.input || {}).text;
            return { verb: t('assistant.doing.subagent'), detail: oneLine(detail), mono: false };
        }
        case 'compacting':
            return { verb: t('assistant.doing.compacting'), detail: '', mono: false };
        case 'composing':
            return { verb: t(COMPOSING[toolBucket(activity.tool)] || 'assistant.doing.compose'), detail: '', mono: false };
        case 'thinking':
            return { verb: t('assistant.doing.thinking'), detail: '', mono: false };
        default:
            return { verb: t('assistant.doing.waiting'), detail: '', mono: false };
    }
}

/** When `key` last changed, held across renders. */
function useSince(key) {
    const [mark, setMark] = useState(() => ({ key, at: Date.now() }));
    if (mark.key !== key) {
        // Set during render, which React allows for state derived from
        // props: the clock never shows one frame of the old work's time.
        const next = { key, at: Date.now() };
        setMark(next);
        return next.at;
    }
    return mark.at;
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
 * seconds, for the buddy's notch while the agent thinks. A new kind of work
 * starts on a random phrase, so two turns in a row do not open with the same
 * word.
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
 * otherwise. The buddy's notch names an action and then, a moment later, what it
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

export default function WorkingIndicator({ items, draft }) {
    const t = useT();
    const activity = workingActivity(items, draft);
    const line = lineOf(activity, t);
    const plain = line.detail ? `${line.verb} ${line.detail}` : line.verb;

    const seconds = useSeconds(useSince(activity.key));

    return (
        <div
            role="status"
            // A rolling phrase is not something said in the conversation, and
            // a find for "reading" should not land on it. See lib/transcript-find.
            data-find-skip=""
            aria-label={plain}
            // A long command is cut to the row; the whole of it on hover.
            title={plain}
            className="flex items-center gap-2 h-8 px-2.5 text-[11px] select-none
                text-gray-400 dark:text-gray-500"
        >
            <Ring />
            <RollingPhrase
                fit
                cue={activity.key}
                text={(
                    <>
                        {line.verb}
                        {line.detail && ' '}
                        {line.detail && <span className={line.mono ? 'font-jetbrains' : ''}>{line.detail}</span>}
                    </>
                )}
            />
            {activity.more > 0 && (
                <span className="shrink-0 text-gray-400/70 dark:text-gray-600">
                    {t('assistant.doing.more', { count: activity.more })}
                </span>
            )}
            {seconds >= 3 && (
                <span className="shrink-0 tabular-nums text-gray-400/70 dark:text-gray-600">
                    {elapsed(seconds)}
                </span>
            )}
        </div>
    );
}
