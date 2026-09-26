import Github from "@thesvg/react/github";
import { HeroStage } from "@/components/HeroStage";
import { Button } from "@/components/kit";
import { HERO, REPO_URL } from "@/content/deck";

/**
 * The hero in SPACE.md §4's rows on Mailroom's words (page.tsx:30-51; MAILROOM.md §1.1): the two-line h1 with the
 * muted second line, a lead of three sentences, two buttons, one 14 px note; then the drawn Mac flush at the rail
 * (only the menu bar, the notch, the island at 1:1, the live blob and the ring), the phase control as one row under
 * it. Entrance: the .rise stagger.
 */
export function Hero() {
  return (
    <header id="top" className="hero">
      <h1 className="hero-h1 rise">
        {HERO.h1[0]}
        <br />
        <span className="mr-grey">{HERO.h1[1]}</span>
      </h1>
      <p className="hero-lead rise rise-2">{HERO.lead}</p>
      <div className="hero-actions rise rise-3">
        <Button kind="primary" size={40} href="#install">
          {HERO.install}
        </Button>
        <Button kind="ghost" size={40} href={REPO_URL} icon={<Github variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />}>
          {HERO.source}
        </Button>
      </div>
      <p className="hero-note rise rise-4">{HERO.note}</p>
      <div className="hero-stage rise rise-3">
        <HeroStage />
      </div>
    </header>
  );
}
