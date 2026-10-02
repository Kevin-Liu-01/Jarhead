import { Fragment, type ReactElement } from "react";
import { JarheadMark } from "@/components/kit/Mark";
import { FOOTER, HERO } from "@/content/deck";
import { parts } from "@/lib/cut";

/**
 * The version and the licence, the two figures said nowhere else (the hero, Costs and Hands carry the rest), held whole
 * between their dots so the line wraps only between parts.
 */
const FIGURES = parts(HERO.figures).slice(0, 2);

/**
 * The disclosures that still hold for drawn pictures: the alarm's fixed words, the voice's one language, the marks' source
 * (the first two speak of captures, and the page shows none), then the credit (the licence is on the figures line).
 */
const NOTES = [...FOOTER.disclosures.slice(2), FOOTER.credit];

/**
 * The foot, centred and calm: the orb mark at 56 and the name, the line that says what it is and what it is built with, the
 * version and licence in mono, then the disclosures in one quiet row. GitHub and its stars live in the bar and the hero.
 */
export function Footer(): ReactElement {
  return (
    <footer className="foot">
      <div className="foot-in">
        <div className="foot-brand">
          <JarheadMark size={56} />
          <span>{FOOTER.brand}</span>
        </div>
        <p className="foot-line">{FOOTER.line1}</p>
        <p className="foot-line foot-line--2">{FOOTER.line2}</p>
        <p className="foot-mono">
          {FIGURES.map((f, i) => (
            <Fragment key={f}>
              {i > 0 ? " · " : null}
              <span>{f}</span>
            </Fragment>
          ))}
        </p>
        <ul className="foot-notes" role="list">
          {NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
