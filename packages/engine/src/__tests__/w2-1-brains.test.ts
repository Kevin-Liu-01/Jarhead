/**
 * W2-1, the brains' engine half (launch triage): a brain that fails says so, a signed-out one hands over, a key alone
 * is not a Claude login, and no Go waits out a slow probe.
 *
 * - E-SIGNEDOUT: a login that expired mid-run is a typed problem with Retry and the brain not ready; under `auto` the
 *   walk passes it over and lands on the next backend, and Retry tries it again. The kinds passed over add up, so two
 *   signed-out brains never alternate. A usage limit walks the same way, or says to try later. A passing rate limit
 *   and an unreachable server are rows of their own; a task that finishes clears them.
 * - F-CLAUDE-KEY: ANTHROPIC_API_KEY alone does not make Claude Code configured (its session never receives the key).
 * - F-AUTO-PROBE: a start past the patience goes on in the background while the next ready brain takes the Go; once
 *   it proves itself it takes over. A slow start that proves itself while the walk waits on the next one takes the Go
 *   at once, and the last client brain is waited on no longer than any other.
 * - F-PROXY-RESTARTING: a task that reaches the proxy mid-restart is told so, not "unknown error".
 *
 * The selection runs over fake brains (`EngineOptions.brainOf`): nothing here starts a CLI or reaches a network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Brain, BrainResult } from "@jarhead/brain";
import { Engine, brainNotConfigured, classifyBrainFailure, type BrainFacts, type SelectableBrain } from "../engine.ts";
import { delegate, nextUtterance, rows, settle, testConfig, tempDir, until, world, type World } from "./world.ts";

const said = (w: World): string[] => w.lives.flatMap((l) => [...l.instructions, ...l.commentary]);
const brainRows = (engine: Engine) => engine.typedProblems().filter((p) => p.kind === "brain.unavailable");
const resolved = (engine: Engine): string | undefined => engine.snapshot().setup.brainResolved;
const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();

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
    // The row names the fix and the brain used meanwhile, not "trying the next backend" after the walk has landed.
    assert.match(rows[0]!.text, /^Codex is signed out \(unexpected status 401.*\)\. Run codex login, then press Retry\. Using Claude Code meanwhile\.$/);
    assert.deepEqual(rows[0]!.remedy, { label: "Retry", command: { type: "problem.retry", kind: "brain.unavailable" } });
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

test("E-SIGNEDOUT: the kinds passed over add up; Codex then Claude Code signed out lands on the Anthropic API, never back and forth; Retry tries them all again", async () => {
  const signedOut = (kind: SelectableBrain) => () => fake(kind, { handle: async () => ({ status: "failed", error: EXPIRED }) }).brain;
  const api = fake("anthropic-api");
  const w = selecting({ codex: signedOut("codex"), "claude-code": signedOut("claude-code"), "anthropic-api": () => api.brain });
  const { engine } = w;
  const seen: (string | undefined)[] = [];
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    seen.push(resolved(engine));
    for (const [i, words] of ["jarhead summarize my last email from Ben", "jarhead find the invoice pdf in my downloads"].entries()) {
      const before = resolved(engine);
      delegate(w, words, `item_${i + 1}`);
      assert.ok(await until(() => resolved(engine) !== undefined && resolved(engine) !== before), `still on ${String(before)}`);
      seen.push(resolved(engine));
      nextUtterance(w);
    }
    assert.deepEqual(seen, ["codex", "claude-code", "anthropic-api"]);
    assert.ok(said(w).some((s) => s.includes("Claude Code is signed out. Switching to the next brain. Ask again.")), JSON.stringify(said(w)));
    // Both rows stand, each with its own fix and the brain in use meanwhile.
    const texts = brainRows(engine).map((p) => p.text);
    assert.equal(texts.length, 2, JSON.stringify(texts));
    assert.match(texts.find((t) => t.startsWith("Codex"))!, /^Codex is signed out \(unexpected status 401.*\)\. Run codex login, then press Retry\. Using Anthropic API meanwhile\.$/);
    assert.match(texts.find((t) => t.startsWith("Claude Code"))!, /^Claude Code is signed out \(unexpected status 401.*\)\. Run claude auth login, then press Retry\. Using Anthropic API meanwhile\.$/);
    // The next request runs on the Anthropic API, and the walk stays there.
    delegate(w, "jarhead what time is it in Tokyo", "item_3");
    assert.ok(await until(() => api.tasks.length === 1));
    await settle(50);
    assert.equal(resolved(engine), "anthropic-api");
    // Kevin signed both in again and pressed Retry: the walk starts from the top.
    await engine.retryProblem("brain.unavailable");
    assert.equal(resolved(engine), "codex");
    assert.equal(brainRows(engine).length, 0);
  } finally {
    await engine.stop();
  }
});

test("a usage limit says to come back later, in the server's own words, never 'in a minute'; under auto it walks to the next backend as a lost login does", async () => {
  const LIMIT = "You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.";
  const explicit = world({ brain: fake("codex", { handle: async () => ({ status: "failed", error: LIMIT }) }).brain });
  try {
    await explicit.engine.start();
    await explicit.engine.ready();
    explicit.engine.updateSettings({ idleSleepMinutes: 0 });
    await explicit.engine.wake("test");
    delegate(explicit, "jarhead summarize my last email", "item_1");
    assert.ok(await until(() => brainRows(explicit.engine).length === 1));
    assert.equal(brainRows(explicit.engine)[0]!.text, `Codex brain hit its usage limit (${LIMIT}). Try again later.`);
    assert.equal(explicit.engine.snapshot().brainReady, true, "the brain is up; its plan is spent");
  } finally {
    await explicit.engine.stop();
  }
  const codex = fake("codex", { handle: async () => ({ status: "failed", error: LIMIT }) });
  const claude = fake("claude-code");
  const auto = selecting({ codex: () => codex.brain, "claude-code": () => claude.brain });
  try {
    await auto.engine.start();
    await auto.engine.ready();
    auto.engine.updateSettings({ idleSleepMinutes: 0 });
    await auto.engine.wake("test");
    delegate(auto, "jarhead summarize my last email", "item_1");
    assert.ok(await until(() => resolved(auto.engine) === "claude-code"), `still on ${String(resolved(auto.engine))}`);
    assert.ok(said(auto).some((s) => s.includes("Codex hit its usage limit. Switching to the next brain. Ask again.")), JSON.stringify(said(auto)));
    const rows = brainRows(auto.engine);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text, `Codex hit its usage limit (${LIMIT}). Press Retry once it resets. Using Claude Code meanwhile.`);
  } finally {
    await auto.engine.stop();
  }
});

/** The speaker flushes the engine asked for, each with when it came (real time). */
function flushes(engine: Engine): number[] {
  const at: number[] = [];
  engine.on("event", (e: { type: string }) => {
    if (e.type === "speaker-flush") at.push(Date.now());
  });
  return at;
}
const startedRows = (w: World) => rows<{ type: string; sessionId: string; resumedFrom?: string }>(w, "session.started");

