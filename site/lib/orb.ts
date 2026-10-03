/**
 * The still ramp orb: the disc on the diagonal ORB ramp in five dithered bands, the rim shade,
 * the glassy gleam, the three-level glow spilling onto a ground, and the face the live blob draws
 * (lib/eyes.ts: `O O` ink ovals with a paper catchlight, `^ ^` ink arcs, `- -` closed lids), antialiased per pixel.
 * Threshold per CELL, geometry per PIXEL, so the disc's edge stays crisp while the pattern stays chunky.
 * Sources: facts-orb.md §1.4–1.5, §1.9 (scripts/dither.ts:107-346, UI/Console/BrandMarks.swift:446-466).
 * Used by Mark, the blob's stills (lib/still.ts) and the OG field. Pure: no DOM, runs in Node.
 */
import { BAYER8, ORB_STOPS, clamp01, lut, quantise, rampAt, smoothstep, mix3, type RGB, type Stops } from "./dither";
import { faceField } from "./eyes";

export type Face = "^^" | "OO" | "--" | null;

const PAPER: RGB = [255, 255, 255];
const INK: RGB = [7, 7, 7];

interface Gleam { readonly x: number; readonly y: number; readonly sigma: number; readonly amp: number }

/** The orb's shading knobs, in R units (dither.ts:107-126). */
const ORB = {
  highlight: { x: -0.36, y: -0.4, sigma: 0.3, amp: 0.9 } as Gleam,
  rimDarken: 0.42,
  rimTone: [8, 26, 96] as RGB,
  rimLevels: 6,
  highlightLevels: 8,
  glowAmp: 0.5,
  glowLen: 0.28,
  glowPow: 1.3,
  glowLevels: 3,
};

/** The gleam when the orb wears a face: higher and tighter, as the live blob's (lib/blob.ts). */
const FACE_GLEAM: Gleam = { x: -0.36, y: -0.76, sigma: 0.17, amp: 0.85 };

function gleamLift(g: Gleam, nx: number, ny: number): number {
  const hx = nx - g.x;
  const hy = ny - g.y;
  return g.amp * Math.exp(-(hx * hx + hy * hy) / (2 * g.sigma * g.sigma));
}

/** An RGBA buffer; structurally an ImageData, also in Node where ImageData does not exist. */
interface OrbImage { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }

