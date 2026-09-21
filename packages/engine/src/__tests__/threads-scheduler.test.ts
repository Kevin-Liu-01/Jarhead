import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import { AgentRegistry, type AgentConnector } from "@jarhead/agents";
import { ConfirmationDesk, ConfirmationState, FocusLease, LEASE_IDLE_MS, WAIT_MAX_MS, type AcquireOptions, type LeaseOutcome } from "@jarhead/hands";
import type { Brain, BrainResult, BrainSink, BrainTask, ToolRunner } from "@jarhead/brain";
import { MAIN_THREAD_ID, THREAD_MAX_LIVE, type LedgerRow, type OverlayCommand, type Thread, type ThreadEvent } from "@jarhead/protocol";
import { ACTING_HOLD_MS, ThreadTable } from "../threads/table.ts";
import { THREAD_IDLE_END_MS, THREAD_PROGRESS_GAP_MS, ThreadScheduler, type ThreadBrainFactory, type ThreadParent, type ThreadVoice } from "../threads/scheduler.ts";
import { LANE_REFUSAL } from "../threads/runner.ts";
import { CONFIRMATION_RESUME, confirmationResume, resumeText, threadBrief } from "../threads/lines.ts";
import { RecordingHands, settle, threadNameOf, until } from "./world.ts";

/**
 * The scheduler without the engine: fake brains scripted per thread, a real
 * ConfirmationDesk over a ConfirmationState, a FocusLease over fake hands with fast
 * polls, a real Ledger in a temp dir, and a clock the test moves. Admission is
 * synchronous and refuses the fifth live thread, a spawned thread's spawn, a
 * duplicate name (case-insensitively) and a name over sixteen characters; the
 * budgets end a turn; a follow-up supersedes the running turn on the same brain;
 * `answerYes` arms only for the floor's lane; every change is one coalesced event
 * and never a snapshot; the ledger gets the thread.* rows the rebuild reads.
 */

interface FakeBrain {
  readonly id: string;
  name: string;
  readonly runner: ToolRunner;
  tasks: BrainTask[];
  sink: BrainSink | undefined;
  started: number;
  cancels: number;
  stops: number;
  resolve: ((r: BrainResult) => void) | undefined;
  /** The task whose `handle` is in flight (a late return after a bounded supersede lets go of ITS runner, not a newer turn's). */
  current: BrainTask | undefined;
}

interface Harness {
  readonly scheduler: ThreadScheduler;
  readonly table: ThreadTable;
  readonly clock: { t: number };
  readonly hands: RecordingHands;
  readonly handsBg: RecordingHands;
  readonly lease: FocusLease;
  readonly desk: ConfirmationDesk;
  readonly root: ConfirmationState;
  readonly ledger: Ledger;
  readonly brains: FakeBrain[];
  readonly events: ThreadEvent[];
  readonly changes: { n: number };
  readonly voice: { split: string[]; says: string[] };
  readonly overlays: OverlayCommand[];
  readonly parent: ThreadParent;
  readonly acquires: { actor: string; opts: AcquireOptions & { rank?: number | undefined } }[];
  script: ((job: { brain: FakeBrain; task: BrainTask; sink: BrainSink; runner: ToolRunner }) => Promise<BrainResult | undefined>) | undefined;
  startResult: ((brain: FakeBrain) => Promise<{ ready: boolean; detail: string }>) | undefined;
  byName(name: string): FakeBrain | undefined;
  rows<T extends LedgerRow["type"]>(type: T): Extract<LedgerRow, { type: T }>[];
  spawned(): readonly Thread[];
  start(name: string, task?: string, lane?: "screen" | "background", budget?: { steps?: number; seconds?: number }): ReturnType<ThreadScheduler["start"]>;
}

const fakeConnector: AgentConnector = {
  kind: "sessions",
  health: async () => ({ kind: "sessions", ok: true, detail: "ok" }),
  list: async () => [],
  send: async () => ({ accepted: true }),
  read: async () => "",
};

