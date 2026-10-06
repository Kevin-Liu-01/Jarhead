"use client";
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { Icon } from "@/components/icons/Icon";
import { ISLAND } from "@/content/island";
import { upTo } from "@/lib/cut";
import { faceMarks, flareSize, type FacePose } from "@/lib/eyes";
import type { Show, Tile } from "@/lib/live";
import type { DeskKind } from "@/lib/phase";

/**
 * The island's face per kind, the app's own pairs (BlobField.swift renderEyes): the gate's small still eyes asleep (its ear
 * open for "jarhead", Kevin's island), round eyes listening, the lowered lids thinking (churning to `~ ~`, Top.tsx), `o o`
 * acting and while a ring is up, `^ ^` speaking.
 */
export const ISLAND_FACE: Record<DeskKind, string> = { listening: "O O", thinking: "- -", acting: "o o", speaking: "^ ^", asleep: ". .", alarm: "o o" };

/**
 * The foot asleep, the app's asleep row (NotchPanel.swift drawAsleepRow): the crescent, `asleep` as its noun, then the next
 * thing armed, the alarm the Sleep night runs to; its name (` · Wake up, Kevin`) is the tail, which gives way docked so the
 * time stays whole at the legible size. While the alarm rings the clause is what the night cost.
 */
const ASLEEP_NOUN = upTo(ISLAND.footAsleep, " · ");
const ALARM_AT = upTo(ISLAND.hero.alarm, " · ");
const ALARM_NAME = ISLAND.hero.alarm.slice(ALARM_AT.length);
const NEXT_WHEN = `next ${upTo(ISLAND.headAlarm, " · ")} ${ALARM_AT}`;

export interface IslandRefs {
  ink: RefObject<HTMLCanvasElement | null>;
  trace: RefObject<HTMLCanvasElement | null>;
  sweep: RefObject<HTMLCanvasElement | null>;
  clock: RefObject<HTMLSpanElement | null>;
  tiles: RefObject<HTMLDivElement | null>;
  eyes: RefObject<HTMLDivElement | null>;
  face: RefObject<SVGSVGElement | null>;
}

/** The face's box in the anchor band, centred on the anchor point, and the body its eyes are drawn for (lib/eyes.ts R). */
const FACE_W = 80;
const FACE_H = 56;
const FACE_R = 52;
/** The light rim round every shape of the face, in island px: wide enough to hold docked, where it is under 1.3 px on screen. */
const FACE_RIM = 1.9;
/**
 * The ink halo round every light mark, in island px: at rest just enough to part a star's tip from the pupil's light rim,
 * and grown with a flare so the star crossing that rim keeps its points.
 */
const GLINT_HALO = 1.5;
const GLINT_REST = 0.6;
/** The halos show only over the rims (an alpha mask of the rims themselves): off the face a flare's tip is paper alone. */
const RIM_MASK = "desk-face-rim";
/** The island's smallest scale on screen (docked on a phone), so the sparkle's 0.7 px floor is judged in screen px. */
const FACE_UNIT = 0.6;
const REST: FacePose = { open: 1, sparkle: 0, turn: 0 };

/**
 * The island's face: the blob's own eyes (lib/eyes.ts) as SVG paths, so they stay crisp at every island scale. The same ink
 * pupils with their paper star and dot, the same ink lines and the happy arcs' own sparkle. The ink is rimmed in the
 * phase-tinted paper (the SVG's colour, styles/desk.css) so the face reads on the island's dark; every light mark sits on
 * a thin ink halo (`.halo`, all drawn before any light fill, shown only over the rims), the rim turned inside out, so a
 * flaring star that crosses a pupil's rim keeps its points. `pair` is the app's, one glyph per eye with a space between.
 */
