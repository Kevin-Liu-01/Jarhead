import { deflateSync } from "node:zlib";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { AgentMark, type AgentTool } from "@/components/kit/AgentMark";
import { GLYPHS, isLine, type GlyphName } from "@/components/kit/Glyph";
import { BAYER8_RANKS, QUIET_STOPS } from "@/lib/dither";
import { pngDataUri, renderOrb, type Face } from "@/lib/orb";

/**
 * THE 2.5D STACK, FILLED, THE BLOB IN IT (ART.md "The illustration system"; docs/ART-STYLE.md is the law): the shared parts
 * every picture is drawn from. A picture is a shallow stack of plates on the frame's ground, each plate offset along the 1:2
 * diagonal (dx = depth / 2 right, dy = depth down) so its side faces show; depth is drawn only by a dithered band on those
 * side faces (the 8×8 Bayer ranks at 2-unit cells, titanium cells over the plate's own fill), never a shadow; 1.5-unit strokes
 * outline the top faces; the section's phase colour is the lit face (a flat accent top with accent cells down its sides). The
 * orb is the real one (lib/orb.ts renderOrb at 2× into a PNG, deflated, defined once per picture and placed with <use>): 96 as
 * the picture's character, 64 as a thread of it, joined to it by a Flow of the halftone material. The stack fills its frame:
 * the subject reaches within MARGIN of every edge, a picture holds at most ELEMENTS (five) elements and `Art` counts them,
 * nothing under the FILL scale (glyphs 28 to 30, marks 24 to 28, values mono 13, tracks 36, tiles 32, badges 40). Server-only:
 * the PNG is deflated with node:zlib, so no client component may import this file. Colours only through --jh-* tokens, so both
 * themes come from html[data-theme] with no JS.
 */

export const W = 420;
const H = 315;
/** The one depth: 8 units along (4, 8). Small tiles and bars take 6 along (3, 6). */
const DEPTH = 8;
/** The most air a picture may leave between its subject and the frame's edge, on every side (the Mac's top edge runs from 0). Read by every picture for its edges. */
export const MARGIN = 16;
/** The most elements a picture may hold: an element is one thing the eye counts (a lane, a key, a wave, a chart, a row). `Art` throws past it. */
const ELEMENTS = 5;
/** A part under 4 units is a flat TICK-wide mark, never widened (an honest stub on a scale); a subject-scale glyph's ridges (the fingerprint, a clock's hands) are TICK wide too. */
export const TICK = 3;
export const STROKE = "var(--jh-fg-3)";
export const GROUND = "var(--jh-ground)";
export const RAISED = "var(--jh-raised)";
export const INK = "var(--jh-ink)";
const PAPER = "var(--jh-paper)";
export const FG = "var(--jh-fg)";
export const WORD = "var(--jh-fg-2)";
export const QUIET = "var(--jh-fg-3-word)";
export const HAIR = "var(--jh-hair)";
export const ERROR = "var(--jh-error)";
const SANS = "var(--font-sans)";
const MONO = "var(--font-mono)";

export type Token = `--jh-${string}`;
type Band = 1 | 2 | 3 | 4;

/** A picture's kit: its pattern ids (unique per picture, so no two svgs on a page share an id) and its accent as a `var()`. */
interface Kit {
  readonly id: string;
  /** The section's phase colour, `var(--jh-…)`: the one accent a picture may wear. */
  readonly accent: string;
  /** `url(#…)` of the titanium dither at band k of 5 (k·20 % of the cells on). */
  dither(k: Band): string;
  /** The same ranks in the accent: the lit plate's sides and a dissolving head. */
  lit(k: Band): string;
}

export function kit(id: string, accent: Token): Kit {
  return { id, accent: `var(${accent})`, dither: (k) => `url(#${id}-d${k})`, lit: (k) => `url(#${id}-a${k})` };
}