function harness(o: { spares?: number; enabled?: boolean; eyes?: boolean; memory?: (q: string, signal: AbortSignal) => Promise<string | undefined>; look?: () => Promise<string | undefined>; factory?: boolean; coalesceMs?: number; withMain?: boolean; /** A brain's `stop()` takes this long (a real app-server's does). */ stopDelayMs?: number; /** How long a superseded turn's brain may take to let go. */ supersedeWaitMs?: number; /** A brain's `handle` ignores `cancel()` and the abort: it never returns. */ deaf?: boolean; /** The user's name the lines say (default: none wired, so "Kevin"). */ userName?: string } = {}): Harness {
  const clock = { t: 1_757_500_000_000 };
  const now = (): number => clock.t;
  const dir = mkdtempSync(join(tmpdir(), "jh-threads-sched-"));
  const ledger = new Ledger(dir);
  const hands = new RecordingHands();
  const handsBg = new RecordingHands();
  hands.now = now;
  handsBg.now = now;
  const root = new ConfirmationState(3 * 60_000, now);
  const brains: FakeBrain[] = [];
  const events: ThreadEvent[] = [];
  const changes = { n: 0 };
  const voice = { split: [] as string[], says: [] as string[] };
  const overlays: OverlayCommand[] = [];
  const acquires: Harness["acquires"] = [];
  let scheduler!: ThreadScheduler;
  const desk = new ConfirmationDesk(root, (name, q) => void scheduler.speakQuestion(name, q), now);
  const lease = new FocusLease({ hands, now, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const acquire = lease.acquire.bind(lease);
  lease.acquire = (actor: string, opts: AcquireOptions): Promise<LeaseOutcome> => {
    acquires.push({ actor, opts });
    return acquire(actor, opts);
  };
  const h: Harness = {
    scheduler: undefined as unknown as ThreadScheduler,
    table: undefined as unknown as ThreadTable,
    clock,
    hands,
    handsBg,
    lease,
    desk,
    root,
    ledger,
    brains,
    events,
    changes,
    voice,
    overlays,
    acquires,
    parent: { id: "dlg_parent", liveId: "item_1", request: "tell ben on slack i'm late and play focus on spotify", kevinDialogue: "tell ben on slack i'm late and play focus on spotify", offsetMs: 1000 },
    script: undefined,
    startResult: undefined,
    byName: (name) => brains.find((b) => b.name === name),
    rows: (type) => ledger.read(clock.t).filter((r): r is Extract<LedgerRow, { type: typeof type }> => r.type === type),
    spawned: () => scheduler.threads().filter((t) => t.id !== MAIN_THREAD_ID),
    start: (name, task = `${name}'s job`, lane = "background", budget) => scheduler.start(h.parent, { name, task, lane, ...(budget ? { budget } : {}) }),
  };
  const factory: ThreadBrainFactory = (spec) => {
    const fb: FakeBrain = { id: spec.threadId, name: "", runner: spec.runner, tasks: [], sink: undefined, started: 0, cancels: 0, stops: 0, resolve: undefined, current: undefined };
    brains.push(fb);
    const brain: Brain = {
      kind: "fake-thread",
      start: async () => {
        fb.started++;
        return h.startResult ? h.startResult(fb) : { ready: true, detail: "fake thread" };
      },
      handle: (task, sink) =>
        new Promise<BrainResult>((resolve) => {
          fb.name = threadNameOf(task) ?? fb.name;
          fb.tasks.push(task);
          fb.sink = sink;
          fb.current = task;
          fb.runner.attach(sink, task);
          let settled = false;
          const done = (r: BrainResult): void => {
            if (settled) return;
            settled = true;
            // A brain lets go of ITS turn's runner and resolver — never a newer turn's.
            if (fb.current === task) {
              fb.runner.attach(undefined);
              fb.resolve = undefined;
              fb.current = undefined;
            }
            resolve(r);
          };
          fb.resolve = done;
          if (!o.deaf) task.signal.addEventListener("abort", () => done({ status: "cancelled" }), { once: true });
          const script = h.script;
          if (script) {
            void script({ brain: fb, task, sink, runner: fb.runner })
              .then((r) => {
                if (r) done(r);
              })
              .catch((e: unknown) => done({ status: "failed", error: (e as Error).message }));
          }
        }),
      cancel: async () => {
        fb.cancels++;
      },
      stop: async () => {
        if (o.stopDelayMs) await new Promise((r) => setTimeout(r, o.stopDelayMs));
        fb.stops++;
      },
    };
    return brain;
  };
  const threadVoice: ThreadVoice = {
    splitLine: (_parentId, name) => voice.split.push(name),
    threadSay: (_parentId, _name, text) => voice.says.push(text),
  };
  const agents = new AgentRegistry([fakeConnector], 0);
  const table = new ThreadTable({ now });
  if (o.withMain) table.started({ id: MAIN_THREAD_ID, name: "Jarhead", lane: "voice", status: "idle", task: "", apps: [], startedAt: clock.t, updatedAt: clock.t, turns: 0, steps: 0, waits: 0, budget: { steps: 40, seconds: 300 }, canSay: true, canStop: true });
  const userName = o.userName;
  scheduler = new ThreadScheduler({
    now,
    ledger,
    desk,
    lease,
    hands: { focus: hands, background: handsBg },
    runnerOptions: () => ({ agents, stateDir: dir, now }),
    toolsetOptions: () => ({ annotate: (cmd) => overlays.push(cmd), now }),
    makeBrain: () => (o.factory === false ? undefined : factory),
    parentFor: () => h.parent,
    voice: () => threadVoice,
    enabled: () => o.enabled !== false,
    onChange: () => changes.n++,
    table,
    onEvent: (e) => events.push(e),
    coalesceMs: o.coalesceMs ?? 30,
    warmThreads: () => o.spares ?? 0,
    memory: o.memory,
    eyes: o.eyes,
    look: o.look,
    supersedeWaitMs: o.supersedeWaitMs,
    userName: userName ? () => userName : undefined,
  });
  (h as { scheduler: ThreadScheduler }).scheduler = scheduler;
  (h as { table: ThreadTable }).table = table;
  return h;
}

const text = (r: { kind: string }): string => (r as { text?: string; message?: string }).text ?? (r as { message?: string }).message ?? "";
const busy = (t: Thread | undefined): boolean => t?.status === "thinking" || t?.status === "acting";

test("admission is synchronous and refuses: the fourth spawned thread (main + 3 live), a spawned thread's spawn (depth one), a duplicate live name case-insensitively, a name over 16 characters, no name, no task, threads off, no factory", async () => {
  const h = harness({ withMain: true });
  h.script = async () => undefined;
  for (const name of ["Spotify", "Slack", "Mail"]) {
    const t0 = process.hrtime.bigint();
    const r = h.start(name);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(r.kind, "text", text(r));
    assert.ok(ms < 20, `admitted in ${ms.toFixed(1)} ms`);
  }
  assert.equal(h.table.liveCount(), THREAD_MAX_LIVE, "main + 3");
  assert.match(text(h.start("Notes")), /^3 threads are busy/);
  assert.match(text(h.start("SPOTIFY")), /already running/);
  assert.match(text(h.start("mail")), /already running/);
  assert.match(text(h.start("ASeventeenCharName")), /too long \(at most 16 characters\)/);
  assert.match(text(h.start("  ")), /needs a name/);
  assert.match(text(h.start("Notes", "   ")), /needs a task/);
  const nested = h.scheduler.start({ ...h.parent, threadId: "t_x", depth: 1 }, { name: "Nested", task: "no", lane: "background" });
  assert.match(text(nested), /a thread never spawns a thread/);
  assert.equal(h.spawned().length, 3);
  assert.deepEqual(h.voice.split, ["Spotify"], "the split line once per parent");
  assert.equal(h.changes.n, 3, "the snapshot goes out once per start (the list changed), never for a step");
  const off = harness({ enabled: false });
  assert.match(text(off.start("Spotify")), /threads are off/);
  const none = harness({ factory: false });
  assert.match(text(none.start("Spotify")), /need a brain that runs its own thread/);
  await h.scheduler.cancelAll("test over");
  h.scheduler.dispose();
});

test("a warm spare is taken first: start() answers under 5 ms, no brain.start on the caller's path, the pool tops up; with no spare the boot is awaited inside the run (status `starting` until it answers) and a failed boot fails the thread with its line", async () => {
  const h = harness({ spares: 2 });
  h.script = async () => undefined;
  assert.equal(h.scheduler.warm(), 2);
  await settle(5);
  assert.equal(h.scheduler.pool.warmCount, 2);
  assert.equal(h.brains.length, 2);
  const t0 = process.hrtime.bigint();
  const r = h.start("Spotify");
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.kind, "text");
  assert.ok(ms < 5, `start() with a spare: ${ms.toFixed(2)} ms`);
  assert.equal(h.brains[0]!.started, 1, "the spare's one boot; none on the caller's path");
  await until(() => h.byName("Spotify") !== undefined);
  assert.equal(h.byName("Spotify"), h.brains[0]);
  await until(() => h.brains.length === 3);
  assert.equal(h.scheduler.spareIds.length, 2, "topped up");

  // Cold: the boot is awaited inside runJob.
  const cold = harness();
  let boot!: (r: { ready: boolean; detail: string }) => void;
  cold.startResult = () => new Promise((r) => (boot = r));
  cold.script = async () => ({ status: "done", summary: "done." });
  const started = cold.start("Slack");
  assert.equal(started.kind, "text", "returns before the boot");
  assert.equal(cold.spawned()[0]!.status, "starting");
  assert.equal(cold.scheduler.runnerFor(cold.spawned()[0]!.id)?.attached, false, "not until its brain is up");
  assert.equal(cold.scheduler.statusLine("slack"), "Slack is starting");
  boot({ ready: false, detail: "codex is not logged in" });
  await until(() => cold.spawned()[0]?.status === "failed");
  assert.equal(cold.spawned()[0]!.detail, "its brain did not start: codex is not logged in");
  assert.deepEqual(cold.voice.says, ["Slack failed: codex is not logged in"]);
  assert.equal(cold.brains[0]!.stops, 1);
  await h.scheduler.stopAll();
  h.scheduler.dispose();
  cold.scheduler.dispose();
});

test("a thread's steps land on ITS OWN delegation (threadId) with the marks stamped — firstToolAt on the first look, firstActionAt on the first ok acting tool, one round trip per tool, the eyes' shot excluded; the ledger carries delegation.created/step/finished with the threadId and the thread.started row", async () => {
  const h = harness();
  h.script = async (job) => {
    h.clock.t += 100;
    await job.runner.run("frontmost_app", {});
    h.clock.t += 100;
    await job.runner.run("applescript", { script: 'tell application "Spotify" to play' });
    h.clock.t += 100;
    return { status: "done", summary: "playing Focus." };
  };
  h.start("Spotify", "play the playlist Focus in Spotify");
  await until(() => h.spawned()[0]?.status === "done");
  const id = h.spawned()[0]!.id;
  const turns = h.scheduler.turnsOf(id);
  assert.equal(turns.length, 1);
  const d = turns[0]!;
  assert.equal(d.threadId, id);
  assert.equal(d.request, h.parent.request);
  assert.equal(d.liveId, "item_1");
  assert.equal(d.status, "done");
  assert.equal(d.summary, "playing Focus.");
  const t = d.timings as { firstToolAt?: number; firstActionAt?: number; toolRoundTripMs?: number[]; eyesMs?: number; doneAt?: number };
  assert.equal(t.firstToolAt, d.createdAt + 100, "the first LOOK, not the eyes' shot");
  assert.equal(t.firstActionAt, d.createdAt + 200, "the Apple event that returned ok");
  assert.equal(t.toolRoundTripMs?.length, 2, "one sample per tool, the eyes' shot excluded");
  assert.equal(t.eyesMs, 0, "the eyes' shot took no fake time");
  assert.equal(t.doneAt, d.createdAt + 300);
  assert.ok(d.steps.some((s) => s.kind === "tool" && s.tool?.name === "screenshot"), "the eyes' shot is on the record");
  assert.equal(d.stepCount, d.steps.length);
  assert.equal(h.spawned()[0]!.steps, 2, "two steps of its own work");
  assert.deepEqual(h.spawned()[0]!.apps, ["Spotify"], "`tell application \"Spotify\"` claimed the app");
  const created = h.rows("delegation.created").filter((r) => r.delegation.threadId === id);
  assert.equal(created.length, 1);
  assert.equal(h.rows("delegation.step").filter((r) => r.delegationId === d.id).length, d.steps.length);
  const finished = h.rows("delegation.finished").find((r) => r.delegationId === d.id)!;
  assert.equal(finished.status, "done");
  assert.equal((finished.timings as { firstActionAt?: number }).firstActionAt, d.createdAt + 200);
  const started = h.rows("thread.started");
  assert.equal(started.length, 1);
  assert.equal(started[0]!.thread.id, id);
  assert.equal(started[0]!.thread.task, "play the playlist Focus in Spotify");
  const ended = h.rows("thread.ended")[0]!;
  assert.equal(ended.status, "done");
  assert.equal(ended.steps, 2);
  assert.equal(ended.summary, "playing Focus.");
  assert.deepEqual(h.rows("thread.said").map((r) => r.text), ["Spotify: playing Focus."]);
  assert.equal(h.rows("thread.status").length, 0, "thinking↔acting never a row");
  h.scheduler.dispose();
});

test("events: one `started` at once; a step is exactly one `step` event ≤ 200 B and zero snapshots; a burst of steps within the window is two events; `ended` at once; the eyes' shot is no event", async () => {
  const h = harness();
  const gate = { open: undefined as (() => void) | undefined };
  h.script = async (job) => {
    await new Promise<void>((r) => (gate.open = r));
    await job.runner.run("frontmost_app", {});
    return undefined;
  };
  h.start("Spotify");
  await until(() => gate.open !== undefined);
  await settle(60);
  assert.deepEqual(h.events.map((e) => e.kind), ["started", "status", "turn"], "started, thinking once its brain was up, the turn; the eyes' shot is no event");
  const changes = h.changes.n;
  const n = h.events.length;
  gate.open!();
  await until(() => h.events.length > n);
  await settle(60);
  const fresh = h.events.slice(n);
  assert.equal(fresh.length, 1, JSON.stringify(fresh));
  assert.equal(fresh[0]!.kind, "step");
  assert.ok(JSON.stringify(fresh[0]).length <= 200, `${JSON.stringify(fresh[0]).length} B`);
  assert.equal(h.changes.n, changes, "no snapshot for a step");
  const fb = h.byName("Spotify")!;
  const m = h.events.length;
  for (let i = 0; i < 8; i++) await fb.runner.run("frontmost_app", {});
  await settle(80);
  const burst = h.events.slice(m);
  assert.equal(burst.length, 2, "the first at once, the newest at the window's end");
  assert.equal((burst[1] as { steps: number }).steps, 9);
  fb.resolve!({ status: "done", summary: "done." });
  await until(() => h.events[h.events.length - 1]?.kind === "ended");
  assert.equal(h.changes.n, changes + 1, "the end changes the list: one snapshot");
  assert.equal(h.scheduler.listChanges, h.changes.n, "the scheduler's own count of list changes is the snapshot count");
  assert.deepEqual(h.events.slice(-2).map((e) => e.kind), ["said", "ended"], "the finish line reaches the wire BEFORE the end: a store that closes the thread on `ended` has its last line");
  assert.equal((h.events[h.events.length - 2] as { text: string }).text, "Spotify: done.");
  h.scheduler.dispose();
});

test("budgets are per turn: past the step budget the thread fails at the step after with its line; past the seconds budget at its next step; three waits for the screen fail it 'could not get the screen'; `waits` and `budget` are on the record", async () => {
  const h = harness();
  h.script = async (job) => {
    for (let i = 0; i < 6; i++) {
      if (job.task.signal.aborted) return { status: "cancelled" };
      await job.runner.run("frontmost_app", {});
    }
    return { status: "done", summary: "six looks." };
  };
  h.start("Spotify", "look six times", "background", { steps: 2 });
  await until(() => h.spawned()[0]?.status === "failed");
  assert.equal(h.spawned()[0]!.detail, "I stopped after 2 tool calls without finishing");
  assert.equal(h.spawned()[0]!.steps, 3);
  assert.deepEqual(h.spawned()[0]!.budget, { steps: 2, seconds: 180 });
  assert.deepEqual(h.voice.says, ["Spotify failed: I stopped after 2 tool calls without finishing"]);
  assert.equal(h.byName("Spotify")!.cancels, 1);
  assert.equal(h.byName("Spotify")!.stops, 1);

  h.script = async (job) => {
    for (let i = 0; i < 6; i++) {
      if (job.task.signal.aborted) return { status: "cancelled" };
      h.clock.t += 6000;
      await job.runner.run("frontmost_app", {});
    }
    return { status: "done", summary: "six looks." };
  };
  h.start("Slack", "look slowly", "background", { seconds: 10 });
  await until(() => h.spawned().find((t) => t.name === "Slack")?.status === "failed");
  const slack = h.spawned().find((t) => t.name === "Slack")!;
  assert.equal(slack.detail, "I ran out of time after 10 seconds");
  assert.equal(slack.steps, 2);
  assert.equal(slack.budget.seconds, 10);

  // Waits: Jarhead's hands hold the screen with an op in flight (a held key) for the whole test, so the lease
  // never hands over on idle; each of the thread's waits runs the 8 s out.
  const got = await h.lease.acquire("jarhead", { priority: true });
  assert.ok(got.ok);
  h.lease.beginOp("jarhead");
  let attempts = 0;
  h.script = async (job) => {
    for (let i = 0; i < 5; i++) {
      if (job.task.signal.aborted) return { status: "cancelled" };
      attempts++;
      const r = (await job.runner.run("key", { text: "space" })).result;
      if (r.kind === "text") return { status: "done", summary: "pressed." };
    }
    return { status: "failed", error: "gave up" };
  };
  h.start("Mail", "press play", "screen");
  for (let n = 1; n <= 3; n++) {
    await until(() => attempts === n && h.spawned().find((t) => t.name === "Mail")?.status === "waiting-screen");
    assert.equal(h.spawned().find((t) => t.name === "Mail")!.waits, n - 1);
    h.clock.t += WAIT_MAX_MS + 100;
  }
  await until(() => h.spawned().find((t) => t.name === "Mail")?.status === "failed");
  const mail = h.spawned().find((t) => t.name === "Mail")!;
  assert.equal(mail.detail, "could not get the screen");
  assert.equal(mail.waits, 3);
  assert.equal(attempts, 3, "the fourth call never came");
  assert.equal(h.rows("thread.status").filter((r) => r.threadId === mail.id && r.status === "waiting-screen").length, 1, "one row when it began waiting (thinking↔waiting flips never repeat it)");
  assert.equal(h.lease.holder, "jarhead");
  h.lease.endOp("jarhead");
  h.scheduler.dispose();
});

test("the background lane refuses every FOCUS tool with the lane line and no helper op; the screen lane takes the lease with the thread's admission rank, reads through the acting helper and reports waiting-screen while the screen is another's", async () => {
  const h = harness();
  const refusals: string[] = [];
  h.script = async (job) => {
    for (const [name, input] of [["type", { text: "x" }], ["left_click", { coordinate: [1, 1] }], ["open_app", { name: "Slack" }], ["clipboard_read", {}]] as const) {
      const r = (await job.runner.run(name, input)).result;
      if (r.kind === "error") refusals.push(r.message);
    }
    await job.runner.run("frontmost_app", {});
    return { status: "done", summary: "reported." };
  };
  h.hands.ops.length = 0;
  h.handsBg.ops.length = 0;
  h.start("Spotify");
  await until(() => h.spawned()[0]?.status === "done");
  assert.equal(refusals.length, 4);
  assert.ok(refusals.every((m) => m === LANE_REFUSAL));
  assert.equal(h.hands.ops.length, 0, "the acting helper saw nothing");
  assert.deepEqual(h.handsBg.ops.map((o) => o.op), ["screenshot", "frontmost"], "the eyes' shot and the one read, both on the reading helper");
  assert.equal(h.acquires.length, 0, "a background thread never touches the lease");

  // Screen lane: the lease is asked with the rank; the acting helper answers.
  h.script = async (job) => {
    await job.runner.run("key", { text: "space" });
    return { status: "done", summary: "pressed." };
  };
  h.hands.ops.length = 0;
  h.handsBg.ops.length = 0;
  h.start("Slack", "press play", "screen");
  await until(() => h.spawned().find((t) => t.name === "Slack")?.status === "done");
  assert.equal(h.acquires.length, 1);
  assert.equal(h.acquires[0]!.actor, h.spawned().find((t) => t.name === "Slack")!.id);
  assert.equal(h.acquires[0]!.opts.priority, false);
  assert.equal(h.acquires[0]!.opts.rank, 1, "the second admission: rank 1 (Kevin's hands and main come before every thread)");
  assert.equal(h.hands.named("key").length, 1, "the key went out through the acting helper");
  assert.equal(h.handsBg.named("screenshot").length, 1, "the eyes' shot still reads through the reading helper");
  assert.equal(h.hands.named("screenshot").length, 0);
  assert.equal(h.lease.holder, undefined, "released at the turn's end");
  h.scheduler.dispose();
});

test("a follow-up supersedes the running turn on the same brain (brain.cancel once, the record closed cancelled, the process kept), the next turn carries Kevin's words and his marks; a follow-up on a finished or unknown thread is false", async () => {
  const h = harness();
  h.script = async () => undefined;
  h.start("Spotify");
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const fb = h.byName("Spotify")!;
  const id = h.spawned()[0]!.id;
  const first = h.scheduler.turnsOf(id)[0]!;
  const ok = await h.scheduler.followUp(id, "skip this song", { items: [{ id: "u1", speaker: "kevin", text: "spotify, skip this song", startMs: 1, endMs: 2, at: h.clock.t, final: true }], marks: [{ path: "/tmp/m.png", mediaType: "image/png", note: "Kevin circled this", kind: "mark" }] });
  assert.equal(ok, true);
  await until(() => fb.tasks.length === 2);
  assert.equal(fb.cancels, 1);
  assert.equal(fb.stops, 0);
  assert.equal(fb.tasks[1]!.request, "skip this song");
  assert.equal(fb.tasks[1]!.confirmation, false);
  assert.match(fb.tasks[1]!.dialogue, /Kevin \(to Spotify\): skip this song$/);
  assert.match(fb.tasks[1]!.kevinDialogue ?? "", /skip this song$/);
  assert.ok(fb.tasks[1]!.attachments?.some((a) => a.kind === "mark"));
  assert.ok(fb.tasks[1]!.attachments?.some((a) => a.kind === "screen"), "a fresh eyes' shot too");
  const turns = h.scheduler.turnsOf(id);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.id, first.id);
  assert.equal(turns[0]!.status, "cancelled");
  assert.equal(turns[0]!.summary, "superseded by Kevin's follow-up");
  assert.equal(turns[1]!.status, "running");
  assert.equal(h.spawned()[0]!.turns, 2);
  assert.ok(busy(h.spawned()[0]));
  const log = h.scheduler.log(id)!;
  assert.ok(log.since(0).some((e) => e.kind === "utterance" && e.item.text === "spotify, skip this song"), "his words are on the thread's record");
  assert.ok(log.since(0).some((e) => e.kind === "delegation" && e.delegation.id === turns[1]!.id));
  assert.ok(h.events.some((e) => e.kind === "turn" && (e as { request: string }).request === "skip this song"));
  fb.resolve!({ status: "done", summary: "skipped." });
  await until(() => h.spawned()[0]?.status === "done");
  assert.equal(await h.scheduler.followUp(id, "again"), false, "finished");
  assert.equal(await h.scheduler.followUp("t_nobody", "x"), false);
  assert.equal(await h.scheduler.followUp(id, "   "), false, "no words");
  h.scheduler.dispose();
});

