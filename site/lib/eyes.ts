/**
 * The blob's eyes, dithered: ink ovals that catch the light as a four-point star and a small dot, and a small vocabulary
 * of lines for the faces that close them, every shape rasterised in the cells of the world it sits on (1.5 CSS px on the
 * live blob, the island's 1.5 island px on screen, the still's 3 px) with the 8×8 Bayer tile deciding each edge cell and
 * the light round the star. So the eyes are part of the same dithered picture as the body and the island's ink, never
 * smooth vector shapes laid over it. One geometry in R units (the disc's radius) and one rasteriser for the live blob
 * (lib/blob.ts), the still orb (lib/orb.ts), the island's face (components/desk/Island.tsx) and the app (Eyes.swift, the
 * same numbers cell for cell).
 *
 * The face pairs the engine uses, one glyph per eye: `O` open, `o` small open, `-` closed (a soft sag), `^` happy (an
 * arc), `u` content (a cup), `_` flat, `x` error, `>` `<` squeezed shut (each points at the middle), `~` wavy (a thin
 * dream of a ripple, a little wider than the lid). Asleep the eyes are shut lids, `- -`, turning `~ ~` at the top of a
 * breath (SLEEP), wherever they are drawn: the blob, the island, the app's peek and lip. Cute is low, close and round:
 * the eyes sit just above the body's middle, a little over half a radius apart, taller than wide. Small blobs (a disc
 * under 52 px) draw their eyes a little larger and their lines never under 1.75 px.
 *
 * The tones (TONE), one a cell: the ink; the paper of the catchlights; the glow, the star's light dithered into the pupil
 * round it (between the ink and the paper: a consumer mixes it from the ink and the phase's tone); and on a dark ground the
 * rim, the phase-tinted paper, which on the island and the app's notch ramps (`ramp`) through the tile to a foot of the
 * phase's own tone, so the rim is lit from above as the body is.
 *
 * On the grid (faceCells): each eye's centre is snapped to a grid corner, the pair together (their distance a whole
 * number of cells), and each eye is dithered in its own space (the Bayer tile anchored at that corner and mirrored about
 * it, so an eye's two sides match), so an eye that moves moves whole and never crawls; a face that hovers on a cell's edge
 * holds its cell (FaceHold) until it is HOLD of a cell past it, so a wobble never flicks it to and fro. The catchlights'
 * centres snap to cell centres, each on its own tile folded about its middle, so a dot is a cell or a plus and a star's
 * arms pair up. The ovals' radii and the lines' widths are whole cells and a line's straight run sits on the cells, so
 * the edges the tile decides are only the curved ones; a large oval's diagonal edges take a wider band, so it reads round,
 * never as an octagon. A cell's coverage is the share of its area the shape covers, held against the tile's threshold.
 * The middle of every catchlight is always lit, a star's spine along its arms once one reaches DITHER.cross cells (a
 * plus at least, never a dash), and a line's centre always inked, so the smallest face keeps its marks whole. At rest every
 * catchlight keeps to its pupil's inner cells (the fit): its spines first, then its arms a quarter cell shorter at a time
 * until it does, and in a pupil too small for even its middle the star steps a cell toward the pupil's middle, so no light
 * ever nicks the pupil's edge. On a dark ground the ink wears a rim:
 * whole rings of cells round the ink, `rim` px rounded to cells and one at least; a catchlight that flares out over the
 * rim is parted from it by a cell of ink. Lit (a ground that is always dark: the island, the app's notch), the lines are
 * drawn in that paper itself and only the pupils are ink, so a sleeping face reads as two light lids, not as the hollow
 * outlines an inked line's rim would leave on the black; a blink's shut lid stays ink in its rim, so a blink never flashes.
 *
 * The sparkle: each open eye's catchlights are a star toward the gleam (upper left) and a dot across from it, inside the
 * pupil. On a pupil GLOW.bloom.cells tall or more the star blooms: its light falls off into the pupil through the tile
 * (the glow tone), brighter lit and through a flare, never within GLOW.bloom.inset cells of the pupil's edge. The live
 * blob and the island breathe the catchlights in size (`twinkle`: the star swells as the dot ebbs) and now and then a star
 * flares (`flare`, TWINKLE): it twists, turns upright and stretches into a long glint whose top arm reaches out past the
 * pupil, bursting there into a four-point star of cells (GLOW.burst) that thins tips first through the tile as the flare
 * falls, while the dot gives way. Lit (starstruck), the dot turns into a small star of its own. The happy arcs (`^ ^`)
 * wear a sparkle of their own off the right eye's outer top, a small star and a dot that pop in as the face appears
 * (`spark`) and pulse with each flare, bursting the same way. A catchlight under MIN_CELL of a cell at its resting size is
 * left out. Pure: no DOM.
 */
import { BAYER8, clamp01 } from "./dither";

export type EyeKind = "open" | "small" | "closed" | "happy" | "content" | "flat" | "error" | "in" | "wavy";

const KIND: Readonly<Record<string, EyeKind>> = {
  O: "open",
  o: "small",
  "-": "closed",
  "^": "happy",
  u: "content",
  _: "flat",
  x: "error",
  ">": "in",
  "<": "in",
  "~": "wavy",
};

/** The eye a glyph names; anything unknown is closed. */
export function eyeOf(ch: string | undefined): EyeKind {
  return (ch && KIND[ch]) || "closed";
}

/** The face in R units. `row` is the eyes' centre line from the body's middle (negative is up), scaled by the squash. */
export const EYES = {
  row: -0.06,
  spread: 0.31,
  /** How far the face travels with the look (sideways, up and down): a glance moves the eyes, not only their aim. */
  look: [0.19, 0.13],
  open: { rx: 0.146, ry: 0.188 },
  small: { rx: 0.104, ry: 0.132 },
  /**
   * The catchlights, their centres as fractions of the eye's radii. The star sits up and toward the light (upper left),
   * its arms `ax` across and `ay` up and down in R units, its sides four parabolas (a quadratic from tip to tip, the control
   * pulled `full` of an arm out from the middle, so the middle stays round and bright); the dot sits low across from it.
   */
  star: { x: -0.25, y: -0.32, ax: 0.088, ay: 0.118, full: 0.18 },
  dot: { x: 0.4, y: 0.44, r: 0.034 },
  /** Starstruck (lit): the dot becomes a small star, its arms these times its radius across and up and down. */
  struck: { ax: 1.1, ay: 1.55 },
  /**
   * A flare at its peak: the star's arms reach this much further across and up and down, its sides pulled in to `sharp`
   * (a long thin glint), and on the way up it twists out by `spin` rad and back, upright at its peak. On a pupil under
   * GLOW.bloom.cells cells tall a glint would split the pupil (a stem through it, a cross over it): there a flare only
   * swells the resting star by `swell`, kept inside the pupil, a twinkle, never a glint.
   */
  flare: { ax: 0.1, ay: 0.8, sharp: 0.12, spin: 0.45, swell: 0.35 },
  /**
   * Where the eyes look within themselves (FacePose `gaze`): the catchlights move this much of the pupil's radii toward
   * it, kept inside the pupil, so a face with no room to move (the app's lip) still glances.
   */
  gaze: 0.45,
  /** How far a catchlight's tips may reach toward the pupil's edge (a fraction of its radii): only a flare goes past it. */
  fit: 0.96,
  /**
   * The happy arcs' own sparkle, off the right eye's outer top, from that eye's centre in R units: a small star (`a` its
   * arms up and down, three quarters of that across) and a dot up and in from it, over the arc.
   */
  glee: { x: 0.24, y: -0.18, a: 0.108, dot: { x: 0.1, y: -0.32, r: 0.032 } },
  /** The lines' half width and weight. */
  half: 0.12,
  stroke: 0.088,
  /** The happy arc's weight over the other lines': joy draws a little bolder. */
  joy: 1.12,
  /**
   * The happy arc and the content cup: a circle's radius and how far its centre sits below (happy) or above (content).
   * The cup is deep (a U at a glance) and the lid nearly flat (a soft line), so content and asleep never read alike.
   */
  arc: { r: 0.128, drop: 0.07, sweep: 0.4 },
  cup: { r: 0.112, lift: 0.07, sweep: 0.46 },
  /**
   * The closed lid: its ends a touch above the eye's line and its middle sagging below it (a quadratic's control). A lid
   * under `small` cells across is drawn level on the cells, its ends on its top row and its middle a row lower (a lid,
   * never the content cup's walls).
   */
  lid: { ends: -0.008, sag: 0.035, small: 10 },
  /**
   * The sleepy `~`: one ripple `span` times the lid's half width either side (a little wider than the lid, so it waves a
   * cell at a time), `amp` deep (half a cell at least), its line `weight` of the lid's: a dream, never a lumpy cloud.
   */
  dream: { amp: 0.03, span: 1.2, weight: 0.4 },
  /** A blink reopening past round stretches the oval this much taller per unit of overshoot, at most `max`. */
  stretch: { k: 0.8, max: 0.1 },
} as const;

/**
 * The light in cells.
 *  - `bloom`: on a pupil at least `cells` cells tall, the star's light in the glow tone round it, a scatter through the
 *    eye's tile: `amp` of the cells within `from` of its arms (the star's own oval, its arms its radii) falling as
 *    (1 − t)² to none at `reach` of them, `lit` brighter lit and `flare` more at a flare's peak, and never within `inset`
 *    cells of the pupil's edge, so the pupil's outline stays whole.
 *  - `burst`: a flare's glint bursts at its top tip into a four-point star of cells, `arm` R·k up and down at the peak and
 *    `across` of that sideways, its middle cross always lit and its arms a scatter through its own folded tile that thins
 *    tips first as the flare falls; none under `cells` cells of arm. The happy sparkle bursts round its star the same way,
 *    `glee` times its arms.
 */
