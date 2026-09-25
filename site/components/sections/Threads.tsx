import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Card, CardGrid } from "@/components/ui/CardGrid";
import { Screen } from "@/components/ui/Screen";
import { THREADS } from "@/content/copy";

/** 03 · Threads: the working island beside the Threads rail, two cards, the figures line and the lease. */
export function Threads(): JSX.Element {
  return (
    <Section id={THREADS.id} phase="acting" h2={THREADS.h2} lead={THREADS.lead} className="sec-threads">
      <div className="sec-cards">
      <CardGrid cols={2}>
        <Card>
          <Screen {...THREADS.island} maxWidth={460} />
          <h3 className="sec-h3">{THREADS.islandCard.h3}</h3>
          <p className="sec-p">{THREADS.islandCard.p}</p>
          <div className="sec-fig sec-fig--push">{THREADS.figures}</div>
          <p className="sec-note">{THREADS.footnote}</p>
        </Card>
        <Card>
          <Screen {...THREADS.rail} aspect="3/4" position="100% 0" maxWidth={300} />
          <h3 className="sec-h3">{THREADS.railCard.h3}</h3>
          <p className="sec-p">{THREADS.railCard.p}</p>
        </Card>
      </CardGrid>
      </div>
    </Section>
  );
}
