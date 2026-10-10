"use client";

import { useTheme } from "next-themes";
import { ComputerIcon, Moon02Icon, Sun03Icon } from "@hugeicons/core-free-icons";
import { useMounted } from "@/lib/use-client-info";
import { Icon } from "./icon";

/** One-tap light/dark flip. Both icons render; CSS shows the right one, so no hydration flicker. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      type="button"
      aria-label="Toggle dark mode"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className={`relative grid size-9 place-items-center rounded-full text-muted transition-colors hover:bg-panel-2 hover:text-fg ${className}`}
    >
      <Icon icon={Sun03Icon} size={18} className="hidden dark:block" />
      <Icon icon={Moon02Icon} size={18} className="block dark:hidden" />
    </button>
  );
}

const options = [
  { value: "system", label: "System", icon: ComputerIcon },
  { value: "light", label: "Light", icon: Sun03Icon },
  { value: "dark", label: "Dark", icon: Moon02Icon },
] as const;

/** System / Light / Dark segmented switch for the footer. */
export function ThemeSwitch() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-full border border-line p-0.5"
    >
      {options.map((o) => {
        const active = mounted && theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={o.label}
            title={o.label}
            onClick={() => setTheme(o.value)}
            className={`grid size-7 place-items-center rounded-full transition-colors ${
              active ? "bg-panel-2 text-fg" : "text-subtle hover:text-fg"
            }`}
          >
            <Icon icon={o.icon} size={15} />
          </button>
        );
      })}
    </div>
  );
}
