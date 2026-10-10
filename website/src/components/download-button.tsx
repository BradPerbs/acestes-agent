"use client";

import { AppVersion } from "@/components/app-version";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowDown01Icon, Download04Icon } from "@hugeicons/core-free-icons";
import { builds, downloadUrl, osLabel, primaryBuild, site } from "@/lib/site";
import { useOS } from "@/lib/use-client-info";
import { gsap, useGSAP } from "@/lib/gsap";
import { Icon } from "./icon";
import { OSIcon } from "./os-icons";

const MENU_W = 300;
const MENU_H = 380;

/**
 * The download control: one pill that fetches the build for the visitor's
 * system, and a quiet "Other platforms" link that opens every build. Without
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
        { autoAlpha: 0, y: up ? 6 : -6, scale: 0.98 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: "power3.out" },
      );
      gsap.fromTo(
        menu.current.querySelectorAll("[role=menuitem]"),
        { autoAlpha: 0, x: -4 },
        { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.035, delay: 0.04 },
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
        className={`inline-flex items-center rounded-full font-medium tracking-[-0.01em] transition-colors duration-200 active:scale-[0.985] ${pill} ${skin}`}
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
          <Icon
            icon={ArrowDown01Icon}
            size={15}
            strokeWidth={2}
            className={`transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          />
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Downloads"
            style={{ ...pos, width: MENU_W }}
            className="invisible fixed z-[60] overflow-hidden rounded-2xl border border-line bg-bg p-1.5 text-fg shadow-[0_24px_60px_-20px_rgb(0_0_0/0.45)]"
          >
            {builds.map((b) => (
              <a
                key={b.file}
                role="menuitem"
                href={downloadUrl(b.file)}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors outline-none hover:bg-panel-2 focus-visible:bg-panel-2"
              >
                <span className="grid size-8 place-items-center rounded-lg border border-line text-muted">
                  <OSIcon os={b.os} size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] leading-tight font-medium">
                    {b.system} <span className="font-normal text-muted">· {b.detail}</span>
                  </span>
                  <span className="block truncate font-mono text-[11px] text-subtle">{b.file}</span>
                </span>
              </a>
            ))}
            <div role="separator" className="mx-2 my-1 h-px bg-line" />
            <a
              role="menuitem"
              href={site.releases}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-xl px-3 py-2.5 text-[13px] text-muted transition-colors outline-none hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2 focus-visible:text-fg"
            >
              All releases
              <span className="font-mono text-[11px]">
                v<AppVersion />
              </span>
            </a>
          </div>,
          document.body,
        )}
    </div>
  );
}
