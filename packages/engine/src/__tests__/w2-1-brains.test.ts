/**
 * W2-1, the brains' engine half (launch triage): a brain that fails says so, a signed-out one hands over, a key alone
 * is not a Claude login, and no Go waits out a slow probe.
 *
 * - E-SIGNEDOUT: a login that expired mid-run is a typed problem with Retry and the brain not ready; under `auto` the
 *   walk passes it over and lands on the next backend, and Retry tries it again. A rate limit and an unreachable
 *   server are rows of their own; a task that finishes clears them.
 * - F-CLAUDE-KEY: ANTHROPIC_API_KEY alone does not make Claude Code configured (its session never receives the key).
 * - F-AUTO-PROBE: a start past the patience goes on in the background while the next ready brain takes the Go; once
 *   it proves itself it takes over.
 * - F-PROXY-RESTARTING: a task that reaches the proxy mid-restart is told so, not "unknown error".
 *
 * The selection runs over fake brains (`EngineOptions.brainOf`): nothing here starts a CLI or reaches a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain, BrainResult } from "@jarhead/brain";
import { Engine, brainNotConfigured, classifyBrainFailure, type BrainFacts, type SelectableBrain } from "../engine.ts";
import { delegate, nextUtterance, settle, testConfig, tempDir, until, world, type World } from "./world.ts";

const said = (w: World): string[] => w.lives.flatMap((l) => [...l.instructions, ...l.commentary]);
const brainRows = (engine: Engine) => engine.typedProblems().filter((p) => p.kind === "brain.unavailable");
const resolved = (engine: Engine): string | undefined => engine.snapshot().setup.brainResolved;

/** A fake brain of a real kind: `start` and `handle` scripted, every stop counted. */
interface Fake {
  readonly brain: Brain;
  stops: number;
  tasks: string[];
}
function fake(kind: SelectableBrain, o: { start?: () => Promise<{ ready: boolean; detail: string }>; handle?: (request: string) => Promise<BrainResult> } = {}): Fake {
  const f: Fake = {
    stops: 0,
    tasks: [],
    brain: {
      kind,
      start: o.start ?? (async () => ({ ready: true, detail: `${kind} (fake)` })),
      handle: async (task) => {
        f.tasks.push(task.request);
        // As every real brain does, a stop ends the task whatever the script was doing.
        const cancelled = new Promise<BrainResult>((resolve) => task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true }));
        return Promise.race([o.handle ? o.handle(task.request) : Promise.resolve<BrainResult>({ status: "done", summary: "done." }), cancelled]);
      },
      cancel: async () => undefined,
      stop: async () => {
        f.stops++;
      },
    },
  };
  return f;
}

/** A world whose selection is the real walk over these brains. */
function selecting(brains: Partial<Record<SelectableBrain, () => Brain>>, extra: { brainPatienceMs?: number } = {}): World {
  return world({ brainOf: brains, ...extra }, { select: true });
}

const EXPIRED = "unexpected status 401 Unauthorized: Your authentication token has expired. Please try signing in again.";

test("E-SIGNEDOUT (audit repro): a brain whose login expired mid-run is a typed problem with Retry, not ready; a task that finishes later clears it", async () => {
  let signedOut = true;
  const w = world({ brain: fake("codex", { handle: async () => (signedOut ? { status: "failed", error: EXPIRED } : { status: "done", summary: "done." }) }).brain });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    for (const [i, words] of ["jarhead summarize my last email from Ben", "jarhead find the invoice pdf in my downloads", "jarhead look up the weather in Tokyo on the web"].entries()) {
      delegate(w, words, `item_${i + 1}`);
      await settle(150);
      nextUtterance(w);
    }
    const rows = brainRows(engine);
    assert.equal(rows.length, 1, `one row for three failures: ${JSON.stringify(rows)}`);
    assert.match(rows[0]!.text, /^Codex brain is signed out \(unexpected status 401/);
    assert.match(rows[0]!.text, /Run codex login, then press Retry\.$/);
    assert.deepEqual(rows[0]!.remedy, { label: "Retry", command: { type: "problem.retry", kind: "brain.unavailable" } });
    assert.equal(engine.snapshot().brainReady, false);
    // What Kevin hears names the fix, not the raw 401.
    assert.ok(said(w).some((s) => s.includes("Codex is signed out. Run codex login, then press Retry.")), JSON.stringify(said(w)));
    // He signs in again: the next task finishes, the row goes and the brain is ready.
    signedOut = false;
    delegate(w, "jarhead what time is it in Tokyo", "item_9");
    assert.ok(await until(() => brainRows(engine).length === 0 && engine.snapshot().brainReady));
  } finally {
    await engine.stop();
  }
});

