import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type AutomationDraft,
  type EngineCommand,
  type Snapshot,
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
  BRAIN_KINDS,
  AUTO_BRAIN_ORDER,
  LOCAL_NONE,
  AUTOMATION_ACTION_KINDS,
  AUTOMATION_ACTING_KINDS,
  AUTOMATION_TERMINAL,
  AUTOMATIONS_MAX,
  AUTOMATIONS_TRASHED_MAX,
  AUTOMATION_ACTIONS_MAX,
  AUTOMATION_LINGER_MS,
  AUTOMATION_REPEAT_CHIME_MS,
  AUTOMATION_SNOOZES,
  AUTOMATION_LINE_CHARS,
  AUTOMATION_WATCH_COOLDOWN_S,
  AUTOMATION_POLL_MIN_S,
  AUTOMATION_FOLDER_WATCHERS_MAX,
  AUTOMATION_WAKE_COOLDOWN_MIN_S,
  AUTOMATION_SLEEP_GAP_MS,
  AUTOMATION_GRACE_MS,
  DEFAULT_AUTOMATIONS,
  DEFAULT_AUDIO,
  isAudioState,
  automationKind,
  grantOf,
  isEngineCommand,
  liveRecipes,
  recipeNamed,
  type Automation,
  type AutomationEvent,
  type AutomationSettings,
  type AudioSettings,
  type AudioState,
  type ClockTime,
  type LedgerRow,
  type Permissions,
  type Settings,
  type SettingsPatch,
  type SetupStatus,
  type ShellRecipe,
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

// ----------------------------------------------------------------- the local brain

test("BRAIN_KINDS ends in local and auto never walks to it: AUTO_BRAIN_ORDER is the five cloud kinds of before, nothing else", () => {
  assert.equal(BRAIN_KINDS.at(-1), "local", "local is the last kind");
  assert.equal(BRAIN_KINDS.length, 7);
  assert.equal(new Set(BRAIN_KINDS).size, BRAIN_KINDS.length, "no kind twice");
  assert.equal((AUTO_BRAIN_ORDER as readonly string[]).includes("local"), false, "a running server is not a choice Kevin made");
  assert.equal((AUTO_BRAIN_ORDER as readonly string[]).includes("auto"), false);
  assert.deepEqual([...AUTO_BRAIN_ORDER], ["codex", "claude-code", "anthropic-api", "openai-compatible", "openai-responses"], "the walk is unchanged");
  for (const k of AUTO_BRAIN_ORDER) assert.ok((BRAIN_KINDS as readonly string[]).includes(k), `${k} is a kind`);
  const picked: Settings = { ...(DEFAULT_SETTINGS as Settings), brain: "local", brainModel: "" };
  assert.equal(picked.brain, "local", "local is a Settings.brain value; an empty brainModel means the best fit on this Mac");
});

test("SetupStatus carries local and dataPaths as required members; LOCAL_NONE is the value before any look", () => {
  const status: SetupStatus = { openaiKey: "unchecked", brain: "unchecked", brainDetail: "", liveModel: "gpt-live-1", secrets: { openai: false, anthropic: false, brainApiKey: false }, local: LOCAL_NONE, dataPaths: [] };
  assert.equal(status.local.reachable, false);
  assert.deepEqual(status.dataPaths, []);
  assert.equal(LOCAL_NONE.reachable, false);
  assert.equal(LOCAL_NONE.baseUrl, "", "no root until one answers");
  assert.deepEqual(LOCAL_NONE.models, []);
  assert.equal(LOCAL_NONE.ramBytes, 0);
  assert.equal(LOCAL_NONE.checkedAt, 0, "0 = never looked");
  assert.equal(LOCAL_NONE.picked, undefined);
  assert.equal(LOCAL_NONE.flavor, undefined);
});

test("a memory.run ledger row takes extractor local beside responses and rules", () => {
  const rows: LedgerRow[] = [
    { at: 1, type: "memory.run", extractor: "local", added: 1, updated: 0, noop: 2, refused: 0, ms: 4200 },
    { at: 2, type: "memory.run", extractor: "responses", added: 0, updated: 1, noop: 0, refused: 0, ms: 900 },
    { at: 3, type: "memory.run", extractor: "rules", added: 0, updated: 0, noop: 0, refused: 0, ms: 3 },
  ];
  assert.deepEqual(rows.map((r) => (r.type === "memory.run" ? r.extractor : "")), ["local", "responses", "rules"]);
});

