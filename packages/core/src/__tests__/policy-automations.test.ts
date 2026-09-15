import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AutomationAction, AutomationClauses, AutomationSettings, AutomationWhen } from "@jarhead/protocol";
import { BACKGROUND_SHELL_REFUSE, OPEN_BACKGROUND_FLAG, actionReason, classifyAutomation, costLine, openPathReason, pressKeyReason, shellSteals, triggerReason, type AutomationContext } from "../policy.ts";

// The set-up gate, row by row from the design's policy table. Every fixture names the home so
// the machine's real ~ is never read; the repo root is a folder nothing here writes into.

const HOME = "/Users/kevin";
const REPO = "/Users/kevin/jarvis";
const FREE: AutomationSettings["unattended"] = ["chime", "say", "notify", "open", "file"];
const ALL: AutomationSettings["unattended"] = [...FREE, "run-recipe", "press", "wake-brain"];
const AT: AutomationWhen = { kind: "at", at: 1_789_243_208_790 };
const DOWNLOADS: AutomationWhen = { kind: "on", on: { kind: "folder.file", path: "~/Downloads", glob: "*.pdf" } };
const QUIT_SLACK: AutomationWhen = { kind: "on", on: { kind: "app.quit", app: "Slack" } };
const chime: AutomationAction = { kind: "chime", line: "Wake up, Kevin" };
const notify: AutomationAction = { kind: "notify", title: "Standup in five" };
const RESPECT: AutomationClauses = { quiet: "respect" };

function ctx(over: Partial<AutomationContext> & { readonly then: readonly AutomationAction[] }): AutomationContext {
  const settings = { enabled: true, unattended: FREE, wakeBudgetMinutesPerDay: 5, recipes: [], ...(over.settings ?? {}) };
  return { when: AT, clauses: RESPECT, folderWatchers: 0, home: HOME, repoRoot: REPO, ...over, settings };
}
const verdict = (c: AutomationContext): string => classifyAutomation(c).verdict;
const reason = (c: AutomationContext): string => classifyAutomation(c).reason;

// ----------------------------------------------------------------- free kinds

test("chime, say and notify run with a fixed line; an empty line, a briefing over 160 chars and a line naming a secret refuse", () => {
  assert.equal(verdict(ctx({ then: [chime] })), "run");
  assert.equal(verdict(ctx({ then: [{ kind: "say", line: "It's seven ten." }] })), "run");
  assert.equal(verdict(ctx({ then: [notify] })), "run");
  assert.equal(verdict(ctx({ then: [{ kind: "notify", title: "Invoice", body: "filed to Papers", open: "~/Documents/Papers" }] })), "run");
  assert.equal(verdict(ctx({ then: [{ kind: "chime", line: "   " }] })), "refuse");
  const long = ctx({ then: [{ kind: "say", line: "x".repeat(161) }] });
  assert.equal(verdict(long), "refuse");
  assert.match(reason(long), /reads a sentence, not a briefing/);
  assert.match(reason(long), /use wake-brain/);
  assert.equal(verdict(ctx({ then: [{ kind: "say", line: "x".repeat(160) }] })), "run", "160 is the edge");
  const secret = ctx({ then: [{ kind: "say", line: "the key is $OPENAI_API_KEY" }] });
  assert.equal(verdict(secret), "refuse");
  assert.match(reason(secret), /names a secret/);
  assert.equal(verdict(ctx({ then: [{ kind: "notify", title: "read ~/.ssh/id_ed25519" }] })), "refuse");
  assert.equal(verdict(ctx({ then: [{ kind: "notify", title: "Pay", open: "https://paypal.com/send" }] })), "refuse", "a banner's Open target is judged like open");
});

