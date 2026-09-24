"use client";

import { useEffect, useState } from "react";
import { readTheme, setTheme, type Theme } from "@/lib/theme";

/** One press flips the theme; the label always names what the press will do. */
export function ThemeToggle({ className }: { readonly className?: string }) {
  const [theme, setLocal] = useState<Theme>("light");
  useEffect(() => setLocal(readTheme()), []);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={className}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        setTheme(next);
        setLocal(next);
      }}
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
