"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Attachment01Icon,
  Clock01Icon,
  CodeIcon,
  ComputerIcon,
  Coffee02Icon,
  CpuIcon,
  FlashIcon,
  Home01Icon,
  ImageAdd01Icon,
  Layers01Icon,
  Mic01Icon,
  Notification03Icon,
  OctopusIcon,
  PlusSignIcon,
  Search01Icon,
  SecurityCheckIcon,
  ServerStack01Icon,
  Settings01Icon,
  Shield01Icon,
  SidebarLeftIcon,
  Tick02Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { CrestId, HelmetId } from "@/lib/helmet/renderer";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import type { BrandName } from "@/lib/brand-paths";
import { sound } from "@/lib/sound";
import { closeJob, H, playJob, primeWork, Ring, settleWork, SH, SIDE, SW, W, Work, type PanelId } from "./home-work";
import { BrandIcon, Icon } from "./icon";
import { LiveHelmet } from "./live-helmet";
import { StillHelmet } from "./still-helmet";

/*
 * A replica of the Acestes window on Home, on its Black theme, drawn at the
 * app's own size and scaled to fit, like the Desktop section's. Built from the
 * renderer: HomeStart and OctopusBar (the octopus controls on the card's top
 * edge and the agent picker), the Home layout in AssistantConversation
 * (HomeShell, the greeting, the card and its mode tag, the composer, the
 * starters), CipherField (the band of characters around the card),
 * ApprovalMenu and ModelMenu (the chips), Tooltip, TitleBar, Sidebar and
 * StatusBar.
 *
 * The story: octopus mode is switched on once, then prompts keep going out
 * to the three agents, without end, each opening its tab behind Home while
 * Home stays put. Beside the window, each job opens where it runs
 * (home-work.tsx): a shell on a server, a Windows machine over Remote
 * Desktop, a check across the fleet. When it is done its window and its tab
 * close, and the next ones come.
 */

// Black theme ramp (lib/app-colors.js)
const RAISED = "#0a0a0a";
const CONTROL = "#141414";

/** The window's ground, washed with the selected agent's colour, violet (.app-ground). */
const GROUND = [
  "radial-gradient(560px 420px at 0 0, color-mix(in srgb, #7c3aed 9%, transparent), transparent 72%)",
  "radial-gradient(420px 560px at 0 100%, color-mix(in srgb, #c084fc 4%, transparent), transparent 72%)",
  "linear-gradient(to bottom, rgb(255 255 255 / 0.025), rgb(255 255 255 / 0) 420px)",
].join(", ");

const LIST_FADE =
  "linear-gradient(to bottom, #000 calc(100% - 72px), rgb(0 0 0 / 0.9) calc(100% - 54px), rgb(0 0 0 / 0.6) calc(100% - 36px), rgb(0 0 0 / 0.25) calc(100% - 18px), transparent)";

type Mode = "always" | "writes" | "never";

/** ApprovalMenu's modes: the chip's icon, the tag's words, and whether it is the loud amber. */
const MODES: Record<Mode, { label: string; icon: IconSvgElement; loud: boolean }> = {
  always: { label: "Ask every time", icon: SecurityCheckIcon, loud: false },
  writes: { label: "Workspace only", icon: Shield01Icon, loud: false },
  never: { label: "Yolo Mode", icon: FlashIcon, loud: true },
};

type Agent = {
  id: string;
  name: string;
  helmet: HelmetId;
  crest: CrestId;
  /** agentInk(colour).lineDark: the mark's ink on a dark theme. */
  ink: string;
  brand: BrandName;
  model: string;
  account?: string;
  effort?: string;
  mode: Mode;
  /** Whether its runtime reads pictures, so the composer offers to attach one. */
  images: boolean;
};

/** The three agents from the Team section, with what each is sent. */
const AGENTS: Agent[] = [
  {
    id: "ace",
    name: "Ace",
    helmet: "corinthian",
    crest: "plume",
    ink: "#a375f2",
    brand: "claude",
    model: "Opus 5.5",
    account: "work",
    effort: "Extra high",
    mode: "writes",
    images: true,
  },
  {
    id: "palinurus",
    name: "Palinurus",
    helmet: "barbute",
    crest: "none",
    ink: "#50b696",
    brand: "openai",
    model: "GPT-5.5",
    effort: "High",
    mode: "never",
    images: true,
  },
  {
    id: "achates",
    name: "Achates",
    helmet: "viking",
    crest: "horns",
    ink: "#e4a051",
    brand: "ollama",
    model: "qwen3:32b",
    mode: "always",
    images: false,
  },
];
const [ACE, PALINURUS, ACHATES] = AGENTS;

/**
 * What Home sends, in order, round and round: each to its agent (reached with
 * the arrow, or picked from the list), and where its work opens.
 */
