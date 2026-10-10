"use client";

import { useRef } from "react";
import { ArrowRight01Icon, UserIcon } from "@hugeicons/core-free-icons";
import { site } from "@/lib/site";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { Helmet } from "../brand";
import { Icon } from "../icon";
import { Reveal } from "../reveal";

/** The org chart: one seat per role. */
const SEATS = 32;
/** The seat left to a person. Someone has to sign off. */
const KEPT = 21;

const figures = [
  { value: "24/7", label: "at the desk" },
  { value: "0", label: "resignations" },
  { value: "1", label: "human to sign off" },
];

/**
 * The seats of an org chart, each a person, turning one by one into an
 * agent's helmet until a single person is left: the one who signs off.
 */
function Seats() {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const people = gsap.utils.toArray<HTMLElement>("[data-person]", el);
      const agents = gsap.utils.toArray<HTMLElement>("[data-agent]", el);
      const kept = el.querySelector<HTMLElement>("[data-kept]");
      const keptGlyph = el.querySelector<HTMLElement>("[data-kept-glyph]");

      const last = () => {
        gsap.set(kept, { borderColor: "rgb(185 150 255 / 0.65)" });
        gsap.set(keptGlyph, { color: "#ffffff" });
      };

      if (prefersReducedMotion()) {
        gsap.set(people, { autoAlpha: 0 });
        gsap.set(agents, { autoAlpha: 1 });
        last();
        return;
      }

      gsap.set(agents, { autoAlpha: 0, scale: 0.6 });

      const tl = gsap.timeline({ paused: true });
      const order = gsap.utils.shuffle(people.map((_, i) => i));
      order.forEach((i, n) => {
        const at = 0.3 + n * 0.08;
        tl.to(people[i], { autoAlpha: 0, scale: 0.6, duration: 0.22, ease: "power2.in" }, at);
        tl.to(agents[i], { autoAlpha: 1, scale: 1, duration: 0.4, ease: "back.out(2)" }, at + 0.14);
      });
      tl.to(kept, { borderColor: "rgb(185 150 255 / 0.65)", duration: 0.6, ease: "power2.out" }, "+=0.2");
      tl.to(keptGlyph, { color: "#ffffff", duration: 0.6, ease: "power2.out" }, "<");

      ScrollTrigger.create({ trigger: el, start: "top 80%", once: true, onEnter: () => tl.play() });
    },
    { scope: root },
  );

  return (
    <div ref={root} aria-hidden="true" className="grid grid-cols-8 gap-1.5">
      {Array.from({ length: SEATS }, (_, i) =>
        i === KEPT ? (
          <span
            key={i}
            data-kept
            className="relative grid aspect-square place-items-center rounded-lg border border-white/10 bg-white/[0.02]"
          >
            <span data-kept-glyph className="text-white/35">
              <Icon icon={UserIcon} size={16} strokeWidth={1.6} />
            </span>
          </span>
        ) : (
          <span
            key={i}
            className="relative grid aspect-square place-items-center rounded-lg border border-white/10 bg-white/[0.02]"
          >
            <span data-person className="absolute inset-0 grid place-items-center text-white/35">
              <Icon icon={UserIcon} size={16} strokeWidth={1.6} />
            </span>
            <span data-agent className="absolute inset-0 grid place-items-center">
              <Helmet size={18} color="rgb(255 255 255 / 0.78)" />
            </span>
          </span>
        ),
      )}
    </div>
  );
}

/**
 * The bespoke tier under the free one: an agent built to take a person's
 * seat, priced per role. Black in both themes, like the hero panel.
 */
export function Succession() {
  return (
    <div id="succession" className="scroll-mt-20 border-t border-line p-2 sm:p-3">
      <div className="relative overflow-hidden rounded-[20px] bg-[#050505] text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(rgb(255_255_255/0.06)_1px,transparent_1.4px)] [mask-image:radial-gradient(90%_80%_at_80%_20%,#000,transparent)] [background-size:16px_16px]"
        />
        <div className="relative grid gap-12 px-5 py-14 sm:px-12 sm:py-16 lg:grid-cols-12 lg:gap-10">
          <Reveal className="lg:col-span-7">
            <p data-r className="font-mono text-[12px] tracking-[0.2em] text-[#b996ff] uppercase">
              Acestes Succession · Bespoke
            </p>
            <h2
              data-r
              className="mt-5 max-w-[640px] text-[40px] leading-[1.02] font-medium tracking-[-0.04em] text-balance sm:text-[56px]"
            >
              Every role has a successor now.
            </h2>
            <p data-r className="mt-6 max-w-[620px] text-[16px] leading-relaxed text-white/65 sm:text-[17px]">
              From the front desk to the top floor. We study how a person works, what they decide and how they answer,
              then build the agent that takes their seat: a receptionist that never logs off, an analyst on every
              shift, or a cloud twin of the one person everyone asks, answering the whole company at once. The people
              who stay approve, decide and sign off.
            </p>
            <div
              data-r
              className="mt-10 grid max-w-[560px] grid-cols-3 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10"
            >
              {figures.map((f) => (
                <div key={f.label} className="bg-[#050505] px-4 py-4 sm:px-5 sm:py-5">
                  <p className="text-[28px] leading-none font-medium tracking-[-0.03em] tabular-nums sm:text-[34px]">
                    {f.value}
                  </p>
                  <p className="mt-2 text-[13px] leading-snug text-white/50">{f.label}</p>
                </div>
              ))}
            </div>
          </Reveal>

          <div className="lg:col-span-5">
            <Seats />
            <Reveal className="mt-10">
              <p data-r className="flex items-baseline gap-2">
                <span className="text-[56px] leading-none font-medium tracking-[-0.04em] tabular-nums">$10,000</span>
                <span className="text-[17px] text-white/55">/ role</span>
              </p>
              <p data-r className="mt-4 max-w-[440px] text-[15px] leading-relaxed text-white/65">
                Every successor is bespoke: built from the person it replaces, on your infrastructure, on the agent
                accounts you already pay for.
              </p>
              <div data-r className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <a
                  href={site.succession}
                  className="inline-flex h-11 items-center rounded-full bg-white px-5 text-[15px] font-medium tracking-[-0.01em] text-[#0d0818] transition-colors duration-200 hover:bg-white/90 active:scale-[0.985]"
                >
                  Start a succession
                </a>
                <a
                  href="#guardrails"
                  className="group/g inline-flex items-center gap-1.5 text-[15px] font-medium text-white/70 transition-colors hover:text-white"
                >
                  Read the guardrails
                  <Icon
                    icon={ArrowRight01Icon}
                    size={16}
                    strokeWidth={2}
                    className="transition-transform duration-200 group-hover/g:translate-x-0.5"
                  />
                </a>
              </div>
              <p data-r className="mt-8 border-t border-white/10 pt-5 text-[13px] leading-relaxed text-white/45">
                Successors still ask before anything irreversible. Make sure someone is left to answer.
              </p>
            </Reveal>
          </div>
        </div>
      </div>
    </div>
  );
}
