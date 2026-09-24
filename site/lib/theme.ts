/** The theme is a data attribute on <html>: "light" | "dark". A stored choice wins; else the system. */
export const THEME_KEY = "jh-theme";
export type Theme = "light" | "dark";

/** Runs before paint (inlined in <head>), so the first frame already wears the right theme. */
export const THEME_BOOT = `(function(){try{var k="${THEME_KEY}",s=localStorage.getItem(k),m=window.matchMedia("(prefers-color-scheme: dark)"),t=s==="light"||s==="dark"?s:(m.matches?"dark":"light");document.documentElement.dataset.theme=t;if(!s){m.addEventListener("change",function(e){if(!localStorage.getItem(k))document.documentElement.dataset.theme=e.matches?"dark":"light"})}}catch(e){document.documentElement.dataset.theme="light"}})();`;

export function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the choice lives for this page only.
  }
}
