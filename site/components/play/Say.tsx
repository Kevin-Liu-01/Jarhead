"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { Icon } from "@/components/icons/Icon";
import { AgentMark } from "@/components/kit/AgentMark";
import { HANDS, NUMBERS, PHASES, SAY, SAY_BADGE, THREADS } from "@/content/deck";
import { ISLAND } from "@/content/island";
import { aroundQuote, nth, part, quoted } from "@/lib/cut";
import { claim, type Show } from "@/lib/live";
import { CUT, SPRING, onScreenNow, useCalm, useSteps } from "@/lib/motion";
import type { Phase } from "@/lib/phase";
import { boxIn, type Pt } from "@/lib/route";
import { Plate } from "./Plate";
import { Replay, StateWord, Utter, useKeepFocus } from "./parts";
import { Wires, type WireSet, type WireSpec } from "./Wires";

type Line = "save" | "ben";
type Step = "idle" | "hear" | "route" | "hands" | "done";
const ORDER: readonly Step[] = ["idle", "hear", "route", "hands", "done"];
const at = (s: Step, min: Step) => ORDER.indexOf(s) >= ORDER.indexOf(min);

const CLICK_SAVE = quoted(SAY.lines[0], "Click Save");
const TELL_BEN = quoted(THREADS.lead, "Tell Ben on Slack I'm late and put on Focus on Spotify");
const SAVE = part(CLICK_SAVE, "Save");
/** The router's two lanes and its picker, each a whole sentence of the lead. */
const REFLEX = nth(SAY.lead, 0);
const REST = nth(SAY.lead, 1);
const PICK = nth(SAY.lead, 2);
/** The brains, cut from the h2: Codex, Claude Code, a key, a model on your Mac. */
const BRAINS: ReadonlyArray<{ readonly id: string; readonly text: string; readonly mark: ReactNode }> = [
  { id: "codex", text: part(SAY.h2[0], "Codex"), mark: <AgentMark tool="codex" size={14} decorative /> },
  { id: "claude", text: part(SAY.h2[0], "Claude Code"), mark: <AgentMark tool="claude" size={14} decorative /> },
  { id: "key", text: part(SAY.h2[0], "a key"), mark: <Icon name="key" size={16} /> },
  { id: "local", text: part(SAY.h2[1], "a model on your Mac"), mark: <Icon name="laptop" size={16} /> },
];
/** The two routes' measured times: the reflex's dispatch (Numbers) and a brain's first visible action in real use (the
 * deck's SAY_BADGE, the author's ledger with Codex, not the canned-hands harness). It was measured with Codex only, so
 * its badge shows while Codex is picked and no other brain. It hides rather than leaves, so the head keeps its wrap and
 * the rows never move under a tap. */
const REFLEX_MS = NUMBERS.display.value;
const BRAIN_S = SAY_BADGE;
const MEASURED = "codex";
/** An empty caption that keeps its line: the brain line's outcome is the two threads in the hands, and its "same policy"
 * line already stands beside the plate, so it is not said twice. */
const QUIET = "\u00a0";
/** The Click Save line's outcome, its spoken words in a <q> as the chip above sets them. */
const SAVE_AT = aroundQuote(SAY.lines[0], CLICK_SAVE);
const SAVED = (
  <>
    {SAVE_AT[0]}
    <q>{SAVE_AT[1]}</q>
    {SAVE_AT[2]}
  </>
);
/** The brain line's outcome as the hands show it (the island's tiles, each `working`), said to a screen reader in the foot. */
const TILES_SAID = ISLAND.tiles.map((t) => `${t} ${ISLAND.tileState}`).join(", ");
/** The words each line is heard as on the island. */
const HEARD: Record<Line, string> = { save: CLICK_SAVE, ben: TELL_BEN };
/**
 * The router's wires at rest as the stage lays them out at 1440 (measured there once): the server's still, so the router
 * reads without JS; on hydration the demo measures its own.
 */
const AT_REST: WireSet = {
  view: [1185, 365],
  joints: [],
  list: [
    { id: "in-r", arrow: true, pts: [[146, 203.5], [332.6, 203.5], [332.6, 105.5], [376.6, 105.5]] },
    { id: "in-b", arrow: true, pts: [[146, 203.5], [332.6, 203.5], [332.6, 224], [376.6, 224]] },
    { id: "out-r", arrow: true, pts: [[736.6, 105.5], [780.6, 105.5], [780.6, 217.5], [945.2, 217.5]] },
    { id: "out-b", arrow: true, pts: [[736.6, 224], [780.6, 224], [780.6, 217.5], [945.2, 217.5]] },
  ],
};

