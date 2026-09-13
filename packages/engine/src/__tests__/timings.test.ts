import { test } from "node:test";
import assert from "node:assert/strict";
import { addLogSink } from "@jarhead/core";
import type { Brain } from "@jarhead/brain";
import type { LedgerRow } from "@jarhead/protocol";
import { delegate, rows, settle, until, world, type World } from "./world.ts";

/**
 * The two latency stamps that make "speech end → first visible action" measurable
 * on every delegation (docs/LATENCY.md §5): `speechEndAt` — the end of Kevin's
 * triggering utterance, placed on the wall clock through the session's start —
 * and `firstActionAt` — the first acting tool that returned ok (a look-only tool
 * and a failed acting tool do not count). Both ride on the ledger's
 * `delegation.finished` row and in the delegator's done line.
 */

type Finished = Extract<LedgerRow, { type: "delegation.finished" }>;

test("timings: speechEndAt is the triggering utterance's end on the session's start clock; firstActionAt is the first acting tool that returned ok; both land on the ledger and in the done line", async () => {
  let w!: World;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: async (task, sink) => {
      const { engine, clock } = w;
      engine.runner.attach(sink, task);
      try {
        clock.t += 100;
        await engine.runner.run("read_focused_text", {}); // looks only: the first tool, not an action
        clock.t += 100;
        const failed = await engine.runner.run("open_app", {}); // an acting member that did nothing
        assert.equal(failed.result.kind, "error");
        clock.t += 100;
        const key = await engine.runner.run("key", { text: "Return" }); // the first action that went through
        assert.equal(key.result.kind, "text", JSON.stringify(key.result));
        clock.t += 100;
        return { status: "done", summary: "pressed return." };
      } finally {
        engine.runner.attach(undefined);
      }
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  w = world({ brain });
  const { engine, hands, clock } = w;
  const logLines: string[] = [];
  const unsub = addLogSink((_level, scope, message) => {
    if (scope === "delegator") logLines.push(message);
  });
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const sessionStartedAt = clock.t;
    // Kevin speaks; Live delegates 600 ms of wall clock after the utterance ended (its transcription and decision).
    clock.t += 2500;
    const wallAtDelegation = clock.t;
    const live = w.live;
    const s = live.nowMs; // 1000 on the session timeline
    delegate(w, "jarhead find the save button and press it", "item_1"); // one fragment [s, s+900], then the delegation at s+900
    await settle(60);

    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1");
    assert.ok(d, "the delegation exists");
    assert.equal(d.status, "done", d.summary);
    const t = d.timings;
    assert.equal(t.delegatedAt, wallAtDelegation);
    assert.equal(t.speechEndAt, sessionStartedAt + s + 900, "the utterance's endMs on the session timeline, placed on the wall clock at session.started");
    assert.equal(t.firstActionAt, wallAtDelegation + 300, "the key press, not the focused-text read and not the open_app that failed");
    assert.equal(hands.named("key").length, 1, "the key went out through the gated hands");
    assert.equal((t as { firstToolAt?: number }).firstToolAt, wallAtDelegation + 100, "the first tool is still the first look (the eyes' shot excluded)");

    const finished = rows<Finished>(w, "delegation.finished").find((r) => r.delegationId === d.id);
    assert.ok(finished, "the finished row is on the ledger");
    assert.equal(finished.timings.speechEndAt, sessionStartedAt + s + 900);
    assert.equal(finished.timings.firstActionAt, wallAtDelegation + 300);

    const done = logLines.find((l) => /^delegation dlg_\S+ done in/.test(l));
    assert.ok(done, `a done line: ${logLines.join(" | ")}`);
    assert.match(done, /speech@-600 /, "speech ended 600 ms before the delegation");
    assert.match(done, /action@300/, "the action 300 ms after it");
  } finally {
    unsub();
    await engine.stop();
  }
});

test("timings: with no acting tool nothing is stamped as an action, and speechEndAt is absent when no utterance preceded the delegation", async () => {
  let w!: World;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: async (task, sink) => {
      w.engine.runner.attach(sink, task);
      try {
        await w.engine.runner.run("frontmost_app", {});
        return { status: "done", summary: "Notes is in front." };
      } finally {
        w.engine.runner.attach(undefined);
      }
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  w = world({ brain });
  const { engine, live } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    // Live delegates with nothing heard yet (a hand-off before the transcript caught up).
    live.emit("delegation", "item_bare", "client", live.nowMs);
    await settle(60);
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_bare");
    assert.ok(d);
    assert.equal(d.status, "done");
    assert.equal(d.timings.firstActionAt, undefined, "a look is not an action");
    assert.equal(d.timings.speechEndAt, undefined, "no utterance, no speech end");
  } finally {
    await engine.stop();
  }
});

test("timings: a thread's steps land on ITS OWN delegation (threadId) with their own marks, never the parent's; the parent's first tool is its thread_start and it has no action; 61 s of thread actions never move lastKevinAt (the presence gate's clock)", async () => {
  const w = world();
  const { engine, brain, clock } = w;
  const lastKevinAt = (): number => (engine as unknown as { lastKevinAt: number }).lastKevinAt;
  try {
    let acted!: () => void;
    const actedP = new Promise<void>((r) => (acted = r));
    w.workers.script = async (job) => {
      for (let i = 0; i < 6; i++) {
        clock.t += 10_000;
        await job.runner.run("frontmost_app", {});
      }
      clock.t += 1000;
      acted();
      return { status: "done", summary: "looked six times." };
    };
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead tell ben on slack and play focus on spotify", "item_1");
    await settle();
    const kevinBefore = lastKevinAt();
    const started = await engine.runner.run("thread_start", { name: "Spotify", task: "play Focus" });
    assert.equal(started.result.kind, "text");
    await actedP;
    assert.equal(lastKevinAt(), kevinBefore, "61 s of a thread's actions are not Kevin's presence");
    const d = engine.snapshot().delegations[0]!;
    assert.equal(d.steps.filter((s) => s.worker === "Spotify" && s.kind === "tool").length, 0, "a thread's steps never land on the parent");
    // thread_start is the main brain's own tool step; the thread's reads are on its own record, not the main brain's first tool or action.
    const t = d.timings as { firstToolAt?: number; firstActionAt?: number };
    const threadStart = d.steps.find((s) => s.kind === "tool" && s.tool?.name === "thread_start")!;
    assert.equal(t.firstToolAt, threadStart.at, "the first tool is the brain's own thread_start");
    assert.equal(t.firstActionAt, undefined, "a thread's read is nobody's action; thread_start changes nothing on screen");
    const threadId = engine.workers.threads().find((x) => x.name === "Spotify")!.id;
    const own = engine.workers.turnsOf(threadId)[0]!;
    assert.equal(own.threadId, threadId);
    assert.equal(own.steps.filter((s) => s.kind === "tool" && s.tool?.name === "frontmost_app").length, 6, "on its own delegation");
    const tt = own.timings as { firstToolAt?: number; firstActionAt?: number; toolRoundTripMs?: number[] };
    assert.ok(tt.firstToolAt !== undefined, "its own first look is stamped on its own turn");
    assert.equal(tt.firstActionAt, undefined, "a read is no action");
    assert.equal(tt.toolRoundTripMs?.length, 6, "one round trip per look; the eyes' shot stamps nothing");
    brain.resolve?.({ status: "done", summary: "on it." });
    await until(() => engine.snapshot().delegations[0]!.status === "done");
  } finally {
    await engine.stop();
  }
});
