import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, type Decision } from "@jarhead/core";
import { FakeHands, KEVIN_QUIET_MS, USER_IDLE_POLL_MS, WAIT_MAX_MS, type UserIdle } from "@jarhead/hands";
import { DEFAULT_AUTOMATIONS, DEFAULT_SETTINGS, type Automation, type AutomationAction, type EngineEvent, type Settings } from "@jarhead/protocol";
import { AutomationExecutor, type FireOutcome } from "../automations/executor.ts";

/**
 * The W2-2 / W2-4 contract (TRIAGE, "W2-2 / W2-4 (unattended open and press)"). After W2-4 the helper holds an
 * activating `open_app` (and `key`) while the user's key, click or scroll is within KEVIN_QUIET_MS. An unattended
 * fire has nobody to retry it, so the executor waits out his quiet window itself: it reads `user_idle` every
 * USER_IDLE_POLL_MS for at most WAIT_MAX_MS, then sends once more. Nothing is billed: no brain, no session. When his
 * hands never leave the machine the step fails with one plain line, the line the island shows. A virtual clock:
 * nothing sleeps.
 */

/** The user types until `typingUntil`; every read and every poll the executor sleeps through sees him still typing. */
class Typist extends FakeHands {
  typingUntil = Number.POSITIVE_INFINITY;
  override get userIdle(): UserIdle {
    if (this.now() < this.typingUntil) this.kevinActed();
    return super.userIdle;
  }
}

interface Rig {
  readonly t: () => number;
  readonly hands: Typist;
  readonly executor: AutomationExecutor;
  readonly events: EngineEvent[];
  /** Runs between polls, at the virtual time the poll wakes. */
  onSleep?: (t: number) => void;
}

function rig(typingMs: number, userName = "Kevin"): Rig {
  let t = 1_757_500_000_000;
  const now = (): number => t;
  const hands = new Typist();
  hands.now = now;
  hands.typingUntil = typingMs === Number.POSITIVE_INFINITY ? typingMs : t + typingMs;
  hands.kevinActed();
  const events: EngineEvent[] = [];
  const settings: Settings = { ...DEFAULT_SETTINGS, automations: { ...DEFAULT_AUTOMATIONS, unattended: [...DEFAULT_AUTOMATIONS.unattended, "press"] } };
  const out: Rig = {
    t: now,
    hands,
    events,
    executor: new AutomationExecutor({
      now,
      ledger: new Ledger(mkdtempSync(join(tmpdir(), "jh-busy-state-"))),
      settings: () => settings,
      hands,
      redact: (s) => s,
      emit: (e) => events.push(e),
      exec: { run: async () => ({ code: 0 }), hold: () => undefined },
      shell: async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, ms: 1 }),
      shellGate: () => ({ verdict: "run", reason: "" }) as unknown as Decision,
      live: () => undefined,
      brain: { warmUp: async () => undefined, lane: async () => undefined, after: async () => undefined },
      home: mkdtempSync(join(tmpdir(), "jh-busy-home-")),
      problem: () => undefined,
      brainSpentToday: () => 0,
      reserveBrain: () => undefined,
      userName: () => userName,
      sleep: async (ms) => {
        t += ms;
        if (t < hands.typingUntil) hands.kevinActed();
        out.onSleep?.(t);
        await new Promise<void>((r) => setImmediate(r));
      },
    }),
  };
  return out;
}

function row(name: string, action: AutomationAction, at: number): Automation {
  return { id: `auto_${name}`, name, when: { kind: "at", at }, then: [action], clauses: { quiet: "override" }, echo: `At 09:00, ${action.kind}.`, state: "firing", fires: 0, missed: 0, createdAt: at - 60_000, updatedAt: at, createdBy: { by: "console", request: "" } };
}

async function fire(r: Rig, action: AutomationAction): Promise<FireOutcome> {
  const a = row("standup", action, r.t());
  return r.executor.fire({ a, now: r.t(), lateMs: 0, quiet: false, dueAt: r.t() }, undefined);
}

const pops = (r: Rig): number => r.events.filter((e) => e.type === "local.say" && (e as { sound?: string }).sound === "Pop").length;

