"use client";
import { animate } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { ISLAND_FACE, InkFace, Island, islandFace, type FaceTones, type IslandRefs } from "@/components/desk/Island";
import { ISLAND } from "@/content/island";
import { BAYER8, cellCss, mix3, parseColor, watchDpr, type RGB } from "@/lib/dither";
import { FaceHold, HOLD, TWINKLE, asleepPair, flareSize, popSize, type FacePose } from "@/lib/eyes";
import { renderIslandInk, renderLevelTrace, renderSweep } from "@/lib/island";
import { getLive, glintTurn, resolveShow, setLive, subscribeLive, type Show } from "@/lib/live";
import { SPRING, useCalm } from "@/lib/motion";
import type { DeskKind } from "@/lib/phase";
import { cssVar, subscribeTheme } from "@/lib/theme";
import { MenuBar } from "./MenuBar";
import { SECTION_KIND } from "./sections";

const SWAP_MS = 160; // --jh-quick
const ISL_H = 184;

/**
 * The faces that blink, as the app's do (BlobField.swift renderEyes `blinkable`): listening and acting. Asleep the lids are
 * shut already, thinking's are low, a ring opens them wide.
 */
const BLINKS = new Set<DeskKind>(["listening", "acting"]);
/**
 * A blink: the open eyes squash shut and back (lib/eyes.ts's lids), shut at 45 % of BLINK_MS, drawn frame by frame on the
 * cells and read from the clock, so a late frame never leaves them shut.
 */
const BLINK_MS = 140;
function blinkLid(ms: number): number {
  const u = ms / BLINK_MS;
  if (!(u > 0 && u < 1)) return 1;
  const e = (x: number): number => x * x * (3 - 2 * x);
  return u < 0.45 ? 1 - 0.88 * e(u / 0.45) : 0.12 + 0.88 * e((u - 0.45) / 0.55);
}
/** A face that can glint (catchlights, or the happy sparkle that pulses), and one with open eyes. */
const GLINTS = /[Oo^]/;
const OPEN = /[Oo]/;
/**
 * Thinking, as the app's face thinks: it looks up and away (the look the pointer otherwise gives, ±8 / ±5 island px, held
 * at the app's -0.7, -0.75) and its lowered lids churn to `~ ~` for one beat in three of THINK_BEAT seconds.
 */
const THINK_LOOK: readonly [number, number] = [-5.6, -3.8];
const THINK_BEAT = 1.7;
function thinkingPair(t: number): string {
  return Math.floor(t / THINK_BEAT) % 3 === 2 ? "~ ~" : ISLAND_FACE.thinking;
}
/** The face a kind wears at `t` s: asleep the lids turn wavy at the top of a breath (as the blob's), thinking churns. */
function kindPair(kind: DeskKind, t: number): string {
  return kind === "thinking" ? thinkingPair(t) : kind === "asleep" ? asleepPair(t, " ") : ISLAND_FACE[kind];
}
/** How fast the look follows the pointer (s): the face is carried cell by cell, eased. */
const LOOK_TAU = 0.06;
/**
 * The face's tones from the kind's tone, eased over --jh-drift to a new kind's: the rim the paper with RIM_TONE of it
 * (--desk-eye-ink), its foot FOOT_TONE of it, the star's glow the ink lit GLOW_TONE of the way to it.
 */
const RIM_TONE = 0.15;
const FOOT_TONE = 0.65;
const GLOW_TONE = 0.5;
const DRIFT_MS = 600;
/** The face's tones (FaceTones) for a kind's tone over the theme's paper and the island's ink. */
function faceTones(tone: RGB, paper: RGB, ink: RGB): FaceTones {
  return { foot: pixel(mix3(paper, tone, FOOT_TONE)), rim: pixel(mix3(paper, tone, RIM_TONE)), ink: pixel(ink), glow: pixel(mix3(ink, tone, GLOW_TONE)), light: pixel(paper) };
}
/** A cheap key for a face as drawn: its box, its tones and its cells (FNV-1a), so an unchanged frame is never put. */
function faceKey(col: number, row: number, cells: Uint8Array, tones: FaceTones): number {
  let h = 2166136261;
  const mixIn = (v: number): void => {
    h = Math.imul(h ^ (v & 0xffff), 16777619);
    h = Math.imul(h ^ (v >>> 16), 16777619);
  };
  mixIn(col + 32768);
  mixIn(row + 32768);
  mixIn(cells.length);
  mixIn(tones.foot);
  mixIn(tones.rim);
  mixIn(tones.glow);
  mixIn(tones.light);
  for (let i = 0; i < cells.length; i++) h = Math.imul(h ^ cells[i]!, 16777619);
  return h >>> 0;
}
/** An opaque colour as an ImageData pixel (little-endian ABGR). */
function pixel(c: RGB): number {
  return ((255 << 24) | ((Math.round(c[2]) & 255) << 16) | ((Math.round(c[1]) & 255) << 8) | (Math.round(c[0]) & 255)) >>> 0;
}
/** The island's sparkle in ms (lib/eyes.ts TWINKLE): a flare's life with its second eye's lag, the happy sparkle's pop. */
const FLARE_MS = (TWINKLE.flare + TWINKLE.lag) * 1000;
const POP_MS = TWINKLE.pop * 1000;
/**
 * The island's phase tone (--desk-phase): the eyes' tint, the Go ring and the bar's dot, and nothing else; the orb's own
 * blue while thinking (no violet in anything orb-like). While the alarm rings the app stays asleep and keeps the asleep
 * tone (NotchPanel.swift: the ring's Go and the eyes take the sim's colour), so the alarm's amber is the head's glyph
 * alone. No edge of the island carries a coloured line and no instrument is tinted: they are the paper alone.
 */
