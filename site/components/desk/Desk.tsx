"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { DESK_KINDS, PHASE_META, type DeskKind, type Phase } from "@/lib/phase";
import { isStill, useTheme } from "@/lib/theme";
import { ditherGlyphs, renderGround, renderMeter, cellCss, type RGB } from "@/lib/dither";
import { renderIslandInk } from "@/lib/island";
import type { BlobFrame } from "@/lib/blob";
import { MenuBar } from "./MenuBar";
import { Notch } from "./Notch";
import { Island, ISLAND, type IslandKind, type IslandRefs, type IslandState, type LipFace } from "./Island";
import { TargetRing } from "./TargetRing";
import { Blob } from "./Blob";

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
/** The hero stage (critique.md §4.2): 1170 × 560, the island and the blob on the notch axis; the phone stage 460 wide. */
const STAGE = { w: 1170, h: 560, phoneW: 460, phoneH: 440, notch: 185, wing: 40 };
const METER_FILL: RGB = [235, 235, 240];
const METER_TRACK: RGB = [56, 56, 60];

type Beat = "none" | "gate" | "heard";
interface View { kind: DeskKind; beat: Beat }

/** What the hero's controls under the stage read and press (SPACE.md §4 row 3). */
export interface DeskApi {
  readonly kind: DeskKind;
  /** The dot pulses: a live phase on the timeline, not a still. */
  readonly live: boolean;
  readonly still: boolean;
  readonly pick: (k: DeskKind) => void;
}

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

function pairSpaced(p: string): string {
  return `${p[0] ?? "-"} ${p[1] ?? "-"}`;
}

/**
 * The desk (design.md §4, recomposed per SPACE.md §4): the 1170 × 560 stage of Kevin's Mac at 1:1 holding only the
 * menu bar, the notch, the island, the live blob and the target ring; the phone stage under 720 px or when `compact`
 * (the FAITHFUL hero's picture column, MAILROOM.md §1.1: the illustration at the right); and the one rAF
 * timeline that steps the island, the blob and the phase colour through the six kinds. `controls` renders after the
 * stage, outside the scaled layer, with the kind and `pick`, so the hero composes its own phase control under the
 * stage. `#still` and reduced motion give one pose.
 */
