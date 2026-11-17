import { useEffect, useRef } from 'react';
import { AGENT_AURAS as AURAS } from '../../lib/agent-look';

/**
 * What moves behind a large mark: a few dozen specks in the agent's colour,
 * drawn on a canvas under the helmet. Only behind the marks that are the
 * thing being looked at (Home, an empty conversation, the agent dialog), never
 * the small ones in rows and tabs, where it would be noise.
 *
 * The effects:
 * - `embers`: sparks rising off the helmet, swaying and flickering out.
 * - `stars`: a slow-turning field of points around it, twinkling, and now and
 *   then one crossing behind it.
 * - `orbit`: a tilted ring of dust going round it, brighter on the near side.
 * - `drift`: motes falling slowly past it, like ash or snow.
 *
 * The canvas is wider than the mark and reaches mostly above it, so nothing
 * falls across the text under a mark; every speck fades out towards the edge
 * of an ellipse inside it, so none is ever cut off by its border. Sized in
 * multiples of the mark, so the same effect reads the same at any size.
 *
 * Cheap: at most sixty frames a second, nothing while it is off screen, and
 * one still frame when reduced motion is asked for. The colour is the
 * canvas's own CSS colour (`.agent-aura`), set per theme by AgentMark.
 */

/** The canvas around the mark, in marks: how wide, how tall, and how far it reaches below. */
const FRAME = {
    full: { width: 3.4, height: 2.7, below: 0.12 },
    // For a mark with little room around it, the agent dialog's, whose
    // content scrolls and so clips: no further out than its padding.
    compact: { width: 2.6, height: 1.7, below: 0.12 },
};

const FPS = 60;
/** How long a moving effect is run before its first frame, so it starts full rather than empty. */
const WARM = 6;

/** A repeatable random sequence, so the stars stay where they were put. */
function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const smooth = (edge0, edge1, x) => {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};

/**
 * One effect, as something that can be stepped and drawn. `s` is the mark's
 * size, and `cx`, `cy` the middle of the helmet, in the canvas's pixels.
 */
