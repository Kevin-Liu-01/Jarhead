import Anthropic from "@thesvg/react/anthropic";
import Apple from "@thesvg/react/apple";
import LmStudio from "@thesvg/react/lm-studio";
import Ollama from "@thesvg/react/ollama";
import Openai from "@thesvg/react/openai";
import Pnpm from "@thesvg/react/pnpm";
import Xcode from "@thesvg/react/xcode";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { AgentMark, Glyph, Group, GroupHead, JarheadMark, Row, type GlyphName } from "@/components/kit";
import { COSTS, HANDS, HERO, INSTALL, MADE, NUMBERS, RAILS, SAY, SHOTS, SLEEP, THREADS, WAKE } from "@/content/deck";
import { part, parts, row } from "@/lib/cut";
import { BAYER8_RANKS } from "@/lib/dither";
import { AgentsGroup, ThreadsNowGroup } from "./railRows";
import { Crop, LRow, Tone } from "./stream/parts";

/**
 * The right rail's per-conversation groups (RightRailView.swift: the Now rail follows the conversation; console-jarhead.jpg
 * shows it full to the fold). The rail shows the group of the section in view (RightRail.tsx); on a phone the same group
 * sits at the end of its section (parts.tsx Sec `rail`). Each conversation's group is its own deck rows or its own capture,
 * never the stream's picture: Wake's gate faces, Say's brains as marks, the Now rail's Threads group and the Agents group
 * drawn from the kit (railRows.tsx; the phone's home for the left rail's threads and agents), Rails' never-list, Sleep's
 * Automations cropped from the capture, Numbers' provenance rows, Costs' three figures, Made's Bayer row and the overlay's
 * shapes, Install's Requirements as a Permissions-style group.
 */

/** The five gate faces (README:163; blob-eyes.jpg): the pair in its phase colour on the icon column, the label as the row. */
const FACES: ReadonlyArray<{ readonly pair: string; readonly tone: string }> = [
  { pair: ". .", tone: "--jh-asleep" },
  { pair: "O O", tone: "--jh-listening" },
  { pair: "^ ^", tone: "--jh-listening" },
  { pair: "> <", tone: "--jh-error" },
  { pair: "- -", tone: "--jh-muted" },
];
const FACE_LABELS = parts(WAKE.faces); // gate · heard · granted · denied · locked
if (FACE_LABELS.length !== FACES.length) throw new Error("the faces strip and its labels drifted");

export function WakeRail(): ReactElement {
  return (
    <Group className="rr-group" head={<GroupHead title={WAKE.name} count={FACES.length} rule />}>
      {FACES.map((f, i) => (
        <Row
          key={f.pair}
          size={13}
          icon={
            <span className="rr-face-pair" style={{ "--face": `var(${f.tone})` } as CSSProperties} aria-hidden="true">
              {f.pair}
            </span>
          }
          title={row(FACE_LABELS, i)}
        />
      ))}
    </Group>
  );
}

/** `6 brains + auto`, the figures line's last fact (README:341), as the marks' group head; the marks alone, each named (ICONS.md). */
const BRAINS = row(parts(HERO.figures), 6);
if (BRAINS !== "6 brains + auto") throw new Error("the brains fact drifted");

export function SayRail(): ReactElement {
  return (
    <Group className="rr-group" head={<GroupHead title={BRAINS} rule />}>
      <li className="marks">
        <AgentMark tool="codex" size={20} />
        <AgentMark tool="claude" size={20} />
        <Anthropic variant="mono" width={20} height={20} role="img" aria-label="Anthropic" />
        <Openai width={20} height={20} className="mark-ink" role="img" aria-label="OpenAI" />
        <Ollama variant="mono" width={20} height={20} role="img" aria-label="Ollama" />
        <LmStudio variant="mono" width={20} height={20} role="img" aria-label="LM Studio" />
        <JarheadMark size={20} label />
      </li>
    </Group>
  );
}

/** The Now rail's Threads group (console-threads.jpg, right): drawn from the kit; on a phone the left rail's threads live here. */
export function ThreadsRail(): ReactElement {
  return <ThreadsNowGroup className="rr-group rr-app" />;
}

/** The Agents group (console-jarhead.jpg, left): the same drawing as the rail's; on a phone the left rail's agents live here. */
export function HandsRail(): ReactElement {
  return <AgentsGroup className="rr-group rr-app" />;
}

/** The never-list (README:349) as the rail's group: the seven refused rows in the error tone, the closing line as its foot. */
export function NeverRail(): ReactElement {
  return (
    <Group className="rr-group" head={<GroupHead title={RAILS.never.label} count={RAILS.never.items.length} rule />}>
      {RAILS.never.items.map((item) => (
        <Row key={item} size={13} mono icon={<Tone name="xOctagon" tone="error" />} title={item} />
      ))}
      <Row size={13} className="rr-never-foot" icon={<Tone name="exclamationCircle" tone="speaking" />} title={RAILS.never.line} />
    </Group>
  );
}

/** The wizard's step name (README:66) is the Console's own word for the group. */
const AGENTS = part(INSTALL.setup, "Agents");
if (AGENTS !== "Agents") throw new Error("the agents word drifted");

