import type { Metadata, Viewport } from "next";
import { ALT, FOOTER, HERO } from "@/content/deck";
import { first, parts } from "@/lib/cut";

/**
 * The page's metadata, in one place; `app/layout.tsx` re-exports both. The words are read
 * from content/deck.ts (FOOTER, HERO, ALT), never typed here; the OG picture is `/og.png`
 * (`app/og.png/route.tsx`), the favicons are `scripts/make-icons.mts`'s output, the
 * manifest is `app/manifest.ts`. `app/icon.png` and `app/apple-icon.png` are Next's file
 * conventions, but Next links them only when `icons` is unset, so they are named in `icons`
 * below beside the 16 px PNG (listed so a browser can pick its size).
 */

const SITE_URL = "https://jarhead.kevinliu.studio";
export const SITE_NAME = FOOTER.brand;

/** The footer line, the lead's first sentence, then three parts of the figures line. 125 characters today. */
export const DESCRIPTION = `${FOOTER.line1} ${first(HERO.lead, 1)} ${parts(HERO.figures).slice(1, 4).join(" · ")}`;

const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: ALT.banner, type: "image/png" } as const;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: "/",
    title: SITE_NAME,
    description: DESCRIPTION,
    locale: "en_US",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: DESCRIPTION,
    images: [{ url: OG_IMAGE.url, width: OG_IMAGE.width, height: OG_IMAGE.height, alt: OG_IMAGE.alt }],
  },
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
  // Next links its file-convention icons only when `icons` is unset, so the two file routes
  // (`app/icon.png`, `app/apple-icon.png`) are named here beside the 16 px PNG.
  icons: {
    icon: [
      { url: "/icon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

// No `themeColor`: the one theme-color meta is the boot script's (lib/theme.ts themeBoot), so it follows html[data-theme].
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};
