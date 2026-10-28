"use client";

import { AppVersion } from "@/components/app-version";
import { useRef } from "react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { gsap, prefersReducedMotion, SplitText, useGSAP } from "@/lib/gsap";
import { DownloadButton } from "../download-button";
import { Container } from "../frame";
import { HeroScene } from "../hero-scene";
import { SoundToggle } from "../sound-toggle";
import { Icon } from "../icon";

/** Letters that hang below the line: a rolled copy above would show its tail. */
const DESCENDERS = /[gjpqy]/i;
/** How much taller than a line its mask is, so descenders are not clipped. */
const ROOM = 0.15;

/**
 * The headline intro, after mistral.ai's: every line is a mask that grows open
 * from the top while its letters rise into it, left to right with a jittered
 * stagger, each line 0.7s behind the one above. Every fifth or eighth letter
 * is stacked twice and rolls through both copies, like an odometer.
 */
function titleIntro(title: HTMLElement) {
  const groups = gsap.utils.toArray<HTMLElement>("[data-title-line]", title);
  const height = title.offsetHeight;
  const splits = groups.map((g) =>
    SplitText.create(g, { type: "lines,words,chars", linesClass: "hero-line", wordsClass: "hero-word" }),
  );
  const lines = splits.flatMap((s) => s.lines as HTMLElement[]);
  const words = splits.flatMap((s) => s.words as HTMLElement[]);

  // Lock the heading to its laid-out height and pin the lines to its foot, so
  // the masks can grow without pushing the copy below it around.
  gsap.set(title, { height, display: "flex", flexDirection: "column", justifyContent: "flex-end" });
  // Words as flex rows: letters stack from their top, so a doubled letter's
  // second copy sits exactly one line below the first.
  gsap.set(words, { display: "inline-flex", whiteSpace: "nowrap" });

  const sizes = lines.map((l) => l.offsetHeight);
  const rolled = new Set<HTMLElement>();
  lines.forEach((line, li) => {
    const below = sizes.slice(li).reduce((a, b) => a + b, 0);
    // A taller mask pushes everything above it up; slide it back down.
    gsap.set(line, {
      overflow: "hidden",
      height: sizes[li] * (1 + ROOM),
      y: below * ROOM,
      transformOrigin: "top center",
    });
    line.querySelectorAll<HTMLElement>(".hero-word > *").forEach((c, n) => {
      if ((n % 5 === 0 || n % 8 === 0) && !DESCENDERS.test(c.textContent ?? "")) {
        c.innerHTML += "<br>" + c.innerHTML;
        rolled.add(c);
      }
    });
  });

  gsap.set(title, { autoAlpha: 1 });

  const tl = gsap.timeline({
    delay: 0.2,
    onComplete: () => {
      splits.forEach((s) => s.revert());
      gsap.set(title, { clearProps: "height,display,flexDirection,justifyContent" });
    },
  });
  // 0.7s between lines, as on mistral.ai, but a phone's four lines share the same 1.4s.
  const gap = lines.length > 2 ? 1.4 / (lines.length - 1) : 0.7;
  lines.forEach((line, li) => {
    const chars = gsap.utils.toArray<HTMLElement>(".hero-word > *", line);
    const jitter = chars.map((_, i) => i * gsap.utils.random(1, 5, 1) * 0.005);
    tl.fromTo(
      chars,
      { y: "100%" },
      {
        y: (_, c: HTMLElement) => (rolled.has(c) ? "-50%" : "0%"),
        duration: 1,
        ease: "power4.inOut",
        stagger: (i) => jitter[i],
      },
      li * gap * 1.05,
    );
    tl.from(line, { height: 0, duration: 1.3, ease: "power4.inOut" }, li * gap);
  });

  return {
    revert: () => {
      tl.kill();
      splits.forEach((s) => s.revert());
      gsap.set(title, { clearProps: "height,display,flexDirection,justifyContent" });
    },
  };
}

