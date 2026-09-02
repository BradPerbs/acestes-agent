import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { agentColor, shade } from '../../lib/agent-colors';

/**
 * An agent's mark: a round face with two eyes in it.
 *
 * Inlined rather than loaded from a file for two reasons. The gradient needs
 * an id, and an id repeated across every copy on screen is one gradient that
 * several elements fight over, so it is generated per instance. And the eyes
 * have to be reachable by a stylesheet, which is where the character lives.
 *
 * The drawing keeps the 338 x 281 canvas the eyes were posed on, so the poses
 * in input.css, which are written in those units, go on working; the body is
 * a circle inside it. `color` is the id of one of the agent colours (see
 * `lib/agent-colors`), which is what tells one agent's mark from another's
 * everywhere it is drawn.
 *
 * `animated` is off by default and asked for where the mark is large and is
 * the thing being looked at. Everywhere else it is a small button icon, and
 * something drifting and blinking in the corner of a terminal window is not
 * charm, it is a distraction with a face on.
 *
 * `mono` is the same shape in `currentColor`, for when the mark is a control
 * rather than the subject: a button in a row of chrome that is one grey in
 * light mode and another in dark. The eyes are cut out rather than painted,
 * so they stay legible whatever the mark is tinted to and whatever it sits on.
 *
 * ## How it stays alive
 *
 * Two eyes is a small vocabulary, so what sells it is timing rather than
 * drawing. Expressions are picked at random and separated by uneven pauses,
 * because a face that cycles predictably reads as a loop within about twenty
 * seconds, and one that never rests reads as a nervous tic. The poses
 * themselves are in input.css; this only decides what happens when.
 *
 * On top of that it watches the pointer. Gaze is a translate on the group and
 * the expressions are transforms on each eye, so the two compose instead of
 * fighting: it can be mid-wink and still be looking at you.
 */

/** How far the pointer has to travel for the eyes to reach the end of their
 *  range, and how far that range goes, in the artwork's own units. */
const REACH_X = 300;
const REACH_Y = 220;
const GAZE_X = 14;
const GAZE_Y = 9;

/**
 * What it can do, and how often. Blinking dominates on purpose: it is the one
 * an eye does without meaning anything by it, and it is what makes the rest
 * land as deliberate when they come.
 */
const EXPRESSIONS = [
    { name: 'blink', weight: 38 },
    { name: 'look', weight: 17 },
    { name: 'curious', weight: 13 },
    { name: 'happy', weight: 12 },
    { name: 'wink', weight: 11 },
    { name: 'angry', weight: 9 },
];

const TOTAL = EXPRESSIONS.reduce((sum, expression) => sum + expression.weight, 0);

/**
 * The next expression, weighted, and not the one just played.
 *
 * Blink is exempt from that rule: two blinks in a row is something a face
 * actually does, while two winks in a row is a tic.
 */
function pickExpression(previous) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        let roll = Math.random() * TOTAL;
        const chosen = EXPRESSIONS.find((expression) => {
            roll -= expression.weight;
            return roll <= 0;
        }) || EXPRESSIONS[0];

        if (chosen.name !== previous || chosen.name === 'blink') return chosen.name;
    }
    return 'blink';
}

/** The rest between two expressions. Uneven, or it reads as a metronome. */
const restFor = () => 1100 + Math.random() * 3200;

/**
 * The body: a ball on the canvas the eyes were posed for, with the eyes in
 * its upper half, where a face carries them. The box is cut square around
 * it, so `size` is the ball's diameter rather than a canvas it sits in.
 */
const BODY = { cx: 176, cy: 200, r: 130 };
const VIEW = `${BODY.cx - BODY.r} ${BODY.cy - BODY.r} ${BODY.r * 2} ${BODY.r * 2}`;

