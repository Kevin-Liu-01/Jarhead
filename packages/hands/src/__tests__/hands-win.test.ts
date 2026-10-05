import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputerToolset } from "../toolset.ts";
import { FakeHands } from "../fake.ts";
import { USER_IDLE_NONE_MS, type UserIdle } from "../native.ts";
import { FocusLease, KEVIN_QUIET_MS, MIN_HOLD_MS, USER_IDLE_POLL_MS, WAIT_MAX_MS, isBusyResult, type LeaseOutcome } from "../lease.ts";

/**
 * W2-4 (RAIL-13, the lease and fake half): Kevin's hands win over every move the hands make,
 * not only clicks and keys. focus_app, an activating open_app and mouse_move are held while he
 * typed within KEVIN_QUIET_MS, and the lease's own re-front waits out his quiet window for every
 * taker, Jarhead's priority hands too, so no app is pulled over the one he is typing in. When he
 * types through the whole wait the taker is told `busy` and holds nothing: it never acts with his
 * app in front.
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
    assert.equal(got.ok, true);
    assert.equal(got.ok && got.refocused, "Safari");
    const fronts = hands.named("focus_app");
    assert.equal(fronts.length, 1, "one re-front, after the wait");
    const waited = (fronts[0]?.at ?? t0) - t0;
    assert.ok(waited >= KEVIN_QUIET_MS - 200, `the re-front waited for his quiet window (${waited} ms)`);
    assert.ok(waited < KEVIN_QUIET_MS - 200 + 2 * USER_IDLE_POLL_MS, `and no longer (${waited} ms)`);
    assert.equal(got.ok && got.waitedMs, waited, "the outcome says how long, for the runner's note");
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

/** Jarhead's hands worked in Safari; a thread brought Slack forward, and Kevin types in it without stopping. */
function typingInSlack(userName?: string): { clock: VirtualClock; hands: AlwaysTyping; lease: FocusLease } {
  const clock = new VirtualClock();
  const hands = new AlwaysTyping();
  hands.now = clock.now;
  hands.kevinActed();
  const lease = new FocusLease({ hands, now: clock.now, sleep: clock.sleep, ...(userName ? { userName: () => userName } : {}) });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "t_1");
  lease.rememberFront("jarhead", "Safari");
  return { clock, hands, lease };
}

test("Kevin types through the taker's whole quiet wait: busy, the lease is let go, nothing re-fronted, and its next type cannot land in his app", async () => {
  const { clock, hands, lease } = typingInSlack();
  const t0 = clock.t;
  const got = await lease.acquire("jarhead", { priority: true, timeoutMs: 2_000 });
  assert.deepEqual(got, { ok: false, reason: "Kevin is using the keyboard or mouse", busy: true }, "never ok with his app in front");
  assert.ok(clock.t - t0 >= 2_000 && clock.t - t0 < 2_000 + 2 * USER_IDLE_POLL_MS, `waited the taker's patience (${clock.t - t0} ms)`);
  assert.equal(hands.named("focus_app").length, 0, "nothing re-fronted over his typing");
  assert.equal(lease.holder, undefined, "the screen is not the taker's");
  assert.equal(lease.info(), undefined);
  assert.equal(hands.frontApp, "Slack");
  // The release learned nothing from his app: Safari is still where Jarhead's hands work, so a later hand-over re-fronts it.
  await clock.sleep(0);
  assert.equal(lease.appOf("jarhead"), "Safari");
  // The name in the reason is the user's.
  const named = typingInSlack("Ada");
  assert.deepEqual(await named.lease.acquire("jarhead", { priority: true, timeoutMs: 1_000 }), { ok: false, reason: "Ada is using the keyboard or mouse", busy: true });
});

test("the quiet wait is capped at WAIT_MAX_MS: the main lane's 30 s acquire does not wait 30 s in its re-front", async () => {
  const { clock, hands, lease } = typingInSlack();
  const t0 = clock.t;
  const got = await lease.acquire("jarhead", { priority: true, timeoutMs: 30_000 });
  assert.equal(got.ok, false);
  assert.equal(!got.ok && got.busy, true);
  const waited = clock.t - t0;
  assert.ok(waited >= WAIT_MAX_MS && waited < WAIT_MAX_MS + 2 * USER_IDLE_POLL_MS, `gave up at WAIT_MAX_MS (${waited} ms)`);
  assert.equal(hands.named("focus_app").length, 0);
});