test("answerYes arms only when the floor is that thread's: refused with the floor's name when another lane holds it, refused with no question, refused for main (the engine's); accepted → the grant row when grantable, one confirmation turn; answerNo forgets that lane's question and stops a thread that cannot go on", async () => {
  const h = harness();
  const results: Record<string, string[]> = { Slack: [], Spotify: [] };
  h.script = async (job) => {
    const r = (await job.runner.run("click_element", { name: "Send" })).result;
    results[job.brain.name]!.push(r.kind);
    return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
  };
  assert.deepEqual(await h.scheduler.answerYes("t_nobody"), { ok: false, reason: "no question is waiting" });
  h.start("Slack", "send the message", "screen");
  await until(() => h.spawned()[0]?.status === "waiting-kevin");
  const slackId = h.spawned()[0]!.id;
  assert.equal(h.desk.floor?.laneId, slackId);
  assert.equal(h.voice.says.length, 1, "spoken once, with its name");
  assert.match(h.voice.says[0]!, /^Slack asks: /);
  assert.equal(h.scheduler.turnsOf(slackId)[0]!.status, "awaiting-confirmation");
  h.start("Spotify", "clear the queue", "screen");
  await until(() => h.spawned().find((t) => t.name === "Spotify")?.status === "waiting-kevin");
  const spotifyId = h.spawned().find((t) => t.name === "Spotify")!.id;
  assert.equal(h.desk.queuedCount, 1);
  // The queued thread's record carries ITS question's words, not the "Queued behind Slack's question…" text its brain read.
  assert.doesNotMatch(h.table.get(spotifyId)!.question ?? "", /Queued behind/);
  assert.match(h.table.get(spotifyId)!.question ?? "", /Send/);
  assert.equal(h.scheduler.turnsOf(spotifyId)[0]!.summary, h.table.get(spotifyId)!.question);
  assert.deepEqual(await h.scheduler.answerYes(spotifyId), { ok: false, reason: "another question is on the floor: Slack's" });
  assert.deepEqual(await h.scheduler.answerYes(MAIN_THREAD_ID), { ok: false, reason: "another question is on the floor: Slack's" });
  assert.equal(results["Slack"]!.length, 1, "nothing ran");
  assert.equal(h.hands.named("click").length, 0);
  const ok = await h.scheduler.answerYes(slackId);
  assert.deepEqual(ok, { ok: true });
  await until(() => results["Slack"]!.length === 2);
  assert.equal(results["Slack"]![1], "text", "the click landed on the confirmation turn");
  assert.equal(h.hands.named("click").length, 1);
  assert.equal(h.byName("Slack")!.tasks[1]!.confirmation, true);
  assert.equal(h.spawned().find((t) => t.name === "Slack")!.turns, 2);
  await until(() => h.spawned().find((t) => t.name === "Slack")?.status === "done");
  // The queue moved: Spotify's question is on the floor, spoken with its name; Kevin says no.
  await until(() => h.desk.floor?.laneId === spotifyId);
  assert.ok(h.voice.says.some((s) => /^Spotify asks: /.test(s)));
  // One `waiting-kevin` row per thread: the promotion re-spoke the question, it did not re-record the status.
  const waitingRows = h.rows("thread.status").filter((r) => r.status === "waiting-kevin");
  assert.equal(waitingRows.filter((r) => r.threadId === slackId).length, 1);
  assert.equal(waitingRows.filter((r) => r.threadId === spotifyId).length, 1, "the queued question was recorded once, when its turn ended; the promotion wrote no second row");
  assert.equal(waitingRows.find((r) => r.threadId === spotifyId)!.detail, h.table.get(spotifyId)!.question, "and with the question's own words");
  assert.equal(h.events.filter((e) => e.kind === "question" && e.threadId === spotifyId).length, 1, "the same words again append no event");
  assert.equal(await h.scheduler.answerNo(spotifyId), true);
  assert.equal(h.desk.floor, undefined);
  await until(() => h.spawned().find((t) => t.name === "Spotify")?.status === "stopped");
  assert.equal(h.spawned().find((t) => t.name === "Spotify")!.detail, "Kevin said no");
  assert.equal(results["Spotify"]!.length, 1, "never clicked");
  assert.equal(await h.scheduler.answerNo("t_nobody"), false);
  h.scheduler.dispose();
});

