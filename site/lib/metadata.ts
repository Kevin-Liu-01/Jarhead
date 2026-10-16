import type { Metadata, Viewport } from "next";
import { ALT, FOOTER, HERO } from "@/content/deck";
import { first, parts } from "@/lib/cut";

/**
 * The page's metadata, in one place; `app/layout.tsx` re-exports both. The words are read
 * from content/deck.ts (FOOTER, HERO, ALT), never typed here; the OG picture is the static
 * `public/og.png` (1200 × 630, captured from the dev-only `/card` by `scripts/make-cards.sh`,
 * docs/DESIGN.md "The share pictures"), linked with a version query (OG_VERSION below); the
 * favicons are `scripts/make-icons.mts`'s output, the manifest is `app/manifest.ts`.
 * `app/icon.png` and `app/apple-icon.png` are Next's file conventions, but Next links them
 * only when `icons` is unset, so they are named in `icons` below beside the 16 px PNG, the
 * 48/32/16 px `public/favicon.ico` and the 192 px PNG (listed so a browser can pick its size).
 */

export const SITE_URL = "https://jarhead.kevinliu.studio";
export const SITE_NAME = FOOTER.brand;

/** The footer line, the lead's first sentence, then three parts of the figures line. 125 characters today. */
export const DESCRIPTION = `${FOOTER.line1} ${first(HERO.lead, 1)} ${parts(HERO.figures).slice(1, 4).join(" · ")}`;

/**
 * X, LinkedIn, Slack, Facebook and iMessage cache a card's picture by its URL, and `/og.png` already served the launch
 * card. Bump this whenever `public/og.png` changes, so feeds fetch the new picture instead of the one they hold.
 */
const OG_VERSION = 3;
const OG_IMAGE = { url: `/og.png?v=${OG_VERSION}`, width: 1200, height: 630, alt: ALT.og, type: "image/png" } as const;

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
  // (`app/icon.png`, `app/apple-icon.png`) are named here beside the public/ icons.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48 32x32 16x16", type: "image/x-icon" },
      { url: "/icon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

/** The home page's JSON-LD: the site and its brand, the logo being the 512 px icon (Google wants a PNG of 112 px or more). */
export const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "@id": `${SITE_URL}/#website`, name: SITE_NAME, url: `${SITE_URL}/` },
    { "@type": "Organization", "@id": `${SITE_URL}/#organization`, name: SITE_NAME, url: `${SITE_URL}/`, logo: `${SITE_URL}/icon-512.png` },
  ],
} as const;

// No `themeColor`: the one theme-color meta is the boot script's (lib/theme.ts themeBoot), so it follows html[data-theme].
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};
