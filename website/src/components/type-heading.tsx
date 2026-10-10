"use client";

import { useRef } from "react";
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap";

/**
 * "// heading" in mono that types itself out the first time it scrolls into
 * view. Screen readers get the plain text; the typed copy is decorative.
 * The eyebrow variant is the small violet label above a section title.
 */
export function TypeHeading({
  text,
  as: Tag = "h2",
  variant = "heading",
  className = "",
  id,
}: {
  text: string;
  as?: "h1" | "h2" | "h3" | "p";
  variant?: "heading" | "eyebrow";
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLHeadingElement>(null);

  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const typed = ref.current?.querySelector("[data-typed]");
      if (!typed) return;
      gsap.set(typed, { text: "" });
      gsap.to(typed, {
        text,
        duration: Math.min(1.8, Math.max(0.6, text.length * 0.045)),
        ease: "none",
        delay: 0.15,
        scrollTrigger: { trigger: ref.current, start: "top 88%", once: true },
      });
    },
    { scope: ref, dependencies: [text] },
  );

  const look =
    variant === "eyebrow"
      ? "font-mono text-[13px] font-medium tracking-[0.01em] text-accent sm:text-[14px]"
      : "font-mono text-[20px] leading-snug font-medium tracking-[-0.02em] sm:text-[24px]";

  return (
    <Tag ref={ref} id={id} className={`${look} ${className}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        <span className={variant === "eyebrow" ? "mr-2 text-subtle" : "mr-3 text-subtle"}>{"//"}</span>
        <span data-typed>{text}</span>
        <span className="caret text-accent" />
      </span>
    </Tag>
  );
}
