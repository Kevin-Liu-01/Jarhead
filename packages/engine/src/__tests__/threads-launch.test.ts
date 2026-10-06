import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "@jarhead/core";
import { AgentRegistry, type AgentConnector } from "@jarhead/agents";
import { ConfirmationDesk, ConfirmationState, FocusLease, type ToolResult } from "@jarhead/hands";
import { specByName, type Brain, type BrainResult, type BrainSink, type BrainTask, type ToolRunner } from "@jarhead/brain";
import { MAIN_THREAD_ID, type Thread } from "@jarhead/protocol";
import { ThreadTable } from "../threads/table.ts";
import { THREAD_IDLE_END_MS, ThreadScheduler, type ThreadBrainFactory, type ThreadParent } from "../threads/scheduler.ts";
import { FOCUS_TOOLS, LANE_REFUSAL, needsFocus } from "../threads/runner.ts";
import { confirmationResume, threadBrief } from "../threads/lines.ts";
import { RecordingHands, delegate, nextUtterance, settle, threadNameOf, until, world, type World } from "./world.ts";

/**
 * W1-5, the launch audit's threads findings as pins (scratchpad/launch/threads): a thread's
 * question is re-asked when it vanished with no word from Kevin or went stale, and ends
 * `stopped` with a line after two re-asks (TH-1); one he heard and then answered no to, or
 * talked past, is never asked again behind his back, so a later "okay" sends nothing (the
 * W1-5 review's TH-1 no); an idle end is `stopped`, never `done`; the confirmation turn carries
 * Kevin's own words, from the Delegator's yes and the typed yes (RAIL-2);
 * the main brain reaches its threads by name from any later request (TH-3) and `thread_wait`
 * all reports a finished sibling (TH-7); the background lane leaves the front browser tab
 * alone (TH-4); a step budget of N lets N calls act and never refuses the next turn's eyes
 * (TH-5); a stopped main turn's screen tool never acts, and a lease cut with the task live is
 * not a stop (F-CODEX-AFTERSTOP); inner shells, groups, substitutions and a shell on stdin are
 * screen work (RAIL-8); and two quick follow-ups run one turn at a time on a brain that, like
 * every real one, refuses a second `handle` (TH-2, re-run: red at HEAD, so the verbs queue).
 *
 * The scheduler half runs over a fake brain that refuses an overlapping `handle` exactly as
 * codex.ts, claude.ts, compatible.ts and anthropic.ts do ("already handling a task"), a real
 * ConfirmationDesk / FocusLease / Ledger in a temp dir and a clock the test moves. Nothing
 * here touches ~/.jarhead, a helper, a socket or the network.
 */

interface FB {
  name: string;
  readonly runner: ToolRunner;
  tasks: BrainTask[];
  refused: number;
  cancels: number;
  stops: number;
  resolve: ((r: BrainResult) => void) | undefined;
}

type Script = (job: { brain: FB; task: BrainTask; sink: BrainSink; runner: ToolRunner }) => Promise<BrainResult | undefined>;

const fakeConnector: AgentConnector = {
  kind: "sessions",
  health: async () => ({ kind: "sessions", ok: true, detail: "ok" }),
  list: async () => [],
  send: async () => ({ accepted: true }),
  read: async () => "",
};

