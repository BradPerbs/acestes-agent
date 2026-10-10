import type { OS } from "@/lib/site";
import { BrandIcon } from "./icon";

/** The real marks: the Windows logo, the Apple logo and Tux (simple-icons). */
const MARK = { windows: "windows", mac: "apple", linux: "linux" } as const;

/**
 * Apple's and Tux's artwork sit a touch smaller in their box than the
 * Windows squares, so they get a little more room to look the same size.
 */
const OPTICAL = { windows: 0.9, mac: 1.05, linux: 1.1 } as const;

export function OSIcon({ os, size = 15, className }: { os: OS; size?: number; className?: string }) {
  return <BrandIcon name={MARK[os]} size={Math.round(size * OPTICAL[os])} className={className} />;
}
