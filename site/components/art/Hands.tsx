import type { ReactElement } from "react";
import { HANDS, SAY } from "@/content/deck";
import { nth, part } from "@/lib/cut";
import { Art, El, FG, Flow, G, GROUND, HAIR, Hole, Label, MARGIN, Orb, Plate, STROKE, W, kit } from "./parts";

/**
 * 04 · Hands (ART-STYLE §8), the accent, five elements. A window plate fills the frame: its title strip of three discs,
 * a row of three controls; the one the hands found by its label is lit, `Save`, inside the dashed circle the kit's circle
 * glyph draws. The blob stands on the window's floor wearing `^ ^`, and the pointer's path runs from it to the lit control
 * as a flow. At the lower right a screenshot plate with a check stamped on it: it only verifies. Read left to right and up;
 * never numbered. One word.
 */
const K = kit("hands", "--jh-accent");
const SAVE = part(SAY.lines[0], "Save");
/** The word on the lit control follows the accent fill, as the kit's primary does: paper on the light accent, ink on the dark lift. */
const ON_ACCENT = "var(--jh-on-accent)";

const WIN = { x: MARGIN, y: MARGIN, w: W - 2 * MARGIN, h: 283 } as const;
const TILE = 48;
const ROW_Y = 64;
const TARGET = { x: 272, y: ROW_Y } as const;
const ORB = { cx: 96, cy: 200, size: 96 } as const;
const SHOT = { x: 268, y: 200, w: 120, h: 84 } as const;

export function ArtHands(): ReactElement {
  const tcx = TARGET.x + TILE / 2;
  const tcy = TARGET.y + TILE / 2;
  return (
    <Art k={K} label={nth(HANDS.lead, 1)}>
      <El name="window">
        <Plate k={K} x={WIN.x} y={WIN.y} w={WIN.w} h={WIN.h} r={8}>
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={WIN.x + 18 + i * 16} cy={WIN.y + 16} r={4.5} fill={STROKE} />
          ))}
          <rect x={WIN.x} y={WIN.y + 31} width={WIN.w} height={1} fill={HAIR} />
          <Plate k={K} x={48} y={ROW_Y} w={TILE} h={TILE} r={6} d={6}>
            <G name="folder" x={48 + 12} y={ROW_Y + 12} size={24} />
          </Plate>
          <Plate k={K} x={160} y={ROW_Y} w={TILE} h={TILE} r={6} d={6}>
            <G name="send" x={160 + 12} y={ROW_Y + 12} size={24} />
          </Plate>
        </Plate>
      </El>

      {/* the pointer's path from the blob to the control it found */}
      <El name="travel">
        <Flow k={K} d={`M${ORB.cx + 30} ${ORB.cy - 30}C200 ${ORB.cy - 30} 200 ${tcy} ${TARGET.x + 8} ${tcy}`} />
      </El>

      {/* the control the hands found by its label: lit, inside the circle */}
      <El name="target">
        <Plate k={K} x={TARGET.x} y={TARGET.y} w={TILE} h={TILE} r={6} d={6} lit band={3}>
          <Label x={tcx} y={tcy + 4.5} anchor="middle" color={ON_ACCENT}>
            {SAVE}
          </Label>
        </Plate>
        <circle cx={tcx} cy={tcy} r={36} fill="none" stroke={K.accent} strokeWidth={2} strokeDasharray="4 3" />
      </El>

      <El name="blob">
        <Orb cx={ORB.cx} cy={ORB.cy} size={ORB.size} face="^^" />
      </El>

      {/* the screenshot: a captured plate, a check stamped at its corner */}
      <El name="shot">
        <Plate k={K} x={SHOT.x} y={SHOT.y} w={SHOT.w} h={SHOT.h} r={6} d={6} top={1}>
          <Hole cx={SHOT.x + SHOT.w - 22} cy={SHOT.y + SHOT.h - 22} r={18} fill={GROUND} />
          <G name="checkCircle" x={SHOT.x + SHOT.w - 36} y={SHOT.y + SHOT.h - 36} size={28} color={FG} />
        </Plate>
      </El>
    </Art>
  );
}
