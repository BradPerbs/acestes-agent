"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { REST, drawHelmet, framing, whenHelmetReady, type CrestId, type HelmetId } from "@/lib/helmet/renderer";
import { gsap, prefersReducedMotion } from "@/lib/gsap";
import { Helmet } from "./brand";

/*
 * The app's own helmet, drawn live by its WebGL2 renderer as ink line art and
 * moving the way AgentMark's LiveMark does in the app: it turns to look at the
 * pointer a beat behind it and sways a little on its own. On the site it also
 * turns in to face you the first time it scrolls into view.
 */

/** How it looks at the pointer (AgentMark.jsx). */
const LOOK = { yaw: 60, pitch: 12, level: 8, reachX: 420, reachY: 320 };
/** The drift it has of its own, in degrees. */
const SWAY = { yaw: 2.5, pitch: 1.2 };
/** How long it takes to catch up with where it is looking, in seconds. */
const LAG = 0.25;
/** Every angle it can reach, which its canvas is sized to hold. */
const RANGE: [number, number][] = (() => {
  const angles: [number, number][] = [[REST.yaw, REST.pitch]];
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

/* One pointer, shared by every helmet that follows it. */
const pointer = { x: 0, y: 0, inside: false };
let followers = 0;
const onMove = (e: PointerEvent) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.inside = true;
};
const onLeave = () => {
  pointer.inside = false;
};
function followPointer() {
  if (followers++ === 0) {
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
  }
  return () => {
    if (--followers === 0) {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    }
  };
}

const isDark = () => document.documentElement.classList.contains("dark");
const noop = () => () => {};

export function LiveHelmet({
  helmet = "corinthian",
  crest = "plume",
  size = 96,
  line,
  lineDark,
  paper = null,
  delay = 0,
  className = "",
}: {
  helmet?: HelmetId;
  crest?: CrestId;
  size?: number;
  /** Ink in light mode and in dark mode, as the app's agentInk() gives them. */
  line: string;
  lineDark: string;
  paper?: string | null;
  /** Seconds before it turns in, so a row of them can arrive one after another. */
  delay?: number;
  className?: string;
}) {
  const wrap = useRef<HTMLSpanElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [place, setPlace] = useState({ grow: 1, dx: 0, dy: 0 });
  const ratio = useSyncExternalStore(
    noop,
    () => Math.min(2, window.devicePixelRatio || 1),
    () => 1,
  );

  // Load the mesh once it is about to be seen (each is a few hundred
  // kilobytes), then work out the canvas that holds every angle it can turn to.
  useEffect(() => {
    const box = wrap.current;
    if (!box) return;
    let current = true;
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        near.disconnect();
        whenHelmetReady(helmet).then((ok) => {
          if (!current) return;
          if (ok) {
            setPlace(framing(helmet, crest, RANGE));
            setStatus("ready");
          } else {
            setStatus("failed");
          }
        });
      },
      { rootMargin: "900px 0px" },
    );
    near.observe(box);
    return () => {
      current = false;
      near.disconnect();
    };
  }, [helmet, crest]);

  const canvasSize = size * place.grow;
  const pixels = Math.max(1, Math.round(canvasSize * ratio));

  useEffect(() => {
    const node = canvas.current;
    const box = wrap.current;
    if (status !== "ready" || !node || !box) return;

    let colour = isDark() ? lineDark : line;
    const view = { yaw: REST.yaw, pitch: REST.pitch };
    const draw = () =>
      drawHelmet(node, {
        helmet,
        crest,
        size,
        canvasSize,
        yaw: view.yaw,
        pitch: view.pitch,
        range: RANGE,
        line: colour,
        paper,
      });

    // Re-ink when the theme flips.
    const themes = new MutationObserver(() => {
      colour = isDark() ? lineDark : line;
      draw();
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    if (prefersReducedMotion()) {
      draw();
      return () => themes.disconnect();
    }

    // Turned away until it is seen, then it turns in to face you.
    view.yaw = -LOOK.yaw;
    view.pitch = LOOK.level + LOOK.pitch;
    draw();
    let following = false;
    let intro: gsap.core.Tween | null = null;

    const tick = (time: number, delta: number) => {
      if (following) {
        let targetYaw = REST.yaw;
        let targetPitch = REST.pitch;
        if (pointer.inside) {
          const r = box.getBoundingClientRect();
          targetYaw = LOOK.yaw * Math.tanh((pointer.x - (r.left + r.width / 2)) / LOOK.reachX);
          targetPitch = LOOK.level + LOOK.pitch * Math.tanh((pointer.y - (r.top + r.height / 2)) / LOOK.reachY);
        }
        targetYaw += SWAY.yaw * Math.sin(time * 0.8);
        targetPitch += SWAY.pitch * Math.sin(time * 0.63 + 1.3);
        const k = 1 - Math.exp(-Math.min(0.1, delta / 1000) / LAG);
        view.yaw += (targetYaw - view.yaw) * k;
        view.pitch += (targetPitch - view.pitch) * k;
      }
      draw();
    };

    let ticking = false;
    const visible = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (!intro) {
          intro = gsap.to(view, {
            yaw: REST.yaw,
            pitch: REST.pitch,
            duration: 1.8,
            delay,
            ease: "expo.out",
            onComplete: () => {
              following = true;
            },
          });
        }
        if (!ticking) {
          gsap.ticker.add(tick);
          ticking = true;
        }
      } else if (ticking) {
        gsap.ticker.remove(tick);
        ticking = false;
      }
    });
    visible.observe(box);
    const stopFollowing = followPointer();

    return () => {
      intro?.kill();
      gsap.ticker.remove(tick);
      visible.disconnect();
      themes.disconnect();
      stopFollowing();
    };
  }, [status, helmet, crest, size, canvasSize, pixels, line, lineDark, paper, delay]);

  return (
    <span
      ref={wrap}
      aria-hidden="true"
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {status === "failed" ? (
        <Helmet size={size} color={line} />
      ) : (
        <canvas
          ref={canvas}
          width={pixels}
          height={pixels}
          className="absolute max-w-none"
          style={{
            width: canvasSize,
            height: canvasSize,
            left: (size - canvasSize) / 2 + place.dx * size,
            top: (size - canvasSize) / 2 + place.dy * size,
          }}
        />
      )}
    </span>
  );
}
