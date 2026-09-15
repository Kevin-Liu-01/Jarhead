import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { HANDS_OFF_APPS, classifyAction, classifyPath, classifyUrl, clockOf, describeInstant, expandPath, newId, riskyUrlReason, secretPathReason, snoozeDefault, type ActionContext, type Decision, type Ledger } from "@jarhead/core";
import { runShell, type Brain, type BrainResult, type BrainSink, type BrainTask } from "@jarhead/brain";
import type { FocusedText, FrontmostInfo, NativeHands } from "@jarhead/hands";
import { AUTOMATION_LINE_CHARS, automationKind, type Automation, type AutomationAction, type AutomationActionKind, type AutomationKind, type AutomationPress, type Delegation, type EngineEvent, type ProblemKind, type ProblemRemedy, type Settings } from "@jarhead/protocol";
import type { LaneRunner } from "../threads/runner.ts";

/**
 * The fire pipeline — nothing here asks. A row's actions run in order and the chain
 * stops at the first failure; every verdict is lexical and every "would need a yes" is
 * a `failed` detail, never a question: no session opens, no yes is read from anything,
 * `presence.recent` is false on every policy call so a confirm-tier action in a
 * presence-gated app holds and the hold is the failure. The app owns the speaker and
 * the banners: `chime`, `say` and `notify` are `local.say` / `notify` events; awake, the
 * same fire is one instruction to Live instead (the FAREWELL_LINE pattern). `wake-brain`
 * is one headless turn on a background-lane brain behind its budget; the engine's
 * `wake()` / `connect()` are never called from here.
 */

/** The island's event line is capped here (protocol.test.ts measures a `fired` event); the ring keeps the whole line. */
export const EVENT_LINE_CHARS = 80;
export const EVENT_DETAIL_CHARS = 70;
/** A row's `lastDetail` is capped here. */
export const DETAIL_CHARS = 200;
/** The recipe's output kept for `lastDetail`. */
const RECIPE_OUTPUT_CHARS = 120;
/** How long `open` waits for `/usr/bin/open`. */
const OPEN_TIMEOUT_MS = 10_000;
/** A headless brain turn is told this much before Kevin's prompt. */
const HEADLESS_NOTE = "You run headless for one of Kevin's automations while he is away: nobody answers a question, so never call a tool that would need his yes — answer with what you can see and do freely, in one or two sentences.";

// -------------------------------------------------------------------- seams

/** The engine's own processes for a fire: `open` to completion, `caffeinate` held until Done. Fixed argv, never a shell line. */
export interface AutomationExec {
  run(file: string, argv: readonly string[], timeoutMs: number): Promise<{ readonly code: number | null; readonly error?: string | undefined }>;
  /** Start a process that is killed later (`caffeinate -t N` for a running timer); undefined when it could not start. */
  hold(file: string, argv: readonly string[]): { kill(): void } | undefined;
}

/** The default: `runShell` with an argv (no shell), and a detached child for the hold. */
export const defaultAutomationExec: AutomationExec = {
  run: async (file, argv, timeoutMs) => {
    const r = await runShell({ command: [file, ...argv].join(" "), argv: [file, ...argv], timeoutMs });
    return { code: r.code, ...(r.error ? { error: r.error } : {}) };
  },
  hold: (file, argv) => {
    try {
      const child = spawn(file, [...argv], { stdio: "ignore", detached: false });
      child.on("error", () => undefined);
      child.unref();
      return {
        kill: () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // gone
          }
        },
      };
    } catch {
      return undefined;
    }
  },
};

/** `runShell`'s own shapes (the brain package exports the function, not the types). */
export type ShellRunOptions = Parameters<typeof runShell>[0];
export type ShellRunResult = Awaited<ReturnType<typeof runShell>>;
export type ShellRunner = (opts: ShellRunOptions) => Promise<ShellRunResult>;
export type ShellGate = (ctx: ActionContext) => Decision;

/** One lane for one headless turn: its brain and its background-lane runner, released after. */
export interface WakeBrainLane {
  readonly brain: Brain;
  readonly runner: LaneRunner;
  release(): Promise<void>;
}

