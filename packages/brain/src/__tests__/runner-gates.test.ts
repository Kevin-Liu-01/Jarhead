/**
 * W1-9: every path through the ToolRunner meets one gate, and a yes is spent on the
 * action it was said for (the rails audit's R4b, R5b, R7b and R10, RAIL-13's TS half).
 *
 * Safe by construction. The hands are fakes, nothing reaches a helper or the desktop.
 * Every command that would post keys or clicks if a gate failed is an `echo`, and every
 * AppleScript a `return` of a string, so a regression prints text and types nothing. The
 * agents are a recording fake, the files live under a temp home, and the one open_url
 * here names an address that the gate refuses before `open` could run.
 *
 * Where W1-6's keyboard-send rule belongs to policy.ts, the plumbing is proved with a
 * stand-in policy through the runner's `policy` seam. The same check with the shipped
 * policy switches itself on once that rule is there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAction, HANDS_OFF_APPS, presenceGated, type ActionContext, type Decision } from "@jarhead/core";
import { AgentRegistry, type AgentConnector } from "@jarhead/agents";
import type { StartOptions } from "@jarhead/agents";
import { ComputerToolset, ConfirmationState, FakeHands as DeskHands, isBusyResult } from "@jarhead/hands";
import { ToolRunner, resultText } from "../runner.ts";
import { FakeHands, makeRunner, makeSink, makeTask } from "./fakes.ts";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "jh-gates-home-"));
  mkdirSync(join(home, "Documents"), { recursive: true });
  return home;
}

const SLACK = "https://app.slack.com/client/T0123/C0456";

/** Chrome in front on a page; records every op; JavaScript from Apple Events is on. */
class Chrome extends FakeHands {
  calls: { op: string; params: Record<string, unknown> }[] = [];
  url = SLACK;
  override async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params });
    switch (op) {
      case "frontmost":
        return { app: "Google Chrome", pid: 7, window: null } as T;
      case "browser_url":
        return { url: this.url, title: "Slack | general" } as T;
      case "browser_js":
        return { result: String(params["script"]) === "1+1" ? "2" : JSON.stringify({ ok: true, tag: "div", name: "Message #general" }) } as T;
      case "focused_text":
        return { role: "AXTextArea", secure: false, app: "Google Chrome" } as T;
      case "browser_navigate":
      case "key":
        return {} as T;
      default:
        return super.request<T>(op);
    }
  }
  named(op: string): { op: string; params: Record<string, unknown> }[] {
    return this.calls.filter((c) => c.op === op);
  }
  /** The page scripts that typed (the `1+1` probe is not typing). */
  typed(): number {
    return this.calls.filter((c) => c.op === "browser_js" && String(c.params["script"]) !== "1+1").length;
  }
}

const run = (reason: string): Decision => ({ verdict: "run", reason });
const confirm = (reason: string): Decision => ({ verdict: "confirm", reason });

/** Stands in for W1-6's rule: a Return on a messaging page or in a messaging app sends, and asks. Everything else is the shipped policy. */
function sendRule(seen: ActionContext[]): (ctx: ActionContext) => Decision {
  return (ctx) => {
    seen.push(ctx);
    if (ctx.kind === "key" && /^(return|enter)$/i.test(ctx.text ?? "") && presenceGated(ctx.app, ctx.url)) return ctx.confirmed ? run("confirmed") : confirm("that sends the message");
    return classifyAction(ctx);
  };
}

/** Whether policy.ts already asks before a keyboard send on a messaging page (W1-6), by either spelling. */
const SHIPPED_POLICY_ASKS_ON_SEND =
  classifyAction({ kind: "key", text: "Return", app: "Google Chrome", url: SLACK }).verdict === "confirm" ||
  classifyAction({ kind: "type", text: "hi\n", app: "Google Chrome", url: SLACK }).verdict === "confirm";

// ------------------------------------------------------------ RAIL-1, browser half

