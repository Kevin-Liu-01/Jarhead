import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { CodexAppServer, PRIMER_TEXT, appServerArgs } from "../codex-app-server.ts";

/**
 * The warm transport's JSON-RPC client against an in-process stand-in: a stop
 * that arrives while turn/start is still unanswered (a thread's first turn takes
 * ~2 s while the MCP servers start) must still interrupt the server-side turn
 * once its id is known — otherwise the turn runs on after Kevin's stop and its
 * tool calls reach the daemon with no delegation attached. And the boot budget
 * is the boot budget: thread/start gets what is left of startTimeoutMs, not a
 * hard-coded minute.
 */

/** One turn's tokenUsage as the fake reports it: `total` the thread's running bill, `last` the last request (the context as it stands). */
interface FakeUsage {
  readonly total: number;
  readonly last: number;
  readonly window?: number | null;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  requests: { id: number | undefined; method: string; params: Record<string, unknown> }[] = [];
  turnStartDelayMs = 300;
  threadStartDelayMs = 0;
  /** Whether turn/interrupt is followed by turn/completed{interrupted} (a server that never says so is given up locally). */
  completesOnInterrupt = true;
  /**
   * Turns that complete on their own: after the reply, one agentMessage, this usage (shifted per
   * turn), turn/completed. Unset = the turn hangs after its first tool item (the interrupt tests).
   */
  completing: { usages: readonly FakeUsage[]; afterMs: number } | undefined;
  threads = 0;
  turns = 0;
  constructor() {
    super();
    let buf = "";
    this.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        if (!msg.method) continue;
        this.requests.push({ id: msg.id, method: msg.method, params: msg.params ?? {} });
        const reply = (result: unknown): boolean => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
        const notif = (method: string, params: unknown): boolean => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
        if (msg.method === "initialize") reply({ userAgent: "fake" });
        else if (msg.method === "thread/start") {
          const id = `thr_${++this.threads}`;
          setTimeout(() => reply({ thread: { id }, model: "fake", reasoningEffort: null }), this.threadStartDelayMs);
        } else if (msg.method === "turn/start") {
          const threadId = String(msg.params?.["threadId"] ?? "thr_1");
          const turnId = `turn_${++this.turns}`;
          const n = this.turns;
          // The first turn on a thread starts the MCP servers before the reply lands.
          setTimeout(() => {
            reply({ turn: { id: turnId, status: "inProgress" } });
            notif("turn/started", { threadId, turnId, turn: { id: turnId, status: "inProgress" } });
            const completing = this.completing;
            if (!completing) {
              setTimeout(() => notif("item/started", { threadId, turnId, item: { type: "mcpToolCall", server: "jarhead", tool: "left_click", status: "inProgress" } }), 50);
              return;
            }
            setTimeout(() => {
              if (this.interruptedTurns.has(turnId)) return;
              notif("item/completed", { threadId, turnId, item: { type: "agentMessage", id: `msg_${n}`, text: `answer ${n}`, phase: "final_answer" } });
              const u = completing.usages[Math.min(n - 1, completing.usages.length - 1)];
              if (u) notif("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: { totalTokens: u.total, inputTokens: u.total - 20, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 }, last: { totalTokens: u.last, inputTokens: u.last - 20, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 }, modelContextWindow: u.window === undefined ? 258_400 : u.window } });
              notif("turn/completed", { threadId, turnId, turn: { id: turnId, status: "completed", error: null } });
            }, completing.afterMs);
          }, this.turnStartDelayMs);
        } else if (msg.method === "turn/interrupt") {
          const turnId = String(msg.params?.["turnId"] ?? "turn_1");
          const threadId = String(msg.params?.["threadId"] ?? "thr_1");
          this.interruptedTurns.add(turnId);
          reply({});
          if (this.completesOnInterrupt) notif("turn/completed", { threadId, turnId, turn: { id: turnId, status: "interrupted", error: null } });
        }
      }
    });
    setImmediate(() => this.emit("spawn"));
  }
  readonly interruptedTurns = new Set<string>();
  /** turn/start params in order. */
  get turnStarts(): Record<string, unknown>[] {
    return this.requests.filter((r) => r.method === "turn/start").map((r) => r.params);
  }
  kill(): boolean {
    this.exitCode = 0;
    setImmediate(() => this.emit("close", 0, null));
    return true;
  }
}