/** The cells of the 8×8 tile that are on at band k: rank < k · 64 / 5, each a 2 × 2 square, as one path. */
function cells(k: Band): string {
  const t = (k * 64) / 5;
  let d = "";
  for (let i = 0; i < 64; i++) {
    if ((BAYER8_RANKS[i] ?? 64) < t) d += `M${(i % 8) * 2} ${Math.floor(i / 8) * 2}h2v2h-2z`;
  }
  return d;
}

const BANDS: readonly Band[] = [1, 2, 3, 4];

/** The eight patterns (four bands × titanium / accent), 16 × 16 units in user space so every plate shares one grid; crisp edges so the cells snap to device pixels. */
function Defs({ k }: { readonly k: Kit }): ReactElement {
  return (
    <defs>
      {BANDS.map((b) => (
        <pattern key={`d${b}`} id={`${k.id}-d${b}`} width={16} height={16} patternUnits="userSpaceOnUse">
          <path d={cells(b)} fill="var(--jh-titanium)" shapeRendering="crispEdges" />
        </pattern>
      ))}
      {BANDS.map((b) => (
        <pattern key={`a${b}`} id={`${k.id}-a${b}`} width={16} height={16} patternUnits="userSpaceOnUse">
          <path d={cells(b)} fill={k.accent} shapeRendering="crispEdges" />
        </pattern>
      ))}
    </defs>
  );
}

/**
 * An element of a picture: one thing the eye counts (a wave, a key, the blob, a lane, a chart), named. Every part
 * of a picture is written inside one; `Art` counts them at render and throws past ELEMENTS, so the cap is enforced rather than
 * remembered. Write `El` in the picture's own JSX (a helper component's `El`s are not seen through).
 */
export function El({ name, children }: { readonly name: string; readonly children: ReactNode }): ReactElement {
  return <g data-element={name}>{children}</g>;
}

/** The `El`s under a node, outer ones only (what an element holds is its own business); arrays, fragments and plain groups are walked. */
function countElements(node: ReactNode): number {
  let n = 0;
  Children.forEach(node, (child) => {
    if (!isValidElement<{ readonly children?: ReactNode }>(child)) return;
    if (child.type === El) n += 1;
    else n += countElements(child.props.children);
  });
  return n;
}

/**
 * The picture root: 420 × 315 (4:3), the frame's width, role img labelled with deck cuts that say what it shows (never the
 * section's h2 again); it counts the picture's `El`s against ELEMENTS. A picture whose words are too many for one label
 * passes `null` and sets them beside the svg as a visually hidden `.art-words` list (Numbers); the svg is then hidden from
 * assistive tech. A picture that shares its frame with HTML (Rails) passes a shorter `height`.
 */
