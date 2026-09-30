import { useEffect, useMemo, useRef, useState } from 'react';
import { agentInk } from '../../lib/agent-colors';
import { agentLook } from '../../lib/agent-look';
import { REST, drawHelmet, framing, helmetMask, whenHelmetReady } from './helmet/renderer';

/**
 * An agent's mark: a helmet in ink, turned three quarters on. A Corinthian
 * unless the agent picked another.
 *
 * Acestes was a king in the Aeneid, so the face is a warrior's. It is drawn
 * from a real model (see `helmet/renderer.js`, and `scripts/helmets` for
 * where the models come from), live, so it can be turned. `look` is which
 * helmet it is, which crest it wears and in which of the agent colours; it
 * takes an agent, a `{ color, helmet, crest }` or a bare colour id.
 *
 * Two ways of showing it:
 *
 * - Still, which is almost every mark on screen: tab icons, list rows, the
 *   switcher. The helmet is drawn once per size into a mask image and the
 *   colour is the element's own, from CSS, so it follows the theme and the
 *   text around it without being drawn again, and a row of tabs shares one
 *   picture.
 * - `animated`, where the mark is large and is the thing being looked at:
 *   it turns to look at the pointer, a beat behind it (straight at you when
 *   the pointer is over it, to either side as it moves off), and sways a
 *   little on its own, so it looks alive rather than printed. With no
 *   pointer in the window it rests three quarters on, like a still mark.
 *   Drawn every frame while it is on screen; it is cheap, a fraction of a
 *   millisecond.
 *
 * `mono` is the same helmet in the surrounding text colour, for when the
 * mark is a control rather than the subject.
 *
 * Where there is no WebGL2 to draw with, it falls back to one drawing of the
 * helmet in its resting pose (`helmet/still.js`), and does not turn.
 */

/** Per helmet: whether it can be drawn, once its mesh has loaded. */
const ready = new Map();
// The Corinthian is the one almost every mark wears, so it starts loading at once.
whenHelmetReady().then((ok) => { ready.set('corinthian', ok); });

/** Whether `helmet` can be drawn: null while it loads, then true or false. */
function useHelmetReady(helmet) {
    const known = ready.has(helmet) ? ready.get(helmet) : null;
    const [state, setState] = useState({ helmet, ok: known });
    useEffect(() => {
        if (ready.has(helmet)) {
            setState({ helmet, ok: ready.get(helmet) });
            return undefined;
        }
        let current = true;
        setState({ helmet, ok: null });
        whenHelmetReady(helmet).then((ok) => {
            ready.set(helmet, ok);
            if (current) setState({ helmet, ok });
        });
        return () => { current = false; };
    }, [helmet]);
    // the state is a render behind when the helmet changes; what is known now wins
    return state.helmet === helmet ? state.ok : known;
}

/** The device pixel ratio, kept up to date when the window moves to another screen. */
function usePixelRatio() {
    const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1);
    useEffect(() => {
        let query = null;
        const listen = () => {
            query?.removeEventListener('change', update);
            query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
            query.addEventListener('change', update);
        };
        function update() {
            setRatio(window.devicePixelRatio || 1);
            listen();
        }
        listen();
        return () => query?.removeEventListener('change', update);
    }, []);
    return ratio;
}

const stillMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/* ---- The pointer, shared by every mark that follows it -------------------- */

const pointer = { x: 0, y: 0, inside: false };
let following = 0;
const onPointerMove = (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.inside = true;
};
const onPointerLeave = () => { pointer.inside = false; };

function followPointer() {
    if (following++ === 0) {
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        document.documentElement.addEventListener('pointerleave', onPointerLeave);
        window.addEventListener('blur', onPointerLeave);
    }
    return () => {
        if (--following > 0) return;
        window.removeEventListener('pointermove', onPointerMove);
        document.documentElement.removeEventListener('pointerleave', onPointerLeave);
        window.removeEventListener('blur', onPointerLeave);
    };
}

/* ---- The theme, which the live marks have to hear about ------------------- */

const themeListeners = new Set();
let themeObserver = null;