function makeEffect(kind, { s, cx, cy, width }) {
    const random = seeded(kind.length * 7919 + Math.round(s));

    if (kind === 'embers') {
        const list = [];
        const rate = 22 * (s / 72);
        let owed = 0;
        return {
            step(dt) {
                owed += rate * dt;
                while (owed >= 1 && list.length < 70) {
                    owed -= 1;
                    list.push({
                        x: cx + (random() - 0.5) * 0.9 * s,
                        y: cy + random() * 0.25 * s,
                        vx: (random() - 0.5) * 0.1 * s,
                        vy: -(0.3 + random() * 0.35) * s,
                        age: 0,
                        life: 1.6 + random() * 1.4,
                        r: (0.014 + random() * 0.024) * s,
                        phase: random() * Math.PI * 2,
                        sway: (0.03 + random() * 0.05) * s,
                        pace: 1.5 + random() * 2,
                    });
                }
                for (let i = list.length - 1; i >= 0; i -= 1) {
                    const e = list[i];
                    e.age += dt;
                    if (e.age >= e.life) { list.splice(i, 1); continue; }
                    e.vy *= 1 - 0.15 * dt;
                    e.x += e.vx * dt;
                    e.y += e.vy * dt;
                }
            },
            draw(dot) {
                for (const e of list) {
                    const k = e.age / e.life;
                    const flicker = 0.65 + 0.35 * Math.sin(e.age * 18 + e.phase * 3);
                    const alpha = 0.95 * smooth(0, 0.12, k) * (1 - smooth(0.55, 1, k)) * flicker;
                    dot(e.x + Math.sin(e.age * e.pace + e.phase) * e.sway, e.y, e.r * (1 - 0.5 * k), alpha, true);
                }
            },
        };
    }

    if (kind === 'stars') {
        const middle = { x: cx, y: cy - 0.15 * s };
        const stars = [];
        while (stars.length < 28) {
            const angle = random() * Math.PI * 2;
            const reach = (0.62 + random() * 0.88) * s;
            if (middle.y + Math.sin(angle) * reach * 0.85 > cy + 0.45 * s) continue;
            const bright = stars.length < 5;
            stars.push({
                angle,
                reach,
                r: bright ? (0.05 + random() * 0.02) * s : (0.008 + random() * 0.009) * s,
                bright,
                pace: 0.6 + random() * 1.2,
                phase: random() * Math.PI * 2,
                base: bright ? 0.9 : 0.45 + random() * 0.45,
            });
        }
        let t = 0;
        let shot = null;
        let nextShot = 2 + random() * 4;
        return {
            step(dt) {
                t += dt;
                nextShot -= dt;
                if (!shot && nextShot <= 0) {
                    const heading = 0.35 + random() * 0.25;
                    shot = {
                        x: cx - (0.9 + random() * 0.6) * s,
                        y: cy - (0.9 + random() * 0.5) * s,
                        dx: Math.cos(heading) * 1.9 * s,
                        dy: Math.sin(heading) * 1.9 * s,
                        age: 0,
                        life: 0.75,
                    };
                    nextShot = 5 + random() * 4;
                }
                if (shot) {
                    shot.age += dt;
                    if (shot.age >= shot.life) shot = null;
                }
            },
            draw(dot, sparkle, streak) {
                const turn = t * 0.025;
                for (const star of stars) {
                    const x = middle.x + Math.cos(star.angle + turn) * star.reach;
                    const y = middle.y + Math.sin(star.angle + turn) * star.reach * 0.85;
                    const twinkle = 0.5 + 0.5 * Math.sin(t * star.pace + star.phase);
                    const alpha = star.base * (0.25 + 0.75 * twinkle * twinkle);
                    if (star.bright) sparkle(x, y, star.r * (0.7 + 0.3 * twinkle), alpha);
                    else dot(x, y, star.r, alpha, false);
                }
                if (shot) {
                    const k = shot.age / shot.life;
                    const x = shot.x + shot.dx * shot.age;
                    const y = shot.y + shot.dy * shot.age;
                    streak(x, y, shot.dx, shot.dy, 0.35 * s, Math.sin(k * Math.PI) * 0.85);
                }
            },
        };
    }

    if (kind === 'orbit') {
        const dust = Array.from({ length: 72 }, (_, i) => ({
            angle: (i / 72) * Math.PI * 2 + random() * 0.08,
            pace: 0.38 + (random() - 0.5) * 0.04,
            reach: (1.05 + (random() - 0.5) * 0.14) * s,
            lift: (random() - 0.5) * 0.04 * s,
            r: 0.6 + random() * 0.8,
        }));
        const tilt = -0.2;
        const centre = { x: cx, y: cy + 0.08 * s };
        return {
            step(dt) {
                for (const d of dust) d.angle += d.pace * dt;
            },
            draw(dot) {
                for (const d of dust) {
                    const ex = Math.cos(d.angle) * d.reach;
                    const ey = Math.sin(d.angle) * d.reach * 0.26 + d.lift;
                    const x = centre.x + ex * Math.cos(tilt) - ey * Math.sin(tilt);
                    const y = centre.y + ex * Math.sin(tilt) + ey * Math.cos(tilt);
                    // The near side, the lower half of the ellipse, brighter and bigger.
                    const near = 0.5 + 0.5 * Math.sin(d.angle);
                    dot(x, y, (0.01 + 0.012 * near) * s * d.r, 0.2 + 0.65 * near, false);
                }
            },
        };
    }

    if (kind === 'drift') {
        const list = [];
        const rate = 6 * (s / 72);
        let owed = 0;
        const floor = cy + 0.35 * s;
        return {
            step(dt) {
                owed += rate * dt;
                while (owed >= 1 && list.length < 60) {
                    owed -= 1;
                    list.push({
                        x: cx + (random() - 0.5) * width * 0.65,
                        y: cy - (1.5 + random() * 0.2) * s,
                        vy: (0.14 + random() * 0.12) * s,
                        r: (0.01 + random() * 0.018) * s,
                        sway: (0.03 + random() * 0.05) * s,
                        pace: 0.6 + random() * 0.6,
                        phase: random() * Math.PI * 2,
                        base: 0.3 + random() * 0.3,
                        age: 0,
                    });
                }
                for (let i = list.length - 1; i >= 0; i -= 1) {
                    const m = list[i];
                    m.age += dt;
                    m.y += m.vy * dt;
                    if (m.y > floor) list.splice(i, 1);
                }
            },
            draw(dot) {
                for (const m of list) {
                    const alpha = m.base * smooth(0, 0.8, m.age) * (1 - smooth(cy - 0.1 * s, floor, m.y));
                    dot(m.x + Math.sin(m.age * m.pace + m.phase) * m.sway, m.y, m.r, alpha, false);
                }
            },
        };
    }

    return null;
}

