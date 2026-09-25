import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { Figure } from "@/components/ui/Figure";
import { Block } from "./Block";
import { COSTS } from "@/content/copy";
import { join, row, upTo } from "./cut";

/** The three rows that bill nothing, each cut to its title and its amount (COSTS.rows; README:526, README:35, README:529). */
const NOTHING = [1, 2, 8].map((i) => row(COSTS.rows, i)).map((r) => join(r.title, r.value ?? ""));
const VOICE = row(COSTS.rows, 0); // The voice · GPT-Live-1 · README:325

/** Costs: one plate carrying $0.05 / min as display type with its one line, and what costs nothing beside it. */
export function Costs(): JSX.Element {
  return (
    <Section id={COSTS.id} h2={COSTS.h2} lead={upTo(COSTS.lead, " The meter")} /* the first sentence, README:325 */>
      <Plate>
        <div className="sec-frame sec-frame--costs">
          <Figure value={COSTS.display} label={join(VOICE.title, upTo(VOICE.p, "."))} proof={COSTS.displayLine} size="lg" className="sec-costs-figure" />
          <Block items={NOTHING} className="sec-costs-lines" />
        </div>
      </Plate>
    </Section>
  );
}
