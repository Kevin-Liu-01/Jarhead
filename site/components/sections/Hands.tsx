import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { ThemeImage } from "@/components/ui/Screen";
import { Figure } from "@/components/ui/Figure";
import { Block } from "./Block";
import { HANDS, NUMBERS } from "@/content/copy";
import { after, head, row } from "./cut";

const TOOLS = row(NUMBERS.tiles, 9); // `71` · tools in ten families · README:332
/** The ten families, each cut to its name before the deck's own joiner (HANDS.chips, README:37). */
const FAMILIES = HANDS.chips.map((c) => head(c));

/** 04 · Hands: the Console pair at half its pixel size on the plate; 71 as display type over the ten families as one block. */
export function Hands(): JSX.Element {
  return (
    <Section
      id={HANDS.id}
      phase="acting"
      h2={HANDS.h2}
      lead={after(HANDS.lead, "71 tools in ten families. ")} // README:37; the count is the plate's figure
      lines={[
        { glyph: "bell", text: HANDS.problems.h3 }, // README:52
        { glyph: "target", text: HANDS.circle.h3 }, // README:43
        { glyph: "window", text: HANDS.agents.h3 }, // README:42
      ]}
    >
      <Plate>
        <div className="sec-frame">
          <figure className="jh-shot sec-console">
            <ThemeImage dark={HANDS.consoleDark} light={HANDS.consoleLight} width={1600} height={1030} sizes="(min-width: 860px) 800px, 100vw" />
          </figure>
          <div className="sec-hands-ladder">
            <Figure value={TOOLS.figure} label={TOOLS.label} size="md" />
            <Block items={FAMILIES} />
          </div>
        </div>
      </Plate>
    </Section>
  );
}
