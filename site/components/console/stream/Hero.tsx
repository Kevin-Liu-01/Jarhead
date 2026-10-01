import Apple from "@thesvg/react/apple";
import Github from "@thesvg/react/github";
import type { ReactElement } from "react";
import { Button } from "@/components/kit";
import { HERO, INSTALL, REPO_URL } from "@/content/deck";
import { first, parts, row } from "@/lib/cut";
import { PhaseControl } from "../PhaseControl";
import { Stars } from "../Stars";
import { Top } from "../Top";

/** The figures line's standing facts; the glass button's second line is the two requirements and the Install conversation's label, joined with the deck's own dot. */
const FACTS = parts(HERO.figures);
const REQUIREMENTS = [row(FACTS, 2), row(FACTS, 3), INSTALL.label].join(" · "); // macOS 14+ · Apple silicon · source only
/** The lead cut to its first two sentences (CENTER.md "The hero words"). */
const LEAD = first(HERO.lead, 2); // Say jarhead, pass Touch ID, talk. It uses the computer for you.

/**
 * The stream's first conversation (CENTER.md): the Mac's top edge (the menu bar, the notch, the island with the blob's face
 * and the six faces in its foot) spanning the stream, then, with 32 px of air, three things: the h1 on one line, the lead,
 * the two calls (the glass Install with its two lines, Read the source with the star count). Nothing else.
 */
export function Hero({ stars }: { readonly stars: number | null }): ReactElement {
  return (
    <section className="hero" aria-labelledby="hero-h">
      <div className="hero-dock">
        <Top />
      </div>
      <div className="hero-phase">
        <PhaseControl variant="wide" />
      </div>
      <div className="hero-words">
        <h1 id="hero-h" className="hero-h1">
          {HERO.h1.join(" ")}
        </h1>
        <p className="hero-lead">{LEAD}</p>
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
      </div>
    </section>
  );
}
