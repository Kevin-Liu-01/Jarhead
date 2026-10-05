/**
 * W1-7, the Claude Code brain at launch: its own cwd and no inherited settings (F-CLAUDE-HOME), results tied to
 * the turn that asked (F-CLAUDE-STALE), a login checked without a model call and never called 'api key' when the
 * key is dropped (F-CLAUDE-KEY, F-AUTO-PROBE), and a wall clock, a step cap and spares that send nothing
 * (F-CLAUDE-BUDGET).
 *
 * Adopted from the launch audit's brains-findings repros. No real Claude Code runs: the Agent SDK is a stand-in,
 * and `claude auth status` is a shell script that prints what the real CLI prints. resolveSettings is the SDK's own
 * resolver; it reads files and spawns nothing.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SdkLike, SdkMessage, SdkQuery, SdkUserMessage } from "@jarhead/agents";
import * as claude from "../claude.ts";
import { ClaudeBrain } from "../claude.ts";
import type { ToolRunner } from "../runner.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The stand-in CLIs' folders, removed when the file is done. */
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

type ToolCall = (name: string, args: unknown) => Promise<{ content?: Array<{ text?: string }>; isError?: boolean }>;

/** Counts the runner's dispatches, so a refused call is seen to have reached nothing. */
function countRuns(runner: ToolRunner): { calls: string[] } {
  const seen = { calls: [] as string[] };
  const real = runner.run.bind(runner);
  (runner as unknown as { run: ToolRunner["run"] }).run = (async (name: string, args: unknown, ...rest: unknown[]) => {
    seen.calls.push(name);
    return (real as (...a: unknown[]) => ReturnType<ToolRunner["run"]>)(name, args, ...rest);
  }) as ToolRunner["run"];
  return seen;
}

/**
 * A stand-in for the CLI in streaming-input mode. `turn(n, ctx)` scripts each user message. As the real CLI does,
 * an interrupted turn still ends with its own `error_during_execution` result, a little later, and the next queued
 * message then runs as the next turn.
 */
class ScriptedSdk implements SdkLike {
  seen: SdkUserMessage[] = [];
  options: Record<string, unknown> | undefined;
  interrupts = 0;
  callTool: ToolCall | undefined;
  private release: (() => void) | undefined;
  interrupted = false;
  constructor(readonly turn: (n: number, ctx: ScriptedSdk) => AsyncGenerator<SdkMessage>) {}
  /** Resolves when the running turn is interrupted. */
  waitInterrupt(): Promise<void> {
    if (this.interrupted) return Promise.resolve();
    return new Promise<void>((r) => (this.release = r));
  }
  query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery {
    this.options = options;
    const self = this;
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      yield { type: "system", subtype: "init", session_id: "s1", model: "fake" };
      let n = 0;
      for await (const msg of prompt) {
        self.seen.push(msg);
        self.interrupted = false;
        yield* self.turn(++n, self);
      }
    })();
    return {
      [Symbol.asyncIterator]: () => messages,
      interrupt: async () => {
        self.interrupts++;
        self.interrupted = true;
        self.release?.();
        self.release = undefined;
      },
    };
  }
}

const answer = (text: string): SdkMessage[] => [
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null },
  { type: "result", subtype: "success", result: text, is_error: false },
];
const interruptedResult: SdkMessage = { type: "result", subtype: "error_during_execution", is_error: true, result: "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null" };

/** Every turn fails the way a signed-out CLI does. */
class LoggedOutSdk implements SdkLike {
  seen: SdkUserMessage[] = [];
  options: Record<string, unknown> | undefined;
  query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery {
    this.options = options;
    const seen = this.seen;
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      yield { type: "system", subtype: "init", session_id: "s1", model: "fake" };
      for await (const msg of prompt) {
        seen.push(msg);
        yield { type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" };
      }
    })();
    return { [Symbol.asyncIterator]: () => messages, interrupt: async () => undefined };
  }
}