export function islandFace(pair: string, pose: FacePose = REST): string {
  const marks = faceMarks(pair.replace(/\s+/g, ""), FACE_W / 2, FACE_H / 2, FACE_R, pose, { ink: "ink", light: "glint" }, FACE_UNIT);
  let rims = "";
  let face = "";
  let halos = "";
  let glints = "";
  const f = Math.max(flareSize(pose.flare?.[0] ?? 0), flareSize(pose.flare?.[1] ?? 0));
  const halo = (2 * (GLINT_REST + (GLINT_HALO - GLINT_REST) * Math.min(1, f * 2.5))).toFixed(2);
  for (const m of marks) {
    if (m.paint === "glint") {
      halos += `<path class="halo" d="${m.d}" stroke-width="${halo}"/>`;
      glints += `<path class="glint" d="${m.d}"/>`;
      continue;
    }
    const line = m.fill ? "" : " line";
    rims += `<path class="rim${line}" d="${m.d}" stroke-width="${(m.width + 2 * FACE_RIM).toFixed(2)}"/>`;
    face += m.fill ? `<path class="ink" d="${m.d}"/>` : `<path class="ink line" d="${m.d}" stroke-width="${m.width.toFixed(2)}"/>`;
  }
  const parted = halos ? `<mask id="${RIM_MASK}" mask-type="alpha">${rims}</mask><g mask="url(#${RIM_MASK})">${halos}</g>` : "";
  return rims + face + parted + glints;
}

/**
 * The phase word changes in two steps, never two words at once: the old one fades out, then the new one fades in, each
 * step to its own end (the in step keeps its class until its own animation ends, so it is never cut to full). A change
 * while a step plays never restarts a word from full: during the out step the waiting word is swapped for the newest, and
 * a word still fading in is dropped where it stands and the newest fades in from nothing at once (`now`).
 */
function WordCrossfade({ text }: { text: string }): ReactElement {
  const [pair, setPair] = useState<{ cur: string; prev: string | null; n: number; fading: boolean; now: boolean }>({ cur: text, prev: null, n: 0, fading: false, now: false });
  const prevText = useRef(text);
  useEffect(() => {
    if (prevText.current === text) return;
    const old = prevText.current;
    prevText.current = text;
    setPair((p) => {
      if (p.prev) return { ...p, cur: text };
      if (p.fading) return { cur: text, prev: null, n: p.n + 1, fading: true, now: true };
      return { cur: text, prev: old, n: p.n + 1, fading: true, now: false };
    });
  }, [text]);
  const outDone = () => setPair((p) => (p.prev ? { ...p, prev: null } : p));
  const inDone = () => setPair((p) => (p.fading && !p.prev ? { ...p, fading: false, now: false } : p));
  return (
    <span className="desk-word-x">
      {pair.prev ? (
        <span key={`p${pair.n}`} className="desk-word-out" onAnimationEnd={outDone}>
          {pair.prev}
        </span>
      ) : null}
      <span key={`c${pair.n}`} className={pair.fading ? `desk-word-in${pair.now ? " is-now" : ""}` : undefined} onAnimationEnd={inDone}>
        {pair.cur}
      </span>
    </span>
  );
}

interface IslandProps {
  readonly kind: DeskKind;
  readonly swap: boolean;
  readonly refs: IslandRefs;
  /** What the demo in view put on the island (lib/live.ts): its line, its question, its tiles, the foot's figures. */
  readonly show: Show;
}

/** A tile's second line: the app's `working` with its clock, or the thread's word (`asks`, `done`); a stopped thread goes quiet. */
function tileWord(t: Tile): string | null {
  if (t.state === "working") return null;
  if (t.state === "stopped") return "";
  return t.state;
}

/**
 * The island (design.md §4.3–4.4): the body of the notch grown (the band over the bar is styles/site.css .top-band), one
 * open shape over the ink canvas, never folded to the lip, four DOM bands in px from its top-left: the anchor (the face,
 * the word, Go · Stop · Mute), the display (the head's words, the hero line and under it, in the lines it leaves free, the
 * level trace listening or the working sweep acting with no tiles; the kind's middle), the control row (the Say box with
 * its placeholder, Circle · Window · Ask), and the foot (one line in the app's problem-row grammar: a bright noun, then a
 * quieter clause, the figures or the next thing armed; then the app's Console · Sleep tiles). No line runs along its
 * contour and nothing bar-shaped rides its head or its foot: the phase tone is the eyes' tint, the Go ring and the head's
 * one glyph while it asks or rings, every instrument the paper. It wears all six kinds open, all in the one blue ink:
 * asleep is the app's island (the gate's small still eyes, its words as the hero, set calm, `☾ asleep · next Alarm 07:10`
 * in the foot), the alarm rings over it. Every control and tile icon is Phosphor Fill (components/icons), the site's one
 * family. A drawing of the app, so aria-hidden: the menu bar names its state in words.
 */
