/**
 * A section's ground: one tone ordered-dithered over the page ground (the 8×8 Bayer tile, the family's only texture). Every
 * cell is one of `bands + 1` flat colours between the ground and the tone at `peak`; the level a cell takes is the field's
 * intensity at that cell quantised against the tile's threshold, so the ramp is seen as dots and never as a smooth gradient.
 * The intensity is a floor everywhere (sparse dots of the tone across the whole section) rising to the peak at an anchor
 * (behind the section's picture) over a radius; the hero adds a second, wide light (an ellipse behind its two calls, so
 * the glass has something to frost). Pure: the colours are passed in already resolved from --jh-* tokens by the caller, one
 * ImageData per render, the canvas upscaled pixelated.
 */
import { BAYER8, clamp01, mix3, smoothstep, type RGB } from "@/lib/dither";

interface ToneField {
  /** The section's size in CSS px; the store is rounded up to 64 so a resize re-renders only across a boundary. */
  readonly width: number;
  readonly height: number;
  /** The cell in CSS px. */
  readonly cell: number;
  readonly ground: RGB;
  readonly tone: RGB;
  /** The mix of the tone over the ground at the anchor, 0 to 1. */
  readonly peak: number;
  /** The intensity everywhere, as a fraction of the peak. */
  readonly floor: number;
  /** The anchor as fractions of the section's box. */
  readonly ax: number;
  readonly ay: number;
  /** The radius as a fraction of the section's larger side. */
  readonly r: number;
  readonly bands: number;
  /** A second light: an ellipse (centre and radii in CSS px on the section's box), its intensity as a fraction of the peak. */
  readonly band?: { readonly x: number; readonly y: number; readonly rx: number; readonly ry: number; readonly strength: number };
  /** The fraction of the section's height, at its foot, over which every light thins to nothing (0 leaves the foot as drawn). */
  readonly foot?: number;
}

/** Little-endian ABGR for a Uint32 view of ImageData. */
function pack(c: RGB): number {
  return ((255 << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
}

export function renderToneField(canvas: HTMLCanvasElement, o: ToneField): void {
  const cell = o.cell > 0 ? o.cell : 2;
  const W = Math.max(64, Math.ceil(o.width / 64) * 64);
  const H = Math.max(64, Math.ceil(o.height / 64) * 64);
  const nx = Math.ceil(W / cell);
  const ny = Math.ceil(H / cell);
  canvas.width = nx;
  canvas.height = ny;
  canvas.style.width = `${nx * cell}px`;
  canvas.style.height = `${ny * cell}px`;
  const g = canvas.getContext("2d");
  if (!g) return;
  const img = g.createImageData(nx, ny);
  const px = new Uint32Array(img.data.buffer);
  const bands = Math.max(1, o.bands);
  const L: number[] = [];
  for (let i = 0; i <= bands; i++) L.push(pack(mix3(o.ground, o.tone, (o.peak * i) / bands)));
  // The anchor and radius on the section's own box (o.width × o.height), so the rounding never moves the light.
  const cx = o.ax * o.width;
  const cy = o.ay * o.height;
  const R = Math.max(1, o.r * Math.max(o.width, o.height));
  const floor = clamp01(o.floor);
  const band = o.band;
  // The foot: the section's last `foot` of height thins every light to nothing, so a field never ends on the box's edge.
  const foot = clamp01(o.foot ?? 0);
  for (let y = 0; y < ny; y++) {
    const yc = (y + 0.5) * cell;
    const py = yc - cy;
    const row = (y & 7) * 8;
    const base = y * nx;
    const by = band ? (yc - band.y) / Math.max(1, band.ry) : 0;
    const fade = foot > 0 ? 1 - smoothstep(o.height * (1 - foot), o.height, yc) : 1;
    for (let x = 0; x < nx; x++) {
      const qx = (x + 0.5) * cell - cx;
      const d = Math.sqrt(qx * qx + py * py) / R;
      let u = floor + (1 - floor) * (1 - smoothstep(0, 1, d));
      if (band) {
        const bx = ((x + 0.5) * cell - band.x) / Math.max(1, band.rx);
        u = Math.max(u, band.strength * (1 - smoothstep(0, 1, Math.sqrt(bx * bx + by * by))));
      }
      u *= fade;
      const t = BAYER8[row + (x & 7)] ?? 0.5;
      const i = Math.min(bands, Math.floor(u * bands + t));
      px[base + x] = L[i] ?? 0;
    }
  }
  g.putImageData(img, 0, 0);
}
