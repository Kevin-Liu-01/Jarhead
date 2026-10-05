/**
 * W1-9: every path through the ToolRunner meets one gate, and a yes is spent on the
 * action it was said for (the rails audit's R4b, R5b, R7b and R10, RAIL-13's TS half).
 *
 * Safe by construction. The hands are fakes, nothing reaches a helper or the desktop.
 * Every command that would post keys or clicks if a gate failed is an `echo`, and every
 * AppleScript a `return` of a string, so a regression prints text and types nothing. The
 * agents are a recording fake, the files live under a temp home, and the one open_url
 * here names an address that the gate refuses before `open` could run. Every shell line
 * that says `open` runs under a stand-in policy that refuses all of them, and every
 * AppleScript that loads a page also asks for an administrator password, which the
 * policy refuses: a regression shows the policy's refusal, and nothing opens.
 *
 * Where W1-6's keyboard-send rule belongs to policy.ts, the plumbing is proved with a
 * stand-in policy through the runner's `policy` seam. The same check with the shipped
 * policy switches itself on once that rule is there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyAction, HANDS_OFF_APPS, presenceGated, type ActionContext, type Decision } from "@jarhead/core";
import { AgentRegistry, type AgentConnector } from "@jarhead/agents";
import type { StartOptions } from "@jarhead/agents";
import { ComputerToolset, ConfirmationState, FakeHands as DeskHands, NativeRequestError, isBusyResult, isHandsBusyMessage } from "@jarhead/hands";
import { ToolRunner, resultText } from "../runner.ts";
import { FakeHands, makeRunner, makeSink, makeTask } from "./fakes.ts";

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "jh-gates-home-"));
  mkdirSync(join(home, "Documents"), { recursive: true });
  return home;
}

const SLACK = "https://app.slack.com/client/T0123/C0456";

/**
 * Chrome on a page; records every op. Knobs: `front` (the app in front), `jsOn` (JavaScript
 * from Apple Events), `noAutomation` (every Apple Event to Chrome fails, so neither the page
 * URL nor a page script can be read).
 */
class Chrome extends FakeHands {
  calls: { op: string; params: Record<string, unknown> }[] = [];
  url = SLACK;
  front = "Google Chrome";
  jsOn = true;
  noAutomation = false;
  override async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params });
    if (this.noAutomation && (op === "browser_url" || op === "browser_js")) throw new NativeRequestError({ code: "permission_denied", message: "Not authorized to send Apple events to Google Chrome." });
    switch (op) {
      case "frontmost":
        return { app: this.front, pid: 7, window: null } as T;
      case "browser_url":
        return { url: this.url, title: "Slack | general" } as T;
      case "browser_js":
        if (!this.jsOn) return { result: "missing value" } as T;
        return { result: String(params["script"]) === "1+1" ? "2" : JSON.stringify({ ok: true, tag: "div", name: "Message #general" }) } as T;
      case "focused_text":
        return { role: "AXTextArea", secure: false, app: this.front } as T;
      case "type":
        return { characters: String(params["text"] ?? "").length, events: 1, via: "keys", attempts: 1, verified: true } as T;
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
  /** Everything that reached the page or the keyboard: page scripts that typed, keystrokes typed, keys pressed. */
  posted(): string[] {
    return this.calls.flatMap((c) => (c.op === "browser_js" && String(c.params["script"]) !== "1+1" ? ["page"] : c.op === "type" ? [`type:${JSON.stringify(c.params["text"])}`] : c.op === "key" ? [`key:${String(c.params["combo"])}`] : []));
  }
}

const run = (reason: string): Decision => ({ verdict: "run", reason });
const confirm = (reason: string): Decision => ({ verdict: "confirm", reason });

/**
 * Stands in for W1-6's rule (TRIAGE, the W1-6 / W1-9 contract): a Return, or typing with a line
 * break, on a messaging page or in a messaging app sends, and asks. Everything else is the
 * shipped policy.
 */
