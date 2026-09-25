import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Ledger } from "./Ledger";
import { StatGrid } from "./StatGrid";
import { NUMBERS } from "@/content/copy";

/** Numbers: the display figure with its provenance, the 4 × 4 grid, the remaining rows, the footnote. */
export function Numbers(): JSX.Element {
  return (
    <Section id={NUMBERS.id} label={NUMBERS.label} h2={NUMBERS.h2} lead={NUMBERS.lead} className="sec-numbers">
      <div className="sec-display-row">
        <div className="jh-display sec-display">{NUMBERS.display}</div>
        <div className="sec-fig sec-display-line">{NUMBERS.displayLine}</div>
      </div>
      <StatGrid tiles={NUMBERS.tiles} />
      <Ledger rows={NUMBERS.rows} variant="figure" className="sec-numbers-rows" />
      <p className="sec-note">{NUMBERS.footnote}</p>
    </Section>
  );
}
