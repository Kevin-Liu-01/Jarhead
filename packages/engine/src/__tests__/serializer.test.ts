import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunOutcome } from "@jarhead/brain";
import { READ_ONLY_TOOLS } from "@jarhead/hands";
import { haltReason } from "../../../brain/src/batch.ts";
import { ActingSerializer, SERIALIZER_BYPASS, haltReasonFor } from "../observe.ts";

/**
 * ActingSerializer, invariants I1–I7 (design-speed.md §1.4): one acting op in flight per
 * lane in arrival order (I1); a needs-confirmation / refusal / error halts the acting calls
 * queued behind it with batch.ts's words, never running them (I2); reads never wait (I3);
 * a stop drains the queue (I6); two lanes' queues are independent. I4 and I5 follow: the
 * verdicts are judged where they were, and call N's gate runs after call N−1 landed.
 */

interface Deferred {
  readonly promise: Promise<RunOutcome>;
  resolve: (o: RunOutcome) => void;
  started: boolean;
}
function deferred(): Deferred {
  let resolve!: (o: RunOutcome) => void;
  const promise = new Promise<RunOutcome>((r) => (resolve = r));
  return { promise, resolve, started: false };
}
const text = (t = "OK"): RunOutcome => ({ result: { kind: "text", text: t }, ms: 1 });
const question = (): RunOutcome => ({ result: { kind: "needs-confirmation", question: "About to click Send?", pendingId: "confirm_1" }, ms: 1 });
const refused = (): RunOutcome => ({ result: { kind: "error", message: "refused: 1Password holds credentials" }, ms: 1 });
const failed = (): RunOutcome => ({ result: { kind: "error", message: "no control named Save" }, ms: 1 });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test("haltReasonFor is batch.ts's haltReason, word for word", () => {
  for (const o of [question(), refused(), failed(), text()]) assert.equal(haltReasonFor("type", o), haltReason({ name: "type", input: {} }, o));
  assert.equal(haltReasonFor("type", text()), undefined);
  assert.ok(READ_ONLY_TOOLS.size > 0 && [...READ_ONLY_TOOLS].every((t) => SERIALIZER_BYPASS.has(t)), "every look bypasses the queue");
  for (const t of ["thread_wait", "worker_wait", "speak_progress", "agent_wait"]) assert.ok(SERIALIZER_BYPASS.has(t), `${t} never holds the acts behind it`);
  // The hands-free management tools: never behind an act, never halted by its question.
  for (const t of ["thread_start", "thread_stop", "thread_read", "worker_start", "worker_stop", "worker_read", "agent_start", "agent_send", "agent_read"]) assert.ok(SERIALIZER_BYPASS.has(t), `${t} touches neither the hands nor the lease`);
  for (const t of ["self_edit", "self_apply", "self_check", "self_discard", "left_click", "type", "applescript", "run_shell", "browser_navigate", "write_file"]) assert.ok(!SERIALIZER_BYPASS.has(t), `${t} takes the queue`);
});

test("a thread_start (and its alias, and an agent_start / agent_send) issued alongside a left_click that asks Kevin starts at once and answers its own text — never `not run:`", async () => {
  for (const mgmt of ["thread_start", "worker_start", "thread_stop", "agent_start", "agent_send"]) {
    const s = new ActingSerializer();
    const click = deferred();
    const started = deferred();
    const pClick = s.run("left_click", () => click.promise);
    // The split rule's shape: `Promise.all([left_click(Send), thread_start({name:'Spotify'})])` in one exec.
    const pMgmt = s.run(mgmt, () => ((started.started = true), started.promise));
    const typed = deferred();
    const pTyped = s.run("type", () => ((typed.started = true), typed.promise));
    assert.equal(started.started, true, `${mgmt} started while the click was in flight`);
    assert.equal(typed.started, false, "the act behind the click waits");
    assert.equal(s.pending, 1, `${mgmt} is not in the acting queue`);
    started.resolve(text("started Spotify alongside"));
    click.resolve(question());
    assert.equal((await pClick).result.kind, "needs-confirmation");
    assert.deepEqual((await pMgmt).result, { kind: "text", text: "started Spotify alongside" }, `${mgmt} answers its own result`);
    assert.deepEqual((await pTyped).result, { kind: "error", message: "not run: left_click is waiting for Kevin's answer; ask him and stop" }, "the act behind the click is halted, as before");
    assert.equal(s.halted, 1);
    assert.equal(s.ran, 1, "the management tool is not counted as an act");
  }
});

