import type { Metadata, Viewport } from "next";

/**
 * The page's metadata, in one place; `app/layout.tsx` re-exports both. The words are the
 * deck's (COPY.md:251, COPY.md:36, COPY.md:40, COPY.md:268); the OG picture is `/og.png`
 * (`app/og.png/route.tsx`), the favicons are `scripts/make-icons.mts`'s output, the
 * manifest is `app/manifest.ts`. `app/icon.png` and `app/apple-icon.png` are Next's file
 * conventions, but Next links them only when `icons` is unset, so they are named in `icons`
 * below beside the 16 and 32 px PNGs (listed so a browser can pick its size).
 */

export const SITE_URL = "https://jarhead.kevinliu.studio";
export const SITE_NAME = "Jarhead";

/** The footer line, the lead's first sentence, then three parts of the figures line. 125 characters. */
export const DESCRIPTION = "A voice-first Mac assistant that uses the computer for you. Say jarhead, pass Touch ID, talk. MIT · macOS 14+ · Apple silicon";

export const OG_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: "The dithered orb over an ink field.", type: "image/png" } as const;

/** The two grounds, `--jh-ground` light and dark (globals.css); a meta value has no token to read. */
export const THEME_COLOR_LIGHT = "#ffffff";
export const THEME_COLOR_DARK = "#070707";

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
  // (`app/icon.png`, `app/apple-icon.png`) are named here beside the 16 / 32 PNGs.
  icons: {
    icon: [
      { url: "/icon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR_DARK },
  ],
};