export const GLOW = {
  bloom: { cells: 9, inset: 1.5, from: 0.6, reach: 1.8, amp: 0.8, lit: 0.3, flare: 0.6 },
  burst: { arm: 0.2, across: 0.8, glee: 1.3, cells: 2.5 },
} as const;

/**
 * The raster (faceCells), in cells: a cell's coverage is the share of its area a shape covers (`samples`² points across an
 * edge cell); the middle `edge` of that range is stretched over the Bayer threshold (coverage under 0.5 − edge / 2 is
 * never inked, over 0.5 + edge / 2 always), so only the cells the edge truly splits are dithered and no lone cell of ink
 * stands off an eye; an oval at least `round` cells across takes the wider `corner` band where its edge runs diagonal, so
 * its corners round off through the tile (a smaller one keeps the edge band: on the wide band a pupil six cells across
 * lost its top corners and kept its square sides, a battery, never an eye); a star's spine is always lit once an arm reaches `cross` cells (upright within
 * `upright` rad), out to `spine` of a cell short of its tips; a round dot under `dot` cells lights no corner cell; a
 * diagonal is drawn `lean` of a cell under its whole width, so the cells beside its steps (half covered at full width)
 * stay clear and its staircase is clean; the fit shortens a catchlight's arms `fit` of a cell at a time; a catchlight's
 * arms and how much of them shows are held to 1/`quant` of a cell and 1/64, so a breath steps and a face that only moves
 * is drawn from the eye's cache (its ink, its fit and its lights kept apart, so a breath re-draws only the light).
 */
export const DITHER = { samples: 4, edge: 0.4, corner: 0.8, diag: 0.38, round: 9, cross: 2, upright: 0.2, dot: 1.6, lean: 0.3, quant: 8, fit: 0.25, spine: 0.75 } as const;

/**
 * The rim's ramp (`ramp`): over the rim's rows (0 its top, 1 its foot), tilted `tilt` toward the side away from the light,
 * a rim cell is the rim's paper while the ramp is under `from`, the foot's tone past `to`, dithered between on the eye's tile.
 * A lit line ramps the same way over its own rows, later (`lineFrom` to `lineTo`): its top row stays paper and its lowest
 * takes the foot, so a lid reads lit from above, never a tinted smear (the wavy `~` stays plain: it is one cell thin).
 */
export const RAMP = { from: 0.16, to: 0.68, tilt: 0.12, lineFrom: 0.35, lineTo: 0.85 } as const;

/** How far (in cells) a face's place may stray from the cell it holds before it hops (FaceHold). */
export const HOLD = 0.75;

/** The smallest catchlight drawn, in cells at its resting size (a star's arm across, a dot's radius): under it, none. */
export const MIN_CELL = 0.3;

/**
 * Asleep, the lids turn wavy at the top of a breath: `~ ~` from `from` to `to` s of every `period` s (lib/blob.ts and the
 * island's face share it; the app's BlobField turns them on its own breath).
 */
export const SLEEP = { period: 8, from: 3.2, to: 4.8 } as const;

/** The sleeping face at `t` s: shut lids, wavy at the top of a breath. `gap` goes between the glyphs (the island's is a space). */
export function asleepPair(t: number, gap = ""): string {
  const b = ((t % SLEEP.period) + SLEEP.period) % SLEEP.period;
  return b > SLEEP.from && b < SLEEP.to ? `~${gap}~` : `-${gap}-`;
}

/**
 * The sparkle's timing in s, shared by the live blob and the island: the catchlights' breath (`period`); a flare's life,
 * where its peak falls in it, and how far the second eye trails the first; the wait between flares on the hero (`rest`),
 * on every other face (`demo`) and while lit, each a base and a random spread; never two on one face within `gap`, nor
 * two faces on the page within `page`; a flare `wake` after the eyes open from a closed face; the happy sparkle's `pop`.
 */
export const TWINKLE = {
  period: 3.2,
  flare: 0.38,
  peak: 0.35,
  lag: 0.09,
  rest: [2, 2.6],
  demo: [3, 3],
  lit: [1.1, 0.8],
  gap: 0.5,
  page: 0.6,
  wake: 0.32,
  pop: 0.32,
} as const;

/** A flare's reach over its life `u` (0 to 1): up fast (out-cubic) to its peak at TWINKLE.peak, then down (in-quad); 0 outside. */
export function flareSize(u: number): number {
  if (!(u > 0 && u < 1)) return 0;
  if (u < TWINKLE.peak) {
    const v = 1 - u / TWINKLE.peak;
    return 1 - v * v * v;
  }
  const v = (u - TWINKLE.peak) / (1 - TWINKLE.peak);
  return 1 - v * v;
}

/** A flare's twist over its life (rad): out and back on the way up, so it turns upright at its peak; none on the way down. */
function flareTwist(u: number): number {
  return u > 0 && u < TWINKLE.peak ? EYES.flare.spin * Math.sin(Math.PI * flareSize(u)) : 0;
}

/** The happy sparkle's pop over `u` (0 to 1): from nothing past its size by a fifth (out-back), settling at 1. */
export function popSize(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const c = 2.4;
  const v = u - 1;
  return 1 + (c + 1) * v * v * v + c * v * v;
}

/** A small blob's eyes grow, up to 40 % at a disc of 32 px (R = 16), so a small face stays all eyes; full size from R = 34. */
export function eyeScale(R: number): number {
  const u = (34 - R) / 18;
  return 1 + 0.4 * (u < 0 ? 0 : u > 1 ? 1 : u);
}

/** The line weight in px: proportional, never under 1.75 px. */
export function eyeStroke(R: number): number {
  return Math.max(1.75, EYES.stroke * R * eyeScale(R));
}

export interface FacePose {
  /** The lids: 1 open, 0 shut (a blink squashes the oval and drops its top); past 1 the eye stretches as it reopens. */
  readonly open: number;
  /** 0 to 1: the eyes light up (a touch larger, the star as large as its pupil holds it, the dot starstruck). */
  readonly sparkle: number;
  /** The look's sideways part, -1 to 1: the face turns, the far eye narrows. */
  readonly turn: number;
  /** The catchlights' breath, 0 to 1: at 1 the star is largest and the dot smallest. Absent (a still), both rest whole. */
  readonly twinkle?: number;
  /** Each eye's flare (left, right): how far through its life (flareSize), none outside 0 to 1. Absent, none. */
  readonly flare?: readonly [number, number];
  /** The happy sparkle's size: 1 at rest, past 1 in a pop or a pulse, 0 hides it. Absent, 1. */
  readonly spark?: number;
  /** Where the eyes look within themselves, -1 to 1 each way (EYES.gaze): the catchlights move toward it. Absent, ahead. */
  readonly gaze?: readonly [number, number];
}

export const REST: FacePose = { open: 1, sparkle: 0, turn: 0 };

/** The grid a face is drawn on: its cell, and where cell (0, 0)'s top-left corner sits, in the face's own px. */
export interface FaceGrid {
  readonly cell: number;
  readonly x: number;
  readonly y: number;
}

/**
 * A cell's tone, in the order a face overlaps itself: none (the ground shows), the rim's foot, the rim, the ink, the
 * star's glow on the pupil, the paper of a catchlight.
 */
export const TONE = { none: 0, foot: 1, rim: 2, ink: 3, glow: 4, light: 5 } as const;

/** A face on the grid: the box it covers (its first column and row in grid cells, its size in cells) and one TONE per cell, row-major. */
export interface FaceCells {
  readonly col: number;
  readonly row: number;
  readonly w: number;
  readonly h: number;
  readonly tone: Uint8Array;
}

/**
 * How a face is drawn on its ground: `rim` px of rim round the ink (0: none, the blob's body is its own contrast); `lit`,
 * its lines in the rim's paper (a ground that is always dark); `ramp`, its rim ramping to the foot's tone (RAMP); `hold`,
 * the cell it keeps while it moves.
 */
export interface FaceStyle {
  readonly rim?: number;
  readonly lit?: boolean;
  readonly ramp?: boolean;
  readonly hold?: FaceHold;
}

/**
 * The cell a moving face keeps: its pair's corner and spread hop to the nearest only once the place asked for is HOLD of
 * a cell away from the one held, so a face hovering on a cell's edge (the body's wobble, a pointer's look) never flicks a
 * cell to and fro, and a monotonic move still steps a cell at a time. One per face that moves (the live blob, the island).
 */
export class FaceHold {
  private col = Number.NaN;
  private row = Number.NaN;
  private d = Number.NaN;

  /** The pair's spread in whole cells for `v` cells asked for. */
  spread(v: number): number {
    if (!(Math.abs(v - this.d) <= HOLD)) this.d = Math.max(1, Math.round(v));
    return this.d;
  }

  /** The corner held for a left eye asked to sit at (u, v) cells. */
  at(u: number, v: number): readonly [number, number] {
    if (!(Math.abs(u - this.col) <= HOLD)) this.col = Math.round(u);
    if (!(Math.abs(v - this.row) <= HOLD)) this.row = Math.round(v);
    return [this.col, this.row];
  }

  /** Forget the held cell (a new grid): the next place is taken as it is. */
  reset(): void {
    this.col = Number.NaN;
    this.row = Number.NaN;
    this.d = Number.NaN;
  }
}