function makeImage(width: number, height: number): ImageData {
  if (typeof ImageData !== "undefined") return new ImageData(width, height);
  return { width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" } as unknown as ImageData;
}

/** The desktop blob's halo: the phase colour in a five-level dithered coverage mask, over a dark backing or over nothing. */
interface Halo { readonly color: RGB; readonly glow: number; readonly backing: RGB | null }

interface PaintOrbOptions {
  cx: number;
  cy: number;
  R: number;
  /** Dither cell in image px; the threshold is sampled per cell, the geometry per pixel. */
  cell: number;
  face: Face;
  stops?: Stops;
  bands?: number;
  /** Outside the disc: an opaque ground lifted by the icon's three-level glow; "keep" composites the glow over what is already in the buffer; null (default) leaves it transparent, the glow as alpha. */
  ground?: RGB | "keep" | null;
  /** The blob's halo instead of the icon glow (the still PNG). */
  halo?: Halo | null;
}

/** Paint the orb into `img` (RGBA, straight alpha). Fills only the disc and its glow reach. */
function paintOrb(img: OrbImage, o: PaintOrbOptions): void {
  const { width: W, height: H, data } = img;
  const { cx, cy, R, cell, face } = o;
  const bands = o.bands ?? 5;
  const L = lut(o.stops ?? ORB_STOPS, bands);
  const stops = o.stops ?? ORB_STOPS;
  const gleam = face ? FACE_GLEAM : ORB.highlight;
  const halo = o.halo ?? null;
  const ground = o.ground ?? null;
  const reach = halo ? 1.28 * R + cell : 1.9 * R;
  const x0 = Math.max(0, Math.floor(cx - reach));
  const x1 = Math.min(W, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach));
  const y1 = Math.min(H, Math.ceil(cy + reach));
  const ga = halo ? 0.16 + 0.34 * halo.glow : 0;
  const ba = halo && halo.backing ? 0.14 + 0.18 * halo.glow : 0;
  for (let y = y0; y < y1; y++) {
    const cy8 = ((y / cell) | 0) & 7;
    const ny = (y + 0.5 - cy) / R;
    for (let x = x0; x < x1; x++) {
      const t = BAYER8[cy8 * 8 + (((x / cell) | 0) & 7)]!;
      const nx = (x + 0.5 - cx) / R;
      const d = Math.hypot(nx, ny);
      const i = (y * W + x) * 4;
      if (d <= 1) {
        const diag = clamp01(0.5 + (nx + ny) / 2.6);
        let col = L[Math.min(bands, Math.floor(diag * bands + t))]!;
        const rim = smoothstep(0.55, 1, d) * clamp01(0.5 + (nx + ny) / 2) * ORB.rimDarken;
        col = mix3(col, ORB.rimTone, quantise(rim, ORB.rimLevels, t));
        col = mix3(col, PAPER, quantise(gleamLift(gleam, nx, ny), ORB.highlightLevels, t));
        // The face, only near the eyes: ink, then the catchlight, each covering by its distance (one pixel of antialias).
        if (face && nx > -0.62 && nx < 0.62 && ny > -0.42 && ny < 0.2) {
          const f = faceField(nx, ny, face);
          const ink = clamp01(0.5 - f.ink * R);
          if (ink > 0) col = mix3(col, INK, ink);
          const glint = clamp01(0.5 - f.glint * R);
          if (glint > 0) col = mix3(col, PAPER, glint);
        }
        data[i] = col[0];
        data[i + 1] = col[1];
        data[i + 2] = col[2];
        data[i + 3] = 255;
      } else if (halo) {
        let g = clamp01((1.28 - d) / 0.85);
        g = g * g * (3 - 2 * g);
        const f = quantise(g, 5, t);
        const ag = f * ga;
        const ab = f * ba * (1 - ag);
        const A = ag + ab;
        if (A <= 0) {
          if (ground !== "keep") data[i + 3] = 0;
          continue;
        }
        const bk = halo.backing ?? INK;
        data[i] = (halo.color[0] * ag + bk[0] * ab) / A;
        data[i + 1] = (halo.color[1] * ag + bk[1] * ab) / A;
        data[i + 2] = (halo.color[2] * ag + bk[2] * ab) / A;
        data[i + 3] = A * 255;
      } else {
        const sd = d - 1;
        const glow = ORB.glowAmp * Math.exp(-((sd / ORB.glowLen) ** ORB.glowPow));
        const q = quantise(glow, ORB.glowLevels, t);
        const diag = clamp01(0.5 + (nx + ny) / 2.6);
        if (ground === "keep") {
          if (q <= 0) continue;
          const base: RGB = [data[i]!, data[i + 1]!, data[i + 2]!];
          const col = mix3(base, rampAt(stops, diag), q);
          data[i] = col[0];
          data[i + 1] = col[1];
          data[i + 2] = col[2];
          data[i + 3] = 255;
        } else if (ground) {
          const col = mix3(ground, rampAt(stops, diag), q);
          data[i] = col[0];
          data[i + 1] = col[1];
          data[i + 2] = col[2];
          data[i + 3] = 255;
        } else if (q > 0) {
          const col = rampAt(stops, diag);
          data[i] = col[0];
          data[i + 1] = col[1];
          data[i + 2] = col[2];
          data[i + 3] = q * 255;
        } else {
          data[i + 3] = 0;
        }
      }
    }
  }
}

/** The JarheadMark's sheen: a paper disc at `alpha`, radius `r`, centred at (cx, cy), flat (BrandMarks.swift:446-466). */
export function paintPaperDisc(img: OrbImage, cx: number, cy: number, r: number, alpha: number): void {
  const { width: W, height: H, data } = img;
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > r) continue;
      const i = (y * W + x) * 4;
      if (data[i + 3]! === 0) continue;
      data[i] = data[i]! + (255 - data[i]!) * alpha;
      data[i + 1] = data[i + 1]! + (255 - data[i + 1]!) * alpha;
      data[i + 2] = data[i + 2]! + (255 - data[i + 2]!) * alpha;
    }
  }
}

