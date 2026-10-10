"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { site } from "@/lib/site";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { Section } from "../frame";
import { TermLines, TermWindow, type TermLine } from "../terminal";
import { SectionHeader } from "../section-header";
import { ButtonLink } from "../ui";

type Feature = { title: string; tool: string; lead: string; body: string; cwd: string; lines: TermLine[] };

const features: Feature[] = [
  {
    title: "It remembers",
    tool: "remember",
    lead: "It remembers.",
    body: "How your projects are laid out, how you like things done, what the fix turned out to be. Stored on your machine and searched by meaning.",
    cwd: "~/code/shop",
    lines: [
      { k: "cmd", t: "why is the staging deploy slow again?" },
      { k: "info", t: 'recall "staging deploy slow"' },
      { k: "out", t: "m-4f2  staging builds skip the npm cache since 12 Sep" },
      { k: "out", t: "m-9a1  you prefer small commits, one fix each" },
      { k: "gap" },
      { k: "ok", t: "2 notes found. Picking up where we left off." },
    ],
  },
  {
    title: "It does the work",
    tool: "run_command",
    lead: "It does the work.",
    body: "Reads, searches and edits your code, runs the build, opens a shell on the server and checks the result.",
    cwd: "~/code/shop",
    lines: [
      { k: "cmd", t: "npm test" },
      { k: "bad", t: "3 failing  test/billing.test.js" },
      { k: "info", t: 'git bisect  →  8c1e2d4 "Round invoice lines early"' },
      { k: "info", t: "edit src/billing/total.js  (+4 −2)" },
      { k: "gap" },
      { k: "ok", t: "214 passing  (1.84s)" },
    ],
  },
  {
    title: "It uses your desktop",
    tool: "read_screen",
    lead: "It uses your desktop.",
    body: "When there is no API, it works the app itself: reads the window, clicks, types and checks the result, with the real cursor where you can see it.",
    cwd: "desktop",
    lines: [
      { k: "cmd", t: "export last month's invoices from the billing app" },
      { k: "info", t: "open_app  Billing" },
      { k: "out", t: "read_screen  48 controls · [12] Reports · [31] Export" },
      { k: "info", t: 'click [12] → click [31] → type_text "2026-09"' },
      { k: "gap" },
      { k: "ok", t: "invoices-2026-09.csv saved to ~/Downloads" },
    ],
  },
  {
    title: "It carries its own kit",
    tool: "inventory",
    lead: "It carries its own kit.",
    body: "Folders, hosts, keys, snippets, playbooks and MCP servers live in its inventory. It keeps that up to date itself.",
    cwd: "inventory",
    lines: [
      { k: "cmd", t: "list_inventory" },
      { k: "tag", tag: "hosts", tone: "accent", t: "web-01  web-02  db-01  homelab" },
      { k: "tag", tag: "keys", tone: "accent", t: "deploy-ed25519  github-ci" },
      { k: "tag", tag: "folders", tone: "accent", t: "~/code/shop  ~/code/infra" },
      { k: "tag", tag: "mcp", tone: "accent", t: "github  grafana  postgres" },
      { k: "tag", tag: "specs", tone: "accent", t: "rotate-logs  renew-certs" },
    ],
  },
  {
    title: "It stays inside the fence",
    tool: "folders",
    lead: "It stays inside the fence.",
    body: "It only touches the folders you grant it. Turn on the container and the fence becomes a wall.",
    cwd: "~/code/shop",
    lines: [
      { k: "cmd", t: "read ~/.ssh/id_ed25519" },
      { k: "bad", t: "refused  outside the granted folders" },
      { k: "out", t: "granted  ~/code/shop  (read and write)" },
      { k: "gap" },
      { k: "info", t: "container on: the fence is now a wall" },
    ],
  },
  {
    title: "It works while you're away",
    tool: "schedule_job",
    lead: "It works while you're away.",
    body: "Jobs run on a schedule, a webhook or a host going down, and keep running after you close the window.",
    cwd: "jobs",
    lines: [
      { k: "cmd", t: 'schedule_job "certificate expiry" daily 07:00' },
      { k: "ok", t: "job created  cert-check" },
      { k: "out", t: "next run   tomorrow 07:00" },
      { k: "out", t: "watches    web-01  web-02  homelab" },
      { k: "out", t: "on change  waits for you first" },
    ],
  },
  {
    title: "It shares the work",
    tool: "fan_out",
    lead: "It shares the work.",
    body: "Run one check across twenty hosts, or hand a task to another agent.",
    cwd: "fleet",
    lines: [
      { k: "cmd", t: 'fan_out "df -h /" across 20 hosts' },
      { k: "ok", t: "web-01 … web-12   under 70%" },
      { k: "ok", t: "cache-01 … 06     under 55%" },
      { k: "bad", t: "db-01   91%  /var/lib/postgresql" },
      { k: "gap" },
      { k: "info", t: "19 healthy · 1 needs you" },
    ],
  },
  {
    title: "You decide how much it does alone",
    tool: "approval",
    lead: "You decide how much it does alone.",
    body: "Ask for everything, only for changes, or never. Dangerous commands are blocked outright.",
    cwd: "web-02",
    lines: [
      { k: "cmd", t: "sudo systemctl reload nginx" },
      { k: "tag", tag: "waiting", tone: "warn", t: "on you   [ Allow ]  [ Deny ]" },
      { k: "gap" },
      { k: "cmd", t: "rm -rf /var/www" },
      { k: "tag", tag: "blocked", tone: "bad", t: "on your list. No approval lets it through." },
    ],
  },
];

const DWELL = 7;

export function Features() {
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const f = features[active];

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
          onComplete: () => setActive((a) => (a + 1) % features.length),
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
    const n = features.length;
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
    <Section id="features" label="Features">
      <div ref={root} className="grid lg:grid-cols-2">
        <SectionHeader
          eyebrow="an agent, not a chatbot."
          title="Remembers. Works. Asks first."
          sub="It drives your desktop apps, carries its own kit, stays inside the fence, and keeps working while you're away."
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
          aria-label="What Acestes does"
          aria-orientation="vertical"
          onKeyDown={onKey}
          className="border-line lg:border-r"
        >
          {features.map((item, i) => {
            const on = i === active;
            return (
              <button
                key={item.tool}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                role="tab"
                id={`feature-tab-${i}`}
                aria-selected={on}
                aria-controls="feature-panel"
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
          id="feature-panel"
          role="tabpanel"
          aria-labelledby={`feature-tab-${active}`}
          className="flex flex-col border-t border-line lg:border-t-0"
        >
          <div className="flex min-h-[176px] items-center border-b border-line px-5 py-8 sm:px-10">
            <p className="text-[19px] leading-[1.45] tracking-[-0.015em] text-muted sm:text-[20px]">
              <span data-copy className="mr-2 text-subtle">
                {"//"}
              </span>
              <strong data-copy className="font-medium text-fg">
                {f.lead}
              </strong>{" "}
              <span data-copy>{f.body}</span>
            </p>
          </div>
          <div className="flex flex-1 p-4 sm:p-5">
            <TermWindow title={f.cwd} className="flex w-full flex-col" bodyClassName="min-h-[230px] flex-1">
              <TermLines key={active} lines={f.lines} />
            </TermWindow>
          </div>
        </div>
      </div>
    </Section>
  );
}
