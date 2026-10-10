import {
  AiBrowserIcon,
  AiNetworkIcon,
  CalendarClockIcon,
  ChartLineData01Icon,
  FlowConnectionIcon,
  McpServerIcon,
  RefreshCwIcon,
  UserSwitchIcon,
} from "@hugeicons/core-free-icons";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

const parts = [
  {
    icon: FlowConnectionIcon,
    tool: "fan_out",
    title: "Across the fleet",
    body: "One check on forty hosts at once, answers side by side.",
  },
  {
    icon: CalendarClockIcon,
    tool: "schedule_job",
    title: "On a schedule",
    body: "Jobs on a timer, a webhook or a host going down.",
  },
  {
    icon: ChartLineData01Icon,
    tool: "watch_metric",
    title: "Live charts",
    body: "Any command's numbers, charted in the chat as they arrive.",
  },
  {
    icon: AiNetworkIcon,
    tool: "delegate",
    title: "Other agents",
    body: "Hands a task to another agent, on any model, in a tab of its own.",
  },
  {
    icon: RefreshCwIcon,
    tool: "failover",
    title: "Failover",
    body: "Restarts after a crash or a hang and carries on the turn.",
  },
  {
    icon: McpServerIcon,
    tool: "mcp",
    title: "Your other tools",
    body: "GitHub, Grafana, Kubernetes and databases, one switch each.",
  },
  {
    icon: AiBrowserIcon,
    tool: "browser",
    title: "A real browser",
    body: "Pages, logins and dashboards, worked like a person would.",
  },
  {
    icon: UserSwitchIcon,
    tool: "accounts",
    title: "Several accounts",
    body: "More than one account per runtime, each plan's limits in view.",
  },
];

export function Advanced() {
  return (
    <Section id="advanced" label="Advanced">
      <SectionHeader
        eyebrow="beyond a chat window."
        title="The advanced parts, built in."
        sub="Fleets, schedules, live numbers, other agents and the rest of your tools, all from the same conversation."
        className="border-b border-line"
      />
      <Reveal
        draw
        className="grid grid-cols-2 gap-px bg-line lg:grid-cols-4"
        stagger={{ each: 0.05, grid: "auto", from: "start" }}
      >
        {parts.map((p) => (
          <div key={p.tool} className="group/a bg-bg">
            <div data-r className="flex h-full min-h-[190px] flex-col justify-between gap-6 px-5 py-7 sm:px-8">
              <div className="flex items-center justify-between gap-3">
                <span data-draw className="text-muted transition-colors duration-300 group-hover/a:text-accent">
                  <Icon icon={p.icon} size={24} strokeWidth={1.4} />
                </span>
                <code className="truncate font-mono text-[11.5px] text-subtle">{p.tool}</code>
              </div>
              <div>
                <h3 className="text-[16px] font-medium tracking-[-0.01em]">{p.title}</h3>
                <p className="mt-1 text-[14px] leading-snug text-muted">{p.body}</p>
              </div>
            </div>
          </div>
        ))}
      </Reveal>
    </Section>
  );
}
