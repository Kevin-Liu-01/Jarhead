import type { ReactElement } from "react";
import { ICON_PATHS } from "@/components/desk/Icons";
import { COSTS } from "@/content/deck";
import { row } from "@/lib/cut";
import { Art, Bar, El, G, GROUND, HAIR, Hole, MARGIN, Plate, QUIET, Track, Value, W, kit } from "./parts";

/**
 * Costs (ART-STYLE §8), the listening accent. Two elements, no orb (a measure). Awake: a plate holding the session's meter,
 * a lit bar filling its track with the dissolving head (still filling), `$0.05` at its root and `$3` at its head, the
 * seconds ticked under it (it counts per second). Asleep: the same track empty, the crescent at its root, `$0`. Three values.
 */
const K = kit("costs", "--jh-listening");
const MIN = row(COSTS.figures, 0).value; // $0.05
const HOUR = row(COSTS.figures, 1).value; // $3
const ZERO = row(COSTS.figures, 2).value; // $0
/** What it shows, for a screen reader: the three figures it draws, each value with its deck label. */
const SAYS = COSTS.figures.map((f) => `${f.value} ${f.label}`).join(" · ");

const PLATE = { x: MARGIN, w: W - 2 * MARGIN - 4 } as const;
const AWAKE = { y: MARGIN + 8, h: 140 } as const;
const ASLEEP = { y: 194, h: 100 } as const;
const TRACK = { x: PLATE.x + 24, w: PLATE.w - 48, h: 36 } as const;

export function ArtCosts(): ReactElement {
  const ty = AWAKE.y + 58;
  const sy = ASLEEP.y + 32;
  return (
    <Art k={K} label={SAYS}>
      <El name="awake">
        <Plate k={K} x={PLATE.x} y={AWAKE.y} w={PLATE.w} h={AWAKE.h} r={8} d={8}>
          <G name="mic" x={TRACK.x - 2} y={AWAKE.y + 16} size={28} />
          <Value x={TRACK.x + 34} y={AWAKE.y + 36} size={14}>
            {MIN}
          </Value>
          <Value x={TRACK.x + TRACK.w} y={AWAKE.y + 36} anchor="end" size={14}>
            {HOUR}
          </Value>
          <Track x={TRACK.x} y={ty} w={TRACK.w} h={TRACK.h} />
          <Bar k={K} x={TRACK.x} y={ty} w={TRACK.w - 70} h={TRACK.h} lit dissolve />
          {Array.from({ length: 60 }, (_, i) => (
            <rect key={i} x={TRACK.x + 1 + (i * (TRACK.w - 3)) / 59} y={ty + TRACK.h + 10} width={1} height={i % 15 === 0 ? 14 : 8} fill={HAIR} />
          ))}
        </Plate>
      </El>

      <El name="asleep">
        <Plate k={K} x={PLATE.x} y={ASLEEP.y} w={PLATE.w} h={ASLEEP.h} r={8} d={8}>
          <Track x={TRACK.x + 52} y={sy} w={TRACK.w - 52} h={TRACK.h} />
          <Value x={TRACK.x + 66} y={sy + TRACK.h / 2 + 5} color={QUIET} size={14}>
            {ZERO}
          </Value>
        </Plate>
        <Hole cx={TRACK.x + 18} cy={sy + TRACK.h / 2} r={19} fill={GROUND} />
        <g transform={`translate(${TRACK.x + 18 - 14} ${sy + TRACK.h / 2 - 14}) scale(1.4)`}>
          <path d={ICON_PATHS.moon.d} fill="var(--jh-titanium)" />
        </g>
      </El>
    </Art>
  );
}
