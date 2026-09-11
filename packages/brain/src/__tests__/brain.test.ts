import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ComputerToolset, ConfirmationState, type NativeHands } from "@jarhead/hands";
import { AgentRegistry, type AgentConnector } from "@jarhead/agents";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ToolRunner, resultText } from "../runner.ts";
import { Delegator } from "../delegator.ts";
import { ResponsesBrain, responsesDelegationConfig } from "../responses.ts";
import { zodShape, ClaudeBrain } from "../claude.ts";
import { ALL_TOOL_SPECS, specByName } from "../tools.ts";
import type { Brain, BrainResult, BrainSink, BrainTask } from "../brain.ts";

class FakeHands implements NativeHands {
  ready = true;
  async request<T>(op: string): Promise<T> {
    if (op === "screenshot") return { displayId: 1, pngBase64: Buffer.from("png").toString("base64"), width: 100, height: 50, points: { x: 0, y: 0, w: 200, h: 100 }, scale: 0.5 } as T;
    if (op === "frontmost") return { app: "Finder", pid: 1, window: null } as T;
    if (op === "element_at") return { role: "AXButton", title: "Open" } as T;
    if (op === "cursor") return { x: 10, y: 10 } as T;
    return {} as T;
  }
}

const fakeConnector: AgentConnector = {
  kind: "sessions",
  health: async () => ({ kind: "sessions", ok: true, detail: "ok" }),
  list: async () => [{ id: "sessions:claude:w1p1", kind: "sessions", name: "reviewer", status: "idle", cwd: "/repo", updatedAt: 0 }],
  send: async () => ({ accepted: true }),
  read: async () => "last line",
};

function makeRunner(): { runner: ToolRunner; steps: string[]; spoken: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "jh-brain-"));
  const toolset = new ComputerToolset({ hands: new FakeHands(), confirmations: new ConfirmationState() });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([fakeConnector], 0), stateDir: dir });
  const steps: string[] = [];
  const spoken: string[] = [];
  runner.attach({
    thinking: () => undefined,
    commentary: (t) => spoken.push(t),
    step: (s) => steps.push(`${s.kind}:${s.tool?.name ?? s.text ?? ""}`),
    screenshot: (p) => steps.push(`shot:${p.split("/")[0]}`),
  });
  return { runner, steps, spoken, dir };
}

test("runner archives screenshots, routes agent tools, and gates shell", async () => {
  const { runner, steps, spoken } = makeRunner();
  const shot = await runner.run("screenshot", {});
  assert.equal(shot.result.kind, "image");
  assert.ok(shot.screenshotPath?.startsWith("shots/"));
  assert.deepEqual(steps.slice(0, 2), ["shot:shots", "tool:screenshot"]);

  const list = await runner.run("agents_list", {});
  assert.match(resultText(list.result), /reviewer/);
  const sent = await runner.run("agent_send", { agent: "the reviewer", text: "hi" });
  assert.match(resultText(sent.result), /sent to reviewer/);

  const ro = await runner.run("run_shell", { command: "echo hello" });
  assert.match(resultText(ro.result), /hello/);
  const mut = await runner.run("run_shell", { command: "rm -rf ./build" });
  assert.equal(mut.result.kind, "needs-confirmation");

  await runner.run("speak_progress", { text: "halfway there" });
  assert.deepEqual(spoken, ["halfway there"]);
  await runner.run("remember", { note: "kevin likes cedar" });
  assert.match(resultText((await runner.run("recall", {})).result), /cedar/);
  assert.equal((await runner.run("nope", {})).result.kind, "error");
});

test("tool specs are complete and map to zod shapes", () => {
  assert.equal(ALL_TOOL_SPECS.length, 17 + 6 + 5 + 4);
  const names = new Set(ALL_TOOL_SPECS.map((t) => t.name));
  assert.equal(names.size, ALL_TOOL_SPECS.length, "no duplicate tool names");
  const shape = zodShape(specByName("scroll")!);
  assert.deepEqual(Object.keys(shape).sort(), ["coordinate", "scroll_amount", "scroll_direction", "text"]);
  const cfg = responsesDelegationConfig({ model: "gpt-5.6-terra", effort: "low" });
  assert.equal(cfg.responses.tools?.length, ALL_TOOL_SPECS.length + 1);
});

/** A LiveSession stand-in with just the surface the delegator and the responses brain touch. */
class FakeLive extends EventEmitter {
  sent: { type: string; payload: unknown }[] = [];
  nowMs = 5000;
  appendThinking(id: string | null, content: string): string { this.sent.push({ type: "thinking", payload: { id, content } }); return "t"; }
  appendCommentary(id: string | null, content: string): string { this.sent.push({ type: "commentary", payload: { id, content } }); return "c"; }
  appendInstructions(id: string | null, content: string): string { this.sent.push({ type: "instructions", payload: { id, content } }); return "i"; }
  createResponseItem(item: unknown): void { this.sent.push({ type: "item", payload: item }); }
  createResponse(): void { this.sent.push({ type: "response.create", payload: undefined }); }
}

