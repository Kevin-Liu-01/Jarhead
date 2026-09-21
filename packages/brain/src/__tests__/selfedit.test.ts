import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { DaemonServer, type EngineLike } from "@jarhead/daemon";
import type { ToolResult } from "@jarhead/hands";
import { resultText } from "../runner.ts";
import { RAILS, SelfEditManager, firstFailureLine, railsNamed, railsTouched, saysApplyAnyway, selfEditDoctorRow, selfEditPrompt, type SelfEditRecord } from "../selfedit.ts";
import { makeRunner, makeSink, makeTask } from "./fakes.ts";

/** The shared stand-in for the Codex CLI (speaks `codex exec --json`); see packages/agents. */
const FAKE_CODEX = fileURLToPath(new URL("../../../agents/src/sessions/__tests__/fixtures/fake-codex.mjs", import.meta.url));

/**
 * A `codex` binary for the self-edit tests: it applies the edit named by
 * FAKE_EDIT_FILE / FAKE_EDIT_TEXT in the `-C` directory (what a coding agent does)
 * and then runs the shared fake-codex fixture for the JSONL conversation.
 */
function fakeCodexBin(dir: string): string {
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/bin/sh
prev=""
for a in "$@"; do
  if [ "$prev" = "-C" ]; then wt="$a"; fi
  prev="$a"
done
if [ -n "$FAKE_EDIT_FILE" ] && [ -n "$wt" ]; then
  mkdir -p "$(dirname "$wt/$FAKE_EDIT_FILE")"
  printf '%s\\n' "$FAKE_EDIT_TEXT" >> "$wt/$FAKE_EDIT_FILE"
fi
exec "${process.execPath}" "${FAKE_CODEX}" "$@"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A repo that looks enough like Jarhead's: main, a package.json whose typecheck
 * script always passes and whose test script fails when a FAIL file exists, and a
 * seeded policy.ts so a rail can be touched.
 */
function fakeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "packages", "core", "src"), { recursive: true });
  mkdirSync(join(repo, "packages", "engine", "src"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fake-jarhead", private: true, scripts: { typecheck: 'node -e "process.exit(0)"', test: "node check.mjs" } }, null, 2));
  writeFileSync(join(repo, "check.mjs"), `import { existsSync } from "node:fs";\nif (existsSync("FAIL")) { console.log("not ok 1 - boom: the FAIL file exists"); process.exit(1); }\nconsole.log("ok 1 - fine");\n`);
  writeFileSync(join(repo, "README.md"), "# fake\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\npnpm-lock.yaml\n");
  writeFileSync(join(repo, "packages", "core", "src", "policy.ts"), "export const NEVER = [];\n");
  writeFileSync(join(repo, "packages", "engine", "src", "other.ts"), "export const x = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

interface Harness {
  root: string;
  repo: string;
  bin: string;
  codexHome: string;
  logFile: string;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "jh-selfedit-"));
  const repo = fakeRepo(root);
  const bin = fakeCodexBin(root);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } }));
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-6-astra"\n');
  return { root, repo, bin, codexHome, logFile: join(root, "codex.log") };
}

function manager(h: Harness, env: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof SelfEditManager>[0]> = {}): SelfEditManager {
  return new SelfEditManager({
    repoRoot: h.repo,
    worktreesDir: join(h.root, "worktrees"),
    codexBin: h.bin,
    codexHome: h.codexHome,
    claude: false,
    env: { ...process.env, OPENAI_API_KEY: "must-not-leak", FAKE_CODEX_LOG: h.logFile, ...env },
    ...extra,
  });
}

