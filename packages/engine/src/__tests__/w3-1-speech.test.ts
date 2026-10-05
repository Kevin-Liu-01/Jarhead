import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow } from "@jarhead/protocol";
import { rows, until, world } from "./world.ts";

/**
 * W3-1, PERF-6: `timings.speechEndAt` is the wall clock of the last input delta of Kevin's triggering utterance,
 * stamped by the engine as the delta arrives. It used to be Live's session timeline (`endMs`) placed on the wall
 * clock through `session.started`, and the two clocks drift: 24 of 88 stamps on Kevin's ledger landed AFTER the
 * delegation they triggered. A delta that has arrived is never later than a delegation handled after it.
 */

type Finished = Extract<LedgerRow, { type: "delegation.finished" }>;

test("PERF-6 (audit repro): Live's timeline runs ahead of the wall clock; speechEndAt is still the wall clock of the last input delta, before the delegation", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const opened = clock.t;
    // 1.5 s of wall clock after session.started, Live's timeline already reads 4 s (its zero came before our stamp).
    clock.t += 1_500;
    live.nowMs = 4_000;
    live.emit("inputTranscript", " jarhead press return", 3_000, 3_900);
    clock.t += 200;
    live.emit("inputTranscript", " please", 3_900, 4_400); // the request's last delta
    const lastDeltaAt = clock.t;
    clock.t += 700; // Live's transcription and decision
    live.nowMs = 4_500;
    live.emit("delegation", "item_1", "client", 4_500);
    await until(() => engine.snapshot().delegations.some((d) => d.liveId === "item_1"));
    const d = engine.snapshot().delegations.find((x) => x.liveId === "item_1")!;
    console.log(`[measure] PERF-6: the timeline stamp would read delegation − speech end = ${d.timings.delegatedAt - (opened + 4_400)} ms; the wall stamp reads ${d.timings.delegatedAt - (d.timings.speechEndAt ?? Number.NaN)} ms`);
    assert.equal(d.timings.speechEndAt, lastDeltaAt, "the wall clock of the last input delta");
    assert.equal(d.timings.delegatedAt - d.timings.speechEndAt!, 700);
    w.brain.resolve?.({ status: "done", summary: "pressed return." });
    await until(() => rows<Finished>(w, "delegation.finished").some((r) => r.delegationId === d.id));
    const row = rows<Finished>(w, "delegation.finished").find((r) => r.delegationId === d.id)!;
    assert.equal(row.timings.speechEndAt, lastDeltaAt, "on the ledger too");
  } finally {
    await engine.stop();
  }
});

test("PERF-6: Live's timeline lags the wall clock; speechEndAt is the wall clock of the delta, and a second utterance gets its own", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    clock.t += 6_000; // the wall clock moved 6 s; Live's timeline still reads 1 s
    live.emit("inputTranscript", " jarhead scroll down", 1_000, 1_800);
    const first = clock.t;
    clock.t += 400;
    live.nowMs = 1_800;
    live.emit("delegation", "item_a", "client", 1_800);
    await until(() => engine.snapshot().delegations.some((d) => d.liveId === "item_a"));
    assert.equal(engine.snapshot().delegations.find((x) => x.liveId === "item_a")?.timings.speechEndAt, first);
    w.brain.resolve?.({ status: "done", summary: "scrolled." });
    // A new utterance well past the merge gap, with its own delta.
    clock.t += 9_000;
    live.nowMs = 9_000;
    live.emit("inputTranscript", " jarhead scroll up", 8_000, 8_600);
    const second = clock.t;
    clock.t += 300;
    live.emit("delegation", "item_b", "client", 9_000);
    await until(() => engine.snapshot().delegations.some((d) => d.liveId === "item_b"));
    const b = engine.snapshot().delegations.find((x) => x.liveId === "item_b")!;
    assert.equal(b.timings.speechEndAt, second);
    assert.ok(b.timings.speechEndAt! <= b.timings.delegatedAt);
  } finally {
    await engine.stop();
  }
});
