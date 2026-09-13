import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transcript, type LiveSession } from "@jarhead/live";
import { ConfirmationState } from "@jarhead/hands";
import { MEMORY_PROMPT_LABEL, delegationPrompt, historyPrompt } from "../anthropic.ts";
import { OpenAICompatibleBrain } from "../compatible.ts";
import { Delegator, MEMORY_RECALL_MS } from "../delegator.ts";
import type { Brain, BrainTask } from "../brain.ts";
import { ALL_TOOL_SPECS, specByName } from "../tools.ts";
import { fakeServer, makeRunner, makeSink, makeTask } from "./fakes.ts";

/**
 * Durable memory reaches the brain as one labelled part of the user turn — after
 * the conversation, before the reflex notes — through the one promptParts every
 * brain kind renders with. It never enters kevinDialogue (what the gates read as
 * Kevin's words), and the delegator's lookup rides the marks/eyes race under the
 * MEMORY_RECALL_MS cut so the first action never waits on it. The rendered block
 * arrives already cut to BRAIN_MEMORY_TOKENS by @jarhead/memory; nothing here
 * re-renders it. No network, no session: fakes throughout.
 */

const MEMORY = "- Kevin prefers short answers.\n- Kevin goes by Kev.\n- How Kevin likes it done: read the diff before calling a PR fine.";

test("memory prompt: the labelled part sits after Recent conversation and before the reflex notes, history equals delegation, and a task without memory renders exactly as before", () => {
  const plain = makeTask("open the budget", undefined, { dialogue: "Kevin: open the budget", kevinDialogue: "open the budget" });
  const task: BrainTask = { ...plain, memory: MEMORY, notes: ['reflex "scroll": scrolled once'] };
  const parts = delegationPrompt(task).split("\n\n");
  const at = (prefix: string): number => parts.findIndex((p) => p.startsWith(prefix));
  const conv = at("Recent conversation:");
  const mem = at(MEMORY_PROMPT_LABEL);
  const notes = at("Already done or found by Jarhead");
  assert.ok(conv >= 0 && mem > conv && notes > mem, `order conversation < memory < notes, got ${[conv, mem, notes].join(",")}`);
  assert.equal(parts[mem], `${MEMORY_PROMPT_LABEL}\n${MEMORY}`, "the label, then the rendered items verbatim");
  assert.equal(MEMORY_PROMPT_LABEL, "What you know about Kevin (durable memory; use it, do not repeat it back, do not say you remembered):");
  assert.equal(historyPrompt(task), delegationPrompt(task), "the turn kept in history carries the same part");
  // The block is context about Kevin, never his words: the gates' inputs do not see it.
  assert.equal(task.kevinDialogue, "open the budget");
  assert.equal(task.request, "open the budget");
  // Absent: no label, and byte-identical to the prompt before the field existed.
  const bare = delegationPrompt(plain);
  assert.doesNotMatch(bare, /durable memory/);
  assert.equal(delegationPrompt({ ...plain, memory: "" }), bare, "an empty block renders nothing");
  assert.equal(historyPrompt(plain), bare);
});

