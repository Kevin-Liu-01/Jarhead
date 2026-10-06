// W3-3: what the contract adds for its consumers, pinned on both sides the way contract-additions.test.ts pins W2-5's.
//
// - Carried decisions (W2-3's `Ledger.carry`): `carried?: true` and `decidedAt?` on the conversation.*, now.* and
//   agent.hidden rows; `lineage?` on ledger.moved. Declared in the TS rows and in Swift's LedgerRow, and the probe
//   fixture carries one of each, so protocol-probe.sh decodes them with the app's own Codable mirror.
// - Search older: `ledger.hits` carries `older`, and the app's mirror of one page (LedgerSearchPage) holds it.
// - LM-6: the app's mirror of the whole `ledger.days` answer (LedgerDays) holds the totals by day.
// - APP-3, the app's half: EngineClient sends ProtocolVersion.current in its hello, and the `app.version` row it raises
//   reads exactly as the fixture's sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CarriedDecision, LedgerRow, Problem, Snapshot } from "../index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SWIFT = readFileSync(join(ROOT, "apps/mac/Sources/Jarhead/Model/Protocol.swift"), "utf8");
const CLIENT = readFileSync(join(ROOT, "apps/mac/Sources/Jarhead/Daemon/EngineClient.swift"), "utf8");
type Frame = Record<string, unknown> & { readonly type: string };
const FIXTURE = JSON.parse(readFileSync(join(ROOT, "apps/mac/Scripts/fixtures/snapshot-threads.json"), "utf8")) as Frame[];
const frames = (type: string): Frame[] => FIXTURE.filter((f) => f.type === type);

