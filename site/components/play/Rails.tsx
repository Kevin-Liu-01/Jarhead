"use client";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Character, type CharacterHandle } from "@/components/desk/Character";
import { Icon, type IconName } from "@/components/icons/Icon";
import { RAILS, SAY } from "@/content/deck";
import { nth, part, quoted, row } from "@/lib/cut";
import { claim, type Show } from "@/lib/live";
import { CUT, SPRING, ease, useCalm, useFirstView, useSteps } from "@/lib/motion";
import { boxIn, type Pt } from "@/lib/route";
import { Plate } from "./Plate";
import { Replay, useKeepFocus } from "./parts";
import { Wires, type WireSet } from "./Wires";

type Verdict = "run" | "confirm" | "refuse";

interface Call {
  readonly id: string;
  readonly text: string;
  readonly verdict: Verdict;
  readonly icon?: IconName;
  /** How it is set: spoken (the voice), a verb (Inter), a command (mono). */
  readonly kind: "spoken" | "verb" | "cmd";
}

const NEVER_LINE = RAILS.never.line;
const CLICK_SAVE = quoted(SAY.lines[0], "Click Save");
/** Every call the tray holds: the reflex's spoken line, the five verbs that always ask, three of the seven that never run. */
const CALLS: readonly Call[] = [
  { id: "save", text: CLICK_SAVE, verdict: "run", icon: "cursorClick", kind: "spoken" },
  { id: "send", text: part(NEVER_LINE, "Send"), verdict: "confirm", icon: "paperPlaneTilt", kind: "verb" },
  { id: "pay", text: part(NEVER_LINE, "pay"), verdict: "confirm", icon: "creditCard", kind: "verb" },
  { id: "delete", text: part(NEVER_LINE, "delete"), verdict: "confirm", icon: "trash", kind: "verb" },
  { id: "post", text: part(NEVER_LINE, "post"), verdict: "confirm", icon: "megaphoneSimple", kind: "verb" },
  { id: "purchase", text: part(NEVER_LINE, "purchase"), verdict: "confirm", icon: "shoppingCartSimple", kind: "verb" },
  { id: "mkfs", text: row(RAILS.never.items, 0), verdict: "refuse", kind: "cmd" },
  { id: "erase", text: row(RAILS.never.items, 1), verdict: "refuse", kind: "cmd" },
  { id: "shutdown", text: row(RAILS.never.items, 3), verdict: "refuse", kind: "cmd" },
];
const BY_TEXT = new Map(CALLS.map((c) => [c.text, c]));

/** "Click Save" runs. (the Run row's sentence, its call the slot) */
const RUNS = nth(SAY.lines[0], 0);
const RUNS_TAIL = RUNS.slice(`"${CLICK_SAVE}"`.length);
if (!RUNS.startsWith(`"${CLICK_SAVE}"`)) throw new Error("Rails: the Run sentence no longer starts with the call");

/**
 * The three verdicts, cut from the h2's second line, where they are lowercase (.rail-word capitalises them): the word,
 * the icon, the tag, the row's own reason (always on the table, lit with its row) and what the blob says when a call
 * lands (a second deck line, so nothing is said twice). A refused call is not talked over: its command lights in NEVER
 * and the blob frowns.
 */
const ROWS: ReadonlyArray<{ readonly id: Verdict; readonly word: string; readonly icon: IconName; readonly tag?: string; readonly why?: string; readonly said?: string }> = [
  { id: "run", word: part(RAILS.lead, "run"), icon: "playCircle", said: nth(SAY.lines[0], 1) },
  { id: "confirm", word: part(RAILS.lead, "confirm"), icon: "handPalm", tag: part(NEVER_LINE, "ask every time"), why: nth(NEVER_LINE, 1), said: RAILS.lines[0] },
  { id: "refuse", word: part(RAILS.lead, "refuse"), icon: "prohibit", tag: RAILS.never.label },
];
const EVERY_CALL = part(RAILS.lead, "Every call");
/** The call the demo sorts by itself when the plate first comes into view, and the still it rests on. */
const FIRST = "send";

/**
 * A call as a chip: in the tray it waits; sorted, it sits lit in its verdict's row. One layout id, so it springs across; a
 * new node each side, so focus finds it again by its `data-id`.
 */
