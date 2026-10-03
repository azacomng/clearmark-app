import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

// Built per request so the URL follows the deployment (CLEARMARK_PUBLIC_URL or Vercel's domain).
export const dynamic = "force-dynamic";

// Only the homepage is public. Dashboards, payment links and receipts belong to people, not search engines.
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/app", "/api", "/pay", "/r"] },
    sitemap: new URL("/sitemap.xml", base).toString(),
  };
}
