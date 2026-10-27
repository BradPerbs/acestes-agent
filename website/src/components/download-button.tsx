"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowDown01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import { builds, downloadUrl, osLabel, primaryBuild, site } from "@/lib/site";
import { useOS } from "@/lib/use-client-info";
import { gsap, useGSAP } from "@/lib/gsap";
import { Icon } from "./icon";
import { Turn } from "./motion-fx";
import { OSIcon } from "./os-icons";

const MENU_W = 272;
const MENU_H = 250;

/** The file type, shown at the end of each row: .exe, .dmg, .AppImage. */
const ext = (file: string) => file.slice(file.lastIndexOf("."));

/**
 * The download control: one pill that fetches the build for the visitor's
 * system, and a quiet "Other platforms" link that opens every build: a
 * plain list, one row per download, each complete on its own (system,
 * variant, file type). Without
 * a known OS the pill goes to the latest release page. The menu lives in a
 * portal so no clipped or transformed parent can hide it, and opens upward
 * when there's no room below.
 */
export function DownloadButton({
  size = "lg",
  tone = "accent",
  other = true,
  className = "",
}: {
  size?: "md" | "lg";
  /** light: white pill for dark, coloured backdrops. accent: violet pill. */
  tone?: "accent" | "light";
  /** Show the "Other platforms" menu link beside the pill. */
  other?: boolean;
  className?: string;
}) {
  const os = useOS();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties>({});
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const build = os ? primaryBuild[os] : null;
  const href = build ? downloadUrl(build.file) : site.latest;
  const label = os ? `Download for ${osLabel[os]}` : "Download";

  // Place the menu under (or over) its trigger before it paints.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(r.left + r.width / 2 - MENU_W / 2, window.innerWidth - MENU_W - 12));
    const below = window.innerHeight - r.bottom;
    const up = below < MENU_H + 16 && r.top > below;
    setPos(up ? { left, bottom: window.innerHeight - r.top + 10 } : { left, top: r.bottom + 10 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        trigger.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = [...(menu.current?.querySelectorAll<HTMLAnchorElement>("[role=menuitem]") ?? [])];
        if (!items.length) return;
        e.preventDefault();
        const i = items.indexOf(document.activeElement as HTMLAnchorElement);
        const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
        items[next]?.focus();
      }
      if (e.key === "Tab") close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    // Wait a beat: the menu is invisible until its fade-in starts, and
    // invisible elements can't take focus.
    const t = window.setTimeout(
      () => menu.current?.querySelector<HTMLAnchorElement>("[role=menuitem]")?.focus({ preventScroll: true }),
      60,
    );
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useGSAP(
    () => {
      if (!open || !menu.current) return;
      const up = pos.bottom !== undefined;
      gsap.fromTo(
        menu.current,
        { autoAlpha: 0, y: up ? 4 : -4 },
        { autoAlpha: 1, y: 0, duration: 0.18, ease: "power2.out" },
      );
    },
    { dependencies: [open, pos] },
  );

  const lg = size === "lg";
  const pill = lg ? "h-[52px] gap-3 px-7 text-[16px]" : "h-11 gap-2.5 px-5 text-[15px]";
  const skin =
    tone === "light"
      ? "bg-white text-[#0d0818] hover:bg-white/90"
      : "bg-accent-strong text-white hover:bg-[color-mix(in_oklab,var(--accent-strong)_88%,white)]";
  const quiet = tone === "light" ? "text-white/70 hover:text-white" : "text-muted hover:text-fg";

  return (
    <div className={`inline-flex flex-wrap items-center justify-center gap-x-6 gap-y-3 ${className}`}>
      <a
        href={href}
        data-press
        className={`inline-flex items-center rounded-full font-medium tracking-[-0.01em] transition-colors duration-200 ${pill} ${skin}`}
      >
        {os ? (
          <OSIcon os={os} size={lg ? 19 : 17} className="-ml-0.5" />
        ) : (
          <Icon icon={Download04Icon} size={18} strokeWidth={1.8} className="-ml-0.5" />
        )}
        <span>{label}</span>
      </a>

      {other && (
        <button
          ref={trigger}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex items-center gap-1.5 text-[15px] font-medium transition-colors ${quiet}`}
        >
          Other platforms
          <Turn open={open}>
            <Icon icon={ArrowDown01Icon} size={15} strokeWidth={2} />
          </Turn>
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Other downloads"
            style={{ ...pos, width: MENU_W }}
            className="invisible fixed z-[60] rounded-xl border border-line bg-bg p-1 text-[13.5px] leading-none text-fg"
          >
            {builds.map((b) => (
              <a
                key={b.file}
                role="menuitem"
                href={downloadUrl(b.file)}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 transition-colors outline-none hover:bg-panel-2 focus-visible:bg-panel-2"
              >
                <OSIcon os={b.os} size={14} className="shrink-0 text-muted" />
                <span>
                  {b.system} <span className="text-muted">{b.detail}</span>
                </span>
                <span className="ml-auto font-mono text-[11px] text-subtle">{ext(b.file)}</span>
              </a>
            ))}
            <a
              role="menuitem"
              href={site.releases}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block rounded-md px-2.5 py-2 text-[12px] text-subtle transition-colors outline-none hover:text-fg focus-visible:text-fg"
            >
              All releases ↗
            </a>
          </div>,
          document.body,
        )}
    </div>
  );
}
