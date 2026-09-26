import type { ReactElement } from "react";
import { QUIET_STOPS } from "@/lib/dither";
import { paintPaperDisc, pngDataUri, renderOrb } from "@/lib/orb";

const cache = new Map<string, string>();

/** Clips the image to the disc (BrandMarks.swift:446-466: the mark is clipped to a circle): the icon's glow spill outside it goes transparent, so the mark sits on paper as it sits on ink. */
function clipToDisc(img: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }): void {
  const { width, height, data } = img;
  const cx = width / 2;
  const cy = height / 2;
  const R = width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > R) data[(y * width + x) * 4 + 3] = 0;
    }
  }
}

/**
 * JarheadMark (BrandMarks.swift:446-466; facts-orb.md §1.9): the faceless dithered disc at 14 / 16 / 20 / 24 px (56 in the closing band),
 * 1 px cells, five bands, plus a paper disc at .34 alpha (0.42 × size, offset (−0.15, −0.17) × size).
 * `quiet` swaps in QUIET_STOPS (a conversation that is over). Rendered once into an inline PNG data
 * URI, so it is right at SSR and with no JS; pixelated so the cells stay crisp on Retina.
 */
export function Mark({ size = 20, quiet, className }: { size?: 14 | 16 | 20 | 24 | 56; quiet?: boolean; className?: string }): ReactElement {
  const key = `${size}${quiet ? "q" : ""}`;
  let uri = cache.get(key);
  if (!uri) {
    const img = renderOrb({ size, cell: 1, face: null, stops: quiet ? QUIET_STOPS : undefined });
    clipToDisc(img);
    paintPaperDisc(img, size / 2 - 0.15 * size, size / 2 - 0.17 * size, 0.21 * size, 0.34);
    uri = pngDataUri(img);
    cache.set(key, uri);
  }
  return <img src={uri} width={size} height={size} alt="" aria-hidden="true" decoding="async" className={`desk-mark${className ? ` ${className}` : ""}`} />;
}
