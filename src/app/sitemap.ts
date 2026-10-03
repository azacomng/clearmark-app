import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

// Built per request so the URL follows the deployment (CLEARMARK_PUBLIC_URL or Vercel's domain).
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: siteUrl().toString(), changeFrequency: "weekly", priority: 1 }];
}