const ISLAND_TONE: Record<DeskKind, `--jh-${string}`> = {
  listening: "--jh-listening",
  thinking: "--jh-accent",
  acting: "--jh-acting",
  speaking: "--jh-speaking",
  asleep: "--jh-asleep",
  alarm: "--jh-asleep",
};

/** The trace's height at most (island px): a voice's peaks, never a wall of bars over the line it hears. */
const TRACE_H = 40;
/** The trace's history: the last levels (newest last), one per tick, as many as the widest trace can show. */
const TRACE_N = 200;
/**
 * A level as a voice makes it: syllables in phrases with breaths between them, a little grain. A breath is 0, silence, and
 * the trace draws its dotted rule there (lib/island.ts SILENCE).
 */
function voiceLevel(t: number, grain: number): number {
  const phrase = Math.max(0, Math.sin(t * 1.15 + Math.sin(t * 0.41) * 1.6));
  const syllable = 0.4 + 0.6 * Math.abs(Math.sin(t * 6.3 + Math.sin(t * 2.1) * 1.4));
  return Math.min(1, phrase ** 0.6 * syllable * (0.72 + 0.28 * grain));
}
/** One crossing of the working sweep, in seconds (there and back is two), and its strip's length (island px). */
const SWEEP_S = 1.6;
const SWEEP_W = 96;
/**
 * The island's dither cell in island px: the app's 1.5 pt, so the grain is the same share of the island at every scale,
 * whole device pixels on screen (never under one).
 */
function islandCell(scale: number): number {
  return cellCss(1.5 * scale) / scale;
}
/** The still trace (calm, and the first frame): the same voice sampled at the tick rate, with a fixed grain. */
function stillTrace(): Float32Array {
  const a = new Float32Array(TRACE_N);
  for (let i = 0; i < TRACE_N; i++) a[i] = voiceLevel(2 + i / 8, 0.5 + 0.5 * Math.sin(i * 12.9898));
  return a;
}

/**
 * The bar's items yield to the band (styles/site.css .top-band) at its widest, the hero scale, so nothing ever runs under
 * the island and nothing pops in or out as it docks: the menus drop whole from the last, then the right side's least needed
 * items (the clock, the phase word and GitHub's word to the screen reader only, the star count likewise). A dropped item
 * wears data-off: hidden, out of the tab order, or read only by a screen reader where it names something. No item shrinks
 * (styles/site.css), so an overflow shows as the right cluster's first item crossing the band's edge, never as a squeezed
 * control. The bar wears data-fit once fitted: until then its menus and right side are hidden, so no first paint shows a
 * cut word or a squeezed control and the fit never shifts anything a visitor saw.
 */
function fitBar(bar: HTMLElement, hero: number): void {
  for (const el of bar.querySelectorAll<HTMLElement>("[data-off]")) delete el.dataset["off"];
  bar.dataset["fit"] = "";
  // at 580 px and under the bar is the band itself and the island hangs under it: nothing to yield (styles/site.css)
  if (window.matchMedia("(max-width: 580px)").matches) return;
  const r = bar.getBoundingClientRect();
  if (!r.width) return;
  const ear = parseFloat(getComputedStyle(bar).getPropertyValue("--ear")) || 10;
  const half = 210 * hero + ear + 6;
  const leftEdge = r.left + r.width / 2 - half;
  const rightEdge = r.left + r.width / 2 + half;
  const menus = [...bar.querySelectorAll<HTMLElement>(".bar-menus a")];
  for (let i = menus.length - 1; i >= 0; i--) {
    const m = menus[i];
    if (!m || !m.offsetWidth) continue;
    if (m.getBoundingClientRect().right <= leftEdge) break;
    m.dataset["off"] = "";
  }
  const right = bar.querySelector<HTMLElement>(".bar-r");
  if (!right) return;
  const first = (): number => {
    for (const c of right.children) {
      const b = c.getBoundingClientRect();
      if (b.width > 1) return b.left;
    }
    return Infinity;
  };
  for (const sel of [".bar-clock", ".bar-phase", ".bar-gh-word", ".bar-gh .stars"]) {
    if (first() >= rightEdge - 0.5) break;
    const el = right.querySelector<HTMLElement>(sel);
    if (el) el.dataset["off"] = "";
  }
}

