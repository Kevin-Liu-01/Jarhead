import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clockOf } from "@jarhead/core";
import type { Automation, LedgerRow } from "@jarhead/protocol";
import type { Engine } from "../engine.ts";
import type { AutomationExec } from "../automations/index.ts";
import { rows, settle, until, world } from "./world.ts";

/**
 * W2-2 SL-1: times are local. A zone change (the Mac flew west) moves every armed clock row to the
 * new zone's wall clock: the app forwards NSSystemTimeZoneDidChange as `clock.changed`, and the
 * daemon reads the zone link itself once a minute. node --test runs this file in its own process,
 * so the zone is this file's to move; every test puts New York back.
 */

process.env.TZ = "America/New_York";

const M = 60_000;
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();
type FiredRow = Extract<LedgerRow, { type: "automation.fired" }>;
type MissedRow = Extract<LedgerRow, { type: "automation.missed" }>;
const home = (): string => mkdtempSync(join(tmpdir(), "jh-w22-tz-"));
/** No process runs; `zone` is the link the daemon would read, scripted. */
const execWith = (zone?: () => string | undefined): AutomationExec => ({ run: async () => ({ code: 0 }), hold: () => undefined, ...(zone ? { zone } : {}) });
const armedId = (r: unknown): string => {
  assert.equal((r as { kind: string }).kind, "armed", JSON.stringify(r));
  return (r as { automation: Automation }).automation.id;
};

test("SL-1: 'weekdays 07:10' armed in New York rings at 07:10 local after the Mac moves to Los Angeles", async () => {
  process.env.TZ = "America/New_York";
  const w = world({ automations: { exec: execWith(), home: home() } });
  const { engine, clock } = w;
  clock.t = new Date(2026, 9, 5, 6, 0, 0).getTime(); // Mon 06:00 New York
  try {
    await engine.start();
    const id = armedId(engine.automations.arm({ name: "Wake up", whenPhrase: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }], echo: "Weekdays at 07:10, ring." }, "console", true));
    assert.equal(clockOf(engine.automations.table.get(id)!.nextAt!), "07:10");
    process.env.TZ = "America/Los_Angeles";
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    const after = engine.automations.table.get(id)!;
    assert.equal(clockOf(after.nextAt!), "07:10", `next ring reads ${clockOf(after.nextAt!)} local`);
    assert.equal(after.nextAt, new Date(2026, 9, 5, 7, 10, 0).getTime(), "today's 07:10 in the new zone");
    assert.equal(rows<MissedRow>(w, "automation.missed").length, 0, "a zone change is not a missed fire");
    clock.t = after.nextAt!;
    tick(engine);
    await until(() => rows<FiredRow>(w, "automation.fired").length >= 1, 1500);
    const f = rows<FiredRow>(w, "automation.fired");
    assert.equal(f.length, 1);
    assert.equal(f[0]!.line, "07:10 · Wake up", `the alarm rang as "${f[0]!.line}"`);
  } finally {
    await engine.stop();
    process.env.TZ = "America/New_York";
  }
});

test("SL-1: the daemon reads the zone link once a minute; a change sets the process zone and moves the rows, with no signal from the app", async () => {
  process.env.TZ = "America/New_York";
  let link = "America/New_York";
  const w = world({ automations: { exec: execWith(() => link), home: home() } });
  const { engine, clock } = w;
  clock.t = new Date(2026, 9, 5, 6, 0, 0).getTime();
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "standup", whenPhrase: "daily 09:00", then: [{ kind: "say", line: "standup" }], echo: "Daily at 09:00, say standup." }, "console", true));
    const before = engine.automations.table.get(id)!.nextAt!;
    link = "America/Los_Angeles";
    for (let i = 0; i < 61; i++) {
      clock.t += 1000;
      tick(engine);
    }
    assert.equal(process.env.TZ, "America/Los_Angeles", "the process follows the link");
    const after = engine.automations.table.get(id)!.nextAt!;
    assert.equal(clockOf(after), "09:00");
    assert.equal(after - before, 3 * 60 * M, "09:00 Pacific is three hours after 09:00 Eastern");
  } finally {
    await engine.stop();
    process.env.TZ = "America/New_York";
  }
});

test("SL-1: the first read of the link only records it: a process started with its own TZ keeps it until the link moves", async () => {
  process.env.TZ = "America/New_York";
  const w = world({ automations: { exec: execWith(() => "Europe/London"), home: home() } });
  const { engine, clock } = w;
  try {
    await engine.start();
    for (let i = 0; i < 3; i++) {
      clock.t += 61_000;
      tick(engine);
    }
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    assert.equal(process.env.TZ, "America/New_York");
  } finally {
    await engine.stop();
    process.env.TZ = "America/New_York";
  }
});

test("SL-1: a clock change with no zone change still settles what the jump passed: the 07:10 alarm the clock skipped is missed, not moved", async () => {
  process.env.TZ = "America/New_York";
  const w = world({ automations: { exec: execWith(), home: home() } });
  const { engine, clock } = w;
  clock.t = new Date(2026, 9, 5, 6, 0, 0).getTime();
  try {
    await engine.start();
    tick(engine);
    const id = armedId(engine.automations.arm({ name: "Wake up", whenPhrase: "weekdays 07:10", then: [{ kind: "chime", line: "Wake up", sound: "Hero" }], echo: "x" }, "console", true));
    clock.t = new Date(2026, 9, 5, 8, 0, 0).getTime(); // Kevin set the clock forward two hours
    engine.systemSignal({ kind: "clock.changed" }, clock.t);
    await settle(40);
    const missed = rows<MissedRow>(w, "automation.missed").filter((m) => m.id === id);
    assert.deepEqual(missed.map((m) => m.dueAt), [new Date(2026, 9, 5, 7, 10, 0).getTime()]);
    assert.equal(engine.automations.table.get(id)!.nextAt, new Date(2026, 9, 6, 7, 10, 0).getTime());
  } finally {
    await engine.stop();
    process.env.TZ = "America/New_York";
  }
});
