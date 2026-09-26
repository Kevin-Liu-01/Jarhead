import type { CSSProperties, ReactNode } from "react";

/**
 * Isometric helpers in Mailroom's construction (MAILROOM.md §4 "Construction"): points in (u, v, z), u down-right,
 * v down-left, z up; 1 px non-scaling strokes (.mr-iso in mr.css); every fill a color-mix of the --jh-* tokens so one
 * drawing renders in both themes. The "dark" tone is the ink colour (white in dark, ink in light), as Mailroom's sorter.
 */
export const COS = 0.866;
export const SIN = 0.5;
export type Pt = readonly [number, number];

export function iso(u: number, v: number, z = 0): Pt {
  return [(u - v) * COS, (u + v) * SIN - z];
}
const r = (n: number) => Math.round(n * 10) / 10;
export const poly = (points: readonly Pt[]) => points.map(([x, y]) => `${r(x)},${r(y)}`).join(" ");
/** Local x along u, local y along v, on the horizontal plane at height z, anchored at (u, v). */
export function plane(u: number, v: number, z: number): string {
  const [x, y] = iso(u, v, z);
  return `matrix(${COS} ${SIN} ${-COS} ${SIN} ${r(x)} ${r(y)})`;
}
/** Local x along u, local y straight down: the front-left face (the v = v1 plane) of a box, anchored at (u, v1, z). */
export function faceLeft(u: number, v1: number, z: number): string {
  const [x, y] = iso(u, v1, z);
  return `matrix(${COS} ${SIN} 0 1 ${r(x)} ${r(y)})`;
}

const mix = (a: string, pct: number, b = "transparent") => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
export const fg = (pct: number, base = "transparent") => mix("var(--jh-fg)", pct, base);

type Faces = { top: CSSProperties; left: CSSProperties; right: CSSProperties };
export const tones: Record<"plain" | "dark", Faces> = {
  plain: {
    top: { fill: mix("var(--jh-raised)", 94, "var(--jh-ground)"), stroke: fg(34) },
    left: { fill: fg(9, "var(--jh-raised)"), stroke: fg(26) },
    right: { fill: fg(15, "var(--jh-raised)"), stroke: fg(28) },
  },
  dark: {
    top: { fill: fg(84, "var(--jh-raised)"), stroke: fg(100) },
    left: { fill: fg(92, "var(--jh-raised)"), stroke: fg(100) },
    right: { fill: fg(97, "var(--jh-raised)"), stroke: fg(100) },
  },
};
const shadowStyle: CSSProperties = { fill: fg(7) };
const portStyle: CSSProperties = { fill: "var(--jh-accent)", stroke: mix("var(--jh-raised)", 70) };
const hexStyle: CSSProperties = { fill: mix("var(--jh-ground)", 86), stroke: fg(36) };
const hexFilledStyle: CSSProperties = { fill: mix("var(--jh-accent)", 22, "var(--jh-ground)"), stroke: mix("var(--jh-accent)", 60) };

/** A box as its three visible faces: left (+v), right (+u), top. Children paint on top of it. */
export function IsoBox({ u0, v0, u1, v1, z = 0, h, tone = "plain", shadow = false, children }: { u0: number; v0: number; u1: number; v1: number; z?: number; h: number; tone?: keyof typeof tones; shadow?: boolean; children?: ReactNode }) {
  const t = tones[tone];
  const top = z + h;
  return (
    <g>
      {shadow ? <polygon points={poly([iso(u0 + 5, v0 + 5), iso(u1 + 11, v0 + 5), iso(u1 + 11, v1 + 11), iso(u0 + 5, v1 + 11)])} style={shadowStyle} /> : null}
      <polygon className="mr-iso" points={poly([iso(u0, v1, top), iso(u1, v1, top), iso(u1, v1, z), iso(u0, v1, z)])} style={t.left} />
      <polygon className="mr-iso" points={poly([iso(u1, v0, top), iso(u1, v1, top), iso(u1, v1, z), iso(u1, v0, z)])} style={t.right} />
      <polygon className="mr-iso" points={poly([iso(u0, v0, top), iso(u1, v0, top), iso(u1, v1, top), iso(u0, v1, top)])} style={t.top} />
      {children}
    </g>
  );
}

/** A small accent hexagon where a wire meets a face. */
export function Port({ at, s = 4 }: { at: Pt; s?: number }) {
  const [x, y] = at;
  const pts: Pt[] = [[x, y - 1.2 * s], [x + s, y - 0.6 * s], [x + s, y + 0.6 * s], [x, y + 1.2 * s], [x - s, y + 0.6 * s], [x - s, y - 0.6 * s]];
  return <polygon points={poly(pts)} style={portStyle} strokeWidth={1} />;
}

/** A floating packet: outlined, or filled when it carries something. */
export function Hex({ at, s = 7, filled = false }: { at: Pt; s?: number; filled?: boolean }) {
  const [x, y] = at;
  const w = s * 0.87;
  const pts: Pt[] = [[x, y - s], [x + w, y - s / 2], [x + w, y + s / 2], [x, y + s], [x - w, y + s / 2], [x - w, y - s / 2]];
  return <polygon className="mr-iso" points={poly(pts)} style={filled ? hexFilledStyle : hexStyle} />;
}

/** A static wire with the signal dash riding along it (globals.css:132-133). */
export function Wire({ d }: { d: string }) {
  return (
    <>
      <path className="mr-wire" d={d} />
      <path className="mr-signal" d={d} />
    </>
  );
}