/** What the executor needs of the engine for `wake-brain`; the engine builds it over the thread pool. */
export interface WakeBrainSeam {
  /** `brain.warmUp()` when it cooled at sleep (a local model reloads its weights — the cost line's "warm-up"). */
  warmUp(): Promise<void>;
  /** The thread pool opened and one spare taken on the background lane, its boot awaited; undefined when no brain can run a thread. */
  lane(): Promise<WakeBrainLane | undefined>;
  /** `pool.stopAll()`: asleep again, nothing boots behind Jarhead's back. */
  after(): Promise<void>;
}

/** As much of Live as a fire needs while awake. */
export interface LiveLike {
  appendInstructions(delegationId: string | null, content: string): unknown;
}

export interface ExecutorOptions {
  readonly now: () => number;
  readonly ledger: Ledger;
  readonly settings: () => Settings;
  /** The acting helper: `open_app`, the `press` probes and the key. */
  readonly hands: NativeHands;
  readonly redact: (text: string) => string;
  readonly emit: (event: EngineEvent) => void;
  readonly exec: AutomationExec;
  readonly shell: ShellRunner;
  /** The shell gate re-run on a recipe's saved text at every fire (tests script a `confirm`). */
  readonly shellGate: ShellGate;
  /** The open session, when one is up: the fire is delivered through it instead of the speaker. */
  readonly live: () => LiveLike | undefined;
  readonly brain: WakeBrainSeam;
  readonly home: string;
  readonly repoRoot?: string | undefined;
  readonly problem: (kind: ProblemKind, text: string, remedy?: ProblemRemedy) => void;
  /** Brain seconds `wake-brain` spent today (the ledger's `automation.fired { brainSeconds }` rows). */
  readonly brainSpentToday: () => number;
}

export interface FireContext {
  readonly a: Automation;
  readonly now: number;
  readonly lateMs: number;
  /** The file that landed (folder.file / download.done), absolute. */
  readonly file?: string | undefined;
  /** Inside quiet hours with `quiet: respect`: chime/say are shown, not sounded or spoken. */
  readonly quiet: boolean;
  /** The instant the row was due (the alarm's head clock). */
  readonly dueAt: number;
}

