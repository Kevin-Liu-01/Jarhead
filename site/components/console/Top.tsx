"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Island, ISLAND, type IslandKind, type IslandRefs, type IslandState } from "@/components/desk/Island";
import { over } from "@/components/kit/Meter";
import { SECTION_KIND } from "@/content/deck";
import { cellCss, ditherGlyphs, parseColor, renderMeter, type RGB } from "@/lib/dither";
import { renderIslandInk } from "@/lib/island";
import { getLive, liveActions, setLive, subscribeLive, useLive, type Beat } from "@/lib/live";
import { DESK_KINDS, PHASE_META, type DeskKind } from "@/lib/phase";
import { cssVar, isStill } from "@/lib/theme";
import { MenuBar } from "./MenuBar";
import { ISLAND_FACE, PhaseControl } from "./PhaseControl";

/** The timeline (design.md §4.5): listening 6 → thinking 3 → acting 6 → speaking 5 → asleep 4 → alarm 5 → wake 1.2 → listening. */
type SegKind = DeskKind | "wake";
const SEGS: ReadonlyArray<{ kind: SegKind; dur: number }> = [
  { kind: "listening", dur: 6 },
  { kind: "thinking", dur: 3 },
  { kind: "acting", dur: 6 },
  { kind: "speaking", dur: 5 },
  { kind: "asleep", dur: 4 },
  { kind: "alarm", dur: 5 },
  { kind: "wake", dur: 1.2 },
];
const CYCLE = SEGS.reduce((s, x) => s + x.dur, 0);
const GATE = 0.8; // the wake beat: `. .` + the pill, then `O O` on the peek
const HOLD_MS = 15000;
const SWAP_MS = 160; // --jh-quick
const NOTCH = 185;
const WING = 40;

/** The island's face per kind (PhaseControl.tsx ISLAND_FACE); the round pairs blink. */
const FACE = ISLAND_FACE;
const BLINKS = new Set<DeskKind>(["listening", "alarm"]);

/**
 * The island's meters (NotchPanel.swift drawBar: white .72 on a white .10 track over the ink): the screen's fg-2 and active
 * tones over the island ground, the kit Meter's recipe on the screen tokens; the island is a screen in both themes.
 */
function islandInk(): { fill: RGB; track: RGB } {
  const ground = parseColor(cssVar("--jh-island-ground"));
  return { fill: over("--jh-screen-fg-2", ground), track: over("--jh-screen-active", ground) };
}

interface View { kind: DeskKind; beat: Beat }

