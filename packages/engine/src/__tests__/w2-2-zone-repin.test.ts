import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockOf } from "@jarhead/core";
import type { Automation, LedgerRow } from "@jarhead/protocol";
import type { Engine } from "../engine.ts";
import { repinned, type AutomationExec } from "../automations/index.ts";
import { rows, settle, until, world, type World } from "./world.ts";

/**
 * W2-2 SL-1, the review's repros: a zone change RE-PINS each row's own wall clock (Mon 07:10 in Los Angeles becomes
 * Mon 07:10 in New York); it never recomputes the next occurrence from now. So a flight east with the lid closed over
 * the alarm leaves one missed row with Run now whichever of the tick, the zone signal or the wake comes first; a skip
 * holds; an occurrence already rung never rings twice; one-shots move with the clock; a daemon that starts in a new
 * zone moves the rows the last one pinned. node --test runs this file in its own process, so the zone is this file's
 * to move. The link the daemon reads is scripted (the exec seam); the daemon sets the process zone from it, as on a Mac.
 */

const NY = "America/New_York";
const LA = "America/Los_Angeles";
process.env.TZ = NY;

const M = 60_000;
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
type FiredRow = Extract<LedgerRow, { type: "automation.fired" }>;
type MissedRow = Extract<LedgerRow, { type: "automation.missed" }>;
const home = (): string => mkdtempSync(join(tmpdir(), "jh-w22-repin-"));
/** The wall clock of a Date in the process zone as it is when this runs (month 0-based, as Date takes it). */
const local = (y: number, mo: number, d: number, hh: number, mm: number): number => new Date(y, mo, d, hh, mm, 0, 0).getTime();
/** No process runs; `zone` is the /etc/localtime link, scripted. */
const execWith = (zone: () => string | undefined): AutomationExec => ({ run: async () => ({ code: 0 }), hold: () => undefined, zone });
const armedId = (r: unknown): string => {
  assert.equal((r as { kind: string }).kind, "armed", JSON.stringify(r));
  return (r as { automation: Automation }).automation.id;
};
const alarm = (engine: Engine, phrase = "weekdays 07:10"): string =>
  armedId(engine.automations.arm({ name: "Wake up", whenPhrase: phrase, then: [{ kind: "chime", line: "Wake up", sound: "Hero" }], echo: "x" }, "console", true));
const missedOf = (w: World, id: string): MissedRow[] => rows<MissedRow>(w, "automation.missed").filter((m) => m.id === id);
const firedOf = (w: World, id: string): FiredRow[] => rows<FiredRow>(w, "automation.fired").filter((m) => m.id === id);

for (const order of ["tick-only", "zone-first", "wake-first"] as const) {
  test(`SL-1 (${order}): flying east with the lid closed over the 07:10 alarm, the passed alarm is one missed row with Run now, never moved to tomorrow in silence`, async () => {
    process.env.TZ = LA;
    let link = LA;
    const w = world({ automations: { exec: execWith(() => link), home: home() } });
    const { engine, clock } = w;
    clock.t = local(2026, 9, 5, 6, 0); // Mon 06:00 Los Angeles
    try {
      await engine.start();
      tick(engine);
      const id = alarm(engine);
      if (order !== "tick-only") engine.systemSignal({ kind: "mac.sleep" }, clock.t + M);
      // The lid opens at 09:00 Los Angeles time, 12:00 in New York, where the Mac now is.
      clock.t = local(2026, 9, 5, 9, 0);
      link = NY;
      if (order === "zone-first") {
        engine.systemSignal({ kind: "clock.changed" }, clock.t);
        engine.systemSignal({ kind: "mac.wake" }, clock.t);
      } else if (order === "wake-first") {
        engine.systemSignal({ kind: "mac.wake" }, clock.t);
        engine.systemSignal({ kind: "clock.changed" }, clock.t);
      } else tick(engine);
      await settle(60);
      assert.equal(process.env.TZ, NY, "the daemon follows the link");
      const missed = missedOf(w, id);
      assert.deepEqual(missed.map((m) => m.dueAt), [local(2026, 9, 5, 7, 10)], "Monday 07:10, New York time, is the missed occurrence");
      assert.equal(firedOf(w, id).length, 0, "nothing rings five hours late");
      const problems = engine.snapshot().problems.filter((p) => p.kind === "automation.missed");
      assert.equal(problems.length, 1);
      assert.deepEqual(problems[0]!.remedy, { label: "Run now", command: { type: "automation.run", id } });
      assert.equal(engine.automations.table.get(id)!.nextAt, local(2026, 9, 6, 7, 10), "then Tuesday 07:10 in New York");
    } finally {
      await engine.stop();
      process.env.TZ = NY;
    }
  });

  test(`SL-1 (${order}): flying west with the lid closed, the 07:10 alarm rings at 07:10 where the Mac landed, once`, async () => {
    process.env.TZ = NY;
    let link = NY;
    const w = world({ automations: { exec: execWith(() => link), home: home() } });
    const { engine, clock } = w;
    clock.t = local(2026, 9, 5, 6, 0); // Mon 06:00 New York
    try {
      await engine.start();
      tick(engine);
      const id = alarm(engine);
      if (order !== "tick-only") engine.systemSignal({ kind: "mac.sleep" }, clock.t + M);
      clock.t = local(2026, 9, 5, 10, 0); // 10:00 New York, 07:00 in Los Angeles
      link = LA;
      if (order === "zone-first") {
        engine.systemSignal({ kind: "clock.changed" }, clock.t);
        engine.systemSignal({ kind: "mac.wake" }, clock.t);
      } else if (order === "wake-first") {
        engine.systemSignal({ kind: "mac.wake" }, clock.t);
        engine.systemSignal({ kind: "clock.changed" }, clock.t);
      } else tick(engine);
      await settle(40);
      assert.equal(process.env.TZ, LA);
      assert.equal(missedOf(w, id).length, 0, "07:10 has not come yet where the Mac is");
      const next = engine.automations.table.get(id)!.nextAt!;
      assert.equal(next, local(2026, 9, 5, 7, 10), "Monday 07:10 in Los Angeles, ten minutes away");
      clock.t = next;
      tick(engine);
      await until(() => firedOf(w, id).length >= 1, 1500);
      assert.equal(firedOf(w, id)[0]!.line, "07:10 · Wake up");
      engine.automations.changeNow(id, "done");
      assert.equal(engine.automations.table.get(id)!.nextAt, local(2026, 9, 6, 7, 10));
      assert.equal(firedOf(w, id).length, 1);
    } finally {
      await engine.stop();
      process.env.TZ = NY;
    }
  });
}

