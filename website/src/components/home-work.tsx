"use client";

import type { ReactNode } from "react";
import { ComputerTerminal01Icon, ServerStack01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { CrestId, HelmetId } from "@/lib/helmet/renderer";
import { gsap } from "@/lib/gsap";
import { sound } from "@/lib/sound";
import { useSpin } from "./motion-fx";
import { Icon } from "./icon";
import { OSIcon } from "./os-icons";
import { StillHelmet } from "./still-helmet";

/*
 * The work Home sends out, drawn beside the window: as each prompt goes, a
 * small window opens at the replica's edge and does that job where it lives,
 * then closes. Shells on servers, the mouse and keyboard on Windows machines
 * over Remote Desktop, read-only checks across the fleet. All of it in the
 * stage's own units, so it scales with the replica.
 */

/** The replica's window, at the app's own size. */
export const W = 1200;
export const H = 760;
/** Room either side of it, and under it, for the work to hang over its edges. */
export const SIDE = 150;
const FOOT = 16;
export const SW = W + SIDE * 2;
export const SH = H + FOOT;

export type PanelId = "ssh-web" | "ssh-nginx" | "rdp-desk" | "rdp-dc" | "fleet-audit" | "fleet-tls";

export type Who = { id: string; name: string; helmet: HelmetId; crest: CrestId; ink: string };

const VIOLET = "#7c3aed";
const PANEL = "#0b0b0c";

/** Where each kind of work opens: shells top right, screens bottom left, fleet checks bottom right. */
const SLOT = {
  shell: { x: SIDE + W - 250, y: 64, w: 392 },
  screen: { x: 12, y: 404, w: 470 },
  fleet: { x: SIDE + W - 236, y: 552, w: 376 },
};

export function Ring() {
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

/** A small window of its own: where the work is, then who is doing it and whether it is done. */
function Panel({
  id,
  slot,
  mark,
  place,
  detail,
  who,
  children,
}: {
  id: PanelId;
  slot: keyof typeof SLOT;
  mark: ReactNode;
  place: string;
  detail: string;
  who: Who;
  children: ReactNode;
}) {
  const { x, y, w } = SLOT[slot];
  return (
    <div
      data-sat={id}
      className="absolute overflow-hidden rounded-[14px] shadow-[0_32px_80px_-28px_rgb(0_0_0/0.9)] ring-1 ring-white/[0.13]"
      style={{ left: x, top: y, width: w, background: PANEL, visibility: "hidden" }}
    >
      <div className="flex h-10 items-center gap-2 border-b border-white/[0.06] px-3.5 text-[12.5px]">
        <span className="grid size-4 shrink-0 place-items-center text-neutral-400">{mark}</span>
        <span className="font-medium text-gray-100">{place}</span>
        <span className="truncate text-neutral-500">{detail}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-neutral-400">
          <StillHelmet helmet={who.helmet} crest={who.crest} color={who.ink} size={14} />
          <span>{who.name}</span>
          <span className="ml-1 grid size-3.5 place-items-center">
            <span data-sat-busy className="col-start-1 row-start-1 grid place-items-center text-neutral-400">
              <Ring />
            </span>
            <span
              data-sat-done
              className="col-start-1 row-start-1 grid place-items-center text-emerald-400"
              style={{ visibility: "hidden" }}
            >
              <Icon icon={Tick02Icon} size={14} strokeWidth={2.4} />
            </span>
          </span>
        </span>
      </div>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shells                                                              */
/* ------------------------------------------------------------------ */

type Line = { k: "cmd" | "out" | "ok"; t: string; hot?: string; bad?: boolean; wait?: number };

const SHELLS: Record<"ssh-web" | "ssh-nginx", { place: string; lines: Line[] }> = {
  "ssh-web": {
    place: "web-02",
    lines: [
      { k: "cmd", t: "df -h /var" },
      { k: "out", t: "/dev/sda1   40G   38G  2.0G  ", hot: "95%" },
      { k: "cmd", t: "sudo journalctl --vacuum-time=7d", wait: 0.5 },
      { k: "out", t: "Freed 14.2G of archived journals." },
      { k: "cmd", t: "df -h /var" },
      { k: "out", t: "/dev/sda1   40G   24G   16G  59%" },
      { k: "ok", t: "web-02 down to 59%, the rest under 80%" },
    ],
  },
  "ssh-nginx": {
    place: "web-03",
    lines: [
      { k: "cmd", t: "systemctl status php8.3-fpm" },
      { k: "out", t: "● php8.3-fpm.service  ", hot: "failed (oom-kill)", bad: true },
      { k: "cmd", t: "sudo systemctl restart php8.3-fpm", wait: 0.5 },
      { k: "cmd", t: "curl -sI localhost | head -1" },
      { k: "out", t: "HTTP/1.1 200 OK" },
      { k: "ok", t: "php-fpm back after an OOM kill, 502s gone" },
    ],
  },
};

function Shell({ id, who }: { id: keyof typeof SHELLS; who: Who }) {
  const { place, lines } = SHELLS[id];
  return (
    <Panel
      id={id}
      slot="shell"
      mark={<Icon icon={ComputerTerminal01Icon} size={15} strokeWidth={1.8} />}
      place={place}
      detail="ssh"
      who={who}
    >
      <div className="px-4 pt-3 pb-3.5 font-mono text-[12.5px] leading-[21px] whitespace-pre text-neutral-400">
        {lines.map((l, i) => (
          <p key={i} data-line style={{ visibility: "hidden" }} className="flex gap-2">
            {l.k === "cmd" && (
              <>
                <span className="text-violet-400">❯</span>
                <span data-cmd={l.t} className="text-gray-100">
                  {l.t}
                </span>
              </>
            )}
            {l.k === "out" && (
              <span className="pl-4">
                {l.t}
                {l.hot && <span className={l.bad ? "text-red-400" : "text-amber-400"}>{l.hot}</span>}
              </span>
            )}
            {l.k === "ok" && (
              <>
                <span className="text-emerald-400">✓</span>
                <span className="text-emerald-400">{l.t}</span>
              </>
            )}
          </p>
        ))}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Windows, over Remote Desktop: the shared pieces                      */
/* ------------------------------------------------------------------ */

/** A control's number, as a numbered screenshot draws it. */
function Num({ n }: { n: number }) {
  return (
    <span
      data-num
      className="pointer-events-none absolute -inset-[2px] rounded-[3px] border-[1.5px]"
      style={{ borderColor: `${VIOLET}aa`, visibility: "hidden" }}
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

/** Remote Desktop's connection bar, pinned at the top of a full-screen session. */
function ConnectionBar({ name }: { name: string }) {
  return (
    <div
      className="absolute top-0 left-1/2 z-20 flex h-[18px] w-[200px] -translate-x-1/2 items-center gap-1.5 rounded-b-[5px] px-2 text-[9.5px] text-[#1b1b1b] shadow-[0_2px_6px_rgb(0_0_0/0.35)]"
      style={{ background: "linear-gradient(#f6f8fb, #dde4ee)" }}
    >
      <svg className="size-2.5 shrink-0 text-[#3b3b3b]" viewBox="0 0 12 12" fill="currentColor">
        <path d="M4 1h4l-.6 4 1.6 1.4V7H6.5v4L6 11.6 5.5 11V7H3v-.6L4.6 5z" />
      </svg>
      <svg className="size-2.5 shrink-0 text-[#2b7a2b]" viewBox="0 0 12 12" fill="currentColor">
        <rect x="1" y="8" width="2" height="3" />
        <rect x="4" y="6" width="2" height="5" />
        <rect x="7" y="4" width="2" height="7" />
        <rect x="10" y="2" width="1.5" height="9" />
      </svg>
      <span className="flex-1 text-center font-medium">{name}</span>
      <span className="flex shrink-0 items-center gap-2 text-[#3b3b3b]">
        <svg className="size-2" viewBox="0 0 12 12">
          <rect y="6" width="12" height="1.2" fill="currentColor" />
        </svg>
        <svg className="size-2" viewBox="0 0 12 12">
          <rect x="1" y="3" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M3 3V1h8v8H9" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <svg className="size-2" viewBox="0 0 12 12">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </span>
    </div>
  );
}

/** A caption button on a window's title bar. */
function Caption({ children }: { children: ReactNode }) {
  return <span className="grid h-full w-[24px] place-items-center text-[#1b1b1b]">{children}</span>;
}

function Captions({ help = false }: { help?: boolean }) {
  return (
    <span className="ml-auto flex h-full items-center">
      {help ? (
        <Caption>
          <span className="text-[9px] leading-none">?</span>
        </Caption>
      ) : (
        <>
          <Caption>
            <svg className="size-2" viewBox="0 0 12 12">
              <rect y="6" width="12" height="1" fill="currentColor" />
            </svg>
          </Caption>
          <Caption>
            <svg className="size-2" viewBox="0 0 12 12">
              <rect x="1" y="1" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          </Caption>
        </>
      )}
      <Caption>
        <svg className="size-2" viewBox="0 0 12 12">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1" />
        </svg>
      </Caption>
    </span>
  );
}

/** The machine's own pointer, the Windows arrow, moved by the agent. */
function Pointer() {
  return (
    <svg
      data-pointer
      width="12"
      height="17"
      viewBox="0 0 16 22"
      className="pointer-events-none absolute top-0 left-0 z-30"
      style={{ visibility: "hidden" }}
    >
      <path
        d="M1.5 1v16.6l4.3-4.1 2.8 6.6 2.7-1.1-2.8-6.5h6z"
        fill="white"
        stroke="black"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Tray({ time }: { time: string }) {
  return (
    <div className="ml-auto flex items-center gap-2 pr-2.5 text-white/85">
      <svg className="size-[8px]" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M2 8l4-4 4 4" />
      </svg>
      <svg className="size-[10px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M1.5 6a9.5 9.5 0 0 1 13 0M4 8.8a6 6 0 0 1 8 0M6.4 11.4a2.6 2.6 0 0 1 3.2 0" />
        <circle cx="8" cy="13.6" r="0.9" fill="currentColor" stroke="none" />
      </svg>
      <svg className="size-[10px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M2 6h2.5L8 3v10L4.5 10H2z" fill="currentColor" stroke="none" />
        <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9" />
      </svg>
      <span className="flex flex-col items-end text-[8px] leading-[10px] tabular-nums">
        <span>{time}</span>
        <span>28/10/2026</span>
      </span>
    </div>
  );
}

const FOLDER = (
  <svg className="size-[13px]" viewBox="0 0 16 16">
    <path
      d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.4l1.6 1.6h6A1.5 1.5 0 0 1 15 5.1V12.5A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
      fill="#e8a317"
    />
    <path
      d="M1 6.2A1.2 1.2 0 0 1 2.2 5h11.6A1.2 1.2 0 0 1 15 6.2v6.3A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5z"
      fill="#ffc83d"
    />
  </svg>
);

/* ------------------------------------------------------------------ */
/* front-desk: Windows 11, a stuck print queue                          */
/* ------------------------------------------------------------------ */

/** A lens-shaped petal, from the bloom's heart out to its tip. */
const PETAL = "M0 0C52-50 150-46 210 0C150 46 52 50 0 0Z";
/** The petals: angle, length and opacity, fanned up and to the left. */
const PETALS: [number, number, number][] = [
  [-176, 0.78, 0.4],
  [-150, 0.98, 0.5],
  [-124, 1.08, 0.58],
  [-98, 1.05, 0.58],
  [-72, 1, 0.52],
  [-46, 0.9, 0.46],
  [-20, 0.78, 0.4],
  [8, 0.62, 0.3],
];
const INNER: [number, number][] = [
  [-140, 0.55],
  [-104, 0.62],
  [-70, 0.58],
  [-36, 0.48],
];

/** A dark, Windows 11 style wallpaper: a blue bloom opening on a night-blue ground. */
function Bloom() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 470 264"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 size-full"
    >
      <defs>
        <radialGradient id="fd-sky" cx="72%" cy="78%" r="85%">
          <stop offset="0" stopColor="#0d3478" />
          <stop offset="0.4" stopColor="#071b42" />
          <stop offset="0.85" stopColor="#02060f" />
        </radialGradient>
        <linearGradient id="fd-petal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0a3cb8" />
          <stop offset="0.55" stopColor="#2386ff" />
          <stop offset="1" stopColor="#a8dcff" />
        </linearGradient>
        <linearGradient id="fd-inner" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3a9bff" />
          <stop offset="1" stopColor="#dff3ff" />
        </linearGradient>
        <radialGradient id="fd-glow">
          <stop offset="0" stopColor="#8fd0ff" stopOpacity="0.7" />
          <stop offset="1" stopColor="#8fd0ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="470" height="264" fill="url(#fd-sky)" />
      <g transform="translate(372 214)">
        {PETALS.map(([a, s, o]) => (
          <path
            key={a}
            d={PETAL}
            fill="url(#fd-petal)"
            opacity={o}
            transform={`rotate(${a}) scale(${s} ${s * 0.92})`}
            style={{ mixBlendMode: "screen" }}
          />
        ))}
        {INNER.map(([a, s]) => (
          <path
            key={a}
            d={PETAL}
            fill="url(#fd-inner)"
            opacity={0.32}
            transform={`rotate(${a}) scale(${s} ${s * 0.8})`}
            style={{ mixBlendMode: "screen" }}
          />
        ))}
        <circle r="64" fill="url(#fd-glow)" />
      </g>
    </svg>
  );
}

/** The printer's own glyph, for the window's title and the taskbar. */
function PrinterGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M4.5 6V1.5h7V6" />
      <rect x="1.5" y="6" width="13" height="6" rx="1.2" />
      <path d="M4.5 10h7v4.5h-7z" fill="#fff" />
    </svg>
  );
}

/** Windows 11's taskbar: the pinned apps in the middle, the tray and the clock on the right. */
function Taskbar11() {
  const cell = "grid size-[20px] place-items-center rounded-[4px]";
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10 flex h-[26px] items-center border-t border-white/[0.07] backdrop-blur-md"
      style={{ background: "rgb(30 30 32 / 0.84)" }}
    >
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
        <span className={cell}>
          <svg className="size-[12px]" viewBox="0 0 16 16">
            <defs>
              <linearGradient id="fd-start" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#5fd0ff" />
                <stop offset="1" stopColor="#0a6fd6" />
              </linearGradient>
            </defs>
            <path d="M0 0h7.5v7.5H0zM8.5 0H16v7.5H8.5zM0 8.5h7.5V16H0zM8.5 8.5H16V16H8.5z" fill="url(#fd-start)" />
          </svg>
        </span>
        <span className={`${cell} text-white/85`}>
          <svg className="size-[11px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="6.5" cy="6.5" r="5" />
            <path d="M10.2 10.2 15 15" />
          </svg>
        </span>
        <span className={`${cell} text-white/85`}>
          <svg className="size-[11px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1" y="3" width="9" height="10" rx="1.5" />
            <path d="M12.5 4.5h1.3a1.2 1.2 0 0 1 1.2 1.2v4.6a1.2 1.2 0 0 1-1.2 1.2h-1.3" />
          </svg>
        </span>
        <span className={cell}>{FOLDER}</span>
        <span className={`${cell} text-[#9aa3ad]`}>
          <svg className="size-[12px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="2.4" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
          </svg>
        </span>
        <span className={`${cell} relative bg-white/[0.09] text-white`}>
          <PrinterGlyph className="size-[12px]" />
          <span className="absolute bottom-[1px] left-1/2 h-[2px] w-[7px] -translate-x-1/2 rounded-full bg-[#4cc2ff]" />
        </span>
      </div>
      <Tray time="09:41" />
    </div>
  );
}

const QUEUE: [string, string, number][] = [
  ["invoice-1042.pdf", "Error - Printing", 2],
  ["shipping-labels.docx", "Error", 1],
  ["Q3 summary.xlsx", "Error", 8],
];

function FrontDesk({ who }: { who: Who }) {
  return (
    <Panel
      id="rdp-desk"
      slot="screen"
      mark={<OSIcon os="windows" size={13} />}
      place="front-desk"
      detail="computer use"
      who={who}
    >
      <div data-desk className="relative h-[264px] overflow-hidden">
        <Bloom />
        <ConnectionBar name="front-desk" />

        <div className="absolute top-[30px] left-[10px] flex w-[44px] flex-col items-center gap-1 text-center">
          <svg className="size-[20px]" viewBox="0 0 20 20" fill="none">
            <path
              d="M4.5 6h11l-1.1 11.2a1 1 0 0 1-1 .8H6.6a1 1 0 0 1-1-.8z"
              fill="rgb(220 235 250 / 0.25)"
              stroke="#dbe9f7"
              strokeWidth="1"
            />
            <path d="M3.5 6h13M8 3.5h4" stroke="#dbe9f7" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M8.2 9v6M11.8 9v6" stroke="#dbe9f7" strokeWidth="0.9" opacity="0.7" />
          </svg>
          <span className="text-[8.5px] leading-tight text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.8)]">
            Recycle Bin
          </span>
        </div>

        {/* The print queue: a classic window, light, as Windows draws it */}
        <div className="absolute top-[30px] left-[62px] w-[300px] rounded-[8px] text-[10.5px] text-[#1b1b1b] shadow-[0_14px_36px_rgb(0_0_0/0.5),0_0_0_1px_rgb(0_0_0/0.25)]">
          <div className="flex h-[26px] items-center rounded-t-[8px] bg-[#f3f3f3] pl-2.5">
            <PrinterGlyph className="mr-2 size-[11px] shrink-0 text-[#3b3b3b]" />
            <span className="truncate text-[10px]">HP LaserJet Pro M404</span>
            <Captions />
          </div>
          <div className="relative flex h-[20px] items-center gap-0.5 bg-white px-1">
            <span data-q-printer className="relative rounded-[3px] px-1.5 py-[2px]">
              Printer
              <Num n={7} />
            </span>
            <span className="px-1.5 py-[2px]">Document</span>
            <span className="px-1.5 py-[2px]">View</span>
            <span
              data-q-menu
              className="absolute top-full left-1 z-20 mt-px flex w-[170px] flex-col rounded-[6px] border border-black/[0.12] bg-[#f9f9f9] py-1 shadow-[0_8px_20px_rgb(0_0_0/0.28)]"
              style={{ visibility: "hidden" }}
            >
              <span className="px-3 py-[3px]">Connect…</span>
              <span className="px-3 py-[3px]">Pause Printing</span>
              <span data-q-cancel className="relative mx-1 rounded-[4px] px-2 py-[3px]">
                Cancel All Documents
                <Num n={21} />
              </span>
              <span className="my-1 h-px bg-black/[0.1]" />
              <span className="px-3 py-[3px]">Properties</span>
            </span>
          </div>
          <div className="grid h-[18px] grid-cols-[1fr_92px_32px] items-center border-y border-[#e5e5e5] bg-white px-2.5 text-[9.5px] text-[#5c5c5c]">
            <span>Document Name</span>
            <span>Status</span>
            <span className="text-right">Pages</span>
          </div>
          <div className="bg-white">
            {QUEUE.map(([name, status, pages]) => (
              <div key={name} data-q-row className="overflow-hidden" style={{ height: 22 }}>
                <div className="mx-1 grid h-[22px] grid-cols-[1fr_92px_32px] items-center px-1.5">
                  <span className="truncate">{name}</span>
                  <span className="text-[#c42b1c]">{status}</span>
                  <span className="text-right tabular-nums">{pages}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="flex h-[20px] items-center rounded-b-[8px] border-t border-[#e5e5e5] bg-[#f3f3f3] px-2.5 text-[9.5px] text-[#5c5c5c]">
            <span className="grid">
              <span data-q-before className="col-start-1 row-start-1">
                3 document(s) in queue
              </span>
              <span data-q-after className="col-start-1 row-start-1" style={{ visibility: "hidden" }}>
                0 document(s) in queue
              </span>
            </span>
            <span
              data-q-ready
              className="ml-auto flex items-center gap-1.5 text-[#0f7b0f]"
              style={{ visibility: "hidden" }}
            >
              <span className="size-1.5 rounded-full bg-[#0f7b0f]" />
              Ready
            </span>
          </div>
        </div>

        <Taskbar11 />
        <Pointer />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* dc-02: Windows Server, a locked-out account                          */
/* ------------------------------------------------------------------ */

/** Windows Server's wallpaper: the window logo, lit, on deep blue. */
function ServerWall() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 470 264"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 size-full"
    >
      <defs>
        <radialGradient id="dc-sky" cx="76%" cy="42%" r="80%">
          <stop offset="0" stopColor="#0f4aa8" />
          <stop offset="0.45" stopColor="#062457" />
          <stop offset="1" stopColor="#020a1c" />
        </radialGradient>
        <linearGradient id="dc-pane" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#bfe6ff" />
          <stop offset="1" stopColor="#3d8ff0" />
        </linearGradient>
        <radialGradient id="dc-glow">
          <stop offset="0" stopColor="#5fb4ff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#5fb4ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="470" height="264" fill="url(#dc-sky)" />
      <circle cx="402" cy="112" r="100" fill="url(#dc-glow)" />
      <g transform="translate(372 76) skewY(-9)" fill="url(#dc-pane)" opacity="0.92">
        <rect width="29" height="29" />
        <rect x="32" width="29" height="29" />
        <rect y="32" width="29" height="29" />
        <rect x="32" y="32" width="29" height="29" />
      </g>
    </svg>
  );
}

/** Windows Server's taskbar: Start and the search box on the left, black. */
function Taskbar10() {
  const cell = "grid h-full w-[26px] place-items-center";
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10 flex h-[24px] items-center text-white/85"
      style={{ background: "rgb(10 10 12 / 0.94)" }}
    >
      <span className={cell}>
        <svg className="size-[11px]" viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 2.2 6.5 1.3v6.2H0zM7.3 1.2 16 0v7.5H7.3zM0 8.5h6.5v6.2L0 13.8zM7.3 8.5H16V16l-8.7-1.2z" />
        </svg>
      </span>
      <span className="flex h-[18px] w-[118px] items-center gap-1.5 bg-[#f2f2f2] px-1.5 text-[8px] text-[#6b6b6b]">
        <svg className="size-[8px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="6.5" cy="6.5" r="5" />
          <path d="M10.2 10.2 15 15" />
        </svg>
        Type here to search
      </span>
      {/* Server Manager */}
      <span className={cell}>
        <svg className="size-[12px]" viewBox="0 0 16 16">
          <rect x="1.5" y="4" width="13" height="9" rx="1" fill="#9aa7b4" />
          <rect x="1.5" y="4" width="13" height="2.6" rx="1" fill="#5b6b7b" />
          <rect x="6" y="2" width="4" height="2" fill="none" stroke="#9aa7b4" strokeWidth="1" />
        </svg>
      </span>
      <span className={cell}>{FOLDER}</span>
      {/* Active Directory Users and Computers, open */}
      <span className={`${cell} relative bg-white/[0.1]`}>
        <AdGlyph className="size-[12px]" />
        <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#76b9ed]" />
      </span>
      <Tray time="09:44" />
    </div>
  );
}

/** Users and Computers' glyph: a directory with people in it. */
function AdGlyph({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16">
      <path
        d="M1 4.5A1.5 1.5 0 0 1 2.5 3h3.2l1.4 1.4h6.4A1.5 1.5 0 0 1 15 5.9V13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 13z"
        fill="#e8b84a"
      />
      <circle cx="6.2" cy="8.4" r="1.6" fill="#2f6fbd" />
      <path d="M3.6 13a2.6 2.6 0 0 1 5.2 0z" fill="#2f6fbd" />
      <circle cx="10.4" cy="8.9" r="1.4" fill="#4c8ad1" />
      <path d="M8.2 13a2.2 2.2 0 0 1 4.4 0z" fill="#4c8ad1" />
    </svg>
  );
}

const PEOPLE: [string, string][] = [
  ["Anna Conti", "User"],
  ["Front Desk", "Security Group"],
  ["Luca Bianchi", "User"],
  ["Maria Rossi", "User"],
  ["Paolo Greco", "User"],
  ["Sara Ferri", "User"],
];

function DomainController({ who }: { who: Who }) {
  return (
    <Panel
      id="rdp-dc"
      slot="screen"
      mark={<OSIcon os="windows" size={13} />}
      place="dc-02"
      detail="computer use"
      who={who}
    >
      <div data-desk className="relative h-[264px] overflow-hidden text-[#1b1b1b]">
        <ServerWall />
        <ConnectionBar name="dc-02" />

        {/* Active Directory Users and Computers */}
        <div className="absolute top-[26px] left-[12px] w-[318px] bg-white text-[8.5px] shadow-[0_10px_30px_rgb(0_0_0/0.5),0_0_0_1px_rgb(0_0_0/0.35)]">
          <div className="flex h-[22px] items-center pl-2">
            <AdGlyph className="mr-1.5 size-[11px] shrink-0" />
            <span className="truncate text-[9.5px]">Active Directory Users and Computers</span>
            <Captions />
          </div>
          <div className="flex h-[15px] items-center gap-2.5 px-2">
            <span>File</span>
            <span>Action</span>
            <span>View</span>
            <span>Help</span>
          </div>
          <div className="flex h-[148px] border-t border-[#e5e5e5]">
            <div className="w-[98px] shrink-0 border-r border-[#e5e5e5] py-1 leading-[15px]">
              <p className="px-1.5">corp.example</p>
              <p className="pl-3.5">Builtin</p>
              <p className="pl-3.5">Computers</p>
              <p className="pl-3.5">Domain Controllers</p>
              <p className="bg-[#cce8ff] pl-3.5">Staff</p>
              <p className="pl-3.5">Users</p>
            </div>
            <div className="min-w-0 flex-1">
              <div className="grid h-[15px] grid-cols-[1fr_78px] items-center border-b border-[#e5e5e5] px-2 text-[#5c5c5c]">
                <span>Name</span>
                <span>Type</span>
              </div>
              {PEOPLE.map(([name, type]) => (
                <div
                  key={name}
                  className={`grid h-[15px] grid-cols-[1fr_78px] items-center px-2 ${name === "Maria Rossi" ? "bg-[#cce8ff]" : ""}`}
                >
                  <span className="truncate">{name}</span>
                  <span className="truncate text-[#5c5c5c]">{type}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Maria's properties, on the Account tab */}
        <div
          data-ad-dialog
          className="absolute top-[34px] left-[150px] w-[232px] bg-[#f0f0f0] text-[8.5px] shadow-[0_12px_34px_rgb(0_0_0/0.55),0_0_0_1px_rgb(0_0_0/0.4)]"
        >
          <div className="flex h-[22px] items-center bg-white pl-2">
            <span className="truncate text-[9.5px]">Maria Rossi Properties</span>
            <Captions help />
          </div>
          <div className="flex items-end gap-0.5 px-2 pt-1.5">
            {["General", "Account", "Profile", "Member Of"].map((tab) => (
              <span
                key={tab}
                className={`px-1.5 py-[2px] ${tab === "Account" ? "border border-b-0 border-[#d0d0d0] bg-white" : "text-[#444]"}`}
              >
                {tab}
              </span>
            ))}
          </div>
          <div className="mx-2 flex flex-col gap-1.5 border border-[#d0d0d0] bg-white px-2 py-2">
            <span>User logon name:</span>
            <span className="flex gap-1">
              <span className="flex-1 border border-[#a0a0a0] px-1 py-px">m.rossi</span>
              <span className="border border-[#a0a0a0] px-1 py-px text-[#444]">@corp.example ▾</span>
            </span>
            <span className="relative mt-1 flex gap-1.5">
              <span
                data-ad-box
                className="relative mt-px grid size-[9px] shrink-0 place-items-center border border-[#333] bg-white"
              >
                <svg
                  data-ad-tick
                  className="size-[8px]"
                  viewBox="0 0 10 10"
                  fill="none"
                  stroke="#1b1b1b"
                  strokeWidth="1.6"
                  style={{ visibility: "hidden" }}
                >
                  <path d="M1.5 5.2 4 7.6 8.6 2.4" />
                </svg>
                <Num n={14} />
              </span>
              <span className="leading-[11px]">
                Unlock account. This account is currently locked out on this Active Directory Domain Controller.
              </span>
            </span>
          </div>
          <div className="flex justify-end gap-1 px-2 py-1.5">
            <span data-ad-ok className="relative w-[44px] border border-[#0078d4] bg-[#e1e1e1] py-px text-center">
              OK
              <Num n={31} />
            </span>
            <span className="w-[44px] border border-[#adadad] bg-[#e1e1e1] py-px text-center">Cancel</span>
            <span className="w-[44px] border border-[#adadad] bg-[#e1e1e1] py-px text-center text-[#888]">Apply</span>
          </div>
        </div>

        <Taskbar10 />
        <Pointer />
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Read-only checks across the fleet                                    */
/* ------------------------------------------------------------------ */

const HOSTS = 20;

type Check = {
  check: string;
  order: number[];
  flagged: number[];
  findings: [string, string][];
  clean: string;
};

const CHECKS: Record<"fleet-audit" | "fleet-tls", Check> = {
  "fleet-audit": {
    check: "sudoers, sshd_config",
    order: [3, 11, 0, 17, 6, 14, 9, 1, 19, 5, 12, 8, 15, 2, 10, 18, 7, 13, 4, 16],
    flagged: [6, 13],
    findings: [
      ["db-02", "PermitRootLogin yes"],
      ["build-01", "NOPASSWD: ALL for deploy"],
    ],
    clean: "18 clean",
  },
  "fleet-tls": {
    check: "TLS certificates",
    order: [8, 2, 15, 0, 11, 19, 5, 13, 1, 17, 9, 4, 14, 7, 18, 3, 12, 6, 16, 10],
    flagged: [2, 15],
    findings: [
      ["mail-01", "expires in 6 days"],
      ["vpn", "expires in 19 days"],
    ],
    clean: "18 fine",
  },
};

function Fleet({ id, who }: { id: keyof typeof CHECKS; who: Who }) {
  const { check, findings, clean } = CHECKS[id];
  return (
    <Panel
      id={id}
      slot="fleet"
      mark={<Icon icon={ServerStack01Icon} size={15} strokeWidth={1.8} />}
      place="20 hosts"
      detail="read only"
      who={who}
    >
      <div className="px-4 pt-3.5 pb-4">
        <div className="grid grid-cols-10 gap-1">
          {Array.from({ length: HOSTS }, (_, i) => (
            <span
              key={i}
              data-cell={i}
              className="h-3 rounded-[3px]"
              style={{ background: "rgb(255 255 255 / 0.06)" }}
            />
          ))}
        </div>
        <p className="mt-3 flex items-center justify-between font-mono text-[11.5px] text-neutral-500">
          <span>
            {check} · <span data-checked>0</span> of {HOSTS}
          </span>
          <span data-clean className="text-neutral-400" style={{ visibility: "hidden" }}>
            {clean}
          </span>
        </p>
        <div className="mt-2 flex flex-col gap-1 font-mono text-[11.5px]">
          {findings.map(([host, what]) => (
            <p key={host} data-finding className="flex items-center gap-2.5" style={{ visibility: "hidden" }}>
              <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
              <span className="w-[64px] shrink-0 text-gray-200">{host}</span>
              <span className="truncate text-neutral-400">{what}</span>
            </p>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* The layer, and its part of the timeline                              */
/* ------------------------------------------------------------------ */

export function Work({ who, scale }: { who: Record<PanelId, Who>; scale: number }) {
  return (
    <div
      data-work
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 origin-top-left font-[family-name:var(--font-app)] text-[14px] text-gray-100 antialiased select-none"
      style={{ width: SW, height: SH, transform: `scale(${scale})` }}
    >
      <Shell id="ssh-web" who={who["ssh-web"]} />
      <Shell id="ssh-nginx" who={who["ssh-nginx"]} />
      <FrontDesk who={who["rdp-desk"]} />
      <DomainController who={who["rdp-dc"]} />
      <Fleet id="fleet-audit" who={who["fleet-audit"]} />
      <Fleet id="fleet-tls" who={who["fleet-tls"]} />
    </div>
  );
}

const OK = "rgb(52 211 153 / 0.4)";
const FLAG = "rgb(251 191 36 / 0.85)";

const panelOf = (stage: HTMLElement, id: PanelId) => stage.querySelector<HTMLElement>(`[data-sat="${id}"]`)!;
const within = (panel: HTMLElement) => ({
  one: (selector: string) => panel.querySelector<HTMLElement>(selector)!,
  all: (selector: string) => [...panel.querySelectorAll<HTMLElement>(selector)],
});

/** Where each job ends, for reduced motion: open, done, its result on screen. */
export function settleWork(stage: HTMLElement, ids: PanelId[]) {
  for (const id of ids) {
    const panel = panelOf(stage, id);
    const { one, all } = within(panel);
    gsap.set(panel, { autoAlpha: 1 });
    gsap.set(one("[data-sat-busy]"), { autoAlpha: 0 });
    gsap.set(one("[data-sat-done]"), { autoAlpha: 1 });
    gsap.set(all("[data-line], [data-q-after], [data-q-ready], [data-clean], [data-finding]"), {
      autoAlpha: 1,
    });
    gsap.set(all("[data-q-before]"), { visibility: "hidden" });
    gsap.set(all("[data-q-row]"), { height: 0 });
    gsap.set(all("[data-ad-dialog]"), { autoAlpha: 0 });
    if (id in CHECKS) {
      const { flagged } = CHECKS[id as keyof typeof CHECKS];
      gsap.set(all("[data-checked]"), { textContent: String(HOSTS) });
      for (const cell of all("[data-cell]")) {
        gsap.set(cell, { backgroundColor: flagged.includes(Number(cell.dataset.cell)) ? FLAG : OK });
      }
    }
  }
}

/**
 * Hides, by opacity as well, everything that starts hidden. A repeating
 * timeline rewinds each piece to how it looked before its first fade in, and
 * an element hidden only by `visibility` would come back fully opaque.
 */
export function primeWork(stage: HTMLElement) {
  gsap.set(stage.querySelectorAll('[data-sat], [data-work] [style*="visibility"]:not(canvas)'), { autoAlpha: 0 });
}

/** Closes a job's window, once its work is done and has been seen. */
export function closeJob(tl: gsap.core.Timeline, stage: HTMLElement, id: PanelId, at: number) {
  tl.to(panelOf(stage, id), { autoAlpha: 0, y: 10, scale: 0.97, duration: 0.4, ease: "power2.in" }, at);
}

/**
 * Opens a job's window at `start`, plays its work, marks it done, and
 * returns when it was done.
 */
export function playJob(tl: gsap.core.Timeline, stage: HTMLElement, id: PanelId, start: number) {
  const panel = panelOf(stage, id);
  const { one } = within(panel);

  tl.fromTo(
    panel,
    { autoAlpha: 0, y: 16, scale: 0.97, transformOrigin: "50% 100%" },
    { autoAlpha: 1, y: 0, scale: 1, duration: 0.55, ease: "power3.out", immediateRender: false },
    start,
  );
  tl.call(() => sound.play("tick"), [], start);

  let done: number;
  if (id === "ssh-web" || id === "ssh-nginx") done = shell(tl, panel, SHELLS[id].lines, start);
  else if (id === "rdp-desk") done = frontDesk(tl, panel, stage, start);
  else if (id === "rdp-dc") done = domainController(tl, panel, stage, start);
  else done = fleet(tl, panel, CHECKS[id], start);

  tl.set(one("[data-sat-busy]"), { autoAlpha: 0 }, done);
  tl.fromTo(
    one("[data-sat-done]"),
    { autoAlpha: 0, scale: 0.4 },
    { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(3)", immediateRender: false },
    done,
  );
  return done;
}

/** Each command typed, its answer under it. */
function shell(tl: gsap.core.Timeline, panel: HTMLElement, lines: Line[], start: number) {
  const nodes = within(panel).all("[data-line]");
  let t = start + 0.5;
  lines.forEach((line, i) => {
    const node = nodes[i];
    if (line.k === "cmd") tl.set(node, { autoAlpha: 1 }, t);
    const cmd = node.querySelector<HTMLElement>("[data-cmd]");
    if (cmd) {
      const typing = line.t.length * 0.022;
      tl.fromTo(cmd, { text: "" }, { text: line.t, duration: typing, ease: "none", immediateRender: false }, t);
      t += typing + 0.35 + (line.wait ?? 0);
    } else {
      tl.fromTo(node, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, immediateRender: false }, t);
      t += 0.45;
    }
  });
  // A typed command starts empty, before its line shows.
  for (const node of nodes) {
    const cmd = node.querySelector<HTMLElement>("[data-cmd]");
    if (cmd) gsap.set(cmd, { text: "" });
  }
  return t + 0.05;
}

/** The machine's own pointer: glides to a control and clicks it. */
function hands(tl: gsap.core.Timeline, panel: HTMLElement, stage: HTMLElement) {
  const { one } = within(panel);
  const desk = one("[data-desk]");
  const pointer = one("[data-pointer]");
  const point = (node: HTMLElement) => () => {
    const box = desk.getBoundingClientRect();
    const a = node.getBoundingClientRect();
    const k = stage.getBoundingClientRect().width / SW;
    return { x: (a.left - box.left + a.width * 0.45) / k - 1, y: (a.top - box.top + a.height / 2) / k - 1 };
  };
  return {
    pointer,
    appear: (x: number, y: number, at: number) =>
      tl.fromTo(pointer, { autoAlpha: 0, x, y }, { autoAlpha: 1, duration: 0.25, immediateRender: false }, at),
    glide: (node: HTMLElement, at: number, duration: number) => {
      const p = point(node);
      tl.to(pointer, { x: () => p().x, y: () => p().y, duration, ease: "power3.inOut" }, at);
    },
    click: (at: number) => {
      tl.call(() => sound.play("press"), [], at);
      tl.to(pointer, { scale: 0.85, duration: 0.07, ease: "power2.in" }, at);
      tl.to(pointer, { scale: 1, duration: 0.14 }, at + 0.07);
    },
    leave: (at: number) => tl.to(pointer, { autoAlpha: 0, y: "+=12", duration: 0.35 }, at),
  };
}

/** The print queue: numbered, the Printer menu, Cancel All, empty and Ready. */
function frontDesk(tl: gsap.core.Timeline, panel: HTMLElement, stage: HTMLElement, t: number) {
  const { one, all } = within(panel);
  const { appear, glide, click, leave } = hands(tl, panel, stage);
  const printer = one("[data-q-printer]");
  const menu = one("[data-q-menu]");
  const cancel = one("[data-q-cancel]");
  const first = one("[data-q-printer] [data-num]");
  const fresh = one("[data-q-cancel] [data-num]");

  tl.fromTo(
    first,
    { autoAlpha: 0, scale: 1.15 },
    { autoAlpha: 1, scale: 1, duration: 0.25, immediateRender: false },
    t + 0.6,
  );
  appear(330, 196, t + 1);
  glide(printer, t + 1.05, 0.6);
  click(t + 1.7);
  tl.to(printer, { backgroundColor: "rgb(0 120 215 / 0.14)", duration: 0.1 }, t + 1.75);
  tl.fromTo(menu, { autoAlpha: 0, y: -3 }, { autoAlpha: 1, y: 0, duration: 0.18, immediateRender: false }, t + 1.8);
  tl.fromTo(
    fresh,
    { autoAlpha: 0, scale: 1.2 },
    { autoAlpha: 1, scale: 1, duration: 0.25, immediateRender: false },
    t + 2,
  );
  glide(cancel, t + 2.2, 0.5);
  tl.to(cancel, { backgroundColor: "rgb(0 120 215 / 0.13)", duration: 0.12 }, t + 2.6);
  click(t + 2.8);
  tl.to(menu, { autoAlpha: 0, duration: 0.12 }, t + 3);
  tl.to(printer, { backgroundColor: "rgb(0 120 215 / 0)", duration: 0.15 }, t + 3);
  tl.to(first, { autoAlpha: 0, duration: 0.2 }, t + 3.05);
  tl.to(all("[data-q-row]"), { height: 0, autoAlpha: 0, duration: 0.3, ease: "power2.inOut", stagger: 0.12 }, t + 3.15);
  tl.to(one("[data-q-before]"), { autoAlpha: 0, duration: 0.15 }, t + 3.7);
  tl.fromTo(one("[data-q-after]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2, immediateRender: false }, t + 3.75);
  tl.fromTo(
    one("[data-q-ready]"),
    { autoAlpha: 0, x: 4 },
    { autoAlpha: 1, x: 0, duration: 0.25, immediateRender: false },
    t + 3.8,
  );
  leave(t + 4.1);
  return t + 4.4;
}

/** The locked account: numbered, Unlock ticked, OK, and the dialog gone. */
function domainController(tl: gsap.core.Timeline, panel: HTMLElement, stage: HTMLElement, t: number) {
  const { one, all } = within(panel);
  const { appear, glide, click, leave } = hands(tl, panel, stage);
  const box = one("[data-ad-box]");
  const ok = one("[data-ad-ok]");

  tl.fromTo(
    all("[data-num]"),
    { autoAlpha: 0, scale: 1.15 },
    { autoAlpha: 1, scale: 1, duration: 0.25, stagger: 0.1, immediateRender: false },
    t + 0.6,
  );
  appear(400, 205, t + 1);
  glide(box, t + 1.05, 0.65);
  click(t + 1.75);
  tl.fromTo(
    one("[data-ad-tick]"),
    { autoAlpha: 0, scale: 0.5 },
    { autoAlpha: 1, scale: 1, duration: 0.16, immediateRender: false },
    t + 1.8,
  );
  glide(ok, t + 2.2, 0.55);
  click(t + 2.85);
  tl.to(ok, { backgroundColor: "#cce4f7", duration: 0.08 }, t + 2.85);
  tl.to(one("[data-ad-dialog]"), { autoAlpha: 0, scale: 0.98, duration: 0.22, ease: "power2.in" }, t + 3.05);
  leave(t + 3.5);
  return t + 3.8;
}

/** Every host checked, two worth a look, nothing changed. */
function fleet(tl: gsap.core.Timeline, panel: HTMLElement, check: Check, t: number) {
  const { one, all } = within(panel);
  const checked = one("[data-checked]");
  check.order.forEach((cell, n) => {
    const at = t + 0.5 + n * 0.12;
    tl.to(
      one(`[data-cell="${cell}"]`),
      { backgroundColor: check.flagged.includes(cell) ? FLAG : OK, duration: 0.2 },
      at,
    );
    tl.set(checked, { textContent: String(n + 1) }, at);
    if (n % 3 === 0) tl.call(() => sound.play("tick"), [], at);
  });
  const end = t + 0.5 + check.order.length * 0.12;
  tl.fromTo(one("[data-clean]"), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, immediateRender: false }, end + 0.1);
  tl.fromTo(
    all("[data-finding]"),
    { autoAlpha: 0, y: 4 },
    { autoAlpha: 1, y: 0, duration: 0.25, stagger: 0.18, immediateRender: false },
    end + 0.25,
  );
  return end + 0.75;
}
