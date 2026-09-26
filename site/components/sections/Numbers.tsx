import type { JSX } from "react";
import { Glyph, Group, GroupHead, Row, Tip, type GlyphName } from "@/components/kit";
import { Plate } from "@/components/ui/Plate";
import { Section } from "@/components/ui/Section";
import { COSTS, NUMBERS } from "@/content/copy";
import { after, join, row, upTo } from "./cut";

/**
 * The display figure's line cut once: `ear final → hands dispatch` as the label, `median · 6 ms p95 · real helper · n = 50 ·
 * 2026-09-11` as the proof line on the page (facts-product.md §5.8: never 3 ms without its median, n and date), and the
 * same proof as the tip (README:313, docs/LATENCY.md:321).
 */
const DISPLAY_LABEL = upTo(NUMBERS.displayLine, " · ");
const DISPLAY_PROOF = after(NUMBERS.displayLine, `${DISPLAY_LABEL} · `);

/**
 * Six of the README's rows as kit rows: the deck's label, its figure as the value, its proof as the tip. A latency row
 * (`proof`) also carries its proof as the meta line, so the n and the date are on the page on every device (§5.8; a tip
 * is never the only carrier).
 */
const LATENCY: ReadonlyArray<{ readonly i: number; readonly glyph: GlyphName; readonly proof?: true }> = [
  { i: 2, glyph: "voice", proof: true }, // GPT-Live-1 reply · README:321
  { i: 3, glyph: "play", proof: true }, // delegation to first visible action · README:317
  { i: 4, glyph: "checkCircle", proof: true }, // delegation to verified completion · README:318
  { i: 5, glyph: "reload", proof: true }, // tool round trip · README:322
  { i: 7, glyph: "terminal" }, // input tokens on a cold Codex thread · README:324
  { i: 14, glyph: "exclamationCircle" }, // the daemon lingers after a crash · README:331
];
const VOICE = row(COSTS.rows, 0); // The voice · GPT-Live-1 · README:325
/** The voice row's title with its first sentence: the cost figure's tip title; the rest of the row is the tip's line. */
const VOICE_TITLE = join(VOICE.title, upTo(VOICE.p, "."));
const VOICE_STORY = after(VOICE.p, ". ");
const NOTHING: ReadonlyArray<{ readonly i: number; readonly glyph: GlyphName }> = [
  { i: 1, glyph: "pause" }, // Asleep · README:526
  { i: 2, glyph: "stopCircle" }, // Paused or stopped · README:35
  { i: 8, glyph: "terminal" }, // Benchmarks · README:529
];

const figure = (t: { figure: string; unit?: string }): string => (t.unit ? `${t.figure}${t.unit === "k" ? "" : " "}${t.unit}` : t.figure);

/**
 * Numbers: 3 ms as the one display figure beside the latency rows; Costs as a second figure beside its three rows. Every
 * provenance is a tip; a latency's is also on the page, the one mono proof line under the figure and the meta line of its row.
 * The cost figure's line is the deck's own (`per second of open session, muted or not · $3 an hour of talking`, README:325,
 * README:526), so the clause that matters is visible and never only in a tip (facts-product.md §5.9).
 */
export function Numbers(): JSX.Element {
  return (
    <Section id={NUMBERS.id} h2={NUMBERS.h2} lead={NUMBERS.lead} /* README:307-309 */>
      <Plate>
        <div className="sec-frame sec-frame--figure">
          <Tip card={{ title: NUMBERS.display, lines: [DISPLAY_PROOF] }} tap>
            <button type="button" className="sec-figure" aria-label={join(NUMBERS.display, DISPLAY_LABEL)}>
              <span className="sec-figure-v">{NUMBERS.display}</span>
              <span className="sec-figure-l">{DISPLAY_LABEL}</span>
              <span className="sec-figure-p">{DISPLAY_PROOF}</span>
            </button>
          </Tip>
          <Group className="sec-rows">
            {LATENCY.map(({ i, glyph, proof }) => {
              const t = row(NUMBERS.tiles, i);
              return (
                <Row key={t.label} size={13} icon={<Glyph name={glyph} size={16} />} title={t.label} value={figure(t)} meta={proof ? t.proof : undefined} tip={{ card: { title: figure(t), lines: [t.proof] } }} />
              );
            })}
          </Group>
        </div>
        <div className="sec-frame sec-frame--figure">
          <Tip card={{ title: VOICE_TITLE, lines: [VOICE_STORY] }} tap>
            <button type="button" className="sec-figure is-md" aria-label={join(COSTS.display, COSTS.displayLine)}>
              <span className="sec-figure-v">{COSTS.display}</span>
              <span className="sec-figure-l">{COSTS.displayLine}</span>
            </button>
          </Tip>
          <Group className="sec-rows" head={<GroupHead title={COSTS.h2} count={NOTHING.length} />}>
            {NOTHING.map(({ i, glyph }) => {
              const r = row(COSTS.rows, i);
              return <Row key={r.title} size={13} icon={<Glyph name={glyph} size={16} />} title={r.title} value={r.value} tip={r.p ? { card: { title: r.title, lines: [r.p] } } : undefined} />;
            })}
          </Group>
        </div>
      </Plate>
    </Section>
  );
}
