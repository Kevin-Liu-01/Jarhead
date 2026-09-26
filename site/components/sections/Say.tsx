import type { JSX, ReactNode } from "react";
import Anthropic from "@thesvg/react/anthropic";
import Ollama from "@thesvg/react/ollama";
import Openai from "@thesvg/react/openai";
import { AgentMark, GroupHead, Group, JarheadMark, Row, type RowBadge } from "@/components/kit";
import { IslandStrip } from "@/components/ui/IslandStrip";
import { Plate } from "@/components/ui/Plate";
import { Section } from "@/components/ui/Section";
import { SAY, THREADS } from "@/content/copy";
import { after, row, sentence, upTo } from "./cut";

const SETTING = row(SAY.cards, 1); // The brain is a setting · 6 kinds + auto · README:36, README:332

/** Each brain's mark in the 20 column: the app's own agent marks for codex and claude (kit/AgentMark), thesvg for the vendors (ICONS.md; the OpenAI mark has no mono variant and hard-codes paper, so it wears the column's colour through .jh-mark-ink), the faceless orb for auto. */
const MARKS: Record<string, ReactNode> = {
  codex: <AgentMark tool="codex" size={14} />,
  "claude-code": <AgentMark tool="claude" size={14} />,
  "anthropic-api": <Anthropic variant="mono" width={14} height={14} aria-hidden="true" focusable="false" />,
  "openai-compatible": <Openai className="jh-mark-ink" width={14} height={14} aria-hidden="true" focusable="false" />,
  "openai-responses": <Openai className="jh-mark-ink" width={14} height={14} aria-hidden="true" focusable="false" />,
  local: <Ollama variant="mono" width={14} height={14} aria-hidden="true" focusable="false" />,
  auto: <JarheadMark size={14} />,
};

/** The trailing word of each row, cut from its own deck line (docs/REDESIGN.md:270-276). */
const TRAIL: Record<string, { readonly value?: string; readonly badge?: RowBadge }> = {
  codex: { badge: { word: "no key" } }, // ConsoleBadge.Word.noKey; the deck's "No key."
  "claude-code": { value: after(upTo(row(SAY.brains, 1).p, "."), "SDK, ") },
  "anthropic-api": { value: after(upTo(row(SAY.brains, 2).p, "."), "loop, ") },
  "openai-compatible": { value: after(upTo(row(SAY.brains, 3).p, ", a hosted"), "URL: ") },
  "openai-responses": { value: after(upTo(row(SAY.brains, 4).p, "."), "delegation, ") },
  local: { value: upTo(after(row(SAY.brains, 5).p, "only; "), ".") },
  auto: { value: upTo(after(row(SAY.brains, 6).p, "order. "), ".") },
};

/** 02 · Say: the working island at 1:1 in its drawn menu-bar strip beside the seven brains as kit rows with our own marks. */
export function Say(): JSX.Element {
  return (
    <Section id={SAY.id} h2="Say" lead={sentence(SAY.lead, ", and the brain")} /* README:36-38 */>
      <Plate>
        <div className="sec-frame">
          <IslandStrip {...THREADS.island} />
          <Group className="sec-rows" head={<GroupHead title={SETTING.h3} figure={upTo(SETTING.fig, " · pnpm")} />}>
            {SAY.brains.map((b) => (
              <Row key={b.title} size={13} mono icon={MARKS[b.title]} title={b.title} value={TRAIL[b.title]?.value} badge={TRAIL[b.title]?.badge} tip={{ card: { title: b.title, lines: [b.p] } }} />
            ))}
          </Group>
        </div>
      </Plate>
    </Section>
  );
}
