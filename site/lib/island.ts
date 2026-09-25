/**
 * The island's ink: the orb ramp pooling out of the notch's black (UI/Orb/NotchInk.swift:356-433,
 * facts-orb.md §1.8). Five bands of ORB_STOPS on 1.5 CSS px cells, a per-state bias, the pale-cyan
 * highlight (σ 18 pt) that breathes, black pooling from the top edge (deep under the notch, a short
 * rim at the corners), a vignette on the open island. One buffer pixel per cell; the canvas is
 * upscaled with image-rendering: pixelated by the caller's CSS.
 */
import { BAYER8, ORB_STOPS, cellCss, clamp01, lut, quantise, smoothstep, type RGB } from "@/lib/dither";

const CYAN: RGB = [160, 240, 255];

interface Buf { n: number; m: number; img: ImageData; px: Uint32Array; g: CanvasRenderingContext2D }
const bufs = new WeakMap<HTMLCanvasElement, Buf>();

export interface IslandInkOptions {
  width: number;
  height: number;
  state: "open" | "peek";
  notchWidth: number;
  wing: number;
  /** 0…1, the 4 s breath of the highlight's amplitude. */
  breath: number;
  /** Cell size in the canvas's own CSS px (default 1.5 CSS px on screen). */
  cell?: number;
}

export function renderIslandInk(canvas: HTMLCanvasElement, o: IslandInkOptions): void {
  const cell = o.cell ?? cellCss(1.5);
  const W = o.width;
  const H = o.height;
  const n = Math.max(1, Math.round(W / cell));
  const m = Math.max(1, Math.ceil(H / cell));
  let b = bufs.get(canvas);
  if (!b || b.n !== n || b.m !== m) {
    canvas.width = n;
    canvas.height = m;
    const g = canvas.getContext("2d");
    if (!g) return;
    const img = g.createImageData(n, m);
    b = { n, m, img, px: new Uint32Array(img.data.buffer), g };
    bufs.set(canvas, b);
  }
  canvas.style.width = `${n * cell}px`;
  canvas.style.height = `${m * cell}px`;
  const L = lut(ORB_STOPS, 5);
  const sizeT = o.state === "peek" ? 0 : smoothstep(26, 184, H);
  const bias = 0.08 + (0.3 - 0.08) * sizeT;
  const hx = -0.01 * W;
  const hy = 0.36 * H;
  const sig2 = 2 * 18 * 18;
  const amp = (0.3 + 0.5 * sizeT) * (0.6 + 0.4 * clamp01(o.breath));
  const deep = 0.34 + (0.82 - 0.34) * sizeT;
  const rim = 0.5 + (0.26 - 0.5) * sizeT;
  const vig = 0.34 * sizeT;
  const half = o.notchWidth / 2;
  const px = b.px;
  for (let y = 0; y < m; y++) {
    const yPt = (y + 0.5) * cell;
    const fy = yPt / H;
    const vy = Math.abs(fy - 0.5) * 2 * 0.9;
    for (let x = 0; x < n; x++) {
      const t = BAYER8[(y & 7) * 8 + (x & 7)]!;
      const xPt = (x + 0.5) * cell;
      const fx = xPt / W;
      const u = bias + 0.78 * (0.68 * fx + 0.32 * fy);
      const c = L[Math.min(5, Math.floor(clamp01(u) * 5 + t))]!;
      let r = c[0];
      let g = c[1];
      let bl = c[2];
      const hl = quantise(amp * Math.exp(-((xPt - hx) * (xPt - hx) + (yPt - hy) * (yPt - hy)) / sig2), 6, t);
      if (hl > 0) {
        r += (CYAN[0] - r) * hl;
        g += (CYAN[1] - g) * hl;
        bl += (CYAN[2] - bl) * hl;
      }
      const fromNotch = clamp01((Math.abs(xPt - W / 2) - half) / o.wing);
      const reach = deep + (rim - deep) * smoothstep(0, 1, fromNotch);
      const black = quantise(1 - smoothstep(0, reach, fy), 5, t);
      const v = quantise(vig * smoothstep(0.55, 1, Math.max(Math.abs(fx - 0.5) * 2, vy)), 6, t);
      const k = (1 - black) * (1 - v);
      r *= k;
      g *= k;
      bl *= k;
      px[y * n + x] = (255 << 24) | ((bl & 255) << 16) | ((g & 255) << 8) | (r & 255);
    }
  }
  b.g.putImageData(b.img, 0, 0);
}
