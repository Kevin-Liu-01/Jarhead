"use client";
import type { ReactElement } from "react";
import { DESK_KINDS, PHASE_META, type DeskKind } from "@/lib/phase";

/** Six tiles: the face glyph and the word; the active one pressed. Keyboard: a real <button> each (design.md §2.1). */
export function PhaseButtons({ kind, onPick }: { kind: DeskKind; onPick: (k: DeskKind) => void }): ReactElement {
  return (
    <div className="desk-phases" role="group" aria-label="Phase">
      {DESK_KINDS.map((k) => {
        const m = PHASE_META[k];
        return (
          <button key={k} type="button" className="desk-phase-btn" aria-pressed={k === kind} onClick={() => onPick(k)}>
            <span className="desk-phase-face" aria-hidden="true">{m.face}</span>
            <span>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
