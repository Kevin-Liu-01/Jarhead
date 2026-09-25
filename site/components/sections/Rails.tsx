import type { JSX } from "react";
import { Section } from "@/components/ui/Section";
import { Screen } from "@/components/ui/Screen";
import { Ledger } from "./Ledger";
import { NeverPanel } from "./NeverPanel";
import { RAILS } from "@/content/copy";

/** 05 · Rails: the NEVER panel at the head of the fifteen-rail ledger; the Slack ask, the self-edit, the Trash at the right. */
export function Rails(): JSX.Element {
  return (
    <Section id={RAILS.id} phase="speaking" h2={RAILS.h2} lead={RAILS.lead} className="sec-rails">
      <div className="sec-precedence">{RAILS.precedence}</div>
      <div className="sec-rails-row">
        <div className="sec-rails-left">
          <NeverPanel label={RAILS.never.label} list={RAILS.never.list} line={RAILS.never.line} />
          <Ledger rows={RAILS.rows} variant="article" />
        </div>
        <div className="sec-stack">
          <div className="sec-stack-item">
            <Screen {...RAILS.asks} aspect="3/4" position="0 0" maxWidth={300} />
            <p className="sec-cap">{RAILS.asksCap}</p>
          </div>
          <div className="sec-stack-item">
            <h3 className="sec-h3">{RAILS.rewrites.h3}</h3>
            <p className="sec-p">{RAILS.rewrites.p}</p>
            <div className="sec-fig">{RAILS.rewrites.fig}</div>
          </div>
          <div className="sec-stack-item">
            <Screen {...RAILS.cleanupShot} aspect="3/4" position="0 0" maxWidth={300} />
            <h3 className="sec-h3">{RAILS.cleanup.h3}</h3>
            <p className="sec-p">{RAILS.cleanup.p}</p>
          </div>
          <div className="sec-stack-item">
            <div className="sec-label">{RAILS.railsListHead}</div>
            <div className="sec-fig sec-fig--wrap">{RAILS.railsList}</div>
          </div>
        </div>
      </div>
    </Section>
  );
}
