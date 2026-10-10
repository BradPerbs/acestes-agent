import { site } from "@/lib/site";
import { Helmet } from "../brand";
import { BlockGrid, type Block } from "../block-grid";
import { DownloadButton } from "../download-button";
import { Container } from "../frame";
import { Reveal } from "../reveal";
import { ButtonLink } from "../ui";

// Ten columns by seven rows; the panel covers columns 3-8, rows 2-6.
const blocks: Block[] = [
  { col: 1, row: 1, span: 2 },
  { col: 5, row: 1, span: 2, angle: 270 },
  { col: 9, row: 1, span: 2, angle: 270 },
  { col: 2, row: 2 },
  { col: 9, row: 2 },
  { col: 1, row: 3, span: 2 },
  { col: 10, row: 3, angle: 270 },
  { col: 1, row: 4 },
  { col: 9, row: 4, span: 2, angle: 270 },
  { col: 2, row: 5 },
  { col: 10, row: 5 },
  { col: 1, row: 6, span: 2 },
  { col: 9, row: 6, angle: 270 },
  { col: 1, row: 7 },
  { col: 3, row: 7, span: 3 },
  { col: 9, row: 7, span: 2, angle: 270 },
];

const crew = ["#8b7cf6", "#22c39a", "#f2a33a", "#ef6b73", "#4fb3f6"];

export function Cta() {
  return (
    <section aria-labelledby="cta-title" className="relative">
      <Container className="border-x border-line">
        <div data-glow-area className="relative">
          <BlockGrid cols={10} rows={7} blocks={blocks} tone="mono" className="absolute inset-0 hidden md:grid" />
          <div className="relative md:grid md:grid-cols-10 md:grid-rows-[repeat(7,88px)]">
            <Reveal className="relative z-10 flex flex-col items-center justify-center bg-bg px-5 py-16 text-center md:col-span-6 md:col-start-3 md:row-span-5 md:row-start-2 md:border md:border-line md:py-8">
              <div data-r className="flex items-center">
                {crew.map((c, i) => (
                  <span
                    key={c}
                    className="-ml-2.5 grid size-10 place-items-center rounded-full border-2 border-bg bg-panel-2 first:ml-0"
                    style={{ zIndex: crew.length - i }}
                  >
                    <Helmet size={24} color={c} />
                  </span>
                ))}
                <span className="-ml-2.5 grid h-10 place-items-center rounded-full border-2 border-bg bg-panel-2 px-3 font-mono text-[12px] text-muted">
                  + yours
                </span>
              </div>
              <h2
                id="cta-title"
                data-r
                className="mt-7 max-w-[560px] text-[34px] leading-[1.05] font-medium tracking-[-0.035em] sm:text-[44px]"
              >
                Ready to put Acestes on guard? <span className="text-muted">Hand it the next audit.</span>
              </h2>
              <p data-r className="mt-5 max-w-[520px] text-[16px] leading-relaxed text-muted">
                Download it, point it at your servers and the apps you work in, and it will be there tomorrow knowing
                what happened today.
              </p>
              <div data-r className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <DownloadButton other={false} />
                <ButtonLink href={site.repo} external variant="outline" size="lg">
                  Star on GitHub
                </ButtonLink>
              </div>
              <p data-r className="mt-6 font-mono text-[11px] tracking-[0.22em] text-subtle uppercase">
                Free · Windows · macOS · Linux · Fair-code
              </p>
            </Reveal>
          </div>
        </div>
      </Container>
    </section>
  );
}
