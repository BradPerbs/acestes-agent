const repo = "https://github.com/BradPerbs/acestes-agent";

export const site = {
  name: "Acestes Agent",
  tagline: "Every agent. Every account. One app.",
  description:
    "Acestes runs Claude Code, Codex, Cursor and ten more coding agents side by side, on all your accounts, in one desktop app. It remembers how you work, drives your desktop apps and opens shells on your servers.",
  // The latest release at build time, filled in by next.config.ts.
  // <AppVersion /> refreshes it in the browser if a newer one is out.
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "",
  released: process.env.NEXT_PUBLIC_APP_RELEASED ?? "",
  repo,
  releases: `${repo}/releases`,
  latest: `${repo}/releases/latest`,
  issues: `${repo}/issues`,
  roadmap: `${repo}/blob/main/ROADMAP.md`,
  license: `${repo}/blob/main/LICENSE`,
  notices: `${repo}/blob/main/THIRD-PARTY-NOTICES.md`,
  feed: `${repo}/releases.atom`,
  cloudterm: "https://github.com/BradPerbs/cloudterm",
} as const;

export const siteUrl = (() => {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") return "https://tryacestes.com";
  return "http://localhost:3000";
})();

export type OS = "windows" | "mac" | "linux";

export type Build = {
  os: OS;
  system: string;
  detail: string;
  file: string;
};

export const builds: Build[] = [
  { os: "windows", system: "Windows", detail: "Installer", file: "AcestesAgent-Setup-x64.exe" },
  { os: "windows", system: "Windows", detail: "Portable", file: "AcestesAgent-x64.exe" },
  { os: "mac", system: "macOS", detail: "Apple silicon", file: "AcestesAgent-arm64.dmg" },
  { os: "mac", system: "macOS", detail: "Intel", file: "AcestesAgent-x64.dmg" },
  { os: "linux", system: "Linux", detail: "AppImage", file: "AcestesAgent-x86_64.AppImage" },
];

export const downloadUrl = (file: string) => `${repo}/releases/latest/download/${file}`;

/** The build we offer first for each system. */
export const primaryBuild: Record<OS, Build> = {
  windows: builds[0],
  mac: builds[2],
  linux: builds[4],
};

export const osLabel: Record<OS, string> = {
  windows: "Windows",
  mac: "macOS",
  linux: "Linux",
};
