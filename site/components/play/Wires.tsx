"use client";
import { motion } from "motion/react";
import type { ReactElement } from "react";
import { CUT, ease } from "@/lib/motion";
import { chevron, route, type Pt } from "@/lib/route";

export interface WireSpec {
  readonly id: string;
  readonly pts: readonly Pt[];
  /** Lit: the path the line takes, solid in the section's tone; otherwise a quiet dashed wire. */
  readonly lit?: boolean;
  /** Ends in a chevron into its target. */
  readonly arrow?: boolean;
  /** Seconds before a lit wire starts drawing along its length. */
  readonly delay?: number;
}

/** A demo's wires: the list, the joints where they fork, and (for the server's resting layout) the stage they were drawn on. */
export interface WireSet {
  readonly list: readonly WireSpec[];
  readonly joints: readonly Pt[];
  /** The stage size the points were measured on: the server's still stretches them to the stage until JS measures. */
  readonly view?: readonly [number, number];
}

/**
 * The wires of a demo, as one svg over its stage: quiet dashed wires for the ways not taken, and the lit way drawn along
 * its length (Motion's pathLength) each time it lights; `play` keys the drawing, so a replay draws it again. Calm: the lit
 * way simply appears. A set with a `view` is the resting layout the server renders (measured once at 1440 and kept in the
 * demo), stretched to the stage with a stroke that never scales, so the still has its wires without JS; on hydration the
 * demo measures its own. Decorative: the pieces carry the words.
 */
export function Wires({ set, play, calm }: { readonly set: WireSet; readonly play: number; readonly calm: boolean }): ReactElement {
  const view = set.view;
  const fixed = view !== undefined;
  return (
    <svg className="wires" aria-hidden="true" viewBox={view ? `0 0 ${view[0]} ${view[1]}` : undefined} preserveAspectRatio={view ? "none" : undefined}>
      {set.list.map((w) => {
        const d = route(w.pts);
        const n = w.pts.length;
        const head = w.arrow && n > 1 ? chevron(w.pts[n - 2] as Pt, w.pts[n - 1] as Pt) : null;
        if (!w.lit || fixed)
          return (
            <g key={w.id} className={`wire${w.lit ? " is-lit" : ""}`}>
              <path d={d} vectorEffect={fixed ? "non-scaling-stroke" : undefined} />
              {head ? <path d={head} className="wire-head" vectorEffect={fixed ? "non-scaling-stroke" : undefined} /> : null}
            </g>
          );
        return (
          <g key={`${w.id}-${play}`} className="wire is-lit">
            <motion.path d={d} initial={calm ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={calm ? CUT : { ...ease("slow", "inout"), delay: w.delay ?? 0 }} />
            {head ? <motion.path d={head} className="wire-head" initial={calm ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={calm ? CUT : { ...ease("quick"), delay: (w.delay ?? 0) + 0.34 }} /> : null}
          </g>
        );
      })}
      {fixed
        ? null
        : set.joints.map((j, i) => <circle key={i} className="wire-joint" cx={j[0]} cy={j[1]} r={3} />)}
    </svg>
  );
}
