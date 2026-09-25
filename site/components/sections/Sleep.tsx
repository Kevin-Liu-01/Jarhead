import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Card, CardGrid } from "@/components/ui/CardGrid";
import { Screen } from "@/components/ui/Screen";
import { SLEEP } from "@/content/copy";

/** 06 · Sleep: the alarm ringing on the island, the Automations rail, then four cards. */
export function Sleep(): JSX.Element {
  return (
    <Section id={SLEEP.id} phase="asleep" h2={SLEEP.h2} lead={SLEEP.lead} className="sec-sleep">
      <div className="sec-cards">
      <CardGrid cols={3}>
        <Card span={2}>
          <Screen {...SLEEP.alarm} aspect="920/500" maxWidth={460} />
          <h3 className="sec-h3">{SLEEP.automations.h3}</h3>
          <p className="sec-p">{SLEEP.automations.p}</p>
          <div className="sec-fig sec-fig--push">{SLEEP.automations.fig}</div>
        </Card>
        <Card>
          <Screen {...SLEEP.refuseShot} aspect="3/4" position="100% 0" />
          <h3 className="sec-h3">{SLEEP.refuse.h3}</h3>
          <p className="sec-p">{SLEEP.refuse.p}</p>
        </Card>
        {SLEEP.cards.map((c) => (
          <Card key={c.h3} h3={c.h3} fig={c.fig}>
            <p className="sec-p">{c.p}</p>
          </Card>
        ))}
      </CardGrid>
      </div>
    </Section>
  );
}
