import type { ReactElement } from "react";
import type { GlyphName } from "@/components/kit";
import { NUMBERS, SHOTS } from "@/content/deck";
import { LedgerRail } from "../railGroups";
import { Cut, LRow, LeadFigure, Pic, Sec } from "./parts";

/** A glyph per figure, what the row measures: the reflex bolt, the hourglass, the voice, the terminal, the settled check, the round trip, the screen, the tokens' folder, the tools, the threads, the raised hand, the ping, the relaunch, the sleep. */
export const LEDGER_GLYPHS: readonly GlyphName[] = ["live", "hourglass", "voice", "terminal", "checkCircle", "reloadLine", "circle", "folder", "summon", "ask", "handRaised", "live", "reload", "quit"];
if (LEDGER_GLYPHS.length !== NUMBERS.figures.length) throw new Error("a figure has no glyph");

/** Numbers (picture right): the ledger as the stream, the lead figure first at 28, then every figure in the clock column with its glyph and label; the Ledger tab's day at 0.5× (console-ledger.jpg, the stream pane from x 378, y 128 at 2×: the day's rows with their clocks from Session started to Session closed, the delegation card with its timings, and the 17.0 min billed line the caption promises; the day header above sits outside, since the window cannot hold both at 0.5×); the three provenance rows are the rail's group (railGroups.tsx). */
export function Numbers(): ReactElement {
  return (
    <Sec
      id={NUMBERS.id}
      name={NUMBERS.name}
      label={NUMBERS.label}
      h2={NUMBERS.h2}
      lead={NUMBERS.lead}
      side="right"
      rail={<LedgerRail />}
      pic={
        <Pic caption={SHOTS.consoleLedger.alt}>
          <Cut shot={SHOTS.consoleLedger} scale={0.5} x={189} y={64} />
        </Pic>
      }
    >
      <LeadFigure figure={NUMBERS.display} />
      <ul role="list" className="kit-rows ledger">
        {NUMBERS.figures.map((f, i) => (
          <LRow key={f.label} figure={f} glyph={LEDGER_GLYPHS[i] ?? "dot"} />
        ))}
      </ul>
    </Sec>
  );
}
