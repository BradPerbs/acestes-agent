import { AppMock } from "../app-mock";
import { DownloadButton } from "../download-button";
import { Section } from "../frame";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

export function Desktop() {
  return (
    <Section id="desktop" label="Desktop app">
      <SectionHeader
        eyebrow="acestes desktop app"
        title="Work with your agent, not around it."
        sub="Review its diffs, approve its commands, open shells beside it and keep its memory, all in one workspace."
        className="pb-12 sm:pb-14"
      >
        <DownloadButton />
      </SectionHeader>

      <div className="relative overflow-hidden px-3 pt-16 pb-10 sm:px-10 sm:pb-14">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[-120px] left-1/2 h-[360px] w-[85%] -translate-x-1/2 rounded-full bg-black/[0.07] blur-[110px] dark:bg-white/[0.06]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:linear-gradient(to_bottom,transparent,#000_60%)] [background-size:16px_16px]"
        />
        <Reveal y={40} start="top 90%">
          <div data-r className="relative mx-auto max-w-[1000px]">
            <AppMock />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