/**
 * A stand-in `claude` binary. `auth status` prints what the real CLI prints (pretty JSON, exit 1 when signed out)
 * from `status.json` beside it, or, with `status.json` absent, answers like the CLI does with no OAuth login: signed
 * in only when ANTHROPIC_API_KEY is in its environment. `hang` makes it never answer. Every call is logged with
 * whether the key reached it.
 */
function fakeClaude(status?: { loggedIn: boolean; authMethod: string; apiProvider?: string } | "hang"): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "jh-fake-claude-"));
  made.push(dir);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  if (status && status !== "hang") writeFileSync(join(dir, "status.json"), JSON.stringify({ ...status, apiProvider: status.apiProvider ?? "firstParty" }, null, 2));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
here=$(dirname "$0")
echo "$* key=\${ANTHROPIC_API_KEY:+set} cwd=$(pwd)" >> "$here/calls.log"
[ "$1 $2" = "auth status" ] || exit 2
${status === "hang" ? "exec sleep 30" : ""}
if [ -f "$here/status.json" ]; then
  cat "$here/status.json"
  grep -q '"loggedIn": true' "$here/status.json" && exit 0 || exit 1
fi
if [ -n "$ANTHROPIC_API_KEY" ]; then
  printf '{\\n  "loggedIn": true,\\n  "authMethod": "api_key",\\n  "apiProvider": "firstParty",\\n  "apiKeySource": "ANTHROPIC_API_KEY"\\n}\\n'
  exit 0
fi
printf '{\\n  "loggedIn": false,\\n  "authMethod": "none",\\n  "apiProvider": "firstParty"\\n}\\n'
exit 1
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return body().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ------------------------------------------------------------------ F-CLAUDE-HOME

