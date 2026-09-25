import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { IslandStrip } from "@/components/ui/IslandStrip";
import { Figure } from "@/components/ui/Figure";
import { NUMBERS, THREADS } from "@/content/copy";
import { row, upTo } from "./cut";

const THREE = row(NUMBERS.tiles, 11); // `3` · live threads beside the main one · README:327

/** 03 · Threads: the working island at 1:1 in a drawn menu-bar strip on the plate, the thread count as display type beside it. */
export function Threads(): JSX.Element {
  return (
    <Section
      id={THREADS.id}
      phase="acting"
      h2={THREADS.h2}
      lead={upTo(THREADS.lead, " Each thread has")} // README:39
      lines={[
        { glyph: "window", text: THREADS.islandCard.h3 }, // README:45
        { glyph: "ask", text: THREADS.railCard.h3 }, // README:39
      ]}
    >
      <Plate>
        <div className="sec-frame">
          <IslandStrip {...THREADS.island} className="sec-strip" />
          <Figure value={THREE.figure} label={THREE.label} proof={THREE.proof} size="lg" />
        </div>
      </Plate>
    </Section>
  );
}
