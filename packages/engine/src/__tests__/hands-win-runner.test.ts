import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@jarhead/agents";
import type { BrainSink, BrainTask } from "@jarhead/brain";
import { ComputerToolset, ConfirmationDesk, ConfirmationState, FakeHands, FocusLease, KEVIN_QUIET_MS, USER_IDLE_POLL_MS, WAIT_MAX_MS, type UserIdle } from "@jarhead/hands";
import { ThreadAwareRunner } from "../threads/index.ts";

/**
 * W2-4 review follow-up, through the main lane's runner: when Kevin types through the lease's
 * whole re-front wait, the main lane neither acts with his app in front nor takes the screen by
 * force; it answers "waiting for the screen". When he pauses inside the wait, the runner notes how
 * long it waited, the app comes back, and the tool runs there. A virtual clock: nothing sleeps.
 */

type Step = Parameters<BrainSink["step"]>[0];

/** Kevin types until `typingUntil` (re-stamped on every poll the lease sleeps through). */
class Typist extends FakeHands {
  typingUntil = Number.POSITIVE_INFINITY;
  override get userIdle(): UserIdle {
    if (this.now() < this.typingUntil) this.kevinActed();
    return super.userIdle;
  }
}

function world(typingMs: number): { t: () => number; hands: Typist; runner: ThreadAwareRunner; steps: Step[] } {
  let t = 1_000_000;
  const now = (): number => t;
  const hands = new Typist();
  hands.now = now;
  hands.typingUntil = typingMs === Number.POSITIVE_INFINITY ? typingMs : t + typingMs;
  hands.kevinActed();
  // Jarhead's hands last worked in Safari; a thread then brought Slack forward, and Kevin is typing in it.
  hands.frontApp = "Slack";
  hands.frontPid = 200;
  const sleep = async (ms: number): Promise<void> => {
    t += ms;
    if (t < hands.typingUntil) hands.kevinActed();
    await new Promise<void>((r) => setImmediate(r));
  };
  const lease = new FocusLease({ hands, now, sleep });
  lease.activated("Slack", "t_1");
  lease.rememberFront(ThreadAwareRunner.ACTOR, "Safari");
  const desk = new ConfirmationDesk(new ConfirmationState(3 * 60_000, now), () => undefined, now);
  const dir = mkdtempSync(join(tmpdir(), "jh-w24-runner-"));
  const runner = new ThreadAwareRunner({
    toolset: new ComputerToolset({ hands, now }),
    agents: new AgentRegistry([], 0),
    stateDir: dir,
    home: mkdtempSync(join(tmpdir(), "jh-w24-home-")),
    now,
    pool: { tool: async () => ({ kind: "text", text: "" }) },
    lease,
    desk,
  });
  const steps: Step[] = [];
  const sink: BrainSink = { thinking: () => undefined, commentary: () => undefined, step: (s) => steps.push(s), screenshot: () => undefined };
  const task = { delegationId: "d1", request: "search Safari", dialogue: "", confirmation: false, signal: new AbortController().signal } as unknown as BrainTask;
  runner.attach(sink, task);
  return { t: now, hands, runner, steps };
}

test("Kevin types through the main lane's whole re-front wait: 'waiting for the screen', nothing typed into his app, no force-take, done within WAIT_MAX_MS", async () => {
  const { t, hands, runner, steps } = world(Number.POSITIVE_INFINITY);
  const t0 = t();
  const out = await runner.run("type", { text: "search terms for Safari" });
  assert.equal(out.result.kind, "error");
  assert.equal((out.result as { message: string }).message, "waiting for the screen: Kevin is using the keyboard or mouse; do the rest first, or call it again");
  assert.equal(hands.posted.length, 0, "nothing typed, in Slack or anywhere");
  assert.equal(hands.named("focus_app").length, 0, "Safari was not pulled over his typing");
  assert.equal(hands.frontApp, "Slack");
  const waited = t() - t0;
  assert.ok(waited >= WAIT_MAX_MS && waited < WAIT_MAX_MS + 2 * USER_IDLE_POLL_MS, `one capped wait, not the 30 s acquire nor a second one after a force-take (${waited} ms)`);
  assert.equal(steps.filter((s) => s.kind === "note" && /took the screen/.test(String((s as { text?: string }).text))).length, 0, "Kevin's hands are not a holder to take the screen from");
});

test("Kevin pauses inside the wait: the runner notes the wait, Safari comes back, and the type lands there", async () => {
  const { t, hands, runner, steps } = world(2_000);
  const t0 = t();
  const out = await runner.run("type", { text: "search terms for Safari" });
  assert.equal(out.result.kind, "text", JSON.stringify(out.result));
  assert.equal(hands.frontApp, "Safari");
  const typed = hands.posted.filter((p) => p.op === "type");
  assert.equal(typed.length, 1);
  assert.ok((typed[0]?.at ?? 0) - t0 >= 2_000 - USER_IDLE_POLL_MS + KEVIN_QUIET_MS - USER_IDLE_POLL_MS, "after his quiet window");
  const notes = steps.filter((s) => s.kind === "note").map((s) => String((s as { text?: string }).text));
  assert.ok(notes.some((n) => /^waited \d+ ms for Kevin's hands$/.test(n)), `the wait is noted (${notes.join(" | ")})`);
  assert.ok(notes.includes("brought Safari back to the front"), notes.join(" | "));
});
