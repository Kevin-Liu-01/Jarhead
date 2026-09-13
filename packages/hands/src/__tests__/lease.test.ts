import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerToolset } from "../toolset.ts";
import { FakeHands } from "../fake.ts";
import { NativeRequestError } from "../native.ts";
import { ACTIVATED_TTL_MS, FocusLease, KEVIN_QUIET_MS, LEASE_IDLE_MS, MIN_HOLD_MS, SETTLE_MS, USER_IDLE_POLL_MS, WAIT_MAX_MS, isBusyResult } from "../lease.ts";

/**
 * The screen lease: one holder across calls; hand-over at turn end, a question or
 * LEASE_IDLE_MS of silence; a priority taker (Jarhead's own hands) waits out MIN_HOLD
 * and never lands mid-op; the taker's remembered app is re-fronted once; Kevin's own
 * hands hold every worker off (user_idle, then the helper's busy refusal, which the
 * lease retries silently); an app Kevin switched to is never covered behind him.
 */

/** A clock the test moves: `sleep` advances it instead of waiting, so a 3 s idle costs nothing. */
class VirtualClock {
  t = 1_000_000;
  now = (): number => this.t;
  sleep = async (ms: number): Promise<void> => {
    this.t += ms;
    await new Promise<void>((r) => setImmediate(r));
  };
}

function world(): { clock: VirtualClock; hands: FakeHands; lease: FocusLease } {
  const clock = new VirtualClock();
  const hands = new FakeHands();
  hands.now = clock.now;
  const lease = new FocusLease({ hands, now: clock.now, sleep: clock.sleep });
  return { clock, hands, lease };
}

/** One macrotask: every microtask chain in flight (the fake's answers, an acquire's awaits) runs to its next hold or sleep. */
const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** Has the promise settled yet? (Without awaiting it: a waiter that must still be waiting.) */
function settled(p: Promise<unknown>): { readonly done: boolean } {
  const s = { done: false };
  void p.then(
    () => (s.done = true),
    () => (s.done = true),
  );
  return s;
}

test("constants are the design's", () => {
  assert.equal(LEASE_IDLE_MS, 3000);
  assert.equal(MIN_HOLD_MS, 1500);
  assert.equal(SETTLE_MS, 300);
  assert.equal(WAIT_MAX_MS, 8000);
  assert.equal(KEVIN_QUIET_MS, 1500);
  assert.equal(USER_IDLE_POLL_MS, 250);
});

test("a worker waits while the holder acts, takes the screen after LEASE_IDLE_MS of silence or at the holder's turn end, and gives up with the reason at WAIT_MAX_MS", async () => {
  const { clock, hands, lease } = world();
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  assert.deepEqual(await lease.acquire("jarhead", { priority: true, app: "Slack" }), { ok: true });
  assert.equal(lease.holder, "jarhead");

  // The holder keeps acting: the worker's 8 s run out.
  const t0 = clock.t;
  let acting = true;
  const keepActing = (async (): Promise<void> => {
    while (acting) {
      lease.touch("jarhead");
      await clock.sleep(500);
    }
  })();
  const waited = await lease.acquire("w_1", { priority: false, app: "Spotify" });
  acting = false;
  await keepActing;
  assert.deepEqual(waited, { ok: false, reason: "jarhead has the screen" });
  assert.ok(clock.t - t0 >= WAIT_MAX_MS, `waited the full ${WAIT_MAX_MS} ms (${clock.t - t0})`);
  assert.equal(lease.holder, "jarhead");

  // Silence: 3 s after the holder's last action the worker gets it.
  lease.touch("jarhead");
  const t1 = clock.t;
  const got = await lease.acquire("w_1", { priority: false });
  assert.equal(got.ok, true);
  assert.ok(clock.t - t1 >= LEASE_IDLE_MS && clock.t - t1 < LEASE_IDLE_MS + 2 * USER_IDLE_POLL_MS, `took it after the idle window (${clock.t - t1} ms)`);
  assert.equal(lease.holder, "w_1");
  // The worker holds it across its own calls: re-acquiring is free.
  assert.deepEqual(await lease.acquire("w_1", { priority: false }), { ok: true });

  // Turn end: the holder lets go and the next taker has it at once.
  lease.release("w_1", "turn-end");
  assert.equal(lease.holder, undefined);
  lease.release("jarhead", "turn-end"); // not the holder: ignored
  const t2 = clock.t;
  assert.equal((await lease.acquire("w_2", { priority: false })).ok, true);
  assert.equal(clock.t, t2, "no wait");
});

