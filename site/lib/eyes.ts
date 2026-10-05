/**
 * The blob's eyes, drawn as shapes: ink ovals that catch the light as a four-point star and a small dot, and a small
 * vocabulary of lines for the faces that close them. One geometry in R units (the disc's radius) for the live blob
 * (lib/blob.ts draws it on its face canvas), for the still orb (lib/orb.ts rasterises the same shapes as distance fields)
 * and for the island's face (faceMarks writes the same calls down as SVG paths), so every character on the page matches.
 *
 * The face pairs the engine uses, one glyph per eye: `O` open, `o` small open, `-` closed (a soft sag), `^` happy (an arc),
 * `u` content (a cup), `_` flat, `x` error, `>` `<` squeezed shut (each points at the middle), `~` wavy. Cute is low, close
 * and round: the eyes sit just above the body's middle, a little over half a radius apart, taller than wide. Small blobs
 * (a disc under 52 px) draw their eyes a little larger and their lines never under 1.75 px, so a 32 px face still reads.
 *
 * The sparkle: each open eye's catchlights are a star toward the gleam (upper left) and a dot across from it, in solid
 * paper, both inside the pupil. The live blob and the island breathe them in size (`twinkle`: the star swells as the dot
 * ebbs) and now and then a star flares (`flare`, TWINKLE): it twists, turns upright and stretches into a long glint whose
 * top arm reaches out past the pupil, while the dot gives way. Lit (starstruck), the dot turns into a small star of its own. The happy arcs (`^ ^`) wear a sparkle of
 * their own off the right eye's outer top, a small star and a dot that pop in as the face appears (`spark`) and pulse
 * with each flare. A mark that would draw under MIN_MARK screen px at its resting size is left out, so no face smudges and
 * no mark drops out a frame early in a blink.
 * Pure: no DOM.
 */

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
   * The still's are a touch larger (`still`), so a 56 px thread still keeps them once it is scaled down.
   */
  star: { x: -0.25, y: -0.32, ax: 0.088, ay: 0.118, full: 0.18, still: 1.08 },
  dot: { x: 0.4, y: 0.44, r: 0.034 },
  /** Starstruck (lit): the dot becomes a small star, its arms these times its radius across and up and down. */
  struck: { ax: 1.1, ay: 1.55 },
  /**
   * A flare at its peak: the star's arms reach this much further across and up and down, its sides pulled in to `sharp`
   * (a long thin glint), and on the way up it twists out by `spin` rad and back, upright at its peak.
   */
  flare: { ax: 0.1, ay: 0.8, sharp: 0.12, spin: 0.45 },
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
  /** The closed lid: its ends a touch above the eye's line and its middle sagging below it (a quadratic's control). */
  lid: { ends: -0.008, sag: 0.035 },
  /** A blink reopening past round stretches the oval this much taller per unit of overshoot, at most `max`. */
  stretch: { k: 0.8, max: 0.1 },
} as const;

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
}

export interface FaceInk {
  readonly ink: string;
  readonly light: string;
}

/** What drawFace draws with: a canvas context, or a pen that writes the same calls down as path data (faceMarks). */
export type FacePen = Pick<
  CanvasRenderingContext2D,
  "lineCap" | "lineJoin" | "lineWidth" | "strokeStyle" | "fillStyle" | "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "ellipse" | "arc" | "closePath" | "fill" | "stroke"
>;

const TAU = Math.PI * 2;
/** The smallest sparkle drawn, in screen px (a star's arm across, a dot's radius): anything less would only smudge. */
export const MIN_MARK = 0.7;
/** The star outline's control (`full`) that draws a circle to within a few percent: the dot's shape before it is starstruck. */
const ROUND = 0.914;

/** The pair's two eye centres (x) for a face centred at cx, turned by `turn`. */
function eyeX(cx: number, R: number, side: number, turn: number): number {
  return cx + side * EYES.spread * R * (1 - 0.08 * Math.abs(turn));
}