test("open: an ordinary app, an https page and a readable path run; 1Password, http://, a payment or sign-in host, a secret path and an empty open refuse", () => {
  assert.equal(verdict(ctx({ then: [{ kind: "open", app: "Notes" }] })), "run");
  assert.equal(verdict(ctx({ then: [{ kind: "open", url: "https://example.com/notes" }] })), "run");
  assert.equal(verdict(ctx({ then: [{ kind: "open", path: "~/Documents/Papers" }] })), "run");
  const hands = ctx({ then: [{ kind: "open", app: "1Password" }] });
  assert.equal(verdict(hands), "refuse");
  assert.match(reason(hands), /hands-off/);
  assert.equal(verdict(ctx({ then: [{ kind: "open", app: "Keychain Access" }] })), "refuse");
  const http = ctx({ then: [{ kind: "open", url: "http://example.com" }] });
  assert.equal(verdict(http), "refuse");
  assert.match(reason(http), /only https/);
  assert.equal(verdict(ctx({ then: [{ kind: "open", url: "https://paypal.com/myaccount" }] })), "refuse", "a payment host");
  assert.equal(verdict(ctx({ then: [{ kind: "open", url: "https://example.com/login" }] })), "refuse", "a sign-in page");
  assert.equal(verdict(ctx({ then: [{ kind: "open", url: "file:///Users/kevin/x" }] })), "refuse");
  assert.equal(verdict(ctx({ then: [{ kind: "open", path: "~/.ssh" }] })), "refuse");
  assert.equal(verdict(ctx({ then: [{ kind: "open", path: "~/.jarhead/env" }] })), "refuse");
  const empty = ctx({ then: [{ kind: "open" }] });
  assert.equal(verdict(empty), "refuse");
  assert.match(reason(empty), /needs an app, an https URL or a path/);
});

test("open { path }: a .command, a .sh, a .py, a .scpt, a .workflow, a .pkg, a .dmg, a .terminal and any .app refuse (nothing runs from a free open); 1Password.app names the hands-off app; a path inside a bundle refuses; a PDF and a folder run; a banner's Open target is judged the same", () => {
  for (const path of ["~/scripts/deploy.command", "~/bin/tidy.sh", "~/x.zsh", "~/x.bash", "~/tools/report.py", "~/x.rb", "~/x.pl", "~/x.scpt", "~/x.applescript", "~/x.workflow", "~/Downloads/x.pkg", "~/Downloads/x.mpkg", "~/Downloads/x.dmg", "~/x.tool", "~/x.terminal", "~/Downloads/DEPLOY.COMMAND"]) {
    const d = classifyAutomation(ctx({ then: [{ kind: "open", path }] }));
    assert.equal(d.verdict, "refuse", path);
    assert.match(d.reason, /would run when opened|never executes/, path);
    assert.match(d.reason, /run-recipe/, `${path}: the safe kind is named`);
  }
  const bundle = classifyAutomation(ctx({ then: [{ kind: "open", path: "/Applications/Notes.app" }] }));
  assert.equal(bundle.verdict, "refuse");
  assert.match(bundle.reason, /app bundle; open the app by name/);
  const hands = classifyAutomation(ctx({ then: [{ kind: "open", path: "/Applications/1Password.app/" }] }));
  assert.equal(hands.verdict, "refuse");
  assert.match(hands.reason, /1Password is hands-off/);
  assert.equal(verdict(ctx({ then: [{ kind: "open", path: "/Applications/Keychain Access.app" }] })), "refuse");
  const inside = classifyAutomation(ctx({ then: [{ kind: "open", path: "/Applications/Slack.app/Contents/MacOS/Slack" }] }));
  assert.equal(inside.verdict, "refuse");
  assert.match(inside.reason, /inside an app bundle/);
  assert.equal(verdict(ctx({ then: [{ kind: "open", path: "~/Documents/report.pdf" }] })), "run");
  assert.equal(verdict(ctx({ then: [{ kind: "open", path: "~/Documents/Papers/" }] })), "run");
  assert.equal(verdict(ctx({ then: [{ kind: "open", path: "~/Documents/apples.txt" }] })), "run", "'app' inside a name is not a bundle");
  assert.equal(verdict(ctx({ then: [{ kind: "notify", title: "Deploy", open: "~/scripts/deploy.command" }] })), "refuse", "a banner's Open target is judged like open");
  assert.equal(openPathReason("~/scripts/deploy.command", HOME)?.includes("deploy.command"), true);
  assert.equal(openPathReason("~/Documents/report.pdf", HOME), undefined);
});

