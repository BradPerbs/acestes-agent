"use client";

import { useRef } from "react";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";

/**
 * Rings of dots rippling out from the centre, drawn on a canvas. Reads the
 * theme's foreground colour so it works in light and dark, and only runs
 * while it's on screen.
 */
export function DotWave({ className = "" }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useGSAP(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;

    let w = 0;
    let h = 0;
    let rgb = "250,250,250";
    const gap = 9;

    const readColor = () => {
      const fg = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim() || "#fafafa";
      const n = parseInt(fg.replace("#", "").slice(0, 6), 16);
      rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = c.getBoundingClientRect();
      w = r.width;
      h = r.height;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const maxD = Math.hypot(cx, cy * 2.1);
      for (let y = gap / 2; y < h; y += gap) {
        for (let x = gap / 2; x < w; x += gap) {
          const dx = x - cx;
          const dy = (y - cy) * 2.1;
          const d = Math.hypot(dx, dy);
          const wave = Math.sin(d * 0.05 - t * 1.5);
          const fall = 1 - Math.min(1, d / maxD);
          const near = Math.min(1, d / 70);
          const alpha = (0.08 + (wave + 1) * 0.28) * (0.35 + fall * 0.65) * near;
          if (alpha < 0.02) continue;
          const r = 0.55 + (wave + 1) * 0.5 * (0.4 + fall * 0.6);
          ctx.fillStyle = `rgba(${rgb},${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y + wave * 2.2 * fall, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    readColor();
    resize();

    const still = prefersReducedMotion();
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

    // Re-read the colour when next-themes flips the class on <html>.
    const mo = new MutationObserver(() => {
      readColor();
      draw(time);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    draw(0);
    let st: ScrollTrigger | undefined;
    if (!still) {
      st = ScrollTrigger.create({
        trigger: c,
        start: "top bottom",
        end: "bottom top",
        onToggle: (self) => (self.isActive ? gsap.ticker.add(tick) : gsap.ticker.remove(tick)),
      });
      if (st.isActive) gsap.ticker.add(tick);
    }

    return () => {
      gsap.ticker.remove(tick);
      st?.kill();
      ro.disconnect();
      mo.disconnect();
    };
  });

  return <canvas ref={canvas} aria-hidden="true" className={`block size-full ${className}`} />;
}
