import { gsap } from 'gsap';
import { cubicBezier, prefersReducedMotion, seconds } from './motion';

/**
 * The status bar's pieces coming and going: an account's meter when it is
 * ticked or cleared, its name when a second account makes names worth
 * showing, a runtime's group when it gets its first figure.
 *
 * Each grows out of nothing to the width it was drawn at and folds back into
 * nothing the same way, fading as it goes, so whatever stands beside it
 * slides over rather than jumping. On the tab strip's curve, a touch quicker:
 * these are small, and the bar is not where the eye is.
 *
 * Either can be caught halfway through the other. A meter cleared and ticked
 * again before it has gone grows back from the width it had reached rather
 * than from nothing, and one cleared while still arriving folds from where it
 * got to.
 */

const EASE = cubicBezier(0.16, 1, 0.3, 1);
const GROW_MS = 240;
const FOLD_MS = 180;
const PROPS = 'width,opacity,overflow';

/** A piece arriving, or coming back while it was on its way out. */
export function growIn(node) {
    if (!node) return null;

    // Where it stands now: nothing for one just drawn, wherever it had got to
    // for one caught mid-fold.
    const moving = gsap.isTweening(node);
    const from = moving ? node.getBoundingClientRect().width : 0;
    const opacity = moving ? Number(gsap.getProperty(node, 'opacity')) : 0;

    // Its natural width, measured with nothing of ours written on it.
    gsap.killTweensOf(node);
    gsap.set(node, { clearProps: PROPS });
    if (prefersReducedMotion()) return null;
    const width = node.getBoundingClientRect().width;

    return gsap.fromTo(
        node,
        { width: from, opacity, overflow: 'hidden' },
        { width, opacity: 1, duration: seconds(GROW_MS), ease: EASE, clearProps: PROPS },
    );
}

/**
 * A piece leaving: folded to nothing, then `done` takes it out. Nothing is
 * cleared at the end; it keeps the nothing it lands on until it is unmounted.
 */
export function foldOut(node, done) {
    if (!node) {
        done?.();
        return null;
    }

    const width = node.getBoundingClientRect().width;
    gsap.killTweensOf(node);
    return gsap.fromTo(
        node,
        { width, overflow: 'hidden' },
        { width: 0, opacity: 0, duration: seconds(FOLD_MS), ease: EASE, onComplete: done },
    );
}
