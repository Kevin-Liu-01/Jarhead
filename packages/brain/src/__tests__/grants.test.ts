import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import type { Ledger } from "@jarhead/core";
import type { LedgerRow } from "@jarhead/protocol";
import { Delegator } from "../delegator.ts";
import type { Brain, BrainResult, BrainTask } from "../brain.ts";

/**
 * K5 (2026-09-12): the arm-on-yes → grant hook in the Delegator. Kevin's spoken yes
 * to a repeatable question (act in a hands-off app) arms the confirmation as before
 * and, because the question carried a grant class, issues a grant and puts a `grant`
 * row on the ledger at once. A yes to a destructive question arms it and leaves no
 * row: those keep asking.
 */

class FakeLive extends EventEmitter {
  sent: string[] = [];
  nowMs = 5000;
  appendThinking(): string { return "t"; }
  appendCommentary(_id: string | null, content: string): string { this.sent.push(content); return "c"; }
  appendInstructions(_id: string | null, content: string): string { this.sent.push(content); return "i"; }
}

function world(withLedger = true): { live: FakeLive; transcript: Transcript; confirmations: ConfirmationState; rows: LedgerRow[]; tasks: BrainTask[]; d: Delegator; clock: () => number } {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  let clock = 100_000;
  const confirmations = new ConfirmationState(3 * 60_000, () => clock);
  const rows: LedgerRow[] = [];
  const ledger = withLedger ? ({ append: (row: LedgerRow) => rows.push(row) } as unknown as Ledger) : undefined;
  const tasks: BrainTask[] = [];
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (task): Promise<BrainResult> => {
      tasks.push(task);
      return { status: "done", summary: "done" };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations, ...(ledger ? { ledger } : {}), now: () => clock, commentaryCoalesceMs: 0 });
  return { live, transcript, confirmations, rows, tasks, d, clock: () => clock };
}

test("no ledger, no grant: a yes the Delegator cannot record arms the one action and keeps nothing (no grant ever stands without its row)", async () => {
  const w = world(false);
  w.confirmations.ask('click "Copy" in 1Password', "left_click", { coordinate: [100, 100] }, { app: "com.1password.1password", actionClass: "click" });
  w.transcript.push({ speaker: "kevin", delta: "yes", startMs: 0, endMs: 500 });
  w.live.emit("delegation", "item_1", "client", 500);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.tasks[0]?.confirmation, true, "armed: the one click runs on this yes");
  assert.equal(w.confirmations.activeGrants.length, 0, "nothing kept");
  assert.ok(!w.confirmations.granted("com.1password.1password", "click"));
});

test("a request that is not a yes drops the question but not the standing grants (moving on is not a cut)", async () => {
  const w = world();
  w.confirmations.ask('click "Copy" in 1Password', "left_click", { coordinate: [100, 100] }, { app: "com.1password.1password", actionClass: "click" });
  w.transcript.push({ speaker: "kevin", delta: "yes", startMs: 0, endMs: 500 });
  w.live.emit("delegation", "item_1", "client", 500);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(w.confirmations.granted("com.1password.1password", "click"));
  // A new question stands, and Kevin asks for something else: the question goes, the grant stays.
  w.confirmations.ask('click "Send" in Mail', "left_click", { coordinate: [500, 300] });
  w.live.nowMs = 9000;
  w.transcript.push({ speaker: "kevin", delta: "actually open Notes", startMs: 3000, endMs: 4500 });
  w.live.emit("delegation", "item_2", "client", 4500);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.confirmations.pending, undefined, "the question is gone");
  assert.ok(w.confirmations.granted("com.1password.1password", "click"), "the grant stands");
  assert.equal(w.rows.filter((r) => r.type === "grant").length, 1);
});

test("a spoken yes to the hands-off question arms it, issues the grant and writes the grant row; the chain id is the one the engine set", async () => {
  const w = world();
  w.confirmations.beginConversation("sess_root");
  // The tool asked: click "Copy" in 1Password — a repeatable question (grant class "click").
  w.confirmations.ask('click "Copy" in 1Password', "left_click", { coordinate: [100, 100] }, { app: "com.1password.1password", actionClass: "click" });

  w.transcript.push({ speaker: "kevin", delta: "yes go ahead", startMs: 0, endMs: 800 });
  w.live.emit("delegation", "item_1", "client", 800);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(w.tasks.length, 1);
  assert.equal(w.tasks[0]!.confirmation, true, "the task knows it is the yes");
  assert.ok(w.confirmations.granted("com.1password.1password", "click"), "the grant stands");
  const grant = w.rows.find((r) => r.type === "grant");
  assert.ok(grant, "a grant row went on the ledger");
  assert.equal(grant.type, "grant");
  if (grant.type !== "grant") return;
  assert.equal(grant.chainId, "sess_root");
  assert.equal(grant.app, "com.1password.1password");
  assert.equal(grant.actionClass, "click");
  assert.equal(grant.at, w.clock());
  assert.ok(grant.until > grant.at, "until is the ceiling; the chain's end comes first");
  assert.equal(w.rows.filter((r) => r.type === "grant").length, 1, "one row per yes");
  // The record of the delegation is there too, as always.
  assert.ok(w.rows.some((r) => r.type === "delegation.created"));
});

test("a spoken yes to a destructive question (Send) arms it and leaves no grant and no row; a request that is not a yes drops the question", async () => {
  const w = world();
  w.confirmations.ask('click "Send" in Mail', "left_click", { coordinate: [500, 300] });
  w.transcript.push({ speaker: "kevin", delta: "yes", startMs: 0, endMs: 500 });
  w.live.emit("delegation", "item_1", "client", 500);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.tasks[0]?.confirmation, true);
  assert.equal(w.rows.filter((r) => r.type === "grant").length, 0, "Send: no grant, ever");
  assert.equal(w.confirmations.activeGrants.length, 0);

  // A new question, then something else entirely: the question is dropped, nothing granted.
  w.confirmations.ask('click "Copy" in 1Password', "left_click", { coordinate: [1, 1] }, { app: "com.1password.1password", actionClass: "click" });
  w.live.nowMs = 9000;
  w.transcript.push({ speaker: "kevin", delta: "open the budget spreadsheet instead", startMs: 3000, endMs: 4500 });
  w.live.emit("delegation", "item_2", "client", 4500);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.tasks[1]?.confirmation, false);
  assert.equal(w.confirmations.pending, undefined, "moved on: the question is gone");
  assert.equal(w.rows.filter((r) => r.type === "grant").length, 0);
});