function Chip({ call, onClick, calm, placed }: { readonly call: Call; readonly onClick: () => void; readonly calm: boolean; readonly placed: boolean }): ReactElement {
  return (
    <motion.button layoutId={`rail-${call.id}`} layout="position" type="button" className="rail-chip" data-id={call.id} data-kind={call.kind} data-placed={placed ? "" : undefined} aria-pressed={placed} onClick={onClick} transition={calm ? CUT : SPRING}>
      {call.icon ? <Icon name={call.icon} size={16} /> : null}
      {call.kind === "spoken" ? <q>{call.text}</q> : call.kind === "cmd" ? <code>{call.text}</code> : <span>{call.text}</span>}
    </motion.button>
  );
}

/**
 * Rails: one policy table you sort by hand. The table always shows what it holds: Run ends on "Click Save" runs.; Confirm
 * lists send, pay, delete, post and purchase with their icons and asks every time; Refuse lists NEVER's seven commands.
 * Press a call in the tray and it springs into its slot in the table, a wire draws down the rail into its row, the row
 * lights and the blob speaks the reason (a refused call earns a frown, its command lit in NEVER). Press a sorted call to
 * send it back. It sorts Send by itself once when the plate first comes into view; the still is that moment.
 */
export function Rails(): ReactElement {
  const [placed, setPlaced] = useState<Record<string, boolean>>({ [FIRST]: true });
  const [last, setLast] = useState<Call | null>(BY_TEXT.get(part(NEVER_LINE, "Send")) ?? null);
  const [play, setPlay] = useState(0);
  const [wires, setWires] = useState<WireSet | null>(null);
  const calm = useCalm();
  const steps = useSteps();
  const root = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const rows = useRef<Partial<Record<Verdict, HTMLDivElement | null>>>({});
  const ch = useRef<CharacterHandle>(null);
  const keep = useKeepFocus(root);

  // The island with it: a run acts, a send asks its own question, the other verbs say their reason, a refusal listens on.
  useEffect(() => {
    let show: Show = { kind: "listening" };
    if (last?.verdict === "run") show = { kind: "acting", line: CLICK_SAVE };
    else if (last?.verdict === "confirm") show = last.id === "send" ? { kind: "speaking", ask: true } : { kind: "speaking", line: RAILS.lines[0] };
    claim("rails", show);
  }, [last]);

  const now = useRef(placed);
  now.current = placed;
  const toggle = useCallback((c: Call) => {
    const going = !now.current[c.id];
    now.current = { ...now.current, [c.id]: going };
    setPlaced(now.current);
    if (going) {
      setLast(c);
      setPlay((n) => n + 1);
      ch.current?.nudge();
    } else setLast((l) => (l?.id === c.id ? null : l));
  }, []);
  const reset = useCallback(() => {
    steps.clear();
    now.current = {};
    setPlaced({});
    setLast(null);
  }, [steps]);
  // A pressed chip leaves its place for the other side: focus follows it there; Replay hands focus to the tray's first.
  const chipIn = (sel: string) => () => root.current?.querySelector<HTMLElement>(sel);
  const press = (c: Call) => {
    keep(chipIn(`.rail-chip[data-id="${c.id}"]`));
    toggle(c);
  };
  const replay = () => {
    keep(chipIn(".rails-tray .rail-chip"));
    reset();
  };

  // Once, when the plate first comes into view: the table empties into the tray and Send is sorted into Confirm.
  const firstView = useCallback(() => {
    reset();
    const send = CALLS.find((c) => c.id === FIRST);
    if (send) steps.at(520, () => toggle(send));
  }, [reset, steps, toggle]);
  useFirstView(root, firstView, calm);

  // The rail down the left of the table: quiet, with a spur into each row; the lit way draws down it into the row a call
  // lands in. Measured from the laid-out rows.
  const lit = last?.verdict ?? null;
  useLayoutEffect(() => {
    const tb = table.current;
    if (!tb) return;
    const measure = () => {
      const R = (["run", "confirm", "refuse"] as const).map((v) => boxIn(tb, rows.current[v] ?? null));
      if (R.some((b) => !b)) return setWires(null);
      const x = 9;
      const ys = R.map((b) => (b ? b.t + 26 : 0));
      const end = ys[2] ?? 0;
      const into = (v: Verdict) => (R[["run", "confirm", "refuse"].indexOf(v)]?.l ?? 24) - 2;
      const list = [
        { id: "rail", pts: [[x, 0], [x, end]] as Pt[] },
        ...(["run", "confirm", "refuse"] as const).map((v, i) => ({ id: `spur-${v}`, pts: [[x, ys[i] ?? 0], [into(v), ys[i] ?? 0]] as Pt[] })),
        ...(lit ? [{ id: `lit-${lit}`, pts: [[x, 0], [x, ys[["run", "confirm", "refuse"].indexOf(lit)] ?? 0], [into(lit), ys[["run", "confirm", "refuse"].indexOf(lit)] ?? 0]] as Pt[], lit: true, arrow: true }] : []),
      ];
      setWires({ list, joints: ys.map((y) => [x, y] as Pt) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tb);
    return () => ro.disconnect();
  }, [lit]);

  /** A slot in the table: the call's chip when it has been sorted, else its quiet word. */
  const slot = (c: Call | undefined, quiet: ReactNode): ReactNode =>
    c && placed[c.id] ? <Chip key={c.id} call={c} onClick={() => press(c)} calm={calm} placed /> : <span className="rail-quiet">{quiet}</span>;

  const tray = CALLS.filter((c) => !placed[c.id]);
  const any = CALLS.some((c) => placed[c.id]);
  const reason = lit ? ROWS.find((r) => r.id === lit)?.said : undefined;
  const save = CALLS[0];
  return (
    <div ref={root} className="rails" data-last={lit ?? undefined}>
      <Plate tone="--jh-speaking" ax={0.04} ay={0.04}>
        <LayoutGroup>
          <div className="rails-stage">
            <div className="rails-top">
              <Character ref={ch} phase={lit === "refuse" ? "listening" : lit ? "speaking" : "listening"} face={lit === "refuse" ? "><" : null} className="rails-char" />
              <div className="rails-say" aria-live="polite">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={`${lit ?? "none"}-${last?.id ?? ""}`}
                    className="rails-reason"
                    data-spoken={reason ? "" : undefined}
                    initial={calm ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={calm ? CUT : ease("base")}
                  >
                    {reason ?? (lit === "refuse" && last ? (
                      <>
                        <span className="tag">{RAILS.never.label}</span>
                        <code>{last.text}</code>
                      </>
                    ) : (
                      EVERY_CALL
                    ))}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>
            <div className="rails-tray" aria-label={EVERY_CALL} role="group">
              {tray.map((c) => (
                <Chip key={c.id} call={c} onClick={() => press(c)} calm={calm} placed={false} />
              ))}
            </div>
            <div ref={table} className="rails-table">
              {wires ? <Wires set={wires} play={play} calm={calm} /> : null}
              {ROWS.map((r) => (
                <div
                  key={r.id}
                  ref={(el) => {
                    rows.current[r.id] = el;
                  }}
                  className="sheet rail-row"
                  data-verdict={r.id}
                  data-lit={lit === r.id ? "" : undefined}
                  role="group"
                  aria-label={r.word.charAt(0).toUpperCase() + r.word.slice(1)}
                >
                  <div className="rail-head">
                    <Icon name={r.icon} size={20} />
                    <span className="rail-word">{r.word}</span>
                    {r.tag ? <span className="tag">{r.tag}</span> : null}
                  </div>
                  <div className="rail-body">
                    {r.id === "run" ? (
                      <p className="rail-runs">
                        {slot(save, <q>{CLICK_SAVE}</q>)}
                        {RUNS_TAIL}
                      </p>
                    ) : null}
                    {r.id === "confirm" ? (
                      <>
                        <div className="rail-verbs">
                          {CALLS.filter((c) => c.verdict === "confirm").map((c) => (
                            <span key={c.id} className="rail-slot">
                              {slot(
                                c,
                                <>
                                  {c.icon ? <Icon name={c.icon} size={16} /> : null}
                                  {c.text}
                                </>,
                              )}
                            </span>
                          ))}
                        </div>
                        <p className="rail-why">{ROWS[1]?.why}</p>
                      </>
                    ) : null}
                    {r.id === "refuse" ? (
                      <ul className="rail-never" role="list">
                        {RAILS.never.items.map((it) => (
                          <li key={it} className="rail-slot">
                            {slot(BY_TEXT.get(it), <code>{it}</code>)}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </LayoutGroup>
        {any ? <Replay onClick={replay} className="plate-replay" /> : null}
      </Plate>
    </div>
  );
}
