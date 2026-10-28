"use client";

import {
  AiBrain01Icon,
  ArrowDataTransferHorizontalIcon,
  Link04Icon,
  RefreshIcon,
  ShieldKeyIcon,
  SquareLock02Icon,
} from "@hugeicons/core-free-icons";
import { DevicesMock } from "../devices-mock";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

/**
 * Devices: Acestes on several computers, working as one fleet (Settings,
 * Devices in the app; src/main/fleet). The replica plays it in the app's own
 * UI: the fleet on the Devices page, then a chat on this computer hands a job
 * to front-desk with run_on_device, front-desk's conversation opens here as a
 * tab, and the answer comes back.
 */

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
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function Devices() {
  return (
    <Section id="devices" label="Devices">
      <SectionHeader
        eyebrow="devices."
        title="All your computers. One agent."
        sub="Put Acestes on your other PCs and on the Windows servers you reach by RDP, and join them with a code. They work as one: the same agents, hosts, keys and memory on every one, and any of them can hand another a task."
        className="pb-12 sm:pb-14"
      />

      <div className="relative overflow-hidden px-3 pt-16 pb-10 sm:px-10 sm:pb-14">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[-120px] left-1/2 h-[360px] w-[85%] -translate-x-1/2 rounded-full bg-black/[0.07] blur-[110px] dark:bg-white/[0.06]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:linear-gradient(to_bottom,transparent,#000_60%)] [background-size:16px_16px]"
        />
        <Reveal y={40} start="top 90%">
          <div data-r className="relative mx-auto max-w-[1000px]">
            <DevicesMock />
          </div>
        </Reveal>
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
