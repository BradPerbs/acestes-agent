import type { NextConfig } from "next";

const REPO = "https://github.com/BradPerbs/acestes-agent";

/**
 * The app's latest release, read from GitHub when the site is built, so the
 * version on the page is never typed by hand. `releases/latest` redirects to
 * the tag GitHub marks as latest; the Atom feed gives its date. Neither is the
 * rate-limited REST API, which shared build machines would exhaust.
 */
async function latestRelease(): Promise<{ version: string; released: string }> {
  const res = await fetch(`${REPO}/releases/latest`, { redirect: "manual" });
  const tag = res.headers.get("location")?.match(/\/releases\/tag\/(v?[^/?#]+)/)?.[1];
  if (!tag) throw new Error(`no latest release at ${REPO} (HTTP ${res.status})`);

  const feed = await (await fetch(`${REPO}/releases.atom`)).text();
  const entry = feed.split("<entry>").find((e) => e.includes(`/releases/tag/${tag}"`));
  const released = entry?.match(/<updated>(\d{4}-\d{2}-\d{2})/)?.[1] ?? "";

  return { version: tag.replace(/^v/, ""), released };
}

export default async function config(): Promise<NextConfig> {
  const release = await latestRelease();
  console.log(`Acestes latest release: v${release.version} (${release.released || "date unknown"})`);

  return {
    // The site lives inside the Electron app's repo, which has its own lockfile.
    // Pin the root so Turbopack doesn't treat the parent repo as the workspace.
    turbopack: { root: process.cwd() },
    // Plain static files in out/, served by Cloudflare Pages.
    output: "export",
    poweredByHeader: false,
    devIndicators: false,
    reactStrictMode: true,
    images: { unoptimized: true },
    env: {
      NEXT_PUBLIC_APP_VERSION: release.version,
      NEXT_PUBLIC_APP_RELEASED: release.released,
    },
  };
}