test("open: the user is typing at the fire and stops a second later; the app opens once his quiet window has passed", async () => {
  const r = rig(1_000);
  const t0 = r.t();
  const out = await fire(r, { kind: "open", app: "Zoom" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.line, "standup · opened Zoom");
  assert.equal(r.hands.frontApp, "Zoom");
  const opens = r.hands.named("open_app");
  assert.equal(opens.length, 2, "the held open, then one more after the quiet window");
  assert.equal(opens[1]!.params["activate"], true);
  // His last key landed one poll before he stopped; the open waits KEVIN_QUIET_MS past it.
  assert.ok(opens[1]!.at - t0 >= 1_000 - USER_IDLE_POLL_MS + KEVIN_QUIET_MS, `after his quiet window (${opens[1]!.at - t0} ms)`);
  assert.ok(r.hands.named("user_idle").length >= 2, "the wait reads user_idle");
  assert.equal(pops(r), 1, "one soft Pop, for the open that landed");
});

test("open: the user never stops typing; the step fails with the plain line after WAIT_MAX_MS, nothing opened over his work", async () => {
  const r = rig(Number.POSITIVE_INFINITY);
  const t0 = r.t();
  const out = await fire(r, { kind: "open", app: "Zoom" });
  assert.equal(out.ok, false);
  assert.equal(out.detail, "Kevin was using the keyboard or mouse, so Zoom was not opened.");
  assert.doesNotMatch(out.detail ?? "", /—/, "no em dash");
  assert.equal(r.hands.frontApp, "Notes", "his app stays in front");
  assert.equal(r.hands.named("open_app").length, 1, "no second open while his hands are still on the machine");
  const waited = r.t() - t0;
  assert.ok(waited >= WAIT_MAX_MS && waited < WAIT_MAX_MS + 2 * USER_IDLE_POLL_MS, `one capped wait (${waited} ms)`);
  assert.equal(pops(r), 0);
});

test("open: the line names the user the engine knows", async () => {
  const r = rig(Number.POSITIVE_INFINITY, "Sam");
  const out = await fire(r, { kind: "open", app: "Zoom" });
  assert.equal(out.detail, "Sam was using the keyboard or mouse, so Zoom was not opened.");
});

test("open: an idle user is not waited for; one open_app, no user_idle read", async () => {
  const r = rig(0);
  r.hands.kevinAt = undefined;
  const out = await fire(r, { kind: "open", app: "Zoom" });
  assert.equal(out.ok, true);
  assert.equal(r.hands.named("open_app").length, 1);
  assert.equal(r.hands.named("user_idle").length, 0);
});

test("press: the user types in Cursor at the fire, stops; the front app is read again and the key lands there", async () => {
  const r = rig(1_000);
  r.hands.apps.set("Cursor", 600);
  r.hands.frontApp = "Cursor";
  r.hands.frontPid = 600;
  const t0 = r.t();
  const out = await fire(r, { kind: "press", app: "Cursor", key: "cmd+s" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.line, "standup · pressed cmd+s in Cursor");
  assert.equal(r.hands.named("frontmost").length, 2, "the front app is probed again before the retry");
  const keys = r.hands.posted.filter((p) => p.op === "key");
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0]!.params["expectFront"], { pid: 600 });
  assert.ok(keys[0]!.at - t0 >= 1_000 - USER_IDLE_POLL_MS + KEVIN_QUIET_MS, `after his quiet window (${keys[0]!.at - t0} ms)`);
});

test("press: the user switched apps while the fire waited; the retry sees it and presses nothing", async () => {
  const r = rig(1_000);
  r.hands.apps.set("Cursor", 600);
  r.hands.frontApp = "Cursor";
  r.hands.frontPid = 600;
  r.onSleep = () => {
    r.hands.frontApp = "Slack";
    r.hands.frontPid = 200;
  };
  const out = await fire(r, { kind: "press", app: "Cursor", key: "cmd+s" });
  assert.equal(out.ok, false);
  assert.equal(out.detail, "Cursor is not in front (Slack is)");
  assert.equal(r.hands.posted.filter((p) => p.op === "key").length, 0);
});

test("press: the user never stops; the step fails with the plain line and no key is posted", async () => {
  const r = rig(Number.POSITIVE_INFINITY);
  r.hands.apps.set("Cursor", 600);
  r.hands.frontApp = "Cursor";
  r.hands.frontPid = 600;
  const out = await fire(r, { kind: "press", app: "Cursor", key: "cmd+s" });
  assert.equal(out.ok, false);
  assert.equal(out.detail, "Kevin was using the keyboard or mouse, so cmd+s was not pressed.");
  assert.equal(r.hands.posted.filter((p) => p.op === "key").length, 0);
});
