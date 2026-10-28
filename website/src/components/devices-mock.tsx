"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  Archive01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  Attachment01Icon,
  BubbleChatIcon,
  Coffee02Icon,
  CommandLineIcon,
  ComputerIcon,
  ComputerPhoneSyncIcon,
  Copy01Icon,
  CpuIcon,
  CursorMagicSelection01Icon,
  EyeIcon,
  Home01Icon,
  ImageAdd01Icon,
  InformationCircleIcon,
  Layers01Icon,
  LinkSquare02Icon,
  Mic01Icon,
  Notification03Icon,
  PaintBoardIcon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  ServerStack01Icon,
  Settings01Icon,
  Shield01Icon,
  ShieldKeyIcon,
  SidebarLeftIcon,
  SlidersHorizontalIcon,
  SmartPhone01Icon,
  SplitIcon,
  StopCircleIcon,
  UnfoldMoreIcon,
  UserShield01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { gsap, prefersReducedMotion, ScrollTrigger, SplitText, useGSAP } from "@/lib/gsap";
import { sound } from "@/lib/sound";
import { AppVersion } from "./app-version";
import { useGlint, useSpin } from "./motion-fx";
import { BrandIcon, Icon } from "./icon";
import { LiveHelmet } from "./live-helmet";
import { StillHelmet } from "./still-helmet";

/*
 * A replica of the Acestes window on its Black theme, drawn at the app's own
 * size and scaled to fit, like the Desktop and Octopus sections'. Built from
 * the renderer: Settings > Devices (SettingsNav, SettingsPage, SettingCard,
 * SettingRow and DevicesSection's ConnectionCard and DeviceRow, with their
 * strings from the en catalog), and the chat (TitleBar, Sidebar,
 * ConversationView's header with its "Runs on" line for a mirrored chat,
 * ToolCall's rows, WorkingIndicator, the composer and StatusBar).
 *
 * The story is the one Devices is for: the fleet in Settings, then a chat on
 * this computer asks for something only another one can do. The agent hands it
 * over with run_on_device, the other computer's chat opens here as a tab, it
 * does the work on its own desktop, and the answer comes back.
 */

const W = 1200;
const H = 760;

// Black theme ramp (lib/app-colors.js)
const RAISED = "#0a0a0a";
const CONTROL = "#141414";
/** --app-active: the rule between device rows (neutral-700 in the app). */
const ACTIVE_STEP = "#2a2a2a";

/** Ace, the selected agent: agentInk(violet).lineDark. */
const INK = "#a375f2";

const GROUND = [
  "radial-gradient(560px 420px at 0 0, color-mix(in srgb, #7c3aed 9%, transparent), transparent 72%)",
  "radial-gradient(420px 560px at 0 100%, color-mix(in srgb, #c084fc 4%, transparent), transparent 72%)",
  "linear-gradient(to bottom, rgb(255 255 255 / 0.025), rgb(255 255 255 / 0) 420px)",
].join(", ");

const LIST_FADE =
  "linear-gradient(to bottom, #000 calc(100% - 72px), rgb(0 0 0 / 0.9) calc(100% - 54px), rgb(0 0 0 / 0.6) calc(100% - 36px), rgb(0 0 0 / 0.25) calc(100% - 18px), transparent)";

const MONO = "font-[family-name:var(--font-app-mono)]";

/** The tab already open, the new chat, and the one front-desk runs. */
const OTHER = "Audit sudoers on prod";
const TITLE = "Front desk printer queue";
const MIRROR = "Clear the print queue";
const PROMPT = "The front desk printer is stuck again. Clear its queue.";
const BRIEF =
  "The HP LaserJet at the front desk is stuck. Open its print queue on this computer, cancel the stuck documents, and check the printer shows Ready.";

const CHATS = [
  "Slow staging builds since Monday",
  "Failed SSH logins on bastion",
  "Disk filling up on db-01",
  "Renew TLS certs before Friday",
  "Postgres replica lag on db-02",
  "Upgrade nginx on the web fleet",
  "Why the backup cron never ran",
  "Clean up old Docker images",
  "Grafana alert noise",
];

/** SETTINGS_CATEGORIES in SettingsNav.jsx, with a rule between the groups. */
const NAV: { id: string; label: string; icon?: IconSvgElement; group: string }[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon, group: "app" },
  { id: "assistant", label: "AI Agent", group: "agent" },
  { id: "permissions", label: "Permissions", icon: UserShield01Icon, group: "agent" },
  { id: "agentic", label: "Agentic Use", icon: CursorMagicSelection01Icon, group: "agent" },
  { id: "chat", label: "Chat & Voice", icon: BubbleChatIcon, group: "agent" },
  { id: "channels", label: "Channels", icon: SmartPhone01Icon, group: "agent" },
  { id: "devices", label: "Devices", icon: ComputerPhoneSyncIcon, group: "agent" },
  { id: "appearance", label: "Appearance", icon: PaintBoardIcon, group: "machine" },
  { id: "servers", label: "SSH & Servers", icon: ServerStack01Icon, group: "machine" },
  { id: "security", label: "Security", icon: ShieldKeyIcon, group: "machine" },
  { id: "backup", label: "Backup", icon: Archive01Icon, group: "machine" },
  { id: "about", label: "About", icon: InformationCircleIcon, group: "machine" },
];

