import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import AgentMark from './AgentMark';
import { describeCall } from './ToolCall';
import { Ring, RollingPhrase, activityOf, elapsed, usePhrase, useSeconds } from './WorkingIndicator';
import useDictation from '../../hooks/useDictation';
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
 * said. It is the only sign on screen that an agent is driving, so it also
 * says when the user's hand paused the agents, or Esc stopped them.
 *
 * Each card has a light running round its edge while the agent works: grey
 * while it thinks, violet while it acts, amber while it waits for you. Cards
 * come in from below and leave to the right. With the cursor over them the
 * whole stack fades nearly away, so the cursor is never hidden behind it
 * (main watches the cursor; this window hears no mouse).
 *
 * The voice shortcut (Ctrl+S) while an agent drives opens the microphone
 * here: a card with a live waveform and the words as they are heard. Pressed
 * again, what was said steers the agent without stopping it (see `steer` in
 * main/ai/index.js), and the card says whether it will read it at its next
 * step or, its turn over, gets it as a new message.
 *
 * The working line is the one under a turn in the app (WorkingIndicator.jsx):
 * the turning ring and a phrase with the glint over it, rolling over to the
 * next. Between actions it is the app's own thinking phrases; during one it
 * names the action and what it is aimed at.
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

/** The voice shortcut, as the card shows it. Kept with computer.js's VOICE_KEY. */
const VOICE_HINT = 'Ctrl+S';

/** How long a card takes to leave, matching `activity-out` in input.css. */
const LEAVE_MS = 260;

/** How long what was sent, or why nothing was, stays on the listening card. */
const OUTCOME_MS = { steered: 2600, message: 3200, notice: 4200 };

const clock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

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
 * The rows as drawn: the ones still here, and for a moment the ones just
 * gone, in the place they had, so they can leave rather than vanish.
 */
function usePresence(rows) {
    const [shown, setShown] = useState(() => rows.map(row => ({ row, leaving: false })));
    const timers = useRef(new Map());

    useEffect(() => {
        setShown((current) => {
            const here = new Set(rows.map(row => row.id));
            const next = rows.map(row => ({ row, leaving: false }));
            current.forEach((entry, index) => {
                if (here.has(entry.row.id)) return;
                next.splice(Math.min(index, next.length), 0, { row: entry.row, leaving: true });
            });
            return next;
        });
    }, [rows]);

    // Each leaving card goes once its exit has played, on a clock of its own,
    // so the stream of updates while others work never holds it back.
    useEffect(() => {
        for (const entry of shown) {
            const id = entry.row.id;
            if (entry.leaving && !timers.current.has(id)) {
                timers.current.set(id, setTimeout(() => {
                    timers.current.delete(id);
                    setShown(current => current.filter(item => !(item.leaving && item.row.id === id)));
                }, LEAVE_MS));
            } else if (!entry.leaving && timers.current.has(id)) {
                // Back before it had gone.
                clearTimeout(timers.current.get(id));
                timers.current.delete(id);
            }
        }
    }, [shown]);

    useEffect(() => () => {
        for (const timer of timers.current.values()) clearTimeout(timer);
    }, []);

    return shown;
}

/** Whether something is drawn, kept a moment after it is not wanted, so it can leave. */
function useLinger(wanted) {
    const [render, setRender] = useState(wanted);
    useEffect(() => {
        if (wanted) {
            setRender(true);
            return undefined;
        }
        const timer = setTimeout(() => setRender(false), LEAVE_MS);
        return () => clearTimeout(timer);
    }, [wanted]);
    return { render: wanted || render, leaving: !wanted && render };
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
        <div className="working-loud mt-2 flex items-center gap-2 min-w-0 text-[11.5px]">
            <Ring className={tool ? 'text-violet-500 dark:text-violet-400' : 'text-gray-500 dark:text-gray-400'} />
            <RollingPhrase fit text={text} cue={named ? `act:${tool.seq}` : phrase} />
        </div>
    );
}

/** A state line with a mark of its own: waiting on you, paused, stopped. */
function StateLine({ tone, children, mark }) {
    const colour = {
        amber: 'text-amber-600 dark:text-amber-400',
        red: 'text-red-600 dark:text-red-400',
        muted: 'text-gray-500 dark:text-gray-400',
    }[tone];
    return (
        <div className={`activity-line-in mt-2 flex items-center gap-2 min-w-0 text-[11.5px] ${colour}`}>
            <span aria-hidden="true" className="relative w-3 h-3 shrink-0 flex items-center justify-center">{mark}</span>
            <span className="truncate">{children}</span>
        </div>
    );
}