/**
 * Draw the face `pair` centred at (cx, cy) on a body of radius R (CSS px on a context already scaled to them). `unit` is
 * how many screen px one of those px is at its smallest (the island docked), so the sparkle's floor is judged on screen.
 */
export function drawFace(g: FacePen, pair: string, cx: number, cy: number, R: number, pose: FacePose, ink: FaceInk, unit = 1): void {
  const k = eyeScale(R);
  const lw = eyeStroke(R);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = lw;
  g.strokeStyle = ink.ink;
  for (let e = 0; e < 2; e++) {
    const side = e ? 1 : -1;
    const kind = eyeOf(pair[e]);
    const ex = eyeX(cx, R, side, pose.turn);
    const far = Math.max(0, -side * pose.turn);
    const narrow = 1 - 0.14 * far;
    if (kind === "open" || kind === "small") {
      const o = pose.open < 0 ? 0 : pose.open > 1 ? 1 : pose.open;
      const shape = kind === "open" ? EYES.open : EYES.small;
      const grow = 1 + 0.08 * pose.sparkle;
      const rx = shape.rx * R * k * narrow * grow;
      const ry = shape.ry * R * k * grow;
      if (o < 0.22) {
        // shut: the closed lid, as wide as the open eye
        lid(g, ex, cy, rx * 1.05, R * k);
        continue;
      }
      // the blink: the oval squashes, widens a little, and its top comes down; reopening, it overshoots a touch taller
      // and narrower, then settles (the lids are a spring in lib/blob.ts)
      const over = pose.open > 1 ? Math.min(EYES.stretch.max, (pose.open - 1) * EYES.stretch.k) : 0;
      const ryo = ry * o * (1 + over);
      const rxo = rx * (1 + 0.18 * (1 - o)) * (1 - 0.4 * over);
      const yo = cy + (ry - ryo) * 0.35;
      g.fillStyle = ink.ink;
      g.beginPath();
      g.ellipse(ex, yo, rxo, ryo, 0, 0, TAU);
      g.fill();
      // the catchlights come back as the lids open
      if (o > 0.5) catchlights(g, ex, yo, rxo, ryo, R * k * (kind === "small" ? 0.8 : 1), (o - 0.5) * 2, narrow, pose, side, ink, unit);
      continue;
    }
    const w = EYES.half * R * k * narrow;
    g.lineWidth = lw;
    g.beginPath();
    switch (kind) {
      case "closed":
        lid(g, ex, cy, w, R * k);
        continue;
      case "happy": {
        g.lineWidth = lw * EYES.joy;
        const r = EYES.arc.r * R * k;
        const c = cy + EYES.arc.drop * R * k;
        g.ellipse(ex, c, r * narrow, r, 0, Math.PI * (1.5 - EYES.arc.sweep), Math.PI * (1.5 + EYES.arc.sweep));
        break;
      }
      case "content": {
        const r = EYES.cup.r * R * k;
        const c = cy - EYES.cup.lift * R * k;
        g.ellipse(ex, c, r * narrow, r, 0, Math.PI * (0.5 - EYES.cup.sweep), Math.PI * (0.5 + EYES.cup.sweep));
        break;
      }
      case "flat":
        g.moveTo(ex - w * 0.9, cy + 0.06 * R * k);
        g.lineTo(ex + w * 0.9, cy + 0.06 * R * k);
        break;
      case "error": {
        const d = 0.066 * R * k;
        g.moveTo(ex - d * narrow, cy - d);
        g.lineTo(ex + d * narrow, cy + d);
        g.moveTo(ex + d * narrow, cy - d);
        g.lineTo(ex - d * narrow, cy + d);
        break;
      }
      case "in": {
        // > on the left eye, < on the right: each points at the middle, squeezed shut
        const dir = -side;
        const a = 0.082 * R * k;
        const v = 0.074 * R * k;
        g.moveTo(ex - dir * a * narrow, cy - v);
        g.lineTo(ex + dir * a * narrow, cy);
        g.lineTo(ex - dir * a * narrow, cy + v);
        break;
      }
      case "wavy": {
        // a soft ripple, half the open eye's height: a dream, not a moustache
        const amp = 0.022 * R * k;
        for (let i = 0; i <= 16; i++) {
          const x = ex - w * 0.9 + (1.8 * w * i) / 16;
          const y = cy + amp * Math.sin((i / 16) * TAU);
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        break;
      }
    }
    g.stroke();
    if (kind === "happy" && side === 1) glee(g, ex, cy, R * k, narrow, pose, ink, unit);
  }
}

/**
 * A four-point star at (x, y), arms `ax` across and `ay` up and down, its sides quadratics through a control `full` of an
 * arm out from the middle (0.18 a star with a round bright middle, 0.5 a diamond, ROUND a circle), turned by `rot`.
 */
function star(g: FacePen, x: number, y: number, ax: number, ay: number, full: number, rot: number): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const X = (px: number, py: number) => x + px * c - py * s;
  const Y = (px: number, py: number) => y + px * s + py * c;
  const fx = full * ax;
  const fy = full * ay;
  g.beginPath();
  g.moveTo(X(0, -ay), Y(0, -ay));
  g.quadraticCurveTo(X(fx, -fy), Y(fx, -fy), X(ax, 0), Y(ax, 0));
  g.quadraticCurveTo(X(fx, fy), Y(fx, fy), X(0, ay), Y(0, ay));
  g.quadraticCurveTo(X(-fx, fy), Y(-fx, fy), X(-ax, 0), Y(-ax, 0));
  g.quadraticCurveTo(X(-fx, -fy), Y(-fx, -fy), X(0, -ay), Y(0, -ay));
  g.closePath();
  g.fill();
}

