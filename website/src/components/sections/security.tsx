"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { site } from "@/lib/site";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { Section } from "../frame";
import { TermLines, TermWindow, type TermLine } from "../terminal";
import { SectionHeader } from "../section-header";
import { ButtonLink } from "../ui";

type Play = { title: string; tool: string; lead: string; body: string; cwd: string; lines: TermLine[] };

// Addresses are from the ranges set aside for examples (RFC 5737).
const plays: Play[] = [
  {
    title: "It audits the fleet",
    tool: "fan_out",
    lead: "It audits the whole fleet.",
    body: "One check across every host at once: SSH settings, open ports, pending updates, who can log in. The odd ones out come back first.",
    cwd: "fleet · 40 hosts",
    lines: [
      { k: "cmd", t: "fan_out \"sshd -T | grep -iE 'permitroot|passwordauth'\"" },
      { k: "ok", t: "web-01 … web-24    keys only, no root" },
      { k: "ok", t: "cache-01 … 08      keys only, no root" },
      { k: "bad", t: "legacy-03   permitrootlogin yes" },
      { k: "bad", t: "vpn-01      passwordauthentication yes" },
      { k: "gap" },
      { k: "info", t: "38 as they should be · 2 need you" },
    ],
  },
  {
    title: "It digs into an incident",
    tool: "watch_metric",
    lead: "It digs into an incident.",
    body: "Reads the logs on every box you point it at, charts what is happening as it happens, and remembers what the last incident turned out to be.",
    cwd: "bastion-01",
    lines: [
      { k: "cmd", t: "why so many failed logins on bastion-01?" },
      { k: "info", t: 'recall "bastion failed logins"  →  brute force from one range, May' },
      { k: "out", t: "auth.log   1,912 failed in the last hour" },
      { k: "out", t: "top        203.0.113.42  1,804 tries · 41 usernames" },
      { k: "tag", tag: "live", tone: "accent", t: "failed logins / min   ▁▂▃▅▇█▇█" },
      { k: "gap" },
      { k: "ok", t: "Same pattern as May. Blocking it needs you." },
    ],
  },
  {
    title: "It fixes it, on your say-so",
    tool: "approval",
    lead: "It fixes it, on your say-so.",
    body: "Every change waits on a card with the exact command. Sessions can be recorded keystroke by keystroke, and commands you block never run.",
    cwd: "bastion-01",
    lines: [
      { k: "cmd", t: "sudo ufw deny from 203.0.113.42" },
      { k: "tag", tag: "waiting", tone: "warn", t: "on you   [ Allow ]  [ Deny ]" },
      { k: "ok", t: "allowed by you · rule added" },
      { k: "out", t: "recorded   bastion-01 · 02:31:07" },
      { k: "gap" },
      { k: "cmd", t: "rm -rf /var/log" },
      { k: "tag", tag: "blocked", tone: "bad", t: "on your list. No approval lets it through." },
    ],
  },
  {
    title: "It keeps watch",
    tool: "schedule_job",
    lead: "It keeps watch while you sleep.",
    body: "Jobs run on a schedule, a webhook or a host going down: certificates about to lapse, ports that opened, logins that spiked. Anything that needs changing waits for you.",
    cwd: "jobs",
    lines: [
      { k: "cmd", t: 'schedule_job "exposure check" daily 06:00' },
      { k: "ok", t: "job created  exposure-check" },
      { k: "out", t: "checks     open ports · cert expiry · failed logins" },
      { k: "out", t: "on         web-01 … web-24 · bastion-01 · vpn-01" },
      { k: "out", t: "on change  waits for you first" },
    ],
  },
  {
    title: "It reaches the odd box",
    tool: "connect_host",
    lead: "It reaches the odd box.",
    body: "Jump hosts, proxies, serial and Telnet: the switch in the rack and the server behind the bastion are in reach, through sessions you can watch.",
    cwd: "core-sw-01 · serial",
    lines: [
      { k: "cmd", t: "connect_host core-sw-01   COM3 · 9600 8N1" },
      { k: "ok", t: "connected" },
      { k: "cmd", t: "show running-config | include snmp" },
      { k: "bad", t: "snmp-server community public RO" },
      { k: "gap" },
      { k: "info", t: "A default community string. Replace it with one from your keychain?" },
    ],
  },
  {
    title: "It can stay in the building",
    tool: "local model",
    lead: "It can stay in the building.",
    body: "Give an agent a local model through Ollama, LM Studio or vLLM, and what it reads never leaves your network. Secrets never reach any model at all.",
    cwd: "agents · Achates",
    lines: [
      { k: "tag", tag: "runtime", tone: "accent", t: "Ollama, on this machine" },
      { k: "tag", tag: "access", tone: "accent", t: "20 hosts · reads only" },
      { k: "tag", tag: "secrets", tone: "accent", t: "seen as {{secret:name}}, never the value" },
      { k: "gap" },
      { k: "ok", t: "Audit done. Nothing left the building." },
    ],
  },
];

const DWELL = 7;

