"use client";

import { useRef } from "react";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";

/**
 * A halftone field of light dots over the hero panel. Dots swell toward a
 * glow that rises from the bottom edge, and a slow interference pattern
 * drifts through them. Runs only while visible; still under reduced motion.
 */
export function Halftone({ className = "" }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useGSAP(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;

    let w = 0;
    let h = 0;
    const gap = 7;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = c.getBoundingClientRect();
      w = r.width;
      h = r.height;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    // Glow strength rises in on load, then breathes.
    const state = { glow: prefersReducedMotion() ? 1 : 0 };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h * 1.08;
      const reach = Math.max(w * 0.55, h * 0.9);
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const d = Math.hypot((x - cx) * 0.75, y - cy);
          const g = Math.max(0, 1 - d / reach) * state.glow;
          const wave = Math.sin(x * 0.018 + t * 0.6) * Math.cos(y * 0.026 - t * 0.9);
          const a = 0.05 + g * g * 0.75 + wave * 0.035 + (1 - y / h) * 0.02;
          if (a < 0.03) continue;
          const r = 0.45 + g * 1.25 + wave * 0.12;
          ctx.fillStyle = `rgba(237, 228, 255, ${Math.min(0.9, a).toFixed(3)})`;
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
        }
      }
    };

    resize();
    draw(0);

    let time = 0;
    const tick = (_: number, delta: number) => {
      time += delta / 1000;
      draw(time);
    };

    const ro = new ResizeObserver(() => {
      resize();
      draw(time);
    });
    ro.observe(c);

    if (prefersReducedMotion()) return () => ro.disconnect();

    gsap.to(state, { glow: 1, duration: 2.4, ease: "power2.out", delay: 0.2 });
    gsap.to(state, { glow: 0.82, duration: 3.2, ease: "sine.inOut", repeat: -1, yoyo: true, delay: 2.6 });

    const st = ScrollTrigger.create({
      trigger: c,
      start: "top bottom",
      end: "bottom top",
      onToggle: (self) => (self.isActive ? gsap.ticker.add(tick) : gsap.ticker.remove(tick)),
    });
    if (st.isActive) gsap.ticker.add(tick);

    return () => {
      gsap.ticker.remove(tick);
      st.kill();
      ro.disconnect();
    };
  });

  return <canvas ref={canvas} aria-hidden="true" className={`block size-full ${className}`} />;
}