function server(child: FakeChild, extra: Partial<ConstructorParameters<typeof CodexAppServer>[0]> = {}): CodexAppServer {
  return new CodexAppServer({ bin: "codex", cwd: "/tmp", env: {}, codexHome: "/tmp/no-codex-home", node: "node", tsxCli: "tsx", bridgePath: "bridge", socketPath: "/tmp/x.sock", developerInstructions: "x", disableUserServers: false, spawnImpl: (() => child as unknown as ChildProcess) as never, killGraceMs: 10, ...extra });
}

test("app-server: interrupt() before turn/start has answered still interrupts the server-side turn once its id is known, and the turn resolves on the server's word", async () => {
  const child = new FakeChild();
  const s = server(child);
  await s.start();
  const started: string[] = [];
  const turn = s.turn([{ type: "text", text: "click save", text_elements: [] }], { onItemStarted: (i) => started.push(`${i.type}:${i.tool}`) });
  await new Promise((r) => setTimeout(r, 30)); // Kevin presses stop while turn/start is in flight
  const t0 = Date.now();
  await s.interrupt();
  assert.ok(Date.now() - t0 < 50, "interrupt() returns at once; it does not wait for turn/start");
  assert.ok(!child.requests.some((r) => r.method === "turn/interrupt"), "nothing to interrupt yet: no turn id");
  const result = await turn;
  assert.equal(result.status, "interrupted");
  assert.equal(result.turnId, "turn_1", "resolved by the server's turn/completed, with the real id");
  const methods = child.requests.map((r) => r.method);
  assert.deepEqual(methods, ["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt"], "turn/interrupt went out the moment turn/start answered");
  assert.equal((child.requests[4]!.params as { turnId: string }).turnId, "turn_1");
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(started, [], "the interrupted turn's items never reach the handlers");
  // The thread is free for the next turn.
  child.turnStartDelayMs = 5;
  child.requests.length = 0;
  const next = s.turn([{ type: "text", text: "again", text_elements: [] }], {});
  await new Promise((r) => setTimeout(r, 40));
  await s.interrupt();
  assert.equal((await next).status, "interrupted");
  await s.stop();
});

test("app-server: a server that never completes an interrupted turn is given up locally after the grace period; a second interrupt() is a no-op", async () => {
  const child = new FakeChild();
  child.completesOnInterrupt = false;
  child.turnStartDelayMs = 10;
  const s = server(child, { interruptGraceMs: 120 });
  await s.start();
  const turn = s.turn([{ type: "text", text: "x", text_elements: [] }], {});
  await new Promise((r) => setTimeout(r, 40));
  const t0 = Date.now();
  await s.interrupt();
  await s.interrupt();
  const result = await turn;
  const took = Date.now() - t0;
  assert.equal(result.status, "interrupted");
  assert.ok(took >= 100 && took < 1000, `given up after the grace period (${took} ms)`);
  assert.equal(child.requests.filter((r) => r.method === "turn/interrupt").length, 1, "one turn/interrupt, not one per stop");
  await s.stop();
});

const text = (t: string): { type: "text"; text: string; text_elements: never[] } => ({ type: "text", text: t, text_elements: [] });

