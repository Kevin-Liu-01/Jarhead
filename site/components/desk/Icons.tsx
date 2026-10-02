import type { ReactElement } from "react";

/**
 * The drawn Mac's own glyphs the kit lacks (the island's Window, Console and Sleep tiles, the drawings' crescent):
 * inline 20-box paths drawn by hand in the kit's weight (Glyph.tsx: ink inside 1.5 → 18.5), fill: currentColor. They are
 * the picture's chrome, never the site's controls: every verb and status glyph is the kit's Glyph. No SF Symbol data ships.
 */
type IconName = "moon" | "window" | "console";

type IconProps = { readonly size?: number; readonly className?: string };
type IconFn = (p: IconProps) => ReactElement;

export const ICON_PATHS: Record<IconName, { readonly d: string; readonly evenodd?: boolean }> = {
  // The asleep crescent: the disc r 8 about (10.32, 9.68) less the same disc moved 6 up-right, centred on the box.
  moon: { d: "M7.19 2.32A8 8 0 1 0 17.68 12.81A8 8 0 0 1 7.19 2.32Z" },
  // The island's Window tile.
  window: { evenodd: true, d: "M3 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4Zm2 3.5V16h10V7.5H5Z" },
  // The island foot's Console tile (notch-island-working.png): a tall pane and two stacked ones.
  console: { d: "M3 5.5A1.5 1.5 0 0 1 4.5 4h4A1.5 1.5 0 0 1 10 5.5v9A1.5 1.5 0 0 1 8.5 16h-4A1.5 1.5 0 0 1 3 14.5v-9ZM11.5 5.5A1.5 1.5 0 0 1 13 4h2.5A1.5 1.5 0 0 1 17 5.5v2.25a1.5 1.5 0 0 1-1.5 1.5H13a1.5 1.5 0 0 1-1.5-1.5V5.5ZM11.5 12.25a1.5 1.5 0 0 1 1.5-1.5h2.5a1.5 1.5 0 0 1 1.5 1.5v2.25a1.5 1.5 0 0 1-1.5 1.5H13a1.5 1.5 0 0 1-1.5-1.5v-2.25Z" },
};

function make(name: IconName): IconFn {
  const p = ICON_PATHS[name];
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
  console: make("console"),
};
