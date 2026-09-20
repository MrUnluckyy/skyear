import type { MetadataRoute } from "next";

/** Only the public pages. /devices and /login are per-account and pointless to index. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: "https://skyear.lt/", lastModified: now, priority: 1 },
    { url: "https://skyear.lt/join", lastModified: now, priority: 0.9 },
    { url: "https://skyear.lt/reading", lastModified: now, priority: 0.7 },
    { url: "https://skyear.lt/privacy", lastModified: now, priority: 0.3 },
  ];
}
