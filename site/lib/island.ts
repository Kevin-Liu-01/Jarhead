/**
 * The island's ink: the orb ramp (or its titanium twin, asleep) pooling out of the notch's black (UI/Orb/NotchInk.swift
 * render(_:), facts-orb.md §1.8). Five bands of ORB_STOPS on 1.5 CSS px cells, a per-state bias, the pale-cyan
 * highlight (σ 18 pt) that breathes, the notch's lip, a vignette on the open island. The lip is the notch's black
 * carried a short way into the island and dithered away: its depth a Gaussian across x centred on the notch, so it
 * hangs as a soft bell and never as a wedge, over a thin rim that keeps the whole top edge ink. One buffer pixel per
 * cell; the canvas is upscaled with image-rendering: pixelated by the caller's CSS.
 */
import { BAYER8, ORB_STOPS, cellCss, clamp01, lut, quantise, smoothstep, type RGB, type Stops } from "@/lib/dither";

const CYAN: RGB = [160, 240, 255];
/** The lip's depth under the notch's centre and the rim's along the rest of the top edge, as fractions of the height: open, then peek. */
const LIP = 0.2;
const RIM = 0.02;
const LIP_PEEK = 0.34;
const RIM_PEEK = 0.5;
/** How much wider the bell's left flank is on the open island: the ramp is pale there, and a bell of equal depth read lighter left of the notch than right. */
const LEFT_WIDEN = 0.3;

interface Buf { n: number; m: number; img: ImageData; px: Uint32Array; reach: Float32Array; g: CanvasRenderingContext2D }
const bufs = new WeakMap<HTMLCanvasElement, Buf>();

interface IslandInkOptions {
  width: number;
  height: number;
  /** 0…1, the 4 s breath of the highlight's amplitude. */
  breath: number;
  /** Cell size in the canvas's own CSS px (default 1.5 CSS px on screen). */
  cell?: number;
  /** The ramp: the orb's by default; asleep wears QUIET_STOPS, the titanium twin. */
  stops?: Stops;
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
    b = { n, m, img, px: new Uint32Array(img.data.buffer), reach: new Float32Array(n), g };
    bufs.set(canvas, b);
  }
  canvas.style.width = `${n * cell}px`;
  canvas.style.height = `${m * cell}px`;
  const L = lut(o.stops ?? ORB_STOPS, 5);
  const sizeT = smoothstep(26, 184, H);
  // The open island's ramp sits deeper than the peek's, so the words over it read; the pale end is the face's corner.
  const bias = 0.08 + (0.42 - 0.08) * sizeT;
  const span = 0.78 + (0.95 - 0.78) * sizeT;
  const hx = -0.01 * W;
  const hy = 0.36 * H;
  const sig2 = 2 * 18 * 18;
  const amp = (0.3 + 0.5 * sizeT) * (0.6 + 0.4 * clamp01(o.breath));
  // The lip, per column: deepest under the notch's centre (a fifth of the open island), a bell across x over the rim.
  // σ is a quarter of the island's width (the app's halfW / 2, its e⁻² point a wing past the notch's edge), the left
  // flank a little wider on the open island. The peek keeps its top third ink and its shoulders half, so a breathing
  // peek's ends stay ink, never cyan ears.
  const lip = LIP_PEEK + (LIP - LIP_PEEK) * sizeT;
  const rim = RIM_PEEK + (RIM - RIM_PEEK) * sizeT;
  const right = 2 * (W / 4) ** 2;
  const left = right * (1 + LEFT_WIDEN * sizeT) ** 2;
  const reach = b.reach;
  for (let x = 0; x < n; x++) {
    const dx = (x + 0.5) * cell - W / 2;
    reach[x] = rim + (lip - rim) * Math.exp(-(dx * dx) / (dx < 0 ? left : right));
  }
  const vig = 0.34 * sizeT;
  const px = b.px;
  for (let y = 0; y < m; y++) {
    const yPt = (y + 0.5) * cell;
    const fy = yPt / H;
    const vy = Math.abs(fy - 0.5) * 2 * 0.9;
    for (let x = 0; x < n; x++) {
      const t = BAYER8[(y & 7) * 8 + (x & 7)]!;
      const xPt = (x + 0.5) * cell;
      const fx = xPt / W;
      const u = bias + span * (0.68 * fx + 0.32 * fy);
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
      const black = quantise(1 - smoothstep(0, reach[x]!, fy), 5, t);
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