export function Art({ k, label, height = H, children }: { readonly k: Kit; readonly label: string | null; readonly height?: number; readonly children: ReactNode }): ReactElement {
  const n = countElements(children);
  if (n === 0) throw new Error(`${k.id}: a picture is drawn in El elements`);
  if (n > ELEMENTS) throw new Error(`${k.id}: ${n} elements, the cap is ${ELEMENTS}`);
  const a11y = label === null ? { "aria-hidden": true } : { role: "img", "aria-label": label };
  return (
    <svg className="art" viewBox={`0 0 ${W} ${height}`} width="100%" {...a11y} data-art={k.id} data-elements={n}>
      <Defs k={k} />
      {children}
    </svg>
  );
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * The side faces of a rounded rect extruded along (dx, dy): the hull between the front face and its offset, closed by the
 * chord the front face paints over. The two tangent segments run parallel to the offset from the extreme points of the
 * top-right and bottom-left arcs (the normal perpendicular to the offset).
 */
function extrude(x: number, y: number, w: number, h: number, r: number, dx: number, dy: number): string {
  const L = Math.hypot(dx, dy) || 1;
  const nx = dy / L;
  const ny = -dx / L;
  const p1x = x + w - r + r * nx;
  const p1y = y + r + r * ny;
  const p2x = x + r - r * nx;
  const p2y = y + h - r - r * ny;
  return [
    `M${f(p1x)} ${f(p1y)}`,
    `L${f(p1x + dx)} ${f(p1y + dy)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + w + dx)} ${f(y + r + dy)}`,
    `L${f(x + w + dx)} ${f(y + h - r + dy)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + w - r + dx)} ${f(y + h + dy)}`,
    `L${f(x + r + dx)} ${f(y + h + dy)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(p2x + dx)} ${f(p2y + dy)}`,
    `L${f(p2x)} ${f(p2y)}`,
    "Z",
  ].join("");
}

/** The same for a disc: two tangents and the far half of the offset circle. */
function extrudeDisc(cx: number, cy: number, r: number, dx: number, dy: number): string {
  const L = Math.hypot(dx, dy) || 1;
  const nx = dy / L;
  const ny = -dx / L;
  const p1x = cx + r * nx;
  const p1y = cy + r * ny;
  const p2x = cx - r * nx;
  const p2y = cy - r * ny;
  return `M${f(p1x)} ${f(p1y)}L${f(p1x + dx)} ${f(p1y + dy)}A${f(r)} ${f(r)} 0 1 1 ${f(p2x + dx)} ${f(p2y + dy)}L${f(p2x)} ${f(p2y)}Z`;
}

/** A part under 24 units on a side is marked small: site.css drops its side faces at the phone's width (clarity judge, graft 6). */
const sideClass = (w: number, h: number): string => (w < 24 || h < 24 ? "art-side art-side--sm" : "art-side");

interface PlateProps {
  readonly k: Kit;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Corner radius, 4 to 8 on a plate (a 6-wide bar takes 3). */
  readonly r?: number;
  /** The depth along the diagonal: 8 (plates) or 6 (tiles, bars). */
  readonly d?: number;
  /** The top face's flat fill; the ground (ink in dark, paper in light) by default, so a plate reads as the island's black plate or a light card. */
  readonly fill?: string;
  /** The lit plate: the accent as the top face, accent cells down the sides. */
  readonly lit?: boolean;
  /** The dither band on the side faces, 2 by default (40 %); a lit plate's sides take 3. */
  readonly band?: Band;
  /** The top face's stroke; omit the outline with `false` (a bar inside a track). */
  readonly stroke?: string | false;
  /** A dithered top face (titanium cells at this band over the fill): a grey slab, the halftone bar. */
  readonly top?: Band;
  readonly children?: ReactNode;
}

/** A plate of the stack: the dithered side faces, then the stroked top face, then what sits on it. */
export function Plate({ k, x, y, w, h, r = 6, d = DEPTH, fill = GROUND, lit, band, stroke = STROKE, top, children }: PlateProps): ReactElement {
  const dx = d / 2;
  const rr = Math.min(r, w / 2, h / 2);
  const side = extrude(x, y, w, h, rr, dx, d);
  const pat = lit ? k.lit(band ?? 3) : k.dither(band ?? 2);
  return (
    <g>
      <g className={sideClass(w, h)}>
        <path d={side} fill={fill} />
        <path d={side} fill={pat} />
        {stroke ? <path d={side} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" /> : null}
      </g>
      <rect x={x} y={y} width={w} height={h} rx={rr} fill={lit ? k.accent : fill} />
      {top ? <rect x={x} y={y} width={w} height={h} rx={rr} fill={k.dither(top)} /> : null}
      {stroke ? <rect x={x} y={y} width={w} height={h} rx={rr} fill="none" stroke={stroke} strokeWidth={1.5} /> : null}
      {children}
    </g>
  );
}

/** A disc of the stack (a key, a ring's seat): the same recipe on a circle. */
export function Disc({ k, cx, cy, r, d = DEPTH, fill = GROUND, lit, band, children }: { readonly k: Kit; readonly cx: number; readonly cy: number; readonly r: number; readonly d?: number; readonly fill?: string; readonly lit?: boolean; readonly band?: Band; readonly children?: ReactNode }): ReactElement {
  const side = extrudeDisc(cx, cy, r, d / 2, d);
  const pat = lit ? k.lit(band ?? 3) : k.dither(band ?? 2);
  return (
    <g>
      <g className={sideClass(2 * r, 2 * r)}>
        <path d={side} fill={fill} />
        <path d={side} fill={pat} />
        <path d={side} fill="none" stroke={STROKE} strokeWidth={1.5} strokeLinejoin="round" />
      </g>
      <circle cx={cx} cy={cy} r={r} fill={lit ? k.accent : fill} stroke={STROKE} strokeWidth={1.5} />
      {children}
    </g>
  );
}

/** A flat track a slab runs along: the raised tone inside a hairline, no depth (it is cut into the ground, not stacked on it). */
export function Track({ x, y, w, h, r = 4 }: { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly r?: number }): ReactElement {
  return <rect x={x} y={y} width={w} height={h} rx={r} fill={RAISED} stroke={HAIR} strokeWidth={1} />;
}

/** The dissolving head: three 4-unit steps at bands 3, 2, 1 (the app's own meter edge, lib/dither.ts renderMeter). */
const HEAD = 12;

/**
 * A bar on a track (a meter filling, a thread still running): a slab at depth 6 whose head dissolves through the dither
 * bands into the track; `lit` in the accent, else the halftone slab. Under 4 units it is a flat TICK-wide mark in the tone
 * (a scale's honest stub, never widened). A finished bar takes a plain Plate: its end is square to the track.
 */
export function Bar({ k, x, y, w, h, lit, dissolve }: { readonly k: Kit; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly lit?: boolean; readonly dissolve?: boolean }): ReactElement {
  if (w < 4) return <rect x={x} y={y} width={TICK} height={h} fill={lit ? k.accent : "var(--jh-titanium)"} />;
  const body = dissolve ? Math.max(4, w - HEAD) : w;
  const paint = lit ? k.lit : k.dither;
  return (
    <g>
      {lit ? <Plate k={k} x={x} y={y} w={body} h={h} r={4} d={6} lit band={3} stroke={false} /> : <Plate k={k} x={x} y={y} w={body} h={h} r={4} d={6} band={1} top={3} stroke={false} />}
      {dissolve ? ([3, 2, 1] as const).map((b, i) => <rect key={b} x={x + body + 4 * i} y={y} width={4} height={h} fill={paint(b)} shapeRendering="crispEdges" />) : null}
    </g>
  );
}

/** A knock-out: a disc of the face's own ground, so a glyph or a mark sits in a clean hole over a band, a slab or an orb (r 17 to 18 at the FILL scale). */
export function Hole({ cx, cy, r, fill = RAISED }: { readonly cx: number; readonly cy: number; readonly r: number; readonly fill?: string }): ReactElement {
  return <circle cx={cx} cy={cy} r={r} fill={fill} />;
}

/** A ring in one colour (the Touch ID ring, 8 wide in the accent, lit): flat, no depth. It belongs to the plate it sits on and is never the orb's own. */
export function Ring({ cx, cy, r, w = 8, color }: { readonly cx: number; readonly cy: number; readonly r: number; readonly w?: number; readonly color: string }): ReactElement {
  return <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={w} />;
}

/**
 * A flow: the halftone slab's material (the ground under titanium cells at band 3) run along a path as a band `w` wide with
 * round caps: a thread leaving the blob for its lane, a spoken line forking, a join between two plates. It is the same stuff as
 * a halftone Bar's top face, so a flow into a lane and the slab along it read as one thread. Flat: a flow is movement, never a
 * thing that stands. Draw it before the orbs and plates it joins, with its ends tucked 8 under them so no cap shows.
 */
export function Flow({ k, d, w = 10 }: { readonly k: Kit; readonly d: string; readonly w?: number }): ReactElement {
  return (
    <g fill="none" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke={GROUND} />
      <path d={d} stroke={k.dither(3)} />
    </g>
  );
}

/**
 * The Touch ID glyph (the kit has none; this is the family's, drawn once here): five ridges in a 46 × 41 box, the two outer
 * arcs, the middle arch, the inner arch and the centre line, scaled to `size` wide about (cx, cy) and stroked `ridge` units
 * ON THE PAGE (the stroke is divided by the scale) with round caps. A subject-scale glyph: its ridges are TICK wide.
 */
export function Fingerprint({ cx, cy, size = 70, color = FG, ridge = TICK }: { readonly cx: number; readonly cy: number; readonly size?: number; readonly color?: string; readonly ridge?: number }): ReactElement {
  const s = size / 46;
  return (
    <g fill="none" stroke={color} strokeWidth={f(ridge / s)} strokeLinecap="round" transform={`translate(${f(cx)} ${f(cy)}) scale(${f(s)}) translate(-210 -154.75)`}>
      <path d="M187 171V158A23 23 0 0 1 203 136" />
      <path d="M209 134.5A23 23 0 0 1 233 158V171" />
      <path d="M196 173V159A14 14 0 0 1 224 159V173" />
      <path d="M205 175V162A5 5 0 0 1 215 162V175" />
      <path d="M210 151V167" />
    </g>
  );
}

// ---- the orb: the real one (lib/orb.ts), rendered once per size and face into an inline PNG, defined once per picture ----

/** 96 as a picture's character (Wake's blob, Threads' main blob, Made's Dock icon), 64 as a thread of it at the end of a Flow, 128 where the blob is the subject alone; 32 stays for the rail and the sheet, never in a section picture. */
type OrbSize = 32 | 64 | 96 | 128;
const orbCache = new Map<string, string>();

/** Clipped to the disc like the kit's mark (BrandMarks.swift:446-466): the icon glow outside the disc goes transparent, so the orb sits on any plate. */
function clipToDisc(img: { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }): void {
  const { width, height, data } = img;
  const c = width / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - c, y + 0.5 - c) > c) data[(y * width + x) * 4 + 3] = 0;
    }
  }
}