export interface FireOutcome {
  readonly ok: boolean;
  readonly actions: readonly AutomationActionKind[];
  /** The island's line, whole and redacted. */
  readonly line: string;
  readonly calm?: string | undefined;
  readonly detail?: string | undefined;
  readonly presses: readonly AutomationPress[];
  /** A line kind rang (or a file was filed): the row waits for Done. */
  readonly ring: boolean;
  readonly delegationId?: string | undefined;
  readonly brainSeconds?: number | undefined;
  readonly ms: number;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "12:00" for a timer's length. */
function clockLength(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** A path whose name is free in its folder: `name.pdf`, else `name (2).pdf`, `name (3).pdf`… */
export function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = join(dir, name);
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

export class AutomationExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  /** The island's line for a row: alarm "07:10 · name", timer "name · 12:00 is up", reminder "name", routine / watcher "name · what it did" (a reminder whose acting kind did something says so too). */
  line(a: Automation, dueAt: number, what?: string): string {
    const kind = automationKind(a);
    const raw = kind === "alarm" ? `${clockOf(dueAt)} · ${a.name}` : kind === "timer" ? `${a.name} · ${clockLength(a.when.kind === "in" ? a.when.ms : 0)} is up` : what ? `${a.name} · ${what}` : a.name;
    return cut(this.opts.redact(raw), AUTOMATION_LINE_CHARS);
  }

  /** The quieter second line: the next fire when the row repeats, else the echo's tail. */
  calm(a: Automation, nextAt: number | undefined): string | undefined {
    if (nextAt !== undefined) return `next ${describeInstant(nextAt)}`;
    const echo = a.echo.trim();
    return echo ? cut(this.opts.redact(echo), 60) : undefined;
  }

  /** The presses a ring offers: Open · Done when something can be opened, else Snooze · Done. */
  presses(a: Automation, open?: string): AutomationPress[] {
    if (open) return [{ kind: "open", target: open }, { kind: "done" }];
    return [{ kind: "snooze", minutes: snoozeDefault(automationKind(a), this.opts.settings().automations.snoozeMinutes) }, { kind: "done" }];
  }

  /**
   * Run the row's actions in order; the first failure stops the chain. The line, the
   * calm second line and the presses are the island's; every text is redacted.
   */
  async fire(ctx: FireContext, nextAt: number | undefined): Promise<FireOutcome> {
    const t0 = this.opts.now();
    const { a } = ctx;
    const kind = automationKind(a);
    const actions: AutomationActionKind[] = [];
    let what: string | undefined;
    let openTarget: string | undefined;
    let ring = false;
    let detail: string | undefined;
    let delegationId: string | undefined;
    let brainSeconds: number | undefined;
    let ok = true;
    // The acting kind runs first when the row has one, so the line can say what it did ("filed invoice.pdf → Papers").
    const order = [...a.then].sort((x, y) => Number(isLine(x)) - Number(isLine(y)));
    for (const action of order) {
      actions.push(action.kind);
      const r = await this.one(action, ctx, kind, what, nextAt);
      // The acting kind's failure ends the chain before any line kind rings for it.
      if (r.what) what = r.what;
      if (r.open) openTarget = r.open;
      if (r.ring) ring = true;
      if (r.detail) detail = r.detail;
      if (r.delegationId) delegationId = r.delegationId;
      if (r.brainSeconds !== undefined) brainSeconds = r.brainSeconds;
      if (!r.ok) {
        ok = false;
        detail = r.detail ?? "failed";
        break;
      }
    }
    const line = this.line(a, ctx.dueAt, what);
    const presses = this.presses(a, openTarget);
    return { ok, actions, line, calm: this.calm(a, nextAt), detail: detail ? cut(this.opts.redact(detail), DETAIL_CHARS) : undefined, presses, ring, delegationId, brainSeconds, ms: this.opts.now() - t0 };
  }

  // ------------------------------------------------------------- actions

  private async one(action: AutomationAction, ctx: FireContext, kind: AutomationKind, what: string | undefined, nextAt: number | undefined): Promise<StepOutcome> {
    switch (action.kind) {
      case "chime":
        return this.chime(action, ctx, kind, what, nextAt);
      case "say":
        return this.say(action, ctx, what);
      case "notify":
        return this.notify(action, ctx);
      case "open":
        return this.open(action, ctx.a.id);
      case "file":
        return this.file(action, ctx);
      case "run-recipe":
        return this.recipe(action, ctx);
      case "press":
        return this.press(action);
      case "wake-brain":
        return this.wakeBrain(action, ctx);
      default:
        return { ok: false, detail: `unknown action kind "${String((action as { readonly kind?: unknown }).kind)}"` };
    }
  }

  /** The line kinds' banner: the same presses the island offers; a press lands on the same row. */
  private banner(a: Automation, title: string, body: string | undefined, open: string | undefined): void {
    this.opts.emit({ type: "notify", id: newId("ntf"), title: cut(this.opts.redact(title), AUTOMATION_LINE_CHARS), ...(body ? { body: cut(this.opts.redact(body), AUTOMATION_LINE_CHARS) } : {}), presses: this.presses(a, open), automationId: a.id });
  }

  private chime(action: Extract<AutomationAction, { kind: "chime" }>, ctx: FireContext, kind: AutomationKind, what: string | undefined, nextAt: number | undefined): StepOutcome {
    const { a } = ctx;
    const line = this.line(a, ctx.dueAt, what);
    const spoken = cut(this.opts.redact(action.line.trim() || a.name), AUTOMATION_LINE_CHARS);
    const live = this.opts.live();
    let detail: string | undefined;
    if (live) {
      // Awake: the island line only; the chime is skipped (the mic would hear it) and Live is told once.
      live.appendInstructions(null, `Kevin's ${a.name} fired: say '${spoken}' once, with its name, and nothing more.`);
      detail = "said by the voice";
    } else if (ctx.quiet) {
      detail = "quiet hours: shown, not said";
    } else {
      this.opts.emit({ type: "local.say", sound: action.sound ?? (kind === "alarm" ? "Hero" : "Glass"), automationId: a.id });
    }
    this.banner(a, line, spoken !== line ? spoken : this.calm(a, nextAt), undefined);
    return { ok: true, ring: true, detail };
  }

  private say(action: Extract<AutomationAction, { kind: "say" }>, ctx: FireContext, what: string | undefined): StepOutcome {
    const { a } = ctx;
    const text = cut(this.opts.redact(action.line.trim()), AUTOMATION_LINE_CHARS);
    const live = this.opts.live();
    let detail: string | undefined;
    if (live) {
      live.appendInstructions(null, `Kevin's ${a.name} fired: say '${text}' once, with its name, and nothing more.`);
      detail = "said by the voice";
    } else if (ctx.quiet) {
      detail = "quiet hours: shown, not said";
    } else {
      this.opts.emit({ type: "local.say", text, automationId: a.id });
    }
    this.banner(a, this.line(a, ctx.dueAt, what), text, undefined);
    return { ok: true, ring: true, detail };
  }

  private notify(action: Extract<AutomationAction, { kind: "notify" }>, ctx: FireContext): StepOutcome {
    this.banner(ctx.a, action.title, action.body, action.open);
    return { ok: true, ring: true, ...(action.open ? { open: action.open } : {}) };
  }

  /** `open`: an app through the hands (the policy re-judged, presence absent), an https URL or a path through `/usr/bin/open`; one soft Pop. */
  private async open(action: Extract<AutomationAction, { kind: "open" }>, automationId: string): Promise<StepOutcome> {
    if (action.app) {
      if (HANDS_OFF_APPS.test(action.app)) return { ok: false, detail: `${action.app} is hands-off; not opened unattended` };
      const d = classifyAction({ kind: "open_app", app: action.app, target: action.app, presence: { recent: false }, home: this.opts.home });
      if (d.verdict !== "run") return { ok: false, detail: d.hold ? `${action.app}: ${d.reason}` : `${action.app}: would need a yes; nobody to ask (${d.reason})` };
      try {
        const r = await this.opts.hands.request<{ readonly app?: string }>("open_app", { name: action.app, activate: true }, 8000);
        this.opts.emit({ type: "local.say", sound: "Pop", automationId });
        return { ok: true, what: `opened ${r.app ?? action.app}` };
      } catch (e) {
        return { ok: false, detail: `could not open ${action.app}: ${(e as Error).message}` };
      }
    }
    if (action.url) {
      const d = classifyUrl({ url: action.url });
      if (d.verdict !== "run") return { ok: false, detail: d.reason };
      const risky = riskyUrlReason(action.url);
      if (risky) return { ok: false, detail: `${risky}; not unattended` };
      const r = await this.opts.exec.run("/usr/bin/open", [action.url], OPEN_TIMEOUT_MS);
      if (r.code !== 0) return { ok: false, detail: `could not open ${cut(action.url, 60)}${r.error ? `: ${r.error}` : ` (exit ${r.code ?? "?"})`}` };
      this.opts.emit({ type: "local.say", sound: "Pop", automationId });
      return { ok: true, what: `opened ${cut(action.url, 60)}` };
    }
    if (action.path) {
      const p = expandPath(action.path, this.opts.home);
      const d = classifyPath({ path: p, access: "read", home: this.opts.home });
      if (d.verdict !== "run") return { ok: false, detail: d.reason };
      const r = await this.opts.exec.run("/usr/bin/open", [p], OPEN_TIMEOUT_MS);
      if (r.code !== 0) return { ok: false, detail: `could not open ${cut(action.path, 60)}${r.error ? `: ${r.error}` : ` (exit ${r.code ?? "?"})`}` };
      this.opts.emit({ type: "local.say", sound: "Pop", automationId });
      return { ok: true, what: `opened ${basename(p)}` };
    }
    return { ok: false, detail: "open names nothing" };
  }

  /**
   * `file`: rename(2) of the triggering file into `into` on the same volume — a name clash
   * takes ` (2)`, ` (3)`…; cross-volume fails (never copy-then-unlink); nothing is ever
   * unlinked; `into` sits inside ~ and never under ~/.jarhead or a secret store.
   */
  private file(action: Extract<AutomationAction, { kind: "file" }>, ctx: FireContext): StepOutcome {
    const src = ctx.file;
    if (!src) return { ok: false, detail: "file: no file landed for this fire" };
    const home = this.opts.home;
    const into = expandPath(action.into, home);
    const secret = secretPathReason(into);
    if (secret) return { ok: false, detail: `${secret}; nothing is filed there` };
    if (isUnder(into, resolve(home, ".jarhead"))) return { ok: false, detail: "~/.jarhead is Jarhead's own; nothing is filed there" };
    if (!isUnder(into, home)) return { ok: false, detail: `${action.into} is outside Kevin's home` };
    if (!existsSync(src)) return { ok: false, detail: `${basename(src)} is gone before it could be filed` };
    try {
      mkdirSync(into, { recursive: true });
      const dest = freeName(into, basename(src));
      if (resolve(dirname(src)) === resolve(into)) return { ok: true, what: `${basename(src)} is already in ${basename(into)}` };
      renameSync(src, dest);
      const what = `filed ${basename(src)} → ${basename(into)}${basename(dest) !== basename(src) ? ` as ${basename(dest)}` : ""}`;
      return { ok: true, ring: true, what, open: dest };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EXDEV") return { ok: false, detail: `${basename(src)}: ${action.into} is on a different volume; not moved` };
      return { ok: false, detail: `could not file ${basename(src)}: ${(e as Error).message}` };
    }
  }

  /** `run-recipe`: the saved text re-judged by the shell gate at every fire — anything but `run` is a failure, never a question. */
  private async recipe(action: Extract<AutomationAction, { kind: "run-recipe" }>, ctx: FireContext): Promise<StepOutcome> {
    const recipe = this.opts.settings().automations.recipes.find((r) => r.name.toLowerCase() === action.recipe.trim().toLowerCase());
    if (!recipe) return { ok: false, detail: `no recipe named "${action.recipe}"` };
    const cwd = recipe.cwd ? expandPath(recipe.cwd, this.opts.home) : this.opts.home;
    const d = this.opts.shellGate({ kind: "run_shell", text: recipe.command, confirmed: false, cwd, home: this.opts.home, presence: { recent: false }, ...(this.opts.repoRoot ? { repoRoot: this.opts.repoRoot } : {}) });
    if (d.verdict === "confirm") return { ok: false, detail: `recipe ${recipe.name} would need a yes; nobody to ask (${d.reason.replace(/; ask first$/, "")})` };
    if (d.verdict === "refuse") return { ok: false, detail: `recipe ${recipe.name} refused: ${d.reason}` };
    const env: NodeJS.ProcessEnv = { ...process.env, ...(ctx.file ? { JARHEAD_FILE: ctx.file } : {}) };
    const r = await this.opts.shell({ command: recipe.command, cwd, timeoutMs: Math.min(600, Math.max(1, recipe.timeoutSeconds)) * 1000, env });
    const output = this.opts.redact(`${r.stdout}${r.stderr ? ` ${r.stderr}` : ""}`.replace(/\s+/g, " ").trim());
    const tail = output ? ` · ${cut(output, RECIPE_OUTPUT_CHARS)}` : "";
    if (r.error) return { ok: false, detail: `recipe ${recipe.name} could not start: ${r.error}` };
    if (r.timedOut) return { ok: false, detail: `recipe ${recipe.name} stopped after ${recipe.timeoutSeconds} s${tail}` };
    if (r.code !== 0) {
      this.banner(ctx.a, `${ctx.a.name} failed · exit ${r.code ?? "?"}`, output ? cut(output, AUTOMATION_LINE_CHARS) : undefined, undefined);
      return { ok: false, detail: `recipe ${recipe.name} exit ${r.code ?? "?"}${tail}` };
    }
    return { ok: true, what: `recipe ${recipe.name} exit 0${tail}` };
  }

  /** `press`: the front app and the focused field are probed; only the named app in front with no secure field gets the key. */
  private async press(action: Extract<AutomationAction, { kind: "press" }>): Promise<StepOutcome> {
    if (HANDS_OFF_APPS.test(action.app)) return { ok: false, detail: `${action.app} is hands-off; nothing is pressed there` };
    let front: FrontmostInfo | undefined;
    let focused: FocusedText | undefined;
    try {
      [front, focused] = await Promise.all([this.opts.hands.request<FrontmostInfo>("frontmost", {}, 1500), this.opts.hands.request<FocusedText>("focused_text", {}, 1500).catch(() => undefined)]);
    } catch (e) {
      return { ok: false, detail: `could not see the screen: ${(e as Error).message}` };
    }
    if (!front || front.app.toLowerCase() !== action.app.toLowerCase()) return { ok: false, detail: `${action.app} is not in front${front?.app ? ` (${front.app} is)` : ""}` };
    if (front.locked || focused?.locked) return { ok: false, detail: "the screen is locked" };
    if (focused?.secure) return { ok: false, detail: "a password field has focus" };
    try {
      await this.opts.hands.request("key", { combo: action.key, repeat: 1, expectFront: { pid: front.pid } }, 3000);
    } catch (e) {
      return { ok: false, detail: `could not press ${action.key} in ${action.app}: ${(e as Error).message}` };
    }
    return { ok: true, what: `pressed ${action.key} in ${action.app}` };
  }

  // ---------------------------------------------------------- wake-brain

  /**
   * One headless brain turn behind the day's budget: `warmUp` if cooled, one spare from
   * the pool on the background lane, a Delegation with `liveId: ""` and `origin`, the
   * turn under its own AbortController and the row's budget; any `needs-confirmation`
   * step cancels it (nobody to answer); the final line (first sentence, ≤ 160, redacted)
   * is spoken by the local speaker when `speak` and always a banner. Awake, the prompt
   * goes to Live instead and the budget is untouched.
   */
  private async wakeBrain(action: Extract<AutomationAction, { kind: "wake-brain" }>, ctx: FireContext): Promise<StepOutcome> {
    const { a } = ctx;
    const prompt = action.prompt.trim();
    const live = this.opts.live();
    if (live) {
      live.appendInstructions(null, `Kevin's automation ${a.name} fired: do this now — "${cut(prompt, 400)}" — and tell him the result in one sentence.`);
      return { ok: true, what: "asked the voice", detail: "awake: the voice took it; nothing spent from the automations budget" };
    }
    const cap = this.opts.settings().automations.wakeBudgetMinutesPerDay * 60;
    const spent = this.opts.brainSpentToday();
    if (cap <= 0 || spent + action.budget.seconds > cap) {
      this.opts.problem("automation.budget", `brain minutes for automations are spent today (${Math.round(spent / 60)} of ${Math.round(cap / 60)} min)`);
      return { ok: false, detail: "budget" };
    }
    await this.opts.brain.warmUp().catch(() => undefined);
    const lane = await this.opts.brain.lane().catch(() => undefined);
    if (!lane) {
      await this.opts.brain.after().catch(() => undefined);
      return { ok: false, detail: "no brain could take the turn (threads off, or the brain cannot run its own thread)" };
    }
    const t0 = this.opts.now();
    const wall0 = Date.now();
    const id = newId("dlg");
    const delegation: Delegation = { id, liveId: "", createdAt: t0, offsetMs: 0, request: prompt, status: "running", steps: [], timings: { delegatedAt: t0 }, threadId: lane.runner.laneId, origin: { automationId: a.id } };
    this.opts.ledger.append({ at: t0, type: "delegation.created", delegation });
    const abort = new AbortController();
    let steps = 0;
    let question: string | undefined;
    let over: string | undefined;
    const timer = setTimeout(() => {
      over = `ran out of time after ${action.budget.seconds} s`;
      abort.abort();
    }, action.budget.seconds * 1000);
    timer.unref?.();
    const sink: BrainSink = {
      thinking: () => undefined,
      commentary: () => undefined, // speak_progress is dropped: there is no voice to speak it
      screenshot: () => undefined,
      step: (step) => {
        if (step.kind !== "tool" && step.kind !== "confirm" && step.kind !== "error" && step.kind !== "screenshot") return;
        steps++;
        this.opts.ledger.append({ at: this.opts.now(), type: "delegation.step", delegationId: id, step: { id: newId("step"), at: this.opts.now(), kind: step.kind, ...(step.text ? { text: cut(this.opts.redact(step.text), 200) } : {}), ...(step.tool ? { tool: { name: step.tool.name, input: undefined, ok: step.tool.ok, ms: step.tool.ms } } : {}) } });
        if (step.kind === "confirm") {
          question = step.text ?? "a question";
          abort.abort();
          return;
        }
        if (steps > action.budget.steps) {
          over = `stopped after ${action.budget.steps} tool calls`;
          abort.abort();
        } else if (this.opts.now() - t0 >= action.budget.seconds * 1000) {
          over = `ran out of time after ${action.budget.seconds} s`;
          abort.abort();
        }
      },
    };
    const task: BrainTask = {
      delegationId: `${lane.runner.laneId}/${id}`,
      thread: { id: lane.runner.laneId, name: a.name, lane: "background" },
      request: prompt,
      dialogue: `Jarhead (asleep, for Kevin's automation "${a.name}"): ${prompt}`,
      confirmation: false,
      offsetMs: 0,
      signal: abort.signal,
      notes: [HEADLESS_NOTE],
    };
    let result: BrainResult;
    try {
      result = await lane.brain.handle(task, sink);
    } catch (e) {
      result = { status: "failed", error: (e as Error).message };
    } finally {
      clearTimeout(timer);
      await lane.release().catch(() => undefined);
      await this.opts.brain.after().catch(() => undefined);
    }
    const brainSeconds = Math.max(1, Math.round(Math.max(this.opts.now() - t0, Date.now() - wall0) / 1000));
    const doneAt = this.opts.now();
    const finish = (status: Delegation["status"], summary: string | undefined): void => {
      this.opts.ledger.append({ at: doneAt, type: "delegation.finished", delegationId: id, status: status === "running" ? "failed" : status, timings: { delegatedAt: t0, doneAt }, ...(summary ? { summary: cut(this.opts.redact(summary), 200) } : {}) });
    };
    if (question !== undefined) {
      finish("cancelled", "asked a question; nobody to answer");
      return { ok: false, detail: "asked a question; nobody to answer", delegationId: id, brainSeconds };
    }
    if (over !== undefined || result.status === "cancelled" || abort.signal.aborted) {
      finish("cancelled", over ?? "cancelled");
      return { ok: false, detail: over ?? "cancelled", delegationId: id, brainSeconds };
    }
    if (result.status === "failed") {
      finish("failed", result.error);
      return { ok: false, detail: `the brain failed: ${cut(result.error ?? "unknown error", 120)}`, delegationId: id, brainSeconds };
    }
    const summary = (result.summary ?? "").replace(/\s+/g, " ").trim() || "done.";
    finish(result.status, summary);
    const sentence = cut(this.opts.redact(firstSentence(summary)), AUTOMATION_LINE_CHARS);
    if (action.speak && !ctx.quiet) this.opts.emit({ type: "local.say", text: sentence, automationId: a.id });
    this.banner(a, a.name, sentence, undefined);
    return { ok: true, ring: true, what: sentence, delegationId: id, brainSeconds };
  }
}

interface StepOutcome {
  readonly ok: boolean;
  /** What it did, for the line ("opened Notes", "filed invoice.pdf → Papers"). */
  readonly what?: string | undefined;
  readonly detail?: string | undefined;
  /** Something can be opened from the ring (the filed file, a banner's target). */
  readonly open?: string | undefined;
  readonly ring?: boolean | undefined;
  readonly delegationId?: string | undefined;
  readonly brainSeconds?: number | undefined;
}

function isLine(a: AutomationAction): boolean {
  return a.kind === "chime" || a.kind === "say" || a.kind === "notify";
}

function isUnder(p: string, root: string): boolean {
  const a = resolve(p);
  const r = resolve(root);
  return a === r || a.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/** The first sentence of a text (the local speaker reads one). */
export function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
  return (m?.[1] ?? text.trim()).trim();
}

/** Whether a file at `path` exists and is a regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
