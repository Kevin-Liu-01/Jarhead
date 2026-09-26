import type { ReactElement } from "react";
import { Tip } from "@/components/kit";
import { Lead, Section } from "@/components/ui/Section";
import { COSTS } from "@/content/deck";
import { from, row } from "./cut";

/**
 * Mailroom's cost section has no lede (page.tsx:104-118): the h2 says the price, the cards say it in figures, and the
 * one sentence the figures cannot say stands after them. Costs lines 1 and 3 ride as card-tip lines on the figure they
 * qualify; line 2 sits beside its local-brain twin on the Say slide.
 */
const EXTRA: Readonly<Record<string, string>> = { [row(COSTS.figures, 0).value]: row(COSTS.lines, 0), [row(COSTS.figures, 1).value]: row(COSTS.lines, 2) };

export function Costs(): ReactElement {
  return (
    <Section id={COSTS.id} h2={COSTS.h2}>
      <ul className="mr-stats">
        {COSTS.figures.map((f) => {
          const extra = EXTRA[f.value];
          return (
            <li key={f.value}>
              <Tip card={{ title: f.value, status: f.label, lines: extra ? [f.tip, extra] : [f.tip] }}>
                <div className="mr-card mr-stat" tabIndex={0} aria-label={`${f.value} · ${f.label}`}>
                  <span className="mr-stat-v">{f.value}</span>
                  <span className="mr-stat-l">{f.label}</span>
                </div>
              </Tip>
            </li>
          );
        })}
      </ul>
      <Lead after>{from(COSTS.lead, 2)}</Lead>
    </Section>
  );
}
