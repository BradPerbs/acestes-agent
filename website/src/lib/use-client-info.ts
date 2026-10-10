"use client";

import { useSyncExternalStore } from "react";
import type { OS } from "./site";

const noop = () => () => {};

function detectOS(): OS | null {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const ua = nav.userAgent.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(ua)) return null;
  const platform = (nav.userAgentData?.platform || nav.platform || "").toLowerCase();
  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (platform.includes("mac") || ua.includes("mac os")) return "mac";
  if (platform.includes("linux") || ua.includes("linux") || ua.includes("x11")) return "linux";
  return null;
}

/** The visitor's desktop OS, or null on the server, on phones, or when unknown. */
export function useOS(): OS | null {
  return useSyncExternalStore(noop, detectOS, () => null);
}

/** True once hydrated; lets client-only UI render without a mismatch. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
