/**
 * W1-7, the Claude Code brain at launch: its own cwd and no inherited settings (F-CLAUDE-HOME), results tied to
 * the turn that asked (F-CLAUDE-STALE), a login checked without a model call and never called 'api key' when the
 * key is dropped (F-CLAUDE-KEY, F-AUTO-PROBE), and a wall clock, a step cap and spares that send nothing
 * (F-CLAUDE-BUDGET).
 *
 * The review's probes are here too: a superseded turn that never reports back or folds the next message in (the
 * task goes to a fresh session), a CLI that exits during the login check or a task, and close()'s interrupt.
 *
 * Adopted from the launch audit's brains-findings repros. No real Claude Code runs: the Agent SDK is a stand-in,
 * and `claude auth status` is a node script that works the login out as the real CLI does, settings included.
 * resolveSettings is the SDK's own resolver; it reads files and spawns nothing.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSession, type SdkLike, type SdkMessage, type SdkQuery, type SdkUserMessage } from "@jarhead/agents";
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

/** The cloud providers `claude auth status` names, by the variable that picks each (as CLI 2.1.267's He() reads them). */
const PROVIDERS: ReadonlyArray<readonly [variable: string, provider: string]> = [
  ["CLAUDE_CODE_USE_BEDROCK", "bedrock"],
  ["CLAUDE_CODE_USE_FOUNDRY", "foundry"],
  ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "anthropicAws"],
  ["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "anthropicGoogleCloud"],
  ["CLAUDE_CODE_USE_MANTLE", "mantle"],
  ["CLAUDE_CODE_USE_VERTEX", "vertex"],
];
/** Every variable that could sign the stand-in in from the test runner's own environment; each login test clears them. */
const LOGIN_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", ...PROVIDERS.map(([v]) => v)];

/**
 * A stand-in `claude` binary (a node script). `auth status --json` works the login out the way CLI 2.1.267's does: a
 * cloud provider first, then a token in the environment, then an apiKeyHelper, then the stored login, then
 * ANTHROPIC_API_KEY; pretty JSON, exit 1 when signed out. Like the CLI it first applies ~/.claude/settings.json (its
 * env block and apiKeyHelper) unless `--setting-sources=` comes before the subcommand, the flag the SDK gives the
 * session. `login` is the stored login (the keychain's): "claude.ai", or "oauth_token" for an Anthropic profile.
 * "hang" never answers. Every call is logged with its arguments, whether the key reached it, and its folder.
 */