test("app-server: rollover judges the context as it stands (tokenUsage.last), not the thread's cumulative bill (total) — three trivial turns keep the thread, a full context replaces it in the background with the report in the log and a `rollover` event", async () => {
  const child = new FakeChild();
  child.turnStartDelayMs = 5;
  // The analyst's real sequence: the bill grows ~25k per request while the context stays 23–33k of a 258 400 window.
  child.completing = { usages: [{ total: 19_400, last: 23_100 }, { total: 38_800, last: 26_400 }, { total: 58_200, last: 33_000 }, { total: 240_000, last: 181_000 }, { total: 260_000, last: 24_000 }], afterMs: 5 };
  const s = server(child);
  const rollovers: string[] = [];
  s.on("rollover", (info) => rollovers.push(`${info.from}→${info.to} ${info.report}`));
  await s.start();
  for (let i = 0; i < 3; i++) {
    await s.settleThread();
    assert.equal((await s.turn([text(`trivial ${i + 1}`)], {})).status, "completed");
    assert.equal(s.needsFreshThread(), false, `turn ${i + 1}: context ${s.tokenUsage?.contextTokens} of ${s.tokenUsage?.contextWindow} is nowhere near 70 %`);
  }
  assert.equal(s.tokenUsage?.totalTokens, 58_200, "the bill after three turns");
  assert.equal(s.tokenUsage?.contextTokens, 33_000, "the context after three turns");
  assert.equal(s.contextReport(), "context 33k/258k (0.13)");
  assert.equal(child.threads, 1, "one thread across the three turns (the old code opened a new one after every delegation with a few tool calls: total/window > 0.7)");
  assert.deepEqual(rollovers, []);
  assert.deepEqual(child.turnStarts.map((p) => p["threadId"]), ["thr_1", "thr_1", "thr_1"]);

  // The fourth turn genuinely fills the context: 181k/258k. The replacement starts right after turn/completed.
  assert.equal((await s.turn([text("a long one")], {})).status, "completed");
  assert.equal(s.needsFreshThread(), true);
  assert.equal(s.isRollingOver, true, "thread/start for the replacement went out with the completion, not at the next turn");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(child.threads, 2);
  assert.deepEqual(rollovers, ["thr_1→thr_2 context 181k/258k (0.70)"]);
  assert.equal(s.thread, "thr_2");
  assert.equal(s.needsFreshThread(), false, "a fresh thread has no usage yet");
  // The next turn rides the new thread, with no thread/start on its own path.
  await s.settleThread();
  const before = child.threads;
  assert.equal((await s.turn([text("next")], {})).status, "completed");
  assert.equal(child.threads, before);
  assert.equal(child.turnStarts[4]!["threadId"], "thr_2");
  await s.stop();
});

test("app-server: a turn that arrives while the replacement thread is still starting waits for it (settleThread), and a full thread with background rollover off is replaced at the next turn instead", async () => {
  const child = new FakeChild();
  child.turnStartDelayMs = 5;
  child.completing = { usages: [{ total: 200_000, last: 190_000 }, { total: 210_000, last: 20_000 }], afterMs: 5 };
  const s = server(child);
  await s.start();
  child.threadStartDelayMs = 120; // the replacement is slow
  assert.equal((await s.turn([text("fill it")], {})).status, "completed");
  assert.equal(s.isRollingOver, true);
  const t0 = Date.now();
  await s.settleThread();
  assert.ok(Date.now() - t0 >= 100, "waited for thread/start rather than running on the full thread");
  assert.equal(s.isRollingOver, false);
  assert.equal(s.thread, "thr_2");
  assert.equal((await s.turn([text("next")], {})).status, "completed");
  assert.equal(child.turnStarts[1]!["threadId"], "thr_2");
  await s.stop();

  const lazy = new FakeChild();
  lazy.turnStartDelayMs = 5;
  lazy.completing = { usages: [{ total: 200_000, last: 190_000 }, { total: 210_000, last: 20_000 }], afterMs: 5 };
  const l = server(lazy, { backgroundRollover: false });
  await l.start();
  assert.equal((await l.turn([text("fill it")], {})).status, "completed");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lazy.threads, 1, "nothing in the background");
  assert.equal(l.needsFreshThread(), true);
  await l.settleThread();
  assert.equal(lazy.threads, 2, "replaced at the next turn");
  assert.equal(l.thread, "thr_2");
  await l.stop();
});