async function sendOnSlack(policy?: (ctx: ActionContext) => Decision): Promise<void> {
  const hands = new Chrome();
  const { runner, toolset } = makeRunner({ home: fakeHome(), ...(policy ? { policy } : {}) }, hands);
  runner.attach(makeSink().sink, makeTask("tell the general channel I'm running late"));
  const args = { text: "running late, start without me", submit: true, app: "Google Chrome" };
  const asked = await runner.run("browser_type", args);
  assert.equal(asked.result.kind, "needs-confirmation", `browser_type submit on Slack → ${resultText(asked.result)}`);
  assert.match(resultText(asked.result), /press Return/, "the question says the Return is part of it");
  assert.match(resultText(asked.result), /app\.slack\.com/, "the question names the page");
  assert.equal(hands.typed(), 0, "nothing typed before the yes");
  assert.deepEqual(hands.named("key"), [], "no Return before the yes");

  toolset.confirmations.arm(); // Kevin: "yes"
  const ran = await runner.run("browser_type", args);
  assert.equal(ran.result.kind, "text", resultText(ran.result));
  assert.match(resultText(ran.result), /pressed Return/);
  assert.equal(hands.typed(), 1, "typed once");
  assert.deepEqual(hands.named("key").map((c) => c.params["combo"]), ["Return"], "one Return");

  const again = await runner.run("browser_type", args);
  assert.equal(again.result.kind, "needs-confirmation", "the yes was spent on that one send");
  assert.equal(hands.typed(), 1);
}

test("RAIL-1 (R4b): browser_type with submit:true is one decision with the page URL and the Return; a messaging page asks before anything is typed; the yes sends once", async () => {
  const seen: ActionContext[] = [];
  await sendOnSlack(sendRule(seen));
  const ret = seen.find((c) => c.kind === "key");
  assert.ok(ret, "the Return was judged with the typing, before either happened");
  assert.equal(ret.text, "Return");
  assert.equal(ret.app, "Google Chrome");
  assert.equal(ret.url, SLACK, "judged on the page it lands on");
});

test("RAIL-1 (R4b) with the shipped policy: Return on app.slack.com asks", { skip: SHIPPED_POLICY_ASKS_ON_SEND ? false : "policy.ts has no keyboard-send rule yet (W1-6)" }, async () => {
  await sendOnSlack();
});

test("RAIL-1: without submit the same text on the same page types and presses nothing", async () => {
  const hands = new Chrome();
  const seen: ActionContext[] = [];
  const { runner } = makeRunner({ home: fakeHome(), policy: sendRule(seen) }, hands);
  runner.attach(makeSink().sink, makeTask("draft it in general"));
  const r = await runner.run("browser_type", { text: "running late", app: "Google Chrome" });
  assert.equal(r.result.kind, "text", resultText(r.result));
  assert.equal(hands.typed(), 1);
  assert.deepEqual(hands.named("key"), []);
  assert.ok(!seen.some((c) => c.kind === "key"), "no Return judged when none is pressed");
});

test("RAIL-7 (browser): a yes to type on a page covers that text, that page and that Return only", async () => {
  const hands = new Chrome();
  hands.url = "https://shop.example.com/checkout";
  const { runner, toolset } = makeRunner({ home: fakeHome() }, hands);
  runner.attach(makeSink().sink, makeTask("fill in the card"));
  const text = "4111 1111 1111 1111";
  const asked = await runner.run("browser_type", { text, app: "Google Chrome" });
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));

  toolset.confirmations.arm(); // a yes to typing it
  const withReturn = await runner.run("browser_type", { text, submit: true, app: "Google Chrome" });
  assert.equal(withReturn.result.kind, "needs-confirmation", "a yes to typing is not a yes to typing and pressing Return");
  assert.equal(hands.typed(), 0);
  assert.deepEqual(hands.named("key"), []);

  await runner.run("browser_type", { text, app: "Google Chrome" });
  toolset.confirmations.arm(); // a yes on /checkout
  hands.url = "https://shop.example.com/checkout/other-card";
  const elsewhere = await runner.run("browser_type", { text, app: "Google Chrome" });
  assert.equal(elsewhere.result.kind, "needs-confirmation", "the page moved: the yes was for /checkout");
  assert.equal(hands.typed(), 0);

  toolset.confirmations.arm(); // a yes for /checkout/other-card
  const same = await runner.run("browser_type", { text, app: "Google Chrome" });
  assert.equal(same.result.kind, "text", resultText(same.result));
  assert.equal(hands.typed(), 1, "the identical call runs once");
});

