import type { MetadataRoute } from "next";
import { DESCRIPTION, SITE_NAME, THEME_COLOR_DARK } from "@/lib/metadata";

/**
 * /manifest.webmanifest. The four large icons are `scripts/make-icons.mts`'s output: the
 * transparent pair for `any`, the pair flattened on ink with the squircle at 80 % for
 * `maskable`. `display: browser`: this is a page, never an installed app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME,
    description: DESCRIPTION,
    start_url: "/",
    display: "browser",
    theme_color: THEME_COLOR_DARK,
    background_color: THEME_COLOR_DARK,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
