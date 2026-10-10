import { AppVersion } from "@/components/app-version";
import { Bug01Icon, Download04Icon, RssIcon } from "@hugeicons/core-free-icons";
import { site } from "@/lib/site";
import { Wordmark } from "./brand";
import { DotWave } from "./dot-wave";
import { Container } from "./frame";
import { BrandIcon, Icon } from "./icon";
import { ThemeSwitch } from "./theme-toggle";

const links = [
  { label: "Features", href: "#features" },
  { label: "Runtimes", href: "#runtimes" },
  { label: "Desktop", href: "#desktop" },
  { label: "Memory", href: "#memory" },
  { label: "Download", href: "#download" },
  { label: "FAQ", href: "#faq" },
  { label: "Changelog", href: site.releases, external: true },
  { label: "Roadmap", href: site.roadmap, external: true },
  { label: "Source", href: site.repo, external: true },
  { label: "License", href: site.license, external: true },
  { label: "Notices", href: site.notices, external: true },
  { label: "CloudTerm", href: site.cloudterm, external: true },
];

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

export function SiteFooter() {
  return (
    <footer aria-label="Footer" className="relative">
      <Container className="border-x border-line">
        <div className="grid border-b border-line lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)_72px]">
          <nav aria-label="Footer" className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                {...(l.external ? ext : {})}
                className="flex min-h-[72px] items-center bg-bg px-6 text-[15px] text-muted transition-colors hover:bg-panel hover:text-fg"
              >
                {l.label}
                {l.external && <span className="ml-1.5 text-[11px] text-subtle">↗</span>}
              </a>
            ))}
          </nav>

          <div className="relative h-[240px] overflow-hidden border-t border-line bg-bg lg:h-auto lg:border-t-0 lg:border-l">
            <DotWave className="absolute inset-0" />
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{ background: "radial-gradient(ellipse 42% 30% at 50% 50%, var(--bg) 40%, transparent 100%)" }}
            />
            <div className="absolute inset-0 grid place-items-center">
              <Wordmark height={52} />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-px border-t border-line bg-line lg:grid-cols-1 lg:border-t-0 lg:border-l">
            {[
              { label: "GitHub", href: site.repo, el: <BrandIcon name="github" size={19} /> },
              { label: "Release feed", href: site.feed, el: <Icon icon={RssIcon} size={19} /> },
              { label: "Report an issue", href: site.issues, el: <Icon icon={Bug01Icon} size={19} /> },
            ].map((s) => (
              <a
                key={s.label}
                href={s.href}
                {...ext}
                aria-label={s.label}
                title={s.label}
                className="grid min-h-[72px] place-items-center bg-bg text-muted transition-colors hover:bg-panel hover:text-fg"
              >
                {s.el}
              </a>
            ))}
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-4 px-6 py-7 text-[13px] text-muted sm:flex-row">
          <p>© {new Date().getFullYear()} Acestes Agent. Fair-code licensed, forked from CloudTerm 1.4.3.</p>
          <div className="flex items-center gap-4">
            <a href={site.latest} {...ext} className="hidden items-center gap-1.5 hover:text-fg sm:flex">
              <Icon icon={Download04Icon} size={14} />v<AppVersion />
            </a>
            <ThemeSwitch />
          </div>
        </div>
      </Container>
    </footer>
  );
}
