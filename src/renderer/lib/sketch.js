/**
 * The buddy's drawings, as a hand would make them (BuddyOverlay.jsx draws
 * them): a loop around a thing, a box over a region, an arrow to a thing, a
 * line under some words. Each is a little off true, the way a pen is, and
 * the same every time for the same shape, since its wobble is seeded by the
 * shape itself. Out come SVG path data and where the label goes, in the
 * overlay window's own pixels.
 */

/** A small seeded generator (mulberry32): the same numbers for the same seed. */
export function seeded(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A seed from a shape's numbers. */
export function seedOf(...numbers) {
    let hash = 2166136261;
    for (const number of numbers) {
        hash ^= Math.round(Number(number) || 0) & 0xffff;
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

const tenth = value => Math.round(value * 10) / 10;

/** A smooth path through the points, as cubic curves (Catmull-Rom). */
export function smooth(points) {
    if (points.length < 2) return '';
    let d = `M${tenth(points[0][0])} ${tenth(points[0][1])}`;
    for (let i = 0; i < points.length - 1; i += 1) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C${tenth(c1[0])} ${tenth(c1[1])} ${tenth(c2[0])} ${tenth(c2[1])} ${tenth(p2[0])} ${tenth(p2[1])}`;
    }
    return d;
}

/** How far out from the thing a loop or a box is drawn, so it surrounds it rather than crossing it. */
const PAD = 6;

/**
 * A loop around a point: a little more than once round, starting at the top
 * left and ending just outside where it began, a touch oval and tilted.
 */
export function loop({ x, y, r }) {
    const rand = seeded(seedOf(1, x, y, r));
    const radius = Math.max(8, r) + PAD;
    const start = -2.5 + rand() * 0.5;
    const sweep = Math.PI * 2 * (1.07 + rand() * 0.06);
    const squash = 0.94 + rand() * 0.08;
    const tilt = (rand() - 0.5) * 0.35;
    const steps = 32;
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const angle = start + sweep * t;
        const grow = 1 + 0.08 * t;
        const wobble = 1 + (rand() - 0.5) * 0.03;
        const px = Math.cos(angle) * radius * grow * wobble;
        const py = Math.sin(angle) * radius * squash * grow * wobble;
        points.push([
            x + px * Math.cos(tilt) - py * Math.sin(tilt),
            y + px * Math.sin(tilt) + py * Math.cos(tilt),
        ]);
    }
    return { paths: [smooth(points)], label: { x: x + radius * 1.12 + 6, y: y - radius * 0.7, align: 'left' } };
}

/**
 * A box over a region: four sides each a little bowed, corners a little
 * round, the pen going on past where it started.
 */
export function frame({ x, y, w, h }) {
    const rand = seeded(seedOf(2, x, y, w, h));
    const jitter = () => (rand() - 0.5) * 3;
    const left = x - PAD;
    const top = y - PAD;
    const right = x + w + PAD;
    const bottom = y + h + PAD;
    const width = right - left;
    const height = bottom - top;
    const bow = () => (rand() - 0.5) * Math.min(6, Math.max(2, Math.min(width, height) * 0.04));
    const points = [
        [left + width * 0.12 + jitter(), top + jitter()],
        [left + width * 0.55, top + bow()],
        [right + jitter(), top + jitter()],
        [right + bow(), top + height * 0.5],
        [right + jitter(), bottom + jitter()],
        [left + width * 0.5, bottom + bow()],
        [left + jitter(), bottom + jitter()],
        [left + bow(), top + height * 0.5],
        [left + jitter(), top + jitter()],
        [left + width * 0.22 + jitter(), top - 1.5 + jitter()],
    ];
    // Clear of the top edge of the screen, the label sits above the box; else just inside it.
    const above = top > 34;
    return {
        paths: [smooth(points)],
        fill: { x: left, y: top, width, height },
        label: { x: left, y: above ? top - 30 : top + 8, align: 'left' },
    };
}

/**
 * An arrow from a tail to a tip: a shaft with a slight bow, stopping just
 * short of the thing so it points at it rather than covering it, and a head
 * of two strokes along the shaft's last heading.
 */
export function arrow({ x1, y1, x2, y2 }) {
    const rand = seeded(seedOf(3, x1, y1, x2, y2));
    const length = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / length;
    const uy = (y2 - y1) / length;
    // The tip stops a little short, the tail a little out.
    const gap = Math.min(10, length * 0.12);
    const tip = [x2 - ux * gap, y2 - uy * gap];
    const tail = [x1, y1];
    const side = rand() < 0.5 ? -1 : 1;
    const bend = side * length * (0.06 + rand() * 0.06);
    const mid = [(tail[0] + tip[0]) / 2 - uy * bend, (tail[1] + tip[1]) / 2 + ux * bend];
    const steps = 10;
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        const u = 1 - t;
        const wobble = i === 0 || i === steps ? 0 : (rand() - 0.5) * 1.2;
        points.push([
            u * u * tail[0] + 2 * u * t * mid[0] + t * t * tip[0] - uy * wobble,
            u * u * tail[1] + 2 * u * t * mid[1] + t * t * tip[1] + ux * wobble,
        ]);
    }
    // The heading the shaft arrives at the tip with.
    const hx = tip[0] - mid[0];
    const hy = tip[1] - mid[1];
    const heading = Math.atan2(hy, hx);
    const barb = Math.max(10, Math.min(18, length * 0.18));
    const spread = 0.5 + rand() * 0.08;
    const back = angle => [tip[0] - Math.cos(heading + angle) * barb, tip[1] - Math.sin(heading + angle) * barb];
    const one = back(spread);
    const two = back(-spread);
    const head = `M${tenth(one[0])} ${tenth(one[1])} L${tenth(tip[0])} ${tenth(tip[1])} L${tenth(two[0])} ${tenth(two[1])}`;
    // The label at the tail, a little behind it, centred on the line.
    return {
        paths: [smooth(points)],
        head,
        label: { x: x1 - ux * 16, y: y1 - uy * 16, align: 'centre' },
    };
}

/**
 * A line under some words: a little wavy, a little past each end, just under
 * the baseline. Its label goes after the words, not under them, where it
 * would cover the next line.
 */
export function underline({ x, y, w }) {
    const rand = seeded(seedOf(4, x, y, w));
    const steps = Math.max(4, Math.min(10, Math.round(w / 40)));
    const slope = (rand() - 0.5) * Math.min(4, w * 0.02);
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        points.push([x - 3 + (w + 6) * t, y + 4 + slope * t + (rand() - 0.5) * 2]);
    }
    return { paths: [smooth(points)], label: { x: x + w + 12, y: y - 17, align: 'left' } };
}

/** A shape as it is drawn: its path(s), its head or fill if it has one, and where its label goes. */
export function sketchOf(shape) {
    switch (shape?.kind) {
        case 'circle':
            return loop(shape);
        case 'highlight':
            return frame(shape);
        case 'arrow':
            return arrow(shape);
        case 'underline':
            return underline(shape);
        default:
            return null;
    }
}

/** The point a shape is drawn about, to tell which display it is on. */
export function centreOf(shape) {
    switch (shape?.kind) {
        case 'circle':
            return { x: shape.x, y: shape.y };
        case 'highlight':
            return { x: shape.x + shape.w / 2, y: shape.y + shape.h / 2 };
        case 'arrow':
            return { x: shape.x2, y: shape.y2 };
        case 'underline':
            return { x: shape.x + shape.w / 2, y: shape.y };
        default:
            return null;
    }
}

/** A shape moved by an offset: from the desktop's coordinates to a window's. */
export function moved(shape, dx, dy) {
    const out = { ...shape };
    for (const key of ['x', 'x1', 'x2']) if (key in out) out[key] -= dx;
    for (const key of ['y', 'y1', 'y2']) if (key in out) out[key] -= dy;
    return out;
}