/** The Console's Automations group cropped from the capture at 0.5× (console-automations.jpg, x 1200 to 1600, y 460 to 760 at 2×): the alarm, the timer, the routine. */
export function SleepRail(): ReactElement {
  return (
    <Group className="rr-group" head={<GroupHead title={SLEEP.name} rule />}>
      <li className="rr-crop-host">
        <Crop shot={SHOTS.consoleAutomations} scale={0.5} x={600} y={232} width={200} height={150} className="rr-crop" />
      </li>
    </Group>
  );
}

/** A date (2026-09-11) stays whole on a phone; a render split only, the text stays byte for byte the deck's. */
function dated(s: string): ReactNode {
  return s.split(/(\d{4}-\d{2}-\d{2})/).map((p, i) => (i % 2 ? <span key={i} className="nowrap">{p}</span> : p));
}

/** The ledger's three provenance rows (facts:308-311) under the conversation's own label. */
export function LedgerRail(): ReactElement {
  return (
    <Group className="rr-group" head={<GroupHead title={NUMBERS.label} count={NUMBERS.lines.length} rule />}>
      {NUMBERS.lines.map((l) => (
        <Row key={l} size={13} icon={<Tone name="terminal" />} title={dated(l)} />
      ))}
    </Group>
  );
}

/** A glyph per Costs figure: the open session, the voice talking, asleep. */
const BILL_GLYPHS: readonly GlyphName[] = ["live", "voice", "quit"];
if (BILL_GLYPHS.length !== COSTS.figures.length) throw new Error("a figure has no glyph");

/** The three figures (README:536) as ledger rows in a narrow clock column, each with its provenance card. */
export function BillRail(): ReactElement {
  return (
    <Group className="rr-group rr-bill" head={<GroupHead title={COSTS.label} count={COSTS.figures.length} rule />}>
      {COSTS.figures.map((f, i) => (
        <LRow key={f.label} figure={f} glyph={BILL_GLYPHS[i] ?? "dot"} />
      ))}
    </Group>
  );
}

/** The 8×8 Bayer tile as the row's glyph at the column's 16, in the column's ink (Dither.swift:127; lib/dither.ts BAYER8_RANKS): every rank under 32 is ink, the pattern the app dithers with. */
function Bayer(): ReactElement {
  return (
    <svg className="kit-glyph" width={16} height={16} viewBox="0 0 8 8" fill="currentColor" aria-hidden="true" focusable="false" shapeRendering="crispEdges">
      {BAYER8_RANKS.map((r, i) => (r < 32 ? <rect key={i} x={i % 8} y={Math.floor(i / 8)} width={1} height={1} /> : null))}
    </svg>
  );
}

/** The Bayer line wearing the tile, then the overlay's shapes cropped at 0.5× (overlay-shapes.png, x 800 to 1200, y 120 to 400 at 2×): the circle and the arrow the hands draw. */
export function MadeRail(): ReactElement {
  return (
    <Group className="rr-group" head={<GroupHead title={MADE.label} rule />}>
      <Row size={13} icon={<Bayer />} title={MADE.lines[0]} />
      <li className="rr-crop-host">
        <Crop shot={SHOTS.overlayShapes} scale={0.5} x={400} y={60} width={200} height={140} className="rr-crop" />
      </li>
    </Group>
  );
}

/** The six requirements: the three the script checks wear their product marks (ICONS.md), the three the visitor brings the kit's glyphs; a settled check on each. */
const REQ: ReadonlyArray<{ readonly icon: ReactNode; readonly title: string; readonly meta?: string }> = [
  { icon: <Apple variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, title: INSTALL.requirements.items[0] },
  { icon: <Xcode variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, title: INSTALL.requirements.items[1] },
  { icon: <Pnpm variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, title: INSTALL.requirements.items[2] },
  { icon: <Glyph name="key" size={16} />, title: INSTALL.requirements.items[3] },
  { icon: <Glyph name="ask" size={16} />, title: INSTALL.requirements.items[4] },
  { icon: <Glyph name="lock" size={16} />, title: INSTALL.requirements.items[5], meta: INSTALL.requirements.certNote },
];

export function InstallRail(): ReactElement {
  return (
    <Group className="rr-group rr-req" head={<GroupHead title={INSTALL.requirements.word} count={INSTALL.requirements.count} rule />}>
      {REQ.map((r) => (
        <Row key={r.title} size={13} icon={r.icon} title={r.title} meta={r.meta ? <span className="rr-req-note">{r.meta}</span> : undefined} trailing={<Tone name="checkCircle" tone="acting" />} />
      ))}
    </Group>
  );
}

/** The group per section id, in the stream's order; the hero, the live conversation, shows the constant groups alone. */
export const RAIL_GROUPS: Readonly<Record<string, () => ReactElement>> = {
  [WAKE.id]: WakeRail,
  [SAY.id]: SayRail,
  [THREADS.id]: ThreadsRail,
  [HANDS.id]: HandsRail,
  [RAILS.id]: NeverRail,
  [SLEEP.id]: SleepRail,
  [NUMBERS.id]: LedgerRail,
  [COSTS.id]: BillRail,
  [MADE.id]: MadeRail,
  [INSTALL.id]: InstallRail,
};
