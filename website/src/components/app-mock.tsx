"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  Calendar03Icon,
  Cancel01Icon,
  CommandLineIcon,
  Copy01Icon,
  Edit02Icon,
  File01Icon,
  Home01Icon,
  ImageAdd01Icon,
  Layers01Icon,
  LinkSquare02Icon,
  Menu01Icon,
  Mic01Icon,
  Notification03Icon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  Settings01Icon,
  Shield01Icon,
  SidebarLeftIcon,
  SplitIcon,
  StopCircleIcon,
  Tick02Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { gsap, prefersReducedMotion, ScrollTrigger, SplitText, useGSAP } from "@/lib/gsap";
import { Helmet } from "./brand";
import { BrandIcon, Icon } from "./icon";

/*
 * A replica of the Acestes window on its Black theme, drawn at the app's own
 * size and scaled to fit. Surfaces, type and spacing come from the renderer
 * (src/renderer: app-colors.js, ToolCall, ToolGroup, ApprovalRequest,
 * DiffView, ModelMenu) and the session is the one in the README demo.
 */

const W = 1200;
const H = 760;
const VIOLET = "#a271ff";

// Black theme surfaces (app-colors.js)
const RAISED = "#0a0a0a";
const CONTROL = "#141414";

const TITLE = "Checkout tests failing after #212";
const MONO = "font-[family-name:var(--font-app-mono)]";

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Code({ children }: { children: ReactNode }) {
  return (
    <code className={`rounded-[4px] bg-white/[0.08] px-1 py-px ${MONO} text-[12px] text-gray-100`}>{children}</code>
  );
}

/** Assistant prose. It reveals as it streams in, over a hidden copy that holds the space. */
function Prose({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div data-step={name} className="text-[14px] leading-[22px] text-gray-100">
      <div className="grid">
        <div className="invisible col-start-1 row-start-1">{children}</div>
        <div data-type className="col-start-1 row-start-1">
          {children}
        </div>
      </div>
    </div>
  );
}

/** A finished tool call: ToolCall.jsx's verb row. */
function ToolRow({
  name,
  icon,
  label,
  detail,
  mono,
  chip,
  open,
  children,
}: {
  name: string;
  icon?: IconSvgElement;
  label: string;
  detail?: string;
  mono?: boolean;
  chip?: string;
  open?: boolean;
  children?: ReactNode;
}) {
  return (
    <div data-step={name} className="overflow-hidden rounded-lg bg-white/[0.035]">
      <div className="flex h-8 items-center gap-2 px-2.5">
        {icon ? (
          <Icon icon={icon} size={14} strokeWidth={2} className="shrink-0 text-gray-500" />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
        )}
        <span className="shrink-0 text-[11px] font-medium text-gray-400">{label}</span>
        {chip ? (
          <span className="flex max-w-[60%] min-w-0 items-center gap-1.5 truncate rounded-md bg-white/[0.07] px-1.5 py-0.5 text-[11px] text-gray-300">
            <Icon icon={File01Icon} size={12} strokeWidth={2} className="shrink-0 text-gray-500" />
            <span className={`truncate ${MONO}`}>{chip}</span>
          </span>
        ) : (
          detail && (
            <span className={`min-w-0 flex-1 truncate text-[11px] text-gray-500 ${mono ? MONO : ""}`}>{detail}</span>
          )
        )}
        <Icon
          icon={ArrowDown01Icon}
          size={13}
          strokeWidth={2}
          className={`ml-auto shrink-0 text-gray-600 ${open ? "rotate-180" : ""}`}
        />
      </div>
      {children}
    </div>
  );
}

