import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerRow, Worker } from "@jarhead/protocol";
import type { BrainResult, BrainTask } from "@jarhead/brain";
import type { ToolResult } from "@jarhead/hands";
import { LANE_REFUSAL, MAIN_LEASE_WAIT_MS, needsFocus } from "../workers.ts";
import { delegate, nextUtterance, rows, settle, until, world, type World } from "./world.ts";

/**
 * Workers: a second pair of hands inside one delegation. The main brain says
 * `worker_start`; Kevin hears one line at the split ("Spotify alongside.") and one
 * when the worker finishes; the worker's steps land on the parent's timeline with
 * its name and its brain is told Kevin's words, never the brief, as `request`. The
 * background lane is refused the pointer, the keyboard, the front app and the
 * clipboard with one line and no helper op; the screen lane waits its turn for the
 * one lease, which Jarhead's own hands take back after MIN_HOLD and never mid-op.
 * Every cut verb cancels every worker with its brain's cancel called once; the
 * Console's Stop cancels one and the session stays open.
 */

type WorkerRow = Extract<LedgerRow, { type: "worker" }>;

/** A promise a test opens by hand. */
function gate(): { readonly p: Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/** Wake, delegate the two-part request, and hold the main brain's turn (its runner is attached with the task). */
async function split(w: World, request = "jarhead tell ben on slack i'm late and play focus on spotify"): Promise<void> {
  await w.engine.start();
  await w.engine.ready();
  w.engine.updateSettings({ idleSleepMinutes: 0 });
  await w.engine.wake("test");
  delegate(w, request, "item_1");
  await settle();
  assert.equal(w.brain.tasks.length, 1, "the main brain holds the task");
}

async function startWorker(w: World, name: string, task: string, lane: "background" | "screen" = "background"): Promise<ToolResult> {
  const out = await w.engine.runner.run("worker_start", { name, task, lane });
  await until(() => w.workers.byName(name)?.tasks.length === 1);
  return out.result;
}

const workersOf = (w: World): readonly Worker[] => w.engine.snapshot().workers ?? [];

test("worker_start: one split line, a worker row per status change, the worker's steps on the parent's timeline with its name, Kevin's words as its request; a finish line once; worker_wait says what Kevin was told; a third hand is refused", async () => {
  const w = world();
  const { engine, live, brain } = w;
  try {
    // The worker looks once (on its own lane) and then holds for the test.
    w.workers.script = async (job) => {
      await job.runner.run("frontmost_app", {});
      return undefined;
    };
    await split(w);
    const started = await startWorker(w, "Spotify", "play the playlist Focus in Spotify");
    assert.equal(started.kind, "text", JSON.stringify(started));
    assert.match((started as { text: string }).text, /^started worker Spotify \(w_[a-z0-9]+\) on the background lane/);
    assert.deepEqual(live.commentary, ["Spotify alongside."], "Jarhead's one line at the split, at once");

    await until(() => workersOf(w)[0]?.status === "working");
    const spotify = workersOf(w)[0]!;
    assert.match(spotify.id, /^w_/);
    assert.equal(spotify.name, "Spotify");
    assert.equal(spotify.lane, "background");
    assert.equal(spotify.delegationId, engine.snapshot().delegations[0]!.id);
    assert.deepEqual(rows<WorkerRow>(w, "worker").map((r) => r.worker.status), ["starting", "working"], "one row per status change");

    // Gate hygiene: the brain's brief rides in the dialogue; `request` is what Kevin said.
    const fb = w.workers.byName("Spotify")!;
    assert.equal(fb.started, 1);
    const task: BrainTask = fb.tasks[0]!;
    assert.match(task.request, /play focus on spotify/);
    assert.doesNotMatch(task.request, /playlist Focus in Spotify/, "the brief is never the request");
    assert.match(task.dialogue, /Your one job: play the playlist Focus in Spotify/);
    assert.match(task.dialogue, /Lane: background/);
    assert.equal(task.confirmation, false);
    assert.ok(typeof task.kevinDialogue === "string");
    // Its step is on the PARENT's timeline, tagged, and never voiced.
    await until(() => engine.snapshot().delegations[0]!.steps.some((s) => s.worker === "Spotify" && s.kind === "tool"));
    const step = engine.snapshot().delegations[0]!.steps.find((s) => s.worker === "Spotify" && s.kind === "tool")!;
    assert.equal(step.tool?.name, "frontmost_app");
    assert.equal(workersOf(w)[0]!.steps, 1);
    fb.sink!.commentary("I am pressing play now");
    fb.sink!.thinking("looking at the playlist");
    await settle();
    assert.ok(engine.snapshot().delegations[0]!.steps.some((s) => s.worker === "Spotify" && s.kind === "commentary" && s.text === "I am pressing play now"));
    assert.deepEqual(live.commentary, ["Spotify alongside."], "workers never narrate: nothing more reached the voice");

    // A second hand, then the cap.
    const slack = await startWorker(w, "Slack", "tell Ben I'm running late", "screen");
    assert.equal(slack.kind, "text");
    assert.deepEqual(live.commentary, ["Spotify alongside."], "the split line is spoken once per delegation");
    const third = await engine.runner.run("worker_start", { name: "Mail", task: "check the inbox" });
    assert.equal(third.result.kind, "error");
    assert.match((third.result as { message: string }).message, /2 hands are busy/);
    const dup = await engine.runner.run("worker_start", { name: "spotify", task: "again" });
    assert.match((dup.result as { message: string }).message, /already running/);

    // Spotify finishes: one line, Jarhead's own; the record settles and lingers in the snapshot.
    w.clock.t += 1000;
    fb.resolve!({ status: "done", summary: "playing Focus." });
    await until(() => live.commentary.includes("Spotify: playing Focus."));
    assert.equal(live.commentary.filter((c) => /Spotify: playing Focus/.test(c)).length, 1);
    const done = workersOf(w).find((x) => x.name === "Spotify")!;
    assert.equal(done.status, "done");
    assert.equal(done.detail, "playing Focus.");
    assert.ok(done.doneAt !== undefined);
    assert.deepEqual(rows<WorkerRow>(w, "worker").filter((r) => r.worker.name === "Spotify").map((r) => r.worker.status), ["starting", "working", "done"]);
    assert.equal(fb.stops, 1, "its process ends with it");
    const waited = await engine.runner.run("worker_wait", { name: "Spotify" });
    assert.equal(waited.result.kind, "text");
    assert.match((waited.result as { text: string }).text, /^Spotify: done — playing Focus\. \(Kevin was told: "Spotify: playing Focus\."\)/);
    // The parent's timeline recorded the worker_* calls as tool steps of its own.
    assert.ok(engine.snapshot().delegations[0]!.steps.some((s) => s.kind === "tool" && s.tool?.name === "worker_start" && !s.worker));

    // Slack fails: one line, the parent carries on and finishes with its own summary once.
    const slackBrain = w.workers.byName("Slack")!;
    w.clock.t += 1000;
    slackBrain.resolve!({ status: "failed", error: "Slack is not running on this Mac" });
    await until(() => live.commentary.some((c) => /Slack failed: Slack is not running on this Mac/.test(c)));
    assert.equal(engine.workers.running(), 0);
    brain.resolve!({ status: "done", summary: "Sent to Ben." });
    await until(() => engine.snapshot().delegations[0]!.status === "done");
    assert.equal(live.commentary.filter((c) => /Sent to Ben/.test(c)).length, 1);
    const all = await engine.runner.run("worker_wait", { name: "all" });
    assert.equal(all.result.kind, "error", "the delegation is over: no task owns a worker any more");
  } finally {
    await engine.stop();
  }
});

test("two workers finishing within the coalescing window are one spoken append; a finished worker lingers in the snapshot and its lines are on the parent's record", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    w.workers.script = async () => undefined;
    await split(w);
    await startWorker(w, "Spotify", "play Focus");
    await startWorker(w, "Slack", "tell Ben");
    await until(() => workersOf(w).length === 2 && workersOf(w).every((x) => x.status === "working"));
    // Both finish inside the coalescing window that the split line opened: one append for the two of them.
    w.workers.byName("Spotify")!.resolve!({ status: "done", summary: "playing Focus." });
    w.workers.byName("Slack")!.resolve!({ status: "done", summary: "sent." });
    await until(() => live.commentary.some((c) => /Slack: sent/.test(c)), 1500);
    assert.deepEqual(live.commentary, ["Spotify alongside.", "Spotify: playing Focus. Slack: sent."], "two finish lines within 600 ms are one append");
    assert.equal(workersOf(w).length, 2, "both linger for the Console");
    assert.ok(engine.snapshot().delegations[0]!.steps.filter((s) => s.kind === "commentary" && s.worker).length >= 2);
    // Past WORKER_LINGER_MS they leave the snapshot.
    w.clock.t += 31_000;
    assert.equal(workersOf(w).length, 0);
  } finally {
    await engine.stop();
  }
});