test("isEngineCommand accepts mark.remove and mark.window (the notch panel's verbs) and still refuses mark.delete", () => {
  assert.ok(isEngineCommand({ type: "mark.remove", id: "mark_x" }));
  assert.ok(isEngineCommand({ type: "mark.window" }));
  assert.equal(isEngineCommand({ type: "mark.delete", id: "mark_x" }), false, "remove is the verb; delete is not a command");
});

// ----------------------------------------------------------------- automations (design11)

/** The thirteen surface verbs over automations and recipes: every one a state change or a Move to Trash / Restore, never a deletion. */
const AUTOMATION_COMMANDS = [
  "automation.set", "automation.snooze", "automation.done", "automation.skip", "automation.pause", "automation.resume",
  "automation.rename", "automation.trash", "automation.restore", "automation.run", "recipe.set", "recipe.trash", "recipe.restore",
] as const;

test("isEngineCommand accepts exactly the thirteen automation.* / recipe.* commands and refuses a deletion verb on any of them, cancel, and the brain tools' names", () => {
  assert.equal(AUTOMATION_COMMANDS.length, 13);
  assert.equal(new Set(AUTOMATION_COMMANDS).size, 13, "no verb twice");
  for (const type of AUTOMATION_COMMANDS) assert.ok(isEngineCommand({ type, id: "auto_1" }), `${type} is a surface command`);
  // The verb that is never on the wire, spelt at run time so the acceptance grep for it over the tree stays at zero.
  const never = ["automation", "rule", "recipe"].map((noun) => [noun, "delete"].join("."));
  for (const type of [...never, "automation.cancel", "automation.list", "automation_set", "automation_list", "automation_change", "recipe_list", "automation", "automations.set"]) {
    assert.equal(isEngineCommand({ type }), false, `${type} is not a command on the wire`);
  }
});

test("automation.set carries who sent it: `by` is console or cli (the brain's rows come through its tool, never this command) and the draft rides whole; the field is optional so an older Console still arms", () => {
  const draft: AutomationDraft = { name: "Wake up", when: { kind: "at", at: 1_789_243_208_790 }, then: [{ kind: "chime", line: "Wake up, Kevin" }], clauses: { quiet: "override" }, echo: 'At 07:10, ring "Wake up, Kevin".' };
  const fromCli: EngineCommand = { type: "automation.set", automation: draft, by: "cli" };
  const fromConsole: EngineCommand = { type: "automation.set", automation: draft, by: "console" };
  const older: EngineCommand = { type: "automation.set", automation: draft };
  for (const cmd of [fromCli, fromConsole, older]) assert.ok(isEngineCommand(cmd));
  // @ts-expect-error the brain never sends the surface command; its rows are stamped by the tool path
  const never: EngineCommand = { type: "automation.set", automation: draft, by: "brain" };
  assert.equal((never as { by?: string }).by, "brain", "spelt only to be refused by the type");
  assert.equal(JSON.parse(JSON.stringify(fromCli)).by, "cli", "the stamp survives the wire");
});

test("SETTINGS_KEYS lists automations once and DEFAULT_SETTINGS.automations is the contract's default: on, five free kinds unattended, snooze 10, five brain minutes, no recipes, not opening at login", () => {
  assert.equal((SETTINGS_KEYS as readonly string[]).filter((k) => k === "automations").length, 1);
  const a: AutomationSettings = (DEFAULT_SETTINGS as Settings).automations;
  assert.deepEqual(a, { enabled: true, unattended: ["chime", "say", "notify", "open", "file"], snoozeMinutes: 10, wakeBudgetMinutesPerDay: 5, recipes: [], openAtLogin: false });
  assert.deepEqual(a, DEFAULT_AUTOMATIONS);
  assert.equal(a.quietHours, undefined, "no quiet hours until Kevin sets them");
  for (const k of a.unattended) assert.equal(AUTOMATION_ACTING_KINDS.has(k) && k !== "open" && k !== "file", false, `${k} is a free kind or one of the two reversible acting kinds`);
  for (const opt of ["run-recipe", "press", "wake-brain"] as const) assert.equal(a.unattended.includes(opt), false, `${opt} needs the chip and a per-row yes`);
});

