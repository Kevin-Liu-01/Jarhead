"use client";
import type { ReactElement } from "react";
import { Blob } from "@/components/desk/Blob";
import { HERO, PHASES } from "@/content/deck";
import { liveActions, shownKind, useLive } from "@/lib/live";
import { PHASE_META } from "@/lib/phase";
import { useTheme } from "@/lib/theme";

/**
 * The live blob in the hero: the dithered body on its harmonic outline, the face following the pointer over the whole
 * page, the halo in the phase colour the island is cycling through; a click steps the phase. Never hidden: asleep it
 * wears the quiet ramp and `- -` while the island tucks.
 */
export function HeroBlob(): ReactElement {
  const live = useLive();
  const theme = useTheme();
  const k = shownKind(live);
  const label = HERO.blobLabel.replace("{phase}", PHASES[k].word.toLowerCase());
  return (
    <div className="hero-blob">
      <Blob phase={PHASE_META[k].phase} theme={theme} hidden={false} still={live.still} label={label} onAdvance={() => liveActions.advance()} onFrame={(f) => liveActions.onBlobFrame(f)} />
    </div>
  );
}