test("background lane: type, click, open_url, clipboard_write, an activating AppleScript and `open`/`osascript` shells are refused with the lane line and no helper op; open -g is not the lane's business; worker_* and self_* are not a worker's", async () => {
  // The table, before the engine: the shell head and the AppleScript verbs.
  assert.equal(needsFocus("run_shell", { command: "open -g Spotify" }), false);
  assert.equal(needsFocus("run_shell", { command: "open -j x" }), false);
  assert.equal(needsFocus("run_shell", { command: "open /Applications/Spotify.app" }), true);
  assert.equal(needsFocus("run_shell", { command: "FOO=1 open x" }), true);
  assert.equal(needsFocus("run_shell", { command: "osascript -e 'tell app \"Finder\" to activate'" }), true);
  assert.equal(needsFocus("run_shell", { command: "ls -la" }), false);
  // Compound lines are judged per command; a flag cluster with g or j keeps `open` in the background; wrappers and paths do not hide the head.
  assert.equal(needsFocus("run_shell", { command: "ls && open -a Slack" }), true);
  assert.equal(needsFocus("run_shell", { command: "cd ~/Downloads; open ." }), true);
  assert.equal(needsFocus("run_shell", { command: "echo 'tell app \"Finder\" to activate' | osascript" }), true);
  assert.equal(needsFocus("run_shell", { command: "true || open -a Slack" }), true);
  assert.equal(needsFocus("run_shell", { command: "sudo open /Applications/Slack.app" }), true);
  assert.equal(needsFocus("run_shell", { command: "env FOO=1 /usr/bin/open x" }), true);
  assert.equal(needsFocus("run_shell", { command: "nohup /usr/bin/osascript -e 'beep' &" }), true);
  assert.equal(needsFocus("run_shell", { command: "open -ga Spotify" }), false);
  assert.equal(needsFocus("run_shell", { command: "open -g -a Spotify" }), false);
  assert.equal(needsFocus("run_shell", { command: "open --background -a Spotify" }), false);
  assert.equal(needsFocus("run_shell", { command: "ls -la && open -gj x; echo done" }), false);
  assert.equal(needsFocus("run_shell", { command: "echo 'open -a Slack'" }), false, "quoted: an argument, not a command");
  assert.equal(needsFocus("run_shell", { command: "grep open file.txt | wc -l" }), false);
  assert.equal(needsFocus("applescript", { script: 'tell application "Spotify" to play track "x"' }), false);
  assert.equal(needsFocus("applescript", { script: 'tell application "Spotify" to activate' }), true);
  assert.equal(needsFocus("applescript", { script: 'tell application "System Events" to keystroke "a"' }), true);
  assert.equal(needsFocus("clipboard_write", {}), true);
  assert.equal(needsFocus("browser_read", {}), false);

  const w = world();
  const { engine, hands, handsBg } = w;
  try {
    const results = new Map<string, ToolResult>();
    w.workers.script = async (job) => {
      const calls: [string, Record<string, unknown>][] = [
        ["type", { text: "hello" }],
        ["left_click", { coordinate: [10, 10] }],
        ["open_app", { name: "Spotify" }],
        ["open_url", { url: "https://open.spotify.com" }],
        ["clipboard_write", { text: "x" }],
        ["applescript", { script: 'tell application "Spotify" to activate' }],
        ["run_shell", { command: "open -a Spotify" }],
        ["run_shell", { command: "osascript -e 'beep'" }],
        ["worker_start", { name: "Nested", task: "no" }],
        ["self_status", {}],
        ["frontmost_app", {}],
      ];
      for (const [name, input] of calls) results.set(`${name}:${JSON.stringify(input)}`, (await job.runner.run(name, input)).result);
      return { status: "done", summary: "reported." };
    };
    await split(w);
    hands.ops.length = 0;
    handsBg.ops.length = 0;
    await startWorker(w, "Spotify", "play Focus");
    await until(() => results.size === 11);
    for (const [key, r] of results) {
      if (key.startsWith("frontmost_app")) {
        assert.equal(r.kind, "text", key);
        continue;
      }
      assert.equal(r.kind, "error", key);
      const message = (r as { message: string }).message;
      if (key.startsWith("worker_start") || key.startsWith("self_status")) assert.match(message, /not for a worker/, key);
      else assert.equal(message, LANE_REFUSAL, key);
    }
    for (const op of ["type", "click", "open_app", "focus_app", "key", "scroll"]) {
      assert.equal(hands.named(op).length, 0, `${op} never reached the acting helper`);
      assert.equal(handsBg.named(op).length, 0, `${op} never reached the reading helper`);
    }
    assert.equal(handsBg.named("frontmost").length, 1, "the one read went to the reading helper");
    assert.equal(hands.named("frontmost").length, 0);
    // The refusals are on the parent's timeline as the worker's error steps.
    const errors = engine.snapshot().delegations[0]!.steps.filter((s) => s.worker === "Spotify" && s.kind === "error");
    assert.ok(errors.length >= 8, `${errors.length} refusals recorded`);
    await until(() => workersOf(w)[0]?.status === "done");
  } finally {
    await engine.stop();
  }
});

test("screen lane: a worker acquires only when the main brain's turn ends, re-fronts its app with exactly one focus_app on a later hand-over; Jarhead's hands take the lease back after MIN_HOLD and never mid-op (a held type finishes first)", async () => {
  const w = world();
  const { engine, hands, brain, clock } = w;
  try {
    const opened = gate();
    const g1 = gate();
    const g2 = gate();
    w.workers.script = async (job) => {
      await job.runner.run("open_app", { name: "Spotify" });
      opened.open();
      await g1.p;
      await job.runner.run("type", { text: "focus" });
      await g2.p;
      await job.runner.run("key", { text: "space" });
      return { status: "done", summary: "played Focus." };
    };
    await split(w);
    // The main brain acts: Jarhead's own hands hold the screen.
    const key = await engine.runner.run("key", { text: "Return" });
    assert.equal(key.result.kind, "text");
    assert.equal(engine.lease.holder, "jarhead");
    hands.ops.length = 0;

    await startWorker(w, "Slack", "tell Ben I'm late", "screen");
    await until(() => workersOf(w)[0]?.status === "waiting-screen");
    assert.equal(hands.named("open_app").length, 0, "the worker waits: the main brain's turn is still running");
    // The turn ends: the worker takes the screen within a poll.
    brain.resolve!({ status: "done", summary: "on it." });
    await opened.p;
    assert.equal(hands.named("open_app").length, 1);
    assert.equal(hands.frontApp, "Spotify");
    assert.equal(engine.lease.holder, workersOf(w)[0]!.id);
    assert.equal(workersOf(w)[0]!.status, "working");
    assert.equal(engine.snapshot().delegations[0]!.status, "running", "the parent drains while its worker works");

    // Kevin asks something else; the worker is mid-type (held on the fake); Jarhead's hands wait for the op and MIN_HOLD.
    nextUtterance(w);
    delegate(w, "jarhead what is on my screen", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 2);
    hands.hold = "type";
    g1.open();
    await until(() => hands.named("type").length === 1);
    const focusing = engine.runner.run("focus_app", { name: "Notes" });
    await settle(320);
    assert.equal(hands.named("focus_app").length, 0, "not mid-op, even for Jarhead's own hands");
    clock.t += 1600;
    await settle(320);
    assert.equal(hands.named("focus_app").length, 0, "MIN_HOLD passed but the type is still in flight");
    hands.release();
    await until(() => hands.named("focus_app").length === 1);
    const focused = await focusing;
    assert.equal(focused.result.kind, "text");
    assert.equal(engine.lease.holder, "jarhead");
    assert.equal(hands.frontApp, "Notes");
    brain.resolve!({ status: "done", summary: "typed." });
    await settle();

    // The worker's next screen tool: its app comes back to the front, once, then the key lands.
    g2.open();
    await until(() => hands.named("key").length === 2);
    assert.equal(hands.named("focus_app").filter((f) => f.params["name"] === "Spotify").length, 1, "exactly one re-front");
    assert.equal(hands.frontApp, "Spotify");
    assert.ok(engine.snapshot().delegations[0]!.steps.some((s) => s.worker === "Slack" && s.kind === "note" && /brought Spotify back to the front/.test(s.text ?? "")));
    await until(() => engine.snapshot().delegations[0]!.status !== "running");
  } finally {
    hands.release();
    await engine.stop();
  }
});

