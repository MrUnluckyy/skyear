import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/devices", "/login", "/auth/"] },
    sitemap: "https://skyear.lt/sitemap.xml",
  };
}
