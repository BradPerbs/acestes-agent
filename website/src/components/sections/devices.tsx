"use client";

import { useRef, type ReactNode } from "react";
import {
  AiBrain01Icon,
  ArrowDataTransferHorizontalIcon,
  Link04Icon,
  RefreshIcon,
  ServerStack02Icon,
  ShieldKeyIcon,
  SquareLock02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { sound, type Sound } from "@/lib/sound";
import { Section } from "../frame";
import { Icon } from "../icon";
import { OSIcon } from "../os-icons";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";
import { Bracket } from "../ui";

/**
 * Devices: Acestes on several computers, working as one fleet (Settings,
 * Devices in the app; src/main/fleet). The demo plays the thing it is for: on
 * the computer at your desk you ask for something that can only be done on
 * another one, the agent hands it over with run_on_device, and that
 * computer's own agent does it on its own desktop while its tab is mirrored
 * here. On the left the fleet sees it happen: the target goes busy, then the
 * memory of it syncs everywhere.
 */

type Device = {
  name: string;
  kind: "windows" | "mac" | "server";
  detail: string;
  you?: boolean;
  target?: boolean;
  locked?: boolean;
  off?: boolean;
};

const devices: Device[] = [
  { name: "workstation", kind: "windows", detail: "Windows 11 · hosts the relay", you: true },
  { name: "front-desk", kind: "windows", detail: "Windows 11 · reception", target: true },
  { name: "dc-01", kind: "server", detail: "Windows Server 2022 · over RDP", locked: true },
  { name: "studio-mac", kind: "mac", detail: "macOS · lends its Claude Code" },
  { name: "old-laptop", kind: "windows", detail: "Windows 10 · its jobs run elsewhere", off: true },
];

const steps: [string, string][] = [
  ["read_screen", "Printers & scanners"],
  ["click", "[7] HP LaserJet · Open print queue"],
  ["read_screen", "3 documents · Error - Printing"],
  ["click", "Printer · Cancel all documents"],
  ["click", "Yes"],
  ["read_screen", "0 documents · Ready"],
];

const points = [
  {
    tag: "join",
    icon: Link04Icon,
    lead: "A code, and it's in.",
    body: "Make a code on one computer and paste it on the next. No account, no sign-in to share: it takes work the moment it joins.",
  },
  {
    tag: "sync",
    icon: RefreshIcon,
    lead: "The same on every one.",
    body: "Agents, settings, hosts, keys, secrets, memory and jobs follow you, so any computer picks up where the last one left off.",
  },
  {
    tag: "hand off",
    icon: ArrowDataTransferHorizontalIcon,
    lead: "Work goes where it belongs.",
    body: "Name a computer and the task runs there, on its desktop, files and network, and opens here as a tab you can watch and answer in.",
  },
  {
    tag: "sealed",
    icon: ShieldKeyIcon,
    lead: "The relay can't read it.",
    body: "Every message is signed by the computer that sent it and sealed under a key only your fleet holds. The relay in the middle carries ciphertext.",
  },
  {
    tag: "models",
    icon: AiBrain01Icon,
    lead: "No model? It borrows one.",
    body: "A computer with no AI runtime of its own borrows one from another in the fleet. The thinking happens there; the tools still run where the work is.",
  },
  {
    tag: "lock",
    icon: SquareLock02Icon,
    lead: "Lock the ones that matter.",
    body: "A locked computer stays in sync but takes no tasks from the others and runs none of their jobs.",
  },
];

/* ------------------------------------------------------------------ */
/* The fleet, as Settings shows it                                     */
/* ------------------------------------------------------------------ */

function Status({ d }: { d: Device }) {
  if (d.off) {
    return (
      <span className="flex items-center gap-1.5 font-mono text-[12px] text-subtle">
        <span className="size-1.5 rounded-full bg-subtle/60" />
        off
      </span>
    );
  }
  const online = (
    <span data-idle={d.target ? "" : undefined} className="flex items-center gap-1.5 font-mono text-[12px] text-muted">
      <span className="size-1.5 rounded-full bg-ok" />
      online
    </span>
  );
  if (!d.target) return online;
  return (
    <span className="relative grid justify-items-end">
      <span className="col-start-1 row-start-1">{online}</span>
      <span
        data-busy
        className="invisible col-start-1 row-start-1 flex items-center gap-1.5 font-mono text-[12px] whitespace-nowrap text-accent"
      >
        <span className="relative flex size-1.5">
          <span data-beat className="absolute inset-0 rounded-full bg-accent" />
          <span className="relative size-1.5 rounded-full bg-accent" />
        </span>
        <span className="sm:hidden">working</span>
        <span className="hidden sm:inline">task from workstation</span>
      </span>
    </span>
  );
}

function DeviceRow({ d }: { d: Device }) {
  return (
    <li
      className={`relative flex items-center gap-4 border-b border-line px-5 py-4 sm:px-8 ${d.off ? "opacity-60" : ""}`}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-line bg-panel text-fg">
        {d.kind === "server" ? (
          <Icon icon={ServerStack02Icon} size={18} />
        ) : (
          <OSIcon os={d.kind === "mac" ? "mac" : "windows"} size={16} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[16px] tracking-[-0.01em] sm:text-[17px]">
          {d.name}
          {d.you && (
            <code className="rounded-full border border-line px-2 py-px font-mono text-[11px] text-muted">
              this computer
            </code>
          )}
          {d.locked && (
            <code className="flex items-center gap-1 rounded-full border border-line px-2 py-px font-mono text-[11px] text-muted">
              <Icon icon={SquareLock02Icon} size={11} strokeWidth={2} />
              locked
            </code>
          )}
        </span>
        <span className="mt-0.5 block truncate text-[13.5px] text-muted">{d.detail}</span>
      </span>
      <Status d={d} />
      {d.target && (
        <span
          aria-hidden="true"
          data-task-bar
          className="absolute inset-x-0 bottom-[-1px] h-[2px] origin-left scale-x-0 bg-accent"
        />
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* The conversation on workstation                                     */
/* ------------------------------------------------------------------ */

function Msg({ children, me = false }: { children: ReactNode; me?: boolean }) {
  return (
    <div data-msg className={`flex shrink-0 ${me ? "justify-end" : ""}`}>
      {me ? (
        <p className="max-w-[82%] rounded-2xl rounded-br-md bg-term-fg px-3.5 py-2 text-[13.5px] leading-snug text-term-bg">
          {children}
        </p>
      ) : (
        <p className="max-w-[92%] text-[13.5px] leading-relaxed text-term-fg">{children}</p>
      )}
    </div>
  );
}

function Handoff() {
  return (
    <div data-msg className="shrink-0">
      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.025]">
        <div className="flex items-center gap-2 px-3.5 py-2.5 font-mono text-[12px]">
          <span className="text-violet-300">run_on_device</span>
          <span className="truncate text-term-muted">front-desk</span>
          <span className="ml-auto grid justify-items-end">
            <span data-run-busy className="col-start-1 row-start-1 flex items-center gap-1.5 text-term-muted">
              <span data-spin className="size-3 rounded-full border border-white/20 border-t-violet-300" />
              running there
            </span>
            <span
              data-run-done
              className="invisible col-start-1 row-start-1 flex items-center gap-1 whitespace-nowrap text-emerald-400"
            >
              <Icon icon={Tick02Icon} size={13} strokeWidth={2.2} />
              done · 38s
            </span>
          </span>
        </div>
        <p className="border-t border-white/[0.06] px-3.5 py-2.5 text-[12.5px] leading-snug text-term-muted">
          Cancel the stuck jobs in the print queue and check the printer shows Ready.
        </p>
        <div className="border-t border-white/[0.06] bg-black/40 px-3.5 py-3">
          <p className="mb-2 flex items-center gap-2 font-mono text-[11px] text-term-muted">
            <span className="relative flex size-1.5">
              <span data-beat className="absolute inset-0 rounded-full bg-violet-400" />
              <span className="relative size-1.5 rounded-full bg-violet-400" />
            </span>
            front-desk · its tab, mirrored here
          </p>
          <div className="flex flex-col font-mono text-[11.5px] leading-[1.8]">
            {steps.map(([tool, what]) => (
              <p key={tool + what} data-step className="flex gap-2.5 overflow-hidden whitespace-nowrap">
                <span className="w-[78px] shrink-0 text-violet-300/90">{tool}</span>
                <span className="truncate text-term-fg/80">{what}</span>
              </p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function Devices() {
  const root = useRef<HTMLDivElement>(null);

  // The hand-off, played when the section comes into view and paused off
  // screen. It loops, with a breath and a fade between runs.
  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const q = gsap.utils.selector(el);
      const convo = q("[data-convo]")[0] as HTMLElement | undefined;
      if (!convo) return;

      if (prefersReducedMotion()) {
        gsap.set(convo, { autoAlpha: 1 });
        gsap.set(q("[data-run-busy]"), { autoAlpha: 0 });
        gsap.set(q("[data-run-done]"), { autoAlpha: 1 });
        return;
      }

      const msgs = q("[data-msg]");
      const lines = q("[data-step]");
      const busy = q("[data-busy]");
      const idle = q("[data-idle]");
      const bar = q("[data-task-bar]");
      const mirror = q("[data-mirror-tab]");
      const count = q("[data-sync-count]")[0];
      const when = q("[data-sync-when]")[0];

      gsap.to(q("[data-spin]"), { rotate: 360, duration: 0.9, ease: "none", repeat: -1 });
      gsap.fromTo(
        q("[data-beat]"),
        { scale: 1, opacity: 0.7 },
        { scale: 2.6, opacity: 0, duration: 1.4, repeat: -1, ease: "power1.out" },
      );

      // Grows in, with its sound if the visitor has it on, then lets go of its
      // height, so a card can keep growing as its steps arrive.
      const show = (tl: gsap.core.Timeline, m: Element, at: string | number = ">", cue?: Sound) => {
        tl.fromTo(
          m,
          { height: 0, autoAlpha: 0 },
          { height: "auto", autoAlpha: 1, duration: 0.45, ease: "power3.out" },
          at,
        );
        if (cue) tl.call(() => sound.play(cue), [], "<");
        return tl.set(m, { height: "auto" });
      };

      const tl = gsap.timeline({ paused: true, repeat: -1, repeatDelay: 0.4, delay: 0.3 });
      tl.set(convo, { autoAlpha: 1 })
        .set(msgs, { height: 0, autoAlpha: 0, overflow: "hidden" })
        .set(lines, { height: 0, autoAlpha: 0 })
        .set(q("[data-run-busy]"), { autoAlpha: 1 })
        .set(q("[data-run-done]"), { autoAlpha: 0 })
        .set(mirror, { autoAlpha: 0, width: 0 })
        .set(busy, { autoAlpha: 0 })
        .set(idle, { autoAlpha: 1 })
        .set(bar, { scaleX: 0, autoAlpha: 1 })
        .set(count, { text: "418 items" })
        .set(when, { text: "2 min ago" });

      show(tl, msgs[0], 0.2, "send");
      show(tl, msgs[1], "+=0.8", "blip");
      show(tl, msgs[2], "+=0.6", "blip");
      // front-desk takes it: busy on the left, its tab opens in the title bar.
      tl.addLabel("run", "<0.1")
        .to(idle, { autoAlpha: 0, duration: 0.25 }, "run")
        .to(busy, { autoAlpha: 1, duration: 0.25 }, "run")
        .to(mirror, { autoAlpha: 1, width: "auto", duration: 0.5, ease: "power3.out" }, "run");
      lines.forEach((line) => show(tl, line, "+=0.5", "step"));
      tl.to(bar, { scaleX: 1, duration: tl.duration() - tl.labels.run, ease: "none" }, "run");
      tl.addLabel("done", "+=0.4")
        .to(q("[data-run-busy]"), { autoAlpha: 0, duration: 0.2 }, "done")
        .to(q("[data-run-done]"), { autoAlpha: 1, duration: 0.25 }, "done")
        .to(busy, { autoAlpha: 0, duration: 0.25 }, "done")
        .to(idle, { autoAlpha: 1, duration: 0.25 }, "done")
        .to(bar, { autoAlpha: 0, duration: 0.4 }, "done")
        .call(() => sound.play("chime"), [], "done");
      show(tl, msgs[3], "+=0.6", "blip");
      // What it learned lands in memory, and the fleet syncs it.
      tl.to(q("[data-sync-icon]"), { rotate: "+=360", duration: 0.9, ease: "power2.inOut" }, "+=0.5")
        .set(count, { text: "419 items" }, "<0.6")
        .set(when, { text: "just now" }, "<");
      tl.to({}, { duration: 4 }).to(convo, { autoAlpha: 0, duration: 0.45 });

      const st = ScrollTrigger.create({
        trigger: el,
        start: "top 70%",
        end: "bottom 15%",
        onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
      });
      if (st.isActive) tl.play();
    },
    { scope: root },
  );

  return (
    <Section id="devices" label="Devices">
      <SectionHeader
        eyebrow="devices."
        title="All your computers. One agent."
        sub="Put Acestes on your other PCs and on the Windows servers you reach by RDP, and join them with a code. They work as one: the same agents, hosts, keys and memory on every one, and any of them can hand another a task."
        className="border-b border-line"
      />

      <div ref={root} className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* The fleet */}
        <div className="flex flex-col border-b border-line lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-8">
            <Bracket>Your devices</Bracket>
            <span className="font-mono text-[11.5px] text-subtle">5 computers · through Tailscale</span>
          </div>
          <ul aria-label="Computers in this fleet">
            {devices.map((d) => (
              <DeviceRow key={d.name} d={d} />
            ))}
          </ul>
          {/* Joining: a code made here, pasted on the next computer */}
          <div className="flex flex-col gap-3 border-b border-line px-5 py-6 sm:px-8">
            <div className="flex items-center justify-between gap-3">
              <Bracket>Add a computer</Bracket>
              <span className="font-mono text-[11.5px] text-subtle">expires in 15 min</span>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-dashed border-line bg-panel px-3.5 py-2.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted">
                <span className="text-accent">ACESTES1.</span>eyJyIjoid3NzOi8vcmVsYXkuZXhhbXBsZS5kZXYiLCJmIjoiOGQ0YTFj
              </code>
              <span className="shrink-0 rounded-md border border-line px-2 py-1 font-mono text-[11px] text-fg">
                copy
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-muted">
              Paste it on the next computer, in Settings, Devices. That&apos;s the whole setup.
            </p>
          </div>
          <div className="mt-auto flex items-start gap-3 px-5 py-6 sm:px-8">
            <span data-sync-icon className="mt-0.5 text-accent">
              <Icon icon={RefreshIcon} size={16} />
            </span>
            <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-muted">
              <strong className="font-medium text-fg">In sync.</strong> Agents, settings, hosts, keys, secrets, memory
              and jobs. Synced <span data-sync-when>just now</span>,{" "}
              <span data-sync-count className="font-mono text-[12.5px]">
                419 items
              </span>
              .
            </p>
          </div>
        </div>

        {/* The conversation */}
        <div className="relative overflow-hidden px-3 py-10 sm:px-8 sm:py-12">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:linear-gradient(to_bottom,transparent,#000_70%)] [background-size:16px_16px]"
          />
          <div className="relative mx-auto w-full max-w-[560px] overflow-hidden rounded-[16px] bg-term-bg text-term-fg ring-1 ring-black/10 dark:ring-white/10">
            {/* Title bar with the open tabs */}
            <div className="flex items-center gap-2 border-b border-white/[0.06] bg-term-bar/60 px-4 py-2.5 text-[12px]">
              <span
                className="block shrink-0 mask-brand text-term-fg"
                style={{
                  maskImage: "url(/brand/mark.png)",
                  WebkitMaskImage: "url(/brand/mark.png)",
                  height: 13,
                  aspectRatio: "352 / 406",
                }}
              />
              <span className="truncate text-term-muted">
                Acestes <span className="text-term-muted/70">· workstation</span>
              </span>
              <span className="ml-auto flex min-w-0 items-center gap-1.5">
                <span className="truncate rounded-md bg-term-hl px-2 py-1 text-term-fg">Print queue</span>
                <span
                  data-mirror-tab
                  className="flex items-center gap-1.5 overflow-hidden rounded-md border border-violet-400/30 px-2 py-1 whitespace-nowrap text-violet-200"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-violet-400" />
                  front-desk
                </span>
              </span>
            </div>

            <div
              data-convo
              data-reveal
              className="flex h-[470px] flex-col justify-end gap-3.5 overflow-hidden px-4 py-5 sm:px-5"
            >
              <Msg me>The front desk printer is stuck again. Clear its queue.</Msg>
              <Msg>
                That printer hangs off <strong className="font-medium">front-desk</strong>, so I&apos;ll have it done
                there.
              </Msg>
              <Handoff />
              <Msg>
                Done on <strong className="font-medium">front-desk</strong>: three stuck jobs cancelled, the queue is
                empty and the printer shows Ready. Every step is in its tab.
              </Msg>
            </div>
          </div>
        </div>
      </div>

      <Reveal draw className="grid gap-px border-t border-line bg-line md:grid-cols-2 lg:grid-cols-3" stagger={0.08}>
        {points.map((p) => (
          <article key={p.tag} className="group/c relative bg-bg">
            <div data-r className="flex h-full flex-col gap-8 px-5 py-9 sm:px-10 sm:py-11">
              <div className="flex items-center justify-between">
                <span className="rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-muted">
                  {p.tag}
                </span>
                <span data-draw className="text-subtle transition-colors duration-300 group-hover/c:text-accent">
                  <Icon icon={p.icon} size={26} strokeWidth={1.4} />
                </span>
              </div>
              <h3 className="text-[19px] leading-[1.45] tracking-[-0.015em] text-muted sm:text-[20px]">
                <span className="mr-2 font-mono text-subtle">{"//"}</span>
                <strong className="font-medium text-fg">{p.lead}</strong> {p.body}
              </h3>
            </div>
          </article>
        ))}
      </Reveal>
      <p className="border-t border-line px-5 py-4 text-[13px] text-muted sm:px-10">
        Your computers meet on one of them, over the same network or Tailscale, or on a relay of your own as a
        Cloudflare Worker. A scheduled job runs once across the fleet: on the computer it was made on, or the next one
        that is on.
      </p>
    </Section>
  );
}