test("memory prompt: every brain kind that builds its own user turn goes through delegationPrompt/historyPrompt (the one render site); openai-responses is the documented exception", () => {
  // A source pin rather than five fakes: the claim is "one render site reaches
  // every brain", and the cheapest true test of that is that each brain file
  // calls it. responses.ts is Live's own backend (Live runs the turn itself), so
  // the per-delegation block cannot reach it — AGENTS.md says so.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const file of ["anthropic.ts", "claude.ts", "codex.ts", "compatible.ts"]) {
    const src = readFileSync(join(here, "..", file), "utf8");
    assert.match(src, /\b(delegationPrompt|historyPrompt)\(/, `${file} renders its turn through promptParts`);
  }
  const responses = readFileSync(join(here, "..", "responses.ts"), "utf8");
  assert.doesNotMatch(responses, /\bdelegationPrompt\(/, "the Responses brain has no user turn of its own to carry the block");
});

test("compatible brain: the labelled part is in the user turn the server receives — after Recent conversation with no attachments, and on the text-only coordinates path with a circled region (codex.test.ts pins the warm turn the same way)", async () => {
  // A behavioural check that survives a rename of the helper: the bytes on the wire carry the label.
  const completion = { id: "chatcmpl_1", object: "chat.completion", model: "llama3.1", choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  const server = await fakeServer((req) => (req.path === "/v1/models" ? { status: 200, json: { object: "list", data: [{ id: "llama3.1", object: "model" }] } } : { status: 200, json: completion }));
  try {
    const { runner, dir } = makeRunner();
    // 127.0.0.1 is a loopback host: no images, so a circled region goes as coordinates through historyPrompt.
    const brain = new OpenAICompatibleBrain({ runner, baseUrl: server.url, model: "llama3.1" });
    await brain.start();
    const task: BrainTask = { ...makeTask("open the budget", undefined, { dialogue: "Kevin: open the budget", kevinDialogue: "open the budget" }), memory: MEMORY };
    assert.equal((await brain.handle(task, makeSink().sink)).status, "done");
    const lastUser = (n: number): string => {
      const body = server.seen.filter((r) => r.path.endsWith("/chat/completions"))[n]!.body as { messages: Array<{ role: string; content: unknown }> };
      return String(body.messages.filter((m) => m.role === "user").at(-1)!.content);
    };
    const plain = lastUser(0);
    assert.ok(plain.includes(`${MEMORY_PROMPT_LABEL}\n${MEMORY}`), "the label and the rendered items, verbatim, in the turn the server got");
    assert.ok(plain.indexOf("Recent conversation:") < plain.indexOf(MEMORY_PROMPT_LABEL), "after the conversation");

    const png = join(dir, "mark_1.png");
    writeFileSync(png, "PNG");
    const circled: BrainTask = { ...task, attachments: [{ path: png, mediaType: "image/png", note: "Kevin circled this region of his screen: 10,20 100×50 (global points)" }] };
    assert.equal((await brain.handle(circled, makeSink().sink)).status, "done");
    const textOnly = lastUser(1);
    assert.match(textOnly, /cannot receive images/, "the text-only path");
    assert.ok(textOnly.includes(`${MEMORY_PROMPT_LABEL}\n${MEMORY}`), "historyPrompt carries the part too");

    // Without the field, neither path says a word about memory.
    const { memory: _memory, ...bare } = task;
    assert.equal((await brain.handle(bare, makeSink().sink)).status, "done");
    assert.doesNotMatch(lastUser(2), /durable memory/);
  } finally {
    await server.close();
  }
});

/** A LiveSession stand-in with the surface the delegator touches. */
class FakeLive extends EventEmitter {
  nowMs = 5000;
  appendThinking(): string {
    return "t";
  }
  appendCommentary(): string {
    return "c";
  }
  appendInstructions(): string {
    return "i";
  }
}

function fakeBrain(seen: BrainTask[], handledAt: number[] = []): Brain {
  return {
    kind: "fake",
    start: async () => ({ ready: true, detail: "" }),
    handle: async (task) => {
      seen.push(task);
      handledAt.push(Date.now());
      return { status: "done", summary: "done." };
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
}

test("delegator: the memory lookup is asked with the request plus Kevin's recent lines (never Jarhead's), rides the race, and lands on task.memory while kevinDialogue stays his words only", async () => {
  const live = new FakeLive();
  const transcript = new Transcript(() => 0);
  const seen: BrainTask[] = [];
  const queries: string[] = [];
  const d = new Delegator({
    live: live as unknown as LiveSession,
    transcript,
    brain: fakeBrain(seen),
    confirmations: new ConfirmationState(),
    memory: async (query) => {
      queries.push(query);
      return MEMORY;
    },
  });
  transcript.push({ speaker: "kevin", delta: "what a nice day", startMs: 0, endMs: 400 });
  transcript.push({ speaker: "jarhead", delta: "It is.", startMs: 500, endMs: 700 });
  transcript.push({ speaker: "kevin", delta: " open the budget", startMs: 800, endMs: 1200 });
  live.emit("delegation", "item_1", "client", 1200);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seen.length, 1, "the brain got the task");
  assert.equal(seen[0]!.memory, MEMORY, "the rendered block, passed through untouched");
  assert.equal(queries.length, 1, "one lookup per delegation");
  assert.match(queries[0]!, /what a nice day/);
  assert.match(queries[0]!, /open the budget/);
  assert.doesNotMatch(queries[0]!, /It is\./, "Jarhead's own line is not part of the query");
  assert.equal(seen[0]!.kevinDialogue, "what a nice day\nopen the budget", "unchanged: Kevin's lines only, no memory inside");
  assert.doesNotMatch(seen[0]!.kevinDialogue ?? "", /Kev\b|short answers/);
  assert.equal(d.all()[0]!.status, "done");
  d.dispose();
});

test("delegator: a slow lookup is cut at MEMORY_RECALL_MS with its signal aborted, a failing one is swallowed, an empty one leaves the field absent — the task goes to the brain each time", async () => {
  assert.equal(MEMORY_RECALL_MS, 250);
  // Slow: never answers within the bound; its signal must fire so an embedding call in flight is dropped.
  {
    const live = new FakeLive();
    const transcript = new Transcript(() => 0);
    const seen: BrainTask[] = [];
    const handledAt: number[] = [];
    let aborted = false;
    const d = new Delegator({
      live: live as unknown as LiveSession,
      transcript,
      brain: fakeBrain(seen, handledAt),
      confirmations: new ConfirmationState(),
      memory: (_q, signal) =>
        new Promise<string | undefined>((resolve) => {
          const late = setTimeout(() => resolve("too late"), 5000);
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              clearTimeout(late);
              resolve(undefined);
            },
            { once: true },
          );
        }),
    });
    transcript.push({ speaker: "kevin", delta: "open the budget", startMs: 0, endMs: 900 });
    const t0 = Date.now();
    live.emit("delegation", "item_1", "client", 900);
    await new Promise((r) => setTimeout(r, MEMORY_RECALL_MS + 400));
    assert.equal(seen.length, 1, "the brain got the task without the block");
    assert.equal(seen[0]!.memory, undefined);
    assert.ok(!("memory" in seen[0]!), "no `memory` key at all when there is nothing");
    assert.equal(aborted, true, "the lookup's signal fired at the cut");
    const waited = handledAt[0]! - t0;
    assert.ok(waited >= MEMORY_RECALL_MS - 30 && waited < MEMORY_RECALL_MS + 350, `the task waited about the bound, not the lookup: ${waited} ms`);
    d.dispose();
  }
  // Failing: an error is a warning, not a failed delegation — whether the hook rejects or throws before it ever returns a promise.
  const rejects = async (): Promise<string | undefined> => {
    throw new Error("embeddings down");
  };
  const throwsSync = (): Promise<string | undefined> => {
    throw new Error("hook broke before it started");
  };
  for (const [how, memory] of [
    ["rejects", rejects],
    ["throws synchronously", throwsSync],
  ] as const) {
    const live = new FakeLive();
    const transcript = new Transcript(() => 0);
    const seen: BrainTask[] = [];
    const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: fakeBrain(seen), confirmations: new ConfirmationState(), memory });
    transcript.push({ speaker: "kevin", delta: "open the budget", startMs: 0, endMs: 900 });
    live.emit("delegation", "item_1", "client", 900);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(seen.length, 1, `${how}: the brain still got the task`);
    assert.equal(seen[0]!.memory, undefined, how);
    assert.equal(d.all()[0]!.status, "done", `${how}: the delegation is done, not failed`);
    d.dispose();
  }
  // Empty store, or no memory wired: the field is absent, the prompt unchanged.
  for (const memory of [async () => undefined, async () => "", undefined] as const) {
    const live = new FakeLive();
    const transcript = new Transcript(() => 0);
    const seen: BrainTask[] = [];
    const d = new Delegator({ live: live as unknown as LiveSession, transcript, brain: fakeBrain(seen), confirmations: new ConfirmationState(), memory });
    transcript.push({ speaker: "kevin", delta: "open the budget", startMs: 0, endMs: 900 });
    live.emit("delegation", "item_1", "client", 900);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(seen.length, 1);
    assert.ok(!("memory" in seen[0]!));
    assert.doesNotMatch(delegationPrompt(seen[0]!), /durable memory/);
    d.dispose();
  }
});

test("tools: `remember` says it is for this session and points facts about Kevin at the durable memory; the tool table is unchanged (67, no memory tool — the engine hook does that work)", () => {
  const remember = specByName("remember")!;
  assert.match(remember.description, /later in this session/);
  assert.match(remember.description, /Not for facts about Kevin/);
  assert.match(remember.description, /durable memory learns those from the conversation on its own/);
  assert.equal(ALL_TOOL_SPECS.length, 67);
  assert.equal(specByName("memory_add"), undefined);
  assert.equal(specByName("memory_forget"), undefined);
});

test("tools: the agent tools know `ended` — agents_list names it (no live process) apart from unknown (evidence missing); agent_wait settles on it and says a saved Codex thread still resumes", () => {
  assert.match(specByName("agents_list")!.description, /working\/idle\/blocked\/done\/ended — ended means no live process, however recent; unknown means the process evidence was missing/);
  assert.match(specByName("agent_wait")!.description, /idle, blocked, done or ended \(its process gone — agent_send still resumes a saved Codex thread\)/);
});
