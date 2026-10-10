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

      gsap.set(title, { autoAlpha: 1 });
      SplitText.create(title, {
        type: "lines",
        mask: "lines",
        linesClass: "split-line",
        autoSplit: true,
        onSplit: (self) =>
          gsap.from(self.lines, { yPercent: 115, duration: 1.3, ease: "expo.out", stagger: 0.1, delay: 0.25 }),
      });

      gsap.fromTo(
        fades,
        { autoAlpha: 0, y: 14 },
        { autoAlpha: 1, y: 0, duration: 1, ease: "expo.out", stagger: 0.08, delay: 0.5, clearProps: "transform" },
      );

      gsap.fromTo(
        el.querySelector("[data-panel]"),
        { clipPath: "inset(6% 4% 6% 4% round 28px)" },
        { clipPath: "inset(0% 0% 0% 0% round 20px)", duration: 1.6, ease: "expo.out" },
      );
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
              href={site.latest}
              target="_blank"
              rel="noopener noreferrer"
              className="group/ann inline-flex max-w-full items-center gap-2.5 rounded-full border border-white/20 bg-white/[0.06] py-1.5 pr-1.5 pl-4 text-[13px] text-white/90 backdrop-blur-md transition-colors hover:border-white/35 hover:bg-white/10 sm:text-[14px]"
            >
              <span className="truncate">
                <span className="font-medium">
                  Acestes <AppVersion />
                </span>
                <span className="text-white/60"> · charts in replies, split view with terminals</span>
              </span>
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-white text-[#3b0f8f] transition-transform group-hover/ann:translate-x-0.5">
                <Icon icon={ArrowRight01Icon} size={14} strokeWidth={2.2} />
              </span>
            </a>

            <h1
              id="hero-title"
              data-hero-title
              data-reveal
              className="mt-8 max-w-[1000px] text-[40px] leading-[1.02] font-medium tracking-[-0.035em] min-[400px]:text-[44px] sm:text-[56px] lg:text-[70px]"
            >
              <span className="block sm:whitespace-nowrap">Every agent. Every account.</span>
              <span className="block text-[#d8c4ff]">One app.</span>
            </h1>

            <p
              data-hero-fade
              data-reveal
              className="mt-6 max-w-[680px] text-[17px] leading-relaxed text-balance text-white/80 sm:text-[19px]"
            >
              Acestes runs Claude Code, Codex, Cursor and ten more on all your accounts, with memory, computer use and
              your servers built in.
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
                  all 13 runtimes
                </a>
              </span>
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}