test("a priority taker (Jarhead's hands) takes the lease from a worker after MIN_HOLD_MS, never mid-op: a held type finishes first", async () => {
  const { clock, hands, lease } = world();
  assert.equal((await lease.acquire("w_1", { priority: false, app: "Spotify" })).ok, true);
  const since = clock.t;

  // Inside the worker's op: the main lane waits for it.
  hands.hold = "type";
  const workerOp = lease.act("w_1", () => hands.request("type", { text: "focus" }));
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(lease.info()?.inFlight, 1);
  clock.t = since + MIN_HOLD_MS + 100; // the hold is over, the op is not
  const take = lease.acquire("jarhead", { priority: true });
  await clock.sleep(USER_IDLE_POLL_MS * 3);
  assert.equal(lease.holder, "w_1", "still the worker's while its type is in flight");
  hands.release();
  await workerOp;
  const took = await take;
  assert.equal(took.ok, true);
  assert.equal(lease.holder, "jarhead");
  assert.ok(hands.posted.some((p) => p.op === "type"), "the worker's type landed whole before the hand-over");

  // A fresh worker hold: the priority taker waits out MIN_HOLD even with nothing in flight — but never Kevin's typing or the worker's idle.
  lease.release("jarhead", "turn-end");
  assert.equal((await lease.acquire("w_1", { priority: false })).ok, true);
  hands.kevinActed(); // Kevin's hands on the machine: a worker would wait; Jarhead does not
  const idleReads = hands.named("user_idle").length;
  const t0 = clock.t;
  const again = await lease.acquire("jarhead", { priority: true });
  assert.equal(again.ok, true);
  assert.ok(clock.t - t0 >= MIN_HOLD_MS, `waited MIN_HOLD (${clock.t - t0} ms)`);
  assert.ok(clock.t - t0 < MIN_HOLD_MS + 2 * USER_IDLE_POLL_MS, "and not the idle window");
  assert.equal(hands.named("user_idle").length, idleReads, "a priority taker never reads user_idle (the worker acquires above did)");
});

test("hand-over re-fronts the taker's remembered app with exactly one focus_app and waits for it to settle; an app Kevin switched to himself is never covered (STALE_FOCUS: the worker waits and says so)", async () => {
  const { clock, hands, lease } = world();
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  assert.equal((await lease.acquire("jarhead", { priority: true, app: "Slack" })).ok, true);
  // Jarhead acts in Slack (the runner touches the lease with the gate's front app after each acting call): Slack is a lane's app now.
  lease.touch("jarhead", "Slack");
  assert.equal(lease.appOf("jarhead"), "Slack");
  lease.release("jarhead", "question");

  // Spotify's worker worked in Spotify earlier (remembered), Slack is in front because Jarhead put it there.
  lease.rememberFront("w_1", "Spotify");
  const got = await lease.acquire("w_1", { priority: false });
  assert.deepEqual(got, { ok: true, refocused: "Spotify" });
  assert.equal(hands.named("focus_app").length, 1, "one re-front");
  assert.deepEqual(hands.named("focus_app")[0]?.params, { name: "Spotify" });
  assert.equal(hands.frontApp, "Spotify");
  // Jarhead takes it back: Slack comes back to the front, once.
  clock.t += MIN_HOLD_MS;
  const back = await lease.acquire("jarhead", { priority: true });
  assert.deepEqual(back, { ok: true, refocused: "Slack" });
  assert.equal(hands.named("focus_app").length, 2);
  assert.equal(hands.frontApp, "Slack");
  lease.release("jarhead", "turn-end");

  // Kevin switched to Mail himself (no lane fronted it): the worker is not re-fronted behind him.
  hands.frontApp = "Mail";
  hands.frontPid = 400;
  const t0 = clock.t;
  const stale = await lease.acquire("w_1", { priority: false, timeoutMs: 2000 });
  assert.deepEqual(stale, { ok: false, reason: "Kevin is using Mail" });
  assert.equal(hands.named("focus_app").length, 2, "no focus_app went out");
  assert.equal(lease.holder, undefined);
  assert.ok(clock.t - t0 >= 2000);
  // Jarhead's own hands over Kevin's Mail: they take the lease, but nothing is re-fronted over his window either.
  const own = await lease.acquire("jarhead", { priority: true });
  assert.deepEqual(own, { ok: true }, "no refocus over an app Kevin chose");
  assert.equal(hands.named("focus_app").length, 2);
  lease.release("jarhead", "turn-end");
  // Kevin goes back to Spotify (the worker's own app): fair game again.
  hands.frontApp = "Spotify";
  hands.frontPid = 300;
  assert.deepEqual(await lease.acquire("w_1", { priority: false }), { ok: true });
});

