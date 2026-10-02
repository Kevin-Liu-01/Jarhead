import Apple from "@thesvg/react/apple";
import Github from "@thesvg/react/github";
import type { ReactElement } from "react";
import { HERO, INSTALL, REPO_URL } from "@/content/deck";
import { first, parts, row } from "@/lib/cut";
import { Field } from "./Field";
import { HeroBlob } from "./HeroBlob";
import { Stars } from "./Stars";

/** The glass button's second line: the figures line's two requirements and Install's own label, joined with the deck's dot. */
const FACTS = parts(HERO.figures);
const REQUIREMENTS = [row(FACTS, 2), row(FACTS, 3), INSTALL.label].join(" · "); // macOS 14+ · Apple silicon · source only
/** The lead cut to its first two sentences. */
const LEAD = first(HERO.lead, 2); // Say jarhead, pass Touch ID, talk. It uses the computer for you.

/**
 * The hero: the island hangs from the notch above it (the sticky top), the real blob huge at the right on the h1's horizon,
 * and on the left the h1 on one line, one lead, and the two calls: the glass Install (the Apple mark, `Install` and the
 * requirements; the page's one glass surface, frosting the band of light the field runs behind it) and Read the source with
 * the live star count. The ground is the accent dithered over the page ground, rising behind the blob.
 */
export function Hero({ stars }: { readonly stars: number | null }): ReactElement {
  return (
    <section id="hero" className="hero" aria-labelledby="hero-h">
      <Field tone="--jh-accent" ax={0.8} ay={0.44} band=".hero-calls" />
      <div className="hero-in">
        <div className="hero-words">
          <div className="hero-blob">
            <HeroBlob />
          </div>
          <h1 id="hero-h" className="hero-h1">
            {HERO.h1.join(" ")}
          </h1>
          <p className="hero-lead">{LEAD}</p>
          <div className="hero-calls">
            <a className="glass" href="#install">
              <Apple variant="mono" width={30} height={30} className="glass-mark" aria-hidden="true" focusable="false" />
              <span className="glass-lines">
                <span className="glass-l1">{HERO.install}</span>
                <span className="glass-l2">{REQUIREMENTS}</span>
              </span>
            </a>
            <a className="source" href={REPO_URL} rel="noopener">
              <Github variant="mono" width={22} height={22} aria-hidden="true" focusable="false" />
              <span>{HERO.source}</span>
              <Stars initial={stars} />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