function Waiting() {
    const t = useT();
    return (
        <StateLine
            tone="amber"
            mark={(
                <>
                    <span className="absolute inset-0.5 rounded-full bg-amber-500/40 motion-safe:animate-ping" />
                    <span className="relative w-1.5 h-1.5 rounded-full bg-amber-500" />
                </>
            )}
        >
            {t('activity.waitingForYou')}
        </StateLine>
    );
}

function Held({ code }) {
    const t = useT();
    if (code === 'escape') {
        return (
            <StateLine tone="red" mark={<span className="w-2 h-2 rounded-[2px] bg-red-500" />}>
                {t('activity.stopped')}
            </StateLine>
        );
    }
    return (
        <StateLine
            tone="amber"
            mark={(
                <span className="flex gap-[2px]">
                    <span className="w-[3px] h-2.5 rounded-full bg-amber-500" />
                    <span className="w-[3px] h-2.5 rounded-full bg-amber-500" />
                </span>
            )}
        >
            {t('activity.paused')}
        </StateLine>
    );
}

function Check({ className = '' }) {
    return (
        <svg viewBox="0 0 12 12" className={`activity-check w-3 h-3 shrink-0 ${className}`} aria-hidden="true">
            <path
                d="M2.75 6.25 5 8.5l4.25-4.75" fill="none" stroke="currentColor"
                strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
            />
        </svg>
    );
}

function Done() {
    const t = useT();
    return (
        <StateLine tone="muted" mark={<Check className="text-emerald-500" />}>
            {t('activity.done')}
        </StateLine>
    );
}

/** Which light runs round a card's edge. */
function toneOf(row) {
    if (row.done) return 'done';
    if (row.held) return row.held === 'escape' ? 'stopped' : 'paused';
    if (row.phase === 'waiting') return 'waiting';
    return row.phase === 'acting' ? 'acting' : 'thinking';
}

/** The card's frame: the hairline edge, the light running round it, the surface inside. */
function Shell({ tone, leaving, children, className = '' }) {
    return (
        <div
            role="status"
            data-tone={tone}
            className={`activity-card ${leaving ? 'activity-out' : 'activity-in'} ${className}`}
        >
            <div className="activity-surface">{children}</div>
        </div>
    );
}

function Card({ row, leaving }) {
    const t = useT();
    // How long it has been at it, after the first few seconds, as under a
    // turn in the app; stopped where it let go.
    const seconds = useSeconds(row.since || Date.now(), row.ended);
    const tone = toneOf(row);

    let line;
    if (row.done) line = <Done />;
    else if (row.held) line = <Held code={row.held} />;
    else if (row.phase === 'waiting') line = <Waiting />;
    else line = <Working row={row} />;

    return (
        <Shell tone={tone} leaving={leaving} className={row.done ? 'activity-done' : ''}>
            <div className="flex items-center gap-2 min-w-0">
                <AgentMark size={18} look={row.look} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-gray-900 dark:text-gray-50">
                    {row.title || row.agent || t('activity.untitled')}
                </span>
                {seconds >= 3 && (
                    <span className="shrink-0 tabular-nums text-[10.5px] text-gray-400 dark:text-gray-500">
                        {elapsed(seconds)}
                    </span>
                )}
            </div>
            {line}
            {row.said && (
                <div
                    key={row.said}
                    className="activity-said mt-1.5 text-[11px] leading-snug text-gray-500 dark:text-gray-400 line-clamp-2"
                >
                    {row.said}
                </div>
            )}
        </Shell>
    );
}

/** A small keyboard chip. */
function Keys({ children }) {
    return (
        <kbd className="px-1.5 py-[1px] rounded-md font-inter text-[10px] font-medium
            bg-black/[0.05] dark:bg-white/[0.08] text-gray-600 dark:text-gray-300
            ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]"
        >
            {children}
        </kbd>
    );
}

/** Bars of the waveform, each with its own reach, so the shape moves like a voice. */
const BARS = Array.from({ length: 30 }, (_, index) => {
    const centre = 1 - Math.abs(index - 14.5) / 15;
    const reach = 0.35 + 0.65 * centre * (0.6 + 0.4 * Math.abs(Math.sin(index * 1.7)));
    return { reach: reach.toFixed(3), delay: `${-((index * 137) % 900)}ms` };
});

/**
 * The microphone at work, for the voice shortcut: listening, then writing it
 * down, then what became of it. The waveform follows the `--level` the
 * dictation hook sets on it each frame, with no renders.
 */
