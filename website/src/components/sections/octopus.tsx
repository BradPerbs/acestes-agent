import { HomeMock } from "../home-mock";
import { Section } from "../frame";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

/**
 * Octopus mode, on Home: one box, any agent. The replica plays it the way the
 * app does it, three prompts to three agents, each in a tab behind Home.
 */
export function Octopus() {
  return (
    <Section id="octopus" label="Octopus mode">
      <SectionHeader
        eyebrow="home, octopus mode."
        title="One prompt box. Every agent."
        sub="Turn on octopus mode and each prompt goes to the agent you pick, in a tab of its own behind Home, so the next one can go straight out. Switch agents with the arrows or Alt+← and Alt+→."
        className="pb-12 sm:pb-14"
      />

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
            <HomeMock />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
