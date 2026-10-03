"use client";
import { animate, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { Icon, type IconName } from "@/components/icons/Icon";
import { HERO, PHASES, UI, WAKE } from "@/content/deck";
import { part, parts, row } from "@/lib/cut";
import { claim, type Show } from "@/lib/live";
import { CUT, SPRING, ease, onScreenNow, useCalm, useSteps } from "@/lib/motion";
import type { Phase } from "@/lib/phase";
import { Plate } from "./Plate";
import { Replay, StateWord, Utter, useKeepFocus } from "./parts";

type S = "asleep" | "heard" | "gate" | "granted" | "denied" | "locked";

/** The gate's own words (WAKE.faces: gate · heard · granted · denied · locked) and the asleep word. */
const F = parts(WAKE.faces);
const WORD: Record<S, string> = { asleep: PHASES.asleep.word, gate: row(F, 0), heard: row(F, 1), granted: row(F, 2), denied: row(F, 3), locked: row(F, 4) };
/** "Say jarhead", cut from the hero's lead: the word the visitor says. */
const SAY = part(HERO.lead, "Say jarhead");
const SAY_VERB = SAY.split(" ")[0] ?? "";
const SAY_WORD = SAY.slice(SAY_VERB.length + 1);
const TOUCH_ID = part(WAKE.h2[1], "Touch ID");
/** The four ways through the gate, cut from the lead; Touch ID is the one the pad plays. */
const WAYS: ReadonlyArray<{ readonly icon: IconName; readonly text: string }> = [
  { icon: "fingerprint", text: TOUCH_ID },
  { icon: "watch", text: part(WAKE.lead, "Apple Watch") },
  { icon: "password", text: part(WAKE.lead, "the Mac password") },
  { icon: "keyboard", text: part(WAKE.lead, "a passphrase") },
];
const HOLD_MS = 700;
/** The frown a wrong press earns (`> <`), drawn by the blob's face. */
const DENIED = "><";
const MISSES = 3;

/** Three misses lock the gate for a minute (WAKE.lines[0]): the lock counts it down, then the gate waits again. */
const LOCK_S = 60;
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

const PHASE: Record<S, Phase> = { asleep: "asleep", heard: "listening", gate: "listening", granted: "speaking", denied: "listening", locked: "asleep" };
/** The island with it: asleep, then it heard the word, waits at the gate, opens awake; locked, it sleeps again. */
const ISLAND: Record<S, Show> = {
  asleep: { kind: "asleep" },
  heard: { kind: "listening", line: SAY_WORD },
  gate: { kind: "listening", line: SAY_WORD },
  granted: { kind: "listening" },
  denied: { kind: "listening", line: SAY_WORD },
  locked: { kind: "asleep" },
};

/**
 * Wake: the blob asleep on its plate. Say jarhead (the chip) and it hears, `O O`, and the gate comes up with its four ways
 * in. Hold the Touch ID pad (pointer, touch, or Space or Enter held) while its ring draws round: granted, `^ ^`, the lock
 * opens and the island at the top opens with it. Let go early and the blob frowns `> <`, denied, and a miss is counted;
 * three misses and the gate locks for the deck's minute, counted down on the pad. The still (no JS, or a page opened on
 * this section) is the gate waiting for the press.
 */
export function Wake(): ReactElement {
  const [s, setS] = useState<S>("gate");
  const [misses, setMisses] = useState(0);
  const [lockLeft, setLockLeft] = useState(LOCK_S);
  const [saying, setSaying] = useState(false);
  const calm = useCalm();
  const steps = useSteps();
  const root = useRef<HTMLDivElement>(null);
  const ch = useRef<CharacterHandle>(null);
  const card = useRef<HTMLDivElement>(null);
  const pad = useRef<HTMLButtonElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const hold = useRef<{ start: number; raf: number } | null>(null);
  const live = useRef({ s, misses });
  live.current = { s, misses };
  const keep = useKeepFocus(root);

  // The still is the waiting gate; a page that opens elsewhere starts the demo from its first frame, asleep.
  useEffect(() => {
    if (!onScreenNow(root.current)) setS("asleep");
  }, []);
  useEffect(() => {
    claim("wake", ISLAND[s]);
  }, [s]);
  // Locked: the minute runs down on the pad, then the misses clear and the gate waits for the press again.
  useEffect(() => {
    if (s !== "locked") return;
    setLockLeft(LOCK_S);
    const t0 = Date.now();
    const t = window.setInterval(() => {
      const left = Math.max(0, LOCK_S - Math.floor((Date.now() - t0) / 1000));
      setLockLeft(left);
      if (left === 0) {
        window.clearInterval(t);
        setMisses(0);
        setS("gate");
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [s]);

  const setRing = (p: number) => {
    ring.current?.style.setProperty("stroke-dashoffset", String(1 - Math.max(0, Math.min(1, p))));
  };

  // Replay leaves with the press: focus goes back to the chip that wakes it.
  const reset = useCallback(() => {
    keep(() => chip.current);
    steps.clear();
    setMisses(0);
    setSaying(false);
    setRing(0);
    setS("asleep");
  }, [steps, keep]);

  const say = () => {
    if (live.current.s !== "asleep") return;
    const fromKeys = document.activeElement === chip.current;
    setSaying(true);
    ch.current?.nudge();
    steps.at(320, () => {
      setSaying(false);
      setS("heard");
      ch.current?.nudge();
    });
    steps.at(860, () => {
      setS("gate");
      if (fromKeys) pad.current?.focus({ preventScroll: true });
    });
  };

  const miss = () => {
    const n = live.current.misses + 1;
    setMisses(n);
    setRing(0);
    ch.current?.nudge();
    if (card.current && !calm) animate(card.current, { x: [0, -7, 6, -4, 3, 0] }, { duration: 0.36, ease: "easeOut" });
    if (n >= MISSES) {
      setS("locked");
      return;
    }
    setS("denied");
    steps.at(900, () => setS((cur) => (cur === "denied" ? "gate" : cur)));
  };

  const startHold = () => {
    const cur = live.current.s;
    if (cur === "asleep") {
      // Asleep, the gate is not up yet: the chip that wakes it gives a small nod.
      if (chip.current && !calm) animate(chip.current, { y: [0, -4, 0] }, ease("base"));
      return;
    }
    if ((cur !== "gate" && cur !== "denied") || hold.current) return;
    if (cur === "denied") setS("gate");
    const start = performance.now();
    const tick = (now: number) => {
      if (!hold.current) return;
      const p = (now - start) / HOLD_MS;
      setRing(p);
      if (p >= 1) {
        hold.current = null;
        setS("granted");
        ch.current?.nudge();
        return;
      }
      hold.current.raf = requestAnimationFrame(tick);
    };
    hold.current = { start, raf: requestAnimationFrame(tick) };
  };
  const endHold = () => {
    const h = hold.current;
    if (!h) return;
    cancelAnimationFrame(h.raf);
    hold.current = null;
    miss();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
      e.preventDefault();
      startHold();
    }
  };
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      endHold();
    }
  };

  const up = s !== "asleep" && s !== "heard";
  const open = s === "granted";
  const face = s === "denied" ? DENIED : null;
  const tr = calm ? CUT : SPRING;
  return (
    <div ref={root} className="wake" data-state={s}>
      <Plate tone="--jh-listening" ax={0.92} ay={0.96}>
        <div className="wake-stage">
          <div className="wake-me">
            <Character ref={ch} phase={PHASE[s]} face={face} className="wake-char" />
            <StateWord>{WORD[s]}</StateWord>
            <Utter buttonRef={chip} lead={SAY_VERB} words={SAY_WORD} onSay={say} saying={saying} disabled={s !== "asleep"} />
          </div>
          <motion.div
            ref={card}
            className="sheet wake-gate"
            initial={false}
            animate={up ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0.4, y: 10, scale: 0.98 }}
            transition={tr}
            aria-hidden={!up}
          >
            <div className="sheet-head">
              <Icon name={open ? "lockOpen" : "lock"} size={20} className={open ? "is-tone" : undefined} />
              <span>{WORD.gate}</span>
            </div>
            <ul className="wake-ways" role="list">
              {WAYS.map((w, i) => (
                <li key={w.text} data-lit={i === 0 ? "" : undefined}>
                  <Icon name={w.icon} size={20} />
                  <span>{w.text}</span>
                  {i === 0 && open ? <Icon name="checkCircle" size={20} className="is-tone wake-ok" /> : null}
                </li>
              ))}
            </ul>
            <div className="wake-pad-row">
              <button
                ref={pad}
                type="button"
                className="wake-pad"
                aria-label={`${TOUCH_ID}, ${UI.hold}`}
                aria-disabled={!(s === "gate" || s === "denied")}
                tabIndex={up ? 0 : -1}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  startHold();
                }}
                onPointerUp={endHold}
                onPointerCancel={endHold}
                onLostPointerCapture={endHold}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onBlur={endHold}
                onContextMenu={(e) => e.preventDefault()}
              >
                <svg className="wake-ring" viewBox="0 0 72 72" aria-hidden="true">
                  <circle className="wake-ring-track" cx="36" cy="36" r="34" />
                  <circle ref={ring} className="wake-ring-fill" cx="36" cy="36" r="34" pathLength={1} style={{ strokeDashoffset: open ? 0 : 1 }} />
                </svg>
                <Icon name="fingerprint" size={32} />
              </button>
              {/* The lit first way and the print already name the pad; the state word under the blob says granted, denied or locked. */}
              <span className="wake-pad-words">
                <span className="wake-hint">{s === "locked" ? <span className="wake-lock">{clock(lockLeft)}</span> : UI.hold}</span>
                {/* The tries, on the Hold line: one small print per press, spent in the denied tone; three lock the gate. */}
                <span className="wake-misses" aria-hidden="true">
                  {Array.from({ length: MISSES }, (_, i) => (
                    <Icon key={i} name="fingerprint" size={14} className={i < misses ? "is-spent" : undefined} />
                  ))}
                </span>
              </span>
            </div>
          </motion.div>
        </div>
        <p className="plate-foot" aria-live="polite">
          {s === "locked" ? WAKE.lines[0] : " "}
        </p>
        {s === "granted" || s === "locked" ? <Replay onClick={reset} className="plate-replay" /> : null}
      </Plate>
    </div>
  );
}