test("E-SIGNEDOUT under auto: the signed-out kind is passed over and the next backend takes the next request; Retry tries it again", async () => {
  const codex = fake("codex", { handle: async () => ({ status: "failed", error: EXPIRED }) });
  const claude = fake("claude-code");
  const codexBrains = [codex];
  const w = selecting({ codex: () => codexBrains.shift()?.brain ?? fake("codex").brain, "claude-code": () => claude.brain });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    assert.equal(resolved(engine), "codex");
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead summarize my last email from Ben", "item_1");
    assert.ok(await until(() => resolved(engine) === "claude-code"), `still on ${resolved(engine)}`);
    assert.equal(codex.stops, 1, "the signed-out brain stopped");
    const rows = brainRows(engine);
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.text, /^Codex brain unavailable \(signed out: unexpected status 401.*\); trying the next backend$/);
    assert.ok(said(w).some((s) => s.includes("Codex is signed out. Switching to the next brain. Ask again.")), JSON.stringify(said(w)));
    // The next request runs on Claude Code.
    nextUtterance(w);
    delegate(w, "jarhead find the invoice pdf in my downloads", "item_2");
    assert.ok(await until(() => claude.tasks.length === 1));
    // Kevin signed Codex in again and pressed Retry: the walk tries it first again.
    await engine.retryProblem("brain.unavailable");
    assert.equal(resolved(engine), "codex");
    assert.equal(brainRows(engine).length, 0);
  } finally {
    await engine.stop();
  }
});

test("E-SIGNEDOUT: a rate limit and an unreachable server are rows of their own; the brain stays ready and the next finished task clears them", async () => {
  let next: BrainResult = { status: "failed", error: "the Anthropic API is rate limiting us; try again in a moment" };
  const w = world({ brain: fake("anthropic-api", { handle: async () => next }).brain });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    delegate(w, "jarhead summarize my last email", "item_1");
    assert.ok(await until(() => brainRows(engine).length === 1));
    assert.match(brainRows(engine)[0]!.text, /^Anthropic API brain is rate limited \(the Anthropic API is rate limiting us.*\)\. Try again in a minute\.$/);
    assert.equal(engine.snapshot().brainReady, true, "a rate limit is not a lost login");
    next = { status: "failed", error: "could not reach the Anthropic API: getaddrinfo ENOTFOUND api.anthropic.com" };
    nextUtterance(w);
    delegate(w, "jarhead try again", "item_2");
    assert.ok(await until(() => brainRows(engine)[0]?.text.startsWith("Anthropic API brain could not reach its server") === true));
    assert.equal(brainRows(engine).length, 1, "one row about the brain in use, the newest");
    next = { status: "done", summary: "done." };
    nextUtterance(w);
    delegate(w, "jarhead once more", "item_3");
    assert.ok(await until(() => brainRows(engine).length === 0));
  } finally {
    await engine.stop();
  }
});