/** node:zlib's deflate as the PNG writer's compressor: a 96 orb (192 px) is about 6 KB, a 128 orb (256 px) about 10. */
const zlib = (raw: Uint8Array): Uint8Array => new Uint8Array(deflateSync(raw, { level: 9 }));

/** The orb at `size` units: renderOrb at 2× (2 image px per unit) with 2 px cells (1-unit cells, the icon's own grain), the face in paper boxed in ink; `quiet` wears the titanium ramp (asleep, over, denied, locked). Cached per shape. */
function orbUri(size: OrbSize, face: Face, quiet?: boolean): string {
  const key = `${size}${face ?? "-"}${quiet ? "q" : ""}`;
  let uri = orbCache.get(key);
  if (!uri) {
    const img = renderOrb({ size: size * 2, cell: 2, face, stops: quiet ? QUIET_STOPS : undefined });
    clipToDisc(img);
    uri = pngDataUri(img, zlib);
    orbCache.set(key, uri);
  }
  return uri;
}

/** The orb placed once, centred at (cx, cy), at an integer scale (2 image px per unit), pixelated so the cells stay crisp. */
export function Orb({ cx, cy, size, face = null, quiet }: { readonly cx: number; readonly cy: number; readonly size: OrbSize; readonly face?: Face; readonly quiet?: boolean }): ReactElement {
  return <image href={orbUri(size, face, quiet)} x={cx - size / 2} y={cy - size / 2} width={size} height={size} style={{ imageRendering: "pixelated" }} />;
}