type Job = { panel: PanelId; agent: Agent; via?: "next" | "pick"; prompt: string; title: string };
const JOBS: Job[] = [
  {
    panel: "ssh-web",
    agent: ACE,
    prompt: "Check disk space on the web fleet and clear old logs on anything over 80%.",
    title: "Disk space on the web fleet",
  },
  {
    panel: "rdp-desk",
    agent: PALINURUS,
    via: "next",
    prompt: "The printer at front-desk is stuck again. Clear its queue.",
    title: "Print queue on front-desk",
  },
  {
    panel: "fleet-audit",
    agent: ACHATES,
    via: "pick",
    prompt: "Audit sudoers and SSH config on all 20 hosts. Report only, change nothing.",
    title: "Sudo and SSH audit",
  },
  {
    panel: "ssh-nginx",
    agent: ACE,
    via: "next",
    prompt: "nginx on web-03 is throwing 502s. Find out why and fix it.",
    title: "502s on web-03",
  },
  {
    panel: "rdp-dc",
    agent: PALINURUS,
    via: "next",
    prompt: "Maria is locked out again. Unlock her account on dc-02.",
    title: "Unlock Maria on dc-02",
  },
  {
    panel: "fleet-tls",
    agent: ACHATES,
    via: "next",
    prompt: "Which TLS certificates expire in the next 30 days? Check all 20 hosts.",
    title: "TLS certificates due",
  },
];

/** The chat that was already open, and Ace's older ones in the sidebar. */
const OPEN = "Checkout tests failing after #212";
const CHATS = [
  "Audit sudoers on prod",
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
];

/** The starters under Home's composer (STARTERS in AssistantConversation). */
const STARTERS: { icon: IconSvgElement; label: string }[] = [
  { icon: ServerStack01Icon, label: "Check my servers" },
  { icon: SecurityCheckIcon, label: "Security audit" },
  { icon: ComputerIcon, label: "Use my desktop" },
  { icon: CodeIcon, label: "Fix code" },
  { icon: Clock01Icon, label: "Schedule a job" },
];

const noop = () => () => {};

/** The hour's greeting, as Home picks it. */
function greeting(hour: number) {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}

/* ------------------------------------------------------------------ */
/* CipherField                                                         */
/* ------------------------------------------------------------------ */

const CELL_W = 7;
const CELL_H = 13;
const FPS = 12;
const RAMP = [".", ":", "-", "=", "+", "*", "x", "X"];
const GLYPHS = "0123456789ABCDEF#%$&";
const ABOVE = 26;
const BELOW = 44;
const CLEAR = 6;

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function skyline(u: number, t: number) {
  return (
    0.55 +
    0.2 * Math.sin(u * 2.3 + t * 0.35) +
    0.12 * Math.sin(u * 6.1 - t * 0.55) +
    0.06 * Math.sin(u * 13.7 + t * 0.9)
  );
}

/**
 * CipherField.jsx, line for line: a low skyline of cipher text around the
 * card, densest at its foot, turning over a few cells at a time. Drawn in the
 * window's own units (the window is scaled as a whole), at a dozen frames a
 * second while on screen, still under reduced motion.
 */
