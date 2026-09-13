import { test } from "node:test";
import assert from "node:assert/strict";
import { FiredReflexes, parseReflex, type Reflex, type ReflexOutcome } from "@jarhead/brain";
import { EarReflexes, type ReflexLedgerRow } from "../ear.ts";

/**
 * The ear's matcher on its own: partials become a fired reflex once unambiguous
 * (final at once, terminal tail at once, otherwise after the stability window),
 * only the words not yet acted on are judged, a mid-command pause does not fire a
 * command that grows into a compound, "stop" is forwarded, and dictation splits
 * the words at its commands.
 */

interface Harness {
  ear: EarReflexes;
  ran: { label: string; phrase: string; at: number }[];
  rows: ReflexLedgerRow[];
  stops: number;
  dictation: { active: boolean; typed: string[]; newlines: number[]; deletes: number; stopped: string[] };
  clock: { t: number };
  fired: FiredReflexes;
}

function harness(opts: { enabled?: boolean | (() => boolean); stableMs?: number; carefulMs?: number; dropped?: string; dictationStableMs?: number; suppressed?: () => string | undefined } = {}): Harness {
  const clock = { t: 1_000_000 };
  const fired = new FiredReflexes(() => clock.t);
  const h: Harness = { ear: undefined as unknown as EarReflexes, ran: [], rows: [], stops: 0, dictation: { active: false, typed: [], newlines: [], deletes: 0, stopped: [] }, clock, fired };
  h.ear = new EarReflexes({
    now: () => clock.t,
    enabled: () => (typeof opts.enabled === "function" ? opts.enabled() : opts.enabled ?? true),
    ...(opts.suppressed ? { suppressed: opts.suppressed } : {}),
    match: (u) => (h.dictation.active ? undefined : parseReflex(u)),
    run: async (reflex: Reflex, phrase: string): Promise<ReflexOutcome & { dropped?: string }> => {
      h.ran.push({ label: reflex.label, phrase, at: clock.t });
      if (reflex.kind === "dictate_start") h.dictation.active = true;
      if (reflex.kind === "dictate_stop") h.dictation.active = false;
      if (opts.dropped) return { reflex, result: { kind: "error", message: opts.dropped }, ms: 0, ok: false, dropped: opts.dropped };
      return { reflex, result: { kind: "text", text: "OK" }, ms: 3, ok: true, dispatchedAt: clock.t };
    },
    onStop: () => void h.stops++,
    dictation: {
      active: () => h.dictation.active,
      start: () => (h.dictation.active = true),
      stop: (reason) => {
        h.dictation.active = false;
        h.dictation.stopped.push(reason);
      },
      type: async (text) => {
        h.dictation.typed.push(text);
        return true;
      },
      newline: async (n) => void h.dictation.newlines.push(n),
      deleteWord: async () => void h.dictation.deletes++,
    },
    fired,
    ledger: (row) => h.rows.push(row),
    // Short windows for the tests: 30 ms for the prefire kinds, 60 ms for the careful ones (120 / 450 in production).
    stableMs: opts.stableMs ?? 30,
    carefulMs: opts.carefulMs ?? 60,
    ...(opts.dictationStableMs !== undefined ? { dictationStableMs: opts.dictationStableMs } : {}),
  });
  return h;
}

const tick = (ms = 45): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("ear: a final fires at once, a terminal tail fires at once, a plain partial waits for the stability window and fires once; the ledger row carries the timing chain", async () => {
  const h = harness();
  h.ear.hear("scroll down", true, 1, 999_900);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down"], "final: immediate");
  assert.equal(h.rows.length, 1);
  assert.deepEqual([h.rows[0]!.fired, h.rows[0]!.earAt, h.rows[0]!.phrase, h.rows[0]!.action, h.rows[0]!.ok], ["final", 999_900, "scroll down", "scroll down", true]);
  assert.ok(h.rows[0]!.matchedAt >= h.rows[0]!.earAt && h.rows[0]!.dispatchedAt >= h.rows[0]!.matchedAt && h.rows[0]!.doneAt >= h.rows[0]!.dispatchedAt);

  // A new segment: "press enter please" ends terminally → no wait.
  h.ear.hear("press enter please", false, 2, 1_000_100);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down", "press enter"]);
  assert.equal(h.rows[1]!.fired, "terminal");

  // A plain partial: nothing until the window; then once, and the repeat of the same partial does not fire again.
  // "select all" is a careful kind (⌘A is not reversible): the longer window, not the short one.
  h.ear.hear("select all", false, 3, 1_000_200);
  await tick(45);
  assert.equal(h.ran.length, 2, "not yet: the partial may still grow (the short window has passed, the careful one has not)");
  await tick(45);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down", "press enter", "select all"]);
  assert.equal(h.rows[2]!.fired, "stable");
  h.ear.hear("select all", false, 3, 1_000_300);
  h.ear.hear("select all", true, 3, 1_000_320);
  await tick(50);
  assert.equal(h.ran.length, 3, "the words were consumed; the final for them fires nothing more");
  assert.equal(h.fired.recent().length, 3);
});

