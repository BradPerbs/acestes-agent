import { useEffect, useRef } from 'react';

/**
 * The field of characters behind Home's composer: a low band of cipher text
 * that rises and falls like a skyline, densest along the foot of the box and
 * thinning out to the sides and the top. The characters turn over slowly, a
 * few at a time, so it reads as something quietly working rather than as
 * motion to watch.
 *
 * A canvas over the whole page, behind the content, drawn around the card
 * named by `cardRef` and never under it: the card is see-through, and text
 * showing through the box being typed in would be noise in the one place
 * that has to stay clear. Ink is the canvas's own CSS colour, so the theme
 * and the app's colours carry through without a prop.
 *
 * Cheap on purpose: a dozen frames a second, a few thousand cells, and
 * nothing at all while Home is behind another tab or the window is hidden.
 * With reduced motion asked for, one still frame.
 */

const CELL_W = 7;
const CELL_H = 13;
const FONT_PX = 10;
const FPS = 12;

/** From faint to dense. The odd glyph past the end is the cipher showing through. */
const RAMP = ['.', ':', '-', '=', '+', '*', 'x', 'X'];
const GLYPHS = '0123456789ABCDEF#%$&';

/** How far the band reaches above and below the card, in pixels. */
const ABOVE = 26;
const BELOW = 44;
/** Kept clear around the card, so no character touches its edge. */
const CLEAR = 6;

/** A repeatable 0..1 from three integers. */
function hash(x, y, s) {
    let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** How much of the band is lit at `u` (-1..1 across it) at time `t`, from the bottom. */
function skyline(u, t) {
    return 0.55
        + 0.2 * Math.sin(u * 2.3 + t * 0.35)
        + 0.12 * Math.sin(u * 6.1 - t * 0.55)
        + 0.06 * Math.sin(u * 13.7 + t * 0.9);
}

export default function CipherField({ cardRef, active = true, className = '' }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return undefined;
        const context = canvas.getContext('2d');
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

        let size = { width: 0, height: 0, ratio: 1 };
        let card = null;
        let frame = 0;
        let last = 0;
        const born = performance.now();

        const measure = () => {
            const box = canvas.getBoundingClientRect();
            const ratio = window.devicePixelRatio || 1;
            if (box.width !== size.width || box.height !== size.height || ratio !== size.ratio) {
                size = { width: box.width, height: box.height, ratio };
                canvas.width = Math.round(box.width * ratio);
                canvas.height = Math.round(box.height * ratio);
            }
            const target = cardRef?.current?.getBoundingClientRect();
            card = target && target.width > 0
                ? {
                    left: target.left - box.left,
                    right: target.right - box.left,
                    top: target.top - box.top,
                    bottom: target.bottom - box.top,
                }
                : null;
        };

        const draw = (now) => {
            const { width, height, ratio } = size;
            context.setTransform(ratio, 0, 0, ratio, 0, 0);
            context.clearRect(0, 0, width, height);
            if (!card || width === 0) return;

            const t = still ? 0 : (now - born) / 1000;
            const centre = (card.left + card.right) / 2;
            const cardHalf = (card.right - card.left) / 2;
            // Out past each side of the card by up to three quarters of its
            // half-width, as far as the page allows.
            const side = Math.max(0, Math.min(width / 2 - 8 - cardHalf, cardHalf * 0.75));
            const half = cardHalf + side;
            const top = card.top - ABOVE;
            const bottom = card.bottom + BELOW;
            const span = bottom - top;
            if (half <= 0 || span <= 0) return;

            context.font = `${FONT_PX}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
            context.textBaseline = 'top';
            context.fillStyle = getComputedStyle(canvas).color;

            const firstCol = Math.floor((centre - half) / CELL_W);
            const lastCol = Math.ceil((centre + half) / CELL_W);
            const firstRow = Math.floor(top / CELL_H);
            const lastRow = Math.ceil(bottom / CELL_H);

            for (let row = firstRow; row <= lastRow; row += 1) {
                const y = row * CELL_H;
                const v = (y + CELL_H / 2 - top) / span;
                if (v < 0 || v > 1) continue;
                const insideRows = y + CELL_H > card.top - CLEAR && y < card.bottom + CLEAR;

                for (let col = firstCol; col <= lastCol; col += 1) {
                    const x = col * CELL_W;
                    if (insideRows && x + CELL_W > card.left - CLEAR && x < card.right + CLEAR) continue;

                    const offset = Math.abs(x + CELL_W / 2 - centre);
                    const u = (x + CELL_W / 2 - centre) / half;
                    // Full strength beside the card, thinning out from its
                    // edge to nothing at the end of the band.
                    const reach = side > 0 ? 1 - Math.max(0, offset - cardHalf) / side : 1;
                    if (reach <= 0) continue;

                    // Lit from the foot of the band up to the skyline, and
                    // denser the deeper below it the cell sits.
                    const lit = skyline(u, t);
                    const depth = (lit - (1 - v)) / lit;
                    if (depth <= 0) continue;
                    // Capped, so even the foot of the band has gaps and a
                    // mix of characters rather than a solid rule of X.
                    const density = Math.min(0.78, depth ** 0.6 * reach ** 0.7);

                    // Each cell turns over at its own pace.
                    const pace = 0.35 + hash(col, row, 7) * 1.1;
                    const turn = Math.floor(t * pace + hash(col, row, 3) * 10);
                    const roll = hash(col, row, turn);
                    if (roll > Math.min(0.95, density * 1.15)) continue;

                    let glyph;
                    if (density > 0.45 && hash(col, row, turn + 101) < 0.06) {
                        glyph = GLYPHS[Math.floor(hash(col, row, turn + 202) * GLYPHS.length)];
                    } else {
                        const index = Math.floor(density * RAMP.length + (hash(col, row, turn + 303) - 0.5) * 5);
                        glyph = RAMP[Math.max(0, Math.min(RAMP.length - 1, index))];
                    }
                    context.globalAlpha = 0.22 + 0.48 * density;
                    context.fillText(glyph, x, y);
                }
            }
            context.globalAlpha = 1;
        };

        const tick = (now) => {
            frame = requestAnimationFrame(tick);
            if (now - last < 1000 / FPS) return;
            last = now;
            measure();
            draw(now);
        };

        const observer = new ResizeObserver(() => {
            measure();
            draw(performance.now());
        });
        observer.observe(canvas);
        if (cardRef?.current) observer.observe(cardRef.current);

        const run = () => {
            cancelAnimationFrame(frame);
            frame = 0;
            measure();
            draw(performance.now());
            if (active && !still && !document.hidden) frame = requestAnimationFrame(tick);
        };
        run();
        document.addEventListener('visibilitychange', run);

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            document.removeEventListener('visibilitychange', run);
        };
    }, [cardRef, active]);

    return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
