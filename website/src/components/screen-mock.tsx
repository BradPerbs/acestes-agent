"use client";

import { useEffect, useRef, useState } from "react";
import { Alert02Icon, Key01Icon, LockIcon } from "@hugeicons/core-free-icons";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { Icon } from "./icon";
import { TermLines, TermWindow, type TermLine } from "./terminal";

/*
 * Computer use, shown the way the agent sees it: Windows' Event Viewer with
 * a number on every control (as read_screen numbers them), the real cursor
 * going from control to control, a dialog whose controls arrive with new
 * numbers, and the agent's own transcript beside it. Drawn at a fixed size
 * and scaled to fit, like the app replica, so the cursor's path is exact at
 * any width. Addresses are from the ranges set aside for examples.
 */

const W = 880;
const H = 560;
const VIOLET = "#7c3aed";

const transcript: TermLine[] = [
  { k: "cmd", t: "pull last night's failed logons from the Security log" },
  { k: "info", t: "read_screen   Event Viewer · 33 controls" },
  { k: "info", t: 'click [11]   tree item "Security"' },
  { k: "info", t: 'click [28]   "Filter Current Log…"' },
  { k: "tag", tag: "new", tone: "accent", t: '[41] edit "Event IDs" · [42] button "OK"' },
  { k: "info", t: 'type_text [41] "4625" · click [42]' },
  { k: "tag", tag: "changed", tone: "accent", t: "1,912 events, every one a 4625" },
  { k: "ok", t: "1,804 from 203.0.113.42, between 02:10 and 02:14" },
  { k: "tag", tag: "waiting", tone: "warn", t: "block 203.0.113.42 at the firewall?  [ Allow ]" },
];

/** A control's number, drawn over it the way a numbered screenshot draws it. */
function Tag({ n, fresh = false }: { n: number; fresh?: boolean }) {
  return (
    <span
      data-mark={fresh ? "new" : "old"}
      data-reveal
      className="pointer-events-none absolute -inset-[2px] z-10 rounded-[3px] border-[1.5px]"
      style={{ borderColor: `${VIOLET}99` }}
    >
      <span
        className="absolute -top-[8px] -left-[3px] rounded-[3px] px-[3px] text-[9.5px] leading-[13px] font-medium text-white"
        style={{ background: VIOLET }}
      >
        {n}
      </span>
    </span>
  );
}

type Node = { n: number; label: string; depth: number; caret?: "open" | "closed"; sel?: "app" | "sec" };

const tree: Node[] = [
  { n: 6, label: "Event Viewer (Local)", depth: 0, caret: "open" },
  { n: 7, label: "Custom Views", depth: 1, caret: "closed" },
  { n: 8, label: "Windows Logs", depth: 1, caret: "open" },
  { n: 10, label: "Application", depth: 2, sel: "app" },
  { n: 11, label: "Security", depth: 2, sel: "sec" },
  { n: 12, label: "Setup", depth: 2 },
  { n: 13, label: "System", depth: 2 },
  { n: 14, label: "Forwarded Events", depth: 2 },
  { n: 15, label: "Applications and Services Logs", depth: 1, caret: "closed" },
  { n: 16, label: "Subscriptions", depth: 1 },
];

const actions: { n: number; label: string }[] = [
  { n: 24, label: "Open Saved Log…" },
  { n: 25, label: "Create Custom View…" },
  { n: 26, label: "Import Custom View…" },
  { n: 27, label: "Clear Log…" },
  { n: 28, label: "Filter Current Log…" },
  { n: 29, label: "Properties" },
  { n: 30, label: "Find…" },
  { n: 31, label: "Save All Events As…" },
  { n: 32, label: "Refresh" },
  { n: 33, label: "Help" },
];

type Level = "info" | "warn" | "error" | "ok" | "fail";
type Row = [Level, string, string, string, string];

const SOURCE = "Microsoft Windows security auditing.";

/** The selected event's General tab: its heading, a line of summary, and a few fields. */
type Detail = { title: string; summary: string; fields: [string, string][] };

const appDetail: Detail = {
  title: "Event 1001, Windows Error Reporting",
  summary: "Fault bucket 2187340021, type 5",
  fields: [
    ["Event Name:", "APPCRASH"],
    ["Response:", "Not available"],
    ["Cab Id:", "0"],
  ],
};

const logonDetail: Detail = {
  title: "Event 4625, Microsoft Windows security auditing.",
  summary: "An account failed to log on.",
  fields: [
    ["Logon Type:", "3"],
    ["Account Name:", "administrator"],
    ["Failure Reason:", "Unknown user name or bad password."],
    ["Source Network Address:", "203.0.113.42"],
  ],
};