test("ear: a partial that grows into a compound is never fired on the prefix; a non-command final is left behind and the next words start fresh", async () => {
  const h = harness();
  h.ear.hear("scroll down", false, 1, 1);
  await tick(10);
  h.ear.hear("scroll down to the", false, 1, 2); // grew before the window: the timer resets, and the compound is not a reflex
  await tick(50);
  h.ear.hear("scroll down to the footer", true, 1, 3);
  await tick(10);
  assert.equal(h.ran.length, 0, "nothing scrolled: the brain gets the whole sentence");
  // The next segment's words are judged on their own.
  h.ear.hear("press escape", true, 2, 4);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["press escape"]);
});

test("ear: within one segment, words already acted on are not re-judged; the recogniser's leading filler and the wake word are ignored; a silence gap leaves stale words behind", async () => {
  const h = harness();
  h.ear.hear("hey jarhead scroll down", true, 1, 1);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down"]);
  // The same segment keeps growing (the on-device recogniser accumulates for ~50 s); only the new words count.
  h.ear.hear("hey jarhead scroll down um press enter", false, 1, 2);
  await tick(90);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down", "press enter"]);
  // Words that were not a command, then a long silence, then a command: the stale words do not prefix it.
  h.ear.hear("hey jarhead scroll down um press enter what a nice day", false, 1, 3);
  await tick(50);
  assert.equal(h.ran.length, 2);
  h.clock.t += 2000;
  h.ear.hear("hey jarhead scroll down um press enter what a nice day zoom in", true, 1, 4);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down", "press enter", "zoom in"]);
});

test("ear: \"stop\" is forwarded at once; a dropped reflex (the policy wanted a question) is on the ledger but not remembered as done", async () => {
  const h = harness({ dropped: "needs confirmation" });
  h.ear.hear("stop", false, 1, 1);
  await tick(5);
  assert.equal(h.stops, 1, "stop needs no stability window");
  h.ear.hear("click send", true, 2, 2);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["click send"]);
  assert.equal(h.rows[0]!.ok, false);
  assert.equal(h.rows[0]!.dropped, "needs confirmation");
  assert.equal(h.fired.recent().length, 0, "a dropped reflex must not make the delegation 'already done'");
});

test("ear: switched off nothing fires; a matched partial whose window ends after the switch-off does not fire either", async () => {
  let on = true;
  const clock = { t: 5 };
  const ran: string[] = [];
  const ear = new EarReflexes({
    now: () => clock.t,
    enabled: () => on,
    match: (u) => parseReflex(u),
    run: async (reflex) => {
      ran.push(reflex.label);
      return { reflex, result: { kind: "text", text: "OK" }, ms: 0, ok: true };
    },
    onStop: () => undefined,
    dictation: { active: () => false, start: () => undefined, stop: () => undefined, type: async () => true, newline: async () => undefined, deleteWord: async () => undefined },
    fired: new FiredReflexes(() => clock.t),
    stableMs: 30,
  });
  ear.hear("scroll down", false, 1, 1);
  on = false;
  await tick(50);
  assert.deepEqual(ran, []);
  ear.hear("scroll up", true, 2, 2);
  await tick(5);
  assert.deepEqual(ran, []);
});

test("ear: dictation — words are typed with a trailing space on the final (or a long-stable partial), commands split them, \"stop dictating\" ends it, and while dictating a command word is text", async () => {
  const h = harness({ dictationStableMs: 40 });
  h.ear.hear("start dictating", true, 1, 1);
  await tick(5);
  assert.equal(h.dictation.active, true);
  // Finals are typed at once; "new line" and "delete that" are commands inside the words.
  h.ear.hear("start dictating dear ana thanks for the notes new line see you tomorrow", true, 1, 2);
  await tick(10);
  assert.deepEqual(h.dictation.typed, ["dear ana thanks for the notes ", "see you tomorrow "]);
  assert.deepEqual(h.dictation.newlines, [1]);
  // A partial that stays put long enough is typed too; "scroll down" is text while dictating, not a command.
  h.ear.hear("scroll down the hill", false, 2, 3);
  await tick(60);
  assert.deepEqual(h.dictation.typed.slice(2), ["scroll down the hill "]);
  assert.equal(h.ran.length, 1, "no reflex ran while dictating");
  h.ear.hear("scroll down the hill wait delete that new paragraph stop dictating", true, 2, 4);
  await tick(10);
  assert.deepEqual(h.dictation.typed.slice(3), ["wait "]);
  assert.equal(h.dictation.deletes, 1);
  assert.deepEqual(h.dictation.newlines, [1, 2]);
  assert.equal(h.dictation.active, false);
  assert.deepEqual(h.dictation.stopped, ["said"]);
  // Back to commands.
  h.ear.hear("zoom in", true, 3, 5);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label).slice(1), ["zoom in"]);
});