test("self_edit: a worktree, the fake Codex edits it under workspace-write, the change is committed and the checks are green", async () => {
  const h = harness();
  const m = manager(h, { FAKE_EDIT_FILE: "README.md", FAKE_EDIT_TEXT: "Added by the agent." });
  const progress: string[] = [];
  const { record, summary } = await m.edit("add a line to the readme", { progress: (l) => progress.push(l) });
  assert.equal(record.status, "checked");
  assert.equal(record.agent, "codex");
  assert.equal(record.agentOk, true);
  assert.deepEqual(record.files, ["README.md"]);
  assert.equal(record.green, true);
  assert.deepEqual(record.checks.map((c) => `${c.name}:${c.ok}`), ["typecheck:true", "test:true"]);
  assert.deepEqual(record.rails, []);
  assert.match(summary, /^Self-edit se_\w+ changed 1 file \(1 insertion\(\+\)\): README\.md\./);
  assert.match(summary, /Checks green: typecheck, test\./);
  assert.match(summary, /Say the word to apply/);
  assert.ok(!/safety rails/.test(summary));
  assert.ok(progress.includes("Codex is working on it.") && progress.includes("Running typecheck.") && progress.includes("test passed."), progress.join(" | "));

  // The worktree is on its own branch; main did not move; the commit is Jarhead's.
  assert.ok(existsSync(record.dir));
  assert.equal(git(record.dir, "rev-parse", "--abbrev-ref", "HEAD"), record.branch);
  assert.equal(git(h.repo, "log", "--oneline", "main").split("\n").length, 1);
  assert.match(git(record.dir, "log", "-1", "--format=%an %s"), /^Jarhead self-edit se_\w+: add a line to the readme$/);
  assert.match(readFileSync(join(record.dir, "README.md"), "utf8"), /Added by the agent\./);
  assert.equal(readFileSync(join(h.repo, "README.md"), "utf8"), "# fake\n", "the checkout is untouched");

  // The Codex argv: exec, --json, workspace-write, no user config, the configured model, -C the worktree, prompt on stdin; secrets scrubbed.
  const log = JSON.parse(readFileSync(h.logFile, "utf8").trim().split("\n").pop()!) as { args: string[]; cwd: string; codexHome: string; hasOpenAIKey: boolean };
  assert.equal(log.args[0], "exec");
  for (const flag of ["--json", "--skip-git-repo-check", "--ignore-user-config"]) assert.ok(log.args.includes(flag), flag);
  assert.equal(log.args[log.args.indexOf("-s") + 1], "workspace-write");
  assert.equal(log.args[log.args.indexOf("-m") + 1], "gpt-6-astra");
  assert.equal(log.args[log.args.indexOf("-C") + 1], record.dir);
  assert.equal(log.args[log.args.length - 1], "-");
  assert.equal(log.codexHome, h.codexHome);
  assert.equal(log.hasOpenAIKey, false, "the voice key never reaches Codex");
  assert.match(selfEditPrompt("x", "/wt"), /follow AGENTS\.md.*keep `pnpm run check` green.*Do not commit/is);

  // Review shows the diff; status lists it; the doctor row counts it.
  const review = await m.review(record.id);
  assert.match(review, /README\.md \| 1 \+/);
  assert.match(review, /\+Added by the agent\./);
  assert.match(await m.status(), new RegExp(`${record.id}: "add a line to the readme" — checked, 1 file, checks green`));
  const row = selfEditDoctorRow(m.worktreesDir, h.repo);
  assert.equal(row.pending, 1);
  assert.match(row.detail, /1 pending worktree \(se_\w+\).*no self-edit applied yet/);
});

