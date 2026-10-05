import { test } from "node:test";
import assert from "node:assert/strict";
import { describe } from "@jarhead/core";
import type { Automation } from "@jarhead/protocol";
import { landedAutomation, parseClockAutomation } from "../automations-cli.ts";

/**
 * W2-2: `jarhead automations add` hands its when-words to core's parseWhen, so the phrasings
 * the README uses arm from the CLI too (SL-16), and the quiet clause follows the derived kind.
 * A second "pasta" after a done one is the engine's to arm now (SL-5); `add` still prints only
 * the row it created.
 */

process.env.TZ = "America/New_York";
const NOW = new Date(2026, 9, 5, 6, 0, 0).getTime();

test("SL-16: the README's phrasings arm from the CLI, the quiet clause from the kind", () => {
  const alarm = parseClockAutomation("at seven ten on weekdays chime 'Wake up'", NOW);
  assert.ok(!("error" in alarm), JSON.stringify(alarm));
  assert.equal(describe(alarm.when!), "weekdays 07:10");
  assert.equal(alarm.clauses.quiet, "override", "a chime on a clock is an alarm");
  const timer = parseClockAutomation("in twelve minutes chime pasta", NOW);
  assert.ok(!("error" in timer), JSON.stringify(timer));
  assert.equal(describe(timer.when!), "in 12 min");
  assert.equal(timer.clauses.quiet, "respect", "a chime at `in` is a timer");
  const nightly = parseClockAutomation("every night at eleven say 'bed'", NOW);
  assert.ok(!("error" in nightly), JSON.stringify(nightly));
  assert.equal(describe(nightly.when!), "daily 23:00");
});

test("SL-5: a done pasta (now renamed by the engine) never passes for the new one", () => {
  const sentAt = NOW;
  const base = { when: { kind: "in", ms: 720_000 }, then: [{ kind: "chime", line: "pasta" }], clauses: { quiet: "respect" }, echo: "", fires: 0, missed: 0, updatedAt: NOW, createdBy: { by: "cli", request: "" } } as const;
  const rows = [
    { ...base, id: "auto_old000", name: "pasta · 28 Sep", state: "done", createdAt: NOW - 7 * 86_400_000 },
    { ...base, id: "auto_new000", name: "pasta", state: "armed", createdAt: NOW + 5 },
  ] as unknown as Automation[];
  assert.equal(landedAutomation(rows, "pasta", sentAt)?.id, "auto_new000");
});