test("E-SIGNEDOUT (review repro): Codex alone under auto signs out mid-conversation; the walk lands on Responses, the failure line is heard out, and the session reopens with the conversation", async () => {
  const codex = fake("codex", { handle: async () => ({ status: "failed", error: EXPIRED }) });
  const w = selecting({ codex: () => codex.brain });
  const { engine } = w;
  const flushed = flushes(engine);
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    nextUtterance(w);
    delegate(w, "jarhead summarize my last email from Ben", "item_1");
    assert.ok(await until(() => resolved(engine) === "openai-responses"), `still on ${String(resolved(engine))}`);
    const first = w.lives[0]!;
    assert.ok(said(w).some((s) => s.includes("Codex is signed out. Switching to the next brain. Ask again.")), JSON.stringify(said(w)));
    // The voice has not said the line yet: nothing is flushed and the session is still the one Kevin is listening to.
    await settle(300);
    assert.deepEqual(flushed, [], "the speaker was flushed before the line was said");
    assert.equal(w.lives.length, 1);
    // The voice says it.
    first.emit("outputTranscript", "Codex is signed out.", 5000, 6200);
    first.emit("outputTranscript", " Switching to the next brain. Ask again.", 6200, 8100);
    const saidAt = Date.now();
    assert.ok(await until(() => w.lives.length === 2 && engine.transportState === "awake", 4000), `sessions ${w.lives.length}, transport ${engine.transportState}`);
    assert.ok(flushed.length > 0 && flushed[0]! - saidAt >= Engine.LINE_QUIET_MS - 50, `flushed ${flushed.map((t) => t - saidAt).join(", ")} ms after the line`);
    // The new session carries the conversation on: resumed from the first, its continuity holding what was said.
    assert.equal(startedRows(w).at(-1)?.resumedFrom, "sess_1");
    const instructions = String(w.lives[1]!.config?.instructions);
    assert.match(instructions, /# Continuity/);
    assert.match(instructions, /summarize my last email from Ben/);
    assert.equal(w.lives[1]!.config?.delegation?.type, "responses");
    const rowsNow = brainRows(engine).map((p) => p.text);
    assert.ok(rowsNow.some((t) => /^Codex is signed out \(unexpected status 401.*\)\. Run codex login, then press Retry\. Using OpenAI Responses meanwhile\.$/.test(t)), JSON.stringify(rowsNow));
  } finally {
    await engine.stop();
  }
});