test("file: into a folder inside ~ with a folder trigger runs; outside ~, into ~/.jarhead, into a secret store, or with a clock trigger refuses", () => {
  const file = (into: string, when: AutomationWhen = DOWNLOADS): AutomationContext => ctx({ when, then: [{ kind: "file", into }] });
  assert.equal(verdict(file("~/Documents/Papers")), "run");
  assert.equal(verdict(file("/Users/kevin/Desktop/Inbox")), "run");
  assert.equal(verdict(file("~/Documents/Papers", { kind: "on", on: { kind: "download.done", glob: "*.pdf" } })), "run");
  const outside = file("/tmp/papers");
  assert.equal(verdict(outside), "refuse");
  assert.match(reason(outside), /outside Kevin's home/);
  assert.equal(verdict(file("/Volumes/Backup/Papers")), "refuse");
  const own = file("~/.jarhead/papers");
  assert.equal(verdict(own), "refuse");
  assert.match(reason(own), /Jarhead's own/);
  assert.equal(verdict(file("~/.jarhead/trash")), "refuse");
  assert.equal(verdict(file("~/.ssh")), "refuse");
  assert.equal(verdict(file("~/jarvis/packages")), "refuse", "the running checkout asks: refused, not asked");
  const clock = file("~/Documents/Papers", AT);
  assert.equal(verdict(clock), "refuse");
  assert.match(reason(clock), /only a folder.file or download.done watcher/);
  assert.equal(verdict(file("~/Documents/Papers", QUIT_SLACK)), "refuse", "an app watcher has no triggering file either");
  assert.equal(verdict(file("  ")), "refuse");
});

// ----------------------------------------------------------------- the acting kinds

const recipes = (...list: readonly { name: string; command: string; cwd?: string }[]): AutomationSettings["recipes"] => list.map((r) => ({ timeoutSeconds: 120, approvedAt: 1, ...r }));
const runRecipe = (name: string, over: Partial<AutomationContext> = {}): AutomationContext => ctx({ then: [{ kind: "run-recipe", recipe: name }], settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] }, ...over });

test("run-recipe: 'rm -rf ~/x' refuses; 'git push --force' refuses with 'would need a yes when it runs'; 'pnpm test' confirms once and runs with confirmed", () => {
  const rm = runRecipe("wipe", { recipeCommand: "rm -rf ~/x" });
  assert.equal(verdict(rm), "refuse");
  assert.match(reason(rm), /would need a yes when it runs|never list/);
  const force = runRecipe("ship", { recipeCommand: "git push --force" });
  assert.equal(verdict(force), "refuse");
  assert.match(reason(force), /would need a yes when it runs; nobody is there then/);
  assert.match(reason(force), /notify instead, or make it non-destructive/);
  const tests = runRecipe("tests", { recipeCommand: "pnpm test" });
  const asked = classifyAutomation(tests);
  assert.equal(asked.verdict, "confirm");
  assert.match(asked.reason, /recipe tests \(pnpm test\) will run unattended/);
  assert.equal(asked.grant, undefined, "a set-up yes is spent on this one row; nothing widens");
  const yes = classifyAutomation({ ...tests, confirmed: true });
  assert.equal(yes.verdict, "run");
  assert.match(yes.reason, /^Kevin confirmed: /);
  // A recipe already in Settings is judged by its saved text, at every set-up.
  const saved = runRecipe("tests", { settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: recipes({ name: "tests", command: "pnpm test" }) } });
  assert.equal(verdict(saved), "confirm");
  const missing = runRecipe("nothing");
  assert.equal(verdict(missing), "refuse");
  assert.match(reason(missing), /no recipe named "nothing"/);
  assert.equal(verdict(runRecipe("never", { recipeCommand: "shutdown -h now" })), "refuse", "the never list");
});

