import type { BrandName } from "@/lib/brand-paths";
import type { CrestId, HelmetId } from "@/lib/helmet/renderer";
import { Section } from "../frame";
import { BrandIcon } from "../icon";
import { LiveHelmet } from "../live-helmet";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

type Agent = {
  name: string;
  role: string;
  /** The look an agent stores in the app (lib/agent-look.js). */
  helmet: HelmetId;
  crest: CrestId;
  /** agentInk() for its colour: the line in light mode and in dark. */
  line: string;
  lineDark: string;
  runtime: string;
  brand: BrandName;
  approval: string;
  kit: string;
  notes: string;
};

const agents: Agent[] = [
  {
    name: "Ace",
    role: "incident response",
    helmet: "corinthian",
    crest: "plume",
    line: "#7C3AED", // violet
    lineDark: "#a375f2",
    runtime: "Claude Code",
    brand: "claude",
    approval: "Asks for changes",
    kit: "14 hosts · 3 keys · github, grafana",
    notes: "128 notes",
  },
  {
    name: "Palinurus",
    role: "homelab",
    helmet: "barbute",
    crest: "none",
    line: "#059669", // emerald
    lineDark: "#50b696",
    runtime: "Codex",
    brand: "openai",
    approval: "Never asks",
    kit: "4 hosts · proxmox · ~/infra",
    notes: "57 notes",
  },
  {
    name: "Achates",
    role: "read-only auditor",
    helmet: "viking",
    crest: "horns",
    line: "#D97706", // amber
    lineDark: "#e4a051",
    runtime: "Local model",
    brand: "ollama",
    approval: "Reads and reports",
    kit: "20 hosts · no write access",
    notes: "33 notes",
  },
];

export function Team() {
  return (
    <Section id="team" label="A team of agents">
      <SectionHeader
        eyebrow="a team of them."
        title="One for incidents. One for the homelab. One that only reads."
        sub="Each has its own name, helmet, colour, memory, inventory and rules, and runs on whichever model you give it."
        className="border-b border-line"
      />
      <Reveal className="grid gap-px bg-line md:grid-cols-3" stagger={0.1} y={24}>
        {agents.map((a, i) => (
          <article key={a.name} className="group/a relative overflow-hidden bg-bg">
            <div data-r>
              {/* The stage: the agent's own helmet, drawn live, looking at you */}
              <div className="relative flex h-[230px] items-center justify-center overflow-hidden border-b border-line">
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:radial-gradient(closest-side,#000,transparent)] [background-size:14px_14px]"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-1/2 size-56 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.14] blur-3xl transition-opacity duration-500 group-hover/a:opacity-30"
                  style={{ background: a.line }}
                />
                <LiveHelmet
                  helmet={a.helmet}
                  crest={a.crest}
                  line={a.line}
                  lineDark={a.lineDark}
                  size={148}
                  delay={0.15 + i * 0.18}
                  className="relative"
                />
                <span className="absolute top-4 right-4 rounded-full border border-line bg-bg/80 px-2.5 py-1 font-mono text-[11px] text-muted backdrop-blur">
                  {a.role}
                </span>
              </div>

              <div className="px-6 pt-6 pb-8 sm:px-8">
                <h3 className="flex items-center gap-2.5 text-[24px] font-medium tracking-[-0.02em]">
                  <span className="size-2 rounded-full" style={{ background: a.line }} />
                  {a.name}
                </h3>
                <dl className="mt-5 divide-y divide-line border-y border-line text-[13.5px]">
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-muted">Runtime</dt>
                    <dd className="flex items-center gap-1.5">
                      <BrandIcon name={a.brand} size={13} />
                      {a.runtime}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-muted">Approval</dt>
                    <dd>{a.approval}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-muted">Inventory</dt>
                    <dd className="truncate text-right">{a.kit}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 py-2.5">
                    <dt className="text-muted">Memory</dt>
                    <dd>{a.notes}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </article>
        ))}
      </Reveal>
    </Section>
  );
}