function dot(g: FacePen, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}

/** The largest arms [across, up and down] a star centred at (X, Y) (fractions of a pupil's radii rx, ry) has inside the pupil. */
function fitArms(rx: number, ry: number, X: number, Y: number): readonly [number, number] {
  const m = EYES.fit * EYES.fit;
  return [rx * (Math.sqrt(Math.max(0, m - Y * Y)) - Math.abs(X)), ry * (Math.sqrt(Math.max(0, m - X * X)) - Math.abs(Y))];
}

/**
 * An open eye's catchlights on its pupil at (x, y), radii (rx, ry): the star and the dot, `s` their scale (R·k) and `a`
 * how far the lids have let them back (0 to 1). Lit, the star grows as far as the pupil holds it and the dot turns into a
 * small star; a flare stretches the star's arms past the pupil and twists it upright at its peak; the breath trades the
 * star's size for the dot's. Each mark's floor is judged at its resting size, so none drops out early in a blink.
 */
function catchlights(g: FacePen, x: number, y: number, rx: number, ry: number, s: number, a: number, narrow: number, pose: FacePose, side: number, ink: FaceInk, unit: number): void {
  const lit = pose.sparkle;
  const b = pose.twinkle;
  const swell = b === undefined ? 1 : 0.9 + 0.1 * b;
  const ebb = b === undefined ? 1 : 0.9 + 0.1 * (1 - b);
  const u = pose.flare ? (pose.flare[side < 0 ? 0 : 1] ?? 0) : 0;
  const f = flareSize(u);
  g.fillStyle = ink.light;
  // the star: narrowed with its eye, fitted inside the pupil, then a flare's reach past it
  const ax0 = EYES.star.ax * s * narrow;
  if (ax0 * unit >= MIN_MARK) {
    const [mx, my] = fitArms(rx, ry, EYES.star.x, EYES.star.y);
    const ax = Math.min(ax0 * (1 + 0.24 * lit) * swell * a, mx) * (1 + EYES.flare.ax * f);
    const ay = Math.min(EYES.star.ay * s * (1 + 0.15 * lit) * swell * a, my) * (1 + EYES.flare.ay * f);
    star(g, x + rx * EYES.star.x, y + ry * EYES.star.y, ax, ay, EYES.star.full + (EYES.flare.sharp - EYES.star.full) * f, -side * flareTwist(u));
  }
  // the dot, starstruck while lit (a circle that sharpens through a diamond into a small star); it gives way to a flare,
  // so the light gathers in the glint and never runs into it
  const r0 = EYES.dot.r * s * (1 + 0.4 * lit);
  if (r0 * unit >= MIN_MARK) {
    const r = r0 * ebb * a * (1 - 0.5 * f);
    const dx = x + rx * EYES.dot.x;
    const dy = y + ry * EYES.dot.y;
    if (lit < 0.02) dot(g, dx, dy, r);
    else {
      const [mx, my] = fitArms(rx, ry, EYES.dot.x, EYES.dot.y);
      const ax = Math.min(r * (1 + (EYES.struck.ax - 1) * lit), mx);
      const ay = Math.min(r * (1 + (EYES.struck.ay - 1) * lit), my);
      star(g, dx, dy, ax, ay, ROUND + (EYES.star.full - ROUND) * lit, 0);
    }
  }
}