/**
 * Called when the theme changes: the class on the root that turns dark mode
 * on, or the custom palette written into its style. A still mark's colour
 * comes from CSS and needs none of this; a live one paints its colour into a
 * canvas and has to be told.
 */
function onThemeChange(listener) {
    themeListeners.add(listener);
    if (!themeObserver) {
        themeObserver = new MutationObserver(() => { for (const fn of themeListeners) fn(); });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    return () => themeListeners.delete(listener);
}

/* ---- How a live mark moves -------------------------------------------------- */

/**
 * How it looks at the pointer: the face turned up to `yaw` degrees either
 * side, and tilted `pitch` either way about `level`, reaching most of that
 * once the pointer is `reachX` or `reachY` pixels off.
 */
const LOOK = { yaw: 60, pitch: 12, level: 8, reachX: 420, reachY: 320 };
/** The drift it has of its own, in degrees. */
const SWAY = { yaw: 2.5, pitch: 1.2 };
/** How long it takes to catch up with where it is looking, in seconds. */
const LAG = 0.25;
/** Every angle a live mark can reach, sampled, which its frame is sized to hold. */
const RANGE = (() => {
    const angles = [[REST.yaw, REST.pitch]];
    const yaw = LOOK.yaw + SWAY.yaw;
    const low = LOOK.level - LOOK.pitch - SWAY.pitch;
    const high = LOOK.level + LOOK.pitch + SWAY.pitch;
    for (let y = -yaw; y <= yaw + 0.01; y += yaw / 5) {
        for (let p = low; p <= high + 0.01; p += (high - low) / 3) {
            angles.push([Math.round(y * 10) / 10, Math.round(p * 10) / 10]);
        }
    }
    return angles;
})();

function LiveMark({ size, helmet, crest, paper, ratio, tint, wrapperProps }) {
    const wrapper = useRef(null);
    const canvas = useRef(null);
    // A canvas bigger than the mark, so the helmet can turn without running
    // off it, placed so that at rest it sits exactly where a still one would.
    const place = useMemo(() => framing(helmet, crest, RANGE), [helmet, crest]);
    const canvasSize = size * place.grow;
    const pixels = Math.max(1, Math.round(canvasSize * ratio));

    useEffect(() => {
        const node = canvas.current;
        if (!node) return undefined;
        let colour = getComputedStyle(wrapper.current).color;
        let yaw = REST.yaw, pitch = REST.pitch;
        let last = performance.now();
        let frame = 0;
        let onScreen = true;
        // A frame can still come once the mark is gone: React lets go of the
        // element before it runs this effect's cleanup, and an observer's
        // report can arrive after it is disconnected. That frame does nothing.
        let alive = true;

        const tick = (now) => {
            frame = 0;
            if (!alive || !onScreen || !wrapper.current) return;
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            let targetYaw = REST.yaw, targetPitch = REST.pitch;
            if (pointer.inside) {
                const box = wrapper.current.getBoundingClientRect();
                targetYaw = LOOK.yaw * Math.tanh((pointer.x - (box.left + box.width / 2)) / LOOK.reachX);
                targetPitch = LOOK.level + LOOK.pitch * Math.tanh((pointer.y - (box.top + box.height / 2)) / LOOK.reachY);
            }
            const t = now / 1000;
            targetYaw += SWAY.yaw * Math.sin(t * 0.8);
            targetPitch += SWAY.pitch * Math.sin(t * 0.63 + 1.3);
            const k = 1 - Math.exp(-dt / LAG);
            yaw += (targetYaw - yaw) * k;
            pitch += (targetPitch - pitch) * k;
            drawHelmet(node, { helmet, crest, size, canvasSize, yaw, pitch, range: RANGE, line: colour, paper });
            frame = requestAnimationFrame(tick);
        };

        // Only while it can be seen: a mark in a tab that is not showing
        // has no reason to spend a frame.
        const visibility = new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting;
            if (onScreen && !frame) {
                last = performance.now();
                frame = requestAnimationFrame(tick);
            }
        });
        visibility.observe(node);
        const stopFollowing = followPointer();
        const stopTheme = onThemeChange(() => { if (wrapper.current) colour = getComputedStyle(wrapper.current).color; });
        frame = requestAnimationFrame(tick);
        return () => {
            alive = false;
            cancelAnimationFrame(frame);
            visibility.disconnect();
            stopFollowing();
            stopTheme();
        };
        // `tint` is here for the colour: it is read from the element's style,
        // which changes when the agent's colour does as well as the theme.
    }, [helmet, crest, size, canvasSize, paper, pixels, tint]);

    return (
        <span ref={wrapper} {...wrapperProps}>
            <canvas
                ref={canvas}
                width={pixels}
                height={pixels}
                className="agent-mark-canvas"
                style={{
                    width: canvasSize,
                    height: canvasSize,
                    left: (size - canvasSize) / 2 + place.dx * size,
                    top: (size - canvasSize) / 2 + place.dy * size,
                }}
            />
        </span>
    );
}

