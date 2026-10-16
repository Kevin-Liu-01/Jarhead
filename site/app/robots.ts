import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/metadata";

/** /robots.txt: everything public may be crawled, and the sitemap names the one page. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
