import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { LineSplitter, REPO_ROOT, classifyAction, logger, newId } from "@jarhead/core";
import { ClaudeSession, claudeEnv, loadSdk, type PermissionDecision, type SdkLike } from "@jarhead/agents";
import { codexConfigModel, codexEnv, codexHomeDir, codexSignedIn, findCodexBinary } from "./codex.ts";
import { describeShellResult, runShell, type ShellRunResult } from "./shell.ts";

/**
 * Self-modification, as a checked and confirmed loop.
 *
 *   self_edit    a git worktree of the Jarhead repo on branch jarhead/self-<id>; a
 *                coding agent (Codex, else Claude Code, else the brain's own file
 *                tools) makes the change; it is committed; the checks run
 *                (install when the lockfile changed, typecheck, tests, swift build
 *                when the Mac app changed); a spoken summary comes back with the id.
 *   self_review  the diff against main.
 *   self_apply   after Kevin's yes to that exact question: fast-forward into main,
 *                install if needed, remove the worktree, and the caller restarts the
 *                daemon (engine code) or rebuilds the app (apps/mac).
 *   self_discard remove the worktree and branch.
 *
 * Nothing here touches the running checkout until apply, and apply refuses when
 * the checks were red (unless Kevin said to apply anyway) or when the change
 * touches one of Jarhead's own safety rails that his request did not name. The
 * rails are listed in RAILS; a security-critical file is a rail as a whole (a
 * hunk regex is easy to dodge), and only a file that is mostly ordinary code is
 * judged by the lines that changed. The request the guard reads is Kevin's own
 * words — the runner strips Jarhead's lines before they get here.
 */

const log = logger("brain.selfedit");

export const SELF_EDIT_BUDGET_MS = 15 * 60_000;
export const STALE_AFTER_MS = 24 * 60 * 60_000;
const DIFF_CAP = 12_000;

export interface SelfEditCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  /** The first line that looks like the failure, for the spoken summary. */
  readonly firstFailure?: string | undefined;
  readonly skipped?: string | undefined;
}

export type SelfEditAgent = "codex" | "claude-code" | "manual";

export interface SelfEditRecord {
  readonly id: string;
  readonly task: string;
  readonly branch: string;
  readonly dir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: "editing" | "checked" | "applied" | "discarded";
  readonly agent: SelfEditAgent;
  readonly agentOk: boolean;
  readonly agentSummary: string;
  /** Paths changed relative to the repo root. */
  readonly files: readonly string[];
  readonly diffStat: string;
  readonly head?: string | undefined;
  readonly checks: readonly SelfEditCheck[];
  /** undefined until the checks ran (or when there was nothing to check). */
  readonly green?: boolean | undefined;
  /** Human names of the safety rails the diff touches. */
  readonly rails: readonly string[];
}

export interface LastApply {
  readonly id: string;
  readonly at: number;
  readonly files: readonly string[];
  readonly restart: boolean;
  readonly builtMac: boolean;
  readonly head: string;
}

export interface CheckCommand {
  readonly name: string;
  readonly argv: readonly string[];
  readonly timeoutMs?: number | undefined;
}

export interface CheckContext {
  readonly dir: string;
  readonly changed: readonly string[];
  readonly lockfileChanged: boolean;
}

export interface SelfEditOptions {
  /** The Jarhead checkout the daemon runs from (default REPO_ROOT). */
  readonly repoRoot?: string | undefined;
  /** Where worktrees and their records live (default <stateDir>/worktrees). */
  readonly worktreesDir: string;
  /** JARHEAD_CODEX_BIN; `false` skips Codex. */
  readonly codexBin?: string | false | undefined;
  readonly codexHome?: string | undefined;
  /** Model for the coding agent; empty = the agent's own default. */
  readonly model?: string | undefined;
  /** `false` skips the Claude Code fallback. */
  readonly claude?: boolean | undefined;
  /** JARHEAD_CLAUDE_BIN; otherwise PATH, ~/.local/bin and ~/.claude/local are searched. */
  readonly claudeBin?: string | undefined;
  /** Test seam for the Claude Code fallback. */
  readonly claudeSdk?: SdkLike | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly budgetMs?: number | undefined;
  /** Wall clock for the coding agent within the budget (default 10 min). */
  readonly agentBudgetMs?: number | undefined;
  /** Test seam: the check commands for a worktree; the default is pnpm's. */
  readonly checks?: ((ctx: CheckContext) => CheckCommand[]) | undefined;
  readonly now?: (() => number) | undefined;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The pnpm that runs the checks. The daemon is spawned by the app with launchd's
 * PATH, which has no nvm in it, so the copy next to this process's node comes
 * first; then PATH, then the usual homes. Falls back to the bare name.
 */
export function pnpmBinary(env: NodeJS.ProcessEnv = process.env): string {
  const home = env["HOME"] || homedir();
  const candidates = [join(dirname(process.execPath), "pnpm"), ...(env["PATH"] ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "pnpm")), join(home, "Library", "pnpm", "pnpm"), "/opt/homebrew/bin/pnpm", "/usr/local/bin/pnpm"];
  return candidates.find(isExecutable) ?? "pnpm";
}