test("Kevin's hands: a worker waits while user_idle says he typed within KEVIN_QUIET_MS; the helper's busy refusal lands nothing and the lease's retry runs the op after the quiet window; ownDriver (dictation) is never held", async () => {
  const { clock, hands, lease } = world();
  hands.frontApp = "Spotify";
  hands.frontPid = 300;
  hands.elementTitle = "Play";
  const ts = new ComputerToolset({ hands, now: clock.now });
  await ts.run("screenshot", {});

  // Kevin pressed a key 400 ms ago: the worker waits until 1.5 s have passed.
  hands.kevinActed(clock.t - 400);
  const t0 = clock.t;
  const got = await lease.acquire("w_1", { priority: false, app: "Spotify" });
  assert.equal(got.ok, true);
  assert.ok(clock.t - t0 >= KEVIN_QUIET_MS - 400 && clock.t - t0 < KEVIN_QUIET_MS, `waited out the quiet window (${clock.t - t0} ms)`);
  assert.ok(hands.named("user_idle").length >= 2, "polled user_idle");

  // He types again between the lease and the op: the helper refuses, nothing is posted, the result says so.
  hands.kevinActed();
  const busy = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(busy.kind, "error");
  assert.match((busy as { message: string }).message, /^busy: Kevin used the keyboard\/mouse 0 ms ago; nothing was posted$/);
  assert.ok(isBusyResult(busy));
  assert.equal(hands.posted.length, 0, "nothing posted");
  // The same on type: the code stays in front so a runner can spot it.
  const busyType = await ts.run("type", { text: "focus" });
  assert.equal(busyType.kind, "error");
  assert.match((busyType as { message: string }).message, /^busy: /);
  assert.equal(hands.posted.length, 0);

  // The lease retries silently; the op lands once Kevin has been quiet for 1.5 s.
  const t1 = clock.t;
  const landed = await lease.retryBusy(() => lease.act("w_1", () => ts.run("left_click", { coordinate: [100, 100] })), isBusyResult);
  assert.equal(landed.kind, "text");
  assert.equal(hands.posted.filter((p) => p.op === "click").length, 1, "one click landed");
  assert.ok(clock.t - t1 >= KEVIN_QUIET_MS - USER_IDLE_POLL_MS && clock.t - t1 <= KEVIN_QUIET_MS + USER_IDLE_POLL_MS, `landed after the quiet window (${clock.t - t1} ms)`);
  assert.ok(!isBusyResult(landed));
  assert.ok(!isBusyResult({ kind: "error", message: "refused: never" }));

  // Dictation: Kevin is the one typing, so his keystrokes do not hold his own words back.
  hands.kevinActed();
  const dictated = await ts.run("type", { text: "hello there", ownDriver: true });
  assert.equal(dictated.kind, "text");
  assert.deepEqual(hands.posted.at(-1)?.params, { text: "hello there", ownDriver: true, expectFront: { pid: 300 } });
});

