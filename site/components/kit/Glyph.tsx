import type { ReactElement } from "react";

/**
 * ConsoleGlyph's web twins (UI/Console/ConsoleGlyph.swift:3-90; ConsoleTheme.swift:805-822). Every name is
 * an inline SVG in a 20-unit box drawn by hand in the app's optical weight: the app's 13 pt medium symbol
 * fills about 12 × 12 of its 20 pt column, so the ink here stays inside a 13 × 13 core (a disc 17, nothing past
 * 1.5 → 18.5), line glyphs stroke 1.5 with round caps and joins, the chrome that stands alone at 14 px (a chevron,
 * ×, ±, ✓, the picker) 1.75 to sit nearer the app's 9 pt semibold, filled shapes carry r 1 corners. SF Symbols are Apple's and none of their
 * data ships: these are our own paths. The rule (ConsoleGlyph.swift:3-9): a glyph that IS the verb goes
 * filled; chrome inside another box (a field's ×, a stepper's ±, a chevron, the ⋯ in its tile) stays a line,
 * because the box is its solid. Knock-outs inside a disc are evenodd sub-paths that touch but never overlap.
 */
export type GlyphName =
  // verbs, filled (ConsoleGlyph.swift:15-44)
  | "send" | "reload" | "undo" | "search" | "dismiss" | "externalLink" | "folder" | "live" | "quit" | "ask" | "voice" | "switchVoice"
  | "stop" | "play" | "pause" | "mic" | "muted"
  // chrome, kept as lines (ConsoleGlyph.swift:46-73)
  | "cross" | "magnifier" | "ellipsis" | "chevron" | "chevronLeft" | "picker" | "checkmark" | "scopeMark" | "plus" | "minus" | "circle" | "summon"
  | "reloadLine" | "earlierLine" | "newestLine" | "undoLine"
  // status, solid and tinted by state (ConsoleTheme.swift:149-229; ProblemGlyphs.swift:8-26)
  | "checkCircle" | "xOctagon" | "exclamationCircle" | "questionCircle" | "handRaised" | "hourglass" | "stopCircle" | "slashCircle" | "lock" | "key" | "terminal" | "dot"
  // the site's own verb (doc.on.doc.fill's twin for the Copy buttons)
  | "copy";

export type GlyphSize = 14 | 16 | 20;

type Fill = { readonly d: string; readonly rule?: "evenodd"; readonly round?: number };
type Line = { readonly d: string; readonly w: number; readonly dash?: string };
type Prim = Fill | Line;
const isLine = (p: Prim): p is Line => "w" in p;

type Pt = readonly [number, number];
const f = (n: number): string => String(Math.round(n * 100) / 100);
const P = (p: Pt): string => `${f(p[0])} ${f(p[1])}`;

/** A point on a circle at `deg` clockwise from the top, in SVG's y-down box. */
const at = (cx: number, cy: number, r: number, deg: number): Pt => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
};
const poly = (pts: readonly Pt[]): string => `M${pts.map(P).join("L")}Z`;
const disc = (cx: number, cy: number, r: number): string => `M${f(cx)} ${f(cy - r)}A${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy + r)}A${f(r)} ${f(r)} 0 1 1 ${f(cx)} ${f(cy - r)}Z`;
const rrect = (x: number, y: number, w: number, h: number, r: number): string => {
  const R = Math.min(r, w / 2, h / 2);
  return `M${f(x + R)} ${f(y)}H${f(x + w - R)}A${f(R)} ${f(R)} 0 0 1 ${f(x + w)} ${f(y + R)}V${f(y + h - R)}A${f(R)} ${f(R)} 0 0 1 ${f(x + w - R)} ${f(y + h)}H${f(x + R)}A${f(R)} ${f(R)} 0 0 1 ${f(x)} ${f(y + h - R)}V${f(y + R)}A${f(R)} ${f(R)} 0 0 1 ${f(x + R)} ${f(y)}Z`;
};
/** An annular sector: radius r, width w, from `from` clockwise to `to` (degrees from the top); its caps are radial. */
const arc = (cx: number, cy: number, r: number, w: number, from: number, to: number): string => {
  const ro = r + w / 2;
  const ri = r - w / 2;
  const large = to - from > 180 ? 1 : 0;
  return `M${P(at(cx, cy, ro, from))}A${f(ro)} ${f(ro)} 0 ${large} 1 ${P(at(cx, cy, ro, to))}L${P(at(cx, cy, ri, to))}A${f(ri)} ${f(ri)} 0 ${large} 0 ${P(at(cx, cy, ri, from))}Z`;
};
/** The stroked form of the same arc, for line glyphs. */
const arcLine = (cx: number, cy: number, r: number, from: number, to: number): string =>
  `M${P(at(cx, cy, r, from))}A${f(r)} ${f(r)} 0 ${to - from > 180 ? 1 : 0} 1 ${P(at(cx, cy, r, to))}`;