export function Desk({ still: stillProp, compact, controls }: { still?: boolean; /** The phone stage (460 wide: the bar, the notch, the island at 1:1, the blob under) regardless of the viewport: the hero's picture column. */ compact?: boolean; controls?: (api: DeskApi) => ReactNode }): ReactElement {
  const theme = useTheme();
  const [still, setStill] = useState(!!stillProp);
  const [view, setView] = useState<View>({ kind: "listening", beat: "none" });
  const [shown, setShown] = useState<IslandKind>("listening");
  const [swap, setSwap] = useState(false);
  const [pill, setPill] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ground = useRef<HTMLCanvasElement>(null);
  const refs = useMemo<IslandRefs>(
    () => ({
      ink: { current: null },
      meterHead: { current: null },
      meterFoot: { current: null },
      glyphs: { current: null },
      clock: { current: null },
      tiles: { current: null },
      typed: { current: null },
      say: { current: null },
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
    visible: true,
    swapAt: 0,
    pending: null as IslandKind | null,
    inkAt: 0,
    glyphAt: 0,
    typedN: -1,
    delays: [] as number[],
    blinkAt: 0,
    blinkUntil: 0,
    blobPair: "O O",
    blobOut: true,
    scale: 1,
    shownKind: "listening" as IslandKind,
    view: { kind: "listening", beat: "none" } as View,
  });

  // Derived pose.
  const islandState: IslandState = view.kind === "asleep" ? "tucked" : view.beat === "heard" ? "peek" : "open";
  const lipFace: LipFace = view.beat === "gate" ? ". ." : view.beat === "heard" ? "O O" : "- -";
  const blobHidden = view.kind === "asleep" || view.kind === "alarm" || view.beat !== "none";
  const blobPhase: Phase = blobHidden ? "asleep" : PHASE_META[view.kind].phase;
  const phaseToken = view.beat === "gate" ? PHASE_META.asleep.token : PHASE_META[view.kind].token;
  const style = { "--desk-phase": `var(${phaseToken})` } as CSSProperties;

  const applyView = useCallback((next: View, now: number) => {
    const s = tl.current;
    s.view = next;
    setView(next);
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

  // The stage's scale (the CSS ladder paints first; JS makes it exact from the container).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      const phone = compact || window.innerWidth < 720;
      const s = phone ? Math.min(1, w / STAGE.phoneW) : w >= STAGE.w - 4 ? 1 : w / STAGE.w; // the rail's own 1 px borders leave 1168: keep 1:1 and clip 2 px of ground
      tl.current.scale = s;
      el.style.setProperty("--desk-s", String(Math.round(s * 10000) / 10000));
      if (phone) el.dataset["phone"] = "";
      else delete el.dataset["phone"];
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener("resize", apply);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [compact]);

  // The desktop ground: GROUND / PAPER, once per size and theme (the phone stage's height follows the scale, so it is measured).
  useEffect(() => {
    const cv = ground.current;
    const el = root.current;
    const st = stage.current;
    if (!cv || !el || !st) return;
    const paint = () => {
      const phone = el.dataset["phone"] !== undefined;
      renderGround(cv, { width: phone ? STAGE.phoneW : STAGE.w, height: phone ? st.clientHeight || STAGE.phoneH : STAGE.h, theme });
    };
    paint();
    const mo = new MutationObserver(paint);
    mo.observe(el, { attributes: true, attributeFilter: ["data-phone"] });
    const ro = new ResizeObserver(paint);
    ro.observe(st);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [theme]);

  // The island's ink, rendered per state (and breathing at 8 fps from the loop).
  const paintInk = useCallback((breath: number) => {
    const cv = refs.ink.current;
    if (!cv) return;
    const state = tl.current.view.kind === "asleep" ? "tucked" : tl.current.view.beat === "heard" ? "peek" : "open";
    if (state === "tucked") return;
    const cell = cellCss(1.5) / (tl.current.scale || 1);
    if (state === "peek") renderIslandInk(cv, { width: 240, height: 26, state: "peek", notchWidth: STAGE.notch, wing: STAGE.wing, breath, cell });
    else renderIslandInk(cv, { width: 420, height: 184, state: "open", notchWidth: STAGE.notch, wing: STAGE.wing, breath, cell });
  }, [refs.ink]);

  useEffect(() => {
    paintInk(0.5);
  }, [paintInk, islandState]);

  // Meters and the still glyphs when the shown kind changes.
  useEffect(() => {
    if (refs.meterHead.current) renderMeter(refs.meterHead.current, { width: 100, height: 6, fraction: 0.68, fill: METER_FILL, track: METER_TRACK });
    if (refs.meterFoot.current) renderMeter(refs.meterFoot.current, { width: 88, height: 6, fraction: 0.84, fill: METER_FILL, track: METER_TRACK });
    if (still && refs.glyphs.current) refs.glyphs.current.textContent = ditherGlyphs(8, 1, 0, true)[0] ?? "";
  }, [shown, still, refs.meterHead, refs.meterFoot, refs.glyphs]);

  // The island's eyes: the blob's pair while it is out; the kind's own face when it is in the notch.
  const setEyes = useCallback((pair: string) => {
    if (refs.eyeTop.current && refs.eyeTop.current.textContent !== pair) {
      refs.eyeTop.current.textContent = pair;
      if (refs.eyeUnder.current) refs.eyeUnder.current.textContent = pair;
    }
  }, [refs.eyeTop, refs.eyeUnder]);
  const onBlobFrame = useCallback((f: BlobFrame) => {
    tl.current.blobPair = pairSpaced(f.pair);
    tl.current.blobOut = !f.hidden;
    if (!f.hidden) setEyes(tl.current.blobPair);
  }, [setEyes]);
  useEffect(() => {
    if (shown === "alarm") setEyes("o o");
    else if (!tl.current.blobOut) setEyes(shown === "listening" ? "O O" : PHASE_META[shown].face);
  }, [shown, setEyes]);

  // The pointer turns the island's eyes by ±8 / ±5 px within 300 px.
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const move = (e: PointerEvent) => {
      const eyes = refs.eyes.current;
      if (!eyes || tl.current.view.kind === "asleep") return;
      const r = eyes.getBoundingClientRect();
      const sc = tl.current.scale || 1;
      const x = (e.clientX - r.left) / sc;
      const y = (e.clientY - r.top) / sc;
      const l = Math.hypot(x, y);
      if (l < 300 && l > 1) {
        const m = Math.min(1, l / 120);
        eyes.style.transform = `translate(${((x / l) * m * 8).toFixed(1)}px, ${((y / l) * m * 5).toFixed(1)}px)`;
      }
    };
    const leave = () => {
      if (refs.eyes.current) refs.eyes.current.style.transform = "";
    };
    st.addEventListener("pointermove", move);
    st.addEventListener("pointerleave", leave);
    return () => {
      st.removeEventListener("pointermove", move);
      st.removeEventListener("pointerleave", leave);
    };
  }, [refs.eyes]);

  // The timeline: one rAF, created paused, played by an IntersectionObserver, paused on a hidden tab.
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const s = tl.current;
    const stillNow = stillProp || isStill();
    setStill(stillNow);
    if (stillNow) {
      s.typedN = -1;
      return;
    }
    const frame = (now: number) => {
      s.raf = 0;
      const dt = Math.min(0.1, (now - (s.last || now)) / 1000);
      s.last = now;
      // A held kind (a segment press) keeps its own clock running to the segment's end, so the Say box types and Working counts.
      const held = now < s.hold;
      const at = locate(s.pos);
      s.pos = held ? Math.min(s.pos + dt, at.acc + SEGS[at.idx]!.dur - 0.001) : (s.pos + dt) % CYCLE;
      const { idx, local } = locate(s.pos);
      const seg = SEGS[idx]!;
      const beat: Beat = seg.kind === "wake" ? (local < GATE ? "gate" : "heard") : "none";
      if (idx !== s.seg || beat !== s.beat) {
        s.seg = idx;
        s.beat = beat;
        const kind: DeskKind = seg.kind === "wake" ? (beat === "gate" ? "asleep" : "listening") : seg.kind;
        applyView({ kind, beat }, now);
        if (kind === "listening" && beat === "none") {
          let at = 0.2;
          s.delays = [];
          for (let i = 0; i < ISLAND.utterance.length; i++) {
            at += 0.018 + Math.random() * 0.01;
            s.delays.push(at);
          }
          s.typedN = -1;
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
        if (mh) renderMeter(mh, { width: 100, height: 6, fraction: 0.55 + 0.2 * Math.sin(t * 3.1) + 0.12 * Math.sin(t * 7.3), fill: METER_FILL, track: METER_TRACK });
      }
      // The Say box types the utterance from 200 ms at 18–28 ms a character.
      if (s.shownKind === "listening" && s.view.kind === "listening" && s.view.beat === "none") {
        let count = 0;
        while (count < s.delays.length && (s.delays[count] ?? 9) <= local) count++;
        if (count !== s.typedN) {
          s.typedN = count;
          const typed = refs.typed.current;
          const say = refs.say.current;
          if (typed) typed.textContent = ISLAND.utterance.slice(0, count);
          if (say) say.dataset["typed"] = count > 0 ? "" : undefined;
          if (say && count === 0) delete say.dataset["typed"];
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
      // The island's own blink while the blob is in the notch (alarm).
      if (s.shownKind === "alarm") {
        if (now >= s.blinkAt) {
          s.blinkUntil = now + 120;
          s.blinkAt = now + 3000 + Math.random() * 3000;
        }
        setEyes(now < s.blinkUntil ? "- -" : "o o");
      }
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
    const io = new IntersectionObserver(([en]) => {
      s.visible = !!en?.isIntersecting;
      s.running = s.visible;
      if (s.running) play();
      else pause();
    });
    io.observe(st);
    const vis = () => (document.hidden ? pause() : play());
    document.addEventListener("visibilitychange", vis);
    if (process.env.NODE_ENV !== "production") {
      // Verification hooks (development only): pick a kind, read the clock, place it without the 15 s hold.
      (window as unknown as { __jhDesk?: unknown }).__jhDesk = {
        pick: (k: DeskKind) => pick(k),
        pos: () => s.pos,
        seek: (p: number) => {
          s.pos = p;
          s.hold = 0;
          s.seg = -1;
        },
      };
    }
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
      pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stillProp]);

  const pick = useCallback((k: DeskKind) => {
    const s = tl.current;
    const now = performance.now();
    s.pos = segStart(k);
    s.hold = now + HOLD_MS;
    s.seg = -1;
    if (still) {
      applyView({ kind: k, beat: "none" }, now);
      s.seg = SEGS.findIndex((x) => x.kind === k);
      if (s.pending) commitShown(s.pending);
    }
  }, [still, applyView, commitShown]);

  const advance = useCallback(() => {
    const i = DESK_KINDS.indexOf(tl.current.view.kind);
    pick(DESK_KINDS[(i + 1) % DESK_KINDS.length] ?? "listening");
  }, [pick]);

  const label = `Jarhead's blob, ${PHASE_META[view.kind].label.toLowerCase()}`;
  const live = !still && !blobHidden;

  return (
    <div ref={root} className={`desk${compact ? " is-compact" : ""}`} style={style} data-still={still ? "" : undefined} data-phone={compact ? "" : undefined} data-kind={view.kind} data-island={islandState}>
      <div className="desk-stagebox">
        <div ref={stage} className="desk-scale" data-desk-stage="">
          <canvas ref={ground} className="desk-ground" aria-hidden="true" />
          <MenuBar />
          <Notch />
          <Island kind={shown} state={islandState} lipFace={lipFace} swap={swap} still={still} pill={pill} refs={refs} />
          <TargetRing />
          <Blob phase={blobPhase} theme={theme} hidden={blobHidden} still={still} label={label} onAdvance={advance} onFrame={onBlobFrame} />
        </div>
      </div>
      {controls ? controls({ kind: view.kind, live, still, pick }) : null}
    </div>
  );
}