function fakeClaude(o: { readonly login?: "claude.ai" | "oauth_token" } | "hang" = {}): { bin: string; calls: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "jh-fake-claude-"));
  made.push(dir);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  if (o !== "hang" && o.login) writeFileSync(join(dir, "login.json"), JSON.stringify({ authMethod: o.login }));
  const bin = join(dir, "claude");
  // "hang" is a shell script: it logs the call at once, where node may not have booted before a short timeout.
  const hang = `#!/bin/sh\necho "$* key=\${ANTHROPIC_API_KEY:+set} cwd=$(pwd)" >> "$(dirname "$0")/calls.log"\nexec sleep 30\n`;
  writeFileSync(
    bin,
    o === "hang"
      ? hang
      : `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const here = __dirname;
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(here, "calls.log"), argv.join(" ") + " key=" + (process.env.ANTHROPIC_API_KEY ? "set" : "") + " cwd=" + process.cwd() + "\\n");
function main() {
  const at = argv.indexOf("auth");
  if (at < 0 || argv[at + 1] !== "status") return void (process.exitCode = 2);
  const env = { ...process.env };
  let helper;
  if (!argv.slice(0, at).includes("--setting-sources=")) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || "", ".claude"), "settings.json"), "utf8"));
      Object.assign(env, s.env || {});
      helper = s.apiKeyHelper;
    } catch {}
  }
  const provider = ${JSON.stringify(PROVIDERS)}.find(([v]) => env[v]);
  let stored;
  try { stored = JSON.parse(fs.readFileSync(path.join(here, "login.json"), "utf8")).authMethod; } catch {}
  let authMethod = "none";
  if (provider) authMethod = "third_party";
  else if (env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) authMethod = "oauth_token";
  else if (helper) authMethod = "api_key_helper";
  else if (stored) authMethod = stored;
  else if (env.ANTHROPIC_API_KEY) authMethod = "api_key";
  const loggedIn = authMethod !== "none";
  process.stdout.write(JSON.stringify({ loggedIn, authMethod, apiProvider: provider ? provider[1] : "firstParty" }, null, 2) + "\\n");
  process.exitCode = loggedIn ? 0 : 1;
}
main();
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

/** Runs `body` with HOME a fresh folder (holding `~/.claude/settings.json` when given), every login variable cleared, then `vars` set. */
function inHome<T>(settings: object | undefined, vars: Record<string, string>, body: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "jh-claude-home-"));
  made.push(home);
  if (settings) {
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  }
  const cleared: Record<string, string | undefined> = {};
  for (const k of LOGIN_VARS) cleared[k] = undefined;
  return withEnv({ ...cleared, HOME: home, ...vars }, () => body(home));
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
  const fake = fakeClaude(); // no stored login: the CLI is signed in only through a key in its environment
  const { runner } = makeRunner();
  const sdk = new LoggedOutSdk();
  // ~/.jarhead/env's key, as loadEnv() puts it in process.env; the brain drops it (dropApiKey defaults to true).
  const brain = new ClaudeBrain({ runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin });
  try {
    await inHome(undefined, { ANTHROPIC_API_KEY: "sk-ant-canary-not-a-real-key" }, async () => {
      const started = await brain.start();
      const env = (sdk.options?.["env"] ?? {}) as Record<string, string | undefined>;
      console.log(`[measure] ready=${started.ready} detail="${started.detail}" modelTurns=${sdk.seen.length} sessionEnvHasKey=${env["ANTHROPIC_API_KEY"] !== undefined} authStatusCalls=${JSON.stringify(fake.calls())}`);
      assert.ok(!started.ready || env["ANTHROPIC_API_KEY"] !== undefined || sdk.seen.length > 1, "ready was declared on a key the session never receives, with no check of the login it will really use");
      assert.equal(started.ready, false);
      assert.match(started.detail, /not signed in.*claude auth login/i);
      assert.doesNotMatch(started.detail, /api key/i, "a dropped key is never the login");
      assert.equal(sdk.seen.length, 0, "no model call proves the login");
      assert.equal(fake.calls().length, 2, "`claude auth status` was asked for the session's view, then once with settings to explain a signed-out answer");
      assert.match(fake.calls()[0]!, /^--setting-sources= auth status --json key= cwd=/, "the session's view: its environment with the key dropped, and no settings");
      for (const call of fake.calls()) assert.match(call, / key= cwd=/, "no call ever sees the dropped key");
      const first = await brain.handle(makeTask("open safari"), makeSink().sink);
      if (started.ready) assert.notEqual(first.status, "failed", "the first real request fails on the login the check never saw");
    });
  } finally {
    await brain.stop();
  }
});

test("F-CLAUDE-KEY: the login check sees what the session sees (no user, project or local settings), so neither a login only ~/.claude/settings.json gives nor one it shadows is misread; the ready line names the login", async () => {
  type Case = { readonly name: string; readonly login?: "claude.ai" | "oauth_token"; readonly settings?: object; readonly vars?: Record<string, string>; readonly ready: boolean; readonly detail: RegExp; readonly calls: number };
  const cases: Case[] = [
    { name: "a Claude login", login: "claude.ai", ready: true, detail: /, Claude login\)$/, calls: 1 },
    { name: "an Anthropic profile", login: "oauth_token", ready: true, detail: /, OAuth token\)$/, calls: 1 },
    { name: "a token in Jarhead's own environment", vars: { CLAUDE_CODE_OAUTH_TOKEN: "tok-canary" }, ready: true, detail: /, OAuth token\)$/, calls: 1 },
    { name: "Bedrock picked in Jarhead's own environment", vars: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" }, ready: true, detail: /, bedrock\)$/, calls: 1 },
    // A false not-ready before: for `claude` itself the apiKeyHelper (or provider) in settings wins over the Claude
    // login, but the session loads no settings, so it runs on that login.
    { name: "an apiKeyHelper in settings over a Claude login", login: "claude.ai", settings: { apiKeyHelper: "/bin/echo sk-ant-helper" }, ready: true, detail: /, Claude login\)$/, calls: 1 },
    { name: "Bedrock in settings over a Claude login", login: "claude.ai", settings: { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, ready: true, detail: /, Claude login\)$/, calls: 1 },
    // A false ready before: a provider, token, key or helper only settings hold never reaches the session. Said plainly.
    {
      name: "Bedrock only in settings",
      settings: { env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" } },
      ready: false,
      detail: /^Claude Code reaches bedrock only through its own settings, which Jarhead does not load\. Put CLAUDE_CODE_USE_BEDROCK and the rest of that setup in ~\/\.jarhead\/env, or run claude auth login\.$/,
      calls: 2,
    },
    { name: "Vertex only in settings", settings: { env: { CLAUDE_CODE_USE_VERTEX: "1" } }, ready: false, detail: /^Claude Code reaches vertex only through its own settings.*Put CLAUDE_CODE_USE_VERTEX /, calls: 2 },
    { name: "a token only in settings", settings: { env: { ANTHROPIC_AUTH_TOKEN: "tok-canary" } }, ready: false, detail: /^Claude Code has only a token from its own settings, which Jarhead does not load\. Put it in ~\/\.jarhead\/env, or run claude auth login\.$/, calls: 2 },
    { name: "an API key only in settings", settings: { env: { ANTHROPIC_API_KEY: "sk-ant-canary-stale" } }, ready: false, detail: /^Claude Code has only an API key from its own settings, which Jarhead does not load\. Run claude auth login\.$/, calls: 2 },
    { name: "an apiKeyHelper only in settings", settings: { apiKeyHelper: "/bin/echo sk-ant-helper" }, ready: false, detail: /^Claude Code has only an API key from its own settings/, calls: 2 },
    { name: "no login anywhere", ready: false, detail: /^Claude Code is not signed in\. Run claude auth login\.$/, calls: 2 },
  ];
  for (const c of cases) {
    const fake = fakeClaude(c.login ? { login: c.login } : {});
    const sdk = new LoggedOutSdk();
    const brain = new ClaudeBrain({ runner: makeRunner().runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin });
    try {
      await inHome(c.settings, c.vars ?? {}, async () => {
        const started = await brain.start();
        const calls = fake.calls();
        console.log(`[measure] ${c.name}: ready=${started.ready} "${started.detail}"; auth status ${JSON.stringify(calls.map((l) => l.split(" key=")[0]))}`);
        assert.equal(started.ready, c.ready, `${c.name}: ${started.detail}`);
        assert.match(started.detail, c.detail, c.name);
        if (c.ready) assert.doesNotMatch(started.detail, /api key/i, c.name);
        assert.equal(calls.length, c.calls, `${c.name}: auth status calls`);
        assert.match(calls[0]!, /^--setting-sources= auth status --json /, `${c.name}: the verdict is the session's own view, with no settings`);
        if (calls[1]) assert.match(calls[1], /^auth status --json /, `${c.name}: only the explanation reads Claude Code's own settings`);
        assert.equal(sdk.seen.length, 0, `${c.name}: no model call`);
      });
    } finally {
      await brain.stop();
    }
  }
});

