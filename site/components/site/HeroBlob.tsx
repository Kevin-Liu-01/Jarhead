"use client";
import { useEffect, useState, type ReactElement } from "react";
import { Blob } from "@/components/desk/Blob";
import { HERO, PHASES } from "@/content/deck";
import { liveActions, useLive } from "@/lib/live";
import { DESK_PHASE } from "@/lib/phase";
import { isStill, useTheme } from "@/lib/theme";

/**
 * The hero's blob: the real one (lib/blob.ts), huge, beside the island. It wears the phase the island is in (the alarm
 * rings while it sleeps, so the alarm wears asleep), its eyes follow the pointer across the page, a press or Enter steps
 * the island to the next kind. The still PNG shows until the first frame and without JS.
 */
export function HeroBlob(): ReactElement {
  const live = useLive();
  const theme = useTheme();
  const [still, setStill] = useState(false);
  useEffect(() => setStill(isStill()), []);
  const label = HERO.blobLabel.replace("{phase}", PHASES[live.kind].word);
  return <Blob phase={DESK_PHASE[live.kind]} theme={theme} still={still} label={label} onAdvance={() => liveActions.advance()} />;
}
