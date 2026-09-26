import type { JSX } from "react";
import { Glyph, Group, GroupHead, Row } from "@/components/kit";
import { Plate } from "@/components/ui/Plate";
import { Section } from "@/components/ui/Section";
import { NUMBERS, RAILS } from "@/content/copy";
import { after, row, upTo } from "./cut";

const NEVER = row(RAILS.rows, 6); // § 7 · The never-list · README:340
const REFUSED = upTo(after(NEVER.p, "are "), " outright"); // refused
const HANDS_WIN = row(RAILS.rows, 5); // § 6 · Your hands win · README:40
const HOLD = row(NUMBERS.tiles, 12); // 1.5 s · README:329
const ONCE = row(RAILS.rows, 3); // § 4 · A yes is yours, once · README:338

/** 05 · Rails: the never-list as danger rows on the ink plate, `refused` once on its head, beside three rails with their tips. */
export function Rails(): JSX.Element {
  return (
    <Section id={RAILS.id} h2={RAILS.h2} lead={upTo(RAILS.lead, " Send, pay")} /* the first sentence, README:41 */>
      <Plate ink>
        <div className="sec-frame sec-frame--pair">
          <div>
            <Group className="sec-rows" head={<GroupHead title={NEVER.title} count={RAILS.never.list.length} badge={{ word: REFUSED, tone: "error" }} />}>
              {RAILS.never.list.map((item) => (
                <Row key={item} size={13} mono className="is-danger" icon={<Glyph name="xOctagon" size={16} />} title={item} />
              ))}
            </Group>
            <p className="sec-note">{RAILS.never.line}</p>
          </div>
          <Group className="sec-rows" head={<GroupHead title={RAILS.h2} count={3} />}>
            <Row
              size={13}
              icon={<Glyph name="handRaised" size={16} />}
              title={HANDS_WIN.title}
              value={`${HOLD.figure} ${HOLD.unit}`}
              tip={{ card: { title: `${HOLD.figure} ${HOLD.unit}`, lines: [upTo(HANDS_WIN.p, " A focus")] } }}
            />
            <Row size={13} icon={<Glyph name="checkCircle" size={16} />} title={ONCE.title} tip={{ card: { title: ONCE.title, lines: [ONCE.p] } }} />
            <Row size={13} icon={<Glyph name="reload" size={16} />} title={RAILS.rewrites.h3} tip={{ card: { title: RAILS.rewrites.h3, lines: [RAILS.rewrites.fig] } }} />
          </Group>
        </div>
      </Plate>
    </Section>
  );
}
