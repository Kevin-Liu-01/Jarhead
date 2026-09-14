import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAIN_THREAD_ID,
  THREADS_MAX,
  THREAD_LINGER_MS,
  THREAD_MAX_LIVE,
  THREAD_NAME_CHARS,
  THREAD_PAGE,
  THREAD_SPAWN_DEPTH,
  THREAD_STATUSES,
  THREAD_TERMINAL,
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
  grantOf,
  isEngineCommand,
  type Permissions,
  type Settings,
  type Thread,
  type ThreadEvent,
  type ThreadStatus,
} from "../index.ts";

// Pins on the threads contract: the eight commands the daemon accepts, the shape of the
// status vocabulary, and what a thread costs on the wire at the bounds the record
// documents (task ≤ 200, detail ≤ 200, question ≤ 160, name ≤ 16, apps ≤ 4). The
// snapshot carries ≤ THREADS_MAX of these on every emit, so a field that grows here
// grows every client's bytes; the numbers below are measured, not estimated.

const THREAD_COMMANDS = ["thread.open", "thread.close", "thread.history", "thread.stop", "thread.pause", "thread.resume", "thread.answer", "thread.say"] as const;

test("isEngineCommand accepts exactly the eight thread.* commands; the verbs of before 2026-09-13 (worker.stop, wake) are not commands; a brain tool name or a stray thread.* verb is not a command", () => {
  for (const type of THREAD_COMMANDS) assert.ok(isEngineCommand({ type, threadId: "t_1" }), `${type} is a surface command`);
  assert.equal(THREAD_COMMANDS.length, 8);
  assert.equal(isEngineCommand({ type: "worker.stop", workerId: "w_1" }), false, "the verb of before 2026-09-13; thread.stop is the command");
  assert.equal(isEngineCommand({ type: "wake" }), false, "the verb of before 2026-09-13; `go` wakes");
  assert.ok(isEngineCommand({ type: "go" }));
  assert.ok(isEngineCommand({ type: "sleep", cause: "command" }));
  for (const type of ["thread_start", "thread_stop", "thread_wait", "thread_read", "thread.nonsense", "thread", "threads.open"]) {
    assert.equal(isEngineCommand({ type }), false, `${type} is refused`);
  }
  assert.equal(isEngineCommand("thread.stop"), false, "a bare string is not a command");
  assert.equal(isEngineCommand(null), false);
});

test("SETTINGS_KEYS names every key of Settings once, DEFAULT_SETTINGS has a value for each, and nothing else", () => {
  const defaults = DEFAULT_SETTINGS as Settings;
  assert.equal(new Set(SETTINGS_KEYS).size, SETTINGS_KEYS.length, "no key twice");
  const inDefaults = Object.keys(defaults).sort();
  const required = SETTINGS_KEYS.filter((k) => defaults[k] !== undefined).sort();
  assert.deepEqual(inDefaults, required, "every key with a default is listed and every listed key with a value has a default");
  for (const k of inDefaults) assert.ok((SETTINGS_KEYS as readonly string[]).includes(k), `${k} is a listed key`);
  for (const retired of ["workers", "replayFinish"]) assert.equal((SETTINGS_KEYS as readonly string[]).includes(retired), false, `${retired} (a settings.json key from before 2026-09-13) is not a setting`);
});

test("grantOf reads the row for a kind and answers unknown when the app has not read it yet", () => {
  const none: Permissions = { all: [] };
  assert.equal(grantOf(none, "microphone"), "unknown");
  const some: Permissions = { all: [
    { kind: "microphone", grant: "granted", ask: "prompt", required: true, label: "Microphone", why: "" },
    { kind: "screenRecording", grant: "denied", ask: "settings", required: true, label: "Screen Recording", why: "" },
  ] };
  assert.equal(grantOf(some, "microphone"), "granted");
  assert.equal(grantOf(some, "screenRecording"), "denied");
  assert.equal(grantOf(some, "accessibility"), "unknown");
});

test("THREAD_TERMINAL is exactly done / failed / stopped; every status is either terminal or live; idle is a status (main between turns)", () => {
  assert.deepEqual([...THREAD_TERMINAL].sort(), ["done", "failed", "stopped"]);
  for (const s of THREAD_TERMINAL) assert.ok((THREAD_STATUSES as readonly string[]).includes(s), `${s} is in the vocabulary`);
  const live = THREAD_STATUSES.filter((s) => !THREAD_TERMINAL.has(s));
  assert.deepEqual(live, ["idle", "queued", "starting", "thinking", "acting", "waiting-screen", "waiting-kevin", "paused"]);
  assert.equal(THREAD_STATUSES.length, 11);
  assert.equal(new Set(THREAD_STATUSES).size, THREAD_STATUSES.length, "no status twice");
});

