import type { ElementType, ReactNode } from "react";

/**
 * The page is drawn as one long blueprint: a centred column with solid side
 * rails, sections stacked inside it, and "gaps" between them where the rails
 * go dashed and a small rounded square marks each place two lines cross.
 * The gutters outside the rails carry the body's dot texture.
 */

export function Container({
  children,
  className = "",
  as: Tag = "div",
}: {
  children?: ReactNode;
  className?: string;
  as?: ElementType;
}) {
  return (
    <Tag className={`relative mx-auto w-[calc(100%-1.5rem)] max-w-[1248px] sm:w-[calc(100%-3rem)] ${className}`}>
      {children}
    </Tag>
  );
}

export function Section({
  children,
  id,
  className = "",
  label,
}: {
  children: ReactNode;
  id?: string;
  className?: string;
  label?: string;
}) {
  return (
    <section id={id} aria-label={label} className="relative">
      <Container className={`border-x border-line bg-bg ${className}`}>{children}</Container>
    </section>
  );
}

export function Corner({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute z-10 size-[17px] rounded-[5px] border border-line bg-bg ${className}`}
    />
  );
}

/**
 * Squares centred on the four places a gap band's lines cross the rails.
 * Rails and lines both sit on the box's outer pixel rows and columns, so a
 * 17px square 8px out on every side is dead centre and meets each line flush.
 */
export function Corners() {
  return (
    <>
      <Corner className="-top-[8px] -left-[8px]" />
      <Corner className="-top-[8px] -right-[8px]" />
      <Corner className="-bottom-[8px] -left-[8px]" />
      <Corner className="-right-[8px] -bottom-[8px]" />
    </>
  );
}

export function Gap({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const h = size === "sm" ? "h-12 sm:h-16" : size === "lg" ? "h-20 sm:h-32" : "h-16 sm:h-[100px]";
  return (
    <div aria-hidden="true" className={`relative ${h}`}>
      {/* Dashed across the gutters; the frame below draws them solid over its width. */}
      <span className="dash-x absolute inset-x-0 top-0 h-px" />
      <span className="dash-x absolute inset-x-0 bottom-0 h-px" />
      <Container className="h-full border-y border-line bg-bg">
        <span className="dash-y absolute inset-y-0 left-0 w-px" />
        <span className="dash-y absolute inset-y-0 right-0 w-px" />
        <Corners />
      </Container>
    </div>
  );
}

/** A dashed callout with accent corner marks. */
export function Callout({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`bracket ${className}`}>
      <span aria-hidden="true" className="bracket-c" />
      <span aria-hidden="true" className="bracket-c" />
      <span aria-hidden="true" className="bracket-c" />
      <span aria-hidden="true" className="bracket-c" />
      {children}
    </div>
  );
}

/**
 * Two dotted strips running down the outside of the rails, each closed off
 * by a dashed line. Sits behind the page's sections; hidden on phones, where
 * the gutters are too narrow to carry it.
 */
export function Strips() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 hidden sm:block">
      <div className="relative mx-auto h-full w-[calc(100%-3rem)] max-w-[1248px]">
        <div className="dot-strip absolute inset-y-0 right-full w-24">
          <span className="dash-y absolute inset-y-0 left-0 w-px" />
        </div>
        <div className="dot-strip absolute inset-y-0 left-full w-24">
          <span className="dash-y absolute inset-y-0 right-0 w-px" />
        </div>
      </div>
    </div>
  );
}
