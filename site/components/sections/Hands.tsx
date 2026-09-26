import type { JSX } from "react";
import { Glyph, Group, GroupHead, KeyCap, Row } from "@/components/kit";
import { Plate } from "@/components/ui/Plate";
import { ThemeImage } from "@/components/ui/Screen";
import { Section } from "@/components/ui/Section";
import { HANDS, NUMBERS, THREADS } from "@/content/copy";
import { after, head, join, row, upTo } from "./cut";

const TOOLS = row(NUMBERS.tiles, 9); // `71` · tools in ten families · README:332
/** The ten families, each cut to its name before the deck's own joiner, set with the deck's ` · ` (README:37). */
const FAMILIES = HANDS.chips.map((c) => head(c)).reduce((a, b) => join(a, b));
const THREADS_VALUE = upTo(THREADS.figures, " · "); // main + 3 live · README:327
const CIRCLE_KEY = upTo(HANDS.circle.fig, " · "); // ⌥⇧C · README:430
const AGENTS_KEY = upTo(HANDS.agents.fig, " "); // ⌥⇧J · README:426
const CONSOLE = upTo(after(HANDS.agents.fig, `${AGENTS_KEY} `), " ·"); // Console
const PING = upTo(HANDS.problems.fig, " · "); // ping 2 s · README:330

/**
 * 04 · Hands: the Console pair at half its pixel size (1:1 on a 2× screen) in its own section, then two short row
 * groups side by side in the same column, the hands and the Console, so every value sits beside its title.
 */
export function Hands(): JSX.Element {
  return (
    <Section id={HANDS.id} h2={HANDS.h2} lead={HANDS.lead} /* README:37 */>
      <Plate>
        <div className="sec-frame sec-frame--stack">
          <figure className="jh-shot sec-console">
            <ThemeImage dark={HANDS.consoleDark} light={HANDS.consoleLight} width={1600} height={1030} sizes="(min-width: 860px) 800px, 100vw" />
          </figure>
          <div className="sec-groups">
            <Group className="sec-rows" head={<GroupHead title={HANDS.h2} count={3} />}>
              <Row size={13} icon={<Glyph name="ask" size={16} />} title={TOOLS.label} value={TOOLS.figure} tip={{ card: { title: TOOLS.figure, status: TOOLS.label, lines: [FAMILIES] } }} />
              <Row size={13} icon={<Glyph name="live" size={16} />} title={THREADS.h2} value={THREADS_VALUE} tip={{ card: { title: THREADS_VALUE, lines: [after(THREADS.figures, `${THREADS_VALUE} · `)] } }} />
              <Row size={13} icon={<Glyph name="circle" size={16} />} title={HANDS.circle.h3} trailing={<KeyCap>{CIRCLE_KEY}</KeyCap>} tip={{ line: after(HANDS.circle.fig, `${CIRCLE_KEY} · `) }} />
            </Group>
            <Group className="sec-rows" head={<GroupHead title={CONSOLE} count={2} />}>
              <Row size={13} icon={<Glyph name="terminal" size={16} />} title={HANDS.agents.h3} trailing={<KeyCap>{AGENTS_KEY}</KeyCap>} tip={{ card: { title: HANDS.agents.h3, lines: [upTo(HANDS.agents.p, " Step into")] } }} />
              <Row size={13} icon={<Glyph name="exclamationCircle" size={16} />} title={HANDS.problems.h3} value={PING} tip={{ line: after(HANDS.problems.fig, `${PING} · `) }} />
            </Group>
          </div>
        </div>
      </Plate>
    </Section>
  );
}