test("the constants the surfaces size themselves by", () => {
  assert.equal(MAIN_THREAD_ID, "main");
  assert.equal(THREAD_MAX_LIVE, 4, "main + 3 spawned");
  assert.equal(THREAD_SPAWN_DEPTH, 1, "a spawned thread never spawns");
  assert.equal(THREAD_NAME_CHARS, 16);
  assert.equal(THREAD_LINGER_MS, 30_000, "the snapshot's linger; the Console keeps finished threads longer from events");
  assert.equal(THREADS_MAX, 16);
  assert.equal(THREAD_PAGE, 60);
});

// ----------------------------------------------------------------- bytes on the wire

const chars = (n: number, c = "x"): string => c.repeat(n);
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// Ids as the engine mints them (core's newId: `<prefix>_<base36 ms><6 random>`): a thread id is 16
// chars, a delegation id 17. Shorter ids in a pin understate every record by ~6 B per id — the first
// version of these pins did, and read 950 B where the wire carries 968.
const T36 = (1_789_243_208_790).toString(36); // 8 chars today (and until 2038)
const threadId = (six: string): string => `t_${T36}${six}`;
const delegationId = (six: string): string => `dl_${T36}${six}`;
const TID = threadId("k3q9zx");
const PARENT_DL = delegationId("a1b2c3");
const CURRENT_DL = delegationId("d4e5f6");
/** Live's call id on the record ("call_" + 24). */
const LIVE_ID = `call_${chars(24, "K")}`;

/** A spawned thread at the record's documented bounds (task ≤ 200, detail ≤ 200, question ≤ 160, name 16), every field a real record carries at that moment. */
function threadAtBounds(id: string, status: ThreadStatus, opts: { question?: boolean; pointers?: boolean; detail?: number } = {}): Thread {
  const finished = THREAD_TERMINAL.has(status);
  return {
    id,
    name: chars(THREAD_NAME_CHARS, "n"),
    lane: "screen",
    status,
    parentId: MAIN_THREAD_ID,
    parentDelegationId: PARENT_DL,
    task: chars(200),
    detail: chars(opts.detail ?? 200),
    apps: ["Slack"],
    app: "Slack",
    startedAt: 1_789_243_208_790,
    updatedAt: 1_789_243_218_790,
    ...(finished ? { doneAt: 1_789_243_228_790 } : { currentDelegationId: CURRENT_DL }),
    turns: 3,
    steps: 17,
    waits: 2,
    budget: { steps: 40, seconds: 300 },
    ...(opts.question ? { question: chars(160, "q") } : {}),
    ...(opts.pointers ? { liveId: LIVE_ID, at: { x: 1234.5, y: 678.25 }, lastScreenshotPath: `shots/2026-09-13/1789243218790-${id}.png` } : {}),
    canSay: !finished,
    canStop: !finished,
  };
}

const mainThread: Thread = { id: MAIN_THREAD_ID, name: "Jarhead", lane: "voice", status: "thinking", task: "", apps: [], startedAt: 1_789_243_200_000, updatedAt: 1_789_243_218_790, turns: 12, steps: 88, waits: 0, budget: { steps: 0, seconds: 0 }, canSay: true, canStop: true };

test("a Thread with a 160-char question and 200-char task and detail serialises under 1 KB (968 B measured; 1 113 B with liveId, at and a screenshot path)", () => {
  const asked = threadAtBounds(TID, "waiting-kevin", { question: true });
  const n = bytes(asked);
  assert.ok(n < 1024, `a bounded thread with a question is ${n} B`);
  const withPointers = bytes(threadAtBounds(TID, "waiting-kevin", { question: true, pointers: true }));
  assert.ok(withPointers < 1200, `with every optional pointer it is ${withPointers} B`);
  const finished = bytes(threadAtBounds(TID, "done"));
  assert.ok(finished < 800, `a finished thread (no question, no current delegation) is ${finished} B`);
});

test("the acceptance's '< 900 B per Thread' needs Thread.detail ≤ 120 at the other bounds (888 B); the committed ≤ 200 gives 968 B and ≤ 140 still 908 B — the contract's call, measured here so the pin moves with it", () => {
  // The design estimated 900 B; the record's own bounds put it at 968 B with real ids. What
  // meets the estimate is a tighter `detail` (the last tool + outcome line — 120 chars is a
  // sentence), not a shorter task or question, which the voice and the pane read whole.
  const at = (detail: number): number => bytes(threadAtBounds(TID, "waiting-kevin", { question: true, detail }));
  assert.ok(at(120) < 900, `detail ≤ 120 → ${at(120)} B`);
  assert.ok(at(140) >= 900, `detail ≤ 140 is not enough with 16/17-char ids: ${at(140)} B`);
  assert.ok(at(200) >= 900, `the committed bound is over the estimate: ${at(200)} B`);
});

