import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { action, BARS, DOING } from './ActivityOverlay';
import { Ring, RollingPhrase, elapsed, usePhrase, useSeconds } from './WorkingIndicator';
import useDictation from '../../hooks/useDictation';
import { createPcmPlayer } from '../../lib/pcm-player';
import { speakSystem } from '../../lib/system-voice';
import { agentColor } from '../../lib/agent-colors';
import { getLanguage, useT } from '../../i18n';

/**
 * The buddy: Acestes in the background, beside the cursor (see
 * main/ai/buddy.js, which says what to draw).
 *
 * One of these per display, each a transparent, click-through window the
 * size of it, kept out of screen capture. Two things are drawn:
 *
 *   the mark    a small violet arrowhead riding beside the cursor on a
 *               spring, on whichever display the cursor is on. It becomes a
 *               waveform while you hold Ctrl+Alt and talk, a turning ring
 *               while the agent thinks, and says what the agent is doing
 *               beside it (Clicking · Save) as it does it. A reply that
 *               points somewhere sends it flying there along an arc, where it
 *               says what it found, then back to the cursor.
 *   the notch   on the main display, a black notch hanging from the top
 *               edge, MacBook-style: small at rest, opening to show what is
 *               heard, what the agent is at, what it asks, and what it said.
 *               With the cursor resting on it, it opens a little to say how
 *               to talk to it, and the last reply.
 *
 * The window told to listen records (useDictation, the same engines as the
 * composer's microphone) and says what it hears; the one on the main display
 * reads replies out with this computer's voice.
 */

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

    const draw = useCallback(() => {
        const s = sim.current;
        const el = node.current;
        if (!el) return;
        el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
        el.style.setProperty('--turn', `${s.turn.toFixed(1)}deg`);
        el.style.setProperty('--grow', (s.grow ?? 1).toFixed(3));
        el.style.opacity = s.here || s.flight || s.rest ? '1' : '0';
    }, []);

    const target = useCallback(() => {
        const s = sim.current;
        const point = cursor.last.current;
        const bounds = cursor.hello?.bounds;
        if (!point || !bounds) return null;
        return { x: point.x - bounds.x + OFFSET.x, y: point.y - bounds.y + OFFSET.y, s };
    }, [cursor]);

    const tick = useCallback((now) => {
        const s = sim.current;
        const dt = Math.min(3, Math.max(0.25, (now - (s.last || now - 16)) / 16.67));
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
    }, [draw, target]);

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
                <span className="buddy-bubble buddy-bubble-point">{typed || ' '}</span>
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

