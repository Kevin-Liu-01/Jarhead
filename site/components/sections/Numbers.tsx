import type { ReactElement, ReactNode } from "react";
import { Group, Row, Tip } from "@/components/kit";
import { Figure } from "@/components/ui/Figure";
import { Pill } from "@/components/ui/Pill";
import { Heading, Lead } from "@/components/ui/Section";
import { NUMBERS } from "@/content/deck";
import { row } from "./cut";

/** Eight of the fifteen figures as the ledger's rows; the rest live where they are the fact (Threads, Hands, Sleep, Costs). */
const ROWS = [0, 1, 2, 3, 4, 7, 11, 13].map((i) => row(NUMBERS.figures, i));

/** A date (2026-09-11) stays whole: on the phone the line would otherwise break at the hyphens inside it. A render split only; the text stays byte for byte the deck's. */
function dated(s: string): ReactNode {
  return s.split(/(\d{4}-\d{2}-\d{2})/).map((part, i) => (i % 2 ? <span key={i} className="mr-nowrap">{part}</span> : part));
}

/**
 * #numbers: Mailroom's two-column section (page.tsx:94-100; JudgmentCard): the h2, the lede and the three provenance
 * lines at the left; at the right the ledger figure: the lead figure on top, then label · value rows, every tooltip a kit tip.
 */
export function Numbers(): ReactElement {
  return (
    <section id={NUMBERS.id} className="mr-sec">
      <div className="mr-two">
        <div>
          <Heading h2={NUMBERS.h2} />
          <Lead>{NUMBERS.lead}</Lead>
          <div className="mr-lines">
            {NUMBERS.lines.map((l) => (
              <p key={l}>{dated(l)}</p>
            ))}
          </div>
        </div>
        <Figure stack head={<Pill word={NUMBERS.label} />}>
          <div className="mr-panel">
            <Tip card={{ title: NUMBERS.display.value, lines: [NUMBERS.display.tip] }}>
              <button type="button" className="mr-ledger-top" aria-label={`${NUMBERS.display.value} · ${NUMBERS.display.label}`}>
                <span className="mr-ledger-v">{NUMBERS.display.value}</span>
                <span className="mr-ledger-l">{NUMBERS.display.label}</span>
              </button>
            </Tip>
          </div>
          <Group className="mr-rows mr-ledger">
            {ROWS.map((r) => (
              <Row key={r.label} size={13} title={r.label} value={r.value} tip={{ card: { title: r.value, lines: [r.tip] } }} />
            ))}
          </Group>
        </Figure>
      </div>
    </section>
  );
}
