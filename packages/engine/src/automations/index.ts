import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atClock, classifyAction, classifyAutomation, clockOf, describe, describeInstant, expandPath, graceFor, inQuiet, inWindow, isLoopbackHost, logger, newId, nextFire, parseWhen, quietEnds, secretsPresent, snoozeDefault, Ledger, type ActionContext, type AutomationContext, type Decision } from "@jarhead/core";
import { runShell, type AutomationChangeResult, type AutomationSetContext, type AutomationSetResult, type AutomationSource, type AutomationVerb, type RecipeRow } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import {
  AUTOMATION_ACTIONS_MAX,
  AUTOMATION_LINGER_MS,
  AUTOMATION_REPEAT_CHIME_MS,
  AUTOMATION_SLEEP_GAP_MS,
  AUTOMATION_WATCH_COOLDOWN_S,
  automationKind,
  liveRecipes,
  recipeNamed,
  type Automation,
  type AutomationClauses,
  type AutomationDraft,
  type AutomationKind,
  type AutomationState,
  type AutomationWhen,
  type EngineCommand,
  type EngineEvent,
  type MissedWhy,
  type ProblemKind,
  type ProblemRemedy,
  type RingLine,
  type Settings,
  type SettingsPatch,
  type AutomationSettings,
  type ShellRecipe,
  type Snapshot,
  type SystemSignal,
  type AgentInfo,
} from "@jarhead/protocol";
import { AutomationExecutor, DETAIL_CHARS, EVENT_DETAIL_CHARS, EVENT_LINE_CHARS, defaultAutomationExec, type AutomationExec, type FireOutcome, type LiveLike, type ShellGate, type ShellRunner, type WakeBrainSeam } from "./executor.ts";
import { AutomationTable, SCHEDULED } from "./table.ts";
import { Watchers } from "./watchers.ts";

export { AutomationTable, JOURNAL_COMPACT_BYTES } from "./table.ts";
export { AutomationExecutor, defaultAutomationExec, freeName, firstSentence } from "./executor.ts";
export type { AutomationExec, LiveLike, ShellGate, ShellRunner, WakeBrainLane, WakeBrainSeam } from "./executor.ts";
export { Watchers, FOLDER_POLL_MS, APP_POLL_MS, LIST_ASYNC_AT, globToRegExp, runningApps } from "./watchers.ts";

/**
 * The Automations façade the engine constructs beside the ThreadScheduler: arming (the
 * set-up gate, judged once, awake), the clock (`tick(now)` from the engine's 1 s tick —
 * sleep detection by the tick gap, the due loop, the rings, the watchers, the timer
 * ticks, the day's brain spend), the signals the app forwards, the thirteen commands, the
 * snapshot projection and the `AutomationSource` the brain's four tools call.
 *
 * Rails: nothing here opens a Live session or reads a yes (the engine's wake path, its
 * session opener and its presence stamp are never called; a fire that would need a yes is
 * a `failed` row);
 * `presence.recent` is false at every fire-time policy call; rows are never deleted
 * (`trashed` is a state, the journal only grows); the ledger is the record.
 */

const log = logger("engine.automations");

/** The name a row wears, at most this long. */
export const AUTOMATION_NAME_CHARS = 24;
/** The echo line Jarhead read back, at most this long. */
export const AUTOMATION_ECHO_CHARS = 120;
/** One `caffeinate -t` holds a running timer at most this long; a longer timer is held again before each one runs out. */
export const CAFFEINATE_CHUNK_MS = 60 * 60_000;
/** A hold is renewed this long before it runs out. */
const CAFFEINATE_RENEW_MS = 60_000;
/** The zone link is read this often from tick() (and at every clock.changed). */
export const ZONE_CHECK_MS = 60_000;
/** Files a folder row has waiting at most; past it a landing is counted, not handled. */
export const FILE_QUEUE_MAX = 100;
/** The actions that take the landed file: a folder row with one handles every file, one fire each. */
const FILE_KINDS: ReadonlySet<string> = new Set(["file", "run-recipe"]);
/** A row in one of these states keeps its name only until another row wants it. */
const RETIRABLE: ReadonlySet<AutomationState> = new Set<AutomationState>(["done", "failed"]);
/** The brains always billed per token on an API key: the cost line says so. openai-compatible depends on its server (brainPaid). */
const API_BRAINS: ReadonlySet<string> = new Set(["anthropic-api", "openai-responses"]);

/** Which brain keys are set, by presence only (core's secretsPresent). */
export interface BrainKeys {
  /** JARHEAD_BRAIN_API_KEY: the one key an openai-compatible server other than OpenAI's is sent. */
  readonly brainApiKey: boolean;
  /** OPENAI_API_KEY: sent to an openai-compatible root only when it is OpenAI's own host. */
  readonly openai: boolean;
}