// ---- the shapes of one eye, in its own px (its centre at 0, 0, y down) ----

/**
 * An ink shape: a filled oval, or a stroked polyline (round caps and joins) of width `w`; `keep` keeps a line in ink even
 * lit (a blink's shut lid: an open eye in its rim, closing, never a lit flash); `plain`, a lit line never ramped (the `~`).
 */
type Ink =
  | { readonly oval: true; readonly rx: number; readonly ry: number; readonly y: number }
  | { readonly oval: false; readonly pts: readonly number[]; readonly w: number; readonly keep: boolean; readonly plain?: boolean };
type Line = Extract<Ink, { readonly oval: false }>;

/**
 * A light as asked for: its centre (x, y) on a cell centre; its arms at rest (`ax` across, `ay` up and down; a dot's
 * radius both), of which `k` shows now (the breath, the lids, a pop) and a flare stretches by (`sx`, `sy`); its sides'
 * control now and at rest (`full`, `full0`), its turn; a round `dot`; `fit`, kept to its pupil's inner cells; the
 * `bloom`'s strength round it on its pupil (0: none); a `burst` of `arm` px at its top tip (`tip`) or its middle, `bf`
 * through its life.
 */
interface Light {
  readonly x: number;
  readonly y: number;
  readonly ax: number;
  readonly ay: number;
  readonly k: number;
  readonly sx: number;
  readonly sy: number;
  readonly full: number;
  readonly full0: number;
  readonly rot: number;
  readonly dot: boolean;
  readonly fit: boolean;
  readonly bloom: number;
  readonly burst: number;
  readonly bf: number;
  readonly tip: boolean;
}

const TAU = Math.PI * 2;
/** The star outline's control (`full`) that draws a circle to within a few percent: the dot's shape before it is starstruck. */
const ROUND = 0.914;

/** The largest arms [across, up and down] a star centred at (X, Y) (fractions of a pupil's radii rx, ry) has inside the pupil. */
function fitArms(rx: number, ry: number, X: number, Y: number): readonly [number, number] {
  const m = EYES.fit * EYES.fit;
  return [rx * (Math.sqrt(Math.max(0, m - Y * Y)) - Math.abs(X)), ry * (Math.sqrt(Math.max(0, m - X * X)) - Math.abs(Y))];
}

/** A cell centre near `v` (px), the eye's centre being a grid corner: catchlights snap there, so a dot is a cell and a star has a middle. */
function snapMid(v: number, c: number): number {
  return (Math.floor(v / c) + 0.5) * c;
}

/** `v` held to 1/`n` of its unit `u`: the steps a breathing size takes. */
function step(v: number, u: number, n: number): number {
  return (Math.round((v / u) * n) / n) * u;
}

/** A quadratic from (x0, y0) through the control (qx, qy) to (x1, y1), as a polyline of `n` steps. */
function quad(x0: number, y0: number, qx: number, qy: number, x1: number, y1: number, n = 12): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push(u * u * x0 + 2 * u * t * qx + t * t * x1, u * u * y0 + 2 * u * t * qy + t * t * y1);
  }
  return pts;
}

/** An arc of an ellipse (clockwise on screen, y down, from a0 to a1) as a polyline. */
function arcPts(x: number, y: number, rx: number, ry: number, a0: number, a1: number, n = 16): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push(x + rx * Math.cos(a), y + ry * Math.sin(a));
  }
  return pts;
}

/** A whole number of cells near `v` px (at least `least`), in px: the pixel art's sizes. */
function cells(v: number, c: number, least = 1): number {
  return Math.max(least, Math.round(v / c)) * c;
}

/** The most cells wide a diagonal reaching `n` cells each way may be drawn: about a third of its span, so its arms stay apart. */
function diagonal(n: number): number {
  return Math.max(1, Math.floor((2 * n + 1) / 3));
}

/**
 * A stroked line as the grid draws it: its width a whole number of cells, and the whole line moved (by under a cell) so
 * that its point (rx, ry) sits on a cell centre when that number is odd, on a cell edge when it is even. A straight run
 * through that point then has its edges on cell edges (crisp), and only its curved parts have edge cells for the Bayer
 * tile to decide; never a straight edge split down the middle of its cells, which would dither the whole run.
 */
function stroke(pts: number[], w: number, c: number, ry: number, rx?: number, keep = false): Line {
  const n = Math.max(1, Math.round(w / c));
  const at = (v: number): number => (n % 2 ? (Math.floor(v / c) + 0.5) * c : Math.round(v / c) * c) - v;
  const dy = at(ry);
  const dx = rx === undefined ? 0 : at(rx);
  return { oval: false, pts: pts.map((v, i) => v + (i % 2 ? dy : dx)), w: n * c, keep };
}

/**
 * The closed lid, `w` either side of the eye's middle: a soft sag, its middle lower than its ends by EYES.lid in whole
 * cells, and by one cell at least once the lid spans three, so a sleeping face is curved (˘ ˘) at every size, never flat
 * dashes. Under EYES.lid.small cells across the curve's raised ends would read as the content cup's walls, so a small
 * lid is laid on the cells: its line level across its whole span (one row less than the line is wide, one at least), and
 * under it a row inset a cell each side, so its middle hangs lowest (`######` over `.####.`). `keep`: a blink's, inked
 * even lit.
 */
function lid(w: number, Rk: number, lw: number, c: number, keep = false): Ink[] {
  const mid = ((EYES.lid.ends + EYES.lid.sag) / 2) * Rk;
  const n = Math.max(1, Math.round(lw / c));
  // its half span in cells: the line's ends and caps, as the curve would reach
  const m = Math.max(2, Math.round((w + (n * c) / 2) / c));
  if (2 * m >= EYES.lid.small) {
    const dip = cells(((EYES.lid.sag - EYES.lid.ends) / 2) * Rk, c, 2 * w >= 3 * c ? 1 : 0);
    return [stroke(quad(-w, mid - dip, 0, mid + dip, w, mid - dip), lw, c, mid, undefined, keep)];
  }
  // the rows, centred on the lid's line: the level run (its ends' cells centred on the span's end cells), then the sag
  const rows = Math.max(2, n);
  const r0 = Math.round(mid / c - rows / 2);
  const top = rows - 1;
  const yb = (r0 + top / 2) * c;
  const ys = (r0 + top + 0.5) * c;
  const xe = (m - 0.5) * c;
  return [
    { oval: false, pts: [-xe, yb, xe, yb], w: top * c, keep },
    { oval: false, pts: [-(xe - c), ys, xe - c, ys], w: c, keep },
  ];
}

/**
 * One eye's shapes (its centre at 0, 0): the kind on side `side` (-1 the left eye) of a body of radius R, posed, on a grid
 * of cell `c` (the catchlights snap to its cells and one under MIN_CELL of a cell at rest is left out).
 */
