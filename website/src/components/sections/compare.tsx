"use client";

import { useRef, useState, type ReactNode } from "react";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { gsap, prefersReducedMotion, ScrollTrigger, SplitText, useGSAP } from "@/lib/gsap";
import { Section } from "../frame";
import { Icon } from "../icon";

type Row = { tag?: string; tone?: "bad" | "ok" | "accent" | "muted"; children: ReactNode; align?: "right" };

const toneText = {
  bad: "text-bad",
  ok: "text-ok",
  accent: "text-accent",
  muted: "text-subtle",
} as const;

function Line({ tag, tone = "muted", children, align }: Row) {
  return (
    <div data-row className={`flex flex-col gap-1 ${align === "right" ? "items-end text-right" : ""}`}>
      {tag && (
        <span className={`font-mono text-[10.5px] tracking-[0.18em] uppercase ${toneText[tone]}`}>[ {tag} ]</span>
      )}
      <div className="text-[14.5px] leading-[1.55]">{children}</div>
    </div>
  );
}

export function Compare() {
  const root = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(0);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const q = gsap.utils.selector(el);
      if (prefersReducedMotion()) return;

      const titles = q("[data-title]").map((t) => SplitText.create(t, { type: "chars" }));
      const tl = gsap.timeline({ paused: true });
      titles.forEach((s, i) =>
        tl.fromTo(
          s.chars,
          { autoAlpha: 0, yPercent: 60, rotate: 4 },
          { autoAlpha: 1, yPercent: 0, rotate: 0, stagger: 0.025, duration: 0.7, ease: "back.out(2)" },
          i * 0.15,
        ),
      );

      const left = q('[data-pane="left"] [data-row]');
      const right = q('[data-pane="right"] [data-row]');
      tl.fromTo(
        left,
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, stagger: 0.55, duration: 0.5, ease: "power2.out" },
        0.5,
      );
      tl.fromTo(
        right,
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, stagger: 0.55, duration: 0.5, ease: "power2.out" },
        0.75,
      );

      const st = ScrollTrigger.create({ trigger: el, start: "top 65%", once: true, onEnter: () => tl.play() });
      if (run > 0) {
        st.kill();
        tl.play();
      }
    },
    { scope: root, dependencies: [run], revertOnUpdate: true },
  );

  return (
    <Section label="Without memory and with Acestes">
      <div ref={root} className="relative grid lg:grid-cols-2">
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          aria-label="Replay the comparison"
          className="absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-panel-2 hover:text-fg"
        >
          <Icon icon={RefreshIcon} size={15} />
        </button>

        {/* Without */}
        <div data-pane="left" className="border-b border-line lg:border-r lg:border-b-0">
          <div className="border-b border-line px-5 py-10 sm:px-12">
            <p data-title className="text-[34px] leading-none font-medium tracking-[-0.03em] text-muted sm:text-[42px]">
              Without memory
            </p>
            <p className="mt-3 text-[15px] text-muted">A chatbot. Every morning is day one.</p>
          </div>
          <div className="flex flex-col gap-5 px-5 py-8 sm:px-12">
            <Line tag="prompt" tone="muted">
              <span className="font-mono">&gt; web-02 is throwing 502s again</span>
            </Line>
            <Line>
              <span className="text-muted">✳ Which server is web-02? Could you paste the nginx logs?</span>
            </Line>
            <Line tag="again" tone="bad">
              <span className="font-mono">&gt; same box as yesterday. we fixed this.</span>
            </Line>
            <Line>
              <span className="text-muted">✳ I don&apos;t have access to previous conversations.</span>
            </Line>
            <Line tag="again" tone="bad">
              <span className="font-mono">&gt; the cert renewal thing??</span>
            </Line>
            <Line>
              <span className="text-muted">✳ Could you share your nginx config and certbot setup?</span>
            </Line>
            <Line tag="starting over" tone="bad">
              <span className="font-mono">&gt; never mind. I&apos;ll ssh in myself.</span>
            </Line>
          </div>
        </div>

        {/* With */}
        <div data-pane="right">
          <div className="border-b border-line px-5 py-10 sm:px-12">
            <p data-title className="text-[34px] leading-none font-medium tracking-[-0.03em] sm:text-[42px]">
              The next morning.
            </p>
            <p className="mt-3 text-[15px] text-muted">Acestes. After it knows you.</p>
          </div>
          <div className="flex flex-col gap-5 px-5 py-8 sm:px-12">
            <Line tag="prompt" tone="muted" align="right">
              <span className="font-mono">&gt; web-02 is throwing 502s again</span>
            </Line>
            <Line tag="recall" tone="accent">
              <span className="mark">
                web-02 sits behind Cloudflare. On Tuesday certbot renewed and nginx kept the old cert.
              </span>
            </Line>
            <Line>
              <span className="font-mono text-[13px]">
                <span className="text-accent">◆</span> ssh web-02 · sudo nginx -t <span className="text-ok">ok</span>
              </span>
            </Line>
            <Line tag="waiting on you" tone="accent">
              <span className="font-mono text-[13px]">sudo systemctl reload nginx</span>{" "}
              <span className="ml-1 rounded-md bg-accent-strong px-2 py-0.5 text-[12px] font-medium text-white">
                Allow
              </span>
            </Line>
            <Line>
              <span className="text-ok">✓</span> 502s gone. Same cause as Tuesday. I added a certbot deploy hook so
              nginx reloads itself, and a daily certificate check.
            </Line>
            <Line tag="remembered" tone="ok" align="right">
              <span className="font-mono">&gt; that&apos;s exactly it. thanks.</span>
            </Line>
          </div>
        </div>
      </div>
    </Section>
  );
}
