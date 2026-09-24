import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { THEME_BOOT } from "@/lib/theme";
import "./globals.css";

// Inter 4.1 (rsms), self-hosted: the variable roman and italic, every weight in two files.
const inter = localFont({
  src: [
    { path: "./fonts/InterVariable.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/InterVariable-Italic.woff2", weight: "100 900", style: "italic" },
  ],
  variable: "--font-inter",
  display: "swap",
});

const SITE = "https://jarhead.kevinliu.studio";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: "Jarhead",
  description: "A voice-first Mac assistant that uses the computer for you. Say its name, talk, it does the work. Open source, MIT.",
  openGraph: { title: "Jarhead", description: "A voice-first Mac assistant that uses the computer for you.", url: SITE, siteName: "Jarhead", type: "website" },
  twitter: { card: "summary_large_image", title: "Jarhead", description: "A voice-first Mac assistant that uses the computer for you." },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#070707" },
  ],
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Theme before paint: a stored choice, else the system. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