test("sixteen threads (THREADS_MAX: four live with questions, twelve lingering) at the committed bounds stay under 13 KB in a snapshot (13 105 B); under 12 KB with detail ≤ 120 (11 825 B); main + 3 working threads add under 3 KB (2 597 B)", () => {
  const sixteen = (detail: number): number => {
    const live = [0, 1, 2, 3].map((i) => threadAtBounds(threadId(`liv${i}00`), "waiting-kevin", { question: true, detail }));
    const lingering = Array.from({ length: THREADS_MAX - live.length }, (_, i) => threadAtBounds(threadId(`don${String(i).padStart(3, "0")}`), "done", { detail }));
    assert.equal(live.length + lingering.length, THREADS_MAX);
    return bytes([...live, ...lingering]);
  };
  assert.ok(sixteen(200) < 13 * 1024, `sixteen threads at the committed bounds are ${sixteen(200)} B`);
  assert.ok(sixteen(120) < 12 * 1024, `the acceptance's 12 KB holds with detail ≤ 120: ${sixteen(120)} B`);
  // The acceptance for a working day: main + three spawned threads acting, no questions.
  const working = [1, 2, 3].map((i) => threadAtBounds(threadId(`wrk${i}00`), "acting"));
  const growth = bytes([mainThread, ...working]);
  assert.ok(growth <= 3 * 1024, `snapshot.threads with main + 3 working threads is ${growth} B`);
});

// The contract comment promises "≤ 200 B on the wire" per thread.event. It holds for the
// fixed-shape kinds and for the text-carrying kinds only when the EVENT caps its text: the
// full detail / request / question stay on the Thread record and the thread.transcript page,
// the event carries a head of it. These are the caps the table (B2) applies when it emits.
const EVENT_TEXT_CAPS = { statusDetail: 80, turnRequest: 70, question: 100, endedSummary: 80, saidText: 110 } as const;

test("every thread.event kind but `started` fits 200 B when the event caps its text (status.detail ≤ 80, turn.request ≤ 70, question ≤ 100, ended.summary ≤ 80, said ≤ 110); at the record's own bounds status / turn / question do not (315 / 243 / 253 B); started carries the whole record", () => {
  const base = { seq: 4096, at: 1_789_243_218_790, threadId: TID };
  const capped: ThreadEvent[] = [
    { ...base, kind: "status", status: "waiting-screen", detail: chars(EVENT_TEXT_CAPS.statusDetail) },
    { ...base, kind: "step", steps: 40, tool: "browser_navigate", ok: true },
    { ...base, kind: "at", x: 1234.5, y: 678.25, app: "Calendar" },
    { ...base, kind: "turn", delegationId: CURRENT_DL, request: chars(EVENT_TEXT_CAPS.turnRequest) },
    { ...base, kind: "question", question: chars(EVENT_TEXT_CAPS.question) },
    { ...base, kind: "said", text: chars(EVENT_TEXT_CAPS.saidText) },
    { ...base, kind: "ended", status: "stopped", summary: chars(EVENT_TEXT_CAPS.endedSummary) },
  ];
  for (const e of capped) assert.ok(bytes(e) <= 200, `${e.kind} event at its cap is ${bytes(e)} B`);
  // One more character of text at each cap and the event is over — the caps are the edge, not a guess.
  assert.ok(bytes({ ...base, kind: "turn", delegationId: CURRENT_DL, request: chars(80) }) > 200, "turn at 80 chars is over (the earlier '≤ 90' seam was measured with a 10-char id)");
  assert.ok(bytes({ ...base, kind: "question", question: chars(110) }) > 200, "question at 110 chars is over");
  assert.ok(bytes({ ...base, kind: "status", status: "waiting-screen", detail: chars(90) }) > 200, "status detail at 90 chars is over");
  // The record's own bounds in an event: what happens without the cap.
  const uncapped: ThreadEvent[] = [
    { ...base, kind: "status", status: "waiting-screen", detail: chars(200) },
    { ...base, kind: "turn", delegationId: CURRENT_DL, request: chars(120) },
    { ...base, kind: "question", question: chars(160) },
  ];
  for (const e of uncapped) assert.ok(bytes(e) > 200 && bytes(e) < 320, `${e.kind} at the record's bound is ${bytes(e)} B — the table must cap it`);
  const started: ThreadEvent = { ...base, kind: "started", thread: threadAtBounds(TID, "starting") };
  assert.ok(bytes(started) > 200 && bytes(started) < 1024, `started is one record: ${bytes(started)} B`);
  // A step event as the daemon frames it: header included, well inside the budget.
  assert.ok(5 + bytes({ type: "thread.event", event: capped[1] }) <= 200, "a step frame with its 5-byte header fits");
});
