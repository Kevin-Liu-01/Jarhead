import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { IslandStrip } from "@/components/ui/IslandStrip";
import { Figure } from "@/components/ui/Figure";
import { NUMBERS, SLEEP } from "@/content/copy";
import { row } from "./cut";

const IDLE = row(NUMBERS.tiles, 15); // `10` min · idle sleep · README:326

/** 06 · Sleep: the alarm ringing on the island at 1:1 in a drawn menu-bar strip, the idle-sleep figure as display type beside it. */
export function Sleep(): JSX.Element {
  return (
    <Section
      id={SLEEP.id}
      phase="asleep"
      h2={SLEEP.h2}
      lead={SLEEP.lead} // README:46, README:277-281
      lines={[
        { glyph: "moon", text: row(SLEEP.cards, 0).h3 }, // README:46
        { glyph: "bell", text: row(SLEEP.cards, 1).h3 }, // README:281
        { glyph: "pause", text: row(SLEEP.cards, 2).h3 }, // README:526
      ]}
    >
      <Plate>
        <div className="sec-frame">
          <IslandStrip {...SLEEP.alarm} className="sec-strip" />
          <Figure value={`${IDLE.figure} ${IDLE.unit}`} label={IDLE.label} proof={IDLE.proof} size="lg" />
        </div>
      </Plate>
    </Section>
  );
}
