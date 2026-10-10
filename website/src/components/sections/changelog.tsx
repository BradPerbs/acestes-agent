import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { site } from "@/lib/site";
import { Section } from "../frame";
import { Icon } from "../icon";
import { Reveal } from "../reveal";
import { Eyebrow } from "../ui";

// From the commits since v1.4.3: Full access mode, and the computer use rebuild.
const entries = [
  { kind: "feat", text: "Computer use reads a window in one call" },
  { kind: "feat", text: "Numbered screenshots, with their read" },
  { kind: "feat", text: "Actions report only what changed" },
  { kind: "feat", text: "Hover, held keys, drag paths, the clipboard" },
  { kind: "feat", text: "Full access mode, one step past Yolo" },
  { kind: "fix", text: "Menu items click by number; long text types whole" },
] as const;

const released = new Date(`${site.released}T12:00:00Z`).toLocaleDateString("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function Changelog() {
  return (
    <Section label="Changelog">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line px-5 py-10 sm:px-10">
        <div>
          <Eyebrow>ship</Eyebrow>
          <h2 className="mt-3 text-[32px] font-medium tracking-[-0.03em] sm:text-[36px]">Changelog</h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-line px-3 py-1 font-mono text-[13px]">v{site.version}</span>
          {site.released && (
            <span className="text-[14px] text-muted">
              Released <time dateTime={site.released}>{released}</time>
            </span>
          )}
        </div>
      </div>
      <a
        href={site.releases}
        target="_blank"
        rel="noopener noreferrer"
        className="group/cl block transition-colors hover:bg-panel"
      >
        <Reveal as="ul" className="grid md:grid-cols-2" stagger={0.05} y={8}>
          {entries.map((e, i) => (
            <li
              key={e.text}
              data-r
              className={`flex items-center gap-4 border-b border-line px-5 py-4 sm:px-10 ${i % 2 === 0 ? "md:border-r" : ""}`}
            >
              <span
                className={`w-11 shrink-0 rounded-[4px] py-0.5 text-center font-mono text-[10.5px] font-semibold tracking-wider uppercase ${
                  e.kind === "feat" ? "bg-accent/12 text-accent" : "bg-ok/12 text-ok"
                }`}
              >
                {e.kind}
              </span>
              <span className="text-[15px]">{e.text}</span>
            </li>
          ))}
        </Reveal>
        <span className="flex items-center gap-2 px-5 py-5 text-[14px] text-muted transition-colors group-hover/cl:text-fg sm:px-10">
          Read the full changelog
          <Icon
            icon={ArrowRight01Icon}
            size={15}
            strokeWidth={2}
            className="transition-transform group-hover/cl:translate-x-0.5"
          />
        </span>
      </a>
    </Section>
  );
}