test("cancelAll empties the lease and every waiter returns at once; an aborted signal returns cancelled", async () => {
  const { clock, lease } = world();
  assert.equal((await lease.acquire("w_1", { priority: false })).ok, true);
  const waiting = lease.acquire("w_2", { priority: false });
  await clock.sleep(USER_IDLE_POLL_MS);
  lease.cancelAll("Kevin pressed stop");
  assert.deepEqual(await waiting, { ok: false, reason: "cut" });
  assert.equal(lease.holder, undefined);
  assert.equal(lease.info(), undefined);
  const ac = new AbortController();
  assert.equal((await lease.acquire("w_1", { priority: false })).ok, true);
  const p = lease.acquire("w_3", { priority: false, signal: ac.signal });
  ac.abort();
  assert.deepEqual(await p, { ok: false, reason: "cancelled" });
});

// The worker's gate is two helper round trips between "the lease is free" and "it is
// mine". Whatever lands in that gap wins; the worker judges again and goes back to
// waiting — one holder, never mid-op, a cut empties every waiter.

test("gate in flight, a priority taker lands: the worker does not overwrite it — it waits, and gets the screen only when Jarhead lets go", async () => {
  const { hands, lease } = world();
  hands.hold = "user_idle";
  const worker = lease.acquire("w_1", { priority: false });
  const w = settled(worker);
  await tick();
  assert.equal(lease.holder, undefined, "the gate is in flight: nothing taken yet");
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  hands.hold = undefined;
  hands.release();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(lease.holder, "jarhead", "one holder: the worker's stale verdict did not land");
  assert.equal(w.done, false, "the worker is waiting");
  lease.release("jarhead", "turn-end");
  assert.deepEqual(await worker, { ok: true });
  assert.equal(lease.holder, "w_1");
});

test("gate in flight, a second worker takes the free lease: the first sees it held and waits its turn", async () => {
  const { hands, lease } = world();
  hands.hold = "user_idle";
  const a = lease.acquire("w_1", { priority: false });
  const aState = settled(a);
  await tick();
  // The fake holds one request per op at a time: w_2's gate passes while w_1's is held.
  const b = lease.acquire("w_2", { priority: false });
  await tick();
  assert.deepEqual(await b, { ok: true });
  assert.equal(lease.holder, "w_2");
  hands.hold = undefined;
  hands.release();
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(lease.holder, "w_2", "w_1's gate answered: the lease moved, w_1 did not take it");
  assert.equal(aState.done, false, "w_1 waits behind w_2's activity");
  lease.release("w_2", "turn-end");
  assert.deepEqual(await a, { ok: true });
  assert.equal(lease.holder, "w_1");
});

test("gate in flight, the idle holder wakes and begins an op: the worker never lands mid-op, and waits out a fresh idle window after it", async () => {
  const { clock, hands, lease } = world();
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  clock.t += LEASE_IDLE_MS + 500; // silent long enough that the lease reads free
  hands.hold = "user_idle";
  const worker = lease.acquire("w_1", { priority: false });
  await tick();
  lease.beginOp("jarhead"); // a mouse_down is going out
  hands.hold = undefined;
  hands.release();
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(lease.holder, "jarhead", "still the holder's, mid-op");
  assert.equal(lease.info()?.inFlight, 1);
  lease.endOp("jarhead");
  const t0 = clock.t;
  const got = await worker;
  assert.deepEqual(got, { ok: true });
  assert.equal(lease.holder, "w_1");
  assert.ok(clock.t - t0 >= LEASE_IDLE_MS && clock.t - t0 < LEASE_IDLE_MS + 2 * USER_IDLE_POLL_MS, `a full idle window after the op (${clock.t - t0} ms)`);
});

test("gate in flight, a cut: the worker returns cut and holds nothing after the stop; nothing is re-fronted", async () => {
  const { hands, lease } = world();
  lease.rememberFront("w_1", "Spotify");
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "jarhead");
  hands.hold = "user_idle";
  const worker = lease.acquire("w_1", { priority: false });
  await tick();
  lease.cancelAll("Kevin pressed stop");
  hands.hold = undefined;
  hands.release();
  assert.deepEqual(await worker, { ok: false, reason: "cut" });
  assert.equal(lease.holder, undefined);
  assert.equal(hands.named("focus_app").length, 0, "no focus_app after a stop");
});