test("run-recipe: mv or cp without -n refuses (never overwrite), with -n confirms; open / osascript refuse with 'use the open action'; a cwd inside ~/.jarhead refuses", () => {
  const plain = runRecipe("file", { recipeCommand: 'mv "$JARHEAD_FILE" ~/Documents/Papers/' });
  assert.equal(verdict(plain), "refuse");
  assert.match(reason(plain), /mv needs -n/);
  assert.equal(verdict(runRecipe("file", { recipeCommand: 'mv -n "$JARHEAD_FILE" ~/Documents/Papers/' })), "confirm");
  assert.equal(verdict(runRecipe("file", { recipeCommand: 'mv -vn "$JARHEAD_FILE" ~/Documents/Papers/' })), "confirm", "a flag cluster with n");
  assert.equal(verdict(runRecipe("copy", { recipeCommand: "cp ~/notes.md ~/Documents/" })), "refuse");
  assert.equal(verdict(runRecipe("copy", { recipeCommand: "cp --no-clobber ~/notes.md ~/Documents/" })), "confirm");
  const fronts = runRecipe("slack", { recipeCommand: "open -a Slack" });
  assert.equal(verdict(fronts), "refuse");
  assert.match(reason(fronts), /use the open action/);
  assert.equal(verdict(runRecipe("say", { recipeCommand: "osascript -e 'display notification \"hi\"'" })), "refuse");
  assert.equal(verdict(runRecipe("bg", { recipeCommand: "open -g ~/Downloads/report.pdf" })), "confirm", "open -g stays in the background");
  const cwd = runRecipe("inside", { settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: recipes({ name: "inside", command: "ls", cwd: "~/.jarhead/ledger" }) } });
  assert.equal(verdict(cwd), "refuse");
});

test("a recipe in the Trash is refused as a target by name — run-recipe and recipe.red alike, even with a recipeCommand or a yes — and the refusal says Restore; the same name live confirms", () => {
  const binned = { name: "tests", command: "pnpm test", timeoutSeconds: 120, approvedAt: 1, trashedAt: 2 };
  const settings = { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [binned] };
  const row = classifyAutomation(ctx({ then: [{ kind: "run-recipe", recipe: "Tests" }], settings }));
  assert.equal(row.verdict, "refuse");
  assert.match(row.reason, /recipe "tests" is in the Trash; restore it/);
  assert.equal(classifyAutomation(ctx({ then: [{ kind: "run-recipe", recipe: "tests" }], settings, recipeCommand: "pnpm test", confirmed: true })).verdict, "refuse", "a new text under the trashed name does not revive it");
  const red = classifyAutomation(ctx({ when: { kind: "on", on: { kind: "recipe.red", recipe: "tests", everySeconds: 60 } }, then: [notify], settings }));
  assert.equal(red.verdict, "refuse");
  assert.match(red.reason, /in the Trash/);
  const { trashedAt: _gone, ...alive } = binned;
  const live = { ...settings, recipes: [alive] };
  assert.equal(classifyAutomation(ctx({ then: [{ kind: "run-recipe", recipe: "tests" }], settings: live })).verdict, "confirm");
});

test("a kind off in Settings › While asleep is refused, not asked, naming the chip and the nearest safe kind — run-recipe under the default chips, and a chime under an empty list", () => {
  const d = classifyAutomation(ctx({ then: [{ kind: "run-recipe", recipe: "tests" }], recipeCommand: "pnpm test" }));
  assert.equal(d.verdict, "refuse");
  assert.equal(d.reason, "run-recipe is not allowed while Jarhead is asleep (Settings › Automations › While asleep); a notify or a chime is");
  assert.equal(verdict(ctx({ then: [chime], settings: { enabled: true, unattended: [], wakeBudgetMinutesPerDay: 5, recipes: [] } })), "refuse");
  assert.equal(verdict(ctx({ then: [{ kind: "press", app: "Notes", key: "cmd+s" }] })), "refuse", "press is opt-in");
  assert.equal(verdict(ctx({ then: [{ kind: "wake-brain", prompt: "inbox?", budget: { steps: 8, seconds: 120 }, speak: true }] })), "refuse", "wake-brain is opt-in");
});