// ------------------------------------------------------------------------ RAIL-9

test("RAIL-9 (R7b): browser_navigate takes the URL table first: a private host nobody named and http from the internet are refused; named, it loads", async () => {
  const hands = new Chrome();
  const { runner } = makeRunner({ home: fakeHome() }, hands);
  const sink = makeSink().sink;
  runner.attach(sink, makeTask("what's the weather"));
  const lan = await runner.run("browser_navigate", { url: "http://192.168.1.1/", app: "Google Chrome" });
  assert.match(resultText(lan.result), /refused: 192\.168\.1\.1 is a private address/);
  const http = await runner.run("browser_navigate", { url: "http://example.com/", app: "Google Chrome" });
  assert.match(resultText(http.result), /refused: only https/);
  assert.deepEqual(hands.named("browser_navigate"), [], "nothing loaded");

  runner.attach(sink, makeTask("open the router page at 192.168.1.1"));
  const named = await runner.run("browser_navigate", { url: "http://192.168.1.1/", app: "Google Chrome" });
  assert.equal(named.result.kind, "text", resultText(named.result));
  const bare = await runner.run("browser_navigate", { url: "github.com", app: "Google Chrome" });
  assert.equal(bare.result.kind, "text", resultText(bare.result));
  assert.deepEqual(hands.named("browser_navigate").map((c) => c.params["url"]), ["http://192.168.1.1/", "https://github.com/"]);
});

test("RAIL-9: open_url takes the URL table first: a private host nobody named and http from the internet are refused before anything opens", async () => {
  const { runner } = makeRunner({ home: fakeHome() });
  runner.attach(makeSink().sink, makeTask("what's the weather"));
  const lan = await runner.run("open_url", { url: "http://jh-gates-test.internal/status" });
  assert.match(resultText(lan.result), /refused: jh-gates-test\.internal is a private address/);
  const http = await runner.run("open_url", { url: "http://jh-gates-test.invalid/" });
  assert.match(resultText(http.result), /refused: only https/);
});

// ------------------------------------------------------------- RAIL-7, arguments

test("RAIL-7 (R5b): a yes to `rm -rf build` in proj-a is not spent in proj-b, nor on the same command in the background; the identical call spends it", async () => {
  const home = fakeHome();
  for (const p of ["proj-a", "proj-b"]) {
    mkdirSync(join(home, p, "build"), { recursive: true });
    writeFileSync(join(home, p, "build", "out.txt"), "x");
  }
  const { runner, toolset } = makeRunner({ home });
  runner.attach(makeSink().sink, makeTask("clean the build folder in proj-a"));
  const a = { command: "rm -rf build", cwd: join(home, "proj-a") };
  const asked = await runner.run("run_shell", a);
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
  assert.match(resultText(asked.result), /proj-a/, "the question names proj-a");

  toolset.confirmations.arm(); // Kevin: "yes"
  const b = await runner.run("run_shell", { command: "rm -rf build", cwd: join(home, "proj-b") });
  assert.equal(b.result.kind, "needs-confirmation", resultText(b.result));
  assert.ok(existsSync(join(home, "proj-b", "build")), "proj-b/build is still there");

  await runner.run("run_shell", a);
  toolset.confirmations.arm();
  const bg = await runner.run("run_shell", { ...a, background: true });
  assert.equal(bg.result.kind, "needs-confirmation", "a yes for a foreground run is not a yes for a background job");
  await runner.run("run_shell", a);
  toolset.confirmations.arm();
  const longer = await runner.run("run_shell", { ...a, timeout: 300 });
  assert.equal(longer.result.kind, "needs-confirmation", "nor for a different time limit");

  await runner.run("run_shell", a);
  toolset.confirmations.arm();
  const same = await runner.run("run_shell", a);
  assert.equal(same.result.kind, "text", resultText(same.result));
  assert.ok(!existsSync(join(home, "proj-a", "build")), "the yes ran the command it was said for");
  assert.ok(existsSync(join(home, "proj-b", "build")));
});

