"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Alert02Icon,
  ArrowDown01Icon,
  Attachment01Icon,
  Cancel01Icon,
  Coffee02Icon,
  CommandLineIcon,
  Copy01Icon,
  CpuIcon,
  Edit02Icon,
  File01Icon,
  GitBranchIcon,
  Home01Icon,
  ImageAdd01Icon,
  Layers01Icon,
  LinkSquare02Icon,
  Mic01Icon,
  Notification03Icon,
  PlusMinusSquare01Icon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  Settings01Icon,
  Shield01Icon,
  SidebarLeftIcon,
  SplitIcon,
  StopCircleIcon,
  Tick02Icon,
  Undo02Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { gsap, prefersReducedMotion, ScrollTrigger, SplitText, useGSAP } from "@/lib/gsap";
import { Helmet } from "./brand";
import { BrandIcon, Icon } from "./icon";

/*
 * A replica of the Acestes window on its Black theme, drawn at the app's own
 * size and scaled to fit. Surfaces, type and spacing come from the renderer
 * (src/renderer: App.jsx, TitleBar, Sidebar, ConversationView, the composer in
 * AssistantConversation, ToolCall, ToolGroup, ApprovalRequest, DiffView,
 * TurnFooter, WorkingIndicator, ContextRing, ModelMenu and StatusBar) and the
 * session is the one in the README demo.
 */

const W = 1200;
const H = 760;

/** The violet agent's ink on a dark theme (agentInk in lib/agent-colors.js). */
const VIOLET = "#a375f2";

// Black theme ramp (lib/app-colors.js)
const RAISED = "#0a0a0a";
const CONTROL = "#141414";

/** The window's ground, washed with the violet agent's colour (.app-ground in input.css). */
const GROUND = [
  "radial-gradient(560px 420px at 0 0, color-mix(in srgb, #7c3aed 9%, transparent), transparent 72%)",
  "radial-gradient(420px 560px at 0 100%, color-mix(in srgb, #c084fc 4%, transparent), transparent 72%)",
  "linear-gradient(to bottom, rgb(255 255 255 / 0.025), rgb(255 255 255 / 0) 420px)",
].join(", ");

/** The sidebar's list fading out at its foot (.sidebar-list-fade, at its full 72px). */
const LIST_FADE =
  "linear-gradient(to bottom, #000 calc(100% - 72px), rgb(0 0 0 / 0.9) calc(100% - 54px), rgb(0 0 0 / 0.6) calc(100% - 36px), rgb(0 0 0 / 0.25) calc(100% - 18px), transparent)";

const TITLE = "Checkout tests failing after #212";
/** Another chat, at work in its own tab while this one runs, and done partway through. */
const ELSEWHERE = "Audit sudoers on prod";
const CHATS = [
  "Slow staging builds since Monday",
  "Playbook for checkout staging deploys",
  "Failed SSH logins on bastion",
  "Disk filling up on db-01",
  "Renew TLS certs before Friday",
  "Postgres replica lag on db-02",
  "Upgrade nginx on the web fleet",
  "Why the backup cron never ran",
  "Clean up old Docker images",
  "Grafana alert noise",
  "Rotate the deploy keys",
  "Firewall rules for the new VPN",
  "Move app logs to Loki",
];

const MONO = "font-[family-name:var(--font-app-mono)]";

/** ContextRing.jsx: a 16px ring, r 7. */
const RING = 2 * Math.PI * 7;
const ringFill = (percent: number) => `${(percent / 100) * RING} ${RING}`;

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Code({ children }: { children: ReactNode }) {
  return <code className={`rounded bg-white/10 px-1 py-0.5 ${MONO} text-[0.85em]`}>{children}</code>;
}

/** Markdown's text: 13px at 1.65. It reveals as it streams in, over a hidden copy that holds the space. */
function Prose({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div data-step={name} className="text-[13px] leading-[1.65] text-gray-200">
      <div className="grid">
        <div className="invisible col-start-1 row-start-1">{children}</div>
        <div data-type className="col-start-1 row-start-1">
          {children}
        </div>
      </div>
    </div>
  );
}