test("F-CLAUDE-HOME: the session runs in an empty folder Jarhead owns with no filesystem settings, and only the jarhead tools exist; the SDK's own resolver loads neither the stale key nor the allow rules in ~/.claude/settings.json", async () => {
  const home = mkdtempSync(join(tmpdir(), "jh-claude-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "jh-claude-state-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-canary-stale" }, permissions: { allow: ["Read", "Bash(curl:*)"] } }));
  const { runner } = makeRunner();
  const sdk = new LoggedOutSdk();
  const brain = new ClaudeBrain({ runner, stateDir, sdk, mcpFactory: async () => ({}), authProbe: async () => "valid" });
  try {
    await withEnv({ HOME: home, CLAUDE_CONFIG_DIR: undefined }, async () => {
      await brain.start();
      const o = sdk.options ?? {};
      console.log(`[measure] session cwd=${o["cwd"] === home ? "HOME" : String(o["cwd"])} settingSources=${JSON.stringify(o["settingSources"])} tools=${JSON.stringify(o["tools"])}`);
      assert.notEqual(o["cwd"], home, "the session's cwd is HOME, so 'project' settings are ~/.claude/settings.json");
      assert.equal(o["cwd"], join(stateDir, "claude-cwd"));
      assert.ok(existsSync(String(o["cwd"])), "the cwd exists");
      assert.deepEqual(readdirSync(String(o["cwd"])), [], "and is empty");
      assert.deepEqual(o["settingSources"], [], "no user, project or local settings");
      assert.deepEqual(o["tools"], [], "no built-in tools at all");
      assert.equal(o["strictMcpConfig"], true, "only the MCP servers Jarhead passes");
      for (const t of ["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Task", "Agent", "Skill", "ToolSearch"]) {
        assert.ok((o["disallowedTools"] as string[] | undefined)?.includes(t), `${t} is disallowed`);
      }
      assert.ok(Object.keys((o["mcpServers"] ?? {}) as Record<string, unknown>).join() === "jarhead", "the jarhead server is the one server");
      const { resolveSettings } = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as {
        resolveSettings: (o: { cwd: string; settingSources: string[] }) => Promise<{ effective: { env?: Record<string, string>; permissions?: { allow?: string[] } } }>;
      };
      const resolved = await resolveSettings({ cwd: String(o["cwd"]), settingSources: o["settingSources"] as string[] });
      const loaded = resolved.effective.env?.["ANTHROPIC_API_KEY"] === "sk-ant-canary-stale";
      const allow = resolved.effective.permissions?.allow ?? [];
      console.log(`[measure] the CLI's resolver for these options: stale key loaded=${loaded}, allow rules=${JSON.stringify(allow)}`);
      assert.equal(loaded, false, "the stale key in ~/.claude/settings.json reaches the headless session");
      assert.deepEqual(allow, [], "the allow rules in ~/.claude/settings.json pre-empt canUseTool");
    });
  } finally {
    await brain.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ F-CLAUDE-STALE

/** Turn 1 runs until interrupted and then ends with its interrupted result; later turns act once through a jarhead tool and answer. */
function supersedeScript(record: { turn2Tool?: { attached: boolean; kind: string } }, attached: () => boolean) {
  return async function* (n: number, sdk: ScriptedSdk): AsyncGenerator<SdkMessage> {
    if (n === 1) {
      await sdk.waitInterrupt();
      await sleep(30); // the CLI aborts the stream and writes the interrupted turn's result
      yield interruptedResult;
      return;
    }
    const r = await sdk.callTool!("frontmost_app", {});
    record.turn2Tool = { attached: attached(), kind: r.isError ? "error" : "ran" };
    yield* answer("Chrome is open.");
  };
}

test("F-CLAUDE-STALE: after a supersede the next request gets its own answer, never the interrupted turn's result, and its tool calls run attached", async () => {
  const { runner } = makeRunner();
  const record: { turn2Tool?: { attached: boolean; kind: string } } = {};
  const sdk = new ScriptedSdk(supersedeScript(record, () => runner.attached));
  const brain = new ClaudeBrain({
    runner,
    sdk,
    authProbe: async () => "valid",
    mcpFactory: async (_specs, call) => {
      sdk.callTool = call as ToolCall;
      return {};
    },
  });
  try {
    assert.equal((await brain.start()).ready, true);
    const first = new AbortController();
    const r1 = brain.handle(makeTask("open safari", first.signal), makeSink().sink);
    await sleep(20);
    // "no, open chrome": the Delegator aborts the running turn, awaits brain.cancel(), then hands over the new task.
    first.abort();
    assert.equal((await r1).status, "cancelled");
    await brain.cancel();
    const r2 = await brain.handle(makeTask("no, open chrome"), makeSink().sink);
    console.log(`[measure] second request: ${JSON.stringify(r2)}; turn 2's tool call: ${JSON.stringify(record.turn2Tool)}`);
    assert.equal(r2.status, "done", `the new request was answered with the old turn's result: ${JSON.stringify(r2)}`);
    assert.equal(r2.summary, "Chrome is open.");
    assert.deepEqual(record.turn2Tool, { attached: true, kind: "ran" }, "turn 2 acted with its delegation attached");
    assert.equal(runner.attached, false, "nothing stays attached once the answer is in");
  } finally {
    await brain.stop();
  }
});

test("F-CLAUDE-STALE: a tool call the interrupted turn still sends after the stop is refused before it reaches the runner", async () => {
  const { runner } = makeRunner();
  const runs = countRuns(runner);
  const late: { r?: Awaited<ReturnType<ToolCall>> } = {};
  const sdk = new ScriptedSdk(async function* (n, ctx) {
    if (n === 1) {
      await ctx.waitInterrupt();
      late.r = await ctx.callTool!("key", { text: "Return" }); // the Send Claude had already decided on
      yield interruptedResult;
      return;
    }
    yield* answer("ok");
  });
  const brain = new ClaudeBrain({
    runner,
    sdk,
    authProbe: async () => "valid",
    mcpFactory: async (_specs, call) => {
      sdk.callTool = call as ToolCall;
      return {};
    },
  });
  try {
    assert.equal((await brain.start()).ready, true);
    const stop = new AbortController();
    const r1 = brain.handle(makeTask("send it", stop.signal), makeSink().sink);
    await sleep(20);
    stop.abort();
    await brain.cancel();
    assert.equal((await r1).status, "cancelled");
    for (let i = 0; i < 50 && !late.r; i++) await sleep(10);
    console.log(`[measure] the late call: ${JSON.stringify(late.r)}; runner dispatches: ${JSON.stringify(runs.calls)}`);
    assert.equal(late.r?.isError, true, "the key press ran after the stop");
    assert.match(late.r?.content?.[0]?.text ?? "", /no task is running/);
    assert.deepEqual(runs.calls, [], "nothing reached the runner");
  } finally {
    await brain.stop();
  }
});

// ------------------------------------------------------------------ F-CLAUDE-KEY / F-AUTO-PROBE

test("F-CLAUDE-KEY: a valid ANTHROPIC_API_KEY the session never receives does not make the brain ready; the login it will use is checked with no model call and never called 'api key'", async () => {
  const fake = fakeClaude(); // the CLI's own answer: signed in only through a key in its environment
  const { runner } = makeRunner();
  const sdk = new LoggedOutSdk();
  // ~/.jarhead/env's key, as loadEnv() puts it in process.env; the brain drops it (dropApiKey defaults to true).
  const brain = new ClaudeBrain({ runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin });
  try {
    await withEnv({ ANTHROPIC_API_KEY: "sk-ant-canary-not-a-real-key" }, async () => {
      const started = await brain.start();
      const env = (sdk.options?.["env"] ?? {}) as Record<string, string | undefined>;
      console.log(`[measure] ready=${started.ready} detail="${started.detail}" modelTurns=${sdk.seen.length} sessionEnvHasKey=${env["ANTHROPIC_API_KEY"] !== undefined} authStatusCalls=${JSON.stringify(fake.calls())}`);
      assert.ok(!started.ready || env["ANTHROPIC_API_KEY"] !== undefined || sdk.seen.length > 1, "ready was declared on a key the session never receives, with no check of the login it will really use");
      assert.equal(started.ready, false);
      assert.match(started.detail, /not signed in.*claude auth login/i);
      assert.doesNotMatch(started.detail, /api key/i, "a dropped key is never the login");
      assert.equal(sdk.seen.length, 0, "no model call proves the login");
      assert.equal(fake.calls().length, 1, "`claude auth status` was asked once");
      assert.match(fake.calls()[0]!, /^auth status --json key= cwd=/, "with the session's environment: the key dropped");
      const first = await brain.handle(makeTask("open safari"), makeSink().sink);
      if (started.ready) assert.notEqual(first.status, "failed", "the first real request fails on the login the check never saw");
    });
  } finally {
    await brain.stop();
  }
});

test("F-CLAUDE-KEY: the ready line names the login the session uses; a key that only Claude Code's own settings hold is not one", async () => {
  const cases: Array<[status: { loggedIn: boolean; authMethod: string; apiProvider?: string }, ready: boolean, detail: RegExp]> = [
    [{ loggedIn: true, authMethod: "claude.ai" }, true, /Claude login/],
    [{ loggedIn: true, authMethod: "oauth_token" }, true, /OAuth token/],
    [{ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }, true, /bedrock/],
    [{ loggedIn: true, authMethod: "api_key" }, false, /settings.*claude auth login/i],
    [{ loggedIn: true, authMethod: "api_key_helper" }, false, /settings.*claude auth login/i],
    [{ loggedIn: false, authMethod: "none" }, false, /not signed in/i],
  ];
  for (const [status, ready, detail] of cases) {
    const fake = fakeClaude(status);
    const { runner } = makeRunner();
    const sdk = new LoggedOutSdk();
    const brain = new ClaudeBrain({ runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin });
    try {
      const started = await brain.start();
      assert.equal(started.ready, ready, `${JSON.stringify(status)}: ${started.detail}`);
      assert.match(started.detail, detail, JSON.stringify(status));
      if (ready) assert.doesNotMatch(started.detail, /api key/i);
      assert.equal(sdk.seen.length, 0, "no model call");
    } finally {
      await brain.stop();
    }
  }
});

test("F-AUTO-PROBE: a signed-out Claude Code answers at once with no model call, and a CLI that never reports its login is given up at the check's timeout (5 s by default)", async () => {
  assert.equal((claude as Record<string, unknown>)["LOGIN_TIMEOUT_MS"], 5000, "the default timeout of the login check");
  const out = fakeClaude({ loggedIn: false, authMethod: "none" });
  const sdk = new LoggedOutSdk();
  const brain = new ClaudeBrain({ runner: makeRunner().runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: out.bin });
  const t0 = Date.now();
  const r = await brain.start();
  const signedOutMs = Date.now() - t0;
  await brain.stop();
  console.log(`[measure] signed out: ready=${r.ready} in ${signedOutMs} ms, model turns ${sdk.seen.length}, detail "${r.detail}"`);
  assert.equal(r.ready, false);
  assert.equal(sdk.seen.length, 0, "a probe turn was sent to learn what auth status says for free");
  assert.ok(signedOutMs < 3000, `${signedOutMs} ms`);

  const hung = fakeClaude("hang");
  const sdk2 = new LoggedOutSdk();
  const slow = new ClaudeBrain({ runner: makeRunner().runner, sdk: sdk2, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: hung.bin, probeTimeoutMs: 300 });
  const t1 = Date.now();
  const r2 = await slow.start();
  const hungMs = Date.now() - t1;
  await slow.stop();
  console.log(`[measure] hung CLI: ready=${r2.ready} in ${hungMs} ms, detail "${r2.detail}"`);
  assert.equal(r2.ready, false);
  assert.match(r2.detail, /did not report its login/);
  assert.ok(hungMs < 3000, `${hungMs} ms`);
  assert.equal(sdk2.seen.length, 0);
});

// ------------------------------------------------------------------ F-CLAUDE-BUDGET

test("F-CLAUDE-BUDGET: the 41st tool call is refused before dispatch, the turn is interrupted and the task fails honestly; maxTurns rides to the CLI", async () => {
  const { runner } = makeRunner();
  const runs = countRuns(runner);
  let refused: Awaited<ReturnType<ToolCall>> | undefined;
  const sdk = new ScriptedSdk(async function* (n, ctx) {
    if (n !== 1) return yield* answer("ok");
    for (let i = 0; i < 60 && !ctx.interrupted; i++) {
      const r = await ctx.callTool!("frontmost_app", {});
      if (r.isError) refused = r;
    }
    if (ctx.interrupted) return yield interruptedResult;
    yield* answer("did sixty things");
  });
  const brain = new ClaudeBrain({
    runner,
    sdk,
    authProbe: async () => "valid",
    mcpFactory: async (_specs, call) => {
      sdk.callTool = call as ToolCall;
      return {};
    },
  });
  try {
    assert.equal((await brain.start()).ready, true);
    const result = await Promise.race([brain.handle(makeTask("do everything"), makeSink().sink), sleep(10_000).then(() => ({ status: "hung" as const }))]);
    console.log(`[measure] ${JSON.stringify(result)}; dispatched ${runs.calls.length}; interrupts ${sdk.interrupts}; maxTurns=${String(sdk.options?.["maxTurns"])}`);
    assert.deepEqual(result, { status: "failed", error: "I stopped after 40 tool calls without finishing" });
    assert.equal(runs.calls.length, 40, "call 41 reached the runner");
    assert.match(refused?.content?.[0]?.text ?? "", /40 tool calls/);
    assert.ok(sdk.interrupts >= 1, "the turn was interrupted");
    assert.equal(sdk.options?.["maxTurns"], 41, "the CLI's own backstop: one round trip per step and the answer");
    assert.equal(runner.attached, false);
  } finally {
    await brain.stop();
  }
});

test("F-CLAUDE-BUDGET: a turn that never ends is cut by the wall clock (300 s by default), and the next request is answered by its own turn", async () => {
  assert.equal((claude as Record<string, unknown>)["CLAUDE_MAX_WALL_MS"], 300_000, "the default wall clock");
  assert.equal((claude as Record<string, unknown>)["CLAUDE_MAX_STEPS"], 40, "the default step cap");
  const { runner } = makeRunner();
  const sdk = new ScriptedSdk(async function* (n, ctx) {
    if (n === 1) {
      await ctx.waitInterrupt(); // a CLI stuck in retries: only the interrupt ends it
      return yield interruptedResult;
    }
    yield* answer("second answer");
  });
  const brain = new ClaudeBrain({ runner, sdk, authProbe: async () => "valid", mcpFactory: async () => ({}), maxWallMs: 300 });
  try {
    assert.equal((await brain.start()).ready, true);
    const t0 = Date.now();
    const result = await Promise.race([brain.handle(makeTask("wait forever"), makeSink().sink), sleep(3000).then(() => ({ status: "hung" as const }))]);
    console.log(`[measure] ${JSON.stringify(result)} after ${Date.now() - t0} ms; interrupts ${sdk.interrupts}`);
    assert.equal(result.status, "failed");
    assert.match((result as { error?: string }).error ?? "", /^I ran out of time after \d+ seconds$/);
    assert.ok(sdk.interrupts >= 1, "the stuck turn was interrupted");
    const next = await brain.handle(makeTask("and now?"), makeSink().sink);
    assert.deepEqual(next, { status: "done", summary: "second answer" });
  } finally {
    await brain.stop();
  }
});

test("F-CLAUDE-BUDGET: spares reuse the main brain's proven login: one `claude auth status` for main and two spares, and not one model request", async () => {
  const fake = fakeClaude({ loggedIn: true, authMethod: "claude.ai" });
  const sdks = [new LoggedOutSdk(), new LoggedOutSdk(), new LoggedOutSdk()];
  const brains = sdks.map((sdk) => new ClaudeBrain({ runner: makeRunner().runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin }));
  try {
    const started = [];
    for (const b of brains) started.push(await b.start());
    console.log(`[measure] ${JSON.stringify(started.map((s) => s.ready))}; auth status calls ${fake.calls().length}; model turns ${sdks.map((s) => s.seen.length).join(",")}`);
    assert.deepEqual(started.map((s) => s.ready), [true, true, true]);
    assert.equal(fake.calls().length, 1, "each spare asked again");
    assert.deepEqual(sdks.map((s) => s.seen.length), [0, 0, 0], "a probe turn at wake is a model request");
  } finally {
    for (const b of brains) await b.stop();
  }
});

test("a turn that fails on the login marks the brain not ready and the next start asks `claude auth status` again", async () => {
  const fake = fakeClaude({ loggedIn: true, authMethod: "claude.ai" });
  const sdk = new LoggedOutSdk(); // the token was revoked server side: auth status still says signed in
  const brain = new ClaudeBrain({ runner: makeRunner().runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin });
  try {
    assert.equal((await brain.start()).ready, true);
    const r = await brain.handle(makeTask("open safari"), makeSink().sink);
    assert.deepEqual(r, { status: "failed", error: "Invalid API key · Please run /login" });
    const after = await brain.warmUp();
    assert.equal(after.warm, false, "a brain whose login failed still reads warm");
    const again = await brain.handle(makeTask("open notes"), makeSink().sink);
    assert.equal(again.status, "failed");
    assert.equal(sdk.seen.length, 1, "a second request went to a CLI that cannot sign in");
    await brain.stop();
    const spare = new ClaudeBrain({ runner: makeRunner().runner, sdk: new LoggedOutSdk(), mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin });
    await spare.start();
    await spare.stop();
    assert.equal(fake.calls().length, 2, "the proven login was forgotten when it failed");
  } finally {
    await brain.stop();
  }
});
