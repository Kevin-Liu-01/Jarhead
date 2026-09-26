import type { ReactElement } from "react";
import { AgentMark, Glyph, Group, JarheadMark, Row } from "@/components/kit";
import { Fact, Figure } from "@/components/ui/Figure";
import { Pill } from "@/components/ui/Pill";
import { ThemeImage } from "@/components/ui/Screen";
import { Section } from "@/components/ui/Section";
import { HANDS, NUMBERS, SHOTS } from "@/content/deck";
import { row } from "./cut";

const ROUND_TRIP = row(NUMBERS.figures, 5); // `55 ms` · tool round trip, median · README:331

/**
 * #hands: the ordinal h2, the whole lede, then the figure: the Console (dark / light pair) full width in its panel,
 * lines 2 and 3 as rows under it (line 1 is card 03 of the story); the Console row wears the app's own agent marks (SPACE.md §2).
 */
export function Hands(): ReactElement {
  return (
    <Section id={HANDS.id} h2={HANDS.h2} lead={HANDS.lead}>
      <Figure
        stack
        head={
          <>
            <Pill phase={HANDS.phase} />
            <Fact value={ROUND_TRIP.value} label={ROUND_TRIP.label} />
          </>
        }
      >
        <div className="mr-panel jh-console">
          <ThemeImage dark={SHOTS.consoleDark} light={SHOTS.consoleLight} width={1600} height={1030} />
        </div>
        <Group className="mr-rows">
          <Row size={13} icon={<JarheadMark size={14} />} title={HANDS.lines[1]} />
          <Row
            size={13}
            icon={<Glyph name="terminal" size={16} />}
            title={HANDS.lines[2]}
            trailing={
              <>
                <AgentMark tool="claude" size={14} />
                <AgentMark tool="codex" size={14} />
              </>
            }
          />
        </Group>
      </Figure>
    </Section>
  );
}