test("pause: the turn is superseded (brain.cancel once), the lease released, the question dropped, status `paused` with its row; resume runs one continuation turn; pauseAll / resumeAll cover every live thread oldest first; a paused thread's follow-up resumes it with the words", async () => {
  const h = harness();
  h.script = async () => undefined;
  h.start("Spotify");
  h.start("Slack", "tell Ben", "screen");
  await until(() => h.byName("Spotify")?.tasks.length === 1 && h.byName("Slack")?.tasks.length === 1);
  const [spotify, slack] = [h.spawned()[0]!, h.spawned()[1]!];
  assert.equal(await h.scheduler.pause(spotify.id), true);
  assert.equal(h.byName("Spotify")!.cancels, 1);
  assert.equal(h.byName("Spotify")!.stops, 0, "the process stays warm");
  assert.equal(h.table.get(spotify.id)!.status, "paused");
  assert.equal(h.table.get(spotify.id)!.detail, "Kevin paused it");
  assert.equal(h.scheduler.turnsOf(spotify.id)[0]!.status, "cancelled");
  assert.equal(h.scheduler.turnsOf(spotify.id)[0]!.summary, "Kevin paused it");
  assert.deepEqual(h.rows("thread.status").map((r) => [r.threadId, r.status]), [[spotify.id, "paused"]]);
  assert.equal(h.scheduler.statusLine("spotify"), "Spotify is paused at step 0");
  assert.equal(await h.scheduler.pause(spotify.id), false, "already paused");
  assert.equal(h.scheduler.running(), 2, "paused threads are live");
  await h.scheduler.resume(spotify.id);
  await until(() => h.byName("Spotify")!.tasks.length === 2);
  assert.match(h.byName("Spotify")!.tasks[1]!.dialogue, /Kevin paused you at step 0; carry on/);
  assert.ok(busy(h.table.get(spotify.id)));
  await h.scheduler.pauseAll();
  assert.equal(h.table.count("paused"), 2);
  assert.equal(h.byName("Spotify")!.cancels, 2);
  assert.equal(h.byName("Slack")!.cancels, 1);
  assert.equal(h.lease.holder, undefined);
  await h.scheduler.resumeAll();
  await until(() => h.byName("Spotify")!.tasks.length === 3 && h.byName("Slack")!.tasks.length === 2);
  assert.ok(busy(h.table.get(spotify.id)) && busy(h.table.get(slack.id)));
  await h.scheduler.pause(slack.id);
  assert.equal(await h.scheduler.followUp(slack.id, "tell him five minutes"), true);
  await until(() => h.byName("Slack")!.tasks.length === 3);
  assert.equal(h.byName("Slack")!.tasks[2]!.request, "tell him five minutes");
  await h.scheduler.cancelAll("done");
  h.scheduler.dispose();
});

