import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Card, CardGrid } from "@/components/ui/CardGrid";
import { Screen, ThemeImage } from "@/components/ui/Screen";
import { Chips } from "@/components/ui/Chips";
import { DitherGround } from "@/components/ui/DitherGround";
import { HANDS } from "@/content/copy";

/** 04 · Hands: the ten families, the overlay at rail width, the Console at the full rail on its floor, the faces. */
export function Hands(): JSX.Element {
  return (
    <Section id={HANDS.id} phase="acting" face={HANDS.face} h2={HANDS.h2} lead={HANDS.lead} className="sec-hands">
      <div className="sec-hands-chips">
        <Chips items={HANDS.chips} />
      </div>
      <div className="sec-hands-overlay">
        <Screen {...HANDS.overlay} ground="ink" aspect="1600/589" sizes="(min-width: 1202px) 1170px, 100vw" />
      </div>
      <div className="sec-cards">
      <CardGrid cols={3}>
        <Card>
          <Screen {...HANDS.workShot} aspect="16/9" position="100% 0" />
          <h3 className="sec-h3">{HANDS.work.h3}</h3>
          <p className="sec-p">{HANDS.work.p}</p>
          <div className="sec-fig sec-fig--push">{HANDS.work.fig}</div>
        </Card>
        <Card>
          <Screen {...HANDS.circleShot} aspect="16/9" />
          <h3 className="sec-h3">{HANDS.circle.h3}</h3>
          <p className="sec-p">{HANDS.circle.p}</p>
          <div className="sec-fig sec-fig--push">{HANDS.circle.fig}</div>
        </Card>
        <Card>
          <div className="sec-notch-band">
            <div>
              <Screen {...HANDS.notchTucked} maxWidth={460} />
              <div className="sec-fig sec-notch-cap">{HANDS.notchTuckedCap}</div>
            </div>
            <div>
              <Screen {...HANDS.notchPeek} maxWidth={460} />
              <div className="sec-fig sec-notch-cap">{HANDS.notchPeekCap}</div>
            </div>
          </div>
          <h3 className="sec-h3">{HANDS.notch.h3}</h3>
          <p className="sec-p">{HANDS.notch.p}</p>
        </Card>
        <Card span={3}>
          <div className="sec-console-floor">
            <DitherGround />
            <div className="sec-console">
              <ThemeImage dark={HANDS.consoleDark} light={HANDS.consoleLight} width={1600} height={1030} sizes="(min-width: 1202px) 1170px, 100vw" />
            </div>
          </div>
          <div className="sec-console-text">
            <div>
              <h3 className="sec-h3">{HANDS.agents.h3}</h3>
              <p className="sec-p">{HANDS.agents.p}</p>
              <div className="sec-fig">{HANDS.agents.fig}</div>
            </div>
            <p className="sec-cap">{HANDS.consoleCap}</p>
          </div>
        </Card>
        <Card span={2}>
          <Screen {...HANDS.facesShot} aspect="1600/1451" />
          <h3 className="sec-h3">{HANDS.faces.h3}</h3>
          <p className="sec-p">{HANDS.faces.p}</p>
        </Card>
        <Card>
          <Screen {...HANDS.problemsShot} aspect="3/5" position="100% 0" />
          <h3 className="sec-h3">{HANDS.problems.h3}</h3>
          <p className="sec-p">{HANDS.problems.p}</p>
          <div className="sec-fig sec-fig--push">{HANDS.problems.fig}</div>
        </Card>
      </CardGrid>
      </div>
    </Section>
  );
}
