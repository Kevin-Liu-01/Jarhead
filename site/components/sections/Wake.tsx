import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { Crop } from "@/components/ui/Crop";
import { Faces } from "./Faces";
import { WAKE } from "@/content/copy";
import { row, upTo } from "./cut";

/** 01 · Wake: the gate capture at 1:1 on the plate, the five gate faces drawn large beside it. */
export function Wake(): JSX.Element {
  return (
    <Section
      id={WAKE.id}
      phase="listening"
      h2={WAKE.h2}
      lead={upTo(WAKE.lead, " Hearing")} // the first two sentences, README:34
      lines={[
        { glyph: "lock", text: WAKE.card.h3 }, // README:34
        { glyph: "play", text: row(WAKE.cards, 3).h3 }, // README:35
        { glyph: "speaker", text: row(WAKE.cards, 1).h3 }, // README:50
      ]}
    >
      <Plate>
        <div className="sec-frame">
          <Crop {...WAKE.shot} scale={1} box={[520, 330]} x={50} y={64} fit />
          <Faces items={WAKE.faces} />
        </div>
      </Plate>
    </Section>
  );
}