test("speak_progress on a thread speaks once per turn as '<Name>: …' and never within 20 s of its last line; the rest stays on the record; a new turn after the gap speaks again", async () => {
  const h = harness();
  h.script = async () => undefined;
  h.start("Spotify");
  await until(() => h.byName("Spotify")?.sink !== undefined);
  const fb = h.byName("Spotify")!;
  fb.sink!.commentary("pressing play");
  fb.sink!.commentary("and the volume");
  fb.sink!.thinking("looking");
  assert.deepEqual(h.voice.says, ["Spotify: pressing play"]);
  assert.deepEqual(h.rows("thread.said").map((r) => r.text), ["Spotify: pressing play"]);
  const id = h.spawned()[0]!.id;
  const steps = h.scheduler.turnsOf(id)[0]!.steps;
  assert.equal(steps.filter((s) => s.kind === "commentary").length, 2, "both lines on the record");
  assert.equal(steps.filter((s) => s.kind === "thinking").length, 1);
  assert.equal(h.scheduler.statusLine("spotify"), "Spotify is pressing play — 0 seconds in", "the fragment 'and the volume' is no phrase: the line keeps the last one that read");
  // A follow-up turn within the gap: still silent; after the gap: one more.
  await h.scheduler.followUp(id, "louder");
  await until(() => fb.tasks.length === 2);
  fb.sink!.commentary("turning it up");
  assert.equal(h.voice.says.length, 1, "within THREAD_PROGRESS_GAP_MS of the last line");
  h.clock.t += THREAD_PROGRESS_GAP_MS;
  await h.scheduler.followUp(id, "even louder");
  await until(() => fb.tasks.length === 3);
  fb.sink!.commentary("maxed out");
  assert.deepEqual(h.voice.says, ["Spotify: pressing play", "Spotify: maxed out"]);
  await h.scheduler.cancelAll("done");
  h.scheduler.dispose();
});

test("stop by kevin speaks '<Name> stopped.', by cut is silent, by the brain (thread_stop) answers the brain; stopNamed is case-insensitive and false for a finished thread; thread_wait waits for a settled or waiting thread and reads a finished one", async () => {
  const h = harness();
  h.script = async () => undefined;
  const task = { delegationId: "item_1", request: h.parent.request, dialogue: "", confirmation: false, offsetMs: 0, signal: new AbortController().signal };
  const started = await h.scheduler.tool("thread_start", { name: "Spotify", task: "play Focus", lane: "background" }, { task });
  assert.match(text(started), /^started thread Spotify \(t_/);
  const second = await h.scheduler.tool("thread_start", { name: "Slack", task: "tell Ben" }, { task });
  assert.equal(second.kind, "text");
  await until(() => h.byName("Spotify") !== undefined && h.byName("Slack") !== undefined);
  const read = await h.scheduler.tool("thread_read", { name: "spotify" }, { task });
  assert.match(text(read), /^Spotify: still working \(0 steps, 0 s\); thread_wait again or thread_stop it$/);
  const waiting = h.scheduler.tool("thread_wait", { name: "Spotify", timeout: 5 }, { task });
  await settle(20);
  assert.equal(await h.scheduler.stopNamed("SPOTIFY"), true);
  assert.match(text(await waiting), /^Spotify: stopped — Kevin stopped it \(Kevin was told: "Spotify stopped\."\)/);
  assert.deepEqual(h.voice.says, ["Spotify stopped."]);
  assert.equal(await h.scheduler.stopNamed("spotify"), false, "finished: not live");
  assert.equal(await h.scheduler.stop("t_nobody"), false);
  const stopped = await h.scheduler.tool("thread_stop", { name: "Slack" }, { task });
  assert.match(text(stopped), /^Slack stopped \(0 steps\)\. Kevin was told: "Slack stopped\."$/);
  assert.deepEqual(h.voice.says, ["Spotify stopped.", "Slack stopped."]);
  assert.equal(h.byName("Slack")!.cancels, 1);
  assert.equal(h.byName("Slack")!.stops, 1);
  const unknown = await h.scheduler.tool("thread_stop", { name: "Mail" }, { task });
  assert.match(text(unknown), /no thread named "Mail"/);
  const all = await h.scheduler.tool("thread_wait", { name: "all" }, { task });
  assert.match(text(all), /Spotify: stopped[\s\S]*Slack: stopped/);
  // A cut says nothing.
  h.start("Mail");
  await until(() => h.byName("Mail") !== undefined);
  await h.scheduler.cancelAll("interrupt");
  assert.equal(h.voice.says.length, 2, "silent");
  assert.equal(h.spawned().find((t) => t.name === "Mail")!.status, "stopped");
  assert.equal(h.rows("thread.ended").filter((r) => r.status === "stopped").length, 3);
  const noParent = harness();
  const none = await noParent.scheduler.tool("thread_read", { name: "x" }, { task });
  assert.match(text(none), /no thread named "x"/);
  h.scheduler.dispose();
  noParent.scheduler.dispose();
});

test("statusLine through the scheduler: the tool's phrase while acting, the question while waiting on Kevin, the overview for two; threadNames lists the live spawned names; anyScreenBusy is true only for a screen thread at work", async () => {
  const h = harness();
  const holds = new Map<string, () => void>();
  h.script = async (job) => {
    if (job.brain.name === "Slack") {
      await job.runner.run("open_app", { name: "Slack" });
      await new Promise<void>((r) => holds.set("Slack", r));
      return undefined;
    }
    await job.runner.run("applescript", { script: 'tell application "Spotify" to play' });
    await new Promise<void>((r) => holds.set("Spotify", r));
    return undefined;
  };
  h.start("Spotify");
  await until(() => holds.has("Spotify"));
  assert.equal(h.scheduler.anyScreenBusy(), false, "a background thread never holds the ear");
  h.clock.t += 3000;
  assert.equal(h.scheduler.statusLine("spotify"), "Spotify is running an AppleScript — 3 seconds in");
  h.start("Slack", "tell Ben", "screen");
  await until(() => holds.has("Slack"));
  assert.equal(h.scheduler.anyScreenBusy(), true);
  assert.equal(h.scheduler.statusLine("slack"), "Slack is opening Slack — 0 seconds in");
  assert.deepEqual(h.scheduler.threadNames(), ["Spotify", "Slack"]);
  assert.equal(h.scheduler.statusLine(), "Two threads: Spotify working, Slack working");
  h.clock.t += ACTING_HOLD_MS;
  h.scheduler.tick();
  assert.equal(h.table.get(h.spawned()[0]!.id)!.status, "thinking", "no step for 4 s: thinking");
  assert.equal(h.scheduler.statusLine("spotify"), "Spotify is running an AppleScript — 7 seconds in");
  assert.equal(h.scheduler.statusLine("mail"), "nothing called mail is running; Spotify and Slack are");
  assert.equal(h.scheduler.speakQuestion("Slack", "send it to Ben?"), true);
  assert.equal(h.scheduler.statusLine("slack"), "Slack is waiting on you: send it to Ben?");
  assert.deepEqual(h.voice.says, ["Slack asks: send it to Ben?"]);
  assert.equal(h.scheduler.speakQuestion("Jarhead", "May I?"), false, "the main lane's: the engine speaks for it");
  assert.equal(h.scheduler.anyScreenBusy(), false, "waiting on Kevin is not at work");
  await h.scheduler.cancelAll("done");
  assert.equal(h.scheduler.statusLine(), "nothing is running");
  h.scheduler.dispose();
});

test("apps are claimed from open_app, `tell application`, and a browser host; a tagged orb.fly from the thread's toolset carries `thread` to the overlay and lands on the record as `at`; the summaries carry the app and the lane", async () => {
  const h = harness();
  h.script = async (job) => {
    await job.runner.run("applescript", { script: 'tell application "Spotify" to play track "x"' });
    await job.runner.run("web_fetch", { url: "https://example.com/x" });
    // The blob's fly rides the toolset's annotate: tagged with the thread.
    (job.runner as unknown as { opts: { toolset: { opts: { annotate?: (c: OverlayCommand) => void } } } }).opts.toolset.opts.annotate?.({ cmd: "orb.fly", x: 100.4, y: 200.6, reason: "click" });
    (job.runner as unknown as { opts: { toolset: { opts: { annotate?: (c: OverlayCommand) => void } } } }).opts.toolset.opts.annotate?.({ cmd: "rect", rect: { x: 0, y: 0, w: 1, h: 1 } });
    return undefined;
  };
  h.start("Spotify");
  await until(() => h.overlays.length === 2);
  const id = h.spawned()[0]!.id;
  const fly = h.overlays.find((c) => c.cmd === "orb.fly") as Extract<OverlayCommand, { cmd: "orb.fly" }>;
  assert.equal(fly.thread, id, "tagged with the thread");
  assert.equal((h.overlays.find((c) => c.cmd === "rect") as { thread?: string }).thread, undefined, "a shape is untagged");
  assert.deepEqual(h.table.get(id)!.at, { x: 100, y: 201 });
  await settle(60);
  assert.ok(h.events.some((e) => e.kind === "at" && (e as { x: number }).x === 100), "the coalesced `at` event reached the sink");
  assert.deepEqual(h.table.get(id)!.apps, ["Spotify"], "the Apple event's app; a web fetch is no app");
  assert.equal(h.table.get(id)!.app, "Spotify");
  const list = h.spawned();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, id);
  assert.equal(list[0]!.name, "Spotify");
  assert.equal(list[0]!.status, "acting", "the Apple event was an act");
  assert.equal(list[0]!.parentDelegationId, "dlg_parent");
  assert.equal(list[0]!.app, "Spotify");
  assert.equal(list[0]!.lane, "background");
  await h.scheduler.cancelAll("done");
  assert.equal(h.spawned()[0]!.status, "stopped");
  h.scheduler.dispose();
});

