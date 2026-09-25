import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Screen } from "@/components/ui/Screen";
import { Ledger } from "./Ledger";
import { COSTS } from "@/content/copy";

/** Costs: the display figure, the nine-row ledger of what bills what, the Ledger tab at the right. */
export function Costs(): JSX.Element {
  return (
    <Section id={COSTS.id} label={COSTS.label} h2={COSTS.h2} lead={COSTS.lead} className="sec-costs">
      <div className="sec-costs-row">
        <div className="sec-costs-left">
          <div className="sec-display-row">
            <div className="jh-display sec-display">{COSTS.display}</div>
            <div className="sec-fig sec-display-line">{COSTS.displayLine}</div>
          </div>
          <Ledger rows={COSTS.rows} variant="table" className="sec-costs-rows" />
        </div>
        <div className="sec-costs-shot">
          <Screen {...COSTS.shot} aspect="3/4" position="100% 0" maxWidth={300} />
          <p className="sec-cap">{COSTS.shotCap}</p>
        </div>
      </div>
    </Section>
  );
}
