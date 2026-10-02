import type { ReactElement } from "react";
import { QUIET_STOPS } from "@/lib/dither";
import { paintPaperDisc, pngDataUri, renderOrb } from "@/lib/orb";

const cache = new Map<string, string>();

/** Clips the image to the disc (BrandMarks.swift:446-466): the icon's glow spill outside it goes transparent, so the mark sits on paper as it sits on ink. */
function clipToDisc(img: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }): void {
  const { width, height, data } = img;
  const c = width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - c, y + 0.5 - c) > c) data[(y * width + x) * 4 + 3] = 0;
    }
  }
}

/**
 * JarheadMark (BrandMarks.swift:438-466; facts-orb.md §1.9): the faceless dithered disc on the diagonal ramp, five bands,
 * 1 px cells, a paper disc at .34 alpha (0.42 × size, offset (−0.15, −0.17) × size); 14 in the icon column, 24 in a head,
 * 56 at the foot. `quiet` wears the titanium ramp for a conversation that is over (Dither.swift:67-78). Rendered once per
 * shape into an inline PNG data URI at SSR, so it is right with no JS; pixelated so the cells stay crisp on Retina.
 * Server-only (the PNG encoder is the server's); decorative.
 */
export function JarheadMark({ size = 14, quiet, className }: { readonly size?: 14 | 24 | 56; readonly quiet?: boolean; readonly className?: string }): ReactElement {
  const key = `${size}${quiet ? "q" : ""}`;
  let uri = cache.get(key);
  if (!uri) {
    const img = renderOrb({ size, cell: 1, face: null, stops: quiet ? QUIET_STOPS : undefined });
    clipToDisc(img);
    paintPaperDisc(img, size / 2 - 0.15 * size, size / 2 - 0.17 * size, 0.21 * size, 0.34);
    uri = pngDataUri(img);
    cache.set(key, uri);
  }
  return <img src={uri} width={size} height={size} alt="" aria-hidden="true" decoding="async" className={`kit-mark${className ? ` ${className}` : ""}`} />;
}