function ListenCard({ phase, seconds, heard, outcome, title, download, meterRef, leaving }) {
    const t = useT();
    const tone = phase === 'outcome'
        ? (outcome?.kind === 'notice' ? 'paused' : 'sent')
        : phase === 'transcribing' ? 'thinking' : 'listening';

    let header;
    if (phase === 'outcome' && outcome) {
        const sent = outcome.kind !== 'notice';
        header = (
            <div className={`flex items-center gap-2 min-w-0 text-[12px] font-medium
                ${sent ? 'text-gray-900 dark:text-gray-50' : 'text-amber-600 dark:text-amber-400'}`}
            >
                <span className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center
                    ${sent ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'}`}
                >
                    {sent ? <Check /> : <span className="text-[11px] leading-none">!</span>}
                </span>
                <span className="min-w-0 flex-1 truncate">
                    {outcome.kind === 'steered' && t('activity.steered')}
                    {outcome.kind === 'message' && t('activity.sentAsMessage')}
                    {outcome.kind === 'notice' && t('activity.notSent')}
                </span>
            </div>
        );
    } else {
        header = (
            <div className="flex items-center gap-2 min-w-0">
                <span className="relative w-5 h-5 shrink-0 flex items-center justify-center">
                    {phase === 'listening' && (
                        <span aria-hidden="true" className="activity-mic-halo absolute inset-0 rounded-full bg-rose-500/25" />
                    )}
                    <span className={`relative w-2 h-2 rounded-full ${phase === 'listening' ? 'bg-rose-500' : 'bg-gray-400'}`} />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-gray-900 dark:text-gray-50">
                    {phase === 'listening' ? t('activity.listening') : t('assistant.transcribing')}
                    {title && (
                        <span className="font-normal text-gray-500 dark:text-gray-400">
                            {` · ${t('activity.steering', { title })}`}
                        </span>
                    )}
                </span>
                <span className="shrink-0 tabular-nums text-[10.5px] text-gray-400 dark:text-gray-500">
                    {download !== null ? t('assistant.speechModel', { percent: download }) : clock(seconds)}
                </span>
            </div>
        );
    }

    const words = phase === 'outcome' ? (outcome?.text || '') : heard;

    return (
        <Shell tone={tone} leaving={leaving}>
            {/* The hook sets `--level` on this one element each frame; the
                halo and every bar read it from here. */}
            <div ref={meterRef} style={{ '--level': 0 }}>
                {header}
                {phase !== 'outcome' && (
                    <div
                        className={`activity-wave mt-2.5 ${phase === 'transcribing' ? 'activity-wave-rest' : ''}`}
                        aria-hidden="true"
                    >
                        {BARS.map((bar, index) => (
                            <span key={index} className="activity-bar" style={{ '--reach': bar.reach }}>
                                <span style={{ animationDelay: bar.delay }} />
                            </span>
                        ))}
                    </div>
                )}
                {words && (
                    <div className={`activity-words mt-2 text-[12px] leading-snug
                        ${phase === 'outcome' ? 'text-gray-600 dark:text-gray-300' : 'text-gray-800 dark:text-gray-100'}`}
                    >
                        <span>{phase === 'outcome' && outcome?.kind !== 'notice' ? `“${words}”` : words}</span>
                    </div>
                )}
                {phase === 'listening' && (
                    <div className="mt-2.5 flex items-center justify-end gap-1.5 text-[10.5px] text-gray-400 dark:text-gray-500">
                        <Keys>{VOICE_HINT}</Keys>
                        <span>{t('activity.steerHint')}</span>
                    </div>
                )}
            </div>
        </Shell>
    );
}

/**
 * The voice shortcut's half of the card: the microphone, which agent it is
 * for, and what became of what was said.
 */
function useListening(rows) {
    const t = useT();
    const [target, setTarget] = useState(null);
    const [heard, setHeard] = useState('');
    const [outcome, setOutcome] = useState(null);
    const targetRef = useRef(null);
    const meterRef = useRef(null);

    const onText = useCallback((text, { final }) => {
        if (!final) {
            setHeard(text || '');
            return;
        }
        const said = String(text || '').trim();
        const aim = targetRef.current;
        if (!said || !aim) return;
        setHeard(said);
        Promise.resolve(window.api.ai.steer?.(aim.conversationId, said)).then((result) => {
            if (!result?.success) setOutcome({ kind: 'notice', text: result?.message || t('activity.notSentWhy') });
            else setOutcome({ kind: result.steered ? 'steered' : 'message', text: said });
        }, (error) => {
            setOutcome({ kind: 'notice', text: error?.message || t('activity.notSentWhy') });
        });
    }, [t]);

    const onNotice = useCallback((message) => {
        if (message) setOutcome({ kind: 'notice', text: message });
    }, []);

    const dictation = useDictation({ onText, onNotice, meterRef });
    const latest = useRef(dictation);
    latest.current = dictation;

    // The shortcut, pressed: start for the agent named, or stop and send.
    useEffect(() => window.api.ai.onActivityVoice?.((message) => {
        const current = latest.current;
        if (current.state === 'recording') {
            current.stop();
            return;
        }
        if (current.state !== 'idle' || !message?.conversationId) return;
        targetRef.current = { conversationId: message.conversationId, title: message.title || '' };
        setTarget(targetRef.current);
        setHeard('');
        if (message.enabled === false) {
            setOutcome({ kind: 'notice', text: t('activity.voiceOff') });
            return;
        }
        setOutcome(null);
        current.start({ live: Boolean(message.live) });
    }), [t]);

    // Esc stopped the agent this was for: nothing is sent.
    const stoppedFor = target ? rows.find(row => row.id === target.conversationId)?.held === 'escape' : false;
    useEffect(() => {
        if (!stoppedFor || latest.current.state !== 'recording') return;
        latest.current.cancel();
        setOutcome({ kind: 'notice', text: t('activity.stoppedNothingSent') });
    }, [stoppedFor, t]);

    // What became of it stays a moment, then the card goes.
    useEffect(() => {
        if (!outcome) return undefined;
        const timer = setTimeout(() => {
            setOutcome(null);
            setHeard('');
            if (latest.current.state === 'idle') {
                targetRef.current = null;
                setTarget(null);
            }
        }, OUTCOME_MS[outcome.kind] || OUTCOME_MS.notice);
        return () => clearTimeout(timer);
    }, [outcome]);

    const { state } = dictation;
    let phase = null;
    if (outcome && state === 'idle') phase = 'outcome';
    else if (state === 'recording' || state === 'starting') phase = 'listening';
    else if (state === 'transcribing') phase = 'transcribing';

    // A recording that ended with neither words nor a notice (thrown away):
    // the card goes at once.
    useEffect(() => {
        if (state === 'idle' && !outcome && target) {
            targetRef.current = null;
            setTarget(null);
        }
    }, [state, outcome, target]);

    return { phase, heard, outcome, target, meterRef, seconds: dictation.seconds, download: dictation.download };
}

export default function ActivityOverlay() {
    useFollowTheme();
    const [rows, setRows] = useState([]);
    const [over, setOver] = useState(false);
    const stackRef = useRef(null);

    useEffect(() => window.api.ai.onActivity?.((payload) => {
        setRows(Array.isArray(payload?.rows) ? payload.rows : []);
    }), []);

    useEffect(() => window.api.ai.onActivityHover?.((payload) => setOver(Boolean(payload?.over))), []);

    // Stacked from the bottom, newest nearest the corner; three at most, which
    // is all a glance takes in.
    const shown = usePresence(rows.slice(-3));
    const listen = useListening(rows);
    const panel = useLinger(Boolean(listen.phase));
    // The phase as last drawn, so the card leaving still has something to show.
    const lastPhase = useRef(listen.phase);
    if (listen.phase) lastPhase.current = listen.phase;

    // Where the cards are, for main to fade them under the cursor, and whether
    // the card is listening, so it stays up mid-sentence.
    const report = useCallback(() => {
        const node = stackRef.current;
        const box = node && node.childElementCount > 0 ? node.getBoundingClientRect() : null;
        window.api.ai.activityUi?.({
            extent: box && box.height > 0
                ? { top: box.top, left: box.left, right: box.right, bottom: box.bottom }
                : null,
            listening: panel.render,
        });
    }, [panel.render]);

    useLayoutEffect(() => {
        report();
    }, [report, shown.length]);

    useEffect(() => {
        const node = stackRef.current;
        if (!node || typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(() => report());
        observer.observe(node);
        return () => observer.disconnect();
    }, [report]);

    return (
        <div className="h-full w-full flex flex-col justify-end p-3 font-inter select-none pointer-events-none">
            <div
                ref={stackRef}
                className={`activity-stack flex flex-col gap-2 ${over ? 'activity-stack-faded' : ''}`}
            >
                {shown.map(({ row, leaving }) => <Card key={row.id} row={row} leaving={leaving} />)}
                {panel.render && (
                    <ListenCard
                        phase={listen.phase || lastPhase.current}
                        seconds={listen.seconds}
                        heard={listen.heard}
                        outcome={listen.outcome}
                        title={listen.target?.title || ''}
                        download={listen.download}
                        meterRef={listen.meterRef}
                        leaving={panel.leaving}
                    />
                )}
            </div>
        </div>
    );
}