/** DiffView.jsx: path and counts, then the lines with their numbers. */
function Diff() {
  const row = "flex leading-[1.55]";
  const num = "w-9 shrink-0 pr-2 text-right tabular-nums text-neutral-600";
  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <span className={`min-w-0 flex-1 truncate ${MONO} text-[11px] text-gray-400`}>
          C:\src\checkout-service\src\discount.js
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium tabular-nums">
          <span className="text-emerald-400">+1</span>
          <span className="text-red-400">-1</span>
        </span>
      </div>
      <div className={`${MONO} pb-1 text-[11px]`}>
        <div className={`${row} text-gray-500`}>
          <span className={num}>11</span>
          <span className="w-3 shrink-0 text-transparent"> </span>
          <span className="pr-2.5 whitespace-pre">export function applyDiscount(cents, percent) {"{"}</span>
        </div>
        <div className={`${row} bg-red-500/[0.09] text-red-300`}>
          <span className={num}>12</span>
          <span className="w-3 shrink-0 text-red-400">-</span>
          <span className="pr-2.5 whitespace-pre"> return cents * (1 - percent / 100);</span>
        </div>
        <div className={`${row} bg-emerald-500/[0.10] text-emerald-300`}>
          <span className={num}>12</span>
          <span className="w-3 shrink-0 text-emerald-400">+</span>
          <span className="pr-2.5 whitespace-pre"> return Math.round(cents * (100 - percent) / 100);</span>
        </div>
        <div className={`${row} text-gray-500`}>
          <span className={num}>13</span>
          <span className="w-3 shrink-0 text-transparent"> </span>
          <span className="pr-2.5 whitespace-pre">{"}"}</span>
        </div>
      </div>
    </div>
  );
}

/** ApprovalRequest.jsx's three answers. */
function Choices() {
  const choice =
    "flex min-h-9 w-full items-center gap-2.5 rounded-lg bg-[#141414]/60 px-2.5 py-2 text-left text-[12px] font-medium text-gray-200";
  const glyph = "flex size-4 shrink-0 items-center justify-center text-neutral-500";
  return (
    <div className="space-y-1.5">
      <div data-allow className={choice}>
        <span className={glyph}>
          <Icon icon={Tick02Icon} size={14} strokeWidth={2.5} />
        </span>
        Allow
      </div>
      <div className={choice}>
        <span className={glyph}>
          <Icon icon={Cancel01Icon} size={13} strokeWidth={2.5} />
        </span>
        Decline
      </div>
      <div className={choice}>
        <span className={glyph}>
          <Icon icon={Edit02Icon} size={13} strokeWidth={2} />
        </span>
        Something else...
      </div>
    </div>
  );
}

