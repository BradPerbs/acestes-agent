import {
  BlockedIcon,
  CheckmarkCircle02Icon,
  EyeIcon,
  FolderSecurityIcon,
  LockPasswordIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

const principles = [
  {
    tag: "in the open",
    icon: EyeIcon,
    lead: "It works where you can see.",
    body: "Edits show as a diff, server commands run in a real terminal in front of you, and on the desktop you watch the real cursor.",
  },
  {
    tag: "approvals",
    icon: CheckmarkCircle02Icon,
    lead: "It asks in the open.",
    body: "Every change waits on a card showing the exact command or diff. Questions come with answers to pick from.",
  },
  {
    tag: "secrets",
    icon: LockPasswordIcon,
    lead: "Secrets go one way.",
    body: "It can store a password or key, but never reads one back. None ever lands in a transcript or a log.",
  },
  {
    tag: "fence",
    icon: FolderSecurityIcon,
    lead: "It stays inside the fence.",
    body: "It only touches the folders you grant it. Turn on the container and the fence becomes a wall.",
  },
  {
    tag: "blocked",
    icon: BlockedIcon,
    lead: "Some commands never run.",
    body: "Whatever is on your blocked list is refused however it's spelled, and no approval lets it through.",
  },
  {
    tag: "agents",
    icon: UserMultiple02Icon,
    lead: "Every agent is its own person.",
    body: "Separate memory, inventory, folders and sessions. One can't reach into another's.",
  },
];

export function Principles() {
  return (
    <Section id="guardrails" label="Guardrails">
      <SectionHeader
        eyebrow="guardrails, built in."
        title="Safe by construction."
        sub="The rules a security team would set are there from the first run, not bolted on afterwards."
        className="border-b border-line"
      />
      <Reveal draw className="grid gap-px bg-line md:grid-cols-2 lg:grid-cols-3" stagger={0.08}>
        {principles.map((p) => (
          <article key={p.tag} className="group/p relative bg-bg">
            <div data-r className="flex h-full flex-col gap-10 px-5 py-10 sm:px-10 sm:py-12">
              <div className="flex items-center justify-between">
                <span className="rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-muted">
                  {p.tag}
                </span>
                <span data-draw className="text-subtle transition-colors duration-300 group-hover/p:text-accent">
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
    </Section>
  );
}
