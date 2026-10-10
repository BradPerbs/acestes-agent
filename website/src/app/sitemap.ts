import type { MetadataRoute } from "next";
import { site, siteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, lastModified: new Date(`${site.released}T00:00:00Z`), changeFrequency: "weekly", priority: 1 },
  ];
}

export const dynamic = "force-static";
