/**
 * W3-1 (W2-1's hand-off): a typed brain failure, the proxy's own line ("Codex is signed out. Switching to the next
 * brain. Ask again."), is said as it is. Only a raw failure (an error the proxy has no better words for) keeps the
 * "Something went wrong:" head. Fake brains over the real selection walk; nothing starts a CLI or reaches a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain, BrainResult } from "@jarhead/brain";
import type { SelectableBrain } from "../engine.ts";
import { delegate, nextUtterance, settle, until, world, type World } from "./world.ts";

const said = (w: World): string[] => w.lives.flatMap((l) => [...l.instructions, ...l.commentary]);
const EXPIRED = "unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again.";

function fake(kind: SelectableBrain, handle: () => Promise<BrainResult>): Brain {
  return {
    kind,
    start: async () => ({ ready: true, detail: `${kind} (fake)` }),
    handle: async (task) => {
      const cancelled = new Promise<BrainResult>((resolve) => task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }));
      return Promise.race([handle(), cancelled]);
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
}

test("W3-1: the proxy's typed line is said as it is, with no 'Something went wrong:' head; under auto and with a brain Kevin picked", async () => {
  const codexBrains = [fake("codex", async () => ({ status: "failed", error: EXPIRED }))];
  const w = world({ brainOf: { codex: () => codexBrains.shift() ?? fake("codex", async () => ({ status: "done", summary: "done." })), "claude-code": () => fake("claude-code", async () => ({ status: "done", summary: "done." })) } }, { select: true });
  const picked = world({ brain: fake("codex", async () => ({ status: "failed", error: EXPIRED })) });
  try {
    for (const x of [w, picked]) {
      await x.engine.start();
      await x.engine.ready();
      x.engine.updateSettings({ idleSleepMinutes: 0 });
      await x.engine.wake("test");
      delegate(x, "jarhead summarize my last email from Ben", "item_1");
    }
    assert.ok(await until(() => said(w).some((s) => s.includes("Switching to the next brain"))), JSON.stringify(said(w)));
    assert.ok(said(w).includes("Codex is signed out. Switching to the next brain. Ask again."), JSON.stringify(said(w)));
    assert.ok(await until(() => said(picked).some((s) => s.includes("Run codex login"))), JSON.stringify(said(picked)));
    assert.ok(said(picked).includes("Codex is signed out. Run codex login, then press Retry."), JSON.stringify(said(picked)));
    for (const x of [w, picked]) assert.ok(!said(x).some((s) => s.startsWith("Something went wrong")), JSON.stringify(said(x)));
    // The record says what was said.
    const d = picked.engine.snapshot().delegations.find((x) => x.liveId === "item_1");
    assert.equal(d?.status, "failed");
    assert.equal(d?.summary, "Codex is signed out. Run codex login, then press Retry.");
  } finally {
    await picked.engine.stop();
    await w.engine.stop();
  }
});

test("W3-1: a raw failure the proxy has no words for keeps the head", async () => {
  const w = world({ brain: fake("codex", async () => ({ status: "failed", error: "the disk caught fire" })) });
  try {
    await w.engine.start();
    await w.engine.ready();
    w.engine.updateSettings({ idleSleepMinutes: 0 });
    await w.engine.wake("test");
    delegate(w, "jarhead summarize my last email from Ben", "item_1");
    assert.ok(await until(() => said(w).some((s) => s.includes("caught fire"))), JSON.stringify(said(w)));
    assert.ok(said(w).includes("Something went wrong: the disk caught fire"), JSON.stringify(said(w)));
    nextUtterance(w);
    await settle(20);
  } finally {
    await w.engine.stop();
  }
});
