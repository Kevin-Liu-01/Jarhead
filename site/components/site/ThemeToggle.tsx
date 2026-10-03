"use client";

import { useEffect } from "react";
import { Icon } from "@/components/icons/Icon";
import { NAV } from "@/content/deck";
import { readTheme, setTheme, useTheme } from "@/lib/theme";

/**
 * The theme as a status item in the menu bar: Phosphor's circle-half (Fill), the same in both themes; the label names the mode the press switches to and is re-asserted after hydration.
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
      <Icon name="circleHalf" size={16} />
    </button>
  );
}
