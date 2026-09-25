import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Card, CardGrid } from "@/components/ui/CardGrid";
import { Screen } from "@/components/ui/Screen";
import { MADE } from "@/content/copy";

/** Made: the icon strip in a two-row card, then how it is built. */
export function Made(): JSX.Element {
  return (
    <Section id={MADE.id} label={MADE.label} h2={MADE.h2} lead={MADE.lead} className="sec-made">
      <div className="sec-cards">
      <CardGrid cols={3}>
        <Card rows={2}>
          <Screen {...MADE.icons} ground="raised" maxWidth={320} />
          <h3 className="sec-h3">{MADE.dithered.h3}</h3>
          <p className="sec-p">{MADE.dithered.p}</p>
        </Card>
        {MADE.cards.map((c) => (
          <Card key={c.h3} h3={c.h3} fig={c.fig}>
            <p className="sec-p">{c.p}</p>
          </Card>
        ))}
        <Card span={3}>
          <div className="sec-wide">
            <h3 className="sec-h3">{MADE.homes.h3}</h3>
            <p className="sec-p">{MADE.homes.p}</p>
            <div className="sec-fig">{MADE.homes.fig}</div>
          </div>
        </Card>
      </CardGrid>
      </div>
    </Section>
  );
}
