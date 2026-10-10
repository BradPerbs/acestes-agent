import type { ReactNode } from "react";

export type TermLine =
  | { k: "cmd"; t: string }
  | { k: "out"; t: string }
  | { k: "ok"; t: string }
  | { k: "bad"; t: string }
  | { k: "info"; t: string }
  | { k: "tag"; tag: string; t: string; tone?: "ok" | "accent" | "bad" | "warn" }
  | { k: "gap" };

export function TermWindow({
  title,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-[10px] bg-term-bg font-mono text-[12px] leading-[1.75] text-term-fg ring-1 ring-black/5 sm:text-[12.5px] dark:ring-white/5 ${className}`}
    >
      <div className="flex items-center gap-2 bg-term-bar/60 px-4 py-2.5">
        <span className="size-[11px] rounded-full bg-[#ff5f57]" />
        <span className="size-[11px] rounded-full bg-[#febc2e]" />
        <span className="size-[11px] rounded-full bg-[#28c840]" />
        <span className="ml-2 truncate text-[11.5px] text-term-muted">{title}</span>
      </div>
      <div className={`px-4 pt-3 pb-5 ${bodyClassName}`}>{children}</div>
    </div>
  );
}

const toneClass = {
  ok: "bg-emerald-400/15 text-emerald-400",
  accent: "bg-violet-400/20 text-violet-300",
  bad: "bg-red-400/15 text-red-400",
  warn: "bg-amber-400/15 text-amber-400",
} as const;

export function TermLines({ lines }: { lines: TermLine[] }) {
  return (
    <>
      {lines.map((l, i) => {
        switch (l.k) {
          case "cmd":
            return (
              <p key={i} data-line className="-mx-2 mb-1 flex gap-2 rounded-[4px] bg-term-hl px-2 py-0.5">
                <span className="text-violet-400">❯</span>
                <span data-cmd className="min-w-0 break-words whitespace-pre-wrap">
                  {l.t}
                </span>
              </p>
            );
          case "ok":
            return (
              <p key={i} data-line className="flex gap-2 text-emerald-400">
                <span>✓</span>
                <span className="min-w-0 whitespace-pre-wrap">{l.t}</span>
              </p>
            );
          case "bad":
            return (
              <p key={i} data-line className="flex gap-2 text-red-400">
                <span>✗</span>
                <span className="min-w-0 whitespace-pre-wrap">{l.t}</span>
              </p>
            );
          case "info":
            return (
              <p key={i} data-line className="flex gap-2">
                <span className="text-violet-400">◆</span>
                <span className="min-w-0 whitespace-pre-wrap">{l.t}</span>
              </p>
            );
          case "tag":
            return (
              <p key={i} data-line className="flex items-baseline gap-2">
                <span
                  className={`shrink-0 rounded-[3px] px-1.5 text-[10px] leading-[1.7] font-medium tracking-wider uppercase ${toneClass[l.tone ?? "ok"]}`}
                >
                  {l.tag}
                </span>
                <span className="min-w-0 whitespace-pre-wrap">{l.t}</span>
              </p>
            );
          case "gap":
            return <p key={i} data-line aria-hidden="true" className="h-2" />;
          default:
            return (
              <p key={i} data-line className="pl-4 whitespace-pre-wrap text-term-muted">
                {l.t}
              </p>
            );
        }
      })}
    </>
  );
}
