import {
  CursorInWindowIcon,
  KeyboardIcon,
  Mic01Icon,
  Route01Icon,
  StopCircleIcon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";
import { VoiceMock } from "../voice-mock";

/**
 * Push to talk (2.0): Acestes in the background, Ctrl+Alt held anywhere to
 * talk to the agent, which gets the words and the screen under the pointer
 * and works it with computer use (src/main/ai/buddy.js, BuddyOverlay.jsx).
 */

const points = [
  {
    tag: "anywhere",
    icon: KeyboardIcon,
    lead: "Two keys, in any app.",
    body: "Hold Ctrl+Alt, say it, let go. No window to switch to and nothing to type. Speech is written down on this computer.",
  },
  {
    tag: "context",
    icon: CursorInWindowIcon,
    lead: "It sees what you point at.",
    body: "Your words go with a capture of the screen your pointer is on, the pointer ringed, so “this one” means the one you're on.",
  },
  {
    tag: "notch",
    icon: Route01Icon,
    lead: "Every step, in view.",
    body: "A notch at the top of the screen shows what it heard, what it is doing and what it asks. It never takes focus or catches a click.",
  },
  {
    tag: "steer",
    icon: Mic01Icon,
    lead: "Correct it mid-task.",
    body: "Hold Ctrl+Alt again to change course, or to answer a question it asks aloud. It carries on while you talk.",
  },
  {
    tag: "control",
    icon: StopCircleIcon,
    lead: "Stop it from the notch.",
    body: "Stop, and Open in Acestes, sit in the notch while it works. Touch the mouse and it pauses; press Esc and it stops.",
  },
  {
    tag: "recap",
    icon: VolumeHighIcon,
    lead: "One line, out loud.",
    body: "When it finishes it says what it did in a sentence, in this computer's voice or an ElevenLabs voice on your own key.",
  },
];

export function Voice() {
  return (
    <Section id="voice" label="Push to talk">
      <SectionHeader
        eyebrow="push to talk."
        title="Point at it. Say what needs doing."
        sub="Acestes waits in the background. Hold Ctrl+Alt in any app, speak, and let go: the agent gets your words and the screen under your pointer, and works it with computer use while a notch at the top of the screen reports each step."
        className="border-b border-line"
      />

      <div className="relative overflow-hidden px-3 py-10 sm:px-8 sm:py-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:linear-gradient(to_bottom,transparent,#000_70%)] [background-size:16px_16px]"
        />
        <Reveal y={30} start="top 90%">
          <div data-r className="relative mx-auto max-w-[1120px]">
            <VoiceMock />
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
        On Windows today. Ctrl+Alt+Space moves to the next agent, and asked where something is, it points to it on
        screen. It works under the same rules as computer use, and its questions and approvals come to the notch. Turn
        it on in Settings, under Agentic Use.
      </p>
    </Section>
  );
}