test("Kevin's hands win: the helper's busy answer is retried silently and the key lands after his quiet window; nothing was posted meanwhile", async () => {
  const w = world();
  const { engine, hands, clock } = w;
  try {
    await split(w);
    hands.ops.length = 0;
    hands.kevinActed();
    const pressing = engine.runner.run("key", { text: "Return" });
    await settle(120);
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 0, "nothing posted while Kevin's hands are on the machine");
    assert.ok(hands.named("key").length >= 1, "the helper refused it");
    clock.t += 1600;
    const out = await pressing;
    assert.equal(out.result.kind, "text", JSON.stringify(out.result));
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 1, "landed once, after the quiet window");
  } finally {
    await engine.stop();
  }
});

/** Two workers: Spotify (background) mid-read on the reading helper, Slack (screen) holding its turn. */
async function twoWorkersMidFlight(w: World): Promise<{ spotify: Promise<ToolResult>; slackReady: Promise<void> }> {
  let spotifyResult!: (r: ToolResult) => void;
  const spotify = new Promise<ToolResult>((r) => (spotifyResult = r));
  const slack = gate();
  w.workers.script = async (job) => {
    if (job.brain.name === "Spotify") {
      const r = await job.runner.run("frontmost_app", {});
      spotifyResult(r.result);
      return undefined;
    }
    slack.open();
    return undefined;
  };
  await split(w);
  w.handsBg.hold = "frontmost";
  await startWorker(w, "Spotify", "play Focus");
  await startWorker(w, "Slack", "tell Ben", "screen");
  await until(() => w.handsBg.named("frontmost").length >= 1 && workersOf(w).length === 2);
  return { spotify, slackReady: slack.p };
}

test("interrupt while workers run: both helpers' pendings fail, every worker is cancelled with its brain's cancel called once, no per-worker line, a late tool.run for it is refused — and the session stays open", async () => {
  const w = world();
  const { engine, live, hands, handsBg, brain } = w;
  try {
    const { spotify } = await twoWorkersMidFlight(w);
    // The main lane's own probe is pending on the acting helper too.
    hands.hold = "frontmost";
    const typing = engine.toolset.run("type", { text: "hi" });
    await until(() => hands.named("frontmost").length >= 1);
    const spotifyId = workersOf(w).find((x) => x.name === "Spotify")!.id;
    assert.ok(engine.runnerFor(spotifyId)?.attached, "the worker's lane is attached while it works");
    live.commentary.length = 0;

    await engine.command({ type: "interrupt" });
    assert.equal(brain.cancels, 1);
    assert.equal(w.workers.byName("Spotify")!.cancels, 1);
    assert.equal(w.workers.byName("Slack")!.cancels, 1);
    assert.deepEqual(workersOf(w).map((x) => x.status), ["cancelled", "cancelled"]);
    assert.equal(engine.workers.running(), 0);
    assert.equal(engine.lease.holder, undefined);
    const bg = await spotify;
    assert.equal(bg.kind, "error");
    assert.match((bg as { message: string }).message, /cancelled|stop/, "the reading helper's pending failed");
    const fg = await typing;
    assert.equal(fg.kind, "error", "the acting helper's pending failed");
    hands.release();
    handsBg.release();
    assert.equal(engine.runnerFor(spotifyId), undefined, "a late tool.run {worker} has nowhere to go: refused");
    assert.equal(live.currentState, "started", "a spoken stop keeps the session");
    assert.ok(!live.commentary.some((c) => /stopped\./.test(c)), "a cut says nothing per worker");
    assert.equal(rows<WorkerRow>(w, "worker").filter((r) => r.worker.status === "cancelled").length, 2);
  } finally {
    hands.release();
    handsBg.release();
    await engine.stop();
  }
});

test("worker.stop cancels one worker, says '<Name> stopped.' once, leaves the other working and the session open; a second stop of it is a word", async () => {
  const w = world();
  const { engine, live, events } = w;
  try {
    await twoWorkersMidFlight(w);
    w.handsBg.release();
    const spotify = workersOf(w).find((x) => x.name === "Spotify")!;
    events.length = 0;
    await engine.command({ type: "worker.stop", workerId: spotify.id });
    await until(() => live.commentary.some((c) => /Spotify stopped\./.test(c)));
    assert.equal(live.commentary.filter((c) => /Spotify stopped\./.test(c)).length, 1);
    assert.equal(workersOf(w).find((x) => x.name === "Spotify")!.status, "cancelled");
    assert.equal(workersOf(w).find((x) => x.name === "Slack")!.status, "working", "the other carries on");
    assert.equal(w.workers.byName("Spotify")!.cancels, 1);
    assert.equal(w.workers.byName("Slack")!.cancels, 0);
    assert.equal(live.currentState, "started");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "Spotify stopped"));
    events.length = 0;
    await engine.command({ type: "worker.stop", workerId: "w_nobody" });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "no such worker"));
    // Its row still lingers for the Console: a Stop on it stops nothing, and says so — no second "stopped" line.
    events.length = 0;
    await engine.command({ type: "worker.stop", workerId: spotify.id });
    assert.ok(events.some((e) => e.type === "toast" && e.text === "Spotify had already finished"));
    assert.equal(live.commentary.filter((c) => /Spotify stopped\./.test(c)).length, 1);
    assert.equal(w.workers.byName("Spotify")!.cancels, 1);
    // The main brain's worker_stop does the same for the other, with a result it can read.
    const stopped = await engine.runner.run("worker_stop", { name: "Slack" });
    assert.equal(stopped.result.kind, "text");
    assert.match((stopped.result as { text: string }).text, /Slack stopped/);
    await until(() => live.commentary.some((c) => /Slack stopped\./.test(c)));
    assert.equal(engine.workers.running(), 0);
  } finally {
    w.handsBg.release();
    await engine.stop();
  }
});

