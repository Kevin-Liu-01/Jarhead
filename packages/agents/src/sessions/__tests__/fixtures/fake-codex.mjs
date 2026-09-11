#!/usr/bin/env node
// A stand-in for the Codex CLI (codex-cli 0.153.4) for the sessions tests. Speaks the
// `codex exec --json` event shapes recorded on Kevin's machine (see codex-exec-events.jsonl
// and codex-exec-reconnect-events.jsonl), answers `--version` and `queue` the way the real
// one does, and — when CODEX_HOME is set — writes the rollout lines a real run would, so the
// CodexStore lists what it did. Behaviour knobs:
//
//   FAKE_CODEX_LOG        append one JSON line per invocation (pid, argv, cwd, CODEX_HOME, whether OPENAI_API_KEY was set)
//   FAKE_CODEX_MODE       reply (default) | recorded | hang | fail | crash
//   FAKE_CODEX_EVENTS     with mode=recorded: a JSONL file to replay verbatim (exit 1 when its last event is turn.failed, as the real CLI does)
//   FAKE_CODEX_PAUSE_AFTER  with mode=recorded: pause FAKE_CODEX_DELAY_MS after this many lines
//   FAKE_CODEX_REPLY      reply text; "{prompt}" is replaced with the prompt
//   FAKE_CODEX_DELAY_MS   pause after turn.started before the rest
//   FAKE_CODEX_THREAD_ID  thread id for a new thread
//   FAKE_CODEX_IGNORE_SIGINT  with mode=hang: survive SIGINT so only SIGKILL ends it
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const env = process.env;
if (env.FAKE_CODEX_LOG) {
  appendFileSync(env.FAKE_CODEX_LOG, `${JSON.stringify({ pid: process.pid, args, cwd: process.cwd(), codexHome: env.CODEX_HOME ?? null, hasOpenAIKey: Boolean(env.OPENAI_API_KEY) })}\n`);
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (args[0] === "--version") {
  console.log("codex-cli 0.153.4");
  process.exit(0);
}

if (args[0] === "queue") {
  // The real contract (0.153.4, checked with and without an app-server running): the message
  // is filed in $CODEX_HOME/queue_1.sqlite and the exit is 0 whenever the rollout exists,
  // daemon or no daemon; only a missing rollout fails. Nothing here says who, if anyone, will run it.
  const thread = args[args.indexOf("--thread") + 1];
  if (env.CODEX_HOME && !findRollout(join(env.CODEX_HOME, "sessions"), thread)) {
    console.error(`Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ${thread} (code -32603)`);
    process.exit(1);
  }
  console.log(`Queued message ${randomUUID()} for thread ${thread}.`);
  process.exit(0);
}

if (args[0] === "exec") {
  const resume = args[1] === "resume";
  const dd = args.indexOf("--");
  const positionals = dd === -1 ? [] : args.slice(dd + 1);
  const threadId = resume ? positionals[0] : env.FAKE_CODEX_THREAD_ID ?? "01a0ffff-0000-7000-8000-00000000c0de";
  const prompt = resume ? positionals[1] ?? "" : positionals[0] ?? "";
  const mode = env.FAKE_CODEX_MODE ?? "reply";
  // The real CLI prints this to stderr whenever stdin is not a TTY; it is not an error.
  process.stderr.write("Reading additional input from stdin...\n");

  if (mode === "recorded") {
    const lines = readFileSync(env.FAKE_CODEX_EVENTS, "utf8").split("\n").filter(Boolean);
    const pauseAfter = env.FAKE_CODEX_PAUSE_AFTER ? Number(env.FAKE_CODEX_PAUSE_AFTER) : -1;
    for (let i = 0; i < lines.length; i++) {
      if (i === pauseAfter && env.FAKE_CODEX_DELAY_MS) await sleep(Number(env.FAKE_CODEX_DELAY_MS));
      process.stdout.write(`${lines[i]}\n`);
    }
    process.exit(/"type":"turn\.failed"/.test(lines[lines.length - 1] ?? "") ? 1 : 0);
  }

  out({ type: "thread.started", thread_id: threadId });
  out({ type: "turn.started" });
  if (env.FAKE_CODEX_DELAY_MS) await sleep(Number(env.FAKE_CODEX_DELAY_MS));

  if (mode === "hang") {
    process.on("SIGINT", () => {
      if (env.FAKE_CODEX_IGNORE_SIGINT) return;
      process.exit(130);
    });
    setInterval(() => undefined, 1000);
  } else if (mode === "fail") {
    out({ type: "turn.failed", error: { message: "model says no" } });
    process.stderr.write("Error: turn failed: model says no\n");
    process.exit(1);
  } else if (mode === "crash") {
    process.stderr.write("Error: stream disconnected before completion\n");
    process.exit(1);
  } else {
    out({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "pnpm test", aggregated_output: "", exit_code: null, status: "in_progress" } });
    out({ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "pnpm test", aggregated_output: "ok\n", exit_code: 0, status: "completed" } });
    out({ type: "item.completed", item: { id: "item_1", type: "error", message: "Exceeded skills context budget. All skill descriptions were removed." } });
    const reply = (env.FAKE_CODEX_REPLY ?? "Done: **{prompt}**").replaceAll("{prompt}", prompt);
    out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: reply } });
    out({ type: "turn.completed", usage: { input_tokens: 20928, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } });
    persist(threadId, prompt, reply, resume);
    process.exit(0);
  }
} else {
  console.error(`fake codex: unexpected arguments: ${args.join(" ")}`);
  process.exit(2);
}

/** Append the turn to the thread's rollout under CODEX_HOME/sessions, creating the file for a new thread. */
function persist(threadId, prompt, reply, resume) {
  if (!env.CODEX_HOME) return;
  const now = new Date().toISOString();
  const cwd = process.cwd();
  let path = resume ? findRollout(join(env.CODEX_HOME, "sessions"), threadId) : undefined;
  const lines = [];
  if (!path) {
    const dir = join(env.CODEX_HOME, "sessions", "2026", "09", "10");
    mkdirSync(dir, { recursive: true });
    path = join(dir, `rollout-2026-09-10T12-00-00-${threadId}.jsonl`);
    lines.push({ timestamp: now, type: "session_meta", payload: { session_id: threadId, id: threadId, timestamp: now, cwd, originator: "codex_exec", cli_version: "0.153.4", source: "exec", thread_source: "user", model_provider: "openai" } });
  }
  lines.push({ timestamp: now, type: "response_item", payload: { type: "message", id: `m-${Date.now()}-u`, role: "user", content: [{ type: "input_text", text: prompt }] } });
  lines.push({ timestamp: now, type: "response_item", payload: { type: "message", id: `m-${Date.now()}-a`, role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: reply }] } });
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  if (existsSync(path)) appendFileSync(path, text);
  else writeFileSync(path, text);
}

function findRollout(dir, threadId) {
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const found = findRollout(p, threadId);
      if (found) return found;
    } else if (name.endsWith(`-${threadId}.jsonl`)) return p;
  }
  return undefined;
}