function eyeShapes(kind: EyeKind, side: number, R: number, pose: FacePose, c: number, ink: Ink[], light: Light[]): void {
  const k = eyeScale(R);
  const Rk = R * k;
  const lw = eyeStroke(R);
  const far = Math.max(0, -side * pose.turn);
  const narrow = 1 - 0.14 * far;
  if (kind === "open" || kind === "small") {
    const o = pose.open < 0 ? 0 : pose.open > 1 ? 1 : pose.open;
    const shape = kind === "open" ? EYES.open : EYES.small;
    const grow = 1 + 0.08 * pose.sparkle;
    const rx = shape.rx * Rk * narrow * grow;
    const ry = shape.ry * Rk * grow;
    if (o < 0.22) {
      // shut: the closed lid, as wide as the open eye, in ink within its rim (the oval's own, closed)
      ink.push(...lid(rx * 1.05, Rk, lw, c, true));
      return;
    }
    // the blink: the oval squashes, widens a little, and its top comes down; reopening, it overshoots a touch taller
    // and narrower, then settles (the lids are a spring in lib/blob.ts). Its radii and its drop are whole cells, so its
    // silhouette is the grid's own oval (the sides and the top and bottom runs crisp) and a blink steps a row at a time.
    const over = pose.open > 1 ? Math.min(EYES.stretch.max, (pose.open - 1) * EYES.stretch.k) : 0;
    const rxo = cells(rx * (1 + 0.18 * (1 - o)) * (1 - 0.4 * over), c);
    // open, it stays taller than wide however the radii round
    const ryo = Math.max(cells(ry * o * (1 + over), c), o > 0.9 ? rxo + c : c);
    const yo = cells((ry - ryo) * 0.35, c, 0);
    ink.push({ oval: true, rx: rxo, ry: ryo, y: yo });
    // the catchlights come back as the lids open
    if (o > 0.5) catchlights(rxo, ryo, yo, Rk * (kind === "small" ? 0.8 : 1), (o - 0.5) * 2, narrow, pose, side, c, light);
    return;
  }
  const w = EYES.half * Rk * narrow;
  switch (kind) {
    case "closed":
      ink.push(...lid(w, Rk, lw, c));
      return;
    case "happy": {
      const r = EYES.arc.r * Rk;
      const cy = EYES.arc.drop * Rk;
      ink.push(stroke(arcPts(0, cy, r * narrow, r, Math.PI * (1.5 - EYES.arc.sweep), Math.PI * (1.5 + EYES.arc.sweep)), lw * EYES.joy, c, cy - r));
      if (side === 1) glee(Rk, narrow, pose, c, light);
      return;
    }
    case "content": {
      const r = EYES.cup.r * Rk;
      const cy = -EYES.cup.lift * Rk;
      ink.push(stroke(arcPts(0, cy, r * narrow, r, Math.PI * (0.5 - EYES.cup.sweep), Math.PI * (0.5 + EYES.cup.sweep)), lw, c, cy + r));
      return;
    }
    case "flat":
      ink.push(stroke([-w * 0.9, 0.06 * Rk, w * 0.9, 0.06 * Rk], lw, c, 0.06 * Rk));
      return;
    case "error": {
      // on the grid two true diagonals crossing at the eye's centre (a grid corner), through cell centres when they are
      // an odd number of cells wide (through corners when even), never so thick the cross fills in
      const n = Math.max(1, Math.round((0.066 * Rk) / c));
      const W = Math.min(Math.max(1, Math.round(lw / c)), diagonal(n));
      const d = (n + (W % 2) / 2) * c;
      ink.push({ oval: false, pts: [-d, -d, d, d], w: (W - DITHER.lean) * c, keep: false }, { oval: false, pts: [d, -d, -d, d], w: (W - DITHER.lean) * c, keep: false });
      return;
    }
    case "in": {
      // > on the left eye, < on the right: each points at the middle, squeezed shut; on the grid a true 45° chevron n
      // cells each way of its point, its point on a cell centre when it is an odd number of cells wide (on a corner when
      // even), so even the smallest reads as > (three rows), never as a lump
      const dir = -side;
      const n = Math.max(1, Math.round((0.074 * Rk) / c));
      const W = Math.min(Math.max(1, Math.round(lw / c)), diagonal(n));
      const o = (W % 2) / 2;
      const px = (Math.round(n / 2) + o) * dir * c;
      const py = o * c;
      ink.push({ oval: false, pts: [px - dir * n * c, py - n * c, px, py, px - dir * n * c, py + n * c], w: (W - DITHER.lean) * c, keep: false });
      return;
    }
    case "wavy": {
      // the sleepy ripple: one wave a little wider than the lid, thin, swinging half a cell at least each way so it steps a
      // row up and a row down on the cells, its crest on a cell; under EYES.lid.small cells across, where a sampled wave is
      // a step with a stray cell, it is laid on the cells as a pixel tilde on the lid's two rows, the same turned about its
      // middle (`.##..#` over `#..##.`)
      const span = EYES.dream.span * w;
      const m = Math.max(2, Math.round((span + c / 2) / c));
      if (2 * m < EYES.lid.small) {
        const r0 = Math.round((((EYES.lid.ends + EYES.lid.sag) / 2) * Rk) / c - 1);
        const yt = (r0 + 0.5) * c;
        const yb = (r0 + 1.5) * c;
        const at = (i: number): number => (i - m + 0.5) * c;
        const run = (a: number, b: number, y: number): Ink => ({ oval: false, pts: [at(a), y, at(b), y], w: c, keep: false, plain: true });
        ink.push(run(0, 0, yb), run(1, m - 1, yt), run(m, 2 * m - 2, yb), run(2 * m - 1, 2 * m - 1, yt));
        return;
      }
      const amp = Math.max(EYES.dream.amp * Rk, 0.5 * c);
      const pts: number[] = [];
      for (let i = 0; i <= 16; i++) pts.push(-span + (2 * span * i) / 16, amp * Math.sin((i / 16) * TAU));
      ink.push({ ...stroke(pts, lw * EYES.dream.weight, c, -amp), plain: true });
      return;
    }
  }
}

/**
 * An open eye's catchlights on its pupil (radii rx, ry, centred `y` below the eye's centre): the star and the dot, `s`
 * their scale (R·k) and `a` how far the lids have let them back (0 to 1). Lit, the star grows as far as the pupil holds it
 * and the dot turns into a small star; on a tall pupil a flare stretches the star's arms past the pupil, twists it upright
 * at its peak and bursts at its tip, and on a small one only swells it (EYES.flare.swell); the breath trades the star's
 * size for the dot's; a tall pupil blooms round its star; the gaze moves both toward where the eyes look. Each mark's
 * floor is judged at its resting size, so none drops out early in a blink.
 */
function catchlights(rx: number, ry: number, y: number, s: number, a: number, narrow: number, pose: FacePose, side: number, c: number, light: Light[]): void {
  const lit = pose.sparkle;
  const b = pose.twinkle;
  const swell = b === undefined ? 1 : 0.9 + 0.1 * b;
  const ebb = b === undefined ? 1 : 0.9 + 0.1 * (1 - b);
  const u = pose.flare ? (pose.flare[side < 0 ? 0 : 1] ?? 0) : 0;
  const f = flareSize(u);
  // on the grid a pupil under two cells across and four tall keeps no light, one under six across only its star (one
  // cell of light in a small eye reads as its glint; two read as a slash)
  const across = Math.round(rx / c);
  const tall = Math.round(ry / c);
  const B = GLOW.bloom;
  // a pupil tall enough to bloom glints (stretched, twisted, bursting); a smaller one twinkles, its star swelling inside it
  const glints = 2 * ry >= B.cells * c;
  const g = glints ? f : 0;
  // the gaze: the catchlights' centres toward where the eyes look, in fractions of the pupil's radii
  const gx = pose.gaze ? EYES.gaze * pose.gaze[0] : 0;
  const gy = pose.gaze ? EYES.gaze * pose.gaze[1] : 0;
  // the star: narrowed with its eye, fitted inside the pupil, then a flare's reach past it
  const ax0 = EYES.star.ax * s * narrow;
  if (ax0 >= MIN_CELL * c && across >= 1 && tall >= 2) {
    const [mx, my] = fitArms(rx, ry, EYES.star.x + gx, EYES.star.y + gy);
    light.push({
      x: snapMid(rx * (EYES.star.x + gx), c),
      y: snapMid(y + ry * (EYES.star.y + gy), c),
      ax: Math.min(ax0 * (1 + 0.24 * lit), mx),
      ay: Math.min(EYES.star.ay * s * (1 + 0.15 * lit), my),
      k: swell * a * (glints ? 1 : 1 + EYES.flare.swell * f),
      sx: 1 + EYES.flare.ax * g,
      sy: 1 + EYES.flare.ay * g,
      full: EYES.star.full + (EYES.flare.sharp - EYES.star.full) * g,
      full0: EYES.star.full,
      rot: glints ? -side * flareTwist(u) : 0,
      dot: false,
      fit: true,
      bloom: glints ? a * (B.amp * (1 + B.lit * lit) + B.flare * f) : 0,
      burst: GLOW.burst.arm * s * g,
      bf: g,
      tip: true,
    });
  }
  // the dot, starstruck while lit (a circle that sharpens through a diamond into a small star); it gives way to a flare,
  // so the light gathers in the glint and never runs into it (on a small pupil, whose star cannot grow, it goes out for
  // the flare's top: the twinkle shows as the light gathering in the star)
  const r0 = EYES.dot.r * s * (1 + 0.4 * lit);
  if (r0 >= MIN_CELL * c && across >= 3 && (glints || f < 0.5)) {
    const round = lit < 0.02;
    const [mx, my] = fitArms(rx, ry, EYES.dot.x + gx, EYES.dot.y + gy);
    const full = ROUND + (EYES.star.full - ROUND) * lit;
    light.push({
      x: snapMid(rx * (EYES.dot.x + gx), c),
      y: snapMid(y + ry * (EYES.dot.y + gy), c),
      ax: round ? r0 : Math.min(r0 * (1 + (EYES.struck.ax - 1) * lit), mx),
      ay: round ? r0 : Math.min(r0 * (1 + (EYES.struck.ay - 1) * lit), my),
      k: ebb * a * (1 - 0.5 * f),
      sx: 1,
      sy: 1,
      full,
      full0: full,
      rot: 0,
      dot: round,
      fit: true,
      bloom: 0,
      burst: 0,
      bf: 0,
      tip: false,
    });
  }
}

/**
 * The happy arcs' sparkle, beside the right eye (`Rk` its scale): a small star and a dot up and in from it, breathing with
 * the catchlights, popping in and pulsing with each flare (`spark`), the star bursting as it overshoots.
 */
function glee(Rk: number, narrow: number, pose: FacePose, c: number, light: Light[]): void {
  const J = EYES.glee;
  const b = pose.twinkle;
  const swell = b === undefined ? 1 : 0.9 + 0.1 * b;
  const ebb = b === undefined ? 1 : 0.9 + 0.1 * (1 - b);
  const pop = pose.spark ?? 1;
  if (!(pop > 0.02)) return;
  const a = J.a * Rk * (1 + 0.25 * pose.sparkle);
  // the burst: the pop's overshoot and each flare's pulse (spark past 1)
  const f = clamp01((pop - 1) * 2.5);
  const base = { sx: 1, sy: 1, rot: 0, fit: false, bloom: 0, tip: false } as const;
  if (a * 0.75 >= MIN_CELL * c)
    light.push({ ...base, x: snapMid(J.x * Rk * narrow, c), y: snapMid(J.y * Rk, c), ax: a * 0.75, ay: a, k: swell * pop, full: EYES.star.full, full0: EYES.star.full, dot: false, burst: GLOW.burst.glee * J.a * Rk * f, bf: f });
  const r = J.dot.r * Rk;
  if (r >= MIN_CELL * c) light.push({ ...base, x: snapMid(J.dot.x * Rk * narrow, c), y: snapMid(J.dot.y * Rk, c), ax: r, ay: r, k: ebb * pop, full: ROUND, full0: ROUND, dot: true, burst: 0, bf: 0 });
}

// ---- distances (px, negative inside) ----

