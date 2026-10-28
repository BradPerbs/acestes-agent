import { HomeMock } from "../home-mock";
import { Section } from "../frame";
import { Reveal } from "../reveal";
import { SectionHeader } from "../section-header";

/**
 * Home, the one prompt box: the replica sends three prompts to three agents,
 * each in a tab behind Home, and each job opens beside the window where it
 * runs: a shell on a server, the mouse and keyboard on another computer, a
 * read-only check across the fleet.
 */
export function Octopus() {
  return (
    <Section id="octopus" label="One prompt box">
      <SectionHeader
        eyebrow="home."
        title={
          <>
            One prompt box.
            <br />
            Any machine, any agent.
          </>
        }
        sub="Say what you need and it goes where the work lives: a shell on your servers, the mouse and keyboard on another computer, a check across the fleet. Octopus mode sends each to any agent, in its own tab."
        className="pb-12 sm:pb-14"
      />

      <div className="relative overflow-hidden px-3 pt-6 pb-10 sm:px-10 sm:pt-8 sm:pb-14">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-[-120px] left-1/2 h-[360px] w-[85%] -translate-x-1/2 rounded-full bg-black/[0.07] blur-[110px] dark:bg-white/[0.06]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 [background-image:radial-gradient(var(--dot)_1px,transparent_1.4px)] [mask-image:linear-gradient(to_bottom,transparent,#000_60%)] [background-size:16px_16px]"
        />
        <Reveal y={40} start="top 90%">
          <div data-r className="relative mx-auto max-w-[1250px]">
            <HomeMock />
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
