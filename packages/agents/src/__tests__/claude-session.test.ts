import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeSession, claudeEnv, type SdkLike, type SdkMessage, type SdkUserMessage } from "../claude-code/session.ts";
import { ClaudeCodeConnector } from "../claude-code/connector.ts";
import { AgentRegistry } from "../registry.ts";
import { AsyncQueue } from "../claude-code/queue.ts";

/** A scripted Claude: answers every user message with a tool call, a tool result, text, and a result. */
function fakeSdk(script: (userText: string, n: number) => SdkMessage[]): SdkLike & { received: string[]; options: Record<string, unknown> | undefined } {
  const received: string[] = [];
  const holder = { received, options: undefined as Record<string, unknown> | undefined };
  return Object.assign(holder, {
    query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }) {
      holder.options = options;
      const out = new AsyncQueue<SdkMessage>();
      out.push({ type: "system", subtype: "init", session_id: "sess-1", model: "claude-opus-5" });
      let n = 0;
      (async () => {
        for await (const m of prompt) {
          const text = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
          received.push(text);
          for (const msg of script(text, ++n)) out.push(msg);
        }
        out.close();
      })();
      return Object.assign(out, { interrupt: async () => undefined });
    },
  }) as SdkLike & { received: string[]; options: Record<string, unknown> | undefined };
}

const turn = (answer: string): SdkMessage[] => [
  { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { file_path: "x" } }] } },
  { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
  { type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: answer }] } },
  { type: "result", subtype: "success", is_error: false, result: answer, total_cost_usd: 0.01 },
];

test("a session goes idle → working → idle and keeps the last answer", async () => {
  const sdk = fakeSdk((_t, n) => turn(`answer ${n}`));
  const s = new ClaudeSession({ sdk, cwd: "/tmp/proj", name: "proj", model: "claude-opus-5" });
  const statuses: string[] = [];
  const tools: string[] = [];
  s.on("status", (st) => statuses.push(st));
  s.on("tool", (t) => tools.push(t.name));
  s.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.sessionId, "sess-1");
  s.send("do the thing");
  await new Promise((r) => s.once("result", r));
  assert.equal(s.lastAssistantText, "answer 1");
  assert.deepEqual(tools, ["Read"]);
  assert.ok(statuses.includes("working") && statuses.at(-1) === "idle");
  assert.equal(sdk.options?.["model"], "claude-opus-5");
  await s.close();
});

test("connector lists, sends, reads, and settles; registry finds by name", async () => {
  const sdk = fakeSdk((_t, n) => turn(`reply ${n}`));
  const conn = new ClaudeCodeConnector({ sdk });
  const reg = new AgentRegistry([conn], 0);
  const info = await conn.start({ cwd: "/Users/kevinliu/gt/gt-cloud", name: "gt-cloud", prompt: "run the tests" });
  assert.equal(info.kind, "claude-code");
  assert.equal(info.id, "claude-code:s1");
  const settled = await conn.waitSettled(info.id, 2000);
  assert.equal(settled.status, "idle");
  assert.equal(await conn.read(info.id), "reply 1");
  const found = await reg.find("the gt cloud one");
  assert.equal(found?.id, info.id);
  const r = await reg.send(info.id, "and lint");
  assert.equal(r.accepted, true);
  assert.equal(sdk.received.length, 2);
  await conn.closeAll();
});

test("claudeEnv strips nested-session guards and optionally the api key", () => {
  const env = claudeEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", ANTHROPIC_API_KEY: "sk", PATH: "/bin" } as NodeJS.ProcessEnv, { dropApiKey: true });
  assert.equal(env["CLAUDECODE"], undefined);
  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(env["PATH"], "/bin");
});
