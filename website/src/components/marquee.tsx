"use client";

import { Fragment, useRef, type ReactNode } from "react";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";

/**
 * An endless strip. The content renders twice side by side and the track
 * slides by exactly half its width, so the loop never shows a seam at any
 * viewport size. Slows under the pointer; stops off screen and under
 * reduced motion.
 */
export function Marquee({
  children,
  reverse = false,
  speed = 45,
  repeat = 2,
  className = "",
}: {
  children: ReactNode;
  reverse?: boolean;
  speed?: number;
  /** Copies of the content in each half, so one half is always wider than the frame. */
  repeat?: number;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    (_, contextSafe) => {
      const el = root.current;
      const track = el?.querySelector<HTMLElement>("[data-track]");
      if (!el || !track || !contextSafe || prefersReducedMotion()) return;

      const tween = gsap.fromTo(
        track,
        { xPercent: reverse ? -50 : 0 },
        { xPercent: reverse ? 0 : -50, duration: speed, ease: "none", repeat: -1 },
      );
      const st = ScrollTrigger.create({
        trigger: el,
        start: "top bottom",
        end: "bottom top",
        onToggle: (self) => (self.isActive ? tween.resume() : tween.pause()),
      });
      if (!st.isActive) tween.pause();

      const slow = contextSafe(() => gsap.to(tween, { timeScale: 0.15, duration: 0.6, ease: "power2.out" }));
      const fast = contextSafe(() => gsap.to(tween, { timeScale: 1, duration: 0.6, ease: "power2.out" }));
      el.addEventListener("pointerenter", slow);
      el.addEventListener("pointerleave", fast);
      return () => {
        el.removeEventListener("pointerenter", slow);
        el.removeEventListener("pointerleave", fast);
      };
    },
    { scope: root },
  );

  return (
    <div
      ref={root}
      className={`overflow-hidden [mask-image:linear-gradient(90deg,transparent,#000_10%,#000_90%,transparent)] ${className}`}
    >
      <div data-track className="flex w-max">
        {[0, 1].map((half) => (
          <div key={half} className="flex shrink-0" {...(half ? { "aria-hidden": true, inert: true } : {})}>
            {Array.from({ length: repeat }, (_, i) => (
              <Fragment key={i}>{children}</Fragment>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
