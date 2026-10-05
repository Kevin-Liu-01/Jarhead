/**
 * W3-1 (W2-4 / W1-9's hand-off): "your hands win" covers the two roads that bring an app forward without the helper.
 * `open_url` (the runner's `/usr/bin/open`) and a `run_shell` or `applescript` line that fronts an app (`open -a`,
 * `open -b`, an `activate`) read `user_idle` first: Kevin's key, click or scroll within KEVIN_QUIET_MS holds them, in
 * the helper's own busy words, so a lane retries them with no row once he stops.
 *
 * Safe by construction: nothing here opens. The hold comes before every other gate, and behind it each line meets a
 * gate that refuses it: the URL is a private host nobody named, every shell line runs under a stand-in policy that
 * refuses all of them, and the AppleScript also asks for an administrator password, which the policy refuses. A
 * regression shows that refusal instead of `busy`, and nothing opens either way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionContext, Decision } from "@jarhead/core";
import { AgentRegistry } from "@jarhead/agents";
import { ComputerToolset, ConfirmationState, FakeHands, isBusyResult } from "@jarhead/hands";
import { ToolRunner, resultText } from "../runner.ts";
import { makeSink, makeTask } from "./fakes.ts";

const PRIVATE_URL = "http://jh-gates-test.internal/status";
const ADMIN = '\ndo shell script "true" with administrator privileges';

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "jh-w31-home-"));
  mkdirSync(join(home, "Documents"), { recursive: true });
  return home;
}

/** Refuses every shell line, so a line that gets past the hold opens nothing. */
const nothingRuns = (seen: ActionContext[]) => (ctx: ActionContext): Decision => {
  seen.push(ctx);
  return { verdict: "refuse", reason: "stand-in: nothing runs here" };
};

function harness(): { runner: ToolRunner; hands: FakeHands; seen: ActionContext[]; clock: { t: number } } {
  const clock = { t: 3_000_000 };
  const hands = new FakeHands();
  hands.now = () => clock.t;
  const seen: ActionContext[] = [];
  const toolset = new ComputerToolset({ hands, confirmations: new ConfirmationState() });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([], 0), stateDir: mkdtempSync(join(tmpdir(), "jh-w31-state-")), home: fakeHome(), policy: nothingRuns(seen), now: () => clock.t });
  runner.attach(makeSink().sink, makeTask("open it for me"));
  return { runner, hands, seen, clock };
}

/** The helper's own busy words, and what was not done. */
const busy = (nothing: "opened" | "run"): RegExp => new RegExp(`^error: busy: Kevin used the keyboard/mouse 200 ms ago\\. Nothing was ${nothing}\\. Try again once Kevin stops\\.$`);

test("W3-1: open_url is held while Kevin typed 200 ms ago, in the helper's busy words, before anything else is judged; once he stops it meets the URL table", async () => {
  const { runner, hands, clock } = harness();
  hands.kevinActed(clock.t - 200);
  const held = await runner.run("open_url", { url: PRIVATE_URL });
  assert.match(resultText(held.result), busy("opened"));
  assert.ok(isBusyResult(held.result), "a lane retries it as it does the helper's own busy refusal");
  assert.equal(hands.calls.filter((c) => c.op === "user_idle").length, 1, "read user_idle once");
  clock.t += 2_000;
  const quiet = await runner.run("open_url", { url: PRIVATE_URL });
  assert.match(resultText(quiet.result), /refused: jh-gates-test\.internal is a private address/, "not held: the URL table answers");
  const scheme = await runner.run("open_url", { url: "file:///etc/hosts" });
  assert.match(resultText(scheme.result), /refused: only http and https/, "a URL that never opens is refused without a look at Kevin's hands");
});

test("W3-1: a run_shell line that brings an app forward (open -a, open -b, an inner shell's open, osascript activate) is held while Kevin types; a background open and a line that fronts nothing are not, and read nothing", async () => {
  const { runner, hands, seen, clock } = harness();
  hands.kevinActed(clock.t - 200);
  for (const command of ["open -a Notes", "open -b com.apple.Notes", "bash -c 'open -a Notes'", `osascript -e 'tell application "Notes" to activate'`, "open ~/Documents/plan.pdf"]) {
    const r = await runner.run("run_shell", { command });
    assert.match(resultText(r.result), busy("run"), command);
  }
  assert.equal(seen.length, 0, "held before the policy is asked");
  const reads = hands.calls.filter((c) => c.op === "user_idle").length;
  for (const command of ["open -g -a Notes", "echo open the door", `osascript -e 'tell application "Music" to playpause'`, "ls ~/Documents"]) {
    const r = await runner.run("run_shell", { command });
    assert.match(resultText(r.result), /refused: stand-in: nothing runs here/, command);
  }
  assert.equal(hands.calls.filter((c) => c.op === "user_idle").length, reads, "lines that front nothing read nothing");
  clock.t += 2_000;
  const quiet = await runner.run("run_shell", { command: "open -a Notes" });
  assert.match(resultText(quiet.result), /refused: stand-in: nothing runs here/, "Kevin stopped: the policy judges it");
});

test("W3-1: an AppleScript that activates or reopens an app is held while Kevin types; one that fronts nothing is not, and reads nothing", async () => {
  const { runner, hands, clock } = harness();
  hands.kevinActed(clock.t - 200);
  for (const script of [`tell application "Notes" to activate${ADMIN}`, `tell application "Safari" to reopen${ADMIN}`, `tell application "System Events" to set frontmost of process "Notes" to true${ADMIN}`]) {
    const r = await runner.run("applescript", { script });
    assert.match(resultText(r.result), busy("run"), script.split("\n")[0]);
  }
  const reads = hands.calls.filter((c) => c.op === "user_idle").length;
  const plain = await runner.run("applescript", { script: `tell application "Music" to get name of current track${ADMIN}` });
  assert.match(resultText(plain.result), /refused: that script needs an administrator password/);
  assert.equal(hands.calls.filter((c) => c.op === "user_idle").length, reads, "a script that fronts nothing reads nothing");
  clock.t += 2_000;
  const quiet = await runner.run("applescript", { script: `tell application "Notes" to activate${ADMIN}` });
  assert.match(resultText(quiet.result), /refused: that script needs an administrator password/, "Kevin stopped: the script's gate judges it");
});