function NotchBody({ state, peek, download, heardHere }) {
    const t = useT();
    const phrase = usePhrase('think');
    // The clock ticks only while the agent is at it; at rest it stands still.
    const working = Boolean(state.since) && ['thinking', 'acting', 'waiting'].includes(state.phase);
    const seconds = useSeconds(state.since || 0, working ? 0 : 1);
    const clock = working && seconds >= 3 ? elapsed(seconds) : '';
    const chord = state.chord || 'Ctrl Alt';

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
                    {line(
                        <span className="relative w-2 h-2 rounded-full bg-rose-500 buddy-rec" />,
                        state.mode === 'steer' ? t('buddy.listeningSteer') : t('buddy.listening'),
                        // Whom it is for, when it is not obvious from the turn under way.
                        { meta: download !== null ? t('assistant.speechModel', { percent: download }) : (state.mode === 'steer' ? '' : agentOf(state)?.name || '') },
                    )}
                    {/* The level is drawn in the window that is listening; on another display's notch it only breathes. */}
                    <NotchWave resting={!heardHere} />
                    {state.heard && <div className="buddy-heard">{tail(state.heard)}</div>}
                </>
            );
        case 'hearing':
            return (
                <>
                    {line(<Ring className="text-white/70" />, t('buddy.hearing'), { meta: '' })}
                    {state.heard && <div className="buddy-heard">{tail(state.heard)}</div>}
                </>
            );
        case 'looking':
            return line(<Ring className="text-white/70" />, t('buddy.looking'), { meta: '' });
        case 'thinking':
        case 'acting': {
            if (state.held) {
                return line(
                    <span className={`w-2 h-2 rounded-[2px] ${state.held === 'escape' ? 'bg-red-500' : 'bg-amber-400'}`} />,
                    state.held === 'escape' ? t('buddy.stopped') : t('buddy.paused'),
                    { tone: state.held === 'escape' ? 'text-red-300' : 'text-amber-200' },
                );
            }
            const tool = state.phase === 'acting' ? state.action : null;
            const named = Boolean(tool && DOING[tool.name]);
            return (
                <>
                    {line(
                        <Ring className={tool ? 'text-violet-300' : 'text-white/70'} />,
                        named ? action(t, tool) : phrase,
                        { cue: named ? `act:${tool.seq}` : phrase },
                    )}
                    {state.said && <div className="buddy-said">{state.said}</div>}
                    {peek && <div className="mt-2 flex justify-end"><Hint text={t('buddy.steerHint')} chord={chord} /></div>}
                </>
            );
        }
        case 'waiting':
            return (
                <>
                    {line(<span className="w-2 h-2 rounded-full bg-amber-400 buddy-rec" />, t('buddy.asks'), { tone: 'text-amber-200' })}
                    {state.ask?.question && <div className="buddy-reply">{state.ask.question}</div>}
                    {state.say?.trouble && <div className="buddy-trouble">{state.say.trouble}</div>}
                    {state.ask?.options?.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                            {state.ask.options.map(option => <span key={option} className="buddy-chip">{option}</span>)}
                        </div>
                    )}
                    <div className="mt-2.5 flex justify-end"><Hint text={t('buddy.answerHint')} chord={chord} /></div>
                </>
            );
        case 'speaking':
        case 'done': {
            // The recap, as it was said, leads; the reply is under it for
            // whoever looks up, the start of it at least.
            const lead = state.recap || state.title || t('buddy.done');
            const rest = state.reply && state.reply !== state.recap ? state.reply : '';
            return (
                <>
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
 * at a time: the agents, or the buttons while the agent works.
 */
function useHitArea(ref, key) {
    useEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        const send = () => {
            const rect = node.getBoundingClientRect();
            window.api.buddy.hit({ x: rect.left - 3, y: rect.top - 3, width: rect.width + 6, height: rect.height + 6 });
        };
        send();
        // The notch eases open around it, so it is measured again as it settles.
        const timers = [90, 200, 340, 520, 700].map(ms => setTimeout(send, ms));
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(send) : null;
        observer?.observe(node);
        return () => {
            timers.forEach(clearTimeout);
            observer?.disconnect();
            window.api.buddy.hit(null);
        };
    }, [ref, key]);
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
 * agents can be clicked (see useHitArea).
 */
function AgentPicker({ state, peek, switched }) {
    const t = useT();
    const row = useRef(null);
    const agents = state.agents || [];
    const current = agentOf(state);
    const chord = state.chord || 'Ctrl Alt';

    useHitArea(row, agents.length);

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
    idle: [150, 26],
    listening: [380, 0],
    hearing: [360, 0],
    looking: [330, 0],
    thinking: [360, 0],
    acting: [380, 0],
    waiting: [420, 0],
    speaking: [430, 0],
    done: [430, 0],
    notice: [400, 0],
};

function Notch({ state, cursor, download, heardHere }) {
    const box = useRef(null);
    const body = useRef(null);
    const [height, setHeight] = useState(26);
    const [peek, setPeek] = useState(false);
    const phase = state.phase || 'idle';
    const resting = phase === 'idle';
    // The agents show with the cursor resting on it at rest, and for a moment
    // after a switch whatever it is doing.
    const switched = useFlash(state.switcher);
    const picking = (peek && resting) || switched;
    const closed = resting && !picking;
    // A turn under way: it can be stopped, or opened in the app, from here.
    const working = !picking && ['thinking', 'acting', 'waiting'].includes(phase);
    const [width, least] = picking ? [370, 0] : (SIZES[phase] || SIZES.idle);

    // The height follows what is in it, so the notch eases open to fit.
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
    useEffect(() => {
        let timer = 0;
        const off = cursor.subscribe((point) => {
            const bounds = cursor.hello?.bounds;
            const node = box.current;
            if (!bounds || !node) return;
            const rect = node.getBoundingClientRect();
            // The display's pixels to this page's, which differ if the app is zoomed.
            const scale = window.innerWidth > 0 ? bounds.width / window.innerWidth : 1;
            const x = (point.x - bounds.x) / scale;
            const y = (point.y - bounds.y) / scale;
            const near = x >= rect.left - PEEK_PAD && x <= rect.right + PEEK_PAD && y <= rect.bottom + PEEK_PAD && y >= 0;
            if (near && !timer) {
                timer = setTimeout(() => setPeek(true), PEEK_AFTER);
            } else if (!near) {
                clearTimeout(timer);
                timer = 0;
                setPeek(false);
            }
        });
        return () => {
            off();
            clearTimeout(timer);
        };
    }, [cursor]);

    // The ears outside the box are drawn by the notch itself; what is inside
    // is clipped by a layer of its own, and measured at its natural height.
    return (
        <div
            ref={box}
            className={`buddy-notch ${closed ? 'buddy-notch-rest' : ''}`}
            data-phase={phase}
            data-picking={picking ? 'true' : 'false'}
            style={{ width, height: closed ? 26 : height }}
        >
            <div className="buddy-notch-clip">
                <div
                    ref={body}
                    key={closed ? 'rest' : picking ? 'agents' : `open:${phase}`}
                    className={`buddy-notch-body ${working ? 'buddy-notch-body-controls' : ''}`}
                >
                    {picking
                        ? <AgentPicker state={state} peek={peek} switched={switched} />
                        : <NotchBody state={state} peek={peek} download={download} heardHere={heardHere} />}
                </div>
            </div>
            {working && <WorkControls />}
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
 * main told when it has been. In this computer's voice, or ElevenLabs':
 * its audio comes on a channel of its own, by the say's id, as it streams,
 * and may come before the state that names it, so it waits a moment for
 * that. If ElevenLabs fails, or says nothing for a while, the same words
 * go in this computer's voice instead.
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
        if (say.engine === 'elevenlabs') {
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
                        player = player || createPcmPlayer(say.rate || 24000);
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

    // The voice's level is set on the root each frame (useDictation), so the
    // mark and the notch both read it.
    return (
        <div
            ref={meterRef}
            style={{ '--level': 0 }}
            className="buddy-root font-inter select-none pointer-events-none"
            lang={getLanguage()}
        >
            {hello.primary && state.notch && (
                <Notch state={state} cursor={cursor} download={dictation.download} heardHere={listener} />
            )}
            <Mark state={state} cursor={cursor} />
        </div>
    );
}