function harness(o: { deaf?: boolean; supersedeWaitMs?: number; letGoMs?: number; eyes?: boolean } = {}) {
  const clock = { t: 1_757_500_000_000 };
  const now = (): number => clock.t;
  const dir = mkdtempSync(join(tmpdir(), "jh-w15-threads-"));
  const ledger = new Ledger(dir);
  const hands = new RecordingHands();
  const handsBg = new RecordingHands();
  hands.now = now;
  handsBg.now = now;
  handsBg.shareScreenWith(hands);
  const root = new ConfirmationState(3 * 60_000, now);
  const brains: FB[] = [];
  const says: string[] = [];
  let scheduler!: ThreadScheduler;
  const desk = new ConfirmationDesk(root, (name, q) => void scheduler.speakQuestion(name, q), now);
  const lease = new FocusLease({ hands, now, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
  const ctl: { script: Script | undefined } = { script: undefined };
  const factory: ThreadBrainFactory = (spec) => {
    const fb: FB = { name: "", runner: spec.runner, tasks: [], refused: 0, cancels: 0, stops: 0, resolve: undefined };
    brains.push(fb);
    let current: BrainTask | undefined;
    const brain: Brain = {
      kind: "fake-thread",
      start: async () => ({ ready: true, detail: "fake thread" }),
      handle: (task, sink) => {
        // Every real brain: one task at a time.
        if (current) {
          fb.refused++;
          return Promise.resolve({ status: "failed", error: "already handling a task" });
        }
        current = task;
        return new Promise<BrainResult>((resolve) => {
          fb.name = threadNameOf(task) ?? fb.name;
          fb.tasks.push(task);
          fb.runner.attach(sink, task);
          let settled = false;
          const done = (r: BrainResult): void => {
            if (settled) return;
            settled = true;
            if (current === task) {
              current = undefined;
              fb.runner.attach(undefined);
            }
            resolve(r);
          };
          fb.resolve = done;
          // A real brain lets go a beat after cancel (turn/interrupt round trip: ~35 ms idle, seconds under load).
          if (!o.deaf) task.signal.addEventListener("abort", () => setTimeout(() => done({ status: "cancelled" }), o.letGoMs ?? 40), { once: true });
          const s = ctl.script;
          if (s) void s({ brain: fb, task, sink, runner: fb.runner }).then((r) => r && done(r)).catch((e: unknown) => done({ status: "failed", error: (e as Error).message }));
        });
      },
      cancel: async () => {
        fb.cancels++;
      },
      stop: async () => {
        fb.stops++;
      },
    };
    return brain;
  };
  const agents = new AgentRegistry([fakeConnector], 0);
  const table = new ThreadTable({ now });
  table.started({ id: MAIN_THREAD_ID, name: "Jarhead", lane: "voice", status: "idle", task: "", apps: [], startedAt: clock.t, updatedAt: clock.t, turns: 0, steps: 0, waits: 0, budget: { steps: 40, seconds: 300 }, canSay: true, canStop: true });
  const parentA: ThreadParent = { id: "dlg_A", liveId: "item_1", request: "tell ben on slack i'm late and play focus on spotify", kevinDialogue: "tell ben on slack i'm late and play focus on spotify", offsetMs: 1000, threadId: MAIN_THREAD_ID, depth: 0 };
  let parent = parentA;
  scheduler = new ThreadScheduler({
    now,
    ledger,
    desk,
    lease,
    hands: { focus: hands, background: handsBg },
    runnerOptions: () => ({ agents, stateDir: dir, now }),
    toolsetOptions: () => ({ now }),
    makeBrain: () => factory,
    parentFor: () => parent,
    voice: () => ({ splitLine: () => undefined, threadSay: (_p, _n, text) => says.push(text) }),
    enabled: () => true,
    onChange: () => undefined,
    table,
    coalesceMs: 30,
    warmThreads: () => 0,
    eyes: o.eyes ?? false,
    supersedeWaitMs: o.supersedeWaitMs,
  });
  return {
    scheduler,
    table,
    ledger,
    clock,
    hands,
    handsBg,
    desk,
    root,
    lease,
    brains,
    says,
    ctl,
    parentA,
    setParent: (p: ThreadParent) => (parent = p),
    byName: (n: string) => brains.find((b) => b.name === n),
    spawned: (): readonly Thread[] => scheduler.threads().filter((t) => t.id !== MAIN_THREAD_ID),
    task: (delegationId: string): BrainTask => ({ delegationId, request: "x", dialogue: "", confirmation: false, offsetMs: 0, signal: new AbortController().signal }),
  };
}

type H = ReturnType<typeof harness>;

const text = (r: { kind: string }): string => (r as { text?: string; message?: string }).text ?? (r as { message?: string }).message ?? "";

/** Kevin's request reaching Jarhead, as the Delegator records it: a main `delegation.created` row with his words. */
let dlgSeq = 0;
function kevinSays(h: H, request: string): void {
  const at = h.clock.t;
  h.ledger.append({ at, type: "delegation.created", delegation: { id: `dlg_k${++dlgSeq}`, liveId: `item_k${dlgSeq}`, createdAt: at, offsetMs: 0, request, status: "running", steps: [], timings: { delegatedAt: at } } });
}

/** Slack on the screen lane clicks Send: the gate asks, the turn ends on the question, the question holds the floor. */
async function slackAsks(h: H): Promise<string> {
  h.ctl.script = async (job) => {
    const r = (await job.runner.run("click_element", { name: "Send" })).result;
    return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : `failed: ${text(r)}` };
  };
  h.scheduler.start(h.parentA, { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
  await until(() => h.spawned()[0]?.status === "waiting-kevin");
  assert.equal(h.desk.floor?.name, "Slack", "Slack's question holds the floor");
  return h.spawned()[0]!.id;
}

// ------------------------------------------------------------- TH-1: questions re-ask

test("TH-1 re-ask: a question that leaves the root with no word from Kevin since (only his late yes) is asked again at the next tick on the floor ('Slack still asks: …'), and his next yes lands the click", async () => {
  const h = harness();
  const id = await slackAsks(h);
  // His yes came after the root's TTL: the Delegator's arm finds it expired and the question leaves the root.
  kevinSays(h, "yes");
  h.desk.dropQuestion();
  assert.equal(h.desk.floor, undefined);
  h.scheduler.tick();
  assert.equal(h.desk.floorLane(), id, "re-asked on the floor");
  assert.match(h.says.at(-1) ?? "", /^Slack still asks: /);
  assert.equal(h.table.get(id)!.status, "waiting-kevin");
  // His yes: the Delegator arms the root and resumes the floor's thread.
  assert.ok(h.root.arm() !== undefined, "the re-asked question is armable");
  await h.scheduler.resume(id);
  await until(() => h.table.get(id)!.status === "done");
  assert.equal(h.hands.named("click").length, 1, "the click landed on the yes");
  h.scheduler.dispose();
});

test("TH-1 stale: a question left on the floor past the root's TTL is re-asked before it lapses, so a yes four minutes later still lands (never a main-brain task)", async () => {
  const h = harness();
  const id = await slackAsks(h);
  h.clock.t += 4 * 60_000;
  h.scheduler.tick();
  assert.equal(h.desk.floorLane(), id);
  assert.match(h.says.at(-1) ?? "", /^Slack still asks: /);
  assert.ok(h.root.arm() !== undefined, "the yes arms: the question on the root is fresh");
  await h.scheduler.resume(id);
  await until(() => h.table.get(id)!.status === "done");
  assert.equal(h.hands.named("click").length, 1);
  h.scheduler.dispose();
});

test("TH-1 limit: after two re-asks a question that vanishes again ends the thread 'stopped' with a line saying how to ask again; its lane and the floor are freed", async () => {
  const h = harness();
  const id = await slackAsks(h);
  for (let i = 0; i < 2; i++) {
    h.desk.dropQuestion();
    h.scheduler.tick();
    assert.equal(h.desk.floorLane(), id, `re-ask ${i + 1}`);
  }
  h.desk.dropQuestion();
  h.scheduler.tick();
  const t = h.table.get(id)!;
  assert.equal(t.status, "stopped");
  assert.equal(h.says.filter((s) => s.startsWith("Slack still asks")).length, 2);
  assert.equal(h.says.at(-1), "Slack stopped with no answer. Ask me again to retry.");
  assert.equal(h.desk.floor, undefined);
  assert.equal(h.hands.named("click").length, 0, "nothing was sent");
  await until(() => h.byName("Slack")!.stops === 1);
  h.scheduler.dispose();
});

test("TH-1 no: Kevin says 'no, don't send it' and the question leaves the root with it; the tick never asks it again: Slack stops ('Slack stopped.', Kevin said no), and his later 'okay' arms nothing and sends nothing", async () => {
  const h = harness();
  const id = await slackAsks(h);
  // The Delegator records his words, then drops the question (a request that is not a yes).
  kevinSays(h, "no, don't send it");
  h.desk.dropQuestion();
  h.scheduler.tick();
  h.clock.t += 2_000;
  h.scheduler.tick();
  const t = h.table.get(id)!;
  assert.equal(t.status, "stopped");
  assert.equal(t.detail, "Kevin said no");
  assert.equal(h.says.at(-1), "Slack stopped.");
  assert.ok(!h.says.some((x) => x.startsWith("Slack still asks")), "asked again right after Kevin said no");
  assert.equal(h.desk.floor, undefined);
  kevinSays(h, "okay.");
  assert.equal(h.root.arm(), undefined, "an 'okay' a beat later has nothing to arm");
  assert.equal(h.hands.named("click").length, 0, "nothing was sent");
  h.scheduler.dispose();
});

test("TH-1 moved on: Kevin heard the question, asked for something else, and it left the root; it is not asked again behind his back: Slack ends 'stopped' with a line saying how to ask again", async () => {
  const h = harness();
  const id = await slackAsks(h);
  kevinSays(h, "what's the weather tomorrow");
  h.desk.dropQuestion();
  h.scheduler.tick();
  const t = h.table.get(id)!;
  assert.equal(t.status, "stopped");
  assert.equal(t.detail, "Kevin moved on from its question");
  assert.equal(h.says.at(-1), "Slack stopped. You moved on from its question. Ask me again to retry.");
  assert.ok(!h.says.some((x) => x.startsWith("Slack still asks")));
  assert.equal(h.root.arm(), undefined);
  assert.equal(h.hands.named("click").length, 0);
  h.scheduler.dispose();
});

test("TH-1 queued: Slack's question waited behind Jarhead's own and went with it when Kevin answered Jarhead; he never heard it, so it is asked ('Slack asks: …', not 'still asks') and his yes lands it", async () => {
  const h = harness();
  h.desk.lane("jarhead", "Jarhead").ask('left click on "Delete" in Finder', "left_click", { coordinate: [10, 20] });
  h.ctl.script = async (job) => {
    const r = (await job.runner.run("click_element", { name: "Send" })).result;
    return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : `failed: ${text(r)}` };
  };
  h.scheduler.start(h.parentA, { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
  await until(() => h.spawned()[0]?.status === "waiting-kevin");
  const id = h.spawned()[0]!.id;
  assert.equal(h.desk.floor?.name, "Jarhead", "Slack's question waits behind Jarhead's");
  assert.ok(!h.says.some((x) => x.startsWith("Slack asks")), "a queued question is not spoken");
  // "no" to Jarhead's own question: the Delegator drops it, and the queue with it.
  kevinSays(h, "no");
  h.desk.dropQuestion();
  h.scheduler.tick();
  assert.equal(h.desk.floorLane(), id, "asked on the floor");
  assert.match(h.says.at(-1) ?? "", /^Slack asks: /);
  assert.ok(h.root.arm() !== undefined);
  await h.scheduler.resume(id);
  await until(() => h.table.get(id)!.status === "done");
  assert.equal(h.hands.named("click").length, 1);
  h.scheduler.dispose();
});

test("TH-1 Allow past the TTL: the Console's Allow on an expired question arms nothing, says it is asked again, and asks it; the next Allow lands the click", async () => {
  const h = harness();
  const id = await slackAsks(h);
  h.clock.t += 4 * 60_000;
  const late = await h.scheduler.answerYes(id);
  assert.equal(late.ok, false);
  assert.equal(late.reason, "the question had expired; it is asked again");
  assert.equal(h.desk.floorLane(), id);
  assert.match(h.says.at(-1) ?? "", /^Slack still asks: /);
  assert.equal(h.hands.named("click").length, 0, "an expired yes acted");
  const again = await h.scheduler.answerYes(id);
  assert.equal(again.ok, true, again.reason);
  await until(() => h.table.get(id)!.status === "done");
  assert.equal(h.hands.named("click").length, 1);
  h.scheduler.dispose();
});

test("idle end: a thread paused for THREAD_IDLE_END_MS ends 'stopped' (never 'done'), detail idle, at the tick", async () => {
  const h = harness();
  h.ctl.script = async () => undefined;
  h.scheduler.start(h.parentA, { name: "Spotify", task: "play focus", lane: "background" });
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const id = h.spawned()[0]!.id;
  assert.equal(await h.scheduler.pause(id), true);
  h.clock.t += THREAD_IDLE_END_MS;
  h.scheduler.tick();
  assert.equal(h.table.get(id)!.status, "stopped");
  assert.equal(h.table.get(id)!.detail, "idle");
  h.scheduler.dispose();
});

// ------------------------------------------------------------- RAIL-2: Kevin's words

test("RAIL-2: the confirmation turn carries Kevin's exact words, in the dialogue and in kevinDialogue for the gates; with no words (the Console's Allow) it says yes as before", async () => {
  const h = harness();
  const id = await slackAsks(h);
  h.ctl.script = async () => ({ status: "done", summary: "left it." });
  assert.ok(h.root.arm() !== undefined);
  await h.scheduler.resume(id, { words: "Yeah, no, don't send it" });
  await until(() => h.table.get(id)!.status === "done");
  const turn = h.byName("Slack")!.tasks.at(-1)!;
  assert.equal(turn.confirmation, true);
  assert.ok(turn.dialogue.includes('"Yeah, no, don\'t send it"'), turn.dialogue);
  assert.ok(!/said yes/.test(turn.dialogue), "never a paraphrase of his answer");
  assert.match(turn.dialogue, /If it is not a yes, do not call it/);
  assert.match(turn.kevinDialogue ?? "", /Yeah, no, don't send it$/);
  assert.equal(confirmationResume("Kevin"), "\n\nJarhead (to its thread): Kevin said yes. Call the same tool again with exactly the same arguments, then finish your job.");
  h.scheduler.dispose();
});

// ------------------------------------------------------------- TH-3 / TH-7: names span the conversation

test("TH-3: a thread started by one request is read, waited for and stopped by name by the main brain on the NEXT request (every request is a new delegation)", async () => {
  const h = harness();
  h.ctl.script = async () => undefined;
  const started = await h.scheduler.tool("thread_start", { name: "Slack", task: "tell ben i'm late", lane: "background" }, { task: h.task("item_1") });
  assert.equal(started.kind, "text", text(started));
  await until(() => h.byName("Slack")?.tasks.length === 1);
  h.setParent({ id: "dlg_B", liveId: "item_2", request: "actually don't message ben", kevinDialogue: "actually don't message ben", offsetMs: 9000, threadId: MAIN_THREAD_ID, depth: 0 });
  const read = await h.scheduler.tool("thread_read", { name: "slack" }, { task: h.task("item_2") });
  assert.equal(read.kind, "text", text(read));
  assert.match(text(read), /^Slack: still working/);
  const wait = await h.scheduler.tool("thread_wait", { name: "Slack", timeout: 1 }, { task: h.task("item_2") });
  assert.equal(wait.kind, "text", text(wait));
  const stop = await h.scheduler.tool("thread_stop", { name: "Slack" }, { task: h.task("item_2") });
  assert.equal(stop.kind, "text", text(stop));
  assert.equal(h.spawned()[0]!.status, "stopped");
  // After the end it still reads by name from a later request, and an unknown name says nothing is running by it.
  const after = await h.scheduler.tool("thread_read", { name: "Slack" }, { task: h.task("item_2") });
  assert.match(text(after), /^Slack: stopped/);
  const none = await h.scheduler.tool("thread_stop", { name: "Mail" }, { task: h.task("item_2") });
  assert.equal(none.kind, "error");
  assert.equal(text(none), 'no thread named "Mail" is running');
  h.scheduler.dispose();
});

test("TH-7: thread_wait all reports every thread, including a sibling that already finished", async () => {
  const h = harness();
  h.ctl.script = async (job) => (threadNameOf(job.task) === "Spotify" ? { status: "done", summary: "playing Focus." } : undefined);
  await h.scheduler.tool("thread_start", { name: "Spotify", task: "play focus", lane: "background" }, { task: h.task("item_1") });
  await h.scheduler.tool("thread_start", { name: "Slack", task: "tell ben", lane: "background" }, { task: h.task("item_1") });
  await until(() => h.spawned().find((t) => t.name === "Spotify")?.status === "done");
  const r = await h.scheduler.tool("thread_wait", { name: "all", timeout: 1 }, { task: h.task("item_1") });
  assert.match(text(r), /^Spotify: done/m, text(r));
  assert.match(text(r), /^Slack: still working/m, text(r));
  await h.scheduler.cancelAll("test over");
  h.scheduler.dispose();
});

// ------------------------------------------------------------- TH-4: the background lane and the front tab

test("TH-4: a BACKGROUND thread never changes the front browser tab: browser_navigate is refused with the lane line, which names what is allowed; the main and screen lanes take the lease for it", async () => {
  const h = harness();
  h.hands.frontApp = "Google Chrome";
  let nav: ToolResult | undefined;
  h.ctl.script = async (job) => {
    nav = (await job.runner.run("browser_navigate", { url: "https://weather.example/tomorrow" })).result;
    return { status: "done", summary: "looked it up." };
  };
  h.scheduler.start(h.parentA, { name: "Weather", task: "look up tomorrow's weather", lane: "background" });
  await until(() => h.spawned()[0]?.status === "done");
  const ops = [...h.hands.ops, ...h.handsBg.ops].filter((op) => op.op === "browser_navigate");
  assert.equal(ops.length, 0, "the active tab of Kevin's front Chrome window was not touched");
  assert.equal(nav?.kind, "error");
  assert.equal(text(nav!), LANE_REFUSAL);
  assert.ok(FOCUS_TOOLS.has("browser_navigate"), "the lease's business on the main and screen lanes");
  for (const allowed of ["web_fetch", "web_search", "browser_read", "applescript", "run_shell"]) assert.ok(LANE_REFUSAL.includes(allowed), `the lane line names ${allowed}`);
  assert.ok(!LANE_REFUSAL.includes("browser_*"), "no blanket browser_* in the lane line");
  assert.ok(!/—/.test(LANE_REFUSAL), "no em dash in a line a model reads back");
  assert.match(threadBrief("Weather", "look it up", "background", "what's the weather"), /web_fetch and web_search/);
  const spec = specByName("thread_start")!.description;
  assert.match(spec, /front browser tab/);
  assert.match(spec, /web_fetch and web_search/);
  h.scheduler.dispose();
});

// ------------------------------------------------------------- TH-5: the step budget

test("TH-5: a 2-step budget lets at most 2 tool calls act; the third is refused before it reaches the hands and the thread fails with its line", async () => {
  const h = harness();
  h.ctl.script = async (job) => {
    for (let i = 0; i < 5; i++) {
      if (job.task.signal.aborted) return { status: "cancelled" };
      await job.runner.run("click_element", { name: "Save" });
    }
    return { status: "done", summary: "clicked." };
  };
  h.scheduler.start(h.parentA, { name: "Notes", task: "save it", lane: "screen", budget: { steps: 2 } });
  await until(() => h.spawned()[0]?.status === "failed");
  assert.equal(h.hands.named("click").length, 2, "a third click was posted under a 2-step budget");
  assert.equal(h.spawned()[0]!.detail, "I stopped after 2 tool calls without finishing");
  h.scheduler.dispose();
});

test("TH-5 eyes: a turn that spent exactly its budget (a 1-step thread whose one call asked) leaves the next turn its eyes' shot and its full budget", async () => {
  const h = harness({ eyes: true });
  const id = await (async () => {
    h.ctl.script = async (job) => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : `failed: ${text(r)}` };
    };
    h.scheduler.start(h.parentA, { name: "Slack", task: "send Ben: I'm running late", lane: "screen", budget: { steps: 1 } });
    await until(() => h.spawned()[0]?.status === "waiting-kevin");
    return h.spawned()[0]!.id;
  })();
  const fb = h.byName("Slack")!;
  assert.ok(fb.tasks[0]!.attachments?.some((a) => a.kind === "screen"), "the first turn's eyes");
  assert.ok(h.root.arm() !== undefined);
  await h.scheduler.resume(id);
  await until(() => h.table.get(id)!.status === "done" || h.table.get(id)!.status === "failed");
  assert.equal(h.table.get(id)!.status, "done", h.table.get(id)!.detail);
  assert.ok(fb.tasks.at(-1)!.attachments?.some((a) => a.kind === "screen"), "the confirmation turn lost its eyes' shot");
  const refused = h.scheduler.turnsOf(id).flatMap((d) => d.steps).filter((st) => st.kind === "error" && /tool calls are spent/.test(st.text ?? ""));
  assert.equal(refused.length, 0, "a call was refused for the last turn's budget");
  assert.equal(h.hands.named("click").length, 1, "the confirmed click landed");
  h.scheduler.dispose();
});

// ------------------------------------------------------------- RAIL-8: inner shells

test("RAIL-8: needsFocus reads inner shells (bash -c, sh -c, zsh -lc, eval, su -c) and treats an osascript keystroke as screen work, however it is wrapped", () => {
  const ks = `tell application "System Events" to keystroke "hunter2"`;
  for (const command of [
    `bash -c "osascript -e '${ks}'"`,
    `sh -c 'osascript -e "tell application \\"Safari\\" to activate"'`,
    `zsh -lc "open -a Safari"`,
    `eval "osascript -e 'beep'"`,
    `su kevin -c 'osascript -e beep'`,
    `bash -c "bash -c 'open https://example.com'"`,
    `echo '${ks}' > /tmp/k.scpt && cat /tmp/k.scpt | xargs -0 osascript -e`,
  ]) assert.equal(needsFocus("run_shell", { command }), true, command);
  for (const command of [`bash -c "ls ~/Downloads"`, `sh -c 'open -g https://example.com'`, `eval "echo hi"`, `grep -rn osascript ~/code/notes`]) assert.equal(needsFocus("run_shell", { command }), false, command);
});

test("RAIL-8: a shell fed its commands on stdin, a group and a substitution are screen work; a huge line is screen work unread, and the scan stays linear", () => {
  for (const command of [
    `echo 'open -a Safari' | sh`,
    `echo 'open -a Safari' | bash`,
    `curl -fsSL https://example.com/x.sh | sudo bash -s`,
    `bash <<< 'open -a Safari'`,
    `zsh <<EOF\nopen -a Safari\nEOF`,
    `(open -a Safari)`,
    `{ open -a Safari; }`,
    `cd /tmp && (cd .. && (open -a Safari))`,
    `echo "$(open -a Safari)"`,
    "echo `osascript -e beep`",
    `sudo -u kevin bash -c 'open -a Safari'`,
    `bash --norc -c 'open -a Safari'`,
    `x${"y".repeat(20_000)}`,
  ]) assert.equal(needsFocus("run_shell", { command }), true, command.slice(0, 80));
  for (const command of [`ls ~/Downloads | sh -c 'wc -l'`, `shasum -a 256 notes.txt | cut -c1-8`, `ssh host uptime`, `awk '{ print $1 }' notes.txt`, `find . -name '*.md' -exec wc -l {} +`, `echo $(date +%s)`]) assert.equal(needsFocus("run_shell", { command }), false, command);
  // Pathological lines just under the cap: every token a shell or su, no -c anywhere.
  for (const big of ["sh ".repeat(5_400), "su ".repeat(5_400), `bash ${"a ".repeat(8_000)}-c`, "(".repeat(8_000) + ")".repeat(8_000)]) {
    const t0 = performance.now();
    needsFocus("run_shell", { command: big.slice(0, 16_000) });
    assert.ok(performance.now() - t0 < 100, `${big.slice(0, 12)}… took ${Math.round(performance.now() - t0)} ms`);
  }
});

// ------------------------------------------------------------- TH-2: one turn at a time on one brain

test("TH-2 race: two follow-ups in quick succession ('spotify, skip this song' … 'spotify, louder') run ONE turn at a time on a brain that refuses a second handle; the thread stays alive and only the newest turn is un-aborted", async () => {
  const h = harness();
  h.ctl.script = async () => undefined;
  h.scheduler.start(h.parentA, { name: "Spotify", task: "play focus", lane: "background" });
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const id = h.spawned()[0]!.id;
  const [a, b] = await Promise.all([h.scheduler.followUp(id, "skip this song"), h.scheduler.followUp(id, "louder")]);
  await settle(200);
  const fb = h.byName("Spotify")!;
  assert.equal(a && b, true);
  assert.equal(fb.refused, 0, "a second handle() was issued on the same brain while the first ran");
  assert.notEqual(h.table.get(id)!.status, "failed", h.table.get(id)!.detail);
  assert.equal(fb.tasks.filter((t) => !t.signal.aborted).length, 1, "one live turn");
  assert.equal(fb.tasks.at(-1)!.request, "louder", "the last words win");
  await h.scheduler.cancelAll("test over");
  h.scheduler.dispose();
});

test("TH-2 slow let-go: a brain slower to let go than the supersede bound does not fail the follow-up; the next turn runs once it lets go", async () => {
  const h = harness({ supersedeWaitMs: 50, letGoMs: 250 });
  h.ctl.script = async () => undefined;
  h.scheduler.start(h.parentA, { name: "Spotify", task: "play focus", lane: "background" });
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const id = h.spawned()[0]!.id;
  assert.equal(await h.scheduler.followUp(id, "skip this song"), true);
  await settle(100);
  assert.notEqual(h.table.get(id)!.status, "failed", "the follow-up killed the thread");
  await until(() => h.byName("Spotify")!.tasks.length === 2);
  assert.notEqual(h.table.get(id)!.status, "failed", h.table.get(id)!.detail);
  assert.equal(h.byName("Spotify")!.tasks[1]!.request, "skip this song");
  await h.scheduler.cancelAll("test over");
  h.scheduler.dispose();
});

test("TH-2 deaf: a brain that never lets go does not fail the thread at the supersede bound; the follow-up waits for it, bounded, and Kevin's stop still cuts", async () => {
  const h = harness({ deaf: true, supersedeWaitMs: 50 });
  h.ctl.script = async () => undefined;
  h.scheduler.start(h.parentA, { name: "Spotify", task: "play focus", lane: "background" });
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const id = h.spawned()[0]!.id;
  assert.equal(await h.scheduler.followUp(id, "skip this song"), true);
  await settle(100);
  assert.notEqual(h.table.get(id)!.status, "failed", `the follow-up killed the thread: ${h.table.get(id)!.detail}`);
  assert.equal(await h.scheduler.stop(id), true);
  assert.equal(h.table.get(id)!.status, "stopped");
  h.scheduler.dispose();
});

test("TH-2 pause then resume a beat later leaves the thread running, not paused (the verbs run in order)", async () => {
  const h = harness();
  h.ctl.script = async () => undefined;
  h.scheduler.start(h.parentA, { name: "Spotify", task: "play focus", lane: "background" });
  await until(() => h.byName("Spotify")?.tasks.length === 1);
  const id = h.spawned()[0]!.id;
  const p = h.scheduler.pause(id);
  await settle(5);
  await h.scheduler.resume(id);
  await p;
  await settle(100);
  assert.notEqual(h.table.get(id)!.status, "paused", "the resume was lost");
  assert.equal(h.byName("Spotify")!.refused, 0);
  await h.scheduler.cancelAll("test over");
  h.scheduler.dispose();
});

// ------------------------------------------------------------- through the engine

async function split(w: World): Promise<void> {
  await w.engine.start();
  await w.engine.ready();
  w.engine.updateSettings({ idleSleepMinutes: 0 });
  await w.engine.wake("test");
  delegate(w, "jarhead tell ben on slack i'm late and play focus on spotify", "item_1");
  await settle();
  assert.equal(w.brain.tasks.length, 1, "the main brain holds the task");
}

const named = (w: World, name: string): Thread | undefined => w.engine.threads.threads().find((t) => t.id !== MAIN_THREAD_ID && t.name === name);

test("TH-3 (engine): 'tell Ben on Slack I'm late' splits Slack off; Kevin's next words reach the main brain on a new delegation, whose thread_stop {name: 'Slack'} stops it", async () => {
  const w = world();
  try {
    w.threads.script = async () => undefined;
    await split(w);
    await w.engine.runner.run("thread_start", { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
    await until(() => w.threads.byName("Slack")?.tasks.length === 1);
    w.brain.resolve!({ status: "done", summary: "on it." });
    await settle(50);
    nextUtterance(w);
    delegate(w, "jarhead actually don't message ben", "item_2");
    await until(() => w.brain.tasks.length === 2);
    const stop = (await w.engine.runner.run("thread_stop", { name: "Slack" })).result;
    assert.equal(stop.kind, "text", text(stop));
    assert.equal(named(w, "Slack")?.status, "stopped");
  } finally {
    await w.engine.stop();
  }
});

test("TH-1 (engine): Slack asks 'send?'; four minutes pass (past the root's TTL); the tick asks again, so Kevin's 'yes' reaches Slack's question and the click lands", async () => {
  const w = world();
  const { engine, hands } = w;
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  try {
    w.threads.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : "failed" };
    };
    await split(w);
    await engine.runner.run("thread_start", { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
    await until(() => named(w, "Slack")?.status === "waiting-kevin");
    w.clock.t += 4 * 60_000;
    // The engine's root ConfirmationState runs on Date.now, not the injected clock: move both.
    const realNow = Date.now;
    (engine.confirmations as unknown as { now: () => number }).now = () => realNow() + 4 * 60_000;
    const l = w.lives[w.lives.length - 1]!;
    const lines = l.commentary.length;
    tick();
    assert.equal(engine.threads.floorThread()?.name, "Slack", "asked again on the floor");
    // The voice says the question again (the engine's own line, so it was asked for): the exchange is open for the yes.
    assert.ok(await until(() => l.commentary.length > lines, 1000), "the question went to the voice again");
    l.emit("outputTranscript", " slack asks: send it?", l.nowMs, l.nowMs + 900);
    nextUtterance(w);
    delegate(w, "yes", "item_yes");
    await until(() => named(w, "Slack")?.status === "done");
    assert.equal(hands.named("click").length, 1, "the yes landed the click");
  } finally {
    await engine.stop();
  }
});

test("F-CODEX-AFTERSTOP: once the main task is stopped, a screen tool its brain still sends (a Return, the Send) is answered cancelled and never reaches the hands", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    const steps: string[] = [];
    const sink: BrainSink = { thinking: () => undefined, commentary: () => undefined, screenshot: () => undefined, step: (s) => steps.push(`${s.kind}:${s.text ?? ""}`) };
    const stop = new AbortController();
    engine.runner.attach(sink, { delegationId: "item_x", request: "send it", dialogue: "", confirmation: false, offsetMs: 0, signal: stop.signal });
    stop.abort();
    const before = hands.named("key").length;
    const out = await engine.runner.run("key", { text: "Return" });
    assert.equal(out.result.kind, "error", text(out.result));
    assert.match(text(out.result), /^cancelled/);
    assert.equal(hands.named("key").length - before, 0, "the key was posted after the stop");
    assert.ok(steps.some((s) => s.startsWith("error:cancelled")), "the refusal is on the record");
    engine.runner.attach(undefined);
  } finally {
    await engine.stop();
  }
});

test("TH-1 no (engine): Slack asks 'send?'; Kevin says 'no, don't send it'; the tick does not ask again and Slack stops; his 'okay.' a beat later clicks nothing", async () => {
  const w = world();
  const { engine, hands } = w;
  const tick = (): void => (engine as unknown as { tick(): void }).tick();
  try {
    w.threads.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : "failed" };
    };
    await split(w);
    await engine.runner.run("thread_start", { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
    await until(() => named(w, "Slack")?.status === "waiting-kevin");
    w.brain.resolve!({ status: "done", summary: "on it." });
    await settle(50);
    nextUtterance(w);
    delegate(w, "no, don't send it", "item_no");
    await settle(100);
    tick();
    await settle(20);
    w.clock.t += 2_000;
    tick();
    await settle(20);
    assert.equal(named(w, "Slack")?.status, "stopped");
    // The tick stops it ("Kevin said no"); merged with W1-3, the Delegator stops it on the no first, as Deny does ("Kevin stopped it").
    assert.match(named(w, "Slack")?.detail ?? "", /^Kevin (said no|stopped it)$/);
    assert.equal(engine.threads.floorThread(), undefined, "asked again after Kevin said no");
    nextUtterance(w);
    delegate(w, "okay.", "item_ok");
    await settle(300);
    assert.equal(hands.named("click").length, 0, "the declined send landed");
  } finally {
    await engine.stop();
  }
});

test(
  "RAIL-2 (engine): a spoken yes reaches the confirmation turn as Kevin's own words",
  async () => {
    const w = world();
    const { engine } = w;
    try {
      w.threads.script = async (job): Promise<BrainResult> => {
        const r = (await job.runner.run("click_element", { name: "Send" })).result;
        return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : "failed" };
      };
      await split(w);
      await engine.runner.run("thread_start", { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
      await until(() => named(w, "Slack")?.status === "waiting-kevin");
      nextUtterance(w);
      delegate(w, "yes, send it", "item_yes");
      await until(() => named(w, "Slack")?.status === "done");
      const turn = w.threads.byName("Slack")!.tasks.at(-1)!;
      assert.equal(turn.confirmation, true);
      assert.ok(turn.dialogue.includes('"yes, send it"'), turn.dialogue);
    } finally {
      await engine.stop();
    }
  },
);

test("RAIL-2 (engine, typed): a typed yes reaches the confirmation turn as Kevin's own words", async () => {
  const w = world();
  const { engine } = w;
  try {
    w.threads.script = async (job): Promise<BrainResult> => {
      const r = (await job.runner.run("click_element", { name: "Send" })).result;
      return { status: "done", summary: r.kind === "needs-confirmation" ? r.question : r.kind === "text" ? "sent." : "failed" };
    };
    await split(w);
    await engine.runner.run("thread_start", { name: "Slack", task: "send Ben: I'm running late", lane: "screen" });
    await until(() => named(w, "Slack")?.status === "waiting-kevin");
    await engine.command({ type: "say-text", text: "yes, send it" });
    await until(() => named(w, "Slack")?.status === "done");
    const turn = w.threads.byName("Slack")!.tasks.at(-1)!;
    assert.equal(turn.confirmation, true);
    assert.ok(turn.dialogue.includes('"yes, send it"'), turn.dialogue);
    assert.match(turn.kevinDialogue ?? "", /yes, send it$/);
  } finally {
    await engine.stop();
  }
});

test("main lane: a cut of the lease while the task is live is not a stop; the screen is asked for once more and the call acts (a second call's force-take cut the first)", async () => {
  const w = world();
  const { engine, hands } = w;
  try {
    await engine.start();
    await engine.ready();
    const sink: BrainSink = { thinking: () => undefined, commentary: () => undefined, screenshot: () => undefined, step: () => undefined };
    engine.runner.attach(sink, { delegationId: "item_live", request: "press return", dialogue: "", confirmation: false, offsetMs: 0, signal: new AbortController().signal });
    // A thread holds the screen mid-op, so Jarhead's priority taker waits for it.
    assert.equal((await engine.lease.acquire("t_other", { priority: false, timeoutMs: 50 })).ok, true);
    let finishOp!: () => void;
    const op = engine.lease.act("t_other", () => new Promise<void>((r) => (finishOp = r)));
    const before = hands.named("key").length;
    const call = engine.runner.run("key", { text: "Return" });
    await settle(30);
    engine.lease.cancelAll("Jarhead's hands took the screen");
    const out = await call;
    finishOp();
    await op;
    assert.notEqual(out.result.kind === "error" ? out.result.message.slice(0, 9) : "", "cancelled", "a live task's call was told the task was stopped");
    assert.equal(hands.named("key").length - before, 1, "the key did not land");
    engine.runner.attach(undefined);
  } finally {
    await engine.stop();
  }
});
