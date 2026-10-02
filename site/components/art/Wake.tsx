import type { ReactElement } from "react";
import { ALT, WAKE } from "@/content/deck";
import { parts, row } from "@/lib/cut";
import { Art, Disc, El, FaceText, Fingerprint, Label, MARGIN, Orb, Ring, W, kit, type Token } from "./parts";

/**
 * Wake (ART-STYLE §8), the listening accent. Four elements. On one axis across the top two thirds, the h2 read left to
 * right: the word enters as a wave of six lit capsules from the left edge; the blob, the real orb at 96 wearing `O O`, has
 * heard it; the key, the Touch ID disc r 74 with its ring lit around the fingerprint, touches the right edge. Along the foot
 * the gate's five faces (README:163; blob-eyes.jpg), each a piece of the notch's black with the face in its phase tone, named
 * from the deck (WAKE.faces). No notch stratum: the page's own Mac top edge hangs above the picture.
 */
const K = kit("wake", "--jh-listening");

/** The one axis the wave, the blob and the key sit on. */
const AXIS_Y = 112;
const KEY = { cx: W - MARGIN - 4 - 74, cy: AXIS_Y, r: 74, ring: 60, ringW: 8, print: 64 } as const;
const ORB = { cx: 176, cy: AXIS_Y, size: 96 } as const;
/** The wave: six lit capsules 12 wide at a 20 pitch from the left edge, a spoken burst rising to a 128 crest and falling into the blob. */
const WAVE: readonly number[] = [32, 64, 96, 128, 104, 72];
const WAVE_PITCH = 20;
const WAVE_W = 12;

/** The five gate faces, each in its phase colour (BlobField.swift via facts-orb.md §3), under their names from the deck. */
const FACES: ReadonlyArray<{ readonly pair: string; readonly tone: Token }> = [
  { pair: ". .", tone: "--jh-asleep" },
  { pair: "O O", tone: "--jh-listening" },
  { pair: "^ ^", tone: "--jh-listening" },
  { pair: "> <", tone: "--jh-error" },
  { pair: "- -", tone: "--jh-muted" },
];
const NAMES = parts(WAKE.faces); // gate · heard · granted · denied · locked
if (NAMES.length !== FACES.length) throw new Error("the gate faces and their names drifted");
/** The strip: five tabs 68 × 36 at a 78 pitch, centred, hanging from the strip's top line as the notch hangs from the bar. */
const TAB = { w: 68, h: 36, pitch: 78, y: 214, r: 10 } as const;
const TAB_X0 = (W - (FACES.length - 1) * TAB.pitch - TAB.w) / 2;

/** A tab's outline: square shoulders at the top, rounded at the foot, like the notch. */
const tab = (x: number): string =>
  `M${x} ${TAB.y}H${x + TAB.w}V${TAB.y + TAB.h - TAB.r}A${TAB.r} ${TAB.r} 0 0 1 ${x + TAB.w - TAB.r} ${TAB.y + TAB.h}H${x + TAB.r}A${TAB.r} ${TAB.r} 0 0 1 ${x} ${TAB.y + TAB.h - TAB.r}Z`;

export function ArtWake(): ReactElement {
  return (
    <Art k={K} label={ALT.blobGate}>
      {/* the word entering from the left: six lit capsules on the axis, flat (sound is a mark, not a plate) */}
      <El name="wave">
        {WAVE.map((h, i) => (
          <rect key={i} x={MARGIN + i * WAVE_PITCH} y={AXIS_Y - h / 2} width={WAVE_W} height={h} rx={WAVE_W / 2} fill={K.accent} />
        ))}
      </El>

      {/* the blob that heard it: the real orb at 96 wearing O O */}
      <El name="blob">
        <Orb cx={ORB.cx} cy={ORB.cy} size={ORB.size} face="OO" />
      </El>

      {/* the Touch ID key: a disc plate, the ring lit, the fingerprint on its seat */}
      <El name="key">
        <Disc k={K} cx={KEY.cx} cy={KEY.cy} r={KEY.r} band={2}>
          <Ring cx={KEY.cx} cy={KEY.cy} r={KEY.ring} w={KEY.ringW} color={K.accent} />
          <Fingerprint cx={KEY.cx} cy={KEY.cy} size={KEY.print} />
        </Disc>
      </El>

      {/* the gate's five faces, each on a piece of the notch's black, named under it */}
      <El name="faces">
        {FACES.map((f, i) => {
          const x = TAB_X0 + i * TAB.pitch;
          return (
            <g key={f.pair}>
              <path d={tab(x)} fill="var(--jh-desk-notch)" />
              <FaceText x={x + TAB.w / 2} y={TAB.y + 24} size={17} color={`var(${f.tone})`}>
                {f.pair}
              </FaceText>
              <Label x={x + TAB.w / 2} y={TAB.y + TAB.h + 24} anchor="middle" size={14}>
                {row(NAMES, i)}
              </Label>
            </g>
          );
        })}
      </El>
    </Art>
  );
}