/** An oval's signed distance to first order (exact near the edge, which is all the raster needs). */
function sdOval(px: number, py: number, rx: number, ry: number): number {
  const u = px / rx;
  const v = py / ry;
  const k = Math.sqrt(u * u + v * v);
  if (k < 1e-6) return -Math.min(rx, ry);
  const gu = px / (rx * rx);
  const gv = py / (ry * ry);
  const g = Math.sqrt(gu * gu + gv * gv) / k;
  return (k - 1) / g;
}

/** The squared distance from (px, py) to a polyline [x0, y0, x1, y1, ...]: roots only where a distance is needed. */
function d2Polyline(px: number, py: number, v: readonly number[]): number {
  if (v.length < 4) {
    const dx = px - (v[0] ?? 0);
    const dy = py - (v[1] ?? 0);
    return dx * dx + dy * dy;
  }
  let d = Infinity;
  for (let i = 0; i + 3 < v.length; i += 2) {
    const ax = v[i]!;
    const ay = v[i + 1]!;
    const ex = v[i + 2]! - ax;
    const ey = v[i + 3]! - ay;
    const wx = px - ax;
    const wy = py - ay;
    const l2 = ex * ex + ey * ey;
    const h = l2 > 0 ? Math.max(0, Math.min(1, (wx * ex + wy * ey) / l2)) : 0;
    const dx = wx - ex * h;
    const dy = wy - ey * h;
    d = Math.min(d, dx * dx + dy * dy);
  }
  return d;
}

// ---- the raster ----

/** One eye on the grid, in its own cells (its centre the corner between cells -1 and 0 each way): its box and tones. */
interface EyeCells {
  readonly i0: number;
  readonly j0: number;
  readonly w: number;
  readonly h: number;
  readonly tone: Uint8Array;
}

/** The chords a star's side is drawn with (a quadratic at cell scale: four keep it within a tenth of a cell of its curve). */
const STAR_STEPS = 4;

const NO_EYE: EyeCells = { i0: 0, j0: 0, w: 0, h: 0, tone: new Uint8Array(0) };

/**
 * How much of the cell centred at (X, Y) (side `c`) lies inside a shape, `d` the shape's signed distance at the centre and
 * `inside` its test at a point: 0 or 1 when the centre is clear of the edge by more than half the cell's diagonal, else
 * the share of DITHER.samples² points inside (its area, near enough), its middle `band` stretched to the whole range.
 */
function cover(d: number, inside: (x: number, y: number) => boolean, X: number, Y: number, c: number, band: number = DITHER.edge): number {
  if (d >= 0.71 * c) return 0;
  if (d <= -0.71 * c) return 1;
  const n = DITHER.samples;
  let hit = 0;
  for (let b = 0; b < n; b++) {
    const y = Y + ((b + 0.5) / n - 0.5) * c;
    for (let a = 0; a < n; a++) if (inside(X + ((a + 0.5) / n - 0.5) * c, y)) hit++;
  }
  return clamp01((hit / (n * n) - 0.5) / band + 0.5);
}

/**
 * A four-point star's outline in its own frame (its centre at 0, 0, unturned), folded into one quadrant: its sides are
 * quadratics from tip to tip through a control `full` of an arm out from the middle, and a side drawn as STAR_STEPS chords
 * is the same chain in every quadrant (the curve is its own mirror across the diagonal), so the star is the points (|u|,
 * |v|) under the chain from (0, ay) to (ax, 0). Its vertices [x0, y0, ..., x4, y4] in px, x rising.
 */
function starProfile(ax: number, ay: number, full: number): Float64Array {
  const prof = new Float64Array(2 * STAR_STEPS + 2);
  for (let i = 0; i <= STAR_STEPS; i++) {
    const t = i / STAR_STEPS;
    const u = 1 - t;
    prof[2 * i] = ax * (2 * u * t * full + t * t);
    prof[2 * i + 1] = ay * (u * u + 2 * u * t * full);
  }
  return prof;
}

/** Whether the point (p, q) (|u|, |v| in the star's frame) is inside the star whose folded outline is `prof`. */
function inStar(p: number, q: number, prof: Float64Array): boolean {
  if (!(p < prof[2 * STAR_STEPS]!)) return false;
  for (let i = 0; i < STAR_STEPS; i++) {
    const x1 = prof[2 * i + 2]!;
    if (p < x1) {
      const x0 = prof[2 * i]!;
      const y0 = prof[2 * i + 1]!;
      const y1 = prof[2 * i + 3]!;
      return q < y0 + ((y1 - y0) * (p - x0)) / (x1 - x0);
    }
  }
  return false;
}

/** The star's signed distance at (p, q) (|u|, |v| in its frame; negative inside): to the nearest chord of its folded outline. */
function sdStar(p: number, q: number, prof: Float64Array): number {
  let d = Infinity;
  for (let i = 0; i < STAR_STEPS; i++) {
    const ax = prof[2 * i]!;
    const ay = prof[2 * i + 1]!;
    const ex = prof[2 * i + 2]! - ax;
    const ey = prof[2 * i + 3]! - ay;
    const wx = p - ax;
    const wy = q - ay;
    const l2 = ex * ex + ey * ey;
    const h = l2 > 0 ? Math.max(0, Math.min(1, (wx * ex + wy * ey) / l2)) : 0;
    const dx = wx - ex * h;
    const dy = wy - ey * h;
    d = Math.min(d, dx * dx + dy * dy);
  }
  return (inStar(p, q, prof) ? -1 : 1) * Math.sqrt(d);
}

/**
 * The cells a light lights at (x, y) with arms `ax`, `ay`, `full`, `rot` (a round `dot`: a circle of radius ax), as grid
 * cells [I, J, I, J, ...]: each cell's coverage held against the light's own tile, folded about its middle cell both ways
 * and across the diagonal (so a star's opposite arms always match); a round dot under DITHER.dot cells keeps its corners
 * dark (a cell or a plus, never a dash or a square); its middle always, and a star's cross once its arms reach
 * DITHER.cross cells upright.
 */
function lightCells(x: number, y: number, ax: number, ay: number, full: number, rot: number, dot: boolean, c: number): readonly number[] {
  const key = `${c}|${x},${y},${ax},${ay},${full},${rot},${dot ? 1 : 0}`;
  const hit = LIGHT_CACHE.get(key);
  if (hit) return hit;
  const got = lightRaster(x, y, ax, ay, full, rot, dot, c);
  if (LIGHT_CACHE.size >= 4 * EYE_CACHE_MAX) LIGHT_CACHE.clear();
  LIGHT_CACHE.set(key, got);
  return got;
}

/** The catchlights' cells lately drawn, by their shape and place (a breath steps through a few sizes again and again). */
const LIGHT_CACHE = new Map<string, readonly number[]>();

function lightRaster(x: number, y: number, ax: number, ay: number, full: number, rot: number, dot: boolean, c: number): number[] {
  const mi = Math.floor(x / c);
  const mj = Math.floor(y / c);
  const r = Math.max(ax, ay);
  const prof = dot ? null : starProfile(ax, ay, full);
  const ax2 = ax * ax;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  // a point in the star's own frame (turned with it), folded into one quadrant
  const inside = prof
    ? (X: number, Y: number): boolean => inStar(Math.abs((X - x) * cs + (Y - y) * sn), Math.abs((Y - y) * cs - (X - x) * sn), prof)
    : (X: number, Y: number): boolean => (X - x) * (X - x) + (Y - y) * (Y - y) < ax2;
  // a cell further than half its diagonal outside the star's box (in its own turned frame), or for a star whose sides
  // bow in (full under a half) outside its diamond, is clear of it: its coverage is none, no distance needed
  const m = 0.71 * c;
  const diamond = !dot && full <= 0.5 && ax > 0 && ay > 0;
  const dn = diamond ? Math.sqrt(1 / ax2 + 1 / (ay * ay)) : 0;
  const out: number[] = [mi, mj];
  const ri = Math.ceil(r / c) + 1;
  for (let J = mj - ri; J <= mj + ri; J++) {
    const dj = Math.abs(J - mj);
    const Y = (J + 0.5) * c;
    for (let I = mi - ri; I <= mi + ri; I++) {
      const di = Math.abs(I - mi);
      if (!di && !dj) continue;
      if (dot && di && dj && r < DITHER.dot * c) continue;
      const X = (I + 0.5) * c;
      const u = Math.abs((X - x) * cs + (Y - y) * sn);
      const v = Math.abs((Y - y) * cs - (X - x) * sn);
      if (u > ax + m || v > ay + m) continue;
      if (diamond && (u / ax + v / ay - 1) / dn > m) continue;
      const d = prof ? sdStar(u, v, prof) : Math.sqrt((X - x) * (X - x) + (Y - y) * (Y - y)) - ax;
      if (cover(d, inside, X, Y, c) > BAYER8[(Math.min(di, dj) & 7) * 8 + (Math.max(di, dj) & 7)]!) out.push(I, J);
    }
  }
  const upright = !dot && Math.abs(rot) < DITHER.upright;
  const add = (I: number, J: number): void => {
    for (let n = 0; n < out.length; n += 2) if (out[n] === I && out[n + 1] === J) return;
    out.push(I, J);
  };
  // a plus at least once both arms reach a cell (the tile may light one arm's cells and not the other's: a dash)
  if (upright && ax >= c && ay >= c) {
    add(mi - 1, mj);
    add(mi + 1, mj);
    add(mi, mj - 1);
    add(mi, mj + 1);
  }
  // its spine: once an arm reaches DITHER.cross cells, the cells along each arm a cell long or more out to DITHER.spine of
  // a cell short of its tips, one at least (a plus, never a dash)
  const cross = upright && Math.max(ax, ay) >= DITHER.cross * c;
  if (cross && ax >= c) {
    for (let n = 1; n <= Math.max(1, Math.floor(ax / c - DITHER.spine)); n++) {
      add(mi - n, mj);
      add(mi + n, mj);
    }
  }
  if (cross && ay >= c) {
    for (let n = 1; n <= Math.max(1, Math.floor(ay / c - DITHER.spine)); n++) {
      add(mi, mj - n);
      add(mi, mj + n);
    }
  }
  return out;
}

