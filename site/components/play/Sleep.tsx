"use client";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { Icon, type IconName } from "@/components/icons/Icon";
import { COSTS, PHASES, SLEEP } from "@/content/deck";
import { ISLAND } from "@/content/island";
import { part, quoted, row, upTo } from "@/lib/cut";
import { claim, type Show } from "@/lib/live";
import { CUT, SPRING, useCalm, useFirstView, useSteps } from "@/lib/motion";
import type { Phase } from "@/lib/phase";
import { Plate } from "./Plate";
import { Replay, StateWord, Utter, useKeepFocus } from "./parts";

/** asleep: the night, the clock running · saying: "night." · ringing: the 07:10 alarm · done: dismissed, still asleep. */
type S = "asleep" | "saying" | "ringing" | "done";

const NIGHT = quoted(SLEEP.lead, "night.");
const ASLEEP = row(COSTS.figures, 2);
const ALARM_AT = upTo(ISLAND.hero.alarm, " · ");
/** What fires while it sleeps, cut from the lead, each with the island's own example where it has one. */
const KINDS: ReadonlyArray<{ readonly id: string; readonly icon: IconName; readonly word: string; readonly what?: string; readonly tag?: string }> = [
  { id: "alarm", icon: "alarm", word: part(SLEEP.lead, "Alarms"), what: ISLAND.hero.alarm, tag: part(ISLAND.headAlarm, "weekdays") },
  { id: "timer", icon: "timer", word: part(SLEEP.lead, "timers"), what: part(ISLAND.footAsleep, "11:56 · pasta") },
  { id: "watch", icon: "eye", word: part(SLEEP.lead, "watchers") },
  { id: "routine", icon: "repeat", word: part(SLEEP.lead, "routines") },
];

/** The night on the island's own clock: from its 12:37 to the alarm's 07:10 the next morning, in minutes. */
const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const fmt = (min: number): string => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const START = toMin(ISLAND.footClock);
const RING = toMin(ALARM_AT) + 1440;
if (fmt(START) !== ISLAND.footClock || fmt(RING) !== ALARM_AT) throw new Error("Sleep: the clock no longer reads the island's times");
const NIGHT_MS = 2600;
/** Snooze 10: ten minutes on the clock. */
const SNOOZE = Number(/\d+/.exec(ISLAND.snooze)?.[0] ?? 10);

const PHASE: Record<S, Phase> = { asleep: "asleep", saying: "speaking", ringing: "listening", done: "asleep" };

/**
 * Sleep: it sleeps at $0 with its alarm armed, the plate gone to ink, the island asleep with the clock. When the plate
 * first comes into view the night runs on that clock from 12:37 to 07:10 and the alarm rings while it sleeps: the row
 * lights, the island rings, the blob looks up, Snooze 10 or Done (Done leaves it asleep: no session, nothing billed).
 * Say "night." and it says it back, closes the session and the night runs again. The still is the night: asleep at $0,
 * 12:37, the alarm armed.
 */
