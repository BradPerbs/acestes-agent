import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { brandPaths, evenOdd, type BrandName } from "@/lib/brand-paths";

type IconProps = {
  icon: IconSvgElement;
  size?: number;
  strokeWidth?: number;
  className?: string;
};

/** Hugeicons, decorative by default. */
export function Icon({ icon, size = 18, strokeWidth = 1.6, className }: IconProps) {
  return (
    <HugeiconsIcon
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden="true"
      focusable="false"
    />
  );
}

/** Single-path brand marks (simple-icons), filled with currentColor. */
export function BrandIcon({ name, size = 18, className }: { name: BrandName; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={brandPaths[name]} fillRule={evenOdd.has(name) ? "evenodd" : undefined} />
    </svg>
  );
}
