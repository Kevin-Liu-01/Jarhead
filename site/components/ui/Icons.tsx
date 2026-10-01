import type { ReactElement } from "react";

/**
 * The drawn Mac's own glyphs the kit lacks (the island's Sleep and Window, the menu bar's status items): inline
 * 20-box paths drawn by hand in the kit's weight (Glyph.tsx: ink inside 1.5 → 18.5), fill: currentColor; only names
 * with an importer ship. These are the picture's chrome, never the site's controls: every verb and status glyph is
 * the kit's Glyph (components/kit/Glyph.tsx). No SF Symbol or Heroicon data ships here.
 */
export type IconName = "moon" | "window" | "wifi" | "battery";

type IconProps = { readonly size?: number; readonly className?: string };
type IconFn = (p: IconProps) => ReactElement;

const PATHS: Record<IconName, { readonly d: string; readonly evenodd?: boolean }> = {
  // The asleep crescent: the disc r 8 about (10.32, 9.68) less the same disc moved 6 up-right, its horns at the
  // upper left and the right, the whole centred on the box (2.32 → 17.68 both ways).
  moon: { d: "M7.19 2.32A8 8 0 1 0 17.68 12.81A8 8 0 0 1 7.19 2.32Z" },
  // The island's Window tile and the menu bar's.
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
  wifi: make("wifi"),
  battery: make("battery"),
};