test("I1: two acting calls issued together run in arrival order — the second starts only after the first resolved; I3: a read issued alongside runs at once", async () => {
  const s = new ActingSerializer();
  const a = deferred();
  const b = deferred();
  const r = deferred();
  const pa = s.run("type", () => ((a.started = true), a.promise));
  const pb = s.run("key", () => ((b.started = true), b.promise));
  const pr = s.run("screenshot", () => ((r.started = true), r.promise));
  assert.equal(a.started, true, "the first act started at once");
  assert.equal(b.started, false, "the second waits");
  assert.equal(r.started, true, "the read did not wait behind either");
  assert.equal(s.pending, 1);
  assert.equal(s.inFlight, "type");
  r.resolve(text("shot"));
  await tick();
  assert.equal(b.started, false, "a read finishing frees nothing for the acts");
  a.resolve(text("typed"));
  await pa;
  await tick();
  assert.equal(b.started, true, "the second act starts once the first landed");
  assert.equal(s.inFlight, "key");
  b.resolve(text());
  assert.equal((await pb).result.kind, "text");
  assert.equal((await pr).result.kind, "text");
  assert.equal(s.ran, 2);
  assert.equal(s.pending, 0);
  assert.equal(s.inFlight, undefined);
});

test("I2: a needs-confirmation from the first acting call makes the queued second answer batch.ts's text without touching the hands; a refusal and an error halt the same way; a call issued after the halt runs", async () => {
  // batch.ts names the call that did not go through (the one waiting for Kevin), the same words for every call behind it.
  for (const [outcome, expect] of [
    [question(), "not run: left_click is waiting for Kevin's answer; ask him and stop"],
    [refused(), "not run: left_click was refused earlier in this turn"],
    [failed(), "not run: left_click failed earlier in this turn (no control named Save)"],
  ] as const) {
    const s = new ActingSerializer();
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const pa = s.run("left_click", () => a.promise);
    const pb = s.run("key", () => ((b.started = true), b.promise));
    const pc = s.run("scroll", () => ((c.started = true), c.promise));
    a.resolve(outcome);
    assert.equal((await pa).result, outcome.result, "the halting call answers as it did");
    const outB = await pb;
    const outC = await pc;
    assert.equal(b.started, false, "never run");
    assert.equal(c.started, false, "never run");
    assert.deepEqual(outB.result, { kind: "error", message: expect });
    assert.deepEqual(outC.result, { kind: "error", message: expect });
    assert.equal(s.halted, 2);
    // The model saw the question and re-planned: a later call is not the earlier batch's.
    const d = deferred();
    const pd = s.run("left_click", () => ((d.started = true), d.promise));
    await tick();
    assert.equal(d.started, true, "a call issued after the halt runs");
    d.resolve(text());
    assert.equal((await pd).result.kind, "text");
    assert.equal(s.pending, 0);
  }
});

test("I6: drain answers every queued acting call `stopped: <reason>`; the one in flight is left to the toolset's own refusal", async () => {
  const s = new ActingSerializer();
  const a = deferred();
  const b = deferred();
  const c = deferred();
  const pa = s.run("type", () => a.promise);
  const pb = s.run("key", () => ((b.started = true), b.promise));
  const pc = s.run("open_app", () => ((c.started = true), c.promise));
  assert.equal(s.drain("Kevin pressed stop"), 2);
  assert.deepEqual((await pb).result, { kind: "error", message: "stopped: Kevin pressed stop" });
  assert.deepEqual((await pc).result, { kind: "error", message: "stopped: Kevin pressed stop" });
  assert.equal(b.started || c.started, false);
  a.resolve({ result: { kind: "error", message: "cancelled: stopped" }, ms: 1 });
  assert.equal((await pa).result.kind, "error");
  assert.equal(s.pending, 0);
  assert.equal(s.inFlight, undefined);
  // Fresh after the stop.
  const d = deferred();
  const pd = s.run("type", () => ((d.started = true), d.promise));
  assert.equal(d.started, true);
  d.resolve(text());
  await pd;
});

test("two lanes' queues are independent: a worker lane's act does not wait on the main lane's, and a halt on one halts nothing on the other", async () => {
  const main = new ActingSerializer();
  const lane = new ActingSerializer();
  const a = deferred();
  const w = deferred();
  const w2 = deferred();
  void main.run("type", () => a.promise);
  const pw = lane.run("applescript", () => ((w.started = true), w.promise));
  const pw2 = lane.run("applescript", () => ((w2.started = true), w2.promise));
  assert.equal(w.started, true, "the lane's first act runs while main types");
  a.resolve(question());
  await tick();
  w.resolve(text("played"));
  await pw;
  await tick();
  assert.equal(w2.started, true, "main's question halted nothing on the lane");
  w2.resolve(text());
  await pw2;
});

test("a throwing fn is an error outcome that halts what was queued behind it", async () => {
  const s = new ActingSerializer();
  const pa = s.run("run_shell", async () => {
    throw new Error("boom");
  });
  const pb = s.run("key", async () => text());
  assert.deepEqual((await pa).result, { kind: "error", message: "boom" });
  assert.deepEqual((await pb).result, { kind: "error", message: "not run: run_shell failed earlier in this turn (boom)" });
});