/**
 * Say: say one of two deck lines and watch it route. `"Click Save"` is unambiguous: it takes the reflex lane to the hands
 * in milliseconds and Save is pressed. The Slack and Spotify line goes to the brain picked in Settings (pick any of the
 * four rows: Codex, Claude Code, a key, a model on your Mac), which thinks, then hands its work on: two threads. The wire
 * the line takes draws along its length; the others wait dashed. The island thinks and acts with it.
 */
export function Say(): ReactElement {
  const [line, setLine] = useState<Line | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [brain, setBrain] = useState(0);
  const [play, setPlay] = useState(0);
  const [wires, setWires] = useState<WireSet | null>(AT_REST);
  const calm = useCalm();
  const steps = useSteps();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ch = useRef<CharacterHandle>(null);
  const reflex = useRef<HTMLDivElement>(null);
  const brainCard = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);
  const hands = useRef<HTMLDivElement>(null);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const first = useRef<HTMLButtonElement>(null);
  const keep = useKeepFocus(root);

  const reset = useCallback(() => {
    steps.clear();
    setLine(null);
    setStep("idle");
  }, [steps]);

  // The still is the router at rest with Codex picked; the first frame is the same, so nothing resets on mount.
  useEffect(() => {
    if (!onScreenNow(root.current)) reset();
  }, [reset]);

  // The island hears the line, thinks with the brain (the Slack and Spotify line) or acts at once (the reflex), and ends
  // with the hands: Save pressed, or the two threads working.
  useEffect(() => {
    let show: Show = { kind: "listening" };
    if (line && step !== "idle") {
      const heard = HEARD[line];
      if (step === "hear") show = { kind: "listening", line: heard };
      else if (line === "ben") show = step === "route" ? { kind: "thinking", line: heard } : { kind: "acting", line: heard, tiles: ISLAND.tiles.map((name) => ({ name, state: "working" as const })) };
      else show = step === "done" ? { kind: "listening", line: heard } : { kind: "acting", line: heard };
    }
    claim("say", show);
  }, [line, step]);

  const go = (l: Line) => {
    steps.clear();
    setLine(l);
    setStep("hear");
    setPlay((p) => p + 1);
    ch.current?.nudge();
    if (l === "save") {
      steps.at(300, () => setStep("route"));
      steps.at(620, () => setStep("hands"));
      steps.at(1100, () => setStep("done"));
    } else {
      steps.at(300, () => setStep("route"));
      steps.at(1800, () => setStep("hands"));
      steps.at(2400, () => setStep("done"));
    }
  };

  const pick = (i: number) => {
    if (i === brain) return;
    setBrain(i);
    if (line === "ben") reset();
  };
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + BRAINS.length) % BRAINS.length;
    pick(n);
    rows.current[n]?.focus();
  };

  // The wires, measured from the laid-out pieces whenever the stage resizes or the picked brain moves. Only where the
  // stage lays its pieces side by side (CSS sets --wired); stacked on a phone, the pieces light without wires.
  const lit = line !== null && at(step, "route");
  const out = line !== null && at(step, "hands");
  useLayoutEffect(() => {
    const st = stage.current;
    if (!st) return;
    const measure = () => {
      if (getComputedStyle(st).getPropertyValue("--wired").trim() !== "1") return setWires(null);
      const me = boxIn(st, ch.current?.el ?? null);
      const R = boxIn(st, reflex.current);
      const C = boxIn(st, rows.current[brain] ?? null);
      const BC = boxIn(st, brainCard.current);
      const L = boxIn(st, lanes.current);
      const H = boxIn(st, hands.current);
      if (!me || !R || !C || !BC || !L || !H) return setWires(null);
      const x0 = me.cx + (me.r - me.l) * 0.36 + 8;
      const jx = L.l - 44;
      const ox = L.r + 44;
      const list: WireSpec[] = [
        { id: "in-r", pts: [[x0, me.cy], [jx, me.cy], [jx, R.cy], [R.l, R.cy]], arrow: true, lit: lit && line === "save" },
        { id: "in-b", pts: [[x0, me.cy], [jx, me.cy], [jx, C.cy], [BC.l, C.cy]], arrow: true, lit: lit && line === "ben" },
        { id: "out-r", pts: [[R.r, R.cy], [ox, R.cy], [ox, H.cy], [H.l, H.cy]], arrow: true, lit: out && line === "save" },
        { id: "out-b", pts: [[BC.r, C.cy], [ox, C.cy], [ox, H.cy], [H.l, H.cy]], arrow: true, lit: out && line === "ben" },
      ];
      setWires({ list, joints: [[jx, me.cy], [ox, H.cy]] });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(st);
    return () => ro.disconnect();
  }, [brain, lit, out, line]);

  const phase: Phase = step === "route" && line === "ben" ? "thinking" : step === "hands" ? "acting" : "listening";
  const caption = step !== "done" ? " " : line === "save" ? SAVED : brain === 3 ? SAY.lines[2] : QUIET;
  const working = line === "ben" && step === "route";
  const pressed = line === "save" && at(step, "hands");
  const tiles = line === "ben" && at(step, "hands");
  const tr = calm ? CUT : SPRING;
  return (
    <div ref={root} className="say" data-step={step} data-line={line ?? undefined}>
      <Plate tone="--jh-thinking" ax={0.06} ay={0.98}>
        <div ref={stage} className="say-stage">
          {wires ? <Wires set={wires} play={play} calm={calm} /> : null}
          <div className="say-lines">
            <Utter buttonRef={first} words={CLICK_SAVE} onSay={() => go("save")} saying={line === "save" && step === "hear"} />
            <Utter words={TELL_BEN} onSay={() => go("ben")} saying={line === "ben" && step === "hear"} />
          </div>
          <div className="say-me">
            <Character ref={ch} phase={phase} className="say-char" />
            <StateWord>{PHASES[phase === "thinking" ? "thinking" : phase === "acting" ? "acting" : "listening"].word}</StateWord>
          </div>
          <div ref={lanes} className="say-lanes">
            <div ref={reflex} className="sheet say-reflex" data-lit={lit && line === "save" ? "" : undefined}>
              <span className="say-reflex-icon">
                <Icon name="lightning" size={20} />
              </span>
              <span className="say-reflex-words">{REFLEX}</span>
              <span className="tag">{REFLEX_MS}</span>
            </div>
            <div ref={brainCard} className="sheet say-brain" data-lit={lit && line === "ben" ? "" : undefined}>
              <div className="sheet-head">
                <Icon name="gearSix" size={20} />
                <span className="say-head">{REST}</span>
                <span className="tag" data-off={BRAINS[brain]?.id === MEASURED ? undefined : ""}>
                  {BRAIN_S}
                </span>
              </div>
              <div role="radiogroup" aria-label={PICK} className="say-rows">
                {BRAINS.map((b, i) => (
                  <button
                    key={b.id}
                    ref={(el) => {
                      rows.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={i === brain}
                    tabIndex={i === brain ? 0 : -1}
                    className="say-row"
                    data-working={working && i === brain ? "" : undefined}
                    onClick={() => pick(i)}
                    onKeyDown={(e) => onRowKey(e, i)}
                  >
                    <span className="say-mark">{b.mark}</span>
                    <span>{b.text}</span>
                    {working && i === brain ? (
                      <span className="dots" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : i === brain ? (
                      <Icon name="checkCircle" size={16} className="say-check" />
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div ref={hands} className="sheet say-hands" data-lit={out ? "" : undefined}>
            <div className="win-bar" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <span className="say-hands-name">{HANDS.name}</span>
            <div className="say-win">
              <AnimatePresence initial={false} mode="popLayout">
                {tiles ? (
                  <motion.div key="tiles" className="say-tiles" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={tr}>
                    {ISLAND.tiles.map((t) => (
                      <span key={t} className="say-tile">
                        <i />
                        {t}
                        <span className="say-quiet">{ISLAND.tileState}</span>
                      </span>
                    ))}
                  </motion.div>
                ) : (
                  <motion.div key="doc" className="say-doc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr}>
                    <i />
                    <i />
                    <i />
                    <span className="say-save" data-pressed={pressed ? "" : undefined}>
                      {SAVE}
                      {pressed ? <Icon name="cursorClick" size={20} className="say-cursor" /> : null}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
        <p className="plate-foot" aria-live="polite">
          {caption}
          {line === "ben" && step === "done" ? <span className="sr-only">{TILES_SAID}</span> : null}
        </p>
        {step === "done" ? (
          <Replay
            onClick={() => {
              keep(() => first.current);
              reset();
            }}
            className="plate-replay"
          />
        ) : null}
      </Plate>
    </div>
  );
}