/** A triangular head seated on the radial line at `deg` (base 2h across), pointing along the clockwise tangent by `len`. */
const head = (cx: number, cy: number, r: number, deg: number, len: number, h: number): string => {
  const a = (deg * Math.PI) / 180;
  const [ex, ey] = at(cx, cy, r, deg);
  return poly([at(cx, cy, r - h, deg), at(cx, cy, r + h, deg), [ex + Math.cos(a) * len, ey + Math.sin(a) * len]]);
};
/** A polyline outlined as one polygon of width w with mitred joins: a tick or a chevron that can be knocked out. */
const outline = (pts: readonly Pt[], w: number): string => {
  const h = w / 2;
  const n = pts.length;
  const nrm = (i: number): Pt => {
    const a = pts[i] ?? [0, 0];
    const b = pts[i + 1] ?? [0, 0];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = pts[i] ?? [0, 0];
    let ox: number;
    let oy: number;
    if (i === 0 || i === n - 1) {
      const [nx, ny] = nrm(i === 0 ? 0 : n - 2);
      ox = nx * h;
      oy = ny * h;
    } else {
      const [ax, ay] = nrm(i - 1);
      const [bx, by] = nrm(i);
      const k = h / (1 + ax * bx + ay * by);
      ox = (ax + bx) * k;
      oy = (ay + by) * k;
    }
    left.push([x + ox, y + oy]);
    right.push([x - ox, y - oy]);
  }
  return poly([...left, ...right.reverse()]);
};
/** A plus of half-length `half` and bar width w, rotated `rot` degrees about (cx, cy): the × is this at 45. */
const plus = (cx: number, cy: number, half: number, w: number, rot: number): string => {
  const h = w / 2;
  const raw: Pt[] = [[h, h], [half, h], [half, -h], [h, -h], [h, -half], [-h, -half], [-h, -h], [-half, -h], [-half, h], [-h, h], [-h, half], [h, half]];
  const a = (rot * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return poly(raw.map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]));
};
/** A rounded rectangle as a clockwise polygon (arcs sampled), so it can be clipped. */
const rrectPoly = (x: number, y: number, w: number, h: number, r: number, steps = 6): Pt[] => {
  const out: Pt[] = [];
  const corners: ReadonlyArray<readonly [number, number, number]> = [[x + r, y + r, 270], [x + w - r, y + r, 0], [x + w - r, y + h - r, 90], [x + r, y + h - r, 180]];
  for (const [cx, cy, start] of corners) for (let i = 0; i <= steps; i++) out.push(at(cx, cy, r, start + (90 * i) / steps));
  return out;
};
/** Sutherland–Hodgman against the half-plane a·x + b·y + c ≥ 0. */
const clip = (p: readonly Pt[], a: number, b: number, c: number): Pt[] => {
  const out: Pt[] = [];
  const side = (q: Pt): number => a * q[0] + b * q[1] + c;
  for (let i = 0; i < p.length; i++) {
    const cur = p[i] ?? [0, 0];
    const prev = p[(i + p.length - 1) % p.length] ?? [0, 0];
    const sc = side(cur);
    const sp = side(prev);
    if (sc >= 0) {
      if (sp < 0) {
        const t = sp / (sp - sc);
        out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
      }
      out.push(cur);
    } else if (sp >= 0) {
      const t = sp / (sp - sc);
      out.push([prev[0] + (cur[0] - prev[0]) * t, prev[1] + (cur[1] - prev[1]) * t]);
    }
  }
  return out;
};

