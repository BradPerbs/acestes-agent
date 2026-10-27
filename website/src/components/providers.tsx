"use client";

import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { MotionFx } from "./motion-fx";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <MotionFx />
      {children}
    </ThemeProvider>
  );
}
