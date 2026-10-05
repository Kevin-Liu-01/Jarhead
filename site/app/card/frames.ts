/**
 * The share pictures, one family: the h1 on one line in Newsreader with the blob as its full stop, lit and sparkling, on
 * the accent dithered up from the foot. The Open Graph card and the GitHub social preview add the glass Install it loves
 * and the site's host at the foot; the README banners are the line alone over a low pool; the README's GIF is the hero's
 * blob over its two-line glass Install, without the line (the banner above it has the line), pressed and let go, light
 * and dark like the banners.
 *
 * Every still is laid out at half its picture's size, captured at 4x and halved by scripts/make-cards.sh, so the blob's
 * 1.5 px cells are a crisp 3 px in the picture and the pool's 2 px cells are 4 px; the GIF is laid out at two thirds and
 * captured at 1.5x.
 * Lengths here are layout px. `t` is how long the scene plays before the capture (ms on the card's clock, ./clock.ts,
 * from the blob's mount), `lit` when what it loves lights up (the key, or a point it looks toward), `seed` its generator:
 * the same three numbers give the same picture every run.
 */
import type { Theme } from "@/lib/theme";

/** The glass Install under the line: the cap's height and width, its label's size, its gap under the line and its inset. */
export interface Key {
  /** `cap`: the mark and the one word. `two`: the hero's two lines (the requirements under Install). */
  readonly kind: "cap" | "two";
  readonly h: number;
  readonly w: number;
  readonly size: number;
  readonly depth: number;
  /** The Apple mark on the cap, as on the page's key (`mark=0` in the query leaves it off). */
  readonly mark: boolean;
  readonly gap: number;
  /** From the line's left edge; null centres the key under the line. */
  readonly dx: number | null;
}

/** The pool: the accent dithered over the ground (lib/field.ts) as a dome from an anchor, and a second light. */
export interface Pool {
  readonly ax: number;
  readonly ay: number;
  readonly r: number;
  readonly peak: number;
  readonly bands: number;
  readonly cell: number;
  /** The fraction of the height, at the foot, over which every light thins to the ground. */
  readonly foot: number;
  /** `key`: a light pooled behind the glass Install at this strength. `low`: a wide ellipse along the foot (half-width, half-height, strength). */
  readonly band: { readonly key: number } | { readonly low: readonly [number, number, number] } | null;
}

export interface Frame {
  readonly id: string;
  readonly w: number;
  readonly h: number;
  readonly theme: Theme;
  /** The h1 on one line with the blob as its full stop; false leaves the blob alone, standing over the key. */
  readonly line: boolean;
  /** The h1's size and weight. */
  readonly fs: number;
  readonly weight: number;
  /** The blob: its disc across, and the mark's margin after the stop (em). */
  readonly disc: number;
  readonly gap: number;
  /** How far the line and the key sit below the frame's middle: the blob rises over the line, so the line sits low. */
  readonly drop: number;
  readonly key: Key | null;
  /** The site's host, small and centred at the foot. */
  readonly url: boolean;
  /** What it loves, lit: the key, or a point this far from its centre (x, y in its own discs). */
  readonly look: "key" | readonly [number, number];
  readonly pool: Pool;
  readonly seed: number;
  readonly t: number;
  readonly lit: number;
}

const LIGHT_POOL: Pool = { ax: 0.5, ay: 1.1, r: 0.44, peak: 0.6, bands: 5, cell: 2, foot: 0, band: { key: 0.42 } };
const DARK_POOL: Pool = { ...LIGHT_POOL, peak: 0.5 };

/** The Open Graph card, 1200 × 630: the line low, the blob over it, the keycap under it, the host at the foot. */
const OG = {
  line: true,
  w: 600,
  h: 315,
  fs: 47,
  weight: 360,
  disc: 128,
  gap: 0.02,
  drop: 20,
  key: { kind: "cap", h: 38, w: 118, size: 14.5, depth: 3, mark: true, gap: 22, dx: null },
  url: true,
  look: "key",
  // picked by eye from seeds 1 to 36 at t 1240, then t 1200 to 1310 (each read straight from `t`: stepping there plays
  // other frames): a round body under a crown of two stars, the left eye's flare just past its peak, the dots diamonds
  seed: 30,
  t: 1280,
  lit: 1000,
} as const satisfies Partial<Frame>;

/** The banner, 1280 × 480 (its PNG 2560 × 960, for Retina): the line alone, the pool low along the foot and thinned to the
 * ground at the very edge. */
const BANNER = {
  line: true,
  w: 640,
  h: 240,
  fs: 52,
  weight: 340,
  disc: 108,
  gap: 0.04,
  drop: 10,
  key: null,
  url: false,
  look: [-1, -0.35],
  // picked from seeds 1 to 30 at t 1240: a round body under a crown of two stars, the left eye flaring
  seed: 30,
  t: 1240,
  lit: 1000,
} as const satisfies Partial<Frame>;
const LOW = { ay: 1.2, r: 0.24, foot: 0.05, band: { low: [300, 88, 0.9] } } as const;

