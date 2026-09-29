import Github from "@thesvg/react/github";
import type { ReactElement } from "react";
import { Badge, Button } from "@/components/kit";
import { HERO, REPO_URL } from "@/content/deck";
import { parts } from "@/lib/cut";
import { HeroBlob } from "../HeroBlob";
import { PhaseControl } from "../PhaseControl";

/** The figures line's four standing facts as figure badges (v2.0.0 · MIT · macOS 14+ · Apple silicon); the session's two live in the rail's phase card. */
const FACTS = parts(HERO.figures).slice(0, 4);

/**
 * The stream's first conversation: the h1 at the Console's one display size, the lead, the two calls and the
 * figure badges at the left; the live blob at the right on the ground; the phase control under both.
 */
export function Hero(): ReactElement {
  return (
    <section className="hero" aria-labelledby="hero-h">
      <div className="hero-grid">
        <div className="hero-words">
          <h1 id="hero-h" className="hero-h1">
            {HERO.h1[0]}
            <br />
            {HERO.h1[1]}
          </h1>
          <p className="hero-lead">{HERO.lead}</p>
          <div className="hero-actions">
            <Button kind="primary" size={32} href="#install">
              {HERO.install}
            </Button>
            <Button kind="ghost" size={32} href={REPO_URL} icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
              {HERO.source}
            </Button>
          </div>
          <div className="kit-flow hero-badges">
            {FACTS.map((f) => (
              <Badge key={f} figure={f} />
            ))}
          </div>
        </div>
        <HeroBlob />
      </div>
      <div className="hero-phase">
        <PhaseControl />
      </div>
    </section>
  );
}
