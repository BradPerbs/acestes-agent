import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeCall } from './ToolCall';
import { Ring, RollingPhrase, elapsed, usePhrase, useSeconds } from './WorkingIndicator';
import useDictation from '../../hooks/useDictation';
import { createPcmPlayer } from '../../lib/pcm-player';
import { speakSystem } from '../../lib/system-voice';
import { agentColor } from '../../lib/agent-colors';
import { centreOf, moved, sketchOf } from '../../lib/sketch';
import { DESKTOP_VERBS as DOING } from '../../lib/working-activity';
import { getLanguage, useT } from '../../i18n';

/**
 * The buddy: beside the cursor whenever an agent uses the computer, and, on
 * for good, Acestes in the background (see main/ai/buddy.js, which says what
 * to draw).
 *
 * One of these per display, each a transparent, click-through window the
 * size of it, kept out of screen capture. Two things are drawn:
 *
 *   the mark    a small violet arrowhead riding beside the cursor on a
 *               spring, on whichever display the cursor is on. It becomes a
 *               waveform while you talk to it, a turning ring while the agent
 *               thinks, and says what the agent is doing beside it
 *               (Clicking · Save) as it does it. A reply that points
 *               somewhere sends it flying there along an arc, where it says
 *               what it found, then back to the cursor.
 *   the notch   a black notch hanging from the top edge of the main display,
 *               MacBook-style: small at rest, opening to show what is heard,
 *               what the agent is at (and which chat it is, when it is not
 *               the buddy's own), what it asks, and what it said. With the
 *               cursor resting on it, it opens a little to say how to talk to
 *               it, and the last reply, and can be dragged anywhere, on any
 *               display: let go near a top edge it hangs from it, near a
 *               side it stands on end against it and opens inward, anywhere
 *               else it floats, and it stays where it is left.
 *   drawings    what a reply drew to show something: loops, boxes, arrows
 *               and lines under words, in the mark's violet, stroke by
 *               stroke as if by hand, each on the display it is on, gone a
 *               few seconds after the recap has been said.
 *
 * The window told to listen records (useDictation, the same engines as the
 * composer's microphone) and says what it hears; the one on the main display
 * reads replies out with this computer's voice.
 */

/** A desktop action as words: the verb, and what it is aimed at by name once found, the call's own words until then. */
function action(t, tool) {
    const verb = DOING[tool.name];
    const detail = tool.aim
        || (tool.name === 'do_steps'
            ? t('activity.stepCount', { count: (tool.input?.steps || []).length })
            : describeCall(tool.name, tool.input || {}).text);
    return detail ? `${t(verb)} · ${detail}` : t(verb);
}

/** Bars of the notch's waveform, each with its own reach, so the shape moves like a voice. */
const BARS = Array.from({ length: 30 }, (_, index) => {
    const centre = 1 - Math.abs(index - 14.5) / 15;
    const reach = 0.35 + 0.65 * centre * (0.6 + 0.4 * Math.abs(Math.sin(index * 1.7)));
    return { reach: reach.toFixed(3), delay: `${-((index * 137) % 900)}ms` };
});

/** Where the mark rides, from the cursor's tip, in CSS pixels. */
const OFFSET = { x: 18, y: 20 };
/** The spring it rides on: how hard it is pulled, how much of its speed it keeps each frame. */
const PULL = 0.24;
const KEEP = 0.58;
/** The arrowhead's tilt at rest, like a cursor's, in degrees. */
const REST_TURN = -35;
/** How long it stays at a place it points to. Kept with POINT_MS in buddy.js. */
const POINT_MS = 3200;
/** How near the notch the cursor has to rest for it to open a little, and for how long. */
const PEEK_PAD = 14;
const PEEK_AFTER = 450;
/** The notch at rest, in CSS pixels. */
const REST_W = 96;
const REST_H = 18;
/** Where it is unless it was dragged: hanging from the top edge, in the middle. */
const TOP_MIDDLE = { x: 0.5, y: 0, dock: 'top' };
/** How near an edge a notch let go of docks there. Kept with DOCK_ZONE in buddy.js. */
const DOCK_ZONE = 36;
/** How near the middle of the edge it docks to it goes right to the middle. */
const MIDDLE_SNAP = 28;
/** How far the pointer moves with the button down before it is a drag, not a click. */
const DRAG_AFTER = 4;
/** How far it is kept from the display's sides, and a floating one from its top and bottom. */
const EDGE = 8;
/** What it is doing that it cannot be picked up from: a turn under way, or someone talking to it. */
const BUSY = new Set(['listening', 'hearing', 'looking', 'thinking', 'acting', 'waiting']);

/** What the cursor and the display are, shared by the mark and the notch without renders. */
function useCursor(hello) {
    const listeners = useRef(new Set());
    const last = useRef(null);
    useEffect(() => window.api.buddy.onCursor((point) => {
        last.current = point;
        for (const listener of listeners.current) listener(point);
    }), []);
    const subscribe = useCallback((listener) => {
        listeners.current.add(listener);
        if (last.current) listener(last.current);
        return () => listeners.current.delete(listener);
    }, []);
    return useMemo(() => ({ subscribe, last, hello }), [subscribe, hello]);
}

/* ------------------------------------------------------------------ *
 * The mark beside the cursor
 * ------------------------------------------------------------------ */

const smooth = p => p * p * (3 - 2 * p);

function Arrow() {
    return (
        <svg viewBox="0 0 20 20" className="buddy-arrow" aria-hidden="true">
            {/* Slim and notched, so turned like a cursor it reads as pointing, not as a play button. */}
            <path d="M10 1.4 L16 18 L10 14 L4 18 Z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1.4" />
        </svg>
    );
}

/** The few bars that stand in for a voice beside the cursor, following the microphone's level. */
function Wave() {
    return (
        <span className="buddy-wave" aria-hidden="true">
            {[0.45, 0.75, 1, 0.75, 0.45].map((reach, index) => (
                <span key={index} style={{ '--reach': reach, animationDelay: `${-index * 140}ms` }} />
            ))}
        </span>
    );
}

/** How long the agents show after a switch (Ctrl+Alt+Space, or a click on one). */
const SWITCH_MS = 2400;

/** True for a moment each time `seq` moves on; not for the value it starts at. */
function useFlash(seq, ms = SWITCH_MS) {
    const [on, setOn] = useState(false);
    const first = useRef(seq);
    useEffect(() => {
        if (!seq || seq === first.current) return undefined;
        setOn(true);
        const timer = setTimeout(() => setOn(false), ms);
        return () => clearTimeout(timer);
    }, [seq, ms]);
    return on;
}

