import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Card, CardGrid } from "@/components/ui/CardGrid";
import { Screen } from "@/components/ui/Screen";
import { Ledger } from "./Ledger";
import { SayStrip } from "./SayStrip";
import { SAY } from "@/content/copy";

/** 02 · Say: the utterance is the h2; the seven brains and the say strip beside the Settings rail; six cards. */
export function Say(): JSX.Element {
  return (
    <Section id={SAY.id} phase="thinking" h2={SAY.h2} lead={SAY.lead} className="sec-say">
      <div className="sec-say-row">
        <div className="sec-say-left">
          <Ledger rows={SAY.brains} variant="table" />
          <p className="sec-note">{SAY.brainsFoot}</p>
          <SayStrip head={SAY.stripHead} pairs={SAY.strip} />
        </div>
        <div className="sec-say-shot">
          <Screen {...SAY.shot} aspect="3/8" position="100% 0" maxWidth={300} />
        </div>
      </div>
      <div className="sec-cards">
      <CardGrid cols={3}>
        {SAY.cards.map((c) => (
          <Card key={c.h3} h3={c.h3} fig={c.fig}>
            <p className="sec-p">{c.p}</p>
          </Card>
        ))}
      </CardGrid>
      </div>
    </Section>
  );
}
