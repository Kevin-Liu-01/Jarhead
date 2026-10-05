"use client";
import { animate } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Island, islandFace, type IslandRefs } from "@/components/desk/Island";
import { ISLAND } from "@/content/island";
import { BAYER8, QUIET_STOPS, cellCss, ditherGlyphs, mix3, parseColor, renderMeter, type RGB } from "@/lib/dither";
import { TWINKLE, flareSize, popSize, type FacePose } from "@/lib/eyes";
import { renderIslandInk } from "@/lib/island";
import { getLive, glintTurn, resolveShow, setLive, subscribeLive, type Show } from "@/lib/live";
import { SPRING, useCalm } from "@/lib/motion";
import type { DeskKind } from "@/lib/phase";
import { cssVar, subscribeTheme } from "@/lib/theme";
import { MenuBar } from "./MenuBar";
import { SECTION_KIND } from "./sections";

const SWAP_MS = 160; // --jh-quick
const NOTCH = 185;
const WING = 40;
const ISL_H = 184;

/** The island's face per kind: round eyes listening, the flat pair thinking and asleep, `o o` acting and ringing, `^ ^` speaking. */
const ISLAND_FACE: Record<DeskKind, string> = { listening: "O O", thinking: "- -", acting: "o o", speaking: "^ ^", asleep: "- -", alarm: "o o" };
const BLINKS = new Set<DeskKind>(["listening", "alarm"]);
/** A face that can glint (catchlights, or the happy sparkle that pulses), and one with open eyes. */
const GLINTS = /[Oo^]/;
const OPEN = /[Oo]/;
/** The island's sparkle in ms (lib/eyes.ts TWINKLE): a flare's life with its second eye's lag, the happy sparkle's pop. */
const FLARE_MS = (TWINKLE.flare + TWINKLE.lag) * 1000;
const POP_MS = TWINKLE.pop * 1000;
/** The island's hairline and eye tint: the phase tone, but the orb's own blue while thinking (no violet in anything orb-like). */
const ISLAND_TONE: Record<DeskKind, `--jh-${string}`> = {
  listening: "--jh-listening",
  thinking: "--jh-accent",
  acting: "--jh-acting",
  speaking: "--jh-speaking",
  asleep: "--jh-asleep",
  alarm: "--jh-mark",
};

/** An rgba() token composited over a ground, so a meter's flat fills carry the token's alpha. */
function over(token: string, ground: RGB): RGB {
  const raw = cssVar(token);
  const m = /rgba?\([^)]*?,\s*([\d.]+)\s*\)$/i.exec(raw);
  const a = m ? Number(m[1]) : 1;
  return mix3(ground, parseColor(raw), Number.isFinite(a) ? a : 1);
}