test("press: Keychain Access and 1Password refuse; a malformed key refuses; cmd+s in Notes confirms with the unattended clause", () => {
  const press = (app: string, key: string): AutomationContext => ctx({ then: [{ kind: "press", app, key }], settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] } });
  assert.equal(verdict(press("Keychain Access", "space")), "refuse");
  assert.equal(verdict(press("1Password", "cmd+c")), "refuse");
  assert.equal(verdict(press("Notes", "cmd+s; rm -rf ~")), "refuse");
  assert.equal(verdict(press("Notes", "")), "refuse");
  assert.equal(verdict(press("Notes", "x".repeat(33))), "refuse");
  assert.equal(verdict(press("", "cmd+s")), "refuse");
  const ok = classifyAutomation(press("Notes", "cmd+s"));
  assert.equal(ok.verdict, "confirm");
  assert.equal(ok.reason, "`cmd+s` will be pressed in Notes unattended, only while it is in front and no password field has focus");
  assert.equal(classifyAutomation({ ...press("Notes", "cmd+s"), confirmed: true }).verdict, "run");
});

test("press never deletes, quits, logs out, force-quits, powers off or ejects: cmd+shift+delete, cmd+delete, delete, backspace, forwarddelete, fn+delete, cmd+q, 'Cmd + Q', cmd+shift+q, cmd+opt+esc, cmd+alt+escape, power and eject refuse at set-up even with confirmed; cmd+s, space, return, the arrows and media keys confirm", () => {
  const settings = { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] };
  const press = (key: string, confirmed = false): AutomationContext => ctx({ then: [{ kind: "press", app: "Finder", key }], settings, confirmed });
  for (const key of ["cmd+shift+delete", "cmd+delete", "delete", "Delete", "backspace", "forwarddelete", "fn+delete", "cmd+q", "Cmd + Q", "q+cmd", "cmd+shift+q", "command+q", "cmd+opt+esc", "cmd+alt+escape", "cmd+option+esc", "power", "eject", "shift+delete"]) {
    const d = classifyAutomation(press(key));
    assert.equal(d.verdict, "refuse", key);
    assert.match(d.reason, /never pressed unattended/, key);
    assert.equal(classifyAutomation(press(key, true)).verdict, "refuse", `${key}: a yes does not open it`);
    assert.match(pressKeyReason(key) ?? "", /never pressed unattended/, key);
  }
  for (const key of ["cmd+s", "space", "return", "down", "cmd+shift+r", "cmd+r", "cmd+l", "play", "cmd+w", "esc", "cmd+opt+s"]) {
    assert.equal(classifyAutomation(press(key)).verdict, "confirm", key);
    assert.equal(pressKeyReason(key), undefined, key);
  }
  assert.match(pressKeyReason("cmd+shift+§") ?? "", /not a key or chord/);
});

test("wake-brain: budget 0 refuses naming the setting; otherwise confirms with the cost line ('brain minute'); a spawned thread and an empty or 400+ prompt refuse; a local brain says warm-up", () => {
  const wake = (over: Partial<AutomationContext> = {}, seconds = 120): AutomationContext =>
    ctx({ then: [{ kind: "wake-brain", prompt: "what is in my inbox", budget: { steps: 8, seconds }, speak: true }], settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] }, ...over });
  const zero = wake({ settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 0, recipes: [] } });
  assert.equal(verdict(zero), "refuse");
  assert.match(reason(zero), /Settings › Automations › Brain minutes is 0/);
  const d = classifyAutomation(wake());
  assert.equal(d.verdict, "confirm");
  assert.match(d.reason, /brain minute/);
  assert.equal(d.reason, costLine({ steps: 8, seconds: 120 }, 5, false));
  assert.equal(classifyAutomation(wake({ confirmed: true })).reason, `Kevin confirmed: ${costLine({ steps: 8, seconds: 120 }, 5, false)}`, "the words he heard are the words recorded");
  assert.match(classifyAutomation(wake({ localBrain: true })).reason, /a model warm-up on this Mac/);
  assert.equal(verdict(wake({ fromThread: true })), "refuse");
  assert.match(reason(wake({ fromThread: true })), /spawned thread/);
  assert.equal(verdict(ctx({ then: [{ kind: "wake-brain", prompt: " ", budget: { steps: 8, seconds: 120 }, speak: false }], settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] } })), "refuse");
  assert.equal(verdict(ctx({ then: [{ kind: "wake-brain", prompt: "x".repeat(401), budget: { steps: 8, seconds: 120 }, speak: false }], settings: { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] } })), "refuse");
});

