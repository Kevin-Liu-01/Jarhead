import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerToolset } from "../toolset.ts";
import { FakeHands } from "../fake.ts";
import { USER_IDLE_NONE_MS, type UserIdle } from "../native.ts";
import { FocusLease, KEVIN_QUIET_MS, MIN_HOLD_MS, USER_IDLE_POLL_MS, isBusyResult } from "../lease.ts";

/**
 * W2-4 (RAIL-13, the lease and fake half): Kevin's hands win over every move the hands make,
 * not only clicks and keys. focus_app, an activating open_app and mouse_move are held while he
 * typed within KEVIN_QUIET_MS, and the lease's own re-front waits out his quiet window for every
 * taker, Jarhead's priority hands too, so no app is pulled over the one he is typing in.
 * The helper's half is packages/hands/native (HandsWin.swift, run by hands-win-native.test.ts).
 */

/** A clock the test moves: `sleep` advances it instead of waiting. */
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

/** Kevin types without stopping: `user_idle` always says 100 ms, and the helper refuses busy. */
class AlwaysTyping extends FakeHands {
  override get userIdle(): UserIdle {
    return { keyMs: 100, clickMs: USER_IDLE_NONE_MS, scrollMs: USER_IDLE_NONE_MS, moveMs: 100, foreignMs: 100 };
  }
}

test("RAIL-13 R12: while Kevin typed 200 ms ago, focus_app, open_app and mouse_move are held like a click; his front app stays; a background open moves nothing and is not held", async () => {
  let t = 1_000_000;
  const hands = new FakeHands();
  hands.now = () => t;
  const ts = new ComputerToolset({ hands, now: () => t });
  await ts.run("screenshot", {});
  hands.kevinActed(t - 200); // Kevin is typing in Notes

  const click = await ts.run("left_click", { coordinate: [100, 100] });
  assert.equal(click.kind, "error", "a click is held busy (control)");
  for (const [member, input] of [
    ["focus_app", { name: "Slack" }],
    ["open_app", { name: "Spotify" }],
    ["mouse_move", { coordinate: [400, 300] }],
  ] as const) {
    const r = await ts.run(member, input);
    assert.equal(r.kind, "error", `${member} is held`);
    assert.ok(isBusyResult(r), `${member}: the busy code stays in front, so a runner retries it silently (${(r as { message?: string }).message})`);
  }
  assert.equal(hands.frontApp, "Notes", `nothing was pulled over Kevin's typing (front: ${hands.frontApp})`);

  // A launch in the background moves nothing of his: not held.
  const bg = await hands.request<{ app: string }>("open_app", { name: "Music", activate: false });
  assert.equal(bg.app, "Music");
  assert.equal(hands.frontApp, "Notes");

  // Past his quiet window the same calls land.
  t += KEVIN_QUIET_MS;
  assert.equal((await ts.run("focus_app", { name: "Slack" })).kind, "text");
  assert.equal(hands.frontApp, "Slack");
  assert.equal((await ts.run("mouse_move", { coordinate: [400, 300] })).kind, "text");
});

for (const busyCheck of [true, false]) {
  test(`a priority taker's re-front waits out Kevin's quiet window before focus_app goes out (helper busy check ${busyCheck ? "on" : "off: the lease alone holds it"})`, async () => {
    const { clock, hands, lease } = world();
    hands.busyCheck = busyCheck;
    // A thread brought Slack forward; Kevin is typing in it. Jarhead's hands last worked in Safari.
    hands.frontApp = "Slack";
    hands.frontPid = 200;
    lease.activated("Slack", "t_1");
    lease.rememberFront("jarhead", "Safari");
    hands.kevinActed(clock.t - 200);

    const t0 = clock.t;
    const got = await lease.acquire("jarhead", { priority: true });
    assert.deepEqual(got, { ok: true, refocused: "Safari" });
    const fronts = hands.named("focus_app");
    assert.equal(fronts.length, 1, "one re-front, after the wait");
    const waited = (fronts[0]?.at ?? t0) - t0;
    assert.ok(waited >= KEVIN_QUIET_MS - 200, `the re-front waited for his quiet window (${waited} ms)`);
    assert.ok(waited < KEVIN_QUIET_MS - 200 + 2 * USER_IDLE_POLL_MS, `and no longer (${waited} ms)`);
    assert.ok(hands.named("user_idle").length >= 2, "the priority taker read user_idle before its re-front");
    assert.equal(hands.frontApp, "Safari");
  });
}

test("no re-front, no wait: a priority taker whose app is already in front never reads user_idle", async () => {
  const { clock, hands, lease } = world();
  hands.frontApp = "Safari";
  hands.frontPid = 500;
  lease.rememberFront("jarhead", "Safari");
  hands.kevinActed(clock.t - 100);
  const t0 = clock.t;
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  assert.equal(clock.t, t0, "taken at once; the helper's busy check holds its ops");
  assert.equal(hands.named("user_idle").length, 0);
  assert.equal(hands.named("focus_app").length, 0);
});