/** The island's meters: the screen's fg-2 and active tones over the island ground; the island is a screen in both themes. */
function islandInk(): { fill: RGB; track: RGB } {
  const ground = parseColor(cssVar("--jh-island-ground"));
  return { fill: over("--jh-screen-fg-2", ground), track: over("--jh-screen-active", ground) };
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
 * The sticky top: the Mac's menu bar edge to edge with the notch cut out of it, and the island hanging from the notch,
 * fixed over the page at every scroll position and never folded. Over the hero it hangs at the hero scale; as the page
 * scrolls its foot travels up with the page until it docks at the compact scale, and the dissolve shows under the bar.
 * It wears what the visitor is doing (lib/live.ts resolveShow): the hero blob's claim over the hero, then the claim of the
 * demo in view (its kind, its line, its question, its tiles, the foot, the clock), or that section's own kind. A new kind
 * fades the content out over --jh-quick and lands with the island settling on the spring from its top edge. Its ink
 * breathes, its meters tick, its face blinks and turns to the pointer, at 8 fps while the tab is visible; its sparkle
 * breathes with them and flares and pops on frames of its own. Calm (reduced motion, `#still`): one pose per change (the
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
      meterHead: { current: null },
      meterFoot: { current: null },
      glyphs: { current: null },
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
    pair: "- -",
    lid: 1,
    kindPair: "- -",
    shown: "asleep" as DeskKind,
    kind: "asleep" as DeskKind,
    docked: false,
    scale: 1,
    s0: 1,
    s1: 0.62,
    pointerNear: false,
    turn: 0,
    face: "",
    ink: null as { fill: RGB; track: RGB } | null,
  });
  const meterInk = useCallback(() => (tl.current.ink ??= islandInk()), []);
  const style = { "--desk-phase": `var(${ISLAND_TONE[kind]})` } as CSSProperties;

  // A new kind lands: the content that faded out comes back as the new kind's, and the island settles on the spring,
  // hung from the notch (its transform origin is its top edge, styles/desk.css), so it never leaves the notch.
  const commit = useCallback((next: Show, calm: boolean) => {
    const s = tl.current;
    const changed = s.shown !== next.kind;
    s.shown = next.kind;
    setView(next);
    setSwap(false);
    if (changed && !calm) {
      const isl = scaleBox.current?.querySelector<HTMLElement>(".desk-island");
      if (isl) void animate(isl, { scale: [0.965, 1] }, SPRING);
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

  // The island's ink at the scale it is drawn at, so a cell is 1.5 CSS px on screen at any scale.
  const paintInk = useCallback(
    (breath: number) => {
      const cv = refs.ink.current;
      if (!cv) return;
      const s = tl.current;
      const sc = s.scale || 1;
      s.inkScale = sc;
      renderIslandInk(cv, { width: 420, height: ISL_H, notchWidth: NOTCH, wing: WING, breath, cell: cellCss(1.5) / sc, stops: s.shown === "asleep" ? QUIET_STOPS : undefined });
    },
    [refs.ink],
  );
  useEffect(() => {
    paintInk(0.5);
  }, [paintInk, view.kind]);

  // The scale: the hero's (measured from its CSS probe) falling with the scroll to the docked one; calm steps it.
  useEffect(() => {
    const s = tl.current;
    const el = top.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      s.s0 = (probeHero.current?.offsetHeight ?? ISL_H) / ISL_H || 1;
      s.s1 = Math.min(s.s0, (probeDock.current?.offsetHeight ?? ISL_H * 0.62) / ISL_H || 0.62);
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
      if (Math.abs(sc - s.inkScale) > 0.06 || (docked && sc !== s.inkScale)) paintInk(0.5);
    };
    const inkFade = () => {
      if (fade.current) paintFade(fade.current, ISL_H * s.s1);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onResize = () => {
      measure();
      inkFade();
      onScroll();
    };
    measure();
    apply();
    inkFade();
    const offTheme = subscribeTheme(() => {
      tl.current.ink = null;
      inkFade();
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      offTheme();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [paintInk, still]);

  // Meters and the still glyphs when the shown kind or the claim's meter changes.
  const footMeter = view.meter;
  useEffect(() => {
    const { fill, track } = meterInk();
    if (refs.meterHead.current) renderMeter(refs.meterHead.current, { width: 100, height: 6, fraction: 0.68, fill, track });
    if (refs.meterFoot.current) renderMeter(refs.meterFoot.current, { width: 64, height: 6, fraction: footMeter ?? 0.84, fill, track });
    if (still && refs.glyphs.current) refs.glyphs.current.textContent = ditherGlyphs(8, 1, 0, true)[0] ?? "";
  }, [view.kind, footMeter, still, meterInk, refs.meterHead, refs.meterFoot, refs.glyphs]);

  // The island's eyes: the kind's own face (lib/eyes.ts, as SVG), shut for a blink and turned with the pointer, written
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
    setEyes(pair, 1, !still);
    if (still) return;
    // `^ ^` arrives with its sparkle popping; eyes opening from a closed face catch the light soon after
    if (pair.startsWith("^") && !was.startsWith("^")) {
      // a pop playing is never started over
      if (performance.now() >= s.popAt + POP_MS) s.popAt = performance.now();
      sparkle();
    } else if (OPEN.test(pair) && !OPEN.test(was)) s.flareNext = performance.now() + TWINKLE.wake * 1000;
  }, [kind, setEyes, sparkle, still]);

  // The pointer turns the island's eyes by ±8 / ±5 px; away from it, and once calm, they rest centred.
  useEffect(() => {
    if (still) return;
    const move = (e: PointerEvent) => {
      const eyes = refs.eyes.current;
      if (!eyes) return;
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
      tl.current.turn = 0;
      if (refs.eyes.current) refs.eyes.current.style.transform = "";
    };
  }, [refs.eyes, still]);

  // The loop: 8 fps for the ink's breath, the head's level trace, the glyph ticker, Working's clock and the blink (one
  // tick shut). Each tick waits 125 ms, then takes the next frame, so nothing runs between ticks. Calm stops it at rest.
  useEffect(() => {
    if (still) return;
    const s = tl.current;
    let wait = 0;
    const frame = (now: number) => {
      s.raf = 0;
      const t = now / 1000;
      paintInk(0.5 + 0.5 * Math.sin((2 * Math.PI * t) / (s.shown === "asleep" ? 8 : 4)));
      const gl = refs.glyphs.current;
      if (gl) gl.textContent = ditherGlyphs(8, 1, Math.floor(now / 125) % 8)[0] ?? "";
      const mh = refs.meterHead.current;
      if (mh) {
        const { fill, track } = meterInk();
        renderMeter(mh, { width: 100, height: 6, fraction: 0.55 + 0.2 * Math.sin(t * 3.1) + 0.12 * Math.sin(t * 7.3), fill, track });
      }
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
      if (BLINKS.has(s.kind) && now >= s.blinkAt) {
        s.blinkUntil = now + 120;
        s.blinkAt = now + 3000 + Math.random() * 3000;
      }
      // The sparkle breathes at the loop's ticks; every 2 to 4.6 s a star flares on its own frames, the eye the face is
      // turned to first (else the other eye from last time), never inside a blink, one playing never cut off, and only
      // when it is the page's turn (lib/live.ts glintTurn). A face that cannot glint just lets the clock move on.
      s.breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / TWINKLE.period);
      const face = ISLAND_FACE[s.kind];
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
      setEyes(face, BLINKS.has(s.kind) && now < s.blinkUntil ? 0 : 1, true);
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
      paintInk(0.5);
      setEyes(ISLAND_FACE[s.kind]);
    };
  }, [meterInk, paintInk, refs, setEyes, sparkle, still]);

  return (
    <header ref={top} className="top desk" style={style} data-still={still ? "" : undefined} data-kind={kind}>
      <div className="top-fade" aria-hidden="true">
        <canvas ref={fade} width={1} height={1} />
      </div>
      <MenuBar stars={stars} />
      <div ref={scaleBox} className="top-scale">
        <Island kind={view.kind} swap={swap} still={still} refs={refs} show={view} />
      </div>
      <i ref={probeHero} className="top-probe top-probe--hero" aria-hidden="true" />
      <i ref={probeDock} className="top-probe top-probe--dock" aria-hidden="true" />
    </header>
  );
}