test("the task carries the memory block (bounded at 250 ms: a hanging hook leaves it out) and the composite look in notes[0] before the identity note; with eyes off no screenshot is taken", async () => {
  let hang = false;
  const memory = (q: string, signal: AbortSignal): Promise<string | undefined> => (hang ? new Promise((r) => signal.addEventListener("abort", () => r(undefined))) : Promise.resolve(`Kevin prefers Focus (asked: ${q.slice(0, 20)})`));
  const h = harness({ memory, look: async () => "now: Spotify in front; playlist Focus selected" });
  h.script = async () => ({ status: "done", summary: "ok." });
  h.start("Spotify");
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const task = h.byName("Spotify")!.tasks[0]!;
  assert.match(task.memory ?? "", /^Kevin prefers Focus/);
  assert.equal(task.notes?.[0], "now: Spotify in front; playlist Focus selected");
  assert.match(task.notes?.[1] ?? "", /^you are Jarhead's thread Spotify; your job: Spotify's job$/);
  assert.equal(task.kevinDialogue, h.parent.kevinDialogue);
  assert.doesNotMatch(task.kevinDialogue ?? "", /prefers Focus/, "never inside kevinDialogue");
  hang = true;
  const t0 = Date.now();
  h.start("Slack");
  await until(() => h.byName("Slack")?.tasks.length === 1);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(h.byName("Slack")!.tasks[0]!.memory, undefined, "bounded: the task went without it");
  const blind = harness({ eyes: false });
  blind.script = async () => ({ status: "done", summary: "ok." });
  blind.start("Mail");
  await until(() => blind.byName("Mail")?.tasks.length === 1);
  assert.equal(blind.byName("Mail")!.tasks[0]!.attachments, undefined);
  assert.equal(blind.handsBg.named("screenshot").length, 0);
  h.scheduler.dispose();
  blind.scheduler.dispose();
});

test("idle end: a thread waiting on a yes nobody gives, or paused, for THREAD_IDLE_END_MS ends done 'idle' at the tick and its lane returns; drain resolves when the parent's threads end; running(parentId) counts one parent's", async () => {
  const h = harness();
  h.script = async (job) => {
    const r = (await job.runner.run("click_element", { name: "Send" })).result;
    return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
  };
  h.start("Slack", "send it", "screen");
  await until(() => h.spawned()[0]?.status === "waiting-kevin");
  const other: ThreadParent = { ...h.parent, id: "dlg_other" };
  h.script = async () => undefined;
  h.scheduler.start(other, { name: "Mail", task: "read the inbox", lane: "background" });
  await until(() => h.byName("Mail") !== undefined);
  assert.equal(h.scheduler.running(), 2);
  assert.equal(h.scheduler.running("dlg_parent"), 1);
  assert.equal(h.scheduler.running("dlg_other"), 1);
  let drained = false;
  void h.scheduler.drain("dlg_parent", new AbortController().signal).then(() => (drained = true));
  const slack = (): Thread => h.spawned().find((t) => t.name === "Slack")!;
  h.clock.t += THREAD_IDLE_END_MS - 1;
  h.scheduler.tick();
  assert.equal(slack().status, "waiting-kevin", "not yet");
  h.clock.t += 1;
  h.scheduler.tick();
  assert.equal(slack().status, "done");
  assert.equal(slack().detail, "idle");
  assert.equal(h.byName("Slack")!.stops, 1, "its lane returned");
  assert.equal(h.desk.floor, undefined, "its question went with it");
  await until(() => drained);
  assert.equal(h.scheduler.running("dlg_parent"), 0);
  assert.equal(h.scheduler.running("dlg_other"), 1, "the other parent's thread is untouched");
  const cut = new AbortController();
  const waitOther = h.scheduler.drain("dlg_other", cut.signal);
  cut.abort();
  await waitOther;
  await h.scheduler.stopAll();
  h.scheduler.dispose();
});

test("stopAll (sleep) stops every thread and every spare, flushes the coalescer, and the next warm() boots again; the summaries say who lingers", async () => {
  const h = harness({ spares: 1 });
  h.scheduler.warm();
  await settle(5);
  assert.equal(h.scheduler.pool.warmCount, 1);
  h.script = async () => undefined;
  h.start("Spotify");
  await until(() => h.byName("Spotify") !== undefined);
  await until(() => h.scheduler.spareIds.length === 1);
  const spare = h.brains.find((b) => h.scheduler.spareIds.includes(b.id))!;
  await h.scheduler.stopAll();
  assert.equal(h.scheduler.running(), 0);
  assert.equal(h.byName("Spotify")!.stops, 1);
  assert.equal(spare.stops, 1, "the spare's process ended too");
  assert.equal(h.scheduler.spareIds.length, 0);
  assert.equal(h.events[h.events.length - 1]!.kind, "ended");
  assert.equal(h.spawned().length, 1, "the finished thread lingers in the summaries");
  h.clock.t += 30_001;
  assert.equal(h.spawned().length, 0);
  assert.equal(h.scheduler.warm(), 1, "a new wake warms again");
  await h.scheduler.stopAll();
  h.scheduler.dispose();
});

