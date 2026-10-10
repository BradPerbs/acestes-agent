"use client";

import { useEffect, useState } from "react";
import { site } from "@/lib/site";

const API = "https://api.github.com/repos/BradPerbs/acestes-agent/releases/latest";

// One request per page view, shared by every <AppVersion /> on the page.
let latest: Promise<string | null> | null = null;

function fetchLatest() {
  latest ??= fetch(API, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((r: { tag_name?: string } | null) => r?.tag_name?.replace(/^v/, "") ?? null)
    .catch(() => null);
  return latest;
}

/**
 * The app's latest version. Renders the version from build time, then swaps in
 * a newer one from GitHub if a release went out after the site was built.
 */
export function AppVersion() {
  const [version, setVersion] = useState<string>(site.version);

  useEffect(() => {
    let live = true;
    fetchLatest().then((v) => {
      if (live && v) setVersion(v);
    });
    return () => {
      live = false;
    };
  }, []);

  return <>{version}</>;
}