test("the cost line, verbatim: N = ceil(seconds / 60), singular at one, the plan or a warm-up", () => {
  assert.equal(costLine({ steps: 8, seconds: 120 }, 5, false), "this wakes the brain — not the voice — while Jarhead is asleep: about 2 brain minutes per fire on Kevin's plan, up to 5 a day; its one-line answer is spoken by the local speaker / shown as a banner");
  assert.equal(costLine({ steps: 4, seconds: 30 }, 3, false), "this wakes the brain — not the voice — while Jarhead is asleep: about 1 brain minute per fire on Kevin's plan, up to 3 a day; its one-line answer is spoken by the local speaker / shown as a banner");
  assert.equal(costLine({ steps: 8, seconds: 61 }, 5, true), "this wakes the brain — not the voice — while Jarhead is asleep: about 2 brain minutes per fire a model warm-up on this Mac, up to 5 a day; its one-line answer is spoken by the local speaker / shown as a banner");
});

// ----------------------------------------------------------------- triggers, counts, the switch

test("a reserved trigger kind refuses by name; an unknown trigger kind and an unknown action kind refuse (fail closed); a pass-2 recurrence refuses with 'not yet'", () => {
  const reserved = ctx({ when: { kind: "on", on: { kind: "clipboard.match", pattern: "\\d{6}" } as unknown as Extract<AutomationWhen, { kind: "on" }>["on"] }, then: [notify] });
  assert.equal(verdict(reserved), "refuse");
  assert.match(reason(reserved), /clipboard\.match is a later pass/);
  for (const kind of ["network.changed", "automation.fired"]) {
    const c = ctx({ when: { kind: "on", on: { kind } as unknown as Extract<AutomationWhen, { kind: "on" }>["on"] }, then: [notify] });
    assert.match(reason(c), new RegExp(`${kind.replace(".", "\\.")} is a later pass`));
  }
  const unknownTrigger = ctx({ when: { kind: "on", on: { kind: "moon.full" } as unknown as Extract<AutomationWhen, { kind: "on" }>["on"] }, then: [notify] });
  assert.equal(verdict(unknownTrigger), "refuse");
  assert.match(reason(unknownTrigger), /unknown trigger kind "moon.full"/);
  const unknownAction = ctx({ then: [{ kind: "email", to: "kevin" } as unknown as AutomationAction] });
  assert.equal(verdict(unknownAction), "refuse");
  assert.match(reason(unknownAction), /unknown action kind "email"/);
  assert.equal(actionReason({ kind: "send", text: "hi" } as unknown as AutomationAction, ctx({ then: [] })).verdict, "refuse", "actionReason alone fails closed too");
  const unknownWhen = ctx({ when: { kind: "cron", expr: "* * * * *" } as unknown as AutomationWhen, then: [notify] });
  assert.equal(verdict(unknownWhen), "refuse");
  const monthly = ctx({ when: { kind: "every", every: { kind: "monthly", nth: 1, weekday: "mon", at: "09:00" }, phrase: "first monday 09:00" }, then: [notify] });
  assert.equal(verdict(monthly), "refuse");
  assert.match(reason(monthly), /not yet — say the date/);
});

