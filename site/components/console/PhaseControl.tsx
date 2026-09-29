"use client";
import type { ReactElement } from "react";
import { Segments, type SegmentOption } from "@/components/kit";
import { PHASES } from "@/content/deck";
import { liveActions, shownKind, useLive } from "@/lib/live";
import { DESK_KINDS, type DeskKind } from "@/lib/phase";

/** The six kinds as the kit's Segments: the face pair in mono before the word (ConsoleSegments.swift; SPACE.md §4 row 3). */
const OPTIONS: readonly SegmentOption[] = DESK_KINDS.map((k) => ({ id: k, title: PHASES[k].word, face: PHASES[k].face }));

/**
 * The hero's phase control under the blob: a press holds the kind for 15 s on the island's timeline (Top.tsx `pick`),
 * so the phase is steppable by a control and not only by a click on the blob; the on cell follows the live kind.
 */
export function PhaseControl(): ReactElement {
  const live = useLive();
  return <Segments value={shownKind(live)} options={OPTIONS} onPick={(id) => liveActions.pick(id as DeskKind)} size="rail" ariaLabel={PHASES[shownKind(live)].word} fit className="hero-phases" />;
}
