"use client";
import { animate, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { Icon } from "@/components/icons/Icon";
import { HANDS, PHASES, SAY } from "@/content/deck";
import { nth, part, quoted } from "@/lib/cut";
import { claim } from "@/lib/live";
import { CUT, SPRING, SPRING_CHAR, ease, useCalm, useFirstView, useSteps } from "@/lib/motion";
import type { Phase } from "@/lib/phase";
import { Plate } from "./Plate";
import { Replay, StateWord, Utter, useKeepFocus } from "./parts";

type Step = "idle" | "label" | "click" | "shot" | "done";
const ORDER: readonly Step[] = ["idle", "label", "click", "shot", "done"];
const at = (s: Step, min: Step) => ORDER.indexOf(s) >= ORDER.indexOf(min);

const CLICK_SAVE = quoted(SAY.lines[0], "Click Save");
const SAVE = part(CLICK_SAVE, "Save");
/** The check's line, the lead's whole last sentence: shown dim before the shot, heard once when the step is shot. */
const VERIFIES = nth(HANDS.lead, 2);

/** The pinned beat: on a desk tall enough, the section holds its plate while the scroll steps the h2's three sentences. The pin itself is CSS under this same query (styles/site.css); keep the two in step. */
const PIN = "(min-width: 1001px) and (min-height: 700px)";
/** Where the scroll through the pinned section shows each step (0 is the plate pinned, 1 the pin let go). */
function stepAt(p: number): Step {
  if (p < 0.14 || p > 1) return "done";
  if (p < 0.42) return "label";
  if (p < 0.7) return "click";
  return "shot";
}

/**
 * Hands: say "Click Save" and watch the hands work through the h2's three sentences, each lit as it plays (the section's
 * `data-step`, styles/play.css). Label first: a ring draws round the control that carries the label Save and its tag is
 * read. Click second: the blob flies on its own spring to where the hands act and presses Save. Then the screenshot (the
 * h2's "Screenshots when they help.", which gives it no fixed place: a delegation usually starts with one, engine.ts
 * lookAtScreen): the window flashes, its corners close in, and a check says the screenshot checks the work. Then the blob
 * flies home. On a desk the section also pins its plate while the scroll steps the same three sentences; elsewhere it
 * plays once when it first comes into view. The still (no JS, calm) is the whole sequence at once.
 */
export function Hands(): ReactElement {
  const [step, setStep] = useState<Step>("done");
  const [play, setPlay] = useState(0);
  const calm = useCalm();
  const steps = useSteps();
  const root = useRef<HTMLDivElement>(null);
  const ch = useRef<CharacterHandle>(null);
  const save = useRef<HTMLSpanElement>(null);
  const flash = useRef<HTMLSpanElement>(null);
  const cur = useRef<Step>("done");
  const playing = useRef(false);
  const pinned = useRef(false);
  const chip = useRef<HTMLButtonElement>(null);
  const keep = useKeepFocus(root);

  // The h2 lights its sentence for the step in play (styles/play.css reads the section's data-step).
  useEffect(() => {
    cur.current = step;
    const sec = root.current?.closest("section");
    if (sec) sec.dataset["step"] = step;
    claim("hands", step === "idle" || step === "done" ? { kind: "listening", line: step === "done" && play > 0 ? CLICK_SAVE : undefined } : { kind: "acting", line: CLICK_SAVE });
  }, [step, play]);

  // The blob flies to the control the hands act on (its top-right corner, small enough to sit on it), or home.
  const fly = useCallback(
    (to: "save" | "home") => {
      const el = ch.current?.el;
      if (!el) return;
      if (to === "home") {
        void animate(el, { x: 0, y: 0, scale: 1 }, calm ? CUT : SPRING_CHAR);
        return;
      }
      const target = save.current;
      if (!target) return;
      const b = target.getBoundingClientRect();
      const was = el.style.transform;
      el.style.transform = "none";
      const rest = el.getBoundingClientRect();
      el.style.transform = was;
      void animate(el, { x: b.right - 6 - (rest.left + rest.width / 2), y: b.top + 4 - (rest.top + rest.height / 2), scale: 0.46 }, calm ? CUT : SPRING_CHAR);
    },
    [calm],
  );

  /** A step as the scroll asks for it: the state, and the blob where that step has it. */
  const show = useCallback(
    (s: Step) => {
      if (s === cur.current) return;
      setStep(s);
      fly(s === "click" ? "save" : "home");
      if (s === "shot" && flash.current && !calm) void animate(flash.current, { opacity: [0, 0.9, 0] }, { duration: 0.42, ease: "easeOut" });
    },
    [fly, calm],
  );

  const go = useCallback(() => {
    steps.clear();
    playing.current = true;
    fly("home");
    setStep("label");
    setPlay((p) => p + 1);
    ch.current?.nudge();
    steps.at(640, () => {
      setStep("click");
      fly("save");
    });
    steps.at(1180, () => {
      const el = ch.current?.el;
      ch.current?.nudge();
      if (el && !calm) void animate(el, { scale: [0.46, 0.38, 0.46] }, ease("base"));
    });
    steps.at(1700, () => {
      setStep("shot");
      if (flash.current && !calm) void animate(flash.current, { opacity: [0, 0.9, 0] }, { duration: 0.42, ease: "easeOut" });
    });
    steps.at(2200, () => fly("home"));
    steps.at(2700, () => {
      setStep("done");
      playing.current = false;
    });
  }, [steps, fly, calm]);

  // The pinned beat (a desk, motion allowed): the section grows by a scroll's worth and its plate sticks (server-rendered
  // CSS under the same query, styles/site.css); the scroll through it steps label, click, screenshot. A press on the line
  // still plays the whole route in time.
  useEffect(() => {
    const sec = root.current?.closest("section");
    if (!sec || calm) return;
    const mq = matchMedia(PIN);
    let raf = 0;
    const read = () => {
      raf = 0;
      if (!pinned.current || playing.current) return;
      const r = sec.getBoundingClientRect();
      const span = r.height - window.innerHeight;
      if (span <= 0) return;
      show(stepAt(-r.top / span));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    const setup = () => {
      pinned.current = mq.matches;
      onScroll();
    };
    setup();
    mq.addEventListener("change", setup);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      mq.removeEventListener("change", setup);
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      pinned.current = false;
    };
  }, [calm, show]);

  // Unpinned (a phone, a short or narrow desk), it plays once when it first comes into view.
  const firstView = useCallback(() => {
    if (!pinned.current) go();
  }, [go]);
  useFirstView(root, firstView, calm);

  const phase: Phase = step === "idle" || step === "done" ? "listening" : "acting";
  const tr = calm ? CUT : SPRING;
  const ring = at(step, "label");
  const pressed = at(step, "click");
  const shot = at(step, "shot");
  const fresh = calm || play === 0;
  return (
    <div ref={root} className="hands" data-step={step}>
      <Plate tone="--jh-accent" ax={0.96} ay={0.08}>
        <div className="hands-stage">
          <div className="hands-me">
            <Character ref={ch} phase={phase} className="hands-char" />
            <StateWord>{PHASES[phase === "acting" ? "acting" : "listening"].word}</StateWord>
            <Utter buttonRef={chip} words={CLICK_SAVE} onSay={go} saying={step === "label" && playing.current} />
          </div>
          <div className="hands-shot" data-on={shot ? "" : undefined}>
            <div className="sheet hands-win">
              <div className="win-bar" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <div className="hands-doc" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </div>
              <div className="hands-foot">
                <span ref={save} className="hands-save" data-pressed={pressed ? "" : undefined}>
                  {SAVE}
                  {ring ? (
                    <motion.span key={`tag-${play}`} className="hands-tag" initial={fresh ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...tr, delay: fresh ? 0 : 0.28 }}>
                      <Icon name="tag" size={12} />
                      {SAVE}
                    </motion.span>
                  ) : null}
                  <svg className="hands-ring" aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none">
                    {ring ? <motion.rect key={`ring-${play}`} x="1" y="1" width="98" height="98" rx="10" pathLength={1} vectorEffect="non-scaling-stroke" initial={fresh ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={fresh ? CUT : ease("slow", "inout")} /> : null}
                  </svg>
                </span>
              </div>
              <span ref={flash} className="hands-flash" aria-hidden="true" />
              <span className="hands-corners" aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            {/* the line shows dim before the shot; a screen reader hears it once, when the step is shot */}
            <p className="hands-check">
              <Icon name="camera" size={16} />
              <span aria-hidden="true">{VERIFIES}</span>
              <Icon name="checkCircle" size={16} className="is-tone" />
              <span className="sr-only" aria-live="polite">
                {shot ? VERIFIES : ""}
              </span>
            </p>
          </div>
        </div>
        {step === "done" && play > 0 ? (
          <Replay
            onClick={() => {
              keep(() => chip.current);
              go();
            }}
            className="plate-replay"
          />
        ) : null}
      </Plate>
    </div>
  );
}
