"use client";

import { useRef, type ReactNode } from "react";
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap";

/**
 * Every bit of small motion on the site, done in GSAP rather than CSS.
 *
 * MotionFx is mounted once and works by delegation, so server components only
 * need data attributes:
 *   data-hover          a group that reacts to hover and keyboard focus
 *   data-nudge="x|y"    a child of a group that slides 2px while it is active
 *   data-press          shrinks a touch while pressed
 */
export function MotionFx() {
  useGSAP(() => {
    if (prefersReducedMotion()) return;

    const nudge = (group: Element, on: boolean) => {
      group.querySelectorAll<HTMLElement>("[data-nudge]").forEach((n) => {
        const axis = n.dataset.nudge === "y" ? "y" : "x";
        gsap.to(n, {
          [axis]: on ? 2 : 0,
          duration: on ? 0.35 : 0.5,
          ease: on ? "power3.out" : "expo.out",
          overwrite: "auto",
        });
      });
    };
    const enter = (e: Event) => {
      const group = (e.target as Element | null)?.closest?.("[data-hover]");
      const from = (e as PointerEvent | FocusEvent).relatedTarget as Node | null;
      if (group && !(from && group.contains(from))) nudge(group, true);
    };
    const leave = (e: Event) => {
      const group = (e.target as Element | null)?.closest?.("[data-hover]");
      const to = (e as PointerEvent | FocusEvent).relatedTarget as Node | null;
      if (group && !(to && group.contains(to))) nudge(group, false);
    };

    let pressed: HTMLElement | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      pressed = (e.target as Element | null)?.closest?.<HTMLElement>("[data-press]") ?? null;
      if (pressed) gsap.to(pressed, { scale: 0.98, duration: 0.12, ease: "power2.out", overwrite: "auto" });
    };
    const up = () => {
      if (!pressed) return;
      // Clear the transform once back at rest: a leftover one makes a stacking
      // context that would trap the download menu under later rows.
      gsap.to(pressed, { scale: 1, duration: 0.45, ease: "expo.out", overwrite: "auto", clearProps: "transform" });
      pressed = null;
    };

    const d = document;
    d.addEventListener("pointerover", enter);
    d.addEventListener("pointerout", leave);
    d.addEventListener("focusin", enter);
    d.addEventListener("focusout", leave);
    d.addEventListener("pointerdown", down);
    d.addEventListener("pointerup", up);
    d.addEventListener("pointercancel", up);
    d.addEventListener("dragstart", up);
    return () => {
      d.removeEventListener("pointerover", enter);
      d.removeEventListener("pointerout", leave);
      d.removeEventListener("focusin", enter);
      d.removeEventListener("focusout", leave);
      d.removeEventListener("pointerdown", down);
      d.removeEventListener("pointerup", up);
      d.removeEventListener("pointercancel", up);
      d.removeEventListener("dragstart", up);
    };
  });

  return null;
}

/** Turns its content half a turn when open: the chevrons on menus and the FAQ. */
export function Turn({ open, className = "", children }: { open: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  useGSAP(
    () => {
      const reduce = prefersReducedMotion();
      gsap.to(ref.current, {
        rotation: open ? 180 : 0,
        duration: reduce ? 0 : 0.5,
        ease: "expo.out",
        overwrite: true,
      });
    },
    { dependencies: [open] },
  );
  return (
    <span ref={ref} className={`inline-grid place-items-center ${className}`}>
      {children}
    </span>
  );
}

/** Blinking block caret after typed text. */
export function Caret({ className = "" }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useGSAP(() => {
    if (prefersReducedMotion()) return;
    // steps(1) over a half period: hard on, hard off, like a terminal.
    gsap.to(ref.current, { autoAlpha: 0, duration: 0.525, ease: "steps(1)", repeat: -1, yoyo: true });
  });
  return <span ref={ref} className={`caret ${className}`} />;
}

/** Spins forever: the app replica's working ring. */
export function useSpin<T extends Element>(duration = 0.8) {
  const ref = useRef<T>(null);
  useGSAP(() => {
    if (prefersReducedMotion()) return;
    gsap.to(ref.current, { rotation: 360, transformOrigin: "50% 50%", duration, ease: "none", repeat: -1 });
  });
  return ref;
}

/** Light sweeping across text: the app replica's working phrase. */
export function useGlint<T extends HTMLElement>(duration = 1.6) {
  const ref = useRef<T>(null);
  useGSAP(() => {
    if (prefersReducedMotion()) return;
    gsap.fromTo(
      ref.current,
      { backgroundPosition: "100% 0%" },
      { backgroundPosition: "0% 0%", duration, ease: "none", repeat: -1 },
    );
  });
  return ref;
}