test("ear: a careful kind never fires on a prefix that is merely waiting for the next recogniser tick — \"copy\" of \"copy this file to the desktop\", \"type hello\" of \"type hello world\", \"undo\" of \"undo the last commit\" — while a prefire kind still fires after the short window", async () => {
  const h = harness({ stableMs: 30, carefulMs: 120 });
  // Partials 40 ms apart, as the recogniser lands word groups: shorter than the careful window, longer than the short one.
  h.ear.hear("copy", false, 1, 1);
  await tick(40);
  h.ear.hear("copy this file", false, 1, 2);
  await tick(40);
  h.ear.hear("copy this file to the desktop", false, 1, 3);
  await tick(140);
  assert.equal(h.ran.length, 0, "⌘C was never pressed");
  h.ear.hear("type hello", false, 2, 4);
  await tick(40);
  h.ear.hear("type hello world", false, 2, 5);
  await tick(140);
  assert.deepEqual(h.ran.map((r) => r.label), ["type hello world"], "typed once, the whole text");
  h.ear.hear("undo", false, 3, 6);
  await tick(40);
  h.ear.hear("undo the last commit in the terminal", false, 3, 7);
  await tick(140);
  assert.equal(h.ran.length, 1, "no ⌘Z");
  // A prefire kind on the same cadence fires after the short window: the scroll is reversible and the compound is excluded by the grammar anyway.
  h.ear.hear("scroll down", false, 4, 8);
  await tick(45);
  assert.deepEqual(h.ran.map((r) => r.label).slice(1), ["scroll down"]);
  // A careful kind that Kevin actually stops at fires once the window passes.
  h.ear.hear("press enter", false, 5, 9);
  await tick(140);
  assert.deepEqual(h.ran.map((r) => r.label).slice(2), ["press enter"]);
  assert.equal(h.rows.at(-1)!.fired, "stable");
});

test("ear: \"right click save\" is not \"click save\" — the leading word is a command of its own, not filler; \"um click save\" still is", async () => {
  const h = harness();
  h.ear.hear("right click save", true, 1, 1);
  await tick(5);
  assert.equal(h.ran.length, 0, "no left click for a right click");
  h.ear.hear("um, click save", true, 2, 2);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["click save"]);
});

test("ear: quiesce (a stop or a pause) keeps the segment with its words consumed — the recogniser's late final for the same words fires nothing, a shortened revision fires nothing, and the words said after it are judged on their own", async () => {
  const h = harness();
  h.ear.hear("type hello", false, 7, 1);
  await tick(90);
  assert.deepEqual(h.ran.map((r) => r.label), ["type hello"]);
  h.ear.quiesce();
  // The final for the same segment, a few hundred ms after the stop.
  h.ear.hear("type hello", true, 7, 2);
  await tick(20);
  assert.equal(h.ran.length, 1, "not typed again");
  // Kevin's next command inside the same segment is judged on its own words.
  h.ear.hear("type hello scroll down", false, 7, 3);
  await tick(45);
  assert.deepEqual(h.ran.map((r) => r.label).slice(1), ["scroll down"]);
  // A revision that shortens the text does not start over on the words already acted on.
  h.ear.hear("press enter please", false, 8, 4);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label).slice(2), ["press enter"]);
  h.ear.hear("press enter", true, 8, 5);
  await tick(20);
  assert.equal(h.ran.length, 3, "the shortened final does not press Return again");
});

