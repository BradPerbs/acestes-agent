import type { AnchorHTMLAttributes, ReactNode } from "react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./icon";

type Variant = "solid" | "accent" | "outline" | "ghost";

const variants: Record<Variant, string> = {
  solid: "bg-fg text-bg hover:bg-fg/85",
  accent: "bg-accent-strong text-accent-fg hover:bg-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.18)]",
  outline: "border border-line text-fg hover:border-fg/30 hover:bg-panel-2",
  ghost: "text-muted hover:text-fg",
};

export const buttonClass = (variant: Variant = "solid", size: "sm" | "md" | "lg" = "md") =>
  [
    "group/btn inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium tracking-[-0.01em] transition-[background-color,border-color,color,transform] duration-200 active:scale-[0.98]",
    size === "sm" ? "h-9 px-4 text-sm" : size === "lg" ? "h-12 px-6 text-[17px]" : "h-11 px-5 text-[15px]",
    variants[variant],
  ].join(" ");

export function ButtonLink({
  variant = "solid",
  size = "md",
  arrow,
  external,
  className = "",
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  arrow?: boolean;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      className={`${buttonClass(variant, size)} ${className}`}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...rest}
    >
      {children}
      {arrow && (
        <Icon
          icon={ArrowRight01Icon}
          size={16}
          strokeWidth={2}
          className="-mr-1 transition-transform duration-200 group-hover/btn:translate-x-0.5"
        />
      )}
    </a>
  );
}

/** Small uppercase mono label, the "// community" kind. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p className={`font-mono text-[11px] tracking-[0.22em] text-subtle uppercase ${className}`}>
      <span className="mr-2 text-subtle/70">{"//"}</span>
      {children}
    </p>
  );
}

/** Bracketed mono tag, e.g. [ Input ]. */
export function Bracket({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] tracking-wide text-subtle ${className}`}>[ {children} ]</span>;
}