export function Sleep(): ReactElement {
  const [s, setS] = useState<S>("asleep");
  const [clock, setClock] = useState(START);
  const calm = useCalm();
  const steps = useSteps();
  const root = useRef<HTMLDivElement>(null);
  const ch = useRef<CharacterHandle>(null);
  const done = useRef<HTMLButtonElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const keep = useKeepFocus(root);
  const raf = useRef(0);
  const run = useRef(0);

  useEffect(() => {
    const show: Show = s === "saying" ? { kind: "speaking", line: NIGHT } : s === "ringing" ? { kind: "alarm" } : { kind: "asleep", clock: fmt(clock) };
    claim("sleep", show);
  }, [s, clock]);
  useEffect(() => {
    if (s === "ringing" && root.current?.contains(document.activeElement)) done.current?.focus({ preventScroll: true });
  }, [s]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /** The clock runs from `from` to `to` over `ms` on an ease in-out, then the alarm rings. Calm: it simply reads `to`. */
  const night = useCallback(
    (from: number, to: number, ms: number) => {
      const me = ++run.current;
      cancelAnimationFrame(raf.current);
      setS("asleep");
      setClock(from);
      const ring = () => {
        if (me !== run.current) return;
        setS("ringing");
        ch.current?.nudge();
      };
      if (calm) {
        steps.at(ms, () => {
          setClock(to);
          ring();
        });
        return;
      }
      steps.at(500, () => {
        const t0 = performance.now();
        const tick = (now: number) => {
          if (me !== run.current) return;
          const u = Math.min(1, (now - t0) / ms);
          const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
          setClock(from + (to - from) * e);
          if (u < 1) raf.current = requestAnimationFrame(tick);
          else ring();
        };
        raf.current = requestAnimationFrame(tick);
      });
    },
    [calm, steps],
  );

  const goodnight = useCallback(() => {
    steps.clear();
    run.current++;
    cancelAnimationFrame(raf.current);
    setS("saying");
    setClock(START);
    ch.current?.nudge();
    steps.at(650, () => night(START, RING, NIGHT_MS));
  }, [steps, night]);

  // Once, when the plate first comes into view: the night runs on the clock and the alarm rings.
  const firstView = useCallback(() => night(START, RING, NIGHT_MS), [night]);
  useFirstView(root, firstView, calm);

  // Snooze, Done and Replay leave with the press: focus goes to the "night." chip.
  const snooze = () => {
    keep(() => chip.current);
    steps.clear();
    night(clock, clock + SNOOZE, 1200);
  };
  const dismiss = () => {
    keep(() => chip.current);
    steps.clear();
    run.current++;
    setS("done");
  };

  const ringing = s === "ringing";
  const dark = s === "asleep" || s === "done";
  const caption = dark ? SLEEP.lines[0] : ringing ? SLEEP.lines[1] : " ";
  const tr = calm ? CUT : SPRING;
  return (
    <div ref={root} className="sleep" data-state={s} data-dark={dark ? "" : undefined}>
      <Plate tone="--jh-asleep" ax={0.94} ay={0.06}>
        <span className="sleep-night" aria-hidden="true" />
        <div className="sleep-stage">
          <div className="sleep-me">
            <div className="sleep-who">
              <Character ref={ch} phase={PHASE[s]} face={s === "saying" ? "^^" : null} className="sleep-char" />
              <AnimatePresence>
                {s === "saying" ? (
                  <motion.q key="night" className="sleep-said" initial={calm ? false : { opacity: 0, x: -8, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0 }} transition={tr}>
                    {NIGHT}
                  </motion.q>
                ) : null}
              </AnimatePresence>
            </div>
            <StateWord>{ringing ? PHASES.alarm.word : s === "saying" ? PHASES.speaking.word : PHASES.asleep.word}</StateWord>
            <span className="sleep-meter">
              {s === "saying" ? (
                ISLAND.footMeter
              ) : (
                <>
                  <b>{ASLEEP.value}</b> {ASLEEP.label}
                </>
              )}
            </span>
            <Utter buttonRef={chip} words={NIGHT} onSay={goodnight} saying={s === "saying"} disabled={s === "saying"} />
          </div>
          <div className="sleep-side">
            <time className="sleep-clock" aria-hidden="true">
              {fmt(clock)}
            </time>
            <div className="sheet sleep-card">
              <ul className="sleep-kinds" role="list">
                {KINDS.map((k) => (
                  <li key={k.id} data-lit={k.id === "alarm" && ringing ? "" : undefined}>
                    <span className={`sleep-icon${k.id === "alarm" && ringing ? " is-ringing" : ""}`}>
                      <Icon name={k.icon} size={20} />
                    </span>
                    <span className="sleep-word">{k.word}</span>
                    {k.what ? <code className="sleep-what">{k.what}</code> : null}
                    {k.tag ? <span className="tag">{k.tag}</span> : null}
                    {k.id === "alarm" && s === "done" ? <Icon name="checkCircle" size={16} className="sleep-ok" /> : null}
                    {k.id === "alarm" && ringing ? (
                      <span className="sleep-btns">
                        <button type="button" className="kit-btn kit-btn--ghost kit-btn--lg" onClick={snooze}>
                          {ISLAND.snooze}
                        </button>
                        <button ref={done} type="button" className="kit-btn kit-btn--primary kit-btn--lg" onClick={dismiss}>
                          {ISLAND.done}
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <p className="plate-foot" aria-live="polite">
          {caption}
        </p>
        {s === "done" ? (
          <Replay
            onClick={() => {
              keep(() => chip.current);
              goodnight();
            }}
            className="plate-replay"
          />
        ) : null}
      </Plate>
    </div>
  );
}
