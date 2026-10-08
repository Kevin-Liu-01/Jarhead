"use client";
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactElement } from "react";
import { Character } from "@/components/desk/Character";
import { COSTS, PHASES } from "@/content/deck";
import { ISLAND } from "@/content/island";
import { row } from "@/lib/cut";
import { claim } from "@/lib/live";
import { Plate } from "./Plate";

const RATE = row(COSTS.figures, 0); // $0.05 per minute of open session
const HOUR = row(COSTS.figures, 1); // $3 an hour of talking
const ZERO = row(COSTS.figures, 2); // $0 the voice, asleep
/** The section's h2 (Section renders it as `${id}-h`) names the Listening and Asleep group; its first line, "It's five cents a minute", names the slider. */
const HEAD = `${COSTS.id}-h`;
const HEAD_1 = `${HEAD}-1`;
const PER_MIN = Number(RATE.value.slice(1));
if (Math.abs(PER_MIN * 60 - Number(HOUR.value.slice(1))) > 1e-9) throw new Error("Costs: the rate times sixty is no longer the hour");
/** The island's own reading is where the slider starts: 7.2 min · $0.36. */
const START = Number(/^([\d.]+) min/.exec(ISLAND.footMeter)?.[1] ?? "7.2");
const MIN_WORD = ISLAND.footMeter.includes(" min ") ? "min" : "";

function dollars(min: number): string {
  if (min >= 60) return HOUR.value;
  if (min <= 0) return ZERO.value;
  return `$${(min * PER_MIN).toFixed(2)}`;
}
/** The island's foot reading for a number of minutes, in the island's own format (`7.2 min · $0.36`). */
const reading = (min: number) => `${min.toFixed(1)} ${MIN_WORD} · ${dollars(min)}`;
if (reading(START) !== ISLAND.footMeter) throw new Error("Costs: the reading no longer matches the island's");

/**
 * Costs: drag the minutes of an open session (or use the arrow keys) and the cost follows at five cents a minute, up to
 * three dollars at the hour; the island's own foot at the top reads the same. Put it to sleep and the figure is $0 and
 * the slider rests: the voice costs nothing asleep. The blob talks while it is listening and sleeps when it is asleep.
 * The still is the island's own reading, 7.2 min and $0.36.
 */
export function Costs(): ReactElement {
  const [min, setMin] = useState(START);
  const [asleep, setAsleep] = useState(false);
  const [talking, setTalking] = useState(false);
  const quiet = useRef<number>(0);

  // The island reads the same: its foot carries the reading, and while the visitor drags it says it.
  useEffect(() => {
    const foot = reading(min);
    claim("costs", asleep ? { kind: "asleep" } : talking ? { kind: "speaking", line: foot, foot } : { kind: "listening", foot });
  }, [asleep, talking, min]);
  useEffect(() => () => window.clearTimeout(quiet.current), []);

  const onInput = (e: ChangeEvent<HTMLInputElement>) => {
    setMin(Number(e.target.value));
    setTalking(true);
    window.clearTimeout(quiet.current);
    quiet.current = window.setTimeout(() => setTalking(false), 700);
  };

  const fig = asleep ? ZERO.value : dollars(min);
  const style = { "--p": (min / 60).toFixed(4) } as CSSProperties;
  return (
    <div className="costs" data-asleep={asleep ? "" : undefined}>
      <Plate tone="--jh-listening" ax={0.06} ay={0.96}>
        <div className="costs-stage">
          <div className="costs-top">
            <Character phase={asleep ? "asleep" : talking ? "speaking" : "listening"} className="costs-char" />
            <div className="costs-fig">
              {/* not live (an <output> is a status by default): the range's own valuetext says the reading as it moves */}
              <output className="costs-dollars" htmlFor="costs-min" aria-live="off">
                {fig}
              </output>
              <span className="costs-what">{asleep ? ZERO.label : `${min.toFixed(1)} ${MIN_WORD}`}</span>
            </div>
          </div>
          <div className="costs-slider" style={style}>
            <input
              id="costs-min"
              type="range"
              min={0}
              max={60}
              step={0.1}
              value={min}
              disabled={asleep}
              onChange={onInput}
              aria-labelledby={HEAD_1}
              aria-valuetext={asleep ? `${ZERO.value} ${ZERO.label}` : reading(min)}
            />
            <div className="costs-ends" aria-hidden="true">
              <span>
                <b>{RATE.value}</b> {RATE.label}
              </span>
              <span>
                <b>{HOUR.value}</b> {HOUR.label}
              </span>
            </div>
          </div>
          <div className="seg" role="radiogroup" aria-labelledby={HEAD}>
            {(["listening", "asleep"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={(k === "asleep") === asleep}
                tabIndex={(k === "asleep") === asleep ? 0 : -1}
                className="seg-opt"
                onClick={() => setAsleep(k === "asleep")}
                onKeyDown={(e) => {
                  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
                    e.preventDefault();
                    setAsleep((a) => !a);
                    const sib = (e.currentTarget.nextElementSibling ?? e.currentTarget.previousElementSibling) as HTMLButtonElement | null;
                    sib?.focus();
                  }
                }}
              >
                <i className="seg-dot" data-kind={k} />
                {PHASES[k].word}
              </button>
            ))}
          </div>
        </div>
      </Plate>
    </div>
  );
}