/**
 * A burst at cell (bi, bj): a four-point star of cells `arm` px up and down and GLOW.burst.across of that sideways, `f`
 * through its life, its middle cross always lit and its arms a scatter through its own folded tile, thinning toward the
 * tips and as `f` falls; none under GLOW.burst.cells cells of arm. As grid cells [I, J, ...].
 */
function burstCells(bi: number, bj: number, arm: number, f: number, c: number): number[] {
  const A = arm / c;
  const out: number[] = [];
  if (!(A >= GLOW.burst.cells)) return out;
  const B = A * GLOW.burst.across;
  const ra = Math.ceil(A);
  const rb = Math.ceil(B);
  for (let dv = -ra; dv <= ra; dv++) {
    for (let du = -rb; du <= rb; du++) {
      const au = Math.abs(du);
      const av = Math.abs(dv);
      const q = Math.sqrt(au / (B + 0.5)) + Math.sqrt(av / (A + 0.5));
      if (q >= 1) continue;
      const v = au + av <= 1 ? 1 : f * (0.25 + 0.75 * Math.min(1, (1 - q) * 2.4));
      if (v > BAYER8[(Math.min(au, av) & 7) * 8 + (Math.max(au, av) & 7)]!) out.push(bi + du, bj + dv);
    }
  }
  return out;
}

/** Whether any of the eight neighbours of cell (i, j) is set in `m` (only the four beside it, unless `diagonals`). */
function near(m: Uint8Array, w: number, h: number, i: number, j: number, diagonals = true): boolean {
  for (let dj = -1; dj <= 1; dj++) {
    const y = j + dj;
    if (y < 0 || y >= h) continue;
    for (let di = -1; di <= 1; di++) {
      const x = i + di;
      if ((di || dj) && (diagonals || !(di && dj)) && x >= 0 && x < w && m[y * w + x]) return true;
    }
  }
  return false;
}

/** An eye's ink rasterised in its own box (its shapes and rim, a cell of margin each way), every cell's coverage on the eye's tile. */
interface InkRaster {
  readonly i0: number;
  readonly j0: number;
  readonly w: number;
  readonly h: number;
  readonly tone: Uint8Array;
  readonly inside: Uint8Array;
  readonly onOval: Uint8Array;
  readonly lines: Uint8Array;
}

type Oval = { readonly rx: number; readonly ry: number; readonly y: number };
type Stroke = { readonly pts: readonly number[]; readonly w: number; readonly keep: boolean; readonly box: readonly [number, number, number, number] };

const NO_INK: InkRaster = { i0: 0, j0: 0, w: 0, h: 0, tone: new Uint8Array(0), inside: new Uint8Array(0), onOval: new Uint8Array(0), lines: new Uint8Array(0) };

/**
 * The ink: each cell's coverage of the oval and the lines held against the eye's tile (mirrored about its centre), a
 * line's centre always inked; `inkLines` false (lit), the lines are the rim's tone and marked as lines.
 */
function inkRaster(ov: Oval | null, strokes: readonly Stroke[], box: readonly [number, number, number, number], c: number, inkLines: boolean): InkRaster {
  if (!(box[2] > box[0] && box[3] > box[1])) return NO_INK;
  const i0 = Math.floor(box[0] / c) - 1;
  const j0 = Math.floor(box[1] / c) - 1;
  const w = Math.ceil(box[2] / c) + 1 - i0;
  const h = Math.ceil(box[3] / c) + 1 - j0;
  const tone = new Uint8Array(w * h);
  const inside = new Uint8Array(w * h);
  const onOval = new Uint8Array(w * h);
  const lines = new Uint8Array(w * h);
  const tileAt = (I: number, J: number): number => BAYER8[((J < 0 ? -1 - J : J) & 7) * 8 + ((I < 0 ? -1 - I : I) & 7)]!;
  const inOval = ov ? (X: number, Y: number): boolean => (X / ov.rx) * (X / ov.rx) + ((Y - ov.y) / ov.ry) * ((Y - ov.y) / ov.ry) < 1 : null;
  // a large oval's diagonal edges take the wider band (its corners round off through the tile)
  const roundOval = !!ov && 2 * ov.rx >= DITHER.round * c;
  const onLines = (X: number, Y: number): boolean => {
    for (const s of strokes) if (d2Polyline(X, Y, s.pts) < (s.w / 2) * (s.w / 2)) return true;
    return false;
  };
  const core2 = 0.25 * c * c;
  for (let j = 0; j < h; j++) {
    const J = j0 + j;
    const Y = (J + 0.5) * c;
    for (let i = 0; i < w; i++) {
      const I = i0 + i;
      const X = (I + 0.5) * c;
      const t = tileAt(I, J);
      const k = j * w + i;
      // a line: its centre within half a cell of the cell's (always inked), else its coverage
      let isLine = false;
      let near2 = Infinity;
      let d = Infinity;
      for (const s of strokes) {
        const b = s.box;
        if (X < b[0] - c || X > b[2] + c || Y < b[1] - c || Y > b[3] + c) continue;
        const q = d2Polyline(X, Y, s.pts);
        near2 = Math.min(near2, q);
        d = Math.min(d, Math.sqrt(q) - s.w / 2);
      }
      if (near2 <= core2) isLine = true;
      else if (near2 < Infinity) {
        // every stroke counts for the coverage (one out of its box is far from the cell, never the nearest)
        isLine = cover(d, onLines, X, Y, c) > t;
      }
      let isOval = false;
      if (ov && inOval && Math.abs(X) <= ov.rx + c && Math.abs(Y - ov.y) <= ov.ry + c) {
        let band: number = DITHER.edge;
        if (roundOval) {
          const gx = Math.abs(X) / (ov.rx * ov.rx);
          const gy = Math.abs(Y - ov.y) / (ov.ry * ov.ry);
          const g = Math.sqrt(gx * gx + gy * gy);
          if (g > 0 && Math.min(gx, gy) / g > DITHER.diag) band = DITHER.corner;
        }
        isOval = cover(sdOval(X, Y - ov.y, ov.rx, ov.ry), inOval, X, Y, c, band) > t;
      }
      onOval[k] = isOval ? 1 : 0;
      // lit, the lines are the rim's paper (on a dark ground an inked line would show only as its rim's outline)
      const isInk = isOval || (isLine && inkLines);
      inside[k] = isInk ? 1 : 0;
      if (isInk) tone[k] = TONE.ink;
      else if (isLine) {
        tone[k] = TONE.rim;
        lines[k] = 1;
      }
    }
  }

  return { i0, j0, w, h, tone, inside, onOval, lines };
}

const INK_CACHE = new Map<string, InkRaster>();

function inkRasterKept(ov: Oval | null, strokes: readonly Stroke[], box: readonly [number, number, number, number], c: number, rim: number, inkLines: boolean): InkRaster {
  let key = `${c}|${rim}|${inkLines ? 1 : 0}`;
  if (ov) key += `|o${ov.rx},${ov.ry},${ov.y}`;
  for (const s of strokes) key += `|l${s.w},${s.keep ? 1 : 0},${s.pts.join(",")}`;
  const hit = INK_CACHE.get(key);
  if (hit) return hit;
  const r = inkRaster(ov, strokes, box, c, inkLines);
  if (INK_CACHE.size >= EYE_CACHE_MAX) INK_CACHE.clear();
  INK_CACHE.set(key, r);
  return r;
}

/**
 * One eye's shapes rasterised in its own cells of `c` px, every threshold on the Bayer tile anchored at the eye's centre
 * and mirrored about it (each catchlight's and each burst's on its own, folded about its middle):
 *  1. the ink: each cell's coverage of the oval and the lines (a line's centre always inked);
 *  2. the fit: each catchlight kept to its pupil's inner cells at rest (its arms a cell shorter at a time, the one that
 *     leaves first; too small for even its middle, a star steps a cell toward the pupil's middle, a dot gives way), then
 *     drawn as it is now (the breath, the lids, a flare) with a flare's or a pop's burst;
 *  3. the bloom: the glow round a star on a tall pupil, never near its edge;
 *  4. rimmed, the rings of rim round the ink, the halo of ink round a catchlight over no ink, and `ramp`, the rim's foot.
 * `lit`: the lines take the rim's tone and no rim of their own (a `keep` line stays ink).
 */