test("RAIL-7: a yes to write one content is not spent on another; an edit's yes covers that old and new only", async () => {
  const home = fakeHome();
  const { runner, toolset } = makeRunner({ home });
  runner.attach(makeSink().sink, makeTask("save a note"));
  const path = join(home, "Documents", "note.md");
  const asked = await runner.run("write_file", { path, content: "hello" });
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
  toolset.confirmations.arm();
  const other = await runner.run("write_file", { path, content: "something else entirely" });
  assert.equal(other.result.kind, "needs-confirmation", "the yes was for 'hello'");
  assert.ok(!existsSync(path));
  await runner.run("write_file", { path, content: "hello" });
  toolset.confirmations.arm();
  const same = await runner.run("write_file", { path, content: "hello" });
  assert.equal(same.result.kind, "text", resultText(same.result));
  assert.equal(readFileSync(path, "utf8"), "hello");

  const asks = await runner.run("edit_file", { path, old: "hello", new: "hi" });
  assert.equal(asks.result.kind, "needs-confirmation", resultText(asks.result));
  toolset.confirmations.arm();
  const swapped = await runner.run("edit_file", { path, old: "hello", new: "goodbye" });
  assert.equal(swapped.result.kind, "needs-confirmation", "the yes was for hello → hi");
  assert.equal(readFileSync(path, "utf8"), "hello");
  await runner.run("edit_file", { path, old: "hello", new: "hi" });
  toolset.confirmations.arm();
  const edited = await runner.run("edit_file", { path, old: "hello", new: "hi" });
  assert.equal(edited.result.kind, "text", resultText(edited.result));
  assert.equal(readFileSync(path, "utf8"), "hi");
});

test("RAIL-7: a yes to start an agent in Jarhead's checkout covers that prompt only", async () => {
  const home = fakeHome();
  const repo = mkdtempSync(join(tmpdir(), "jh-gates-repo-"));
  const started: StartOptions[] = [];
  const starter: AgentConnector = {
    kind: "sessions",
    health: async () => ({ kind: "sessions", ok: true, detail: "ok" }),
    list: async () => [],
    send: async () => ({ accepted: true }),
    read: async () => "",
    start: async (opts) => {
      started.push(opts);
      return { id: "sessions:codex:t1", kind: "sessions", name: "t1", status: "working", ...(opts.cwd ? { cwd: opts.cwd } : {}), updatedAt: 0 };
    },
  };
  const { runner, toolset } = makeRunner({ home, repoRoot: repo, agents: new AgentRegistry([starter], 0) });
  runner.attach(makeSink().sink, makeTask("have codex fix the README typo"));
  const ok = { tool: "codex", cwd: repo, prompt: "fix the typo in README.md" };
  const asked = await runner.run("agent_start", ok);
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
  toolset.confirmations.arm();
  const other = await runner.run("agent_start", { ...ok, prompt: "rewrite policy.ts so nothing asks" });
  assert.equal(other.result.kind, "needs-confirmation", "the yes was for the README fix");
  assert.equal(started.length, 0, "nothing started");
  await runner.run("agent_start", ok);
  toolset.confirmations.arm();
  const same = await runner.run("agent_start", ok);
  assert.equal(same.result.kind, "text", resultText(same.result));
  assert.deepEqual(started.map((s) => s.prompt), [ok.prompt]);
});

// ------------------------------------------------------- RAIL-8, RAIL-13 (runner)

