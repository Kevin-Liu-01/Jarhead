"use client";
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { Glyph } from "@/components/kit/Glyph";
import { ISLAND } from "@/content/island";
import { after, upTo } from "@/lib/cut";
import type { DeskKind } from "@/lib/phase";
import { Icon } from "./Icons";

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
  eyeTop: RefObject<HTMLSpanElement | null>;
  eyeUnder: RefObject<HTMLSpanElement | null>;
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
}

/**
 * The island (design.md §4.3–4.4): one open shape over the ink canvas, never folded to the lip, four DOM bands in px from
 * its top-left: the anchor (the face, the word, Go · Stop · Mute), the display (the head, the hero line, the kind's middle),
 * the control row (the Say box with its placeholder, Circle · Window · Ask), the foot (the clock, the meter and its figure, or the asleep line;
 * then the app's Console · Sleep tiles), and the phase hairline along the bottom. It wears all six kinds open: asleep is the
 * app's quiet island (the titanium ink, `- -`, the crescent, the clock), the alarm rings over it. Every control glyph is the
 * kit's; Window and the crescent are the drawn Mac's own (desk/Icons). A drawing of the app, so aria-hidden: the menu bar
 * names its state in words.
 */
export function Island({ kind, swap, still, refs }: IslandProps): ReactElement {
  const sleeping = kind === "asleep" || kind === "alarm";
  const question = kind === "speaking";
  const working = kind === "thinking" || kind === "acting";
  return (
    <div className="desk-island" data-kind={kind} aria-hidden="true">
      <canvas ref={refs.ink} className="desk-ink" />
      <div className="desk-anchor">
        <div ref={refs.eyes} className="desk-eyes">
          <span ref={refs.eyeUnder} className="desk-eye-under">
            O O
          </span>
          <span ref={refs.eyeTop} className="desk-eye-top">
            O O
          </span>
        </div>
        <div className="desk-word">
          <WordCrossfade text={ISLAND.word[kind]} />
        </div>
        <div className="desk-go">
          <Glyph name={sleeping ? "play" : "pause"} size={14} />
        </div>
        <div className="desk-box desk-stop">
          <Glyph name="stop" size={14} />
        </div>
        <div className={`desk-box desk-mute${sleeping ? " is-dim" : ""}`}>
          <Glyph name="mic" size={14} />
        </div>
      </div>
      <div className="desk-display" data-swap={swap ? "" : undefined}>
        <div className="desk-head">
          {kind === "listening" ? <canvas ref={refs.meterHead} className="desk-meter desk-meter-head" /> : null}
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
              <Glyph name="handRaised" size={14} />
              {ISLAND.headSpeaking}
            </span>
          ) : null}
          {kind === "alarm" ? (
            <span className="desk-head-alarm">
              <Glyph name="dot" size={14} />
              {ISLAND.headAlarm}
            </span>
          ) : null}
          {kind === "asleep" ? (
            <span className="desk-head-asleep">
              <Icon.moon size={12} />
              {ASLEEP_WORD}
            </span>
          ) : null}
        </div>
        {kind === "asleep" ? (
          <div className="desk-hero is-clock">{ISLAND.footClock}</div>
        ) : (
          <div className={`desk-hero${question ? " is-question" : ""}${kind === "alarm" ? " is-mono" : ""}`}>
            {ISLAND.hero[kind]}
            {kind === "alarm" ? <span className="desk-hero-dim">{ISLAND.alarmSub}</span> : null}
          </div>
        )}
        {kind === "acting" ? (
          <div ref={refs.tiles} className="desk-tiles">
            {ISLAND.tiles.map((name, i) => (
              <div key={name} className="desk-tile" style={{ left: i === 0 ? 114 : 266 }}>
                <span className="desk-tile-name">
                  <i /> {name}
                </span>
                <span className="desk-tile-s">
                  {ISLAND.tileState} · <span className="t">0:08</span>
                </span>
                <span className="desk-tile-stop" />
              </div>
            ))}
          </div>
        ) : null}
        {question ? (
          <>
            <div className="desk-btn" style={{ left: 114, top: 82, width: 84 }}>
              {ISLAND.allow}
            </div>
            <div className="desk-btn" style={{ left: 206, top: 82, width: 84 }}>
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
            <Glyph name="scopeMark" size={14} />
          </i>
          <i>
            <Icon.window size={13} />
          </i>
          {question ? null : (
            <i>
              <Glyph name="questionCircle" size={14} />
            </i>
          )}
        </div>
      </div>
      <div className="desk-foot" data-swap={swap ? "" : undefined}>
        <div className="desk-foot-row">
          {sleeping ? (
            <>
              <span className="desk-foot-l">
                <Icon.moon size={12} />
                {ASLEEP_WORD}
              </span>
              <span className="desk-foot-r">{ASLEEP_NEXT}</span>
            </>
          ) : (
            <>
              <span className="desk-foot-l">{ISLAND.footClock}</span>
              <canvas ref={refs.meterFoot} className="desk-meter desk-meter-foot" />
              <span className="desk-foot-r">{ISLAND.footMeter}</span>
            </>
          )}
        </div>
        <div className="desk-strip desk-strip--foot">
          <i>
            <Icon.console size={13} />
          </i>
          <i>
            <Icon.moon size={12} />
          </i>
        </div>
      </div>
      <div className="desk-hair" />
    </div>
  );
}
