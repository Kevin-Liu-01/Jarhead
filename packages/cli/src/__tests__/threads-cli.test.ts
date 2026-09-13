import { test } from "node:test";
import assert from "node:assert/strict";
import type { Thread, Worker } from "@jarhead/protocol";
import { resolveThread, threadGlyph, threadsLines, workersFallbackLines } from "../threads-cli.ts";

/**
 * `jarhead cmd thread.stop <id|name>` and the `threads N (M live)` block of `jarhead status`,
 * without a daemon: the resolver's rules (id first, live name before a lingering one,
 * case-insensitive, "main" and `t_…` pass through, an unknown name names what is live)
 * and the exact lines.
 */

const thread = (over: Partial<Thread> & Pick<Thread, "id" | "name" | "status">): Thread => ({
  lane: "background",
  task: "",
  apps: [],
  startedAt: 0,
  updatedAt: 0,
  turns: 1,
  steps: 0,
  waits: 0,
  budget: { steps: 25, seconds: 180 },
  canSay: true,
  canStop: true,
  ...over,
});

const table: Thread[] = [
  thread({ id: "main", name: "Jarhead", status: "idle", lane: "voice" }),
  thread({ id: "t_1", name: "Slack", status: "acting", lane: "screen", steps: 4, detail: "click_element Send · ok", apps: ["Slack"] }),
  thread({ id: "t_2", name: "Spotify", status: "waiting-kevin", steps: 1, question: "play Focus on the living-room speaker?" }),
  thread({ id: "t_0", name: "slack", status: "done", steps: 3, doneAt: 5, detail: "sent" }),
];

test("resolveThread: an id is sent as it is; a name finds the LIVE thread before a lingering finished one, whatever the case", () => {
  assert.deepEqual(resolveThread(table, "t_2"), { threadId: "t_2", target: table[2] });
  assert.equal(resolveThread(table, "slack").threadId, "t_1", "the live Slack, not the finished t_0 that lingers under the same name");
  assert.equal(resolveThread(table, "SLACK").threadId, "t_1");
  assert.equal(resolveThread(table, "Spotify").threadId, "t_2");
  assert.equal(resolveThread(table, "jarhead").threadId, "main", "the main thread by its name");
  // Only a finished one carries the name → it is still what the name means (a pause on it is refused by the engine, not here).
  const finishedOnly = table.filter((t) => t.id !== "t_1");
  assert.equal(resolveThread(finishedOnly, "slack").threadId, "t_0");
});

test("resolveThread: 'main' and a t_… id pass through when the table does not list them; an unknown name throws naming the live threads", () => {
  assert.deepEqual(resolveThread([], "main"), { threadId: "main" });
  assert.deepEqual(resolveThread([], "t_77"), { threadId: "t_77" });
  assert.throws(() => resolveThread(table, "chrome"), /^Error: no thread called chrome; live: Jarhead \(main\), Slack \(t_1\), Spotify \(t_2\)$/);
  assert.throws(() => resolveThread([], "chrome"), /no thread called chrome; nothing is live/);
  assert.throws(() => resolveThread(table.filter((t) => t.id === "t_0"), "spotify"), /nothing is live/, "a lingering finished thread is not 'live'");
});

test("threadGlyph: the settled statuses draw as the Console does; everything busy is a spinner", () => {
  assert.deepEqual(
    (["done", "failed", "stopped", "waiting-kevin", "paused", "idle", "acting", "thinking", "queued", "starting", "waiting-screen"] as const).map(threadGlyph),
    ["✔", "✘", "–", "?", "‖", "·", "⟳", "⟳", "⟳", "⟳", "⟳"],
  );
});

test("threadsLines: `threads N (M live)` then one row per thread — glyph, name, status, lane, steps, id, the question it asks else its detail", () => {
  assert.deepEqual(threadsLines(table), [
    "  threads    4 (3 live)",
    "    · Jarhead          idle           voice      0 steps · main",
    "    ⟳ Slack            acting         screen     4 steps · t_1 · click_element Send · ok",
    "    ? Spotify          waiting-kevin  background 1 step · t_2 · asks: play Focus on the living-room speaker?",
    "    ✔ slack            done           background 3 steps · t_0 · sent",
  ]);
  assert.deepEqual(threadsLines([]), ["  threads    0 (0 live)"]);
});

test("workersFallbackLines: an older daemon's workers list, said so", () => {
  const w = (over: Partial<Worker> & Pick<Worker, "id" | "name" | "status">): Worker => ({ delegationId: "d_1", lane: "background", task: "", startedAt: 0, steps: 0, ...over });
  assert.deepEqual(workersFallbackLines([]), ["  workers    0 (an older daemon: no thread table)"]);
  assert.deepEqual(workersFallbackLines([w({ id: "w_1", name: "Slack", status: "working", steps: 1 }), w({ id: "w_0", name: "Spotify", status: "done", steps: 2, detail: "played" })]), [
    "  workers    2 (1 running) (an older daemon: no thread table)",
    "    ⟳ Slack            working                background 1 step · w_1",
    "    ✔ Spotify          done                   background 2 steps · w_0 · played",
  ]);
});
