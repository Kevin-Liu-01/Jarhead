import localFont from "next/font/local";
import type { ReactNode } from "react";
import { THEME_BOOT } from "@/lib/theme";
import "./globals.css";
import "@/styles/kit.css";
import "@/styles/desk.css";
import "@/styles/hero.css";
import "@/styles/sections.css";
import "@/styles/install.css";

export { metadata, viewport } from "@/lib/metadata";

// Inter 4.1 (rsms), self-hosted: the variable roman, every weight in one file. Nothing on the page is italic.
const inter = localFont({
  src: [
    { path: "./fonts/InterVariable.woff2", weight: "100 900", style: "normal" },
  ],
  variable: "--font-inter",
  display: "swap",
});

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* The theme before paint: a stored choice, else the system, stamped as data-theme and data-theme-source. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
