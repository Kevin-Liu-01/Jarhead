import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Card, CardGrid } from "@/components/ui/CardGrid";
import { Screen } from "@/components/ui/Screen";
import { Faces } from "./Faces";
import { WAKE } from "@/content/copy";

/** 01 · Wake: the gate capture beside the five gate faces, then four cards. */
export function Wake(): JSX.Element {
  return (
    <Section id={WAKE.id} phase="listening" h2={WAKE.h2} lead={WAKE.lead} className="sec-wake">
      <div className="sec-wake-row">
        <Screen {...WAKE.shot} aspect="16/9" position="50% 62%" maxWidth={520} />
        <div className="sec-block">
          <h3 className="sec-h3">{WAKE.card.h3}</h3>
          <p className="sec-p">{WAKE.card.p}</p>
          <Faces items={WAKE.faces} />
        </div>
      </div>
      <div className="sec-cards">
      <CardGrid cols={4}>
        {WAKE.cards.map((c) => (
          <Card key={c.h3} h3={c.h3} fig={c.fig}>
            <p className="sec-p">{c.p}</p>
          </Card>
        ))}
      </CardGrid>
      </div>
    </Section>
  );
}