// ---- the kit's glyphs, the app's agent marks and the brand marks, drawn inside the picture ----

/** The FILL scale for a kit glyph: 24 in a badge or a hole, 28 to 30 on a column or at a track's head, 32 as a subject. */
type GlyphUnits = 24 | 28 | 30 | 32;

/** A kit glyph (components/kit/Glyph.tsx GLYPHS) at `size` units from its 20 box, top-left at (x, y), in one colour. */
export function G({ name, x, y, size = 28, color = WORD }: { readonly name: GlyphName; readonly x: number; readonly y: number; readonly size?: GlyphUnits; readonly color?: string }): ReactElement {
  const s = size / 20;
  return (
    <g transform={`translate(${f(x)} ${f(y)}) scale(${f(s)})`}>
      {GLYPHS[name].map((p, i) =>
        isLine(p) ? (
          <path key={i} d={p.d} fill="none" stroke={color} strokeWidth={p.w} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={p.dash} />
        ) : (
          <path key={i} d={p.d} fill={color} fillRule={p.rule} clipRule={p.rule} stroke={p.round ? color : undefined} strokeWidth={p.round} strokeLinejoin={p.round ? "round" : undefined} />
        ),
      )}
    </g>
  );
}

/** An agent mark (components/kit/AgentMark.tsx) with its top-left at (x, y), 24 to 32 units (the kit draws it at 24 and the group scales it up): the app's own drawing of the brain, in its brand colour or titanium while quiet. */
export function Mark({ tool, x, y, size = 24, quiet }: { readonly tool: AgentTool; readonly x: number; readonly y: number; readonly size?: 24 | 28 | 32; readonly quiet?: boolean }): ReactElement {
  return (
    <g transform={`translate(${f(x)} ${f(y)}) scale(${f(size / 24)})`}>
      <AgentMark tool={tool} size={24} quiet={quiet} />
    </g>
  );
}

