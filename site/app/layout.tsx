import localFont from "next/font/local";
import type { ReactNode } from "react";
import { ARRIVE_BOOT } from "@/lib/motion";
import { SCALE_BOOT } from "@/lib/scale";
import { themeBoot } from "@/lib/theme";
import { token } from "@/lib/tokens";
import "./globals.css";
import "@/styles/kit.css";
import "@/styles/desk.css";
import "@/styles/site.css";
import "@/styles/play.css";

export { metadata, viewport } from "@/lib/metadata";

// Inter 4.1 (rsms, SIL OFL, app/fonts/LICENSE-Inter.txt), self-hosted: every word on the page that is not a heading or
// spoken. The variable roman cut with fontTools to what the page sets: weights 400 to 600 (600 on the menu bar's app name
// alone), the optical size axis kept, Latin and the page's punctuation and Mac keys, the features it uses; 48 KB.
const inter = localFont({
  src: [{ path: "./fonts/InterVariable.woff2", weight: "400 600", style: "normal" }],
  variable: "--font-inter",
  display: "swap",
});

// Newsreader (Production Type, SIL OFL, app/fonts/OFL-Newsreader.txt), the display face: the h1 and the section heads,
// set large and quiet. Instanced with fontTools to the display optical sizes (opsz 36 to 72) and weights 300 to 420,
// subset to Latin and the punctuation the page sets; 48 KB.
const news = localFont({
  src: [{ path: "./fonts/Newsreader-Display.woff2", weight: "300 420", style: "normal" }],
  variable: "--font-news",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

// Newsreader Italic, one static instance (opsz 22, wght 400), 14 KB: the voice. Every line the visitor says on the page
// (the chips that speak a deck line) is set in it, so what is spoken reads as spoken.
const newsItalic = localFont({
  src: [{ path: "./fonts/Newsreader-Italic.woff2", weight: "400", style: "italic" }],
  variable: "--font-news-i",
  display: "swap",
  fallback: ["Georgia", "Times New Roman", "serif"],
});

// JetBrains Mono 2.304 (SIL OFL, app/fonts/OFL-JetBrainsMono.txt), subset: values, commands, the island's head and foot.
const mono = localFont({
  src: [{ path: "./fonts/JetBrainsMono-wght.woff2", weight: "100 800", style: "normal" }],
  variable: "--font-jbm",
  display: "swap",
  fallback: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
  adjustFontFallback: false,
});

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${news.variable} ${newsItalic.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/* Before paint: the theme (a stored choice, else the system), whether the hero's blob arrives (motion allowed), and
            the island's scale inputs from the viewport itself (lib/scale.ts). */}
        <script dangerouslySetInnerHTML={{ __html: themeBoot({ light: token("--jh-ground"), dark: token("--jh-ground", "dark") }) + ARRIVE_BOOT + SCALE_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
