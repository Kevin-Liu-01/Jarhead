"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { Island, ISLAND, type IslandKind, type IslandRefs, type IslandState } from "@/components/desk/Island";
import { Notch } from "@/components/desk/Notch";
import type { BlobFrame } from "@/lib/blob";
import { over } from "@/components/kit/Meter";
import { cellCss, ditherGlyphs, parseColor, renderMeter, type RGB } from "@/lib/dither";
import { renderIslandInk } from "@/lib/island";
import { SECTION_KIND } from "@/content/deck";
import { getLive, liveActions, setLive, subscribeLive, useLive, type Beat } from "@/lib/live";
import { DESK_KINDS, PHASE_META, type DeskKind } from "@/lib/phase";
import { cssVar, isStill } from "@/lib/theme";

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
const LEAVE_MS = 600; // NotchPanel: the island contracts 600 ms after the pointer leaves
const NOTCH = 185;
const WING = 40;

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

const spaced = (p: string): string => `${p[0] ?? "-"} ${p[1] ?? "-"}`;

/**
 * The notch and the island over the page's top edge (IMMERSE.md angle A): the hardware notch at the top centre, the
 * island hanging under it, peeking while awake (the blob's face on the 26 px strip), tucked asleep (the lip with `- -`),
 * open under the pointer or while an alarm rings, at 1:1 on a 420 px holder that scales down on a phone. It runs the one
 * rAF timeline the whole page reads (lib/live.ts): the kinds cycle, the Say box types the utterance (here and in the
 * composer), Working counts, the meters tick, the ink breathes. `#still` and reduced motion give one pose.
 */