/**
 * The happy arcs' sparkle, beside the right eye (centre (ex, cy), `Rk` its scale): a small star and a dot up and in from it,
 * breathing with the catchlights, popping in and pulsing with each flare (`spark`).
 */
function glee(g: FacePen, ex: number, cy: number, Rk: number, narrow: number, pose: FacePose, ink: FaceInk, unit: number): void {
  const J = EYES.glee;
  const b = pose.twinkle;
  const swell = b === undefined ? 1 : 0.9 + 0.1 * b;
  const ebb = b === undefined ? 1 : 0.9 + 0.1 * (1 - b);
  const pop = pose.spark ?? 1;
  if (!(pop > 0.02)) return;
  const a = J.a * Rk * (1 + 0.25 * pose.sparkle);
  g.fillStyle = ink.light;
  if (a * 0.75 * unit >= MIN_MARK) star(g, ex + J.x * Rk * narrow, cy + J.y * Rk, a * 0.75 * swell * pop, a * swell * pop, EYES.star.full, 0);
  const r = J.dot.r * Rk;
  if (r * unit >= MIN_MARK) dot(g, ex + J.dot.x * Rk * narrow, cy + J.dot.y * Rk, r * ebb * pop);
}

/** The closed lid: a soft sag, its middle a little lower than its ends. */
function lid(g: FacePen, ex: number, cy: number, w: number, Rk: number): void {
  g.beginPath();
  g.moveTo(ex - w, cy + EYES.lid.ends * Rk);
  g.quadraticCurveTo(ex, cy + EYES.lid.sag * Rk, ex + w, cy + EYES.lid.ends * Rk);
  g.stroke();
}

// ---- the same shapes as SVG paths, for a face drawn in the DOM (the island's): crisp at any scale ----

/** One shape of the face: its path data, the paint drawFace gave it (`ink` or `light`, as passed), filled or stroked at `width`. */
export interface FaceMark {
  readonly d: string;
  readonly paint: string;
  readonly fill: boolean;
  readonly width: number;
}

const num = (v: number): string => String(Math.round(v * 100) / 100);

/** An arc of an ellipse as canvas draws it (clockwise from a0 to a1), joined to the path, or the whole ellipse in two halves. */
function arcPath(open: boolean, x: number, y: number, rx: number, ry: number, a0: number, a1: number): string {
  const at = (a: number) => `${num(x + rx * Math.cos(a))} ${num(y + ry * Math.sin(a))}`;
  const head = `${open ? "L" : "M"}${at(a0)}`;
  const r = `${num(rx)} ${num(ry)} 0`;
  if (a1 - a0 >= TAU - 1e-6) return `${head}A${r} 0 1 ${at(a0 + Math.PI)}A${r} 0 1 ${at(a0)}Z`;
  return `${head}A${r} ${a1 - a0 > Math.PI ? 1 : 0} 1 ${at(a1)}`;
}

