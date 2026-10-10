"use client";

import { useEffect, useRef, useState } from "react";
import { Cancel01Icon, Menu01Icon } from "@hugeicons/core-free-icons";
import { site } from "@/lib/site";
import { gsap, useGSAP } from "@/lib/gsap";
import { Mark, Wordmark } from "./brand";
import { BrandIcon, Icon } from "./icon";
import { ThemeToggle } from "./theme-toggle";
import { buttonClass } from "./ui";

const links = [
  { href: "#features", label: "Features" },
  { href: "#runtimes", label: "Runtimes" },
  { href: "#desktop", label: "Desktop" },
  { href: "#download", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
  { href: site.releases, label: "Changelog", external: true },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  useGSAP(
    () => {
      if (!open || !panel.current) return;
      gsap.fromTo(panel.current, { height: 0 }, { height: "auto", duration: 0.5, ease: "expo.out" });
      gsap.fromTo(
        panel.current.querySelectorAll("a"),
        { autoAlpha: 0, y: -8 },
        { autoAlpha: 1, y: 0, stagger: 0.04, duration: 0.4, delay: 0.05 },
      );
    },
    { dependencies: [open], scope: header },
  );

  return (
    <header ref={header} className="sticky top-0 z-50 border-b border-line bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 w-[calc(100%-1.5rem)] max-w-[1296px] items-center justify-between gap-4 sm:w-[calc(100%-3rem)] md:h-[76px]">
        <a href="#top" aria-label="Acestes Agent, back to top" className="flex items-center gap-2.5 rounded-lg">
          <Mark size={28} />
          <Wordmark height={21} className="translate-y-[1px]" />
        </a>

        <nav aria-label="Main" className="hidden items-center lg:flex">
          <ul className="flex items-center gap-1">
            {links.map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className="rounded-full px-3.5 py-2 text-[15px] text-muted transition-colors hover:text-fg"
                >
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex items-center gap-1.5">
          <a
            href={site.repo}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Acestes Agent on GitHub"
            className="hidden size-9 place-items-center rounded-full text-muted transition-colors hover:bg-panel-2 hover:text-fg sm:grid"
          >
            <BrandIcon name="github" size={18} />
          </a>
          <ThemeToggle />
          <a href="#download" className={`${buttonClass("solid", "sm")} ml-1.5`}>
            Download
          </a>
          <button
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
            className="grid size-9 place-items-center rounded-full text-fg transition-colors hover:bg-panel-2 lg:hidden"
          >
            <Icon icon={open ? Cancel01Icon : Menu01Icon} size={20} />
          </button>
        </div>
      </div>

      {open && (
        <div ref={panel} id="mobile-nav" className="overflow-hidden border-t border-line lg:hidden">
          <nav aria-label="Mobile" className="mx-auto w-[calc(100%-1.5rem)] py-2 sm:w-[calc(100%-3rem)]">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                onClick={() => setOpen(false)}
                {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                className="flex items-center justify-between border-b border-line py-3.5 text-[17px] last:border-0"
              >
                {l.label}
                <span className="font-mono text-[11px] text-subtle">{l.external ? "↗" : "#"}</span>
              </a>
            ))}
            <a href="#download" onClick={() => setOpen(false)} className={`${buttonClass("solid", "md")} my-3 w-full`}>
              Download Acestes
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