test("Kevin types past the taker's deadline: it holds the lease, re-fronts nothing over him, and says nothing was refocused", async () => {
  const clock = new VirtualClock();
  const hands = new AlwaysTyping();
  hands.now = clock.now;
  hands.kevinActed();
  const lease = new FocusLease({ hands, now: clock.now, sleep: clock.sleep });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "t_1");
  lease.rememberFront("jarhead", "Safari");

  const t0 = clock.t;
  const got = await lease.acquire("jarhead", { priority: true, timeoutMs: 2_000 });
  assert.deepEqual(got, { ok: true }, "the screen is Jarhead's; its own ops meet the helper's busy refusal");
  assert.ok(clock.t - t0 >= 2_000, `waited to the deadline (${clock.t - t0} ms)`);
  assert.equal(hands.named("focus_app").length, 0, "nothing re-fronted over his typing");
  assert.equal(lease.holder, "jarhead");
  assert.equal(lease.info()?.inFlight, 0, "the re-front is over");
  assert.equal(hands.frontApp, "Slack");
});

test("a stop during the quiet wait: cancelled, the lease is empty, nothing re-fronted; a cut: cut", async () => {
  {
    const { clock, hands, lease } = world();
    hands.frontApp = "Slack";
    hands.frontPid = 200;
    lease.activated("Slack", "t_1");
    lease.rememberFront("jarhead", "Safari");
    hands.kevinActed(clock.t);
    const ac = new AbortController();
    const p = lease.acquire("jarhead", { priority: true, signal: ac.signal });
    await clock.sleep(USER_IDLE_POLL_MS);
    ac.abort();
    assert.deepEqual(await p, { ok: false, reason: "cancelled" });
    assert.equal(lease.holder, undefined);
    assert.equal(hands.named("focus_app").length, 0);
  }
  {
    const { clock, hands, lease } = world();
    hands.frontApp = "Slack";
    hands.frontPid = 200;
    lease.activated("Slack", "t_1");
    lease.rememberFront("jarhead", "Safari");
    hands.kevinActed(clock.t);
    const p = lease.acquire("jarhead", { priority: true });
    await clock.sleep(USER_IDLE_POLL_MS);
    lease.cancelAll("stop");
    assert.deepEqual(await p, { ok: false, reason: "cut" });
    assert.equal(lease.holder, undefined);
    assert.equal(hands.named("focus_app").length, 0);
  }
});

test("nothing decided before the wait stands after it: Kevin switched to Mail while he typed, so nothing is re-fronted over it", async () => {
  const clock = new VirtualClock();
  const hands = new FakeHands();
  hands.now = clock.now;
  let polls = 0;
  const lease = new FocusLease({
    hands,
    now: clock.now,
    sleep: async (ms) => {
      polls++;
      if (polls === 2) {
        hands.frontApp = "Mail";
        hands.frontPid = 400;
      }
      await clock.sleep(ms);
    },
  });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "t_1");
  lease.rememberFront("jarhead", "Safari");
  hands.kevinActed(clock.t - 100);
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  assert.equal(hands.named("focus_app").length, 0, "Mail is his: not covered");
  assert.equal(hands.frontApp, "Mail");
});

test("the helper refuses the re-front busy (he typed between user_idle and focus_app): retried after his quiet window, never reported as done before it lands", async () => {
  const clock = new VirtualClock();
  /** user_idle reads quiet once, then he types: the helper's own check is the one that catches it. */
  class RaceHands extends FakeHands {
    reads = 0;
    override get userIdle(): UserIdle {
      this.reads++;
      if (this.reads === 1) return { keyMs: USER_IDLE_NONE_MS, clickMs: USER_IDLE_NONE_MS, scrollMs: USER_IDLE_NONE_MS, moveMs: USER_IDLE_NONE_MS, foreignMs: USER_IDLE_NONE_MS };
      return super.userIdle;
    }
  }
  const hands = new RaceHands();
  hands.now = clock.now;
  const lease = new FocusLease({ hands, now: clock.now, sleep: clock.sleep });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "t_1");
  lease.rememberFront("jarhead", "Safari");
  clock.t += MIN_HOLD_MS;
  hands.kevinActed(clock.t);
  const t0 = clock.t;
  const got = await lease.acquire("jarhead", { priority: true });
  assert.deepEqual(got, { ok: true, refocused: "Safari" });
  const fronts = hands.named("focus_app");
  assert.equal(fronts.length, 2, "refused once, then landed");
  assert.ok((fronts[1]?.at ?? 0) - t0 >= KEVIN_QUIET_MS, "the landing re-front came after his quiet window");
  assert.equal(hands.frontApp, "Safari");
});

test("a thread's re-front waits for Kevin's quiet window too (he started typing between its gate and the re-front)", async () => {
  const clock = new VirtualClock();
  class StartsTyping extends FakeHands {
    reads = 0;
    override get userIdle(): UserIdle {
      this.reads++;
      // The thread's gate reads quiet; he starts typing right after it.
      if (this.reads === 1) return { keyMs: USER_IDLE_NONE_MS, clickMs: USER_IDLE_NONE_MS, scrollMs: USER_IDLE_NONE_MS, moveMs: USER_IDLE_NONE_MS, foreignMs: USER_IDLE_NONE_MS };
      if (this.reads === 2) this.kevinActed();
      return super.userIdle;
    }
  }
  const hands = new StartsTyping();
  hands.now = clock.now;
  const lease = new FocusLease({ hands, now: clock.now, sleep: clock.sleep });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "jarhead");
  lease.rememberFront("t_1", "Spotify");
  const t0 = clock.t;
  const got = await lease.acquire("t_1", { priority: false });
  assert.deepEqual(got, { ok: true, refocused: "Spotify" });
  const fronts = hands.named("focus_app");
  assert.equal(fronts.length, 1);
  assert.ok((fronts[0]?.at ?? 0) - t0 >= KEVIN_QUIET_MS, `waited for him (${(fronts[0]?.at ?? 0) - t0} ms)`);
});