test("ear: while off or held (paused, muted, the voice speaking, a task running) the words are consumed, not queued — re-enabled, only what is said afterwards counts; \"stop\" is never held", async () => {
  let on = true;
  let held: string | undefined;
  const h = harness({ enabled: () => on, suppressed: () => held });
  on = false;
  h.ear.hear("press enter", true, 1, 1);
  on = true;
  h.ear.hear("press enter", true, 1, 2);
  await tick(20);
  assert.equal(h.ran.length, 0, "a final heard while off is not acted on once the ear is back on");
  h.ear.hear("press enter scroll down", true, 1, 3);
  await tick(20);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down"], "only the words said after");
  held = "the voice is speaking";
  h.ear.hear("now press enter", true, 2, 4);
  await tick(20);
  assert.equal(h.ran.length, 1, "Jarhead's own words back through the microphone press nothing");
  h.ear.hear("now press enter stop", false, 2, 5);
  await tick(5);
  assert.equal(h.stops, 1, "stop goes through while speaking");
  held = undefined;
  h.ear.hear("now press enter stop zoom in", true, 2, 6);
  await tick(20);
  assert.deepEqual(h.ran.map((r) => r.label), ["scroll down", "zoom in"]);
  // A matched partial whose window ends while held does not fire.
  h.ear.hear("scroll up", false, 3, 7);
  held = "a task is running";
  await tick(45);
  assert.equal(h.ran.length, 2);
});

/** An ear over a table of two live threads: the name window, the segment roll, Live's echo. */
function threadHarness(opts: { live: () => number; echo?: () => boolean; names: string[]; recent?: string[] }): { ear: EarReflexes; ran: { label: string; phrase: string }[]; rows: ReflexLedgerRow[]; stops: number; gates: number; clock: { t: number }; fired: FiredReflexes } {
  const clock = { t: 1_000_000 };
  const fired = new FiredReflexes(() => clock.t);
  const h = { ear: undefined as unknown as EarReflexes, ran: [] as { label: string; phrase: string }[], rows: [] as ReflexLedgerRow[], stops: 0, gates: 0, clock, fired };
  h.ear = new EarReflexes({
    now: () => clock.t,
    enabled: () => true,
    // The engine's grammar: live names, plus the ones that just ended when asked (the name after a stop word).
    match: (u, o) => parseReflex(u, { threadNames: o?.recentNames ? [...opts.names, ...(opts.recent ?? [])] : opts.names }),
    run: async (reflex, phrase) => {
      h.ran.push({ label: reflex.label, phrase });
      return { reflex, result: { kind: "text", text: "" }, ms: 1, ok: true, dispatchedAt: clock.t };
    },
    onStop: () => void h.stops++,
    onGateSpeech: () => void h.gates++,
    liveThreads: opts.live,
    ...(opts.echo ? { recentNamedStop: opts.echo } : {}),
    stopNameWaitMs: 60,
    dictation: { active: () => false, start: () => undefined, stop: () => undefined, type: async () => true, newline: async () => undefined, deleteWord: async () => undefined },
    fired,
    ledger: (row) => h.rows.push(row),
    stableMs: 30,
    carefulMs: 60,
  });
  return h;
}

test("ear: the name window survives a segment roll — 'stop' in segment 1, 'the slack one' as the first words of segment 2 fires 'stop Slack' (remembered for Live's reconcile, one gate); a roll with no name cuts everything when the window runs out", async () => {
  const h = threadHarness({ live: () => 2, names: ["Slack", "Spotify"] });
  h.ear.hear("stop", false, 1, h.clock.t);
  await tick(5);
  assert.equal(h.gates, 1, "the speech is gated on the stop word");
  assert.equal(h.stops, 0, "the work waits for a name");
  // The recogniser rolled its request between the stop word and the name.
  h.ear.hear("the slack one", false, 2, h.clock.t);
  await tick(5);
  assert.deepEqual(h.ran, [{ label: "stop Slack", phrase: "stop the slack one" }], "the new segment's words are judged as the name");
  assert.equal(h.gates, 1, "gated once, not again at the fire");
  await tick(100);
  assert.equal(h.stops, 0, "the name closed the window: no cut");
  assert.equal(h.rows.length, 1);
  assert.deepEqual([h.rows[0]!.action, h.rows[0]!.fired, h.rows[0]!.ok], ["stop Slack", "terminal", true]);
  assert.equal(h.fired.peek("stop the slack one")?.kind, "done", "Live's delegation of the words will find it done");
  // A roll with no name after the stop word: the timer decides, and cuts.
  h.ear.hear("stop", false, 3, h.clock.t);
  await tick(5);
  assert.equal(h.gates, 2);
  h.ear.hear("scroll down", false, 4, h.clock.t);
  await tick(100);
  assert.equal(h.stops, 1, "no name in the window: everything is cut when it runs out");
  assert.equal(h.ran.length, 1, "'scroll down' was not the name and did not fire as a reflex meanwhile");
});