const DISC = disc(10, 10, 8.5);
const line = (d: string, w = 1.5): Line => ({ d, w });
/** The chrome lines that stand alone in a column: 1.75 units, about 1.2 px at 14 (the app's chevrons and × are 9 pt semibold). */
const chrome = (d: string): Line => line(d, 1.75);
const fill = (d: string): Fill => ({ d });
const cut = (...d: string[]): Fill => ({ d: d.join(""), rule: "evenodd" });
const soft = (d: string, round: number): Fill => ({ d, round });

// The mic: a capsule, the U cradle, a stem and a foot (mic.fill's proportions on the 20 box).
const MIC_CAPSULE = rrectPoly(7, 2, 6, 11, 3);
const MIC_CRADLE = line("M5 9V10A5 5 0 0 0 15 10V9");
const MIC_STEM = fill(`${rrect(9.25, 14.75, 1.5, 3, 0)}${rrect(7, 16.75, 6, 1.5, 0.75)}`);
// The slash from (4,3) to (16,17): the capsule splits along it with a 1-unit gap on the slash's upper side (mic.slash.fill).
const SL = Math.hypot(12, 14);
const SN: Pt = [14 / SL, -12 / SL];
const SC = -(SN[0] * 4 + SN[1] * 3);

const GLYPHS: Record<GlyphName, readonly Prim[]> = {
  // ---- verbs, filled ----
  send: [soft(poly([[10, 3.5], [15.75, 9.25], [12.75, 9.25], [12.75, 16.25], [7.25, 16.25], [7.25, 9.25], [4.25, 9.25]]), 1.5)],
  reload: [cut(DISC, arc(10, 10, 4.5, 1.5, 90, 360), head(10, 10, 4.5, 360, 3, 2))],
  undo: [cut(DISC, arc(12.5, 10, 2.5, 1.5, 0, 180), poly([[8.5, 6.75], [12.5, 6.75], [12.5, 8.25], [8.5, 8.25]]), poly([[8, 11.75], [12.5, 11.75], [12.5, 13.25], [8, 13.25]]), poly([[8, 10.25], [8, 14.75], [5, 12.5]]))],
  search: [cut(DISC, disc(9, 9, 3.75), disc(9, 9, 2.25), poly([[12.18, 11.12], [14.83, 13.77], [13.77, 14.83], [11.12, 12.18]]))],
  dismiss: [cut(DISC, plus(10, 10, 4, 1.5, 45))],
  externalLink: [cut(rrect(3, 3, 14, 14, 3), poly([[7.03, 14.03], [12.25, 8.81], [12.25, 11.5], [13.75, 11.5], [13.75, 6.25], [8.5, 6.25], [8.5, 7.75], [11.19, 7.75], [5.97, 12.97]]))],
  folder: [cut(rrect(2, 6, 16, 10.5, 2), "M2 6V5A1.5 1.5 0 0 1 3.5 3.5H7.6A1 1 0 0 1 8.4 3.9L10 6Z", poly([[8.5, 7], [16, 7], [16, 8], [8.5, 8]]))],
  live: [soft(poly([[12, 2.5], [6.5, 11], [9.75, 11], [8.25, 17.5], [13.75, 9], [10.5, 9]]), 1.2)],
  quit: [cut(DISC, arc(10, 10, 4.5, 1.5, 30, 330), poly([[9.25, 4], [10.75, 4], [10.75, 9.75], [9.25, 9.75]]))],
  ask: [
    cut(
      ...[3, 8, 13].flatMap((y) => [rrect(3, y, 5, 5, 1), outline([[4.1, y + 2.6], [5.4, y + 3.9], [6.9, y + 1.5]], 1), rrect(10, y + 1.5, 7, 2, 1)]),
    ),
  ],
  // the waves at (12.7, 10), r 2.5 and 5, so the outer stroke ends at 18.45
  voice: [fill(`${disc(7, 6, 3)}M2 17V14.5A5 5 0 0 1 12 14.5V17Z`), line(arcLine(12.7, 10, 2.5, 45, 135)), line(arcLine(12.7, 10, 5, 45, 135))],
  switchVoice: [cut(DISC, arc(10, 10, 4.5, 1.5, 290, 430), head(10, 10, 4.5, 430, 2.5, 1.75), arc(10, 10, 4.5, 1.5, 110, 250), head(10, 10, 4.5, 250, 2.5, 1.75))],
  stop: [fill(rrect(4, 4, 12, 12, 2))],
  play: [soft(poly([[6.25, 4.25], [15.75, 10], [6.25, 15.75]]), 1.5)],
  pause: [fill(`${rrect(4.5, 3.5, 4, 13, 1)}${rrect(11.5, 3.5, 4, 13, 1)}`)],
  mic: [fill(poly(MIC_CAPSULE)), MIC_CRADLE, MIC_STEM],
  muted: [
    fill(`${poly(clip(MIC_CAPSULE, SN[0], SN[1], SC - 1.75))}${poly(clip(MIC_CAPSULE, -SN[0], -SN[1], -SC - 0.75))}`),
    MIC_CRADLE,
    MIC_STEM,
    line("M4 3L16 17"),
  ],
  // ---- chrome, kept as lines ----
  cross: [chrome("M5.5 5.5L14.5 14.5M14.5 5.5L5.5 14.5")],
  magnifier: [line(disc(8.5, 8.5, 5)), line("M12.04 12.04L16.5 16.5")],
  ellipsis: [fill(`${disc(4.5, 10, 1.6)}${disc(10, 10, 1.6)}${disc(15.5, 10, 1.6)}`)],
  chevron: [chrome("M7.5 5L12.5 10L7.5 15")],
  chevronLeft: [chrome("M12.5 5L7.5 10L12.5 15")],
  picker: [chrome("M7 8.5L10 5.5L13 8.5M7 11.5L10 14.5L13 11.5")],
  checkmark: [chrome("M4 10.5L8.5 15L16 5.5")],
  // the ring r 5 with 2-unit ticks past its stroke, so the ticks' caps end at 1.5 and 18.5
  scopeMark: [line(disc(10, 10, 5)), line("M10 4.25V2.25M10 15.75V17.75M4.25 10H2.25M15.75 10H17.75"), fill(disc(10, 10, 1.2))],
  plus: [chrome("M5 10H15M10 5V15")],
  minus: [chrome("M5 10H15")],
  circle: [{ d: rrect(2.75, 8.75, 11.5, 8.5, 2), w: 1.25, dash: "2 1.5" }, line("M16.25 3.75L10.25 9.75", 2.4), fill(poly([[9.4, 8.9], [11.1, 10.6], [7.75, 12.25]]))],
  // the arrow's tip at (7, 7.5), the click's arcs r 3 and 5.25 from it: the outer arc's cap clears 1.5, the tail's 18.5
  summon: [soft(poly([[7, 7.5], [7, 16.12], [9.18, 14.03], [10.81, 17.3], [12.35, 16.57], [10.81, 13.4], [13.8, 13.4]]), 1), line(arcLine(7, 7.5, 3, 15, 75)), line(arcLine(7, 7.5, 5.25, 15, 75))],
  reloadLine: [line(arcLine(10, 10, 6, 90, 360)), fill(poly([[10, 2], [10, 6], [13.5, 4]]))],
  earlierLine: [line("M10 16.5V3.5M5.5 8L10 3.5L14.5 8")],
  newestLine: [line("M10 3.5V16.5M5.5 12L10 16.5L14.5 12")],
  undoLine: [line("M15 16V10.5A4 4 0 0 0 11 6.5H4.5M7.5 3.5L4.5 6.5L7.5 9.5")],
  // ---- status ----
  checkCircle: [cut(DISC, outline([[5.75, 10.25], [8.75, 13.25], [14.25, 7.25]], 1.75))],
  xOctagon: [cut(poly([0, 1, 2, 3, 4, 5, 6, 7].map((k) => at(10, 10, 8.5, 22.5 + 45 * k))), plus(10, 10, 3.75, 1.5, 45))],
  exclamationCircle: [cut(DISC, rrect(9.2, 5, 1.6, 6.5, 0.8), disc(10, 14, 1))],
  questionCircle: [cut(DISC, arc(10, 7.8, 2.6, 1.5, 250, 540), poly([[9.25, 11.15], [10.75, 11.15], [10.75, 12.7], [9.25, 12.7]]), disc(10, 15.25, 1.05))],
  handRaised: [soft(`${rrect(4.5, 10, 10.5, 7.5, 3)}${rrect(5.4, 3.5, 2.3, 8, 1.15)}${rrect(8.2, 2.25, 2.3, 9.5, 1.15)}${rrect(11, 3, 2.3, 8.5, 1.15)}${outline([[14.2, 11], [17.2, 7.2]], 2.2)}`, 1)],
  hourglass: [fill(poly([[4.5, 3], [15.5, 3], [15.5, 4.75], [14, 4.75], [14, 6.5], [10.9, 10], [14, 13.5], [14, 15.25], [15.5, 15.25], [15.5, 17], [4.5, 17], [4.5, 15.25], [6, 15.25], [6, 13.5], [9.1, 10], [6, 6.5], [6, 4.75], [4.5, 4.75]]))],
  stopCircle: [cut(DISC, rrect(7, 7, 6, 6, 1))],
  slashCircle: [cut(DISC, outline([[5.5, 14.5], [14.5, 5.5]], 1.5))],
  lock: [fill(rrect(4, 9, 12, 9, 2)), line("M6.75 9.5V7.25A3.25 3.25 0 0 1 13.25 7.25V9.5", 1.75)],
  key: [line(disc(6.5, 13.5, 2.75), 2), line("M8.5 11.5L16.5 3.5M13 7L15.25 9.25", 2)],
  terminal: [cut(rrect(2, 3.5, 16, 13, 2), outline([[5.5, 7], [8.5, 10], [5.5, 13]], 1.5), poly([[10.5, 12.5], [14.5, 12.5], [14.5, 14], [10.5, 14]]))],
  dot: [fill(disc(10, 10, 3))],
  // ---- the site's own ----
  copy: [fill(rrect(7, 6, 9, 11, 1.5)), line("M12.5 3.5H5.5A1.5 1.5 0 0 0 4 5V12.5")],
};

export const GLYPH_NAMES: readonly GlyphName[] = Object.keys(GLYPHS) as GlyphName[];

/**
 * `<Glyph name size />`: aria-hidden unless `label` names it (then role="img"). fill: currentColor, so the
 * glyph wears the token of the text around it (titanium on the icon column, --jh-fg-2 on a ghost button).
 */
export function Glyph({ name, size = 16, label, className }: { readonly name: GlyphName; readonly size?: GlyphSize; readonly label?: string; readonly className?: string }): ReactElement {
  const prims = GLYPHS[name];
  const cls = `kit-glyph${className ? ` ${className}` : ""}`;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg className={cls} width={size} height={size} viewBox="0 0 20 20" fill="currentColor" focusable="false" data-glyph={name} {...a11y}>
      {prims.map((p, i) =>
        isLine(p) ? (
          <path key={i} d={p.d} fill="none" stroke="currentColor" strokeWidth={p.w} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={p.dash} />
        ) : (
          <path key={i} d={p.d} fillRule={p.rule} clipRule={p.rule} stroke={p.round ? "currentColor" : undefined} strokeWidth={p.round} strokeLinejoin={p.round ? "round" : undefined} />
        ),
      )}
    </svg>
  );
}