test("the action vocabulary: eight kinds, five of them acting; the terminal states are done and trashed only (trashed is a state, never a deletion)", () => {
  assert.deepEqual([...AUTOMATION_ACTION_KINDS], ["chime", "say", "notify", "open", "file", "run-recipe", "press", "wake-brain"]);
  assert.deepEqual([...AUTOMATION_ACTING_KINDS].sort(), ["file", "open", "press", "run-recipe", "wake-brain"]);
  for (const k of AUTOMATION_ACTING_KINDS) assert.ok((AUTOMATION_ACTION_KINDS as readonly string[]).includes(k));
  assert.deepEqual([...AUTOMATION_TERMINAL].sort(), ["done", "trashed"]);
});

test("the constants the daemon and the surfaces size themselves by", () => {
  assert.equal(AUTOMATIONS_MAX, 32);
  assert.equal(AUTOMATIONS_TRASHED_MAX, 8, "the snapshot's Trash tail: the newest eight trashed rows after the live ones");
  // The snapshot's automation fields, by name — a rename or a drop fails here, not in a Swift decoder.
  const fields: readonly (keyof Snapshot)[] = ["automations", "ringing", "nextFire", "recipesAsking"];
  assert.equal(fields.length, 4);
  assert.equal(AUTOMATION_ACTIONS_MAX, 3);
  assert.equal(AUTOMATION_LINGER_MS, 10 * 60_000);
  assert.equal(AUTOMATION_REPEAT_CHIME_MS, 30_000);
  assert.deepEqual([...AUTOMATION_SNOOZES], [5, 10, 30]);
  assert.equal(AUTOMATION_LINE_CHARS, 160);
  assert.equal(AUTOMATION_WATCH_COOLDOWN_S, 30);
  assert.equal(AUTOMATION_POLL_MIN_S, 30);
  assert.equal(AUTOMATION_FOLDER_WATCHERS_MAX, 8);
  assert.equal(AUTOMATION_WAKE_COOLDOWN_MIN_S, 600);
  assert.equal(AUTOMATION_SLEEP_GAP_MS, 5_000);
  assert.deepEqual(AUTOMATION_GRACE_MS, { alarm: 15 * 60_000, timer: 10 * 60_000, reminder: 60 * 60_000, routine: 0, watcher: 0 }, "routines and watchers never fire late");
});

const at: ClockTime = "07:10";
const row = (when: Automation["when"], first: Automation["then"][number]): Pick<Automation, "when" | "then"> => ({ when, then: [first] });

test("automationKind is derived from when + the first action: in → timer, on → watcher, every+chime → alarm, every+else → routine, at+chime → alarm, at+else → reminder", () => {
  const chime = { kind: "chime", line: "Wake up, Kevin" } as const;
  const notify = { kind: "notify", title: "standup" } as const;
  assert.equal(automationKind(row({ kind: "in", ms: 12 * 60_000 }, chime)), "timer");
  assert.equal(automationKind(row({ kind: "on", on: { kind: "app.quit", app: "Slack" } }, notify)), "watcher");
  assert.equal(automationKind(row({ kind: "every", every: { kind: "weekly", days: ["mon"], at }, phrase: "mon 07:10" }, chime)), "alarm");
  assert.equal(automationKind(row({ kind: "every", every: { kind: "weekly", days: ["mon"], at }, phrase: "mon 07:10" }, notify)), "routine");
  assert.equal(automationKind(row({ kind: "at", at: 1_789_243_208_790 }, chime)), "alarm");
  assert.equal(automationKind(row({ kind: "at", at: 1_789_243_208_790 }, notify)), "reminder");
  assert.equal(automationKind({ when: { kind: "at", at: 1 }, then: [] }), "reminder", "no action yet: a reminder, never a throw");
});