test("ear: Live's fragment path just stopped a thread by name (recentNamedStop) — the ear's stop word with one thread live opens the name window instead of cutting, 'stop the slack one' parses through the recent names, and an empty window closes quiet; with the echo gone a bare stop is today's cut", async () => {
  let echo = true;
  const h = threadHarness({ live: () => 1, echo: () => echo, names: ["Spotify"], recent: ["Slack"] });
  h.ear.hear("stop", false, 1, h.clock.t);
  await tick(5);
  assert.equal(h.gates, 1);
  assert.equal(h.stops, 0, "not cut: Live's words just served a named stop");
  h.ear.hear("stop the slack one", false, 1, h.clock.t);
  await tick(5);
  assert.deepEqual(h.ran.map((r) => r.label), ["stop Slack"], "the name of a thread that just ended still parses");
  await tick(100);
  assert.equal(h.stops, 0);
  // The echo with no name following: quiet.
  h.ear.hear("stop", false, 2, h.clock.t);
  await tick(5);
  assert.equal(h.gates, 2);
  await tick(100);
  assert.equal(h.stops, 0, "an empty window on the echo cuts nothing");
  // No echo any more: the old rule.
  echo = false;
  h.ear.hear("stop", false, 3, h.clock.t);
  await tick(5);
  assert.equal(h.stops, 1, "cut on the partial, as today");
});

test("ear: a typed line while dictating is text, not a command — typed() runs nothing", async () => {
  const h = harness();
  h.ear.hear("start dictating", true, 1, 1);
  await tick(5);
  assert.equal(h.dictation.active, true);
  assert.equal(await h.ear.typed("open safari", h.clock.t), undefined);
  assert.deepEqual(h.ran.map((r) => r.label), ["start dictating"], "no reflex ran for the typed line");
  h.dictation.active = false;
  const out = await h.ear.typed("scroll down", h.clock.t);
  assert.equal(out?.ok, true);
  assert.deepEqual(h.ran.map((r) => r.label), ["start dictating", "scroll down"]);
  assert.equal(h.rows.at(-1)!.source, "typed");
});

test("FiredReflexes: peek finds without claiming, reconcile claims; a longer utterance that ends with the phrase is partial, never done", () => {
  const clock = { t: 10_000 };
  const f = new FiredReflexes(() => clock.t, 4000);
  f.record({ id: "a", phrase: "scroll down", reflex: parseReflex("scroll down")!, source: "ear", earAt: 9990, matchedAt: 9995, dispatchedAt: 10_000, doneAt: 10_010, ok: true });
  clock.t = 10_300;
  assert.equal(f.peek("jarhead scroll down.")?.kind, "done");
  assert.equal(f.peek("jarhead scroll down.")?.kind, "done", "a peek claims nothing: the next look still finds it");
  const partial = f.peek("read me the headline scroll down");
  assert.equal(partial?.kind, "partial", "the request says more than the reflex did");
  assert.equal(f.peek("read me the headline scrolldown"), undefined, "whole words only");
  assert.equal(f.reconcile("jarhead scroll down")?.kind, "done");
  assert.equal(f.peek("scroll down"), undefined, "claimed by the delegation");
});

test("FiredReflexes: the same words within the window are done (claimed once); the same command with other words is a mismatch; old ones age out", () => {
  const clock = { t: 10_000 };
  const f = new FiredReflexes(() => clock.t, 4000);
  const scroll = parseReflex("scroll down")!;
  const typed = parseReflex("type hello there")!;
  f.record({ id: "a", phrase: "scroll down", reflex: scroll, source: "ear", earAt: 9990, matchedAt: 9995, dispatchedAt: 10_000, doneAt: 10_010, ok: true });
  f.record({ id: "b", phrase: "type hello there", reflex: typed, source: "ear", earAt: 9990, matchedAt: 9995, dispatchedAt: 10_000, doneAt: 10_010, ok: true });
  clock.t = 10_400;
  const r1 = f.reconcile("Jarhead, scroll down.");
  assert.equal(r1?.kind, "done");
  assert.equal(f.reconcile("scroll down"), undefined, "claimed once: a second identical delegation is not 'already done'");
  const r2 = f.reconcile("jarhead type hello there everyone how are you");
  assert.equal(r2?.kind, "mismatch", "same command, materially different words");
  assert.equal(f.reconcile("what is on my screen"), undefined);
  f.record({ id: "c", phrase: "press enter", reflex: parseReflex("press enter")!, source: "ear", earAt: 1, matchedAt: 1, dispatchedAt: 10_400, doneAt: 10_401, ok: true });
  clock.t = 14_500;
  assert.equal(f.reconcile("press enter"), undefined, "aged out after the window");
});