export function Security() {
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const p = plays[active];

  // Autoplay: the active tab's bar fills, then the next tab takes over.
  // Paused while the section is off screen.
  useGSAP(
    () => {
      if (prefersReducedMotion()) return;
      const bar = root.current?.querySelector(`[data-bar="${active}"]`);
      if (!bar) return;
      const tween = gsap.fromTo(
        bar,
        { scaleX: 0 },
        {
          scaleX: 1,
          duration: DWELL,
          ease: "none",
          paused: true,
          onComplete: () => setActive((a) => (a + 1) % plays.length),
        },
      );
      const st = ScrollTrigger.create({
        trigger: root.current,
        start: "top 80%",
        end: "bottom 20%",
        onToggle: (self) => (self.isActive ? tween.play() : tween.pause()),
      });
      if (st.isActive) tween.play();
    },
    { dependencies: [active], scope: root, revertOnUpdate: true },
  );

  // Replay the terminal each time the tab changes.
  useGSAP(
    () => {
      const el = panel.current;
      if (!el || prefersReducedMotion()) return;
      const lines = el.querySelectorAll("[data-line]");
      const copy = el.querySelectorAll("[data-copy]");
      const cmd = el.querySelector<HTMLElement>("[data-cmd]");
      const tl = gsap.timeline();
      tl.fromTo(
        copy,
        { autoAlpha: 0, y: 8 },
        { autoAlpha: 1, y: 0, duration: 0.6, ease: "expo.out", stagger: 0.05 },
        0,
      );
      tl.fromTo(
        lines,
        { autoAlpha: 0, y: 6 },
        { autoAlpha: 1, y: 0, duration: 0.45, ease: "power2.out", stagger: 0.12 },
        0.05,
      );
      if (cmd) {
        const full = cmd.textContent ?? "";
        tl.fromTo(cmd, { text: "" }, { text: full, duration: Math.min(0.9, full.length * 0.025), ease: "none" }, 0.1);
      }
    },
    { dependencies: [active], scope: panel, revertOnUpdate: true },
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const n = plays.length;
    const next =
      e.key === "ArrowDown"
        ? (active + 1) % n
        : e.key === "ArrowUp"
          ? (active - 1 + n) % n
          : e.key === "Home"
            ? 0
            : n - 1;
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <Section id="security" label="Security work">
      <div ref={root} className="grid lg:grid-cols-2">
        <SectionHeader
          eyebrow="built for security work."
          title="Audits. Investigates. Hardens. Asks first."
          sub="It works your fleet like a careful engineer: through the same SSH sessions you use, every command in the open, every change on your say-so."
          className="border-b border-line lg:col-span-2"
        >
          <ButtonLink href={site.repo} external arrow>
            Explore on GitHub
          </ButtonLink>
          <ButtonLink href={`${site.repo}#readme`} external variant="outline">
            Read the README
          </ButtonLink>
        </SectionHeader>

        {/* Tabs */}
        <div
          role="tablist"
          aria-label="Security work Acestes does"
          aria-orientation="vertical"
          onKeyDown={onKey}
          className="border-line lg:border-r"
        >
          {plays.map((item, i) => {
            const on = i === active;
            return (
              <button
                key={item.tool}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                role="tab"
                id={`security-tab-${i}`}
                aria-selected={on}
                aria-controls="security-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setActive(i)}
                className={`relative flex w-full items-center gap-4 border-b border-line px-5 py-6 text-left transition-colors duration-300 sm:px-10 lg:min-h-[88px] ${
                  on ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel hover:text-fg"
                } last:border-b-0 lg:last:border-b-0`}
              >
                <span className="w-5 font-mono text-[11px] text-subtle">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1 text-[18px] tracking-[-0.015em] sm:text-[20px]">
                  {item.title}
                  <code className="font-mono text-[13px] text-subtle sm:text-[14px]">`{item.tool}`</code>
                </span>
                <span
                  aria-hidden="true"
                  data-bar={i}
                  className={`absolute inset-x-0 bottom-[-1px] h-[2px] origin-left scale-x-0 bg-accent ${on ? "" : "opacity-0"}`}
                />
              </button>
            );
          })}
        </div>

        {/* Panel */}
        <div
          ref={panel}
          id="security-panel"
          role="tabpanel"
          aria-labelledby={`security-tab-${active}`}
          className="flex flex-col border-t border-line lg:border-t-0"
        >
          <div className="flex min-h-[176px] items-center border-b border-line px-5 py-8 sm:px-10">
            <p className="text-[19px] leading-[1.45] tracking-[-0.015em] text-muted sm:text-[20px]">
              <span data-copy className="mr-2 text-subtle">
                {"//"}
              </span>
              <strong data-copy className="font-medium text-fg">
                {p.lead}
              </strong>{" "}
              <span data-copy>{p.body}</span>
            </p>
          </div>
          <div className="flex flex-1 p-4 sm:p-5">
            <TermWindow title={p.cwd} className="flex w-full flex-col" bodyClassName="min-h-[230px] flex-1">
              <TermLines key={active} lines={p.lines} />
            </TermWindow>
          </div>
        </div>
      </div>
    </Section>
  );
}
