import { ArtCosts } from "@/components/art/Costs";
import { ArtHands } from "@/components/art/Hands";
import { ArtNumbers } from "@/components/art/Numbers";
import { ArtSay } from "@/components/art/Say";
import { ArtSleep } from "@/components/art/Sleep";
import { ArtWake } from "@/components/art/Wake";
import { ConsoleWindow } from "@/components/site/ConsoleWindow";
import { Footer } from "@/components/site/Footer";
import { Hero } from "@/components/site/Hero";
import { Install } from "@/components/site/Install";
import { RailsPicture } from "@/components/site/RailsPicture";
import { Lines, Pic, Section } from "@/components/site/Section";
import { SectionSpy } from "@/components/site/SectionSpy";
import { section } from "@/components/site/sections";
import { Top } from "@/components/site/Top";
import { COSTS, HANDS, NAV, NUMBERS, RAILS, SAY, SLEEP, THREADS, WAKE } from "@/content/deck";
import { first, from, nth } from "@/lib/cut";
import { fetchStars } from "@/lib/stars";

/**
 * The page (docs/DESIGN.md): the Mac's top edge fixed over everything, the island hanging from the notch and wearing the
 * kind of the section in view; the hero with the real blob huge beside the h1 on one line; then one section per question,
 * each on its own full-bleed ground of its tone dithered over the page ground at low intensity, the words beside one big
 * drawing; Install with the terminal; the foot. Each idea is said once: the cost lives in Costs, the spoken step in the
 * Install h2.
 */
export default async function Page() {
  const stars = await fetchStars();
  return (
    <div className="page" data-desk-stage="">
      <a href="#main" className="jh-skip">
        {NAV.skip}
      </a>
      <Top stars={stars} />
      <main id="main">
        <Hero stars={stars} />

        <Section
          meta={section("wake")}
          h2={WAKE.h2}
          lead={`${nth(WAKE.lead, 0)} ${nth(WAKE.lead, 2)}`}
          pic={
            <Pic>
              <ArtWake />
            </Pic>
          }
        >
          <Lines
            items={[
              { glyph: "lock", text: WAKE.lines[0] },
              { glyph: "voice", text: WAKE.lines[1] },
            ]}
          />
        </Section>

        <Section
          meta={section("say")}
          h2={SAY.h2}
          lead={SAY.lead}
          pic={
            <Pic>
              <ArtSay />
            </Pic>
          }
        >
          <Lines
            items={[
              { glyph: "live", text: SAY.lines[0] },
              { glyph: "ask", text: SAY.lines[1] },
            ]}
          />
        </Section>

        <Section meta={section("threads")} h2={THREADS.h2} lead={`${nth(THREADS.lead, 0)} ${nth(THREADS.lead, 2)}`} pic={<ConsoleWindow />}>
          <Lines
            items={[
              { glyph: "handRaised", text: THREADS.lines[0] },
              { glyph: "terminal", text: HANDS.lines[2] },
            ]}
          />
        </Section>

        <Section
          meta={section("hands")}
          h2={HANDS.h2}
          lead={nth(HANDS.lead, 0)}
          pic={
            <Pic>
              <ArtHands />
            </Pic>
          }
        >
          <Lines
            items={[
              { glyph: "circle", text: HANDS.lines[0] },
              { glyph: "scopeMark", text: HANDS.lines[1] },
            ]}
          />
        </Section>

        <Section meta={section("rails")} h2={RAILS.h2} lead={nth(RAILS.lead, 2)} pic={<RailsPicture />}>
          <Lines
            items={[
              { glyph: "handRaised", text: first(RAILS.never.line, 1) },
              { glyph: "voice", text: RAILS.lines[0] },
            ]}
          />
        </Section>

        <Section
          meta={section("sleep")}
          h2={SLEEP.h2}
          lead={`${nth(SLEEP.lead, 0)} ${nth(SLEEP.lead, 2)}`}
          pic={
            <Pic>
              <ArtSleep />
            </Pic>
          }
        >
          <Lines
            items={[
              { glyph: "handRaised", text: SLEEP.lines[1] },
              { glyph: "quit", text: SLEEP.lines[2] },
            ]}
          />
        </Section>

        <Section
          meta={section("numbers")}
          h2={NUMBERS.h2}
          pic={
            <Pic>
              <ArtNumbers />
            </Pic>
          }
        >
          <p className="big-fig">
            <span className="big-fig-v">{NUMBERS.display.value}</span>
            <span className="big-fig-l">{NUMBERS.display.label}</span>
          </p>
          <p className="sec-lead">{nth(NUMBERS.lead, 1)}</p>
        </Section>

        <Section
          meta={section("costs")}
          h2={COSTS.h2}
          lead={from(COSTS.lead, 1)}
          pic={
            <Pic>
              <ArtCosts />
            </Pic>
          }
        >
          <Lines
            items={[
              { glyph: "terminal", text: COSTS.lines[0] },
              { glyph: "slashCircle", text: COSTS.lines[1] },
            ]}
          />
        </Section>

        <Install />
      </main>
      <Footer />
      <SectionSpy />
    </div>
  );
}
