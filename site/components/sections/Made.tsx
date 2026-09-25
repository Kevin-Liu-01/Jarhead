import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { Crop } from "@/components/ui/Crop";
import { Figure } from "@/components/ui/Figure";
import { MADE, NUMBERS } from "@/content/copy";
import { row, upTo } from "./cut";

const TOKENS = row(NUMBERS.tiles, 7); // `10.7` k · input tokens on a cold Codex thread · README:324

/** Made: the Dock icon's five sizes at 1:1 on the plate, the cold-thread token cut as display type beside them. */
export function Made(): JSX.Element {
  return (
    <Section
      id={MADE.id}
      h2={MADE.h2}
      lead={upTo(MADE.lead, " The app spawns")} // the first sentence, README:213-250
      lines={[
        { glyph: "grid", text: MADE.dithered.h3 }, // README:59
        { glyph: "apple", text: row(MADE.cards, 0).h3 }, // README:55
        { glyph: "play", text: row(MADE.cards, 2).h3 }, // README:53
      ]}
    >
      <Plate>
        <div className="sec-frame">
          <Crop {...MADE.icons} scale={1} box={[640, 310]} ground="raised" fit />
          <Figure value={`${TOKENS.figure}${TOKENS.unit}`} label={TOKENS.label} proof={upTo(TOKENS.proof, " · the private")} size="lg" /> {/* `from 22.3k · −52 %`: the whole proof wraps to two lines beside the 640 px plate at 1440; the cut keeps the figure's proof on one line */}
        </div>
      </Plate>
    </Section>
  );
}
