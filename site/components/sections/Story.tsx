import type { ReactElement } from "react";
import { Glyph, type GlyphName } from "@/components/kit";
import { Section } from "@/components/ui/Section";
import { HandsTile, SayTile, WakeTile } from "@/components/ui/Tiles";
import { HANDS, SAY, WAKE } from "@/content/deck";
import { nth } from "./cut";

/**
 * The three cards (RunFlow.tsx:79-95): a number, a tile, a one-word title with its glyph, one self-contained deck
 * sentence as the caption: Wake line 1, the Say lead's last sentence (the Say slide keeps its first two), Hands
 * line 1 (the Hands figure keeps lines 2 and 3). Nothing here is said again on another slide.
 */
const CARDS: ReadonlyArray<{ readonly name: string; readonly glyph: GlyphName; readonly tile: ReactElement; readonly caption: string }> = [
  { name: WAKE.name, glyph: "mic", tile: <WakeTile />, caption: WAKE.lines[0] },
  { name: SAY.name, glyph: "voice", tile: <SayTile />, caption: nth(SAY.lead, 2) }, // "You pick the brain in Settings."
  { name: HANDS.name, glyph: "summon", tile: <HandsTile />, caption: HANDS.lines[0] },
];

/**
 * The wire between two cards (RunFlow.tsx:67-77), without Mailroom's lowercase label: the deck has no connector strings,
 * and the only whole sentences on the gate and the policy are headings this page already says once.
 */
function Connector(): ReactElement {
  return (
    <div className="mr-conn" aria-hidden="true">
      <svg className="mr-conn-h" viewBox="0 0 96 24">
        <path className="mr-wire" d="M0 12 H96" />
        <path className="mr-signal" d="M0 12 H96" />
      </svg>
      <svg className="mr-conn-v" viewBox="0 0 24 56">
        <path className="mr-wire" d="M12 0 V56" />
        <path className="mr-signal" d="M12 0 V56" />
      </svg>
    </div>
  );
}

/** #story: Wake's two-line h2 and lede, then the numbered 01 · 02 · 03 triptych, Wake · Say · Hands, on signal wires (MAILROOM.md §6 take 6). */
export function Story(): ReactElement {
  return (
    <Section id={WAKE.id} h2={WAKE.h2} lead={WAKE.lead}>
      <ol className="mr-trip">
        {CARDS.map((c, i) => (
          <li key={c.name} style={{ display: "contents" }}>
            {i > 0 ? <Connector /> : null}
            <div className="mr-card mr-tcard">
              <span className="mr-tnum">{String(i + 1).padStart(2, "0")}</span>
              {c.tile}
              <h3 className="mr-ttitle">
                <Glyph name={c.glyph} size={16} />
                {c.name}
              </h3>
              <p className="mr-tcap">{c.caption}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