test("pause, Stop and sleep cancel every worker (brain cancel once each); sleep and Stop end the worker processes and the spare; Stop writes its stop row before the sleep row", async () => {
  for (const verb of ["pause", "stop", "sleep"] as const) {
    const w = world();
    const { engine, live } = w;
    try {
      await twoWorkersMidFlight(w);
      w.handsBg.release();
      // The spare warmed at wake became the first worker's brain; the second booted on demand.
      assert.equal(w.workers.brains.length, 2, "the spare (now Spotify's) and Slack's");
      assert.equal(w.workers.brains[0]!.name, "Spotify");
      const [spotify, slack] = [w.workers.byName("Spotify")!, w.workers.byName("Slack")!];
      if (verb === "pause") await engine.command({ type: "pause" });
      else if (verb === "stop") await engine.command({ type: "stop" });
      else await engine.sleep();
      assert.deepEqual(workersOf(w).map((x) => x.status), ["cancelled", "cancelled"], verb);
      assert.equal(spotify.cancels, 1, `${verb}: Spotify's brain cancelled once`);
      assert.equal(slack.cancels, 1, `${verb}: Slack's brain cancelled once`);
      assert.equal(live.currentState, "closed", `${verb} closes the session`);
      assert.equal(engine.workers.running(), 0);
      assert.equal(spotify.stops, 1, `${verb}: a cancelled worker's process ends with it`);
      assert.equal(slack.stops, 1);
      if (verb !== "pause") {
        const types = (engine.ledger.read(w.clock.t) as unknown as { type: string }[]).map((r) => r.type).filter((t) => t === "stop" || t === "sleep");
        assert.deepEqual(types, verb === "stop" ? ["stop", "sleep"] : ["sleep"], verb);
      }
    } finally {
      w.handsBg.release();
      await engine.stop();
    }
  }
});

test("the spare: one worker process is warmed at wake (started, no task), taken by the first worker_start, and ended by sleep when unused", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await until(() => w.workers.brains.length === 1 && w.workers.brains[0]!.started === 1);
    const spare = w.workers.brains[0]!;
    assert.equal(spare.tasks.length, 0, "a process, not a model request");
    assert.equal(engine.workers.spareId, spare.id);
    assert.equal((engine.snapshot().workers ?? []).length, 0, "a spare is not a worker");
    await engine.sleep();
    assert.equal(spare.stops, 1, "sleep ends the spare's process");
    assert.equal(engine.workers.spareId, undefined);
    // The next wake warms one again; the first split takes it.
    await engine.wake("test");
    await until(() => w.workers.brains.length === 2);
    delegate(w, "jarhead play focus and tell ben", "item_1");
    await settle();
    w.workers.script = async () => undefined;
    await engine.runner.run("worker_start", { name: "Spotify", task: "play Focus" });
    await until(() => w.workers.brains[1]!.tasks.length === 1);
    assert.equal(engine.workers.spareId, undefined, "taken");
    assert.equal(w.workers.brains.length, 2, "no third process for the first worker");
  } finally {
    await engine.stop();
  }
});

test("idle sleep is held while a worker runs and fires at the ordinary time after its last report; 61 s of worker actions never move lastKevinAt", async () => {
  const w = world();
  const { engine, live, brain, clock } = w;
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  const lastKevinAt = (): number => (engine as unknown as { lastKevinAt: number }).lastKevinAt;
  try {
    const steps = gate();
    w.workers.script = async (job) => {
      for (let i = 0; i < 6; i++) {
        clock.t += 10_000;
        await job.runner.run("frontmost_app", {});
      }
      clock.t += 1000;
      steps.open();
      return undefined;
    };
    await split(w);
    engine.updateSettings({ idleSleepMinutes: 1 });
    const kevinBefore = lastKevinAt();
    await startWorker(w, "Spotify", "play Focus");
    // The main brain is done; the worker is not: the delegation drains and holds the session.
    brain.resolve!({ status: "done", summary: "on it." });
    await steps.p;
    assert.equal(lastKevinAt(), kevinBefore, "a worker's 61 s of actions are the brain's activity, not Kevin's");
    assert.equal(engine.workers.running(), 1);
    tick();
    await settle();
    assert.equal(live.currentState, "started", "held: a worker still works");
    assert.equal(engine.currentPhase !== "asleep", true);
    assert.equal(rows(w, "sleep").length, 0);
    // The worker reports; then the ordinary idle time passes.
    w.workers.byName("Spotify")!.resolve!({ status: "done", summary: "playing Focus." });
    await until(() => engine.workers.running() === 0 && engine.snapshot().delegations[0]!.status !== "running");
    clock.t += 61_000;
    tick();
    await settle();
    assert.equal(live.currentState, "closed", "asleep at the ordinary time after the last report");
    assert.equal(engine.currentPhase, "asleep");
    const sleep = rows<Extract<LedgerRow, { type: "sleep" }>>(w, "sleep");
    assert.equal(sleep.length, 1);
    assert.equal(sleep[0]!.cause, "idle");
    assert.equal(sleep[0]!.farewell, undefined, "no farewell for an idle sleep");
  } finally {
    await engine.stop();
  }
});

test("a new request while a worker runs parks the parent (its workers carry on) and starts the new task; the parent finishes when its worker drains", async () => {
  const w = world();
  const { engine, live, brain } = w;
  try {
    w.workers.script = async () => undefined;
    await split(w);
    await startWorker(w, "Spotify", "play Focus");
    nextUtterance(w);
    delegate(w, "jarhead what time is it", "item_2");
    await settle();
    const parent = engine.snapshot().delegations.find((d) => d.liveId === "item_1")!;
    assert.equal(parent.status, "running", "parked, not cancelled");
    assert.ok(parent.steps.some((s) => s.kind === "note" && /Kevin asked something else; the workers carry on/.test(s.text ?? "")));
    assert.equal(brain.tasks.length, 2, "the new task runs");
    assert.equal(workersOf(w)[0]!.status, "working", "the worker was not cut");
    assert.equal(w.workers.byName("Spotify")!.cancels, 0);
    w.clock.t += 1000;
    w.workers.byName("Spotify")!.resolve!({ status: "done", summary: "playing Focus." });
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_1")!.status !== "running");
    const finished = engine.snapshot().delegations.find((d) => d.liveId === "item_1")!;
    assert.equal(finished.status, "cancelled");
    assert.match(finished.summary ?? "", /the workers carried on/);
    assert.ok(live.commentary.some((c) => /Spotify: playing Focus\./.test(c)), "its line still reached Kevin through the parked parent");
    assert.equal(engine.snapshot().delegations.find((d) => d.liveId === "item_2")!.status, "running");
  } finally {
    await engine.stop();
  }
});

test("one question floor: the first worker's question is spoken with its name, the second is queued with the floor's text and nothing is spoken; Kevin's yes resumes the floor's worker (the main turn is not superseded), its click lands, and the queued question is then spoken with its worker's name", async () => {
  const w = world();
  const { engine, live, hands, brain } = w;
  try {
    const results: Record<string, ToolResult[]> = { Slack: [], Spotify: [] };
    w.workers.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      results[job.brain.name]!.push(r);
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : "failed" };
    };
    await split(w);
    await startWorker(w, "Slack", "send the message", "screen");
    await until(() => results["Slack"]!.length === 1);
    const q1 = results["Slack"]![0]!;
    assert.equal(q1.kind, "needs-confirmation", JSON.stringify(q1));
    assert.doesNotMatch((q1 as { question: string }).question, /Queued/);
    await until(() => workersOf(w)[0]?.status === "awaiting-confirmation");
    await until(() => live.commentary.join(" ").includes("Slack asks:"), 1500);
    assert.equal(engine.workers.floorLane()?.name, "Slack");
    assert.ok(engine.confirmations.pending, "the question is on the root, where the Delegator arms it");

    await startWorker(w, "Spotify", "clear the queue", "screen");
    await until(() => results["Spotify"]!.length === 1);
    const q2 = results["Spotify"]![0]!;
    assert.equal(q2.kind, "needs-confirmation");
    assert.match((q2 as { pendingId: string }).pendingId, /^queued_/);
    // A worker has no worker_wait: the desk's text is rewritten for it — end the turn; Jarhead resumes it on Kevin's yes.
    assert.match((q2 as { question: string }).question, /^Queued behind Slack's question: .* stop and wait \(end your turn; Jarhead resumes you when Kevin answers\), do not retry/);
    assert.doesNotMatch((q2 as { question: string }).question, /worker_wait/);
    await until(() => workersOf(w).find((x) => x.name === "Spotify")?.status === "awaiting-confirmation");
    await settle(700);
    assert.equal(live.commentary.join(" ").split("Slack asks:").length - 1, 1, "one question spoken");
    assert.ok(!live.commentary.join(" ").includes("Spotify asks:"), "the queued question is not spoken over the first");
    assert.equal(hands.named("click").length, 0, "nothing clicked yet");

    // Kevin: "yes". The floor's worker re-runs its tool; the main brain's turn carries on.
    nextUtterance(w);
    delegate(w, "yes", "item_yes");
    await until(() => results["Slack"]!.length === 2);
    assert.equal(results["Slack"]![1]!.kind, "text", JSON.stringify(results["Slack"]![1]));
    assert.equal(hands.named("click").length, 1, "Slack's Send was clicked, once");
    const yes = engine.snapshot().delegations.find((d) => d.liveId === "item_yes")!;
    await until(() => engine.snapshot().delegations.find((d) => d.liveId === "item_yes")!.status === "done");
    assert.match(engine.snapshot().delegations.find((d) => d.liveId === "item_yes")!.summary ?? "", /relayed the yes to Slack/);
    assert.ok(yes);
    assert.equal(brain.cancels, 0, "the main brain's turn was not superseded by a yes meant for a worker");
    assert.equal(engine.snapshot().delegations[0]!.status, "running");
    // The queue moves: Spotify's question is now the floor's, spoken with its name.
    await until(() => live.commentary.join(" ").includes("Spotify asks:"), 1500);
    assert.equal(engine.workers.floorLane()?.name, "Spotify");
    assert.equal(results["Spotify"]!.length, 1, "a yes never consumes another lane's action");
    await until(() => live.commentary.some((c) => /Slack: sent\./.test(c)));
  } finally {
    await engine.stop();
  }
});

