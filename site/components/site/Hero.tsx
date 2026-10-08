import Github from "@thesvg/react/github";
import type { ReactElement } from "react";
import { HERO, INSTALL, REPO_URL } from "@/content/deck";
import { first, parts, row } from "@/lib/cut";
import { MitMark } from "@/components/kit/MitMark";
import { Field } from "./Field";
import { HeroCharacter, HeroPoke } from "./HeroCharacter";
import { InstallKey } from "./InstallKey";
import { Stars } from "./Stars";

/** The h1 on one line, its full stop held apart: the blob stands where the stop is. */
const H1 = HERO.h1.join(" ");
if (!H1.endsWith(".")) throw new Error("the h1 no longer ends on a full stop");
const H1_WORDS = H1.slice(0, -1);
/** The lead's first sentence: Say jarhead, pass Touch ID, then tell it what to do on your Mac. */
const LEAD = first(HERO.lead, 1);
/** The glass button's second line: two parts of the figures line and Install's label. */
const FACTS = parts(HERO.figures);
const REQUIREMENTS = [row(FACTS, 2), row(FACTS, 3), INSTALL.label].join(" · ");
/** Under the calls, the two facts a visitor asks in ten seconds: open source (the licence), and what it costs. */
const LICENCE = row(FACTS, 1);
const PRICE = row(FACTS, 4);

/**
 * The hero, nearly empty: paper, the h1 set large and quiet in Newsreader, and the character. The h1's full stop is the
 * blob: on arrival the stop is a dot of ink that wakes, turns blue and grows into the blob on the baseline, glances about,
 * then looks at the visitor (HeroCharacter); on a phone it springs up to stand over the line and leaves the stop behind.
 * Two short sentences under it, then the two calls (the glass Install as a physical key the blob loves, InstallKey; Read
 * the source with the live star count) sitting on the one picture, a horizon of the accent dithered up from the hero's
 * foot and thinned to paper before the hero ends (--field-foot), and one quiet line: MIT's mark in the line's colour (the
 * one Glyphfield sets; a selection or a copy reads "MIT", components/kit/MitMark.tsx), then the price.
 */
export function Hero({ stars }: { readonly stars: number | null }): ReactElement {
  return (
    <section id="hero" className="hero" aria-labelledby="hero-h">
      <Field tone="--jh-accent" ax={0.5} ay={1} band=".hero-calls" />
      <div className="hero-in">
        <div className="hero-line">
          <h1 id="hero-h" className="hero-h1">
            {H1_WORDS}
            <span className="h1-stop">.</span>
            <span className="h1-mark">
              <HeroCharacter />
            </span>
          </h1>
          <HeroPoke />
        </div>
        <p className="hero-lead">{LEAD}</p>
        <div className="hero-calls">
          <InstallKey href="#install" l1={HERO.install} l2={REQUIREMENTS} />
          <a className="source" href={REPO_URL} rel="noopener">
            <Github variant="mono" width={20} height={20} aria-hidden="true" focusable="false" />
            <span>{HERO.source}</span>
            <Stars initial={stars} />
          </a>
        </div>
        <p className="hero-terms">
          <span className="hero-terms-lic">
            <MitMark word={LICENCE} />
          </span>
          {" · "}
          {PRICE}
        </p>
      </div>
    </section>
  );
}
