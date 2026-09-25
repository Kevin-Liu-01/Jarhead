import type { CSSProperties } from "react";

/**
 * A capture shown at an exact scale inside a crop box: the box is `box` CSS px (never wider than
 * its column, keeping its aspect), the image is `scale` × its pixel size (0.5 for the 2× Console
 * JPEGs, 1 for the 1× PNGs) and anchors at `x`/`y` percent of the box, so a rail crop shows the
 * rail at its true size instead of a shrunken whole. Frame hairline, radius 6, its own baked ground.
 */
export function Crop({
  src,
  alt,
  width,
  height,
  scale = 0.5,
  box,
  x = 0,
  y = 0,
  ground,
  fit,
  className,
}: {
  readonly src: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly scale?: number;
  readonly box: readonly [number, number];
  /** anchor in percent: 0 = the image's left/top edge at the box's, 100 = the right/bottom edge */
  readonly x?: number;
  readonly y?: number;
  readonly ground?: "screen" | "ink" | "raised";
  /** under 720 px the image fits the box's width (the whole picture on a phone) instead of keeping its scale */
  readonly fit?: boolean;
  readonly className?: string;
}) {
  const style = {
    "--crop-w": box[0],
    "--crop-h": box[1],
    "--crop-img-w": Math.round(width * scale),
    "--crop-x": x,
    "--crop-y": y,
  } as CSSProperties;
  const cls = ["jh-shot", "jh-crop", ground === "ink" ? "is-ink" : ground === "raised" ? "is-raised" : "", fit ? "is-fit" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <figure className={cls} style={style}>
      <img src={src} alt={alt} width={width} height={height} decoding="async" loading="lazy" />
    </figure>
  );
}
