import {
  CursorPointer01Icon,
  HandGrabIcon,
  Radar01Icon,
  ScanEyeIcon,
  ShieldCheckIcon,
  SquareDashedMousePointerIcon,
} from "@hugeicons/core-free-icons";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { ScreenMock } from "../screen-mock";
import { SectionHeader } from "../section-header";

const abilities = [
  {
    tag: "reads",
    icon: ScanEyeIcon,
    lead: "It reads any app.",
    body: "Every control in a window, numbered, from the accessibility tree, in one quick read. A control keeps its number from one read to the next.",
  },
  {
    tag: "sees",
    icon: SquareDashedMousePointerIcon,
    lead: "It sees what you see.",
    body: "For apps that draw their own screens, a screenshot with the same numbers boxed on it, and a zoom for the small print.",
  },
  {
    tag: "hands",
    icon: CursorPointer01Icon,
    lead: "Real hands, in plain sight.",
    body: "The real cursor glides, the real keys go in. Touch the mouse and it pauses; press Esc and it stops.",
  },
  {
    tag: "per app",
    icon: ShieldCheckIcon,
    lead: "It asks before each app.",
    body: "Off until you switch it on, then asked per app, with a warning for terminals and password managers. It can never click its own approval cards.",
  },
  {
    tag: "settles",
    icon: Radar01Icon,
    lead: "It knows what changed.",
    body: "After each step it waits for the window to settle, then reads only what changed: the dialog that opened, the value that moved.",
  },
  {
    tag: "input",
    icon: HandGrabIcon,
    lead: "Every kind of input.",
    body: "Click, type, keys and scroll; hover, drag along a path, hold a button or a key, and read the clipboard.",
  },
];

export function ComputerUse() {
  return (
    <Section id="computer-use" label="Computer use">
      <SectionHeader
        eyebrow="computer use."
        title="When there's no API, it uses the app."
        sub="It reads a window the way a screen reader does, numbers every control, and works it with the real mouse and keyboard, where you can watch."
        className="border-b border-line"
      />

      <div className="relative overflow-hidden px-3 py-10 sm:px-8 sm:py-12">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:linear-gradient(to_bottom,transparent,#000_70%)] [background-size:16px_16px]"
        />
        <Reveal y={30} start="top 90%">
          <div data-r>
            <ScreenMock className="relative grid gap-4 xl:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)]" />
          </div>
        </Reveal>
      </div>

      <Reveal draw className="grid gap-px border-t border-line bg-line md:grid-cols-2 lg:grid-cols-3" stagger={0.08}>
        {abilities.map((a) => (
          <article key={a.tag} className="group/c relative bg-bg">
            <div data-r className="flex h-full flex-col gap-8 px-5 py-9 sm:px-10 sm:py-11">
              <div className="flex items-center justify-between">
                <span className="rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-muted">
                  {a.tag}
                </span>
                <span data-draw className="text-subtle transition-colors duration-300 group-hover/c:text-accent">
                  <Icon icon={a.icon} size={26} strokeWidth={1.4} />
                </span>
              </div>
              <h3 className="text-[19px] leading-[1.45] tracking-[-0.015em] text-muted sm:text-[20px]">
                <span className="mr-2 font-mono text-subtle">{"//"}</span>
                <strong className="font-medium text-fg">{a.lead}</strong> {a.body}
              </h3>
            </div>
          </article>
        ))}
      </Reveal>
      <p className="border-t border-line px-5 py-4 text-[13px] text-muted sm:px-10">
        On Windows today: numbered screenshots, reports of what changed, hover, held buttons and keys, and drags along a
        path. macOS has the rest.
      </p>
    </Section>
  );
}
