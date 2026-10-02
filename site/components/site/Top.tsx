"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Island, type IslandRefs } from "@/components/desk/Island";
import { ISLAND } from "@/content/island";
import { BAYER8, QUIET_STOPS, cellCss, ditherGlyphs, mix3, parseColor, renderMeter, type RGB } from "@/lib/dither";
import { renderIslandInk } from "@/lib/island";
import { getLive, liveActions, setLive, subscribeLive } from "@/lib/live";
import { DESK_KINDS, type DeskKind } from "@/lib/phase";
import { cssVar, isStill, subscribeTheme } from "@/lib/theme";
import { MenuBar } from "./MenuBar";
import { SECTION_KIND } from "./sections";

/** The timeline (design.md §4.5) over the hero: listening 6 → thinking 3 → acting 6 → speaking 5 → asleep 4 → alarm 5 → listening. Never a fold. */
const SEGS: ReadonlyArray<{ kind: DeskKind; dur: number }> = [
  { kind: "listening", dur: 6 },
  { kind: "thinking", dur: 3 },
  { kind: "acting", dur: 6 },
  { kind: "speaking", dur: 5 },
  { kind: "asleep", dur: 4 },
  { kind: "alarm", dur: 5 },
];
const CYCLE = SEGS.reduce((s, x) => s + x.dur, 0);
/** Docked on Sleep the island plays asleep, then the alarm that still rings, and again. */
const NIGHT = { asleep: 4, alarm: 5 } as const;
const HOLD_MS = 15000;
const SWAP_MS = 160; // --jh-quick
const NOTCH = 185;
const WING = 40;
const ISL_H = 184;

/** The island's face per kind: the round eyes listening, the flat pair thinking and asleep, `o o` acting (the eyes look along the travel), `^ ^` speaking. */
const ISLAND_FACE: Record<DeskKind, string> = { listening: "O O", thinking: "- -", acting: "o o", speaking: "^ ^", asleep: "- -", alarm: "o o" };
const BLINKS = new Set<DeskKind>(["listening", "alarm"]);
/** The island's hairline and the tint in its eyes: the phase tone, but the orb's own blue while thinking (no violet in anything orb-like). */
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

/** The island's meters (NotchPanel.swift drawBar): the screen's fg-2 and active tones over the island ground; the island is a screen in both themes. */
function islandInk(): { fill: RGB; track: RGB } {
  const ground = parseColor(cssVar("--jh-island-ground"));
  return { fill: over("--jh-screen-fg-2", ground), track: over("--jh-screen-active", ground) };
}

function locate(pos: number): { idx: number; local: number } {
  let acc = 0;
  for (let i = 0; i < SEGS.length; i++) {
    const d = SEGS[i]!.dur;
    if (pos < acc + d) return { idx: i, local: pos - acc };
    acc += d;
  }
  return { idx: 0, local: pos };
}

function segStart(kind: DeskKind): number {
  let acc = 0;
  for (const s of SEGS) {
    if (s.kind === kind) return acc;
    acc += s.dur;
  }
  return 0;
}

/**
 * The dissolve under the bar: the page's ground solid down past the docked island's foot, then an 8×8 Bayer dissolve to
 * nothing, in 3 px cells, so content scrolling up thins out in the family's dots before it reaches the island and never
 * shows as slivers beside it. Sized from its CSS box (styles/site.css .top-fade), solid to 4 px past `foot` (the docked
 * island's height as the engine measures it from the dock probe), re-inked on a theme flip.
 */