test("50 random interleavings: never two acts in flight, acts start in arrival order, every act queued when a halting act settled is halted and never run, every read starts at once", async () => {
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const READS = ["screenshot", "frontmost_app", "find_element", "browser_read"];
  const ACTS = ["left_click", "type", "key", "scroll", "open_app", "applescript", "run_shell", "browser_click"];
  let rounds = 0;
  let actsTotal = 0;
  let haltedTotal = 0;
  for (let round = 0; round < 50; round++) {
    const s = new ActingSerializer();
    const n = 5 + Math.floor(rnd() * 6);
    interface Call {
      readonly i: number;
      readonly name: string;
      readonly read: boolean;
      readonly outcome: RunOutcome;
      startedAt?: number;
      settledAt?: number;
      enqueuedAt: number;
      result?: RunOutcome;
      ran: boolean;
    }
    const calls: Call[] = [];
    let inFlightActs = 0;
    let maxInFlightActs = 0;
    let clock = 0; // a logical clock: every event is one tick
    const settlers: Array<{ call: Call; delay: number }> = [];
    const promises: Promise<void>[] = [];
    for (let i = 0; i < n; i++) {
      const read = rnd() < 0.35;
      const name = read ? READS[Math.floor(rnd() * READS.length)]! : ACTS[Math.floor(rnd() * ACTS.length)]!;
      const roll = rnd();
      const outcome = read ? text("looked") : roll < 0.65 ? text("did") : roll < 0.8 ? question() : roll < 0.9 ? refused() : failed();
      const call: Call = { i, name, read, outcome, enqueuedAt: ++clock, ran: false };
      calls.push(call);
      const delay = Math.floor(rnd() * 3);
      let startedSync = false;
      const p = s.run(name, async () => {
        startedSync = true;
        call.ran = true;
        call.startedAt = ++clock;
        if (!read) {
          inFlightActs++;
          maxInFlightActs = Math.max(maxInFlightActs, inFlightActs);
        }
        await sleep(delay);
        if (!read) inFlightActs--;
        call.settledAt = ++clock;
        return outcome;
      });
      if (read) assert.equal(startedSync, true, `round ${round}: read ${name} started at once`);
      settlers.push({ call, delay });
      promises.push(p.then((r) => void (call.result = r)));
      if (rnd() < 0.5) await sleep(Math.floor(rnd() * 2));
    }
    await Promise.all(promises);
    rounds++;
    assert.ok(maxInFlightActs <= 1, `round ${round}: ${maxInFlightActs} acts in flight at once (I1)`);
    const acts = calls.filter((c) => !c.read);
    actsTotal += acts.length;
    // Arrival order among the acts that ran.
    const started = acts.filter((c) => c.ran).sort((a, b) => a.startedAt! - b.startedAt!);
    assert.deepEqual(started.map((c) => c.i), acts.filter((c) => c.ran).map((c) => c.i), `round ${round}: acts ran in arrival order`);
    // Every act that did not run was halted by an earlier act that settled badly while it was queued — and says so in batch.ts's words.
    for (const c of acts) {
      if (c.ran) {
        assert.equal(c.result, c.outcome, `round ${round}: a run act answers its own outcome`);
        continue;
      }
      haltedTotal++;
      const halter = acts.find((h) => h.ran && h.i < c.i && haltReasonFor(h.name, h.outcome) !== undefined && h.settledAt! > c.enqueuedAt);
      assert.ok(halter, `round ${round}: act ${c.i} (${c.name}) did not run but nothing queued before it halted (I2)`);
      assert.equal(c.result!.result.kind, "error");
      assert.match((c.result!.result as { message: string }).message, /^not run: /);
    }
    // And every act that ran was not behind a halter it was queued under.
    for (const c of acts.filter((c) => c.ran)) {
      const shouldHaveHalted = acts.find((h) => h.ran && h.i < c.i && haltReasonFor(h.name, h.outcome) !== undefined && h.settledAt! > c.enqueuedAt && h.settledAt! < c.startedAt!);
      assert.equal(shouldHaveHalted, undefined, `round ${round}: act ${c.i} ran though act ${shouldHaveHalted?.i} halted while it was queued`);
    }
    for (const c of calls.filter((c) => c.read)) assert.equal(c.result, c.outcome, "reads answer as they did");
    assert.equal(s.pending, 0);
    assert.equal(s.inFlight, undefined);
  }
  console.log(`measured: ${rounds} random interleavings, ${actsTotal} acting calls, ${haltedTotal} halted, invariants I1–I3 held in every round`);
  assert.equal(rounds, 50);
});
