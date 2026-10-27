"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowLeft01Icon,
  CheckmarkBadge01Icon,
  Notification03Icon,
  PlugSocketIcon,
  RefreshIcon,
  SentIcon,
  ShieldKeyIcon,
  SlidersHorizontalIcon,
  UserLock01Icon,
} from "@hugeicons/core-free-icons";
import { gsap, prefersReducedMotion, ScrollTrigger, useGSAP } from "@/lib/gsap";
import { sound, type Sound } from "@/lib/sound";
import { ChannelMark, type ChannelName } from "../channel-mark";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";
import { Bracket } from "../ui";

/**
 * Channels: the agent reached from a chat app, through a bot of the user's
 * own. Four tabs, one per app, and a phone that plays the same exchange in
 * each: a question, the work, an approval answered from the chat, and
 * /status with its buttons. What differs per app is what differs in the
 * product: "/" or "!" before a command, and reactions instead of buttons on
 * Matrix (see src/main/channels in the app).
 */

type App = {
  name: ChannelName;
  label: string;
  via: string;
  setup: string;
  prefix: "/" | "!";
  buttons: boolean;
};

const apps: App[] = [
  {
    name: "telegram",
    label: "Telegram",
    via: "bot api · long poll",
    setup: "A bot from @BotFather. Paste its token and pair.",
    prefix: "/",
    buttons: true,
  },
  {
    name: "discord",
    label: "Discord",
    via: "gateway · dms only",
    setup: "A bot from the Developer Portal, in a direct message. It reads no server.",
    prefix: "/",
    buttons: true,
  },
  {
    name: "slack",
    label: "Slack",
    via: "socket mode",
    setup: "An app of your own from a manifest, in its Messages tab.",
    prefix: "!",
    buttons: true,
  },
  {
    name: "matrix",
    label: "Matrix",
    via: "/sync · any homeserver",
    setup: "An account for the bot on any homeserver, in a room with you.",
    prefix: "!",
    buttons: false,
  },
];

const commands = ["new", "list", "stop", "status", "model", "effort", "mode", "agent"];

const points = [
  {
    tag: "paired",
    icon: UserLock01Icon,
    lead: "Yours alone.",
    body: "A one-time code from the desktop pairs one account. Anyone else who finds the bot is ignored, without an answer.",
  },
  {
    tag: "approvals",
    icon: CheckmarkBadge01Icon,
    lead: "Approve from the chat.",
    body: "When the conversation's mode asks before a change, the card comes to the chat with buttons. Blocked commands stay blocked.",
  },
  {
    tag: "controls",
    icon: SlidersHorizontalIcon,
    lead: "Steer it from the chat.",
    body: "Start, pick up or stop a conversation, choose who answers, and switch model, effort and mode with buttons.",
  },
  {
    tag: "outbound",
    icon: PlugSocketIcon,
    lead: "Nothing to open.",
    body: "Long polls and sockets the app opens itself: no port, no tunnel, no webhook. The bot token stays encrypted on your computer.",
  },
  {
    tag: "jobs",
    icon: Notification03Icon,
    lead: "It writes first.",
    body: "Job results, alerts and the approvals a background run waits on arrive in the chat, with buttons to answer them.",
  },
  {
    tag: "at the desk",
    icon: ShieldKeyIcon,
    lead: "Secrets stay at the desk.",
    body: "A question that wants a password is answered on the desktop only, and a message that arrives ten minutes late is offered, not run.",
  },
];

/* ------------------------------------------------------------------ */
/* The phone                                                           */
/* ------------------------------------------------------------------ */

function Me({ children }: { children: ReactNode }) {
  return (
    <div data-msg className="flex shrink-0 justify-end">
      <p className="max-w-[80%] rounded-2xl rounded-br-md bg-term-fg px-3 py-2 text-[13px] leading-snug text-term-bg">
        {children}
      </p>
    </div>
  );
}

function Bot({ children, after }: { children: ReactNode; after?: ReactNode }) {
  return (
    <div data-msg className="flex shrink-0 flex-col items-start">
      <div className="max-w-[88%] rounded-2xl rounded-bl-md bg-term-hl px-3 py-2 text-[13px] leading-snug text-term-fg">
        {children}
      </div>
      {after}
    </div>
  );
}

/** Matrix's stand-ins for buttons, as matrix.js numbers the ones without an emoji. */
const keycap = (i: number) => `${i + 1}️⃣`;

