"use client";

import { useRef, type CSSProperties } from "react";
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap";

export type Block = { col: number; row: number; span?: number; angle?: number };

/**
 * A dashed blueprint grid with grain-filled blocks dropped into some of its
 * cells. Blocks sweep in from the left on first view, then breathe; the cell
 * under the pointer lights up and fades.
 */
export function BlockGrid({
  cols,
  rows,
  blocks,
  tone = "accent",
  className = "",
  style,
  delay = 0.2,
  interactive = true,
}: {
  cols: number;
  rows: number;
  blocks: Block[];
  tone?: "accent" | "mono";
  className?: string;
  style?: CSSProperties;
  delay?: number;
  interactive?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    (_, contextSafe) => {
      const el = root.current;
      if (!el) return;
      const items = gsap.utils.toArray<HTMLElement>("[data-block]", el);
      const lines = el.querySelector("[data-lines]");

      if (prefersReducedMotion()) {
        gsap.set([items, lines], { autoAlpha: 1 });
        return;
      }

      const tl = gsap.timeline({
        delay,
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      });
      tl.fromTo(lines, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.8, ease: "power2.out" }, 0).fromTo(
        items,
        { autoAlpha: 1, scaleX: 0, transformOrigin: "0% 50%" },
        {
          scaleX: 1,
          duration: 1.2,
          ease: "expo.out",
          stagger: { each: 0.055, from: "random" },
        },
        0.1,
      );

      // Each block breathes on its own clock once they're all in.
      tl.add(() => {
        gsap.to(items, {
          opacity: () => gsap.utils.random(0.35, 0.8),
          duration: () => gsap.utils.random(1.4, 2.6),
          ease: "sine.inOut",
          stagger: { each: 0.25, from: "random", repeat: -1, yoyo: true },
        });
      });

      if (!interactive || !contextSafe) return;
      const cells = gsap.utils.toArray<HTMLElement>("[data-glow]", el);
      let last = -1;
      const onMove = contextSafe((e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const c = Math.floor(((e.clientX - r.left) / r.width) * cols);
        const rr = Math.floor(((e.clientY - r.top) / r.height) * rows);
        if (c < 0 || rr < 0 || c >= cols || rr >= rows) return;
        const idx = rr * cols + c;
        if (idx === last) return;
        last = idx;
        gsap.fromTo(cells[idx], { opacity: 1 }, { opacity: 0, duration: 1.4, ease: "power2.out", overwrite: true });
      });
      const target = el.closest("[data-glow-area]") ?? el;
      target.addEventListener("pointermove", onMove as EventListener);
      return () => target.removeEventListener("pointermove", onMove as EventListener);
    },
    { scope: root },
  );

  const blockClass = tone === "accent" ? "block-accent" : "block-mono";

  return (
    <div
      ref={root}
      aria-hidden="true"
      className={`pointer-events-none grid ${className}`}
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        ...style,
      }}
    >
      <div
        data-lines
        data-reveal
        className="col-span-full row-span-full grid"
        style={{
          gridColumn: `1 / span ${cols}`,
          gridRow: `1 / span ${rows}`,
          gridTemplateColumns: "inherit",
          gridTemplateRows: "inherit",
        }}
      >
        {Array.from({ length: cols * rows }, (_, i) => {
          const c = i % cols;
          const r = Math.floor(i / cols);
          return (
            <div
              key={i}
              className={`relative ${c < cols - 1 ? "border-r" : ""} ${r < rows - 1 ? "border-b" : ""} border-dashed border-line-dash`}
            >
              <span data-glow className="absolute inset-0 bg-accent/[0.07] opacity-0" />
            </div>
          );
        })}
      </div>
      {blocks.map((b, i) => (
        <div
          key={i}
          data-block
          data-reveal
          className={`grain ${blockClass} m-[10px] sm:m-[12px]`}
          style={
            {
              gridColumn: `${b.col} / span ${b.span ?? 1}`,
              gridRow: `${b.row}`,
              "--angle": `${b.angle ?? 90}deg`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
