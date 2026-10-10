import type { CSSProperties } from "react";

const mask = (src: string): CSSProperties => ({
  maskImage: `url(${src})`,
  WebkitMaskImage: `url(${src})`,
});

/** The blackletter "Acestes" wordmark, painted in currentColor. */
export function Wordmark({ height = 22, className = "" }: { height?: number; className?: string }) {
  return (
    <span
      role="img"
      aria-label="Acestes"
      className={`inline-block shrink-0 mask-brand ${className}`}
      style={{ ...mask("/brand/wordmark.png"), height, aspectRatio: "880 / 226" }}
    />
  );
}

/** The "A" app mark in its rounded tile, inverted per theme. */
export function Mark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-grid shrink-0 place-items-center bg-fg text-bg ${className}`}
      style={{ width: size, height: size, borderRadius: size * 0.27 }}
    >
      <span
        className="block mask-brand"
        style={{ ...mask("/brand/mark.png"), height: size * 0.56, aspectRatio: "352 / 406" }}
      />
    </span>
  );
}

/** The Corinthian helmet every agent wears, tinted by colour. */
export function Helmet({
  size = 32,
  color,
  className = "",
  label,
}: {
  size?: number;
  color?: string;
  className?: string;
  label?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-block shrink-0 mask-brand ${className}`}
      style={{ ...mask("/brand/helmet.png"), width: size, height: size, color }}
    />
  );
}
