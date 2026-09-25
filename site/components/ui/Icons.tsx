import Apple from "@thesvg/react/apple";
import type { ReactElement } from "react";

/**
 * The glyphs: Heroicons 20 solid (MIT) where one exists (lock-closed, speaker-wave and bookmark
 * carry the section lines), hand-drawn 20-box paths for the Mac facsimile. Inline paths, viewBox 0 0 20 20, fill: currentColor; only names with an importer ship.
 * The Apple mark is a brand, so it comes from thesvg.org (@thesvg/react, mono, currentColor; ICONS.md).
 */
export type IconName =
  | "clipboard"
  | "check"
  | "arrowUpRight"
  | "play"
  | "pause"
  | "stop"
  | "mic"
  | "moon"
  | "target"
  | "window"
  | "ask"
  | "grid"
  | "eraser"
  | "wifi"
  | "battery"
  | "apple"
  | "bell"
  | "lock"
  | "speaker"
  | "bookmark";

type IconProps = { readonly size?: number; readonly className?: string };
type IconFn = (p: IconProps) => ReactElement;

const PATHS: Record<Exclude<IconName, "apple">, { readonly d: string; readonly evenodd?: boolean }> = {
  clipboard: {
    evenodd: true,
    d: "M15.988 3.012A2.25 2.25 0 0 1 18 5.25v6.5A2.25 2.25 0 0 1 15.75 14H13.5v-3.379a3 3 0 0 0-.879-2.121l-3.12-3.121a3 3 0 0 0-1.402-.791 2.252 2.252 0 0 1 1.913-1.576A2.25 2.25 0 0 1 12.25 1h1.5a2.25 2.25 0 0 1 2.238 2.012ZM11.5 3.25a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75v.25h-3v-.25ZM3.5 6A1.5 1.5 0 0 0 2 7.5v9A1.5 1.5 0 0 0 3.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L8.44 6.439A1.5 1.5 0 0 0 7.378 6H3.5Z",
  },
  check: {
    evenodd: true,
    d: "M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z",
  },
  arrowUpRight: {
    evenodd: true,
    d: "M5.22 14.78a.75.75 0 0 0 1.06 0l7.22-7.22v5.69a.75.75 0 0 0 1.5 0v-7.5a.75.75 0 0 0-.75-.75h-7.5a.75.75 0 0 0 0 1.5h5.69l-7.22 7.22a.75.75 0 0 0 0 1.06Z",
  },
  play: { d: "M6.3 2.84A1.5 1.5 0 0 0 4 4.11v11.78a1.5 1.5 0 0 0 2.3 1.27l9.344-5.891a1.5 1.5 0 0 0 0-2.538L6.3 2.841Z" },
  pause: {
    d: "M5.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75A.75.75 0 0 0 7.25 3h-1.5ZM12.75 3a.75.75 0 0 0-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 0 0 .75-.75V3.75a.75.75 0 0 0-.75-.75h-1.5Z",
  },
  stop: { d: "M5.25 3A2.25 2.25 0 0 0 3 5.25v9.5A2.25 2.25 0 0 0 5.25 17h9.5A2.25 2.25 0 0 0 17 14.75v-9.5A2.25 2.25 0 0 0 14.75 3h-9.5Z" },
  mic: {
    d: "M7 4a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0V4ZM5.5 9.643a.75.75 0 0 0-1.5 0V10c0 3.06 2.29 5.585 5.25 5.954V17.5h-1.5a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5h-1.5v-1.546A6.001 6.001 0 0 0 16 10v-.357a.75.75 0 0 0-1.5 0V10a4.5 4.5 0 0 1-9 0v-.357Z",
  },
  moon: {
    evenodd: true,
    d: "M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z",
  },
  grid: {
    evenodd: true,
    d: "M4.25 2A2.25 2.25 0 0 0 2 4.25v2.5A2.25 2.25 0 0 0 4.25 9h2.5A2.25 2.25 0 0 0 9 6.75v-2.5A2.25 2.25 0 0 0 6.75 2h-2.5Zm0 9A2.25 2.25 0 0 0 2 13.25v2.5A2.25 2.25 0 0 0 4.25 18h2.5A2.25 2.25 0 0 0 9 15.75v-2.5A2.25 2.25 0 0 0 6.75 11h-2.5Zm9-9A2.25 2.25 0 0 0 11 4.25v2.5A2.25 2.25 0 0 0 13.25 9h2.5A2.25 2.25 0 0 0 18 6.75v-2.5A2.25 2.25 0 0 0 15.75 2h-2.5Zm0 9A2.25 2.25 0 0 0 11 13.25v2.5A2.25 2.25 0 0 0 13.25 18h2.5A2.25 2.25 0 0 0 18 15.75v-2.5A2.25 2.25 0 0 0 15.75 11h-2.5Z",
  },
  bell: {
    evenodd: true,
    d: "M10 2a6 6 0 0 0-6 6c0 1.887-.454 3.665-1.257 5.234a.75.75 0 0 0 .515 1.076 32.91 32.91 0 0 0 3.256.508 3.5 3.5 0 0 0 6.972 0 32.903 32.903 0 0 0 3.256-.508.75.75 0 0 0 .515-1.076A11.448 11.448 0 0 1 16 8a6 6 0 0 0-6-6ZM8.05 14.943a33.54 33.54 0 0 0 3.9 0 2 2 0 0 1-3.9 0Z",
  },
  lock: {
    evenodd: true,
    d: "M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z",
  },
  speaker: {
    d: "M10 3.75a.75.75 0 0 0-1.264-.546L5.203 6.5H2.667a.75.75 0 0 0-.7.48A6.985 6.985 0 0 0 1.5 9.5c0 .887.165 1.737.468 2.52.111.29.39.48.7.48h2.535l3.533 3.296A.75.75 0 0 0 10 15.25V3.75ZM15.95 5.05a.75.75 0 0 0-1.06 1.061 5.5 5.5 0 0 1 0 7.778.75.75 0 0 0 1.06 1.06 7 7 0 0 0 0-9.899ZM13.829 7.172a.75.75 0 0 0-1.061 1.06 2.5 2.5 0 0 1 0 3.536.75.75 0 0 0 1.06 1.06 4 4 0 0 0 0-5.656Z",
  },
  bookmark: {
    evenodd: true,
    d: "M10 2c-1.716 0-3.408.106-5.07.31C3.806 2.45 3 3.414 3 4.517V17.25a.75.75 0 0 0 1.075.676L10 15.082l5.925 2.844A.75.75 0 0 0 17 17.25V4.517c0-1.103-.806-2.068-1.93-2.207A41.403 41.403 0 0 0 10 2Z",
  },
  // Hand-drawn, 20-box: the island's strip glyphs and the menu bar's.
  target: { evenodd: true, d: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 3.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" },
  window: { evenodd: true, d: "M3 4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4Zm2 3.5V16h10V7.5H5Z" },
  ask: {
    evenodd: true,
    d: "M10 2c-4.42 0-8 3.06-8 6.85 0 2.02.98 3.83 2.6 5.09L3.9 17.5l3.72-1.55c.76.19 1.56.3 2.38.3 4.42 0 8-3.07 8-6.85S14.42 2 10 2Zm.9 10.6H9.1v-1.7h1.8v1.7Zm.85-4.05c-.55.48-.85.78-.85 1.5H9.1c0-1.15.5-1.72 1.15-2.28.5-.42.8-.7.8-1.2 0-.6-.5-1.02-1.1-1.02-.68 0-1.2.5-1.2 1.2H7c0-1.65 1.3-2.85 3-2.85 1.6 0 2.95 1 2.95 2.55 0 .98-.55 1.6-1.2 2.1Z",
  },
  eraser: { d: "M11.6 2.6a2 2 0 0 1 2.83 0l3 3a2 2 0 0 1 0 2.83l-6.35 6.35H6.7l-3.3-3.3a2 2 0 0 1 0-2.83l8.2-6.05ZM4 16.5h12V18H4v-1.5Z" },
  wifi: {
    d: "M10 16.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm-3.2-4.4a4.5 4.5 0 0 1 6.4 0l-1.4 1.4a2.5 2.5 0 0 0-3.6 0l-1.4-1.4Zm-2.9-2.9a8.5 8.5 0 0 1 12.2 0l-1.4 1.4a6.5 6.5 0 0 0-9.4 0L3.9 9.2ZM1 6.3a12.5 12.5 0 0 1 18 0l-1.4 1.4a10.5 10.5 0 0 0-15.2 0L1 6.3Z",
  },
  battery: { evenodd: true, d: "M2 7a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1h.5a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H17v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Zm2 .5v5h11v-5H4Zm1 1h7v3H5v-3Z" },
};

function make(name: Exclude<IconName, "apple">): IconFn {
  const p = PATHS[name];
  const Glyph: IconFn = ({ size = 16, className }) => (
    <svg
      className={`jh-icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={p.d} fillRule={p.evenodd ? "evenodd" : undefined} clipRule={p.evenodd ? "evenodd" : undefined} />
    </svg>
  );
  return Glyph;
}

/** The Apple silhouette from thesvg.org: the mono variant inherits currentColor. */
const AppleMark: IconFn = ({ size = 16, className }) => (
  <Apple variant="mono" width={size} height={size} className={`jh-icon${className ? ` ${className}` : ""}`} aria-hidden="true" focusable="false" />
);

export const Icon: Record<IconName, IconFn> = {
  clipboard: make("clipboard"),
  check: make("check"),
  arrowUpRight: make("arrowUpRight"),
  play: make("play"),
  pause: make("pause"),
  stop: make("stop"),
  mic: make("mic"),
  moon: make("moon"),
  target: make("target"),
  window: make("window"),
  ask: make("ask"),
  grid: make("grid"),
  eraser: make("eraser"),
  wifi: make("wifi"),
  battery: make("battery"),
  apple: AppleMark,
  bell: make("bell"),
  lock: make("lock"),
  speaker: make("speaker"),
  bookmark: make("bookmark"),
};