function Card({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <div
      data-card={name}
      className="overflow-hidden rounded-xl border shadow-sm"
      style={{ background: RAISED, borderColor: CONTROL, display: "none" }}
    >
      <div className="flex h-8 items-center gap-2 border-b px-2.5" style={{ borderColor: CONTROL }}>
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
        <span className="shrink-0 text-[11px] font-semibold text-white">{title}</span>
      </div>
      <div className="space-y-2 p-2">
        {children}
        <Choices />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

export function AppMock() {
  const frame = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1000 / W);
  const [run, setRun] = useState(0);

  // Fit the full-size window to the column it sits in.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / W);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const q = gsap.utils.selector(el);
      const viewport = q("[data-viewport]")[0] as HTMLElement;
      const inner = q("[data-inner]")[0] as HTMLElement;
      const pinned = q("[data-pinned]")[0] as HTMLElement;
      const steps = q("[data-step]");
      const busy = q("[data-busy]");
      const tokens = q("[data-tokens]")[0];
      const toBottom = () => -Math.max(0, inner.scrollHeight - viewport.clientHeight);

      if (prefersReducedMotion()) {
        gsap.set(steps, { display: "", autoAlpha: 1 });
        gsap.set(busy, { autoAlpha: 0 });
        gsap.set(inner, { y: toBottom() });
        return;
      }

      gsap.set(steps, { display: "none", autoAlpha: 0 });
      gsap.set(busy, { autoAlpha: 0 });

      const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out", duration: 0.45 } });

      const follow = (at: string | number = "<") => tl.to(inner, { y: toBottom, duration: 0.5 }, at);

      const show = (name: string, at: string | number = "+=0.35") => {
        const node = q(`[data-step="${name}"]`);
        tl.set(node, { display: "" }, at);
        follow();
        tl.fromTo(node, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0 }, "<");
      };

      // Prose streams in line by line as the reply arrives.
      const say = (name: string, at: string | number = "+=0.35", pace = 0.045) => {
        const node = q(`[data-step="${name}"]`)[0] as HTMLElement;
        const typed = node.querySelector<HTMLElement>("[data-type]");
        tl.set(node, { display: "", autoAlpha: 1 }, at);
        follow();
        if (!typed) return;
        // Word by word, the way a reply arrives. The hidden copy underneath
        // already holds the space, so nothing reflows.
        const { words } = SplitText.create(typed, { type: "words" });
        gsap.set(words, { autoAlpha: 0 });
        tl.to(words, { autoAlpha: 1, duration: 0.12, stagger: pace, ease: "none" }, "<");
      };

      const cursor = q("[data-cursor]")[0] as HTMLElement;
      // Pin an approval card above the composer, then a pointer clicks Allow.
      const approve = (card: string) => {
        const node = q(`[data-card="${card}"]`)[0] as HTMLElement;
        const allow = node.querySelector<HTMLElement>("[data-allow]")!;
        tl.set(node, { display: "" }, "+=0.35");
        tl.fromTo(pinned, { height: 0 }, { height: "auto", duration: 0.5 }, "<");
        tl.to(inner, { y: toBottom, duration: 0.35 }, "<0.3");
        tl.fromTo(node, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0 }, "<0.05");
        const target = () => {
          const r = el.getBoundingClientRect();
          const a = allow.getBoundingClientRect();
          const k = r.width / W;
          return { x: (a.left - r.left) / k + 140, y: (a.top - r.top + a.height / 2) / k };
        };
        tl.fromTo(
          cursor,
          { autoAlpha: 0, x: W * 0.84, y: H * 0.98 },
          { autoAlpha: 1, x: () => target().x, y: () => target().y, duration: 1, ease: "power3.inOut" },
          "+=0.5",
        );
        tl.to(allow, { backgroundColor: "#1f1f1f", duration: 0.15 }, "-=0.2");
        tl.to(allow, { scale: 0.985, duration: 0.08 }, "+=0.25").to(allow, { scale: 1, duration: 0.15 });
        tl.to(pinned, { height: 0, duration: 0.4, ease: "power3.inOut" }, "+=0.1");
        tl.to(inner, { y: toBottom, duration: 0.4 }, ">");
        tl.to(node, { autoAlpha: 0, duration: 0.25 }, "<");
        tl.to(cursor, { autoAlpha: 0, y: "+=30", duration: 0.4 }, "<");
        tl.set(node, { display: "none" });
        tl.set(allow, { clearProps: "backgroundColor,transform" });
      };

      tl.set(busy, { autoAlpha: 1 }, 0);
      show("user", 0.15);
      say("p1", "+=0.6");
      show("recall");
      say("p2");
      approve("run");
      show("run1", "-=0.1");
      say("p3", "+=0.5");
      show("gitlog");
      say("p4", "+=0.5");
      approve("edit");
      show("edit", "-=0.1");
      say("p5");
      show("run2");
      say("p6", "+=0.6");
      show("group");
      say("p7", "+=0.5", 0.035);
      tl.to(busy, { autoAlpha: 0, duration: 0.3 });
      tl.to(tokens, { textContent: 9.4, duration: 1, snap: { textContent: 0.1 }, ease: "power1.out" }, "<");

      tl.timeScale(1.15);
      const st = ScrollTrigger.create({ trigger: el, start: "top 75%", once: true, onEnter: () => tl.play() });
      if (run > 0) {
        st.kill();
        tl.play();
      }
    },
    { scope: root, dependencies: [run], revertOnUpdate: true },
  );

  return (
    <div className="relative w-full">
      <button
        type="button"
        onClick={() => setRun((r) => r + 1)}
        aria-label="Replay the demo"
        className="absolute -top-11 right-0 z-10 flex h-8 items-center gap-1.5 rounded-full border border-line bg-bg px-3 text-[13px] text-muted transition-colors hover:text-fg"
      >
        <Icon icon={RefreshIcon} size={14} />
        Replay
      </button>
      <div
        ref={frame}
        className="relative w-full overflow-hidden rounded-[12px] bg-black shadow-[0_40px_120px_-30px_rgb(0_0_0/0.7)] ring-1 ring-white/[0.12]"
        style={{ height: H * scale }}
      >
        <p className="sr-only">
          A replica of the Acestes Agent window: the agent checks its memory, runs the test suite, finds the commit that
          broke it, asks before editing a file, runs the tests again and schedules a nightly check.
        </p>
        <div
          ref={root}
          aria-hidden="true"
          className="absolute top-0 left-0 origin-top-left overflow-hidden bg-black font-[family-name:var(--font-app)] text-[14px] text-gray-100 antialiased select-none"
          style={{ width: W, height: H, transform: `scale(${scale})` }}
        >
          {/* ---------------- Title bar ---------------- */}
          <div className="flex h-[52px] items-center pr-1 pl-2">
            <span className="grid size-9 place-items-center text-gray-300">
              <Icon icon={Menu01Icon} size={20} strokeWidth={1.75} />
            </span>
            <span className="grid size-9 place-items-center text-gray-400">
              <Icon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
            </span>
            <div className="ml-2 flex items-center gap-2">
              <span
                className="flex h-8 items-center gap-2 rounded-[10px] px-3 text-[13px] font-medium text-gray-300"
                style={{ background: RAISED }}
              >
                <Icon icon={Home01Icon} size={14} strokeWidth={2} className="text-gray-400" />
                Home
              </span>
              <span
                className="flex h-8 w-[172px] items-center gap-2 rounded-[10px] px-3 text-[13px] font-semibold text-white"
                style={{ background: CONTROL }}
              >
                <Helmet size={15} color={VIOLET} />
                <span className="min-w-0 overflow-hidden [mask-image:linear-gradient(90deg,#000_80%,transparent)] whitespace-nowrap">
                  {TITLE}
                </span>
              </span>
              <span className="grid size-8 place-items-center text-gray-400">
                <Icon icon={PlusSignIcon} size={16} strokeWidth={2} />
              </span>
            </div>
            <div className="ml-auto flex items-center text-gray-400">
              <span className="relative grid size-10 place-items-center">
                <Icon icon={Notification03Icon} size={18} strokeWidth={1.75} />
                <span
                  data-busy
                  className="absolute top-2 right-2 size-2 rounded-full border-2 border-black bg-emerald-400"
                />
              </span>
              <span className="grid h-10 w-11 place-items-center">
                <span className="h-px w-3 bg-current" />
              </span>
              <span className="grid h-10 w-11 place-items-center">
                <span className="size-[11px] rounded-[2px] border border-current" />
              </span>
              <span className="grid h-10 w-11 place-items-center">
                <Icon icon={Cancel01Icon} size={17} strokeWidth={1.75} />
              </span>
            </div>
          </div>

          {/* ---------------- Body ---------------- */}
          <div className="flex" style={{ height: H - 52 - 22 }}>
            {/* Sidebar */}
            <div className="flex w-[232px] shrink-0 flex-col px-2">
              <div className="rounded-xl p-1.5" style={{ background: RAISED }}>
                <div className="flex h-[52px] items-center gap-3 px-2.5">
                  <Helmet size={28} color={VIOLET} />
                  <span className="leading-tight">
                    <span className="block text-[14px] font-semibold text-white">Acestes</span>
                    <span className="block text-[12px] text-gray-500">Agent</span>
                  </span>
                  <Icon icon={UnfoldMoreIcon} size={14} strokeWidth={2} className="ml-auto text-gray-500" />
                </div>
                <div className="mx-2 my-1 h-px bg-white/[0.06]" />
                {[
                  { i: Layers01Icon, t: "Inventory" },
                  { i: Settings01Icon, t: "Settings" },
                ].map((x) => (
                  <div key={x.t} className="flex h-9 items-center gap-3 px-2.5 text-[14px] text-gray-300">
                    <Icon icon={x.i} size={16} strokeWidth={1.75} className="text-gray-500" />
                    {x.t}
                  </div>
                ))}
              </div>

              <div className="mt-6 flex items-center px-2.5">
                <span className="text-[13px] font-semibold text-white">Conversations</span>
                <Icon icon={Search01Icon} size={16} strokeWidth={2} className="ml-auto text-gray-400" />
                <Icon icon={PlusSignIcon} size={16} strokeWidth={2} className="ml-3 text-gray-400" />
              </div>
              <div className="mt-2 space-y-0.5">
                <div
                  className="flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-[14px] text-white"
                  style={{ background: CONTROL }}
                >
                  <span data-busy className="size-1 shrink-0 rounded-full bg-gray-400" />
                  <span className="min-w-0 overflow-hidden [mask-image:linear-gradient(90deg,#000_82%,transparent)] whitespace-nowrap">
                    {TITLE}
                  </span>
                </div>
                {["Slow staging builds since Monday", "Playbook for checkout staging deploys"].map((c) => (
                  <div key={c} className="flex h-[34px] items-center px-2.5 text-[14px] text-gray-300">
                    <span className="min-w-0 overflow-hidden [mask-image:linear-gradient(90deg,#000_82%,transparent)] whitespace-nowrap">
                      {c}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Conversation panel */}
            <div
              className="mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl"
              style={{ background: RAISED }}
            >
              {/* Header */}
              <div className="flex h-11 shrink-0 items-center border-b border-white/[0.06] pr-2 pl-4">
                <Helmet size={16} color={VIOLET} />
                <span className="ml-2.5 truncate text-[14px] font-semibold text-white">{TITLE}</span>
                <span className="ml-auto flex w-[260px] items-center justify-center text-[13px] font-semibold text-white">
                  No session open
                </span>
                <Icon icon={ArrowDown01Icon} size={12} strokeWidth={2} className="mr-6 text-gray-500" />
                {[Copy01Icon, Calendar03Icon, SplitIcon, LinkSquare02Icon].map((i, n) => (
                  <span key={n} className="grid size-9 place-items-center text-gray-400">
                    <Icon icon={i} size={16} strokeWidth={1.75} />
                  </span>
                ))}
              </div>

              {/* Transcript */}
              <div data-viewport className="relative min-h-0 flex-1 overflow-hidden">
                <div data-inner className="mx-auto flex w-[744px] flex-col gap-3 pt-3 pb-5">
                  <div data-step="user" className="flex justify-end">
                    <div className="max-w-[80%] rounded-[10px] bg-white px-3 py-2 text-[14px] leading-[20px] text-black">
                      The checkout tests started failing after this morning&apos;s merge. Find out why and fix it.
                    </div>
                  </div>

                  <Prose name="p1">Checking my notes on this service first.</Prose>
                  <ToolRow name="recall" icon={Search01Icon} label="Search" detail="query: checkout-service tests" />
                  <Prose name="p2">
                    Tests run with <Code>npm test</Code>, and prices here are integer cents. Running the suite.
                  </Prose>
                  <ToolRow name="run1" icon={CommandLineIcon} label="Run" detail="npm test" mono />
                  <Prose name="p3">
                    Two failures, both in totals: <Code>1799.1</Code> where <Code>1799</Code> was expected. Something is
                    producing fractions of a cent. Looking at what changed this morning.
                  </Prose>
                  <ToolRow
                    name="gitlog"
                    icon={CommandLineIcon}
                    label="Run"
                    detail={'git log -1 -p --format="%h %s (%ar)" -- src/discount.js'}
                    mono
                  />
                  <Prose name="p4">
                    Found it. <strong className="font-semibold">#212</strong> replaced the rounded integer math with{" "}
                    <Code>cents * (1 - percent / 100)</Code>, which returns fractional cents. Putting the rounding back:
                  </Prose>
                  <ToolRow name="edit" icon={Edit02Icon} label="Edit" chip="discount.js" open>
                    <div className="border-t border-white/[0.06]">
                      <Diff />
                    </div>
                  </ToolRow>
                  <Prose name="p5">Running the suite again.</Prose>
                  <ToolRow name="run2" icon={CommandLineIcon} label="Run" detail="npm test" mono />
                  <Prose name="p6">All 4 pass. Writing down what this was, so next time I check it first.</Prose>

                  {/* ToolGroup.jsx: back-to-back calls fold into one row */}
                  <div data-step="group" className="overflow-hidden rounded-lg bg-white/[0.035]">
                    <div className="flex h-8 items-center gap-2 px-2.5">
                      <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
                      <span className="shrink-0 text-[11px] font-medium text-gray-400">2 tool calls</span>
                      <span className="text-[11px] text-gray-500">2 others</span>
                      <span className="ml-auto flex items-center gap-1 text-[11px] text-gray-600">
                        Show all
                        <Icon icon={ArrowDown01Icon} size={13} strokeWidth={2} />
                      </span>
                    </div>
                  </div>

                  <Prose name="p7">
                    <strong className="font-semibold">Fixed.</strong> The checkout suite is green again, 4 of 4.{" "}
                    <strong className="font-semibold">#212</strong> changed <Code>applyDiscount</Code> to fractional
                    math, so $19.99 at 10% off came out as <Code>1799.1</Code> cents. I put the rounding back, noted why
                    in memory, and a nightly job now runs the suite at 02:00.
                  </Prose>
                </div>
              </div>

              {/* Pending approval, pinned above the composer */}
              <div data-pinned className="shrink-0 overflow-hidden" style={{ height: 0 }}>
                <div className="mx-auto w-[768px] border-t border-white/[0.06] px-3 pt-3 pb-1">
                  <Card name="run" title="Run a command on this computer">
                    <div
                      className={`rounded-lg bg-black/30 px-2.5 py-2 ${MONO} text-[11px] leading-[1.6] text-gray-100`}
                    >
                      npm test
                    </div>
                    <p className="flex items-start gap-1.5 px-0.5 text-[11px] leading-snug text-gray-400">
                      <Icon icon={Alert02Icon} size={13} strokeWidth={2} className="mt-px shrink-0 text-amber-500" />
                      This runs on your own computer, not on a server.
                    </p>
                  </Card>
                  <Card name="edit" title="Edit a file">
                    <div className="overflow-hidden rounded-lg bg-black/30">
                      <Diff />
                    </div>
                  </Card>
                </div>
              </div>

              {/* Composer */}
              <div className="shrink-0 px-4 pt-2 pb-3">
                <div
                  className="mx-auto w-[744px] rounded-2xl border border-white/[0.07]"
                  style={{ background: RAISED }}
                >
                  <div className="px-3.5 pt-3 text-[14px] text-gray-600">Ask about your servers</div>
                  <div className="flex h-11 items-center gap-1 px-2">
                    <span className="flex h-7 items-center gap-0.5 rounded-lg px-1.5 text-gray-500">
                      <Icon icon={Shield01Icon} size={15} strokeWidth={1.75} />
                      <Icon icon={ArrowDown01Icon} size={10} strokeWidth={2} />
                    </span>
                    <span className="grid size-7 place-items-center text-[15px] font-medium text-gray-300">@</span>
                    <span className="grid size-7 place-items-center text-gray-400">
                      <Icon icon={ImageAdd01Icon} size={16} strokeWidth={1.75} />
                    </span>
                    <span className="ml-auto flex h-7 items-center gap-1 rounded-xl pr-1.5 pl-2 text-[11px] text-gray-400">
                      <BrandIcon name="claude" size={12} className="text-gray-400" />
                      <span className="font-medium">Opus 5.5</span>
                      <span className="opacity-60">Extra high</span>
                      <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="opacity-60" />
                    </span>
                    <span className="grid size-7 place-items-center text-gray-400">
                      <Icon icon={Mic01Icon} size={16} strokeWidth={1.75} />
                    </span>
                    <span data-busy className="grid size-7 place-items-center text-gray-300">
                      <Icon icon={StopCircleIcon} size={17} strokeWidth={1.75} />
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- Status bar ---------------- */}
          <div className="flex h-[22px] items-center justify-between px-2.5 text-[10.5px] font-medium text-neutral-500 tabular-nums">
            <span className="flex items-center gap-2">
              <BrandIcon name="claude" size={10} />
              <span className="flex items-center gap-1.5">
                5h
                <span className="relative h-[3px] w-7 overflow-hidden rounded-full bg-white/[0.09]">
                  <span className="absolute inset-y-0 left-0 w-[23%] rounded-full bg-neutral-300/80" />
                </span>
                <span className="text-gray-300">23%</span>
              </span>
              <span className="mx-1 h-2.5 w-px bg-white/10" />
              <span>
                Today <span data-tokens>7.7</span>k tokens · 6 turns
              </span>
            </span>
            <span className="flex items-center gap-4">
              <span>726 MB</span>
              <span>1 tab</span>
            </span>
          </div>

          {/* Pointer */}
          <svg
            data-cursor
            width="20"
            height="20"
            viewBox="0 0 24 24"
            className="pointer-events-none invisible absolute top-0 left-0 z-20 drop-shadow-[0_2px_4px_rgb(0_0_0/0.5)]"
          >
            <path
              d="M4 2.5 20 11l-7.2 1.9L9 20z"
              fill="white"
              stroke="black"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
