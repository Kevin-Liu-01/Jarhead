import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { Crop } from "@/components/ui/Crop";
import { Block } from "./Block";
import { SAY } from "@/content/copy";
import { row, sentence, upTo } from "./cut";

/** 02 · Say: the Settings capture at half its pixel size on the plate, anchored on its Settings rail so the phone keeps 0.5× and shows the rail; the seven brain kinds as one block beside it. */
export function Say(): JSX.Element {
  return (
    <Section
      id={SAY.id}
      phase="thinking"
      h2="Say" // README:36-39; the utterance (SAY.h2) is on the island in the hero
      lead={sentence(SAY.lead, ", and the brain")} // README:36-38
      lines={[
        { glyph: "grid", text: row(SAY.cards, 1).h3 }, // README:36
        { glyph: "bookmark", text: row(SAY.cards, 3).h3 }, // README:49
        { glyph: "speaker", text: row(SAY.cards, 5).h3 }, // README:47; the reflex (README:38) is the lead's first sentence
      ]}
    >
      <Plate>
        <div className="sec-frame">
          <Crop {...SAY.shot} scale={0.5} box={[800, 610]} x={100} />
          <Block items={SAY.brains.map((b) => b.title)} foot={upTo(row(SAY.cards, 1).fig, " · pnpm")} /* README:332 */ />
        </div>
      </Plate>
    </Section>
  );
}
