import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Plate } from "@/components/ui/Plate";
import { Figure } from "@/components/ui/Figure";
import { NUMBERS } from "@/content/copy";
import { after, join, row, upTo } from "./cut";

/** The display figure's line cut once: `ear final → hands dispatch` as the label, the rest as the proof (README:313, docs/LATENCY.md:321). */
const DISPLAY_LABEL = upTo(NUMBERS.displayLine, " · ");
const DISPLAY_PROOF = after(NUMBERS.displayLine, " · ");

/** Three more latencies (NUMBERS.tiles), the deck label joined to the cut of its proof that carries the n and the date. */
const reply = row(NUMBERS.tiles, 2); // README:321, docs/LATENCY.md:326
const first = row(NUMBERS.tiles, 3); // README:317, docs/LATENCY.md:259
const done = row(NUMBERS.tiles, 4); // README:318, docs/LATENCY.md:322
const MORE = [
  { value: `${reply.figure} ${reply.unit}`, label: join(reply.label, after(reply.proof, "third party, ")) },
  { value: `${first.figure} ${first.unit}`, label: join(first.label, after(first.proof, "canned hands · ")) },
  { value: `${done.figure} ${done.unit}`, label: join(done.label, after(done.proof, "p95 · ")) },
] as const;

/** Numbers: 3 ms as the plate's figure with its one provenance line; three more latencies as secondary figures. */
export function Numbers(): JSX.Element {
  return (
    <Section id={NUMBERS.id} h2={NUMBERS.h2} lead={NUMBERS.lead}>
      <Plate>
        <div className="sec-frame sec-frame--figures">
          <Figure value={NUMBERS.display} label={DISPLAY_LABEL} proof={DISPLAY_PROOF} size="lg" className="sec-numbers-lead" />
          <ul className="sec-figures">
            {MORE.map((m) => (
              <li key={m.value}>
                <Figure value={m.value} label={m.label} size="sm" />
              </li>
            ))}
          </ul>
        </div>
      </Plate>
    </Section>
  );
}
