import type { ReactElement } from "react";
import { Pill } from "@/components/ui/Pill";
import { Lead, Section } from "@/components/ui/Section";
import { RAILS } from "@/content/deck";
import { from } from "./cut";

/**
 * #rails: the h2, the lede's second and third sentences (the h2 already says run, confirm or refuse), the three lines
 * as Mailroom's trust cards (take 11), then the never-line as one line (the hatched NEVER pill and the seven items with
 * a dot between, take 9) and the closing line under it as the lede after.
 */
export function Rails(): ReactElement {
  return (
    <Section id={RAILS.id} h2={RAILS.h2} lead={from(RAILS.lead, 1)}>
      <ul className="mr-trust mr-trust--3">
        {RAILS.lines.map((l) => (
          <li key={l} className="mr-card">
            {l}
          </li>
        ))}
      </ul>
      <p className="mr-never">
        <Pill danger word={RAILS.never.label} />
        {RAILS.never.items.map((item, i) => (
          <span key={item} className="mr-never-item">
            {i > 0 ? (
              <span className="mr-never-sep" aria-hidden="true">
                ·
              </span>
            ) : null}
            {item}
          </span>
        ))}
      </p>
      <Lead after>{RAILS.never.line}</Lead>
    </Section>
  );
}