export default function AgentAura({ kind, size, compact = false, tint = '' }) {
    const canvasRef = useRef(null);
    const frame = FRAME[compact ? 'compact' : 'full'];
    const width = size * frame.width;
    const height = size * frame.height;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !AURAS.includes(kind) || kind === 'none') return undefined;
        const context = canvas.getContext('2d');
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));

        // The helmet's middle, in the canvas: the mark's box sits at the
        // canvas's foot, `below` of a mark up from it.
        const cx = width / 2;
        const cy = height - frame.below * size - size / 2;
        const effect = makeEffect(kind, { s: size, cx, cy, width });
        if (!effect) return undefined;

        let colour = getComputedStyle(canvas).color;
        let dark = document.documentElement.classList.contains('dark');

        /** How much of a speck at `x`, `y` shows: all of it in the middle, none at the edge of the ellipse. */
        const fade = (x, y) => {
            const u = (x - width / 2) / (width / 2);
            const v = (y - height / 2) / (height / 2);
            return 1 - smooth(0.55, 1, u * u + v * v);
        };

        const dot = (x, y, r, alpha, glow) => {
            const a = alpha * fade(x, y);
            if (a <= 0.01 || r <= 0) return;
            context.globalAlpha = a;
            context.beginPath();
            context.arc(x, y, r, 0, Math.PI * 2);
            context.fill();
            // A faint halo round a spark, in a dark window only: on white
            // it reads as a smudge.
            if (glow && dark) {
                context.globalAlpha = a * 0.14;
                context.beginPath();
                context.arc(x, y, r * 3, 0, Math.PI * 2);
                context.fill();
            }
        };

        // A four-pointed star: two thin crossed strokes and a point in the middle.
        const sparkle = (x, y, r, alpha) => {
            const a = alpha * fade(x, y);
            if (a <= 0.01) return;
            context.globalAlpha = a;
            context.lineWidth = Math.max(0.6, r * 0.12);
            context.beginPath();
            context.moveTo(x - r, y);
            context.lineTo(x + r, y);
            context.moveTo(x, y - r);
            context.lineTo(x, y + r);
            context.stroke();
            context.beginPath();
            context.arc(x, y, Math.max(0.7, r * 0.16), 0, Math.PI * 2);
            context.fill();
        };

        // A line fading out behind a moving point.
        const streak = (x, y, dx, dy, length, alpha) => {
            const a = alpha * fade(x, y);
            if (a <= 0.01) return;
            const n = Math.hypot(dx, dy) || 1;
            const tailX = x - (dx / n) * length;
            const tailY = y - (dy / n) * length;
            const gradient = context.createLinearGradient(x, y, tailX, tailY);
            gradient.addColorStop(0, colour);
            gradient.addColorStop(1, 'transparent');
            context.globalAlpha = a;
            context.strokeStyle = gradient;
            context.lineWidth = Math.max(0.8, size * 0.012);
            context.beginPath();
            context.moveTo(x, y);
            context.lineTo(tailX, tailY);
            context.stroke();
            context.strokeStyle = colour;
        };

        const draw = () => {
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            context.clearRect(0, 0, width, height);
            context.fillStyle = colour;
            context.strokeStyle = colour;
            effect.draw(dot, sparkle, streak);
            context.globalAlpha = 1;
        };

        // Run ahead before the first frame, so sparks are already rising and
        // motes already falling rather than starting from nothing.
        for (let t = 0; t < WARM; t += 1 / 30) effect.step(1 / 30);
        draw();
        if (still) return undefined;

        let raf = 0;
        let last = performance.now();
        let shown = 0;
        let onScreen = true;
        let alive = true;

        const tick = (now) => {
            raf = 0;
            if (!alive || !onScreen) return;
            raf = requestAnimationFrame(tick);
            if (now - shown < 1000 / FPS - 2) return;
            shown = now;
            effect.step(Math.min(0.1, (now - last) / 1000));
            last = now;
            draw();
        };

        const visibility = new IntersectionObserver(([entry]) => {
            onScreen = entry.isIntersecting;
            if (onScreen && !raf) {
                last = performance.now();
                raf = requestAnimationFrame(tick);
            }
        });
        visibility.observe(canvas);

        // The theme, and the app's own colours, which change the ink.
        const theme = new MutationObserver(() => {
            colour = getComputedStyle(canvas).color;
            dark = document.documentElement.classList.contains('dark');
        });
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

        raf = requestAnimationFrame(tick);
        return () => {
            alive = false;
            cancelAnimationFrame(raf);
            visibility.disconnect();
            theme.disconnect();
        };
        // `tint` is here for the colour, read from CSS, which changes with the agent's.
    }, [kind, size, width, height, frame.below, tint]);

    if (!AURAS.includes(kind) || kind === 'none') return null;
    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            className="agent-aura"
            style={{
                width,
                height,
                left: (size - width) / 2,
                top: size + frame.below * size - height,
            }}
        />
    );
}
