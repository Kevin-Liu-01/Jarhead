/**
 * Wires between the pieces of a demo: orthogonal polylines with every turn rounded (the schematic's grammar,
 * docs/DIAGRAM-STYLE.md §3), measured from the laid-out boxes so one demo routes the same at every width. Pure.
 */
export type Pt = readonly [number, number];

interface Box {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
  readonly cx: number;
  readonly cy: number;
}

const f = (n: number): string => String(Math.round(n * 100) / 100);

/** An element's box relative to `root`'s top-left, in CSS px. */
export function boxIn(root: Element, el: Element | null): Box | null {
  if (!el) return null;
  const a = root.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  const l = b.left - a.left;
  const t = b.top - a.top;
  return { l, t, r: l + b.width, b: t + b.height, cx: l + b.width / 2, cy: t + b.height / 2 };
}

/** An orthogonal polyline through `pts` with each turn rounded at `r` (or half the shorter leg). */
export function route(pts: readonly Pt[], r = 12): string {
  const p0 = pts[0];
  if (!p0) return "";
  let d = `M${f(p0[0])} ${f(p0[1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1] as Pt;
    const b = pts[i] as Pt;
    const c = pts[i + 1] as Pt;
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = b[0] - ((b[0] - a[0]) / l1) * rr;
    const ay = b[1] - ((b[1] - a[1]) / l1) * rr;
    const cx = b[0] + ((c[0] - b[0]) / l2) * rr;
    const cy = b[1] + ((c[1] - b[1]) / l2) * rr;
    const sweep = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 0 ? 1 : 0;
    d += `L${f(ax)} ${f(ay)}A${f(rr)} ${f(rr)} 0 0 ${sweep} ${f(cx)} ${f(cy)}`;
  }
  const z = pts[pts.length - 1] as Pt;
  return `${d}L${f(z[0])} ${f(z[1])}`;
}

/** A small open chevron at the end of a wire whose last leg runs from `from` to `to`. */
export function chevron(from: Pt, to: Pt, s = 5): string {
  const dx = Math.sign(to[0] - from[0]);
  const dy = Math.sign(to[1] - from[1]);
  return `M${f(to[0] - dx * s - dy * s)} ${f(to[1] - dy * s - dx * s)}L${f(to[0])} ${f(to[1])}L${f(to[0] - dx * s + dy * s)} ${f(to[1] - dy * s + dx * s)}`;
}