interface RenderOrbOptions {
  size: number;
  cell: number;
  face: Face;
  stops?: Stops;
  /** An opaque ground behind the disc (with the icon glow); omit for a transparent image. */
  ground?: RGB | null;
  /** The disc radius in px; default size / 2 (a disc filling the box) or size / 2.8 when a halo is drawn (the blob's proportions). */
  radius?: number;
  /** The blob's halo (the still PNG); omit for the icon glow. */
  halo?: Halo | null;
}

/** The contract: a square ImageData of `size` with the orb; used by Mark, OrbField, the still PNG and the OG field. */
export function renderOrb(o: RenderOrbOptions): ImageData {
  const img = makeImage(o.size, o.size);
  const R = o.radius ?? (o.halo ? o.size / 2.8 : o.size / 2);
  if (o.ground) {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = o.ground[0];
      d[i + 1] = o.ground[1];
      d[i + 2] = o.ground[2];
      d[i + 3] = 255;
    }
  }
  paintOrb(img, { cx: o.size / 2, cy: o.size / 2, R, cell: o.cell, face: o.face, stops: o.stops, ground: o.ground ?? null, halo: o.halo ?? null });
  return img;
}

// ---- a minimal PNG writer for inline data URIs: stored deflate blocks in the browser, a real zlib stream when the server passes one ----

let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(v: number): number[] {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

function chunk(type: string, body: number[] | Uint8Array): number[] {
  const t = [...type].map((ch) => ch.charCodeAt(0));
  const tb = new Uint8Array(t.length + body.length);
  tb.set(t, 0);
  tb.set(body, t.length);
  return [...u32(body.length), ...tb, ...u32(crc32(tb))];
}

/** The PNG's raw scanlines: a zero filter byte, then the row's RGBA. */
function scanlines(img: OrbImage): Uint8Array {
  const { width, height, data } = img;
  const stride = width * 4 + 1;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  return raw;
}

/** A zlib stream of `raw` in stored (uncompressed) deflate blocks: no compressor needed, so it runs in the browser too. */
function storedZlib(raw: Uint8Array): Uint8Array {
  const blocks: number[] = [0x78, 0x01];
  for (let off = 0; off < raw.length || off === 0; off += 65535) {
    const end = Math.min(raw.length, off + 65535);
    const len = end - off;
    blocks.push(end >= raw.length ? 1 : 0, len & 255, (len >> 8) & 255, ~len & 255, (~len >> 8) & 255, ...raw.subarray(off, end));
    if (end >= raw.length) break;
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]!) % 65521;
    b = (b + a) % 65521;
  }
  blocks.push(...u32(((b << 16) | a) >>> 0));
  return Uint8Array.from(blocks);
}

/** A zlib compressor: raw bytes in, a zlib stream (header, deflate blocks, Adler-32) out. Node's `zlib.deflateSync` is one. */
type Zlib = (raw: Uint8Array) => Uint8Array;

/**
 * RGBA → PNG bytes. With no compressor the IDAT is stored deflate (small images only: a mark, a favicon); a server caller
 * passes a real compressor (`node:zlib` deflateSync) so a 128 px orb inlined in a picture is a few KB, not sixty.
 */
export function encodePng(img: OrbImage, zlib?: Zlib): Uint8Array {
  const raw = scanlines(img);
  const idat = zlib ? zlib(raw) : storedZlib(raw);
  const ihdr = [...u32(img.width), ...u32(img.height), 8, 6, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", ihdr), ...chunk("IDAT", idat), ...chunk("IEND", [])]);
}

export function pngDataUri(img: OrbImage, zlib?: Zlib): string {
  const bytes = encodePng(img, zlib);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  // btoa is global in browsers and in Node 16+; no Buffer, so no client bundle can pull in a polyfill through here.
  return `data:image/png;base64,${btoa(s)}`;
}