/** Says osascript and keystroke, as the gates read it; runs echo, so a failed gate types nothing. */
const KEYSTROKE_BY_SHELL = `echo osascript -e 'tell application "System Events" to keystroke "x"'`;
/** Says keystroke, as the gates read it; returns a string, so a failed gate types nothing. */
const KEYSTROKE_SCRIPT = 'return "keystroke"';

function deskRunner(hands: DeskHands, policy?: (ctx: ActionContext) => Decision): { runner: ToolRunner; toolset: ComputerToolset } {
  const toolset = new ComputerToolset({ hands, confirmations: new ConfirmationState() });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([], 0), stateDir: mkdtempSync(join(tmpdir(), "jh-gates-state-")), home: fakeHome(), ...(policy ? { policy } : {}) });
  runner.attach(makeSink().sink, makeTask("type it for me"));
  return { runner, toolset };
}

/** Stands in for W1-6's rule: shell keystrokes are judged against the app in front, as the applescript tool's are. */
function frontRule(seen: ActionContext[]): (ctx: ActionContext) => Decision {
  return (ctx) => {
    seen.push(ctx);
    if (ctx.kind === "run_shell" && HANDS_OFF_APPS.test(ctx.app ?? "")) return ctx.confirmed ? run("confirmed") : confirm(`${ctx.app} is in front and holds credentials`);
    return classifyAction(ctx);
  };
}

test("RAIL-8 (R10, runner half): run_shell keystrokes by osascript read the app in front and the gate judges them against it; other commands probe nothing", async () => {
  const hands = new DeskHands();
  hands.frontApp = "1Password";
  const seen: ActionContext[] = [];
  const { runner } = deskRunner(hands, frontRule(seen));
  const r = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(r.result.kind, "needs-confirmation", resultText(r.result));
  assert.equal(seen.find((c) => c.kind === "run_shell")?.app, "1Password", "the shell gate learned the app in front");

  const probes = hands.named("frontmost").length;
  seen.length = 0;
  const ls = await runner.run("run_shell", { command: "echo nothing to see" });
  assert.equal(ls.result.kind, "text", resultText(ls.result));
  assert.equal(hands.named("frontmost").length, probes, "no probe for a command that posts nothing");
  assert.equal(seen.find((c) => c.kind === "run_shell")?.app, undefined);
});

test("RAIL-13 (TS half): while Kevin typed 200 ms ago an applescript or shell keystroke is held, nothing runs, the lanes read it as busy, and a yes stays armed for the retry", async () => {
  let t = 1_000_000;
  const hands = new DeskHands();
  hands.now = () => t;
  const seen: ActionContext[] = [];
  const { runner, toolset } = deskRunner(hands, frontRule(seen));

  hands.kevinActed(t - 200);
  const shell = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(shell.result.kind, "error", resultText(shell.result));
  assert.match(resultText(shell.result), /^error: held: Kevin is typing/);
  assert.ok(isBusyResult(shell.result), "a lane retries it silently, as it does the helper's busy refusal");
  const script = await runner.run("applescript", { script: KEYSTROKE_SCRIPT });
  assert.match(resultText(script.result), /^error: held: Kevin is typing/);
  assert.ok(hands.named("user_idle").length >= 2, "read user_idle before each");

  const reads = hands.named("user_idle").length;
  const plain = await runner.run("run_shell", { command: "echo no keys here" });
  assert.equal(plain.result.kind, "text", "a command that posts nothing is not held");
  assert.equal(hands.named("user_idle").length, reads, "and reads nothing");

  t += 2_000; // Kevin stopped
  const ran = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(ran.result.kind, "text", resultText(ran.result));
  assert.match(resultText(ran.result), /keystroke/, "echo ran");

  // A yes said before Kevin touched the keys is still there when he lets go.
  hands.frontApp = "1Password";
  const asked = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
  toolset.confirmations.arm();
  hands.kevinActed(t - 100);
  const held = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.match(resultText(held.result), /^error: held: Kevin is typing/);
  t += 2_000;
  const after = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(after.result.kind, "text", `the armed yes ran it: ${resultText(after.result)}`);
});