test("classifyBrainFailure: the brains' own lines for a lost login, a rate limit and a dead line; a task that failed on its own terms is none", () => {
  const cases: [string | undefined, ReturnType<typeof classifyBrainFailure>][] = [
    [EXPIRED, "auth"],
    ["Invalid API key · Please run /login", "auth"],
    ["ANTHROPIC_API_KEY is rejected by the API (401)", "auth"],
    ["Claude Code is not authenticated: OAuth token has expired", "auth"],
    ["Incorrect API key provided: sk-…", "auth"],
    ["the Anthropic API is rate limiting us; try again in a moment", "rate"],
    ["429 Too Many Requests", "rate"],
    ["You've hit your usage limit. Try again later.", "rate"],
    ["could not reach the Anthropic API: getaddrinfo ENOTFOUND api.anthropic.com", "unreachable"],
    ["the Anthropic API did not answer within 60 seconds", "unreachable"],
    ["fetch failed", "unreachable"],
    ["already handling a task", undefined],
    ["the model declined: I won't log in again to your bank for you", undefined],
    ["I stopped after 40 tool calls without finishing", undefined],
    ["I ran out of time after 300 seconds", undefined],
    ["the brain is restarting; ask again in a moment", undefined],
    ["the button labelled Save was not found", undefined],
    ["", undefined],
    [undefined, undefined],
  ];
  for (const [error, want] of cases) assert.equal(classifyBrainFailure(error), want, String(error));
});

test("F-CLAUDE-KEY: ANTHROPIC_API_KEY alone does not configure Claude Code (its session never receives the key); a binary or a login folder does", () => {
  const facts = (over: Partial<BrainFacts>): BrainFacts => ({ wanted: "auto", codex: { bin: undefined, version: undefined, signedIn: false, detail: "no codex" }, claudeBin: undefined, claudeHome: false, anthropicApiKey: undefined, baseUrl: undefined, ...over });
  assert.equal(brainNotConfigured("claude-code", facts({ anthropicApiKey: "sk-ant-test" })), "no claude binary or Claude login on this Mac");
  assert.equal(brainNotConfigured("anthropic-api", facts({ anthropicApiKey: "sk-ant-test" })), undefined, "the key is the Anthropic API brain's");
  assert.equal(brainNotConfigured("claude-code", facts({ claudeHome: true })), undefined);
  assert.equal(brainNotConfigured("claude-code", facts({ claudeBin: "/opt/claude" })), undefined);
});

test("F-AUTO-PROBE: under auto, Claude Code without credentials is passed at once and Go connects in under 2 s", async () => {
  const claude = fake("claude-code", { start: async () => ({ ready: false, detail: "Claude Code is not signed in. Run claude auth login." }) });
  const api = fake("anthropic-api");
  const w = selecting({ "claude-code": () => claude.brain, "anthropic-api": () => api.brain });
  const { engine } = w;
  try {
    const t0 = Date.now();
    await engine.start();
    await engine.wake("test");
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `Go took ${ms} ms`);
    assert.equal(engine.transportState, "awake");
    assert.equal(resolved(engine), "anthropic-api");
  } finally {
    await engine.stop();
  }
});

test("F-AUTO-PROBE: a start past the patience goes on in the background; the next ready brain takes the Go, and the slow one takes over once it proves itself and nothing runs", async () => {
  let release!: () => void;
  const claude = fake("claude-code", { start: () => new Promise((resolve) => (release = () => resolve({ ready: true, detail: "headless Claude Code (fake)" }))) });
  const api = fake("anthropic-api", { handle: () => new Promise(() => undefined) });
  const w = selecting({ "claude-code": () => claude.brain, "anthropic-api": () => api.brain }, { brainPatienceMs: 150 });
  const { engine } = w;
  try {
    const t0 = Date.now();
    await engine.start();
    await engine.wake("test");
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `Go took ${ms} ms`);
    assert.equal(resolved(engine), "anthropic-api", "the next ready brain took the Go");
    assert.equal(engine.snapshot().setup.brainDetail, "anthropic-api (fake) (auto: Claude Code still starting)");
    // A task is running on the Anthropic API brain when Claude Code proves itself: the swap waits for it.
    engine.updateSettings({ idleSleepMinutes: 0 });
    delegate(w, "jarhead summarize my last email", "item_1");
    assert.ok(await until(() => api.tasks.length === 1));
    release();
    await settle(50);
    assert.equal(resolved(engine), "anthropic-api", "never mid-task");
    await engine.command({ type: "interrupt" });
    assert.ok(await until(() => resolved(engine) === "claude-code", 3000), `still on ${resolved(engine)}`);
    assert.ok(await until(() => api.stops === 1), "the interim brain stopped");
    assert.equal(claude.stops, 0);
  } finally {
    await engine.stop();
  }
});

