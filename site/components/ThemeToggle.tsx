"use client";

import { useEffect } from "react";
import { readTheme, setTheme, useTheme } from "@/lib/theme";

/**
 * The theme toggle as a kit ghost tile, 32, icon-only. The glyph is CSS content on html[data-theme] (◐ light,
 * ◑ dark), so it is right before hydration; the label names the mode the press switches TO and is re-asserted
 * after hydration.
 */
export function ThemeToggle({ className }: { readonly className?: string }) {
  const theme = useTheme();
  useEffect(() => {
    // Re-assert the attribute the boot script stamped, so hydration never leaves <html> unstamped.
    document.documentElement.dataset["theme"] = readTheme();
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${next}`;
  return <button type="button" className={`kit-btn kit-btn--ghost kit-btn--icon jh-theme${className ? ` ${className}` : ""}`} aria-label={label} onClick={() => setTheme(next)} />;
}