function paintFade(cv: HTMLCanvasElement, foot: number): void {
  const box = cv.parentElement;
  if (!box) return;
  const w = box.clientWidth;
  const h = box.clientHeight;
  const solid = foot + 4;
  const cell = cellCss(3);
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
 * The sticky top (SCRATCH.md "The top is sticky and always visible"): the Mac's menu bar edge to edge with the notch cut out of
 * it, and the island hanging from the notch with the blob's face in its anchor band, fixed over the page at every scroll
 * position and never folded. Over the hero it hangs at the hero scale; as the page scrolls its foot travels up with the page
 * (the scale falls by the scroll over 184 px) until it docks at the compact scale, so nothing in the hero ever passes under
 * it. Docked, the dissolve shows under the bar and the island wears the kind of the section in view. Over the hero it runs
 * the one timeline the page reads (lib/live.ts): the kinds cycle, Working counts, the meters tick, the ink breathes, the face blinks and turns to the pointer. `#still` and reduced motion give one pose per section
 * and step the scale.
 */
export function Top({ stars }: { readonly stars: number | null }): ReactElement {
  const [still, setStill] = useState(false);
  const [kind, setKind] = useState<DeskKind>("listening");
  const [shown, setShown] = useState<DeskKind>("listening");
  const [swap, setSwap] = useState(false);
  const top = useRef<HTMLElement>(null);
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
      eyeTop: { current: null },
      eyeUnder: { current: null },
    }),
    [],
  );
  const tl = useRef({
    pos: 0,
    last: 0,
    raf: 0,
    hold: 0,
    seg: -1,
    running: false,
    swapAt: 0,
    pending: null as DeskKind | null,
    inkAt: 0,
    inkScale: 0,
    blinkAt: 0,
    blinkUntil: 0,
    shown: "listening" as DeskKind,
    kind: "listening" as DeskKind,
    docked: false,
    spyAt: 0,
    scale: 1,
    s0: 1,
    s1: 0.66,
    pointerNear: false,
    ink: null as { fill: RGB; track: RGB } | null,
  });
  const meterInk = useCallback(() => (tl.current.ink ??= islandInk()), []);
  const style = { "--desk-phase": `var(${ISLAND_TONE[kind]})` } as CSSProperties;

  const applyKind = useCallback((next: DeskKind, now: number) => {
    const s = tl.current;
    if (next === s.kind) return;
    s.kind = next;
    setKind(next);
    setLive({ kind: next });
    if (next !== s.shown) {
      s.pending = next;
      s.swapAt = now + SWAP_MS;
      setSwap(true);
    }
  }, []);

  const commitShown = useCallback((k: DeskKind) => {
    const s = tl.current;
    s.shown = k;
    s.pending = null;
    setShown(k);
    setSwap(false);
  }, []);

  // The island's ink at the scale it is drawn at, so a cell is 1.5 CSS px on screen at any scale (and breathing at 8 fps from the loop).
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
  }, [paintInk, shown]);

  // The scale: the hero's (measured from its CSS probe) falling with the scroll to the docked one; reduced motion steps it.
  useEffect(() => {
    const s = tl.current;
    const el = top.current;
    if (!el) return;
    let raf = 0;
    const stepped = isStill();
    const measure = () => {
      s.s0 = (probeHero.current?.offsetHeight ?? ISL_H) / ISL_H || 1;
      s.s1 = Math.min(s.s0, (probeDock.current?.offsetHeight ?? ISL_H * 0.66) / ISL_H || 0.66);
    };
    const apply = () => {
      raf = 0;
      const y = Math.max(0, window.scrollY);
      const travel = ISL_H * (s.s0 - s.s1);
      const sc = stepped ? (y < travel / 2 ? s.s0 : s.s1) : Math.max(s.s1, s.s0 - y / ISL_H);
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
    const offTheme = subscribeTheme(inkFade);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      offTheme();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [paintInk]);

  // Meters and the still glyphs when the shown kind changes.
  useEffect(() => {
    const { fill, track } = meterInk();
    if (refs.meterHead.current) renderMeter(refs.meterHead.current, { width: 100, height: 6, fraction: 0.68, fill, track });
    if (refs.meterFoot.current) renderMeter(refs.meterFoot.current, { width: 64, height: 6, fraction: 0.84, fill, track });
    if (still && refs.glyphs.current) refs.glyphs.current.textContent = ditherGlyphs(8, 1, 0, true)[0] ?? "";
  }, [shown, still, meterInk, refs.meterHead, refs.meterFoot, refs.glyphs]);

  // The island's eyes: the kind's own face, written straight to the DOM (no re-render per frame).
  const setEyes = useCallback(
    (pair: string) => {
      if (refs.eyeTop.current && refs.eyeTop.current.textContent !== pair) {
        refs.eyeTop.current.textContent = pair;
        if (refs.eyeUnder.current) refs.eyeUnder.current.textContent = pair;
      }
    },
    [refs.eyeTop, refs.eyeUnder],
  );
  useEffect(() => {
    setEyes(ISLAND_FACE[kind]);
  }, [kind, setEyes]);

  // The pointer turns the island's eyes by ±8 / ±5 px; away from it they rest centred.
  const restEyes = useCallback(() => {
    const eyes = refs.eyes.current;
    if (!eyes) return;
    eyes.style.transform = "";
  }, [refs.eyes]);
  useEffect(() => {
    tl.current.pointerNear = false;
    restEyes();
  }, [kind, restEyes]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const eyes = refs.eyes.current;
      if (!eyes) return;
      const r = eyes.getBoundingClientRect();
      const sc = tl.current.scale || 1;
      const x = (e.clientX - r.left) / sc;
      const y = (e.clientY - r.top) / sc;
      const l = Math.hypot(x, y);
      if (l < 900 && l > 1) {
        const m = Math.min(1, l / 160);
        eyes.style.transform = `translate(${((x / l) * m * 8).toFixed(1)}px, ${((y / l) * m * 5).toFixed(1)}px)`;
        tl.current.pointerNear = true;
      } else if (tl.current.pointerNear) {
        tl.current.pointerNear = false;
        restEyes();
      }
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [refs.eyes, restEyes]);

  // The timeline: one rAF, played while the tab is visible.
  useEffect(() => {
    const s = tl.current;
    const stillNow = isStill();
    setStill(stillNow);
    setLive({ still: stillNow });
    if (stillNow) {
      // One pose that still follows the section in view, done once per section change.
      const follow = () => {
        const want = SECTION_KIND[getLive().section];
        const k: DeskKind = want === "asleep" ? "alarm" : (want ?? SEGS[locate(s.pos).idx]!.kind);
        applyKind(k, performance.now());
        if (s.pending) commitShown(s.pending);
      };
      follow();
      return subscribeLive(follow);
    }
    let wantWas: DeskKind | undefined;
    const frame = (now: number) => {
      s.raf = 0;
      const dt = Math.min(0.1, (now - (s.last || now)) / 1000);
      s.last = now;
      let local: number;
      const want = SECTION_KIND[getLive().section];
      if (want) {
        if (want !== wantWas) {
          wantWas = want;
          s.spyAt = now;
        }
        let k: DeskKind = want;
        local = (now - s.spyAt) / 1000;
        if (want === "asleep") {
          const t = local % (NIGHT.asleep + NIGHT.alarm);
          k = t < NIGHT.asleep ? "asleep" : "alarm";
        }
        applyKind(k, now);
        s.seg = -1;
      } else {
        wantWas = undefined;
        const held = now < s.hold;
        const at = locate(s.pos);
        s.pos = held ? Math.min(s.pos + dt, segStart(SEGS[at.idx]!.kind) + SEGS[at.idx]!.dur - 0.001) : (s.pos + dt) % CYCLE;
        const found = locate(s.pos);
        local = found.local;
        if (found.idx !== s.seg) {
          s.seg = found.idx;
          applyKind(SEGS[found.idx]!.kind, now);
        }
      }
      if (s.pending && now >= s.swapAt) commitShown(s.pending);
      // 8 fps: the ink's breath (asleep breathes over 8 s), the head's level trace, the glyph ticker.
      if (now - s.inkAt >= 125) {
        s.inkAt = now;
        const t = now / 1000;
        paintInk(0.5 + 0.5 * Math.sin((2 * Math.PI * t) / (s.shown === "asleep" ? 8 : 4)));
        const gl = refs.glyphs.current;
        if (gl) gl.textContent = ditherGlyphs(8, 1, Math.floor(now / 125) % 8)[0] ?? "";
        const mh = refs.meterHead.current;
        if (mh) {
          const { fill, track } = meterInk();
          renderMeter(mh, { width: 100, height: 6, fraction: 0.55 + 0.2 * Math.sin(t * 3.1) + 0.12 * Math.sin(t * 7.3), fill, track });
        }
      }
      // Working · m:ss counts from the kind's base.
      if (s.shown === "thinking" || s.shown === "acting") {
        const sec = ISLAND.clockBase[s.shown] + Math.floor(local);
        const txt = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        const ck = refs.clock.current;
        if (ck && ck.textContent !== txt) {
          ck.textContent = txt;
          refs.tiles.current?.querySelectorAll<HTMLSpanElement>(".t").forEach((el) => {
            el.textContent = txt;
          });
        }
      }
      // The face: the kind's own, with a 120 ms blink every 3 to 6 s on the round eyes.
      if (BLINKS.has(s.kind)) {
        if (now >= s.blinkAt) {
          s.blinkUntil = now + 120;
          s.blinkAt = now + 3000 + Math.random() * 3000;
        }
        setEyes(now < s.blinkUntil ? "- -" : ISLAND_FACE[s.kind]);
      } else setEyes(ISLAND_FACE[s.kind]);
      if (s.running && !document.hidden) s.raf = requestAnimationFrame(frame);
    };
    const play = () => {
      if (s.raf || !s.running || document.hidden) return;
      s.last = 0;
      s.raf = requestAnimationFrame(frame);
    };
    const pause = () => {
      if (s.raf) cancelAnimationFrame(s.raf);
      s.raf = 0;
    };
    s.running = true;
    play();
    const vis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", vis);
    return () => {
      s.running = false;
      document.removeEventListener("visibilitychange", vis);
      pause();
    };
  }, [applyKind, commitShown, meterInk, paintInk, refs, setEyes]);

  // A press on the hero blob steps the island to the next kind and holds it there for a while.
  const pick = useCallback(
    (k: DeskKind) => {
      const s = tl.current;
      const now = performance.now();
      s.pos = segStart(k);
      s.hold = now + HOLD_MS;
      s.seg = -1;
      if (still) {
        applyKind(k, now);
        if (s.pending) commitShown(s.pending);
      }
    },
    [still, applyKind, commitShown],
  );
  useEffect(() => {
    liveActions.advance = () => {
      const i = DESK_KINDS.indexOf(tl.current.kind);
      pick(DESK_KINDS[(i + 1) % DESK_KINDS.length] ?? "listening");
    };
    return () => {
      liveActions.advance = () => undefined;
    };
  }, [pick]);

  return (
    <header ref={top} className="top desk" style={style} data-still={still ? "" : undefined} data-kind={kind}>
      <div className="top-fade" aria-hidden="true">
        <canvas ref={fade} width={1} height={1} />
      </div>
      <MenuBar stars={stars} />
      <div className="top-scale">
        <Island kind={shown} swap={swap} still={still} refs={refs} />
      </div>
      <i ref={probeHero} className="top-probe top-probe--hero" aria-hidden="true" />
      <i ref={probeDock} className="top-probe top-probe--dock" aria-hidden="true" />
    </header>
  );
}
