import { REST, drawHelmet, framing, whenHelmetReady } from '../components/assistant/helmet/renderer';

/**
 * Sends off the boot splash, the helmet index.html shows while the bundle
 * loads (see `.boot-splash` in input.css).
 *
 * The splash is a still drawing, because nothing that needs a script can run
 * while it is up. By the time it leaves the scripts are in, so it leaves as
 * the real thing: the drawing gives way to the live helmet in the same pose,
 * which turns across to its other side and comes forward as the splash fades,
 * onto the app underneath. Where the helmet cannot be drawn live, or quickly enough, the
 * drawing comes forward on its own; with reduced motion it only fades.
 */

const HELMET = 'corinthian';
const CREST = 'plume';
/** The helmet's size in CSS pixels. Keep in step with `.boot-splash-mark`. */
const SIZE = 128;
/** How far it comes forward, which the canvas is drawn big enough to stay sharp at. */
const FORWARD = 1.5;
/**
 * Where it turns to on the way out: across your line of sight to the other
 * three quarters, a little more level.
 */
const TO = { yaw: -40, pitch: 8 };
/** Every pose of the turn, so the frame holds the helmet still while it turns. */
const RANGE = Array.from({ length: 9 }, (_, i) => [
    REST.yaw + ((TO.yaw - REST.yaw) * i) / 8,
    REST.pitch + ((TO.pitch - REST.pitch) * i) / 8,
]);
/** How long the live helmet may keep it waiting before it goes without one. */
const LIVE_WAIT = 400;

const TURN_MS = 560;
const OUT_MS = 900;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** After the next frame has been painted. */
const painted = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));

let sent = false;

/**
 * Called once the app (or the lock screen, or the error screen) has rendered.
 * Safe to call more than once, and where there is no splash.
 */
export function dismissBootSplash() {
    const splash = document.getElementById('boot-splash');
    if (sent || !splash) return;
    sent = true;
    const root = document.documentElement;
    if (!root.classList.contains('booting')) {
        splash.remove();
        return;
    }

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const live = still ? Promise.resolve(false) : Promise.race([whenHelmetReady(HELMET), wait(LIVE_WAIT).then(() => false)]);
    // Not before it has finished coming in, so a quick start does not cut it
    // off half risen. The rise is a CSS animation of its own and says when.
    const risen = Promise.all((splash.querySelector('.boot-splash-mark')?.getAnimations() || []).map(a => a.finished));
    Promise.all([live, risen, painted()])
        .then(([ok]) => leave(splash, { still, live: ok }))
        .catch(() => leave(splash, { still: true, live: false }))
        .finally(() => root.classList.remove('booting', 'boot-light'));
}

function leave(splash, { still, live }) {
    const gone = (animation) => animation.finished.then(() => splash.remove(), () => splash.remove());

    if (still) return gone(splash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-out', fill: 'forwards' }));

    const mark = splash.querySelector('.boot-splash-mark');
    if (live) turn(splash);

    splash.querySelector('.boot-splash-track')?.animate([{ opacity: 0 }], { duration: 180, fill: 'forwards' });
    // A breath while it turns, then forward, faster and faster.
    mark.animate([
        { transform: 'none', easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
        { transform: 'scale(1.03)', offset: 0.5, easing: 'cubic-bezier(0.55, 0, 0.85, 0.35)' },
        { transform: `scale(${FORWARD})` },
    ], { duration: OUT_MS, fill: 'forwards' });
    return gone(splash.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: OUT_MS * 0.5,
        delay: OUT_MS * 0.5,
        easing: 'cubic-bezier(0.4, 0, 0.6, 1)',
        fill: 'forwards',
    }));
}

/** Swap the drawing for the live helmet, and turn it. */
function turn(splash) {
    const float = splash.querySelector('.boot-splash-float');
    const drawing = splash.querySelector('.boot-splash-helmet');
    const place = framing(HELMET, CREST, RANGE);
    const canvasSize = SIZE * place.grow;
    const canvas = document.createElement('canvas');
    canvas.className = 'boot-splash-canvas';
    canvas.width = canvas.height = Math.round(canvasSize * (window.devicePixelRatio || 1) * FORWARD);
    Object.assign(canvas.style, {
        width: `${canvasSize}px`,
        height: `${canvasSize}px`,
        left: `${(SIZE - canvasSize) / 2 + place.dx * SIZE}px`,
        top: `${(SIZE - canvasSize) / 2 + place.dy * SIZE}px`,
    });
    const line = getComputedStyle(splash).color;
    const draw = (yaw, pitch) => drawHelmet(canvas, { helmet: HELMET, crest: CREST, size: SIZE, canvasSize, yaw, pitch, range: RANGE, line });

    if (!draw(REST.yaw, REST.pitch)) return;
    float.appendChild(canvas);
    drawing.style.visibility = 'hidden';

    const start = performance.now();
    const step = (now) => {
        if (!canvas.isConnected) return;
        const t = easeInOut(Math.min(1, (now - start) / TURN_MS));
        draw(REST.yaw + (TO.yaw - REST.yaw) * t, REST.pitch + (TO.pitch - REST.pitch) * t);
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}