test("runnerFor: a worker's lane runner is attached while it works and gone once it ends; an id nobody owns is undefined (the daemon refuses)", async () => {
  const w = world();
  const { engine } = w;
  try {
    w.workers.script = async () => undefined;
    await split(w);
    await startWorker(w, "Spotify", "play Focus");
    const id = workersOf(w)[0]!.id;
    assert.ok(engine.runnerFor(id));
    assert.equal(engine.runnerFor(id)?.attached, true);
    assert.equal(engine.runnerFor("w_nobody"), undefined);
    w.workers.byName("Spotify")!.resolve!({ status: "done", summary: "done." });
    await until(() => workersOf(w)[0]?.status === "done");
    assert.equal(engine.runnerFor(id), undefined, "finished: refused from here on");
  } finally {
    await engine.stop();
  }
});

test("workers off in Settings: worker_start says so and starts nothing; no spare is warmed at wake", async () => {
  const w = world();
  const { engine } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0, workers: false });
    await engine.wake("test");
    assert.equal(w.workers.brains.length, 0, "no spare");
    delegate(w, "jarhead do two things", "item_1");
    await settle();
    const out = await engine.runner.run("worker_start", { name: "Spotify", task: "play Focus" });
    assert.equal(out.result.kind, "error");
    assert.match((out.result as { message: string }).message, /workers are off/);
    assert.equal(workersOf(w).length, 0);
  } finally {
    await engine.stop();
  }
});

// ------------------------------------------------------------------ repairs
// The adversarial review's probes, kept as tests: dictation against a screen worker, a
// MAIN-lane question promoted from the queue, the silence of the busy retry, and the
// pool's edges (a cut floor, the budgets, three waits, Kevin's hands on a free lease,
// an app he switched to, presence, secrets, a spare that never boots, the ear while
// the brain waits on its workers).

const privateEngine = (engine: World["engine"]): { startDictation(): void; stopDictation(r: "said"): void; dictateText(t: string): Promise<boolean> } => engine as unknown as { startDictation(): void; stopDictation(r: "said"): void; dictateText(t: string): Promise<boolean> };

test("dictation holds the screen for as long as it lasts: a screen worker waiting for the lease does not take it after 3 s of Kevin's silence, its app is never fronted under his typing, and the next dictated words land where he was typing", async () => {
  const w = world();
  const { engine, hands, brain, clock } = w;
  try {
    const go = gate();
    const attempts: ToolResult[] = [];
    w.workers.script = async (job) => {
      await go.p;
      attempts.push((await job.runner.run("open_app", { name: "Spotify" })).result);
      return { status: "done", summary: "opened." };
    };
    await split(w);
    await startWorker(w, "Spotify", "play Focus", "screen");
    // The main brain's turn ends (the parent drains behind its worker); Kevin starts dictating into Notes.
    brain.resolve!({ status: "done", summary: "on it." });
    await settle();
    privateEngine(engine).startDictation();
    await until(() => engine.lease.holder === "dictation");
    assert.equal(engine.isDictating, true);
    hands.ops.length = 0;
    go.open();
    await until(() => workersOf(w)[0]?.status === "waiting-screen");
    // Kevin falls silent for longer than LEASE_IDLE_MS mid-dictation: the worker still waits.
    clock.t += 3100;
    await settle(600);
    assert.equal(hands.named("open_app").length, 0, "the worker never took the screen");
    assert.equal(engine.lease.holder, "dictation");
    assert.equal(hands.frontApp, "Notes");
    assert.equal(await privateEngine(engine).dictateText("hello there"), true);
    const typed = hands.posted.filter((p) => p.op === "type");
    assert.equal(typed.length, 1);
    assert.equal(typed[0]!.params["ownDriver"], true);
    assert.equal(hands.frontApp, "Notes", "typed where Kevin was typing");
    // The worker's wait runs out: it reports, and never fronted Spotify.
    clock.t += 8100;
    await until(() => attempts.length === 1);
    assert.equal(attempts[0]!.kind, "error");
    assert.match((attempts[0] as { message: string }).message, /^waiting for the screen: dictation has the screen/);
    assert.equal(hands.named("open_app").length, 0);
    // Dictation ends: the lease is free again.
    privateEngine(engine).stopDictation("said");
    assert.equal(engine.lease.holder, undefined);
  } finally {
    await engine.stop();
  }
});

