"use client";

import { useRef, type ElementType, type ReactNode } from "react";
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap";

/**
 * Fades and lifts every [data-r] inside it the first time it scrolls into
 * view. Server components put data-r on what should move and wrap the lot in
 * this, so only the wrapper ships as client code.
 */
export function Reveal({
  children,
  className = "",
  as: Tag = "div",
  stagger = 0.07,
  y = 18,
  start = "top 85%",
  id,
  draw = false,
}: {
  children: ReactNode;
  className?: string;
  as?: ElementType;
  stagger?: number | gsap.StaggerVars;
  y?: number;
  start?: string;
  id?: string;
  /** Also draw the strokes of any [data-draw] icon. */
  draw?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = ref.current;
      if (!el) return;
      const items = gsap.utils.toArray<HTMLElement>("[data-r]", el);
      if (prefersReducedMotion()) {
        gsap.set(items, { autoAlpha: 1 });
        return;
      }
      const tl = gsap.timeline({ scrollTrigger: { trigger: el, start, once: true } });
      tl.fromTo(
        items,
        { autoAlpha: 0, y },
        // Drop the transform when done: a leftover one makes a stacking context
        // that would trap popovers (like the download menu) under later rows.
        { autoAlpha: 1, y: 0, duration: 1, ease: "expo.out", stagger, clearProps: "transform" },
      );
      if (draw) {
        const strokes = el.querySelectorAll(
          "[data-draw] path, [data-draw] circle, [data-draw] rect, [data-draw] line, [data-draw] polyline",
        );
        if (strokes.length) {
          tl.fromTo(
            strokes,
            { drawSVG: "0%" },
            { drawSVG: "100%", duration: 1.4, ease: "power2.inOut", stagger: 0.02 },
            0.15,
          );
        }
      }
    },
    { scope: ref },
  );

  return (
    <Tag ref={ref} id={id} className={className}>
      {children}
    </Tag>
  );
}