/** The agent the buddy talks to, as main listed it. */
function agentOf(state) {
    return (state?.agents || []).find(agent => agent.id === state.agentId) || null;
}

/** An agent's colour as a dot on the black notch: the light end of its pair. */
function dotOf(id) {
    const color = agentColor(id);
    if (color.to) return color.to;
    return color.id === 'black' ? '#71717A' : '#F4F4F5';
}

/** What the mark says beside it, if anything, by phase. */
function useLabel(state) {
    const t = useT();
    const thinking = usePhrase('think');
    if (!state) return null;
    switch (state.phase) {
        case 'looking':
            return { tone: 'muted', text: t('buddy.looking') };
        case 'thinking':
            return state.held ? heldLabel(t, state.held) : { tone: 'muted', text: thinking, cue: 'think' };
        case 'acting': {
            if (state.held) return heldLabel(t, state.held);
            const tool = state.action;
            if (!tool) return { tone: 'muted', text: thinking, cue: 'think' };
            const named = Boolean(DOING[tool.name]);
            return { tone: 'acting', text: named ? action(t, tool) : thinking, cue: named ? `act:${tool.seq}` : 'think' };
        }
        case 'waiting':
            return { tone: 'waiting', text: state.ask?.question ? t('buddy.asks') : t('buddy.waiting') };
        case 'notice':
            return { tone: 'waiting', text: state.notice };
        default:
            return null;
    }
}

function heldLabel(t, code) {
    return code === 'escape'
        ? { tone: 'stopped', text: t('buddy.stopped') }
        : { tone: 'waiting', text: t('buddy.paused') };
}

