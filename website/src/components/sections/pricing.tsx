import { AppVersion } from "@/components/app-version";
import { Download04Icon, PiIcon } from "@hugeicons/core-free-icons";
import { builds, downloadUrl, site } from "@/lib/site";
import { DownloadButton } from "../download-button";
import { Section } from "../frame";
import { BrandIcon, Icon } from "../icon";
import { OSIcon } from "../os-icons";
import { Reveal } from "../reveal";
import { runtimes } from "./runtimes";
import { Succession } from "./succession";

export function Pricing() {
  return (
    <Section id="download" label="Pricing and downloads">
      <div className="grid lg:grid-cols-2">
        {/* Left: the pitch */}
        <Reveal className="flex flex-col justify-between gap-10 border-b border-line px-5 py-12 sm:px-12 sm:py-16 lg:border-r lg:border-b-0">
          <h2 data-r className="text-[44px] leading-[0.98] font-medium tracking-[-0.04em] sm:text-[54px]">
            Free.
            <br />
            <span className="text-muted">Bring your own agent.</span>
          </h2>
          <ul data-r className="flex flex-wrap gap-2" aria-label="Supported runtimes">
            {runtimes.map((r) => (
              <li
                key={r.name}
                className="inline-flex items-center gap-2 rounded-full border border-line py-1.5 pr-3.5 pl-2.5 text-[13px]"
              >
                {r.brand ? (
                  <BrandIcon name={r.brand} size={14} className="shrink-0" />
                ) : (
                  <Icon icon={PiIcon} size={14} strokeWidth={2} className="shrink-0" />
                )}
                {r.name}
              </li>
            ))}
          </ul>
          <p data-r className="max-w-[460px] text-[15px] leading-relaxed text-muted">
            Acestes drives the coding agents already installed and signed in on your machine. No new subscription, no
            key to paste. One runtime can hold several accounts, and the status bar shows each plan&apos;s limits.
          </p>
        </Reveal>

        {/* Right: price card + every build */}
        <div className="flex flex-col">
          <Reveal className="relative z-10 border-b border-line px-5 py-12 sm:px-12">
            <div className="relative">
              <p data-r className="font-mono text-[12px] tracking-[0.2em] text-accent uppercase">
                Acestes Agent
              </p>
              <p data-r className="mt-4 flex items-baseline gap-2">
                <span className="text-[64px] leading-none font-medium tracking-[-0.04em]">$0</span>
                <span className="text-[17px] text-muted">/ forever</span>
              </p>
              <p data-r className="mt-3 text-[16px] text-muted">
                Free to use and modify.{" "}
                <a
                  href={site.license}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg"
                >
                  Fair-code licensed
                </a>
                .
              </p>
              <div data-r className="mt-8">
                <DownloadButton other={false} />
              </div>
            </div>
          </Reveal>

          <div className="flex flex-1 flex-col">
            <div className="flex items-center justify-between px-5 py-5 sm:px-12">
              <h3 className="text-[17px] font-medium tracking-[-0.01em]">Every build.</h3>
              <a
                href={site.releases}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-muted hover:text-fg"
              >
                v<AppVersion /> · all releases ↗
              </a>
            </div>
            <ul className="border-t border-line">
              {builds.map((b) => (
                <li key={b.file} className="border-b border-line last:border-b-0">
                  <a
                    href={downloadUrl(b.file)}
                    className="group/b flex items-center gap-4 px-5 py-4 transition-colors hover:bg-panel sm:px-12"
                  >
                    <OSIcon os={b.os} size={16} className="text-muted group-hover/b:text-fg" />
                    <span className="flex-1">
                      <span className="text-[15px] font-medium">{b.system}</span>{" "}
                      <span className="text-[15px] text-muted">· {b.detail}</span>
                    </span>
                    <span className="hidden font-mono text-[12px] text-subtle sm:inline">{b.file}</span>
                    <Icon
                      icon={Download04Icon}
                      size={16}
                      className="text-subtle transition-transform group-hover/b:translate-y-0.5 group-hover/b:text-fg"
                    />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <Succession />
    </Section>
  );
}