test("a cut while the re-front is out (focus_app held, or the first frontmost read): the outcome is cut, the lease is empty, and no further focus_app goes out", async () => {
  const { hands, lease } = world();
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "jarhead");
  lease.rememberFront("w_1", "Spotify");
  hands.hold = "focus_app";
  const p = lease.acquire("w_1", { priority: false });
  await tick();
  assert.equal(hands.named("focus_app").length, 1, "the re-front went out");
  assert.equal(lease.holder, "w_1");
  assert.equal(lease.info()?.inFlight, 1, "a re-front counts as an op in flight");
  lease.cancelAll("stop");
  hands.hold = undefined;
  hands.release();
  assert.deepEqual(await p, { ok: false, reason: "cut" });
  assert.equal(lease.holder, undefined);
  assert.equal(lease.info(), undefined);

  // The same with the cut landing during settle's first frontmost read, for a priority actor.
  hands.frontApp = "Spotify";
  hands.frontPid = 300;
  lease.activated("Spotify", "w_1");
  lease.rememberFront("jarhead", "Slack");
  hands.hold = "frontmost";
  const q = lease.acquire("jarhead", { priority: true });
  await tick();
  assert.equal(lease.holder, "jarhead", "assigned before the settle");
  lease.cancelAll("stop");
  hands.hold = undefined;
  hands.release();
  assert.deepEqual(await q, { ok: false, reason: "cut" });
  assert.equal(hands.named("focus_app").length, 1, "nothing re-fronted after the cut");
  assert.equal(lease.holder, undefined);
});

test("a priority taker waits for another priority holder's re-front to land (never mid-op), then has it: dictation over Jarhead's hand-over", async () => {
  const { hands, lease } = world();
  hands.frontApp = "Spotify";
  hands.frontPid = 300;
  lease.activated("Spotify", "w_1");
  lease.rememberFront("jarhead", "Slack");
  hands.hold = "focus_app";
  const main = lease.acquire("jarhead", { priority: true });
  await tick();
  assert.equal(hands.named("focus_app").length, 1);
  const dictation = lease.acquire("dictation", { priority: true });
  const d = settled(dictation);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(d.done, false, "dictation waits for the re-front");
  assert.equal(lease.holder, "jarhead");
  hands.hold = undefined;
  hands.release();
  assert.deepEqual(await main, { ok: true, refocused: "Slack" });
  assert.deepEqual(await dictation, { ok: true });
  assert.equal(lease.holder, "dictation");
  assert.equal(hands.named("focus_app").length, 1, "dictation has no remembered app: nothing else re-fronted");
});

test("retryBusy stops at a stop: an abort or a cut during the poll sleep runs the op no more — the last busy answer stands", async () => {
  const { lease } = world();
  const busy = { kind: "error", message: "busy: Kevin used the keyboard/mouse 0 ms ago; nothing was posted" } as const;
  const ac = new AbortController();
  let calls = 0;
  const p = lease.retryBusy(
    async () => {
      calls += 1;
      return busy;
    },
    isBusyResult,
    { signal: ac.signal },
  );
  await tick(); // the first attempt answered busy; the retry is asleep
  ac.abort();
  assert.deepEqual(await p, busy);
  assert.equal(calls, 1, "no attempt after the abort");

  calls = 0;
  const q = lease.retryBusy(async () => {
    calls += 1;
    return busy;
  }, isBusyResult);
  await tick();
  lease.cancelAll("stop");
  assert.deepEqual(await q, busy);
  assert.equal(calls, 1, "no attempt after the cut");
});

