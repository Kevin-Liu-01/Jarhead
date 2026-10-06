"use client";
import { animate } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { ISLAND_FACE, Island, islandFace, type IslandRefs } from "@/components/desk/Island";
import { ISLAND } from "@/content/island";
import { BAYER8, cellCss, parseColor, type RGB } from "@/lib/dither";
import { TWINKLE, flareSize, popSize, type FacePose } from "@/lib/eyes";
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
 * The faces that blink, as the app's do (BlobField.swift renderEyes `blinkable`): listening and acting. The gate's small
 * eyes asleep hold still, thinking's lids are already low, a ring opens them wide.
 */
const BLINKS = new Set<DeskKind>(["listening", "acting"]);
/** A blink: the open eyes squash shut and back (lib/eyes.ts's blink), run by the compositor so it always ends open. */
const BLINK_MS = 140;
const BLINK: Keyframe[] = [{ transform: "scaleY(1)" }, { transform: "scaleY(0.12)", offset: 0.45 }, { transform: "scaleY(1)" }];
/** A face that can glint (catchlights, or the happy sparkle that pulses), and one with open eyes (the gate's beads rest). */
const GLINTS = /[Oo^]/;
const OPEN = /[Oo]/;
/**
 * Thinking, as the app's face thinks: it looks up and away (the look the pointer otherwise gives, ±8 / ±5 island px, held
 * at the app's -0.7, -0.75) and its lowered lids churn to `~ ~` for one beat in three of THINK_BEAT seconds.
 */
