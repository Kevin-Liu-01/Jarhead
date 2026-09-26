"use client";

import type { ReactElement } from "react";
import { Desk, type DeskApi } from "@/components/desk/Desk";
import { Segments } from "@/components/kit";
import { DESK_KINDS, PHASE_META, type DeskKind } from "@/lib/phase";

/** The six kinds as segments: the face pair before the word (SPACE.md §4 row 3). */
const OPTIONS = DESK_KINDS.map((k) => ({ id: k, title: PHASE_META[k].label, face: PHASE_META[k].face }));

/**
 * Rows 2 and 3 of the hero: the stage (the drawn Mac with only the menu bar, the notch, the island, the live blob
 * and the ring), then one ConsoleSegments-style phase control under it with the PhaseMeta hint as one line beside it,
 * the active kind pressed. Picking a segment holds that kind on the desk's timeline for 15 s.
 */
export function HeroStage(): ReactElement {
  return (
    <Desk
      controls={(api: DeskApi) => (
        <div className="hero-phase">
          <Segments value={api.kind} options={OPTIONS} onPick={(id) => api.pick(id as DeskKind)} size="rail" ariaLabel="Phase" fit />
          <p className="hero-hint">
            <span className={`kit-dot${api.live ? " is-live" : ""}`} aria-hidden="true" />
            {PHASE_META[api.kind].hint}
          </p>
        </div>
      )}
    />
  );
}