test("F-AUTO-PROBE: a signed-out Claude Code answers at once with no model call, and a CLI that never reports its login is given up at the check's timeout (5 s by default)", async () => {
  assert.equal((claude as Record<string, unknown>)["LOGIN_TIMEOUT_MS"], 5000, "the default timeout of the login check");
  await inHome(undefined, {}, async () => {
    const out = fakeClaude();
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
    console.log(`[measure] hung CLI: ready=${r2.ready} in ${hungMs} ms, detail "${r2.detail}", auth status calls ${hung.calls().length}`);
    assert.equal(r2.ready, false);
    assert.match(r2.detail, /did not report its login/);
    assert.ok(hungMs < 3000, `${hungMs} ms`);
    // At most one: on a loaded Mac the stand-in may be killed at 300 ms before it has logged anything.
    assert.ok(hung.calls().length <= 1, `a CLI that never answered is not asked again (${hung.calls().length} calls)`);
    assert.equal(sdk2.seen.length, 0);
  });
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
  const fake = fakeClaude({ login: "claude.ai" });
  const sdks = [new LoggedOutSdk(), new LoggedOutSdk(), new LoggedOutSdk()];
  const brains = sdks.map((sdk) => new ClaudeBrain({ runner: makeRunner().runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin }));
  try {
    await inHome(undefined, {}, async () => {
      const started = [];
      for (const b of brains) started.push(await b.start());
      console.log(`[measure] ${JSON.stringify(started.map((s) => s.ready))}; auth status calls ${fake.calls().length}; model turns ${sdks.map((s) => s.seen.length).join(",")}`);
      assert.deepEqual(started.map((s) => s.ready), [true, true, true]);
      assert.equal(fake.calls().length, 1, "each spare asked again");
      assert.deepEqual(sdks.map((s) => s.seen.length), [0, 0, 0], "a probe turn at wake is a model request");
    });
  } finally {
    for (const b of brains) await b.stop();
  }
});