/** The face `pair` as SVG paths: drawFace run on a pen that writes each fill and stroke down instead of painting it. */
export function faceMarks(pair: string, cx: number, cy: number, R: number, pose: FacePose, ink: FaceInk, unit = 1): FaceMark[] {
  const marks: FaceMark[] = [];
  let d = "";
  const pen: FacePen = {
    lineCap: "round",
    lineJoin: "round",
    lineWidth: 1,
    strokeStyle: ink.ink,
    fillStyle: ink.ink,
    beginPath: () => {
      d = "";
    },
    moveTo: (x, y) => {
      d += `M${num(x)} ${num(y)}`;
    },
    lineTo: (x, y) => {
      d += `L${num(x)} ${num(y)}`;
    },
    quadraticCurveTo: (qx, qy, x, y) => {
      d += `Q${num(qx)} ${num(qy)} ${num(x)} ${num(y)}`;
    },
    ellipse: (x, y, rx, ry, _rotation, a0, a1) => {
      d += arcPath(d !== "", x, y, rx, ry, a0, a1);
    },
    arc: (x, y, r, a0, a1) => {
      d += arcPath(d !== "", x, y, r, r, a0, a1);
    },
    closePath: () => {
      d += "Z";
    },
    fill: () => {
      marks.push({ d, paint: String(pen.fillStyle), fill: true, width: 0 });
    },
    stroke: () => {
      marks.push({ d, paint: String(pen.strokeStyle), fill: false, width: pen.lineWidth });
    },
  };
  drawFace(pen, pair, cx, cy, R, pose, ink, unit);
  return marks;
}

// ---- the same shapes as distance fields, for the still orb (lib/orb.ts); R units, negative inside ----

/** An ellipse's approximate signed distance (good near the edge, which is all the raster needs). */
function sdEllipse(px: number, py: number, rx: number, ry: number): number {
  const k = Math.hypot(px / rx, py / ry);
  return (k - 1) * Math.min(rx, ry);
}

/** An arc of radius r about (0, 0), symmetric about the vertical, its middle up (`up`) or down, ± sweep·π, round caps of radius w. */
function sdArc(px: number, py: number, r: number, sweep: number, w: number, up: boolean): number {
  const qx = Math.abs(px);
  const qy = up ? -py : py;
  const s = Math.sin(sweep * Math.PI);
  const c = Math.cos(sweep * Math.PI);
  // inside the arc's wedge: distance to the circle; outside: to the nearer end
  if (c * qx > s * qy) return Math.hypot(qx - s * r, qy - c * r) - w;
  return Math.abs(Math.hypot(qx, qy) - r) - w;
}

/** A polygon's signed distance (negative inside), its points [x0, y0, x1, y1, ...] in order (the crossing-number sign). */
function sdPolygon(px: number, py: number, v: Float64Array): number {
  const n = v.length / 2;
  let d = Infinity;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const ix = v[2 * i]!;
    const iy = v[2 * i + 1]!;
    const ex = v[2 * j]! - ix;
    const ey = v[2 * j + 1]! - iy;
    const wx = px - ix;
    const wy = py - iy;
    const h = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    const bx = wx - ex * h;
    const by = wy - ey * h;
    d = Math.min(d, bx * bx + by * by);
    const up = py >= iy;
    const below = py < iy + ey;
    const left = ex * wy > ey * wx;
    if ((up && below && left) || (!up && !below && !left)) s = -s;
  }
  return s * Math.sqrt(d);
}

/** The star drawFace draws (star(), upright), as a polygon: each quadratic side sampled in eight steps. */
function starPolygon(x: number, y: number, ax: number, ay: number, full: number): Float64Array {
  const tip = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;
  const pts: number[] = [];
  for (let q = 0; q < 4; q++) {
    const [p0x, p0y] = tip[q]!;
    const [p2x, p2y] = tip[(q + 1) % 4]!;
    const qx = (p0x + p2x) * full;
    const qy = (p0y + p2y) * full;
    for (let i = 0; i < 8; i++) {
      const t = i / 8;
      const u = 1 - t;
      pts.push(x + ax * (u * u * p0x + 2 * u * t * qx + t * t * p2x), y + ay * (u * u * p0y + 2 * u * t * qy + t * t * p2y));
    }
  }
  return Float64Array.from(pts);
}

