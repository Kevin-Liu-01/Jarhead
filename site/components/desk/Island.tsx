"use client";
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { Icon } from "@/components/icons/Icon";
import { ISLAND } from "@/content/island";
import { after, upTo } from "@/lib/cut";
import { faceMarks, type FacePose } from "@/lib/eyes";
import type { Show, Tile } from "@/lib/live";
import type { DeskKind } from "@/lib/phase";

/** The asleep foot as the app splits it (notch-island-alarm.png): the crescent and `asleep` at the left, the next thing armed at the right. */
const ASLEEP_WORD = upTo(ISLAND.footAsleep, " · ");
const ASLEEP_NEXT = after(ISLAND.footAsleep, `${ASLEEP_WORD} · `);

export interface IslandRefs {
  ink: RefObject<HTMLCanvasElement | null>;
  meterHead: RefObject<HTMLCanvasElement | null>;
  meterFoot: RefObject<HTMLCanvasElement | null>;
  glyphs: RefObject<HTMLSpanElement | null>;
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
const REST: FacePose = { open: 1, sparkle: 0, turn: 0 };

/**
 * The island's face: the blob's own eyes (lib/eyes.ts) as SVG paths, so they stay crisp at every island scale. The same ink
 * pupils with their paper catchlight and the same ink lines, each rimmed in the phase-tinted paper (the SVG's colour,
 * styles/desk.css) so the face reads on the island's dark. `pair` is the app's, one glyph per eye with a space between.
 */
export function islandFace(pair: string, pose: FacePose = REST): string {
  const marks = faceMarks(pair.replace(/\s+/g, ""), FACE_W / 2, FACE_H / 2, FACE_R, pose, { ink: "ink", light: "glint" });
  let rims = "";
  let face = "";
  for (const m of marks) {
    if (m.paint === "glint") {
      face += `<path class="glint" d="${m.d}"/>`;
      continue;
    }
    const line = m.fill ? "" : " line";
    rims += `<path class="rim${line}" d="${m.d}" stroke-width="${(m.width + 2 * FACE_RIM).toFixed(2)}"/>`;
    face += m.fill ? `<path class="ink" d="${m.d}"/>` : `<path class="ink line" d="${m.d}" stroke-width="${m.width.toFixed(2)}"/>`;
  }
  return rims + face;
}

/** The phase word crossfades over --jh-drift: the old word fades out under the new one. */
function WordCrossfade({ text }: { text: string }): ReactElement {
  const [pair, setPair] = useState<{ cur: string; prev: string | null; n: number }>({ cur: text, prev: null, n: 0 });
  const prevText = useRef(text);
  useEffect(() => {
    if (prevText.current === text) return;
    const old = prevText.current;
    prevText.current = text;
    setPair((p) => ({ cur: text, prev: old, n: p.n + 1 }));
  }, [text]);
  const settle = () => setPair((p) => (p.prev ? { ...p, prev: null } : p));
  return (
    <span className="desk-word-x">
      {pair.prev ? (
        <span key={`p${pair.n}`} className="desk-word-out" onAnimationEnd={settle}>
          {pair.prev}
        </span>
      ) : null}
      <span key={`c${pair.n}`} className={pair.prev ? "desk-word-in" : undefined}>
        {pair.cur}
      </span>
    </span>
  );
}

interface IslandProps {
  readonly kind: DeskKind;
  readonly swap: boolean;
  readonly still: boolean;
  readonly refs: IslandRefs;
  /** What the demo in view put on the island (lib/live.ts): its line, its question, its tiles, the foot, the clock. */
  readonly show: Show;
}

/** A tile's second line: the app's `working` with its clock, or the thread's word (`asks`, `done`); a stopped thread goes quiet. */
function tileWord(t: Tile): string | null {
  if (t.state === "working") return null;
  if (t.state === "stopped") return "";
  return t.state;
}

/**
 * The island (design.md §4.3–4.4): one open shape over the ink canvas, never folded to the lip, four DOM bands in px from
 * its top-left: the anchor (the face, the word, Go · Stop · Mute), the display (the head, the hero line, the kind's middle),
 * the control row (the Say box with its placeholder, Circle · Window · Ask), the foot (the clock, the meter and its figure, or the asleep line;
 * then the app's Console · Sleep tiles), and the phase hairline along the bottom. It wears all six kinds open: asleep is the
 * app's quiet island (the titanium ink, `- -`, the crescent, the clock), the alarm rings over it. Every control and tile
 * icon is Phosphor Fill (components/icons), the site's one family. A drawing of the app, so aria-hidden: the menu bar names
 * its state in words.
 */
export function Island({ kind, swap, still, refs, show }: IslandProps): ReactElement {
  // The face the server draws (the top engine writes every later one straight to the DOM): asleep's flat pair at first.
  const [face] = useState(() => islandFace(kind === "listening" ? "O O" : "- -"));
  const sleeping = kind === "asleep" || kind === "alarm";
  // The island asks only its own question, and only when a demo says so (Threads' Slack, Rails' send); any other spoken
  // line (a reason, "night.", a reading) is said without Allow and Deny.
  const question = kind === "speaking" && show.ask === true;
  // Its Allow and Deny answer only for a demo that handed over its answer (Threads); otherwise they are a drawing, and a
  // press on them lands on the island and nowhere else. The demo's own buttons stay the keyboard's and the reader's.
  const answer = question ? show.answer : undefined;
  const working = kind === "thinking" || kind === "acting";
  const tiles = kind === "acting" ? show.tiles : undefined;
  const line = question ? ISLAND.hero.speaking : kind === "alarm" ? ISLAND.hero.alarm : (show.line ?? "");
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
        <div className="desk-box desk-stop">
          <Icon name="stop" size={12} />
        </div>
        <div className={`desk-box desk-mute${sleeping ? " is-dim" : ""}`}>
          <Icon name="microphone" size={14} />
        </div>
      </div>
      <div className="desk-display" data-swap={swap ? "" : undefined}>
        <div className="desk-head">
          {kind === "listening" || (kind === "speaking" && !question) ? <canvas ref={refs.meterHead} className="desk-meter desk-meter-head" /> : null}
          {working ? (
            <span className="desk-head-work">
              {ISLAND.working} · <span ref={refs.clock}>{`0:0${ISLAND.clockBase[kind]}`}</span>
              {kind === "thinking" ? (
                <span ref={refs.glyphs} className="desk-glyphs">
                  {still ? ".#.#.#.#" : "        "}
                </span>
              ) : null}
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
              <i className="desk-dot" />
              {ISLAND.headAlarm}
            </span>
          ) : null}
          {kind === "asleep" ? (
            <span className="desk-head-asleep">
              <Icon name="moon" size={12} />
              {ASLEEP_WORD}
            </span>
          ) : null}
        </div>
        {kind === "asleep" ? (
          <div className="desk-hero is-clock">{show.clock ?? ISLAND.footClock}</div>
        ) : (
          <div className={`desk-hero${question ? " is-question" : ""}${kind === "alarm" ? " is-mono" : ""}${tiles ? " is-short" : ""}`}>
            {line}
            {kind === "alarm" ? <span className="desk-hero-dim">{ISLAND.alarmSub}</span> : null}
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
            <div className="desk-btn" data-live={answer ? "" : undefined} onClick={answer ? () => answer(true) : undefined} style={{ left: 114, top: 82, width: 84 }}>
              {ISLAND.allow}
            </div>
            <div className="desk-btn" data-live={answer ? "" : undefined} onClick={answer ? () => answer(false) : undefined} style={{ left: 206, top: 82, width: 84 }}>
              {ISLAND.deny}
            </div>
          </>
        ) : null}
        {kind === "alarm" ? (
          <>
            <div className="desk-btn" style={{ left: 114, top: 82, width: 84 }}>
              {ISLAND.snooze}
            </div>
            <div className="desk-btn" style={{ left: 206, top: 82, width: 84 }}>
              {ISLAND.done}
            </div>
            <div className="desk-btn is-mono" style={{ left: 300, top: 82, width: 48 }}>
              {ISLAND.five}
            </div>
            <div className="desk-btn is-mono" style={{ left: 356, top: 82, width: 48 }}>
              {ISLAND.thirty}
            </div>
          </>
        ) : null}
        <div className="desk-say">
          {kind === "listening" ? <span className="desk-caret" /> : null}
          <span className="desk-say-ph">{sleeping ? ISLAND.sayAsleep : ISLAND.sayAwake}</span>
        </div>
        <div className="desk-strip" style={{ left: 328, width: question ? 52 : 78 }}>
          <i>
            <Icon name="crosshairSimple" size={14} />
          </i>
          <i>
            <Icon name="appWindow" size={14} />
          </i>
          {question ? null : (
            <i>
              <Icon name="question" size={14} />
            </i>
          )}
        </div>
      </div>
      <div className="desk-foot" data-swap={swap ? "" : undefined}>
        <div className="desk-foot-row">
          {sleeping ? (
            <>
              <span className="desk-foot-l">
                <Icon name="moon" size={12} />
                {ASLEEP_WORD}
              </span>
              <span className="desk-foot-r">{ASLEEP_NEXT}</span>
            </>
          ) : (
            <>
              <span className="desk-foot-l">{show.clock ?? ISLAND.footClock}</span>
              <canvas ref={refs.meterFoot} className="desk-meter desk-meter-foot" />
              <span className="desk-foot-r">{show.foot ?? ISLAND.footMeter}</span>
            </>
          )}
        </div>
        <div className="desk-strip desk-strip--foot">
          <i>
            <Icon name="layout" size={14} />
          </i>
          <i>
            <Icon name="moon" size={12} />
          </i>
        </div>
      </div>
      <div className="desk-hair" />
    </div>
  );
}
