"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { site } from "@/lib/site";
import { gsap, prefersReducedMotion, useGSAP } from "@/lib/gsap";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Eyebrow } from "../ui";

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg"
  >
    {children}
  </a>
);

const faqs: { q: string; a: ReactNode }[] = [
  {
    q: "Can it do security work on my servers?",
    a: (
      <>
        Yes, with your access and nothing more. It opens the same SSH sessions you do, through jump hosts and proxies,
        runs a check across many hosts at once, reads the logs, and keeps watch on a schedule. Anything that changes a
        server waits for your say-so on a card with the exact command, unless you decide otherwise.
      </>
    ),
  },
  {
    q: "Does anything leave my network?",
    a: (
      <>
        That depends on the agent you run it on. Give it a local model through Ollama, LM Studio or vLLM and what it
        reads stays on your machine. Passwords and keys never reach any model: it only ever sees a reference to them.
      </>
    ),
  },
  {
    q: "How does computer use work, and is it safe?",
    a: (
      <>
        It reads a window through the accessibility tree, the way a screen reader does, numbers its controls and works
        them with the real cursor and keys. It is off until you switch it on, asks before each app, pauses the moment
        you touch the mouse, stops on Esc, and can never touch its own window.
      </>
    ),
  },
  {
    q: "How is Acestes different from Claude Code or Codex?",
    a: (
      <>
        It runs <strong className="font-medium text-fg">on</strong> them. Acestes drives the coding agent you already
        have and adds what a chat window lacks: a memory that lasts, an inventory of hosts, keys and folders, approval
        cards for every change, real terminal sessions on your servers, computer use, and jobs that run while
        you&apos;re away.
      </>
    ),
  },
  {
    q: "Do I need a new subscription or an API key?",
    a: (
      <>
        No. It uses the runtimes already installed and signed in on your machine, on your own accounts. You need at
        least one of them; the app finds it on its own. Local models through Ollama, LM Studio or vLLM work too.
      </>
    ),
  },
  {
    q: "What can it touch on my computer?",
    a: (
      <>
        Only the folders you grant it, each read-only or read and write. Turn on the container and that fence becomes a
        wall. On a server, its access is exactly yours, through sessions you can watch.
      </>
    ),
  },
  {
    q: "How does it handle passwords and keys?",
    a: (
      <>
        Secrets go one way. You type them into a masked field, they&apos;re stored encrypted in your keychain, and the
        agent only ever sees a reference like{" "}
        <code className="font-mono text-[0.92em] text-fg">{"{{secret:name}}"}</code>. None ever lands in a transcript or
        a log.
      </>
    ),
  },
  {
    q: "Will it change things without asking?",
    a: (
      <>
        Only if you say so. Each agent asks for everything, only for changes, or never. Commands you block are refused
        outright, however they&apos;re spelled, and no approval lets them through.
      </>
    ),
  },
  {
    q: "Which systems does it run on?",
    a: (
      <>
        Windows (installer or portable), macOS on Apple silicon and Intel, and Linux as an AppImage. The builds
        aren&apos;t code-signed yet, so your system will warn you the first time; the{" "}
        <A href={`${site.repo}#download`}>README</A> says how to get past it.
      </>
    ),
  },
  {
    q: "What does it cost?",
    a: (
      <>
        Nothing. Acestes is free to use and modify under a fair-code license, and the source is open to read on{" "}
        <A href={site.repo}>GitHub</A>.
      </>
    ),
  },
];

function Item({ q, a, open, onToggle }: { q: string; a: ReactNode; open: boolean; onToggle: () => void }) {
  const id = useId();
  const body = useRef<HTMLDivElement>(null);
  // Height is React's only on first paint; after that GSAP owns it, so a
  // re-render never snaps the panel open before the tween can run.
  const [initiallyOpen] = useState(open);

  useGSAP(
    () => {
      const el = body.current;
      const copy = el?.firstElementChild;
      if (!el || !copy) return;
      if (prefersReducedMotion()) {
        gsap.set(el, { height: open ? "auto" : 0 });
        return;
      }
      gsap.to(el, {
        height: open ? "auto" : 0,
        duration: open ? 0.55 : 0.4,
        ease: open ? "expo.out" : "power3.inOut",
        overwrite: true,
      });
      if (open) {
        gsap.fromTo(copy, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.5, delay: 0.08, overwrite: true });
      } else {
        gsap.to(copy, { autoAlpha: 0, duration: 0.2, overwrite: true });
      }
    },
    { dependencies: [open] },
  );

  return (
    <div className="border-b border-line last:border-b-0">
      <h3>
        <button
          type="button"
          id={`${id}-q`}
          aria-expanded={open}
          aria-controls={`${id}-a`}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-6 px-5 py-6 text-left text-[16px] font-medium tracking-[-0.01em] transition-colors hover:bg-panel sm:px-8"
        >
          {q}
          <Icon
            icon={ArrowDown01Icon}
            size={18}
            strokeWidth={2}
            className={`shrink-0 text-muted transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h3>
      <div
        ref={body}
        id={`${id}-a`}
        role="region"
        aria-labelledby={`${id}-q`}
        className="overflow-hidden"
        style={{ height: initiallyOpen ? "auto" : 0 }}
        inert={!open}
      >
        <p className="px-5 pb-7 text-[15px] leading-[1.65] text-muted sm:px-8">{a}</p>
      </div>
    </div>
  );
}

export function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <Section id="faq" label="Frequently asked questions">
      <div className="grid lg:grid-cols-[2fr_3fr]">
        <div className="border-b border-line px-5 py-12 sm:px-10 lg:border-r lg:border-b-0">
          <div className="lg:sticky lg:top-28">
            <Eyebrow>faq</Eyebrow>
            <h2 className="mt-4 text-[36px] leading-[1.05] font-medium tracking-[-0.03em] sm:text-[40px]">
              Questions,
              <br />
              answered.
            </h2>
            <p className="mt-5 max-w-[320px] text-[15px] leading-relaxed text-muted">
              What usually comes up before someone hands it the keys to the fleet. Still curious? Read the{" "}
              <A href={`${site.repo}#readme`}>README</A> or <A href={site.issues}>open an issue</A>.
            </p>
          </div>
        </div>
        <div>
          {faqs.map((f, i) => (
            <Item key={f.q} q={f.q} a={f.a} open={open === i} onToggle={() => setOpen((o) => (o === i ? -1 : i))} />
          ))}
        </div>
      </div>
    </Section>
  );
}