export default function AgentMark({ size = 18, animated = false, mono = false, color = '', className = '' }) {
    // Colons are fine in an id but read badly in a `url(#...)`, so they go.
    const unique = useId().replace(/:/g, '');
    const gradient = `agent-fill-${unique}`;
    const holes = `agent-eyes-${unique}`;
    const palette = agentColor(color);

    const [expression, setExpression] = useState('');
    const timer = useRef(null);
    const running = useRef(false);
    const previous = useRef('');
    const eyes = useRef(null);

    function play() {
        previous.current = pickExpression(previous.current);
        setExpression(previous.current);
    }

    function queue() {
        clearTimeout(timer.current);
        timer.current = setTimeout(play, restFor());
    }

    /**
     * One expression has finished. The stylesheet owns how long each pose
     * takes, so the end of the animation is the signal rather than a duration
     * repeated here that would drift out of step with it the first time one is
     * retimed.
     */
    function rest() {
        setExpression('');
        if (running.current) queue();
    }

    useEffect(() => {
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        running.current = Boolean(animated) && !still;
        if (!running.current) return undefined;

        queue();
        return () => {
            running.current = false;
            clearTimeout(timer.current);
        };
        // `queue` is recreated every render and closes over nothing but refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [animated]);

    /**
     * Follow the pointer.
     *
     * Written straight to the node rather than held in state: this fires on
     * every mouse move, and a re-render per frame to move two rects a few
     * pixels is the kind of thing that makes a whole window feel heavy. The
     * easing is a CSS transition on the group, so the eyes arrive a beat after
     * the cursor does, which is the difference between watching something and
     * being welded to it.
     *
     * `tanh` rather than a clamp. The eyes slow as they approach the edge of
     * their travel and never hit a wall, so a pointer crossing the far side of
     * the screen still moves them, just barely.
     */
    useLayoutEffect(() => {
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (!animated || still) return undefined;

        let frame = 0;
        let point = null;

        const settle = () => {
            frame = 0;
            const node = eyes.current;
            if (!node || !point) return;

            const box = node.ownerSVGElement?.getBoundingClientRect();
            if (!box?.width) return;

            const x = Math.tanh((point.x - (box.left + box.width / 2)) / REACH_X) * GAZE_X;
            const y = Math.tanh((point.y - (box.top + box.height / 2)) / REACH_Y) * GAZE_Y;
            node.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
        };

        const onMove = (event) => {
            point = { x: event.clientX, y: event.clientY };
            if (!frame) frame = requestAnimationFrame(settle);
        };

        // Back to centre when the pointer leaves the window, rather than
        // staring at the corner it went out through.
        const onLeave = () => {
            point = null;
            if (eyes.current) eyes.current.style.transform = 'translate(0px, 0px)';
        };

        window.addEventListener('mousemove', onMove);
        document.addEventListener('mouseleave', onLeave);
        return () => {
            window.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseleave', onLeave);
            cancelAnimationFrame(frame);
        };
    }, [animated]);

    /**
     * The eyes, painted or cut out.
     *
     * One piece of markup either way: the classes and the ref the poses and the
     * gaze are driven through have to be on the same element in both, or the
     * mark would only be alive in one of its two colours.
     */
    const renderEyes = (fill) => (
        <g
            ref={eyes}
            className={`agent-eyes ${animated ? 'is-tracking' : ''} ${expression ? `is-${expression}` : ''}`}
        >
            {/* The left eye carries the handler. Every expression moves it,
                so it is the one that can be trusted to report the end. */}
            <rect
                className="agent-eye agent-eye-left"
                x="113"
                y="120"
                width="46"
                height="90"
                rx="23"
                fill={fill}
                onAnimationEnd={rest}
            />
            <rect
                className="agent-eye agent-eye-right"
                x="193"
                y="120"
                width="46"
                height="90"
                rx="23"
                fill={fill}
            />
        </g>
    );

    return (
        <svg
            width={size}
            height={size}
            viewBox={VIEW}
            fill="none"
            aria-hidden="true"
            focusable="false"
            className={`${animated ? 'agent-float' : ''} ${className}`}
        >
            {/* Black is a hole, white is kept, so the eyes are subtracted from
                the body and whatever the mark is sitting on shows through
                them: the hover wash on the button, the shell behind it. */}
            {mono && (
                <mask id={holes} maskUnits="userSpaceOnUse" x={BODY.cx - BODY.r} y={BODY.cy - BODY.r} width={BODY.r * 2} height={BODY.r * 2}>
                    <circle cx={BODY.cx} cy={BODY.cy} r={BODY.r} fill="#fff" />
                    {renderEyes('#000')}
                </mask>
            )}

            <circle
                opacity={mono ? 0.8 : 1}
                cx={BODY.cx}
                cy={BODY.cy}
                r={BODY.r}
                fill={mono ? 'currentColor' : `url(#${gradient})`}
                mask={mono ? `url(#${holes})` : undefined}
            />

            {/* The light: a soft catch above and to the left of the eyes,
                which is what turns a disc into a ball. */}
            {!mono && (
                <ellipse
                    cx={BODY.cx - BODY.r * 0.32}
                    cy={BODY.cy - BODY.r * 0.6}
                    rx={BODY.r * 0.3}
                    ry={BODY.r * 0.17}
                    fill="#fff"
                    opacity="0.28"
                    transform={`rotate(-25 ${BODY.cx - BODY.r * 0.32} ${BODY.cy - BODY.r * 0.6})`}
                />
            )}

            {!mono && renderEyes('#FFFFFF')}

            {!mono && (
                <defs>
                    {/* Lit from the upper left: pale there, the colour itself
                        through the middle, and its own shadow at the far edge. */}
                    <radialGradient id={gradient} cx="0.35" cy="0.3" r="0.8">
                        <stop stopColor={shade(palette.from, 0.35)} />
                        <stop offset="0.45" stopColor={palette.from} />
                        <stop offset="1" stopColor={shade(palette.to, -0.3)} />
                    </radialGradient>
                </defs>
            )}
        </svg>
    );
}