test("F-AUTO-PROBE: a slow start that fails is stopped with the walk's line; a new selection pass drops one still running", async () => {
  let fail!: () => void;
  let late!: () => void;
  const starts = [
    () => new Promise<{ ready: boolean; detail: string }>((resolve) => (fail = () => resolve({ ready: false, detail: "Claude Code exited: boom" }))),
    () => new Promise<{ ready: boolean; detail: string }>((resolve) => (late = () => resolve({ ready: true, detail: "late" }))),
    // The third pass's own start never lands: the second's late success is what the test is about.
    () => new Promise<{ ready: boolean; detail: string }>(() => undefined),
  ];
  const claudes: Fake[] = [];
  const api = fake("anthropic-api");
  const w = selecting(
    {
      "claude-code": () => {
        const f = fake("claude-code", { start: starts[claudes.length]! });
        claudes.push(f);
        return f.brain;
      },
      "anthropic-api": () => api.brain,
    },
    { brainPatienceMs: 100 },
  );
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    assert.equal(resolved(engine), "anthropic-api");
    fail();
    assert.ok(await until(() => claudes[0]!.stops === 1));
    assert.ok(brainRows(engine).some((p) => p.text === "Claude Code brain unavailable (Claude Code exited: boom)"), JSON.stringify(brainRows(engine)));
    assert.equal(resolved(engine), "anthropic-api");
    // A restart (Retry) starts a new pass; its own slow Claude Code is then left behind by a second restart.
    await engine.restartBrain("test: first");
    assert.equal(claudes.length, 2);
    await engine.restartBrain("test: second");
    assert.equal(claudes.length, 3);
    late();
    await settle(50);
    assert.equal(claudes[1]!.stops, 1, "a start from an older pass never takes over");
    assert.equal(resolved(engine), "anthropic-api");
  } finally {
    await engine.stop();
  }
});

test("F-PROXY-RESTARTING: a task that reaches the brain mid-restart is told 'the brain is restarting; ask again in a moment', never 'unknown error'", async () => {
  let stopped: (() => void) | undefined;
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: async () => ({ status: "done", summary: "done." }),
    cancel: async () => undefined,
    // The old brain is slow to stop the first time: the restart holds `brain` undefined meanwhile.
    stop: () => (stopped ? Promise.resolve() : new Promise<void>((resolve) => (stopped = resolve))),
  };
  const w = world({ brain });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const restarting = engine.restartBrain("test");
    await settle(20);
    delegate(w, "jarhead open my mail", "item_1");
    assert.ok(await until(() => said(w).some((s) => s.startsWith("Something went wrong"))));
    assert.ok(said(w).includes("Something went wrong: the brain is restarting; ask again in a moment"), JSON.stringify(said(w)));
    stopped?.();
    await restarting;
  } finally {
    await engine.stop();
  }
});

test("V14 / BL-12: an engine with probe: false makes no key check at start; probeSetup uses the fetch it was given", async () => {
  const dir = tempDir("jh-w21-probe-");
  const urls: string[] = [];
  const engine = new Engine({
    config: testConfig(dir, { openaiApiKey: "sk-test-not-used" }),
    connectors: [],
    brain: fake("codex").brain,
    probe: false,
    fetch: (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    discoverLocal: async () => ({ reachable: false, baseUrl: "", models: [], ramBytes: 0, checkedAt: Date.now() }),
    fallbackUserName: "Kevin",
  });
  try {
    await engine.start();
    await engine.ready();
    await settle(50);
    assert.deepEqual(urls, [], "nothing checked at start");
    assert.equal((await engine.probeSetup()).openaiKey, "ok");
    assert.deepEqual(urls, ["https://api.openai.com/v1/models/gpt-live-1"]);
  } finally {
    await engine.stop();
  }
});
