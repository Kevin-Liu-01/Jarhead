import type { ReactElement } from "react";
import { NUMBERS } from "@/content/deck";
import { row } from "@/lib/cut";
import { Art, Bar, El, Label, MARGIN, QUIET, STROKE, Value, W, kit } from "./parts";

/**
 * Numbers (ART-STYLE §8), the listening accent. One element, a chart: the five latencies after the 3 ms the words set big,
 * each a row of its deck value and its deck label over a bar as long as its time. The reflex path (ran on the bench) is lit:
 * prefire 126 ms and careful 457 ms. The model path (ran real Codex) is the halftone slab: the voice reply 1.11 s, the first
 * visible action 4.4 s, verified completion 8.9 s. The scale is honest: milliseconds to the left of a drawn break, seconds
 * to its right, every bar that crosses it cut by the same gap; the axis along the foot at the line law's 1.5 with end ticks
 * and the slanted break. No orb: a measure has no character in it.
 */
const K = kit("numbers", "--jh-listening");

/** A deck value (`126 ms`, `1.11 s`) in milliseconds; anything else is a build error, so a bar can never drift from the deck. */
function toMs(value: string): number {
  const m = /^([\d.]+) (ms|s)$/.exec(value);
  if (!m) throw new Error(`not a latency: ${value}`);
  return Math.round(Number(m[1]) * (m[2] === "s" ? 1000 : 1));
}

/** NUMBERS.figures 0 to 4: the two reflex windows, the voice reply, the first action, the verified end. */
const ROWS = [0, 1, 2, 3, 4].map((i) => {
  const f = row(NUMBERS.figures, i);
  return { value: f.value, label: f.label, ms: toMs(f.value) };
});
/** The reflex path (lit) against the model path (halftone): the ledger's own split (NUMBERS.lines). */
const REFLEX_MS = 500;

/** The honest scale: 0 to 500 ms across 180 units, a 14-unit break, then 0.5 s to 9 s across the rest, to the frame's right edge. */
const X0 = MARGIN;
const MS_END = 196;
const GAP_END = 210;
const S_END = W - MARGIN;
const PER_MS = (MS_END - X0) / REFLEX_MS;
const PER_S = (S_END - GAP_END) / 8.5;
const PITCH = 52;
const Y0 = MARGIN;
const BAR = { dy: 22, h: 24 } as const;
const LABEL_X = X0 + 64;
const AXIS_Y = 288;

/** The bar's pieces on the broken axis: one on the millisecond scale, and past the break one on the second scale. */
function pieces(ms: number): ReadonlyArray<readonly [number, number]> {
  if (ms <= REFLEX_MS) return [[X0, ms * PER_MS]];
  return [
    [X0, MS_END - X0],
    [GAP_END, (ms / 1000 - 0.5) * PER_S],
  ];
}

/** The drawing hides from assistive tech; its five value and label pairs follow it as a visually hidden list. */
export function ArtNumbers(): ReactElement {
  return (
    <>
      <Art k={K} label={null}>
        <El name="chart">
          {ROWS.map((r, i) => {
            const y = Y0 + i * PITCH;
            return (
              <g key={r.value}>
                <Value x={X0} y={y + 13} size={14}>
                  {r.value}
                </Value>
                <Label x={LABEL_X} y={y + 13} color={QUIET}>
                  {r.label}
                </Label>
                {pieces(r.ms).map(([x, w]) => (
                  <Bar key={x} k={K} x={x} y={y + BAR.dy} w={w} h={BAR.h} lit={r.ms <= REFLEX_MS} />
                ))}
              </g>
            );
          })}

          {/* the axis with its break: milliseconds, a gap, seconds; marks only at the line law's 1.5, the values carry the units */}
          <g fill="none" stroke={STROKE} strokeWidth={1.5} strokeLinecap="round">
            <path d={`M${X0} ${AXIS_Y}H${MS_END}M${GAP_END} ${AXIS_Y}H${S_END}`} />
            <path d={`M${X0} ${AXIS_Y - 6}V${AXIS_Y + 6}M${MS_END} ${AXIS_Y - 6}V${AXIS_Y + 6}M${GAP_END} ${AXIS_Y - 6}V${AXIS_Y + 6}M${S_END} ${AXIS_Y - 6}V${AXIS_Y + 6}`} />
            <path d={`M${MS_END + 2} ${AXIS_Y + 6}L${MS_END + 8} ${AXIS_Y - 6}M${GAP_END - 8} ${AXIS_Y + 6}L${GAP_END - 2} ${AXIS_Y - 6}`} />
          </g>
        </El>
      </Art>
      <ul className="art-words" role="list">
        {ROWS.map((r) => (
          <li key={r.value}>{`${r.value} ${r.label}`}</li>
        ))}
      </ul>
    </>
  );
}
