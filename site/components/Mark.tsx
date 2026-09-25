import type { ReactElement } from "react";
import { QUIET_STOPS } from "@/lib/dither";
import { paintPaperDisc, pngDataUri, renderOrb } from "@/lib/orb";

const cache = new Map<string, string>();

/**
 * JarheadMark (BrandMarks.swift:446-466; facts-orb.md §1.9): the faceless dithered disc at 20 / 24 px,
 * 1 px cells, five bands, plus a paper disc at .34 alpha (0.42 × size, offset (−0.15, −0.17) × size).
 * `quiet` swaps in QUIET_STOPS (a conversation that is over). Rendered once into an inline PNG data
 * URI, so it is right at SSR and with no JS; pixelated so the cells stay crisp on Retina.
 */
export function Mark({ size = 20, quiet, className }: { size?: 20 | 24; quiet?: boolean; className?: string }): ReactElement {
  const key = `${size}${quiet ? "q" : ""}`;
  let uri = cache.get(key);
  if (!uri) {
    const img = renderOrb({ size, cell: 1, face: null, stops: quiet ? QUIET_STOPS : undefined });
    paintPaperDisc(img, size / 2 - 0.15 * size, size / 2 - 0.17 * size, 0.21 * size, 0.34);
    uri = pngDataUri(img);
    cache.set(key, uri);
  }
  return <img src={uri} width={size} height={size} alt="" aria-hidden="true" decoding="async" className={`desk-mark${className ? ` ${className}` : ""}`} />;
}