function Cipher({ cardRef, scale }: { cardRef: RefObject<HTMLDivElement | null>; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const still = prefersReducedMotion();
    const born = performance.now();
    let width = 0;
    let height = 0;
    let card: { left: number; right: number; top: number; bottom: number } | null = null;

    const measure = () => {
      const box = canvas.getBoundingClientRect();
      const target = cardRef.current?.getBoundingClientRect();
      const ratio = Math.min(2, window.devicePixelRatio || 1) * scale;
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      const pw = Math.round(width * ratio);
      const ph = Math.round(height * ratio);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      card =
        target && target.width > 0
          ? {
              left: (target.left - box.left) / scale,
              right: (target.right - box.left) / scale,
              top: (target.top - box.top) / scale,
              bottom: (target.bottom - box.top) / scale,
            }
          : null;
    };

    const draw = (now: number) => {
      context.clearRect(0, 0, width, height);
      if (!card || width === 0) return;
      const t = still ? 0 : (now - born) / 1000;
      const centre = (card.left + card.right) / 2;
      const cardHalf = (card.right - card.left) / 2;
      const side = Math.max(0, Math.min(width / 2 - 8 - cardHalf, cardHalf * 0.75));
      const half = cardHalf + side;
      const top = card.top - ABOVE;
      const bottom = card.bottom + BELOW;
      const span = bottom - top;
      if (half <= 0 || span <= 0) return;
      context.font = `10px "JetBrains Mono", ui-monospace, Consolas, monospace`;
      context.textBaseline = "top";
      context.fillStyle = "#737373";
      const firstCol = Math.floor((centre - half) / CELL_W);
      const lastCol = Math.ceil((centre + half) / CELL_W);
      for (let row = Math.floor(top / CELL_H); row <= Math.ceil(bottom / CELL_H); row += 1) {
        const y = row * CELL_H;
        const v = (y + CELL_H / 2 - top) / span;
        if (v < 0 || v > 1) continue;
        const insideRows = y + CELL_H > card.top - CLEAR && y < card.bottom + CLEAR;
        for (let col = firstCol; col <= lastCol; col += 1) {
          const x = col * CELL_W;
          if (insideRows && x + CELL_W > card.left - CLEAR && x < card.right + CLEAR) continue;
          const offset = Math.abs(x + CELL_W / 2 - centre);
          const u = (x + CELL_W / 2 - centre) / half;
          const reach = side > 0 ? 1 - Math.max(0, offset - cardHalf) / side : 1;
          if (reach <= 0) continue;
          const lit = skyline(u, t);
          const depth = (lit - (1 - v)) / lit;
          if (depth <= 0) continue;
          const density = Math.min(0.78, depth ** 0.6 * reach ** 0.7);
          const pace = 0.35 + hash(col, row, 7) * 1.1;
          const turn = Math.floor(t * pace + hash(col, row, 3) * 10);
          if (hash(col, row, turn) > Math.min(0.95, density * 1.15)) continue;
          let glyph;
          if (density > 0.45 && hash(col, row, turn + 101) < 0.06) {
            glyph = GLYPHS[Math.floor(hash(col, row, turn + 202) * GLYPHS.length)];
          } else {
            const index = Math.floor(density * RAMP.length + (hash(col, row, turn + 303) - 0.5) * 5);
            glyph = RAMP[Math.max(0, Math.min(RAMP.length - 1, index))];
          }
          context.globalAlpha = 0.22 + 0.48 * density;
          context.fillText(glyph, x, y);
        }
      }
      context.globalAlpha = 1;
    };

    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < 1000 / FPS) return;
      last = now;
      measure();
      draw(now);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    measure();
    draw(performance.now());
    const seen = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !still && !frame) frame = requestAnimationFrame(tick);
      else if (!entry.isIntersecting) stop();
    });
    seen.observe(canvas);
    const ro = new ResizeObserver(() => {
      measure();
      draw(performance.now());
    });
    ro.observe(canvas);
    return () => {
      stop();
      seen.disconnect();
      ro.disconnect();
    };
  }, [cardRef, scale]);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />;
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** Tooltip.jsx's bubble: the name, and the chord in grey; arrow under it, placed above its control. */
function Tip({
  name,
  label,
  hint,
  align = "center",
}: {
  name: string;
  label: string;
  hint?: string;
  align?: "center" | "end";
}) {
  return (
    <span
      data-tip={name}
      className={`pointer-events-none absolute bottom-full z-30 mb-2 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] leading-none font-medium whitespace-nowrap text-gray-200 shadow-[0_2px_10px_rgba(0,0,0,0.22)] ${
        align === "end" ? "-right-1.5" : "left-1/2 -translate-x-1/2"
      }`}
      style={{ background: RAISED, borderColor: CONTROL, display: "none" }}
    >
      <span
        className={`absolute -bottom-[5px] size-2 rotate-45 border-r border-b ${align === "end" ? "right-3" : "left-1/2 -ml-1"}`}
        style={{ background: RAISED, borderColor: CONTROL }}
      />
      <span className="relative">{label}</span>
      {hint && <span className="relative text-[10px] text-neutral-500 tabular-nums">{hint}</span>}
    </span>
  );
}

/** A TitleBar.jsx chat tab, opened behind Home: the agent's mark, the title, and the spinner or the dot. */
function Tab({ agent, title, id }: { agent: Agent; title: string; id?: PanelId }) {
  const opened = Boolean(id);
  return (
    <span
      data-tab={id}
      className="shrink-0 overflow-hidden"
      style={opened ? { display: "none", width: 0 } : { width: 130 }}
    >
      <span
        className="flex w-[130px] items-center gap-2 overflow-hidden rounded-xl px-3 py-2 text-xs font-medium text-gray-400"
        style={{ background: RAISED }}
      >
        <StillHelmet helmet={agent.helmet} crest={agent.crest} color={agent.ink} size={16} />
        <span className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap">
          {opened ? (
            <>
              <span data-untitled>New conversation</span>
              <span data-titled style={{ display: "none" }}>
                {title}
              </span>
            </>
          ) : (
            title
          )}
        </span>
        {opened && (
          <>
            <span data-spin className="grid size-3 shrink-0 place-items-center">
              <Ring />
            </span>
            <span data-dot className="grid size-3 shrink-0 place-items-center" style={{ display: "none" }}>
              <span className="size-1.5 rounded-full bg-white" />
            </span>
          </>
        )}
      </span>
    </span>
  );
}

function ChatRow({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 rounded-[10px] px-3 text-[13px] text-gray-400">
      {children}
      <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{title}</span>
    </div>
  );
}

function Meter({ account, used, lead }: { account?: string; used: number; lead: string }) {
  return (
    <span className={`flex shrink-0 items-center ${lead}`}>
      {account && <span className="shrink-0 pr-1.5 text-neutral-400">{account}</span>}
      <span className="flex items-center gap-1.5">
        <span className="text-neutral-500">5h</span>
        <span className="relative h-[3px] w-7 overflow-hidden rounded-full bg-white/[0.09]">
          <span className="absolute inset-y-0 left-0 rounded-full bg-neutral-300/80" style={{ width: `${used}%` }} />
        </span>
        <span className="min-w-[1.9em] text-gray-300">{used}%</span>
      </span>
    </span>
  );
}

/** Shown for one agent at a time: the composer is the target agent's. */
const only = (agent: Agent) => ({
  "data-agent": agent.id,
  style: agent.id === ACE.id ? undefined : { display: "none" },
});

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

