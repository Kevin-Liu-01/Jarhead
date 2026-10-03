"use client";
import SlackMark from "@thesvg/react/slack";
import SpotifyMark from "@thesvg/react/spotify";
import { animate, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { Icon } from "@/components/icons/Icon";
import { PHASES, THREADS } from "@/content/deck";
import { ISLAND } from "@/content/island";
import { RAIL_APP } from "@/content/rail";
import { after, aroundQuote, part, parts, quoted, row } from "@/lib/cut";
import { claim, type Show, type Tile } from "@/lib/live";
import { CUT, SPRING, SPRING_CHAR, useCalm, useFirstView, useSteps } from "@/lib/motion";
import type { Phase } from "@/lib/phase";
import { boxIn } from "@/lib/route";
import { Plate } from "./Plate";
import { Replay, StateWord, Utter, useKeepFocus } from "./parts";
import { Wires, type WireSet } from "./Wires";

type Main = "idle" | "hear" | "think" | "split";
type Slack = "off" | "working" | "asks" | "done" | "ended";
type Spot = "off" | "working" | "done";

const LINE = quoted(THREADS.lead, "Tell Ben on Slack I'm late and put on Focus on Spotify");
const STOP = quoted(THREADS.lines[2], "Stop the Slack one");
const SLACK_ROW = row(RAIL_APP.threads.rows, 0);
const SPOT_ROW = row(RAIL_APP.threads.rows, 1);
const [SLACK, SPOTIFY] = ISLAND.tiles;
/** The island's question without its head, its quoted line set in a <q> as the chips are. */
const ASK = aroundQuote(after(ISLAND.hero.speaking, `${ISLAND.headSpeaking}: `), "I'm running late");
/** The Slack card's foot once stopped: the Stop line, its spoken words in a <q>. */
const STOP_AT = aroundQuote(THREADS.lines[2], STOP);
const STOPPED = (
  <>
    {STOP_AT[0]}
    <q>{STOP_AT[1]}</q>
    {STOP_AT[2]}
  </>
);
/** The rail's meta for a thread, its step count left to the step bar under it: `00:06 · screen`. */
const metaOf = (meta: string): string => parts(meta).filter((p) => !/ steps$/.test(p)).join(" · ");
/** The step counts are the rows' own (`4 steps`, `2 steps`). */
const stepsOf = (meta: string): number => Number(/(\d+) steps/.exec(meta)?.[1] ?? 0);
const SLACK_N = stepsOf(SLACK_ROW.meta);
const SPOT_N = stepsOf(SPOT_ROW.meta);
/** The rail's words for a thread: working (the island's tile), asks, done, ended (a fold's summary). */
const WORKING = ISLAND.tileState;
const ENDED = part(row(RAIL_APP.agents.folds, 1).summary, "ended");
const ASKS = SLACK_ROW.status;
const DONE = SPOT_ROW.status;

const SLACK_PHASE: Record<Slack, Phase> = { off: "listening", working: "acting", asks: "speaking", done: "asleep", ended: "asleep" };
const SPOT_PHASE: Record<Spot, Phase> = { off: "listening", working: "acting", done: "asleep" };

/**
 * The fork at rest as the stage lays it out at 1440 (measured there once): the server's still, so the split reads without
 * JS; on hydration the demo measures its own.
 */
const AT_REST: WireSet = {
  view: [577, 406],
  joints: [],
  list: [
    { id: "a", lit: true, arrow: true, pts: [[46, 90.3], [46, 132]] },
    { id: "b", lit: true, arrow: true, pts: [[46, 90.3], [46, 111], [337.6, 111], [337.6, 132]] },
  ],
};

/** A thread's steps as the app's per-step bar: a segment each, filled as it runs, the speaking tone while it asks. */
function Steps({ n, at, asks }: { readonly n: number; readonly at: number; readonly asks: boolean }): ReactElement {
  return (
    <span className="thread-steps" data-asks={asks ? "" : undefined} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} data-on={i < at ? "" : undefined} />
      ))}
    </span>
  );
}