test("a MAIN-lane question queued behind a worker's is voiced once when promoted — Jarhead's own 'May I …? Say yes.' on the parent — and only then does a yes arm it", async () => {
  const w = world();
  const { engine, live, hands, brain } = w;
  try {
    const slack: ToolResult[] = [];
    w.workers.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      slack.push(r);
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
    };
    await split(w);
    await startWorker(w, "Slack", "send the message", "screen");
    await until(() => slack.length === 1 && workersOf(w)[0]?.status === "awaiting-confirmation");
    await until(() => live.commentary.join(" ").includes("Slack asks:"), 1500);
    // The main brain's own Send: queued behind Slack's, told to wait (it has worker_wait); nothing spoken for it.
    const mine = await engine.runner.run("click_element", { name: "Send" });
    assert.equal(mine.result.kind, "needs-confirmation", JSON.stringify(mine.result));
    assert.match((mine.result as { pendingId: string }).pendingId, /^queued_/);
    assert.match((mine.result as { question: string }).question, /^Queued behind Slack's question: .*\(worker_wait\)/);
    assert.equal(engine.desk.queuedCount, 1);
    await settle(700);
    assert.ok(!live.commentary.some((c) => /May I/.test(c)), "not spoken while Slack's question holds the floor");
    // Kevin's yes: Slack's click lands; the main lane's question is promoted and voiced once, as Jarhead's own.
    nextUtterance(w);
    delegate(w, "yes", "item_yes");
    await until(() => slack.length === 2);
    assert.equal(slack[1]!.kind, "text");
    assert.equal(hands.named("click").length, 1);
    await until(() => live.commentary.some((c) => /May I .*"Send.*\? Say yes\./.test(c)), 1500);
    assert.equal(live.commentary.join(" ").split("May I").length - 1, 1, "voiced once");
    assert.equal(engine.desk.floor?.laneId, "jarhead");
    assert.equal(engine.workers.floorLane(), undefined, "the floor is the main lane's, not a worker's");
    assert.ok(engine.confirmations.pending, "the root holds the spoken question");
    assert.equal(brain.tasks.length, 1, "the first yes was Slack's; the main brain's turn was not touched");
    assert.equal(brain.cancels, 0);
    assert.ok(engine.snapshot().delegations[0]!.steps.some((s) => s.kind === "commentary" && s.worker === "Jarhead" && /May I/.test(s.text ?? "")), "on the parent's timeline, as Jarhead's");
    // Only now does a yes arm it: the main brain gets its confirmation turn.
    nextUtterance(w);
    delegate(w, "yes", "item_yes2");
    await until(() => brain.tasks.length === 2);
    assert.equal(brain.tasks[1]!.confirmation, true);
  } finally {
    await engine.stop();
  }
});

test("a queued MAIN-lane question the ear drops (a reflex the policy wants a yes for, behind a worker's question) leaves the queue: nothing is promoted unspoken after Kevin's yes", async () => {
  const w = world();
  const { engine, live, hands, brain, clock } = w;
  try {
    const slack: ToolResult[] = [];
    w.workers.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      slack.push(r);
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
    };
    await split(w);
    await startWorker(w, "Slack", "send the message", "screen");
    await until(() => slack.length === 1 && workersOf(w)[0]?.status === "awaiting-confirmation");
    // The main brain's turn ends (the parent drains); the ear is Kevin's. "type hello" with 1Password in front: the policy asks, behind Slack's question.
    brain.resolve!({ status: "done", summary: "on it." });
    await settle();
    hands.frontApp = "1Password";
    const fired: { ok: boolean; dropped?: string }[] = [];
    engine.on("reflex.fired", (row) => fired.push(row));
    engine.ear("type hello", true, 1, clock.t);
    await until(() => fired.length === 1);
    assert.equal(fired[0]!.ok, false);
    assert.match(fired[0]!.dropped ?? "", /needs confirmation/);
    assert.equal(engine.desk.queuedCount, 0, "the dropped question left the queue");
    assert.equal(hands.named("type").length, 0);
    hands.frontApp = "Notes";
    // Kevin's yes: Slack's click lands and nothing is promoted — no unspoken question waits for a stray yes.
    nextUtterance(w);
    delegate(w, "yes", "item_yes");
    await until(() => slack.length === 2);
    await settle(700);
    assert.equal(engine.desk.floor, undefined);
    assert.equal(engine.confirmations.pending, undefined);
    assert.ok(!live.commentary.some((c) => /May I/.test(c)));
  } finally {
    await engine.stop();
  }
});

test("Kevin's hands win, silently: the helper's busy refusals mid-retry are not steps — one `key` step, one note saying how long the hands waited, no error step, one delegation.step row for the key; a wait that runs out records the last refusal once", async () => {
  const w = world();
  const { engine, hands, clock } = w;
  type StepRow = { type: "delegation.step"; step: { kind: string; text?: string; tool?: { name: string } } };
  try {
    await split(w);
    hands.kevinActed();
    const pressing = engine.runner.run("key", { text: "Return" });
    await settle(400);
    assert.ok(hands.named("key").length >= 2, "refused more than once meanwhile");
    clock.t += 1600;
    const out = await pressing;
    assert.equal(out.result.kind, "text");
    const steps = engine.snapshot().delegations[0]!.steps;
    assert.equal(steps.filter((s) => s.tool?.name === "key").length, 1, "one step for the key");
    assert.equal(steps.find((s) => s.tool?.name === "key")!.tool?.ok, true);
    assert.equal(steps.filter((s) => s.kind === "error").length, 0, "no busy rows on the timeline");
    assert.equal(steps.filter((s) => s.kind === "note" && /^waited \d+ ms for Kevin's hands$/.test(s.text ?? "")).length, 1);
    assert.equal(rows<StepRow>(w, "delegation.step").filter((r) => r.step.tool?.name === "key").length, 1, "one ledger row for the key");
    assert.equal(rows<StepRow>(w, "delegation.step").filter((r) => r.step.kind === "error").length, 0);

    // Kevin keeps typing past the whole wait: the last refusal is the answer, recorded once, and no note.
    Object.defineProperty(hands, "kevinAt", { get: () => clock.t, configurable: true });
    const second = engine.runner.run("key", { text: "Return" });
    await settle(300);
    clock.t += 8100;
    const late = await second;
    assert.equal(late.result.kind, "error");
    assert.match((late.result as { message: string }).message, /busy/);
    const after = engine.snapshot().delegations[0]!.steps;
    assert.equal(after.filter((s) => s.kind === "error").length, 1, "the final refusal, once");
    assert.equal(after.filter((s) => s.kind === "note" && /waited/.test(s.text ?? "")).length, 1, "no second note");
  } finally {
    await engine.stop();
  }
});

test("worker.stop on a worker awaiting a yes: its question leaves the floor, the next queued question is promoted and spoken with its name, and Kevin's yes then lands on that one only", async () => {
  const w = world();
  const { engine, live, hands } = w;
  try {
    const results: Record<string, ToolResult[]> = { Slack: [], Spotify: [] };
    w.workers.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      results[job.brain.name]!.push(r);
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : "sent." };
    };
    await split(w);
    await startWorker(w, "Slack", "send the message", "screen");
    await until(() => workersOf(w).find((x) => x.name === "Slack")?.status === "awaiting-confirmation");
    await startWorker(w, "Spotify", "clear the queue", "screen");
    await until(() => workersOf(w).find((x) => x.name === "Spotify")?.status === "awaiting-confirmation");
    await until(() => live.commentary.join(" ").includes("Slack asks:"), 1500);
    assert.ok(!live.commentary.join(" ").includes("Spotify asks:"));
    const slackId = workersOf(w).find((x) => x.name === "Slack")!.id;
    await engine.command({ type: "worker.stop", workerId: slackId });
    await until(() => live.commentary.join(" ").includes("Spotify asks:"), 1500);
    assert.equal(workersOf(w).find((x) => x.name === "Slack")!.status, "cancelled");
    assert.equal(engine.workers.floorLane()?.name, "Spotify");
    assert.equal(engine.desk.queuedCount, 0);
    assert.ok(live.commentary.some((c) => /Slack stopped\./.test(c)));
    // Kevin's yes is Spotify's now; Slack's Send never lands.
    nextUtterance(w);
    delegate(w, "yes", "item_yes");
    await until(() => results["Spotify"]!.length === 2);
    assert.equal(results["Spotify"]![1]!.kind, "text");
    assert.equal(results["Slack"]!.length, 1);
    assert.equal(hands.named("click").length, 1, "one click: Spotify's");
    await until(() => live.commentary.some((c) => /Spotify: sent\./.test(c)));
  } finally {
    await engine.stop();
  }
});

test("budgets: a worker past its seconds is cut at its next step and one past its steps at the step after — failed, one line each, its brain cancelled once, its process stopped", async () => {
  const w = world();
  const { engine, live, clock } = w;
  try {
    w.workers.script = async (job) => {
      for (let i = 0; i < 6; i++) {
        if (job.task.signal.aborted) return { status: "cancelled" };
        clock.t += 6_000;
        await job.runner.run("frontmost_app", {});
      }
      return { status: "done", summary: "six looks." };
    };
    await split(w);
    const started = await engine.runner.run("worker_start", { name: "Spotify", task: "play Focus", budget: { seconds: 10 } });
    assert.equal(started.result.kind, "text");
    await until(() => workersOf(w).find((x) => x.name === "Spotify")?.status === "failed");
    const spotify = workersOf(w).find((x) => x.name === "Spotify")!;
    assert.equal(spotify.detail, "I ran out of time after 10 seconds");
    assert.equal(spotify.steps, 2, "the second look, at 12 s, was one too many");
    await until(() => live.commentary.some((c) => /Spotify failed: I ran out of time after 10 seconds/.test(c)));
    assert.equal(live.commentary.filter((c) => /Spotify failed/.test(c)).length, 1);
    assert.equal(w.workers.byName("Spotify")!.cancels, 1);
    assert.equal(w.workers.byName("Spotify")!.stops, 1);

    // Steps: a budget of two tool calls; the third ends it.
    w.workers.script = async (job) => {
      for (let i = 0; i < 6; i++) {
        if (job.task.signal.aborted) return { status: "cancelled" };
        await job.runner.run("frontmost_app", {});
      }
      return { status: "done", summary: "six looks." };
    };
    await engine.runner.run("worker_start", { name: "Slack", task: "tell Ben", budget: { steps: 2 } });
    await until(() => workersOf(w).find((x) => x.name === "Slack")?.status === "failed");
    const slack = workersOf(w).find((x) => x.name === "Slack")!;
    assert.equal(slack.detail, "I stopped after 2 tool calls without finishing");
    assert.equal(slack.steps, 3);
    await until(() => live.commentary.some((c) => /Slack failed: I stopped after 2 tool calls/.test(c)));
    assert.equal(live.commentary.filter((c) => /Slack failed/.test(c)).length, 1);
    assert.equal(w.workers.byName("Slack")!.cancels, 1);
    assert.equal(w.workers.byName("Slack")!.stops, 1);
  } finally {
    await engine.stop();
  }
});

test("three consecutive waits for the screen fail a worker: 'could not get the screen', one line, its brain cancelled once", async () => {
  const w = world();
  const { engine, live, hands, clock } = w;
  try {
    let attempts = 0;
    const answers: ToolResult[] = [];
    w.workers.script = async (job) => {
      for (let i = 0; i < 5; i++) {
        if (job.task.signal.aborted) return { status: "cancelled" };
        attempts++;
        const r = (await job.runner.run("key", { text: "space" })).result;
        answers.push(r);
        if (r.kind === "text") return { status: "done", summary: "pressed." };
      }
      return { status: "failed", error: "gave up" };
    };
    await split(w);
    // Jarhead's own hands hold the screen for the whole test: one key held in flight on the helper
    // (a holder that merely fell silent would hand over after LEASE_IDLE_MS; one mid-op never does).
    hands.hold = "key";
    const pressing = engine.runner.run("key", { text: "Return" });
    await until(() => hands.named("key").length === 1);
    assert.equal(engine.lease.holder, "jarhead");
    await startWorker(w, "Slack", "tell Ben", "screen");
    for (let n = 1; n <= 3; n++) {
      await until(() => attempts === n && workersOf(w)[0]?.status === "waiting-screen");
      clock.t += 8_100;
      await until(() => answers.length === n);
      assert.equal(answers[n - 1]!.kind, "error", JSON.stringify(answers[n - 1]));
      assert.match((answers[n - 1] as { message: string }).message, /^waiting for the screen: jarhead has the screen/);
    }
    await until(() => workersOf(w)[0]?.status === "failed");
    assert.equal(workersOf(w)[0]!.detail, "could not get the screen");
    await until(() => live.commentary.some((c) => /Slack failed: could not get the screen/.test(c)));
    assert.equal(live.commentary.filter((c) => /Slack failed/.test(c)).length, 1);
    assert.equal(w.workers.byName("Slack")!.cancels, 1);
    await settle(50);
    assert.equal(attempts, 3, "the fourth call never came: the worker was cut");
    assert.equal(engine.lease.holder, "jarhead", "Jarhead's hands kept the screen throughout");
    hands.release();
    assert.equal((await pressing).result.kind, "text");
  } finally {
    hands.release();
    await engine.stop();
  }
});

test("Kevin typing keeps a screen worker off a FREE lease until his quiet window, with the rail's hourglass meanwhile; it acts once he stops", async () => {
  const w = world();
  const { engine, hands, brain, clock } = w;
  try {
    const go = gate();
    let result: ToolResult | undefined;
    w.workers.script = async (job) => {
      await go.p;
      result = (await job.runner.run("key", { text: "space" })).result;
      return { status: "done", summary: "pressed play." };
    };
    await split(w);
    await startWorker(w, "Spotify", "play Focus", "screen");
    brain.resolve!({ status: "done", summary: "on it." });
    await settle();
    assert.equal(engine.lease.holder, undefined, "the lease is free");
    hands.kevinActed();
    hands.ops.length = 0;
    go.open();
    await until(() => workersOf(w)[0]?.status === "waiting-screen", 1500);
    assert.match(workersOf(w)[0]!.detail ?? "", /^waiting for the screen/);
    await settle(300);
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 0, "nothing posted while Kevin types");
    assert.equal(engine.lease.holder, undefined);
    assert.ok(hands.named("user_idle").length >= 1, "the gate read user_idle on the acting helper");
    clock.t += 1600;
    await until(() => result !== undefined, 2000);
    assert.equal(result!.kind, "text", JSON.stringify(result));
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 1, "landed once, after the quiet window");
    await until(() => workersOf(w)[0]?.status === "done");
  } finally {
    await engine.stop();
  }
});

