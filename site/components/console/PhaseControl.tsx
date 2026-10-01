"use client";
import type { ReactElement } from "react";
import { Segments, type SegmentOption, Glyph } from "@/components/kit";
import { PHASES } from "@/content/deck";
import { liveActions, shownKind, useLive } from "@/lib/live";
import { DESK_KINDS, type DeskKind } from "@/lib/phase";

/**
 * The island's face per kind (ITERATE.md §5; BlobField.swift through facts-orb.md §3): the round eyes listening, the
 * flat pair thinking and asleep, `> >` acting as the blob looks along its travel to the target ring, `^ ^` speaking,
 * the small round pair while the alarm rings. The island (Top.tsx) and its control wear the same faces.
 */
export const ISLAND_FACE: Record<DeskKind, string> = { listening: "O O", thinking: "- -", acting: "o o", speaking: "^ ^", asleep: "- -", alarm: "o o" }; // the app's own faces (notch-island-working.png, notch-island-alarm.png, notch-island.png)

/**
 * The cells' faces: the island's, except asleep, which wears the gate's `. .` (the Wake rail's first face, drawn in the
 * asleep tone; the lip's face through the wake gate) so Asleep and Thinking read apart at a glance; the tucked lip itself
 * keeps `- -` as the app draws it (notch-tucked.png).
 */
const CELL_FACE: Record<DeskKind, string> = { ...ISLAND_FACE, asleep: ". ." };

/**
 * The six kinds as the kit's Segments: the face pair in mono before the word (ConsoleSegments.swift; SPACE.md §4 row 3),
 * and the phase word with its COPY.md hint as the cell's tip card (the deck allows the eyebrow entries as a tooltip), so a
 * face reads as its word on hover or keyboard focus and the cells read as buttons.
 */
/** Acting and Alarm both wear `o o` in the app; the alarm cell carries the chime dot the island's alarm head carries, so the two read apart. */
const OPTIONS: readonly SegmentOption[] = DESK_KINDS.map((k) => ({ id: k, title: PHASES[k].word, face: CELL_FACE[k], glyph: k === "alarm" ? <Glyph name="dot" size={14} /> : undefined, tip: { title: PHASES[k].word, lines: [PHASES[k].hint] } }));

/**
 * The phase control (CENTER.md §5, angle B · THE FOOT): a press holds the kind for 15 s on the island's timeline (Top.tsx
 * `pick`), the on cell follows the live kind. `foot` is the compact six-cell row drawn inside the island's foot band where
 * the app's two tiles sit (the faces show, the words stay for the reader and in each cell's tip); `wide` is the phone's
 * 2 × 3 row under the dock, at the tap floor. Only one of the two is displayed at a time (styles/console.css, the 720 ladder).
 */
export function PhaseControl({ variant }: { readonly variant: "foot" | "wide" }): ReactElement {
  const live = useLive();
  const k = shownKind(live);
  const pick = (id: string) => liveActions.pick(id as DeskKind);
  if (variant === "foot") return <Segments value={k} options={OPTIONS} onPick={pick} size="row" ariaLabel={PHASES[k].word} className="desk-phases" />;
  return <Segments value={k} options={OPTIONS} onPick={pick} size="rail" ariaLabel={PHASES[k].word} fit className="hero-phases" />;
}
