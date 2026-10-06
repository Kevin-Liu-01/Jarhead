"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import { Icon, type IconName } from "@/components/icons/Icon";
import { NUMBERS } from "@/content/deck";
import { part, row } from "@/lib/cut";
import { claim } from "@/lib/live";
import { onScreenNow, useCalm, useInView } from "@/lib/motion";
import { Plate } from "./Plate";
import { Replay, useKeepFocus } from "./parts";

/** A deck latency (`126 ms`, `1.11 s`) in milliseconds; anything else is a build error, so a bar never drifts from the deck. */
function toMs(value: string): number {
  const m = /^([\d.]+) (ms|s)$/.exec(value);
  if (!m) throw new Error(`not a latency: ${value}`);
  return Number(m[1]) * (m[2] === "s" ? 1000 : 1);
}

interface Row {
  readonly value: string;
  readonly label: string;
  readonly ms: number;
  readonly n: string | null;
  readonly icon: IconName;
  readonly digits: number;
}
const rowOf = (f: { readonly value: string; readonly label: string; readonly tip: string }, icon: IconName): Row => {
  const n = /n = \d+/.exec(f.tip)?.[0];
  const dec = /\.(\d+) s$/.exec(f.value)?.[1]?.length ?? 0;
  return { value: f.value, label: f.label, ms: toMs(f.value), n: n ? part(f.tip, n) : null, icon, digits: dec };
};

/** The six latencies, fastest first: the reflex's three, the voice's reply, the model's two. */
const ROWS: readonly Row[] = [
  rowOf(NUMBERS.display, "lightning"),
  rowOf(row(NUMBERS.figures, 0), "lightning"),
  rowOf(row(NUMBERS.figures, 1), "lightning"),
  rowOf(row(NUMBERS.figures, 2), "speakerHigh"),
  rowOf(row(NUMBERS.figures, 3), "brain"),
  rowOf(row(NUMBERS.figures, 4), "brain"),
];
/** Two honest linear scales, each ending on a deck value: the slowest row (all of them to size), and the reflex's slowest (its three race; the rest run off the edge). */
type Scale = "full" | "reflex";
const END: Record<Scale, Row> = { full: row(ROWS, 5), reflex: row(ROWS, 2) };
if (END.full.ms !== Math.max(...ROWS.map((r) => r.ms))) throw new Error("Numbers: the full scale must end on its slowest row");
const SCALES: readonly Scale[] = ["full", "reflex"];

/** A running count in the row's own unit and precision. */
function counting(r: Row, t: number): string {
  if (t >= r.ms) return r.value;
  return r.value.endsWith(" ms") ? `${Math.floor(t)} ms` : `${(t / 1000).toFixed(r.digits)} s`;
}

/**
 * Numbers: the latencies race in real time on one honest linear scale. When the plate comes into view a clock starts at
 * zero and every bar grows at the speed of time: the reflex's three are done before the eye arrives, the voice replies in a
 * second, the model takes its 4.5 and 9.0 seconds. A running count rides each bar's head; the deck figure and its n light
 * at the row's end when the bar lands, every figure on one right edge with its n in a column of its own. The scale is the
 * visitor's and sits at the axis end it sets: 9.0 s shows all six to size, 457 ms zooms into the reflex rows so they
 * visibly race and the slower rows run off the edge. The clock runs only while the plate is on screen and
 * writes each bar's progress to a CSS property (a scaleX), so nothing re-renders per frame; Replay runs it again. The
 * still is the finished race at the full scale.
 */