/** The stored `public var`s of one Swift struct, name → declared type (computed vars carry a `{` and are skipped). */
function swiftVars(name: string): Map<string, string> {
  const lines = SWIFT.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^public struct ${name}\\b`).test(l));
  assert.ok(start >= 0, `Protocol.swift declares public struct ${name}`);
  const vars = new Map<string, string>();
  let depth = 0;
  for (const line of lines.slice(start)) {
    const code = line.replace(/\/\/.*$/, "");
    if (depth === 1) {
      const m = /^\s*public var (\w+): ([^={]+?)\s*(=.*)?$/.exec(code);
      if (m && !code.includes("{")) vars.set(m[1] as string, (m[2] as string).trim());
    }
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    if (depth === 0 && code.includes("}")) break;
  }
  return vars;
}

/** The cases of LedgerRow's CodingKeys, every `case a, b` line of the enum. */
function codingKeys(): Set<string> {
  const m = /public struct LedgerRow\b[\s\S]*?enum CodingKeys: String, CodingKey \{([\s\S]*?)\n {4}\}/.exec(SWIFT);
  assert.ok(m, "LedgerRow declares its CodingKeys");
  const keys = new Set<string>();
  for (const line of (m[1] as string).split("\n")) {
    const c = /^\s*case (.+)$/.exec(line.replace(/\/\/.*$/, ""));
    if (!c) continue;
    for (const part of (c[1] as string).split(",")) keys.add((part.split("=")[0] as string).trim());
  }
  return keys;
}

const CARRIED_TYPES = ["conversation.trashed", "conversation.restored", "conversation.archived", "conversation.renamed", "conversation.pinned", "now.cleared", "now.restored", "agent.hidden"] as const;

test("carried decisions: the conversation.*, now.* and agent.hidden rows declare carried and decidedAt; ledger.moved declares lineage; the rest of the rows do not", () => {
  // Type-level: each row type takes the carried fields, and a move takes its lineage.
  const renamed = { at: 2, type: "conversation.renamed", chainId: "s_a", name: "Budget", carried: true, decidedAt: 1 } satisfies LedgerRow;
  const cleared = { at: 2, type: "now.cleared", sessionId: "s_a", carried: true, decidedAt: 1 } satisfies LedgerRow;
  const hidden = { at: 2, type: "agent.hidden", agentId: "codex:1", hidden: true, carried: true, decidedAt: 1 } satisfies LedgerRow;
  const moved = { at: 3, type: "ledger.moved", day: "2026-09-08", what: "ledger", to: "trash", path: "/x", by: "kevin", lineage: { s_b: ["s_a"] } } satisfies LedgerRow;
  const fields: Required<CarriedDecision> = { carried: true, decidedAt: 1 };
  assert.deepEqual(Object.keys(fields).sort(), ["carried", "decidedAt"]);
  for (const row of [renamed, cleared, hidden]) assert.equal(row.carried, true);
  assert.deepEqual(moved.lineage, { s_b: ["s_a"] });
  // @ts-expect-error a session row is never carried: only decisions are
  const notADecision = { at: 1, type: "session.started", sessionId: "s", voice: "ballad", carried: true } satisfies LedgerRow;
  assert.ok(notADecision);
});

test("carried decisions: Swift's LedgerRow reads carried, decidedAt and lineage under their wire names", () => {
  const row = swiftVars("LedgerRow");
  assert.equal(row.get("carried"), "Bool?");
  assert.equal(row.get("decidedAt"), "Double?");
  assert.equal(row.get("lineage"), "[String: [String]]?");
  const keys = codingKeys();
  for (const k of ["carried", "decidedAt", "lineage"]) assert.ok(keys.has(k), `CodingKeys names ${k}`);
});

test("carried decisions: the probe fixture's ledger.rows carry a carried decision of each family (decided before the move that wrote it) and a move with its lineage", () => {
  const rows = frames("ledger.rows").flatMap((f) => f["rows"] as Record<string, unknown>[]);
  const carried = rows.filter((r) => r["carried"] === true);
  for (const family of ["conversation.", "now.", "agent.hidden"]) {
    assert.ok(carried.some((r) => String(r["type"]).startsWith(family)), `a carried ${family} row`);
  }
  for (const r of carried) {
    assert.ok((CARRIED_TYPES as readonly string[]).includes(String(r["type"])), `${String(r["type"])} is a decision`);
    assert.ok(typeof r["decidedAt"] === "number" && (r["decidedAt"] as number) < (r["at"] as number), "decided before the move carried it");
  }
  const move = rows.find((r) => r["type"] === "ledger.moved" && r["lineage"] !== undefined);
  assert.ok(move, "a ledger.moved row with its lineage");
  const lineage = move["lineage"] as Record<string, unknown>;
  assert.ok(Object.values(lineage).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string")), "per heir, the ids it continues");
});

test("search older: ledger.hits carries older; Swift's LedgerSearchPage holds the hits and older, and the fixture's page names a day", () => {
  const page = swiftVars("LedgerSearchPage");
  assert.equal(page.get("hits"), "[LedgerHit]");
  assert.equal(page.get("older"), "String?");
  const hits = frames("ledger.hits")[0];
  assert.ok(hits, "the fixture carries a ledger.hits page");
  assert.match(String(hits["older"]), /^\d{4}-\d{2}-\d{2}$/, "older is a day, the next request's before");
  assert.ok(Array.isArray(hits["hits"]) && (hits["hits"] as unknown[]).length > 0);
});

test("LM-6: Swift's LedgerDays holds the day list, the totals by day, and whether the daemon answered before it read them all (`partial`)", () => {
  const days = swiftVars("LedgerDays");
  assert.equal(days.get("days"), "[String]");
  assert.equal(days.get("totals"), "[String: LedgerDayTotals]");
  assert.equal(days.get("partial"), "Bool");
  assert.match(CLIENT, /partial: \(obj\["partial"\] as\? Bool\) \?\? false/, "EngineClient reads the wire's `partial`, false when absent");
});

test("APP-3, the app's half: EngineClient's hello carries ProtocolVersion.current, and its app.version row is the fixture's sample word for word", () => {
  const hello = /private func sendHello\(\) \{([\s\S]*?)\n {4}\}/.exec(CLIENT);
  assert.ok(hello, "EngineClient.sendHello");
  assert.match(hello[1] as string, /"protocol": ProtocolVersion\.current/, "the app names the contract it was built in");
  const sample = (frames("snapshot").map((f) => f["snapshot"] as Snapshot).flatMap((s) => s.problems) as Problem[]).find((p) => p.kind === "app.version");
  assert.ok(sample, "the fixture carries the app.version sample");
  const text = /static let skewProblemText = "([^"]*)"/.exec(CLIENT);
  assert.ok(text, "EngineClient names the skew row's text once");
  assert.equal(text[1], sample.text);
  assert.doesNotMatch(CLIENT.match(/static let skew\w*Text = "[^"]*"/g)?.join("\n") ?? "", /—/, "no em dash in the skew's words");
});
