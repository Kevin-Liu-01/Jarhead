import Apple from "@thesvg/react/apple";
import Github from "@thesvg/react/github";
import type { ReactElement } from "react";
import { Badge, Button } from "@/components/kit";
import { HERO, INSTALL, REPO_URL } from "@/content/deck";
import { parts, row } from "@/lib/cut";
import { PhaseControl } from "../PhaseControl";
import { Stars } from "../Stars";
import { Top } from "../Top";

/** The figures line's four standing facts as figure badges (v2.0.0 · MIT · macOS 14+ · Apple silicon); the session's two live in the rail's phase card. */
const FACTS = parts(HERO.figures).slice(0, 4);
/** The glass button's second line: the two requirements from the figures line and the Install conversation's label, joined with the deck's own dot. */
const REQUIREMENTS = [row(FACTS, 2), row(FACTS, 3), INSTALL.label].join(" · "); // macOS 14+ · Apple silicon · source only

/**
 * The stream's first conversation (ITERATE.md §1, §3, §4): the notch and the island at the top, centred, with the blob's
 * face in its anchor band and the Segments control under it; then the h1 on one line, the lead, the glass install button
 * with the Apple mark and the requirements inside, the source button with the star count, the note and the figure badges.
 */
export function Hero({ stars }: { readonly stars: number | null }): ReactElement {
  return (
    <section className="hero" aria-labelledby="hero-h">
      <div className="hero-dock">
        <Top />
      </div>
      <div className="hero-phase">
        <PhaseControl />
      </div>
      <div className="hero-words">
        <h1 id="hero-h" className="hero-h1">
          {HERO.h1.join(" ")}
        </h1>
        <p className="hero-lead">{HERO.lead}</p>
        <div className="hero-actions">
          <a className="glass" href="#install">
            <Apple variant="mono" width={20} height={20} className="glass-mark" aria-hidden="true" focusable="false" />
            <span className="glass-lines">
              <span className="glass-l1">{HERO.install}</span>
              <span className="glass-l2">{REQUIREMENTS}</span>
            </span>
          </a>
          <Button kind="ghost" size={40} href={REPO_URL} className="hero-source" icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
            {HERO.source}
            <span className="hero-sep" aria-hidden="true">
              ·
            </span>
            <Stars initial={stars} />
          </Button>
        </div>
        <p className="hero-note">{HERO.note}</p>
        <div className="kit-flow hero-badges">
          {FACTS.map((f) => (
            <Badge key={f} figure={f} />
          ))}
        </div>
      </div>
    </section>
  );
}