test("the 9th folder watcher refuses (download.done counts as one); a watched folder under ~/.ssh, ~/.jarhead or outside ~ refuses; recipe.red below the 30 s floor refuses", () => {
  assert.equal(verdict(ctx({ when: DOWNLOADS, then: [notify], folderWatchers: 7 })), "run");
  const ninth = ctx({ when: DOWNLOADS, then: [notify], folderWatchers: 8 });
  assert.equal(verdict(ninth), "refuse");
  assert.match(reason(ninth), /8 folder watchers are already armed/);
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "download.done" } }, then: [notify], folderWatchers: 8 })), "refuse");
  assert.equal(verdict(ctx({ when: QUIT_SLACK, then: [notify], folderWatchers: 8 })), "run", "an app watcher is not a folder watcher");
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "folder.file", path: "~/.ssh" } }, then: [notify] })), "refuse");
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "folder.file", path: "~/.jarhead/ledger" } }, then: [notify] })), "refuse");
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "folder.file", path: "/tmp/drop" } }, then: [notify] })), "refuse");
  const fast = ctx({ when: { kind: "on", on: { kind: "recipe.red", recipe: "tests", everySeconds: 10 } }, then: [notify], settings: { enabled: true, unattended: FREE, wakeBudgetMinutesPerDay: 5, recipes: recipes({ name: "tests", command: "pnpm test" }) } });
  assert.equal(verdict(fast), "refuse");
  assert.match(reason(fast), /at most every 30 s/);
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "recipe.red", recipe: "tests", everySeconds: 60 } }, then: [notify], settings: { enabled: true, unattended: FREE, wakeBudgetMinutesPerDay: 5, recipes: recipes({ name: "tests", command: "pnpm test" }) } })), "run");
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "recipe.red", recipe: "ship", everySeconds: 60 } }, then: [notify], settings: { enabled: true, unattended: FREE, wakeBudgetMinutesPerDay: 5, recipes: recipes({ name: "ship", command: "git push --force" }) } })), "refuse", "a polled recipe is judged like one that runs");
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "agent.status", status: "blocked" } }, then: [notify] })), "run");
  assert.equal(verdict(ctx({ when: { kind: "on", on: { kind: "mac.wake" } }, then: [{ kind: "open", app: "Notes" }] })), "run");
});

test("recipe.red naming a recipe not yet approved, with recipeCommand: the poll asks once ('will be run every 60 s unattended') and runs with confirmed; the same trigger on an approved recipe runs at once; a run-recipe action under a second new name refuses", () => {
  const settings = { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] };
  const RED: AutomationWhen = { kind: "on", on: { kind: "recipe.red", recipe: "ci", everySeconds: 60 } };
  const asks = classifyAutomation(ctx({ when: RED, then: [notify], settings, recipeCommand: "pnpm test" }));
  assert.equal(asks.verdict, "confirm");
  assert.match(asks.reason, /^recipe ci \(pnpm test\) will be run every 60 s unattended/);
  assert.equal(classifyAutomation(ctx({ when: RED, then: [notify], settings, recipeCommand: "pnpm test", confirmed: true })).verdict, "run");
  assert.equal(classifyAutomation(ctx({ when: RED, then: [notify], settings: { ...settings, recipes: recipes({ name: "ci", command: "pnpm test" }) } })).verdict, "run", "an approved recipe needs no second yes");
  assert.equal(classifyAutomation(ctx({ when: RED, then: [notify], settings })).verdict, "refuse", "no recipe and no text: refused, as before");
  const two = classifyAutomation(ctx({ when: RED, then: [{ kind: "run-recipe", recipe: "deploy" }], settings, recipeCommand: "pnpm test" }));
  assert.equal(two.verdict, "refuse");
  assert.match(two.reason, /one recipeCommand names one recipe/);
  assert.equal(classifyAutomation(ctx({ when: RED, then: [{ kind: "run-recipe", recipe: "ci" }], settings, recipeCommand: "pnpm test" })).verdict, "confirm", "the same new name on both is one recipe, one yes");
});

