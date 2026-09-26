import Github from "@thesvg/react/github";
import { HeroStage } from "@/components/HeroStage";
import { Button, Chip } from "@/components/kit";
import { REPO_URL } from "@/content/install";

/** README:16 */
const H1 = "Say jarhead. Pass Touch ID. Talk.";
/** README:7, README:16-19: two of the deck's four sentences. */
const LEAD = "A voice-first Mac assistant that uses the computer for you. The brain is whatever you already have a login for.";
/** The deck's figures line (package.json:3, README:13, README:352, README:325, README:332), one chip per figure, the cost one whole: `per second` is the clause that matters (facts-product.md §5.9). */
const FIGURES = ["v2.0.0", "MIT", "macOS 14+", "Apple silicon", "$0.05 / min, per second", "71 tools", "6 brains + auto"] as const;

/**
 * The hero as three rows (SPACE.md §4), one job each: the words (the h1 alone at display size, the lead at a readable
 * measure, two kit buttons, the figures as a kit row of chips) · the stage · the phase control with its hint. Install
 * is the section right after (SPACE.md §4 row 4, the second placement), so the nav's Install lands on its own head.
 */
export function Hero() {
  return (
    <header id="top" className="hero">
      <h1 className="hero-h1">{H1}</h1>
      <p className="hero-lead">{LEAD}</p>
      <div className="hero-actions">
        <Button kind="primary" size={32} href="#install">Install</Button>
        <Button kind="ghost" size={32} href={REPO_URL} icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
          GitHub
        </Button>
      </div>
      <ul className="hero-badges">
        {FIGURES.map((f) => (
          <li key={f}>
            <Chip word={f} />
          </li>
        ))}
      </ul>
      <div className="hero-stage">
        <HeroStage />
      </div>
    </header>
  );
}