export function Numbers(): ReactElement {
  const [run, setRun] = useState(0);
  const [done, setDone] = useState(true);
  const [scale, setScale] = useState<Scale>("full");
  const calm = useCalm();
  const root = useRef<HTMLDivElement>(null);
  const tracks = useRef<Array<HTMLDivElement | null>>([]);
  const nows = useRef<Array<HTMLElement | null>>([]);
  const opts = useRef<Array<HTMLButtonElement | null>>([]);
  const clock = useRef<{ t: number; last: number; raf: number }>({ t: END.full.ms, last: 0, raf: 0 });
  const span = useRef(END.full.ms);
  const inView = useInView(root, 0.4);
  const armed = useRef(false);
  const keep = useKeepFocus(root);

  useEffect(() => {
    claim("numbers", { kind: "listening" });
  }, []);

  const paint = useCallback((t: number) => {
    ROWS.forEach((r, i) => {
      const el = tracks.current[i];
      if (!el) return;
      const p = Math.min(t, r.ms) / span.current;
      el.style.setProperty("--p", Math.min(1, p).toFixed(5));
      el.toggleAttribute("data-over", p > 1);
      const v = nows.current[i];
      if (v) {
        const txt = counting(r, t);
        if (v.textContent !== txt) v.textContent = txt;
      }
      el.parentElement?.toggleAttribute("data-landed", t >= r.ms);
    });
  }, []);

  // A page opened elsewhere arms the race from zero; a page opened here keeps the finished still.
  useEffect(() => {
    if (onScreenNow(root.current) || calm) return;
    clock.current.t = 0;
    armed.current = true;
    setDone(false);
    paint(0);
  }, [calm, paint]);

  // Replay leaves with the press: focus goes to the scale, the plate's first control.
  const replay = () => {
    keep(() => opts.current[SCALES.indexOf(scale)]);
    clock.current.t = 0;
    armed.current = true;
    setDone(false);
    paint(0);
    setRun((n) => n + 1);
  };

  const pick = (k: Scale) => {
    setScale(k);
    span.current = END[k].ms;
    paint(clock.current.t);
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + SCALES.length) % SCALES.length;
    const k = SCALES[n];
    if (!k) return;
    pick(k);
    opts.current[n]?.focus();
  };

  // The clock: it advances only while the plate is in view and the tab is visible.
  useEffect(() => {
    const c = clock.current;
    if (calm) {
      c.t = END.full.ms;
      paint(c.t);
      setDone(true);
      return;
    }
    if (!inView || !armed.current) return;
    const tick = (now: number) => {
      c.raf = 0;
      if (document.hidden) {
        c.last = 0;
      } else {
        c.t += c.last ? now - c.last : 0;
        c.last = now;
      }
      paint(c.t);
      if (c.t >= END.full.ms) {
        armed.current = false;
        setDone(true);
        return;
      }
      c.raf = requestAnimationFrame(tick);
    };
    c.last = 0;
    c.raf = requestAnimationFrame(tick);
    return () => {
      if (c.raf) cancelAnimationFrame(c.raf);
      c.raf = 0;
      c.last = 0;
    };
  }, [inView, run, calm, paint]);

  return (
    <div ref={root} className="numbers" data-scale={scale}>
      <Plate tone="--jh-connecting" ax={0.98} ay={0.5}>
        <ol className="race" role="list">
          {ROWS.map((r, i) => (
            <li key={r.value} className="race-row" data-landed="">
              <span className="race-label">
                <Icon name={r.icon} size={16} />
                {r.label}
              </span>
              <div
                ref={(el) => {
                  tracks.current[i] = el;
                }}
                className="race-track"
                style={{ "--p": (r.ms / END.full.ms).toFixed(5) } as CSSProperties}
                aria-hidden="true"
              >
                <i />
                <span className="race-head">
                  <b
                    ref={(el) => {
                      nows.current[i] = el;
                    }}
                    className="race-now"
                  >
                    {r.value}
                  </b>
                </span>
              </div>
              <span className="race-val">
                <span className="race-fig">{r.value}</span>
                <span className="race-n">{r.n}</span>
              </span>
            </li>
          ))}
        </ol>
        <div className="race-axis">
          <div className="seg" role="radiogroup" aria-label={NUMBERS.name}>
            {SCALES.map((k, i) => (
              <button
                key={k}
                ref={(el) => {
                  opts.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={scale === k}
                tabIndex={scale === k ? 0 : -1}
                className="seg-opt"
                onClick={() => pick(k)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {END[k].value}
              </button>
            ))}
          </div>
        </div>
        {done ? <Replay onClick={replay} className="plate-replay" /> : null}
      </Plate>
    </div>
  );
}