/**
 * Threads: say the Slack and Spotify line and the blob splits in two. Two thread blobs spring out of it along two wires
 * into their cards, each the app's thread: its mark, its rail meta, a bar per step, its state. Spotify runs its two steps
 * in the background and is done; Slack runs three on the screen and stops at `asks`, its question inside the card with
 * Allow (focused) and Deny, the island asking too; "Stop the Slack one" stops it without a model call. It plays once when
 * the plate first comes into view and rests there, on the question; the still (no JS, calm) is that moment.
 */
export function Threads(): ReactElement {
  const [main, setMain] = useState<Main>("split");
  const [slack, setSlack] = useState<Slack>("asks");
  const [slackAt, setSlackAt] = useState(SLACK_N - 1);
  const [spot, setSpot] = useState<Spot>("done");
  const [spotAt, setSpotAt] = useState(SPOT_N);
  const [stopped, setStopped] = useState(false);
  const [play, setPlay] = useState(0);
  const [wires, setWires] = useState<WireSet | null>(AT_REST);
  const calm = useCalm();
  const steps = useSteps();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const me = useRef<CharacterHandle>(null);
  const cards = useRef<Array<HTMLDivElement | null>>([null, null]);
  const kids = useRef<Array<CharacterHandle | null>>([null, null]);
  const allow = useRef<HTMLButtonElement>(null);
  const said = useRef<HTMLButtonElement>(null);
  const keep = useKeepFocus(root);

  const over = (slack === "done" || slack === "ended") && spot === "done";

  // The island with it: it hears, thinks, acts with the two thread tiles, asks the Slack question (its Allow and Deny
  // answer it, as the card's do), and listens again. The answer is this render's, taken when Slack turns to `asks`.
  useEffect(() => {
    let show: Show = { kind: "listening" };
    const tiles: Tile[] = [
      { name: SLACK, state: slack === "ended" ? "stopped" : slack === "asks" ? "asks" : slack === "done" ? "done" : "working" },
      { name: SPOTIFY, state: spot === "done" ? "done" : "working" },
    ];
    if (main === "hear") show = { kind: "listening", line: LINE };
    else if (main === "think") show = { kind: "thinking", line: LINE };
    else if (main === "split" && slack === "asks") show = { kind: "speaking", ask: true, answer: decide };
    else if (main === "split" && !over && slack !== "off") show = { kind: "acting", line: LINE, tiles };
    claim("threads", show);
  }, [main, slack, spot, over]);

  // The split: the two thread blobs leave the main blob's centre and spring to their cards, 60 ms apart.
  const pop = useCallback(() => {
    const m = me.current?.el;
    if (!m || calm) return;
    const mr = m.getBoundingClientRect();
    kids.current.forEach((k, i) => {
      const el = k?.el;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = mr.left + mr.width / 2 - (r.left + r.width / 2);
      const y = mr.top + mr.height / 2 - (r.top + r.height / 2);
      void animate(el, { x: [x, 0], y: [y, 0], scale: [0.3, 1], opacity: [0, 1] }, { ...SPRING_CHAR, delay: i * 0.06 });
    });
  }, [calm]);

  const say = useCallback(() => {
    steps.clear();
    setMain("hear");
    setSlack("off");
    setSpot("off");
    setSlackAt(0);
    setSpotAt(0);
    setStopped(false);
    setPlay((p) => p + 1);
    me.current?.nudge();
    steps.at(340, () => setMain("think"));
    steps.at(900, () => {
      setMain("split");
      setSlack("working");
      setSpot("working");
      me.current?.nudge();
      requestAnimationFrame(pop);
    });
    steps.at(1280, () => {
      setSpotAt(1);
      setSlackAt(1);
    });
    steps.at(1700, () => setSpotAt(2));
    steps.at(1860, () => setSpot("done"));
    steps.at(2000, () => setSlackAt(2));
    steps.at(2500, () => setSlackAt(3));
    steps.at(2760, () => {
      setSlack((s) => (s === "working" ? "asks" : s));
      kids.current[0]?.nudge();
    });
  }, [steps, pop]);

  // Once, when the plate first comes into view: the line is said and the route plays to the question. Calm keeps the still.
  useFirstView(root, say, calm);

  const decide = (yes: boolean) => {
    if (slack !== "asks") return;
    // The question leaves with the answer: focus stays on the Slack card it was asked in.
    keep(() => cards.current[0]);
    if (!yes) {
      setSlack("ended");
      kids.current[0]?.nudge();
      return;
    }
    setSlack("working");
    steps.at(640, () => {
      setSlackAt(SLACK_N);
      setSlack("done");
      kids.current[0]?.nudge();
    });
  };
  const stopSlack = () => {
    if (slack !== "working" && slack !== "asks") return;
    steps.clear();
    setSlack("ended");
    setStopped(true);
    kids.current[0]?.nudge();
    if (spot === "working") {
      steps.at(300, () => setSpotAt(SPOT_N));
      steps.at(420, () => setSpot("done"));
    }
  };

  // Focus follows the question: once Slack asks, a keyboard visitor lands on Allow.
  useEffect(() => {
    if (slack === "asks" && root.current?.contains(document.activeElement)) allow.current?.focus({ preventScroll: true });
  }, [slack]);

  // The fork, measured from the laid-out pieces: down from the main blob, along, and into each card above its own blob.
  const split = main === "split";
  useLayoutEffect(() => {
    const st = stage.current;
    if (!st) return;
    const measure = () => {
      if (getComputedStyle(st).getPropertyValue("--wired").trim() !== "1") return setWires(null);
      // Read where the pieces rest: a card mid-spring or a thread blob mid-split is measured without its transform.
      const moving = [...cards.current, ...kids.current.map((k) => k?.el ?? null)];
      const was = moving.map((el) => el?.style.transform ?? "");
      moving.forEach((el) => el?.style.setProperty("transform", "none"));
      const M = boxIn(st, me.current?.el ?? null);
      const A = boxIn(st, cards.current[0] ?? null);
      const B = boxIn(st, cards.current[1] ?? null);
      const a = boxIn(st, kids.current[0]?.el ?? null);
      const b = boxIn(st, kids.current[1]?.el ?? null);
      moving.forEach((el, i) => el?.style.setProperty("transform", was[i] ?? ""));
      if (!M || !A || !B || !a || !b) return setWires(null);
      const y0 = M.cy + (M.b - M.t) * 0.36 + 4;
      const jy = Math.round((y0 + A.t) / 2);
      // A thread blob within a few px of the main one's centre takes the straight drop; the other turns along the fork.
      const near = (x: number) => Math.abs(x - M.cx) < 10;
      const leg = (id: string, x: number, t: number, delay: number) =>
        near(x)
          ? { id, pts: [[M.cx, y0], [M.cx, t]] as const, arrow: true, lit: split, delay }
          : { id, pts: [[M.cx, y0], [M.cx, jy], [x, jy], [x, t]] as const, arrow: true, lit: split, delay };
      setWires({ list: [leg("a", a.cx, A.t, 0), leg("b", b.cx, B.t, 0.06)], joints: near(a.cx) || near(b.cx) ? [[M.cx, jy]] : [] });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(st);
    return () => ro.disconnect();
  }, [split]);

  const mainPhase: Phase = main === "think" ? "thinking" : main === "split" && !over && slack !== "asks" && slack !== "off" ? "acting" : "listening";
  const tr = calm ? CUT : SPRING;
  // A card's status is its live region: at `asks` it says the island's whole question, so the visitor hears what is asked.
  const badge = (s: Slack | Spot): ReactNode =>
    s === "asks" ? (
      <>
        <span className="badge" data-tone="speaking" aria-hidden="true">
          <Icon name="handPalm" size={12} />
          {ASKS}
        </span>
        <span className="sr-only">{ISLAND.hero.speaking}</span>
      </>
    ) : s === "working" ? (
      <span className="badge" data-tone="acting">
        {WORKING}
      </span>
    ) : s === "done" ? (
      <span className="badge">
        <Icon name="checkCircle" size={12} className="is-tone" />
        {DONE}
      </span>
    ) : s === "ended" ? (
      <span className="badge">{ENDED}</span>
    ) : null;
  const threads = [
    { id: "slack", name: SLACK, mark: <SlackMark className="mono-mark" width={16} height={16} aria-hidden="true" focusable="false" />, state: slack as Slack | Spot, meta: metaOf(SLACK_ROW.meta), n: SLACK_N, at: slackAt, phase: SLACK_PHASE[slack], feet: [THREADS.lines[0], STOPPED], foot: stopped ? 1 : 0 },
    { id: "spotify", name: SPOTIFY, mark: <SpotifyMark variant="mono" width={16} height={16} aria-hidden="true" focusable="false" />, state: spot as Slack | Spot, meta: metaOf(SPOT_ROW.meta), n: SPOT_N, at: spotAt, phase: SPOT_PHASE[spot], feet: [THREADS.lines[1]], foot: 0 },
  ] as const;
  return (
    <div ref={root} className="threads" data-main={main}>
      <Plate tone="--jh-acting" ax={0.5} ay={1.02}>
        <div ref={stage} className="threads-stage">
          {wires ? <Wires set={wires} play={play} calm={calm} /> : null}
          <div className="threads-said">
            <Character ref={me} phase={mainPhase} className="threads-char" />
            <div className="threads-line">
              <Utter buttonRef={said} words={LINE} onSay={say} saying={main === "hear"} />
              <StateWord>{PHASES[mainPhase === "thinking" ? "thinking" : mainPhase === "acting" ? "acting" : "listening"].word}</StateWord>
            </div>
          </div>
          <div className="threads-lanes">
            {threads.map((t, i) => (
              <motion.div
                key={t.id}
                ref={(el: HTMLDivElement | null) => {
                  cards.current[i] = el;
                }}
                className="sheet thread"
                data-state={t.state}
                aria-label={t.name}
                role="group"
                tabIndex={t.id === "slack" ? -1 : undefined}
                initial={false}
                animate={t.state === "off" ? { opacity: 0.32, y: 8 } : { opacity: 1, y: 0 }}
                transition={calm ? CUT : { ...SPRING, delay: i * 0.06 }}
              >
                <div className="thread-head">
                  <Character
                    ref={(h) => {
                      kids.current[i] = h;
                    }}
                    phase={t.phase}
                    face={t.state === "done" ? "^^" : null}
                    className="thread-char"
                  />
                  <div className="thread-who">
                    <span className="thread-name">
                      {t.mark}
                      {t.name}
                      <span className="thread-status" aria-live="polite">
                        {badge(t.state)}
                      </span>
                    </span>
                    <span className="thread-meta">{t.meta}</span>
                    <Steps n={t.n} at={t.at} asks={t.state === "asks"} />
                  </div>
                </div>
                {t.id === "slack" ? (
                  // The question keeps its place in every state, so the card, the plate and the section never change
                  // height: it fades where it stands, and out of turn it is hidden and inert.
                  <motion.div className="thread-ask" data-off={slack === "asks" ? undefined : ""} inert={slack !== "asks"} initial={false} animate={{ opacity: slack === "asks" ? 1 : 0 }} transition={tr}>
                    <p>
                      <Icon name="handPalm" size={16} />
                      <span>
                        {ASK[0]}
                        <q>{ASK[1]}</q>
                        {ASK[2]}
                      </span>
                    </p>
                    <div className="thread-btns">
                      <button ref={allow} type="button" className="kit-btn kit-btn--primary kit-btn--lg" onClick={() => decide(true)}>
                        {ISLAND.allow}
                      </button>
                      <button type="button" className="kit-btn kit-btn--ghost kit-btn--lg" onClick={() => decide(false)}>
                        {ISLAND.deny}
                      </button>
                    </div>
                  </motion.div>
                ) : null}
                {/* every foot the card can show is laid in one cell, so the card keeps the height of the longest */}
                <p className="thread-foot">
                  {t.feet.map((f, k) => (
                    <span key={k} data-off={k === t.foot ? undefined : ""}>
                      {f}
                    </span>
                  ))}
                </p>
              </motion.div>
            ))}
          </div>
          <div className="threads-stop">
            <Utter words={STOP} onSay={stopSlack} disabled={slack !== "working" && slack !== "asks"} />
          </div>
        </div>
        {over ? (
          <Replay
            onClick={() => {
              keep(() => said.current);
              say();
            }}
            className="plate-replay"
          />
        ) : null}
      </Plate>
    </div>
  );
}
