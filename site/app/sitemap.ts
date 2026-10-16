import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/metadata";

/** /sitemap.xml: the landing page is the site's one public document (`/card` is dev-only, a 404 in production). */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: `${SITE_URL}/` }];
}