function StillMark({ size, helmet, crest, paper, pixels, wrapperProps }) {
    const [ink, ground] = useMemo(() => [
        helmetMask({ helmet, crest, size, pixels, layer: 'ink' }),
        paper ? helmetMask({ helmet, crest, size, pixels, layer: 'paper' }) : null,
    ], [helmet, crest, size, pixels, paper]);
    const layer = (url) => ({ WebkitMaskImage: `url(${url})`, maskImage: `url(${url})` });

    return (
        <span {...wrapperProps}>
            {ground && <span className="agent-mark-layer" style={{ ...layer(ground), backgroundColor: paper }} />}
            {ink && <span className="agent-mark-layer agent-mark-lines" style={layer(ink)} />}
        </span>
    );
}

/** The one drawing, for where the helmet cannot be drawn live. */
function DrawnMark({ helmet, crest, paper, wrapperProps }) {
    const [drawing, setDrawing] = useState(null);
    useEffect(() => {
        let current = true;
        import('./helmet/still').then(({ default: still }) => {
            const drawings = still[helmet] || still.corinthian;
            if (current) setDrawing(drawings[crest] || drawings.none || drawings.plume);
        });
        return () => { current = false; };
    }, [helmet, crest]);

    return (
        <span {...wrapperProps}>
            {drawing && (
                <svg viewBox="0 0 240 240" width="100%" height="100%" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
                    {paper && <path d={drawing.outline} fill={paper} stroke="none" />}
                    <path d={drawing.inside} fill="currentColor" stroke="none" />
                    {drawing.lines.map((d, index) => <path key={index} d={d} strokeWidth="0.8" vectorEffect="non-scaling-stroke" />)}
                    <path d={drawing.outline} strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
                </svg>
            )}
        </span>
    );
}

export default function AgentMark({ size = 18, animated = false, mono = false, look = null, className = '' }) {
    const { color, helmet, crest } = agentLook(look);
    const ink = agentInk(color);
    const paper = mono ? null : ink.paper;
    const canDraw = useHelmetReady(helmet);
    const ratio = usePixelRatio();
    const pixels = Math.max(1, Math.round(size * ratio));
    const live = animated && !stillMotion();

    const wrapperProps = {
        'aria-hidden': 'true',
        className: `agent-mark ${mono ? '' : 'agent-mark-ink'} ${animated ? 'agent-float' : ''} ${className}`,
        style: {
            width: size,
            height: size,
            ...(mono ? null : { '--agent-ink': ink.line, '--agent-ink-dark': ink.lineDark }),
        },
    };

    // While the model loads, an empty box of the right size, so nothing moves when it arrives.
    if (canDraw === null) return <span {...wrapperProps} />;
    if (canDraw === false) return <DrawnMark helmet={helmet} crest={crest} paper={paper} wrapperProps={wrapperProps} />;
    if (live) return <LiveMark size={size} helmet={helmet} crest={crest} paper={paper} ratio={ratio} tint={mono ? 'mono' : `${ink.line}/${ink.lineDark}`} wrapperProps={wrapperProps} />;
    return <StillMark size={size} helmet={helmet} crest={crest} paper={paper} pixels={pixels} wrapperProps={wrapperProps} />;
}