test("E-SIGNEDOUT: Kevin asks again while the failure line is still being said; the wait ends, his words are not sent to the signed-out brain, and the reopened session carries them", async () => {
  const codex = fake("codex", { handle: async () => ({ status: "failed", error: EXPIRED }) });
  const w = selecting({ codex: () => codex.brain });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    nextUtterance(w);
    delegate(w, "jarhead summarize my last email from Ben", "item_1");
    assert.ok(await until(() => resolved(engine) === "openai-responses"));
    await settle(100);
    assert.equal(w.lives.length, 1, "the reopen waits for the line");
    const t0 = Date.now();
    nextUtterance(w);
    delegate(w, "jarhead what is on my calendar today", "item_2");
    assert.ok(await until(() => w.lives.length === 2 && engine.transportState === "awake", 3000), `sessions ${w.lives.length}`);
    assert.ok(Date.now() - t0 < Engine.LINE_CAP_MS - 2000, "the wait ended when Kevin spoke");
    assert.equal(codex.tasks.length, 1, "the second request never reached the signed-out brain");
    assert.equal(said(w).filter((s) => s.includes("Switching to the next brain")).length, 1, JSON.stringify(said(w)));
    assert.equal(startedRows(w).at(-1)?.resumedFrom, "sess_1");
    assert.match(String(w.lives[1]!.config?.instructions), /what is on my calendar today/);
  } finally {
    await engine.stop();
  }
});

