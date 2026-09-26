import type { ReactElement, ReactNode } from "react";
import { Lead, Section } from "@/components/ui/Section";
import { FOOTER, MADE } from "@/content/deck";
import { after, upTo } from "./cut";

/** The four trust sentences: the lede's third sentence and the three lines. */
const CARDS: readonly string[] = [after(MADE.lead, "TypeScript. "), ...MADE.lines];

/** A hyphenated compound (append-only, self-edits) stays whole: the card's `text-wrap: balance` would otherwise break it at the hyphen. A render split only; the text stays byte for byte the deck's. */
function whole(s: string): ReactNode {
  return s.split(/(\S+-\S+)/).map((part, i) => (i % 2 ? <span key={i} className="mr-nowrap">{part}</span> : part));
}

/** #made: the h2, the lede's first two sentences, Mailroom's 2 × 2 trust cards (page.tsx:122-131), then the caveat lede: every picture is a harness render. */
export function Made(): ReactElement {
  return (
    <Section id={MADE.id} h2={MADE.h2} lead={upTo(MADE.lead, " Two Swift")}>
      <ul className="mr-trust">
        {CARDS.map((s) => (
          <li key={s} className="mr-card">
            {whole(s)}
          </li>
        ))}
      </ul>
      <Lead after>
        {FOOTER.disclosures[0]} {FOOTER.disclosures[1]}
      </Lead>
    </Section>
  );
}
