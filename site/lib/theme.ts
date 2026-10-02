/**
 * The theme is one attribute on <html>: data-theme="light" | "dark". A stored choice wins; else the
 * system, followed live while nothing is stored. data-theme-source says which ("stored" | "system").
 * The browser chrome follows the same switch: one <meta name="theme-color">, stamped beside data-theme.
 */
// A namespace import: this module is also read by the server layout (for THEME_BOOT), and only client
// components call useTheme, so the hook must not pull a client-only named import into a server module.
import * as React from "react";

const THEME_KEY = "jh-theme";
export type Theme = "light" | "dark";

/** The two grounds, `--jh-ground` light and dark (globals.css); a meta value has no token to read. */
export const THEME_COLOR: Readonly<Record<Theme, string>> = { light: "#ffffff", dark: "#070707" };

/**
 * Runs before paint (inlined in <head>), so the first frame already wears the right theme. It also makes the
 * page's only theme-color meta (nothing server-rendered, so hydration never sees its content change).
 */
export const THEME_BOOT = `(function(){var d=document.documentElement,s=null,m=null;function a(t){d.dataset.theme=t;var e=document.querySelector('meta[name="theme-color"]');if(!e){e=document.createElement("meta");e.name="theme-color";document.head.appendChild(e)}e.content=t==="dark"?"${THEME_COLOR.dark}":"${THEME_COLOR.light}"}try{s=localStorage.getItem("${THEME_KEY}")}catch(e){}try{m=matchMedia("(prefers-color-scheme: dark)")}catch(e){}var st=s==="light"||s==="dark";a(st?s:(m&&m.matches?"dark":"light"));d.dataset.themeSource=st?"stored":"system";if(!st&&m){m.addEventListener("change",function(e){if(d.dataset.themeSource!=="stored")a(e.matches?"dark":"light")})}})();`;

export function readTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
}

/** THEME_BOOT's meta (made again if something dropped it), set to the ground of `theme`. */
function stampThemeColor(theme: Theme): void {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  meta.content = THEME_COLOR[theme];
}

/** Stamps the attribute and the theme-color, stores the choice, and marks the source as stored (the system listener then stands down). */
export function setTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset["theme"] = theme;
  stampThemeColor(theme);
  root.dataset["themeSource"] = "stored";
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Private mode: the choice lives for this page only.
  }
}

/** Every canvas engine re-resolves its ink through this: a MutationObserver on <html data-theme>. */
export function subscribeTheme(cb: (t: Theme) => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const mo = new MutationObserver(() => cb(readTheme()));
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

/** A token's computed value on <html>, e.g. cssVar("--jh-accent"). */
export function cssVar(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const serverTheme = (): Theme => "light";

/** The live theme for client components. */
export function useTheme(): Theme {
  return React.useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
}

/** One still, no loops: `#still` in the hash, or the visitor asked for reduced motion. */
export function isStill(): boolean {
  if (typeof window === "undefined") return true;
  if (window.location.hash === "#still") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