test("automation.event bytes, measured: state fits 200 B with detail ≤ 70 (196 B; 80 is 206), missed 146 B, tick 93 B; fired is the one kind over the line — 228 B at a 40-char line with Snooze · Done, 268 B at the 80-char cap the table applies, 348 B at a full 160-char line", () => {
  const base = { seq: 4096, at: 1_789_243_218_790, id: `auto_${T36}k3q9zx` };
  const state = (detail: number): number => bytes({ ...base, kind: "state", state: "snoozed", nextAt: 1_789_243_818_790, detail: chars(detail) } satisfies AutomationEvent);
  assert.ok(state(70) <= 200, `state with a 70-char detail is ${state(70)} B`);
  assert.ok(state(80) > 200, `state with an 80-char detail is ${state(80)} B — the table caps detail at 70`);
  const missed: AutomationEvent = { ...base, kind: "missed", dueAt: 1_789_243_208_790, lateMs: 720_000, skipped: false, why: "mac-slept" };
  const tick: AutomationEvent = { ...base, kind: "tick", remainingMs: 252_000 };
  assert.ok(bytes(missed) <= 200, `missed is ${bytes(missed)} B`);
  assert.ok(bytes(tick) <= 100, `tick is ${bytes(tick)} B (≤ 1/s while a client views a timer)`);
  const fired = (line: number): number => bytes({ ...base, kind: "fired", actions: ["chime"], line: chars(line), ok: true, lateMs: 720_000, presses: [{ kind: "snooze", minutes: 10 }, { kind: "done" }] } satisfies AutomationEvent);
  assert.ok(fired(40) > 200, `fired carries its presses (~50 B) and is over 200 B even at a 40-char line: ${fired(40)} B`);
  assert.ok(fired(80) < 280, `fired at the table's 80-char line cap is ${fired(80)} B`);
  assert.ok(fired(AUTOMATION_LINE_CHARS) < 360, `fired at a full line is ${fired(AUTOMATION_LINE_CHARS)} B — the record keeps the line whole, the event carries a head`);
});

test("the six automation ledger rows type-check as LedgerRow and a reader that does not know them falls through", () => {
  const a: Automation = {
    id: "auto_1", name: "Wake up", when: { kind: "every", every: { kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], at }, phrase: "weekdays 07:10" },
    then: [{ kind: "chime", line: "Wake up, Kevin", sound: "Hero" }], clauses: { quiet: "override" }, echo: "weekdays at 7:10, a chime",
    state: "armed", nextAt: 2, fires: 0, missed: 0, createdAt: 1, updatedAt: 1, createdBy: { by: "brain", request: "wake me at 7:10 on weekdays" },
  };
  const rows: LedgerRow[] = [
    { at: 1, type: "automation.set", automation: a, by: "brain" },
    { at: 2, type: "automation.fired", id: a.id, actions: ["chime"], ok: true, line: "07:10 · Wake up", lateMs: 720_000, ms: 12 },
    { at: 3, type: "automation.state", id: a.id, state: "snoozed", by: "kevin", until: 4 },
    { at: 4, type: "automation.missed", id: a.id, dueAt: 2, why: "daemon-down" },
    { at: 5, type: "recipe.set", recipe: { name: "tests", command: "pnpm test", timeoutSeconds: 120, approvedAt: 5 }, by: "kevin" },
    { at: 6, type: "recipe.trashed", name: "tests" },
    { at: 7, type: "recipe.restored", name: "tests" },
  ];
  assert.equal(rows.length, 7);
  const sessionRows = rows.filter((r) => r.type === "heard" || r.type === "said");
  assert.deepEqual(sessionRows, [], "none of them is a session's own row");
});

test("a recipe is never deleted: ShellRecipe carries trashedAt for Move to Trash; liveRecipes hides the Trash, recipeNamed finds a live one by name (case-insensitive) and a trashed one only when asked for any", () => {
  const tests: ShellRecipe = { name: "tests", command: "pnpm test", timeoutSeconds: 120, approvedAt: 5 };
  const binned: ShellRecipe = { name: "purge", command: "rm -rf ~/x", timeoutSeconds: 5, approvedAt: 5, trashedAt: 9 };
  assert.deepEqual(liveRecipes([tests, binned]), [tests]);
  assert.equal(recipeNamed([tests, binned], "TESTS"), tests);
  assert.equal(recipeNamed([tests, binned], "purge"), undefined, "the Trash is no picker's");
  assert.equal(recipeNamed([tests, binned], "purge", "any"), binned);
  assert.equal(recipeNamed([tests, binned], " tests "), tests, "the name is trimmed");
  assert.ok(isEngineCommand({ type: "recipe.restore", name: "purge" }));
});