/**
 * The README's GIF, 798 × 315: the hero's blob and its two-line glass Install at half the page's size, the blob standing
 * over the key's middle and no line (the README's banner, just above it, is the line). Laid out at two thirds and captured
 * at 1.5x (scripts/make-cards.sh), so the blob's and the key's 1.5 px cells are whole 2 px cells, as the page draws them on
 * a 1x screen, and nothing is resampled.
 */
const GIF = {
  line: false,
  w: 532,
  h: 210,
  fs: 44,
  weight: 340,
  disc: 83,
  gap: 0.04,
  // barely below the middle: the hop and the stars over its head need the room above
  drop: 4,
  key: { kind: "two", h: 51, w: 229, size: 13.33, depth: 4, mark: true, gap: 16, dx: null },
  url: false,
  look: "key",
  // the banners' seed; the GIF's poster (scripts/make-cards.sh POSTER) is its frame 77, both stars of a burst whole
  seed: 30,
  t: 2200,
  lit: 1000,
} as const satisfies Partial<Frame>;
/**
 * The GIF's pool, in both themes: a dome from below the foot, its cells whole 8 px at the GIF's 1.5x, no second light,
 * thinned to the ground at the very edge as the banners' are, so the plate ends on paper.
 */
const GIF_POOL = { ay: 1.25, r: 0.4, cell: 8 / 3, foot: LOW.foot, band: null } as const;

export const FRAMES: Readonly<Record<string, Frame>> = {
  "og-light": { id: "og-light", theme: "light", ...OG, pool: LIGHT_POOL },
  "og-dark": { id: "og-dark", theme: "dark", ...OG, pool: DARK_POOL },
  social: { id: "social", theme: "light", ...OG, w: 640, h: 320, pool: LIGHT_POOL },
  "banner-light": { id: "banner-light", theme: "light", ...BANNER, pool: { ...LIGHT_POOL, ...LOW, peak: 0.64 } },
  "banner-dark": { id: "banner-dark", theme: "dark", ...BANNER, pool: { ...DARK_POOL, ...LOW, peak: 0.52 } },
  gif: { id: "gif", theme: "light", ...GIF, pool: { ...LIGHT_POOL, ...GIF_POOL, peak: 0.64 } },
  "gif-dark": { id: "gif-dark", theme: "dark", ...GIF, pool: { ...DARK_POOL, ...GIF_POOL, peak: 0.64 } },
};

/**
 * A frame with any of its numbers taken from the query instead, for tuning by eye: `line` (1 or 0), `fs`, `weight`, `disc`,
 * `gap`, `drop`, `seed`, `t`, `lit`, the key's `kh`, `kw`, `ks`, `kg`, `kx` (`c` centres it; `key=0` drops it), `mark` (1 or 0), `url` (1 or 0), `look` (`x,y` or `key`) and
 * the pool's `ax`, `ay`, `r`, `peak`, `bands`, `cell`, `foot`, `band` (the key's strength).
 */
export function tuned(f: Frame, q: Readonly<Record<string, string | undefined>>): Frame {
  const n = (k: string, v: number): number => {
    const s = q[k];
    return s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : v;
  };
  const lk = q["look"];
  const xy = lk?.split(",").map(Number);
  const look: Frame["look"] = lk === "key" ? "key" : xy?.length === 2 && xy.every(Number.isFinite) ? [xy[0]!, xy[1]!] : f.look;
  const k = f.key;
  const p = f.pool;
  const band = p.band && "key" in p.band ? { key: n("band", p.band.key) } : p.band;
  return {
    ...f,
    line: q["line"] === undefined ? f.line : q["line"] === "1",
    fs: n("fs", f.fs),
    weight: n("weight", f.weight),
    disc: n("disc", f.disc),
    gap: n("gap", f.gap),
    drop: n("drop", f.drop),
    seed: n("seed", f.seed),
    t: n("t", f.t),
    lit: n("lit", f.lit),
    url: q["url"] === undefined ? f.url : q["url"] === "1",
    look,
    key: !k || q["key"] === "0" ? null : { ...k, h: n("kh", k.h), w: n("kw", k.w), size: n("ks", k.size), mark: q["mark"] === undefined ? k.mark : q["mark"] === "1", gap: n("kg", k.gap), dx: q["kx"] === undefined ? k.dx : q["kx"] === "c" ? null : n("kx", 0) },
    pool: { ...p, ax: n("ax", p.ax), ay: n("ay", p.ay), r: n("r", p.r), peak: n("peak", p.peak), bands: n("bands", p.bands), cell: n("cell", p.cell), foot: n("foot", p.foot), band },
  };
}