/**
 * The dissolve under the bar once the island has docked: the page's ground solid down past the island's foot, then an
 * 8×8 Bayer dissolve to nothing in one-device-pixel cells. At that grain the dither reads as a fade: words and the ink
 * plates thin out before they reach the island, and none of them breaks into a checkerboard.
 */
function paintFade(cv: HTMLCanvasElement, foot: number): void {
  const box = cv.parentElement;
  if (!box) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  const solid = foot + 4;
  const cell = 1 / (window.devicePixelRatio || 1);
  const nx = Math.max(1, Math.ceil(w / cell));
  const ny = Math.max(1, Math.ceil(h / cell));
  cv.width = nx;
  cv.height = ny;
  cv.style.width = `${nx * cell}px`;
  cv.style.height = `${ny * cell}px`;
  const g = cv.getContext("2d");
  if (!g) return;
  const c = parseColor(cssVar("--jh-ground"));
  const on = ((255 << 24) | (Math.round(c[2]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[0])) >>> 0;
  const img = g.createImageData(nx, ny);
  const px = new Uint32Array(img.data.buffer);
  const fade = Math.max(1, h - solid);
  for (let y = 0; y < ny; y++) {
    const yc = (y + 0.5) * cell;
    const u = yc <= solid ? 1 : 1 - (yc - solid) / fade;
    const row = (y & 7) * 8;
    for (let x = 0; x < nx; x++) px[y * nx + x] = (BAYER8[row + (x & 7)] ?? 1) < u ? on : 0;
  }
  g.putImageData(img, 0, 0);
}

/**
 * The sticky top: the Mac's menu bar edge to edge, and the island grown out of the notch over it, as a notch app opens it:
 * one black silhouette from the page's top edge (the band, the notch widened to the island's width with small concave
 * ears where it meets the edge) down into the island's body, fixed over the page at every scroll position and never
 * folded. Band and body are drawn in one scaled box, so they are one width at every scale (styles/site.css .top-band);
 * the bar's items yield to the band at its widest (fitBar), and on a phone the bar itself is the band. Over the hero the
 * body hangs at the hero scale; as the page scrolls its foot travels up with the page until it docks at the compact
 * scale, and the dissolve shows under the bar. It wears what the visitor is doing (lib/live.ts resolveShow): the hero
 * blob's claim over the hero, then the claim of the demo in view (its kind, its line, its question, its tiles, the
 * foot's figures), or that section's own kind. A new kind fades the content out over --jh-quick and lands with the body
 * settling on the spring out of the band. Its ink is still (one image per scale, every kind's); its trace and sweep
 * tick, its face (drawn on the ink's own cells) blinks and is carried by the pointer (thinking looks up and away), at 8
 * fps while the tab is visible; its sparkle breathes with them and the blink, the look, a flare and a pop run on frames of
 * their own. Calm (reduced motion, `#still`): one pose per change (the
 * sparkle at rest) and a stepped scale.
 */
export function Top({ stars }: { readonly stars: number | null }): ReactElement {
  const still = useCalm();
  const [kind, setKind] = useState<DeskKind>("asleep");
  const [view, setView] = useState<Show>({ kind: "asleep" });
  const [swap, setSwap] = useState(false);
  const top = useRef<HTMLElement>(null);
  const scaleBox = useRef<HTMLDivElement>(null);
  const fade = useRef<HTMLCanvasElement>(null);
  const probeHero = useRef<HTMLElement>(null);
  const probeDock = useRef<HTMLElement>(null);
  const refs = useMemo<IslandRefs>(
    () => ({
      ink: { current: null },
      trace: { current: null },
      sweep: { current: null },
      clock: { current: null },
      tiles: { current: null },
      eyes: { current: null },
    }),
    [],
  );
  const tl = useRef({
    raf: 0,
    running: false,
    swapT: 0,
    want: { kind: "asleep" } as Show,
    since: 0,
    inkScale: 0,
    /** The cell the ink was last drawn in (island px): the face is drawn on that grid, the buffer it is written into. */
    inkCell: 0,
    /** The scale the instruments were last drawn at (they repaint whenever it is not the scale's, C8). */
    meterScale: 0,
    blinkAt: 0,
    blinkUntil: 0,
    /** When the blink drawing now started (performance.now ms). */
    blinkFrom: -1e9,
    /**
     * The sparkle: the breath (the 8 fps loop's), the flare playing (its start and first eye), when the next is due, when
     * the happy sparkle popped, the frames they run on (rAF, so the loop never steps them), the pose setEyes last drew and
     * the kind's own pair as the kind effect last set it.
     */
    breath: 0.5,
    flareAt: -1e9,
    flareLead: 1 as -1 | 1,
    flareNext: 0,
    popAt: -1e9,
    sparkRaf: 0,
    /** The last frame the face's own frames drew (ms), for the look's easing. */
    faceAt: 0,
    pair: ISLAND_FACE.asleep,
    kindPair: ISLAND_FACE.asleep,
    /** The kind the kind effect last saw (asleep's pair is thinking's, so leaving thinking is told by the kind). */
    kindWas: "asleep" as DeskKind,
    shown: "asleep" as DeskKind,
    kind: "asleep" as DeskKind,
    docked: false,
    scale: 1,
    s0: 1,
    s1: 0.62,
    pointerNear: false,
    /** The look: where the face is carried (island px) and how far it is turned, as drawn and as wanted. */
    look: [0, 0] as [number, number],
    lookTo: [0, 0] as [number, number],
    turn: 0,
    turnTo: 0,
    /** The turn as drawn, in tenths, held until the look is HOLD of a tenth past it (a fast sweep steps it once). */
    turnQ: 0,
    face: -1,
    /** The face drawn into the ink (Island.tsx InkFace), the cell it keeps, and its tone: from, to, since (ms). */
    ink: new InkFace(),
    hold: new FaceHold(),
    toneFrom: null as RGB | null,
    toneTo: null as RGB | null,
    toneAt: -1e9,
    /** The tokens the tones are mixed from (read once per theme) and the tones at rest for `toneTo`. */
    eyePaper: null as RGB | null,
    eyeInk: null as RGB | null,
    tones: null as FaceTones | null,
    paper: null as RGB | null,
    levels: stillTrace(),
    /** Where the working sweep's lit run is along its strip (0 at the left end … 1 at the right; calm holds it in the middle). */
    sweep: 0.5,
  });
  // The instruments' one colour: the paper, read once per theme.
  const paper = useCallback((): RGB => {
    const s = tl.current;
    if (!s.paper) s.paper = parseColor(cssVar("--jh-paper"));
    return s.paper;
  }, []);
  const style = { "--desk-phase": `var(${ISLAND_TONE[kind]})` } as CSSProperties;

  // A new kind lands: the content that faded out comes back as the new kind's, and the body settles on the spring out
  // of the band (its height, from its top edge under the band), so the silhouette never leaves the notch. The ink and the
  // foot are anchored to the body's bottom (styles/desk.css), so the spring eats into the black poured under the band,
  // never into the contour or the foot's words.
  const commit = useCallback((next: Show, calm: boolean) => {
    const s = tl.current;
    const changed = s.shown !== next.kind;
    s.shown = next.kind;
    setView(next);
    setSwap(false);
    // Its height, never its width or a scale: the band above it is the body's width, so the silhouette stays one shape.
    if (changed && !calm) {
      const isl = scaleBox.current?.querySelector<HTMLElement>(".desk-island");
      if (isl) void animate(isl, { height: [`${ISL_H - 8}px`, `${ISL_H}px`] }, SPRING);
    }
  }, []);

  // What the island wears: resolved from the live state on every change (a section crossing, a demo's step, the hero
  // blob). The same kind updates in place; a new kind fades the content out over --jh-quick, then lands.
  useEffect(() => {
    const s = tl.current;
    const follow = () => {
      const next = resolveShow(getLive(), SECTION_KIND);
      s.want = next;
      if (next.kind !== s.kind) {
        s.kind = next.kind;
        s.since = performance.now();
        setKind(next.kind);
        setLive({ kind: next.kind });
      }
      if (next.kind === s.shown) {
        if (s.swapT) {
          window.clearTimeout(s.swapT);
          s.swapT = 0;
        }
        setSwap(false);
        setView(next);
        return;
      }
      if (still) return commit(next, true);
      if (s.swapT) return;
      setSwap(true);
      s.swapT = window.setTimeout(() => {
        s.swapT = 0;
        commit(s.want, false);
      }, SWAP_MS);
    };
    follow();
    const off = subscribeLive(follow);
    return () => {
      off();
      if (s.swapT) window.clearTimeout(s.swapT);
      s.swapT = 0;
    };
  }, [commit, still]);

  // The island's eyes: the kind's own face (lib/eyes.ts on the ink's own cells), carried and turned by the look, drawn
  // into the ink canvas itself (no re-render per frame) and only when its cells or its tint change. `live`: a face with
  // catchlights or the happy sparkle breathes, flares and pops and a blink is drawn; without it, as under calm, it rests
  // whole.
  const setEyes = useCallback(
    (pair: string, live = false) => {
      const s = tl.current;
      s.pair = pair;
      if (!refs.ink.current) return;
      const now = performance.now();
      // the turn in tenths, so a slow look re-draws the narrowing eye only as it steps, and a fast one steps it once
      if (Math.abs(s.turn * 10 - s.turnQ * 10) > HOLD) s.turnQ = Math.round(s.turn * 10) / 10;
      let pose: FacePose = { open: live ? blinkLid(now - s.blinkFrom) : 1, sparkle: 0, turn: s.turnQ };
      if (live && GLINTS.test(pair)) {
        const u = (now - s.flareAt) / (TWINKLE.flare * 1000);
        const v = u - TWINKLE.lag / TWINKLE.flare;
        const flare = (s.flareLead < 0 ? [u, v] : [v, u]) as [number, number];
        const spark = popSize((now - s.popAt) / POP_MS) * (1 + 0.4 * flareSize(u));
        pose = { ...pose, twinkle: s.breath, flare, spark };
      }
      // on the ink's own cells as it was last drawn (a new device pixel ratio repaints the ink first)
      const f = islandFace(pair, pose, s.inkCell || islandCell(s.inkScale || s.scale || 1), s.look, s.hold);
      // the tones: read from the tokens once per theme and kind, eased from the last kind's while the drift plays
      if (!s.eyePaper || !s.eyeInk || !s.toneTo) {
        s.eyePaper = parseColor(cssVar("--jh-paper"));
        s.eyeInk = parseColor(cssVar("--jh-desk-notch"));
        s.toneTo = parseColor(cssVar(ISLAND_TONE[s.kind]));
        s.tones = null;
      }
      const k = s.toneFrom ? Math.min(1, Math.max(0, (now - s.toneAt) / DRIFT_MS)) : 1;
      if (k >= 1) s.toneFrom = null;
      let tones = s.tones;
      if (s.toneFrom) tones = faceTones(mix3(s.toneFrom, s.toneTo, live ? k * k * (3 - 2 * k) : 1), s.eyePaper, s.eyeInk);
      else if (!tones) tones = s.tones = faceTones(s.toneTo, s.eyePaper, s.eyeInk);
      const key = faceKey(f.col, f.row, f.tone, tones);
      if (s.face === key) return;
      s.face = key;
      s.ink.paint(f, tones);
    },
    [refs.ink],
  );
  // The face's own frames: while a blink, a flare or a pop plays or the look is on its way, each frame eases the look and
  // draws the pose; the last draws it at rest.
  const animateFace = useCallback(() => {
    const s = tl.current;
    if (s.sparkRaf) return;
    s.faceAt = 0;
    const tick = () => {
      const now = performance.now();
      const dt = s.faceAt ? Math.min(0.05, (now - s.faceAt) / 1000) : 0;
      s.faceAt = now;
      const k = 1 - Math.exp(-dt / LOOK_TAU);
      s.look[0] += (s.lookTo[0] - s.look[0]) * k;
      s.look[1] += (s.lookTo[1] - s.look[1]) * k;
      s.turn += (s.turnTo - s.turn) * k;
      const settled = Math.abs(s.lookTo[0] - s.look[0]) < 0.05 && Math.abs(s.lookTo[1] - s.look[1]) < 0.05 && Math.abs(s.turnTo - s.turn) < 0.01;
      if (settled) {
        s.look = [s.lookTo[0], s.lookTo[1]];
        s.turn = s.turnTo;
      }
      setEyes(s.pair, true);
      const more = !settled || now < s.blinkFrom + BLINK_MS || now < s.flareAt + FLARE_MS || now < s.popAt + POP_MS || now < s.toneAt + DRIFT_MS;
      s.sparkRaf = more ? requestAnimationFrame(tick) : 0;
    };
    s.sparkRaf = requestAnimationFrame(tick);
  }, [setEyes]);
  /** Where the face looks: carried there on its own frames, or at once under calm. */
  const lookAt = useCallback(
    (to: readonly [number, number], turn: number, calm: boolean) => {
      const s = tl.current;
      s.lookTo = [to[0], to[1]];
      s.turnTo = turn;
      if (calm) {
        s.look = [to[0], to[1]];
        s.turn = turn;
        setEyes(s.pair);
      } else animateFace();
    },
    [animateFace, setEyes],
  );

  // The island's ink at the scale it is drawn at, in the app's 1.5 pt cells (1.5 island px, whole device px on screen), so
  // its grain is the same share of the island docked as open. It covers the body to its edges and the body's own rounded
  // clip trims it, so no black frames the ink; once it is down the body's own black goes (data-inked), so the contour
  // antialiases once, ink against the page. It is one still image, the same for every kind (as the app's), so it is
  // painted only when the scale moves.
  const paintInk = useCallback(() => {
    const cv = refs.ink.current;
    if (!cv) return;
    const s = tl.current;
    const sc = s.scale || 1;
    s.inkScale = sc;
    s.inkCell = islandCell(sc);
    renderIslandInk(cv, { width: 420, height: ISL_H, cell: s.inkCell });
    cv.parentElement?.setAttribute("data-inked", "");
    // the face is drawn into the ink: keep the fresh ink under it and draw the face again on the new grid
    s.ink.take(cv);
    s.hold.reset();
    s.face = -1;
    setEyes(s.pair, s.running);
  }, [refs.ink, setEyes]);
  useEffect(() => {
    paintInk();
  }, [paintInk]);

  // The instruments at the scale they are drawn at, in the ink's own cells, all in the paper: the level trace from its
  // history, the working sweep. The head and the foot carry none: nothing bar-shaped rides the island, its figures are words.
  const paintMeters = useCallback(() => {
    const s = tl.current;
    const sc = s.scale || 1;
    s.meterScale = sc;
    const cell = islandCell(sc);
    const on = paper();
    const tr = refs.trace.current;
    if (tr) {
      // Its box: level with the word under the face with nothing heard, else under the heard line, down to the control
      // row's air; a line that leaves it less than 24 island px has the line alone.
      const hero = tr.parentElement?.querySelector<HTMLElement>(".desk-hero");
      const heard = hero?.textContent ? hero.offsetHeight : 0;
      const top = heard ? 30 + heard + 6 : 46;
      const height = Math.min(TRACE_H, 112 - top);
      tr.hidden = height < 24;
      if (!tr.hidden) {
        tr.style.top = `${top}px`;
        renderLevelTrace(tr, { width: 292, height, cell, levels: s.levels, on });
      }
    }
    const sw = refs.sweep.current;
    if (sw) {
      // Under the line it works on, at its left, the swell crossing the short strip and back, always wholly on it; hidden
      // when the line leaves no air.
      const hero = sw.parentElement?.querySelector<HTMLElement>(".desk-hero");
      const top = 30 + (hero?.offsetHeight ?? 22) + 10;
      sw.hidden = top > 104;
      if (!sw.hidden) {
        sw.style.top = `${top}px`;
        renderSweep(sw, { width: SWEEP_W, at: s.sweep, cell, on });
      }
    }
  }, [paper, refs.trace, refs.sweep]);

  // The scale: the hero's (measured from its CSS probe) falling with the scroll to the docked one; calm steps it.
  useEffect(() => {
    const s = tl.current;
    const el = top.current;
    if (!el) return;
    let raf = 0;
    // the probes' exact heights (offsetHeight rounds to whole px), so the script's scale is the CSS one the server painted
    const measure = () => {
      // floored as lib/scale.ts floors its inputs: a probe that reads a sliver (a WebKit's stale or wrong ratio) never
      // draws the island as one
      s.s0 = Math.max(0.3, (probeHero.current?.getBoundingClientRect().height ?? ISL_H) / ISL_H || 1);
      s.s1 = Math.min(s.s0, Math.max(0.3, (probeDock.current?.getBoundingClientRect().height ?? ISL_H * 0.62) / ISL_H || 0.62));
    };
    const apply = () => {
      raf = 0;
      const y = Math.max(0, window.scrollY);
      const travel = ISL_H * (s.s0 - s.s1);
      // the scale as CSS takes it (four places), so the ink's cells are drawn for the scale the island is shown at and land
      // on whole device pixels (an unrounded cell drew the ink a hair off its shown size, 687.97 device px for 688 at the
      // hero's 0.818, so the compositor resampled it)
      const sc = Math.round((still ? (y < travel / 2 ? s.s0 : s.s1) : Math.max(s.s1, s.s0 - y / ISL_H)) * 1e4) / 1e4;
      s.scale = sc;
      el.style.setProperty("--top-s", sc.toFixed(4));
      const docked = sc <= s.s1 + 0.001 && y > 0;
      if (docked !== s.docked) {
        s.docked = docked;
        if (docked) el.dataset["docked"] = "";
        else delete el.dataset["docked"];
      }
      if (Math.abs(sc - s.inkScale) > 0.06 || (docked && sc !== s.inkScale)) paintInk();
      // the instruments follow every step of the scale, so their cells never disagree with the ink's once it rests
      if (Math.abs(sc - s.meterScale) > 0.001) paintMeters();
    };
    const inkFade = () => {
      if (fade.current) paintFade(fade.current, ISL_H * s.s1);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const bar = el.querySelector<HTMLElement>(".bar");
    const fit = () => {
      if (bar) fitBar(bar, s.s0);
    };
    const onResize = () => {
      measure();
      fit();
      inkFade();
      onScroll();
    };
    measure();
    fit();
    void document.fonts?.ready.then(fit);
    apply();
    inkFade();
    // a new device pixel ratio (a browser zoom, another display) redraws the ink, the face on it and the instruments in
    // the new ratio's cells, as lib/blob.ts re-allocs its field
    const offDpr = watchDpr(() => {
      paintInk();
      paintMeters();
      inkFade();
    });
    // An item that changes width after mount (the star count arriving, the phase word) refits the bar, once a frame at
    // most: fitBar clears and reapplies to the same widths, so its own drops settle without a loop.
    let refit = 0;
    const ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            if (!refit)
              refit = requestAnimationFrame(() => {
                refit = 0;
                fit();
              });
          })
        : null;
    if (ro && bar) for (const item of bar.querySelectorAll<HTMLElement>(".bar-r > *, .bar-menus")) ro.observe(item);
    // The scale follows its probes, not only the window's resize: lib/scale.ts also rewrites the inputs on orientationchange
    // and pageshow, which fire no resize here, and a probe can settle after the resize event that moved it. A probe that
    // changes height measures, fits and applies again. (The probes carry no transition, site.css: under reduced motion the
    // global 0.01 ms one lagged them about three frames behind a rotation.)
    const probes =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(() => {
            const h0 = s.s0;
            const h1 = s.s1;
            measure();
            if (s.s0 !== h0 || s.s1 !== h1) onResize();
          })
        : null;
    for (const p of [probeHero.current, probeDock.current]) if (probes && p) probes.observe(p);
    const offTheme = subscribeTheme(() => {
      tl.current.paper = null;
      paintMeters();
      inkFade();
      // the face's tones are the tokens': read again
      const s = tl.current;
      s.toneFrom = null;
      s.toneTo = null;
      s.eyePaper = null;
      s.face = -1;
      setEyes(s.pair, s.running);
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      offTheme();
      offDpr();
      ro?.disconnect();
      probes?.disconnect();
      if (refit) cancelAnimationFrame(refit);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [paintInk, paintMeters, setEyes, still]);

  // The instruments when the shown kind or its line changes.
  useEffect(() => {
    paintMeters();
  }, [view.kind, view.line, paintMeters]);

  useEffect(() => {
    const s = tl.current;
    const was = s.kindPair;
    const wasKind = s.kindWas;
    const pair = ISLAND_FACE[kind];
    s.kindPair = pair;
    s.kindWas = kind;
    // calm rests on the kind's own pair (no loop runs to bring a breath's `~ ~` or thinking's churn back to it)
    s.pair = still ? pair : kindPair(kind, performance.now() / 1000);
    // the face's tone eases from the last kind's to this one's (at once under calm), read from the token once per kind
    const to = parseColor(cssVar(ISLAND_TONE[kind]));
    if (s.toneTo && !still) {
      const k = Math.min(1, Math.max(0, (performance.now() - s.toneAt) / DRIFT_MS));
      s.toneFrom = s.toneFrom ? mix3(s.toneFrom, s.toneTo, k * k * (3 - 2 * k)) : s.toneTo;
      s.toneAt = performance.now();
    } else s.toneFrom = null;
    s.toneTo = to;
    s.tones = null;
    // Thinking looks up and away whatever the pointer does; any other kind is the pointer's again from its next move.
    if (kind === "thinking") lookAt(THINK_LOOK, -0.7, still);
    else if (wasKind === "thinking") {
      s.pointerNear = false;
      lookAt([0, 0], 0, still);
    }
    setEyes(s.pair, !still);
    if (still) return;
    // `^ ^` arrives with its sparkle popping; eyes opening from a closed face catch the light soon after
    if (pair.startsWith("^") && !was.startsWith("^")) {
      // a pop playing is never started over
      if (performance.now() >= s.popAt + POP_MS) s.popAt = performance.now();
      animateFace();
    } else if (OPEN.test(pair) && !OPEN.test(was)) s.flareNext = performance.now() + TWINKLE.wake * 1000;
    if (s.toneFrom) animateFace();
  }, [kind, animateFace, lookAt, setEyes, still]);

  // The pointer carries the island's eyes by ±8 / ±5 px and turns them, cell by cell; away from it (out of reach or out
  // of the window) they ease back to rest centred, and once calm they rest there at once. Thinking keeps its own look (up
  // and away), as the app's face does.
  useEffect(() => {
    if (still) return;
    const away = () => {
      const s = tl.current;
      if (!s.pointerNear || s.kind === "thinking") return;
      s.pointerNear = false;
      lookAt([0, 0], 0, false);
    };
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) away();
    };
    const move = (e: PointerEvent) => {
      const eyes = refs.eyes.current;
      const s = tl.current;
      if (!eyes || s.kind === "thinking") return;
      const r = eyes.getBoundingClientRect();
      const sc = s.scale || 1;
      const x = (e.clientX - r.left) / sc;
      const y = (e.clientY - r.top) / sc;
      const l = Math.hypot(x, y);
      if (l < 900 && l > 1) {
        const m = Math.min(1, l / 160);
        s.pointerNear = true;
        lookAt([(x / l) * m * 8, (y / l) * m * 5], (x / l) * m, false);
      } else away();
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerout", out, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerout", out);
      const s = tl.current;
      s.pointerNear = false;
      if (s.kind !== "thinking") lookAt([0, 0], 0, true);
    };
  }, [refs.eyes, lookAt, still]);

  // The loop: 8 fps for the level trace, the working sweep, Working's clock, thinking's churn and the blink's clock; the
  // ink only if the scale came to rest between its steps. Each tick waits 125 ms, then takes the next frame,
  // so nothing runs between ticks. Calm stops it at rest.
  useEffect(() => {
    if (still) return;
    const s = tl.current;
    let wait = 0;
    const frame = (now: number) => {
      s.raf = 0;
      const t = now / 1000;
      if (s.scale !== s.inkScale) paintInk();
      // The voice's level: the trace keeps its history.
      s.levels.copyWithin(0, 1);
      s.levels[TRACE_N - 1] = voiceLevel(t, Math.random());
      // there and back, eased at each end as a hand slows to turn
      s.sweep = 0.5 - 0.5 * Math.cos((Math.PI * t) / SWEEP_S);
      // the instruments too whenever their scale is another (a rest mid-scale)
      if (refs.trace.current || refs.sweep.current || Math.abs(s.scale - s.meterScale) > 0.001) paintMeters();
      if (s.shown === "thinking" || s.shown === "acting") {
        const sec = ISLAND.clockBase[s.shown] + Math.floor((now - s.since) / 1000);
        const txt = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        const ck = refs.clock.current;
        if (ck && ck.textContent !== txt) {
          ck.textContent = txt;
          refs.tiles.current?.querySelectorAll<HTMLSpanElement>(".t").forEach((el) => {
            el.textContent = txt;
          });
        }
      }
      // A blink every 3 to 6 s, drawn on the face's own frames from the clock, so a slow frame never leaves the eyes shut.
      if (BLINKS.has(s.kind) && now >= s.blinkAt) {
        if (s.blinkAt > 0) {
          s.blinkFrom = now;
          animateFace();
        }
        s.blinkUntil = now + BLINK_MS;
        s.blinkAt = now + 3000 + Math.random() * 3000;
      }
      // The sparkle breathes at the loop's ticks; every 2 to 4.6 s a star flares on its own frames, the eye the face is
      // turned to first (else the other eye from last time), never inside a blink, one playing never cut off, and only
      // when it is the page's turn (lib/live.ts glintTurn). A face that cannot glint just lets the clock move on.
      s.breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / TWINKLE.period);
      const face = kindPair(s.kind, t);
      if (now >= s.flareNext) {
        const busy = now < s.blinkUntil || now < s.flareAt + FLARE_MS + TWINKLE.gap * 1000;
        if (!GLINTS.test(face)) s.flareNext = now + (TWINKLE.rest[0] + Math.random() * TWINKLE.rest[1]) * 1000;
        else if (busy || !glintTurn(now, TWINKLE.page * 1000)) s.flareNext = now + 300 + Math.random() * 500;
        else {
          s.flareAt = now;
          s.flareLead = Math.abs(s.turn) > 0.3 ? (s.turn > 0 ? 1 : -1) : s.flareLead === 1 ? -1 : 1;
          s.flareNext = now + (TWINKLE.rest[0] + Math.random() * TWINKLE.rest[1]) * 1000;
          animateFace();
        }
      }
      setEyes(face, true);
      next();
    };
    const next = () => {
      if (wait || s.raf || !s.running || document.hidden) return;
      wait = window.setTimeout(() => {
        wait = 0;
        if (s.running && !document.hidden) s.raf = requestAnimationFrame(frame);
      }, 125);
    };
    const play = () => {
      if (wait || s.raf || !s.running || document.hidden) return;
      s.raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      window.clearTimeout(wait);
      wait = 0;
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
    s.running = true;
    // the first flare a moment after the loop starts, unless the kind effect asked for a sooner one (eyes opening)
    if (s.flareNext < performance.now()) s.flareNext = performance.now() + 1200 + Math.random() * 1600;
    play();
    const vis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", vis);
    return () => {
      s.running = false;
      document.removeEventListener("visibilitychange", vis);
      pause();
      if (s.sparkRaf) cancelAnimationFrame(s.sparkRaf);
      s.sparkRaf = 0;
      s.flareAt = -1e9;
      s.popAt = -1e9;
      s.blinkFrom = -1e9;
      paintInk();
      setEyes(ISLAND_FACE[s.kind]);
    };
  }, [animateFace, paintInk, paintMeters, refs, setEyes, still]);

  return (
    <header ref={top} className="top desk" style={style} data-still={still ? "" : undefined} data-kind={kind}>
      <div className="top-fade" aria-hidden="true">
        <canvas ref={fade} width={1} height={1} />
      </div>
      <MenuBar stars={stars} />
      <div ref={scaleBox} className="top-scale">
        <i className="top-band" aria-hidden="true" />
        <Island kind={view.kind} swap={swap} refs={refs} show={view} />
      </div>
      <i ref={probeHero} className="top-probe top-probe--hero" aria-hidden="true" />
      <i ref={probeDock} className="top-probe top-probe--dock" aria-hidden="true" />
    </header>
  );
}