export function HomeMock() {
  const stage = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1250 / SW);
  // The visitor's own hour, as the app greets by the clock; evening on the server.
  const hello = useSyncExternalStore(
    noop,
    () => greeting(new Date().getHours()),
    () => "Good evening",
  );

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / SW);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useGSAP(
    () => {
      const el = root.current;
      const wide = stage.current;
      if (!el || !wide) return;
      const q = gsap.utils.selector(el);
      const one = (selector: string) => q(selector)[0] as HTMLElement;
      const all = (selector: string) => q(selector) as HTMLElement[];

      const cursor = one("[data-cursor]");
      const typed = one("[data-typed]");
      const tcaret = one("[data-tcaret]");
      const send = one("[data-send]");
      const toggle = one("[data-toggle]");
      const bar = one("[data-bar]");
      const phOff = one("[data-ph-off]");
      const phOn = one("[data-ph-on]");
      const chip = one("[data-chip]");
      const menu = one("[data-menu]");
      const count = one("[data-count]");
      const nextButton = one("[data-next]");
      const tabOf = (job: Job) => one(`[data-tab="${job.panel}"]`);
      const tabs = (n: number) => (n === 1 ? "1 tab" : `${n} tabs`);

      const target = (id: string) => [
        { targets: all("[data-agent]").filter((n) => n.dataset.agent !== id), vars: { display: "none" } },
        { targets: all(`[data-agent="${id}"]`), vars: { display: "" } },
      ];
      const octopusOn = { backgroundColor: "rgb(139 92 246 / 0.1)", color: "#c4b5fd" };

      // A still, for reduced motion: octopus on, the first three jobs open
      // beside the window and done, their tabs behind Home.
      if (prefersReducedMotion()) {
        const shown = JOBS.slice(0, 3);
        gsap.set(phOff, { display: "none" });
        gsap.set([phOn, bar], { display: "" });
        gsap.set(toggle, octopusOn);
        for (const job of shown) {
          const tab = tabOf(job);
          gsap.set(tab, { display: "", width: 130 });
          gsap.set([tab.querySelector("[data-untitled]"), tab.querySelector("[data-spin]")], { display: "none" });
          gsap.set([tab.querySelector("[data-titled]"), tab.querySelector("[data-dot]")], { display: "" });
        }
        gsap.set(count, { textContent: tabs(shown.length + 1) });
        settleWork(
          wide,
          shown.map((job) => job.panel),
        );
        return;
      }

      // The pointer: to the middle of a control, measured when it gets there.
      const point = (selector: string) => () => {
        const r = el.getBoundingClientRect();
        const a = one(selector).getBoundingClientRect();
        const k = r.width / W;
        return { x: (a.left - r.left + a.width / 2) / k - 3, y: (a.top - r.top + a.height / 2) / k - 2 };
      };

      // Steps on a timeline, each at the time given; each returns when it ends.
      const steps = (tl: gsap.core.Timeline) => {
        const move = (selector: string, at: number, duration = 0.6) => {
          const p = point(selector);
          tl.to(cursor, { x: () => p().x, y: () => p().y, duration, ease: "power3.inOut" }, at);
          return at + duration;
        };
        const press = (node: HTMLElement, at: number) => {
          tl.call(() => sound.play("press"), [], at);
          tl.to(node, { scale: 0.9, duration: 0.07, ease: "power2.in" }, at);
          tl.to(node, { scale: 1, duration: 0.14 }, at + 0.07);
          return at + 0.21;
        };
        const tip = (name: string, show: boolean, at: number) => {
          const node = one(`[data-tip="${name}"]`);
          if (show) {
            tl.set(node, { display: "" }, at);
            tl.fromTo(node, { autoAlpha: 0, y: 3 }, { autoAlpha: 1, y: 0, duration: 0.16, immediateRender: false }, at);
          } else {
            tl.to(node, { autoAlpha: 0, duration: 0.1 }, at);
            tl.set(node, { display: "none" }, at + 0.1);
          }
        };
        return { move, press, tip };
      };

      // Hidden by opacity too, so the loop rewinds each round to hidden, not to opaque.
      primeWork(wide);
      gsap.set(send, { autoAlpha: 0, scale: 0 });

      // Once: the octopus button, its tooltip, then on, and the bar opens beside it.
      const intro = gsap.timeline({ paused: true, defaults: { ease: "power3.out", duration: 0.4 } });
      {
        const { move, press, tip } = steps(intro);
        intro.fromTo(cursor, { autoAlpha: 0, x: W * 0.78, y: H * 0.96 }, { autoAlpha: 1, duration: 0.3 }, 0.4);
        const t = move("[data-toggle]", 0.4, 1);
        tip("toggle", true, t + 0.05);
        tip("toggle", false, t + 1.2);
        press(toggle, t + 1.2);
        intro.to(toggle, { ...octopusOn, duration: 0.2 }, t + 1.2);
        intro.set(bar, { display: "" }, t + 1.2);
        intro.fromTo(
          bar,
          { width: 0, autoAlpha: 0 },
          { width: "auto", autoAlpha: 1, duration: 0.35, immediateRender: false },
          t + 1.2,
        );
        intro.set(phOff, { display: "none" }, t + 1.2);
        intro.set(phOn, { display: "" }, t + 1.2);
        intro.to(cursor, { autoAlpha: 0, duration: 0.3 }, t + 1.8);
      }

      // Then, round and round: every job sent, worked where it lives, done,
      // its window and its tab closed. It ends as it starts, with Ace in front
      // and no tabs open, so each round runs on from the last.
      const loop = gsap.timeline({ paused: true, repeat: -1, defaults: { ease: "power3.out", duration: 0.4 } });
      {
        const { move, press, tip } = steps(loop);
        const to = (id: string, at: number) => {
          for (const step of target(id)) loop.set(step.targets, step.vars, at);
          loop.fromTo(
            one(`[data-mark="${id}"]`),
            { autoAlpha: 0, scale: 0.94 },
            { autoAlpha: 1, scale: 1, duration: 0.35, ease: "power2.out", immediateRender: false },
            at,
          );
        };
        // Alt+→, by the arrow.
        const next = (id: string, at: number, hint = false) => {
          let t = move("[data-next]", at, 0.5);
          if (hint) {
            tip("next", true, t + 0.05);
            t += 0.9;
            tip("next", false, t);
          }
          press(nextButton, t);
          to(id, t);
          return t + 0.3;
        };
        // The picker, and the agent from its list.
        const pick = (id: string, at: number) => {
          const item = one(`[data-pick="${id}"]`);
          let t = move("[data-chip]", at, 0.55);
          press(chip, t);
          loop.to(chip, { backgroundColor: "rgb(255 255 255 / 0.07)", color: "#fff", duration: 0.12 }, t);
          loop.set(menu, { display: "" }, t);
          loop.fromTo(menu, { autoAlpha: 0, y: -4 }, { autoAlpha: 1, y: 0, duration: 0.18, immediateRender: false }, t);
          t = move(`[data-pick="${id}"]`, t + 0.3, 0.5);
          loop.to(item, { backgroundColor: CONTROL, duration: 0.12 }, t - 0.1);
          t = press(item, t + 0.2);
          loop.to(menu, { autoAlpha: 0, duration: 0.12 }, t);
          loop.set(menu, { display: "none" }, t + 0.12);
          loop.to(item, { backgroundColor: "rgb(20 20 20 / 0)", duration: 0.05 }, t + 0.12);
          loop.to(chip, { backgroundColor: "rgb(255 255 255 / 0)", color: "#e5e5e5", duration: 0.15 }, t);
          to(id, t);
          return t + 0.3;
        };
        // Typed into the box, a key at a time; the send button arrives with the first.
        const type = (text: string, at: number) => {
          let shown = 0;
          loop.set(phOn, { autoAlpha: 0 }, at);
          loop.set(tcaret, { display: "" }, at);
          loop.fromTo(
            send,
            { scale: 0, autoAlpha: 0 },
            { scale: 1, autoAlpha: 1, duration: 0.18, immediateRender: false },
            at + 0.05,
          );
          loop.to(
            typed,
            {
              text,
              duration: text.length * 0.03,
              ease: "none",
              onStart: () => {
                shown = 0;
              },
              onUpdate: () => {
                const n = typed.textContent?.length ?? 0;
                if (n > shown) sound.play("type");
                shown = n;
              },
            },
            at + 0.05,
          );
          return at + 0.05 + text.length * 0.03;
        };
        // Sent: the tab opens behind Home, "Sent to" shows for its 2.5 s, and
        // the composer comes back empty for the next one.
        const sent = (job: Job, at: number) => {
          const tab = tabOf(job);
          const status = one(`[data-sent="${job.agent.id}"]`);
          const landed = press(send, at);
          loop.call(() => sound.play("send"), [], at);
          loop.set(typed, { text: "" }, landed);
          loop.set(tcaret, { display: "none" }, landed);
          loop.to(send, { scale: 0, autoAlpha: 0, duration: 0.15 }, landed);
          loop.set(phOn, { autoAlpha: 1 }, landed);
          loop.set(status, { display: "" }, landed);
          loop.fromTo(status, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, immediateRender: false }, landed);
          loop.set(tab, { display: "" }, landed);
          loop.fromTo(
            tab,
            { width: 0, autoAlpha: 0 },
            { width: 130, autoAlpha: 1, duration: 0.45, immediateRender: false },
            landed,
          );
          // Its title, once the conversation has one.
          const titled = tab.querySelector("[data-titled]");
          loop.set(tab.querySelector("[data-untitled]"), { display: "none" }, landed + 1.3);
          loop.set(titled, { display: "" }, landed + 1.3);
          loop.fromTo(titled, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, immediateRender: false }, landed + 1.3);
          loop.to(status, { autoAlpha: 0, duration: 0.25 }, landed + 2.5);
          loop.set(status, { display: "none" }, landed + 2.75);
          return landed;
        };
        // Done while Home was in front: the spinner turns into the dot.
        const done = (job: Job, at: number) => {
          const tab = tabOf(job);
          const dot = tab.querySelector("[data-dot]");
          loop.set(tab.querySelector("[data-spin]"), { display: "none" }, at);
          loop.set(dot, { display: "" }, at);
          loop.fromTo(dot, { scale: 0 }, { scale: 1, duration: 0.3, ease: "back.out(3)", immediateRender: false }, at);
          loop.call(() => sound.play("blip"), [], at);
        };
        // Seen and closed.
        const close = (job: Job, at: number) => {
          const tab = tabOf(job);
          loop.to(tab, { width: 0, autoAlpha: 0, duration: 0.35, ease: "power2.inOut" }, at);
          loop.set(tab, { display: "none" }, at + 0.35);
        };

        const counts: [number, number][] = [];
        let t = 0.1;
        loop.fromTo(
          cursor,
          { autoAlpha: 0, x: () => point("[data-send-slot]")().x + 50, y: () => point("[data-send-slot]")().y + 60 },
          { autoAlpha: 1, duration: 0.3, immediateRender: false },
          t,
        );
        let last = 0;
        JOBS.forEach((job, n) => {
          if (job.via === "next") t = next(job.agent.id, t + 0.35, n === 1);
          if (job.via === "pick") t = pick(job.agent.id, t + 0.35);
          t = move("[data-send-slot]", t + 0.15, 0.55);
          t = type(job.prompt, t + 0.1);
          const landed = sent(job, t + 0.25);
          counts.push([landed, 1]);
          const finished = playJob(loop, wide, job.panel, landed + 0.35);
          done(job, finished);
          closeJob(loop, wide, job.panel, finished + 2.4);
          close(job, finished + 2.55);
          counts.push([finished + 2.55, -1]);
          last = Math.max(last, finished + 2.9);
          t = landed + 0.2;
        });
        // Back to Ace for the next round, and the pointer rests.
        t = next(ACE.id, t + 0.6);
        loop.to(cursor, { autoAlpha: 0, y: "+=20", duration: 0.35 }, t + 0.3);

        // The status bar's count of tabs, as they open and close.
        let open = 1;
        for (const [at, change] of counts.sort((a, b) => a[0] - b[0])) {
          open += change;
          loop.set(count, { textContent: tabs(open) }, at);
        }
        loop.to({}, { duration: 0.01 }, Math.max(last, t + 0.7) + 0.6);
      }

      // Plays while on screen, paused off it: the intro once, then the loop.
      let active = intro;
      let seen = false;
      intro.eventCallback("onComplete", () => {
        active = loop;
        if (seen) loop.play();
      });
      const st = ScrollTrigger.create({
        trigger: wide,
        start: "top 75%",
        end: "bottom 10%",
        onToggle: (self) => {
          seen = self.isActive;
          if (seen) active.play();
          else active.pause();
        },
      });
      if (st.isActive) {
        seen = true;
        active.play();
      }
    },
    { scope: stage },
  );

  return (
    <div className="relative w-full">
      <div ref={stage} className="relative w-full" style={{ aspectRatio: `${SW} / ${SH}` }}>
        <div
          className="absolute top-0 overflow-hidden rounded-[12px] bg-black shadow-[0_40px_120px_-30px_rgb(0_0_0/0.7)] ring-1 ring-white/[0.12]"
          style={{ left: `${(SIDE / SW) * 100}%`, width: `${(W / SW) * 100}%`, aspectRatio: `${W} / ${H}` }}
        >
          <p className="sr-only">
            A replica of Acestes on Home with octopus mode on, sending prompt after prompt to three agents, each in its
            own tab behind Home, while each job opens beside the window where it runs: Ace clears old logs over SSH on
            web-02 and restarts php-fpm on web-03, Palinurus uses the mouse and keyboard over Remote Desktop to clear a
            stuck print queue on front-desk and unlock a user on dc-02, and Achates checks sudo, SSH and certificates on
            20 hosts without changing anything. Each job finishes, its tab closes, and it goes round again.
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
                  className="flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-white"
                  style={{ background: CONTROL }}
                >
                  <Icon icon={Home01Icon} size={14} strokeWidth={1.5} />
                  Home
                </span>
                <span className="-mx-1.5 h-4 w-px shrink-0 bg-white/[0.08]" />
                <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden">
                  <Tab agent={ACE} title={OPEN} />
                  {JOBS.map((job) => (
                    <Tab key={job.panel} agent={job.agent} title={job.title} id={job.panel} />
                  ))}
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
                </span>
                <span className="grid size-8 place-items-center rounded-xl text-gray-400">
                  <svg className="size-3" viewBox="0 0 12 12">
                    <rect y="5" width="12" height="1" fill="currentColor" />
                  </svg>
                </span>
                <span className="grid size-8 place-items-center rounded-xl text-gray-400">
                  <svg className="size-3" viewBox="0 0 12 12">
                    <rect
                      width="10"
                      height="10"
                      x="1"
                      y="1"
                      rx="1"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      fill="none"
                    />
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
              {/* Sidebar: the selected agent, Ace, and its conversations */}
              <div className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-hidden">
                <div className="flex items-center gap-2.5 rounded-xl py-1.5 pr-2.5 pl-1.5">
                  <StillHelmet helmet={ACE.helmet} crest={ACE.crest} color={ACE.ink} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-5 font-semibold tracking-[-0.01em] text-white">
                      {ACE.name}
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
                  <ChatRow title={OPEN} />
                  {CHATS.map((c) => (
                    <ChatRow key={c} title={c} />
                  ))}
                </div>
              </div>

              {/* Main panel: Home */}
              <div
                className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[16px]"
                style={{ background: RAISED }}
              >
                <Cipher cardRef={card} scale={scale} />
                <div className="relative mx-auto flex w-full max-w-[46rem] flex-1 flex-col justify-center px-6 pt-10 pb-[106px]">
                  {/* The greeting: the target agent's mark, large and alive */}
                  <div className="mb-8 flex flex-col items-center text-center">
                    <span className="agent-float relative mb-6 block size-[72px]">
                      {AGENTS.map((a) => (
                        <span key={a.id} data-mark={a.id} {...only(a)} className="absolute inset-0">
                          <LiveHelmet helmet={a.helmet} crest={a.crest} line={a.ink} lineDark={a.ink} size={72} />
                        </span>
                      ))}
                    </span>
                    <h3 className="text-[34px] leading-[1.15] font-medium tracking-[-0.03em] text-white">{hello}</h3>
                    <p className="mt-3 max-w-md text-[13px] leading-relaxed text-neutral-400">
                      Say what you need. I open the sessions, do the work, check the result, and remember what we
                      learned.
                    </p>
                  </div>

                  {/* The card: its top edge, then the composer */}
                  <div ref={card}>
                    <div className="w-full rounded-[20px] border border-white/[0.07] bg-white/[0.025] p-1">
                      <div className="flex items-center px-2.5 pt-1 pb-1.5 leading-5">
                        {AGENTS.map((a) => (
                          <span
                            key={a.id}
                            {...only(a)}
                            className={`shrink-0 rounded-md px-1.5 text-[11px] font-medium ${
                              MODES[a.mode].loud ? "bg-amber-500/10 text-amber-400" : "bg-violet-500/10 text-violet-300"
                            }`}
                          >
                            {MODES[a.mode].label}
                          </span>
                        ))}

                        {/* OctopusBar.jsx */}
                        <div className="ml-auto flex min-w-0 items-center gap-0.5">
                          {AGENTS.map((a) => (
                            <span
                              key={a.id}
                              data-sent={a.id}
                              className="mr-1.5 truncate text-[11px] text-neutral-500"
                              style={{ display: "none" }}
                            >
                              Sent to {a.name}
                            </span>
                          ))}
                          <div
                            data-bar
                            className="flex items-center gap-0.5 overflow-visible"
                            style={{ display: "none" }}
                          >
                            <span className="grid size-5 shrink-0 place-items-center rounded-md text-neutral-500">
                              <Icon icon={ArrowLeft01Icon} size={12} strokeWidth={2} />
                            </span>
                            <span className="relative">
                              <span
                                data-chip
                                className="flex h-5 max-w-[11rem] items-center gap-1 rounded-md pr-1 pl-1 text-[11px] font-medium text-neutral-200"
                              >
                                {AGENTS.map((a) => (
                                  <span key={a.id} {...only(a)} className="flex min-w-0 items-center gap-1">
                                    <StillHelmet helmet={a.helmet} crest={a.crest} color={a.ink} size={13} />
                                    <span className="truncate">{a.name}</span>
                                  </span>
                                ))}
                                <Icon
                                  icon={ArrowDown01Icon}
                                  size={11}
                                  strokeWidth={2}
                                  className="shrink-0 text-neutral-500"
                                />
                              </span>
                              {/* AgentPicker's list, under the chip, its right edge on the chip's */}
                              <span
                                data-menu
                                className="absolute top-full right-0 z-30 mt-1.5 block min-w-[220px] rounded-xl border p-1 shadow-xl shadow-black/40"
                                style={{ background: RAISED, borderColor: CONTROL, display: "none" }}
                              >
                                <span className="block px-2.5 pt-1 pb-1.5 text-[10px] font-medium text-neutral-500">
                                  Send to
                                </span>
                                {AGENTS.map((a) => (
                                  <span
                                    key={a.id}
                                    data-pick={a.id}
                                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs text-gray-300"
                                  >
                                    <StillHelmet helmet={a.helmet} crest={a.crest} color={a.ink} size={14} />
                                    <span className="flex-1 truncate font-medium">{a.name}</span>
                                    {a.id === "palinurus" && (
                                      <Icon
                                        icon={Tick02Icon}
                                        size={13}
                                        strokeWidth={2}
                                        className="shrink-0 text-neutral-400"
                                      />
                                    )}
                                  </span>
                                ))}
                              </span>
                            </span>
                            <span
                              data-next
                              className="relative grid size-5 shrink-0 place-items-center rounded-md text-neutral-500"
                            >
                              <Icon icon={ArrowRight01Icon} size={12} strokeWidth={2} />
                              <Tip name="next" label="Next agent" hint="Alt+→" />
                            </span>
                          </div>
                          <span
                            data-toggle
                            className="relative ml-1 grid size-5 shrink-0 place-items-center rounded-md text-neutral-500"
                          >
                            <Icon icon={OctopusIcon} size={13} strokeWidth={1.75} />
                            <Tip
                              name="toggle"
                              label="Octopus mode: send prompts to any agent, each in a new tab, and stay here"
                              hint="Ctrl+Shift+O"
                              align="end"
                            />
                          </span>
                        </div>
                      </div>

                      {/* The composer */}
                      <div className="relative rounded-2xl border bg-white/[0.035]" style={{ borderColor: CONTROL }}>
                        <div className="relative min-h-[4.5rem] px-4 pt-3.5 pb-1 text-[13px] leading-relaxed text-white">
                          <span className="pointer-events-none absolute top-3.5 right-4 left-4 text-gray-600">
                            <span data-ph-off>
                              <span className="app-caret mr-px inline-block h-[1.05em] w-px translate-y-[2px] bg-white" />
                              How can I help you today?
                            </span>
                            <span data-ph-on style={{ display: "none" }}>
                              <span className="app-caret mr-px inline-block h-[1.05em] w-px translate-y-[2px] bg-white" />
                              {AGENTS.map((a) => (
                                <span key={a.id} {...only(a)}>
                                  Send a prompt to {a.name}
                                </span>
                              ))}
                            </span>
                          </span>
                          <span data-typed />
                          <span
                            data-tcaret
                            className="app-caret ml-px inline-block h-[1.05em] w-px translate-y-[2px] bg-white"
                            style={{ display: "none" }}
                          />
                        </div>
                        <div className="flex items-center gap-1 pr-2 pb-2 pl-2">
                          {AGENTS.map((a) => {
                            const m = MODES[a.mode];
                            return (
                              <span
                                key={a.id}
                                {...only(a)}
                                className={`flex h-7 items-center gap-0.5 rounded-xl pr-1 pl-1.5 ${m.loud ? "text-amber-400" : "text-gray-600"}`}
                              >
                                <Icon icon={m.icon} size={14} strokeWidth={1.5} />
                                <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="opacity-60" />
                              </span>
                            );
                          })}
                          <span className="grid size-7 place-items-center rounded-full text-sm font-semibold text-gray-400">
                            /
                          </span>
                          <span className="grid size-7 place-items-center rounded-full text-sm font-semibold text-gray-400">
                            @
                          </span>
                          <span className="grid size-7 place-items-center rounded-full text-gray-400">
                            <Icon icon={Attachment01Icon} size={15} strokeWidth={2} />
                          </span>
                          {AGENTS.filter((a) => a.images).map((a) => (
                            <span
                              key={a.id}
                              {...only(a)}
                              className="grid size-7 place-items-center rounded-full text-gray-400"
                            >
                              <Icon icon={ImageAdd01Icon} size={15} strokeWidth={2} />
                            </span>
                          ))}
                          <div className="ml-auto flex items-center gap-1">
                            <span className="grid size-7 shrink-0 place-items-center text-gray-400">
                              <svg width="16" height="16" viewBox="0 0 16 16">
                                <circle
                                  cx="8"
                                  cy="8"
                                  r="7"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeOpacity="0.22"
                                  strokeWidth="2"
                                />
                              </svg>
                            </span>
                            {AGENTS.map((a) => (
                              <span
                                key={a.id}
                                {...only(a)}
                                className="flex h-7 items-center gap-1 rounded-xl pr-1.5 pl-2 text-[11px] text-gray-400"
                              >
                                <BrandIcon name={a.brand} size={13} />
                                <span className="font-medium">{a.model}</span>
                                {a.account && <span className="opacity-60">{a.account}</span>}
                                {a.effort && <span className="opacity-60">{a.effort}</span>}
                                <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="opacity-60" />
                              </span>
                            ))}
                            <span className="grid size-7 place-items-center rounded-full text-gray-400">
                              <Icon icon={Mic01Icon} size={15} strokeWidth={2} />
                            </span>
                            <span data-send-slot className="relative grid size-7 shrink-0 place-items-center">
                              <span
                                data-send
                                className="invisible grid size-7 place-items-center rounded-full bg-white text-black"
                              >
                                <Icon icon={ArrowUp01Icon} size={15} strokeWidth={2.5} />
                              </span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* The starters */}
                  <div className="mt-16 flex flex-wrap justify-center gap-1.5">
                    {STARTERS.map((s) => (
                      <span
                        key={s.label}
                        className="flex h-8 max-w-[18rem] items-center gap-1.5 rounded-lg border border-white/[0.08] px-2.5 text-[12px] font-medium text-neutral-300"
                      >
                        <Icon icon={s.icon} size={14} strokeWidth={1.75} className="shrink-0 text-neutral-500" />
                        <span className="truncate">{s.label}</span>
                      </span>
                    ))}
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
                <Meter account="work" used={61} lead="pl-3" />
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
                  <span data-count>1 tab</span>
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
              className="pointer-events-none invisible absolute top-0 left-0 z-40 drop-shadow-[0_2px_4px_rgb(0_0_0/0.5)]"
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

        {/* The work each prompt sets going, where it runs */}
        <Work
          who={Object.fromEntries(JOBS.map((job) => [job.panel, job.agent])) as Record<PanelId, Agent>}
          scale={scale}
        />
      </div>
    </div>
  );
}