export function Hero() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      const title = el?.querySelector<HTMLElement>("[data-hero-title]");
      const fades = gsap.utils.toArray<HTMLElement>("[data-hero-fade]", el);
      if (!el || !title) return;

      if (prefersReducedMotion()) {
        gsap.set([title, ...fades], { autoAlpha: 1 });
        return;
      }

      gsap.fromTo(
        fades,
        { autoAlpha: 0, y: 14 },
        { autoAlpha: 1, y: 0, duration: 1, ease: "expo.out", stagger: 0.08, delay: 0.9, clearProps: "transform" },
      );

      gsap.fromTo(
        el.querySelector("[data-panel]"),
        { clipPath: "inset(6% 4% 6% 4% round 28px)" },
        { clipPath: "inset(0% 0% 0% 0% round 20px)", duration: 1.6, ease: "expo.out" },
      );

      // The copy drifts up and fades as the page scrolls past the scene.
      gsap.to(el.querySelector("[data-hero-copy]"), {
        y: -70,
        opacity: 0,
        ease: "none",
        scrollTrigger: { trigger: el, start: 0, end: "bottom 20%", scrub: true },
      });

      // Split only once the webfont is in, or the lines get measured in the fallback.
      let intro: { revert: () => void } | undefined;
      let dead = false;
      document.fonts.ready.then(() => {
        if (!dead) intro = titleIntro(title);
      });
      return () => {
        dead = true;
        intro?.revert();
      };
    },
    { scope: root },
  );

  return (
    <section id="top" ref={root} aria-labelledby="hero-title" className="relative">
      <Container className="border-x border-line bg-bg p-2 sm:p-3">
        <div
          data-panel
          className="@container relative isolate overflow-hidden rounded-[20px] bg-[#07050d] text-white"
          style={{ clipPath: "inset(0% 0% 0% 0% round 20px)" }}
        >
          {/* Night and the eclipse's glow, for the moment before the scene draws, or where it can't. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10"
            style={{
              background: "radial-gradient(90% 55% at 50% 100%, #5b21b6 0%, #2a1360 30%, #120a26 58%, #07050d 85%)",
            }}
          />
          <HeroScene className="absolute inset-0 -z-10" />

          {/* The copy sits in the sky, clear of the range: the bottom padding is the scene's 0.38 units (sceneUnit). */}
          <div
            data-hero-copy
            className="relative flex min-h-[clamp(660px,calc(100svh-6.75rem),980px)] flex-col items-center justify-center px-5 pt-14 pb-[clamp(200px,23.6cqw,312px)] text-center sm:px-10 sm:pt-16"
          >
            <a
              data-hero-fade
              data-reveal
              data-hover
              href="#devices"
              className="group/ann inline-flex max-w-full items-center gap-2.5 rounded-full border border-white/20 bg-white/[0.06] py-1.5 pr-1.5 pl-4 text-[13px] text-white/90 backdrop-blur-md transition-colors hover:border-white/35 hover:bg-white/10 sm:text-[14px]"
            >
              <span className="truncate">
                <span className="font-medium">New: Devices</span>
                <span className="text-white/60">
                  {" "}
                  · all your computers<span className="hidden sm:inline">, one agent</span>
                </span>
              </span>
              <span
                data-nudge="x"
                className="grid size-6 shrink-0 place-items-center rounded-full bg-white text-[#3b0f8f]"
              >
                <Icon icon={ArrowRight01Icon} size={14} strokeWidth={2.2} />
              </span>
            </a>

            <h1
              id="hero-title"
              data-hero-title
              data-reveal
              className="mt-8 max-w-[1000px] text-[40px] leading-[1.02] font-medium tracking-[-0.035em] [font-kerning:none] min-[400px]:text-[44px] sm:text-[56px] lg:text-[70px]"
            >
              <span data-title-line className="block sm:whitespace-nowrap">
                Every server. Every screen.
              </span>
              <span data-title-line className="block text-balance text-[#d8c4ff]">
                One agent on guard.
              </span>
            </h1>

            <p
              data-hero-fade
              data-reveal
              className="mt-6 max-w-[700px] text-[17px] leading-relaxed text-balance text-white/80 sm:text-[19px]"
            >
              It lives inside every machine you own. It watches every screen, moves the cursor on its own, and never
              sleeps.
            </p>

            <div
              data-hero-fade
              data-reveal
              className="relative z-20 mt-9 flex flex-wrap items-center justify-center gap-3"
            >
              <DownloadButton tone="light" />
            </div>
          </div>

          {/* Captions along the foot of the scene */}
          <div
            data-hero-fade
            data-reveal
            className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 px-5 pb-4 font-mono text-[11.5px] tracking-wide text-white/60 sm:px-7 sm:pb-5 sm:text-[12px]"
          >
            <p>
              v<AppVersion /> · free · Windows, macOS, Linux
            </p>
            <div className="flex items-center gap-5">
              <a
                href="#runtimes"
                className="hidden text-white/70 underline decoration-white/25 underline-offset-4 transition-colors hover:text-white hover:decoration-white md:inline"
              >
                on the agent you already use
              </a>
              <SoundToggle variant="label" className="text-white/70" />
            </div>
          </div>
        </div>
      </Container>
    </section>
  );
}