test("self_edit: red checks carry the first failure line; a rail is flagged; nothing-changed and dirty-repo cases", async () => {
  const h = harness();
  const red = manager(h, { FAKE_EDIT_FILE: "FAIL", FAKE_EDIT_TEXT: "make the tests fail" });
  const bad = await red.edit("break the tests");
  assert.equal(bad.record.green, false);
  assert.deepEqual(bad.record.checks.map((c) => `${c.name}:${c.ok}`), ["typecheck:true", "test:false"], "tests do not run twice; nothing runs after a failure");
  assert.match(bad.record.checks[1]!.firstFailure ?? "", /not ok 1 - boom/);
  assert.match(bad.summary, /Checks red: test failed — not ok 1 - boom: the FAIL file exists\./);

  const rail = manager(h, { FAKE_EDIT_FILE: "packages/core/src/policy.ts", FAKE_EDIT_TEXT: "export const LOOSER = true;" });
  const touched = await rail.edit("relax the policy");
  assert.deepEqual(touched.record.rails, ["the policy (packages/core/src/policy.ts)"]);
  assert.match(touched.summary, /touches Jarhead's own safety rails: the policy \(packages\/core\/src\/policy\.ts\)\. Applying it needs Kevin to name that rail\./);

  const none = manager(h, {});
  const nothing = await none.edit("do nothing");
  assert.deepEqual(nothing.record.files, []);
  assert.equal(nothing.record.green, undefined);
  assert.match(nothing.summary, /made no changes/);
  assert.match(nothing.summary, /self_discard/);

  // Three worktrees exist; one is stale once a day passes.
  const later = manager(h, {}, { now: () => Date.now() + 25 * 60 * 60_000 });
  assert.equal(later.pending().length, 3);
  assert.match(await later.status(), /\(stale\)/);
  assert.equal(selfEditDoctorRow(later.worktreesDir, h.repo, () => Date.now() + 25 * 60 * 60_000).stale, 3);

  // Dirty main refuses before a worktree is made.
  writeFileSync(join(h.repo, "README.md"), "# dirty\n");
  await assert.rejects(manager(h, {}).edit("x"), /refusing to start a self-edit: the repo has 1 uncommitted change \(README\.md\)/);
  git(h.repo, "checkout", "--", "README.md");
  git(h.repo, "checkout", "-q", "-b", "feature");
  await assert.rejects(manager(h, {}).edit("x"), /on branch feature, not main/);
});

test("self_edit: Kevin's stop kills the agent; no agent means a manual worktree and self_check runs the checks afterwards", async () => {
  const h = harness();
  const hang = manager(h, { FAKE_CODEX_MODE: "hang" });
  const abort = new AbortController();
  const pending = hang.edit("take forever", { signal: abort.signal });
  await new Promise((r) => setTimeout(r, 400));
  abort.abort();
  const cancelled = await pending;
  assert.match(cancelled.summary, /was cancelled/);
  assert.equal(cancelled.record.agentOk, false);
  assert.match(cancelled.record.agentSummary, /cancelled/);

  const manual = new SelfEditManager({ repoRoot: h.repo, worktreesDir: join(h.root, "worktrees"), codexBin: false, claude: false, env: { ...process.env } });
  const { record, summary } = await manual.edit("edit by hand");
  assert.equal(record.agent, "manual");
  assert.match(summary, /No coding agent is available \(Codex disabled; Claude Code disabled\)\. The worktree for self-edit se_\w+ is ready at .* on branch jarhead\/self-se_\w+: make the change there yourself with read_file, edit_file and write_file, then call self_check se_\w+/);
  writeFileSync(join(record.dir, "packages", "engine", "src", "other.ts"), "export const x = 2;\n");
  const checked = await manual.check(record.id);
  assert.deepEqual(checked.record.files, ["packages/engine/src/other.ts"]);
  assert.equal(checked.record.green, true);
  assert.match(checked.summary, /changed 1 file/);
  const doneFail = manager(h, { FAKE_CODEX_MODE: "fail" });
  const failed = await doneFail.edit("x");
  assert.equal(failed.record.agentOk, false);
  assert.match(failed.record.agentSummary, /Codex did not finish: model says no/);
});

test("self_apply through the runner: the question comes first, a yes fast-forwards main, the worktree goes, and the restart hook fires for engine code", async () => {
  const h = harness();
  const restarts: string[] = [];
  const env = { ...process.env, FAKE_EDIT_FILE: "packages/engine/src/other.ts", FAKE_EDIT_TEXT: "export const y = 2;" };
  const { runner, toolset } = makeRunner({ home: h.root, requestRestart: (r) => restarts.push(r), restartDelayMs: 0, repoRoot: h.repo, env, selfEdit: { repoRoot: h.repo, codexBin: h.bin, codexHome: h.codexHome, claude: false, env } });
  const log = makeSink();
  runner.attach(log.sink, makeTask("change jarhead so other.ts exports y"));

  const edited = resultText((await runner.run("self_edit", { task: "export y from other.ts" })).result);
  const id = /Self-edit (se_\w+)/.exec(edited)?.[1];
  assert.ok(id, edited);
  assert.match(edited, /Checks green/);
  assert.ok(log.thinking.includes("Codex is working on it."), log.thinking.join(" | "));

  // The worktree is Jarhead's scratch: the file tools write there without asking — but an apply then needs a fresh check.
  const rec = runner.selfEdit.get(id!)!;
  const w = await runner.run("write_file", { path: join(rec.dir, "packages", "engine", "src", "note.ts"), content: "// note\n" });
  assert.equal(w.result.kind, "text", resultText(w.result));
  runner.attach(log.sink, makeTask(`apply ${id}`));
  const stale = await runner.run("self_apply", { id });
  assert.match(resultText(stale.result), /refused: the worktree of se_\w+ changed since its checks ran; call self_check/);
  const rechecked = resultText((await runner.run("self_check", { id })).result);
  assert.match(rechecked, /changed 2 files/);

  // Apply: always a question first, with the handshake's member and id.
  const ask = await runner.run("self_apply", { id });
  assert.equal(ask.result.kind, "needs-confirmation");
  assert.match(resultText(ask.result), /^needs_confirmation: Apply the change to Jarhead and restart it\? Self-edit se_\w+: It changes 2 files \(note\.ts, other\.ts\); checks green\./);
  assert.equal(toolset.confirmations.pending?.member, "self_apply");
  assert.deepEqual(restarts, []);
  assert.equal(git(h.repo, "log", "--oneline", "main").split("\n").length, 1, "nothing merged yet");

  // Kevin says yes: the delegator arms the pending confirmation and the brain calls the same tool again.
  assert.ok(toolset.confirmations.arm());
  const applied = resultText((await runner.run("self_apply", { id })).result);
  assert.match(applied, /^Applied self-edit se_\w+ to main \([0-9a-f]{7}\): 2 files\. Engine code changed, so Jarhead restarts on the new code in 0 seconds/);
  assert.deepEqual(restarts, [`self-update ${id}`], "the engine's requestRestart hook was called");
  assert.equal(git(h.repo, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.match(readFileSync(join(h.repo, "packages", "engine", "src", "other.ts"), "utf8"), /export const y = 2;/);
  assert.ok(existsSync(join(h.repo, "packages", "engine", "src", "note.ts")));
  assert.equal(git(h.repo, "log", "--oneline", "main").split("\n").length, 3, "init, the agent's commit, the re-check's commit");
  assert.equal(git(h.repo, "log", "--merges", "--oneline", "main"), "", "fast-forwarded, no merge commit");
  assert.equal(existsSync(rec.dir), false, "the worktree is gone");
  assert.ok(!git(h.repo, "branch", "--list", rec.branch), "the branch is gone");
  assert.equal(runner.selfEdit.get(id!)?.status, "applied");
  assert.match(runner.selfEdit.lastApply()?.id ?? "", new RegExp(id!));
  assert.match(await runner.selfEdit.status(), /a restart is pending \(self-update se_\w+\)/);
  assert.match(selfEditDoctorRow(runner.selfEdit.worktreesDir, h.repo).detail, /no pending worktrees; last apply se_\w+ .*→ main [0-9a-f]{7}/);

  // Applying twice, or an unknown id, is refused.
  assert.match(resultText((await runner.run("self_apply", { id })).result), /refused: self-edit se_\w+ was already applied/);
  assert.match(resultText((await runner.run("self_apply", { id: "se_nope" })).result), /no self-edit se_nope/);
});

test("self_apply: red checks are refused unless Kevin says anyway; a touched rail is refused unless he names it; discard removes everything; a README change needs no restart", async () => {
  const h = harness();
  const restarts: string[] = [];
  const mk = (edit: { file: string; text: string }) => {
    const env = { ...process.env, FAKE_EDIT_FILE: edit.file, FAKE_EDIT_TEXT: edit.text };
    return makeRunner({ home: h.root, requestRestart: (r) => restarts.push(r), restartDelayMs: 0, repoRoot: h.repo, env, selfEdit: { repoRoot: h.repo, codexBin: h.bin, codexHome: h.codexHome, claude: false, env, worktreesDir: join(h.root, "worktrees") } });
  };

  // Red checks.
  const red = mk({ file: "FAIL", text: "boom" });
  red.runner.attach(makeSink().sink, makeTask("break things"));
  const redId = /Self-edit (se_\w+)/.exec(resultText((await red.runner.run("self_edit", { task: "break the tests" })).result))![1]!;
  red.runner.attach(makeSink().sink, makeTask(`apply ${redId}`));
  assert.match(resultText((await red.runner.run("self_apply", { id: redId })).result), /refused: the checks were red \(test: not ok 1 - boom.*\); Kevin has to say to apply it anyway/);
  red.runner.attach(makeSink().sink, makeTask(`apply ${redId} anyway, I know the tests fail`));
  const redAsk = await red.runner.run("self_apply", { id: redId });
  assert.equal(redAsk.result.kind, "needs-confirmation");
  assert.match(resultText(redAsk.result), /checks red, applying anyway on Kevin's word/);
  assert.ok(saysApplyAnyway("apply it anyway") && saysApplyAnyway("even though the tests fail") && !saysApplyAnyway("apply it"));
  // Discard instead.
  const discarded = resultText((await red.runner.run("self_discard", { id: redId })).result);
  assert.match(discarded, /discarded self-edit se_\w+; its worktree and branch jarhead\/self-se_\w+ are gone and main is untouched/);
  assert.equal(red.runner.selfEdit.get(redId)?.status, "discarded");
  assert.ok(!git(h.repo, "branch", "--list", `jarhead/self-${redId}`));

  // A rail: the policy file. Kevin must name it.
  const rail = mk({ file: "packages/core/src/policy.ts", text: "export const LOOSER = true;" });
  rail.runner.attach(makeSink().sink, makeTask("loosen the never list"));
  const railText = resultText((await rail.runner.run("self_edit", { task: "loosen the never list" })).result);
  const railId = /Self-edit (se_\w+)/.exec(railText)![1]!;
  assert.match(railText, /touches Jarhead's own safety rails: the policy/);
  rail.runner.attach(makeSink().sink, makeTask(`apply ${railId}`));
  assert.match(resultText((await rail.runner.run("self_apply", { id: railId })).result), /refused: this change touches Jarhead's own safety rails \(the policy \(packages\/core\/src\/policy\.ts\)\) and Kevin's request did not name them/);
  rail.runner.attach(makeSink().sink, makeTask(`yes apply ${railId}, I want the policy change`));
  const railAsk = await rail.runner.run("self_apply", { id: railId });
  assert.equal(railAsk.result.kind, "needs-confirmation");
  assert.match(resultText(railAsk.result), /it touches the policy/);
  rail.toolset.confirmations.arm();
  const railApplied = resultText((await rail.runner.run("self_apply", { id: railId })).result);
  assert.match(railApplied, /^Applied self-edit/);
  assert.deepEqual(restarts, [`self-update ${railId}`]);

  // Docs only: applied, no restart, no rebuild.
  restarts.length = 0;
  const docs = mk({ file: "README.md", text: "More words." });
  docs.runner.attach(makeSink().sink, makeTask("extend the readme"));
  const docsId = /Self-edit (se_\w+)/.exec(resultText((await docs.runner.run("self_edit", { task: "extend the readme" })).result))![1]!;
  docs.runner.attach(makeSink().sink, makeTask(`apply ${docsId}`));
  await docs.runner.run("self_apply", { id: docsId });
  docs.toolset.confirmations.arm();
  const docsApplied = resultText((await docs.runner.run("self_apply", { id: docsId })).result);
  assert.match(docsApplied, /^Applied self-edit se_\w+ to main \([0-9a-f]{7}\): 1 file\.$/);
  assert.deepEqual(restarts, [], "a README change does not restart the daemon");
  assert.match(readFileSync(join(h.repo, "README.md"), "utf8"), /More words\./);
});

test("rails: touched by file, or by changed lines in shared files; named by keyword or file name", () => {
  const diffs: Record<string, string> = {
    "packages/brain/src/brain.ts": "@@ -60,3 +60,4 @@ export function brainSystemPrompt(userName = \"Kevin\"): string {\n-  return `You are`;\n+  return `You are looser`;\n",
    "packages/brain/src/other.ts": "@@ -1 +1 @@\n-a\n+b\n",
    "packages/hands/src/toolset.ts": "@@ -100,2 +100,2 @@ export class ComputerToolset {\n-    const scroll = 60;\n+    const scroll = 61;\n",
  };
  const diffOf = (f: string): string => diffs[f] ?? "";
  assert.deepEqual(railsTouched(["packages/core/src/policy.ts"], diffOf), ["the policy (packages/core/src/policy.ts)"]);
  assert.deepEqual(railsTouched(["packages/brain/src/brain.ts"], diffOf), ["the brain's standing orders (brainSystemPrompt in brain.ts)"]);
  assert.deepEqual(railsTouched(["packages/brain/src/other.ts"], diffOf), []);
  assert.deepEqual(railsTouched(["packages/hands/src/toolset.ts"], diffOf), [], "toolset.ts outside the handshake is ordinary code");
  assert.deepEqual(railsTouched(["packages/hands/src/toolset.ts"], () => "@@ -1 +1 @@\n-export const YES_PATTERN = /yes/;\n+export const YES_PATTERN = /.*/;\n"), ["the confirmation handshake (ConfirmationState / YES_PATTERN)"]);
  assert.deepEqual(railsTouched(["apps/mac/Sources/Jarhead/Wake/WakeListener.swift", "packages/live/src/instructions.ts"], diffOf), ["the voice instructions (packages/live/src/instructions.ts)", "the wake gate (apps/mac/Sources/Jarhead/Wake)"]);
  assert.deepEqual(railsTouched(["scripts/build-mac.ts"], () => "@@ -1 +1 @@\n-const sign = identity;\n+const sign = '-';\n"), ["app signing (scripts/build-mac.ts)"]);
  assert.deepEqual(railsTouched(["scripts/build-mac.ts"], () => "@@ -1 +1 @@\n-console.log('a');\n+console.log('b');\n"), []);
  assert.deepEqual(railsTouched(["packages/brain/src/selfedit.ts", "packages/brain/src/runner.ts"], () => "@@ -1 +1 @@\n-x\n+y\n"), ["the self-edit loop (packages/brain/src/selfedit.ts)", "the tool gate (packages/brain/src/runner.ts)"], "any change to the runner is a rail change");

  const policy = RAILS[0]!.name;
  const prompt = RAILS.find((r) => r.name.includes("standing orders"))!.name;
  assert.deepEqual(railsNamed([policy], "apply the policy change"), { ok: true, missing: [] });
  assert.deepEqual(railsNamed([policy], "apply it"), { ok: false, missing: [policy] });
  assert.deepEqual(railsNamed([policy, prompt], "yes change the policy and the system prompt"), { ok: true, missing: [] });
  assert.deepEqual(railsNamed([policy, prompt], "yes change the policy"), { ok: false, missing: [prompt] });
  assert.deepEqual(railsNamed(["the wake gate (apps/mac/Sources/Jarhead/Wake)"], "apply the wake word change"), { ok: true, missing: [] });
  assert.equal(firstFailureLine("ℹ tests 3\n✖ something broke\nℹ fail 1"), "✖ something broke");
  assert.equal(firstFailureLine("all fine\nlast line"), "last line");
});

test("self_status and doctor row with nothing pending", async (t: TestContext) => {
  const h = harness();
  const m = manager(h);
  t.after(() => undefined);
  assert.match(await m.status(), /^main is at [0-9a-f]{7}\.\nNo pending self-edits\.$/);
  assert.equal(selfEditDoctorRow(join(h.root, "nowhere"), h.repo).detail, "no pending worktrees; no self-edit applied yet");
});

/** An engine that only records the commands the daemon hands it. */
class RecordingEngine extends EventEmitter implements EngineLike {
  commands: unknown[] = [];
  ledger = { read: () => [], days: () => [], sessions: () => [], readSession: () => [], search: () => [], readChain: () => ({ rows: [], truncated: false }) };
  memory = { list: () => [], search: async () => [] };
  config = { stateDir: "/tmp/jh-test" };
  runner = { run: async (name: string): Promise<{ result: ToolResult }> => ({ result: { kind: "text", text: `${name} ok` } }) };
  runnerFor(): undefined {
    return undefined;
  }
  dropViewers(): void {}
  snapshot(): unknown {
    return {};
  }
  async command(cmd: unknown): Promise<void> {
    this.commands.push(cmd);
  }
  feedMic(): void {}
  reportInputLevel(): void {}
  setPermission(): void {}
  setPermissions(): void {}
  registerOwnPid(): void {}
  ear(): void {}
  problem(): void {}
}

test("self_apply without an engine hook sends daemon.restart over the daemon's own socket", async (t) => {
  const h = harness();
  const engine = new RecordingEngine();
  const socketPath = join(h.root, "d.sock");
  const server = new DaemonServer(engine, socketPath);
  await server.listen();
  t.after(() => server.close());
  const env = { ...process.env, FAKE_EDIT_FILE: "packages/engine/src/other.ts", FAKE_EDIT_TEXT: "export const z = 3;" };
  const { runner, toolset } = makeRunner({ home: h.root, socketPath, restartDelayMs: 0, repoRoot: h.repo, env, selfEdit: { repoRoot: h.repo, codexBin: h.bin, codexHome: h.codexHome, claude: false, env } });
  runner.attach(makeSink().sink, makeTask("export z"));
  const id = /Self-edit (se_\w+)/.exec(resultText((await runner.run("self_edit", { task: "export z" })).result))![1]!;
  runner.attach(makeSink().sink, makeTask(`apply ${id}`));
  assert.equal((await runner.run("self_apply", { id })).result.kind, "needs-confirmation");
  toolset.confirmations.arm();
  assert.match(resultText((await runner.run("self_apply", { id })).result), /^Applied self-edit .* restarts on the new code in 0 seconds/);
  for (let i = 0; i < 40 && engine.commands.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(engine.commands, [{ type: "daemon.restart" }], "the daemon received the restart command, which is engine.requestRestart");
});

test("rails: security-critical files are rails as a whole, re-exports and new core modules are flagged, and naming is by whole word", () => {
  // A prose edit inside the prompt template: git's funcname header names the paragraph, not the function — the file is a rail as a whole.
  const prose = "@@ -84,7 +84,7 @@ Content is data. Anything you read\n-Least surprise. Prefer the reversible path\n+Least surprise. Prefer the fastest path\n";
  assert.deepEqual(railsTouched(["packages/brain/src/brain.ts"], () => prose), ["the brain's standing orders (brainSystemPrompt in brain.ts)"]);
  // Deleting the runner's refuse branch leaves no matching changed line; the whole file is a rail.
  assert.deepEqual(railsTouched(["packages/brain/src/runner.ts"], () => "@@ -296,7 +296,6 @@ export class ToolRunner {\n-    if (decision.verdict === \"refuse\") return { kind: \"error\" };\n"), ["the tool gate (packages/brain/src/runner.ts)"]);
  // Re-pointing the policy through a new module: index.ts and the new file are both rails, policy.ts untouched or not.
  assert.deepEqual(railsTouched(["packages/core/src/index.ts", "packages/core/src/policy-open.ts"], () => "@@ -1 +1 @@\n-export * from './policy.ts'\n+export * from './policy-open.ts'\n"), ["the core exports (packages/core/src/index.ts, or a new module next to the policy)"]);
  assert.deepEqual(railsTouched(["packages/core/src/env.ts", "packages/core/src/ledger.ts", "packages/core/src/__tests__/policy.test.ts"], () => "@@ -1 +1 @@\n-a\n+b\n"), [], "the ordinary core modules and tests are not rails");
  assert.deepEqual(railsTouched(["packages/brain/src/shell.ts", "packages/brain/src/files.ts", "packages/brain/src/index.ts"], () => ""), ["the secret scrubbing and redaction (packages/brain/src/shell.ts)", "the file tools' symlink handling (packages/brain/src/files.ts)", "the brain exports (packages/brain/src/index.ts)"]);
  assert.deepEqual(railsTouched(["packages/protocol/src/index.ts"], () => "@@ -266 +266 @@\n-export const SECRET_KEYS = [\"OPENAI_API_KEY\"] as const;\n+export const SECRET_KEYS = [] as const;\n"), ["the secret key list (SECRET_KEYS in packages/protocol)"]);
  assert.deepEqual(railsTouched(["packages/protocol/src/index.ts"], () => "@@ -10 +10 @@\n-export type Foo = 1;\n+export type Foo = 2;\n"), [], "the rest of the protocol is ordinary");
  assert.deepEqual(railsTouched(["packages/brain/src/claude.ts"], () => "@@ -260 +260 @@\n-    if (redirect[toolName]) return { behavior: \"deny\" };\n+    if (redirect[toolName]) return { behavior: \"allow\" };\n"), ["the Claude Code permission gate (packages/brain/src/claude.ts)"]);

  const policy = RAILS[0]!.name;
  const wake = "the wake gate (apps/mac/Sources/Jarhead/Wake)";
  assert.deepEqual(railsNamed([wake], "are you awake? apply it"), { ok: false, missing: [wake] }, "awake does not name the wake gate");
  assert.deepEqual(railsNamed([wake], "apply the wake gate change"), { ok: true, missing: [] });
  const prompt = RAILS.find((r) => r.name.includes("standing orders"))!.name;
  assert.deepEqual(railsNamed([prompt], "change the prompts"), { ok: true, missing: [] }, "a plural still names it");
  assert.deepEqual(railsNamed([policy], "apply the policyx change"), { ok: false, missing: [policy] });
  // Jarhead's own summary must not count: the runner strips its lines, and the words alone are judged here.
  const jarheadSummary = "Jarhead: This change touches Jarhead's own safety rails: the policy (packages/core/src/policy.ts). Applying it needs Kevin to name that rail.";
  assert.deepEqual(railsNamed([policy], jarheadSummary), { ok: true, missing: [] }, "the words themselves name it — which is why the runner never feeds Jarhead's lines in");

  assert.ok(saysApplyAnyway("apply it anyway"));
  assert.ok(saysApplyAnyway("yes apply the change even though the tests fail"));
  assert.ok(saysApplyAnyway("even though the tests fail"));
  assert.ok(saysApplyAnyway("ignore the red checks and merge it"));
  assert.ok(saysApplyAnyway("the tests are red, apply it anyway"));
  assert.ok(!saysApplyAnyway("apply it"));
  assert.ok(!saysApplyAnyway("anyway, what is the weather"), "a filler anyway is not consent");
  assert.ok(!saysApplyAnyway("regardless of the weather, open slack"));
});

test("self_apply reads Kevin's words only: a rail named in Jarhead's own dialogue line does not count, in his own line it does; red checks likewise", async () => {
  const h = harness();
  const restarts: string[] = [];
  const env = { ...process.env, FAKE_EDIT_FILE: "packages/core/src/policy.ts", FAKE_EDIT_TEXT: "export const LOOSER = true;" };
  const { runner, toolset } = makeRunner({ home: h.root, requestRestart: (r) => restarts.push(r), restartDelayMs: 0, repoRoot: h.repo, env, selfEdit: { repoRoot: h.repo, codexBin: h.bin, codexHome: h.codexHome, claude: false, env } });
  runner.attach(makeSink().sink, makeTask("loosen the never list"));
  const id = /Self-edit (se_\w+)/.exec(resultText((await runner.run("self_edit", { task: "loosen the never list" })).result))![1]!;

  // The dialogue carries Jarhead's summary, which names the rail and says "anyway"; Kevin only said "yes".
  const dialogue = `Kevin: apply it\nJarhead: Apply the change to Jarhead and restart it? Self-edit ${id}: It changes 1 file (policy.ts); checks green, applying anyway on Kevin's word; it touches the policy (packages/core/src/policy.ts).\nKevin: yes`;
  runner.attach(makeSink().sink, makeTask("yes", undefined, { dialogue, kevinDialogue: "apply it\nyes" }));
  const refused = await runner.run("self_apply", { id });
  assert.equal(refused.result.kind, "error", resultText(refused.result));
  assert.match(resultText(refused.result), /touches Jarhead's own safety rails .*Kevin's request did not name them/);
  // Without kevinDialogue at all, only the request counts (fail closed).
  runner.attach(makeSink().sink, makeTask("yes", undefined, { dialogue }));
  assert.match(resultText((await runner.run("self_apply", { id })).result), /did not name them/);
  // Kevin's own earlier line names the policy: the guard passes and the question is asked.
  runner.attach(makeSink().sink, makeTask("yes", undefined, { dialogue, kevinDialogue: "apply the policy change\nyes" }));
  const ask = await runner.run("self_apply", { id });
  assert.equal(ask.result.kind, "needs-confirmation", resultText(ask.result));
  toolset.confirmations.arm();
  assert.match(resultText((await runner.run("self_apply", { id })).result), /^Applied self-edit/);
  assert.deepEqual(restarts, [`self-update ${id}`]);

  // Red checks: "anyway" in Jarhead's line is not Kevin's word.
  const redEnv = { ...process.env, FAKE_EDIT_FILE: "FAIL", FAKE_EDIT_TEXT: "boom" };
  const red = makeRunner({ home: h.root, requestRestart: () => undefined, restartDelayMs: 0, repoRoot: h.repo, env: redEnv, selfEdit: { repoRoot: h.repo, codexBin: h.bin, codexHome: h.codexHome, claude: false, env: redEnv, worktreesDir: join(h.root, "worktrees") } });
  red.runner.attach(makeSink().sink, makeTask("break the tests"));
  const redId = /Self-edit (se_\w+)/.exec(resultText((await red.runner.run("self_edit", { task: "break the tests" })).result))![1]!;
  red.runner.attach(makeSink().sink, makeTask("yes", undefined, { dialogue: "Jarhead: the checks are red; apply it anyway?\nKevin: yes", kevinDialogue: "yes" }));
  assert.match(resultText((await red.runner.run("self_apply", { id: redId })).result), /refused: the checks were red/);
  red.runner.attach(makeSink().sink, makeTask("yes", undefined, { kevinDialogue: "apply it anyway, I know the tests fail\nyes" }));
  assert.equal((await red.runner.run("self_apply", { id: redId })).result.kind, "needs-confirmation");
});

test("self_apply with neither a restart hook nor a daemon socket says so instead of promising a restart", async () => {
  const h = harness();
  const env = { ...process.env, FAKE_EDIT_FILE: "packages/engine/src/other.ts", FAKE_EDIT_TEXT: "export const w = 4;" };
  // No requestRestart, no socketPath: the fallback is <stateDir>/jarhead.sock, which does not exist in a fresh temp state dir.
  const { runner, toolset, dir } = makeRunner({ home: h.root, restartDelayMs: 0, repoRoot: h.repo, env, selfEdit: { repoRoot: h.repo, codexBin: h.bin, codexHome: h.codexHome, claude: false, env } });
  assert.equal(existsSync(join(dir, "jarhead.sock")), false);
  runner.attach(makeSink().sink, makeTask("export w"));
  const id = /Self-edit (se_\w+)/.exec(resultText((await runner.run("self_edit", { task: "export w" })).result))![1]!;
  runner.attach(makeSink().sink, makeTask(`apply ${id}`));
  assert.equal((await runner.run("self_apply", { id })).result.kind, "needs-confirmation");
  toolset.confirmations.arm();
  const applied = resultText((await runner.run("self_apply", { id })).result);
  assert.match(applied, /^Applied self-edit/);
  assert.match(applied, /no restart hook is wired .* quit and relaunch Jarhead/);
  assert.ok(!/restarts on the new code/.test(applied), applied);
  assert.equal(runner.selfEdit.restartPending, undefined, "nothing was scheduled, so nothing is pending");
  assert.ok(!/restart is pending/.test(await runner.selfEdit.status()));
});

// ------------------------------------------------------------ the user's name ---

test("the user's name: the agent prompt and the spoken summary say the name the runner passes, with no pronoun after it; the default renders as before", () => {
  const kevin = selfEditPrompt("fix the typo", "/wt");
  const sam = selfEditPrompt("fix the typo", "/wt", "Sam");
  assert.doesNotMatch(sam, /Kevin/);
  assert.match(sam, /^You are making one change to Jarhead, Sam's voice-first Mac assistant, in a git worktree at \/wt \(branch of main\)\. Sam asked, out loud: "fix the typo"/);
  assert.equal(sam.replaceAll("Sam", "Kevin"), kevin, "only the name moves");
  const rec = {
    id: "se_name",
    task: "relax the policy",
    branch: "jarhead/self-se_name",
    dir: "/wt",
    createdAt: 1,
    updatedAt: 1,
    status: "checked",
    agent: "codex",
    agentOk: true,
    agentSummary: "",
    files: ["packages/core/src/policy.ts"],
    diffStat: " 1 file changed, 1 insertion(+)",
    checks: [{ name: "typecheck", ok: true, ms: 1 }],
    green: true,
    rails: ["the policy (packages/core/src/policy.ts)"],
  } satisfies SelfEditRecord;
  const worktreesDir = join(tmpdir(), "jh-selfedit-name");
  const forSam = new SelfEditManager({ worktreesDir, codexBin: false, claude: false, userName: () => "Sam" }).summary(rec);
  const forKevin = new SelfEditManager({ worktreesDir, codexBin: false, claude: false }).summary(rec);
  assert.doesNotMatch(forSam, /Kevin/);
  assert.match(forSam, /This change touches Jarhead's own safety rails: the policy \(packages\/core\/src\/policy\.ts\)\. Applying it needs Sam to name that rail\. Say the word to apply se_name/);
  assert.match(forKevin, /Applying it needs Kevin to name that rail\./);
  assert.equal(forSam.replaceAll("Sam", "Kevin"), forKevin, "only the name moves");
});