test("E-SIGNEDOUT: a refused key is called a refused key, never 'signed out'; the row and the line say where to fix it", async () => {
  const REFUSED = "ANTHROPIC_API_KEY is rejected by the API (401)";
  const explicit = world({ brain: fake("anthropic-api", { handle: async () => ({ status: "failed", error: REFUSED }) }).brain });
  try {
    await explicit.engine.start();
    await explicit.engine.ready();
    explicit.engine.updateSettings({ idleSleepMinutes: 0 });
    await explicit.engine.wake("test");
    delegate(explicit, "jarhead summarize my last email", "item_1");
    assert.ok(await until(() => brainRows(explicit.engine).length === 1));
    assert.equal(brainRows(explicit.engine)[0]!.text, `Anthropic API brain's key was refused (${REFUSED}). Check ANTHROPIC_API_KEY in Setup, then press Retry.`);
    assert.ok(said(explicit).some((s) => s.includes("Anthropic API brain's key was refused. Check ANTHROPIC_API_KEY in Setup, then press Retry.")), JSON.stringify(said(explicit)));
    assert.ok(!said(explicit).some((s) => s.includes("signed out")));
  } finally {
    await explicit.engine.stop();
  }
  const api = fake("anthropic-api", { handle: async () => ({ status: "failed", error: REFUSED }) });
  const compatible = fake("openai-compatible");
  const auto = selecting({ "anthropic-api": () => api.brain, "openai-compatible": () => compatible.brain });
  try {
    await auto.engine.start();
    await auto.engine.ready();
    auto.engine.updateSettings({ idleSleepMinutes: 0 });
    await auto.engine.wake("test");
    delegate(auto, "jarhead summarize my last email", "item_1");
    assert.ok(await until(() => resolved(auto.engine) === "openai-compatible"), `still on ${String(resolved(auto.engine))}`);
    assert.ok(said(auto).some((s) => s.includes("Anthropic API brain's key was refused. Switching to the next brain. Ask again.")), JSON.stringify(said(auto)));
    assert.deepEqual(
      brainRows(auto.engine).map((p) => p.text),
      [`Anthropic API brain's key was refused (${REFUSED}). Check ANTHROPIC_API_KEY in Setup, then press Retry. Using OpenAI-compatible meanwhile.`],
    );
  } finally {
    await auto.engine.stop();
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
    ["You've hit your usage limit. Upgrade to Pro or try again in 2 hours 13 minutes.", "quota"],
    ["429 You exceeded your current quota, please check your plan and billing details.", "quota"],
    ["insufficient_quota", "quota"],
    ["Your credit balance is too low to access the Anthropic API.", "quota"],
    ["Claude AI usage limit reached|1760000000", "quota"],
    ["5-hour limit reached ∙ resets 3pm", "quota"],
    ["Rate limit reached for gpt-5 in organization org-x on tokens per min (TPM). Please try again in 1.2s. (429)", "rate"],
    ["Overloaded (529)", "rate"],
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

test("F-AUTO-PROBE: a slow start that proves itself while the walk waits on the next one takes the Go at once", async () => {
  // Codex passes the patience and is ready at 150 ms, while the walk waits on Claude Code, which never answers.
  const codex = fake("codex", { start: () => new Promise((resolve) => setTimeout(() => resolve({ ready: true, detail: "codex (fake, slow)" }), 150)) });
  const claude = fake("claude-code", { start: () => new Promise(() => undefined) });
  const w = selecting({ codex: () => codex.brain, "claude-code": () => claude.brain }, { brainPatienceMs: 100 });
  const { engine } = w;
  try {
    const t0 = Date.now();
    await engine.start();
    await engine.wake("test");
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `Go took ${ms} ms although Codex was ready at 150 ms`);
    assert.equal(engine.transportState, "awake");
    assert.equal(resolved(engine), "codex", "auto's first choice took the Go");
    assert.equal(engine.snapshot().setup.brainDetail, "codex (fake, slow)");
    assert.equal(brainRows(engine).length, 0);
  } finally {
    await engine.stop();
  }
});

test("F-AUTO-PROBE (review repro): the only client start never settles; the Go lands on Responses within the patience plus a margin, never waiting it out", async () => {
  const claude = fake("claude-code", { start: () => new Promise(() => undefined) });
  const w = selecting({ "claude-code": () => claude.brain }, { brainPatienceMs: 100 });
  const { engine } = w;
  try {
    await engine.start();
    const t0 = Date.now();
    const woke = engine.wake("test").then(() => "woke");
    const r = await Promise.race([woke, settle(4000).then(() => "still connecting")]);
    const ms = Date.now() - t0;
    assert.equal(r, "woke", `Go still connecting after 4 s with a 100 ms patience (transport=${engine.transportState})`);
    assert.ok(ms < 100 + 1000, `Go took ${ms} ms with a 100 ms patience`);
    assert.equal(engine.transportState, "awake");
    assert.equal(resolved(engine), "openai-responses");
    assert.match(engine.snapshot().setup.brainDetail, /\(auto: Claude Code still starting\)$/);
  } finally {
    await Promise.race([engine.stop(), settle(500)]);
  }
});

test("F-AUTO-PROBE: a start outranked by the brain in use goes quietly when it lands, ready or not", async () => {
  let land!: (r: { ready: boolean; detail: string }) => void;
  const codex = fake("codex", { start: () => new Promise((resolve) => setTimeout(() => resolve({ ready: true, detail: "codex (fake, slow)" }), 200)) });
  const claude = fake("claude-code", { start: () => new Promise((resolve) => (land = resolve)) });
  const w = selecting({ codex: () => codex.brain, "claude-code": () => claude.brain }, { brainPatienceMs: 100 });
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    assert.equal(resolved(engine), "codex");
    land({ ready: false, detail: "Claude Code exited: boom" });
    assert.ok(await until(() => claude.stops === 1), "the start the walk left behind stopped");
    assert.equal(brainRows(engine).length, 0, "no row about a brain that was never going to be used");
    assert.equal(resolved(engine), "codex");
  } finally {
    await engine.stop();
  }
});

test("F-AUTO-PROBE: when every client start is past the patience, the Go lands on Responses at once; the best start to prove itself takes over at a quiet moment, the session reopened with the conversation; Responses alone when all fail", async () => {
  let codexUp!: () => void;
  const codex = fake("codex", { start: () => new Promise((resolve) => (codexUp = () => resolve({ ready: true, detail: "codex (fake, late)" }))) });
  const claude = fake("claude-code", { start: () => new Promise((resolve) => setTimeout(() => resolve({ ready: true, detail: "claude (fake, slow)" }), 300)) });
  const w = selecting({ codex: () => codex.brain, "claude-code": () => claude.brain }, { brainPatienceMs: 100 });
  const { engine } = w;
  try {
    const t0 = Date.now();
    await engine.start();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    const ms = Date.now() - t0;
    assert.ok(ms < 1500, `Go took ${ms} ms`);
    assert.equal(resolved(engine), "openai-responses", "no start was waited on past its patience");
    assert.match(engine.snapshot().setup.brainDetail, /\(auto: Codex, Claude Code still starting\)$/);
    assert.equal(w.lives[0]!.config?.delegation?.type, "responses");
    // Claude Code proves itself (at about 400 ms), then Codex, while the voice is in an exchange: neither reopens the
    // session yet. Codex outranks Claude Code, so Claude Code's queued swap is dropped.
    await settle(400);
    assert.equal(resolved(engine), "openai-responses", "never mid-exchange");
    codexUp();
    await settle(50);
    tick(engine);
    assert.equal(resolved(engine), "openai-responses", "never mid-exchange");
    assert.equal(w.lives.length, 1);
    assert.ok(await until(() => claude.stops === 1), "the start Codex outranks stopped");
    // The exchange is over: the next tick swaps, and the session reopens on a client delegation with the conversation.
    w.clock.t += Engine.EXCHANGE_WINDOW_MS + 1000;
    tick(engine);
    assert.ok(await until(() => w.lives.length === 2 && engine.transportState === "awake"), `sessions ${w.lives.length}, transport ${engine.transportState}`);
    assert.equal(resolved(engine), "codex");
    assert.equal(w.lives[1]!.config?.delegation?.type ?? "client", "client");
    assert.match(String(w.lives[1]!.config?.instructions), /# Continuity/);
    assert.equal(rows<{ type: string; resumedFrom?: string }>(w, "session.started").at(-1)?.resumedFrom, "sess_1");
  } finally {
    await engine.stop();
  }
  const failing = (kind: SelectableBrain, ms: number) => () => fake(kind, { start: () => new Promise((resolve) => setTimeout(() => resolve({ ready: false, detail: `${kind} would not start` }), ms)) }).brain;
  const none = selecting({ codex: failing("codex", 200), "claude-code": failing("claude-code", 250) }, { brainPatienceMs: 100 });
  try {
    await none.engine.start();
    await none.engine.ready();
    assert.equal(resolved(none.engine), "openai-responses");
    const texts = () => brainRows(none.engine).map((p) => p.text);
    assert.ok(await until(() => texts().some((t) => t.startsWith("Codex brain unavailable (codex would not start)")) && texts().some((t) => t.startsWith("Claude Code brain unavailable (claude-code would not start)"))), JSON.stringify(texts()));
    assert.equal(resolved(none.engine), "openai-responses");
  } finally {
    await none.engine.stop();
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

test("V14 / BL-12: an engine with probe: false makes no key check at start; the fetch it was given serves probeSetup and memory, and the global fetch is never called", async () => {
  const dir = tempDir("jh-w21-probe-");
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  const offProcess: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    offProcess.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  }) as typeof fetch;
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
  const keyCheck = "https://api.openai.com/v1/models/gpt-live-1";
  try {
    await engine.start();
    await engine.ready();
    await settle(50);
    assert.ok(!urls.includes(keyCheck), `no key check at start: ${JSON.stringify(urls)}`);
    assert.equal((await engine.probeSetup()).openaiKey, "ok");
    assert.ok(urls.includes(keyCheck), JSON.stringify(urls));
    assert.deepEqual(offProcess, [], "every request went to the fetch the engine was given");
  } finally {
    try {
      await engine.stop();
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});