/** JARHEAD_CLAUDE_BIN → PATH → the places the Claude Code installer uses. */
export function findClaudeBinary(explicit: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (explicit) return isExecutable(explicit) ? explicit : undefined;
  const home = env["HOME"] || homedir();
  const candidates = [...(env["PATH"] ?? "").split(delimiter).filter(Boolean).map((d) => join(d, "claude")), join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
  return candidates.find(isExecutable);
}

/** What the coding agent is told besides the task. */
export function selfEditPrompt(task: string, dir: string): string {
  return [
    `You are making one change to Jarhead, Kevin's voice-first Mac assistant, in a git worktree at ${dir} (branch of main). Kevin asked, out loud: "${task}"`,
    "Rules: follow AGENTS.md in the repo root. Keep `pnpm run check` green (typecheck, tests, doctor). Do not touch ~/.jarhead/env, the never-list in packages/core/src/policy.ts, the wake gate (apps/mac/Sources/Jarhead/Wake), or the confirmation handshake (ConfirmationState in packages/hands) unless the task names them; do not re-point their exports through another file either. Do not commit; Jarhead commits for you. Do not push. No new dependencies without a reason in your summary.",
    "When you are done, explain in a few plain sentences what you changed and why, naming the files. If the task cannot be done safely, say so and change nothing.",
  ].join("\n\n");
}

interface Rail {
  readonly name: string;
  readonly file: RegExp;
  /** When set, the rail is touched only if a changed line (or hunk header) matches. */
  readonly hunk?: RegExp | undefined;
  /** Words in Kevin's request that count as naming the rail. */
  readonly keywords: readonly string[];
}

/** The modules of packages/core that are ordinary code; any other file there is new and sits next to the policy. */
const CORE_ORDINARY = new Set(["packages/core/src/env.ts", "packages/core/src/ids.ts", "packages/core/src/ledger.ts", "packages/core/src/log.ts", "packages/core/src/marks.ts", "packages/core/src/ndjson.ts"]);

export const RAILS: readonly Rail[] = [
  { name: "the policy (packages/core/src/policy.ts)", file: /^packages\/core\/src\/policy\.ts$/, keywords: ["policy", "never list", "never-list", "destructive"] },
  { name: "the core exports (packages/core/src/index.ts, or a new module next to the policy)", file: /^packages\/core\/src\/(index\.ts|(?!__tests__\/)[^/]+\.ts)$/, keywords: ["policy", "core exports", "core index", "index.ts", "core module"] },
  { name: "the brain's standing orders (brainSystemPrompt in brain.ts)", file: /^packages\/brain\/src\/brain\.ts$/, keywords: ["system prompt", "standing orders", "brain prompt", "brainsystemprompt", "prompt", "brain.ts"] },
  { name: "the voice instructions (packages/live/src/instructions.ts)", file: /^packages\/live\/src\/instructions\.ts$/, keywords: ["instructions", "voice prompt", "live prompt", "personality", "capabilities"] },
  { name: "the confirmation handshake (ConfirmationState / YES_PATTERN)", file: /^packages\/hands\/src\/toolset\.ts$/, hunk: /ConfirmationState|YES_PATTERN|sameTarget|\.consume\(|\.arm\(|confirmations|verdict|refuse|needs-confirmation|policy|gate\(/, keywords: ["confirmation", "handshake", "yes pattern", "yes_pattern", "confirmationstate", "toolset.ts"] },
  { name: "the wake gate (apps/mac/Sources/Jarhead/Wake)", file: /^apps\/mac\/Sources\/Jarhead\/Wake\//, keywords: ["wake"] },
  { name: "app signing (scripts/build-mac.ts)", file: /^scripts\/build-mac\.ts$/, hunk: /codesign|identity|sign|entitlements/i, keywords: ["signing", "codesign", "build-mac", "build mac", "identity"] },
  { name: "the self-edit loop (packages/brain/src/selfedit.ts)", file: /^packages\/brain\/src\/selfedit\.ts$/, keywords: ["self-edit", "self edit", "selfedit", "self_apply", "self_edit", "rail"] },
  { name: "the tool gate (packages/brain/src/runner.ts)", file: /^packages\/brain\/src\/runner\.ts$/, keywords: ["runner", "tool gate", "gate", "runner.ts"] },
  { name: "the secret scrubbing and redaction (packages/brain/src/shell.ts)", file: /^packages\/brain\/src\/shell\.ts$/, keywords: ["shell.ts", "scrub", "redact", "secret"] },
  { name: "the file tools' symlink handling (packages/brain/src/files.ts)", file: /^packages\/brain\/src\/files\.ts$/, keywords: ["files.ts", "file tools", "symlink", "realpath"] },
  { name: "the brain exports (packages/brain/src/index.ts)", file: /^packages\/brain\/src\/index\.ts$/, keywords: ["brain exports", "brain index", "index.ts"] },
  { name: "the Claude Code permission gate (packages/brain/src/claude.ts)", file: /^packages\/brain\/src\/claude\.ts$/, hunk: /permission|canUseTool|behavior|disallowedTools|allowedTools|permissionMode/, keywords: ["claude.ts", "permission", "claude brain", "claude code brain"] },
  { name: "the Codex sandbox and addendum (packages/brain/src/codex.ts)", file: /^packages\/brain\/src\/codex\.ts$/, hunk: /read-only|sandbox|codexAddendum|--ignore-user-config|approval|workspace-write|danger-full-access/, keywords: ["codex.ts", "codex sandbox", "codex addendum", "codex brain"] },
  { name: "the secret key list (SECRET_KEYS in packages/protocol)", file: /^packages\/protocol\/src\/index\.ts$/, hunk: /SECRET_KEYS|SecretKey/, keywords: ["secret_keys", "secret keys", "protocol"] },
];

/** True for a file the rails treat as a whole, false for one judged by its changed lines. */
function railAppliesTo(rail: Rail, file: string): boolean {
  if (!rail.file.test(file)) return false;
  // packages/core/src/*.ts: the known ordinary modules are not rails; policy.ts has its own entry.
  if (rail.file.source.startsWith("^packages\\/core\\/src\\/(index")) return !CORE_ORDINARY.has(file) && file !== "packages/core/src/policy.ts";
  return true;
}

/** The rails a diff touches: by file, or by changed lines where the file is shared with ordinary code. */
export function railsTouched(files: readonly string[], diffOf: (file: string) => string): string[] {
  const out: string[] = [];
  for (const rail of RAILS) {
    for (const file of files) {
      if (!railAppliesTo(rail, file)) continue;
      if (rail.hunk) {
        const diff = diffOf(file);
        const changed = diff.split("\n").filter((l) => /^[+-](?![+-])/.test(l) || l.startsWith("@@"));
        if (!changed.some((l) => rail.hunk!.test(l))) continue;
      }
      if (!out.includes(rail.name)) out.push(rail.name);
    }
  }
  return out;
}

/** A keyword as a whole word (or its plural): "wake" is not in "awake", "prompt" is in "prompts". */
function namesWord(text: string, word: string): boolean {
  const re = new RegExp(String.raw`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|es)?(?=$|[^a-z0-9])`, "i");
  return re.test(text);
}

/**
 * Every touched rail must be named in Kevin's words (a keyword or the file's
 * basename). The text is his request and his own utterances, never the dialogue
 * the model produced: the runner strips Jarhead's lines before calling this.
 */
export function railsNamed(rails: readonly string[], request: string): { ok: boolean; missing: string[] } {
  const text = request.toLowerCase();
  const missing: string[] = [];
  for (const name of rails) {
    const rail = RAILS.find((r) => r.name === name);
    const words = [...(rail?.keywords ?? []), ...(rail ? name.match(/[\w./-]+\.(ts|swift)/g) ?? [] : [])].map((w) => w.toLowerCase());
    if (!words.some((w) => namesWord(text, w))) missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Kevin asking for a red change to land: "apply it anyway", "merge it regardless",
 * "apply even though the tests fail", "ignore the red checks". A bare "anyway" or a
 * question containing the word does not count; the intent to apply has to be near it.
 */
export function saysApplyAnyway(request: string): boolean {
  const apply = String.raw`(apply|merge|ship|land|install|go ahead with|do) (it|that|this|the (change|edit|patch|self[- ]edit))?`;
  const anyway = String.raw`(anyway|regardless|even (though|if|with)|despite|ignore|ignoring)`;
  return (
    new RegExp(String.raw`\b${apply}\b[^.?!\n]{0,60}\b${anyway}\b`, "i").test(request) ||
    new RegExp(String.raw`\b${anyway}\b[^.?!\n]{0,60}\b(apply|merge|ship|land)\b`, "i").test(request) ||
    /\bignore (the |those |its )?(failing|red|broken|failed) (checks?|tests?)\b/i.test(request) ||
    /\b(even (though|if)|despite)\b[^.?!\n]{0,40}\b(tests?|checks?|typecheck|build)\b[^.?!\n]{0,20}\b(fail|failing|failed|red|broken|is broken|are broken)\b/i.test(request) ||
    /\b(tests?|checks?) (are|is) (red|failing|broken)\b[^.?!\n]{0,40}\b(apply|merge|ship|land|still|anyway)\b/i.test(request)
  );
}

export const DEFAULT_CHECKS = (ctx: CheckContext): CheckCommand[] => {
  const out: CheckCommand[] = [];
  const pnpm = pnpmBinary();
  const hasLock = existsSync(join(ctx.dir, "pnpm-lock.yaml"));
  if (hasLock && (ctx.lockfileChanged || !existsSync(join(ctx.dir, "node_modules")))) out.push({ name: "install", argv: [pnpm, "install", "--frozen-lockfile", "--prefer-offline"], timeoutMs: 5 * 60_000 });
  out.push({ name: "typecheck", argv: [pnpm, "run", "typecheck"], timeoutMs: 5 * 60_000 });
  out.push({ name: "test", argv: [pnpm, "run", "test"], timeoutMs: 8 * 60_000 });
  if (ctx.changed.some((f) => f.startsWith("apps/mac/"))) out.push({ name: "swift build", argv: ["swift", "build", "--package-path", "apps/mac"], timeoutMs: 10 * 60_000 });
  return out;
};

/** The line of a failed check worth reading out: the first error-looking one, else the last. */
export function firstFailureLine(output: string): string | undefined {
  // A passing test whose NAME says "failed" ("✔ … a failed queue is refused") is not a failure:
  // passing lines and the runner's ℹ summary never qualify. Hard markers first (a failing test,
  // an assertion, pnpm's ELIFECYCLE, a compiler code), the loose words only when nothing harder is there.
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !/^[✔✓]/.test(l) && !/^ℹ/.test(l));
  const hard = lines.find((l) => /(^|\s)(✖|✘|✗|not ok|AssertionError|ELIFECYCLE|TS\d{4}:|Error:)(\s|:|\b)/.test(l));
  const loose = hard ?? lines.find((l) => /(^|\s)(error|FAIL|failed)(\s|:|\b)/.test(l));
  return (loose ?? lines[lines.length - 1])?.slice(0, 200);
}

function gitExec(repo: string, args: readonly string[], opts: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${String(stderr).trim() || err.message}`));
      else resolve(String(stdout));
    });
  });
}

export class SelfEditManager {
  private readonly now: () => number;
  readonly repoRoot: string;
  readonly worktreesDir: string;
  /** Set once a restart was requested after an apply; self_status reports it. */
  restartPending: string | undefined;

  constructor(private readonly opts: SelfEditOptions) {
    this.now = opts.now ?? Date.now;
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.worktreesDir = opts.worktreesDir;
  }

  // ---------------------------------------------------------------- records

  private recordPath(id: string): string {
    return join(this.worktreesDir, `${id}.json`);
  }

  private save(rec: SelfEditRecord): SelfEditRecord {
    mkdirSync(this.worktreesDir, { recursive: true });
    writeFileSync(this.recordPath(rec.id), JSON.stringify(rec, null, 2));
    return rec;
  }

  get(id: string): SelfEditRecord | undefined {
    try {
      return JSON.parse(readFileSync(this.recordPath(id.trim()), "utf8")) as SelfEditRecord;
    } catch {
      return undefined;
    }
  }

  /** Every record on disk, oldest first. */
  list(): SelfEditRecord[] {
    if (!existsSync(this.worktreesDir)) return [];
    const out: SelfEditRecord[] = [];
    for (const name of readdirSync(this.worktreesDir)) {
      if (!name.endsWith(".json") || name === "last-apply.json") continue;
      try {
        out.push(JSON.parse(readFileSync(join(this.worktreesDir, name), "utf8")) as SelfEditRecord);
      } catch {
        // a half-written record is not worth a crash
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Records whose worktree still exists (editing or checked). */
  pending(): SelfEditRecord[] {
    return this.list().filter((r) => (r.status === "editing" || r.status === "checked") && existsSync(r.dir));
  }

  /** The worktree directories: the file tools write there without asking. */
  worktreeDirs(): string[] {
    return this.pending().map((r) => r.dir);
  }

  lastApply(): LastApply | undefined {
    try {
      return JSON.parse(readFileSync(join(this.worktreesDir, "last-apply.json"), "utf8")) as LastApply;
    } catch {
      return undefined;
    }
  }

  isStale(rec: SelfEditRecord): boolean {
    return this.now() - rec.createdAt > STALE_AFTER_MS;
  }

  // ------------------------------------------------------------------- git

  private git(args: readonly string[], opts: { signal?: AbortSignal | undefined; cwd?: string | undefined; timeoutMs?: number | undefined } = {}): Promise<string> {
    return gitExec(opts.cwd ?? this.repoRoot, args, { signal: opts.signal, timeoutMs: opts.timeoutMs });
  }

  /** Why the repo is not ready for a self-edit or an apply, if it is not. */
  async repoNotClean(): Promise<string | undefined> {
    let branch: string;
    try {
      branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    } catch (e) {
      return `${this.repoRoot} is not a git repository (${(e as Error).message})`;
    }
    if (branch !== "main") return `the repo is on branch ${branch}, not main`;
    const status = (await this.git(["status", "--porcelain", "--untracked-files=no"])).trimEnd();
    if (status) {
      const files = status.split("\n").map((l) => l.slice(3).trim());
      return `the repo has ${files.length} uncommitted change${files.length === 1 ? "" : "s"} (${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}); commit or stash them first`;
    }
    return undefined;
  }

  async mainHead(): Promise<string> {
    return (await this.git(["rev-parse", "--short", "main"])).trim();
  }

  private async changedFiles(rec: Pick<SelfEditRecord, "dir">): Promise<string[]> {
    const out = await this.git(["diff", "--name-only", "main...HEAD"], { cwd: rec.dir });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  private async diffStat(rec: Pick<SelfEditRecord, "dir">): Promise<string> {
    return (await this.git(["diff", "--stat", "main...HEAD"], { cwd: rec.dir })).trim();
  }

  private async diffOfFile(rec: Pick<SelfEditRecord, "dir">, file: string): Promise<string> {
    return this.git(["diff", "main...HEAD", "--", file], { cwd: rec.dir });
  }

  /** Uncommitted work in the worktree (what the agent or the brain left there); node_modules does not count. */
  private async worktreeDirty(rec: Pick<SelfEditRecord, "dir">): Promise<boolean> {
    const lines = (await this.git(["status", "--porcelain"], { cwd: rec.dir })).split("\n").filter((l) => l.trim() && !/(^|\/)node_modules(\/|$)/.test(l.slice(3)));
    return lines.length > 0;
  }

  /** Stage and commit whatever the agent (or the brain) left in the worktree; node_modules never, whatever .gitignore says. */
  private async commitAll(rec: Pick<SelfEditRecord, "dir" | "id" | "task">): Promise<boolean> {
    await this.git(["add", "-A"], { cwd: rec.dir });
    await this.git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "node_modules", "*/node_modules"], { cwd: rec.dir });
    const staged = (await this.git(["diff", "--cached", "--name-only"], { cwd: rec.dir })).trim();
    if (!staged) return false;
    await this.git(["-c", "user.name=Jarhead", "-c", "user.email=jarhead@localhost", "commit", "-q", "-m", `self-edit ${rec.id}: ${rec.task.slice(0, 72)}`], { cwd: rec.dir });
    return true;
  }

  // ------------------------------------------------------------------ edit

  /**
   * The whole loop up to the summary. `progress` gets spoken-friendly lines as
   * the agent and the checks work; `signal` (Kevin's stop) kills the child.
   */
  async edit(task: string, opts: { readonly signal?: AbortSignal | undefined; readonly progress?: ((line: string) => void) | undefined } = {}): Promise<{ record: SelfEditRecord; summary: string }> {
    const progress = opts.progress ?? (() => undefined);
    const started = this.now();
    const deadline = started + (this.opts.budgetMs ?? SELF_EDIT_BUDGET_MS);
    const dirty = await this.repoNotClean();
    if (dirty) throw new Error(`refusing to start a self-edit: ${dirty}`);
    const id = newId("se");
    const branch = `jarhead/self-${id}`;
    const dir = join(this.worktreesDir, id);
    mkdirSync(this.worktreesDir, { recursive: true });
    await this.git(["worktree", "add", "-q", "-b", branch, dir, "main"], { signal: opts.signal });
    let rec: SelfEditRecord = this.save({ id, task, branch, dir, createdAt: started, updatedAt: started, status: "editing", agent: "manual", agentOk: false, agentSummary: "", files: [], diffStat: "", checks: [], rails: [] });
    progress(`Made a worktree for self-edit ${id}.`);

    const agentBudget = Math.min(this.opts.agentBudgetMs ?? 10 * 60_000, deadline - this.now());
    const agent = await this.runAgent(rec, agentBudget, opts.signal, progress);
    rec = this.save({ ...rec, agent: agent.kind, agentOk: agent.ok, agentSummary: agent.summary, updatedAt: this.now() });
    if (opts.signal?.aborted) return { record: rec, summary: `Self-edit ${id} was cancelled; its worktree is at ${dir}.` };
    if (agent.kind === "manual") return { record: rec, summary: agent.summary };

    const checked = await this.check(id, { signal: opts.signal, progress, deadline });
    return checked;
  }

  /** Commit what is in the worktree, run the checks, refresh the record, summarise. */
  async check(id: string, opts: { readonly signal?: AbortSignal | undefined; readonly progress?: ((line: string) => void) | undefined; readonly deadline?: number | undefined } = {}): Promise<{ record: SelfEditRecord; summary: string }> {
    const progress = opts.progress ?? (() => undefined);
    let rec = this.get(id);
    if (!rec) throw new Error(`no self-edit ${id}; call self_status`);
    if (!existsSync(rec.dir)) throw new Error(`the worktree of ${id} is gone (${rec.dir}); it was applied or discarded`);
    if (rec.status === "applied" || rec.status === "discarded") throw new Error(`self-edit ${id} was already ${rec.status}`);
    const deadline = opts.deadline ?? this.now() + (this.opts.budgetMs ?? SELF_EDIT_BUDGET_MS);
    await this.commitAll(rec);
    const files = await this.changedFiles(rec);
    const stat = files.length ? await this.diffStat(rec) : "";
    const head = files.length ? (await this.git(["rev-parse", "--short", "HEAD"], { cwd: rec.dir })).trim() : undefined;
    if (files.length === 0) {
      rec = this.save({ ...rec, files, diffStat: stat, head, checks: [], green: undefined, rails: [], status: "checked", updatedAt: this.now() });
      return { record: rec, summary: `Self-edit ${id} made no changes${rec.agentSummary ? `: ${rec.agentSummary.slice(0, 300)}` : "."} Nothing to apply; self_discard ${id} removes the worktree.` };
    }
    const diffs = new Map<string, string>();
    for (const f of files) if (RAILS.some((r) => r.file.test(f) && r.hunk)) diffs.set(f, await this.diffOfFile(rec, f));
    const rails = railsTouched(files, (f) => diffs.get(f) ?? "");
    const lockfileChanged = files.includes("pnpm-lock.yaml");
    const commands = (this.opts.checks ?? DEFAULT_CHECKS)({ dir: rec.dir, changed: files, lockfileChanged });
    const checks: SelfEditCheck[] = [];
    let green = true;
    for (const cmd of commands) {
      if (opts.signal?.aborted) break;
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        checks.push({ name: cmd.name, ok: false, ms: 0, skipped: "out of time" });
        green = false;
        break;
      }
      progress(`Running ${cmd.name}.`);
      const r = await runShell({ command: cmd.argv.join(" "), argv: cmd.argv, cwd: rec.dir, timeoutMs: Math.min(cmd.timeoutMs ?? 5 * 60_000, remaining), signal: opts.signal, env: this.opts.env });
      const ok = r.code === 0 && !r.timedOut && !r.cancelled && !r.error;
      const failure = ok ? undefined : r.error ?? (r.timedOut ? `stopped after ${Math.round(r.ms / 1000)} s` : firstFailureLine(`${r.stdout}\n${r.stderr}`));
      checks.push({ name: cmd.name, ok, ms: r.ms, ...(failure ? { firstFailure: failure } : {}) });
      progress(ok ? `${cmd.name} passed.` : `${cmd.name} failed: ${failure ?? "unknown"}`);
      if (!ok) {
        green = false;
        break; // a failed install makes typecheck meaningless; a failed typecheck makes tests noise
      }
    }
    rec = this.save({ ...rec, files, diffStat: stat, head, checks, green, rails, status: "checked", updatedAt: this.now() });
    return { record: rec, summary: this.summary(rec) };
  }

  /** Spoken-friendly: what changed, the diff stat, checks, rails, id. */
  summary(rec: SelfEditRecord): string {
    const parts: string[] = [];
    const n = rec.files.length;
    const statLine = rec.diffStat.split("\n").pop()?.trim() ?? "";
    parts.push(`Self-edit ${rec.id} changed ${n} file${n === 1 ? "" : "s"}${statLine ? ` (${statLine.replace(/^\d+ files? changed,?\s*/, "")})` : ""}: ${rec.files.slice(0, 6).map((f) => basename(f)).join(", ")}${n > 6 ? ` and ${n - 6} more` : ""}.`);
    if (rec.agentSummary) parts.push(rec.agentSummary.replace(/\s+/g, " ").slice(0, 400));
    if (rec.checks.length === 0) parts.push("The checks did not run.");
    else if (rec.green) parts.push(`Checks green: ${rec.checks.map((c) => c.name).join(", ")}.`);
    else {
      const bad = rec.checks.find((c) => !c.ok);
      parts.push(`Checks red: ${bad?.name ?? "?"} failed${bad?.firstFailure ? ` — ${bad.firstFailure}` : bad?.skipped ? ` (${bad.skipped})` : ""}.`);
    }
    if (rec.rails.length) parts.push(`This change touches Jarhead's own safety rails: ${rec.rails.join("; ")}. Applying it needs Kevin to name that rail himself.`);
    parts.push(`Say the word to apply ${rec.id}, or ask what changed.`);
    return parts.join(" ");
  }

  // ----------------------------------------------------------------- agent

  private async runAgent(rec: SelfEditRecord, budgetMs: number, signal: AbortSignal | undefined, progress: (line: string) => void): Promise<{ kind: SelfEditAgent; ok: boolean; summary: string }> {
    const prompt = selfEditPrompt(rec.task, rec.dir);
    const env = this.opts.env ?? process.env;
    const why: string[] = [];
    if (this.opts.codexBin !== false) {
      const bin = findCodexBinary(this.opts.codexBin || undefined, { env });
      const codexHome = this.opts.codexHome ?? codexHomeDir(env);
      const signedIn = bin ? codexSignedIn(codexHome) : undefined;
      if (bin && signedIn !== false) {
        progress("Codex is working on it.");
        const r = await this.runCodex(bin.path, codexHome, rec.dir, prompt, budgetMs, signal, progress);
        return { kind: "codex", ...r };
      }
      why.push(bin ? "Codex is not signed in" : "no Codex binary");
    } else why.push("Codex disabled");
    if (this.opts.claude !== false) {
      const claude = this.opts.claudeSdk ? "sdk" : findClaudeBinary(this.opts.claudeBin ?? env["JARHEAD_CLAUDE_BIN"], env);
      if (claude) {
        progress("Claude Code is working on it.");
        try {
          const r = await this.runClaude(rec.dir, prompt, budgetMs, signal, progress);
          return { kind: "claude-code", ...r };
        } catch (e) {
          why.push(`Claude Code failed to start (${(e as Error).message})`);
        }
      } else why.push("no claude binary");
    } else why.push("Claude Code disabled");
    return {
      kind: "manual",
      ok: false,
      summary: `No coding agent is available (${why.join("; ")}). The worktree for self-edit ${rec.id} is ready at ${rec.dir} on branch ${rec.branch}: make the change there yourself with read_file, edit_file and write_file, then call self_check ${rec.id} to run the checks.`,
    };
  }

  private runCodex(bin: string, codexHome: string, dir: string, prompt: string, budgetMs: number, signal: AbortSignal | undefined, progress: (line: string) => void): Promise<{ ok: boolean; summary: string }> {
    const model = this.opts.model?.trim() || codexConfigModel(codexHome);
    const args = ["exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "--ignore-user-config", ...(model ? ["-m", model] : []), "-C", dir, "-"];
    const env = codexEnv(this.opts.env ?? process.env, codexHome);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(bin, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        resolve({ ok: false, summary: `could not start Codex: ${(e as Error).message}` });
        return;
      }
      let candidate = "";
      let failed: string | undefined;
      let completed = false;
      let stderr = "";
      let steps = 0;
      const lines = new LineSplitter(64 * 1024 * 1024);
      const kill = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill("SIGINT");
        } catch {
          // gone
        }
        setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } catch {
            // gone
          }
        }, 3000).unref();
      };
      const timer = setTimeout(() => {
        failed = failed ?? `Codex ran out of time after ${Math.round(budgetMs / 1000)} seconds`;
        kill();
      }, budgetMs);
      const onAbort = (): void => {
        failed = failed ?? "cancelled";
        kill();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        let out: string[];
        try {
          out = lines.push(chunk);
        } catch (e) {
          log.warn((e as Error).message);
          return;
        }
        for (const line of out) {
          let ev: { type?: string; message?: string; error?: { message?: string } | string | null; item?: { type?: string; text?: string; command?: string | string[]; changes?: Array<{ path?: string; kind?: string }>; status?: string; exit_code?: number } };
          try {
            ev = JSON.parse(line) as typeof ev;
          } catch {
            continue;
          }
          const item = ev.item ?? {};
          switch (ev.type) {
            case "item.completed":
              if (item.type === "agent_message" && item.text?.trim()) {
                candidate = item.text.trim();
                progress(`Codex: ${candidate.replace(/\s+/g, " ").slice(0, 160)}`);
              } else if (item.type === "command_execution") {
                steps++;
                const cmd = Array.isArray(item.command) ? item.command.join(" ") : (item.command ?? "");
                progress(`Codex ran ${cmd.slice(0, 80)}${item.exit_code !== undefined && item.exit_code !== 0 ? ` (exit ${item.exit_code})` : ""}.`);
              } else if (item.type === "file_change") {
                steps++;
                const names = (item.changes ?? []).map((c) => basename(c.path ?? "?")).slice(0, 4);
                progress(`Codex edited ${names.join(", ") || "files"}.`);
              }
              break;
            case "turn.completed":
              completed = true;
              break;
            case "turn.failed":
            case "error": {
              const e = ev.error;
              failed = failed ?? (typeof e === "string" ? e : e?.message) ?? ev.message ?? "Codex failed";
              break;
            }
            default:
              break;
          }
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4000);
      });
      child.on("error", (e) => {
        failed = failed ?? `could not start Codex: ${e.message}`;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (failed) resolve({ ok: false, summary: `Codex did not finish: ${failed}${candidate ? ` (its last words: ${candidate.slice(0, 200)})` : ""}` });
        else if (completed || code === 0) resolve({ ok: true, summary: candidate || `Codex finished after ${steps} step${steps === 1 ? "" : "s"} without a summary.` });
        else resolve({ ok: false, summary: `Codex exited with code ${code ?? "?"} before finishing${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}` : ""}` });
      });
      child.stdin?.on("error", (e) => log.debug(`codex stdin: ${e.message}`));
      child.stdin?.end(prompt);
    });
  }

  private async runClaude(dir: string, prompt: string, budgetMs: number, signal: AbortSignal | undefined, progress: (line: string) => void): Promise<{ ok: boolean; summary: string }> {
    const sdk = this.opts.claudeSdk ?? (await loadSdk());
    const env = claudeEnv(this.opts.env ?? process.env, { dropApiKey: true });
    const session = new ClaudeSession({
      sdk,
      cwd: dir,
      name: "jarhead-self-edit",
      ...(this.opts.model ? { model: this.opts.model } : {}),
      persistSession: false,
      permissionMode: "acceptEdits",
      settingSources: ["project", "local"],
      env,
      canUseTool: async (tool, input): Promise<PermissionDecision> => {
        if (["Read", "Glob", "Grep", "LS", "Edit", "Write", "MultiEdit", "NotebookEdit", "TodoWrite", "WebSearch", "WebFetch", "Task"].includes(tool)) return { behavior: "allow" };
        if (tool === "Bash") {
          const d = classifyAction({ kind: "run_shell", text: String(input["command"] ?? ""), scratchRoots: [dir] });
          return d.verdict === "run" ? { behavior: "allow" } : { behavior: "deny", message: `not in a self-edit: ${d.reason}` };
        }
        return { behavior: "deny", message: `${tool} is not available in a self-edit` };
      },
    });
    session.on("tool", (t) => progress(`Claude Code: ${t.name}${typeof (t.input as { file_path?: string })?.file_path === "string" ? ` ${basename((t.input as { file_path: string }).file_path)}` : ""}.`));
    session.on("assistant", (text) => progress(`Claude Code: ${text.replace(/\s+/g, " ").slice(0, 160)}`));
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: { ok: boolean; summary: string }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void session.close();
        resolve(r);
      };
      const timer = setTimeout(() => finish({ ok: false, summary: `Claude Code ran out of time after ${Math.round(budgetMs / 1000)} seconds` }), budgetMs);
      const onAbort = (): void => finish({ ok: false, summary: "cancelled" });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      session.on("result", (msg) => finish(msg.is_error ? { ok: false, summary: `Claude Code failed: ${msg.result ?? "turn failed"}` } : { ok: true, summary: session.lastAssistantText.trim() || "Claude Code finished without a summary." }));
      session.on("error", (e) => finish({ ok: false, summary: `Claude Code failed: ${e.message}` }));
      session.on("closed", () => finish({ ok: false, summary: "Claude Code's session closed before it finished" }));
      try {
        session.start();
        session.send(prompt);
      } catch (e) {
        finish({ ok: false, summary: `could not start Claude Code: ${(e as Error).message}` });
      }
    });
  }

  // -------------------------------------------------------- review / apply

  /** Diff stat and the diff against main, capped. */
  async review(id: string): Promise<string> {
    const rec = this.get(id);
    if (!rec) throw new Error(`no self-edit ${id}; call self_status`);
    if (rec.status === "applied") return `Self-edit ${id} was applied${rec.head ? ` (${rec.head})` : ""}; its changes are on main now: ${rec.files.join(", ")}.`;
    if (!existsSync(rec.dir)) return `Self-edit ${id} was ${rec.status}; its worktree is gone.`;
    await this.commitAll(rec);
    const stat = await this.diffStat(rec);
    if (!stat) return `Self-edit ${id} has no changes against main.`;
    const diff = await this.git(["diff", "main...HEAD"], { cwd: rec.dir });
    const shown = diff.length > DIFF_CAP ? `${diff.slice(0, DIFF_CAP)}\n… [diff cut at ${DIFF_CAP} characters; ${diff.length} total]` : diff;
    return `${stat}\n\n${shown}`;
  }

  /** Why an apply must be refused, if it must. Confirmation is the caller's job. */
  async applyBlocker(rec: SelfEditRecord, request: string): Promise<string | undefined> {
    if (rec.status === "applied") return `self-edit ${rec.id} was already applied`;
    if (rec.status === "discarded") return `self-edit ${rec.id} was discarded`;
    if (!existsSync(rec.dir)) return `the worktree of ${rec.id} is gone`;
    if (rec.status !== "checked") return `self-edit ${rec.id} has not been checked yet; call self_check ${rec.id} first`;
    if (await this.worktreeDirty(rec)) return `the worktree of ${rec.id} changed since its checks ran; call self_check ${rec.id} first so the summary and the checks describe what would be applied`;
    if (rec.files.length === 0) return `self-edit ${rec.id} made no changes; nothing to apply`;
    if (rec.green !== true && !saysApplyAnyway(request)) {
      const bad = rec.checks.find((c) => !c.ok);
      return `the checks were red (${bad ? `${bad.name}: ${bad.firstFailure ?? bad.skipped ?? "failed"}` : "not run"}); Kevin has to say to apply it anyway`;
    }
    if (rec.rails.length > 0) {
      const named = railsNamed(rec.rails, request);
      if (!named.ok) return `this change touches Jarhead's own safety rails (${named.missing.join("; ")}) and Kevin's request did not name them; he has to say which rail he means`;
    }
    return undefined;
  }

  /**
   * Merge into main (fast-forward, else a plain merge, never forced), install if
   * the lockfile moved, drop the worktree and branch, record the apply. Returns
   * what the caller must do next: restart the daemon, rebuild the app.
   */
  async apply(id: string, opts: { readonly signal?: AbortSignal | undefined; readonly progress?: ((line: string) => void) | undefined } = {}): Promise<{ record: SelfEditRecord; restart: boolean; buildMac: boolean; lockfileChanged: boolean }> {
    const progress = opts.progress ?? (() => undefined);
    const rec = this.get(id);
    if (!rec) throw new Error(`no self-edit ${id}`);
    const dirty = await this.repoNotClean();
    if (dirty) throw new Error(`cannot apply: ${dirty}`);
    await this.commitAll(rec);
    const before = (await this.git(["rev-parse", "HEAD"])).trim();
    progress(`Merging ${rec.branch} into main.`);
    try {
      await this.git(["merge", "--ff-only", rec.branch], { signal: opts.signal });
    } catch (ff) {
      try {
        await this.git(["merge", "--no-ff", "--no-edit", "-m", `merge self-edit ${id}`, rec.branch], { signal: opts.signal });
      } catch (e) {
        await this.git(["merge", "--abort"]).catch(() => undefined);
        throw new Error(`could not merge ${rec.branch} into main: ${(e as Error).message} (fast-forward failed: ${(ff as Error).message})`);
      }
    }
    const after = (await this.git(["rev-parse", "HEAD"])).trim();
    const changed = (await this.git(["diff", "--name-only", before, after])).split("\n").map((l) => l.trim()).filter(Boolean);
    const lockfileChanged = changed.includes("pnpm-lock.yaml");
    if (lockfileChanged) {
      progress("Installing dependencies.");
      const r = await runShell({ command: "pnpm install --frozen-lockfile", argv: [pnpmBinary(this.opts.env), "install", "--frozen-lockfile", "--prefer-offline"], cwd: this.repoRoot, timeoutMs: 5 * 60_000, signal: opts.signal, env: this.opts.env });
      if (r.code !== 0) log.warn(`pnpm install after apply: ${describeShellResult(r).slice(0, 300)}`);
    }
    await this.removeWorktree(rec, true);
    const applied = this.save({ ...rec, status: "applied", head: after.slice(0, 7), updatedAt: this.now() });
    const restart = changed.some((f) => f.startsWith("packages/") || f.startsWith("scripts/") || f === "package.json" || f === "pnpm-lock.yaml" || f === "tsconfig.json");
    const buildMac = changed.some((f) => f.startsWith("apps/mac/"));
    const last: LastApply = { id, at: this.now(), files: changed, restart, builtMac: buildMac, head: after.slice(0, 7) };
    writeFileSync(join(this.worktreesDir, "last-apply.json"), JSON.stringify(last, null, 2));
    return { record: applied, restart, buildMac, lockfileChanged };
  }

  /** `pnpm build:mac` in the repo, bounded. */
  async buildMac(opts: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {}): Promise<ShellRunResult> {
    return runShell({ command: "pnpm build:mac", argv: [pnpmBinary(this.opts.env), "build:mac"], cwd: this.repoRoot, timeoutMs: opts.timeoutMs ?? 10 * 60_000, signal: opts.signal, env: this.opts.env });
  }

  private async removeWorktree(rec: SelfEditRecord, merged: boolean): Promise<void> {
    if (existsSync(rec.dir)) {
      try {
        await this.git(["worktree", "remove", "--force", rec.dir]);
      } catch (e) {
        log.warn(`worktree remove: ${(e as Error).message}`);
        rmSync(rec.dir, { recursive: true, force: true });
        await this.git(["worktree", "prune"]).catch(() => undefined);
      }
    }
    await this.git(["branch", merged ? "-d" : "-D", rec.branch]).catch((e: Error) => log.debug(`branch delete: ${e.message}`));
  }

  async discard(id: string): Promise<SelfEditRecord> {
    const rec = this.get(id);
    if (!rec) throw new Error(`no self-edit ${id}`);
    if (rec.status === "applied") throw new Error(`self-edit ${id} was applied already; nothing to discard`);
    await this.removeWorktree(rec, false);
    return this.save({ ...rec, status: "discarded", updatedAt: this.now() });
  }

  /** The self_status text. */
  async status(): Promise<string> {
    const lines: string[] = [];
    let head = "?";
    try {
      head = await this.mainHead();
    } catch (e) {
      lines.push(`main: ${(e as Error).message}`);
    }
    lines.push(`main is at ${head}${this.restartPending ? `; a restart is pending (${this.restartPending})` : ""}.`);
    const pending = this.pending();
    if (pending.length === 0) lines.push("No pending self-edits.");
    for (const r of pending) {
      const age = Math.round((this.now() - r.createdAt) / 60_000);
      lines.push(`${r.id}${this.isStale(r) ? " (stale)" : ""}: "${r.task.slice(0, 80)}" — ${r.status}, ${r.files.length} file${r.files.length === 1 ? "" : "s"}, checks ${r.green === true ? "green" : r.green === false ? "red" : "not run"}${r.rails.length ? `, touches rails: ${r.rails.join("; ")}` : ""}, ${age} min ago, at ${r.dir}`);
    }
    const last = this.lastApply();
    if (last) lines.push(`Last apply: ${last.id} at ${new Date(last.at).toISOString()} (${last.files.length} files, main ${last.head}${last.restart ? ", restarted" : ""}${last.builtMac ? ", app rebuilt" : ""}).`);
    return lines.join("\n");
  }
}

/** For the doctor: pending worktrees and the last apply, without an engine. */
export function selfEditDoctorRow(worktreesDir: string, repoRoot: string = REPO_ROOT, now: () => number = Date.now): { readonly pending: number; readonly stale: number; readonly detail: string } {
  const manager = new SelfEditManager({ worktreesDir, repoRoot, now });
  const pending = manager.pending();
  const stale = pending.filter((r) => manager.isStale(r));
  const last = manager.lastApply();
  const parts: string[] = [];
  parts.push(pending.length === 0 ? "no pending worktrees" : `${pending.length} pending worktree${pending.length === 1 ? "" : "s"} (${pending.map((r) => `${r.id}${manager.isStale(r) ? " stale" : ""}`).join(", ")}) under ${worktreesDir}`);
  parts.push(last ? `last apply ${last.id} on ${new Date(last.at).toISOString().slice(0, 16).replace("T", " ")} (${last.files.length} files → main ${last.head})` : "no self-edit applied yet");
  return { pending: pending.length, stale: stale.length, detail: parts.join("; ") };
}