test("a thread's quiet wait is what is left of its acquire: one that waited 7 s for the screen gives up as busy at 8 s, never later (README: a thread waits at most 8 s)", async () => {
  const clock = new VirtualClock();
  /** The thread's gate reads him quiet; he starts typing right after it, for 2.5 s. */
  class TypesAfterGate extends FakeHands {
    reads = 0;
    typingUntil = 0;
    override get userIdle(): UserIdle {
      this.reads++;
      if (this.reads === 1) {
        this.typingUntil = this.now() + 2_500;
        this.kevinActed();
        return { keyMs: USER_IDLE_NONE_MS, clickMs: USER_IDLE_NONE_MS, scrollMs: USER_IDLE_NONE_MS, moveMs: USER_IDLE_NONE_MS, foreignMs: USER_IDLE_NONE_MS };
      }
      return super.userIdle;
    }
  }
  const hands = new TypesAfterGate();
  hands.now = clock.now;
  let lease: FocusLease | undefined = undefined;
  const t0 = clock.t;
  const holdUntil = t0 + 7_000;
  lease = new FocusLease({
    hands,
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms);
      // Jarhead's hands keep the screen busy for 7 s, then let go.
      if (lease?.holder === "jarhead") {
        if (clock.t < holdUntil) lease.touch("jarhead");
        else lease.release("jarhead", "done");
      }
      if (clock.t < hands.typingUntil) hands.kevinActed(clock.t);
    },
  });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "jarhead");
  lease.rememberFront("t_1", "Spotify");
  hands.apps.set("Spotify", 300);
  assert.deepEqual(await lease.acquire("jarhead", { priority: true }), { ok: true });
  const got = await lease.acquire("t_1", { priority: false });
  assert.deepEqual(got, { ok: false, reason: "Kevin is using the keyboard or mouse", busy: true }, "out of its 8 s with his hands on the machine");
  const waited = clock.t - t0;
  assert.ok(waited >= 7_000 && waited <= WAIT_MAX_MS + USER_IDLE_POLL_MS, `the thread's tool waited at most WAIT_MAX_MS in all (${waited} ms)`);
  assert.equal(hands.named("focus_app").length, 0, "nothing re-fronted over his typing");
  assert.equal(lease.holder, undefined, "the screen is not the thread's");
  assert.equal(hands.frontApp, "Slack");
});

