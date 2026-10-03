import { Costs } from "@/components/play/Costs";
import { Hands } from "@/components/play/Hands";
import { Numbers } from "@/components/play/Numbers";
import { Rails } from "@/components/play/Rails";
import { Say } from "@/components/play/Say";
import { Sleep } from "@/components/play/Sleep";
import { Threads } from "@/components/play/Threads";
import { Wake } from "@/components/play/Wake";
import { Footer } from "@/components/site/Footer";
import { Hero } from "@/components/site/Hero";
import { Install } from "@/components/site/Install";
import { Notes, Section } from "@/components/site/Section";
import { SectionSpy } from "@/components/site/SectionSpy";
import { section } from "@/components/site/sections";
import { Top } from "@/components/site/Top";
import { COSTS, HANDS, NAV, NUMBERS, RAILS, SAY, SLEEP, THREADS, WAKE } from "@/content/deck";
import { from, nth } from "@/lib/cut";
import { fetchStars } from "@/lib/stars";

/** Hands' h2, its three sentences set apart so each lights as the hands reach its step. */
const HANDS_STEPS = [nth(HANDS.h2[0], 0), nth(HANDS.h2[0], 1), HANDS.h2[1]] as const;

/**
 * The page: paper, the Mac's top edge fixed over everything (the island wears what the visitor is doing), the hero where
 * the h1's full stop is the blob, then one idea per screen: a Newsreader h2, one short line, and a plate where the idea is
 * played, each a small vignette the blob takes part in. Install, then the foot.
 */
export default async function Page() {
  const stars = await fetchStars();
  return (
    <div className="page">
      <a href="#main" className="jh-skip">
        {NAV.skip}
      </a>
      <Top stars={stars} />
      <main id="main">
        <Hero stars={stars} />

        <Section meta={section("wake")} h2={WAKE.h2} lead={nth(WAKE.lead, 0)} notes={<Notes items={[{ icon: "userSound", text: WAKE.lines[1] }]} />}>
          <Wake />
        </Section>

        <Section meta={section("say")} layout="stack" h2={SAY.h2} lead={nth(SAY.lead, 2)} notes={<Notes items={[{ icon: "toolbox", text: SAY.lines[1] }]} />}>
          <Say />
        </Section>

        <Section meta={section("threads")} side="left" h2={THREADS.h2} lead={nth(THREADS.lead, 2)}>
          <Threads />
        </Section>

        <Section
          meta={section("hands")}
          layout="stack"
          h2={
            <>
              <span className="sec-h2-1">
                <span className="h2-step" data-n="label">
                  {HANDS_STEPS[0]}
                </span>{" "}
                <span className="h2-step" data-n="click">
                  {HANDS_STEPS[1]}
                </span>
              </span>{" "}
              <span className="sec-h2-2">
                <span className="h2-step" data-n="shot">
                  {HANDS_STEPS[2]}
                </span>
              </span>
            </>
          }
          lead={nth(HANDS.lead, 0)}
          notes={
            <Notes
              items={[
                { icon: "crosshair", text: HANDS.lines[1] },
                { icon: "scribbleLoop", text: HANDS.lines[0] },
              ]}
            />
          }
        >
          <Hands />
        </Section>

        <Section meta={section("rails")} h2={RAILS.h2} lead={from(RAILS.lead, 1)} notes={<Notes items={[{ icon: "monitor", text: RAILS.lines[2] }]} />}>
          <Rails />
        </Section>

        <Section meta={section("sleep")} side="left" h2={SLEEP.h2} lead={nth(SLEEP.lead, 2)} notes={<Notes items={[{ icon: "power", text: SLEEP.lines[2] }]} />}>
          <Sleep />
        </Section>

        <Section
          meta={section("numbers")}
          layout="center"
          h2={NUMBERS.h2}
          lead={nth(NUMBERS.lead, 1)}
          notes={
            <Notes
              items={[
                { icon: "lightning", text: NUMBERS.lines[0] },
                { icon: "speakerHigh", text: NUMBERS.lines[2] },
                { icon: "brain", text: NUMBERS.lines[1] },
              ]}
            />
          }
        >
          <Numbers />
        </Section>

        <Section meta={section("costs")} h2={COSTS.h2} lead={from(COSTS.lead, 1)} notes={<Notes items={[{ icon: "coins", text: COSTS.lines[0] }, { icon: "laptop", text: COSTS.lines[1] }]} />}>
          <Costs />
        </Section>

        <Install />
      </main>
      <Footer />
      <SectionSpy />
    </div>
  );
}