test("release learns only the lane's own app: what Kevin fronted while a lane held the lease is never covered later; an activation ages out after ACTIVATED_TTL_MS and goes with forget()", async () => {
  const { clock, hands, lease } = world();
  hands.frontApp = "Spotify";
  hands.frontPid = 300;
  assert.equal((await lease.acquire("w_1", { priority: false, app: "Spotify" })).ok, true);
  lease.release("w_1", "done");
  await tick();
  assert.equal(lease.appOf("w_1"), "Spotify", "its intended app in front at release: learned, and a lane's");
  assert.ok(lease.isActivated("Spotify"));

  // Kevin brings Mail forward while w_1 holds the lease; w_1 lets go: Mail is his, not learned.
  assert.equal((await lease.acquire("w_1", { priority: false })).ok, true);
  hands.frontApp = "Mail";
  hands.frontPid = 400;
  lease.release("w_1", "turn-end");
  await tick();
  assert.equal(lease.appOf("w_1"), "Spotify");
  assert.ok(!lease.isActivated("Mail"));
  // Jarhead (remembered Slack) takes the lease: nothing is re-fronted over Kevin's Mail …
  lease.rememberFront("jarhead", "Slack");
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  assert.equal(hands.named("focus_app").length, 0);
  lease.release("jarhead", "turn-end");
  await tick();
  assert.equal(lease.appOf("jarhead"), "Slack", "Mail is not Jarhead's either");
  // … and the worker is told whose it is.
  assert.deepEqual(await lease.acquire("w_1", { priority: false, timeoutMs: 1000 }), { ok: false, reason: "Kevin is using Mail" });

  // Kevin goes back to Spotify — a lane's five minutes ago, his now: Jarhead does not re-front Slack over it.
  hands.frontApp = "Spotify";
  hands.frontPid = 300;
  clock.t += ACTIVATED_TTL_MS + 1;
  assert.ok(!lease.isActivated("Spotify"), "the activation aged out");
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  assert.equal(hands.named("focus_app").length, 0);
  lease.release("jarhead", "turn-end");
  await tick();
  // A fresh activation by a lane: re-fronting over it is fair again.
  lease.activated("Spotify", "w_2");
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true, refocused: "Slack" });
  assert.equal(hands.named("focus_app").length, 1);
  lease.release("jarhead", "turn-end");
  await tick();
  // forget(actor): the apps it activated are nobody's.
  hands.frontApp = "Spotify";
  hands.frontPid = 300;
  lease.activated("Spotify", "w_2");
  lease.forget("w_2");
  assert.ok(!lease.isActivated("Spotify"));
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  assert.equal(hands.named("focus_app").length, 1, "no re-front over an app whose lane is gone");
});

// Ranks (pass 4, the threads' admission order): a free lease goes to the LOWEST rank waiting, whichever polled
// first — two screen threads take the screen in the order they were started instead of racing the 250 ms poll.
// A priority taker (Jarhead's hands, dictation) ignores ranks; an unranked waiter is last in line; a cut empties the line.

test("rank: two non-priority waiters, rank 2 first in the poll and rank 1 behind it — rank 1 is granted first, rank 2 after it lets go; the line is visible lowest first", async () => {
  const { clock, lease } = world();
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  lease.touch("jarhead");
  // Rank 2 starts polling first, rank 1 a poll later; both wait on Jarhead's activity.
  const second = lease.acquire("t_b", { priority: false, rank: 2 });
  await tick();
  const first = lease.acquire("t_a", { priority: false, rank: 1 });
  await tick();
  assert.deepEqual(lease.waiting, ["t_a", "t_b"], "lowest rank first");
  const bState = settled(second);
  lease.release("jarhead", "turn-end");
  assert.deepEqual(await first, { ok: true }, "rank 1 has it, though rank 2 polled first");
  assert.equal(lease.holder, "t_a");
  await clock.sleep(USER_IDLE_POLL_MS * 2);
  assert.equal(bState.done, false, "rank 2 still waits: the screen is rank 1's");
  assert.deepEqual(lease.waiting, ["t_b"]);
  lease.release("t_a", "turn-end");
  assert.deepEqual(await second, { ok: true });
  assert.equal(lease.holder, "t_b");
  assert.deepEqual(lease.waiting, [], "nobody in line once granted");
});

