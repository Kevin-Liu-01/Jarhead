import type { ReactElement } from "react";
import { Glyph, Group, Row } from "@/components/kit";
import { Fact, Figure } from "@/components/ui/Figure";
import { IslandStrip } from "@/components/ui/IslandStrip";
import { Pill } from "@/components/ui/Pill";
import { Section } from "@/components/ui/Section";
import { FOOTER, NUMBERS, SHOTS, SLEEP } from "@/content/deck";
import { row } from "./cut";

const IDLE = row(NUMBERS.figures, 14); // `10 min` · idle sleep · README:335

/** #sleep: the h2, the lede, then the figure: the island ringing at 1:1 beside the three lines as rows; the foot names the alarm's fixed data. */
export function Sleep(): ReactElement {
  return (
    <Section id={SLEEP.id} h2={SLEEP.h2} lead={SLEEP.lead}>
      <Figure
        head={
          <>
            <Pill phase={SLEEP.phase} />
            <Fact value={IDLE.value} label={IDLE.label} />
          </>
        }
        foot={FOOTER.disclosures[2]}
      >
        <IslandStrip {...SHOTS.islandAlarm} />
        <Group className="mr-rows">
          <Row size={13} icon={<Glyph name="pause" size={16} />} title={SLEEP.lines[0]} />
          <Row size={13} icon={<Glyph name="ask" size={16} />} title={SLEEP.lines[1]} />
          <Row size={13} icon={<Glyph name="quit" size={16} />} title={SLEEP.lines[2]} />
        </Group>
      </Figure>
    </Section>
  );
}