export function Island({ kind, swap, refs, show }: IslandProps): ReactElement {
  // The face the server draws (the top engine writes every later one straight to the DOM): the kind's own pair.
  const [face] = useState(() => islandFace(ISLAND_FACE[kind]));
  const sleeping = kind === "asleep" || kind === "alarm";
  // The island asks only its own question, and only when a demo says so (Threads' Slack, Rails' send); any other spoken
  // line (a reason, "night.", a reading) is said without Allow and Deny.
  const question = kind === "speaking" && show.ask === true;
  // Its Allow and Deny answer only for a demo that handed over its answer (Threads); otherwise they are a drawing, and a
  // press on them lands on the island and nowhere else. The demo's own buttons stay the keyboard's and the reader's.
  const answer = question ? show.answer : undefined;
  const working = kind === "thinking" || kind === "acting";
  const tiles = kind === "acting" ? show.tiles : undefined;
  const line = question ? ISLAND.question : (show.line ?? "");
  // Listening, the level trace takes the hero's slot (NotchPanel.swift drawHero): with nothing heard yet it is the middle,
  // level with the word under the face, and the head stays clear; once a line is heard it sits in the lines the line leaves
  // free (the top engine places it). The head never carries a meter.
  const listening = kind === "listening";
  // Acting with no tiles (a hand at work, Rails' and Hands' `Click Save`), the line's free lines carry the working sweep: a
  // small swell of ticks running there and back under the line, so the middle says the work is under way (NotchPanel.swift
  // drawSweep).
  const sweeping = kind === "acting" && !tiles;
  return (
    <div className="desk-island" data-kind={kind} aria-hidden="true">
      <canvas ref={refs.ink} className="desk-ink" />
      <div className="desk-anchor">
        <div ref={refs.eyes} className="desk-eyes">
          <svg ref={refs.face} className="desk-face" width={FACE_W} height={FACE_H} viewBox={`0 0 ${FACE_W} ${FACE_H}`} dangerouslySetInnerHTML={{ __html: face }} />
        </div>
        <div className="desk-word">
          <WordCrossfade text={ISLAND.word[kind]} />
        </div>
        <div className="desk-go">
          <Icon name={sleeping ? "play" : "pause"} size={12} />
        </div>
        <div className={`desk-box desk-stop${sleeping ? " is-spent" : ""}`}>
          <Icon name="stop" size={12} />
        </div>
        <div className={`desk-box desk-mute${sleeping ? " is-dim" : ""}`}>
          <Icon name="microphone" size={14} />
        </div>
      </div>
      <div key={`d${kind}`} className="desk-display" data-swap={swap ? "" : undefined}>
        <div className="desk-head">
          {working ? (
            <span className="desk-head-work">
              {`${ISLAND.working} · `}
              <span ref={refs.clock}>{`0:0${ISLAND.clockBase[kind]}`}</span>
            </span>
          ) : null}
          {question ? (
            <span className="desk-head-ask">
              <Icon name="handPalm" size={12} />
              {ISLAND.headSpeaking}
            </span>
          ) : null}
          {kind === "alarm" ? (
            <span className="desk-head-alarm">
              <Icon name="alarm" size={12} />
              {ISLAND.headAlarm}
            </span>
          ) : null}
        </div>
        {listening ? <canvas ref={refs.trace} className="desk-trace" /> : null}
        {sweeping ? <canvas ref={refs.sweep} className="desk-meter desk-sweep" /> : null}
        {kind === "asleep" ? (
          <div className="desk-hero is-calm">{ISLAND.gate}</div>
        ) : (
          <div className={`desk-hero${question ? " is-question" : ""}${kind === "alarm" ? " is-ring" : ""}${tiles ? " is-short" : ""}`}>
            {kind === "alarm" ? (
              <>
                {/* the app's ring hero: the clock in mono, the line in the sans, the calm second line at 0.72 */}
                <span className="desk-hero-clock">{ALARM_AT}</span>
                {ALARM_NAME}
                <span className="desk-hero-dim">{ISLAND.alarmSub}</span>
              </>
            ) : (
              line
            )}
          </div>
        )}
        {tiles ? (
          <div ref={refs.tiles} className="desk-tiles">
            {tiles.map((t, i) => {
              const word = tileWord(t);
              return (
                <div key={t.name} className="desk-tile" data-state={t.state} style={{ left: i === 0 ? 114 : 266 }}>
                  <span className="desk-tile-name">
                    <i /> {t.name}
                  </span>
                  <span className="desk-tile-s">
                    {word ?? (
                      <>
                        {ISLAND.tileState} · <span className="t">0:08</span>
                      </>
                    )}
                  </span>
                  {t.state === "working" ? <span className="desk-tile-stop" /> : null}
                </div>
              );
            })}
          </div>
        ) : null}
        {question ? (
          <>
            <div className="desk-btn" data-live={answer ? "" : undefined} onClick={answer ? () => answer(true) : undefined} style={{ left: 114, width: 84 }}>
              {ISLAND.allow}
            </div>
            <div className="desk-btn" data-live={answer ? "" : undefined} onClick={answer ? () => answer(false) : undefined} style={{ left: 206, width: 84 }}>
              {ISLAND.deny}
            </div>
          </>
        ) : null}
        {kind === "alarm" ? (
          <>
            {/* sized to their labels, which grow in island px as the island docks (the 10.5 px floor): Snooze has the room. The
                app's other presets (5, 30) show only while Snooze is hovered; a drawing holds the two the alarm offers */}
            <div className="desk-btn" style={{ left: 114, width: 104 }}>
              {ISLAND.snooze}
            </div>
            <div className="desk-btn" style={{ left: 226, width: 68 }}>
              {ISLAND.done}
            </div>
          </>
        ) : null}
        <div className="desk-say">
          {kind === "listening" ? <span className="desk-caret" /> : null}
          <span className="desk-say-ph">{sleeping ? ISLAND.sayAsleep : ISLAND.sayAwake}</span>
        </div>
        {/* Circle · Window · Ask, the app's pencil.and.outline, rectangle.inset.filled, questionmark.bubble.fill; asleep Ask
            takes no press (a typed line would wake it, and the placeholder says press Go), its glyph at the app's 0.35 */}
        <div className="desk-strip" style={{ left: 328, width: question ? 52 : 78 }}>
          <i>
            <Icon name="pencilOutline" size={14} />
          </i>
          <i>
            <Icon name="browser" size={14} />
          </i>
          {question ? null : (
            <i className={sleeping ? "is-off" : undefined}>
              <Icon name="questionBubble" size={14} />
            </i>
          )}
        </div>
      </div>
      <div key={`f${kind}`} className="desk-foot" data-swap={swap ? "" : undefined}>
        {/* the app's seam over the foot (y 153.5, white .10): a rule inside the island, never along its edge */}
        <i className="desk-seam" />
        <div className="desk-foot-row">
          {sleeping ? <Icon name="moon" size={12} /> : null}
          {/* one run of text, so every ` · ` is the same word space: the noun a step up, the clause after it */}
          <span className="desk-foot-line">
            <span className="desk-foot-noun">{sleeping ? ASLEEP_NOUN : (show.clock ?? ISLAND.footClock)}</span>
            {` · ${kind === "alarm" ? ISLAND.footRing : sleeping ? NEXT_WHEN : (show.foot ?? ISLAND.footMeter)}`}
            {kind === "asleep" ? <span className="desk-foot-tail">{ALARM_NAME}</span> : null}
          </span>
        </div>
        {/* Console · Sleep, the app's rectangle.3.group.fill (wide, so drawn at 16 to the symbol's width) and moon.fill;
            asleep Sleep is spent, its glyph at 0.35 */}
        <div className="desk-strip desk-strip--foot">
          <i>
            <Icon name="tilesThree" size={16} />
          </i>
          <i className={sleeping ? "is-off" : undefined}>
            <Icon name="moon" size={12} />
          </i>
        </div>
      </div>
    </div>
  );
}
