import type { ReactElement } from "react";
import type { GlyphName } from "@/components/kit/Glyph";
import { RAILS } from "@/content/deck";
import { nth } from "@/lib/cut";
import { Art, El, ERROR, G, GROUND, Hole, INK, MARGIN, Plate, W, WORD, kit } from "./parts";

/**
 * 05 · Rails (ART-STYLE §8), the speaking accent, three elements, drawn 420 × 200 so the NEVER list can share the frame under
 * it (components/site/RailsPicture.tsx). Three rail plates down the drawing, one per verdict, each with its verdict at the
 * left (run: the check; confirm: the raised hand; refuse: the octagon in the error tone) and the same four tool families
 * across it (the shell, files, messages, the browser): no tool is special-cased. Confirm is lit, the one accent. No words.
 */
const K = kit("rails", "--jh-speaking");
const RAILS_H = 200;
const RAIL = { x: MARGIN, w: W - 2 * MARGIN - 4, h: 48, pitch: 60 } as const;
const TOOLS: readonly GlyphName[] = ["terminal", "folder", "send", "externalLink"];
const TOOL_X: readonly number[] = [136, 202, 268, 334];
const VERDICTS: ReadonlyArray<{ readonly glyph: GlyphName; readonly lit?: boolean; readonly error?: boolean }> = [
  { glyph: "checkCircle" },
  { glyph: "handRaised", lit: true },
  { glyph: "xOctagon", error: true },
];

export function ArtRails(): ReactElement {
  const [run, confirm, refuse] = VERDICTS.map((v, i) => {
    const y = MARGIN + i * RAIL.pitch;
    const cy = y + RAIL.h / 2;
    const ink = v.lit ? INK : WORD;
    return (
      <Plate key={y} k={K} x={RAIL.x} y={y} w={RAIL.w} h={RAIL.h} r={6} lit={v.lit} band={v.lit ? 3 : 2}>
        {v.error ? <Hole cx={RAIL.x + 30} cy={cy} r={17} fill={GROUND} /> : null}
        <G name={v.glyph} x={RAIL.x + 15} y={cy - 15} size={30} color={v.error ? ERROR : ink} />
        {TOOLS.map((t, j) => (
          <G key={t} name={t} x={(TOOL_X[j] ?? 0) - 12} y={cy - 12} size={24} color={ink} />
        ))}
      </Plate>
    );
  });
  return (
    <Art k={K} label={nth(RAILS.lead, 0)} height={RAILS_H}>
      <El name="run">{run}</El>
      <El name="confirm">{confirm}</El>
      <El name="refuse">{refuse}</El>
    </Art>
  );
}