test("app-server: a primed thread — PRIMER_TEXT is the first turn after every thread/start; a real turn interrupts a primer still running, then goes out on the same thread", async () => {
  const child = new FakeChild();
  child.turnStartDelayMs = 20;
  child.completing = { usages: [{ total: 15_000, last: 15_000 }, { total: 30_000, last: 15_500 }, { total: 250_000, last: 200_000 }, { total: 265_000, last: 15_000 }], afterMs: 40 };
  const s = server(child, { primeThreads: true });
  await s.start();
  assert.equal(s.isPriming, true, "the primer left with the boot's return");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.isPriming, false);
  assert.deepEqual(s.primerStats, { started: 1, completed: 1, interrupted: 0 });
  assert.equal((child.turnStarts[0]!["input"] as Array<{ text: string }>)[0]!.text, PRIMER_TEXT);
  // A real turn now: no interrupt, the primer is long done.
  await s.settleThread();
  assert.equal((await s.turn([text("real")], {})).status, "completed");
  assert.ok(!child.requests.some((r) => r.method === "turn/interrupt"));
  // A turn that fills the context: the replacement thread gets its own primer; a task arriving mid-primer interrupts it first.
  assert.equal((await s.turn([text("fill it")], {})).status, "completed");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(child.threads, 2);
  await new Promise((r) => setTimeout(r, 30)); // the primer's turn/start is in flight (20 ms) or just answered
  assert.equal(s.isPriming, true);
  const settle = s.settleThread();
  await settle;
  assert.equal(s.isPriming, false);
  assert.deepEqual(s.primerStats, { started: 2, completed: 1, interrupted: 1 });
  assert.equal((await s.turn([text("after")], {})).status, "completed");
  const methods = child.requests.map((r) => r.method).filter((m) => m.startsWith("turn/") || m === "thread/start");
  assert.deepEqual(methods, ["thread/start", "turn/start", "turn/start", "turn/start", "thread/start", "turn/start", "turn/interrupt", "turn/start"], methods.join(" "));
  assert.equal(child.turnStarts[4]!["threadId"], "thr_2");
  await s.stop();
});

test("app-server: thread/start carries baseInstructions when given; turn/start carries the per-turn effort (else the server's); usage for another thread is ignored", async () => {
  const child = new FakeChild();
  child.turnStartDelayMs = 5;
  child.completing = { usages: [{ total: 10_000, last: 10_000 }], afterMs: 5 };
  const s = server(child, { effort: "medium", baseInstructions: "You are the brain of Jarhead." });
  await s.start();
  const threadStart = child.requests.find((r) => r.method === "thread/start")!.params;
  assert.equal(threadStart["baseInstructions"], "You are the brain of Jarhead.");
  assert.equal(threadStart["developerInstructions"], "x");
  assert.equal((await s.turn([text("a")], {}, { effort: "low" })).status, "completed");
  assert.equal((await s.turn([text("b")], {})).status, "completed");
  assert.equal((await s.turn([text("c")], {}, { effort: "max" })).status, "completed");
  assert.deepEqual(child.turnStarts.map((p) => p["effort"]), ["low", "medium", "xhigh"]);
  // A usage notification for a thread that is not ours (a stale one) changes nothing.
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thr_other", turnId: "t", tokenUsage: { total: { totalTokens: 999_999 }, last: { totalTokens: 999_999 }, modelContextWindow: 100 } } })}\n`);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.tokenUsage?.contextTokens, 10_000);
  assert.equal(s.needsFreshThread(), false);
  // No baseInstructions: the key is absent, so Codex keeps its own base prompt.
  const plain = new FakeChild();
  const p = server(plain);
  await p.start();
  assert.equal("baseInstructions" in plain.requests.find((r) => r.method === "thread/start")!.params, false);
  await p.stop();
  await s.stop();
});

test("app-server: the boot budget bounds thread/start (not a hard-coded minute), and the argv switches the plugin runtime and the notify hook off", async () => {
  const child = new FakeChild();
  child.threadStartDelayMs = 400;
  const s = server(child, { startTimeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(s.start(), /codex app-server did not start within 0s/);
  assert.ok(Date.now() - t0 < 1000);
  const args = appServerArgs({ bin: "codex", cwd: "/c", env: {}, codexHome: "/nowhere", node: "n", tsxCli: "t", bridgePath: "b", socketPath: "s", developerInstructions: "x", disableUserServers: false });
  assert.deepEqual(args.slice(0, 7), ["app-server", "--listen", "stdio://", "--disable", "apps", "-c", "notify=[]"]);
});