function Mark({ state, cursor }) {
    const node = useRef(null);
    // Where the mark is and how fast it is going; `turn` is the arrowhead's
    // heading (tilted like a cursor at rest, along the arc in flight).
    const sim = useRef({
        x: -200, y: -200, vx: 0, vy: 0, raf: 0, last: 0,
        flight: null, rest: false, here: false, turn: REST_TURN, grow: 1,
    });
    const [pointing, setPointing] = useState(null);
    const [typed, setTyped] = useState('');
    const byPhase = useLabel(state);
    // Switched to another agent: its name, a moment, where the eyes are.
    const switched = useFlash(state?.switcher);
    const now = switched ? agentOf(state) : null;
    const label = now ? { tone: 'switch', text: now.name } : byPhase;
    const phase = state?.phase || 'idle';

    // What was last written, so a frame that changes only where it is
    // touches only the transform: the turn and the size stand still while it
    // follows, and rewriting them restyles the arrowhead's glow every frame.
    const drawn = useRef({});
    const draw = useCallback(() => {
        const s = sim.current;
        const el = node.current;
        if (!el) return;
        const last = drawn.current;
        const write = (key, value, apply) => {
            if (last[key] === value) return;
            last[key] = value;
            apply(value);
        };
        write('at', `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`, (value) => { el.style.transform = value; });
        write('turn', `${s.turn.toFixed(1)}deg`, value => el.style.setProperty('--turn', value));
        write('grow', (s.grow ?? 1).toFixed(3), value => el.style.setProperty('--grow', value));
        write('shown', s.here || s.flight || s.rest ? '1' : '0', (value) => { el.style.opacity = value; });
    }, []);

    /*
     * Where the cursor is this frame. Main's own look at it comes some 60
     * times a second, so on a 144 or 165Hz display the target would move
     * only every few frames and the mark with it in steps; while it follows,
     * it asks main once a frame instead, one question in flight at a time,
     * and what comes back is the target from the next frame on. Off this
     * display it is not taken: the hand-off is main's, by `follow`.
     */
    const ask = useCallback(() => {
        const s = sim.current;
        const now = window.api.buddy.cursorNow;
        if (s.asking || typeof now !== 'function') return;
        s.asking = true;
        now().then((point) => {
            s.asking = false;
            const bounds = cursor.hello?.bounds;
            if (!point || !bounds || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width
                && point.y >= bounds.y && point.y < bounds.y + bounds.height;
            if (inside) cursor.last.current = point;
        }, () => {
            s.asking = false;
        });
    }, [cursor]);

    const target = useCallback(() => {
        const s = sim.current;
        const point = cursor.last.current;
        const bounds = cursor.hello?.bounds;
        if (!point || !bounds) return null;
        return { x: point.x - bounds.x + OFFSET.x, y: point.y - bounds.y + OFFSET.y, s };
    }, [cursor]);

    const tick = useCallback((now) => {
        const s = sim.current;
        // In 60Hz frames: about 0.36 of one at 165Hz. The floor is for a
        // 360Hz display; the ceiling for a frame that came very late.
        const dt = Math.min(3, Math.max(0.1, (now - (s.last || now - 16)) / 16.67));
        s.last = now;
        let moving = false;
        if (s.flight) {
            const f = s.flight;
            const p = Math.min(1, (now - f.start) / f.duration);
            const e = smooth(p);
            const u = 1 - e;
            s.x = u * u * f.from.x + 2 * u * e * f.via.x + e * e * f.to.x;
            s.y = u * u * f.from.y + 2 * u * e * f.via.y + e * e * f.to.y;
            // Facing along the arc, swelling in the middle of it.
            const dx = 2 * u * (f.via.x - f.from.x) + 2 * e * (f.to.x - f.via.x);
            const dy = 2 * u * (f.via.y - f.from.y) + 2 * e * (f.to.y - f.via.y);
            if (Math.abs(dx) + Math.abs(dy) > 0.01) s.turn = Math.atan2(dy, dx) * 180 / Math.PI + 90;
            s.grow = 1 + 0.3 * Math.sin(Math.PI * p);
            moving = p < 1;
            if (!moving) {
                s.flight = null;
                s.turn = REST_TURN;
                s.grow = 1;
                if (f.back) {
                    s.rest = false;
                } else {
                    s.rest = true;
                    f.arrived?.();
                }
            }
        } else if (!s.rest) {
            if (s.here) ask();
            const goal = target();
            if (goal && s.here) {
                const ax = (goal.x - s.x) * PULL;
                const ay = (goal.y - s.y) * PULL;
                const keep = KEEP ** dt;
                s.vx = (s.vx + ax * dt) * keep;
                s.vy = (s.vy + ay * dt) * keep;
                s.x += s.vx * dt;
                s.y += s.vy * dt;
                moving = Math.abs(goal.x - s.x) > 0.15 || Math.abs(goal.y - s.y) > 0.15
                    || Math.abs(s.vx) > 0.05 || Math.abs(s.vy) > 0.05;
                if (!moving) {
                    s.x = goal.x;
                    s.y = goal.y;
                }
            }
        }
        draw();
        s.raf = moving ? requestAnimationFrame(tick) : 0;
    }, [draw, target, ask]);

    const kick = useCallback(() => {
        const s = sim.current;
        if (!s.raf) {
            s.last = 0;
            s.raf = requestAnimationFrame(tick);
        }
    }, [tick]);

    // The cursor moved: on this display, the mark follows; arriving here
    // from another, it starts beside it rather than gliding in from afar.
    useEffect(() => cursor.subscribe((point) => {
        const s = sim.current;
        const bounds = cursor.hello?.bounds;
        if (!bounds) return;
        const here = point.x >= bounds.x && point.x < bounds.x + bounds.width
            && point.y >= bounds.y && point.y < bounds.y + bounds.height;
        if (here && !s.here) {
            s.x = point.x - bounds.x + OFFSET.x;
            s.y = point.y - bounds.y + OFFSET.y;
            s.vx = 0;
            s.vy = 0;
        }
        s.here = here;
        if (here) kick();
        else draw();
    }), [cursor, draw, kick]);

    // A reply that points: the mark on the display with that place flies
    // there on an arc, says what it found, and comes back. Elsewhere it
    // stays out of the way meanwhile.
    const pointAt = state?.point?.at || 0;
    useEffect(() => {
        const point = state?.point;
        const bounds = cursor.hello?.bounds;
        if (!point || !bounds) return undefined;
        const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width
            && point.y >= bounds.y && point.y < bounds.y + bounds.height;
        if (!inside) return undefined;
        const s = sim.current;
        const to = {
            x: Math.max(20, Math.min(bounds.width - 20, point.x - bounds.x + 8)),
            y: Math.max(20, Math.min(bounds.height - 20, point.y - bounds.y + 12)),
        };
        // From beside the cursor when it is here, else from this display's
        // edge nearest it.
        const at = cursor.last.current;
        const from = s.here
            ? { x: s.x, y: s.y }
            : {
                x: Math.max(0, Math.min(bounds.width, (at?.x ?? bounds.x) - bounds.x)),
                y: Math.max(0, Math.min(bounds.height, (at?.y ?? bounds.y) - bounds.y)),
            };
        const fly = (start, end, back, arrived) => {
            const distance = Math.hypot(end.x - start.x, end.y - start.y);
            const lift = Math.min(distance * 0.2, 80);
            s.flight = {
                from: start,
                to: end,
                via: { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - lift },
                start: performance.now(),
                duration: Math.max(600, Math.min(1400, distance / 0.8)),
                back,
                arrived,
            };
            s.rest = false;
            kick();
        };
        let typing = 0;
        let leave = 0;
        fly(from, to, false, () => {
            const words = point.label || '';
            setPointing({ label: words });
            let shown = 0;
            setTyped('');
            const type = () => {
                shown += 1;
                setTyped(words.slice(0, shown));
                if (shown < words.length) typing = setTimeout(type, 30 + Math.random() * 30);
            };
            if (words) typing = setTimeout(type, 120);
            leave = setTimeout(() => {
                setPointing(null);
                const goal = target();
                if (goal && s.here) fly({ x: s.x, y: s.y }, { x: goal.x, y: goal.y }, true);
                else {
                    s.rest = false;
                    draw();
                }
            }, POINT_MS);
        });
        return () => {
            clearTimeout(typing);
            clearTimeout(leave);
        };
        // Once per point, by when it was made.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pointAt]);

    // A point on another display: this one's mark keeps out of the way.
    const elsewhere = Boolean(state?.point) && !sim.current.flight && !sim.current.rest && !pointing
        && (() => {
            const bounds = cursor.hello?.bounds;
            const point = state.point;
            return bounds && !(point.x >= bounds.x && point.x < bounds.x + bounds.width
                && point.y >= bounds.y && point.y < bounds.y + bounds.height);
        })();

    // A frame asked for and then cancelled is not one still coming: left
    // set, `kick` would wait on it for good (a remount, StrictMode's above all).
    useEffect(() => () => {
        cancelAnimationFrame(sim.current.raf);
        sim.current.raf = 0;
    }, []);

    const listening = phase === 'listening';
    const busy = ['hearing', 'looking', 'thinking', 'acting'].includes(phase) && !state?.held;
    const shape = pointing ? 'arrow' : listening ? 'wave' : busy ? 'ring' : phase === 'waiting' ? 'ask' : 'arrow';

    return (
        <div ref={node} className={`buddy-mark ${elsewhere ? 'buddy-mark-away' : ''}`} data-phase={phase} style={{ opacity: 0 }}>
            <div className={`buddy-glyph buddy-glyph-${shape} ${phase === 'speaking' ? 'buddy-speaking' : ''}`}>
                <span className="buddy-face buddy-face-arrow"><Arrow /></span>
                <span className="buddy-face buddy-face-wave"><Wave /></span>
                <span className="buddy-face buddy-face-ring">
                    <Ring className={phase === 'acting' ? 'text-violet-300' : 'text-white/80'} />
                </span>
                <span className="buddy-face buddy-face-ask"><span className="buddy-ask-dot" /></span>
            </div>
            {pointing ? (
                // Gone to draw something, it says nothing: the drawing has its own label.
                pointing.label && <span className="buddy-bubble buddy-bubble-point">{typed ||' '}</span>
            ) : label && (
                <span key={label.tone} className={`buddy-bubble buddy-tone-${label.tone}`}>
                    {label.cue ? <RollingPhrase text={label.text} cue={label.cue} /> : label.text}
                </span>
            )}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * The notch
 * ------------------------------------------------------------------ */

/** The waveform across the notch, read off the same `--level` as the mark's. */
function NotchWave({ resting }) {
    return (
        <div className={`activity-wave buddy-notch-wave ${resting ? 'activity-wave-rest' : ''}`} aria-hidden="true">
            {BARS.slice(3, 27).map((bar, index) => (
                <span key={index} className="activity-bar" style={{ '--reach': bar.reach }}>
                    <span style={{ animationDelay: bar.delay }} />
                </span>
            ))}
        </div>
    );
}

function Keys({ children }) {
    return <kbd className="buddy-keys">{children}</kbd>;
}

function Hint({ text, chord }) {
    const [before, after] = text.split('{chord}');
    return (
        <span className="inline-flex items-center gap-1.5 text-[10.5px] text-white/45">
            {before}
            {chord.split(' ').map(key => <Keys key={key}>{key}</Keys>)}
            {after}
        </span>
    );
}

/** The newest words of what is being said, for two lines at most. */
function tail(text, most = 150) {
    const words = String(text || '');
    return words.length > most ? `…${words.slice(-most).replace(/^\S*\s/, '')}` : words;
}

function Speaking() {
    return (
        <span className="buddy-speaker" aria-hidden="true">
            <span />
            <span />
            <span />
        </span>
    );
}

/**
 * How to talk to it now, as a hint: hold the chord, with the buddy on for
 * good; else press the voice key, which works while an agent drives.
 */
function talkHint(t, state, kind) {
    return state.talk === 'hold'
        ? { text: t(`buddy.${kind}Hint`), chord: state.chord || 'Ctrl Alt' }
        : { text: t(`buddy.${kind}HintPress`), chord: state.voiceChord || 'Ctrl S' };
}

/**
 * Whose turn it is, when it is not the buddy's own: the chat's title and its
 * agent. And how many more agents are at work on the desktop than this one.
 */
function Who({ state }) {
    const t = useT();
    const others = state.others || 0;
    if (!state.chat && !others) return null;
    const name = state.chat ? (state.title || state.agent || t('buddy.untitled')) : '';
    const meta = [
        state.chat && state.title ? state.agent : '',
        others > 0 ? (name ? t('buddy.more', { count: others }) : t('buddy.othersAtWork', { count: others })) : '',
    ].filter(Boolean).join(' · ');
    return (
        <div className="buddy-who">
            {name && <span className="min-w-0 truncate text-white/70">{name}</span>}
            {meta && <span className="shrink-0">{meta}</span>}
        </div>
    );
}

function NotchBody({ state, peek, download, heardHere }) {
    const t = useT();
    const phrase = usePhrase('think');
    // The clock ticks only while the agent is at it; at rest it stands still.
    const working = Boolean(state.since) && ['thinking', 'acting', 'waiting'].includes(state.phase);
    const seconds = useSeconds(state.since || 0, working ? 0 : 1);
    const clock = working && seconds >= 3 ? elapsed(seconds) : '';
    const chord = state.chord || 'Ctrl Alt';
    const who = <Who state={state} />;
    const steer = talkHint(t, state, 'steer');
    const answer = talkHint(t, state, 'answer');

    const line = (icon, text, { cue, meta = clock, tone = '' } = {}) => (
        <div className={`flex items-center gap-2.5 min-w-0 text-[12.5px] font-medium ${tone}`}>
            <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center">{icon}</span>
            {cue
                ? <RollingPhrase fit text={text} cue={cue} />
                : <span className="min-w-0 flex-1 truncate">{text}</span>}
            {meta && <span className="shrink-0 tabular-nums text-[10.5px] font-normal text-white/40">{meta}</span>}
        </div>
    );

    switch (state.phase) {
        case 'listening':
            return (
                <>
                    {who}
                    {line(
                        <span className="relative w-2 h-2 rounded-full bg-rose-500 buddy-rec" />,
                        state.mode === 'steer' ? t('buddy.listeningSteer') : t('buddy.listening'),
                        // Whom it is for, when it is not obvious from the turn under way.
                        { meta: download !== null ? t('assistant.speechModel', { percent: download }) : (state.mode === 'steer' ? '' : agentOf(state)?.name || '') },
                    )}
                    {/* The level is drawn in the window that is listening; on another display's notch it only breathes. */}
                    <NotchWave resting={!heardHere} />
                    {state.heard && <div className="buddy-heard">{tail(state.heard)}</div>}
                    {/* Pressed rather than held: it says how it ends. */}
                    {state.toggle && (
                        <div className="mt-2 flex justify-end">
                            <Hint text={t('buddy.sendHint')} chord={state.voiceChord || 'Ctrl S'} />
                        </div>
                    )}
                </>
            );
        case 'hearing':
            return (
                <>
                    {who}
                    {line(<Ring className="text-white/70" />, t('buddy.hearing'), { meta: '' })}
                    {state.heard && <div className="buddy-heard">{tail(state.heard)}</div>}
                </>
            );
        case 'looking':
            return line(<Ring className="text-white/70" />, t('buddy.looking'), { meta: '' });
        case 'thinking':
        case 'acting': {
            if (state.held) {
                return (
                    <>
                        {who}
                        {line(
                            <span className={`w-2 h-2 rounded-[2px] ${state.held === 'escape' ? 'bg-red-500' : 'bg-amber-400'}`} />,
                            state.held === 'escape' ? t('buddy.stopped') : t('buddy.paused'),
                            { tone: state.held === 'escape' ? 'text-red-300' : 'text-amber-200' },
                        )}
                    </>
                );
            }
            const tool = state.phase === 'acting' ? state.action : null;
            const named = Boolean(tool && DOING[tool.name]);
            return (
                <>
                    {who}
                    {line(
                        <Ring className={tool ? 'text-violet-300' : 'text-white/70'} />,
                        named ? action(t, tool) : phrase,
                        { cue: named ? `act:${tool.seq}` : phrase },
                    )}
                    {state.said && <div className="buddy-said">{state.said}</div>}
                    {peek && <div className="mt-2 flex justify-end"><Hint text={steer.text} chord={steer.chord} /></div>}
                </>
            );
        }
        case 'waiting':
            return (
                <>
                    {who}
                    {line(<span className="w-2 h-2 rounded-full bg-amber-400 buddy-rec" />, t('buddy.asks'), { tone: 'text-amber-200' })}
                    {state.ask?.question && <div className="buddy-reply">{state.ask.question}</div>}
                    {state.say?.trouble && <div className="buddy-trouble">{state.say.trouble}</div>}
                    {state.ask?.options?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {state.ask.options.map(option => <span key={option} className="buddy-chip">{option}</span>)}
                        </div>
                    )}
                    <div className="mt-2.5 flex justify-end"><Hint text={answer.text} chord={answer.chord} /></div>
                </>
            );
        case 'speaking':
        case 'done': {
            // The recap, as it was said, leads; the reply is under it for
            // whoever looks up, the start of it at least.
            // A chat's title is in the line above already.
            const lead = state.recap || (state.chat ? '' : state.title) || t('buddy.done');
            const rest = state.reply && state.reply !== state.recap ? state.reply : '';
            return (
                <>
                    {who}
                    <div className="flex items-start gap-2.5 min-w-0">
                        <span className="w-3.5 h-[18px] shrink-0 flex items-center justify-center">
                            {state.phase === 'speaking' ? <Speaking /> : <span className="buddy-done-dot" />}
                        </span>
                        <span className="buddy-recap">{lead}</span>
                    </div>
                    {rest && <div className="buddy-reply buddy-reply-old">{rest}</div>}
                    {state.say?.trouble && <div className="buddy-trouble">{state.say.trouble}</div>}
                </>
            );
        }
        case 'notice':
            return line(<span className="text-[12px] leading-none text-amber-300">!</span>, state.notice, { tone: 'text-amber-100', meta: '' });
        default:
            // At rest: nothing, unless the cursor rests on it.
            if (!peek) return <span className="buddy-rest-dot" aria-hidden="true" />;
            return (
                <>
                    <div className="flex items-center justify-center"><Hint text={t('buddy.hint')} chord={chord} /></div>
                    {state.reply && <div className="buddy-reply buddy-reply-old">{state.reply}</div>}
                </>
            );
    }
}

/**
 * The one place of this window that can be clicked, while `ref`'s element
 * is drawn: main makes the window take the mouse with the pointer over it,
 * and only then (see `hit` in main/ai/buddy.js). Only one such place shows
 * at a time: the whole notch while it can be picked up, else the agents, or
 * the buttons while the agent works. `on` false leaves it to another; `at`
 * changing says it moved, and it is measured again without the mouse being
 * let go of between.
 */
function useHitArea(ref, key, on = true, at = '') {
    const sendRef = useRef(null);
    useEffect(() => {
        const node = ref.current;
        if (!on || !node) return undefined;
        const send = () => {
            const rect = node.getBoundingClientRect();
            window.api.buddy.hit({ x: rect.left - 3, y: rect.top - 3, width: rect.width + 6, height: rect.height + 6 });
        };
        sendRef.current = send;
        send();
        // The notch eases open around it, so it is measured again as it settles.
        const timers = [90, 200, 340, 520, 700].map(ms => setTimeout(send, ms));
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(send) : null;
        observer?.observe(node);
        return () => {
            sendRef.current = null;
            timers.forEach(clearTimeout);
            observer?.disconnect();
            window.api.buddy.hit(null);
        };
    }, [ref, key, on]);
    useEffect(() => {
        sendRef.current?.();
    }, [at]);
}

/**
 * While the agent works: open its chat in the app, or stop it, as the Stop
 * button there does. In the notch's top corner, the same through every step
 * of the turn.
 */
function WorkControls() {
    const t = useT();
    const box = useRef(null);
    useHitArea(box, 'work');
    return (
        <div ref={box} className="buddy-controls">
            <button
                type="button"
                className="buddy-control"
                title={t('buddy.openInApp')}
                aria-label={t('buddy.openInApp')}
                onClick={() => window.api.buddy.open()}
            >
                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
                    <path d="M4.5 2.5h5v5M9.5 2.5 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
            <button
                type="button"
                className="buddy-control buddy-control-stop"
                title={t('buddy.stop')}
                aria-label={t('buddy.stop')}
                onClick={() => window.api.buddy.stop()}
            >
                <span className="buddy-stop-square" />
            </button>
        </div>
    );
}

/**
 * Who the buddy talks to, and the others it could: the cursor resting on
 * the notch at rest, or a moment after a switch (Ctrl+Alt+Space). The row of
 * agents can be clicked (see useHitArea); while the notch can be picked up,
 * all of it takes the mouse, so the row is not told separately (`own`).
 */
function AgentPicker({ state, peek, switched, own = true }) {
    const t = useT();
    const row = useRef(null);
    const agents = state.agents || [];
    const current = agentOf(state);
    const chord = state.chord || 'Ctrl Alt';

    useHitArea(row, agents.length, own);

    if (!agents.length) {
        return (
            <>
                <div className="flex items-center justify-center"><Hint text={t('buddy.hint')} chord={chord} /></div>
                {state.reply && <div className="buddy-reply buddy-reply-old">{state.reply}</div>}
            </>
        );
    }

    return (
        <>
            <div className="flex items-center gap-2 min-w-0 text-[12.5px] font-medium">
                <span className="min-w-0 flex-1 truncate">
                    {switched && current ? t('buddy.nowTalkingTo', { name: current.name }) : t('buddy.talkingTo')}
                </span>
                <span className="shrink-0"><Hint text={t('buddy.switchHint')} chord={state.switchChord || 'Ctrl Alt Space'} /></span>
            </div>
            <div ref={row} className="buddy-agents" role="radiogroup" aria-label={t('buddy.talkingTo')}>
                {agents.map(agent => (
                    <button
                        key={agent.id}
                        type="button"
                        role="radio"
                        aria-checked={agent.id === state.agentId}
                        className="buddy-agent"
                        data-on={agent.id === state.agentId ? 'true' : 'false'}
                        data-dim={agent.computerUse ? 'false' : 'true'}
                        title={agent.computerUse ? agent.name : t('buddy.answersOnly', { name: agent.name })}
                        onClick={() => window.api.buddy.pickAgent(agent.id)}
                    >
                        <span className="buddy-agent-dot" style={{ background: dotOf(agent.color) }} />
                        <span className="min-w-0 truncate">{agent.name}</span>
                    </button>
                ))}
            </div>
            {current && !current.computerUse && <div className="buddy-trouble">{t('buddy.cannotAct', { name: current.name })}</div>}
            {peek && !switched && (
                <>
                    <div className="mt-2.5 flex justify-center"><Hint text={t('buddy.hint')} chord={chord} /></div>
                    {state.reply && <div className="buddy-reply buddy-reply-old">{state.reply}</div>}
                </>
            )}
        </>
    );
}

/** The notch's size by phase, in CSS pixels: width, and the least height. */
const SIZES = {
    idle: [REST_W, REST_H],
    listening: [340, 0],
    hearing: [320, 0],
    looking: [300, 0],
    thinking: [320, 0],
    acting: [340, 0],
    waiting: [380, 0],
    speaking: [390, 0],
    done: [390, 0],
    notice: [360, 0],
};
/** Open on the agents. */
const PICKER_W = 340;

/** The window's size in CSS pixels, followed as it changes. */
function useViewport() {
    const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
    useEffect(() => {
        const follow = () => setSize({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener('resize', follow);
        return () => window.removeEventListener('resize', follow);
    }, []);
    return size;
}

const fraction = value => Math.min(1, Math.max(0, value));

/** Docked to the left or right side, where it stands on end. */
const onSide = place => place.dock === 'left' || place.dock === 'right';

/**
 * The edge a point in this window is near enough to dock to, the nearer of
 * two in a corner; false for none. Off this window (over another display)
 * it is none: main sees where it was let go there. Kept with `edgeNear` in
 * buddy.js.
 */
function edgeNear(x, y, width, height) {
    const near = [['top', y], ['left', x], ['right', width - x]]
        .filter(([, gap]) => gap >= 0 && gap < DOCK_ZONE)
        .sort((a, b) => a[1] - b[1]);
    return near.length ? near[0][0] : false;
}

/**
 * Where a notch let go of here would go: near the top edge it hangs from it,
 * near a side it stands on end against it (in the middle of either if near
 * it), anywhere else it floats with its middle under the pointer. As
 * fractions of the display, as main keeps it.
 */
function placeAt(x, y, view) {
    const width = view.width || 1;
    const height = view.height || 1;
    const dock = edgeNear(x, y, width, height);
    if (dock === 'top') {
        const across = Math.abs(x - width / 2) < MIDDLE_SNAP ? 0.5 : x / width;
        return { x: fraction(across), y: 0, dock };
    }
    if (dock) {
        const down = Math.abs(y - height / 2) < MIDDLE_SNAP ? 0.5 : y / height;
        return { x: dock === 'left' ? 0 : 1, y: fraction(down), dock };
    }
    return { x: fraction(x / width), y: fraction(y / height), dock: false };
}

/**
 * Where the notch is drawn, in CSS pixels, at the size it is now: docked to
 * the top, hanging from it; docked to a side, flush with it, opening inward
 * and kept centred where it was left, as far as the screen allows; floating,
 * opening downward in the top half of the display and upward in the bottom
 * half, so it never opens off the screen. Kept clear of the sides however
 * wide it opens.
 */
function notchStyle(place, view, width, height) {
    if (onSide(place)) {
        // Its ears reach 8px above and below it.
        const room = EDGE + 8;
        const top = Math.round(Math.min(
            Math.max(place.y * view.height - height / 2, room),
            Math.max(room, view.height - height - room),
        ));
        return place.dock === 'left' ? { left: 0, top } : { right: 0, top };
    }
    const half = width / 2;
    // A docked one's ears reach 8px past it.
    const side = place.dock ? EDGE + 8 : EDGE;
    const low = half + side;
    const high = Math.max(low, view.width - half - side);
    const left = Math.round(Math.min(high, Math.max(low, place.x * view.width)));
    if (place.dock) return { left, top: 0 };
    const middle = place.y * view.height;
    const top = Math.round(Math.min(Math.max(middle - REST_H / 2, EDGE), Math.max(EDGE, view.height - REST_H - EDGE)));
    if (middle <= view.height / 2) return { left, top };
    return { left, bottom: Math.round(view.height - (top + REST_H)) };
}

function Notch({ state, cursor, download, heardHere }) {
    const box = useRef(null);
    const body = useRef(null);
    const view = useViewport();
    const [height, setHeight] = useState(REST_H);
    const [peek, setPeek] = useState(false);
    // Being dragged: where it would go if let go now. And where it was let
    // go, drawn there until main's word on it comes back.
    const [drag, setDrag] = useState(null);
    const [dropped, setDropped] = useState(null);
    const press = useRef(null);
    const dragging = Boolean(drag);
    const phase = state.phase || 'idle';
    const resting = phase === 'idle';
    // The agents show with the cursor resting on it at rest, and for a moment
    // after a switch whatever it is doing. Only with the buddy on for good:
    // otherwise it is up for the agents at work, and nothing is talked to.
    const switched = useFlash(state.switcher);
    const picking = !dragging && state.talk === 'hold' && ((peek && resting) || switched);
    // Carried about, it is the small one at rest.
    const closed = dragging || (resting && !picking);
    // A turn under way: it can be stopped, or opened in the app, from here.
    const working = !picking && !dragging && ['thinking', 'acting', 'waiting'].includes(phase);
    // It can be picked up with the pointer resting on it, unless a turn is
    // under way or someone is talking to it; all of it takes the mouse then.
    const movable = dragging || (peek && !BUSY.has(phase));
    const [openWidth, least] = closed ? SIZES.idle : picking ? [PICKER_W, 0] : (SIZES[phase] || SIZES.idle);

    const saved = state.place;
    const savedKey = saved ? `${saved.display}:${saved.x}:${saved.y}:${saved.dock}` : '';
    useEffect(() => setDropped(null), [savedKey]);
    // Main not having taken it after all: back to where it is kept.
    useEffect(() => {
        if (!dropped) return undefined;
        const timer = setTimeout(() => setDropped(null), 1500);
        return () => clearTimeout(timer);
    }, [dropped]);
    const place = drag || dropped || saved || TOP_MIDDLE;
    // Docked to a side, it stands on end at rest; open, it is the same panel
    // as anywhere else, flush with that side.
    const side = onSide(place);
    const width = closed && side ? REST_H : openWidth;
    const drawnHeight = closed ? (side ? REST_W : REST_H) : height;
    const at = notchStyle(place, view, width, drawnHeight);
    const spot = `${at.left}:${at.right}:${at.top}:${at.bottom}`;
    useHitArea(box, 'notch', movable, `${spot}:${view.width}:${view.height}`);

    // The height follows what is in it, so the notch eases open to fit. What
    // is in it is laid out at the open width already, so this is one height
    // per opening, not a new one each frame of the width easing out.
    useLayoutEffect(() => {
        const node = body.current;
        if (!node) return undefined;
        const measure = () => setHeight(Math.max(least || 0, Math.ceil(node.scrollHeight)));
        measure();
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        return () => observer.disconnect();
    }, [least, resting, peek, phase, picking]);

    // The cursor resting on it opens it a little; this window hears no
    // mouse, so the cursor main tells it about is checked against it.
    const peekCheck = useRef(null);
    useEffect(() => {
        let timer = 0;
        const check = (point) => {
            const bounds = cursor.hello?.bounds;
            const node = box.current;
            if (!bounds || !node) return;
            const rect = node.getBoundingClientRect();
            // The display's pixels to this page's, which differ if the app is zoomed.
            const scale = window.innerWidth > 0 ? bounds.width / window.innerWidth : 1;
            const x = (point.x - bounds.x) / scale;
            const y = (point.y - bounds.y) / scale;
            // Docked, from the very edge; floating, a little round it on every side.
            const near = x >= rect.left - PEEK_PAD && x <= rect.right + PEEK_PAD
                && y >= (rect.top > 0 ? rect.top - PEEK_PAD : 0) && y <= rect.bottom + PEEK_PAD;
            if (near && !timer) {
                timer = setTimeout(() => setPeek(true), PEEK_AFTER);
            } else if (!near) {
                clearTimeout(timer);
                timer = 0;
                setPeek(false);
            }
        };
        peekCheck.current = check;
        const off = cursor.subscribe(check);
        return () => {
            peekCheck.current = null;
            off();
            clearTimeout(timer);
        };
    }, [cursor]);

    // Moved without the pointer moving (put back from Settings, its display
    // gone): whether the pointer is on it is asked again, so it does not stay
    // open where nobody is.
    useEffect(() => {
        if (!press.current && cursor.last.current) peekCheck.current?.(cursor.last.current);
        // Only when it has moved.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [spot]);

    /*
     * Dragging it. The button going down on it is not yet a drag, so a click
     * on an agent still picks it; a few pixels on, it is. From the press the
     * pointer is followed over the whole window, not the notch alone: a quick
     * hand is off the small notch before the drag has begun. Let go, main is
     * told where, and keeps it (see `moveNotch` in buddy.js); let go over
     * another display, main sees where the pointer is and puts it there.
     */
    const viewRef = useRef(view);
    viewRef.current = view;
    // Gone with a drag under way (switched off, say): nothing left listening.
    useEffect(() => () => press.current?.stop(), []);

    const onPointerDown = (event) => {
        if (!movable || event.button !== 0) return;
        press.current?.stop();
        const held = { id: event.pointerId, x: event.clientX, y: event.clientY, moving: false, last: null };
        const finish = (end) => {
            held.stop();
            if (!held.moving) return;
            setDrag(null);
            if (!end) return;
            setDropped(end);
            window.api.buddy.place(end);
        };
        const move = (next) => {
            if (next.pointerId !== held.id) return;
            // The button came up where it was not seen: the drag ends where it was last.
            if (next.buttons === 0) {
                finish(held.last);
                return;
            }
            if (!held.moving) {
                if (Math.hypot(next.clientX - held.x, next.clientY - held.y) < DRAG_AFTER) return;
                held.moving = true;
                try {
                    box.current?.setPointerCapture(held.id);
                } catch {
                    // Followed all the same, over this window.
                }
            }
            held.last = placeAt(next.clientX, next.clientY, viewRef.current);
            setDrag(held.last);
        };
        const up = (next) => {
            if (next.pointerId !== held.id) return;
            // Where the pointer came up; a drag cut short ends where it was last seen.
            finish(next.type === 'pointerup' ? placeAt(next.clientX, next.clientY, viewRef.current) : held.last);
        };
        held.stop = () => {
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
            if (press.current === held) press.current = null;
        };
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        press.current = held;
    };

    // The ears outside the box are drawn by the notch itself; what is inside
    // is clipped by a layer of its own, and measured at its natural height.
    const classes = [
        'buddy-notch',
        closed && 'buddy-notch-rest',
        !place.dock && 'buddy-notch-float',
        side && `buddy-notch-${place.dock}`,
        movable && 'buddy-notch-movable',
        dragging && 'buddy-notch-dragging',
    ].filter(Boolean).join(' ');
    return (
        <div
            ref={box}
            className={classes}
            data-phase={phase}
            data-picking={picking ? 'true' : 'false'}
            style={{ ...at, width, height: drawnHeight }}
            onPointerDown={onPointerDown}
        >
            <div className="buddy-notch-clip">
                <div
                    ref={body}
                    key={closed ? 'rest' : picking ? 'agents' : `open:${phase}`}
                    className={`buddy-notch-body ${working ? 'buddy-notch-body-controls' : ''}`}
                    // At the width it opens to from the first frame, so its
                    // height is measured once rather than as it widens.
                    style={closed ? undefined : { width }}
                >
                    {picking
                        ? <AgentPicker state={state} peek={peek} switched={switched} own={!movable} />
                        : <NotchBody state={state} peek={peek} download={download} heardHere={heardHere} />}
                </div>
            </div>
            {working && <WorkControls />}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * What it draws
 * ------------------------------------------------------------------ */

/** How long a drawing takes to fade once it is taken down, as .buddy-drawing's transition. */
const ERASE_MS = 340;
/** How far apart the shapes of one drawing start, so they are drawn one after another. */
const STROKE_GAP_MS = 380;
/** How long before the first stroke, so the mark is on its way there. */
const FIRST_STROKE_MS = 260;

/**
 * The shapes of the latest drawing that are on this display, drawn stroke
 * by stroke, each label after its stroke. Taken down, it fades rather than
 * vanishes; a new one replaces it at once.
 */
function Drawing({ drawing, bounds }) {
    const [shown, setShown] = useState(null);
    const at = drawing?.at || 0;

    useEffect(() => {
        if (at && drawing?.shapes?.length) {
            setShown({ at, shapes: drawing.shapes, leaving: false });
            return undefined;
        }
        setShown(current => (current ? { ...current, leaving: true } : null));
        const timer = setTimeout(() => setShown(current => (current?.leaving ? null : current)), ERASE_MS + 40);
        return () => clearTimeout(timer);
        // Once per drawing, by when it was made.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [at]);

    const here = useMemo(() => {
        if (!shown || !bounds) return [];
        return shown.shapes
            .map((shape, index) => ({ shape, index }))
            .filter(({ shape }) => {
                const centre = centreOf(shape);
                return centre && centre.x >= bounds.x && centre.x < bounds.x + bounds.width
                    && centre.y >= bounds.y && centre.y < bounds.y + bounds.height;
            })
            .map(({ shape, index }) => {
                const local = moved(shape, bounds.x, bounds.y);
                return { local, index, drawn: sketchOf(local) };
            })
            .filter(({ drawn }) => drawn);
    }, [shown, bounds]);

    if (!here.length) return null;
    return (
        <div key={shown.at} className={`buddy-drawing ${shown.leaving ? 'buddy-drawing-leaving' : ''}`} aria-hidden="true">
            <svg className="buddy-drawing-canvas" width="100%" height="100%">
                {here.map(({ local, index, drawn }, order) => {
                    const delay = FIRST_STROKE_MS + order * STROKE_GAP_MS;
                    return (
                        <g key={index} className={`buddy-shape buddy-shape-${local.kind}`} style={{ '--delay': `${delay}ms` }}>
                            {drawn.fill && (
                                <rect
                                    className="buddy-fill"
                                    x={drawn.fill.x}
                                    y={drawn.fill.y}
                                    width={drawn.fill.width}
                                    height={drawn.fill.height}
                                    rx="5"
                                />
                            )}
                            {drawn.paths.map((d, path) => (
                                <path key={path} className="buddy-stroke" d={d} pathLength="1" />
                            ))}
                            {drawn.head && <path className="buddy-stroke buddy-stroke-head" d={drawn.head} pathLength="1" />}
                        </g>
                    );
                })}
            </svg>
            {here.map(({ local, index, drawn }, order) => local.label && (
                <span
                    key={index}
                    className={`buddy-bubble buddy-bubble-point buddy-sketch-label ${drawn.label.align === 'centre' ? 'buddy-sketch-label-centre' : ''}`}
                    style={{
                        left: Math.max(6, Math.min(bounds.width - 40, drawn.label.x)),
                        top: Math.max(6, Math.min(bounds.height - 30, drawn.label.y)),
                        animationDelay: `${FIRST_STROKE_MS + order * STROKE_GAP_MS + 420}ms`,
                    }}
                >
                    {local.label}
                </span>
            ))}
        </div>
    );
}

/* ------------------------------------------------------------------ *
 * Listening and talking
 * ------------------------------------------------------------------ */

/**
 * The microphone, when main says this window is to listen: started when the
 * chord goes down, stopped when it comes up, thrown away when it was a
 * shortcut after all. What is heard goes to main as it comes.
 */
function useListening(meterRef) {
    const onText = useCallback((text, { final }) => {
        window.api.buddy.heard({ text: text || '', final: Boolean(final) });
    }, []);
    const onNotice = useCallback((message) => {
        if (message) window.api.buddy.heard({ notice: String(message) });
    }, []);
    const dictation = useDictation({ onText, onNotice, meterRef });
    const latest = useRef(dictation);
    latest.current = dictation;

    useEffect(() => window.api.buddy.onListen((message) => {
        const current = latest.current;
        if (message?.action === 'start') {
            window.speechSynthesis?.cancel();
            current.start({ live: Boolean(message.live) });
        } else if (message?.action === 'stop') {
            current.stop();
        } else if (message?.action === 'cancel') {
            current.cancel();
        }
    }), []);

    return dictation;
}

/**
 * The recap (or a question) said aloud, on the main display's window, and
 * main told when it has been. In this computer's voice, or ElevenLabs' or
 * OpenRouter's: its audio comes on a channel of its own, by the say's id, as
 * it streams, and may come before the state that names it, so it waits a
 * moment for that. If that voice fails, or says nothing for a while, the
 * same words go in this computer's voice instead.
 */
function useSpeaker(say, primary) {
    const sayId = say?.id || 0;
    const current = useRef(null);
    const early = useRef(new Map());

    // What ElevenLabs sends, for the say it belongs to.
    useEffect(() => {
        if (!primary) return undefined;
        return window.api.buddy.onAudio((message) => {
            const now = current.current;
            if (!now || message?.id !== now.id) {
                // Ahead of its say: kept until the say arrives. Behind: dropped.
                if (message?.id && (!now || message.id > now.id)) {
                    const kept = early.current.get(message.id) || [];
                    kept.push(message);
                    early.current.set(message.id, kept.slice(-400));
                }
                return;
            }
            now.hear(message);
        });
    }, [primary]);

    useEffect(() => {
        if (!primary) return undefined;
        if (!sayId || !say?.text) {
            window.speechSynthesis?.cancel();
            return undefined;
        }
        let done = false;
        // This computer's voice has taken over: ElevenLabs' audio that comes late is not played over it.
        let fell = false;
        let player = null;
        let quiet = () => {};
        const end = () => {
            if (done) return;
            done = true;
            window.api.buddy.spoke(sayId);
        };
        const fallBack = () => {
            if (done || fell) return;
            fell = true;
            player?.stop();
            player = null;
            quiet = speakSystem(say.text, end, { pace: say.pace, pitch: say.pitch });
        };
        let guard = 0;
        if (say.engine === 'elevenlabs' || say.engine === 'openrouter') {
            current.current = {
                id: sayId,
                hear: (message) => {
                    if (done || fell) return;
                    if (message.error) {
                        fallBack();
                    } else if (message.done) {
                        if (player) player.end(end);
                        else fallBack();
                    } else if (message.chunk) {
                        clearTimeout(guard);
                        // At the rate the audio says it is (some of OpenRouter's models send 44.1 kHz).
                        player = player || createPcmPlayer(message.rate || say.rate || 24000);
                        player.push(message.chunk);
                    }
                },
            };
            for (const message of early.current.get(sayId) || []) current.current.hear(message);
            early.current.clear();
            // Nothing from ElevenLabs in this long: this computer's voice says it.
            guard = setTimeout(() => { if (!player) fallBack(); }, 6000);
        } else {
            current.current = { id: sayId, hear: () => {} };
            quiet = speakSystem(say.text, end, { pace: say.pace, pitch: say.pitch });
        }
        // A voice that never says it finished does not hold the notch open.
        const limit = setTimeout(end, Math.max(9000, say.text.length * 110));
        return () => {
            clearTimeout(guard);
            clearTimeout(limit);
            player?.stop();
            quiet();
            if (current.current?.id === sayId) current.current = null;
        };
        // Once per say.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sayId, primary]);
}

export default function BuddyOverlay() {
    const [hello, setHello] = useState(null);
    const [state, setState] = useState(null);
    const [listener, setListener] = useState(false);
    const meterRef = useRef(null);
    const cursor = useCursor(hello);

    useEffect(() => {
        const offs = [
            window.api.buddy.onHello(setHello),
            window.api.buddy.onState(setState),
            // The window told to listen draws the voice's level on its mark.
            window.api.buddy.onListen((message) => {
                if (message?.action === 'start') setListener(true);
            }),
        ];
        window.api.buddy.ready();
        return () => offs.forEach(off => off?.());
    }, []);

    const dictation = useListening(meterRef);
    useEffect(() => {
        if (dictation.state === 'idle' && state?.phase !== 'listening') setListener(false);
    }, [dictation.state, state?.phase]);

    useSpeaker(state?.say, Boolean(hello?.primary));

    if (!hello || !state) return null;

    // The notch is on the display it was left on, the main one unless it was dragged.
    const notchHere = state.place ? String(state.place.display) === String(hello.displayId) : hello.primary;

    // The voice's level is set on the root each frame (useDictation), so the
    // mark and the notch both read it.
    return (
        <div
            ref={meterRef}
            style={{ '--level': 0 }}
            className="buddy-root font-inter select-none pointer-events-none"
            lang={getLanguage()}
        >
            <Drawing drawing={state.drawing} bounds={hello.bounds} />
            {notchHere && state.notch && (
                <Notch state={state} cursor={cursor} download={dictation.download} heardHere={listener} />
            )}
            <Mark state={state} cursor={cursor} />
        </div>
    );
}
