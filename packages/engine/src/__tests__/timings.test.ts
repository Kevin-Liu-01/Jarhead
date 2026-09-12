import { test } from "node:test";
import assert from "node:assert/strict";
import { addLogSink } from "@jarhead/core";
import type { Brain } from "@jarhead/brain";
import type { LedgerRow } from "@jarhead/protocol";
import { delegate, rows, settle, world, type World } from "./world.ts";

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
