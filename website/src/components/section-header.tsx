"use client";

import { useRef, type ReactNode } from "react";
import { gsap, prefersReducedMotion, SplitText, useGSAP } from "@/lib/gsap";
import { TypeHeading } from "./type-heading";

/**
 * Centred section opener: a typed violet label, a large title whose lines
 * rise out of a mask, a muted line under it, and optional actions.
 */
export function SectionHeader({
  eyebrow,
  title,
  sub,
  children,
  id,
  className = "",
}: {
  eyebrow: string;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  id?: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      const h = el?.querySelector<HTMLElement>("[data-sh-title]");
      const rest = gsap.utils.toArray<HTMLElement>("[data-sh-fade]", el);
      if (!el || !h) return;
      if (prefersReducedMotion()) {
        gsap.set([h, ...rest], { autoAlpha: 1 });
        return;
      }
      gsap.set(h, { autoAlpha: 1 });
      SplitText.create(h, {
        type: "lines",
        mask: "lines",
        linesClass: "split-line",
        autoSplit: true,
        onSplit: (self) =>
          gsap.from(self.lines, {
            yPercent: 110,
            duration: 1.1,
            ease: "expo.out",
            stagger: 0.08,
            scrollTrigger: { trigger: h, start: "top 88%", once: true },
          }),
      });
      gsap.fromTo(
        rest,
        { autoAlpha: 0, y: 12 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.9,
          ease: "expo.out",
          stagger: 0.08,
          delay: 0.2,
          clearProps: "transform",
          scrollTrigger: { trigger: h, start: "top 88%", once: true },
        },
      );
    },
    { scope: root },
  );

  return (
    <div ref={root} className={`flex flex-col items-center px-5 py-14 text-center sm:px-12 sm:py-20 ${className}`}>
      <TypeHeading as="p" variant="eyebrow" text={eyebrow} />
      <h2
        id={id}
        data-sh-title
        data-reveal
        className="mt-5 max-w-[820px] text-[34px] leading-[1.04] font-medium tracking-[-0.03em] text-balance sm:text-[48px]"
      >
        {title}
      </h2>
      {sub && (
        <p
          data-sh-fade
          data-reveal
          className="mt-5 max-w-[620px] text-[16px] leading-relaxed text-pretty text-muted sm:text-[18px]"
        >
          {sub}
        </p>
      )}
      {children && (
        <div data-sh-fade data-reveal className="relative z-10 mt-8 flex flex-wrap items-center justify-center gap-3">
          {children}
        </div>
      )}
    </div>
  );
}
