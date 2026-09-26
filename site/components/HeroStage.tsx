"use client";

import type { ReactElement } from "react";
import { Desk, type DeskApi } from "@/components/desk/Desk";
import { Segments } from "@/components/kit";
import { DESK_KINDS, PHASE_META, type DeskKind } from "@/lib/phase";

/** The six kinds as word-only segments (SPACE.md §4 row 3); the face pair sits in the hint line beside them. */
const OPTIONS = DESK_KINDS.map((k) => ({ id: k, title: PHASE_META[k].label }));

/**
 * The hero's picture: the 1170 × 560 stage of the Mac at 1:1 (the bar, the notch, the island, the live blob and the
 * ring; the phone stage under 720), then one ConsoleSegments-style phase control under it, the active kind pressed,
 * with the face pair and the hint as one line beside it. Picking a segment holds that kind on the desk's timeline for 15 s.
 */
export function HeroStage(): ReactElement {
  return (
    <Desk
      controls={(api: DeskApi) => (
        <div className="hero-phase">
          <Segments value={api.kind} options={OPTIONS} onPick={(id) => api.pick(id as DeskKind)} size="rail" ariaLabel="Phase" fit />
          <p className="hero-hint">
            <span className={`kit-dot${api.live ? " is-live" : ""}`} aria-hidden="true" />
            <span className="kit-seg-face" aria-hidden="true">
              {PHASE_META[api.kind].face}
            </span>
            {PHASE_META[api.kind].hint}
          </p>
        </div>
      )}
    />
  );
}
