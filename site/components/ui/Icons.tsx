import type { ReactElement } from "react";

/**
 * The drawn Mac's own glyphs the kit lacks (the island's Window, Console and Sleep, the menu bar's status items):
 * inline 20-box paths, fill: currentColor; only names with an importer ship. These are the picture's chrome,
 * never the site's controls: every verb and status glyph is the kit's Glyph (components/kit/Glyph.tsx).
 */
export type IconName = "moon" | "window" | "grid" | "wifi" | "battery";

type IconProps = { readonly size?: number; readonly className?: string };
type IconFn = (p: IconProps) => ReactElement;

const PATHS: Record<IconName, { readonly d: string; readonly evenodd?: boolean }> = {
  moon: {
    evenodd: true,
    d: "M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z",
  },
  grid: {
    evenodd: true,
    d: "M4.25 2A2.25 2.25 0 0 0 2 4.25v2.5A2.25 2.25 0 0 0 4.25 9h2.5A2.25 2.25 0 0 0 9 6.75v-2.5A2.25 2.25 0 0 0 6.75 2h-2.5Zm0 9A2.25 2.25 0 0 0 2 13.25v2.5A2.25 2.25 0 0 0 4.25 18h2.5A2.25 2.25 0 0 0 9 15.75v-2.5A2.25 2.25 0 0 0 6.75 11h-2.5Zm9-9A2.25 2.25 0 0 0 11 4.25v2.5A2.25 2.25 0 0 0 13.25 9h2.5A2.25 2.25 0 0 0 18 6.75v-2.5A2.25 2.25 0 0 0 15.75 2h-2.5Zm0 9A2.25 2.25 0 0 0 11 13.25v2.5A2.25 2.25 0 0 0 13.25 18h2.5A2.25 2.25 0 0 0 18 15.75v-2.5A2.25 2.25 0 0 0 15.75 11h-2.5Z",
  },
  // Hand-drawn, 20-box: the island's Window tile and the menu bar's.
  window: { evenodd: true, d: "M3 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4Zm2 3.5V16h10V7.5H5Z" },
  wifi: {
    d: "M10 16.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm-3.2-4.4a4.5 4.5 0 0 1 6.4 0l-1.4 1.4a2.5 2.5 0 0 0-3.6 0l-1.4-1.4Zm-2.9-2.9a8.5 8.5 0 0 1 12.2 0l-1.4 1.4a6.5 6.5 0 0 0-9.4 0L3.9 9.2ZM1 6.3a12.5 12.5 0 0 1 18 0l-1.4 1.4a10.5 10.5 0 0 0-15.2 0L1 6.3Z",
  },
  battery: { evenodd: true, d: "M2 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1h.5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H17v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Zm2 .5v5h11v-5H4Zm1 1h7v3H5v-3Z" },
};

function make(name: IconName): IconFn {
  const p = PATHS[name];
  const Fn: IconFn = ({ size = 16, className }) => (
    <svg className={`jh-icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={p.d} fillRule={p.evenodd ? "evenodd" : undefined} clipRule={p.evenodd ? "evenodd" : undefined} />
    </svg>
  );
  return Fn;
}

export const Icon: Record<IconName, IconFn> = {
  moon: make("moon"),
  window: make("window"),
  grid: make("grid"),
  wifi: make("wifi"),
  battery: make("battery"),
};
