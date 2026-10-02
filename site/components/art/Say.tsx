import Apple from "@thesvg/react/apple";
import type { ReactElement, ReactNode } from "react";
import { SAY } from "@/content/deck";
import { first, part } from "@/lib/cut";
import { Art, Brand, El, FG, Flow, G, INK, Label, MARGIN, Mark, Orb, Plate, W, kit } from "./parts";

/**
 * Say (ART-STYLE §8), the thinking accent. Three elements. The blob the line leaves, the real orb at 96 at the left edge,
 * faceless (thinking). Two flows of the thread material leave it. Up: the reflex, to a lit 40 badge with the kit's bolt and
 * `"Click Save"` beside it: an unambiguous command reaches the hands at once. Across: the rest, to the brain picker, four
 * rows down the right side, each a brain's mark and its name cut from the h2 (Codex, Claude Code, a key, a model on this
 * Mac), the one in use lit with its check. Words: the command and the four names.
 */
const K = kit("say", "--jh-thinking");
const CLICK = part(SAY.lines[0], '"Click Save"');

/** The four brains the h2 names, in its order, each with the app's mark for it. */
const BRAINS: ReadonlyArray<{ readonly name: string; readonly mark: (x: number, y: number) => ReactNode; readonly on?: boolean }> = [
  { name: part(SAY.h2[0], "Codex"), mark: (x, y) => <Mark tool="codex" x={x} y={y} size={24} />, on: true },
  { name: part(SAY.h2[0], "Claude Code"), mark: (x, y) => <Mark tool="claude" x={x} y={y} size={24} /> },
  { name: part(SAY.h2[0], "a key"), mark: (x, y) => <G name="key" x={x} y={y} size={24} color={FG} /> },
  {
    name: part(SAY.h2[1], "a model on this Mac"),
    mark: (x, y) => (
      <Brand x={x} y={y - 1}>
        <Apple variant="mono" width={24} height={24} aria-hidden="true" focusable="false" />
      </Brand>
    ),
  },
];

const ORB = { cx: MARGIN + 48, cy: 190, size: 96 } as const;
/** The reflex badge at the top of the right column: 40 × 40, the bolt at 28 on it, the command on its middle line. */
const BADGE = { x: 148, y: MARGIN + 4, s: 40 } as const;
/** The picker: four rows 252 × 44 at a 52 pitch, the right edge at W - MARGIN - 4 (its side band to 404). */
const LIST = { x: 148, y: 84, w: W - MARGIN - 4 - 148, h: 44, pitch: 52 } as const;

export function ArtSay(): ReactElement {
  const x0 = ORB.cx + ORB.size / 2 - 8;
  const listMid = LIST.y + (LIST.pitch * (BRAINS.length - 1) + LIST.h) / 2;
  return (
    <Art k={K} label={first(SAY.lead, 2)}>
      {/* the reflex: a flow up to the bolt and the command */}
      <El name="reflex">
        <Flow k={K} d={`M${ORB.cx + 18} ${ORB.cy - 40}C${ORB.cx + 30} ${BADGE.y + 60} ${BADGE.x - 50} ${BADGE.y + BADGE.s / 2} ${BADGE.x + 8} ${BADGE.y + BADGE.s / 2}`} />
        <Plate k={K} x={BADGE.x} y={BADGE.y} w={BADGE.s} h={BADGE.s} r={6} d={6} lit band={3}>
          <G name="live" x={BADGE.x + 6} y={BADGE.y + 6} size={28} color={INK} />
        </Plate>
        <Label x={BADGE.x + BADGE.s + 18} y={BADGE.y + BADGE.s / 2 + 5} size={14} color={FG}>
          {CLICK}
        </Label>
      </El>

      {/* the rest: a flow across to the brain picker, four rows, the one in use lit with its check */}
      <El name="brains">
        <Flow k={K} d={`M${x0} ${ORB.cy}C${(x0 + LIST.x) / 2} ${ORB.cy} ${(x0 + LIST.x) / 2} ${listMid} ${LIST.x + 8} ${listMid}`} />
        {BRAINS.map((b, i) => {
          const y = LIST.y + i * LIST.pitch;
          const cy = y + LIST.h / 2;
          return (
            <Plate key={b.name} k={K} x={LIST.x} y={y} w={LIST.w} h={LIST.h} r={8} d={6} lit={b.on} band={b.on ? 3 : 2}>
              {b.mark(LIST.x + 14, cy - 12)}
              <Label x={LIST.x + 50} y={cy + 5} size={14} color={b.on ? INK : FG}>
                {b.name}
              </Label>
              {b.on ? <G name="checkCircle" x={LIST.x + LIST.w - 38} y={cy - 12} size={24} color={INK} /> : null}
            </Plate>
          );
        })}
      </El>

      {/* the blob the line leaves: faceless while the brain has it */}
      <El name="blob">
        <Orb cx={ORB.cx} cy={ORB.cy} size={ORB.size} />
      </El>
    </Art>
  );
}