test("a thread that got the screen with nothing left of its acquire reads user_idle once: busy at once if his hands are on the machine", async () => {
  const clock = new VirtualClock();
  class StartsTyping extends FakeHands {
    reads = 0;
    override get userIdle(): UserIdle {
      this.reads++;
      // The gate reads him quiet, then the acquire's time is gone, then he types.
      if (this.reads === 1) {
        clock.t += WAIT_MAX_MS;
        this.kevinActed();
        return { keyMs: USER_IDLE_NONE_MS, clickMs: USER_IDLE_NONE_MS, scrollMs: USER_IDLE_NONE_MS, moveMs: USER_IDLE_NONE_MS, foreignMs: USER_IDLE_NONE_MS };
      }
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
  assert.deepEqual(got, { ok: false, reason: "Kevin is using the keyboard or mouse", busy: true });
  assert.equal(clock.t - t0, WAIT_MAX_MS, "no wait past the acquire's own");
  assert.equal(hands.reads, 2, "the gate's read and one re-front read");
  assert.equal(hands.named("focus_app").length, 0);
});

test("Jarhead's own hands wait their patience afresh at the re-front: 7 s behind a thread's op, then they still wait out Kevin's typing and re-front", async () => {
  const clock = new VirtualClock();
  const hands = new FakeHands();
  hands.now = clock.now;
  const t0 = clock.t;
  const opEnds = t0 + 7_000;
  let typingUntil = 0;
  let lease: FocusLease | undefined = undefined;
  lease = new FocusLease({
    hands,
    now: clock.now,
    sleep: async (ms) => {
      await clock.sleep(ms);
      // The thread's op ends 7 s in; Kevin types from then for 2.5 s.
      if (lease?.holder === "t_1" && clock.t >= opEnds && typingUntil === 0) {
        lease.endOp("t_1");
        typingUntil = clock.t + 2_500;
      }
      if (clock.t < typingUntil) hands.kevinActed(clock.t);
    },
  });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.rememberFront("t_1", "Slack");
  lease.rememberFront("jarhead", "Safari");
  assert.equal((await lease.acquire("t_1", { priority: false })).ok, true);
  lease.beginOp("t_1");
  const got = await lease.acquire("jarhead", { priority: true, timeoutMs: 30_000 });
  assert.equal(got.ok && got.refocused, "Safari", `re-fronted once he paused (${JSON.stringify(got)})`);
  const front = hands.named("focus_app")[0];
  assert.ok(front !== undefined && hands.kevinAt !== undefined && front.at >= hands.kevinAt + KEVIN_QUIET_MS, "after his quiet window");
  assert.ok(front !== undefined && front.at - t0 > WAIT_MAX_MS, `later than WAIT_MAX_MS after the acquire began (${front ? front.at - t0 : "none"} ms)`);
  assert.ok(got.ok && (got.waitedMs ?? 0) >= 2_500, `the outcome says it waited (${got.ok ? got.waitedMs : "?"} ms)`);
});

test("a stop between the user_idle read and focus_app pulls nothing forward", async () => {
  const clock = new VirtualClock();
  const ac = new AbortController();
  /** He is quiet; the taker is stopped while its re-front reads user_idle. */
  class StoppedDuringRead extends FakeHands {
    override get userIdle(): UserIdle {
      ac.abort();
      return { keyMs: USER_IDLE_NONE_MS, clickMs: USER_IDLE_NONE_MS, scrollMs: USER_IDLE_NONE_MS, moveMs: USER_IDLE_NONE_MS, foreignMs: USER_IDLE_NONE_MS };
    }
  }
  const hands = new StoppedDuringRead();
  hands.now = clock.now;
  const lease = new FocusLease({ hands, now: clock.now, sleep: clock.sleep });
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  lease.activated("Slack", "t_1");
  lease.rememberFront("jarhead", "Safari");
  const got: LeaseOutcome = await lease.acquire("jarhead", { priority: true, signal: ac.signal });
  assert.deepEqual(got, { ok: false, reason: "cancelled" });
  assert.equal(hands.named("focus_app").length, 0, "a stopped lane pulls nothing forward");
  assert.equal(lease.holder, undefined);
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
  const got = await lease.acquire("jarhead", { priority: true });
  assert.equal(got.ok, true);
  assert.equal(got.ok && got.refocused, undefined);
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
  assert.equal(got.ok && got.refocused, "Safari");
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
  assert.equal(got.ok && got.refocused, "Spotify");
  const fronts = hands.named("focus_app");
  assert.equal(fronts.length, 1);
  assert.ok((fronts[0]?.at ?? 0) - t0 >= KEVIN_QUIET_MS, `waited for him (${(fronts[0]?.at ?? 0) - t0} ms)`);
});

test("RF-9: a type Kevin's hands stopped part way says who stopped it and to look first; it is not a busy refusal, so nothing retypes the part that landed", async () => {
  for (const [userName, who] of [[undefined, "Kevin"], ["Ada", "Ada"]] as const) {
    const hands = new FakeHands();
    const ts = new ComputerToolset({ hands, ...(userName ? { userName: () => userName } : {}) });
    await ts.run("screenshot", {});
    hands.typeResult = { characters: 50, events: 50, via: "keystrokes", attempts: 1, cancelled: true, reason: "busy", field: "the note in Notes" };
    const r = await ts.run("type", { text: "a".repeat(200) });
    assert.equal(r.kind, "text");
    assert.equal((r as { text: string }).text, `stopped after 50 of 200 characters in the note in Notes. ${who} used the keyboard or mouse, so the rest was not typed. Look at the screen before typing again.`);
    assert.equal(isBusyResult(r), false, "a runner's busy retry would type the first 50 again");
    assert.doesNotMatch((r as { text: string }).text, /—/, "no em dash");
  }
});

test("RF-9: a type stopped because the focus moved says the focus moved, not that the front app changed, in short sentences", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  hands.typeResult = { characters: 12, events: 12, via: "keystrokes", attempts: 1, cancelled: true, reason: "focus_moved", field: "the note in Notes" };
  const r = await ts.run("type", { text: "a".repeat(40) });
  assert.equal(r.kind, "text");
  assert.equal((r as { text: string }).text, "stopped after 12 of 40 characters in the note in Notes. The focus moved, so the rest was not typed. Look at the screen before typing again.");
  assert.doesNotMatch((r as { text: string }).text, /front app changed|—/);
});

test("RF-9: 'N of total' counts characters as the helper does: the helper's total when it sends one, else grapheme clusters, never UTF-16 units", async () => {
  const hands = new FakeHands();
  const ts = new ComputerToolset({ hands });
  await ts.run("screenshot", {});
  // An emoji with a skin tone (4 UTF-16 units), e with a combining accent (2), a Return, and "hi": 5 characters.
  const text = "\u{1F44B}\u{1F3FD}e\u0301\nhi";
  assert.equal(text.length, 9);
  hands.typeResult = { characters: 3, events: 3, via: "keystrokes", attempts: 1, cancelled: true, reason: "busy", field: "the note in Notes" };
  const older = await ts.run("type", { text });
  assert.match((older as { text: string }).text, /^stopped after 3 of 5 characters in the note in Notes\. /);
  hands.typeResult = { characters: 3, total: 5, events: 3, via: "keystrokes", attempts: 1, cancelled: true, reason: "busy", field: "the note in Notes" };
  const current = await ts.run("type", { text });
  assert.match((current as { text: string }).text, /^stopped after 3 of 5 characters in the note in Notes\. /);
  hands.typeResult = { characters: 5, events: 6, via: "keystrokes", attempts: 1, verified: true, field: "the note in Notes" };
  const whole = await ts.run("type", { text });
  assert.match((whole as { text: string }).text, /^typed 5 characters by keystrokes/);
});