test("delegator builds the task from Kevin's words, relays progress, and records timings", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  transcript.push({ speaker: "kevin", delta: "hey jarhead", startMs: 0, endMs: 600 });
  transcript.push({ speaker: "kevin", delta: " open slack", startMs: 700, endMs: 1400 });
  const seen: BrainTask[] = [];
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (task, sink) => {
      seen.push(task);
      sink.thinking("Opening Slack.");
      sink.step({ kind: "tool", tool: { name: "open_app", input: { name: "Slack" }, ok: true, ms: 12 } });
      return { status: "done", summary: "Slack is open." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations: new ConfirmationState() });
  const phases: string[] = [];
  d.on("phase", (p) => phases.push(p));
  live.emit("delegation", "item_1", "client", 1400);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(seen[0]?.request, "hey jarhead open slack");
  assert.equal(seen[0]?.confirmation, false);
  const dlg = d.all()[0]!;
  assert.equal(dlg.status, "done");
  assert.equal(dlg.summary, "Slack is open.");
  assert.deepEqual(dlg.steps.map((s) => s.kind), ["thinking", "tool", "commentary"]);
  assert.ok(dlg.timings.firstThinkingAt && dlg.timings.firstCommentaryAt && dlg.timings.doneAt);
  assert.deepEqual(live.sent.map((s) => s.type), ["thinking", "commentary"]);
  assert.deepEqual(phases, ["thinking", "acting", "idle"]);
});

test("a yes after a pending confirmation arms it; a stop cancels a running task", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const confirmations = new ConfirmationState();
  confirmations.ask("click Send", "left_click", { coordinate: [1, 1] });
  let cancelled = false;
  let resolveHandle: ((r: BrainResult) => void) | undefined;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: (task: BrainTask, _sink: BrainSink) =>
      new Promise<BrainResult>((resolve) => {
        resolveHandle = resolve;
        if (task.confirmation) resolve({ status: "done", summary: "sent." });
      }),
    cancel: async () => {
      cancelled = true;
      resolveHandle?.({ status: "cancelled" });
    },
    stop: async () => undefined,
  };
  const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain, confirmations });

  transcript.push({ speaker: "kevin", delta: "yes go ahead", startMs: 100, endMs: 800 });
  live.emit("delegation", "item_2", "client", 800);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.all()[0]?.status, "done");
  assert.equal(confirmations.consume("left_click", { coordinate: [2, 2] }), true, "the yes armed the pending click");

  transcript.push({ speaker: "kevin", delta: " now delete everything", startMs: 5000, endMs: 6000 });
  live.emit("delegation", "item_3", "client", 6000);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.active?.status, "running");
  transcript.push({ speaker: "kevin", delta: " stop", startMs: 6500, endMs: 6800 });
  live.emit("inputTranscript", " stop", 6500, 6800);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cancelled, true);
  assert.equal(d.all()[1]?.status, "cancelled");
  assert.ok(live.sent.some((s) => s.type === "instructions"));
});

test("responses brain runs function calls and continues the backend", async () => {
  const { runner } = makeRunner();
  const live = new FakeLive();
  const brain = new ResponsesBrain({ runner, model: "gpt-5.6-terra" });
  brain.bind(live as unknown as LiveSession);
  const abort = new AbortController();
  const done = brain.handle({ delegationId: "item_9", request: "screenshot", dialogue: "", confirmation: false, offsetMs: 0, signal: abort.signal }, {
    thinking: () => undefined, commentary: () => undefined, step: () => undefined, screenshot: () => undefined,
  });
  live.emit("responseEvent", "item_9", { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: "screenshot", arguments: "{}" } });
  live.emit("responseEvent", "item_9", { type: "response.completed" });
  await new Promise((r) => setTimeout(r, 30));
  const types = live.sent.map((s) => s.type);
  assert.deepEqual(types, ["item", "item", "response.create"]);
  const output = live.sent[0]?.payload as { type: string; call_id: string; output: string };
  assert.equal(output.call_id, "call_1");
  assert.match(output.output, /screenshot attached/);
  live.emit("responseEvent", "item_9", { type: "response.completed" });
  const result = await done;
  assert.equal(result.status, "done");
});

test("claude brain reports not-ready cleanly when the sdk cannot start", async () => {
  const { runner } = makeRunner();
  const brain = new ClaudeBrain({ runner, sdk: { query: () => { throw new Error("no sdk"); } }, mcpFactory: async () => ({}), authProbe: async () => "none" });
  const r = await brain.start();
  assert.equal(r.ready, false);
  assert.match(r.detail, /no sdk/);
});