/** The choices under a card: buttons, or on Matrix the reactions it lists. */
function Choices({ app, items, press }: { app: App; items: { emoji?: string; text: string }[]; press?: number }) {
  if (!app.buttons) {
    return (
      <div className="mt-1.5 flex gap-1.5">
        {items.map((item, i) => (
          <span
            key={item.text}
            {...(i === press ? { "data-press-target": "" } : {})}
            className="rounded-full border border-white/10 bg-term-hl px-2.5 py-0.5 text-[12px]"
          >
            {item.emoji ?? keycap(i)}
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex w-full max-w-[88%] gap-1.5">
      {items.map((item, i) => (
        <span
          key={item.text}
          {...(i === press ? { "data-press-target": "" } : {})}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-term-hl/70 px-2 py-1.5 text-[12.5px] text-term-fg"
        >
          {item.emoji && <span aria-hidden="true">{item.emoji}</span>}
          {item.text}
        </span>
      ))}
    </div>
  );
}

function reactWith(items: { emoji?: string; text: string }[]) {
  return items.map((item, i) => `${item.emoji ?? keycap(i)} ${item.text}`).join(" · ");
}

const placeholder: Record<ChannelName, string> = {
  telegram: "Message",
  discord: "Message @Acestes",
  slack: "Message Acestes",
  matrix: "Send a message…",
};

const approve = [
  { emoji: "✅", text: "Approve" },
  { emoji: "❌", text: "Deny" },
];
const settings = [{ text: "Model" }, { text: "Effort" }, { text: "Mode" }];

function Phone({ app }: { app: App }) {
  return (
    <div className="mx-auto w-full max-w-[372px] rounded-[30px] bg-term-bg p-[7px] ring-1 ring-black/10 dark:ring-white/10">
      <div className="overflow-hidden rounded-[24px] bg-[#101012] text-term-fg">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 pt-4 pb-3">
          <Icon icon={ArrowLeft01Icon} size={18} className="text-term-muted" />
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-term-hl text-term-fg">
            <span
              className="block mask-brand"
              style={{
                maskImage: "url(/brand/mark.png)",
                WebkitMaskImage: "url(/brand/mark.png)",
                height: 14,
                aspectRatio: "352 / 406",
              }}
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] leading-tight font-medium">Acestes</p>
            <p className="text-[11.5px] text-term-muted">bot · answering from your desk</p>
          </div>
          <ChannelMark name={app.name} tone="color" size={20} className="shrink-0 text-term-fg" />
        </div>

        {/* Messages: newest at the bottom, the oldest scroll out of the top. */}
        <div data-chat data-reveal className="flex h-[420px] flex-col justify-end gap-2 overflow-hidden p-3">
          <Me>web-02 is throwing 502s again</Me>

          <Bot>
            <p className="italic">Working…</p>
            <p data-step className="font-mono text-[11.5px] text-term-muted">
              • read nginx error.log on web-02
            </p>
            <p data-step className="font-mono text-[11.5px] text-term-muted">
              • checked php8.2-fpm on web-02
            </p>
          </Bot>

          <Bot>
            Every php-fpm worker on <strong className="font-medium">web-02</strong> has been stuck on one slow query
            since 14:02, and nginx has logged 37 502s. A restart frees them.
          </Bot>

          <Bot
            after={
              <div data-choices className="w-full">
                <Choices app={app} items={approve} press={0} />
              </div>
            }
          >
            <p className="font-medium">Approval needed</p>
            <p className="mt-0.5">
              Run a command on <strong className="font-medium">web-02</strong>
            </p>
            <code className="mt-1.5 block rounded-md bg-black/40 px-2 py-1 font-mono text-[11.5px] text-violet-300">
              sudo systemctl restart php8.2-fpm
            </code>
            {!app.buttons && (
              <p data-choices className="mt-1.5 text-[12px] text-term-muted italic">
                React with {reactWith(approve)}
              </p>
            )}
            <p data-settled className="mt-1.5 hidden text-[12px] text-term-muted italic">
              Approved.
            </p>
          </Bot>

          <Bot>Restarted, and no 502s since. Want me to look at that slow query next?</Bot>

          <Me>{app.prefix}status</Me>

          <Bot after={<Choices app={app} items={settings} />}>
            <p>
              <strong className="font-medium">Ace</strong> on workstation
            </p>
            <p className="text-term-muted">Conversation: web-02 502s · Idle.</p>
            <p className="mt-1.5">
              <strong className="font-medium">Model:</strong> Opus 5.5 · High effort
            </p>
            <p>
              <strong className="font-medium">Mode:</strong> Ask every time, every tool call waits for you
            </p>
            {!app.buttons && (
              <p className="mt-1.5 text-[12px] text-term-muted italic">React with {reactWith(settings)}</p>
            )}
          </Bot>
        </div>

        {/* Composer */}
        <div className="flex items-center gap-2 border-t border-white/[0.06] px-3 py-3">
          <span className="flex-1 truncate rounded-full bg-term-hl px-4 py-2 text-[13px] text-term-muted">
            {placeholder[app.name]}
          </span>
          <span className="grid size-9 place-items-center rounded-full bg-term-hl text-term-muted">
            <Icon icon={SentIcon} size={16} />
          </span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export function Channels() {
  const [active, setActive] = useState(0);
  const [run, setRun] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Once someone picks a tab, the phone stops moving on to the next app. */
  const picked = useRef(false);
  /** Whether the section has been scrolled to: until then the phone waits. */
  const seen = useRef(false);
  const app = apps[active];

  const pick = (i: number) => {
    picked.current = true;
    setActive(i);
    setRun((r) => r + 1);
  };

  // The exchange, played message by message. It waits for the section to come
  // into view the first time, replays on each tab, and pauses off screen.
  // Left alone, it moves on to the next app when it ends.
  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;
      const q = gsap.utils.selector(el);
      const chat = q("[data-chat]")[0] as HTMLElement | undefined;
      if (!chat) return;
      if (prefersReducedMotion()) {
        gsap.set(chat, { autoAlpha: 1 });
        gsap.set(q("[data-settled]"), { display: "block" });
        gsap.set(q("[data-choices]"), { display: "none" });
        return;
      }

      const msgs = q("[data-msg]");
      const steps = q("[data-step]");
      const target = q("[data-press-target]");
      gsap.set(msgs, { height: 0, autoAlpha: 0, overflow: "hidden" });
      gsap.set(steps, { autoAlpha: 0 });
      gsap.set(chat, { autoAlpha: 1 });

      // A message in, with its sound if the visitor has it on.
      const show = (tl: gsap.core.Timeline, m: Element, at: string | number = ">", cue?: Sound) => {
        tl.to(m, { height: "auto", autoAlpha: 1, duration: 0.45, ease: "power3.out" }, at);
        if (cue) tl.call(() => sound.play(cue), [], "<");
        return tl;
      };

      const tl = gsap.timeline({ paused: true, delay: 0.3 });
      show(tl, msgs[0], ">", "send");
      show(tl, msgs[1], "+=0.5", "blip");
      tl.to(steps, { autoAlpha: 1, duration: 0.3, stagger: 0.55 }, ">0.2");
      const stepsAt = (tl.recent() as gsap.core.Tween).startTime();
      steps.forEach((_, i) => tl.call(() => sound.play("step"), [], stepsAt + i * 0.55));
      show(tl, msgs[2], stepsAt + (steps.length - 1) * 0.55 + 0.9, "blip");
      show(tl, msgs[3], "+=0.7", "blip");
      // The press: the Approve button (or the ✅ reaction) is tapped, then
      // the card settles and its choices go, as the gateway leaves it.
      tl.to(target, { scale: 0.94, duration: 0.12, ease: "power2.in" }, "+=1.1")
        .call(() => sound.play("press"), [], "<")
        .to(target, { scale: 1, borderColor: "rgba(167,139,250,0.9)", duration: 0.2, ease: "power2.out" })
        .set(q("[data-settled]"), { display: "block" }, "+=0.35")
        .call(() => sound.play("chime"), [], "<")
        .to(q("[data-choices]"), { height: 0, marginTop: 0, autoAlpha: 0, duration: 0.3, ease: "power2.inOut" }, "<");
      show(tl, msgs[4], "+=0.9", "blip");
      show(tl, msgs[5], "+=1.2", "send");
      show(tl, msgs[6], "+=0.6", "blip");
      tl.to({}, { duration: 3.2 });

      if (!picked.current) {
        const bar = q(`[data-bar="${active}"]`);
        tl.fromTo(bar, { scaleX: 0 }, { scaleX: 1, duration: tl.duration() - 0.3, ease: "none" }, 0);
        tl.eventCallback("onComplete", () => setActive((a) => (a + 1) % apps.length));
      }

      const st = ScrollTrigger.create({
        trigger: el,
        start: "top 70%",
        end: "bottom 15%",
        onToggle: (self) => {
          if (self.isActive) {
            seen.current = true;
            tl.play();
          } else {
            tl.pause();
          }
        },
      });
      if (seen.current && st.isActive) tl.play();
    },
    { scope: root, dependencies: [active, run], revertOnUpdate: true },
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const n = apps.length;
    const next =
      e.key === "ArrowDown"
        ? (active + 1) % n
        : e.key === "ArrowUp"
          ? (active - 1 + n) % n
          : e.key === "Home"
            ? 0
            : n - 1;
    pick(next);
    tabs.current[next]?.focus();
  };

  return (
    <Section id="channels" label="Channels">
      <SectionHeader
        eyebrow="channels."
        title="Away from the desk, still on call."
        sub="Pair a bot of your own on Telegram, Discord, Slack or Matrix. The agent does the work on your computer and answers you in the chat, approvals included."
        className="border-b border-line"
      />

      <div ref={root} className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
        {/* Apps */}
        <div className="flex flex-col border-b border-line lg:border-r lg:border-b-0">
          <div role="tablist" aria-label="Chat apps Acestes answers in" aria-orientation="vertical" onKeyDown={onKey}>
            {apps.map((a, i) => {
              const on = i === active;
              return (
                <button
                  key={a.name}
                  ref={(el) => {
                    tabs.current[i] = el;
                  }}
                  role="tab"
                  id={`channels-tab-${i}`}
                  aria-selected={on}
                  aria-controls="channels-panel"
                  tabIndex={on ? 0 : -1}
                  onClick={() => pick(i)}
                  className={`group/t relative flex w-full items-center gap-4 border-b border-line px-5 py-6 text-left transition-colors duration-300 sm:px-10 ${
                    on ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel hover:text-fg"
                  }`}
                >
                  {/* The logo in its own colours when picked or pointed at, in ink otherwise. */}
                  <span className="relative grid size-8 shrink-0 place-items-center">
                    <ChannelMark
                      name={a.name}
                      size={24}
                      className={`transition-opacity duration-300 ${on ? "opacity-0" : "opacity-100 group-hover/t:opacity-0"}`}
                    />
                    <ChannelMark
                      name={a.name}
                      tone="color"
                      size={24}
                      className={`absolute text-fg transition-opacity duration-300 ${
                        on ? "opacity-100" : "opacity-0 group-hover/t:opacity-100"
                      }`}
                    />
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[18px] tracking-[-0.015em] sm:text-[20px]">
                      {a.label}
                      <code className="font-mono text-[12px] text-subtle sm:text-[13px]">{a.via}</code>
                    </span>
                    <span className="text-[14px] leading-snug text-muted">{a.setup}</span>
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

          {/* Commands, typed the way this app takes them */}
          <div className="flex flex-1 flex-col justify-end gap-4 px-5 py-8 sm:px-10">
            <div className="flex items-center justify-between gap-3">
              <Bracket>Commands</Bracket>
              <button
                type="button"
                onClick={() => setRun((r) => r + 1)}
                aria-label="Replay the chat"
                className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-panel-2 hover:text-fg"
              >
                <Icon icon={RefreshIcon} size={15} />
              </button>
            </div>
            <ul className="flex flex-wrap gap-2" aria-label={`Commands in ${app.label}`}>
              {commands.map((c) => (
                <li key={c} className="rounded-md border border-line px-2 py-1 font-mono text-[12.5px] text-muted">
                  <span className="text-accent">{app.prefix}</span>
                  {c}
                </li>
              ))}
            </ul>
            <p className="text-[13px] leading-relaxed text-muted">
              {app.prefix === "/"
                ? `${app.label} lists them as you type /.`
                : `${app.label} keeps / for its own commands, so these take !.`}{" "}
              Each chat is a conversation in Acestes, carried on from either side.
            </p>
          </div>
        </div>

        {/* Phone */}
        <div
          id="channels-panel"
          role="tabpanel"
          aria-labelledby={`channels-tab-${active}`}
          className="relative overflow-hidden px-3 py-10 sm:px-8 sm:py-12"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:linear-gradient(to_bottom,transparent,#000_70%)] [background-size:16px_16px]"
          />
          <div className="relative">
            <Phone key={`${app.name}-${run}`} app={app} />
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
        The work happens on your computer, so Acestes has to be running: closing the window keeps it in the tray,
        answering. Matrix rooms need end-to-end encryption off for the bot to read them.
      </p>
    </Section>
  );
}
