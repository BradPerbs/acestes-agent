"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";

/*
 * Push to talk, as it looks on a Windows desktop. Acestes waits in the
 * background: a black notch hangs from the top of the screen and a violet
 * mark rides beside the cursor (BuddyOverlay.jsx and the .buddy-* rules in
 * the app's input.css, redrawn here with the app's own strings). Someone
 * points at a stopped firewall in Services, holds Ctrl+Alt and asks why. The
 * agent opens it, asks before changing anything, is answered the same way,
 * turns it back on and says so. Drawn at a fixed size and scaled to fit,
 * like the other replicas, so the cursor's path is exact at any width.
 */

const W = 1120;
const H = 640;
const TASKBAR = 40;
/** Where the mark rides, from the cursor's tip (OFFSET in BuddyOverlay.jsx). */
const OFFSET = { x: 18, y: 20 };
const MARK = "/brand/mark.png";

/* ------------------------------------------------------------------ */
/* The steps under the screen                                          */
/* ------------------------------------------------------------------ */

const steps: { n: string; title: ReactNode; body: string }[] = [
  {
    n: "01",
    title: (
      <>
        Hold <Key>Ctrl</Key> <Key>Alt</Key> and ask
      </>
    ),
    body: "In any app. What you say is written down on this computer.",
  },
  {
    n: "02",
    title: "It sees what you point at",
    body: "Your words go with the screen under your pointer.",
  },
  {
    n: "03",
    title: "It asks before a change",
    body: "Aloud and in the notch. You answer the same way.",
  },
  {
    n: "04",
    title: "It does it, and says so",
    body: "The real cursor works the app, then one line of recap.",
  },
];

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="relative inline-grid h-[22px] min-w-[34px] place-items-center rounded-[5px] border border-line bg-panel px-1.5 align-[1px] font-mono text-[11.5px] text-fg">
      {children}
      <span
        data-key
        className="absolute -inset-px grid place-items-center rounded-[5px] bg-accent-strong text-white"
        style={{ visibility: "hidden", opacity: 0 }}
      >
        {children}
      </span>
    </kbd>
  );
}

/* ------------------------------------------------------------------ */
/* Services                                                            */
/* ------------------------------------------------------------------ */

type Svc = [name: string, description: string, status: string, startup: string];

const FIREWALL = "Windows Defender Firewall";
const FW_DESC =
  "Windows Defender Firewall helps protect your computer by preventing unauthorized users from gaining access to your computer through the Internet or a network.";

const services: Svc[] = [
  ["Windows Audio", "Manages audio for Windows-based programs.", "Running", "Automatic"],
  ["Windows Audio Endpoint Builder", "Manages audio devices for the Windows Audio service.", "Running", "Automatic"],
  ["Windows Backup", "Provides Windows Backup and Restore capabilities.", "", "Manual"],
  [
    "Windows Biometric Service",
    "The Windows biometric service gives client applications the ability to capture.",
    "Running",
    "Manual (Trigger Start)",
  ],
  [
    "Windows Connection Manager",
    "Makes automatic connect/disconnect decisions based on the network.",
    "Running",
    "Automatic (Trigger Start)",
  ],
  [FIREWALL, FW_DESC, "", "Disabled"],
  [
    "Windows Error Reporting Service",
    "Allows errors to be reported when programs stop working.",
    "",
    "Manual (Trigger Start)",
  ],
  ["Windows Event Log", "This service manages events and event logs.", "Running", "Automatic"],
  ["Windows Font Cache Service", "Optimizes performance of applications by caching font data.", "Running", "Automatic"],
  ["Windows Installer", "Adds, modifies, and removes applications provided as a package.", "", "Manual"],
  [
    "Windows Management Instrumentation",
    "Provides a common interface and object model to access management data.",
    "Running",
    "Automatic",
  ],
  [
    "Windows Push Notifications System Service",
    "This service runs in session 0 and hosts the notification platform.",
    "Running",
    "Automatic",
  ],
  [
    "Windows Security Service",
    "Windows Security Service handles unified device protection and health information.",
    "Running",
    "Manual",
  ],
  ["Windows Time", "Maintains date and time synchronization on all clients and servers.", "", "Manual (Trigger Start)"],
  [
    "Windows Update",
    "Enables the detection, download, and installation of updates for Windows.",
    "Running",
    "Manual (Trigger Start)",
  ],
];

const COLS = "grid grid-cols-[228px_150px_66px_minmax(0,1fr)]";
const hidden: CSSProperties = { visibility: "hidden", opacity: 0 };

/** The cog services.msc draws for itself and beside every service. */
function Cog({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5 5 11M11 5l1.5-1.5" />
    </svg>
  );
}

/** Windows' three caption buttons. */
function Captions({ close = false }: { close?: boolean }) {
  return (
    <span className="ml-auto flex h-full text-[#3b3b3b]">
      {!close && (
        <>
          <span className="grid w-[44px] place-items-center">
            <svg viewBox="0 0 10 10" className="size-[10px]" stroke="currentColor" strokeWidth="1">
              <path d="M0 5h10" />
            </svg>
          </span>
          <span className="grid w-[44px] place-items-center">
            <svg viewBox="0 0 10 10" className="size-[10px]" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
            </svg>
          </span>
        </>
      )}
      <span className="grid w-[44px] place-items-center">
        <svg viewBox="0 0 10 10" className="size-[10px]" stroke="currentColor" strokeWidth="1">
          <path d="M0 0l10 10M10 0 0 10" />
        </svg>
      </span>
    </span>
  );
}

/** Two layers in one cell: the value before, and the value after. */
function Swap({
  before,
  after,
  name,
  className = "",
}: {
  before: ReactNode;
  after: ReactNode;
  name: string;
  className?: string;
}) {
  return (
    <span className={`grid ${className}`}>
      <span data-before={name} className="col-start-1 row-start-1 truncate">
        {before}
      </span>
      <span data-after={name} className="col-start-1 row-start-1 truncate" style={hidden}>
        {after}
      </span>
    </span>
  );
}