const THINK_LOOK = "translate(-5.6px, -3.8px)";
const THINK_BEAT = 1.7;
function thinkingPair(t: number): string {
  return Math.floor(t / THINK_BEAT) % 3 === 2 ? "~ ~" : ISLAND_FACE.thinking;
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
 * tick, its face blinks (on the compositor) and turns to the pointer (thinking looks up and away), at 8 fps while the
 * tab is visible; its sparkle breathes with them and
 * flares and pops on frames of its own. Calm (reduced motion, `#still`): one pose per change (the
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
      face: { current: null },
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
    /** The scale the instruments were last drawn at (they repaint whenever it is not the scale's, C8). */
    meterScale: 0,
    blinkAt: 0,
    blinkUntil: 0,
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
    pair: ISLAND_FACE.asleep,
    lid: 1,
    kindPair: ISLAND_FACE.asleep,
    shown: "asleep" as DeskKind,
    kind: "asleep" as DeskKind,
    docked: false,
    scale: 1,
    s0: 1,
    s1: 0.62,
    pointerNear: false,
    turn: 0,
    face: "",
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
    renderIslandInk(cv, { width: 420, height: ISL_H, cell: islandCell(sc) });
    cv.parentElement?.setAttribute("data-inked", "");
  }, [refs.ink]);
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
      s.s0 = (probeHero.current?.getBoundingClientRect().height ?? ISL_H) / ISL_H || 1;
      s.s1 = Math.min(s.s0, (probeDock.current?.getBoundingClientRect().height ?? ISL_H * 0.62) / ISL_H || 0.62);
    };
    const apply = () => {
      raf = 0;
      const y = Math.max(0, window.scrollY);
      const travel = ISL_H * (s.s0 - s.s1);
      const sc = still ? (y < travel / 2 ? s.s0 : s.s1) : Math.max(s.s1, s.s0 - y / ISL_H);
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
    const offTheme = subscribeTheme(() => {
      tl.current.paper = null;
      paintMeters();
      inkFade();
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      offTheme();
      ro?.disconnect();
      if (refit) cancelAnimationFrame(refit);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [paintInk, paintMeters, still]);

  // The instruments when the shown kind or its line changes.
  useEffect(() => {
    paintMeters();
  }, [view.kind, view.line, paintMeters]);

  // The island's eyes: the kind's own face (lib/eyes.ts, as SVG), turned with the pointer, written
  // straight to the DOM (no re-render per frame) and only when the pose changes. `live`: a face with catchlights or the
  // happy sparkle breathes, flares and pops (the loop's and the sparkle's frames); without it, as under calm, it rests whole.
  const setEyes = useCallback(
    (pair: string, open = 1, live = false) => {
      const svg = refs.face.current;
      if (!svg) return;
      const s = tl.current;
      s.pair = pair;
      s.lid = open;
      let pose: FacePose = { open, sparkle: 0, turn: s.turn };
      let key = `${pair}|${open}|${s.turn}`;
      if (live && GLINTS.test(pair)) {
        const now = performance.now();
        const u = (now - s.flareAt) / (TWINKLE.flare * 1000);
        const v = u - TWINKLE.lag / TWINKLE.flare;
        const flare = (s.flareLead < 0 ? [u, v] : [v, u]) as [number, number];
        const spark = popSize((now - s.popAt) / POP_MS) * (1 + 0.4 * flareSize(u));
        pose = { ...pose, twinkle: s.breath, flare, spark };
        const at = (w: number) => (w > 0 && w < 1 ? w.toFixed(2) : "-");
        key += `|${s.breath.toFixed(2)}|${at(flare[0])}|${at(flare[1])}|${spark.toFixed(2)}`;
      }
      if (s.face === key) return;
      s.face = key;
      svg.innerHTML = islandFace(pair, pose);
    },
    [refs.face],
  );
  // The sparkle's own frames: while a flare or a pop plays, each frame draws the pose the loop last set with them, and the
  // last draws it at rest.
  const sparkle = useCallback(() => {
    const s = tl.current;
    if (s.sparkRaf) return;
    const tick = () => {
      const now = performance.now();
      setEyes(s.pair, s.lid, true);
      s.sparkRaf = now < s.flareAt + FLARE_MS || now < s.popAt + POP_MS ? requestAnimationFrame(tick) : 0;
    };
    s.sparkRaf = requestAnimationFrame(tick);
  }, [setEyes]);
  useEffect(() => {
    const s = tl.current;
    const was = s.kindPair;
    const pair = ISLAND_FACE[kind];
    s.kindPair = pair;
    // Thinking looks up and away whatever the pointer does; any other kind is the pointer's again from its next move.
    const eyes = refs.eyes.current;
    if (kind === "thinking") {
      s.turn = -0.7;
      if (eyes) eyes.style.transform = THINK_LOOK;
    } else if (was === ISLAND_FACE.thinking) {
      s.turn = 0;
      s.pointerNear = false;
      if (eyes) eyes.style.transform = "";
    }
    setEyes(pair, 1, !still);
    if (still) return;
    // `^ ^` arrives with its sparkle popping; eyes opening from a closed face catch the light soon after
    if (pair.startsWith("^") && !was.startsWith("^")) {
      // a pop playing is never started over
      if (performance.now() >= s.popAt + POP_MS) s.popAt = performance.now();
      sparkle();
    } else if (OPEN.test(pair) && !OPEN.test(was)) s.flareNext = performance.now() + TWINKLE.wake * 1000;
  }, [kind, refs.eyes, setEyes, sparkle, still]);

  // The pointer turns the island's eyes by ±8 / ±5 px; away from it, and once calm, they rest centred. Thinking keeps its
  // own look (up and away), as the app's face does.
  useEffect(() => {
    if (still) return;
    const move = (e: PointerEvent) => {
      const eyes = refs.eyes.current;
      if (!eyes || tl.current.kind === "thinking") return;
      const r = eyes.getBoundingClientRect();
      const sc = tl.current.scale || 1;
      const x = (e.clientX - r.left) / sc;
      const y = (e.clientY - r.top) / sc;
      const l = Math.hypot(x, y);
      const s = tl.current;
      if (l < 900 && l > 1) {
        const m = Math.min(1, l / 160);
        eyes.style.transform = `translate(${((x / l) * m * 8).toFixed(1)}px, ${((y / l) * m * 5).toFixed(1)}px)`;
        s.pointerNear = true;
        s.turn = Math.round((x / l) * m * 10) / 10;
      } else if (s.pointerNear) {
        s.pointerNear = false;
        s.turn = 0;
        eyes.style.transform = "";
      }
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      tl.current.pointerNear = false;
      if (tl.current.kind !== "thinking") {
        tl.current.turn = 0;
        if (refs.eyes.current) refs.eyes.current.style.transform = "";
      }
    };
  }, [refs.eyes, still]);

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
      // A blink every 3 to 6 s: the compositor squashes the open eyes shut and back, so a slow frame never leaves them shut.
      if (BLINKS.has(s.kind) && now >= s.blinkAt) {
        if (s.blinkAt > 0) refs.face.current?.animate(BLINK, { duration: BLINK_MS, easing: "ease-in-out" });
        s.blinkUntil = now + BLINK_MS;
        s.blinkAt = now + 3000 + Math.random() * 3000;
      }
      // The sparkle breathes at the loop's ticks; every 2 to 4.6 s a star flares on its own frames, the eye the face is
      // turned to first (else the other eye from last time), never inside a blink, one playing never cut off, and only
      // when it is the page's turn (lib/live.ts glintTurn). A face that cannot glint just lets the clock move on.
      s.breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / TWINKLE.period);
      const face = s.kind === "thinking" ? thinkingPair(t) : ISLAND_FACE[s.kind];
      if (now >= s.flareNext) {
        const busy = now < s.blinkUntil || now < s.flareAt + FLARE_MS + TWINKLE.gap * 1000;
        if (!GLINTS.test(face)) s.flareNext = now + (TWINKLE.rest[0] + Math.random() * TWINKLE.rest[1]) * 1000;
        else if (busy || !glintTurn(now, TWINKLE.page * 1000)) s.flareNext = now + 300 + Math.random() * 500;
        else {
          s.flareAt = now;
          s.flareLead = Math.abs(s.turn) > 0.3 ? (s.turn > 0 ? 1 : -1) : s.flareLead === 1 ? -1 : 1;
          s.flareNext = now + (TWINKLE.rest[0] + Math.random() * TWINKLE.rest[1]) * 1000;
          sparkle();
        }
      }
      setEyes(face, 1, true);
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
      paintInk();
      setEyes(ISLAND_FACE[s.kind]);
    };
  }, [paintInk, paintMeters, refs, setEyes, sparkle, still]);

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