/** The host of a server root, lowercased; a root written without a scheme ("localhost:11434") is read as http. */
function hostOfRoot(root: string): string {
  const r = root.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(r) ? r : `http://${r}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * How a wake-brain fire on `brain` is paid for, as the cost line says it: `mac` for a model on this Mac, else core's BrainPaid.
 * An openai-compatible brain is judged by Settings' server root and the keys that are set, the same three inputs the Console's
 * form reads (AutomationForm.billing): a loopback root with no brain key is a model on this Mac (Ollama, LM Studio); a root
 * that is sent Kevin's key bills tokens on it (OpenAI's host takes OPENAI_API_KEY too); any other root, or none in Settings,
 * is "the server you set". Every other brain: local is `mac`, the API brains `key`, the logins (and an unresolved auto) `plan`.
 */
export function brainPaid(brain: string | undefined, brainBaseUrl: string | undefined, keys: BrainKeys): "mac" | NonNullable<AutomationContext["paid"]> {
  if (brain === "local") return "mac";
  if (brain !== undefined && API_BRAINS.has(brain)) return "key";
  if (brain !== "openai-compatible") return "plan";
  const host = hostOfRoot(brainBaseUrl ?? "");
  if (!host) return "server";
  if (isLoopbackHost(host)) return keys.brainApiKey ? "server" : "mac";
  const openaiHost = host === "api.openai.com" || host.endsWith(".openai.com");
  return keys.brainApiKey || (openaiHost && keys.openai) ? "key" : "server";
}
/** What a `firing` row left by a dead daemon says. */
export const RESTART_DETAIL = "the daemon restarted";
/** A recipe the brain hands in with a row is saved with this cap. */
const RECIPE_TIMEOUT_DEFAULT_S = 120;
/** The daemon stamps `<stateDir>/automations/alive` this often from tick(): at the next start it is when the watching stopped. */
export const ALIVE_EVERY_MS = 60_000;

/** The brain's `automation_change` verbs, one word each (packages/brain declares them; the surfaces send the same set). */
export type ChangeVerb = AutomationVerb;

export type ArmOrigin = "brain" | "console" | "cli";

/** The brain's `automation_set` arguments: the draft (clauses and echo may be left out) plus a recipe text to save. */
export type AutomationSetInput = Omit<AutomationDraft, "clauses" | "echo"> & {
  readonly clauses?: Partial<AutomationClauses> | undefined;
  readonly echo?: string | undefined;
  readonly recipeCommand?: string | undefined;
};

export interface ArmContext {
  /** Kevin's own words for the row (the policy's `request`: a folder he named is one `file` may move into). */
  readonly request?: string | undefined;
  readonly chainId?: string | undefined;
  readonly delegationId?: string | undefined;
  /** A spawned thread is arming it (depth one: free kinds only). */
  readonly fromThread?: boolean | undefined;
  /** The words Kevin heard when he said yes (the runner's outstanding question); absent, the gate's own reason is recorded. */
  readonly heard?: string | undefined;
  /** The runner knows the brain is local; absent, Settings decides. */
  readonly localBrain?: boolean | undefined;
}

export type AutomationSetOutcome =
  /** `text` is the toast's whole line; `note` the part after the arm itself (quiet hours, a folder not readable yet) for a caller that writes its own line. */
  | { readonly kind: "armed"; readonly text: string; readonly automation: Automation; readonly note?: string | undefined }
  /** The one set-up question (run-recipe · press · wake-brain): the runner asks it once and re-calls with `confirmed`. */
  | { readonly kind: "confirm"; readonly question: string }
  | { readonly kind: "refused"; readonly reason: string };

export interface AutomationsOptions {
  readonly stateDir: string;
  readonly now: () => number;
  readonly ledger: Ledger;
  readonly settings: () => Settings;
  /** The engine writes settings.json (a recipe the brain handed in after the yes; the Console's Recipes list). */
  readonly updateSettings: (patch: SettingsPatch) => void;
  /** The acting helper (open_app, the press probes and key). */
  readonly hands: NativeHands;
  /** Unused: the app quit fallback reads the process list through `exec`. The engine still hands it in; the two go together. */
  readonly reader?: NativeHands | undefined;
  readonly redact: (text: string) => string;
  readonly emit: (event: EngineEvent) => void;
  readonly problem: (kind: ProblemKind, text: string, remedy?: ProblemRemedy) => void;
  readonly clearProblems?: ((kind: ProblemKind, where?: (text: string) => boolean) => void) | undefined;
  /** The open Live session, when one is up. */
  readonly live: () => LiveLike | undefined;
  readonly brain: WakeBrainSeam;
  /** Kevin is here (a session is open, he spoke recently, or his hands moved): `automation.run` needs it. */
  readonly present: () => Promise<boolean>;
  /** The brain is a local model (the cost line says warm-up, not plan). */
  readonly localBrain: () => boolean;
  /**
   * The brain a wake-brain fire would run on, resolved (what `auto` became); absent, Settings' brain. An API brain's cost line
   * says tokens on the key; wired, it also decides the local warm-up line in place of `localBrain`. The engine wires
   * `() => (this.brainReady && this.brain ? this.brain.kind : this.settings.brain)`, and the Console's AutomationForm.billedBrain
   * reads `setup.brainResolved ?? settings.brain` in the same change, so the form shows what the engine records. That is
   * TRIAGE's W2-1 / W2-2 contract, at the wave merge; until it lands, the default `auto` is judged as "on your plan".
   */
  readonly brainKind?: (() => string | undefined) | undefined;
  /** Which brain keys are set (the openai-compatible cost line); absent, core's secretsPresent(). */
  readonly brainKeys?: (() => BrainKeys) | undefined;
  /** The snapshot goes out (the LIST or a row changed). */
  readonly onChange: () => void;
  /** The user's name as the lines say it (the engine's effective name; "Kevin" when none is wired). */
  readonly userName?: (() => string) | undefined;
  readonly exec?: AutomationExec | undefined;
  readonly shell?: ShellRunner | undefined;
  readonly shellGate?: ShellGate | undefined;
  readonly home?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly coalesceMs?: number | undefined;
  readonly compactBytes?: number | undefined;
}

interface Hold {
  kill(): void;
}

/** The zone the process's clock math runs in now. */
function currentZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * `ms` read as a wall clock in the zone `from`, then the same wall clock in the zone the process runs in now: Mon 07:10 in
 * New York becomes Mon 07:10 in Los Angeles. A minute the new zone skips rolls forward as atClock does. A zone name Intl
 * does not know leaves the instant as it was.
 */
export function repinned(ms: number, from: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: from, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(ms);
  } catch {
    return ms;
  }
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const [y, mo, d, h, mi] = [part("year"), part("month"), part("day"), part("hour"), part("minute")];
  if (![y, mo, d, h, mi].every(Number.isFinite)) return ms;
  // The seconds past the minute are the same in every zone (offsets are whole minutes).
  const rest = ((ms % 60_000) + 60_000) % 60_000;
  return atClock(new Date(y, mo - 1, d), `${pad2(h)}:${pad2(mi)}` as Parameters<typeof atClock>[1]) + rest;
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A row with `changes` applied; a key set to undefined leaves the row (the contract's optionals are absent, never undefined). */
function mut(a: Automation, changes: { readonly [K in keyof Automation]?: Automation[K] | undefined }): Automation {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as unknown as Automation;
}

export class Automations implements AutomationSource {
  readonly table: AutomationTable;
  readonly executor: AutomationExecutor;
  readonly watchers: Watchers;
  private readonly now: () => number;
  private readonly home: string;
  private readonly exec: AutomationExec;
  private lastTickAt = 0;
  /** `<stateDir>/automations/alive`: the last instant this daemon was known to be watching (written every ALIVE_EVERY_MS). */
  private readonly alivePath: string;
  /** `<stateDir>/automations/zone`, beside it: the zone the rows' wall clocks are pinned to, for a daemon that starts somewhere else. */
  private readonly zonePath: string;
  private aliveAt = 0;
  /** At load: the previous daemon's last heartbeat, for the missed rows' words ("Jarhead was off from 02:10") and the watchers' baseline. */
  private downSince: number | undefined;
  /** The master switch as the last tick saw it: the off→on edge resyncs what fell due while off. */
  private wasEnabled: boolean | undefined;
  /** The app said the Mac is going to sleep: evidence for the missed row's detail. */
  private sleptAt: number | undefined;
  /** Alarms that self-snoozed once while unanswered. */
  private readonly selfSnoozed = new Set<string>();
  /** The ring line per `fired` row (the island's), without `more`. */
  private readonly rings = new Map<string, Omit<RingLine, "more">>();
  private readonly lastChimeAt = new Map<string, number>();
  /** `caffeinate` holds per running timer, and when each runs out. */
  private readonly holds = new Map<string, { readonly hold: Hold; readonly until: number }>();
  /** Landed files a folder row has yet to handle, oldest first: one fire each. */
  private readonly fileQueue = new Map<string, { readonly file: string; readonly what: string | undefined }[]>();
  /** The zone link as last read (the first read only records it), the zone the rows' clocks were computed in, and when it was read. */
  private zoneLink: string | undefined;
  private zone: string | undefined;
  private zoneCheckedAt = 0;
  /** Signals inside a row's cooldown since its last fire. */
  private readonly cooled = new Map<string, number>();
  /** Rows whose fire is in flight (a signal storm queues nothing behind it; a folder row's landed files wait in fileQueue). */
  private readonly firing = new Set<string>();
  private viewers = 0;
  /** Brain seconds `wake-brain` spent today and the day it was summed for. */
  private brainSpent = 0;
  private spendDay = "";
  /** Budget seconds reserved by wake-brain fires in flight, by row: counted as spent until the fire settles. */
  private readonly reservedBrain = new Map<string, number>();
  private loaded = false;

  constructor(private readonly opts: AutomationsOptions) {
    this.now = opts.now;
    this.home = opts.home ?? homedir();
    this.exec = opts.exec ?? defaultAutomationExec;
    this.alivePath = join(opts.stateDir, "automations", "alive");
    this.zonePath = join(opts.stateDir, "automations", "zone");
    const shell: ShellRunner = opts.shell ?? ((o) => runShell(o));
    const shellGate: ShellGate = opts.shellGate ?? ((ctx: ActionContext): Decision => classifyAction(ctx));
    this.table = new AutomationTable({ stateDir: opts.stateDir, now: this.now, sink: (e) => opts.emit({ type: "automation.event", event: e }), coalesceMs: opts.coalesceMs, compactBytes: opts.compactBytes });
    this.executor = new AutomationExecutor({
      now: this.now,
      ledger: opts.ledger,
      settings: opts.settings,
      hands: opts.hands,
      redact: opts.redact,
      emit: opts.emit,
      exec: this.exec,
      shell,
      shellGate,
      live: opts.live,
      brain: opts.brain,
      home: this.home,
      repoRoot: opts.repoRoot,
      problem: opts.problem,
      brainSpentToday: () => this.brainSpent + [...this.reservedBrain.values()].reduce((a, b) => a + b, 0),
      reserveBrain: (id, seconds) => this.reservedBrain.set(id, seconds),
      userName: opts.userName,
    });
    this.watchers = new Watchers({ now: this.now, exec: this.exec, shell, shellGate, settings: opts.settings, home: this.home, repoRoot: opts.repoRoot });
  }

  // ------------------------------------------------------------------ load

  /**
   * At `Engine.start()`, after `restoreFromLedger`: the journal, last-by-id; the rows' wall
   * clocks moved to this zone when the last daemon pinned them elsewhere; a row left
   * `firing` by a dead daemon → `failed: "the daemon restarted"`; repeaters without a
   * `nextAt` get one; watchers are watched again (their listings the new baseline); the
   * day's brain spend is re-summed from the ledger; then `resync(now, "daemon-down")`.
   * A second load over the same journal appends nothing new for a clean table.
   */
  load(now = this.now()): void {
    this.table.load();
    this.rings.clear();
    this.holds.clear();
    this.fileQueue.clear();
    // The zone the rows are pinned to: this process's own, else the one the last daemon wrote down. A daemon started after
    // the Mac moved (it quit in New York and starts at login in Los Angeles) moves every wall clock here, as a move while
    // running does; what that puts behind now is settled by the resync below.
    this.zone ??= this.readZone();
    this.checkZone(now);
    // The last daemon's heartbeat: from then until now nothing watched. Its folders' baselines are taken as of that instant.
    const downSince = this.readAlive();
    this.downSince = downSince !== undefined && downSince < now ? downSince : undefined;
    for (const a of this.table.all()) {
      if (a.state === "firing") {
        const row = this.write(mut(a, { state: this.repeats(a) ? "armed" : "failed", nextAt: this.repeats(a) ? nextFire(a.when, now, a.createdAt) : undefined, lastDetail: RESTART_DETAIL, updatedAt: now }), "engine", RESTART_DETAIL);
        // A watcher whose fire the dead daemon left in flight watches again, like any armed one.
        if (row.state === "armed" && row.when.kind === "on") {
          const err = this.watchers.watch(row, this.downSince);
          if (err) this.watchProblem(row, err);
        }
        continue;
      }
      if (a.state === "fired") {
        // A ring nobody answered before the daemon died: the row goes on as if Done.
        this.finishRing(a, now, "unanswered · the daemon restarted");
        continue;
      }
      if (SCHEDULED.has(a.state) && a.when.kind !== "on" && a.nextAt === undefined) {
        const next = nextFire(a.when, now, a.createdAt);
        if (next !== undefined) this.write(mut(a, { nextAt: next, updatedAt: now }), "engine");
        else if (a.when.kind === "at" || a.when.kind === "in") this.write(mut(a, { state: "failed", lastDetail: "missed", missed: a.missed + 1, updatedAt: now }), "engine", "missed");
      }
      if (a.state === "armed" && a.when.kind === "on") {
        const err = this.watchers.watch(a, this.downSince);
        if (err) this.watchProblem(a, err);
      }
      // A running timer, or a snoozed one, holds the Mac awake again.
      if ((a.state === "armed" || a.state === "snoozed") && a.when.kind === "in" && a.nextAt !== undefined) this.caffeinate(a, now);
    }
    this.sumSpend(now);
    this.loaded = true;
    this.lastTickAt = 0;
    this.resync(now, "daemon-down");
    this.downSince = undefined;
    this.heartbeat(now);
    this.opts.onChange();
  }

  /** The previous daemon's last heartbeat, or undefined when there is none (a first run, an unreadable file). */
  private readAlive(): number | undefined {
    try {
      const n = Number(readFileSync(this.alivePath, "utf8").trim());
      return Number.isFinite(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  }

  /** The zone the rows were pinned to when the last daemon wrote it down, or undefined (a first run, a daemon from before the file). */
  private readZone(): string | undefined {
    try {
      const zone = readFileSync(this.zonePath, "utf8").trim();
      return zone || undefined;
    } catch {
      return undefined;
    }
  }

  /** `zone` holds the zone the rows are pinned to: written when it is first recorded and at every move. */
  private writeZone(zone: string): void {
    try {
      mkdirSync(dirname(this.zonePath), { recursive: true });
      writeFileSync(this.zonePath, zone);
    } catch (e) {
      log.debug(`zone: ${(e as Error).message}`);
    }
  }

  /** `alive` holds `now`: one small file rewritten every minute; a failure to write it changes nothing else. */
  private heartbeat(now: number): void {
    this.aliveAt = now;
    try {
      mkdirSync(dirname(this.alivePath), { recursive: true });
      writeFileSync(this.alivePath, String(now));
    } catch (e) {
      log.debug(`alive: ${(e as Error).message}`);
    }
  }

  private repeats(a: Automation): boolean {
    return a.when.kind === "every" || a.when.kind === "on";
  }

  private sumSpend(now: number): void {
    let seconds = 0;
    for (const row of this.opts.ledger.read(now)) if (row.type === "automation.fired" && typeof row.brainSeconds === "number") seconds += row.brainSeconds;
    this.brainSpent = seconds;
    this.spendDay = Ledger.dayFor(now);
  }

  // ------------------------------------------------------------------ tick

  /**
   * The clock, from the engine's tick: (1) a gap over AUTOMATION_SLEEP_GAP_MS means the
   * Mac slept — resync; (2) due rows fire, roll or defer; (3) rings re-chime and linger;
   * (4) the watchers poll; (5) running timers tick while someone looks; (6) the day
   * rolled — the brain spend is re-summed.
   */
  tick(now = this.now()): void {
    if (now - this.aliveAt >= ALIVE_EVERY_MS) this.heartbeat(now);
    const enabled = this.opts.settings().automations.enabled;
    if (!enabled) {
      // Off: nothing fires, nothing resyncs (a sleep gap while off is settled at the flip), every row stays. The rows still
      // follow the zone: the flip's resync reads them where the Mac is.
      if (now - this.zoneCheckedAt >= ZONE_CHECK_MS) this.checkZone(now);
      this.lastTickAt = now;
      this.wasEnabled = false;
      return;
    }
    // The switch back on: what fell due while it was off goes through the missed table — grace for one-shots, skipped
    // routines — never fired hours late. Otherwise a tick gap over AUTOMATION_SLEEP_GAP_MS means the Mac slept. Either
    // resync reads the zone first; with neither, the zone is read once a minute and what a move put behind now is settled.
    if (this.wasEnabled === false) this.resync(now, "daemon-down");
    else if (this.lastTickAt !== 0 && now - this.lastTickAt > AUTOMATION_SLEEP_GAP_MS) this.resync(now, "mac-slept");
    else if (now - this.zoneCheckedAt >= ZONE_CHECK_MS) this.checkZone(now, true);
    this.lastTickAt = now;
    this.wasEnabled = true;
    this.fireDue(now);
    this.ringTick(now);
    this.renewHolds(now);
    void this.pollWatchers(now);
    if (this.viewers > 0) for (const a of this.table.inState("armed")) if (a.when.kind === "in" && a.nextAt !== undefined) this.table.push(a.id, { kind: "tick", remainingMs: Math.max(0, a.nextAt - now) });
    if (this.spendDay !== Ledger.dayFor(now)) this.sumSpend(now);
  }

  private fireDue(now: number): void {
    for (let guard = 0; guard < 64; guard++) {
      const a = this.table.popDue(now);
      if (!a || a.nextAt === undefined) return;
      if (this.firing.has(a.id)) continue;
      const dueAt = a.nextAt;
      // Outside its window or off its days: a repeater rolls to the next occurrence; a one-shot fires anyway (it has no days).
      if (a.when.kind === "every" && !inWindow(a.clauses, dueAt)) {
        this.roll(a, dueAt, now, "outside its window");
        continue;
      }
      // Later than its grace (a tick's worth of slack): the missed table, never a late run — whatever let it get this late. A
      // deferred row is due at its quiet end and keeps the same grace from there.
      const lateMs = now - dueAt;
      if (lateMs > Math.max(graceFor(automationKind(a)), AUTOMATION_SLEEP_GAP_MS)) {
        this.settleDue(a, now, "daemon-down");
        continue;
      }
      this.fireOrDefer(a, now, dueAt, lateMs);
    }
  }

  /** A due row fires now — unless quiet hours hold and it acts, then it waits for the quiet end (the one quiet rule, for the tick and the resync alike). */
  private fireOrDefer(a: Automation, now: number, dueAt: number, lateMs: number): void {
    const quiet = a.clauses.quiet === "respect" && a.state !== "deferred" && inQuiet(this.opts.settings().automations.quietHours, now);
    if (quiet && a.then.some((x) => x.kind !== "chime" && x.kind !== "say" && x.kind !== "notify")) {
      this.defer(a, now, dueAt);
      return;
    }
    void this.fire(a, now, Math.max(0, lateMs), { dueAt, quiet });
  }

  /** An acting kind due inside quiet hours: it waits for the quiet end — unless the next regular occurrence comes sooner. */
  private defer(a: Automation, now: number, dueAt: number): void {
    const ends = quietEnds(this.opts.settings().automations.quietHours, now) ?? now;
    const next = this.repeats(a) ? nextFire(a.when, dueAt, a.createdAt) : undefined;
    if (next !== undefined && next <= ends) {
      this.missedRow(a, dueAt, "quiet-hours", true);
      this.write(mut(a, { state: "armed", nextAt: next, missed: a.missed + 1, lastDetail: "quiet hours: skipped", updatedAt: now }), "engine", "quiet hours: skipped");
      return;
    }
    const detail = `deferred to ${describeInstant(ends).slice(0, 5)}`;
    this.write(mut(a, { state: "deferred", nextAt: ends, lastDetail: detail, updatedAt: now }), "engine", detail);
  }

  /** A repeater rolls to its next occurrence after `from`; past `until` it is done. */
  private roll(a: Automation, from: number, now: number, detail?: string): void {
    const next = nextFire(a.when, from, a.createdAt);
    if (next === undefined || (a.clauses.until !== undefined && next > a.clauses.until)) {
      this.write(mut(a, { state: "done", nextAt: undefined, snoozedUntil: undefined, lastDetail: detail ?? "past its last day", updatedAt: now }), "engine", detail ?? "past its last day");
      return;
    }
    this.write(mut(a, { state: "armed", nextAt: next, snoozedUntil: undefined, ...(detail ? { lastDetail: detail } : {}), updatedAt: now }), "engine", detail);
  }

  /** Alarms re-chime every AUTOMATION_REPEAT_CHIME_MS while `fired`; a ring past the linger self-snoozes once (alarms) or counts as Done. */
  private ringTick(now: number): void {
    for (const a of this.table.inState("fired")) {
      const since = a.lastFiredAt ?? a.updatedAt;
      const kind = automationKind(a);
      if (now - since >= AUTOMATION_LINGER_MS) {
        if (kind === "alarm" && !this.selfSnoozed.has(a.id)) {
          this.selfSnoozed.add(a.id);
          this.snooze(a, this.opts.settings().automations.snoozeMinutes, "engine", now, "unanswered · snoozed once");
        } else {
          this.selfSnoozed.delete(a.id);
          this.finishRing(a, now, "unanswered");
        }
        continue;
      }
      if (kind !== "alarm" || this.opts.live() || a.clauses.quiet === "respect" && inQuiet(this.opts.settings().automations.quietHours, now)) continue;
      const last = this.lastChimeAt.get(a.id) ?? since;
      if (now - last >= AUTOMATION_REPEAT_CHIME_MS) {
        this.lastChimeAt.set(a.id, now);
        const chime = a.then.find((x) => x.kind === "chime");
        this.opts.emit({ type: "local.say", sound: chime?.kind === "chime" && chime.sound ? chime.sound : "Hero", automationId: a.id });
      }
    }
  }

  private async pollWatchers(now: number): Promise<void> {
    // The armed watchers, and the folder rows that ring or fire: files that land meanwhile wait in their queue.
    const rows = this.table.all().filter((a) => a.when.kind === "on" && (a.state === "armed" || (isFolderRow(a) && (a.state === "fired" || a.state === "firing"))));
    if (rows.length === 0) return;
    try {
      // The app client forwards app.launch / app.quit itself: the process list is only the fallback while none is attached.
      for (const f of await this.watchers.poll(now, rows, { appSignals: this.viewers > 0 })) this.watcherFire(f.id, now, f.file, f.what);
    } catch (e) {
      log.warn(`watchers: ${(e as Error).message}`);
    }
  }

  private armedWatchers(): Automation[] {
    return this.table.inState("armed").filter((a) => a.when.kind === "on");
  }

  /**
   * The zone. The clock math is local and Node keeps the zone the process started in, so the
   * /etc/localtime link is read once a minute, at every resync and at every `clock.changed` and
   * `mac.wake`: a link that moved becomes `process.env.TZ` (the first read only records it, so a
   * process started with its own TZ keeps it). When the process zone is not the one the rows were
   * pinned to, every wall clock moves (moveZone). `settle`: what the move put behind now is settled
   * here; a resync passes false and settles it with everything else the gap passed.
   */
  private checkZone(now: number, settle = false): void {
    this.zoneCheckedAt = now;
    const link = this.exec.zone?.();
    if (link !== undefined && link !== this.zoneLink) {
      const first = this.zoneLink === undefined;
      this.zoneLink = link;
      if (!first && process.env["TZ"] !== link) {
        log.info(`the Mac's time zone is now ${link}`);
        process.env["TZ"] = link;
      }
    }
    const zone = currentZone();
    const was = this.zone;
    if (zone === was) return;
    this.zone = zone;
    this.writeZone(zone);
    if (was !== undefined) this.moveZone(was, now, settle);
  }

  /**
   * The rows' wall clocks move from the zone `from` to the zone the process runs in now. Each instant is re-pinned, never
   * recomputed from now: the occurrence a row was waiting for keeps its day and its clock (Mon 07:10 New York → Mon 07:10
   * Los Angeles), so a skip holds, an occurrence already rung never rings twice, and one a move puts behind now stays due
   * for the missed table (Run now). Re-pinned: a one-shot's `at`; the `nextAt` of an armed or ringing clock row (an
   * interval keeps its cadence) and of any deferred row (quiet hours are a wall clock). A timer, a snooze and a watcher
   * keep their instants.
   */
  private moveZone(from: string, now: number, settle: boolean): void {
    const moved = new Set<string>();
    for (const a of this.table.all()) {
      if (a.state === "done" || a.state === "failed" || a.state === "trashed" || a.state === "firing" || a.when.kind === "on") continue;
      const wall = a.when.kind === "at" || (a.when.kind === "every" && a.when.every.kind !== "interval");
      const at = a.when.kind === "at" ? repinned(a.when.at, from) : undefined;
      const pin = a.nextAt !== undefined && (a.state === "deferred" || (wall && (a.state === "armed" || a.state === "fired")));
      const nextAt = pin && a.nextAt !== undefined ? repinned(a.nextAt, from) : a.nextAt;
      const whenMoved = a.when.kind === "at" && at !== undefined && at !== a.when.at;
      if (!whenMoved && nextAt === a.nextAt) continue;
      const when: AutomationWhen = a.when.kind === "at" && at !== undefined ? { ...a.when, at } : a.when;
      this.write(mut(a, { when, nextAt, updatedAt: now }), "engine", undefined, false);
      moved.add(a.id);
    }
    log.info(`time zone ${from} → ${this.zone}: ${moved.size} row${moved.size === 1 ? "" : "s"} moved to the new wall clock`);
    if (moved.size === 0) return;
    // Awake, with no resync to come: inside its grace the occurrence rings late; past it, a missed row with Run now.
    if (settle && this.loaded && this.opts.settings().automations.enabled) {
      for (const a of this.table.due(now)) if (moved.has(a.id) && !this.firing.has(a.id)) this.settleDue(a, now, "mac-slept", "the time zone moved");
    }
    this.opts.onChange();
  }

  // ---------------------------------------------------------------- signals

  /** A signal the app observed on Kevin's behalf — data, never a command. `mac.sleep` is evidence; `mac.wake` / `clock.changed` resync. */
  signal(sig: SystemSignal, at = this.now()): void {
    if (sig.kind === "mac.sleep") {
      this.sleptAt = at;
      return;
    }
    // A clock or zone change (the app forwards NSSystemTimeZoneDidChange as clock.changed) or a wake: the zone first, so every
    // row is read in the zone the Mac is in now, whichever signal comes first.
    if (sig.kind === "clock.changed" || sig.kind === "mac.wake") this.checkZone(this.now());
    // Off: the switch's own resync at the flip settles everything; a signal fires nothing meanwhile.
    if (!this.opts.settings().automations.enabled) return;
    if (sig.kind === "mac.wake" || sig.kind === "clock.changed") this.resync(this.now(), "mac-slept");
    if (sig.kind === "screen.lock") return;
    for (const f of this.watchers.signal(sig, this.armedWatchers())) this.watcherFire(f.id, this.now(), undefined, f.what);
  }

  /** The agents registry refreshed (the engine's `agents.onChange`). */
  agents(list: readonly AgentInfo[]): void {
    const fires = this.watchers.agents(list, this.loaded ? this.armedWatchers() : []);
    if (!this.opts.settings().automations.enabled) return;
    for (const f of fires) this.watcherFire(f.id, this.now(), undefined, f.what);
  }

  /**
   * A watcher saw its signal: the clauses (days / window / once / cooldown) admit or count it, then it fires. A folder row
   * whose actions take the file (file, run-recipe) handles every file: one landing while a fire is in flight waits in the
   * row's queue, and inside the cooldown only the chime, the line and the banner hold back. Anything else inside the
   * cooldown, or while its fire is in flight, is counted (a storm is one fire and a number).
   */
  private watcherFire(id: string, now: number, file: string | undefined, what: string | undefined): void {
    const a = this.table.get(id);
    const perFile = file !== undefined && a !== undefined && a.then.some((x) => FILE_KINDS.has(x.kind));
    // Armed rows fire; a row whose fire is in flight counts the signal; a folder row takes its files while it rings too.
    if (!a || (a.state !== "armed" && a.state !== "firing" && !(file !== undefined && a.state === "fired"))) return;
    if (!inWindow(a.clauses, now)) return;
    if (a.clauses.once === "day" && a.lastFiredAt !== undefined && Ledger.dayFor(a.lastFiredAt) === Ledger.dayFor(now)) return;
    if (perFile && (this.firing.has(a.id) || a.state === "firing")) {
      this.enqueue(a, now, file, what);
      return;
    }
    const cooldownMs = (a.clauses.cooldown ?? AUTOMATION_WATCH_COOLDOWN_S) * 1000;
    const cooling = a.lastFiredAt !== undefined && now - a.lastFiredAt < cooldownMs;
    if (this.firing.has(a.id) || (cooling && !perFile)) {
      this.count(a, now, "in cooldown");
      return;
    }
    this.cooled.delete(a.id);
    const quiet = a.clauses.quiet === "respect" && inQuiet(this.opts.settings().automations.quietHours, now);
    if (quiet && a.then.some((x) => x.kind !== "chime" && x.kind !== "say" && x.kind !== "notify")) {
      this.missedRow(a, now, "quiet-hours", true);
      this.write(mut(a, { missed: a.missed + 1, lastDetail: "quiet hours: not run", updatedAt: now }), "engine", "quiet hours: not run");
      return;
    }
    void this.fire(a, now, 0, { dueAt: now, quiet, file, what, muted: cooling });
  }

  /** A signal counted on the row's detail ("+4 in cooldown"), never fired. */
  private count(a: Automation, now: number, why: string): void {
    const n = (this.cooled.get(a.id) ?? 0) + 1;
    this.cooled.set(a.id, n);
    const base = (a.lastDetail ?? "").replace(/ · \+\d+ (in cooldown|not handled)$/, "");
    this.write(mut(a, { lastDetail: cut(`${base}${base ? " · " : ""}+${n} ${why}`, DETAIL_CHARS), updatedAt: now }), "engine", undefined, false);
  }

  /** A landed file waits for the fire in flight; past FILE_QUEUE_MAX it is counted, not handled. */
  private enqueue(a: Automation, now: number, file: string, what: string | undefined): void {
    const q = this.fileQueue.get(a.id) ?? [];
    if (q.length >= FILE_QUEUE_MAX) {
      this.count(a, now, "not handled");
      return;
    }
    q.push({ file, what });
    this.fileQueue.set(a.id, q);
  }

  /** After a fire: the row's waiting files go, one fire each, while it still watches. */
  private drainFiles(id: string): void {
    const q = this.fileQueue.get(id);
    while (q && q.length > 0 && !this.firing.has(id)) {
      const a = this.table.get(id);
      if (!a || (a.state !== "armed" && a.state !== "fired")) {
        this.fileQueue.delete(id);
        return;
      }
      const next = q.shift()!;
      this.watcherFire(id, this.now(), next.file, next.what);
    }
    if (q && q.length === 0) this.fileQueue.delete(id);
  }

  // ------------------------------------------------------------------ fire

  /**
   * One fire: `firing` → the executor → the row's next state: a ring waits for Done; an
   * acting-only repeater re-arms; a one-shot is done; a failure leaves a one-shot `failed`
   * and re-arms a repeater with the reason. Every fire is an `automation.fired` row and
   * one `fired` event with its presses.
   */
  private async fire(row: Automation, now: number, lateMs: number, o: { readonly dueAt: number; readonly quiet: boolean; readonly file?: string | undefined; readonly what?: string | undefined; readonly muted?: boolean | undefined }): Promise<void> {
    if (this.firing.has(row.id)) return;
    this.firing.add(row.id);
    this.releaseHold(row.id);
    const next = this.repeats(row) && row.when.kind !== "on" ? nextFire(row.when, Math.max(o.dueAt, now), row.createdAt) : undefined;
    const started = this.write(mut(row, { state: "firing", updatedAt: now }), "engine", undefined, false);
    let outcome: FireOutcome;
    try {
      outcome = await this.executor.fire({ a: started, now, lateMs, file: o.file, quiet: o.quiet, dueAt: o.dueAt, muted: o.muted }, next);
    } catch (e) {
      // The same redaction the executor gives its own details: an error carrying a path or a token reaches no surface.
      outcome = { ok: false, actions: row.then.map((x) => x.kind), line: this.executor.line(row, o.dueAt), detail: cut(this.opts.redact(`failed: ${(e as Error).message}`), DETAIL_CHARS), presses: [], ring: false, ms: 0 };
    } finally {
      this.firing.delete(row.id);
      // The reservation ends with the fire, in the same turn that adds the real spend below.
      this.reservedBrain.delete(row.id);
    }
    // The landed file was filed away: a new one under its name lands again.
    if (o.file !== undefined && !existsSync(o.file)) this.watchers.forget(o.file);
    const at = this.now();
    const current = this.table.get(row.id) ?? started;
    // Kevin trashed or paused it while it ran: the fire's record (the ledger row, the event) still stands; the state stays his.
    const moved = current.state === "trashed" || current.state === "paused";
    const late = lateMs > 60_000 ? `${Math.round(lateMs / 60_000)} min late` : undefined;
    const quietNote = o.quiet && outcome.ok && outcome.ring ? "quiet hours: shown, not said" : undefined;
    // Signals counted inside the cooldown while this fire ran stay on the row ("+4 in cooldown").
    const cooled = /\+\d+ in cooldown$/.exec(current.lastDetail ?? "")?.[0];
    const detail = [...[outcome.detail, quietNote, late].filter((s): s is string => typeof s === "string" && s.length > 0), ...(outcome.detail || quietNote || late ? [] : o.what ? [o.what] : []), ...(cooled ? [cooled] : [])].join(" · ") || undefined;
    if (outcome.brainSeconds) this.brainSpent += outcome.brainSeconds;
    this.opts.ledger.append({
      at,
      type: "automation.fired",
      id: row.id,
      actions: outcome.actions,
      ok: outcome.ok,
      line: outcome.line,
      ...(detail ? { detail: cut(detail, DETAIL_CHARS) } : {}),
      ...(lateMs > 0 ? { lateMs } : {}),
      ms: outcome.ms,
      ...(outcome.delegationId ? { delegationId: outcome.delegationId } : {}),
      ...(outcome.brainSeconds !== undefined ? { brainSeconds: outcome.brainSeconds } : {}),
    });
    const base: Automation = mut(current, { fires: current.fires + 1, lastFiredAt: at, ...(detail ? { lastDetail: cut(detail, DETAIL_CHARS) } : { lastDetail: undefined }), snoozedUntil: undefined, updatedAt: at });
    const oneShotDone = row.clauses.once === true || row.when.kind === "at" || row.when.kind === "in";
    if (moved) {
      // The count and the detail are the fire's; the state is what Kevin set (trashed rows leave the heap, paused rows wait).
      this.write(mut(base, { state: current.state, nextAt: undefined }), "engine", undefined, false);
    } else if (!outcome.ok) {
      if (this.repeats(row) && !oneShotDone) this.write(this.rearmed(base, next, at), "engine", detail);
      else this.write(mut(base, { state: "failed", nextAt: undefined }), "engine", detail);
    } else if (outcome.ring) {
      this.rings.set(row.id, { id: row.id, kind: automationKind(row), name: row.name, line: outcome.line, ...(outcome.calm ? { calm: outcome.calm } : {}), at, ...(lateMs > 0 ? { lateMs } : {}), presses: outcome.presses });
      this.lastChimeAt.set(row.id, at);
      this.write(mut(base, { state: "fired", nextAt: next }), "engine", undefined, false);
    } else if (this.repeats(row) && !oneShotDone) {
      this.write(this.rearmed(base, next, at), "engine", undefined, false);
    } else {
      this.write(mut(base, { state: "done", nextAt: undefined }), "engine", undefined, false);
    }
    this.table.push(row.id, { kind: "fired", actions: outcome.actions, line: cut(outcome.line, EVENT_LINE_CHARS), ok: outcome.ok, ...(detail ? { detail: cut(detail, EVENT_DETAIL_CHARS) } : {}), ...(lateMs > 0 ? { lateMs } : {}), presses: outcome.presses });
    this.opts.onChange();
    this.drainFiles(row.id);
  }

  /** A repeater armed again after a fire: at `next` (clocks) or waiting for its signal (watchers); past `until` it is done. */
  private rearmed(base: Automation, next: number | undefined, now: number): Automation {
    if (base.when.kind === "on") return mut(base, { state: "armed", nextAt: undefined });
    if (next === undefined || (base.clauses.until !== undefined && next > base.clauses.until)) return mut(base, { state: "done", nextAt: undefined, lastDetail: base.lastDetail ?? "past its last day", updatedAt: now });
    return mut(base, { state: "armed", nextAt: next });
  }

  /**
   * A ring ends (Done, unanswered, a restart): one-shots are done, repeaters re-arm; the alarm's one self-snooze is per ring,
   * so it resets here. `keepDue` (a resync) re-arms a repeater at the occurrence it was waiting for even when that passed,
   * so the resync settles it: missed, with Run now.
   */
  private finishRing(a: Automation, now: number, detail: string | undefined, keepDue = false): void {
    this.rings.delete(a.id);
    this.lastChimeAt.delete(a.id);
    this.selfSnoozed.delete(a.id);
    const next = a.nextAt !== undefined && (keepDue || a.nextAt > now) ? a.nextAt : this.repeats(a) ? nextFire(a.when, now, a.createdAt) : undefined;
    const base: Automation = mut(a, { snoozedUntil: undefined, ...(detail ? { lastDetail: detail } : {}), updatedAt: now });
    if (this.repeats(a) && a.clauses.once !== true) this.write(this.rearmed(base, next, now), "engine", detail);
    else this.write(mut(base, { state: "done", nextAt: undefined }), "engine", detail);
  }

  // ---------------------------------------------------------------- resync

  /**
   * Missed fires: every waiting row whose `nextAt` passed. A one-shot (or the current
   * occurrence of an alarm) inside its kind's grace fires now, late; past the grace it is
   * `missed` — one row, `missed++`, ONE problem with `Run now` — and repeaters roll while
   * one-shots stay `failed`. Routines (grace 0) never fire late. Folder watchers take a
   * fresh baseline: what landed meanwhile is counted, never replayed.
   */
  resync(now: number, why: MissedWhy): void {
    // The zone first: a move the gap hid re-pins the rows, and what it put behind now is settled below with the rest.
    this.checkZone(now);
    // A ring left up across the gap (the lid closed on it) and older than its kind's grace and the linger ends unanswered.
    // A repeater re-arms at the occurrence it was waiting for, so the loop below settles what the gap passed.
    for (const a of this.table.inState("fired")) {
      if (this.firing.has(a.id) || now - (a.lastFiredAt ?? a.updatedAt) <= Math.max(graceFor(automationKind(a)), AUTOMATION_LINGER_MS)) continue;
      this.finishRing(a, now, `unanswered · ${whyWords(why, undefined)}`, true);
    }
    for (const a of this.table.due(now)) {
      if (a.nextAt === undefined || this.firing.has(a.id)) continue;
      this.settleDue(a, now, why);
    }
    const landed = this.watchers.rebaseline();
    for (const [id, n] of landed) {
      const a = this.table.get(id);
      if (!a) continue;
      const detail = `not watching ${this.span(why, now)} · ${n} new file${n === 1 ? "" : "s"} not handled`;
      this.write(mut(a, { missed: a.missed + n, lastDetail: detail, updatedAt: now }), "engine", detail, false);
    }
    this.sleptAt = undefined;
  }

  /**
   * One waiting row whose `nextAt` passed (the missed table): inside its kind's grace it fires
   * late (deferring again if quiet hours hold; a deferred row is due at its quiet end and
   * fires there); past the grace it is `missed` — routines and watchers skip to the next slot
   * with a row, one-shots and alarms get ONE problem with Run now, repeaters roll, one-shots
   * stay `failed`. A routine deferred by quiet hours is never run hours after its quiet end.
   */
  private settleDue(a: Automation, now: number, why: MissedWhy, words = whyWords(why, this.sleptAt, this.downSince)): void {
    if (a.nextAt === undefined) return;
    const dueAt = a.nextAt;
    const lateMs = now - dueAt;
    const kind = automationKind(a);
    if (lateMs <= graceFor(kind)) {
      this.fireOrDefer(a, now, dueAt, lateMs);
      return;
    }
    const routine = kind === "routine" || kind === "watcher";
    this.missedRow(a, dueAt, why, routine);
    if (routine) {
      const next = nextFire(a.when, now, a.createdAt);
      const detail = `skipped ${describeInstant(dueAt)} · ${words}`;
      if (next === undefined) this.write(mut(a, { state: "done", nextAt: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
      else this.write(mut(a, { state: "armed", nextAt: next, snoozedUntil: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
      return;
    }
    const detail = `missed ${describeInstant(dueAt).slice(0, 5)} · ${words}`;
    this.opts.problem("automation.missed", `missed ${a.name} ${describeInstant(dueAt).slice(0, 5)} · ${words}`, { label: "Run now", command: { type: "automation.run", id: a.id } });
    if (this.repeats(a)) {
      const next = nextFire(a.when, now, a.createdAt);
      this.write(mut(a, { state: next === undefined ? "done" : "armed", nextAt: next, snoozedUntil: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
    } else {
      this.write(mut(a, { state: "failed", nextAt: undefined, snoozedUntil: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
    }
  }

  /** "02:10–07:04" when the gap's start is known (the heartbeat, the app's mac.sleep), else "while Jarhead was off" / "while the Mac slept". */
  private span(why: MissedWhy, now: number): string {
    const from = why === "daemon-down" ? this.downSince : why === "mac-slept" ? this.sleptAt : undefined;
    return from !== undefined ? `${clockOf(from)}–${clockOf(now)}` : `while ${whyWords(why, undefined)}`;
  }

  private missedRow(a: Automation, dueAt: number, why: MissedWhy, skipped: boolean): void {
    const lateMs = Math.max(0, this.now() - dueAt);
    this.opts.ledger.append({ at: this.now(), type: "automation.missed", id: a.id, dueAt, ...(lateMs > 0 ? { lateMs } : {}), ...(skipped ? { skipped: true } : {}), why });
    this.table.push(a.id, { kind: "missed", dueAt, ...(lateMs > 0 ? { lateMs } : {}), ...(skipped ? { skipped: true } : {}), why });
  }

  // ------------------------------------------------------------------- arm

  /**
   * The brain tool's `automation_set` and the Console's / CLI's `automation.set`: the
   * name, the count and the echo checked; `classifyAutomation` judged here, once; `run`
   * arms; `confirm` is the one set-up question (given back to be asked; the re-call with
   * `confirmed` arms and records the words Kevin heard); `refuse` is the reason. A folder
   * watcher reads its folder now, so the TCC prompt shows while Kevin is here.
   */
  arm(draft: AutomationSetInput, by: ArmOrigin, confirmed = false, ctx: ArmContext = {}): AutomationSetOutcome {
    const now = this.now();
    const name = String(draft.name ?? "").replace(/\s+/g, " ").trim();
    if (!name) return { kind: "refused", reason: `an automation needs a name ${this.opts.userName?.() || "Kevin"} will hear` };
    if (name.length > AUTOMATION_NAME_CHARS) return { kind: "refused", reason: `the name "${cut(name, 30)}" is too long (${AUTOMATION_NAME_CHARS} characters at most)` };
    // Only a live row keeps its name: a done or failed one wearing it is renamed with its day when this one arms.
    const holder = this.nameHolder(name, draft.id);
    if (holder?.live) return { kind: "refused", reason: `an automation named "${name}" is already set; pick another name, or change that one` };
    const then = Array.isArray(draft.then) ? draft.then : [];
    if (then.length === 0 || then.length > AUTOMATION_ACTIONS_MAX) return { kind: "refused", reason: `an automation runs 1 to ${AUTOMATION_ACTIONS_MAX} actions` };
    // When it fires: a normalised `when`, or Kevin's phrase through core's parseWhen — the ONE grammar (the Console's form and the
    // CLI send the phrase; the brain's tool parsed it already). A phrase the grammar does not catch is refused in its own words.
    let when: AutomationWhen | undefined = draft.when && typeof draft.when === "object" ? draft.when : undefined;
    if (!when && typeof draft.whenPhrase === "string" && draft.whenPhrase.trim()) {
      const parsed = parseWhen(draft.whenPhrase, now);
      if ("error" in parsed) return { kind: "refused", reason: parsed.error };
      when = parsed;
    }
    if (!when) return { kind: "refused", reason: "say when it fires: a time, 'in 12 minutes', 'weekdays 09:00', or a signal" };
    // Quiet hours by the kind unless a clause says otherwise: an alarm rings through them; a timer, a reminder, a routine and a watcher respect them.
    const clauses = { ...(draft.clauses ?? {}), quiet: draft.clauses?.quiet ?? (automationKind({ when, then }) === "alarm" ? "override" : "respect") } as Automation["clauses"];
    const settings = this.opts.settings().automations;
    // The brain a wake-brain fire would run on: what `auto` resolved to when the engine says (brainKind), else Settings' brain.
    // The Console's form names the same one, so the cost line it shows is the one recorded as heard.
    const billed = this.opts.brainKind?.() ?? this.opts.settings().brain;
    const paid = brainPaid(billed, this.opts.settings().brainBaseUrl, (this.opts.brainKeys ?? secretsPresent)());
    // The runner's word on a local brain wins; then the server root (an openai-compatible loopback root is this Mac); then, with
    // no brainKind wired, the engine's own localBrain seam.
    const localBrain = ctx.localBrain ?? (paid === "mac" || (this.opts.brainKind === undefined && this.opts.localBrain()));
    const judged = classifyAutomation({
      when,
      then,
      clauses,
      settings,
      recipeCommand: draft.recipeCommand,
      confirmed: false,
      folderWatchers: this.table.folderWatchers(),
      fromThread: ctx.fromThread,
      localBrain,
      // A loopback root the runner says is not local is still nobody's bill: "the server you set".
      paid: paid === "mac" ? "server" : paid,
      request: ctx.request,
      home: this.home,
      repoRoot: this.opts.repoRoot,
    });
    if (judged.verdict === "refuse") {
      if (/not allowed while Jarhead is asleep/.test(judged.reason)) this.opts.problem("automation.blocked", judged.reason, { label: "Open Console", command: { type: "open-console" } });
      return { kind: "refused", reason: judged.reason };
    }
    if (judged.verdict === "confirm" && !confirmed) return { kind: "confirm", question: judged.reason };
    const id = draft.id && typeof draft.id === "string" && !this.table.get(draft.id) ? draft.id : newId("auto");
    const nextAt = nextFire(when, now, now);
    if (when.kind !== "on" && nextAt === undefined) return { kind: "refused", reason: `${describe(when)} is already past; say a time ahead` };
    const echo = cut(this.opts.redact(String(draft.echo ?? "").replace(/\s+/g, " ").trim() || `${describe(when)}: ${then.map((x) => x.kind).join(", ")}`), AUTOMATION_ECHO_CHARS);
    const a: Automation = {
      id,
      name,
      when,
      then,
      clauses,
      echo,
      state: "armed",
      ...(nextAt !== undefined ? { nextAt } : {}),
      fires: 0,
      missed: 0,
      createdAt: now,
      updatedAt: now,
      createdBy: { by, ...(ctx.chainId ? { chainId: ctx.chainId } : {}), ...(ctx.delegationId ? { delegationId: ctx.delegationId } : {}), request: cut(this.opts.redact(ctx.request ?? echo), 200) },
      ...(judged.verdict === "confirm" ? { confirmed: { at: now, heard: ctx.heard ?? judged.reason } } : {}),
    };
    // A recipe the brain handed in with the row is Kevin's once he said yes: the ENGINE writes it to settings (a tool never does).
    // It belongs to the run-recipe action, or to a recipe.red trigger naming a recipe not yet approved (the gate asked for both).
    const recipeAction = then.find((x) => x.kind === "run-recipe");
    const recipeName = recipeAction?.kind === "run-recipe" ? recipeAction.recipe : when.kind === "on" && when.on.kind === "recipe.red" ? when.on.recipe : undefined;
    if (draft.recipeCommand && recipeName) this.saveRecipe(recipeName, draft.recipeCommand, by === "brain" ? "brain" : "kevin", now);
    let watchNote = "";
    if (a.when.kind === "on") {
      const err = this.watchers.watch(a);
      if (err) {
        this.watchProblem(a, err);
        watchNote = `the folder could not be read yet (${err}); allow it in the Console`;
      }
    }
    if (holder) this.retire(holder.row, by, now);
    this.table.put(a);
    this.opts.ledger.append({ at: now, type: "automation.set", automation: a, by });
    this.table.push(a.id, { kind: "set", automation: a });
    if (a.when.kind === "in") this.caffeinate(a, now);
    this.opts.onChange();
    log.info(`armed ${a.name} (${a.id}): ${describe(a.when)} → ${then.map((x) => x.kind).join(", ")}${nextAt !== undefined ? ` · next ${describeInstant(nextAt)}` : ""}`);
    const notes = [a.clauses.quiet === "override" && inQuiet(settings.quietHours, nextAt ?? now) ? "it'll ring through quiet hours" : "", watchNote].filter(Boolean);
    const text = `armed: ${a.name} · ${describe(a.when)} · ${then.map((x) => x.kind).join(", ")}${nextAt !== undefined ? ` · next ${describeInstant(nextAt)}` : " · waiting for its signal"}${notes.map((n) => ` · ${n}`).join("")}`;
    return { kind: "armed", automation: a, text, ...(notes.length ? { note: notes.join(" · ") } : {}) };
  }

  private saveRecipe(name: string, command: string, by: "kevin" | "brain", now: number): void {
    const recipes = this.opts.settings().automations.recipes;
    // A name in use — live or in the Trash — is never overwritten; the gate refused a trashed name before this ran.
    if (!name || recipeNamed(recipes, name, "any")) return;
    const recipe: ShellRecipe = { name: cut(name, AUTOMATION_NAME_CHARS), command, timeoutSeconds: RECIPE_TIMEOUT_DEFAULT_S, approvedAt: now };
    this.opts.updateSettings({ automations: { ...this.opts.settings().automations, recipes: [...recipes, recipe] } });
    this.opts.ledger.append({ at: now, type: "recipe.set", recipe, by });
  }

  private watchProblem(a: Automation, err: string): void {
    const folder = a.when.kind === "on" && a.when.on.kind === "folder.file" ? expandPath(a.when.on.path, this.home) : `${this.home}/Downloads`;
    const which = /\/Downloads(\/|$)/.test(folder) ? "filesDownloads" : /\/Desktop(\/|$)/.test(folder) ? "filesDesktop" : /\/Documents(\/|$)/.test(folder) ? "filesDocuments" : "fullDiskAccess";
    this.opts.problem("automation.watch", `${a.name}: ${err}`, { label: "Ask", command: { type: "request-permission", which } });
  }

  /**
   * A running timer holds the Mac awake: `/usr/bin/caffeinate -t <seconds>` for the time left, at most CAFFEINATE_CHUNK_MS
   * at a time (renewHolds takes the next stretch), killed at Done / Snooze / Trash / the fire.
   */
  private caffeinate(a: Automation, now: number): void {
    if (a.when.kind !== "in" || a.nextAt === undefined) return;
    const ms = a.nextAt - now;
    if (ms <= 0) return;
    this.releaseHold(a.id);
    const chunk = Math.min(ms, CAFFEINATE_CHUNK_MS);
    const hold = this.exec.hold("/usr/bin/caffeinate", ["-t", String(Math.ceil(chunk / 1000))]);
    if (hold) this.holds.set(a.id, { hold, until: now + chunk });
  }

  /** A hold about to run out on a timer still running (or snoozed) is taken again for the next stretch. */
  private renewHolds(now: number): void {
    const due = [...this.holds].filter(([, h]) => h.until - now <= CAFFEINATE_RENEW_MS).map(([id, h]) => [id, h.until] as const);
    for (const [id, until] of due) {
      const a = this.table.get(id);
      if (a && (a.state === "armed" || a.state === "snoozed") && a.nextAt !== undefined && a.nextAt > until) this.caffeinate(a, now);
    }
  }

  private releaseHold(id: string): void {
    const h = this.holds.get(id);
    if (!h) return;
    this.holds.delete(id);
    try {
      h.hold.kill();
    } catch {
      // gone
    }
  }

  /** The row that keeps `name` from another one (not `exceptId`): a live one refuses it; a done or failed one gives it up. */
  private nameHolder(name: string, exceptId?: string): { readonly live: boolean; readonly row: Automation } | undefined {
    const row = this.table.named(name);
    if (!row || row.id === exceptId) return undefined;
    return { live: !RETIRABLE.has(row.state), row };
  }

  /** A done or failed row gives its name up: it wears its day ("pasta · 5 Oct"), with a number when that is taken too; one automation.set row. */
  private retire(a: Automation, by: ArmOrigin, now: number): void {
    const day = describeInstant(a.lastFiredAt ?? a.updatedAt).split(" ").slice(-2).join(" ");
    let name = a.name;
    for (let n = 1; n < 1000; n++) {
      const tail = ` · ${day}${n > 1 ? ` ${n}` : ""}`;
      name = `${cut(a.name, AUTOMATION_NAME_CHARS - tail.length)}${tail}`;
      if (!this.table.nameTaken(name, a.id)) break;
    }
    const row = this.table.put(mut(a, { name, updatedAt: now }));
    this.opts.ledger.append({ at: now, type: "automation.set", automation: row, by });
    this.table.push(row.id, { kind: "set", automation: row });
  }

  // ----------------------------------------------------------------- verbs

  /** The brain's `automation_change`: one verb on one row by name or id; the row as it stands afterwards, with the engine's own words as `detail`. */
  async change(nameOrId: string, verb: ChangeVerb, minutes?: number): Promise<AutomationChangeResult> {
    const before = this.table.find(nameOrId);
    const r = verb === "run" ? await this.runNow(nameOrId, "brain") : this.changeNow(nameOrId, verb, minutes, "brain");
    const after = before ? this.table.get(before.id) : undefined;
    if (!r.ok || !after) return { ok: false, reason: r.text };
    return { ok: true, automation: after, detail: r.text };
  }

  /** The synchronous verbs (everything but `run`); `by` is the surface that sent it (a name a restore takes back is recorded under it). */
  changeNow(nameOrId: string, verb: Exclude<ChangeVerb, "run">, minutes?: number, by: ArmOrigin = "console"): { readonly ok: boolean; readonly text: string } {
    const a = this.table.find(nameOrId);
    if (!a) return { ok: false, text: `no automation named "${nameOrId}"` };
    const now = this.now();
    switch (verb) {
      case "snooze": {
        if (a.state === "trashed" || a.state === "done") return { ok: false, text: `${a.name} is ${a.state}; nothing to snooze` };
        const m = Math.min(720, Math.max(1, Math.round(Number(minutes) || snoozeDefault(automationKind(a), this.opts.settings().automations.snoozeMinutes))));
        this.snooze(a, m, "kevin", now);
        return { ok: true, text: `${a.name} snoozed ${m} min · ${describeInstant(now + m * 60_000)}` };
      }
      case "done": {
        if (a.state === "trashed") return { ok: false, text: `${a.name} is in the Trash` };
        this.releaseHold(a.id);
        this.done(a, now, "kevin");
        const after = this.table.get(a.id);
        return { ok: true, text: after?.state === "armed" && after.nextAt !== undefined ? `${a.name} done · next ${describeInstant(after.nextAt)}` : `${a.name} done` };
      }
      case "skip": {
        if (a.state === "trashed" || a.state === "done") return { ok: false, text: `${a.name} is ${a.state}` };
        this.releaseHold(a.id);
        this.rings.delete(a.id);
        if (this.repeats(a) && a.when.kind !== "on") {
          const from = a.state === "fired" || a.nextAt === undefined ? now : a.nextAt;
          const next = nextFire(a.when, Math.max(from, now), a.createdAt);
          const detail = `skipped ${describeInstant(from)}`;
          if (next === undefined) this.write(mut(a, { state: "done", nextAt: undefined, snoozedUntil: undefined, lastDetail: detail, updatedAt: now }), "kevin", detail);
          else this.write(mut(a, { state: "armed", nextAt: next, snoozedUntil: undefined, lastDetail: detail, updatedAt: now }), "kevin", detail);
          const after = this.table.get(a.id);
          return { ok: true, text: after?.nextAt !== undefined ? `${a.name}: skipped · next ${describeInstant(after.nextAt)}` : `${a.name}: skipped; nothing after` };
        }
        if (a.when.kind === "on") return { ok: false, text: `${a.name} waits for a signal; pause it instead` };
        this.write(mut(a, { state: "done", nextAt: undefined, snoozedUntil: undefined, lastDetail: "skipped", updatedAt: now }), "kevin", "skipped");
        return { ok: true, text: `${a.name} skipped` };
      }
      case "pause": {
        if (a.state === "trashed" || a.state === "done") return { ok: false, text: `${a.name} is ${a.state}` };
        if (a.state === "paused") return { ok: true, text: `${a.name} is already paused` };
        this.releaseHold(a.id);
        this.rings.delete(a.id);
        this.watchers.unwatch(a.id);
        this.fileQueue.delete(a.id);
        this.write(mut(a, { state: "paused", snoozedUntil: undefined, updatedAt: now }), "kevin");
        return { ok: true, text: `${a.name} paused` };
      }
      case "resume": {
        if (a.state !== "paused") return { ok: false, text: `${a.name} is not paused (${a.state})` };
        return this.rearm(a, now, "kevin", "resumed");
      }
      case "trash": {
        if (a.state === "trashed") return { ok: true, text: `${a.name} is already in the Trash` };
        this.releaseHold(a.id);
        this.rings.delete(a.id);
        this.watchers.unwatch(a.id);
        this.fileQueue.delete(a.id);
        this.write(mut(a, { state: "trashed", nextAt: undefined, snoozedUntil: undefined, updatedAt: now }), "kevin");
        return { ok: true, text: `${a.name} moved to the Trash · Restore brings it back` };
      }
      case "restore": {
        if (a.state !== "trashed") return { ok: false, text: `${a.name} is not in the Trash` };
        const holder = this.nameHolder(a.name, a.id);
        if (holder?.live) return { ok: false, text: `another automation is named "${a.name}" now; rename that one first` };
        if (holder) this.retire(holder.row, by, now);
        return this.rearm(a, now, "kevin", "restored");
      }
      default:
        return { ok: false, text: `unknown verb "${String(verb)}"` };
    }
  }

  /** `resume` / `restore`: armed again with a fresh `nextAt` (a one-shot whose time passed is done). */
  private rearm(a: Automation, now: number, by: "kevin" | "brain" | "engine", detail: string): { readonly ok: boolean; readonly text: string } {
    if (a.when.kind === "on") {
      const err = this.watchers.watch(a);
      if (err) this.watchProblem(a, err);
      this.write(mut(a, { state: "armed", nextAt: undefined, snoozedUntil: undefined, lastDetail: detail, updatedAt: now }), by, detail);
      return { ok: true, text: `${a.name} ${detail} · watching` };
    }
    const next = nextFire(a.when, now, a.createdAt);
    if (next === undefined) {
      this.write(mut(a, { state: "done", nextAt: undefined, snoozedUntil: undefined, lastDetail: `${detail}; its time had passed`, updatedAt: now }), by, `${detail}; its time had passed`);
      return { ok: true, text: `${a.name} ${detail}, but its time had passed; set a new one` };
    }
    const row = this.write(mut(a, { state: "armed", nextAt: next, snoozedUntil: undefined, lastDetail: detail, updatedAt: now }), by, detail);
    this.caffeinate(row, now);
    return { ok: true, text: `${a.name} ${detail} · next ${describeInstant(next)}` };
  }

  private snooze(a: Automation, minutes: number, by: "kevin" | "brain" | "engine", now: number, detail?: string): void {
    this.releaseHold(a.id);
    this.rings.delete(a.id);
    this.lastChimeAt.delete(a.id);
    // Kevin's own Snooze answers the ring: the engine's one self-snooze is available again for this occurrence's re-ring.
    if (by !== "engine") this.selfSnoozed.delete(a.id);
    const until = now + minutes * 60_000;
    const row = this.write(mut(a, { state: "snoozed", snoozedUntil: until, nextAt: until, ...(detail ? { lastDetail: detail } : {}), updatedAt: now }), by, detail, true, until);
    if (row.when.kind === "in") this.caffeinate(mut(row, { nextAt: until }), now);
  }

  private done(a: Automation, now: number, by: "kevin" | "brain" | "engine"): void {
    if (a.state === "fired" || a.state === "snoozed" || a.state === "failed" || a.state === "deferred") {
      this.finishRing(a, now, undefined);
      return;
    }
    if (a.state === "armed" && !this.repeats(a)) {
      this.write(mut(a, { state: "done", nextAt: undefined, snoozedUntil: undefined, lastDetail: "done before it fired", updatedAt: now }), by, "done before it fired");
      return;
    }
    // An armed repeater: Done means "this one"; the next occurrence stands.
    this.selfSnoozed.delete(a.id);
  }

  /**
   * Fire a row now — Kevin's press on `Run now` or the brain's `run` verb. Refused unless
   * Kevin is here (a session is open, or he spoke or moved recently): a fire is a thing
   * he hears. Never a question either way.
   */
  async runNow(nameOrId: string, by: "kevin" | "brain"): Promise<{ readonly ok: boolean; readonly text: string }> {
    const a = this.table.find(nameOrId);
    if (!a) return { ok: false, text: `no automation named "${nameOrId}"` };
    if (a.state === "trashed") return { ok: false, text: `${a.name} is in the Trash; restore it first` };
    if (!(await this.opts.present().catch(() => false))) return { ok: false, text: `Run now needs you at the Mac: wake me, or press it in the Console while you are here` };
    if (this.firing.has(a.id)) return { ok: false, text: `${a.name} is running now` };
    const now = this.now();
    this.opts.clearProblems?.("automation.missed", (text) => text.includes(a.name));
    this.rings.delete(a.id);
    await this.fire(a, now, 0, { dueAt: now, quiet: false });
    void by;
    const after = this.table.get(a.id);
    return { ok: after?.state !== "failed", text: `${a.name}: ${after?.lastDetail ?? (after?.state === "fired" ? "rang" : "ran")}` };
  }

  /** `automation.rename`: ≤ 24 chars, unique among the non-trashed rows; `by` is the surface that sent it (the ledger's `automation.set` row wears it). */
  rename(id: string, name: string, by: Exclude<ArmOrigin, "brain"> = "console"): { readonly ok: boolean; readonly text: string } {
    const a = this.table.get(id);
    if (!a) return { ok: false, text: `no automation ${id}` };
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean) return { ok: false, text: "a name is needed" };
    if (clean.length > AUTOMATION_NAME_CHARS) return { ok: false, text: `"${cut(clean, 30)}" is too long (${AUTOMATION_NAME_CHARS} at most)` };
    const holder = this.nameHolder(clean, a.id);
    if (holder?.live) return { ok: false, text: `another automation is named "${clean}"` };
    if (holder) this.retire(holder.row, by, this.now());
    const row = this.table.put(mut(a, { name: clean, updatedAt: this.now() }));
    this.opts.ledger.append({ at: this.now(), type: "automation.set", automation: row, by });
    this.table.push(row.id, { kind: "set", automation: row });
    this.opts.onChange();
    return { ok: true, text: `renamed to ${clean}` };
  }

  // -------------------------------------------------------------- commands

  /** The thirteen surface commands. Never a deletion: `trash` is Move to Trash (rows and recipes alike), `restore` brings it back. */
  async command(cmd: EngineCommand, toast: (text: string, tone?: "info" | "warn") => void): Promise<void> {
    switch (cmd.type) {
      case "automation.set": {
        // The Console's form: the press on Add is Kevin's own hand on a control that says what it does — the two-press
        // idiom's second press — so a confirm-tier row arms with the question as what he heard. The CLI (or any process on
        // the socket saying `by: "cli"`) is never a yes: its free kinds arm at once and a confirm-tier row is refused, not asked.
        const by: ArmOrigin = cmd.by === "cli" ? "cli" : "console";
        const r = this.arm(cmd.automation as AutomationSetInput, by, by === "console", {});
        if (r.kind === "confirm") return toast(by === "cli" ? `not armed: ${r.question} — that needs a yes, and the CLI hears none; set it up by voice or in the Console` : `needs a yes: ${r.question}`, "warn");
        toast(r.kind === "armed" ? r.text : `not armed: ${r.reason}`, r.kind === "armed" ? "info" : "warn");
        return;
      }
      case "automation.snooze":
        return toast(...this.said(this.changeNow(cmd.id, "snooze", cmd.minutes)));
      case "automation.done":
        return toast(...this.said(this.changeNow(cmd.id, "done")));
      case "automation.skip":
        return toast(...this.said(this.changeNow(cmd.id, "skip")));
      case "automation.pause":
        return toast(...this.said(this.changeNow(cmd.id, "pause")));
      case "automation.resume":
        return toast(...this.said(this.changeNow(cmd.id, "resume")));
      case "automation.rename":
        return toast(...this.said(this.rename(cmd.id, String(cmd.name ?? ""), cmd.by === "cli" ? "cli" : "console")));
      case "automation.trash":
        return toast(...this.said(this.changeNow(cmd.id, "trash")));
      case "automation.restore":
        return toast(...this.said(this.changeNow(cmd.id, "restore")));
      case "automation.run":
        return toast(...this.said(await this.runNow(cmd.id, "kevin")));
      case "recipe.set": {
        const recipe = cmd.recipe;
        const name = String(recipe?.name ?? "").trim();
        if (!name || !String(recipe?.command ?? "").trim()) return toast("a recipe needs a name and a command", "warn");
        const now = this.now();
        const clean: ShellRecipe = { name: cut(name, AUTOMATION_NAME_CHARS), command: String(recipe.command), ...(recipe.cwd ? { cwd: recipe.cwd } : {}), timeoutSeconds: Math.min(600, Math.max(1, Math.round(Number(recipe.timeoutSeconds) || RECIPE_TIMEOUT_DEFAULT_S))), approvedAt: now };
        const all = this.opts.settings().automations.recipes;
        const trashed = recipeNamed(all, clean.name, "any");
        if (trashed?.trashedAt !== undefined) return toast(`recipe ${trashed.name} is in the Trash; restore it, or pick another name`, "warn");
        const rest = all.filter((r) => r.name.toLowerCase() !== clean.name.toLowerCase());
        this.opts.updateSettings({ automations: { ...this.opts.settings().automations, recipes: [...rest, clean] } });
        this.opts.ledger.append({ at: now, type: "recipe.set", recipe: clean, by: "kevin" });
        return toast(`recipe ${clean.name} saved`);
      }
      case "recipe.trash": {
        // Move to Trash: the recipe stays in Settings with `trashedAt` — hidden from pickers, refused as a target, restorable. Nothing is deleted.
        const name = String(cmd.name ?? "").trim();
        const all = this.opts.settings().automations.recipes;
        const found = recipeNamed(all, name, "any");
        if (!found) return toast(`no recipe named "${name}"`, "warn");
        if (found.trashedAt !== undefined) return toast(`recipe ${found.name} is already in the Trash`);
        const now = this.now();
        this.opts.updateSettings({ automations: { ...this.opts.settings().automations, recipes: all.map((r) => (r === found ? { ...r, trashedAt: now } : r)) } });
        this.opts.ledger.append({ at: now, type: "recipe.trashed", name: found.name });
        return toast(`recipe ${found.name} moved to the Trash · Restore brings it back`);
      }
      case "recipe.restore": {
        const name = String(cmd.name ?? "").trim();
        const all = this.opts.settings().automations.recipes;
        const found = recipeNamed(all, name, "any");
        if (!found) return toast(`no recipe named "${name}"`, "warn");
        if (found.trashedAt === undefined) return toast(`recipe ${found.name} is not in the Trash`);
        const now = this.now();
        this.opts.updateSettings({ automations: { ...this.opts.settings().automations, recipes: all.map((r) => (r === found ? mutRecipe(r) : r)) } });
        this.opts.ledger.append({ at: now, type: "recipe.restored", name: found.name });
        return toast(`recipe ${found.name} restored`);
      }
      default:
        return;
    }
  }

  private said(r: { readonly ok: boolean; readonly text: string }): [string, "info" | "warn"] {
    return [r.text, r.ok ? "info" : "warn"];
  }

  // ------------------------------------------------------------- the source

  /**
   * The brain's `automation_set` (packages/brain's `AutomationSource`): the runner's context
   * becomes the arm's origin, its confirmation and the words Kevin heard; the engine's outcome
   * comes back in the shape the runner renders (`armed` with its note, `confirm` with the one
   * question as the reason, `refused`).
   */
  async set(draft: AutomationDraft, ctx: AutomationSetContext): Promise<AutomationSetResult> {
    const r = this.arm({ ...draft, ...(ctx.recipeCommand ? { recipeCommand: ctx.recipeCommand } : {}) }, ctx.by, ctx.confirmed, {
      request: ctx.request,
      delegationId: ctx.delegationId,
      fromThread: ctx.fromThread,
      heard: ctx.heard,
      localBrain: ctx.localBrain,
    });
    switch (r.kind) {
      case "armed":
        return { kind: "armed", automation: r.automation, ...(r.note ? { note: r.note } : {}) };
      case "confirm":
        return { kind: "confirm", reason: r.question };
      default:
        return { kind: "refused", reason: r.reason };
    }
  }

  /** `automation_list`: every non-trashed row in the snapshot's order — the truth about what is set, never from memory. */
  async list(): Promise<readonly Automation[]> {
    return this.table.rows();
  }

  /** `recipe_list`: the approved recipes, what uses them, and `asks` when the gate now rates one confirm. */
  async recipes(): Promise<readonly RecipeRow[]> {
    return this.recipeRows();
  }

  /** Settings' live recipes (never the Trash's) with the shell gate's present verdict and the rows that name each; the snapshot's `recipesAsking` reads the same list. */
  recipeRows(): readonly RecipeRow[] {
    const rows = this.table.inState("all");
    return liveRecipes(this.opts.settings().automations.recipes).map((r) => {
      const name = r.name.toLowerCase();
      const usedBy = rows.filter((a) => a.then.some((x) => x.kind === "run-recipe" && x.recipe.toLowerCase() === name) || (a.when.kind === "on" && a.when.on.kind === "recipe.red" && a.when.on.recipe.toLowerCase() === name)).map((a) => a.name);
      const d = classifyAction({ kind: "run_shell", text: r.command, confirmed: false, home: this.home, userName: this.opts.userName?.(), ...(r.cwd ? { cwd: expandPath(r.cwd, this.home) } : {}), ...(this.opts.repoRoot ? { repoRoot: this.opts.repoRoot } : {}) });
      return { recipe: r, asks: d.verdict !== "run", usedBy };
    });
  }

  // -------------------------------------------------------------- snapshot

  /** The snapshot's automation fields: the live rows then the Trash's newest, the ring, the next fire, the recipes the gate would now question. */
  snapshot(): Pick<Snapshot, "automations" | "ringing" | "nextFire" | "recipesAsking"> {
    const ringing = this.table.ringing(this.rings);
    const next = this.table.nextFire();
    const recipesAsking = this.recipeRows().filter((r) => r.asks).map((r) => r.recipe.name);
    return { automations: [...this.table.rows(), ...this.table.trashed()], ...(ringing ? { ringing } : {}), ...(next ? { nextFire: next } : {}), recipesAsking };
  }

  /** Clients looking at the island / Console right now: running timers tick only while > 0. */
  setViewers(n: number): void {
    this.viewers = Math.max(0, Math.round(n) || 0);
  }

  /** The seconds `wake-brain` spent today (tests, the card's cost row). */
  get brainSecondsToday(): number {
    return this.brainSpent;
  }

  dispose(): void {
    for (const id of [...this.holds.keys()]) this.releaseHold(id);
    this.table.dispose();
  }

  // ----------------------------------------------------------------- inner

  /**
   * One row change: the table and the journal, one `automation.state` ledger row when
   * the state moved (`by`, `until`, `detail`), one `state` event (coalesced), and the
   * snapshot. `event: false` skips the state event (a fire writes its own `fired`).
   */
  private write(a: Automation, by: "kevin" | "brain" | "engine", detail?: string, event = true, until?: number): Automation {
    const before = this.table.get(a.id);
    const row = this.table.put(a);
    if (before?.state !== row.state) {
      this.opts.ledger.append({ at: row.updatedAt, type: "automation.state", id: row.id, state: row.state, by, ...(until !== undefined ? { until } : {}), ...(detail ? { detail: cut(detail, DETAIL_CHARS) } : {}) });
      if (event) this.table.push(row.id, { kind: "state", state: row.state, ...(row.nextAt !== undefined ? { nextAt: row.nextAt } : {}), ...(detail ? { detail: cut(detail, EVENT_DETAIL_CHARS) } : {}) });
      if (row.state !== "fired") this.rings.delete(row.id);
      this.opts.onChange();
    } else if (event && detail) {
      this.table.push(row.id, { kind: "state", state: row.state, ...(row.nextAt !== undefined ? { nextAt: row.nextAt } : {}), detail: cut(detail, EVENT_DETAIL_CHARS) });
    }
    return row;
  }
}

/** A recipe out of the Trash: the same row with `trashedAt` gone (the contract's optionals are absent, never undefined). */
function mutRecipe(r: ShellRecipe): ShellRecipe {
  const { trashedAt: _gone, ...rest } = r;
  return rest;
}

/**
 * A client's `set-settings { automations }` block, with the Trash kept: the Console re-encodes the whole
 * block from its own ShellRecipe (an older app, or one from before `trashedAt`), so a recipe that arrives
 * under a trashed name without `trashedAt` keeps the stored one, and a block with no `recipes` array keeps
 * the stored recipes. Only `recipe.restore` brings a recipe back — never a chip toggle. Pure.
 */
export function keepRecipeTrash(stored: AutomationSettings, incoming: AutomationSettings): AutomationSettings {
  const kept = Array.isArray(incoming.recipes) ? incoming.recipes : stored.recipes;
  const recipes = kept.map((r) => {
    if (r.trashedAt !== undefined) return r;
    const was = recipeNamed(stored.recipes, r.name, "any");
    return was?.trashedAt !== undefined ? { ...r, trashedAt: was.trashedAt } : r;
  });
  return { ...incoming, recipes };
}

/** A row that watches a folder (folder.file / download.done). */
function isFolderRow(a: Automation): boolean {
  return a.when.kind === "on" && (a.when.on.kind === "folder.file" || a.when.on.kind === "download.done");
}

function whyWords(why: MissedWhy, sleptAt: number | undefined, downSince?: number): string {
  switch (why) {
    case "mac-slept":
      return sleptAt !== undefined ? `the Mac slept from ${describeInstant(sleptAt).slice(0, 5)}` : "the Mac slept";
    case "daemon-down":
      return downSince !== undefined ? `Jarhead was off from ${clockOf(downSince)}` : "Jarhead was off";
    case "quiet-hours":
      return "quiet hours";
    case "budget":
      return "the brain budget was spent";
    default:
      return why;
  }
}