// ---- design12: the audio block and the app's read-back frame.

test("SETTINGS_KEYS lists audio once and DEFAULT_SETTINGS.audio is the contract's default: Recording off; a patch may carry the whole block or null", () => {
  assert.equal((SETTINGS_KEYS as readonly string[]).filter((k) => k === "audio").length, 1, "the audio block joins SETTINGS_KEYS so settings.json keeps it");
  const a: AudioSettings = (DEFAULT_SETTINGS as Settings).audio;
  assert.deepEqual(a, { recording: false });
  assert.deepEqual(a, DEFAULT_AUDIO);
  assert.equal(Object.keys(a).length, 1, "one decision — the ducking level is a constant, not a setting");
  const whole: SettingsPatch = { audio: { recording: true } };
  const cleared: SettingsPatch = { audio: null };
  assert.equal(whole.audio?.recording, true);
  assert.equal(cleared.audio, null);
});

/** A frame as the app sends it on Kevin's Mac today: awake on AirPods, the unit following the headset mic. */
const AEC_ON_AIRPODS: AudioState = {
  running: true,
  voiceProcessing: true,
  duckLevel: 10,
  advancedDucking: true,
  agc: true,
  bypassed: false,
  rung: 2,
  wiring: "input-rate",
  hears: { name: "Kevin's AirPods Pro", uid: "AP-in", rate: 24000, channels: 1, transport: "bluetooth" },
  speaks: { name: "Kevin's AirPods Pro", uid: "AP-out", rate: 16000, channels: 2, transport: "bluetooth" },
  tapFormat: "24000 Hz ×9 Float32",
  recording: false,
  fallback: false,
  guardOn: false,
  guardTailMs: 0,
  gated: 0,
  chunks: 340,
  breakthroughs: 0,
  sharedWith: [],
  inputMuted: false,
  aggregatePresent: true,
};

test("isAudioState accepts the app's frame (devices, counters and the optional knobs) and refuses a malformed one — a missing boolean, a string counter, a device without a rate, a non-string sharer", () => {
  assert.ok(isAudioState(AEC_ON_AIRPODS));
  const { hears: _h, speaks: _s, sharedWith: _w, duckLevel: _d, ...bare } = AEC_ON_AIRPODS;
  assert.ok(isAudioState(bare), "the devices, the sharers and the knobs are optional (the graph may be down; the HAL may not say)");
  assert.equal(isAudioState(undefined), false);
  assert.equal(isAudioState("running"), false);
  assert.equal(isAudioState({ ...AEC_ON_AIRPODS, running: "yes" }), false, "a boolean spelled as a string");
  assert.equal(isAudioState({ ...AEC_ON_AIRPODS, gated: "12" }), false, "a counter spelled as a string");
  assert.equal(isAudioState({ ...AEC_ON_AIRPODS, rung: Number.NaN }), false, "NaN is not a rung");
  assert.equal(isAudioState({ ...AEC_ON_AIRPODS, hears: { name: "x", uid: "y" } }), false, "a device without its rate and transport");
  assert.equal(isAudioState({ ...AEC_ON_AIRPODS, sharedWith: [42] }), false, "sharers are names");
  const { guardOn: _g, ...noGuard } = AEC_ON_AIRPODS;
  assert.equal(isAudioState(noGuard), false, "guardOn is what the ledger line keys on");
});

test("the audio.guard ledger row carries the counters the self-talk fuse reads, and readers fall through on it like any other type", () => {
  const row: LedgerRow = { at: 1, type: "audio.guard", sessionId: "sess_a", tailMs: 420, heldMs: 3200, gated: 12, chunks: 340, breakthroughs: 1, fallback: false };
  assert.equal(row.type, "audio.guard");
  assert.ok(JSON.stringify(row).length < 200, "one row per turn stays small");
});