function ServicesWindow() {
  return (
    <div className="absolute top-[44px] left-[64px] flex h-[520px] w-[992px] flex-col overflow-hidden rounded-[8px] bg-white text-[12px] text-[#1b1b1b] shadow-[0_18px_50px_-12px_rgb(0_0_0/0.35),0_0_0_1px_rgb(0_0_0/0.12)]">
      <div className="flex h-[32px] shrink-0 items-center bg-[#f3f3f3] pl-3">
        <Cog className="mr-2 size-[14px] text-[#5a5a5a]" />
        Services
        <Captions />
      </div>
      <div className="flex h-[24px] shrink-0 items-center gap-1 bg-white px-1.5">
        {["File", "Action", "View", "Help"].map((m) => (
          <span key={m} className="rounded-[3px] px-2 py-[2px]">
            {m}
          </span>
        ))}
      </div>
      <div className="flex h-[30px] shrink-0 items-center gap-[3px] border-y border-[#e6e6e6] bg-[#fafafa] px-2 text-[#5a5a5a]">
        {["M9 3 4 8l5 5", "M7 3l5 5-5 5"].map((d) => (
          <span key={d} className="grid size-[22px] place-items-center rounded-[3px]">
            <svg viewBox="0 0 16 16" className="size-[12px]" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d={d} />
            </svg>
          </span>
        ))}
        <span className="mx-1 h-[16px] w-px bg-[#dcdcdc]" />
        {[0, 1, 2].map((i) => (
          <span key={i} className="grid size-[22px] place-items-center">
            <span className="size-[12px] rounded-[2px] border border-[#9a9a9a] bg-white" />
          </span>
        ))}
        <span className="mx-1 h-[16px] w-px bg-[#dcdcdc]" />
        <span className="grid size-[22px] place-items-center text-[#1e8e3e]">
          <svg viewBox="0 0 12 12" className="size-[10px]" fill="currentColor">
            <path d="M2 1l9 5-9 5z" />
          </svg>
        </span>
        <span className="grid size-[22px] place-items-center">
          <span className="size-[9px] rounded-[1px] bg-[#4a4a4a]" />
        </span>
        <span className="grid size-[22px] place-items-center">
          <span className="flex gap-[2px]">
            <span className="h-[10px] w-[3px] bg-[#4a4a4a]" />
            <span className="h-[10px] w-[3px] bg-[#4a4a4a]" />
          </span>
        </span>
        <span className="grid size-[22px] place-items-center text-[#1e8e3e]">
          <svg viewBox="0 0 12 12" className="size-[10px]" fill="currentColor">
            <path d="M1 1h2v10H1zM4 1l7 5-7 5z" />
          </svg>
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The tree */}
        <div className="w-[168px] shrink-0 border-r border-[#e6e6e6] bg-[#fbfbfb] px-1.5 pt-2">
          <div className="flex h-[22px] items-center gap-1.5 rounded-[3px] bg-[#cce8ff] px-1.5">
            <Cog className="size-[13px] text-[#5a5a5a]" />
            Services (Local)
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-[28px] shrink-0 items-center gap-1.5 border-b border-[#e6e6e6] bg-[#f5f5f5] px-3 font-medium">
            <Cog className="size-[13px] text-[#5a5a5a]" />
            Services (Local)
          </div>
          <div className="flex min-h-0 flex-1">
            {/* What the selected service is, as the Extended view shows it */}
            <div className="relative w-[200px] shrink-0 border-r border-[#ececec] px-3 pt-3 leading-[1.45]">
              <p data-before="desc" className="text-[#6b6b6b]">
                Select an item to view its description.
              </p>
              <div data-after="desc" className="absolute inset-x-3 top-3" style={hidden}>
                <p className="text-[13px] font-semibold">{FIREWALL}</p>
                <div className="relative mt-2.5 h-[38px]">
                  <p data-before="links" className="absolute inset-0">
                    <span className="text-[#0067c0] underline">Start</span> the service
                  </p>
                  <p data-after="links" className="absolute inset-0" style={hidden}>
                    <span className="text-[#0067c0] underline">Stop</span> the service
                    <br />
                    <span className="text-[#0067c0] underline">Restart</span> the service
                  </p>
                </div>
                <p className="mt-2">Description:</p>
                <p className="mt-0.5 text-[#3b3b3b]">{FW_DESC}</p>
              </div>
            </div>

            {/* The list */}
            <div className="min-w-0 flex-1">
              <div className={`${COLS} h-[24px] items-center border-b border-[#e6e6e6] px-2 text-[#5c5c5c]`}>
                <span>Name</span>
                <span>Description</span>
                <span>Status</span>
                <span>Startup Type</span>
              </div>
              {services.map(([name, description, status, startup]) => {
                const fw = name === FIREWALL;
                return (
                  <div key={name} className="relative mx-0.5 h-[22px]">
                    {fw && (
                      <>
                        <span data-fw="hover" className="absolute inset-0 rounded-[2px] bg-[#e5f3ff]" style={hidden} />
                        <span data-fw="sel" className="absolute inset-0 rounded-[2px] bg-[#cce8ff]" style={hidden} />
                      </>
                    )}
                    <div className={`${COLS} relative h-full items-center px-1.5`}>
                      <span data-t={fw ? "fw" : undefined} className="flex min-w-0 items-center gap-1.5 pr-2">
                        <Cog className="size-[12px] shrink-0 text-[#7a7a7a]" />
                        <span className="truncate">{name}</span>
                      </span>
                      <span className="truncate pr-3 text-[#4a4a4a]">{description}</span>
                      {fw ? <Swap name="fw-status" before="" after="Running" /> : <span>{status}</span>}
                      {fw ? (
                        <Swap name="fw-startup" before="Disabled" after="Automatic" />
                      ) : (
                        <span className="truncate">{startup}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex h-[24px] shrink-0 items-end gap-0.5 border-t border-[#e6e6e6] bg-[#fafafa] px-2">
            <span className="rounded-t-[3px] border border-b-0 border-[#d9d9d9] bg-white px-2.5 py-[2px]">
              Extended
            </span>
            <span className="px-2.5 py-[2px] text-[#6b6b6b]">Standard</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)] items-start gap-2">
      <span className="pt-[3px] text-[#3b3b3b]">{label}</span>
      {children}
    </div>
  );
}

const box = "rounded-[3px] border border-[#c8c8c8] bg-[#f6f6f6] px-2 py-[3px]";
const button = "grid h-[24px] w-[74px] place-items-center rounded-[3px] border";

function Properties() {
  return (
    <div
      data-dialog
      className="absolute top-[96px] left-[352px] z-20 w-[412px] rounded-[8px] border border-[#cdcdcd] bg-[#f9f9f9] text-[12px] text-[#1b1b1b] shadow-[0_24px_60px_-18px_rgb(0_0_0/0.45)]"
      style={hidden}
    >
      <div className="flex h-[32px] items-center rounded-t-[8px] bg-[#f3f3f3] pl-3">
        <span className="truncate">{FIREWALL} Properties (Local Computer)</span>
        <Captions close />
      </div>
      <div className="px-3 pt-2 pb-3">
        <div className="flex items-end gap-0.5">
          <span className="relative z-10 -mb-px rounded-t-[3px] border border-[#d4d4d4] border-b-white bg-white px-2.5 py-[3px]">
            General
          </span>
          {["Log On", "Recovery", "Dependencies"].map((t) => (
            <span key={t} className="px-2.5 py-[3px] text-[#5c5c5c]">
              {t}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-2.5 rounded-tr-[3px] rounded-b-[3px] border border-[#d4d4d4] bg-white px-3.5 py-3.5">
          <Field label="Service name:">
            <span className="pt-[3px]">mpssvc</span>
          </Field>
          <Field label="Display name:">
            <span className={box}>{FIREWALL}</span>
          </Field>
          <Field label="Description:">
            <span className={`${box} h-[46px] overflow-hidden leading-[1.35]`}>{FW_DESC}</span>
          </Field>
          <div>
            <p className="text-[#3b3b3b]">Path to executable:</p>
            <p className={`${box} mt-1 truncate font-[family-name:var(--font-app-mono)] text-[11px]`}>
              C:\WINDOWS\system32\svchost.exe -k LocalServiceNoNetworkFirewall -p
            </p>
          </div>
          <Field label="Startup type:">
            <span
              data-t="startup"
              className="relative flex h-[24px] items-center justify-between rounded-[3px] border border-[#8a8a8a] bg-white px-2"
            >
              <Swap name="startup" before="Disabled" after="Automatic" />
              <svg
                viewBox="0 0 10 6"
                className="size-[9px] text-[#5c5c5c]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              >
                <path d="M1 1l4 4 4-4" />
              </svg>
              <span
                data-dd
                className="absolute -inset-x-px top-[calc(100%+2px)] z-30 flex flex-col rounded-[4px] border border-[#bdbdbd] bg-white py-1 shadow-[0_8px_20px_rgb(0_0_0/0.22)]"
                style={hidden}
              >
                {["Automatic (Delayed Start)", "Automatic", "Manual", "Disabled"].map((o) => (
                  <span
                    key={o}
                    data-t={o === "Automatic" ? "auto" : undefined}
                    className="relative mx-1 rounded-[3px] px-2 py-[3px]"
                  >
                    {(o === "Automatic" || o === "Disabled") && (
                      <span
                        data-hl={o === "Automatic" ? "auto" : "disabled"}
                        className="absolute inset-0 rounded-[3px] bg-[#0067c0]"
                        style={o === "Disabled" ? undefined : hidden}
                      />
                    )}
                    <span
                      data-label={o === "Automatic" ? "auto" : o === "Disabled" ? "disabled" : undefined}
                      className="relative"
                    >
                      {o}
                    </span>
                  </span>
                ))}
              </span>
            </span>
          </Field>
          <span className="my-0.5 h-px bg-[#e6e6e6]" />
          <Field label="Service status:">
            <span className="grid pt-[3px]">
              <span data-st="stopped" className="col-start-1 row-start-1">
                Stopped
              </span>
              <span data-st="starting" className="col-start-1 row-start-1" style={hidden}>
                Starting…
              </span>
              <span data-st="running" className="col-start-1 row-start-1" style={hidden}>
                Running
              </span>
            </span>
          </Field>
          <div className="flex gap-2">
            <span data-t="start" data-btn="start" className={`${button} border-[#dadada] text-[#a3a3a3]`}>
              Start
            </span>
            <span data-btn="stop" className={`${button} border-[#dadada] text-[#a3a3a3]`}>
              Stop
            </span>
            <span className={`${button} border-[#dadada] text-[#a3a3a3]`}>Pause</span>
            <span className={`${button} border-[#dadada] text-[#a3a3a3]`}>Resume</span>
          </div>
          <p className="leading-[1.4] text-[#5c5c5c]">
            You can specify the start parameters that apply when you start the service from here.
          </p>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <span data-t="ok" className={`${button} border-[#0067c0] bg-[#0067c0] text-white`}>
            OK
          </span>
          <span className={`${button} border-[#c4c4c4] bg-white`}>Cancel</span>
          <span data-t="apply" data-btn="apply" className={`${button} border-[#dadada] bg-white text-[#a3a3a3]`}>
            Apply
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The desktop                                                         */
/* ------------------------------------------------------------------ */

function Wallpaper() {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{
        background: "radial-gradient(120% 90% at 78% 88%, #c3cbd6 0%, #d9dee5 38%, #e8ebef 70%, #eef0f3 100%)",
      }}
    />
  );
}

function AcestesTile({ size = 18 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center bg-black text-white"
      style={{ width: size, height: size, borderRadius: size * 0.27 }}
    >
      <span
        className="block mask-brand"
        style={{
          maskImage: `url(${MARK})`,
          WebkitMaskImage: `url(${MARK})`,
          height: size * 0.56,
          aspectRatio: "352 / 406",
        }}
      />
    </span>
  );
}

/** Windows 11's taskbar, light: Services open in the middle, Acestes in the tray. */
function Taskbar() {
  const cell = "relative grid size-[30px] place-items-center rounded-[5px]";
  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10 flex items-center border-t border-black/[0.08] text-[#1b1b1b]"
      style={{ height: TASKBAR, background: "rgb(240 242 245 / 0.92)" }}
    >
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-1">
        <span className={cell}>
          <svg className="size-[17px]" viewBox="0 0 16 16">
            <path d="M0 0h7.5v7.5H0zM8.5 0H16v7.5H8.5zM0 8.5h7.5V16H0zM8.5 8.5H16V16H8.5z" fill="#0a74da" />
          </svg>
        </span>
        <span className={cell}>
          <svg className="size-[15px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6.5" cy="6.5" r="5" />
            <path d="M10.2 10.2 15 15" />
          </svg>
        </span>
        <span className={cell}>
          <svg className="size-[17px]" viewBox="0 0 16 16">
            <path
              d="M1 3.5a1 1 0 0 1 1-1h4l1.4 1.5H14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"
              fill="#f0b429"
            />
            <path d="M1 6h14v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z" fill="#ffc83d" />
          </svg>
        </span>
        <span className={`${cell} bg-black/[0.06]`}>
          <Cog className="size-[16px] text-[#4a4a4a]" />
          <span className="absolute bottom-[1px] left-1/2 h-[3px] w-[14px] -translate-x-1/2 rounded-full bg-[#0067c0]" />
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3 pr-4 text-[11.5px]">
        <svg
          className="size-[11px] text-[#4a4a4a]"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        >
          <path d="M2 8l4-4 4 4" />
        </svg>
        <AcestesTile size={16} />
        <svg className="size-[15px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M1.5 6a9.5 9.5 0 0 1 13 0M3.8 8.4a6.2 6.2 0 0 1 8.4 0M6 10.8a3 3 0 0 1 4 0" />
          <circle cx="8" cy="13" r="0.9" fill="currentColor" />
        </svg>
        <svg className="size-[15px]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M2 6h2.5L8 3v10L4.5 10H2zM10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9" />
        </svg>
        <span className="flex flex-col items-end leading-[1.25]">
          <span>09:41</span>
          <span>30/10/2026</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The notch and the mark                                              */
/* ------------------------------------------------------------------ */

type Phase = "rest" | "listen" | "hear" | "look" | "think" | "act" | "ask" | "steer" | "say";

/** The notch's width by phase (SIZES in BuddyOverlay.jsx). */
const WIDTH: Record<Phase, number> = {
  rest: 150,
  listen: 380,
  hear: 360,
  look: 330,
  think: 360,
  act: 380,
  ask: 420,
  steer: 380,
  say: 430,
};

/** The phases that carry Open and Stop in the notch's corner. */
const WORKING: Phase[] = ["think", "act", "ask"];

function Ring({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={`vx-ring size-3 shrink-0 ${className}`} aria-hidden="true">
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

function Line({
  icon,
  children,
  meta,
  tone = "",
  controls = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  meta?: string;
  tone?: string;
  controls?: boolean;
}) {
  return (
    <div
      className={`flex min-w-0 items-center gap-2.5 text-[12.5px] font-medium ${tone}`}
      style={controls ? { paddingRight: 58 } : undefined}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta && <span className="shrink-0 text-[10.5px] font-normal text-white/40 tabular-nums">{meta}</span>}
    </div>
  );
}

function NotchKey({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[6px] bg-white/12 px-1.5 py-px font-[inherit] text-[10px] font-medium text-white/80 shadow-[inset_0_0_0_1px_rgb(255_255_255/0.1)]">
      {children}
    </kbd>
  );
}

/** The voice across the notch: the app's 24 middle bars, longest in the middle. */
const BARS = Array.from({ length: 30 }, (_, i) => {
  const centre = 1 - Math.abs(i - 14.5) / 15;
  return {
    reach: 0.35 + 0.65 * centre * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.7))),
    delay: -((i * 137) % 900),
  };
}).slice(3, 27);

function NotchWave() {
  return (
    <div className="mt-2.5 flex h-[26px] items-center gap-[3px]" aria-hidden="true">
      {BARS.map((b, i) => (
        <span key={i} className="flex h-full flex-1 items-center">
          <span
            className="vx-bar mx-auto block w-[5px] rounded-full bg-[#fb7185]"
            style={{
              height: 4 + b.reach * 22,
              animationDelay: `${b.delay}ms`,
              animationDuration: `${620 + (i % 5) * 70}ms`,
            }}
          />
        </span>
      ))}
    </div>
  );
}

const rec = <span className="vx-breathe relative size-2 rounded-full bg-rose-500" />;

/** What the notch shows in each phase, stacked; the timeline shows one at a time. */
function NotchBodies() {
  const body = (phase: Phase, children: ReactNode) => (
    <div
      key={phase}
      data-nb={phase}
      // Centred with `left`, not a translate: the timeline moves these with transforms of its own.
      className="absolute top-0 px-[18px] pt-[10px] pb-[13px]"
      style={{ width: WIDTH[phase], left: `calc(50% - ${WIDTH[phase] / 2}px)`, ...hidden }}
    >
      {children}
    </div>
  );
  return (
    <>
      <div data-nb="rest" className="absolute inset-x-0 top-0 grid h-[26px] place-items-center">
        <span className="vx-breathe-slow size-[5px] rounded-full bg-violet-400" />
      </div>
      {body(
        "listen",
        <>
          <Line icon={rec} meta="Claude Code">
            Listening
          </Line>
          <NotchWave />
          <p className="mt-2 text-[12.5px] leading-[1.38] text-white/85">
            <span data-heard="ask" />
          </p>
        </>,
      )}
      {body(
        "hear",
        <>
          <Line icon={<Ring className="text-white/70" />}>Writing it down…</Line>
          <p className="mt-2 text-[12.5px] leading-[1.38] text-white/85">Why is this one off?</p>
        </>,
      )}
      {body("look", <Line icon={<Ring className="text-white/70" />}>Looking at your screen…</Line>)}
      {body(
        "think",
        <Line icon={<Ring className="text-white/70" />} controls>
          Thinking…
        </Line>,
      )}
      {body(
        "act",
        <Line icon={<Ring className="text-violet-300" />} controls>
          <span data-act-text className="block truncate">
            Clicking · {FIREWALL}
          </span>
        </Line>,
      )}
      {body(
        "ask",
        <>
          <Line icon={<span className="vx-breathe size-2 rounded-full bg-amber-400" />} tone="text-amber-200" controls>
            It is asking you
          </Line>
          <p className="mt-2 text-[13px] leading-[1.42] text-white/90">
            {FIREWALL} is set to Disabled, so it cannot start. Set it to Automatic and start it now?
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {["Turn it on", "Leave it off"].map((o) => (
              <span key={o} className="rounded-full bg-white/10 px-2 py-[2px] text-[11px] text-white/75">
                {o}
              </span>
            ))}
          </div>
          <div className="mt-2.5 flex justify-end">
            <span className="inline-flex items-center gap-1.5 text-[10.5px] text-white/45">
              Hold <NotchKey>Ctrl</NotchKey>
              <NotchKey>Alt</NotchKey> to answer
            </span>
          </div>
        </>,
      )}
      {body(
        "steer",
        <>
          <Line icon={rec}>Listening · it carries on meanwhile</Line>
          <NotchWave />
          <p className="mt-2 text-[12.5px] leading-[1.38] text-white/85">
            <span data-heard="answer" />
          </p>
        </>,
      )}
      {body(
        "say",
        <>
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="relative flex h-[18px] w-3.5 shrink-0 items-center justify-center">
              <span data-say="speaker" className="vx-speaker absolute flex h-3 items-center gap-[2px]">
                <span className="h-full w-[2.5px] rounded-[2px] bg-violet-400" />
                <span className="h-full w-[2.5px] rounded-[2px] bg-violet-400" />
                <span className="h-full w-[2.5px] rounded-[2px] bg-violet-400" />
              </span>
              <span data-say="done" className="absolute size-[7px] rounded-full bg-emerald-400" style={hidden} />
            </span>
            <span className="min-w-0 flex-1 text-[13.5px] leading-[18px] font-semibold text-white">
              The firewall is back on: set to Automatic, and running.
            </span>
          </div>
          <p className="mt-2 line-clamp-2 text-[12px] leading-[1.42] text-white/55">
            Its startup type was Disabled, so the service could not start. It is set to Automatic now, started, and
            Services shows it Running.
          </p>
        </>,
      )}
    </>
  );
}

function Notch() {
  return (
    <div
      data-notch
      className="absolute top-0 left-1/2 z-40 -translate-x-1/2 bg-black text-white shadow-[0_14px_34px_-14px_rgb(0_0_0/0.6)]"
      style={{ width: WIDTH.rest, height: 26, borderRadius: "0 0 13px 13px" }}
    >
      {/* The flared top corners, drawn outside the box (.buddy-notch::before and ::after). */}
      <span
        aria-hidden="true"
        className="absolute top-0 right-full size-[12px]"
        style={{ background: "radial-gradient(circle at 0 100%, transparent 11.5px, #000 12px)" }}
      />
      <span
        aria-hidden="true"
        className="absolute top-0 left-full size-[12px]"
        style={{ background: "radial-gradient(circle at 100% 100%, transparent 11.5px, #000 12px)" }}
      />
      <div className="relative h-full overflow-hidden rounded-[inherit]">
        <NotchBodies />
      </div>
      {/* Open in Acestes, and Stop, while it works. */}
      <div data-controls className="absolute top-2 right-3 flex gap-[5px]" style={hidden}>
        <span className="grid size-[22px] place-items-center rounded-full bg-white/9 text-white/60">
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path
              d="M4.5 2.5h5v5M9.5 2.5 3 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="grid size-[22px] place-items-center rounded-full bg-white/9 text-white/60">
          <span className="size-2 rounded-[2px] bg-current" />
        </span>
      </div>
    </div>
  );
}

/** A face of the mark sits on a dark disc, so it reads over a white window and a black one alike. */
function Disc({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <>
      <span
        className={`absolute inset-y-0 rounded-full bg-[rgb(17_17_20/0.86)] shadow-[0_3px_10px_-3px_rgb(0_0_0/0.55),inset_0_0_0_1px_rgb(255_255_255/0.08)] ${wide ? "-inset-x-[5px]" : "inset-x-0"}`}
      />
      <span className="relative">{children}</span>
    </>
  );
}

function Mark() {
  const face = "absolute inset-0 grid place-items-center";
  return (
    <div data-mark className="absolute top-0 left-0 z-50 flex items-center gap-1.5" style={{ visibility: "hidden" }}>
      <div className="relative size-[22px] shrink-0">
        <span
          data-face="arrow"
          className={`${face} text-violet-400 [filter:drop-shadow(0_0_4px_rgb(139_92_246/0.7))_drop-shadow(0_1px_1.5px_rgb(0_0_0/0.45))]`}
        >
          <svg viewBox="0 0 20 20" className="size-[15px] -rotate-[35deg]" aria-hidden="true">
            <path
              data-arrow
              d="M10 1.4 L16 18 L10 14 L4 18 Z"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span data-face="wave" className={face} style={hidden}>
          <Disc wide>
            <span className="flex h-4 items-center gap-[2px]">
              {[0.45, 0.75, 1, 0.75, 0.45].map((reach, i) => (
                <span
                  key={i}
                  className="vx-bar block w-[2.5px] rounded-[2px] bg-[#fb7185]"
                  style={{ height: 4 + reach * 12, animationDelay: `${-i * 140}ms`, animationDuration: "560ms" }}
                />
              ))}
            </span>
          </Disc>
        </span>
        <span data-face="ring" className={face} style={hidden}>
          <Disc>
            <span className="grid size-[14px] place-items-center text-white/80 [&_svg]:size-[14px]">
              <Ring />
            </span>
          </Disc>
        </span>
        <span data-face="ask" className={face} style={hidden}>
          <Disc>
            <span className="vx-breathe block size-[7px] rounded-full bg-amber-400" />
          </Disc>
        </span>
      </div>
      <span
        data-bubble
        className="max-w-[320px] truncate rounded-full bg-[rgb(17_17_20/0.88)] px-2.5 py-[3px] text-[11.5px] leading-4 font-medium whitespace-nowrap text-white/90 shadow-[0_6px_16px_-6px_rgb(0_0_0/0.6),inset_0_0_0_1px_rgb(255_255_255/0.08)]"
        style={hidden}
      >
        <span data-bubble-text />
      </span>
    </div>
  );
}

function Cursor() {
  return (
    <div data-cursor className="absolute top-0 left-0 z-50" style={{ visibility: "hidden" }}>
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
  );
}

/* ------------------------------------------------------------------ */
/* The replica                                                         */
/* ------------------------------------------------------------------ */

export function VoiceMock() {
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
      const one = (sel: string) => q(sel)[0] as HTMLElement;

      const notch = one("[data-notch]");
      const controls = one("[data-controls]");
      const nb = (p: Phase) => one(`[data-nb="${p}"]`);
      const cursor = one("[data-cursor]");
      const mark = one("[data-mark]");
      const faces = {
        arrow: one('[data-face="arrow"]'),
        wave: one('[data-face="wave"]'),
        ring: one('[data-face="ring"]'),
        ask: one('[data-face="ask"]'),
      };
      const arrow = one("[data-arrow]");
      const bubble = one("[data-bubble]");
      const bubbleText = one("[data-bubble-text]");
      const actText = one("[data-act-text]");
      const dialog = one("[data-dialog]");
      const dd = one("[data-dd]");
      const before = (n: string) => q(`[data-before="${n}"]`) as HTMLElement[];
      const after = (n: string) => q(`[data-after="${n}"]`) as HTMLElement[];
      const fw = (n: string) => one(`[data-fw="${n}"]`);
      const st = (n: string) => one(`[data-st="${n}"]`);
      const btn = (n: string) => one(`[data-btn="${n}"]`);
      const hl = (n: string) => one(`[data-hl="${n}"]`);
      const label = (n: string) => one(`[data-label="${n}"]`);
      const heard = (n: string) => one(`[data-heard="${n}"]`);
      const sayDone = one('[data-say="done"]');
      const saySpeaker = one('[data-say="speaker"]');
      const stepEls = gsap.utils.toArray<HTMLElement>("[data-step]", page);
      const stepBars = gsap.utils.toArray<HTMLElement>("[data-step-bar]", page);
      const keys = gsap.utils.toArray<HTMLElement>("[data-key]", page);
      const phases = Object.keys(WIDTH) as Phase[];

      // Each body's height at its own width, for the notch to open to.
      // Measured with the words in, as the notch shows them once they are heard.
      const askText = "Why is this one off?";
      const answerText = "Yes, turn it on.";
      heard("ask").textContent = askText;
      heard("answer").textContent = answerText;
      const tall = {} as Record<Phase, number>;
      for (const p of phases) tall[p] = p === "rest" ? 26 : Math.ceil(nb(p).offsetHeight);
      heard("ask").textContent = "";
      heard("answer").textContent = "";

      if (prefersReducedMotion()) {
        // The moment that says the most: the question, with the service open.
        gsap.set(notch, { width: WIDTH.ask, height: tall.ask, borderRadius: "0 0 20px 20px" });
        gsap.set(nb("rest"), { autoAlpha: 0 });
        gsap.set([nb("ask"), controls, dialog, fw("sel"), ...after("desc")], { autoAlpha: 1 });
        gsap.set(before("desc"), { autoAlpha: 0 });
        gsap.set(cursor, { x: 560, y: 300, autoAlpha: 1 });
        gsap.set(mark, { x: 560 + OFFSET.x, y: 300 + OFFSET.y, autoAlpha: 1 });
        gsap.set(faces.arrow, { autoAlpha: 0 });
        gsap.set(faces.ask, { autoAlpha: 1 });
        gsap.set(stepEls, { opacity: 0.45 });
        gsap.set(stepEls[2], { opacity: 1 });
        gsap.set(stepBars.slice(0, 3), { scaleX: 1 });
        return;
      }

      // Where a control is on the canvas, in its own pixels.
      const at = (name: string) => {
        const el = box.querySelector<HTMLElement>(`[data-t="${name}"]`)!;
        const c = box.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const s = c.width / W || 1;
        return { x: (r.left - c.left) / s, y: (r.top - c.top) / s, w: r.width / s, h: r.height / s };
      };
      const fwRow = at("fw");
      // The dialog's controls are measured where it opens, at full size.
      gsap.set(dialog, { autoAlpha: 1 });
      gsap.set(dd, { autoAlpha: 1 });
      const targets = {
        row: { x: fwRow.x + 92, y: fwRow.y + fwRow.h / 2 },
        startup: at("startup"),
        auto: at("auto"),
        apply: at("apply"),
        start: at("start"),
        ok: at("ok"),
      };
      gsap.set([dialog, dd], { autoAlpha: 0 });
      const home = { x: 905, y: 545 };

      const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.8, paused: true });

      // Every loop starts from the same desktop.
      tl.set(notch, { width: WIDTH.rest, height: 26, borderRadius: "0 0 13px 13px" }, 0)
        .set(phases.filter((p) => p !== "rest").map(nb), { autoAlpha: 0 }, 0)
        .set(nb("rest"), { autoAlpha: 1 }, 0)
        .set(controls, { autoAlpha: 0 }, 0)
        .set([faces.wave, faces.ring, faces.ask, bubble], { autoAlpha: 0, scale: 0.6 }, 0)
        .set(faces.arrow, { autoAlpha: 1, scale: 1 }, 0)
        .set(cursor, { x: home.x, y: home.y, autoAlpha: 1 }, 0)
        .set(mark, { autoAlpha: 1 }, 0)
        .set([dialog, dd, fw("hover"), fw("sel"), hl("auto"), sayDone], { autoAlpha: 0 }, 0)
        .set([hl("disabled"), saySpeaker], { autoAlpha: 1 }, 0)
        .set([label("disabled")], { color: "#ffffff" }, 0)
        .set([label("auto")], { color: "#1b1b1b" }, 0)
        .set(["fw-status", "fw-startup", "desc", "links", "startup"].flatMap(before), { autoAlpha: 1 }, 0)
        .set(["fw-status", "fw-startup", "desc", "links", "startup"].flatMap(after), { autoAlpha: 0 }, 0)
        .set(st("stopped"), { autoAlpha: 1 }, 0)
        .set([st("starting"), st("running")], { autoAlpha: 0 }, 0)
        .set([btn("start"), btn("apply"), btn("stop")], { color: "#a3a3a3", borderColor: "#dadada" }, 0)
        .set([heard("ask"), heard("answer")], { text: "" }, 0)
        .set(stepEls, { opacity: 0.45 }, 0)
        .set(stepBars, { scaleX: 0 }, 0)
        .set(keys, { autoAlpha: 0 }, 0);

      let now: Phase = "rest";
      /** The notch eases open (or shut) to the next phase, its body fading in under it. */
      const to = (p: Phase, t: number) => {
        const prev = now;
        now = p;
        tl.to(nb(prev), { autoAlpha: 0, duration: 0.12 }, t);
        tl.to(
          notch,
          {
            width: WIDTH[p],
            height: tall[p],
            borderRadius: p === "rest" ? "0 0 13px 13px" : "0 0 20px 20px",
            duration: 0.46,
            ease: "back.out(1.3)",
          },
          t,
        );
        tl.fromTo(
          nb(p),
          { autoAlpha: 0, y: -4, filter: "blur(3px)" },
          { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.32, ease: "power3.out" },
          t + 0.09,
        );
        const work = WORKING.includes(p);
        if (work !== WORKING.includes(prev)) tl.to(controls, { autoAlpha: work ? 1 : 0, duration: 0.25 }, t + 0.12);
      };

      let shape: keyof typeof faces = "arrow";
      /** The mark's face: an arrowhead, a voice, a turning ring, or a question. */
      const face = (f: keyof typeof faces, t: number) => {
        if (f === shape) return;
        tl.to(faces[shape], { autoAlpha: 0, scale: 0.6, duration: 0.16 }, t);
        tl.to(faces[f], { autoAlpha: 1, scale: 1, duration: 0.22, ease: "back.out(2)" }, t);
        shape = f;
      };

      /** What the mark says beside it, in the app's tones. */
      const say = (text: string | null, t: number, tone = "rgb(255 255 255 / 0.92)") => {
        if (!text) {
          tl.to(bubble, { autoAlpha: 0, scale: 0.8, duration: 0.15 }, t);
          return;
        }
        tl.set(bubbleText, { text }, t);
        tl.set(bubble, { color: tone }, t);
        tl.fromTo(
          bubble,
          { autoAlpha: 0, x: -4, scale: 0.6 },
          { autoAlpha: 1, x: 0, scale: 1, duration: 0.24, ease: "back.out(1.6)" },
          t,
        );
      };

      /** What the agent is doing, in the notch and beside the cursor at once. */
      const doing = (text: string, t: number) => {
        tl.to(actText, { autoAlpha: 0, y: -6, duration: 0.12 }, t);
        tl.set(actText, { text }, t + 0.12);
        tl.fromTo(actText, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.2 }, t + 0.12);
        say(text, t, "rgb(221 214 254)");
      };

      let pos = home;
      /** The cursor glides somewhere: the person's hand, or the agent's. */
      const glide = (p: { x: number; y: number }, t: number) => {
        const d = Math.min(1, Math.max(0.5, Math.hypot(p.x - pos.x, p.y - pos.y) / 620));
        tl.to(cursor, { x: p.x, y: p.y, duration: d, ease: "power2.inOut" }, t);
        pos = p;
        return t + d;
      };
      const centre = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
      const click = (t: number) => {
        tl.to(cursor, { scale: 0.86, duration: 0.07 }, t).to(cursor, { scale: 1, duration: 0.12 }, t + 0.07);
        return t + 0.22;
      };

      /** The steps under the screen: one lit, its bar filling, the ones before it full. */
      const step = (i: number, from: number, until: number) => {
        tl.to(stepEls[i], { opacity: 1, duration: 0.3 }, from);
        tl.fromTo(stepBars[i], { scaleX: 0 }, { scaleX: 1, duration: until - from, ease: "none" }, from);
        tl.to(stepEls[i], { opacity: 0.45, duration: 0.3 }, until);
      };

      // The person points at the service that is off.
      let t = 0.5;
      t = glide(targets.row, t);
      tl.to(fw("hover"), { autoAlpha: 1, duration: 0.15 }, t - 0.1);
      t += 0.5;

      // Ctrl+Alt down: listening.
      const asked = t;
      tl.to(keys, { autoAlpha: 1, duration: 0.12 }, t);
      to("listen", t);
      face("wave", t);
      tl.to(heard("ask"), { text: askText, duration: 1.1, ease: "none" }, t + 0.45);
      t += 1.9;

      // Let go: written down, then a look at the screen under the pointer.
      tl.to(keys, { autoAlpha: 0, duration: 0.15 }, t);
      step(0, asked, t);
      const seen = t;
      to("hear", t);
      face("ring", t);
      t += 0.7;
      to("look", t);
      say("Looking at your screen…", t, "rgb(255 255 255 / 0.62)");
      t += 1;
      to("think", t);
      say("Thinking…", t, "rgb(255 255 255 / 0.62)");
      t += 0.9;

      // It opens the service.
      to("act", t);
      doing(`Clicking · ${FIREWALL}`, t);
      t = click(t + 0.35);
      t = click(t - 0.08);
      tl.to(fw("hover"), { autoAlpha: 0, duration: 0.1 }, t);
      tl.to(fw("sel"), { autoAlpha: 1, duration: 0.1 }, t);
      tl.to(before("desc"), { autoAlpha: 0, duration: 0.15 }, t);
      tl.to(after("desc"), { autoAlpha: 1, duration: 0.2 }, t);
      tl.fromTo(
        dialog,
        { autoAlpha: 0, scale: 0.97, transformOrigin: "50% 40%" },
        { autoAlpha: 1, scale: 1, duration: 0.3 },
        t + 0.2,
      );
      t += 0.7;
      doing(`Reading · ${FIREWALL} Properties`, t);
      t += 1.4;

      // It asks first, aloud and in the notch.
      step(1, seen, t);
      const asking = t;
      to("ask", t);
      face("ask", t);
      say("It is asking you", t, "rgb(253 230 138)");
      t += 3.4;

      // Answered the same way.
      to("steer", t);
      face("wave", t);
      say(null, t);
      tl.to(heard("answer"), { text: answerText, duration: 0.8, ease: "none" }, t + 0.4);
      t += 1.6;
      step(2, asking, t);
      const working = t;

      // It turns it back on.
      to("act", t);
      face("ring", t);
      doing("Clicking · Startup type", t);
      t = click(glide(centre(targets.startup), t + 0.1));
      tl.to(dd, { autoAlpha: 1, duration: 0.15 }, t);
      t += 0.25;
      doing("Clicking · Automatic", t);
      t = glide(centre(targets.auto), t + 0.1);
      tl.to(hl("disabled"), { autoAlpha: 0, duration: 0.08 }, t);
      tl.set(label("disabled"), { color: "#1b1b1b" }, t);
      tl.to(hl("auto"), { autoAlpha: 1, duration: 0.08 }, t);
      tl.set(label("auto"), { color: "#ffffff" }, t);
      t = click(t + 0.15);
      tl.to(dd, { autoAlpha: 0, duration: 0.12 }, t);
      tl.to(before("startup"), { autoAlpha: 0, duration: 0.1 }, t);
      tl.to(after("startup"), { autoAlpha: 1, duration: 0.1 }, t);
      tl.set(btn("apply"), { color: "#1b1b1b", borderColor: "#bdbdbd" }, t);
      t += 0.3;

      doing("Clicking · Apply", t);
      t = click(glide(centre(targets.apply), t + 0.1));
      tl.set(btn("apply"), { color: "#a3a3a3", borderColor: "#dadada" }, t);
      tl.set(btn("start"), { color: "#1b1b1b", borderColor: "#bdbdbd" }, t);
      t += 0.3;

      doing("Clicking · Start", t);
      t = click(glide(centre(targets.start), t + 0.1));
      tl.set(btn("start"), { color: "#a3a3a3", borderColor: "#dadada" }, t);
      tl.to(st("stopped"), { autoAlpha: 0, duration: 0.1 }, t);
      tl.to(st("starting"), { autoAlpha: 1, duration: 0.1 }, t);
      t += 0.9;
      tl.to(st("starting"), { autoAlpha: 0, duration: 0.1 }, t);
      tl.to(st("running"), { autoAlpha: 1, duration: 0.1 }, t);
      tl.set(btn("stop"), { color: "#1b1b1b", borderColor: "#bdbdbd" }, t);
      t += 0.4;

      doing("Clicking · OK", t);
      t = click(glide(centre(targets.ok), t + 0.1));
      tl.to(dialog, { autoAlpha: 0, scale: 0.98, duration: 0.22 }, t);
      tl.to(["fw-status", "fw-startup", "links"].flatMap(before), { autoAlpha: 0, duration: 0.15 }, t + 0.1);
      tl.to(["fw-status", "fw-startup", "links"].flatMap(after), { autoAlpha: 1, duration: 0.2 }, t + 0.1);
      t += 0.6;

      // One line, said aloud.
      to("say", t);
      face("arrow", t);
      say(null, t);
      tl.to(
        arrow,
        { scale: 1.22, transformOrigin: "50% 50%", duration: 0.26, yoyo: true, repeat: 9, ease: "sine.inOut" },
        t,
      );
      t += 3.4;
      tl.to(saySpeaker, { autoAlpha: 0, duration: 0.15 }, t);
      tl.to(sayDone, { autoAlpha: 1, duration: 0.15 }, t);
      step(3, working, t);
      t += 1.8;

      // Back to rest, and the cursor home.
      to("rest", t);
      tl.to(cursor, { x: home.x, y: home.y, duration: 0.9, ease: "power2.inOut" }, t + 0.2);
      tl.to(fw("sel"), { autoAlpha: 0, duration: 0.3 }, t + 0.2);
      tl.to(stepBars, { scaleX: 0, duration: 0.5, ease: "power2.in" }, t + 0.3);
      tl.set({}, {}, t + 1.4);

      // The mark rides beside the cursor on a spring (PULL and KEEP in BuddyOverlay.jsx).
      const sim = { x: home.x + OFFSET.x, y: home.y + OFFSET.y, vx: 0, vy: 0 };
      const follow = () => {
        const gx = (gsap.getProperty(cursor, "x") as number) + OFFSET.x;
        const gy = (gsap.getProperty(cursor, "y") as number) + OFFSET.y;
        const dt = Math.min(3, gsap.ticker.deltaRatio(60));
        const keep = 0.58 ** dt;
        sim.vx = (sim.vx + (gx - sim.x) * 0.24 * dt) * keep;
        sim.vy = (sim.vy + (gy - sim.y) * 0.24 * dt) * keep;
        sim.x += sim.vx * dt;
        sim.y += sim.vy * dt;
        gsap.set(mark, { x: sim.x, y: sim.y });
      };
      gsap.set(mark, { x: sim.x, y: sim.y });

      const play = (on: boolean) => {
        if (on) {
          gsap.ticker.add(follow);
          tl.play();
        } else {
          gsap.ticker.remove(follow);
          tl.pause();
        }
      };
      const trigger = ScrollTrigger.create({
        trigger: page,
        start: "top 75%",
        end: "bottom 15%",
        onToggle: (self) => play(self.isActive),
      });
      if (trigger.isActive) play(true);

      return () => gsap.ticker.remove(follow);
    },
    { scope: root },
  );

  return (
    <div ref={root}>
      <p className="sr-only">
        A demonstration on a Windows desktop: in Services, someone points at Windows Defender Firewall, which is
        stopped, holds Ctrl and Alt, and asks why it is off. A notch at the top of the screen shows it listening, then
        the agent opens the service&apos;s properties and asks whether to set it to Automatic and start it. They answer
        by voice the same way; the agent sets it to Automatic, starts it, and says in one line that the firewall is back
        on and running.
      </p>

      <div
        ref={frame}
        aria-hidden="true"
        className="relative w-full overflow-hidden rounded-[10px] bg-[#e8ebef] ring-1 ring-black/10 dark:ring-white/10"
        style={{ aspectRatio: `${W} / ${H}`, maxHeight: H }}
      >
        <div
          ref={canvas}
          className="absolute top-0 left-0 origin-top-left overflow-hidden font-[family-name:var(--font-app)] antialiased select-none"
          style={{ width: W, height: H, transform: `scale(${scale})` }}
        >
          <Wallpaper />
          <ServicesWindow />
          <Properties />
          <Taskbar />
          <Notch />
          <Mark />
          <Cursor />
        </div>
      </div>

      <ol className="mt-6 grid gap-x-6 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <li key={s.n} data-step className="flex flex-col gap-3">
            <span className="relative block h-px overflow-hidden bg-line">
              <span data-step-bar className="absolute inset-0 origin-left scale-x-0 bg-fg" />
            </span>
            <span className="font-mono text-[11px] text-subtle">{s.n}</span>
            <span className="text-[16px] leading-snug font-medium tracking-[-0.01em]">{s.title}</span>
            <span className="text-[14px] leading-relaxed text-muted">{s.body}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