test("a watcher whose action wakes the brain needs cooldown ≥ 600; with it the row confirms on the cost line", () => {
  const wake: AutomationAction = { kind: "wake-brain", prompt: "summarise what Slack left open", budget: { steps: 8, seconds: 120 }, speak: false };
  const settings = { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] };
  const none = ctx({ when: QUIT_SLACK, then: [wake], settings });
  assert.equal(verdict(none), "refuse");
  assert.match(reason(none), /cooldown of at least 600 s/);
  assert.equal(verdict(ctx({ when: QUIT_SLACK, then: [wake], clauses: { quiet: "respect", cooldown: 599 }, settings })), "refuse");
  assert.equal(verdict(ctx({ when: QUIT_SLACK, then: [wake], clauses: { quiet: "respect", cooldown: 600 }, settings })), "confirm");
  assert.equal(verdict(ctx({ when: AT, then: [wake], settings })), "confirm", "a clock needs no cooldown");
  assert.equal(triggerReason(none), "a watcher that wakes the brain needs a cooldown of at least 600 s between fires");
});

test("the master switch off refuses everything; zero actions, four actions and two acting kinds refuse; three actions with one acting kind run", () => {
  const off = ctx({ then: [chime], settings: { enabled: false, unattended: FREE, wakeBudgetMinutesPerDay: 5, recipes: [] } });
  assert.equal(verdict(off), "refuse");
  assert.match(reason(off), /Settings › Automations/);
  assert.equal(verdict(ctx({ then: [] })), "refuse");
  assert.equal(verdict(ctx({ then: [chime, chime, chime, chime] })), "refuse");
  const two = ctx({ when: DOWNLOADS, then: [{ kind: "file", into: "~/Documents/Papers" }, { kind: "open", path: "~/Documents/Papers" }] });
  assert.equal(verdict(two), "refuse");
  assert.match(reason(two), /one acting kind per automation/);
  assert.equal(verdict(ctx({ when: DOWNLOADS, then: [{ kind: "file", into: "~/Documents/Papers" }, notify, chime] })), "run");
});

test("a fixed-line row that also asks: the free actions run silently and the one question is the recipe's; a refusal anywhere wins over a question", () => {
  const settings = { enabled: true, unattended: ALL, wakeBudgetMinutesPerDay: 5, recipes: [] };
  const mixed = ctx({ then: [notify, { kind: "run-recipe", recipe: "tests" }], recipeCommand: "pnpm test", settings });
  const d = classifyAutomation(mixed);
  assert.equal(d.verdict, "confirm");
  assert.match(d.reason, /^recipe tests/);
  const broken = ctx({ then: [{ kind: "say", line: "" }, { kind: "run-recipe", recipe: "tests" }], recipeCommand: "pnpm test", settings });
  assert.equal(verdict(broken), "refuse");
});

// ----------------------------------------------------------------- the copy of shellSteals

test("shellSteals is the runner's: the two regexes in core are byte-for-byte the ones in packages/engine/src/threads/runner.ts, and the head test agrees on the cases the runner documents", () => {
  const runner = readFileSync(fileURLToPath(new URL("../../../engine/src/threads/runner.ts", import.meta.url)), "utf8");
  const refuse = /export const BACKGROUND_SHELL_REFUSE = (\/.*\/);\n/.exec(runner);
  const flag = /const OPEN_BACKGROUND_FLAG = (\/.*\/);\n/.exec(runner);
  assert.ok(refuse && flag, "the runner still declares both regexes");
  assert.equal(String(BACKGROUND_SHELL_REFUSE), refuse[1]);
  assert.equal(String(OPEN_BACKGROUND_FLAG), flag[1]);
  assert.equal(shellSteals("open -a Slack"), true);
  assert.equal(shellSteals("ls && open -a Slack"), true);
  assert.equal(shellSteals("cd x; open ."), true);
  assert.equal(shellSteals("echo hi | osascript"), true);
  assert.equal(shellSteals("sudo /usr/bin/open -a Slack"), true);
  assert.equal(shellSteals("open -g ~/x.pdf"), false);
  assert.equal(shellSteals("open -ga Preview ~/x.pdf"), false);
  assert.equal(shellSteals("open --background ~/x.pdf"), false);
  assert.equal(shellSteals("pnpm test"), false);
  assert.equal(shellSteals("echo 'open -a Slack'"), false, "a quoted separator is an argument");
  assert.equal(shellSteals(""), false);
});
