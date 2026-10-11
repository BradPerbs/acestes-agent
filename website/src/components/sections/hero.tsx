"use client";

import { AppVersion } from "@/components/app-version";
import { useRef } from "react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { site } from "@/lib/site";
import { gsap, prefersReducedMotion, SplitText, useGSAP } from "@/lib/gsap";
import { DownloadButton } from "../download-button";
import { Container } from "../frame";
import { Halftone } from "../halftone";
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
          className="relative isolate overflow-hidden rounded-[20px] bg-[#07050d] text-white"
          style={{ clipPath: "inset(0% 0% 0% 0% round 20px)" }}
        >
          {/* Violet haze and the rising glow */}
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10"
            style={{
              background:
                "radial-gradient(120% 70% at 50% 115%, #f5edff 0%, #c4a5ff 14%, #8b5cf6 30%, #5b21b6 50%, #24104f 70%, #07050d 92%)",
            }}
          />
          <Halftone className="absolute inset-0 -z-10 opacity-90" />
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 -z-10 h-40 bg-gradient-to-b from-[#07050d] to-transparent"
          />

          <div className="relative flex flex-col items-center px-5 pt-16 pb-24 text-center sm:px-10 sm:pt-24 sm:pb-36 lg:pt-28 lg:pb-40">
            <a
              data-hero-fade
              data-reveal
              data-hover
              href={site.latest}
              target="_blank"
              rel="noopener noreferrer"
              className="group/ann inline-flex max-w-full items-center gap-2.5 rounded-full border border-white/20 bg-white/[0.06] py-1.5 pr-1.5 pl-4 text-[13px] text-white/90 backdrop-blur-md transition-colors hover:border-white/35 hover:bg-white/10 sm:text-[14px]"
            >
              <span className="truncate">
                <span className="font-medium">
                  Acestes <AppVersion />
                </span>
                <span className="text-white/60"> · computer use, rebuilt</span>
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
              The desktop agent for security and IT work. It audits and hardens your fleet over SSH, works the apps that
              have no API with the real mouse and keyboard, and asks before it changes anything.
            </p>

            <div
              data-hero-fade
              data-reveal
              className="relative z-20 mt-9 flex flex-wrap items-center justify-center gap-3"
            >
              <DownloadButton tone="light" />
            </div>

            <p
              data-hero-fade
              data-reveal
              className="mt-6 rounded-full bg-black/25 px-3 py-1 font-mono text-[12px] tracking-wide text-white/75 backdrop-blur-sm"
            >
              v<AppVersion /> · free · Windows, macOS, Linux
              <span className="hidden sm:inline">
                {" "}
                ·{" "}
                <a
                  href="#runtimes"
                  className="text-white/80 underline decoration-white/30 underline-offset-4 hover:decoration-white"
                >
                  on the agent you already use
                </a>
              </span>
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}
