"use client";
import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { Icon } from "@/components/icons/Icon";
import { ISLAND } from "@/content/island";
import { upTo } from "@/lib/cut";
import { REST, TONE, faceCells, type FaceCells, type FaceHold, type FacePose } from "@/lib/eyes";
import { inkPixels } from "@/lib/island";
import type { Show, Tile } from "@/lib/live";
import type { DeskKind } from "@/lib/phase";

/**
 * The island's face per kind, the app's own pairs (BlobField.swift renderEyes): asleep the blob's own sleeping lids (its ear
 * open for "jarhead" or not, turning `~ ~` at the top of a breath, Top.tsx), round eyes listening, the lowered lids
 * thinking (churning to `~ ~`), `o o` acting and while a ring is up, `^ ^` speaking.
 */
export const ISLAND_FACE: Record<DeskKind, string> = { listening: "O O", thinking: "- -", acting: "o o", speaking: "^ ^", asleep: "- -", alarm: "o o" };

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
}

/** The face: the body its eyes are drawn for (lib/eyes.ts R) and its centre in the anchor band, in island px. */
const FACE_R = 52;
const FACE_X = 57;
const FACE_Y = 40;
/** The paper rim round the pupils, in island px (whole cells, one at least). */
const FACE_RIM = 1.9;
/** The island's height: its ink hangs from its bottom edge (styles/desk.css .desk-ink), so its grid is counted from there. */
const ISLAND_H = 184;

/**
 * The island's face on the ink's own cells (lib/eyes.ts faceCells on the grid lib/island.ts lays the ink on, `cell` island
 * px, counted from the island's bottom edge): the blob's own eyes dithered, every edge cell and the star's glow decided by
 * the Bayer tile, the pupils' rims ramping from the phase-tinted paper to the phase's tone at their foot, and the lines
 * (lids, arcs) lit in that paper as the island is always dark. Asleep it is the blob's own sleeping lids. `look` carries
 * the face (island px; it snaps to the cells, `hold` keeping its cell as it hovers). `pair` is the app's, one glyph per eye.
 */
export function islandFace(pair: string, pose: FacePose = REST, cell = 1.5, look: readonly [number, number] = [0, 0], hold?: FaceHold): FaceCells {
  const grid = { cell, x: 0, y: ISLAND_H - Math.ceil(ISLAND_H / cell) * cell };
  return faceCells(pair, FACE_X + look[0], FACE_Y + look[1], FACE_R, pose, grid, { rim: FACE_RIM, lit: true, ramp: true, hold });
}

/**
 * The face's tones as ImageData pixels (little-endian ABGR): the rim's foot (the phase's tone), the rim's tinted paper,
 * the island's ink, the star's glow on it, the catchlights' paper.
 */
export interface FaceTones {
  readonly foot: number;
  readonly rim: number;
  readonly ink: number;
  readonly glow: number;
  readonly light: number;
}

/**
 * The face drawn into the island's ink canvas itself, so it is one picture with the ink, cell for cell and crisp the same
 * way (one buffer pixel a cell, pixelated): the ink as lib/island.ts last drew it is kept (`take`, once per scale, copied
 * from the ink's own buffer, never read back from the canvas), each face is written over it and the cells the last one
 * covered are given back, and only the cells either covers are put.
 */
export class InkFace {
  private g: CanvasRenderingContext2D | null = null;
  private img: ImageData | null = null;
  private px: Uint32Array | null = null;
  private base: Uint32Array | null = null;
  private box: readonly [number, number, number, number] = [0, 0, 0, 0];

  /** The ink as it was just drawn (its buffers kept across scales, made again only when its size changes). */
  take(canvas: HTMLCanvasElement): void {
    const g = canvas.getContext("2d");
    const ink = inkPixels(canvas);
    const n = canvas.width;
    const m = canvas.height;
    if (!g || !ink || !n || !m || ink.length !== n * m) return;
    if (!this.img || this.img.width !== n || this.img.height !== m || !this.px || !this.base) {
      this.img = g.createImageData(n, m);
      this.px = new Uint32Array(this.img.data.buffer);
      this.base = new Uint32Array(n * m);
    }
    this.g = g;
    this.base.set(ink);
    this.px.set(ink);
    this.box = [0, 0, 0, 0];
  }

  paint(f: FaceCells, tones: FaceTones): void {
    const { g, img, px, base } = this;
    if (!g || !img || !px || !base) return;
    const n = img.width;
    const m = img.height;
    const [ox, oy, ow, oh] = this.box;
    for (let y = Math.max(0, oy); y < Math.min(m, oy + oh); y++) {
      const a = y * n + Math.max(0, ox);
      const b = y * n + Math.min(n, ox + ow);
      if (b > a) px.set(base.subarray(a, b), a);
    }
    for (let j = 0; j < f.h; j++) {
      const y = f.row + j;
      if (y < 0 || y >= m) continue;
      for (let i = 0; i < f.w; i++) {
        const x = f.col + i;
        const t = f.tone[j * f.w + i];
        if (!t || x < 0 || x >= n) continue;
        px[y * n + x] = t === TONE.light ? tones.light : t === TONE.glow ? tones.glow : t === TONE.ink ? tones.ink : t === TONE.rim ? tones.rim : tones.foot;
      }
    }
    const x0 = Math.max(0, Math.min(ox, f.col));
    const y0 = Math.max(0, Math.min(oy, f.row));
    const x1 = Math.min(n, Math.max(ox + ow, f.col + f.w));
    const y1 = Math.min(m, Math.max(oy + oh, f.row + f.h));
    this.box = [f.col, f.row, f.w, f.h];
    if (x1 > x0 && y1 > y0) g.putImageData(img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }
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
 * asleep is the app's island (the blob's sleeping lids, its words as the hero, set calm, `☾ asleep · next Alarm 07:10`
 * in the foot), the alarm rings over it. Every control and tile icon is Phosphor Fill (components/icons), the site's one
 * family. A drawing of the app, so aria-hidden: the menu bar names its state in words.
 */
export function Island({ kind, swap, refs, show }: IslandProps): ReactElement {
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
        {/* the face's anchor point (57, 40): the face itself is drawn into the ink (InkFace) */}
        <div ref={refs.eyes} className="desk-eyes" />
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