/** A brand mark from @thesvg/react with its top-left at (x, y), in one ink: site.css pulls every path in `.art-brand` to currentColor, so a mark with no mono variant still wears the family's colour. */
export function Brand({ x, y, color = FG, children }: { readonly x: number; readonly y: number; readonly color?: string; readonly children: ReactNode }): ReactElement {
  return (
    <g className="art-brand" transform={`translate(${f(x)} ${f(y)})`} style={{ color }}>
      {children}
    </g>
  );
}

// ---- words and values ----

type Anchor = "start" | "middle" | "end";

/** A word from the deck, Inter 13, the second ink step; at most six in a picture. */
export function Label({ x, y, anchor = "start", color = WORD, size = 13, children }: { readonly x: number; readonly y: number; readonly anchor?: Anchor; readonly color?: string; readonly size?: 13 | 14; readonly children: string }): ReactElement {
  return (
    <text x={x} y={y} textAnchor={anchor} fontFamily={SANS} fontSize={size} fontWeight={500} fill={color}>
      {children}
    </text>
  );
}

/** A deck value (a figure), mono 13, tabular, in the first ink step. */
export function Value({ x, y, anchor = "start", color = FG, size = 13, children }: { readonly x: number; readonly y: number; readonly anchor?: Anchor; readonly color?: string; readonly size?: 13 | 14; readonly children: string }): ReactElement {
  return (
    <text x={x} y={y} textAnchor={anchor} fontFamily={MONO} fontSize={size} fontWeight={500} fill={color} style={{ fontVariantNumeric: "tabular-nums" }}>
      {children}
    </text>
  );
}

/** The blob's face as the island draws it (desk.css .desk-eyes): mono bold, the one weight above 500 the canon allows, paper on an ink screen piece; 18 on the lip. */
export function FaceText({ x, y, size = 18, color = PAPER, children }: { readonly x: number; readonly y: number; readonly size?: number; readonly color?: string; readonly children: string }): ReactElement {
  return (
    <text x={x} y={y} textAnchor="middle" fontFamily={MONO} fontSize={size} fontWeight={700} fill={color} style={{ whiteSpace: "pre", letterSpacing: "0.04em" }}>
      {children}
    </text>
  );
}