test("a turn that fails on the login marks the brain not ready and the next start asks `claude auth status` again", async () => {
  const fake = fakeClaude({ login: "claude.ai" });
  const sdk = new LoggedOutSdk(); // the token was revoked server side: auth status still says signed in
  const brain = new ClaudeBrain({ runner: makeRunner().runner, sdk, mcpFactory: async () => ({}), pathToClaudeCodeExecutable: fake.bin });
  try {
    await inHome(undefined, {}, async () => {
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
    });
  } finally {
    await brain.stop();
  }
});

// ------------------------------------------------------------------ the session's turn count, and a CLI that goes away

const init: SdkMessage = { type: "system", subtype: "init", session_id: "s1", model: "fake" };
/** The tool call of the session a query belongs to: each session's jarhead MCP server is its own (mcpFactory below). */
const toolCallOf = (options: Record<string, unknown> | undefined): ToolCall => ((options?.["mcpServers"] as { jarhead: { call: ToolCall } }).jarhead.call);
const ownServer = async (_specs: unknown, call: unknown): Promise<Record<string, unknown>> => ({ call });

/**
 * A CLI whose first session's first turn ignores the interrupt for `slowMs` (a long jarhead tool call, a wedged CLI).
 * Then, as CLI 2.1.267 does with a prompt queued behind a running turn ('Mid-turn, the user added: …'), it folds
 * whatever message is queued into that same turn, acts on it, and ends with ONE result for the two sends. Every other
 * turn, and every turn of a later session, acts once through a jarhead tool and answers "answer <session>.<turn>".
 */
class FoldingSdk implements SdkLike {
  queries = 0;
  interrupts = 0;
  readonly log: string[] = [];
  constructor(readonly slowMs: number) {}
  query({ prompt, options }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery {
    const q = ++this.queries;
    const self = this;
    const call = toolCallOf(options);
    const it = prompt[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<SdkUserMessage>> | undefined;
    const next = (): Promise<IteratorResult<SdkUserMessage>> => (pending ??= it.next());
    const take = (): void => void (pending = undefined);
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      yield init;
      for (let n = 1; ; n++) {
        const m = await next();
        take();
        if (m.done) return;
        if (q === 1 && n === 1) {
          await sleep(self.slowMs);
          const queued = await Promise.race([next(), sleep(10).then(() => undefined)]);
          if (queued && !queued.done) {
            take();
            self.log.push("session 1 folded a queued message into turn 1");
          }
          const r = await call("frontmost_app", {});
          self.log.push(`session 1 turn 1, late: ${r.isError ? "refused" : "ran"}`);
          yield* answer("Safari is open.");
          continue;
        }
        const r = await call("frontmost_app", {});
        self.log.push(`session ${q} turn ${n}: ${r.isError ? "refused" : "ran"}`);
        yield* answer(`answer ${q}.${n}`);
      }
    })();
    return { [Symbol.asyncIterator]: () => messages, interrupt: async () => void self.interrupts++ };
  }
}