function eyeCells(ink: readonly Ink[], light: readonly Light[], c: number, rim: number, lit: boolean, ramp: boolean): EyeCells {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const grow = (ax: number, ay: number, bx: number, by: number): void => {
    x0 = Math.min(x0, ax);
    y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx);
    y1 = Math.max(y1, by);
  };
  let oval: Oval | null = null;
  const strokes: Stroke[] = [];
  for (const s of ink) {
    if (s.oval) {
      oval = s;
      grow(-s.rx - rim, s.y - s.ry - rim, s.rx + rim, s.y + s.ry + rim);
    } else {
      const p = s.w / 2;
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (let i = 0; i + 1 < s.pts.length; i += 2) {
        bx0 = Math.min(bx0, s.pts[i]! - p);
        by0 = Math.min(by0, s.pts[i + 1]! - p);
        bx1 = Math.max(bx1, s.pts[i]! + p);
        by1 = Math.max(by1, s.pts[i + 1]! + p);
      }
      strokes.push({ pts: s.pts, w: s.w, keep: s.keep, box: [bx0, by0, bx1, by1] });
      grow(bx0 - rim, by0 - rim, bx1 + rim, by1 + rim);
    }
  }
  // the ink's own box (rim included): the ink and the rim are rasterised only there, the lights wherever they reach
  const inkBox: readonly [number, number, number, number] = [x0, y0, x1, y1];
  for (const l of light) {
    const r = Math.max(l.ax * Math.max(1, l.k) * l.sx, l.ay * Math.max(1, l.k) * l.sy) + 2 * c;
    const reach = r + (l.burst > 0 ? l.burst * (1 + GLOW.burst.across) + 2 * c : 0);
    grow(l.x - reach, l.y - reach, l.x + reach, l.y + reach);
  }
  if (!(x1 > x0 && y1 > y0)) return NO_EYE;
  // a cell of margin each way for the ring
  const i0 = Math.floor(x0 / c) - 1;
  const j0 = Math.floor(y0 / c) - 1;
  const w = Math.ceil(x1 / c) + 1 - i0;
  const h = Math.ceil(y1 / c) + 1 - j0;
  const tone = new Uint8Array(w * h);
  // per cell: inside the ink (whatever lies over it), on the oval, a catchlight over no ink (it needs the halo), a lit line
  const inside = new Uint8Array(w * h);
  const onOval = new Uint8Array(w * h);
  const loose = new Uint8Array(w * h);
  const lines = new Uint8Array(w * h);
  const inkLines = !lit || strokes.some((s) => s.keep);
  const plain = ink.some((s) => !s.oval && !!s.plain);
  const tileAt = (I: number, J: number): number => BAYER8[((J < 0 ? -1 - J : J) & 7) * 8 + ((I < 0 ? -1 - I : I) & 7)]!;
  // the ink's box in the eye's cells, a cell of margin each way (none when there is no ink)
  const ia = inkBox[2] > inkBox[0] ? Math.max(0, Math.floor(inkBox[0] / c) - 1 - i0) : 0;
  const ib = inkBox[2] > inkBox[0] ? Math.min(w, Math.ceil(inkBox[2] / c) + 1 - i0) : 0;
  const ja = inkBox[3] > inkBox[1] ? Math.max(0, Math.floor(inkBox[1] / c) - 1 - j0) : 0;
  const jb = inkBox[3] > inkBox[1] ? Math.min(h, Math.ceil(inkBox[3] / c) + 1 - j0) : 0;

  // 1. the ink, rasterised in its own box (kept: a face whose catchlights change keeps its ink)
  const ov = oval;
  const ink0 = inkRasterKept(ov, strokes, inkBox, c, rim, inkLines);
  if (ink0.w) {
    const ox = ink0.i0 - i0;
    const oy = ink0.j0 - j0;
    for (let b = 0; b < ink0.h; b++) {
      const src = b * ink0.w;
      const dst = (oy + b) * w + ox;
      tone.set(ink0.tone.subarray(src, src + ink0.w), dst);
      inside.set(ink0.inside.subarray(src, src + ink0.w), dst);
      onOval.set(ink0.onOval.subarray(src, src + ink0.w), dst);
      lines.set(ink0.lines.subarray(src, src + ink0.w), dst);
    }
  }

  // 2. the catchlights, each kept to its pupil's inner cells at rest (an oval cell whose four neighbours are oval too)
  const innerAt = (I: number, J: number): boolean => {
    const i = I - i0;
    const j = J - j0;
    if (i < 1 || j < 1 || i >= w - 1 || j >= h - 1) return false;
    const k = j * w + i;
    return !!(onOval[k] && onOval[k - 1] && onOval[k + 1] && onOval[k - w] && onOval[k + w]);
  };
  const shine = new Uint8Array(w * h);
  const put = (got: readonly number[]): void => {
    for (let n = 0; n < got.length; n += 2) {
      const i = got[n]! - i0;
      const j = got[n + 1]! - j0;
      if (i >= 0 && j >= 0 && i < w && j < h) shine[j * w + i] = 1;
    }
  };
  const blooms: { x: number; y: number; ax: number; ay: number; amp: number }[] = [];
  for (const l of light) {
    let x = l.x;
    let capX = l.ax;
    let capY = l.ay;
    // the fit depends only on the light at rest and its pupil: kept, so a breath or a flare never fits it again
    const fk = l.fit && ov ? `${c}|${ov.rx},${ov.ry},${ov.y}|${l.x},${l.y},${l.ax},${l.ay},${l.full0},${l.dot ? 1 : 0}` : "";
    const fitted = fk ? FIT_CACHE.get(fk) : undefined;
    if (fitted) {
      if (!fitted.kept) continue;
      x = fitted.x;
      capX = fitted.ax;
      capY = fitted.ay;
    } else if (l.fit) {
      // at rest (unturned, its resting sides): first each arm's spine kept to the pupil's inner cells, then its arms a
      // step shorter at a time, the one that leaves the pupil first
      let kept = true;
      const si = Math.floor(x / c);
      const sj = Math.floor(l.y / c);
      const spineOut = (arm: number, across: boolean): boolean => {
        if (l.dot || arm < DITHER.cross * c) return false;
        for (let n = 1; n <= Math.floor(arm / c - DITHER.spine); n++) {
          if (across ? !innerAt(si - n, sj) || !innerAt(si + n, sj) : !innerAt(si, sj - n) || !innerAt(si, sj + n)) return true;
        }
        return false;
      };
      while (capY > 0.5 * c && spineOut(capY, false)) capY = Math.max(0, capY - DITHER.fit * c);
      while (capX > 0.5 * c && spineOut(capX, true)) capX = Math.max(0, capX - DITHER.fit * c);
      if (!l.dot && capX < c) capY = Math.min(capY, 0.5 * c);
      for (;;) {
        const got = lightCells(x, l.y, capX, capY, l.full0, 0, l.dot, c);
        let miss: readonly [number, number] | null = null;
        for (let n = 0; n < got.length && !miss; n += 2) if (!innerAt(got[n]!, got[n + 1]!)) miss = [got[n]! - Math.floor(x / c), got[n + 1]! - Math.floor(l.y / c)];
        if (!miss) break;
        if (capX <= 0.5 * c && capY <= 0.5 * c) {
          // even its middle is on the pupil's edge: a star steps a cell toward the pupil's middle, a dot gives way
          const mi = Math.floor(x / c);
          const to = mi < -1 ? mi + 1 : mi > 0 ? mi - 1 : mi;
          const mj = Math.floor(l.y / c);
          if (!l.dot && to !== mi && innerAt(to, mj)) x = (to + 0.5) * c;
          else if (l.dot || !onOval[(mj - j0) * w + (mi - i0)]) kept = false;
          break;
        }
        if (l.dot) {
          capX = Math.max(0, capX - DITHER.fit * c);
          capY = capX;
        } else if (Math.abs(miss[1]) > Math.abs(miss[0]) || capX <= 0.5 * c) capY = Math.max(0, capY - DITHER.fit * c);
        else capX = Math.max(0, capX - DITHER.fit * c);
        // a star the fit leaves no arms across is one cell, never a dash
        if (!l.dot && capX < c) capY = Math.min(capY, 0.5 * c);
      }
      if (fk) {
        if (FIT_CACHE.size >= EYE_CACHE_MAX) FIT_CACHE.clear();
        FIT_CACHE.set(fk, { kept, x, ax: capX, ay: capY });
      }
      if (!kept) continue;
    }
    // as it is now: the breath, the lids or the pop (under its fit), a flare's stretch; held to the grid's steps
    const kq = Math.round(l.k * 64) / 64;
    let ax = step((l.fit ? Math.min(l.ax * kq, capX) : l.ax * kq) * l.sx, c, DITHER.quant);
    let ay = step((l.fit ? Math.min(l.ay * kq, capY) : l.ay * kq) * l.sy, c, DITHER.quant);
    // and as drawn, a star with no arms one way is one cell, never a dash (a blink's reopening shrinks both at once)
    if (!l.dot) {
      if (ax < c) ay = Math.min(ay, 0.5 * c);
      if (ay < c) ax = Math.min(ax, 0.5 * c);
    }
    put(lightCells(x, l.y, ax, ay, l.full, l.rot, l.dot, c));
    if (l.bloom > 0) blooms.push({ x, y: l.y, ax: capX, ay: capY, amp: Math.round(l.bloom * 64) / 64 });
    if (l.burst > 0) {
      const bx = l.tip ? x + ay * Math.sin(l.rot) : x;
      const by = l.tip ? l.y - ay * Math.cos(l.rot) : l.y;
      put(burstCells(Math.floor(bx / c), Math.floor(by / c), l.burst, l.bf, c));
    }
  }
  for (let k = 0; k < w * h; k++) {
    if (!shine[k]) continue;
    loose[k] = inside[k] || lines[k] ? 0 : 1;
    tone[k] = TONE.light;
  }

  // 3. the bloom: the glow on the pupil round its star, its own measure (1 on the star's outline), never near the edge
  if (ov && blooms.length) {
    const ix = ov.rx - GLOW.bloom.inset * c;
    const iy = ov.ry - GLOW.bloom.inset * c;
    for (const bl of blooms) {
      if (!(ix > 0 && iy > 0 && bl.ax > 0 && bl.ay > 0)) continue;
      const R2 = GLOW.bloom.reach * GLOW.bloom.reach;
      const a0 = Math.max(i0, Math.floor((bl.x - bl.ax * R2) / c));
      const a1 = Math.min(i0 + w - 1, Math.floor((bl.x + bl.ax * R2) / c));
      const b0 = Math.max(j0, Math.floor((bl.y - bl.ay * R2) / c));
      const b1 = Math.min(j0 + h - 1, Math.floor((bl.y + bl.ay * R2) / c));
      for (let J = b0; J <= b1; J++) {
        const Y = (J + 0.5) * c;
        for (let I = a0; I <= a1; I++) {
          const k = (J - j0) * w + (I - i0);
          if (tone[k] !== TONE.ink || !onOval[k]) continue;
          const X = (I + 0.5) * c;
          const ex = X / ix;
          const ey = (Y - ov.y) / iy;
          if (ex * ex + ey * ey >= 1) continue;
          const qx = (X - bl.x) / bl.ax;
          const qy = (Y - bl.y) / bl.ay;
          const q = Math.sqrt(qx * qx + qy * qy);
          if (q >= GLOW.bloom.reach) continue;
          const u = Math.max(0, (q - GLOW.bloom.from) / (GLOW.bloom.reach - GLOW.bloom.from));
          if (bl.amp * (1 - u) * (1 - u) > tileAt(I, J)) tone[k] = TONE.glow;
        }
      }
    }
  }

  if (rim > 0) {
    // 4. the rim: whole rings of cells round the ink as its dither left it, as many as the rim is cells wide (one at
    // least), the first through the eight neighbours, the next through the four, so it stays round and never frays
    const grown = inside.slice();
    const ring = new Uint8Array(w * h);
    for (let n = 0; n < Math.max(1, Math.round(rim / c)); n++) {
      const was = grown.slice();
      for (let j = ja; j < jb; j++) {
        for (let i = ia; i < ib; i++) {
          const k = j * w + i;
          if (was[k] || !near(was, w, h, i, j, n % 2 === 0)) continue;
          grown[k] = 1;
          if (tone[k] === TONE.none) {
            tone[k] = TONE.rim;
            ring[k] = 1;
          }
        }
      }
    }
    // the halo: a rim cell (of the rings, never a lit line) touching a catchlight that lies over no ink turns ink, so a
    // flaring tip keeps its point
    for (let j = ja; j < jb; j++) {
      for (let i = ia; i < ib; i++) {
        const k = j * w + i;
        if (ring[k] && near(loose, w, h, i, j)) {
          tone[k] = TONE.ink;
          ring[k] = 0;
        }
      }
    }
    if (ramp) {
      // the ramp: down the rim's rows from its paper to its foot, tilted away from the light, through the eye's tile; and
      // down a lit line's rows the same way (a lid's ends paper, its sag the foot), so a shut eye is dithered as an open
      // one's rim is, never a flat cut-out of paper
      const ramped = (on: (k: number) => boolean, from: number, to: number): void => {
        let top = h;
        let bot = -1;
        let lef = w;
        let rig = -1;
        for (let j = ja; j < jb; j++) {
          for (let i = ia; i < ib; i++) {
            if (!on(j * w + i)) continue;
            top = Math.min(top, j);
            bot = Math.max(bot, j);
            lef = Math.min(lef, i);
            rig = Math.max(rig, i);
          }
        }
        if (bot < top) return;
        const mid = (lef + rig) / 2;
        const half = Math.max(1, (rig - lef + 1) / 2);
        for (let j = top; j <= bot; j++) {
          for (let i = lef; i <= rig; i++) {
            const k = j * w + i;
            if (!on(k)) continue;
            const p = (j - top + 0.5) / (bot - top + 1) + (RAMP.tilt * (i - mid)) / half;
            if (p >= to || (p > from && (p - from) / (to - from) > tileAt(i0 + i, j0 + j))) tone[k] = TONE.foot;
          }
        }
      };
      ramped((k) => ring[k] === 1, RAMP.from, RAMP.to);
      if (!plain) ramped((k) => lines[k] === 1 && tone[k] === TONE.rim, RAMP.lineFrom, RAMP.lineTo);
    }
  }
  return { i0, j0, w, h, tone };
}