const views: {
  id: "app" | "sec" | "filtered";
  head: string;
  count: string;
  first: string;
  rows: Row[];
  detail: Detail;
}[] = [
  {
    id: "app",
    head: "Application",
    count: "Number of events: 3,412",
    first: "Level",
    detail: appDetail,
    rows: [
      ["info", "10/10/2026 09:41:02", "Windows Error Reporting", "1001", "None"],
      ["info", "10/10/2026 09:40:57", "Security-SPP", "16384", "None"],
      ["warn", "10/10/2026 09:12:30", "ESENT", "916", "General"],
      ["error", "10/10/2026 08:58:14", "Application Error", "1000", "(100)"],
      ["info", "10/10/2026 08:31:09", "MsiInstaller", "11707", "None"],
      ["info", "10/10/2026 08:30:51", "VSS", "8224", "None"],
      ["warn", "10/10/2026 07:02:44", "ESENT", "916", "General"],
      ["info", "10/10/2026 06:00:03", "Security-SPP", "16394", "None"],
      ["info", "10/10/2026 05:59:58", "Windows Error Reporting", "1001", "None"],
    ],
  },
  {
    id: "sec",
    head: "Security",
    count: "Number of events: 48,213",
    first: "Keywords",
    detail: logonDetail,
    rows: [
      ["fail", "10/10/2026 02:14:07", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:14:06", SOURCE, "4625", "Logon"],
      ["ok", "10/10/2026 02:13:58", SOURCE, "4624", "Logon"],
      ["fail", "10/10/2026 02:13:51", SOURCE, "4625", "Logon"],
      ["ok", "10/10/2026 02:11:20", SOURCE, "4672", "Special Logon"],
      ["fail", "10/10/2026 02:10:44", SOURCE, "4625", "Logon"],
      ["ok", "10/10/2026 02:02:13", SOURCE, "4634", "Logoff"],
      ["fail", "10/10/2026 02:01:39", SOURCE, "4625", "Logon"],
      ["ok", "10/10/2026 01:58:05", SOURCE, "4624", "Logon"],
    ],
  },
  {
    id: "filtered",
    head: "Security",
    count: "Filtered: Event IDs 4625 · 1,912 of 48,213 events",
    first: "Keywords",
    detail: logonDetail,
    rows: [
      ["fail", "10/10/2026 02:14:07", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:14:06", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:14:05", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:14:03", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:13:59", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:13:51", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:13:47", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:12:30", SOURCE, "4625", "Logon"],
      ["fail", "10/10/2026 02:10:44", SOURCE, "4625", "Logon"],
    ],
  },
];

const LEVEL_TEXT: Record<Level, string> = {
  info: "Information",
  warn: "Warning",
  error: "Error",
  ok: "Audit Success",
  fail: "Audit Failure",
};

function LevelMark({ level }: { level: Level }) {
  if (level === "info") {
    return (
      <span className="grid size-[12px] shrink-0 place-items-center rounded-full bg-[#1f6fb5] text-[8px] leading-none font-medium text-white">
        i
      </span>
    );
  }
  if (level === "error") {
    return (
      <span className="grid size-[12px] shrink-0 place-items-center rounded-full bg-[#c42b1c] text-[9px] leading-none text-white">
        ×
      </span>
    );
  }
  if (level === "warn")
    return <Icon icon={Alert02Icon} size={12} strokeWidth={2} className="shrink-0 text-[#c27d0e]" />;
  if (level === "ok") return <Icon icon={Key01Icon} size={12} strokeWidth={2} className="shrink-0 text-[#b88a1b]" />;
  return <Icon icon={LockIcon} size={12} strokeWidth={2} className="shrink-0 text-[#5b5b5b]" />;
}

const GRID = "grid grid-cols-[104px_138px_minmax(0,1fr)_56px_88px]";

function View({ view, shown }: { view: (typeof views)[number]; shown: boolean }) {
  return (
    <div
      data-view={view.id}
      className="absolute inset-0 flex flex-col"
      style={shown ? undefined : { visibility: "hidden", opacity: 0 }}
    >
      <div className="flex h-[30px] shrink-0 items-center gap-3 border-b border-[#e4e4e4] bg-[#fafafa] px-3">
        <span className="font-medium">{view.head}</span>
        <span className="truncate text-[#6b6b6b]">{view.count}</span>
      </div>
      <div
        className={`${GRID} h-[24px] shrink-0 items-center border-b border-[#e4e4e4] px-3 whitespace-nowrap text-[#6b6b6b]`}
      >
        <span className="truncate">{view.first}</span>
        <span className="truncate">Date and Time</span>
        <span className="truncate">Source</span>
        <span className="truncate">Event ID</span>
        <span className="truncate">Task Category</span>
      </div>
      {view.rows.map((row, i) => (
        <div
          key={i}
          className={`${GRID} h-[25px] shrink-0 items-center px-3 ${i === 0 ? "bg-[#e5f1fb]" : i % 2 ? "bg-[#fbfbfb]" : ""}`}
        >
          <span className="flex items-center gap-1.5 truncate">
            <LevelMark level={row[0]} />
            {LEVEL_TEXT[row[0]]}
          </span>
          <span className="font-[family-name:var(--font-app-mono)] text-[11px] tabular-nums">{row[1]}</span>
          <span className="truncate pr-2">{row[2]}</span>
          <span className="font-[family-name:var(--font-app-mono)] text-[11px] tabular-nums">{row[3]}</span>
          <span className="truncate">{row[4]}</span>
        </div>
      ))}

      {/* The selected event, as Event Viewer shows it under the list */}
      <div className="mt-auto flex h-[196px] shrink-0 flex-col border-t border-[#d9d9d9] bg-white">
        <div className="flex h-[28px] shrink-0 items-center justify-between border-b border-[#ececec] bg-[#fafafa] px-3">
          <span className="truncate font-medium">{view.detail.title}</span>
          <span className="text-[11px] text-[#6b6b6b]">✕</span>
        </div>
        <div className="flex h-[26px] shrink-0 items-end gap-1 border-b border-[#ececec] px-3">
          <span className="rounded-t-[3px] border border-b-0 border-[#d9d9d9] bg-white px-2.5 py-[3px]">General</span>
          <span className="px-2.5 py-[3px] text-[#6b6b6b]">Details</span>
        </div>
        <div className="flex flex-col gap-[5px] px-4 py-3">
          <p>{view.detail.summary}</p>
          {view.detail.fields.map(([key, value]) => (
            <p key={key} className="grid grid-cols-[168px_minmax(0,1fr)]">
              <span className="text-[#6b6b6b]">{key}</span>
              <span className="truncate font-[family-name:var(--font-app-mono)] text-[11px]">{value}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function Dialog() {
  const levels = ["Critical", "Warning", "Verbose", "Error", "Information"];
  return (
    <div
      data-dialog
      className="absolute top-[132px] left-[246px] z-20 w-[392px] overflow-visible rounded-[7px] border border-[#cdcdcd] bg-[#f9f9f9] shadow-[0_24px_60px_-18px_rgb(0_0_0/0.45)]"
      style={{ visibility: "hidden", opacity: 0 }}
    >
      <div className="flex h-[32px] items-center justify-between rounded-t-[7px] border-b border-[#e3e3e3] bg-[#f3f3f3] px-3">
        <span className="font-medium">Filter Current Log</span>
        <span className="text-[13px] text-[#6b6b6b]">✕</span>
      </div>
      <div className="flex flex-col gap-3 px-4 pt-3.5 pb-4">
        <div className="flex items-center gap-2">
          <span className="w-[86px] text-[#6b6b6b]">Logged:</span>
          <span className="flex h-[23px] flex-1 items-center justify-between rounded-[3px] border border-[#c4c4c4] bg-white px-2">
            Any time <span className="text-[10px] text-[#6b6b6b]">▼</span>
          </span>
        </div>
        <div className="flex gap-2">
          <span className="w-[86px] text-[#6b6b6b]">Event level:</span>
          <div className="grid flex-1 grid-cols-3 gap-x-2 gap-y-1.5">
            {levels.map((l) => (
              <span key={l} className="flex items-center gap-1.5">
                <span className="size-[11px] rounded-[2px] border border-[#8a8a8a] bg-white" />
                {l}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[86px] text-[#6b6b6b]">By log:</span>
          <span>Security</span>
        </div>
        <div>
          <p className="text-[#6b6b6b]">Includes or excludes Event IDs:</p>
          <div
            data-target="41"
            className="relative mt-1.5 flex h-[25px] items-center rounded-[3px] border border-[#8a8a8a] bg-white px-2 font-[family-name:var(--font-app-mono)] text-[11.5px]"
          >
            <span data-typed />
            <span data-placeholder className="text-[#8a8a8a]">
              &lt;All Event IDs&gt;
            </span>
            <Tag n={41} fresh />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <span
            data-target="42"
            className="relative grid h-[25px] w-[76px] place-items-center rounded-[3px] bg-[#0067c0] text-white"
          >
            OK
            <Tag n={42} fresh />
          </span>
          <span className="relative grid h-[25px] w-[76px] place-items-center rounded-[3px] border border-[#c4c4c4] bg-white">
            Cancel
            <Tag n={43} fresh />
          </span>
        </div>
      </div>
    </div>
  );
}

/** The window and its transcript, laid out by the caller's grid. */
export function ScreenMock({ className = "" }: { className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useGSAP(
    () => {
      const box = canvas.current;
      const page = root.current;
      if (!box || !page) return;
      const q = gsap.utils.selector(box);
      const oldMarks = q('[data-mark="old"]');
      const newMarks = q('[data-mark="new"]');
      const dialog = q("[data-dialog]")[0];
      const typed = q("[data-typed]")[0];
      const placeholder = q("[data-placeholder]")[0];
      const view = (id: string) => q(`[data-view="${id}"]`)[0];
      const hl = (id: string) => q(`[data-hl="${id}"]`)[0];
      const pane = (id: string) => q(`[data-pane="${id}"]`)[0];
      const cursor = q("[data-cursor]")[0];
      const ripple = q("[data-ripple]")[0];
      const focus = q("[data-focus]")[0];
      const lines = gsap.utils.toArray<HTMLElement>("[data-transcript] [data-line]", page);
      const prompt = page.querySelector<HTMLElement>("[data-transcript] [data-cmd]");

      if (prefersReducedMotion()) {
        // How the run ends: the log filtered, the dialog gone. Its numbers
        // go with it; the page's reveal gate would otherwise show them.
        gsap.set(oldMarks, { autoAlpha: 1 });
        gsap.set(newMarks, { autoAlpha: 0 });
        gsap.set([view("app"), view("sec"), hl("app"), pane("app")], { autoAlpha: 0 });
        gsap.set([view("filtered"), hl("sec"), pane("sec"), ...lines], { autoAlpha: 1 });
        return;
      }

      // Where each control is on the canvas, in its own pixels.
      const at = (n: number) => {
        const el = box.querySelector<HTMLElement>(`[data-target="${n}"]`);
        const c = box.getBoundingClientRect();
        const r = el!.getBoundingClientRect();
        const s = c.width / W || 1;
        return { x: (r.left - c.left) / s, y: (r.top - c.top) / s, w: r.width / s, h: r.height / s };
      };
      const targets = { security: at(11), filter: at(28), ids: at(41), ok: at(42) };
      const home = { x: 760, y: 470 };
      const promptText = prompt?.textContent ?? "";

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.4, paused: true });
      tl.set(oldMarks, { autoAlpha: 0 }, 0)
        .set(newMarks, { autoAlpha: 0 }, 0)
        .set(dialog, { autoAlpha: 0, scale: 0.97, transformOrigin: "50% 40%" }, 0)
        .set(typed, { text: "" }, 0)
        .set(placeholder, { autoAlpha: 1 }, 0)
        .set([view("sec"), view("filtered"), hl("sec"), pane("sec")], { autoAlpha: 0 }, 0)
        .set([view("app"), hl("app"), pane("app")], { autoAlpha: 1 }, 0)
        .set(lines, { autoAlpha: 0, y: 4 }, 0)
        .set([focus, ripple], { autoAlpha: 0 }, 0)
        .set(cursor, { x: home.x, y: home.y, scale: 1, autoAlpha: 1 }, 0);

      let pos = home;
      const show = (i: number, when: number) => tl.to(lines[i], { autoAlpha: 1, y: 0, duration: 0.35 }, when);

      /** The cursor glides to a control, with the outline the helper draws on its target. */
      const glide = (r: { x: number; y: number; w: number; h: number }, when: number) => {
        const to = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        const d = Math.min(1.1, Math.max(0.55, Math.hypot(to.x - pos.x, to.y - pos.y) / 650));
        tl.set(focus, { x: r.x - 3, y: r.y - 3, width: r.w + 6, height: r.h + 6 }, when);
        tl.to(focus, { autoAlpha: 1, duration: 0.25 }, when);
        tl.to(cursor, { x: to.x, y: to.y, duration: d, ease: "power2.inOut" }, when);
        pos = to;
        return when + d;
      };

      /** A click where the cursor is: a press, and a ring going out. */
      const click = (when: number) => {
        tl.to(cursor, { scale: 0.86, duration: 0.07 }, when).to(cursor, { scale: 1, duration: 0.12 }, when + 0.07);
        tl.fromTo(
          ripple,
          { x: pos.x, y: pos.y, xPercent: -50, yPercent: -50, scale: 0.3, autoAlpha: 0.9 },
          { scale: 1.5, autoAlpha: 0, duration: 0.55, ease: "power2.out" },
          when,
        );
        tl.to(focus, { autoAlpha: 0, duration: 0.3 }, when + 0.25);
        return when + 0.3;
      };

      // The ask.
      let t = 0.3;
      show(0, t);
      if (prompt) tl.fromTo(prompt, { text: "" }, { text: promptText, duration: 1, ease: "none" }, t);
      t += 1.35;

      // read_screen: every control gets its number.
      tl.to(oldMarks, { autoAlpha: 1, duration: 0.2, stagger: 0.025 }, t);
      show(1, t + 0.2);
      t += 1.1;

      // The Security log.
      t = click(glide(targets.security, t));
      tl.to([view("app"), hl("app"), pane("app")], { autoAlpha: 0, duration: 0.2 }, t);
      tl.to([view("sec"), hl("sec"), pane("sec")], { autoAlpha: 1, duration: 0.25 }, t);
      show(2, t);
      t += 0.7;

      // Filter Current Log: a dialog, whose controls come with new numbers.
      t = click(glide(targets.filter, t));
      tl.to(dialog, { autoAlpha: 1, scale: 1, duration: 0.3, ease: "power3.out" }, t);
      show(3, t);
      tl.to(newMarks, { autoAlpha: 1, duration: 0.2, stagger: 0.06 }, t + 0.45);
      show(4, t + 0.5);
      t += 1.2;

      // 4625, and OK.
      t = click(glide(targets.ids, t));
      tl.to(placeholder, { autoAlpha: 0, duration: 0.1 }, t);
      tl.to(typed, { text: "4625", duration: 0.7, ease: "none" }, t + 0.1);
      show(5, t + 0.1);
      t += 1;
      t = click(glide(targets.ok, t));
      tl.to(dialog, { autoAlpha: 0, scale: 0.98, duration: 0.25 }, t);
      tl.to(view("sec"), { autoAlpha: 0, duration: 0.2 }, t + 0.15);
      tl.to(view("filtered"), { autoAlpha: 1, duration: 0.3 }, t + 0.15);
      show(6, t + 0.35);
      show(7, t + 1);
      show(8, t + 1.7);
      t += 4.6;

      // Rest, then home again for the next run.
      tl.to(cursor, { x: home.x, y: home.y, duration: 0.9, ease: "power2.inOut" }, t);
      tl.to([...oldMarks, ...lines], { autoAlpha: 0, duration: 0.4 }, t);

      const st = ScrollTrigger.create({
        trigger: page,
        start: "top 75%",
        end: "bottom 15%",
        onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
      });
      if (st.isActive) tl.play();
    },
    { scope: root },
  );

  return (
    <div ref={root} className={className}>
      <p className="sr-only">
        A demonstration: asked for last night&apos;s failed logons, the agent reads Windows&apos; Event Viewer, where
        every control carries a number, clicks the Security log, opens Filter Current Log, types event ID 4625 and
        confirms. 1,912 failed logons remain, 1,804 of them from one address, and it asks before blocking it.
      </p>

      <div
        ref={frame}
        aria-hidden="true"
        className="relative w-full overflow-hidden rounded-[10px] bg-[#f3f3f3] ring-1 ring-black/10 dark:ring-white/10"
        // Sized by CSS rather than by `scale`, so the page below never moves
        // when the script measures the column: a shift there left every
        // scroll trigger further down measured against the old layout.
        style={{ aspectRatio: `${W} / ${H}`, maxHeight: H }}
      >
        <div
          ref={canvas}
          className="absolute top-0 left-0 origin-top-left overflow-hidden bg-white font-[family-name:var(--font-app)] text-[12px] text-[#1b1b1b] antialiased select-none"
          style={{ width: W, height: H, transform: `scale(${scale})` }}
        >
          {/* Title bar */}
          <div className="flex h-[34px] items-center justify-between border-b border-[#e5e5e5] bg-[#f3f3f3] pl-3">
            <span className="flex items-center gap-2">
              <span className="grid size-[16px] place-items-center rounded-[3px] bg-[#1f6fb5] text-[9px] font-medium text-white">
                !
              </span>
              Event Viewer
            </span>
            <span className="flex h-full text-[#3b3b3b]">
              <span className="grid w-[44px] place-items-center">—</span>
              <span className="grid w-[44px] place-items-center text-[11px]">☐</span>
              <span className="grid w-[44px] place-items-center">✕</span>
            </span>
          </div>

          {/* Menu bar */}
          <div className="flex h-[27px] items-center gap-1 border-b border-[#ececec] bg-white px-2">
            {[
              { n: 2, l: "File" },
              { n: 3, l: "Action" },
              { n: 4, l: "View" },
              { n: 5, l: "Help" },
            ].map((m) => (
              <span key={m.n} className="relative rounded-[3px] px-2 py-[3px]">
                {m.l}
                <Tag n={m.n} />
              </span>
            ))}
          </div>

          <div className="flex" style={{ height: H - 34 - 27 }}>
            {/* Tree */}
            <div className="w-[196px] shrink-0 border-r border-[#e4e4e4] bg-[#fbfbfb] px-1.5 pt-2">
              {tree.map((node) => (
                <div
                  key={node.n}
                  data-target={node.n}
                  className="relative mb-[3px] flex h-[22px] items-center gap-1 pr-1"
                  style={{ paddingLeft: 4 + node.depth * 13 }}
                >
                  {node.sel && (
                    <span
                      data-hl={node.sel}
                      className="absolute inset-0 rounded-[3px] bg-[#cce4f7]"
                      style={node.sel === "app" ? undefined : { visibility: "hidden", opacity: 0 }}
                    />
                  )}
                  <span className="relative w-[10px] text-[8px] text-[#6b6b6b]">
                    {node.caret === "open" ? "▼" : node.caret === "closed" ? "▶" : ""}
                  </span>
                  <span className="relative truncate">{node.label}</span>
                  <Tag n={node.n} />
                </div>
              ))}
            </div>

            {/* The log */}
            <div className="relative min-w-0 flex-1 overflow-hidden">
              {views.map((v) => (
                <View key={v.id} view={v} shown={v.id === "app"} />
              ))}
            </div>

            {/* Actions */}
            <div className="w-[188px] shrink-0 border-l border-[#e4e4e4] bg-[#fbfbfb]">
              <div className="flex h-[30px] items-center border-b border-[#e4e4e4] px-3 font-medium">Actions</div>
              <div className="relative h-[26px] border-b border-[#ececec] bg-[#f0f0f0]">
                <span data-pane="app" className="absolute inset-0 flex items-center px-3 font-medium">
                  Application
                </span>
                <span
                  data-pane="sec"
                  className="absolute inset-0 flex items-center px-3 font-medium"
                  style={{ visibility: "hidden", opacity: 0 }}
                >
                  Security
                </span>
              </div>
              <div className="px-1.5 pt-2">
                {actions.map((a) => (
                  <div key={a.n} data-target={a.n} className="relative mb-[4px] flex h-[22px] items-center gap-2 pl-2">
                    <span className="size-[10px] shrink-0 rounded-[2px] border border-[#9a9a9a]" />
                    <span className="truncate">{a.label}</span>
                    <Tag n={a.n} />
                  </div>
                ))}
              </div>
            </div>
          </div>

          <Dialog />

          {/* What the helper shows on screen: an outline on the target, a ripple where it clicks, the cursor. */}
          <span
            data-focus
            className="absolute top-0 left-0 z-30 rounded-[5px] border-2"
            style={{ borderColor: VIOLET, background: `${VIOLET}14`, visibility: "hidden", opacity: 0 }}
          />
          <span
            data-ripple
            className="absolute top-0 left-0 z-30 size-[34px] rounded-full border-2"
            style={{ borderColor: VIOLET, visibility: "hidden", opacity: 0 }}
          />
          <div data-cursor className="absolute top-0 left-0 z-40" style={{ visibility: "hidden" }}>
            <svg width="17" height="24" viewBox="0 0 17 24" className="-translate-x-[1.5px] -translate-y-[1.5px]">
              <path
                d="M1.5 1.5v18.4l4.7-4.5 3.2 7.1 3.1-1.4-3.2-7h6.5z"
                fill="#ffffff"
                stroke="#111111"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>

      <div data-transcript className="min-w-0">
        <TermWindow title="Acestes · Event Viewer" className="h-full" bodyClassName="min-h-[300px]">
          <TermLines lines={transcript} reveal />
        </TermWindow>
      </div>
    </div>
  );
}
