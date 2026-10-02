"use client";

import { useEffect } from "react";
import { NAV } from "@/content/deck";
import { readTheme, setTheme, useTheme } from "@/lib/theme";

/**
 * The theme as a status item in the menu bar: a filled glyph on the kit's 20 box (a ring with its right half filled),
 * the same in both themes; the label names the mode the press switches to and is re-asserted after hydration.
 */
export function ThemeToggle() {
  const theme = useTheme();
  useEffect(() => {
    // Re-assert the attribute the boot script stamped, so hydration never leaves <html> unstamped.
    document.documentElement.dataset["theme"] = readTheme();
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className="bar-item bar-theme" aria-label={NAV.theme[next]} onClick={() => setTheme(next)}>
      <svg width={16} height={16} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false">
        <path fillRule="evenodd" d="M10 1.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 0 1 0-17Zm0 1.75a6.75 6.75 0 0 0 0 13.5Z" />
      </svg>
    </button>
  );
}
