"use client";
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { Icon } from "@/components/ui/Icons";

export type IslandState = "open" | "peek" | "tucked";
export type IslandKind = "listening" | "thinking" | "acting" | "speaking" | "alarm";
export type LipFace = "- -" | ". ." | "O O";

/** The island's strings per kind (design.md §4.4; README:39, README:45, README:117-119, README:274-281, docs/DEMO.md:21; notch-island*.png). */
export const ISLAND = {
  utterance: "Tell Ben on Slack I'm late and put on Focus on Spotify.",
  word: { listening: "Listening", thinking: "Thinking", acting: "Acting", speaking: "Speaking", alarm: "Alarm" } as const,
  hero: {
    listening: "Tell Ben on Slack I'm late and put on Focus on Spotify.",
    thinking: "Three independent apps: Notes and Spotify take Apple events, Slack needs the pointer.",
    acting: "Slack on the screen lane, Spotify on a background lane.",
    speaking: 'Slack asks: send "I\'m running late" to Ben?',
    alarm: "07:10 · Wake up, Kevin",
  } as const,
  alarmSub: "Monday · standup notes at 9",
  headSpeaking: "✋ Slack asks",
  headAlarm: "⏰ Alarm · weekdays",
  working: "Working",
  tiles: [
    { name: "Slack", state: "working" },
    { name: "Spotify", state: "working" },
  ],
  allow: "Allow",
  deny: "Deny",
  snooze: "Snooze 10",
  done: "Done",
  five: "5",
  thirty: "30",
  sayAwake: "Say something…",
  sayAsleep: "Asleep · press Go",
  footClock: "12:37",
  footMeter: "7.2 min · $0.36",
  footAsleep: "☾ asleep · next Timer 11:56 · pasta",
  pill: "Touch ID or passphrase",
  clockBase: { thinking: 1, acting: 6 } as const,
};

export interface IslandRefs {
  ink: RefObject<HTMLCanvasElement | null>;
  meterHead: RefObject<HTMLCanvasElement | null>;
  meterFoot: RefObject<HTMLCanvasElement | null>;
  glyphs: RefObject<HTMLSpanElement | null>;
  clock: RefObject<HTMLSpanElement | null>;
  tiles: RefObject<HTMLDivElement | null>;
  typed: RefObject<HTMLSpanElement | null>;
  say: RefObject<HTMLDivElement | null>;
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
      {pair.prev ? <span key={`p${pair.n}`} className="desk-word-out" onAnimationEnd={settle}>{pair.prev}</span> : null}
      <span key={`c${pair.n}`} className={pair.prev ? "desk-word-in" : undefined}>{pair.cur}</span>
    </span>
  );
}

export interface IslandProps {
  kind: IslandKind;
  state: IslandState;
  lipFace: LipFace;
  swap: boolean;
  still: boolean;
  pill: boolean;
  refs: IslandRefs;
}

/**
 * The island (design.md §4.3–4.4; docs/REDESIGN.md §20): one shape in three states over the ink
 * canvas, four DOM bands in px from its top-left: anchor (face, word, Go · Stop · Mute), display
 * (head, hero, the kind's middle), the control row (Say box, Circle · Window · Ask), the foot
 * (clock, bar, meter, Console · Sleep), the phase hairline along the bottom. Tucked it is the lip
 * with `- -`; peeking it is the face on a 26 px strip. Drawn, so aria-hidden.
 */