function locate(pos: number): { idx: number; acc: number; local: number } {
  let acc = 0;
  for (let i = 0; i < SEGS.length; i++) {
    const d = SEGS[i]!.dur;
    if (pos < acc + d) return { idx: i, acc, local: pos - acc };
    acc += d;
  }
  return { idx: 0, acc: 0, local: pos };
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
 * The Mac's top edge at the head of the stream (CENTER.md): the menu bar spanning the stream with the notch cut out of it,
 * the island hanging under the notch at 1:1 (420 × 184) while a kind is active with the blob's face in its anchor band and the
 * six phase faces in its foot band, the tucked lip with `- -` and the app's asleep pill while it sleeps, the peek for the wake
 * beat's heard moment. The island scales as one under 436 px of viewport; the bar and the notch stay 1:1. It runs the one
 * rAF timeline the page reads (lib/live.ts): the kinds cycle, the composer's Say box types the utterance (the island's keeps
 * the app's placeholder), Working counts, the meters tick, the ink breathes, the face blinks and turns to the pointer; acting, the target ring sits
 * beside the island and the face looks along the travel. The foot's Segments (PhaseControl.tsx) holds a kind for 15 s; a
 * section in view sets its own. `#still` and reduced motion give one pose.
 */
export function Top(): ReactElement {
  const [still, setStill] = useState(false);
  const [view, setView] = useState<View>({ kind: "listening", beat: "none" });
  const [shown, setShown] = useState<IslandKind>("listening");
  const [swap, setSwap] = useState(false);
  const [pill, setPill] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
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
    beat: "none" as Beat,
    running: false,
    swapAt: 0,
    pending: null as IslandKind | null,
    inkAt: 0,
    typedN: -1,
    delays: [] as number[],
    blinkAt: 0,
    blinkUntil: 0,
    scale: 1,
    shownKind: "listening" as IslandKind,
    view: { kind: "listening", beat: "none" } as View,
    state: "open" as IslandState,
    docked: false,
    spyAt: 0,
    pointerNear: false,
    ink: null as { fill: RGB; track: RGB } | null,
  });
  const meterInk = useCallback(() => (tl.current.ink ??= islandInk()), []);

  // A section in view sets the kind (the left rail measures it); the timeline holds until the hero is back.
  useLive();
  const asleep = view.kind === "asleep";
  const state: IslandState = asleep ? "tucked" : view.beat === "heard" ? "peek" : "open";
  tl.current.state = state;
  const lipFace = view.beat === "gate" ? ". ." : view.beat === "heard" ? "O O" : FACE[view.kind];
  const phaseToken = view.beat === "gate" ? PHASE_META.asleep.token : PHASE_META[view.kind].token;
  const style = { "--desk-phase": `var(${phaseToken})` } as CSSProperties;

  const applyView = useCallback((next: View, now: number) => {
    const s = tl.current;
    s.view = next;
    setView(next);
    setLive({ kind: next.kind, beat: next.beat });
    const nextShown: IslandKind = next.kind === "alarm" ? "alarm" : next.kind === "asleep" || next.kind === "listening" ? "listening" : next.kind;
    setPill(next.beat === "gate");
    if (nextShown !== s.shownKind) {
      s.pending = nextShown;
      s.swapAt = now + SWAP_MS;
      setSwap(true);
    }
  }, []);

  const commitShown = useCallback((k: IslandKind) => {
    const s = tl.current;
    s.shownKind = k;
    s.pending = null;
    s.typedN = -1;
    setShown(k);
    setSwap(false);
  }, []);

  // The island's scale (CSS: 1:1 to 436 px of viewport, then the island shrinks as one under the 1:1 bar), read back for the ink's cell and the eyes.
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const apply = () => {
      tl.current.scale = Math.min(1, Math.max(0.1, el.getBoundingClientRect().width / 420));
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);

  // The island's ink, rendered per state (and breathing at 8 fps from the loop).
  const paintInk = useCallback((breath: number) => {
    const cv = refs.ink.current;
    if (!cv) return;
    const st = tl.current.state;
    if (st === "tucked") return;
    const cell = cellCss(1.5) / (tl.current.scale || 1);
    if (st === "peek") renderIslandInk(cv, { width: 240, height: 26, state: "peek", notchWidth: NOTCH, wing: WING, breath, cell });
    else renderIslandInk(cv, { width: 420, height: 184, state: "open", notchWidth: NOTCH, wing: WING, breath, cell });
  }, [refs.ink]);

  useEffect(() => {
    paintInk(0.5);
  }, [paintInk, state]);

  // Meters and the still glyphs when the shown kind changes.
  useEffect(() => {
    const { fill, track } = meterInk();
    if (refs.meterHead.current) renderMeter(refs.meterHead.current, { width: 100, height: 6, fraction: 0.68, fill, track });
    if (refs.meterFoot.current) renderMeter(refs.meterFoot.current, { width: 64, height: 6, fraction: 0.84, fill, track });
    if (still && refs.glyphs.current) refs.glyphs.current.textContent = ditherGlyphs(8, 1, 0, true)[0] ?? "";
  }, [shown, still, state, meterInk, refs.meterHead, refs.meterFoot, refs.glyphs]);

  // The island's eyes: the kind's own face, written straight to the DOM (no re-render per frame).
  const setEyes = useCallback((pair: string) => {
    if (refs.eyeTop.current && refs.eyeTop.current.textContent !== pair) {
      refs.eyeTop.current.textContent = pair;
      if (refs.eyeUnder.current) refs.eyeUnder.current.textContent = pair;
    }
  }, [refs.eyeTop, refs.eyeUnder]);
  useEffect(() => {
    setEyes(FACE[view.kind]);
  }, [view.kind, setEyes]);

  // The pointer turns the island's eyes by ±8 / ±5 px within 300 px; acting, they rest along the travel to the ring.
  const restEyes = useCallback(() => {
    const eyes = refs.eyes.current;
    if (!eyes) return;
    eyes.style.transform = tl.current.view.kind === "acting" ? "translate(6px, 1px)" : "";
  }, [refs.eyes]);
  useEffect(() => {
    tl.current.pointerNear = false;
    restEyes();
  }, [view.kind, restEyes]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const eyes = refs.eyes.current;
      if (!eyes || tl.current.state !== "open") return;
      const r = eyes.getBoundingClientRect();
      const sc = tl.current.scale || 1;
      const x = (e.clientX - r.left) / sc;
      const y = (e.clientY - r.top) / sc;
      const l = Math.hypot(x, y);
      if (l < 300 && l > 1) {
        const m = Math.min(1, l / 120);
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

  // The timeline: one rAF, created paused, played while the tab is visible.
  useEffect(() => {
    const s = tl.current;
    const stillNow = isStill();
    setStill(stillNow);
    setLive({ still: stillNow });
    if (stillNow) {
      s.typedN = -1;
      const typed = document.querySelector<HTMLElement>("[data-say-typed]");
      if (typed) typed.textContent = ISLAND.utterance;
      document.querySelector<HTMLElement>("[data-say]")?.setAttribute("data-typed", "");
      // One pose that still follows the section in view: the loop's docking below, done once per section change (no
      // frame, and the crossfade is already collapsed under reduced motion); the hero wears the timeline's own kind.
      let section: string | null = null;
      const follow = () => {
        const cur = getLive().section;
        if (cur === section) return;
        section = cur;
        const want = SECTION_KIND[cur];
        s.docked = Boolean(want);
        const held = SEGS[locate(s.pos).idx]!.kind;
        const kind: DeskKind = want ?? (held === "wake" ? "listening" : held);
        if (s.view.kind !== kind || s.view.beat !== "none") applyView({ kind, beat: "none" }, performance.now());
        if (s.pending) commitShown(s.pending);
      };
      follow();
      return subscribeLive(follow);
    }
    const enterListening = () => {
      let t0 = 0.2;
      s.delays = [];
      for (let i = 0; i < ISLAND.utterance.length; i++) {
        t0 += 0.018 + Math.random() * 0.01;
        s.delays.push(t0);
      }
      s.typedN = -1;
    };
    const frame = (now: number) => {
      s.raf = 0;
      const dt = Math.min(0.1, (now - (s.last || now)) / 1000);
      s.last = now;
      let local: number;
      const want = SECTION_KIND[getLive().section];
      if (want) {
        if (!s.docked) {
          s.docked = true;
          s.spyAt = now;
        }
        if (s.view.kind !== want || s.view.beat !== "none") {
          applyView({ kind: want, beat: "none" }, now);
          s.spyAt = now;
          if (want === "listening") enterListening();
        }
        s.seg = -1;
        s.beat = "none";
        local = (now - s.spyAt) / 1000;
      } else {
        if (s.docked) {
          s.docked = false;
          s.seg = -1;
        }
        const held = now < s.hold;
        const at = locate(s.pos);
        s.pos = held ? Math.min(s.pos + dt, at.acc + SEGS[at.idx]!.dur - 0.001) : (s.pos + dt) % CYCLE;
        const found = locate(s.pos);
        local = found.local;
        const seg = SEGS[found.idx]!;
        const beat: Beat = seg.kind === "wake" ? (local < GATE ? "gate" : "heard") : "none";
        if (found.idx !== s.seg || beat !== s.beat) {
          s.seg = found.idx;
          s.beat = beat;
          const kind: DeskKind = seg.kind === "wake" ? (beat === "gate" ? "asleep" : "listening") : seg.kind;
          applyView({ kind, beat }, now);
          if (kind === "listening" && beat === "none") enterListening();
        }
      }
      if (s.pending && now >= s.swapAt) commitShown(s.pending);
      // 8 fps: the ink's breath, the head's level trace, the glyph ticker.
      if (now - s.inkAt >= 125) {
        s.inkAt = now;
        const t = now / 1000;
        if (s.view.kind !== "asleep") paintInk(0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 4));
        const gl = refs.glyphs.current;
        if (gl) gl.textContent = ditherGlyphs(8, 1, Math.floor(now / 125) % 8)[0] ?? "";
        const mh = refs.meterHead.current;
        if (mh) {
          const { fill, track } = meterInk();
          renderMeter(mh, { width: 100, height: 6, fraction: 0.55 + 0.2 * Math.sin(t * 3.1) + 0.12 * Math.sin(t * 7.3), fill, track });
        }
      }
      // The composer's Say box types the utterance from 200 ms at 18–28 ms a character and keeps the last line said until
      // the next one types; the island's box keeps the app's placeholder (notch-island.png).
      if (s.view.kind === "listening" && s.view.beat === "none") {
        let count = 0;
        while (count < s.delays.length && (s.delays[count] ?? 9) <= local) count++;
        if (count !== s.typedN) {
          s.typedN = count;
          const text = ISLAND.utterance.slice(0, count);
          const cpTyped = document.querySelector<HTMLElement>("[data-say-typed]");
          const cpSay = document.querySelector<HTMLElement>("[data-say]");
          if (cpTyped) cpTyped.textContent = text;
          if (cpSay) {
            if (count > 0) cpSay.dataset["typed"] = "";
            else delete cpSay.dataset["typed"];
          }
        }
      }
      // Working · m:ss counts from the kind's base.
      if (s.shownKind === "thinking" || s.shownKind === "acting") {
        const sec = ISLAND.clockBase[s.shownKind] + Math.floor(local);
        const txt = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
        const ck = refs.clock.current;
        if (ck && ck.textContent !== txt) {
          ck.textContent = txt;
          refs.tiles.current?.querySelectorAll<HTMLSpanElement>(".t").forEach((el) => {
            el.textContent = txt;
          });
        }
      }
      // The face: the kind's own, with a 120 ms blink every 3–6 s on the round eyes (BlobField.swift's rule).
      const k = s.view.beat === "none" ? s.view.kind : null;
      if (k && BLINKS.has(k)) {
        if (now >= s.blinkAt) {
          s.blinkUntil = now + 120;
          s.blinkAt = now + 3000 + Math.random() * 3000;
        }
        setEyes(now < s.blinkUntil ? "- -" : FACE[k]);
      } else if (k) setEyes(FACE[k]);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = useCallback((k: DeskKind) => {
    const s = tl.current;
    const now = performance.now();
    s.pos = segStart(k);
    s.hold = now + HOLD_MS;
    s.seg = -1;
    s.docked = false;
    if (still) {
      applyView({ kind: k, beat: "none" }, now);
      s.seg = SEGS.findIndex((x) => x.kind === k);
      if (s.pending) commitShown(s.pending);
    }
  }, [still, applyView, commitShown]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      // Verification hooks (development only): pick a kind.
      (window as unknown as { __jhTop?: unknown }).__jhTop = { pick: (k: DeskKind) => pick(k) };
    }
    liveActions.pick = pick;
    liveActions.advance = () => {
      const i = DESK_KINDS.indexOf(tl.current.view.kind);
      pick(DESK_KINDS[(i + 1) % DESK_KINDS.length] ?? "listening");
    };
    return () => {
      liveActions.pick = () => undefined;
      liveActions.advance = () => undefined;
    };
  }, [pick]);

  useEffect(() => {
    setLive({ open: state === "open" });
  }, [state]);

  return (
    <div className="desk top" style={style} data-still={still ? "" : undefined} data-kind={view.kind} data-island={state}>
      <MenuBar />
      <div ref={holder} className="top-scale">
        <Island kind={shown} state={state} lipFace={lipFace} swap={swap} still={still} pill={pill} asleepPill={asleep && view.beat === "none"} refs={refs} />
        <PhaseControl variant="foot" />
        <div className="top-ring" aria-hidden="true" />
      </div>
    </div>
  );
}