function sendRule(seen: ActionContext[]): (ctx: ActionContext) => Decision {
  return (ctx) => {
    seen.push(ctx);
    const sends = (ctx.kind === "key" && /^(return|enter)$/i.test(ctx.text ?? "")) || (ctx.kind === "type" && /[\r\n]/.test(ctx.text ?? ""));
    if (sends && presenceGated(ctx.app, ctx.url)) return ctx.confirmed ? run("confirmed") : confirm("that sends the message");
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

for (const jsOn of [true, false]) {
  test(`RAIL-1: a line break in browser_type's text is a Return: with no submit, on app.slack.com, JavaScript ${jsOn ? "on" : "off"}, it asks before anything is typed; the yes types it once`, async () => {
    const hands = new Chrome();
    hands.jsOn = jsOn;
    const seen: ActionContext[] = [];
    const { runner, toolset } = makeRunner({ home: fakeHome(), policy: sendRule(seen) }, hands);
    runner.attach(makeSink().sink, makeTask("tell the general channel I'm running late"));
    const args = { text: "running late, start without me\n", app: "Google Chrome" };
    const asked = await runner.run("browser_type", args);
    assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
    assert.match(resultText(asked.result), /line break/, "the question says the line break is a Return");
    assert.match(resultText(asked.result), /app\.slack\.com/);
    assert.deepEqual(hands.posted(), [], "nothing typed before the yes");
    assert.ok(seen.some((c) => c.kind === "key" && c.text === "Return" && c.url === SLACK), "the Return was judged on the page");
    assert.ok(seen.some((c) => c.kind === "type" && c.text === args.text && c.url === SLACK), "and the typing, as typing with a line break");

    toolset.confirmations.arm(); // Kevin: "yes"
    const ran = await runner.run("browser_type", args);
    assert.equal(ran.result.kind, "text", resultText(ran.result));
    assert.deepEqual(hands.posted(), [jsOn ? "page" : `type:${JSON.stringify(args.text)}`], "typed once, and no extra Return");
  });
}

test("RAIL-1: a send when the page address cannot be read (no Automation grant for Chrome) asks; the yes types and presses Return once", async () => {
  const hands = new Chrome();
  hands.noAutomation = true;
  const seen: ActionContext[] = [];
  const { runner, toolset } = makeRunner({ home: fakeHome(), policy: sendRule(seen) }, hands);
  runner.attach(makeSink().sink, makeTask("tell the general channel I'm running late"));
  const args = { text: "running late, start without me", submit: true, app: "Google Chrome" };
  const asked = await runner.run("browser_type", args);
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
  assert.match(resultText(asked.result), /the page address could not be read, and Return may send a message/);
  assert.deepEqual(hands.posted(), [], "nothing typed, no Return");
  assert.equal(seen.find((c) => c.kind === "key")?.url, undefined, "the Return was judged with no URL, which no rule can match");

  const line = await runner.run("browser_type", { text: "running late\n", app: "Google Chrome" });
  assert.equal(line.result.kind, "needs-confirmation", `a line break with no page address asks too: ${resultText(line.result)}`);
  assert.deepEqual(hands.posted(), []);

  const draft = await runner.run("browser_type", { text: "running late", app: "Google Chrome" });
  assert.equal(draft.result.kind, "text", `typing that sends nothing does not ask: ${resultText(draft.result)}`);
  hands.calls.length = 0;

  await runner.run("browser_type", args);
  toolset.confirmations.arm(); // Kevin: "yes"
  const ran = await runner.run("browser_type", args);
  assert.equal(ran.result.kind, "text", resultText(ran.result));
  assert.deepEqual(hands.posted(), [`type:${JSON.stringify(args.text)}`, "key:Return"]);
});

test("browser_type posts keyboard keys only into a browser that is in front: submit with another app in front, or no page script, is refused before anything is typed", async () => {
  const browser = (jsOn: boolean): { hands: Chrome; runner: ToolRunner } => {
    const hands = new Chrome();
    hands.url = "https://docs.example.com/page";
    hands.front = "Terminal"; // Chrome is the browser named; Terminal has the keyboard
    hands.jsOn = jsOn;
    const { runner } = makeRunner({ home: fakeHome() }, hands);
    runner.attach(makeSink().sink, makeTask("search the docs"));
    return { hands, runner };
  };

  const off = browser(false);
  const submit = await off.runner.run("browser_type", { text: "rm -rf build", submit: true, app: "Google Chrome" });
  assert.match(resultText(submit.result), /^error: refused: Terminal is in front, so the keys would land there\. Bring Google Chrome to the front first/);
  const keys = await off.runner.run("browser_type", { text: "hello", app: "Google Chrome" });
  assert.match(resultText(keys.result), /^error: refused: Terminal is in front/, "the keyboard fallback types into the app in front");
  assert.deepEqual(off.hands.posted(), [], "nothing typed, no Return");

  const on = browser(true);
  const enter = await on.runner.run("browser_type", { text: "hello", submit: true, app: "Google Chrome" });
  assert.match(resultText(enter.result), /^error: refused: Terminal is in front/, "the Return goes through the keyboard even when the page types");
  const page = await on.runner.run("browser_type", { text: "hello", app: "Google Chrome" });
  assert.equal(page.result.kind, "text", `a page script types into Chrome from behind: ${resultText(page.result)}`);
  assert.deepEqual(on.hands.posted(), ["page"]);

  on.hands.front = "Google Chrome";
  on.hands.calls.length = 0;
  const front = await on.runner.run("browser_type", { text: "hello", submit: true, app: "Google Chrome" });
  assert.equal(front.result.kind, "text", resultText(front.result));
  assert.deepEqual(on.hands.posted(), ["page", "key:Return"]);
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

/** Stands in for the policy where a gate failure would run `open`: it refuses every command, so nothing opens either way. */
function nothingRuns(seen: ActionContext[]): (ctx: ActionContext) => Decision {
  return (ctx) => {
    seen.push(ctx);
    return ctx.kind === "run_shell" ? { verdict: "refuse", reason: "stand-in: nothing runs here" } : classifyAction(ctx);
  };
}

test("RAIL-9: run_shell's `open` meets the URL table under every spelling: a private host nobody named, file://, http from the internet, other schemes, and a URL fed through xargs, sh -c or osascript are refused first", async () => {
  const seen: ActionContext[] = [];
  const { runner } = makeRunner({ home: fakeHome(), policy: nothingRuns(seen) });
  runner.attach(makeSink().sink, makeTask("what's the weather"));
  const refused: [string, RegExp][] = [
    ["open http://192.168.1.1/apply.cgi?action=reboot", /192\.168\.1\.1 is a private address/],
    ["/usr/bin/open -a Safari 'http://192.168.1.1/'", /192\.168\.1\.1 is a private address/],
    ["open file:///etc/passwd", /file:\/\/ is what the file tools are for/],
    ["open http://example.com/", /only https is fetched from the internet/],
    ["open facetime://+15555550100", /only http and https URLs are opened \(got facetime:\)/],
    [`sh -c 'open "http://192.168.1.1/"'`, /192\.168\.1\.1 is a private address/],
    ["echo http://192.168.1.1/ | xargs open", /192\.168\.1\.1 is a private address/],
    ["u=http://192.168.1.1/; open \"$u\"", /192\.168\.1\.1 is a private address/],
    ["o''pen http://192.168.1.1/", /192\.168\.1\.1 is a private address/],
    ["sudo -u kevin open http://10.0.0.1/", /10\.0\.0\.1 is a private address/],
    [`osascript -e 'open location "http://192.168.1.1/"'`, /192\.168\.1\.1 is a private address/],
  ];
  for (const [command, why] of refused) {
    const r = await runner.run("run_shell", { command });
    assert.match(resultText(r.result), new RegExp(`^error: refused: ${why.source}`), command);
  }
  assert.equal(seen.length, 0, "the URL table answered before the policy");
  for (const command of ["open https://github.com/", "open -a Safari", "curl -s http://example.com/ > page.html && open page.html", `git commit -m "open http://localhost:3000 to test"`]) {
    const r = await runner.run("run_shell", { command });
    assert.match(resultText(r.result), /^error: refused: stand-in/, `${command}: the URL table lets it by`);
  }
  runner.attach(makeSink().sink, makeTask("open the router page at 192.168.1.1"));
  const named = await runner.run("run_shell", { command: "open http://192.168.1.1/" });
  assert.match(resultText(named.result), /^error: refused: stand-in/, "named, it passes the URL table");
});

test("RAIL-9: an AppleScript that loads a page meets the URL table: open location, set URL, a URL property, do shell script open; a computed URL cannot be checked", async () => {
  const { runner } = makeRunner({ home: fakeHome() });
  runner.attach(makeSink().sink, makeTask("what's the weather"));
  // The policy refuses this line, so a gate that missed opens nothing either.
  const ADMIN = '\ndo shell script "true" with administrator privileges';
  const refused: [string, RegExp][] = [
    ['open location "http://192.168.1.1/apply.cgi?action=reboot"', /192\.168\.1\.1 is a private address/],
    ['tell application "Safari" to set URL of document 1 to "http://192.168.1.1/"', /192\.168\.1\.1 is a private address/],
    ['tell application "Google Chrome" to make new tab at end of tabs of window 1 with properties {URL:"file:///etc/passwd"}', /file:\/\/ is what the file tools are for/],
    ['do shell script "open http://192.168.1.1/"', /192\.168\.1\.1 is a private address/],
    ['open location "http://192.168." & "1.1/"', /192\.168\.1\.1 is a private address/],
    ['set u to "http://192.168.1.1/"\nopen location u', /open location with a computed URL cannot be checked/],
  ];
  for (const [script, why] of refused) {
    const r = await runner.run("applescript", { script: script + ADMIN });
    assert.match(resultText(r.result), new RegExp(`^error: refused: ${why.source}`), script);
  }
  const ok = await runner.run("applescript", { script: `open location "https://github.com/"${ADMIN}` });
  assert.match(resultText(ok.result), /^error: refused: .*administrator password/, "https passes the URL table and meets the policy");
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

function deskRunner(hands: DeskHands, policy?: (ctx: ActionContext) => Decision, now?: () => number): { runner: ToolRunner; toolset: ComputerToolset } {
  const toolset = new ComputerToolset({ hands, confirmations: new ConfirmationState() });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([], 0), stateDir: mkdtempSync(join(tmpdir(), "jh-gates-state-")), home: fakeHome(), ...(policy ? { policy } : {}), ...(now ? { now } : {}) });
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

test("RAIL-8 (R10) with the shipped policy: shell keystrokes are judged against the app in front, as the applescript tool's are", async () => {
  const hands = new DeskHands();
  hands.frontApp = "1Password";
  const { runner } = deskRunner(hands);
  const shell = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(shell.result.kind, "needs-confirmation", `run_shell with 1Password in front: ${resultText(shell.result)}`);
  const wrapped = await runner.run("run_shell", { command: `bash -c "${KEYSTROKE_BY_SHELL.replace(/"/g, '\\"')}"` });
  assert.equal(wrapped.result.kind, "needs-confirmation", `bash -c with 1Password in front: ${resultText(wrapped.result)}`);
  const script = await runner.run("applescript", { script: KEYSTROKE_SCRIPT });
  assert.equal(script.result.kind, "needs-confirmation", `the applescript tool with 1Password in front: ${resultText(script.result)}`);

  hands.frontApp = "Notes";
  const notes = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(notes.result.kind, "text", `run_shell with Notes in front: ${resultText(notes.result)}`);
});

test("RAIL-8: osascript under any spelling, or with a script the line does not show, reads the app in front and Kevin's hands; a script on the line with no keys reads neither", async () => {
  const hands = new DeskHands();
  hands.frontApp = "1Password";
  const seen: ActionContext[] = [];
  const { runner } = deskRunner(hands, nothingRuns(seen));
  const unseen = [
    `osa''script -e 'tell application "System Events" to keystroke "x"'`,
    `osa\\script -e 'tell application "System Events" to keystroke "x"'`,
    `osascript -e 'tell app "System Events" to key''stroke "x"'`,
    "osascript /tmp/jh-gates-script.scpt",
    `osascript -e "$(cat /tmp/jh-gates-script)"`,
    "osascript < /tmp/jh-gates-script",
    "/usr/bin/osascript -l JavaScript -",
  ];
  for (const command of unseen) {
    seen.length = 0;
    const idle = hands.named("user_idle").length;
    const r = await runner.run("run_shell", { command });
    assert.match(resultText(r.result), /^error: refused: stand-in/, command);
    assert.equal(seen.find((c) => c.kind === "run_shell")?.app, "1Password", `${command}: judged against the app in front`);
    assert.equal(hands.named("user_idle").length, idle + 1, `${command}: Kevin's hands read first`);
  }
  seen.length = 0;
  const reads = { front: hands.named("frontmost").length, idle: hands.named("user_idle").length };
  const plain = await runner.run("run_shell", { command: `osascript -e 'tell application "Spotify" to playpause'` });
  assert.match(resultText(plain.result), /^error: refused: stand-in/);
  assert.equal(seen.find((c) => c.kind === "run_shell")?.app, undefined, "a script on the line with no keys is not judged against the front app");
  assert.deepEqual({ front: hands.named("frontmost").length, idle: hands.named("user_idle").length }, reads, "and reads nothing");
});

test("RAIL-7: a yes to a scripted keystroke covers the app that was in front; a yes in a folder reached by a link is not spent once the link points elsewhere", async () => {
  const hands = new DeskHands();
  hands.frontApp = "1Password";
  const seen: ActionContext[] = [];
  const { runner, toolset } = deskRunner(hands, frontRule(seen));
  const asked = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
  toolset.confirmations.arm(); // Kevin: "yes", with 1Password in front
  hands.frontApp = "Bitwarden";
  const moved = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(moved.result.kind, "needs-confirmation", `the yes was said with 1Password in front: ${resultText(moved.result)}`);
  assert.ok(seen.every((c) => c.confirmed !== true), "the yes was never spent");

  const script = await runner.run("applescript", { script: KEYSTROKE_SCRIPT });
  assert.equal(script.result.kind, "needs-confirmation", resultText(script.result));
  toolset.confirmations.arm();
  hands.frontApp = "1Password";
  const scriptMoved = await runner.run("applescript", { script: KEYSTROKE_SCRIPT });
  assert.equal(scriptMoved.result.kind, "needs-confirmation", `the script's yes was said with Bitwarden in front: ${resultText(scriptMoved.result)}`);

  const home = fakeHome();
  for (const p of ["proj-a", "proj-b"]) mkdirSync(join(home, p, "build"), { recursive: true });
  symlinkSync(join(home, "proj-a"), join(home, "here"));
  const { runner: shell, toolset: desk } = makeRunner({ home });
  shell.attach(makeSink().sink, makeTask("clean the build folder in proj-a"));
  const args = { command: "rm -rf build", cwd: join(home, "here") };
  const ask = await shell.run("run_shell", args);
  assert.equal(ask.result.kind, "needs-confirmation", resultText(ask.result));
  desk.confirmations.arm(); // a yes while "here" is proj-a
  unlinkSync(join(home, "here"));
  symlinkSync(join(home, "proj-b"), join(home, "here"));
  const retargeted = await shell.run("run_shell", args);
  assert.equal(retargeted.result.kind, "needs-confirmation", "the same words now name proj-b");
  assert.ok(existsSync(join(home, "proj-b", "build")), "proj-b/build is still there");
  assert.ok(existsSync(join(home, "proj-a", "build")));
});

test("RAIL-13 (TS half): while Kevin typed 200 ms ago an applescript or shell keystroke is held in the helper's own busy words, so a lane retries it with no row; nothing runs; a yes stays armed for the retry", async () => {
  let t = 1_000_000;
  const hands = new DeskHands();
  hands.now = () => t;
  const seen: ActionContext[] = [];
  const { runner, toolset } = deskRunner(hands, frontRule(seen), () => t);

  hands.kevinActed(t - 200);
  const shell = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(shell.result.kind, "error", resultText(shell.result));
  assert.equal(resultText(shell.result), "error: busy: Kevin used the keyboard/mouse 200 ms ago. Nothing was sent. Try again once Kevin stops.");
  assert.ok(isBusyResult(shell.result), "a lane retries it, as it does the helper's busy refusal");
  assert.ok(shell.result.kind === "error" && /^busy: /.test(shell.result.message) && isHandsBusyMessage(shell.result.message), "the lanes' quiet sink drops a 'busy: ' step while the retry runs");
  const script = await runner.run("applescript", { script: KEYSTROKE_SCRIPT });
  assert.match(resultText(script.result), /^error: busy: Kevin used the keyboard\/mouse 200 ms ago/);
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
  t += 300;
  hands.frontApp = "1Password";
  const asked = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(asked.result.kind, "needs-confirmation", resultText(asked.result));
  toolset.confirmations.arm();
  hands.kevinActed(t - 100);
  const held = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.match(resultText(held.result), /^error: busy: Kevin used the keyboard\/mouse/);
  t += 2_000;
  const after = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(after.result.kind, "text", `the armed yes ran it: ${resultText(after.result)}`);
});

test("RAIL-13: Jarhead's own scripted keystroke is not Kevin's: the next one runs straight after it, and Kevin's own key after it still holds", async () => {
  let t = 2_000_000;
  const hands = new DeskHands();
  hands.now = () => t;
  const { runner } = deskRunner(hands, undefined, () => t);
  const first = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(first.result.kind, "text", resultText(first.result));
  hands.kevinActed(t + 20); // the helper saw System Events' keystroke land, and counts it as foreign
  t += 200;
  const second = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.equal(second.result.kind, "text", `not held behind its own keystroke: ${resultText(second.result)}`);
  t += 400;
  hands.kevinActed(t - 50); // Kevin's own key, after Jarhead's
  const third = await runner.run("run_shell", { command: KEYSTROKE_BY_SHELL });
  assert.match(resultText(third.result), /^error: busy: Kevin used the keyboard\/mouse 50 ms ago/);
});