export function Top(): ReactElement {
  const [still, setStill] = useState(false);
  const [view, setView] = useState<View>({ kind: "listening", beat: "none" });
  const [shown, setShown] = useState<IslandKind>("listening");
  const [swap, setSwap] = useState(false);
  const [pill, setPill] = useState(false);
  const [hover, setHover] = useState(false);
  // A ringing alarm opens the island where a pointer can also close it; on a touch screen it stays on the lip.
  const [canHover, setCanHover] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
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
    swapAt: 0,
    pending: null as IslandKind | null,
    inkAt: 0,
    typedN: -1,
    delays: [] as number[],
    blinkAt: 0,
    blinkUntil: 0,
    blobPair: "O O",
    scale: 1,
    leave: 0,
    shownKind: "listening" as IslandKind,
    view: { kind: "listening", beat: "none" } as View,
    state: "peek" as IslandState,
    docked: false,
    spyAt: 0,
    ink: null as { fill: RGB; track: RGB } | null,
  });
  const meterInk = useCallback(() => (tl.current.ink ??= islandInk()), []);

  // Docked (a section in view) the island wears the kind's own face; in the hero it wears the blob's.
  const docked = Boolean(SECTION_KIND[useLive().section]);
  const asleep = view.kind === "asleep";
  const state: IslandState = asleep ? "tucked" : view.beat === "heard" ? "peek" : hover || (view.kind === "alarm" && canHover) ? "open" : "peek";
  tl.current.state = state;
  const lipFace = view.beat === "gate" ? ". ." : view.beat === "heard" ? "O O" : asleep ? "- -" : docked ? PHASE_META[view.kind].face : tl.current.blobPair;
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

  // The holder's scale (CSS: 1:1 to 436 px of viewport, then the whole island shrinks as one), read back for the ink's cell and the eyes.
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    setCanHover(typeof matchMedia === "function" && matchMedia("(hover: hover)").matches);
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
    if (refs.meterFoot.current) renderMeter(refs.meterFoot.current, { width: 88, height: 6, fraction: 0.84, fill, track });
    if (still && refs.glyphs.current) refs.glyphs.current.textContent = ditherGlyphs(8, 1, 0, true)[0] ?? "";
  }, [shown, still, state, meterInk, refs.meterHead, refs.meterFoot, refs.glyphs]);

  // The island's eyes and the lip's: the blob's pair while it is awake; the kind's own face otherwise.
  const setEyes = useCallback((pair: string) => {
    if (refs.eyeTop.current && refs.eyeTop.current.textContent !== pair) {
      refs.eyeTop.current.textContent = pair;
      if (refs.eyeUnder.current) refs.eyeUnder.current.textContent = pair;
    }
    const v = tl.current.view;
    if (v.beat === "none" && v.kind !== "asleep" && v.kind !== "alarm") {
      holder.current?.querySelectorAll<HTMLSpanElement>(".desk-lipface span").forEach((el) => {
        if (el.textContent !== pair) el.textContent = pair;
      });
    }
  }, [refs.eyeTop, refs.eyeUnder]);
  useEffect(() => {
    liveActions.onBlobFrame = (f: BlobFrame) => {
      tl.current.blobPair = spaced(f.pair);
      if (!tl.current.docked) setEyes(tl.current.blobPair);
    };
    return () => {
      liveActions.onBlobFrame = () => undefined;
    };
  }, [setEyes]);
  useEffect(() => {
    if (shown === "alarm") setEyes("o o");
  }, [shown, setEyes]);

  // The pointer turns the island's eyes by ±8 / ±5 px within 300 px.
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
      }
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [refs.eyes]);

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
        setEyes(s.docked ? PHASE_META[kind].face : s.blobPair);
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
      // A section in view sets the kind (the left rail measures it); the timeline holds until the hero is back.
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
      // The Say box types the utterance from 200 ms at 18–28 ms a character: on the island and in the composer.
      if (s.view.kind === "listening" && s.view.beat === "none") {
        let count = 0;
        while (count < s.delays.length && (s.delays[count] ?? 9) <= local) count++;
        if (count !== s.typedN) {
          s.typedN = count;
          const text = ISLAND.utterance.slice(0, count);
          const typed = refs.typed.current;
          const say = refs.say.current;
          if (typed) typed.textContent = text;
          if (say) {
            if (count > 0) say.dataset["typed"] = "";
            else delete say.dataset["typed"];
          }
          const cpTyped = document.querySelector<HTMLElement>("[data-say-typed]");
          const cpSay = document.querySelector<HTMLElement>("[data-say]");
          if (cpTyped) cpTyped.textContent = text;
          if (cpSay) {
            if (count > 0) cpSay.dataset["typed"] = "";
            else delete cpSay.dataset["typed"];
          }
        }
      } else if (s.typedN !== -1) {
        // The island's box re-renders per kind; the composer keeps the last line said until the next one types.
        s.typedN = -1;
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
      // Docked, the eyes are the kind's own (the blob is off the screen); the alarm keeps its blink below.
      if (s.docked && s.shownKind !== "alarm" && now - s.inkAt < 1) setEyes(PHASE_META[s.view.kind].face);
      // The island's own blink while the alarm rings.
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
      // Verification hooks (development only): pick a kind, open or close the island.
      (window as unknown as { __jhTop?: unknown }).__jhTop = { pick: (k: DeskKind) => pick(k), open: (on: boolean) => setHover(on) };
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

  // Hover opens; the pointer leaving contracts it 600 ms later (NotchPanel). A tap toggles where there is no hover.
  const enter = () => {
    window.clearTimeout(tl.current.leave);
    setHover(true);
  };
  const leave = () => {
    window.clearTimeout(tl.current.leave);
    tl.current.leave = window.setTimeout(() => setHover(false), LEAVE_MS);
  };
  const tap = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch") return;
    window.clearTimeout(tl.current.leave);
    setHover((h) => !h);
  };

  return (
    <div ref={holder} className="desk top" style={style} data-still={still ? "" : undefined} data-kind={view.kind} data-island={state} aria-hidden="true">
      <div className="top-scale" onPointerEnter={enter} onPointerLeave={leave} onPointerDown={tap}>
        <Notch />
        <Island kind={shown} state={state} lipFace={lipFace} swap={swap} still={still} pill={pill} refs={refs} />
      </div>
    </div>
  );
}