test("rank: a lower rank arriving while a higher one is already free to take the lease is judged before the take; priority ignores ranks; an unranked waiter is last; cancelAll empties the line and every waiter returns cut", async () => {
  const { clock, lease } = world();
  // Free lease, rank 3 waits only on its gate (two helper round trips); rank 1 lands meanwhile.
  const late = lease.acquire("t_c", { priority: false, rank: 3 });
  const early = lease.acquire("t_a", { priority: false, rank: 1 });
  await tick();
  await tick();
  const [c, a] = await Promise.all([Promise.race([late, clock.sleep(USER_IDLE_POLL_MS * 3).then(() => "waiting" as const)]), early]);
  assert.deepEqual(a, { ok: true }, "rank 1 took it");
  assert.equal(c, "waiting", "rank 3 saw rank 1 ahead in line and waited");
  assert.equal(lease.holder, "t_a");
  // Priority: Jarhead's hands take it after MIN_HOLD regardless of anyone's rank in line.
  clock.t += MIN_HOLD_MS;
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  assert.equal(lease.holder, "jarhead");
  // An unranked waiter is last: rank 9 beats it.
  const unranked = lease.acquire("w_old", { priority: false });
  await tick();
  const ranked = lease.acquire("t_z", { priority: false, rank: 9 });
  await tick();
  assert.deepEqual(lease.waiting.slice(-2), ["t_z", "w_old"]);
  // A cut: the line is empty and every waiter returns `cut` on its next poll.
  lease.cancelAll("Kevin pressed stop");
  assert.deepEqual(lease.waiting, []);
  assert.deepEqual(await late, { ok: false, reason: "cut" });
  assert.deepEqual(await unranked, { ok: false, reason: "cut" });
  assert.deepEqual(await ranked, { ok: false, reason: "cut" });
  assert.equal(lease.holder, undefined);
});

test("rank: a waiter that runs out of patience, or is aborted, leaves the line — rank 1 past its deadline (or cancelled) no longer holds rank 2 back, which is granted on its next poll", async () => {
  const { clock, lease } = world();
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  lease.touch("jarhead");
  // Rank 1 with a short patience (six polls — every waiter's poll sleep moves the one virtual clock), rank 2 behind it, both waiting on Jarhead's activity.
  const a = lease.acquire("t_a", { priority: false, rank: 1, timeoutMs: USER_IDLE_POLL_MS * 6 });
  await tick();
  const b = lease.acquire("t_b", { priority: false, rank: 2 });
  await tick();
  assert.deepEqual(lease.waiting, ["t_a", "t_b"]);
  const ra = await a;
  assert.equal(ra.ok, false, "rank 1 ran out of patience");
  assert.deepEqual(lease.waiting, ["t_b"], "the deadline took rank 1 out of the line (the finally)");
  lease.release("jarhead", "turn-end");
  assert.deepEqual(await b, { ok: true }, "rank 2 is granted on its next poll: nobody ahead in line any more");
  assert.equal(lease.holder, "t_b");
  assert.deepEqual(lease.waiting, []);
  lease.release("t_b", "turn-end");
  // Aborted mid-wait: the same.
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  lease.touch("jarhead");
  const ctl = new AbortController();
  const c = lease.acquire("t_c", { priority: false, rank: 1, signal: ctl.signal });
  await tick();
  const d = lease.acquire("t_d", { priority: false, rank: 2 });
  await tick();
  assert.deepEqual(lease.waiting, ["t_c", "t_d"]);
  ctl.abort();
  assert.deepEqual(await c, { ok: false, reason: "cancelled" });
  assert.deepEqual(lease.waiting, ["t_d"], "the abort took rank 1 out of the line");
  lease.release("jarhead", "turn-end");
  assert.deepEqual(await d, { ok: true });
  assert.equal(lease.holder, "t_d");
  await clock.sleep(0);
});

test("the fake matches the helper: mouse_up is never refused busy (a refused release would leave a posted button held down), while focus_moved still applies to it", async () => {
  const hands = new FakeHands();
  hands.kevinActed();
  await assert.rejects(hands.request("mouse_down", { x: 1, y: 1 }), (e: unknown) => (e as NativeRequestError).detail.code === "busy");
  await hands.request("mouse_up", { x: 1, y: 1 });
  assert.equal(hands.posted.filter((p) => p.op === "mouse_up").length, 1, "the release landed");
  await assert.rejects(hands.request("mouse_up", { x: 1, y: 1, expectFront: { pid: 999 } }), (e: unknown) => (e as NativeRequestError).detail.code === "focus_moved");
  assert.equal(hands.posted.length, 1);
});
