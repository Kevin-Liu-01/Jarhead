/**
 * The blob's eyes, drawn as shapes: ink ovals with one paper catchlight, and a small vocabulary of lines for the faces that
 * close them. One geometry in R units (the disc's radius) for the live blob (lib/blob.ts draws it on its face canvas), for
 * the still orb (lib/orb.ts rasterises the same shapes as distance fields) and for the island's face (faceMarks writes the
 * same calls down as SVG paths), so every character on the page matches.
 *
 * The face pairs the engine uses, one glyph per eye: `O` open, `o` small open, `-` closed (a soft sag), `^` happy (an arc),
 * `u` content (a cup), `_` flat, `x` error, `>` `<` squeezed shut (each points at the middle), `~` wavy. Cute is low, close
 * and round: the eyes sit just above the body's middle, a little over half a radius apart, taller than wide. Small blobs
 * (a disc under 52 px) draw their eyes a little larger and their lines never under 1.75 px, so a 32 px face still reads.
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
   * The catchlight: radius, and its centre as fractions of the eye's radii, up and toward the light (upper left). The
   * still's is a touch larger (`still`), so a 56 px thread still keeps its sparkle once it is scaled down.
   */
  glint: { r: 0.064, still: 0.08, x: -0.3, y: -0.4 },
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
  /** 0 to 1: the eyes light up (a touch larger, a brighter catchlight and a second small one). */
  readonly sparkle: number;
  /** The look's sideways part, -1 to 1: the face turns, the far eye narrows. */
  readonly turn: number;
}

export interface FaceInk {
  readonly ink: string;
  readonly light: string;
}

/** What drawFace draws with: a canvas context, or a pen that writes the same calls down as path data (faceMarks). */
export type FacePen = Pick<
  CanvasRenderingContext2D,
  "lineCap" | "lineJoin" | "lineWidth" | "strokeStyle" | "fillStyle" | "beginPath" | "moveTo" | "lineTo" | "quadraticCurveTo" | "ellipse" | "arc" | "fill" | "stroke"
>;

const TAU = Math.PI * 2;

/** The pair's two eye centres (x) for a face centred at cx, turned by `turn`. */
function eyeX(cx: number, R: number, side: number, turn: number): number {
  return cx + side * EYES.spread * R * (1 - 0.08 * Math.abs(turn));
}

/** Draw the face `pair` centred at (cx, cy) on a body of radius R (CSS px on a context already scaled to them). */
export function drawFace(g: FacePen, pair: string, cx: number, cy: number, R: number, pose: FacePose, ink: FaceInk): void {
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
      if (o > 0.5) {
        const a = (o - 0.5) * 2;
        const r = Math.max(0.8, EYES.glint.r * R * k * (1 + 0.35 * pose.sparkle) * (kind === "small" ? 0.78 : 1)) * a;
        g.fillStyle = ink.light;
        g.beginPath();
        g.arc(ex + rxo * EYES.glint.x, yo + ryo * EYES.glint.y, r, 0, TAU);
        g.fill();
        if (pose.sparkle > 0.3) {
          g.beginPath();
          g.arc(ex + rxo * 0.36, yo + ryo * 0.42, Math.max(0.6, r * 0.42 * pose.sparkle), 0, TAU);
          g.fill();
        }
      }
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
  }
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
export function faceMarks(pair: string, cx: number, cy: number, R: number, pose: FacePose, ink: FaceInk): FaceMark[] {
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
    fill: () => {
      marks.push({ d, paint: String(pen.fillStyle), fill: true, width: 0 });
    },
    stroke: () => {
      marks.push({ d, paint: String(pen.strokeStyle), fill: false, width: pen.lineWidth });
    },
  };
  drawFace(pen, pair, cx, cy, R, pose, ink);
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

/**
 * The still's face at a point (nx, ny, in R units from the body's centre): how much of the eye's ink and of its
 * catchlight cover it, each a signed distance in R units (negative inside). Only the faces the stills wear: `OO` awake,
 * `^^` happy and `--` asleep (the lid's quadratic as the circle through its ends and its middle).
 */
export function faceField(nx: number, ny: number, pair: "OO" | "^^" | "--"): { readonly ink: number; readonly glint: number } {
  let ink = Infinity;
  let glint = Infinity;
  for (const side of [-1, 1]) {
    const ex = side * EYES.spread;
    const ey = EYES.row;
    if (pair === "OO") {
      const rx = EYES.open.rx;
      const ry = EYES.open.ry;
      ink = Math.min(ink, sdEllipse(nx - ex, ny - ey, rx, ry));
      glint = Math.min(glint, Math.hypot(nx - (ex + rx * EYES.glint.x), ny - (ey + ry * EYES.glint.y)) - EYES.glint.still);
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