/** The eyes drawn lately, by everything that shapes their cells, so a face that only moves is never rasterised again. */
const EYE_CACHE = new Map<string, EyeCells>();
const EYE_CACHE_MAX = 96;
/** The catchlights fitted lately (their pupil and their resting shape: the fit's whole input). */
const FIT_CACHE = new Map<string, { readonly kept: boolean; readonly x: number; readonly ax: number; readonly ay: number }>();

function eyeKey(ink: readonly Ink[], light: readonly Light[], c: number, rim: number, lit: boolean, ramp: boolean): string {
  let key = `${c}|${rim}|${lit ? 1 : 0}${ramp ? 1 : 0}`;
  for (const s of ink) key += s.oval ? `|o${s.rx},${s.ry},${s.y}` : `|l${s.w},${s.keep ? 1 : 0}${s.plain ? 1 : 0},${s.pts.join(",")}`;
  for (const l of light) key += `|L${l.x},${l.y},${l.ax},${l.ay},${Math.round(l.k * 64)},${l.sx},${l.sy},${l.full},${l.full0},${l.rot},${l.dot ? 1 : 0}${l.fit ? 1 : 0}${l.tip ? 1 : 0},${Math.round(l.bloom * 64)},${l.burst},${l.bf}`;
  return key;
}

function eyeCellsKept(ink: readonly Ink[], light: readonly Light[], c: number, rim: number, lit: boolean, ramp: boolean): EyeCells {
  const key = eyeKey(ink, light, c, rim, lit, ramp);
  const hit = EYE_CACHE.get(key);
  if (hit) return hit;
  const e = eyeCells(ink, light, c, rim, lit, ramp);
  if (EYE_CACHE.size >= EYE_CACHE_MAX) EYE_CACHE.clear();
  EYE_CACHE.set(key, e);
  return e;
}

/**
 * The pair `left`, `right` (one glyph each) of a body of radius R, their centres `half` px either side of (cx, cy), posed,
 * on `grid`, drawn in `style`. The pair is snapped as one: the left eye's centre to the nearest grid corner (or the one
 * `style.hold` keeps), the right eye a whole number of cells from it, so the pair never changes its spacing by a cell as
 * it moves.
 */
export function pairCells(left: string, right: string, cx: number, cy: number, half: number, R: number, pose: FacePose, grid: FaceGrid, style: FaceStyle = {}): FaceCells {
  const c = grid.cell;
  const rim = style.rim ?? 0;
  const lit = !!style.lit && rim > 0;
  const ramp = !!style.ramp && rim > 0;
  const D = style.hold ? style.hold.spread((2 * half) / c) : Math.max(1, Math.round((2 * half) / c));
  const u = (cx - grid.x) / c - D / 2;
  const v = (cy - grid.y) / c;
  const [colL, row] = style.hold ? style.hold.at(u, v) : [Math.round(u), Math.round(v)];
  const eyes: EyeCells[] = [];
  for (let e = 0; e < 2; e++) {
    const ink: Ink[] = [];
    const light: Light[] = [];
    eyeShapes(eyeOf(e ? right : left), e ? 1 : -1, R, pose, c, ink, light);
    eyes.push(eyeCellsKept(ink, light, c, rim, lit, ramp));
  }
  const at = [colL, colL + D];
  let c0 = Infinity;
  let r0 = Infinity;
  let c1 = -Infinity;
  let r1 = -Infinity;
  eyes.forEach((e, n) => {
    if (!e.w) return;
    c0 = Math.min(c0, at[n]! + e.i0);
    c1 = Math.max(c1, at[n]! + e.i0 + e.w);
    r0 = Math.min(r0, row + e.j0);
    r1 = Math.max(r1, row + e.j0 + e.h);
  });
  if (!(c1 > c0)) return { col: 0, row: 0, w: 0, h: 0, tone: new Uint8Array(0) };
  const w = c1 - c0;
  const h = r1 - r0;
  const tone = new Uint8Array(w * h);
  eyes.forEach((e, n) => {
    const ox = at[n]! + e.i0 - c0;
    const oy = row + e.j0 - r0;
    for (let j = 0; j < e.h; j++) {
      for (let i = 0; i < e.w; i++) {
        const t = e.tone[j * e.w + i]!;
        const k = (oy + j) * w + ox + i;
        if (t > tone[k]!) tone[k] = t;
      }
    }
  });
  return { col: c0, row: r0, w, h, tone };
}

/**
 * The face `pair` (one glyph per eye, spaces ignored) centred at (cx, cy) on a body of radius R, posed, on `grid`, drawn
 * in `style`: the eyes 0.31 R either side, a touch closer as the face turns.
 */
export function faceCells(pair: string, cx: number, cy: number, R: number, pose: FacePose, grid: FaceGrid, style: FaceStyle = {}): FaceCells {
  const p = pair.replace(/\s+/g, "");
  return pairCells(p[0] ?? "-", p[1] ?? p[0] ?? "-", cx, cy, EYES.spread * R * (1 - 0.08 * Math.abs(pose.turn)), R, pose, grid, style);
}

/** The tone at grid cell (col, row), or none outside the face. */
export function toneAt(f: FaceCells, col: number, row: number): number {
  const i = col - f.col;
  const j = row - f.row;
  return i < 0 || j < 0 || i >= f.w || j >= f.h ? TONE.none : f.tone[j * f.w + i]!;
}