test("a screen thread waits for the lease while a priority holder acts and takes it once the holder let go for LEASE_IDLE_MS; the wait writes one thread.status row and the record's `waits` count", async () => {
  const h = harness();
  const got = await h.lease.acquire("jarhead", { priority: true });
  assert.ok(got.ok);
  let result: string | undefined;
  h.script = async (job) => {
    result = (await job.runner.run("key", { text: "space" })).result.kind;
    return { status: "done", summary: "pressed." };
  };
  h.start("Slack", "press play", "screen");
  await until(() => h.spawned()[0]?.status === "waiting-screen");
  assert.equal(result, undefined);
  assert.match(h.spawned()[0]!.detail ?? "", /^waiting for the screen: Jarhead's hands have the screen/);
  h.clock.t += LEASE_IDLE_MS;
  await until(() => result !== undefined, 2000);
  assert.equal(result, "text");
  assert.equal(h.hands.named("key").length, 1);
  await until(() => h.spawned()[0]?.status === "done");
  assert.equal(h.spawned()[0]!.waits, 0, "a wait that ended in the screen is not a strike");
  assert.equal(h.rows("thread.status").filter((r) => r.status === "waiting-screen").length, 1);
  h.scheduler.dispose();
});

// ------------------------------------------------------------- the repairs
// What the review found: a sleep that left spares behind, a follow-up that left a
// question armable, a follow-up during the boot that ran two turns on one brain, a
// brain that never let go, the wrong verb on a Deny.

test("sleep leaves 0 processes when a brain's stop() takes real time: the pool closes before the cancel, the releases are awaited, no spare boots behind stopAll — not from a release, not from the tick — until the wake's warm() opens the pool again", async () => {
  const h = harness({ spares: 2, stopDelayMs: 30 });
  h.script = async () => undefined;
  assert.equal(h.scheduler.warm(), 2);
  await settle(5);
  assert.equal(h.scheduler.pool.warmCount, 2);
  h.start("Spotify");
  await until(() => h.byName("Spotify") !== undefined && h.scheduler.spareIds.length === 2, 1000);
  const boots = h.scheduler.pool.boots;
  assert.equal(boots, 3, "two spares and the top-up after the take");
  const t0 = Date.now();
  await h.scheduler.stopAll();
  assert.ok(Date.now() - t0 >= 30, "the thread's slow stop was awaited, not fired and forgotten");
  assert.equal(h.scheduler.running(), 0);
  assert.equal(h.scheduler.spareIds.length, 0);
  assert.ok(h.scheduler.pool.isClosed);
  assert.equal(h.brains.length, 3, "no brain was built by the sleep");
  assert.ok(h.brains.every((b) => b.stops === 1), `every process ended once: ${JSON.stringify(h.brains.map((b) => b.stops))}`);
  // Nothing wakes behind it: a release's tail, the tick, a microtask top-up.
  await settle(120);
  h.scheduler.tick();
  await settle(20);
  assert.equal(h.scheduler.pool.boots, boots, "0 boots after stopAll");
  assert.equal(h.scheduler.spareIds.length, 0);
  assert.equal(h.brains.length, 3);
  assert.equal(h.scheduler.pool.topUp(), 0, "a top-up while closed is 0");
  // The wake path opens the pool.
  assert.equal(h.scheduler.warm(), 2);
  assert.ok(!h.scheduler.pool.isClosed);
  assert.equal(h.scheduler.pool.boots, boots + 2);
  await h.scheduler.stopAll();
  assert.equal(h.scheduler.spareIds.length, 0);
  h.scheduler.dispose();
});

test("a follow-up on a thread waiting on Kevin takes its question off the floor before the next turn: nothing is armable, floorThread is undefined, and the question queued behind it is promoted and spoken", async () => {
  const h = harness();
  const clicks: string[] = [];
  h.script = async (job) => {
    if (job.task.request === "send it to Alice instead") {
      // The follow-up turn: a matching action must ASK again, never land on a stale yes.
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      clicks.push(r.kind);
      return undefined;
    }
    const r = (await job.runner.run("click_element", { name: "Send" })).result;
    return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
  };
  h.start("Slack", "send it to Ben", "screen");
  await until(() => h.spawned()[0]?.status === "waiting-kevin");
  const slackId = h.spawned()[0]!.id;
  h.start("Spotify", "clear the queue", "screen");
  await until(() => h.spawned().find((t) => t.name === "Spotify")?.status === "waiting-kevin");
  const spotifyId = h.spawned().find((t) => t.name === "Spotify")!.id;
  assert.equal(h.desk.floor?.laneId, slackId);
  assert.equal(h.desk.queuedCount, 1);
  assert.deepEqual(h.scheduler.floorThread(), { id: slackId, name: "Slack" });
  const says = h.voice.says.length;
  assert.equal(await h.scheduler.followUp(slackId, "send it to Alice instead"), true);
  assert.notEqual(h.desk.floor?.laneId, slackId, "Slack's question left the floor with the turn that asked it");
  assert.equal(h.scheduler.floorThread()?.id, spotifyId, "the queued question came up");
  assert.equal(h.desk.floor?.laneId, spotifyId);
  assert.equal(h.voice.says.length, says + 1);
  assert.match(h.voice.says[says]!, /^Spotify asks: /);
  assert.equal(h.table.get(slackId)!.question, undefined, "the record forgot the question");
  assert.equal(h.table.get(slackId)!.status, "thinking");
  // Kevin's "yes" now answers Spotify, never Slack's abandoned question: Slack's re-asked click must queue, not land.
  await until(() => clicks.length === 1);
  assert.equal(clicks[0], "needs-confirmation", "Slack asked again (queued behind Spotify's); no click landed");
  assert.equal(h.hands.named("click").length, 0);
  // With no queue behind it the floor is simply free.
  const lone = harness();
  lone.script = async (job) => {
    const r = (await job.runner.run("click_element", { name: "Send" })).result;
    return r.kind === "needs-confirmation" ? undefined : { status: "done", summary: "sent." };
  };
  lone.start("Mail", "send it", "screen");
  await until(() => lone.spawned()[0]?.status === "waiting-kevin");
  await lone.scheduler.followUp(lone.spawned()[0]!.id, "never mind, archive it");
  assert.equal(lone.desk.floor, undefined);
  assert.equal(lone.root.pending, undefined);
  assert.equal(lone.root.arm(), undefined, "nothing to arm: a later yes lands on no action");
  assert.equal(lone.scheduler.floorThread(), undefined);
  await h.scheduler.cancelAll("done");
  await lone.scheduler.cancelAll("done");
  h.scheduler.dispose();
  lone.scheduler.dispose();
});

test("a follow-up while the brain still boots becomes its first turn — exactly one handle() on one brain; a pause while it boots leaves it paused with no turn once the boot answers, resume runs the one turn; a follow-up undoes a boot-time pause", async () => {
  const h = harness();
  const boots = new Map<string, (r: { ready: boolean; detail: string }) => void>();
  h.startResult = (brain) => new Promise((r) => boots.set(brain.id, r));
  h.script = async () => undefined;
  // Follow-up during the boot.
  h.start("Spotify", "play Focus");
  await until(() => boots.size === 1);
  const spotifyId = h.spawned()[0]!.id;
  assert.equal(h.table.get(spotifyId)!.status, "starting");
  assert.equal(await h.scheduler.followUp(spotifyId, "skip this song"), true);
  assert.equal(h.table.get(spotifyId)!.status, "starting", "still booting");
  boots.get(spotifyId)!({ ready: true, detail: "up" });
  await until(() => h.byName("Spotify") !== undefined);
  await settle(40);
  const fb = h.byName("Spotify")!;
  assert.equal(fb.tasks.length, 1, "ONE handle: the follow-up is the first turn, the first task never ran beside it");
  assert.equal(fb.tasks[0]!.request, "skip this song");
  assert.match(fb.tasks[0]!.dialogue, /^Jarhead \(to its thread Spotify\)[\s\S]*Kevin \(to Spotify\): skip this song$/, "its dialogue carries the brief and the words");
  assert.equal(fb.cancels, 0, "nothing to supersede");
  assert.equal(h.scheduler.turnsOf(spotifyId).length, 1);
  assert.equal(h.scheduler.turnsOf(spotifyId)[0]!.status, "running");
  assert.equal(h.table.get(spotifyId)!.turns, 1);
  assert.ok(busy(h.table.get(spotifyId)));

  // Pause during the boot: paused once the boot answers, no turn; resume runs the one turn.
  h.start("Slack", "tell Ben", "screen");
  await until(() => boots.size === 2);
  const slackId = h.spawned().find((t) => t.name === "Slack")!.id;
  assert.equal(await h.scheduler.pause(slackId), true);
  assert.equal(h.table.get(slackId)!.status, "paused");
  boots.get(slackId)!({ ready: true, detail: "up" });
  await settle(40);
  assert.equal(h.table.get(slackId)!.status, "paused", "the boot's end found it paused and ran nothing");
  assert.equal(h.brains.filter((b) => b.tasks.length > 0).length, 1, "no handle for Slack");
  assert.deepEqual(h.rows("thread.status").filter((r) => r.threadId === slackId).map((r) => r.status), ["paused"]);
  await h.scheduler.resume(slackId);
  await until(() => h.byName("Slack")?.tasks.length === 1);
  assert.equal(h.byName("Slack")!.tasks[0]!.request, h.parent.request, "the first task, once");
  assert.equal(h.scheduler.turnsOf(slackId).length, 1);

  // Pause during the boot, then a follow-up: the words undo the pause and run once the boot answers.
  h.start("Mail", "read the inbox");
  await until(() => boots.size === 3);
  const mailId = h.spawned().find((t) => t.name === "Mail")!.id;
  await h.scheduler.pause(mailId);
  assert.equal(h.table.get(mailId)!.status, "paused");
  assert.equal(await h.scheduler.followUp(mailId, "only the unread ones"), true);
  assert.equal(h.table.get(mailId)!.status, "starting", "the words undo the pause");
  boots.get(mailId)!({ ready: true, detail: "up" });
  await until(() => h.byName("Mail")?.tasks.length === 1);
  assert.equal(h.byName("Mail")!.tasks[0]!.request, "only the unread ones");
  // A resume while the brain boots (paused, not booted) goes back to starting and runs the first task at the boot.
  await h.scheduler.stop(spotifyId); // three spawned threads is the cap, main registered or not
  assert.equal(h.start("Notes", "read the notes").kind, "text");
  await until(() => boots.size === 4);
  const notesId = h.spawned().find((t) => t.name === "Notes")!.id;
  await h.scheduler.pause(notesId);
  await h.scheduler.resume(notesId);
  assert.equal(h.table.get(notesId)!.status, "starting");
  boots.get(notesId)!({ ready: true, detail: "up" });
  await until(() => h.byName("Notes")?.tasks.length === 1);
  assert.equal(h.byName("Notes")!.tasks[0]!.request, h.parent.request);
  await h.scheduler.cancelAll("done");
  h.scheduler.dispose();
});

test("a brain that never lets go after cancel(): a follow-up resolves within the supersede bound, the record closes cancelled and the next turn runs; the late return finds the turn closed and ends nothing, and the next turn's seconds budget still holds", async () => {
  const h = harness({ deaf: true, supersedeWaitMs: 60 });
  h.script = async () => undefined;
  h.start("Spotify", "play Focus", "background", { seconds: 10 });
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const id = h.spawned()[0]!.id;
  const fb = h.byName("Spotify")!;
  const first = fb.resolve!; // the first turn's resolver: the brain is deaf to the abort, so only this ends it
  const t0 = Date.now();
  assert.equal(await h.scheduler.followUp(id, "skip this song"), true);
  const took = Date.now() - t0;
  assert.ok(took >= 60 && took < 1000, `bounded: ${took} ms`);
  assert.equal(fb.cancels, 1, "cancel() was called once");
  await until(() => fb.tasks.length === 2);
  assert.equal(h.scheduler.turnsOf(id)[0]!.status, "cancelled", "the record closed without the brain");
  assert.equal(h.scheduler.turnsOf(id)[1]!.status, "running");
  assert.ok(busy(h.table.get(id)));
  // The first turn's handle returns late: the job lives on, the second turn is untouched.
  first({ status: "done", summary: "late." });
  await settle(20);
  assert.ok(busy(h.table.get(id)), "the late return ended nothing");
  assert.equal(h.scheduler.turnsOf(id)[1]!.status, "running");
  assert.equal(h.scheduler.running(), 1);
  // The second turn's seconds budget still stands (the late return cleared nothing of the new turn's): at its next step past the cap it fails.
  assert.equal(fb.runner.attached, true, "the second turn's runner is still attached: the late return let go of its own turn only");
  h.clock.t += 11_000;
  await fb.runner.run("frontmost_app", {});
  await until(() => h.table.get(id)?.status === "failed");
  assert.equal(h.table.get(id)!.detail, "I ran out of time after 10 seconds");
  h.scheduler.dispose();
});

test("answerNo on a live thread that is not waiting drops only its question and keeps its lane: the thread stays live and its next question still reaches the floor under its name; on a finished thread it is false", async () => {
  const h = harness();
  const asks = { n: 0 };
  h.script = async (job) => {
    const first = (await job.runner.run("frontmost_app", {})).result;
    assert.equal(first.kind, "text");
    await until(() => asks.n > 0, 1000);
    const r = (await job.runner.run("click_element", { name: "Send" })).result;
    return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
  };
  h.start("Slack", "send it", "screen");
  await until(() => h.byName("Slack") !== undefined && h.table.get(h.spawned()[0]!.id)?.steps === 1);
  const id = h.spawned()[0]!.id;
  assert.ok(busy(h.table.get(id)));
  assert.equal(await h.scheduler.answerNo(id), true, "nothing to deny, nothing to stop: the lane keeps working");
  assert.ok(busy(h.table.get(id)), "still live");
  assert.equal(h.byName("Slack")!.stops, 0);
  asks.n++;
  await until(() => h.table.get(id)?.status === "waiting-kevin");
  assert.equal(h.desk.floor?.laneId, id);
  assert.equal(h.desk.floor?.name, "Slack", "the lane kept its name");
  assert.match(h.voice.says[h.voice.says.length - 1]!, /^Slack asks: /);
  assert.equal(await h.scheduler.answerNo(id), true);
  await until(() => h.table.get(id)?.status === "stopped");
  assert.equal(await h.scheduler.answerNo(id), false, "finished");
  h.scheduler.dispose();
});

test("the user's name: the lines a thread's brain reads say the name — thread_start's refusal, the brief's gate line, a pause's detail and continuation, a stop's detail and thread_wait's told line; for another name no literal Kevin and the same words otherwise", async () => {
  const lines: Record<"Kevin" | "Sam", string[]> = { Kevin: [], Sam: [] };
  for (const who of ["Kevin", "Sam"] as const) {
    const h = harness(who === "Sam" ? { userName: "Sam" } : {});
    h.script = async () => undefined;
    const task = { delegationId: "item_1", request: h.parent.request, dialogue: "", confirmation: false, offsetMs: 0, signal: new AbortController().signal };
    const out = lines[who];
    out.push(text(await h.scheduler.tool("thread_start", { name: "", task: "play Focus" }, { task })));
    const started = await h.scheduler.tool("thread_start", { name: "Spotify", task: "play Focus", lane: "background" }, { task });
    assert.equal(started.kind, "text", text(started));
    await until(() => h.byName("Spotify")?.tasks.length === 1);
    const fb = h.byName("Spotify")!;
    const id = h.spawned()[0]!.id;
    out.push(fb.tasks[0]!.dialogue);
    assert.equal(await h.scheduler.pause(id), true);
    out.push(h.table.get(id)!.detail ?? "");
    await h.scheduler.resume(id);
    await until(() => fb.tasks.length === 2);
    out.push(fb.tasks[1]!.dialogue);
    const waiting = h.scheduler.tool("thread_wait", { name: "Spotify", timeout: 5 }, { task });
    await settle(20);
    assert.equal(await h.scheduler.stopNamed("Spotify"), true);
    out.push(text(await waiting));
    out.push(h.table.get(id)!.detail ?? "");
    h.scheduler.dispose();
  }
  // The defaults, as the older pins read them.
  assert.equal(lines.Kevin[0], "thread_start needs a name Kevin will hear (one word, usually the app)");
  assert.match(lines.Kevin[1]!, /Kevin's own words, for names and gates: "tell ben on slack/);
  assert.equal(lines.Kevin[2], "Kevin paused it");
  assert.match(lines.Kevin[3]!, /Kevin paused you at step 0; carry on from where you were\.$/);
  assert.match(lines.Kevin[4]!, /^Spotify: stopped — Kevin stopped it \(Kevin was told: "Spotify stopped\."\)/);
  assert.equal(lines.Kevin[5], "Kevin stopped it");
  // Another name: the same six lines, the name in every one, no literal Kevin anywhere.
  assert.equal(lines.Sam.length, lines.Kevin.length);
  for (let i = 0; i < lines.Sam.length; i++) {
    assert.doesNotMatch(lines.Sam[i]!, /Kevin/, lines.Sam[i]);
    assert.match(lines.Sam[i]!, /Sam/, lines.Sam[i]);
    assert.equal(lines.Sam[i]!.replaceAll("Sam", "Kevin"), lines.Kevin[i]!, `line ${i} reads the same for another name`);
  }
  // The pure texts, and the default constant the older imports read.
  assert.equal(CONFIRMATION_RESUME, confirmationResume("Kevin"));
  assert.equal(confirmationResume("Sam"), "\n\nJarhead (to its thread): Sam said yes. Call the same tool again with exactly the same arguments, then finish your job.");
  assert.equal(resumeText(3), resumeText(3, "Kevin"));
  assert.equal(resumeText(3, "Sam"), "\n\nJarhead (to its thread): Sam paused you at step 3; carry on from where you were.");
  const brief = threadBrief("Spotify", "play Focus", "background", "play focus", "Sam");
  assert.doesNotMatch(brief, /Kevin/);
  assert.equal(brief.replaceAll("Sam", "Kevin"), threadBrief("Spotify", "play Focus", "background", "play focus"));
});
