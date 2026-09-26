import type { ReactElement } from "react";
import Anthropic from "@thesvg/react/anthropic";
import LmStudio from "@thesvg/react/lm-studio";
import Ollama from "@thesvg/react/ollama";
import Openai from "@thesvg/react/openai";
import { AgentMark } from "@/components/kit";
import { Section } from "@/components/ui/Section";
import { COSTS, SAY } from "@/content/deck";
import { first, row } from "./cut";

/** The six brains as marks alone (ICONS.md: the app's own Codex and Claude Code marks, thesvg mono for the rest; role="img" with the name, no visible word). */
function Marks(): ReactElement {
  return (
    <span className="mr-trust-marks" role="group" aria-label="Brains">
      <AgentMark tool="codex" size={20} />
      <AgentMark tool="claude" size={20} />
      <Anthropic variant="mono" width={20} height={20} role="img" aria-label="Anthropic" />
      <Openai width={20} height={20} className="jh-mark-ink" role="img" aria-label="OpenAI" />
      <Ollama variant="mono" width={20} height={20} role="img" aria-label="Ollama" />
      <LmStudio variant="mono" width={20} height={20} role="img" aria-label="LM Studio" />
    </span>
  );
}

/** The four trust sentences: Say's three lines and the Costs line on the local brain (its own facts side by side). */
const CARDS: readonly string[] = [...SAY.lines, row(COSTS.lines, 1)];
/** The card that says "every brain" wears the six brains. */
const WITH_MARKS = SAY.lines[1];

/**
 * #say: the h2 that lists the brains, the lead's first two sentences (the third is card 02 of the story), then
 * Mailroom's 2 × 2 trust cards (page.tsx:122-131; MAILROOM.md §6 take 11), one sentence each, the six marks on the one
 * that names every brain.
 */
export function Say(): ReactElement {
  return (
    <Section id={SAY.id} h2={SAY.h2} lead={first(SAY.lead, 2)}>
      <ul className="mr-trust">
        {CARDS.map((s) => (
          <li key={s} className="mr-card">
            {s}
            {s === WITH_MARKS ? <Marks /> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