test("F-CLAUDE-STALE: a superseded turn that outlives the wait sends the next task to a fresh session; nothing is queued behind it to fold, its late tool call is refused, and every later task is answered", async () => {
  assert.equal((claude as Record<string, unknown>)["STALE_RESULT_MS"], 5000, "the default wait for a superseded turn's result");
  const { runner } = makeRunner();
  const runs = countRuns(runner);
  const sdk = new FoldingSdk(600);
  const brain = new ClaudeBrain({ runner, sdk, authProbe: async () => "valid", staleResultMs: 150, mcpFactory: ownServer });
  try {
    assert.equal((await brain.start()).ready, true);
    const first = new AbortController();
    const r1 = brain.handle(makeTask("open safari", first.signal), makeSink().sink);
    await sleep(20);
    first.abort();
    await brain.cancel();
    assert.equal((await r1).status, "cancelled");
    const t0 = Date.now();
    const r2 = await brain.handle(makeTask("no, open chrome"), makeSink().sink);
    const r2ms = Date.now() - t0;
    const r3 = await brain.handle(makeTask("what is frontmost"), makeSink().sink);
    await sleep(700); // the old session's stuck turn ends: its late tool call, its result
    const r4 = await brain.handle(makeTask("and now?"), makeSink().sink);
    const warm = await brain.warmUp();
    console.log(`[measure] r2 ${JSON.stringify(r2)} after ${r2ms} ms; r3 ${JSON.stringify(r3)}; r4 ${JSON.stringify(r4)}; sessions ${sdk.queries}; log ${JSON.stringify(sdk.log)}; runner ${JSON.stringify(runs.calls)}; warm ${warm.warm}`);
    assert.deepEqual(r2, { status: "done", summary: "answer 2.1" }, "the task after the stuck one is answered, by a fresh session");
    assert.ok(r2ms >= 150 && r2ms < 2000, `${r2ms} ms`);
    assert.deepEqual(r3, { status: "done", summary: "answer 2.2" });
    assert.deepEqual(r4, { status: "done", summary: "answer 2.3" }, "the count is still right after the old turn's late result");
    assert.equal(sdk.queries, 2, "one fresh session");
    assert.ok(!sdk.log.some((l) => l.includes("folded")), "nothing was queued behind the stuck turn");
    assert.ok(sdk.log.includes("session 1 turn 1, late: refused"), "the old session's late tool call never ran");
    assert.deepEqual(runs.calls, ["frontmost_app", "frontmost_app", "frontmost_app"], "only the fresh session's three turns reached the runner");
    assert.equal(warm.warm, true);
  } finally {
    await brain.stop();
  }
});

/** A CLI whose first session's first turn, once interrupted, ends with no result at all (the interrupt was lost; the CLI went idle). Every other turn answers. */
class LostResultSdk implements SdkLike {
  queries = 0;
  query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery {
    const q = ++this.queries;
    let release: (() => void) | undefined;
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      yield init;
      let n = 0;
      for await (const _m of prompt) {
        n++;
        if (q === 1 && n === 1) {
          await new Promise<void>((r) => (release = r));
          continue; // no result for the interrupted turn
        }
        yield* answer(`answer ${q}.${n}`);
      }
    })();
    return { [Symbol.asyncIterator]: () => messages, interrupt: async () => void release?.() };
  }
}

test("F-CLAUDE-STALE: an interrupted turn that never gets a result costs the next task the wait, not the brain: it is answered by a fresh session, and so is the one after", async () => {
  const sdk = new LostResultSdk();
  const brain = new ClaudeBrain({ runner: makeRunner().runner, sdk, authProbe: async () => "valid", staleResultMs: 150, maxWallMs: 5000, mcpFactory: async () => ({}) });
  try {
    assert.equal((await brain.start()).ready, true);
    const a = new AbortController();
    const r1 = brain.handle(makeTask("one", a.signal), makeSink().sink);
    await sleep(20);
    a.abort();
    await brain.cancel();
    assert.equal((await r1).status, "cancelled");
    const t0 = Date.now();
    const r2 = await brain.handle(makeTask("two"), makeSink().sink);
    const r2ms = Date.now() - t0;
    const r3 = await brain.handle(makeTask("three"), makeSink().sink);
    console.log(`[measure] r2 ${JSON.stringify(r2)} after ${r2ms} ms; r3 ${JSON.stringify(r3)}; sessions ${sdk.queries}`);
    assert.deepEqual(r2, { status: "done", summary: "answer 2.1" });
    assert.ok(r2ms < 2000, `${r2ms} ms`);
    assert.deepEqual(r3, { status: "done", summary: "answer 2.2" });
    assert.equal(sdk.queries, 2);
  } finally {
    await brain.stop();
  }
});

