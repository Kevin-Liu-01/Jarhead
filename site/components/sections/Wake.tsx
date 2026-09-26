import type { JSX } from "react";
import { Glyph, Group, Row } from "@/components/kit";
import { Crop } from "@/components/ui/Crop";
import { Plate } from "@/components/ui/Plate";
import { Section } from "@/components/ui/Section";
import { WAKE } from "@/content/copy";
import { after, row, upTo } from "./cut";

const TRANSPORT = row(WAKE.cards, 3); // One transport · README:35
const TALKS = row(WAKE.cards, 0); // Talks like a person · README:33, README:321
const VOICES = row(WAKE.cards, 1); // Twenty-two voices · README:50
/** `reply 1.11 s median · 1.21 s p90 · Agora, n = 30, 2026-07-09` cut once: the figure as the value, the rest as the meta line (facts-product.md §5.8). */
const TALKS_VALUE = upTo(after(TALKS.fig, "reply "), " median");
const TALKS_PROOF = after(TALKS.fig, `${TALKS_VALUE} `);

/** 01 · Wake: the gate capture at 1:1 beside four kit rows; the mechanism lives in each row's tip, a latency's n and date also on the row. */
export function Wake(): JSX.Element {
  return (
    <Section id={WAKE.id} h2={WAKE.h2} lead={upTo(WAKE.lead, " Hearing")} /* the first two sentences, README:34 */>
      <Plate>
        <div className="sec-frame">
          <Crop {...WAKE.shot} scale={1} box={[520, 330]} x={50} y={64} fit />
          <Group className="sec-rows">
            <Row size={13} icon={<Glyph name="lock" size={16} />} title={WAKE.card.h3} tip={{ card: { title: WAKE.card.h3, lines: [upTo(WAKE.card.p, " Then")] } }} />
            <Row
              size={13}
              icon={<Glyph name="play" size={16} />}
              title={TRANSPORT.h3}
              value={upTo(TRANSPORT.p, ". Pause")}
              tip={{ card: { title: upTo(TRANSPORT.p, ". Pause"), lines: [TRANSPORT.fig] } }}
            />
            <Row
              size={13}
              icon={<Glyph name="voice" size={16} />}
              title={TALKS.h3}
              value={TALKS_VALUE}
              meta={TALKS_PROOF}
              tip={{ card: { title: TALKS_VALUE, lines: [TALKS_PROOF] } }}
            />
            <Row
              size={13}
              icon={<Glyph name="switchVoice" size={16} />}
              title={VOICES.h3}
              value={upTo(after(VOICES.p, "hears. "), " (Ballad)")}
              tip={{ card: { title: VOICES.h3, lines: [VOICES.fig] } }}
            />
          </Group>
        </div>
      </Plate>
    </Section>
  );
}