/** WorkingIndicator.jsx's spinner: a chat at work, on its tab, its row and its working line. */
function Ring() {
  return (
    <svg viewBox="0 0 12 12" className="app-ring size-3 shrink-0" aria-hidden="true">
      <circle cx="6" cy="6" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
      <circle
        cx="6"
        cy="6"
        r="4.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="7.5 30"
      />
    </svg>
  );
}

/** Done while you were elsewhere: a dot in the spinner's slot until it is opened. */
function Dot() {
  return <span className="size-1.5 rounded-full bg-white" />;
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

/** DiffView.jsx: path and counts over a hairline, then the lines with their numbers. */
function Diff() {
  const row = "flex leading-[1.55]";
  const num = "w-9 shrink-0 pr-2 text-right tabular-nums text-neutral-600";
  return (
    <div className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-2.5 py-1.5">
        <span className={`min-w-0 flex-1 truncate ${MONO} text-[11px] text-gray-400`}>
          C:\src\checkout-service\src\discount.js
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium tabular-nums">
          <span className="text-emerald-400">+1</span>
          <span className="text-red-400">-1</span>
        </span>
      </div>
      <div className={`${MONO} text-[11px]`}>
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

/** TitleBar.jsx's chat tab: the agent's mark, the title, and the spinner or the dot after it. */
function Tab({ title, active, children }: { title: string; active?: boolean; children?: ReactNode }) {
  return (
    <span
      className={`flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-xl px-3 py-2 text-xs font-medium ${
        active ? "max-w-[172px] min-w-[76px] grow-[1.45] text-white" : "max-w-[130px] min-w-[52px] text-gray-400"
      }`}
      style={{ background: active ? CONTROL : RAISED }}
    >
      <span className="relative size-4 shrink-0">
        <Helmet size={20} color={VIOLET} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      </span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{title}</span>
      {children}
    </span>
  );
}

/** A Sidebar.jsx chat row. */
function ChatRow({ title, active, children }: { title: string; active?: boolean; children?: ReactNode }) {
  return (
    <div
      className={`flex h-8 shrink-0 items-center gap-2 rounded-[10px] px-3 text-[13px] ${active ? "text-white" : "text-gray-400"}`}
      style={active ? { background: "rgb(20 20 20 / 0.8)" } : undefined}
    >
      {children}
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{title}</span>
    </div>
  );
}

/** One account's five-hour window in the status bar: `work 5h ▬ 61%`. */
function Meter({ account, used, lead, live }: { account?: string; used: number; lead: string; live?: boolean }) {
  return (
    <span className={`flex shrink-0 items-center ${lead}`}>
      {account && <span className="shrink-0 pr-1.5 text-neutral-400">{account}</span>}
      <span className="flex items-center gap-1.5">
        <span className="text-neutral-500">5h</span>
        <span className="relative h-[3px] w-7 overflow-hidden rounded-full bg-white/[0.09]">
          <span
            data-meter={live ? "" : undefined}
            className="absolute inset-y-0 left-0 rounded-full bg-neutral-300/80"
            style={{ width: `${used}%` }}
          />
        </span>
        <span className="min-w-[1.9em] text-gray-300">
          <span data-meter-text={live ? "" : undefined}>{used}</span>%
        </span>
      </span>
    </span>
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
      const one = (selector: string) => q(selector)[0] as HTMLElement;
      const viewport = one("[data-viewport]");
      const inner = one("[data-inner]");
      const pinned = one("[data-pinned]");
      const steps = q("[data-step]");
      const busy = q("[data-busy]");
      const idle = q("[data-idle]");
      const away = q("[data-away]");
      const back = q("[data-back]");
      const fold = q("[data-fold]");
      const working = one("[data-working]");
      const phrase = one("[data-phrase]");
      const clock = one("[data-clock]");
      const seconds = one("[data-seconds]");
      const context = one("[data-context]");
      const pulse = one("[data-pulse]");
      const meter = one("[data-meter]");
      const meterText = one("[data-meter-text]");
      const toBottom = () => -Math.max(0, inner.scrollHeight - viewport.clientHeight);

      // The finished window: every step in, nothing at work, the other chat done.
      if (prefersReducedMotion()) {
        gsap.set(steps, { display: "", autoAlpha: 1 });
        gsap.set([...busy, ...away, ...fold], { display: "none" });
        gsap.set([...idle, ...back], { display: "" });
        gsap.set(context, { attr: { "stroke-dasharray": ringFill(31) } });
        gsap.set(inner, { y: toBottom() });
        return;
      }

      gsap.set(steps, { display: "none", autoAlpha: 0 });

      const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out", duration: 0.45 } });

      const follow = (at: string | number = "<") => tl.to(inner, { y: toBottom, duration: 0.5 }, at);

      // The working line's phrase rolls over to the next kind of work.
      const work = (text: string, at: string | number = "<") => {
        tl.set(phrase, { textContent: text }, at);
        tl.fromTo(phrase, { yPercent: 100, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.24 }, "<");
      };

      // The context ring fills a little with every reply (ContextRing.jsx).
      const fill = (percent: number) =>
        tl.to(context, { attr: { "stroke-dasharray": ringFill(percent) }, duration: 0.6, ease: "power2.out" }, "<");

      const show = (name: string, at: string | number = "+=0.35") => {
        const node = q(`[data-step="${name}"]`);
        tl.set(node, { display: "" }, at);
        follow();
        tl.fromTo(node, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0 }, "<");
      };

      // Prose streams in word by word, the way a reply arrives. The hidden
      // copy underneath already holds the space, so nothing reflows.
      const say = (name: string, at: string | number = "+=0.35", context?: number, pace = 0.045) => {
        const node = one(`[data-step="${name}"]`);
        const typed = node.querySelector<HTMLElement>("[data-type]");
        tl.set(node, { display: "", autoAlpha: 1 }, at);
        follow();
        if (context !== undefined) fill(context);
        if (!typed) return;
        const { words } = SplitText.create(typed, { type: "words" });
        gsap.set(words, { autoAlpha: 0 });
        tl.to(words, { autoAlpha: 1, duration: 0.12, stagger: pace, ease: "none" }, "<");
      };

      const cursor = one("[data-cursor]");
      // Pin an approval card above the composer, then a pointer clicks Allow.
      const approve = (card: string) => {
        const node = one(`[data-card="${card}"]`);
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

      // At work: the spinners, the stop button and the queue placeholder.
      tl.set(busy, { display: "" }, 0);
      tl.set(idle, { display: "none" }, 0);
      tl.fromTo(
        fold,
        { width: 0, marginRight: -8, autoAlpha: 0 },
        { width: 12, marginRight: 0, autoAlpha: 1, duration: 0.3, ease: "power2.out" },
        0,
      );
      work("Thinking", 0);
      show("user", 0.15);
      say("p1", "+=0.6", 4);
      work("Rummaging around", "+=0.2");
      show("recall", "<0.3");
      say("p2", "+=0.35", 9);
      work("Running commands", "+=0.2");
      approve("run");
      show("run1", "-=0.1");
      say("p3", "+=0.5", 14);
      work("Asking git what happened", "+=0.2");
      show("gitlog", "<0.3");

      // The other chat finishes while this one works: its spinner turns into
      // the dot, and the bell takes the notification.
      tl.set(away, { display: "none" }, "+=0.2");
      tl.set(back, { display: "" }, "<");
      tl.fromTo(back, { scale: 0 }, { scale: 1, duration: 0.3, ease: "back.out(3)" }, "<");

      say("p4", "+=0.3", 18);
      work("Writing code", "+=0.2");
      approve("edit");
      show("edit", "-=0.1");
      say("p5", "+=0.35", 22);
      work("Watching the output", "+=0.2");
      show("run2", "<0.3");
      say("p6", "+=0.6", 26);
      work("Connecting the dots", "+=0.2");
      show("group", "<0.3");
      say("p7", "+=0.5", 31, 0.035);

      // Done: the working line goes, the turn's edits and actions come in
      // under the reply, and the plan meter takes the turn.
      tl.to(working, { autoAlpha: 0, duration: 0.25 }, "+=0.2");
      tl.set(busy, { display: "none" });
      tl.set(idle, { display: "" }, "<");
      tl.to(fold, { width: 0, marginRight: -8, autoAlpha: 0, duration: 0.35, ease: "power2.inOut" }, "<");
      tl.to(meter, { width: "63%", duration: 0.7, ease: "power2.out" }, "<");
      tl.to(meterText, { textContent: 63, duration: 0.7, snap: { textContent: 1 }, ease: "power2.out" }, "<");
      show("changes", "<0.1");
      show("actions", "+=0.15");

      // The elapsed time on the working line, from the third second on, and
      // the header's mark breathing for as long as the turn runs.
      const total = tl.duration();
      tl.fromTo(seconds, { textContent: 0 }, { textContent: Math.round(total), duration: total, snap: { textContent: 1 }, ease: "none" }, 0);
      tl.fromTo(clock, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, 3);
      const beats = Math.max(2, Math.floor(total) - (Math.floor(total) % 2));
      tl.to(pulse, { opacity: 0.45, duration: total / beats, repeat: beats - 1, yoyo: true, ease: "sine.inOut" }, 0);

      tl.timeScale(1.15);
      const st = ScrollTrigger.create({ trigger: el, start: "top 75%", once: true, onEnter: () => tl.play() });
      if (run > 0) {
        st.kill();
        tl.play();
      }
    },
    { scope: root, dependencies: [run], revertOnUpdate: true },
  );

  const hidden = { display: "none" };

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
        // Sized by CSS rather than by `scale`, so the page below never moves
        // when the script measures the column: a shift there left every
        // scroll trigger further down measured against the old layout.
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        <p className="sr-only">
          A replica of the Acestes Agent window: the agent checks its memory, runs the test suite, finds the commit that
          broke it, asks before editing a file, runs the tests again and schedules a nightly check, while another chat
          finishes in its own tab.
        </p>
        <div
          ref={root}
          aria-hidden="true"
          className="absolute top-0 left-0 flex origin-top-left flex-col gap-1.5 overflow-hidden bg-black p-1.5 font-[family-name:var(--font-app)] text-[14px] text-gray-100 antialiased select-none"
          style={{ width: W, height: H, transform: `scale(${scale})`, backgroundImage: GROUND }}
        >
          {/* ---------------- Title bar ---------------- */}
          <div className="flex h-12 shrink-0 items-center justify-between">
            <div className="flex h-full min-w-0 flex-1 items-center gap-3 overflow-hidden">
              <span className="grid size-8 shrink-0 place-items-center rounded-xl">
                <svg className="size-4 text-gray-400" viewBox="0 0 16 16" fill="currentColor">
                  <rect y="2" width="16" height="1.5" rx="0.75" />
                  <rect y="7.25" width="16" height="1.5" rx="0.75" />
                  <rect y="12.5" width="16" height="1.5" rx="0.75" />
                </svg>
              </span>
              <span className="-ml-2 grid size-8 shrink-0 place-items-center rounded-xl text-gray-400">
                <Icon icon={SidebarLeftIcon} size={16} strokeWidth={1.75} />
              </span>
              <span
                className="flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-gray-400"
                style={{ background: RAISED }}
              >
                <Icon icon={Home01Icon} size={14} strokeWidth={1.5} />
                Home
              </span>
              <span className="-mx-1.5 h-4 w-px shrink-0 bg-white/[0.08]" />
              <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden">
                <Tab title={TITLE} active>
                  <span data-busy className="grid size-3 shrink-0 place-items-center" style={hidden}>
                    <Ring />
                  </span>
                </Tab>
                <Tab title={ELSEWHERE}>
                  <span data-away className="grid size-3 shrink-0 place-items-center">
                    <Ring />
                  </span>
                  <span data-back className="grid size-3 shrink-0 place-items-center" style={hidden}>
                    <Dot />
                  </span>
                </Tab>
                <span className="grid size-8 shrink-0 place-items-center rounded-xl text-gray-500">
                  <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </span>
              </div>
            </div>
            <div className="flex h-full shrink-0 items-center gap-1">
              <span className="relative mr-1.5 grid size-8 place-items-center rounded-xl text-gray-400">
                <Icon icon={Notification03Icon} size={16} strokeWidth={2} />
                <span
                  data-back
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-blue-500 ring-2 ring-black"
                  style={hidden}
                />
              </span>
              <span className="grid size-8 place-items-center rounded-xl text-gray-400">
                <svg className="size-3" viewBox="0 0 12 12">
                  <rect y="5" width="12" height="1" fill="currentColor" />
                </svg>
              </span>
              <span className="grid size-8 place-items-center rounded-xl text-gray-400">
                <svg className="size-3" viewBox="0 0 12 12">
                  <rect width="10" height="10" x="1" y="1" rx="1" stroke="currentColor" strokeWidth="1.2" fill="none" />
                </svg>
              </span>
              <span className="grid size-8 place-items-center rounded-xl text-gray-400">
                <svg className="size-3" viewBox="0 0 12 12">
                  <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </span>
            </div>
          </div>

          {/* ---------------- Body ---------------- */}
          <div className="flex min-h-0 flex-1 gap-1.5">
            {/* Sidebar: no surface of its own, the agent's wash on the ground is its background */}
            <div className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-hidden">
              <div className="flex items-center gap-2.5 rounded-xl py-1.5 pr-2.5 pl-1.5">
                <Helmet size={28} color={VIOLET} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-5 font-semibold tracking-[-0.01em] text-white">
                    Acestes
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-neutral-500">Agent</span>
                </span>
                <Icon icon={UnfoldMoreIcon} size={14} strokeWidth={2} className="shrink-0 text-neutral-500" />
              </div>
              <div className="mt-1.5 flex flex-col gap-0.5">
                {[
                  { i: Layers01Icon, t: "Inventory" },
                  { i: Settings01Icon, t: "Settings" },
                ].map((x) => (
                  <div
                    key={x.t}
                    className="flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium text-gray-400"
                  >
                    <Icon icon={x.i} size={17} strokeWidth={1.6} className="shrink-0 text-neutral-500" />
                    {x.t}
                  </div>
                ))}
              </div>

              <div className="mx-1.5 mt-4 flex h-9 shrink-0 items-center">
                <span className="flex-1 py-1.5 pl-1.5 text-[12px] font-medium text-white">Conversations</span>
                <span className="grid size-7 place-items-center rounded-full text-gray-400">
                  <Icon icon={Search01Icon} size={15} strokeWidth={2} />
                </span>
                <span className="grid size-7 place-items-center rounded-full text-gray-400">
                  <Icon icon={PlusSignIcon} size={15} strokeWidth={2.5} />
                </span>
              </div>
              <div
                className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden pb-4"
                style={{ maskImage: LIST_FADE, WebkitMaskImage: LIST_FADE }}
              >
                <ChatRow title={TITLE} active>
                  <span
                    data-fold
                    className="grid h-3 shrink-0 place-items-center overflow-hidden"
                    style={{ width: 0, marginRight: -8, visibility: "hidden" }}
                  >
                    <Ring />
                  </span>
                </ChatRow>
                <ChatRow title={ELSEWHERE}>
                  <span data-away className="grid size-3 shrink-0 place-items-center">
                    <Ring />
                  </span>
                  <span data-back className="grid size-3 shrink-0 place-items-center" style={hidden}>
                    <Dot />
                  </span>
                </ChatRow>
                {CHATS.map((c) => (
                  <ChatRow key={c} title={c} />
                ))}
              </div>
            </div>

            {/* Conversation panel */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[16px]" style={{ background: RAISED }}>
              {/* Header */}
              <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/[0.06] px-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span data-pulse className="flex">
                    <Helmet size={18} color={VIOLET} />
                  </span>
                  <span className="truncate text-xs font-semibold text-white">{TITLE}</span>
                </div>
                <div className="w-64 max-w-[40%] shrink-0">
                  <div className="flex h-8 items-center gap-1.5 rounded-xl pr-2 pl-2.5">
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-200">No session open</span>
                    <Icon icon={ArrowDown01Icon} size={12} strokeWidth={2} className="shrink-0 text-gray-600" />
                  </div>
                </div>
                {[Search01Icon, Copy01Icon, CommandLineIcon, SplitIcon, LinkSquare02Icon].map((i, n) => (
                  <span key={n} className="grid size-8 shrink-0 place-items-center rounded-xl text-gray-400">
                    <Icon icon={i} size={16} strokeWidth={1.75} />
                  </span>
                ))}
              </div>

              <div className="mx-auto flex min-h-0 w-full max-w-[768px] flex-1 flex-col">
                {/* Transcript */}
                <div data-viewport className="relative min-h-0 flex-1 overflow-hidden">
                  <div data-inner className="flex flex-col gap-3 p-3">
                    <div data-step="user" className="flex justify-end">
                      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-white px-3 py-2 text-[13px] leading-relaxed text-black">
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
                      Two failures, both in totals: <Code>1799.1</Code> where <Code>1799</Code> was expected. Something
                      is producing fractions of a cent. Looking at what changed this morning.
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
                      <Code>cents * (1 - percent / 100)</Code>, which returns fractional cents. Putting the rounding
                      back:
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
                      math, so $19.99 at 10% off came out as <Code>1799.1</Code> cents. I put the rounding back, noted
                      why in memory, and a nightly job now runs the suite at 02:00.
                    </Prose>

                    {/* TurnFooter.jsx: what the turn edited, with undo and review */}
                    <div
                      data-step="changes"
                      className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.025]"
                    >
                      <div className="flex items-center gap-3 px-3 py-2.5">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-gray-300">
                          <Icon icon={PlusMinusSquare01Icon} size={17} strokeWidth={1.75} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-white">Edited 1 file</div>
                          <span className="flex items-center gap-1.5 text-[11px] font-medium tabular-nums">
                            <span className="text-emerald-400">+1</span>
                            <span className="text-red-400">-1</span>
                          </span>
                        </div>
                        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-300">
                          Undo
                          <Icon icon={Undo02Icon} size={14} strokeWidth={2} />
                        </span>
                        <span className="flex h-7 shrink-0 items-center rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 text-xs font-medium text-gray-200">
                          Review
                        </span>
                      </div>
                      <div className="border-t border-white/[0.06]">
                        <div className="flex h-9 items-center gap-3 px-3">
                          <span className="flex min-w-0 flex-1 items-baseline text-xs">
                            <span className="min-w-0 truncate text-gray-500">C:\src\checkout-service\src\</span>
                            <span className="shrink-0 font-medium text-white">discount.js</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium tabular-nums">
                            <span className="text-emerald-400">+1</span>
                            <span className="text-red-400">-1</span>
                          </span>
                          <Icon icon={ArrowDown01Icon} size={13} strokeWidth={2} className="shrink-0 text-gray-600" />
                        </div>
                      </div>
                    </div>

                    {/* TurnActions: copy, branch, and how fast the turn wrote */}
                    <div data-step="actions" className="flex items-center gap-0.5">
                      {[Copy01Icon, GitBranchIcon].map((i, n) => (
                        <span key={n} className="grid size-7 place-items-center rounded-lg text-gray-500">
                          <Icon icon={i} size={15} strokeWidth={1.75} />
                        </span>
                      ))}
                      <span className="px-1.5 text-[11px] text-gray-500 tabular-nums">84 tok/sec</span>
                    </div>

                    {/* WorkingIndicator.jsx: the spinner and a phrase for the work in hand */}
                    <div
                      data-busy
                      data-working
                      className="flex h-8 shrink-0 items-center gap-2 px-2.5 text-[11px] text-gray-500"
                      style={hidden}
                    >
                      <Ring />
                      <span className="grid overflow-hidden">
                        <span data-phrase className="app-glint whitespace-nowrap">
                          Thinking
                        </span>
                      </span>
                      <span data-clock className="text-gray-600 tabular-nums">
                        <span data-seconds>0</span>s
                      </span>
                    </div>
                  </div>
                </div>

                {/* Pending approval, pinned above the composer */}
                <div data-pinned className="shrink-0 overflow-hidden" style={{ height: 0 }}>
                  <div className="space-y-2 border-t border-white/[0.06] px-3 pt-3 pb-1">
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

                {/* Composer: an outline, no surface of its own */}
                <div className="shrink-0 p-3">
                  <div className="rounded-2xl border" style={{ borderColor: CONTROL }}>
                    <div className="px-3 pt-2.5 pb-1 text-[13px] leading-relaxed text-gray-600">
                      <span data-idle>Ask about your servers</span>
                      <span data-busy style={hidden}>
                        Queue a follow-up…
                      </span>
                    </div>
                    <div className="flex items-center gap-1 px-2 pb-2">
                      <span className="flex h-7 items-center gap-0.5 rounded-xl pr-1 pl-1.5 text-gray-600">
                        <Icon icon={Shield01Icon} size={14} strokeWidth={1.5} />
                        <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="opacity-60" />
                      </span>
                      <span className="grid size-7 place-items-center rounded-full text-sm font-semibold text-gray-400">
                        /
                      </span>
                      <span className="grid size-7 place-items-center rounded-full text-sm font-semibold text-gray-400">
                        @
                      </span>
                      <span className="grid size-7 place-items-center rounded-full text-gray-400">
                        <Icon icon={Attachment01Icon} size={15} strokeWidth={2} />
                      </span>
                      <span className="grid size-7 place-items-center rounded-full text-gray-400">
                        <Icon icon={ImageAdd01Icon} size={15} strokeWidth={2} />
                      </span>
                      <div className="ml-auto flex items-center gap-1">
                        <span className="grid size-7 shrink-0 place-items-center text-gray-400">
                          <svg width="16" height="16" viewBox="0 0 16 16">
                            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2" />
                            <circle
                              data-context
                              cx="8"
                              cy="8"
                              r="7"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeDasharray={ringFill(0)}
                              transform="rotate(-90 8 8)"
                            />
                          </svg>
                        </span>
                        <span className="flex h-7 items-center gap-1 rounded-xl pr-1.5 pl-2 text-[11px] text-gray-400">
                          <BrandIcon name="claude" size={13} />
                          <span className="font-medium">Opus 5.5</span>
                          <span className="opacity-60">work</span>
                          <span className="opacity-60">Extra high</span>
                          <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="opacity-60" />
                        </span>
                        <span className="grid size-7 place-items-center rounded-full text-gray-400">
                          <Icon icon={Mic01Icon} size={15} strokeWidth={2} />
                        </span>
                        <span
                          data-busy
                          className="grid size-7 place-items-center rounded-full text-gray-300"
                          style={{ ...hidden, background: CONTROL }}
                        >
                          <Icon icon={StopCircleIcon} size={15} strokeWidth={2} />
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- Status bar ---------------- */}
          <div
            className="flex h-5 shrink-0 items-center justify-between gap-4 text-[10.5px] leading-none font-medium tabular-nums"
            style={{ margin: "-6px 0 -8px" }}
          >
            <span className="-ml-1.5 flex h-5 items-center px-1.5">
              <span className="text-neutral-400">
                <BrandIcon name="claude" size={11} />
              </span>
              <Meter account="brad" used={23} lead="pl-2" />
              <Meter account="work" used={61} lead="pl-3" live />
              <span className="mx-2.5 h-2.5 w-px shrink-0 bg-white/10" />
              <span className="text-neutral-400">
                <BrandIcon name="openai" size={11} />
              </span>
              <Meter used={12} lead="pl-2" />
            </span>
            <span className="-mr-1.5 flex items-center gap-0.5">
              <span className="flex h-5 items-center gap-2 px-1.5 text-neutral-400">
                <span className="flex items-center gap-1.5">
                  <Icon icon={CpuIcon} size={11} strokeWidth={2} className="text-neutral-500" />
                  <span className="text-gray-300">1.1 GB</span>
                </span>
                <span className="h-2.5 w-px bg-white/10" />
                <span>2 tabs</span>
              </span>
              <span className="grid h-5 w-6 place-items-center text-neutral-500">
                <Icon icon={Coffee02Icon} size={12} strokeWidth={1.8} />
              </span>
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