/** A CLI that exits at boot, as an older claudeBin does on a flag it does not know: the SDK's stream throws. */
class DyingSdk implements SdkLike {
  queries = 0;
  query(): SdkQuery {
    this.queries++;
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      await sleep(5);
      throw new Error("Claude Code process exited with code 1: error: unknown option '--strict-mcp-config'");
    })();
    return { [Symbol.asyncIterator]: () => messages, interrupt: async () => undefined };
  }
}

test("a CLI that exits while its login is checked: start() says why, keeps no dead session, and the next start() tries again", async () => {
  const sdk = new DyingSdk();
  const brain = new ClaudeBrain({ runner: makeRunner().runner, sdk, mcpFactory: async () => ({}), authProbe: async () => (await sleep(50), "valid" as const) });
  try {
    const r = await brain.start();
    const again = await brain.start();
    console.log(`[measure] start ${JSON.stringify(r)}; again ${JSON.stringify(again)}; sessions ${sdk.queries}`);
    assert.deepEqual(r, { ready: false, detail: "Claude Code exited: Claude Code process exited with code 1: error: unknown option '--strict-mcp-config'" });
    assert.deepEqual(again, r, "the second start reports the same cause");
    assert.equal(sdk.queries, 2, "the second start opened a session again instead of answering from the dead one");
    assert.equal((await brain.warmUp()).warm, false);
  } finally {
    await brain.stop();
  }
});

/** A CLI that dies in the middle of a task (killed, out of memory): the SDK's stream throws after the message arrives. */
class CrashSdk implements SdkLike {
  query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery {
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      yield init;
      for await (const _m of prompt) {
        await sleep(20);
        throw new Error("Claude Code process terminated by signal SIGKILL");
      }
    })();
    return { [Symbol.asyncIterator]: () => messages, interrupt: async () => undefined };
  }
}

test("a CLI that dies during a task fails that task at once with the reason, and the brain stops reading warm", async () => {
  const brain = new ClaudeBrain({ runner: makeRunner().runner, sdk: new CrashSdk(), authProbe: async () => "valid", mcpFactory: async () => ({}) });
  try {
    assert.equal((await brain.start()).ready, true);
    const t0 = Date.now();
    const r = await Promise.race([brain.handle(makeTask("open safari"), makeSink().sink), sleep(3000).then(() => ({ status: "hung" as const }))]);
    const ms = Date.now() - t0;
    const warm = await brain.warmUp();
    const next = await brain.handle(makeTask("open notes"), makeSink().sink);
    console.log(`[measure] ${JSON.stringify(r)} after ${ms} ms; warm ${JSON.stringify(warm)}; next ${JSON.stringify(next)}`);
    assert.deepEqual(r, { status: "failed", error: "Claude Code exited: Claude Code process terminated by signal SIGKILL" });
    assert.ok(ms < 1000, `${ms} ms`);
    assert.equal(warm.warm, false);
    assert.deepEqual(next, { status: "failed", error: "Claude Code exited: Claude Code process terminated by signal SIGKILL" });
  } finally {
    await brain.stop();
  }
});

/** Answers every message; counts interrupts. */
class CountingSdk implements SdkLike {
  interrupts = 0;
  query({ prompt }: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): SdkQuery {
    const messages = (async function* (): AsyncGenerator<SdkMessage> {
      yield init;
      for await (const _m of prompt) yield* answer("ok");
    })();
    return { [Symbol.asyncIterator]: () => messages, interrupt: async () => void this.interrupts++ };
  }
}

test("ClaudeSession.close(): a session never sent anything skips the interrupt; one that was sent something gets it even when its count reads idle (a Console agent's background turn, a folded follow-up)", async () => {
  const fresh = new CountingSdk();
  const never = new ClaudeSession({ sdk: fresh, cwd: tmpdir() });
  never.start();
  await never.close();
  const used = new CountingSdk();
  const session = new ClaudeSession({ sdk: used, cwd: tmpdir() });
  session.start();
  session.send("hi");
  assert.equal(await session.settled(2000), true);
  assert.equal(session.turnsInFlight, 0, "idle by the count");
  await session.close();
  console.log(`[measure] interrupts: never sent ${fresh.interrupts}, sent and idle ${used.interrupts}`);
  assert.equal(fresh.interrupts, 0);
  assert.equal(used.interrupts, 1);
});