test("STALE_FOCUS: an app Kevin switched to himself is never covered — a screen worker whose app is behind it is not re-fronted (no focus_app) and answers 'waiting for the screen: Kevin is using <app>'", async () => {
  const w = world();
  const { engine, hands, brain, clock } = w;
  try {
    const g1 = gate();
    let second: ToolResult | undefined;
    w.workers.script = async (job) => {
      await job.runner.run("open_app", { name: "Spotify" });
      await g1.p;
      second = (await job.runner.run("key", { text: "space" })).result;
      return { status: "done", summary: "played." };
    };
    await split(w);
    await startWorker(w, "Spotify", "play Focus", "screen");
    // The main brain's turn ends: the worker takes the screen and fronts Spotify.
    brain.resolve!({ status: "done", summary: "on it." });
    await until(() => hands.named("open_app").length === 1);
    assert.equal(hands.frontApp, "Spotify");
    // Kevin asks something else; Jarhead's hands take the lease (after MIN_HOLD) and work in Notes; that turn ends.
    nextUtterance(w);
    delegate(w, "jarhead what is in my notes", "item_2");
    await settle();
    clock.t += 1600;
    const focused = await engine.runner.run("focus_app", { name: "Notes" });
    assert.equal(focused.result.kind, "text");
    assert.equal(engine.lease.holder, "jarhead");
    brain.resolve!({ status: "done", summary: "notes." });
    await settle();
    assert.equal(engine.lease.holder, undefined);
    // Kevin himself switches to Mail — no lane brought it forward.
    hands.frontApp = "Mail";
    hands.ops.length = 0;
    g1.open();
    await until(() => workersOf(w)[0]?.status === "waiting-screen", 1500);
    clock.t += 8_100;
    await until(() => second !== undefined, 2000);
    assert.equal(second!.kind, "error");
    assert.match((second as { message: string }).message, /^waiting for the screen: Kevin is using Mail/);
    assert.equal(hands.named("focus_app").length, 0, "Spotify was not pulled in front of him");
    assert.equal(hands.frontApp, "Mail");
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 0);
  } finally {
    await engine.stop();
  }
});

test("presence: a worker's Send in Mail while Kevin is away is held (HOLD_ID) — the worker fails with the presence line, nothing waits for a yes, no grant row", async () => {
  const w = world();
  const { engine, live, hands, clock } = w;
  try {
    let answer: ToolResult | undefined;
    w.workers.script = async (job) => {
      answer = (await job.runner.run("click_element", { name: "Send" })).result;
      return { status: "done", summary: answer.kind === "needs-confirmation" ? answer.question : "sent." };
    };
    await split(w);
    hands.frontApp = "Mail";
    // Kevin has not spoken to Jarhead for over a minute.
    clock.t += 61_000;
    await startWorker(w, "Mail", "send the draft", "screen");
    await until(() => answer !== undefined, 2000);
    assert.equal(answer!.kind, "needs-confirmation", JSON.stringify(answer));
    assert.equal((answer as { pendingId: string }).pendingId, "hold");
    assert.match((answer as { question: string }).question, /Not now: .*I'll do this when you're back at the Mac/);
    await until(() => workersOf(w)[0]?.status === "failed");
    assert.match(workersOf(w)[0]!.detail ?? "", /^Not now/);
    assert.equal(engine.confirmations.pending, undefined, "a hold is not a question");
    assert.equal(engine.desk.floor, undefined);
    assert.equal(rows(w, "grant").length, 0);
    await until(() => live.commentary.some((c) => /^Mail: Not now/.test(c)));
    assert.equal(hands.named("click").length, 0);
  } finally {
    await engine.stop();
  }
});