type Device = {
  name: string;
  os: string;
  user: string;
  version?: string;
  self?: boolean;
  relay?: boolean;
  locked?: boolean;
  seen?: string;
};

/** The fleet as DeviceRow draws it: OS, version and user, then whether it is on. */
const DEVICES: Device[] = [
  { name: "workstation", os: "Windows 11 Pro", user: "brad", self: true, relay: true },
  { name: "front-desk", os: "Windows 11 Pro", user: "reception" },
  { name: "dc-01", os: "Windows Server 2022 Standard", user: "Administrator", locked: true },
  { name: "old-laptop", os: "Windows 10 Home", user: "brad", version: "1.5.6", seen: "10/26/2026, 6:04:12 PM" },
];

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

/** WorkingIndicator.jsx's spinner: a chat at work, on its tab, its row and its working line. */
function Ring() {
  const ref = useSpin<SVGSVGElement>();
  return (
    <svg ref={ref} viewBox="0 0 12 12" className="size-3 shrink-0" aria-hidden="true">
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

/** WorkingIndicator.jsx's phrase, with the light passing over it. */
function Phrase({ name, text }: { name: string; text: string }) {
  const ref = useGlint<HTMLSpanElement>();
  return (
    <span className="grid overflow-hidden">
      <span ref={ref} data-phrase={name} className="app-glint whitespace-nowrap">
        {text}
      </span>
    </span>
  );
}

/** A chat at work, or done while you were elsewhere: the spinner, then the dot. */
function Busy({ name }: { name: string }) {
  return (
    <>
      <span data-spin={name} className="grid size-3 shrink-0 place-items-center" style={{ display: "none" }}>
        <Ring />
      </span>
      <span data-dot={name} className="grid size-3 shrink-0 place-items-center" style={{ display: "none" }}>
        <span className="size-1.5 rounded-full bg-white" />
      </span>
    </>
  );
}

/** A TitleBar.jsx chat tab: the agent's mark, the title, and the spinner or the dot. */
function Tab({ name, children, hidden = false }: { name: string; children: ReactNode; hidden?: boolean }) {
  return (
    <span
      data-tab={name}
      className="shrink-0 overflow-hidden"
      style={hidden ? { display: "none", width: 0 } : { width: 150 }}
    >
      <span
        data-face={name}
        className="flex w-[150px] items-center gap-2 overflow-hidden rounded-xl px-3 py-2 text-xs font-medium text-gray-400"
        style={{ background: RAISED }}
      >
        <StillHelmet color={INK} size={16} />
        {children}
      </span>
    </span>
  );
}

/** A Sidebar.jsx chat row. */
function ChatRow({ name, children, hidden = false }: { name?: string; children: ReactNode; hidden?: boolean }) {
  return (
    <div
      data-row={name}
      className="shrink-0 overflow-hidden"
      style={hidden ? { display: "none", height: 0 } : { height: 32 }}
    >
      <div
        data-face={name ? `row-${name}` : undefined}
        className="flex h-8 items-center gap-2 rounded-[10px] px-3 text-[13px] text-gray-400"
      >
        {children}
      </div>
    </div>
  );
}

/** Untitled until the conversation has a title, as a new chat is. */
function Titled({ title }: { title: string }) {
  return (
    <span className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap">
      <span data-untitled>New conversation</span>
      <span data-titled style={{ display: "none" }}>
        {title}
      </span>
    </span>
  );
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

function Bubble({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div data-step={name} className="flex justify-end">
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-white px-3 py-2 text-[13px] leading-relaxed text-black">
        {children}
      </div>
    </div>
  );
}

/**
 * ToolCall.jsx's row. A tool tool-bucket gives a verb to gets its icon and the
 * verb (read_screen reads, run_on_device runs); one it does not, like click,
 * gets the status dot and its own title ("Clicked").
 */
function ToolRow({ name, icon, label, detail }: { name: string; icon?: IconSvgElement; label: string; detail: string }) {
  return (
    <div data-step={name} className="overflow-hidden rounded-lg bg-white/[0.035]">
      <div className="flex h-8 items-center gap-2 px-2.5">
        {icon ? (
          <Icon icon={icon} size={14} strokeWidth={2} className="shrink-0 text-gray-500" />
        ) : (
          <span className="size-1.5 shrink-0 rounded-full bg-emerald-500" />
        )}
        <span className="shrink-0 text-[11px] font-medium text-gray-400">{label}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">{detail}</span>
        <Icon icon={ArrowDown01Icon} size={13} strokeWidth={2} className="ml-auto shrink-0 text-gray-600" />
      </div>
    </div>
  );
}

/** The conversation panel's header: the mark, the title, and the scope, or for a mirror where it runs. */
function Header({ title, device }: { title: ReactNode; device?: string }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-white/[0.06] px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <StillHelmet color={INK} size={18} />
        <span className="flex min-w-0 truncate text-xs font-semibold text-white">{title}</span>
      </div>
      <div className="w-64 max-w-[40%] shrink-0">
        {device ? (
          <span className="flex h-8 items-center justify-center gap-1.5 truncate text-xs font-medium text-gray-300">
            <Icon icon={ComputerIcon} size={14} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">Runs on {device}</span>
          </span>
        ) : (
          <div className="flex h-8 items-center gap-1.5 rounded-xl pr-2 pl-2.5">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-200">No session open</span>
            <Icon icon={ArrowDown01Icon} size={12} strokeWidth={2} className="shrink-0 text-gray-600" />
          </div>
        )}
      </div>
      {[Search01Icon, Copy01Icon, CommandLineIcon, SplitIcon, LinkSquare02Icon].map((i, n) => (
        <span key={n} className="grid size-8 shrink-0 place-items-center rounded-xl text-gray-400">
          <Icon icon={i} size={16} strokeWidth={1.75} />
        </span>
      ))}
    </div>
  );
}

/** The composer: an outline, no surface of its own. */
function Composer({ name, typing = false }: { name: string; typing?: boolean }) {
  return (
    <div className="shrink-0 p-3">
      <div className="rounded-2xl border" style={{ borderColor: CONTROL }}>
        <div className="relative min-h-[34px] px-3 pt-2.5 pb-1 text-[13px] leading-relaxed text-white">
          <span className="pointer-events-none absolute top-2.5 right-3 left-3 text-gray-600">
            <span data-idle={name}>Ask about your servers</span>
            <span data-busy={name} style={{ display: "none" }}>
              Queue a follow-up…
            </span>
          </span>
          {typing && (
            <>
              <span data-typed className="relative" />
              <span
                data-tcaret
                className="app-caret relative ml-px inline-block h-[1.05em] w-px translate-y-[2px] bg-white"
                style={{ display: "none" }}
              />
            </>
          )}
        </div>
        <div className="flex items-center gap-1 px-2 pb-2">
          <span className="flex h-7 items-center gap-0.5 rounded-xl pr-1 pl-1.5 text-gray-600">
            <Icon icon={Shield01Icon} size={14} strokeWidth={1.5} />
            <Icon icon={ArrowDown01Icon} size={11} strokeWidth={2} className="opacity-60" />
          </span>
          <span className="grid size-7 place-items-center rounded-full text-sm font-semibold text-gray-400">/</span>
          <span className="grid size-7 place-items-center rounded-full text-sm font-semibold text-gray-400">@</span>
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
            {typing && (
              <span data-send-slot className="relative grid size-7 shrink-0 place-items-center">
                <span data-send className="invisible grid size-7 place-items-center rounded-full bg-white text-black">
                  <Icon icon={ArrowUp01Icon} size={15} strokeWidth={2.5} />
                </span>
              </span>
            )}
            <span
              data-busy={name}
              className="grid size-7 place-items-center rounded-full text-gray-300"
              style={{ display: "none", background: CONTROL }}
            >
              <Icon icon={StopCircleIcon} size={15} strokeWidth={2} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** WorkingIndicator.jsx: the spinner and a phrase for the work in hand. */
function Working({ name, text }: { name: string; text: string }) {
  return (
    <div
      data-working={name}
      className="flex h-8 shrink-0 items-center gap-2 px-2.5 text-[11px] text-gray-500"
      style={{ display: "none" }}
    >
      <Ring />
      <Phrase name={name} text={text} />
    </div>
  );
}

/* ---------------- Settings > Devices ---------------- */

const CHIP = "inline-flex items-center rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-gray-300";

function Dot({ on }: { on: boolean }) {
  return <span className={`inline-block size-2 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-[#1f1f1f]"}`} />;
}

/** DevicesSection.jsx's DeviceRow. */
function DeviceRow({ d, first }: { d: Device; first: boolean }) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3 ${first ? "" : "border-t"}`}
      style={{ borderColor: ACTIVE_STEP }}
    >
      <div data-device={d.name} className="flex min-w-0 items-start gap-3">
        <span className="mt-1.5 flex">
          <Dot on={!d.seen} />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-white">
            <span className="truncate">{d.name}</span>
            {d.self && <span className={CHIP}>this computer</span>}
            {d.relay && <span className={CHIP}>hosts the relay</span>}
            {d.locked && <span className={CHIP}>locked</span>}
          </p>
          <p className="mt-0.5 truncate text-xs text-gray-400">
            {d.os} · Acestes {d.version ?? <AppVersion />} · {d.user}
          </p>
          {!d.self && <p className="mt-0.5 text-xs text-gray-400">{d.seen ? `Last seen ${d.seen}` : "Online"}</p>}
        </div>
      </div>
      {d.self ? (
        <span className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold whitespace-nowrap text-gray-400">
          Rename
        </span>
      ) : (
        <span className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold whitespace-nowrap text-red-400">
          Remove
        </span>
      )}
    </div>
  );
}

/** SettingCard.jsx in the Black theme: neutral-800/50 on neutral-800. */
function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border p-6" style={{ background: "rgb(20 20 20 / 0.5)", borderColor: CONTROL }}>
      {children}
    </div>
  );
}

function SettingsView() {
  return (
    <div data-view="settings" className="absolute inset-0 flex flex-col overflow-hidden p-6">
      <div className="flex items-start gap-6">
        {/* SettingsNav.jsx */}
        <nav className="flex w-40 shrink-0 flex-col gap-0.5">
          {NAV.map((n, i) => {
            const active = n.id === "devices";
            const rule = i > 0 && NAV[i - 1].group !== n.group;
            return (
              <div key={n.id} className="flex flex-col gap-0.5">
                {rule && <div className="mx-3 my-1.5 h-px bg-white/[0.08]" />}
                <span
                  className={`flex h-9 items-center gap-2.5 rounded-xl px-3 text-sm ${
                    active ? "font-semibold text-white" : "text-gray-400"
                  }`}
                  style={active ? { background: CONTROL } : undefined}
                >
                  {n.icon ? (
                    <Icon icon={n.icon} size={17} strokeWidth={active ? 2 : 1.5} className="shrink-0" />
                  ) : (
                    <StillHelmet color="#9ca3af" size={20} />
                  )}
                  {n.label}
                </span>
              </div>
            );
          })}
        </nav>

        {/* SettingsPage.jsx with DevicesSection.jsx in it */}
        <div className="max-w-3xl min-w-0 flex-1 pb-8">
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-6 px-1">
              <div className="min-w-0">
                <h2 className="text-xl font-bold text-white">Devices</h2>
                <p className="mt-1 text-sm text-gray-400">
                  Your other computers with Acestes on them, working as one: other PCs, and Windows servers you reach
                  by RDP.
                </p>
              </div>
              <div className="relative flex w-60 shrink-0">
                <Icon
                  icon={Search01Icon}
                  size={15}
                  strokeWidth={2}
                  className="absolute top-1/2 left-3 -translate-y-1/2 text-gray-400"
                />
                <span
                  className="flex h-9 w-full items-center rounded-xl border bg-black pr-8 pl-9 text-sm text-gray-600"
                  style={{ borderColor: CONTROL }}
                >
                  Search settings
                </span>
              </div>
            </div>

            {/* ConnectionCard */}
            <Card>
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-2">
                  <h4 className="text-base font-semibold text-white">Your devices</h4>
                  <span className="flex items-center gap-2 text-sm text-gray-300">
                    <Dot on />
                    Connected
                  </span>
                </div>
                <span className="inline-flex h-9 shrink-0 items-center rounded-xl border border-white/[0.16] px-4 text-sm font-semibold text-gray-200">
                  Disconnect
                </span>
              </div>
              <div className="mt-4 flex min-w-0 flex-col gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={CHIP}>Tailscale</span>
                  <span className={`${MONO} truncate text-xs text-white`}>100.101.42.7:7377</span>
                  <span className="shrink-0 text-xs text-gray-400">(hosted on this computer)</span>
                </div>
                <p className="text-xs text-gray-400">
                  Only computers signed in to the same Tailscale account can connect, wherever they are.
                </p>
              </div>
              <div className="mt-5">
                {DEVICES.map((d, i) => (
                  <DeviceRow key={d.name} d={d} first={i === 0} />
                ))}
              </div>
            </Card>

            {/* AddComputer */}
            <Card>
              <h4 className="text-base font-semibold text-white">Add a computer</h4>
              <p className="mt-1 text-sm text-gray-400">
                Make a one-time code here and paste it into Acestes on the other computer.
              </p>
              <div className="mt-6 flex flex-col gap-4">
                <span className="inline-flex h-9 w-fit items-center rounded-xl bg-white px-4 text-sm font-semibold text-black">
                  Make a code
                </span>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

export function DevicesMock() {
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
      const all = (selector: string) => q(selector) as HTMLElement[];

      const cursor = one("[data-cursor]");
      const views = { settings: one('[data-view="settings"]'), chat: one('[data-view="chat"]'), mirror: one('[data-view="mirror"]') };
      const empty = one("[data-empty]");
      const typed = one("[data-typed]");
      const tcaret = one("[data-tcaret]");
      const send = one("[data-send]");
      const count = one("[data-count]");
      const bell = one("[data-bell]");
      const settingsNav = one("[data-nav-settings]");
      const settingsIcon = one("[data-nav-settings-icon]");

      // Who is in front: a tab in the title bar, its row in the sidebar.
      const faces = ["home", "other", "chat", "mirror"];
      const front = (name: string, at: string | number, tl?: gsap.core.Timeline) => {
        const set = (target: gsap.TweenTarget, vars: gsap.TweenVars) => (tl ? tl.set(target, vars, at) : gsap.set(target, vars));
        for (const f of faces) {
          const on = f === name;
          set(one(`[data-face="${f}"]`), { backgroundColor: on ? CONTROL : RAISED, color: on ? "#ffffff" : "#9ca3af" });
          const row = q(`[data-face="row-${f}"]`)[0];
          if (row) set(row, { backgroundColor: on ? "rgb(20 20 20 / 0.8)" : "rgb(20 20 20 / 0)", color: on ? "#ffffff" : "#9ca3af" });
        }
        const home = name === "home";
        set(settingsNav, { backgroundColor: home ? "rgb(20 20 20 / 0.8)" : "rgb(20 20 20 / 0)", color: home ? "#ffffff" : "#9ca3af" });
        set(settingsIcon, { color: home ? INK : "#737373" });
        set(views.settings, { display: home ? "" : "none" });
        set(views.chat, { display: name === "chat" ? "flex" : "none" });
        set(views.mirror, { display: name === "mirror" ? "flex" : "none" });
      };

      const viewport = (name: string) => one(`[data-viewport="${name}"]`);
      const inner = (name: string) => one(`[data-inner="${name}"]`);
      const toBottom = (name: string) => () => -Math.max(0, inner(name).scrollHeight - viewport(name).clientHeight);

      // The finished window, for reduced motion: the chat in front with its
      // answer, front-desk's tab beside it, done.
      if (prefersReducedMotion()) {
        front("chat", 0);
        gsap.set([empty, ...all("[data-untitled]")], { display: "none" });
        gsap.set(all("[data-titled]"), { display: "" });
        gsap.set(all("[data-tab]"), { display: "", width: 150 });
        gsap.set(all("[data-row]"), { display: "", height: 32 });
        gsap.set(all('[data-step]'), { display: "", autoAlpha: 1 });
        gsap.set(all("[data-run-busy]"), { display: "none" });
        gsap.set(all("[data-run-done]"), { display: "" });
        gsap.set(count, { textContent: "3 tabs" });
        gsap.set(inner("chat"), { y: toBottom("chat") });
        return;
      }

      gsap.set(all("[data-step]"), { display: "none", autoAlpha: 0 });

      const tl = gsap.timeline({ paused: true, defaults: { ease: "power3.out", duration: 0.4 } });

      // The pointer: to the middle of a control, measured when it gets there.
      const point = (selector: string) => () => {
        const r = el.getBoundingClientRect();
        const a = one(selector).getBoundingClientRect();
        const k = r.width / W;
        return { x: (a.left - r.left + a.width / 2) / k - 3, y: (a.top - r.top + a.height / 2) / k - 2 };
      };
      const move = (selector: string, at: string | number, duration = 0.7) => {
        const p = point(selector);
        tl.to(cursor, { x: () => p().x, y: () => p().y, duration, ease: "power3.inOut" }, at);
      };
      const press = (node: HTMLElement, at: string | number = ">") => {
        tl.call(() => sound.play("press"), [], at);
        tl.to(node, { scale: 0.94, duration: 0.07, ease: "power2.in" }, "<").to(node, { scale: 1, duration: 0.14 });
      };

      const follow = (name: string, at: string | number = "<") => tl.to(inner(name), { y: toBottom(name), duration: 0.5 }, at);

      const show = (view: string, step: string, at: string | number = "+=0.45", cue?: "step" | "blip") => {
        const node = one(`[data-step="${step}"]`);
        tl.set(node, { display: "" }, at);
        follow(view);
        tl.fromTo(node, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0 }, "<");
        if (cue) tl.call(() => sound.play(cue), [], "<");
      };

      // Prose streams in word by word, the way a reply arrives.
      const say = (view: string, step: string, at: string | number = "+=0.4", pace = 0.04) => {
        const node = one(`[data-step="${step}"]`);
        const words = node.querySelector<HTMLElement>("[data-type]");
        tl.set(node, { display: "", autoAlpha: 1 }, at);
        follow(view);
        if (!words) return;
        const split = SplitText.create(words, { type: "words" });
        gsap.set(split.words, { autoAlpha: 0 });
        tl.to(split.words, { autoAlpha: 1, duration: 0.12, stagger: pace, ease: "none" }, "<");
      };

      const work = (name: string, text: string, at: string | number = "<") => {
        const phrase = one(`[data-phrase="${name}"]`);
        tl.set(phrase, { textContent: text }, at);
        tl.fromTo(phrase, { yPercent: 100, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.24 }, "<");
      };

      // One moment for several changes: a relative position like "+=0.2"
      // would push each one further along than the last.
      let marks = 0;
      const moment = (at: string | number) => {
        const label = `m${marks++}`;
        tl.addLabel(label, at);
        return label;
      };

      const busy = (name: string, on: boolean, at: string | number) => {
        const when = moment(at);
        tl.set(all(`[data-spin="${name}"]`), { display: on ? "" : "none" }, when);
        tl.set(all(`[data-busy="${name}"]`), { display: on ? "" : "none" }, when);
        tl.set(all(`[data-idle="${name}"]`), { display: on ? "none" : "" }, when);
        tl.set(one(`[data-working="${name}"]`), { display: on ? "" : "none" }, when);
      };

      const open = (name: string, at: string | number, width = 150) => {
        const tab = one(`[data-tab="${name}"]`);
        const row = one(`[data-row="${name}"]`);
        tl.set([tab, row], { display: "" }, at);
        tl.fromTo(tab, { width: 0, autoAlpha: 0 }, { width, autoAlpha: 1, duration: 0.45 }, "<");
        tl.fromTo(row, { height: 0, autoAlpha: 0 }, { height: 32, autoAlpha: 1, duration: 0.4 }, "<");
      };

      const titled = (name: string, at: string | number) => {
        const when = moment(at);
        for (const node of [one(`[data-tab="${name}"]`), one(`[data-row="${name}"]`), views.chat]) {
          tl.set(node.querySelector("[data-untitled]"), { display: "none" }, when);
          tl.set(node.querySelector("[data-titled]"), { display: "" }, when);
          tl.fromTo(node.querySelector("[data-titled]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, when);
        }
      };

      // 1. Settings, Devices: the fleet. The pointer passes over front-desk.
      front("home", 0, tl);
      tl.fromTo(cursor, { autoAlpha: 0, x: W * 0.82, y: H * 0.94 }, { autoAlpha: 1, duration: 0.3 }, 0.5);
      move('[data-device="front-desk"]', "<", 1.1);

      // 2. A new chat, from the title bar's +.
      move("[data-plus]", "+=1.2", 0.8);
      press(one("[data-plus]"), ">0.05");
      open("chat", "<");
      tl.set(count, { textContent: "2 tabs" }, "<");
      front("chat", "<", tl);

      // 3. The ask, typed and sent.
      move("[data-send-slot]", "+=0.35", 0.7);
      tl.set(tcaret, { display: "" }, "<0.3");
      tl.set(one('[data-idle="chat"]'), { autoAlpha: 0 }, "<");
      tl.fromTo(send, { scale: 0, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.18 }, "<0.05");
      let shown = 0;
      tl.to(
        typed,
        {
          text: PROMPT,
          duration: PROMPT.length * 0.03,
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
        "<",
      );
      press(send, "+=0.25");
      tl.call(() => sound.play("send"), [], "<");
      tl.set(typed, { text: "" }, ">");
      tl.set(tcaret, { display: "none" }, "<");
      tl.to(send, { scale: 0, autoAlpha: 0, duration: 0.15 }, "<");
      tl.to(cursor, { autoAlpha: 0, y: "+=24", duration: 0.4 }, "<0.3");
      tl.set(one('[data-idle="chat"]'), { autoAlpha: 1 }, "<");
      tl.to(empty, { autoAlpha: 0, duration: 0.2 }, "<").set(empty, { display: "none" });
      busy("chat", true, "<");
      work("chat", "Thinking", "<");
      show("chat", "c-user", "<", undefined);
      titled("chat", "+=0.9");

      // 4. It belongs to front-desk: the hand-off, and its tab opens here.
      say("chat", "c-p1", "<0.2");
      work("chat", "Plotting the route", "+=0.2");
      show("chat", "c-hand", "+=0.3", "blip");
      open("mirror", "+=0.35");
      busy("mirror", true, "<");
      tl.set(count, { textContent: "3 tabs" }, "<");

      // 5. Into front-desk's tab: its own agent works its own desktop.
      tl.to(cursor, { autoAlpha: 1, duration: 0.3 }, "+=0.5");
      move('[data-tab="mirror"]', "<", 0.8);
      press(one('[data-face="mirror"]'), ">0.05");
      front("mirror", "<", tl);
      tl.set(one('[data-step="m-user"]'), { display: "", autoAlpha: 1 }, "<");
      work("mirror", "Getting the lay of the land", "<");
      tl.to(cursor, { autoAlpha: 0, y: "+=24", duration: 0.4 }, "+=0.3");
      say("mirror", "m-p1", "+=0.1");
      show("mirror", "m-open", "+=0.35", "step");
      show("mirror", "m-read1", "+=0.5", "step");
      show("mirror", "m-click1", "+=0.5", "step");
      show("mirror", "m-read2", "+=0.5", "step");
      say("mirror", "m-p2", "+=0.4");
      work("mirror", "Untangling the spaghetti", "<");
      show("mirror", "m-click2", "+=0.4", "step");
      show("mirror", "m-click3", "+=0.5", "step");
      show("mirror", "m-read3", "+=0.5", "step");
      say("mirror", "m-p3", "+=0.4");
      busy("mirror", false, "+=0.2");
      tl.call(() => sound.play("chime"), [], "<");

      // 6. The answer comes back to the chat that asked: done while elsewhere.
      const back = "+=0.6";
      tl.set(one("[data-run-busy]"), { display: "none" }, back);
      tl.set(all("[data-run-done]"), { display: "" }, "<");
      tl.set(one('[data-step="c-p2"]'), { display: "", autoAlpha: 1 }, "<");
      busy("chat", false, "<");
      tl.set(all('[data-dot="chat"]'), { display: "" }, "<");
      tl.fromTo(all('[data-dot="chat"]'), { scale: 0 }, { scale: 1, duration: 0.3, ease: "back.out(3)" }, "<");
      tl.set(bell, { display: "" }, "<");
      tl.fromTo(bell, { scale: 0 }, { scale: 1, duration: 0.3, ease: "back.out(3)" }, "<");
      tl.call(() => sound.play("blip"), [], "<");

      tl.fromTo(cursor, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 }, "+=0.5");
      move('[data-tab="chat"]', "<", 0.8);
      press(one('[data-face="chat"]'), ">0.05");
      front("chat", "<", tl);
      tl.set(all('[data-dot="chat"]'), { display: "none" }, "<");
      tl.set(bell, { display: "none" }, "<");
      follow("chat", "<");
      tl.to(cursor, { autoAlpha: 0, y: "+=24", duration: 0.4 }, "+=0.4");
      tl.to({}, { duration: 2 });

      const st = ScrollTrigger.create({ trigger: el, start: "top 70%", once: true, onEnter: () => tl.play() });
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
        style={{ aspectRatio: `${W} / ${H}` }}
      >
        <p className="sr-only">
          A replica of Acestes on workstation. Settings, Devices lists the fleet: workstation, front-desk, dc-01 and
          old-laptop. A new chat asks for the front desk printer queue to be cleared; the agent hands the task to
          front-desk, whose conversation opens here as a tab. Its agent opens the print queue on front-desk&apos;s own
          desktop, cancels the stuck documents and checks the printer is Ready, and the answer comes back to the chat.
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
                data-face="home"
                className="flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-white"
                style={{ background: CONTROL }}
              >
                <Icon icon={Home01Icon} size={14} strokeWidth={1.5} />
                Home
              </span>
              <span className="-mx-1.5 h-4 w-px shrink-0 bg-white/[0.08]" />
              <div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden">
                <Tab name="other">
                  <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{OTHER}</span>
                </Tab>
                <Tab name="chat" hidden>
                  <Titled title={TITLE} />
                  <Busy name="chat" />
                </Tab>
                <Tab name="mirror" hidden>
                  <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{MIRROR}</span>
                  <Busy name="mirror" />
                </Tab>
                <span data-plus className="grid size-8 shrink-0 place-items-center rounded-xl text-gray-500">
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
                  data-bell
                  className="absolute top-1.5 right-1.5 size-2 rounded-full bg-blue-500 ring-2 ring-black"
                  style={{ display: "none" }}
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
            {/* Sidebar */}
            <div className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-hidden">
              <div className="flex items-center gap-2.5 rounded-xl py-1.5 pr-2.5 pl-1.5">
                <StillHelmet color={INK} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] leading-5 font-semibold tracking-[-0.01em] text-white">
                    Ace
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-neutral-500">Agent</span>
                </span>
                <Icon icon={UnfoldMoreIcon} size={14} strokeWidth={2} className="shrink-0 text-neutral-500" />
              </div>
              <div className="mt-1.5 flex flex-col gap-0.5">
                <div className="flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium text-gray-400">
                  <Icon icon={Layers01Icon} size={17} strokeWidth={1.6} className="shrink-0 text-neutral-500" />
                  Inventory
                </div>
                <div
                  data-nav-settings
                  className="flex h-8 items-center gap-2.5 rounded-lg px-3 text-[13px] font-medium text-white"
                  style={{ background: "rgb(20 20 20 / 0.8)" }}
                >
                  <span data-nav-settings-icon className="flex shrink-0" style={{ color: INK }}>
                    <Icon icon={Settings01Icon} size={17} strokeWidth={1.6} />
                  </span>
                  Settings
                </div>
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
                <ChatRow name="mirror" hidden>
                  <Busy name="mirror" />
                  <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{MIRROR}</span>
                </ChatRow>
                <ChatRow name="chat" hidden>
                  <Busy name="chat" />
                  <Titled title={TITLE} />
                </ChatRow>
                <ChatRow name="other">
                  <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{OTHER}</span>
                </ChatRow>
                {CHATS.map((c) => (
                  <ChatRow key={c}>
                    <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">{c}</span>
                  </ChatRow>
                ))}
              </div>
            </div>

            {/* Main panel */}
            <div className="relative min-w-0 flex-1 overflow-hidden rounded-[16px]" style={{ background: RAISED }}>
              <SettingsView />

              {/* The chat on this computer */}
              <div data-view="chat" className="absolute inset-0 flex-col" style={{ display: "none" }}>
                <Header title={<Titled title={TITLE} />} />
                <div className="mx-auto flex min-h-0 w-full max-w-[768px] flex-1 flex-col">
                  <div data-viewport="chat" className="relative min-h-0 flex-1 overflow-hidden">
                    {/* A new chat's empty page: the mark, a line of the Aeneid, the note */}
                    <div
                      data-empty
                      className="absolute inset-0 mx-auto flex w-full max-w-sm flex-col items-center justify-center px-1 py-6 text-center"
                    >
                      <span className="mb-3 block size-20">
                        <LiveHelmet line={INK} lineDark={INK} size={80} />
                      </span>
                      <h2 className="text-sm font-semibold text-white">
                        No stranger to trouble myself, I have learned to help the troubled.
                      </h2>
                      <p className="mt-1 text-[11px] text-gray-600 italic">
                        Non ignara mali, miseris succurrere disco. · Aeneid 1
                      </p>
                      <p className="mt-3 text-xs leading-relaxed text-gray-500">
                        Say what you need. I open the sessions, do the work, check the result, and remember what we
                        learned.
                      </p>
                    </div>
                    <div data-inner="chat" className="flex flex-col gap-3 p-3">
                      <Bubble name="c-user">{PROMPT}</Bubble>
                      <Prose name="c-p1">
                        That printer is plugged into <strong className="font-semibold">front-desk</strong>, so the
                        work has to happen on that computer. Handing it over.
                      </Prose>
                      {/* run_on_device: tool-bucket files it under run, so the verb is Run */}
                      <div data-step="c-hand" className="overflow-hidden rounded-lg bg-white/[0.035]">
                        <div className="flex items-center">
                          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 px-2.5">
                            <span data-run-busy className="flex shrink-0 animate-pulse text-blue-500">
                              <Icon icon={CommandLineIcon} size={14} strokeWidth={2} />
                            </span>
                            <span data-run-done className="flex shrink-0 text-gray-500" style={{ display: "none" }}>
                              <Icon icon={CommandLineIcon} size={14} strokeWidth={2} />
                            </span>
                            <span className="shrink-0 text-[11px] font-medium text-gray-400">Run</span>
                            <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">
                              front-desk: {MIRROR}
                            </span>
                            <span data-run-done style={{ display: "none" }}>
                              <Icon icon={ArrowDown01Icon} size={13} strokeWidth={2} className="shrink-0 text-gray-600" />
                            </span>
                          </div>
                          <span
                            data-run-done
                            className="flex h-8 shrink-0 items-center gap-1 px-2.5 text-[11px] font-medium text-gray-400"
                            style={{ display: "none" }}
                          >
                            Open
                            <Icon icon={ArrowUpRight01Icon} size={12} strokeWidth={2} />
                          </span>
                        </div>
                      </div>
                      <Working name="chat" text="Thinking" />
                      <Prose name="c-p2">
                        <strong className="font-semibold">Done on front-desk.</strong> Three stuck documents
                        cancelled, the queue is empty and the HP LaserJet shows Ready. Every step is in its tab.
                      </Prose>
                    </div>
                  </div>
                  <Composer name="chat" typing />
                </div>
              </div>

              {/* front-desk's chat, mirrored here */}
              <div data-view="mirror" className="absolute inset-0 flex-col" style={{ display: "none" }}>
                <Header title={MIRROR} device="front-desk" />
                <div className="mx-auto flex min-h-0 w-full max-w-[768px] flex-1 flex-col">
                  <div data-viewport="mirror" className="relative min-h-0 flex-1 overflow-hidden">
                    <div data-inner="mirror" className="flex flex-col gap-3 p-3">
                      <Bubble name="m-user">{BRIEF}</Bubble>
                      <Prose name="m-p1">Opening the printer&apos;s queue.</Prose>
                      <ToolRow name="m-open" label="Opened" detail="ms-settings:printers" />
                      <ToolRow name="m-read1" icon={EyeIcon} label="Read" detail="Settings" />
                      <ToolRow name="m-click1" label="Clicked" detail="element 14" />
                      <ToolRow name="m-read2" icon={EyeIcon} label="Read" detail="HP LaserJet M404 - Print queue" />
                      <Prose name="m-p2">Three documents, all stuck in Error. Cancelling them.</Prose>
                      <ToolRow name="m-click2" label="Clicked" detail="element 9" />
                      <ToolRow name="m-click3" label="Clicked" detail="element 3" />
                      <ToolRow name="m-read3" icon={EyeIcon} label="Read" detail="HP LaserJet M404 - Print queue" />
                      <Prose name="m-p3">
                        <strong className="font-semibold">Cleared.</strong> The three stuck documents are cancelled,
                        the queue is empty and the printer shows Ready.
                      </Prose>
                      <Working name="mirror" text="Getting the lay of the land" />
                    </div>
                  </div>
                  <Composer name="mirror" />
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
              <span className="flex shrink-0 items-center pl-2">
                <span className="shrink-0 pr-1.5 text-neutral-400">work</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-neutral-500">5h</span>
                  <span className="relative h-[3px] w-7 overflow-hidden rounded-full bg-white/[0.09]">
                    <span className="absolute inset-y-0 left-0 w-[34%] rounded-full bg-neutral-300/80" />
                  </span>
                  <span className="min-w-[1.9em] text-gray-300">34%</span>
                </span>
              </span>
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
            <path d="M4 2.5 20 11l-7.2 1.9L9 20z" fill="white" stroke="black" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}
