"use client";

import { useRef, useState } from "react";
import { RefreshIcon, Notebook01Icon } from "@hugeicons/core-free-icons";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { Section } from "../frame";
import { Icon } from "../icon";
import { TermLines, TermWindow, type TermLine } from "../terminal";
import { Bracket } from "../ui";

const prompts = [
  "remember that staging builds skip the npm cache",
  "how did we fix the 502s on web-02 last time?",
  "forget the note about the old VPN, it's gone",
];

const steps = [
  { lead: "Keeps what matters.", body: "one fact per note, short and specific" },
  { lead: "Finds it by meaning.", body: "the note turns up however you word it" },
  { lead: "Rereads the past.", body: "any earlier conversation, read back when it counts" },
];

const output: TermLine[] = [
  { k: "cmd", t: "session ended" },
  { k: "tag", tag: "remembered", t: "staging builds skip the npm cache" },
  { k: "tag", tag: "remembered", t: "web-02 sits behind Cloudflare" },
  { k: "tag", tag: "remembered", t: "you want small commits, one fix each" },
  { k: "tag", tag: "forgot", tone: "warn", t: "old VPN gateway, decommissioned" },
  { k: "ok", t: "3 new notes · 41 in the notebook" },
];

export function Memory() {
  const root = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(0);

  useGSAP(
    () => {
      const el = root.current;
      if (!el || prefersReducedMotion()) return;
      const q = gsap.utils.selector(el);

      // Statement: lead stays bright, the rest warms up word by word.
      gsap.fromTo(
        q("[data-statement] [data-w]"),
        { opacity: 0.15 },
        {
          opacity: 1,
          stagger: 0.05,
          ease: "none",
          scrollTrigger: { trigger: q("[data-statement]")[0], start: "top 80%", end: "bottom 55%", scrub: 0.5 },
        },
      );

      // Typed prompt that cycles through a few asks.
      const typed = q("[data-prompt]")[0];
      gsap.set(typed, { text: "" });
      const loop = gsap.timeline({ repeat: -1, paused: true });
      prompts.forEach((p) => {
        loop
          .to(typed, { text: p, duration: p.length * 0.035, ease: "none" })
          .to({}, { duration: 2.2 })
          .to(typed, { text: "", duration: 0.5, ease: "none" });
      });

      // Steps light up in turn while the notebook fills in.
      const stepEls = q("[data-mstep]");
      const lines = q("[data-out] [data-line]");
      const tl = gsap.timeline({ paused: true });
      tl.set(lines, { autoAlpha: 0, y: 6 });
      stepEls.forEach((s, i) => {
        tl.to(stepEls, { opacity: 0.4, duration: 0.3 }, i === 0 ? 0 : ">")
          .to(s, { opacity: 1, duration: 0.3 }, "<")
          .fromTo(q(`[data-mbar="${i}"]`), { scaleY: 0 }, { scaleY: 1, duration: 1.1, ease: "power2.inOut" }, "<")
          .to(lines.slice(i * 2, i * 2 + 2), { autoAlpha: 1, y: 0, stagger: 0.25, duration: 0.4 }, "<0.2");
      });
      tl.to(stepEls, { opacity: 1, duration: 0.4 }, "+=0.3");

      const play = () => {
        loop.play();
        tl.play();
      };
      const st = ScrollTrigger.create({ trigger: el, start: "top 70%", once: true, onEnter: play });
      if (run > 0) {
        st.kill();
        play();
      }
    },
    { scope: root, dependencies: [run], revertOnUpdate: true },
  );

  const statementLead = "Hello, memory.";
  const statementRest =
    "A notebook it keeps for you: short facts in plain text you can edit, searched by meaning, there the next morning.";

  return (
    <Section id="memory" label="Memory">
      <div ref={root}>
        {/* Statement */}
        <div className="grid border-b border-line lg:grid-cols-2">
          <h2
            data-statement
            className="px-5 py-14 text-[26px] leading-[1.25] font-medium tracking-[-0.03em] sm:px-12 sm:py-20 sm:text-[32px] lg:col-span-2 lg:max-w-[820px] lg:px-16"
          >
            <span className="text-fg">{statementLead}</span>{" "}
            <span className="text-muted">
              {statementRest.split(" ").map((w, i) => (
                <span key={i} data-w className="inline-block whitespace-pre">
                  {w}{" "}
                </span>
              ))}
            </span>
          </h2>
        </div>

        {/* Input row */}
        <div className="flex items-center gap-4 border-b border-line px-5 py-5 sm:px-12">
          <Bracket className="hidden sm:inline">Input</Bracket>
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-line text-muted">
            <Icon icon={Notebook01Icon} size={14} />
          </span>
          <p className="min-w-0 flex-1 truncate font-mono text-[13px] sm:text-[14px]" aria-hidden="true">
            <span data-prompt>{prompts[0]}</span>
            <span className="caret text-accent" />
          </p>
          <button
            type="button"
            onClick={() => setRun((r) => r + 1)}
            aria-label="Replay the memory animation"
            className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <Icon icon={RefreshIcon} size={15} />
          </button>
        </div>

        {/* Steps + output */}
        <div className="grid lg:grid-cols-2">
          <div className="flex flex-col border-b border-line lg:border-r lg:border-b-0">
            <div className="px-5 pt-8 sm:px-12">
              <Bracket>Thinking</Bracket>
            </div>
            <ol className="flex-1">
              {steps.map((s, i) => (
                <li
                  key={s.lead}
                  data-mstep
                  className="relative border-b border-line px-5 py-7 last:border-b-0 sm:px-12"
                >
                  <span
                    aria-hidden="true"
                    data-mbar={i}
                    className="absolute inset-y-0 left-0 w-[2px] origin-top scale-y-0 bg-accent"
                  />
                  <p className="text-[18px] leading-snug tracking-[-0.015em] sm:text-[20px]">
                    <span className="font-medium">{s.lead}</span> <span className="text-muted">{s.body}</span>
                  </p>
                </li>
              ))}
            </ol>
          </div>
          <div className="flex flex-col gap-3 p-4 sm:p-5">
            <div data-out>
              <TermWindow title="~/notebook" bodyClassName="min-h-[220px]">
                <TermLines lines={output} />
              </TermWindow>
            </div>
            <div className="flex items-center justify-between px-1">
              <Bracket>Output</Bracket>
              <span className="text-[13px] text-muted">Plain text, on your machine.</span>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