test("a worker's detail and its spoken line are struck of secrets: a token in its summary reaches the worker row, the snapshot, Kevin's line and worker_wait redacted", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    // Assembled at run time so the literal never sits in the tree: GitHub's push protection reads a
    // "xoxb-…" string as a live Slack token even inside a redaction test. The redactor is shape-based
    // and sees the same string either way.
    const token = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
    w.workers.script = async () => ({ status: "done", summary: `posted with ${token}.` });
    await split(w);
    await startWorker(w, "Slack", "tell Ben");
    await until(() => workersOf(w)[0]?.status === "done");
    const done = workersOf(w)[0]!;
    assert.doesNotMatch(done.detail ?? "", /xoxb-/);
    assert.match(done.detail ?? "", /\[redacted secret\]/);
    const row = rows<WorkerRow>(w, "worker").find((r) => r.worker.status === "done")!;
    assert.doesNotMatch(row.worker.detail ?? "", /xoxb-/);
    await until(() => live.commentary.some((c) => /^Slack: posted with/.test(c)));
    assert.ok(live.commentary.every((c) => !/xoxb-/.test(c)));
    assert.ok(live.commentary.some((c) => /Slack: posted with \[redacted secret\]\./.test(c)));
    const waited = await engine.runner.run("worker_wait", { name: "Slack" });
    assert.doesNotMatch((waited.result as { text: string }).text, /xoxb-/);
  } finally {
    await engine.stop();
  }
});

test("the spare's boot fails while the first worker_start waits on it: the worker fails 'its brain did not start', runnerFor never knew the spare, no second spare this wake — and the next wake warms one again (a failed boot is not for the daemon's life)", async () => {
  const w = world();
  const { engine, live } = w;
  try {
    let boot!: (r: { ready: boolean; detail: string }) => void;
    const booting = new Promise<{ ready: boolean; detail: string }>((r) => (boot = r));
    w.workers.startResult = async (b) => (b === w.workers.brains[0] ? booting : { ready: true, detail: "fake worker" });
    w.workers.script = async () => ({ status: "done", summary: "done." });
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    await until(() => w.workers.brains.length === 1);
    const spareId = engine.workers.spareId!;
    assert.ok(spareId);
    assert.equal(engine.runnerFor(spareId), undefined, "a spare's bridge can never act");
    delegate(w, "jarhead play focus and tell ben", "item_1");
    await settle();
    const started = await engine.runner.run("worker_start", { name: "Spotify", task: "play Focus" });
    assert.equal(started.result.kind, "text");
    assert.equal(workersOf(w)[0]!.status, "starting");
    assert.equal(engine.runnerFor(spareId)?.attached, false, "not until its brain is up");
    boot({ ready: false, detail: "codex is not logged in" });
    await until(() => workersOf(w)[0]?.status === "failed");
    assert.equal(workersOf(w)[0]!.detail, "its brain did not start: codex is not logged in");
    await until(() => live.commentary.some((c) => /Spotify failed: codex is not logged in/.test(c)));
    assert.equal(engine.runnerFor(spareId), undefined);
    assert.equal(w.workers.brains[0]!.stops, 1);
    // No second spare this wake; the next worker boots its own brain and works.
    assert.equal(engine.workers.spareId, undefined);
    const again = await engine.runner.run("worker_start", { name: "Slack", task: "tell Ben" });
    assert.equal(again.result.kind, "text");
    await until(() => workersOf(w).find((x) => x.name === "Slack")?.status === "done");
    assert.equal(w.workers.brains.length, 2);
    // Sleep, wake: a spare is warmed again.
    await engine.sleep();
    await engine.wake("test");
    await until(() => w.workers.brains.length === 3);
    assert.ok(engine.workers.spareId);
  } finally {
    await engine.stop();
  }
});

test("the ear is free while the main brain merely waits on its workers (worker_wait): a spoken reflex scrolls; held again once the wait returns", async () => {
  const w = world();
  const { engine, hands, clock } = w;
  try {
    w.workers.script = async () => undefined;
    await split(w);
    await startWorker(w, "Spotify", "play Focus");
    hands.ops.length = 0;
    // Held: the main brain's turn runs.
    engine.ear("scroll down", true, 1, clock.t);
    await settle(100);
    assert.equal(hands.named("scroll").length, 0, "held while the brain's turn runs");
    // The brain blocks in worker_wait: its hands are still; the ear is Kevin's.
    const waiting = engine.runner.run("worker_wait", { name: "Spotify", timeout: 30 });
    await settle(20);
    assert.equal(engine.runner.waitingOnWorkers, true);
    engine.ear("scroll down", true, 2, clock.t);
    await until(() => hands.named("scroll").length === 1, 1500);
    w.workers.byName("Spotify")!.resolve!({ status: "done", summary: "playing." });
    const out = await waiting;
    assert.equal(out.result.kind, "text");
    assert.equal(engine.runner.waitingOnWorkers, false);
    engine.ear("scroll down", true, 3, clock.t);
    await settle(100);
    assert.equal(hands.named("scroll").length, 1, "held again: the brain's turn is back");
  } finally {
    await engine.stop();
  }
});

test("Jarhead's hands never land mid-op — but a worker's op that outlasts MAIN_LEASE_WAIT_MS does not keep the screen: the lease is cut and taken with a note, and the worker's next tool waits on Jarhead instead of landing between his hands", async () => {
  const w = world();
  const { engine, hands, brain, clock } = w;
  try {
    const typed = gate();
    let second: ToolResult | undefined;
    w.workers.script = async (job) => {
      await job.runner.run("type", { text: "a very long paragraph" });
      typed.open();
      second = (await job.runner.run("key", { text: "Return" })).result;
      return { status: "done", summary: "typed." };
    };
    await split(w);
    hands.hold = "type";
    await startWorker(w, "Slack", "tell Ben", "screen");
    // The main brain's turn ends: the worker takes the screen; its type is in flight on the helper for the whole wait.
    brain.resolve!({ status: "done", summary: "on it." });
    await until(() => hands.named("type").length === 1);
    const slackId = workersOf(w)[0]!.id;
    assert.equal(engine.lease.holder, slackId);
    // Kevin asks something else; Jarhead's hands want the screen.
    nextUtterance(w);
    delegate(w, "jarhead what is in my notes", "item_2");
    await settle();
    assert.equal(brain.tasks.length, 2);
    const focusing = engine.runner.run("focus_app", { name: "Notes" });
    clock.t += 1600;
    await settle(320);
    assert.equal(hands.named("focus_app").length, 0, "never mid-op, MIN_HOLD or not");
    // The op outlasts the wait: the lease is cut and taken.
    clock.t += MAIN_LEASE_WAIT_MS;
    const focused = await focusing;
    assert.equal(focused.result.kind, "text");
    assert.equal(engine.lease.holder, "jarhead");
    const parent2 = engine.snapshot().delegations.find((d) => d.liveId === "item_2")!;
    assert.ok(parent2.steps.some((s) => s.kind === "note" && new RegExp(`^took the screen from ${slackId} \\(${slackId} is mid-action\\)$`).test(s.text ?? "")), JSON.stringify(parent2.steps.filter((s) => s.kind === "note")));
    // The worker's type completes; its next tool waits on Jarhead rather than landing between his hands.
    hands.release();
    await typed.p;
    await until(() => workersOf(w)[0]?.status === "waiting-screen", 1500);
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 0);
    // Jarhead's turn ends: the worker has the screen again and its key lands.
    brain.resolve!({ status: "done", summary: "your notes." });
    await until(() => second !== undefined, 2000);
    assert.equal(second!.kind, "text", JSON.stringify(second));
    assert.equal(hands.posted.filter((p) => p.op === "key").length, 1);
  } finally {
    hands.release();
    await engine.stop();
  }
});
