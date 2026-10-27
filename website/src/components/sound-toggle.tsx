"use client";

import { useSyncExternalStore } from "react";
import { sound } from "@/lib/sound";

const subscribe = (fn: () => void) => {
  const off = sound.subscribe(fn);
  return () => void off();
};

/** Whether the site's sound is on. Off on the server and until the visitor turns it on. */
export function useSoundOn() {
  return useSyncExternalStore(
    subscribe,
    () => sound.enabled,
    () => false,
  );
}

/** Four bars that dance while the sound is on and lie flat while it is off. */
function Bars({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" data-on={on ? "" : undefined} className="sound-bars flex h-3.5 items-end gap-[2px]">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * Sound on and off. `icon` is the header's round button; `label` is the
 * mono caption the hero carries in its corner.
 */
export function SoundToggle({ variant = "icon", className = "" }: { variant?: "icon" | "label"; className?: string }) {
  const on = useSoundOn();
  const label = on ? "Turn sound off" : "Turn sound on";

  if (variant === "label") {
    return (
      <button
        type="button"
        data-sound-skip
        aria-pressed={on}
        aria-label={label}
        onClick={() => sound.toggle()}
        className={`flex items-center gap-2 transition-colors hover:text-white ${className}`}
      >
        <Bars on={on} />
        <span>sound {on ? "on" : "off"}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-sound-skip
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => sound.toggle()}
      className={`relative grid size-9 place-items-center rounded-full transition-colors hover:bg-panel-2 hover:text-fg ${
        on ? "text-fg" : "text-muted"
      } ${className}`}
    >
      <Bars on={on} />
    </button>
  );
}