export function Island({ kind, state, lipFace, swap, still, pill, refs }: IslandProps): ReactElement {
  const asleep = kind === "alarm";
  const question = kind === "speaking";
  const working = kind === "thinking" || kind === "acting";
  return (
    <>
      <div className="desk-island" data-state={state} data-kind={kind} aria-hidden="true">
        <canvas ref={refs.ink} className="desk-ink" />
        <div className="desk-anchor">
          <div ref={refs.eyes} className="desk-eyes">
            <span ref={refs.eyeUnder} className="desk-eye-under">O O</span>
            <span ref={refs.eyeTop} className="desk-eye-top">O O</span>
          </div>
          <div className="desk-word"><WordCrossfade text={ISLAND.word[kind]} /></div>
          <div className="desk-go">{asleep ? <Icon.play size={10} /> : <Icon.pause size={10} />}</div>
          <div className="desk-box desk-stop"><Icon.stop size={12} /></div>
          <div className={`desk-box desk-mute${asleep ? " is-dim" : ""}`}><Icon.mic size={12} /></div>
        </div>
        <div className="desk-display" data-swap={swap ? "" : undefined}>
          <div className="desk-head">
            {kind === "listening" ? <canvas ref={refs.meterHead} className="desk-meter desk-meter-head" /> : null}
            {working ? (
              <span className="desk-head-work">
                {ISLAND.working} · <span ref={refs.clock}>{`0:0${ISLAND.clockBase[kind]}`}</span>
                <span ref={refs.glyphs} className="desk-glyphs">{still ? ".#.#.#.#" : "        "}</span>
              </span>
            ) : null}
            {question ? <span>{ISLAND.headSpeaking}</span> : null}
            {asleep ? <span>{ISLAND.headAlarm}</span> : null}
          </div>
          <div className={`desk-hero${question ? " is-question" : ""}${asleep ? " is-mono" : ""}`}>
            {ISLAND.hero[kind]}
            {asleep ? <span className="desk-hero-dim">{ISLAND.alarmSub}</span> : null}
          </div>
          {kind === "acting" ? (
            <div ref={refs.tiles} className="desk-tiles">
              {ISLAND.tiles.map((tl, i) => (
                <div key={tl.name} className="desk-tile" style={{ left: i === 0 ? 114 : 266 }}>
                  <span className="desk-tile-name"><i /> {tl.name}</span>
                  <span className="desk-tile-s">{tl.state} · <span className="t">0:06</span></span>
                  <span className="desk-tile-stop" />
                </div>
              ))}
            </div>
          ) : null}
          {question ? (
            <>
              <div className="desk-btn" style={{ left: 114, top: 82, width: 84 }}>{ISLAND.allow}</div>
              <div className="desk-btn" style={{ left: 206, top: 82, width: 84 }}>{ISLAND.deny}</div>
            </>
          ) : null}
          {asleep ? (
            <>
              <div className="desk-btn" style={{ left: 114, top: 82, width: 84 }}>{ISLAND.snooze}</div>
              <div className="desk-btn" style={{ left: 206, top: 82, width: 84 }}>{ISLAND.done}</div>
              <div className="desk-btn is-mono" style={{ left: 300, top: 82, width: 48 }}>{ISLAND.five}</div>
              <div className="desk-btn is-mono" style={{ left: 356, top: 82, width: 48 }}>{ISLAND.thirty}</div>
            </>
          ) : null}
          <div ref={refs.say} className="desk-say" data-typing={kind === "listening" ? "" : undefined}>
            {kind === "listening" ? (
              <>
                <span className="desk-say-ph">{still ? "" : ISLAND.sayAwake}</span>
                <span ref={refs.typed} className="desk-typed">{still ? ISLAND.utterance : ""}</span>
                <span className="desk-caret" />
              </>
            ) : (
              <span className="desk-say-ph">{asleep ? ISLAND.sayAsleep : ISLAND.sayAwake}</span>
            )}
          </div>
          <div className="desk-strip" style={{ left: 328, width: question ? 52 : 78 }}>
            <i><Icon.target size={12} /></i>
            <i><Icon.window size={12} /></i>
            {question ? null : <i><Icon.ask size={12} /></i>}
          </div>
        </div>
        <div className="desk-foot" data-swap={swap ? "" : undefined}>
          {asleep ? (
            <span className="desk-foot-l is-wide">{ISLAND.footAsleep}</span>
          ) : (
            <>
              <span className="desk-foot-l">{ISLAND.footClock}</span>
              <canvas ref={refs.meterFoot} className="desk-meter desk-meter-foot" />
              <span className="desk-foot-r">{ISLAND.footMeter}</span>
            </>
          )}
          <div className="desk-strip desk-strip-foot" style={{ left: asleep ? 380 : 354, width: asleep ? 26 : 52 }}>
            <i><Icon.grid size={12} /></i>
            {asleep ? null : <i><Icon.moon size={12} /></i>}
          </div>
        </div>
        <div className="desk-hair" />
        <div className="desk-lipface" data-face={lipFace}>
          <span className="desk-eye-under">{lipFace}</span>
          <span className="desk-eye-top">{lipFace}</span>
        </div>
      </div>
      <div className="desk-pill" data-on={pill ? "" : undefined} aria-hidden="true">{ISLAND.pill}</div>
    </>
  );
}