/** A still's sparkle: its stars as polygons with their boxes, and its dots as circles (x, y, r), in R units. */
interface StillSparkle {
  readonly stars: readonly { readonly poly: Float64Array; readonly x: number; readonly y: number; readonly ax: number; readonly ay: number }[];
  readonly dots: readonly (readonly [number, number, number])[];
}

const STILL_SPARKLE = new Map<string, StillSparkle>();

/**
 * The still's catchlights (`OO`) or the happy arcs' sparkle (`^^`), a touch larger than the live blob's (EYES.star.still)
 * and fitted inside the pupil as the live ones are.
 */
function stillSparkle(pair: "OO" | "^^" | "--"): StillSparkle {
  const hit = STILL_SPARKLE.get(pair);
  if (hit) return hit;
  const k = EYES.star.still;
  const stars: { poly: Float64Array; x: number; y: number; ax: number; ay: number }[] = [];
  const dots: (readonly [number, number, number])[] = [];
  const add = (x: number, y: number, ax: number, ay: number, full: number = EYES.star.full) => stars.push({ poly: starPolygon(x, y, ax, ay, full), x, y, ax, ay });
  if (pair === "OO") {
    for (const side of [-1, 1]) {
      const ex = side * EYES.spread;
      const { rx, ry } = EYES.open;
      const [mx, my] = fitArms(rx, ry, EYES.star.x, EYES.star.y);
      add(ex + rx * EYES.star.x, EYES.row + ry * EYES.star.y, Math.min(EYES.star.ax * k, mx), Math.min(EYES.star.ay * k, my));
      dots.push([ex + rx * EYES.dot.x, EYES.row + ry * EYES.dot.y, EYES.dot.r * k]);
    }
  } else if (pair === "^^") {
    const J = EYES.glee;
    add(EYES.spread + J.x, EYES.row + J.y, J.a * 0.75 * k, J.a * k);
    dots.push([EYES.spread + J.dot.x, EYES.row + J.dot.y, J.dot.r * k]);
  }
  const out: StillSparkle = { stars, dots };
  STILL_SPARKLE.set(pair, out);
  return out;
}

/**
 * The still's face at a point (nx, ny, in R units from the body's centre): how much of the eye's ink and of its
 * catchlights cover it, each a signed distance in R units (negative inside). Only the faces the stills wear: `OO` awake
 * (each pupil's star and dot), `^^` happy (the arcs and their sparkle) and `--` asleep (the lid's quadratic as the circle
 * through its ends and its middle).
 */
export function faceField(nx: number, ny: number, pair: "OO" | "^^" | "--"): { readonly ink: number; readonly glint: number } {
  let ink = Infinity;
  let glint = Infinity;
  const sp = stillSparkle(pair);
  for (const s of sp.stars) {
    // only near a star (its box and a margin): the polygon's distance is the costly part
    if (Math.abs(nx - s.x) < s.ax + 0.05 && Math.abs(ny - s.y) < s.ay + 0.05) glint = Math.min(glint, sdPolygon(nx, ny, s.poly));
  }
  for (const [x, y, r] of sp.dots) glint = Math.min(glint, Math.hypot(nx - x, ny - y) - r);
  for (const side of [-1, 1]) {
    const ex = side * EYES.spread;
    const ey = EYES.row;
    if (pair === "OO") {
      ink = Math.min(ink, sdEllipse(nx - ex, ny - ey, EYES.open.rx, EYES.open.ry));
    } else if (pair === "^^") {
      ink = Math.min(ink, sdArc(nx - ex, ny - (ey + EYES.arc.drop), EYES.arc.r, EYES.arc.sweep, (EYES.stroke * EYES.joy) / 2, true));
    } else {
      const w = EYES.half;
      const mid = (EYES.lid.ends + EYES.lid.sag) / 2;
      const sag = mid - EYES.lid.ends;
      const r = (w * w + sag * sag) / (2 * sag);
      ink = Math.min(ink, sdArc(nx - ex, ny - (ey + mid - r), r, Math.asin(w / r) / Math.PI, EYES.stroke / 2, false));
    }
  }
  return { ink, glint };
}
