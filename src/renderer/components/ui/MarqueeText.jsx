import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from '../../lib/motion';

/** How fast a long title slides, in pixels a second, and how long it rests at either end. */
const MARQUEE_SPEED = 36;
const MARQUEE_REST = 1100;
/** How wide the fade is at an edge that has text hidden past it. */
const MARQUEE_FADE = 20;

/** Ease in and out, over 0 to 1. */
const easeInOut = x => -(Math.cos(Math.PI * x) - 1) / 2;

/**
 * Fade the box's edges, each by as much text as is hidden past it, up to
 * the full width. Nothing hidden on either side is no mask at all.
 */
function fadeEdges(box, left, right) {
    const mask = left <= 0 && right <= 0
        ? ''
        : `linear-gradient(to right, transparent, #000 ${Math.min(MARQUEE_FADE, left)}px, `
            + `#000 calc(100% - ${Math.min(MARQUEE_FADE, right)}px), transparent)`;
    box.style.maskImage = mask;
    box.style.webkitMaskImage = mask;
}

/**
 * A line that fits, or one that fades out, and the whole of it on hover.
 *
 * Too long for its box, it fades out at the right edge rather than ending in
 * an ellipsis. While `playing` it slides to show its end, rests, and slides
 * back, for as long as the pointer stays: the way a music player shows a
 * track name that does not fit. Each edge fades by as much text as is
 * hidden past it, so both are soft while it moves, and the first letter at
 * the start and the last at the end are never faded. A line that fits never
 * moves or fades. Nothing moves for someone who has asked for less motion;
 * a tooltip on whatever holds it is theirs instead.
 *
 * Driven frame by frame rather than as a CSS animation, because the fade has
 * to follow the text exactly and a gradient's stops do not animate.
 */
export default function MarqueeText({ text, playing, className = '' }) {
    const box = useRef(null);
    const line = useRef(null);
    const [overflow, setOverflow] = useState(0);

    // How much does not fit, kept current as the text or the box changes.
    useLayoutEffect(() => {
        const element = box.current;
        if (!element || !line.current) return undefined;
        const measure = () => setOverflow(Math.max(0, Math.ceil(line.current.offsetWidth - element.clientWidth)));
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [text]);

    // At rest: the end fades out, where the rest of the title is.
    useLayoutEffect(() => {
        if (box.current) fadeEdges(box.current, 0, overflow);
    }, [overflow]);

    useEffect(() => {
        if (!playing || overflow <= 0 || prefersReducedMotion() || !box.current || !line.current) return undefined;
        const element = box.current;
        const moving = line.current;

        const travel = Math.max(600, (overflow / MARQUEE_SPEED) * 1000);
        const total = 2 * (MARQUEE_REST + travel);
        const offsetAt = (elapsed) => {
            const t = elapsed % total;
            if (t < MARQUEE_REST) return 0;
            if (t < MARQUEE_REST + travel) return overflow * easeInOut((t - MARQUEE_REST) / travel);
            if (t < 2 * MARQUEE_REST + travel) return overflow;
            return overflow * (1 - easeInOut((t - 2 * MARQUEE_REST - travel) / travel));
        };

        const began = performance.now();
        let frame = 0;
        const tick = (now) => {
            const offset = offsetAt(now - began);
            moving.style.transform = `translateX(${-offset}px)`;
            fadeEdges(element, offset, overflow - offset);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);

        return () => {
            cancelAnimationFrame(frame);
            moving.style.transform = '';
            fadeEdges(element, 0, overflow);
        };
    }, [playing, overflow]);

    // A block, so the transform moves it and its width is the whole title.
    return (
        <span ref={box} className={`min-w-0 flex-1 overflow-hidden whitespace-nowrap ${className}`}>
            <span ref={line} className="inline-block">{text}</span>
        </span>
    );
}