test("SL-1: a skipped occurrence stays skipped across a zone change", async () => {
  process.env.TZ = NY;
  let link = NY;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 8, 0); // Mon 08:00 New York: the next ring is Tuesday's
  try {
    await engine.start();
    tick(engine);
    const id = alarm(engine);
    assert.match(engine.automations.changeNow(id, "skip").text, /skipped · next 07:10 · Wed 7 Oct/);
    link = LA;
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    const a = engine.automations.table.get(id)!;
    assert.equal(a.nextAt, local(2026, 9, 7, 7, 10), "Wednesday 07:10 in Los Angeles: Tuesday stays skipped");
    assert.equal(missedOf(w, id).length, 0);
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("SL-1: Monday's alarm rang in New York and Kevin pressed Done; landing in Los Angeles at 06:00 does not ring Monday again", async () => {
  process.env.TZ = NY;
  let link = NY;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 7, 0);
  try {
    await engine.start();
    tick(engine);
    const id = alarm(engine);
    clock.t = local(2026, 9, 5, 7, 10);
    tick(engine);
    await until(() => firedOf(w, id).length >= 1, 1500);
    engine.automations.changeNow(id, "done");
    clock.t = local(2026, 9, 5, 9, 0); // 09:00 New York, 06:00 in Los Angeles
    link = LA;
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    assert.equal(engine.automations.table.get(id)!.nextAt, local(2026, 9, 6, 7, 10), "Tuesday 07:10 in Los Angeles");
    // Monday 07:10 in Los Angeles comes and goes.
    clock.t = local(2026, 9, 5, 7, 10);
    tick(engine);
    clock.t += 5 * M;
    tick(engine);
    await settle(40);
    assert.equal(firedOf(w, id).length, 1, "Monday rang once");
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("SL-1: the ring is still up when the zone changes; Done after landing keeps the next occurrence's wall clock", async () => {
  process.env.TZ = NY;
  let link = NY;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 7, 0);
  try {
    await engine.start();
    tick(engine);
    const id = alarm(engine);
    clock.t = local(2026, 9, 5, 7, 10);
    tick(engine);
    await until(() => firedOf(w, id).length >= 1, 1500);
    link = LA;
    engine.systemSignal({ kind: "clock.changed" }, clock.t + 1000);
    assert.equal(engine.automations.table.get(id)!.state, "fired");
    engine.automations.changeNow(id, "done");
    assert.equal(engine.automations.table.get(id)!.nextAt, local(2026, 9, 6, 7, 10), "Tuesday 07:10 in Los Angeles");
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("SL-1: a one-shot alarm ('tomorrow 07:00') keeps its wall clock across a zone change", async () => {
  process.env.TZ = NY;
  let link = NY;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 21, 0);
  try {
    await engine.start();
    tick(engine);
    const id = alarm(engine, "tomorrow 07:00");
    link = LA;
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    const a = engine.automations.table.get(id)!;
    const want = local(2026, 9, 6, 7, 0); // Tue 07:00 in Los Angeles
    assert.deepEqual(a.when, { kind: "at", at: want });
    assert.equal(a.nextAt, want);
    clock.t = want;
    tick(engine);
    await until(() => firedOf(w, id).length >= 1, 1500);
    assert.equal(firedOf(w, id)[0]!.line, "07:00 · Wake up");
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("SL-1: a timer and a snoozed alarm keep their instants across a zone change; an interval keeps its cadence", async () => {
  process.env.TZ = NY;
  let link = NY;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 7, 0);
  try {
    await engine.start();
    tick(engine);
    const timer = armedId(engine.automations.arm({ name: "pasta", whenPhrase: "in 30 minutes", then: [{ kind: "chime", line: "pasta" }], echo: "x" }, "console", true));
    const every = armedId(engine.automations.arm({ name: "stretch", whenPhrase: "every 2 h", then: [{ kind: "say", line: "stretch" }], echo: "x" }, "console", true));
    const id = alarm(engine, "07:05");
    clock.t = local(2026, 9, 5, 7, 5);
    tick(engine);
    await until(() => firedOf(w, id).length >= 1, 1500);
    engine.automations.changeNow(id, "snooze", 10);
    const before = [timer, every, id].map((x) => engine.automations.table.get(x)!.nextAt);
    link = LA;
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    assert.deepEqual([timer, every, id].map((x) => engine.automations.table.get(x)!.nextAt), before);
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("SL-1: awake, a move east that puts today's 07:10 behind the clock is a missed row with Run now, in its own words", async () => {
  process.env.TZ = LA;
  let link = LA;
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = local(2026, 9, 5, 5, 0); // Mon 05:00 Los Angeles, 08:00 in New York
  try {
    await engine.start();
    tick(engine);
    const id = alarm(engine);
    link = NY;
    for (let i = 0; i < 61; i++) {
      clock.t += 1000;
      tick(engine);
    }
    await settle(40);
    assert.equal(process.env.TZ, NY);
    assert.deepEqual(missedOf(w, id).map((m) => m.dueAt), [local(2026, 9, 5, 7, 10)], "07:10 New York passed before the zone was read");
    assert.equal(firedOf(w, id).length, 0);
    const problems = engine.snapshot().problems.filter((p) => p.kind === "automation.missed");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.text, /missed Wake up 07:10 · the time zone moved/);
    assert.equal(engine.automations.table.get(id)!.nextAt, local(2026, 9, 6, 7, 10));
  } finally {
    await engine.stop();
    process.env.TZ = NY;
  }
});

test("SL-1: a daemon that starts in a new zone moves the rows the last one pinned: the weekly alarm and the one-shot ring at their wall clock", async () => {
  process.env.TZ = NY;
  const h = home();
  const first = world({ automations: { exec: execWith(() => NY), home: h } });
  let second: World | undefined;
  let stopped = false;
  first.clock.t = local(2026, 9, 5, 6, 0); // Mon 06:00 New York
  try {
    await first.engine.start();
    tick(first.engine);
    const weekly = alarm(first.engine);
    const once = armedId(first.engine.automations.arm({ name: "flight", whenPhrase: "tomorrow 07:00", then: [{ kind: "chime", line: "flight" }], echo: "x" }, "console", true));
    assert.equal(readFileSync(join(first.dir, "state", "automations", "zone"), "utf8"), NY, "the zone the rows are pinned to is written down");
    await first.engine.stop();
    stopped = true;
    // The app quit in New York; the Mac flew; Jarhead opens at login in Los Angeles at 05:00 (08:00 New York).
    process.env.TZ = LA;
    second = world({ automations: { exec: execWith(() => LA), home: h } }, { dir: first.dir, firstSessionId: "sess_2" });
    second.clock.t = local(2026, 9, 5, 5, 0);
    await second.engine.start();
    const w = second.engine.automations.table.get(weekly)!;
    assert.equal(w.nextAt, local(2026, 9, 5, 7, 10), `Monday 07:10 in Los Angeles, not 04:10 (${clockOf(w.nextAt!)})`);
    const o = second.engine.automations.table.get(once)!;
    assert.deepEqual(o.when, { kind: "at", at: local(2026, 9, 6, 7, 0) });
    assert.equal(o.nextAt, local(2026, 9, 6, 7, 0));
    assert.equal(rows<MissedRow>(second, "automation.missed").length, 0);
    assert.equal(readFileSync(join(first.dir, "state", "automations", "zone"), "utf8"), LA);
  } finally {
    if (!stopped) await first.engine.stop();
    if (second) await second.engine.stop();
    process.env.TZ = NY;
  }
});

test("SL-1: repinned reads the wall clock in the old zone and builds it in the new one; a minute the new zone skips rolls forward", () => {
  process.env.TZ = LA;
  try {
    const nyMorning = Date.UTC(2026, 9, 5, 11, 10); // Mon 07:10 in New York
    assert.equal(repinned(nyMorning, NY), local(2026, 9, 5, 7, 10));
    assert.equal(repinned(nyMorning + 30_500, NY), local(2026, 9, 5, 7, 10) + 30_500, "the seconds past the minute are kept");
    assert.equal(repinned(nyMorning, "Not/AZone"), nyMorning, "an unknown zone leaves the instant");
    process.env.TZ = NY;
    // 02:30 on 8 Mar 2026 in Tokyo has no twin in New York: the clocks there go from 02:00 to 03:00 that night.
    const tokyo = Date.UTC(2026, 2, 7, 17, 30); // Sun 8 Mar 02:30 in Tokyo
    assert.equal(repinned(tokyo, "Asia/Tokyo"), local(2026, 2, 8, 3, 0));
  } finally {
    process.env.TZ = NY;
  }
});
