"use client";

import { useRef } from "react";
import { gsap, prefersReducedMotion, SplitText, useGSAP } from "@/lib/gsap";
import { Helmet } from "../brand";
import { Callout, Section } from "../frame";
import { Eyebrow } from "../ui";

const text =
  "A host, in the oldest sense of the word: the one whose ground you can return to, who remembers you, and who holds what you leave in his care.";

export function Quote() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const p = root.current?.querySelector<HTMLElement>("[data-quote]");
      if (!p || prefersReducedMotion()) return;
      SplitText.create(p, {
        type: "words",
        autoSplit: true,
        onSplit: (self) =>
          gsap.fromTo(
            self.words,
            { opacity: 0.16 },
            {
              opacity: 1,
              ease: "none",
              stagger: 0.1,
              scrollTrigger: { trigger: p, start: "top 78%", end: "bottom 45%", scrub: 0.6 },
            },
          ),
      });
    },
    { scope: root },
  );

  return (
    <Section label="Why the name Acestes">
      <div className="p-4 sm:p-10 lg:p-14">
        <Callout className="rounded-[2px]">
          <figure ref={root} className="px-5 py-12 sm:px-12 sm:py-16 lg:px-14">
            <Eyebrow>why acestes</Eyebrow>
            <blockquote className="mt-8">
              <p
                data-quote
                className="max-w-[960px] text-[28px] leading-[1.14] font-medium tracking-[-0.035em] sm:text-[40px] lg:text-[46px]"
              >
                <span aria-hidden="true" className="text-subtle">
                  “
                </span>
                {text}
                <span aria-hidden="true" className="text-subtle">
                  ”
                </span>
              </p>
            </blockquote>
            <figcaption className="mt-10 flex items-center gap-4">
              <span className="grid size-12 place-items-center rounded-full border border-line bg-panel">
                <Helmet size={30} className="text-accent" />
              </span>
              <span className="flex flex-col">
                <span className="text-[15px] font-medium">Acestes, king of Sicily</span>
                <span className="text-[14px] text-muted">
                  In the <i>Aeneid</i>, the host who stays. That is what this agent is built to be.
                </span>
              </span>
            </figcaption>
          </figure>
        </Callout>
      </div>
    </Section>
  );
}
