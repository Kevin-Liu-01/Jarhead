import type { JSX } from "react";
import { Glyph, Group, KeyCap, Row } from "@/components/kit";
import { IslandStrip } from "@/components/ui/IslandStrip";
import { Plate } from "@/components/ui/Plate";
import { Section } from "@/components/ui/Section";
import { COSTS, SLEEP } from "@/content/copy";
import { after, need, row, upTo } from "./cut";

const SAYS = row(SLEEP.cards, 0); // Sleeps when you say so · README:46, README:326
const RING = row(SLEEP.cards, 1); // The ring · README:281
const FREE = row(SLEEP.cards, 2); // Asleep costs nothing · README:526
const ASLEEP = row(COSTS.rows, 1); // Asleep · nothing · README:526

/** 06 · Sleep: the alarm ringing on the island at 1:1 in its strip beside three kit rows. */
export function Sleep(): JSX.Element {
  return (
    <Section id={SLEEP.id} h2={SLEEP.h2} lead={SLEEP.lead} /* README:46, README:277-281 */>
      <Plate>
        <div className="sec-frame">
          <IslandStrip {...SLEEP.alarm} />
          <Group className="sec-rows">
            <Row size={13} icon={<Glyph name="hourglass" size={16} />} title={SAYS.h3} value={upTo(need(SAYS.fig), " · a setting")} tip={{ card: { title: SAYS.h3, lines: [upTo(SAYS.p, ' "Shut down')] } }} />
            <Row size={13} icon={<Glyph name="exclamationCircle" size={16} />} title={RING.h3} trailing={<KeyCap>{upTo(need(RING.fig), " ")}</KeyCap>} tip={{ card: { title: RING.h3, lines: [after(RING.p, "same two buttons. ")] } }} />
            <Row size={13} icon={<Glyph name="pause" size={16} />} title={FREE.h3} value={ASLEEP.value} tip={{ card: { title: FREE.h3, lines: [upTo(FREE.p, " Nothing fires")] } }} />
          </Group>
        </div>
      </Plate>
    </Section>
  );
}
