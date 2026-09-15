import { homedir } from "node:os";
import { classifyAction, classifyAutomation, describe, describeInstant, expandPath, graceFor, inQuiet, inWindow, logger, newId, nextFire, quietEnds, snoozeDefault, Ledger, type ActionContext, type Decision } from "@jarhead/core";
import { runShell, type AutomationChangeResult, type AutomationSetContext, type AutomationSetResult, type AutomationSource, type AutomationVerb, type RecipeRow } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import {
  AUTOMATION_ACTIONS_MAX,
  AUTOMATION_LINGER_MS,
  AUTOMATION_REPEAT_CHIME_MS,
  AUTOMATION_SLEEP_GAP_MS,
  AUTOMATION_WATCH_COOLDOWN_S,
  automationKind,
  type Automation,
  type AutomationClauses,
  type AutomationDraft,
  type AutomationKind,
  type AutomationState,
  type EngineCommand,
  type EngineEvent,
  type MissedWhy,
  type ProblemKind,
  type ProblemRemedy,
  type RingLine,
  type Settings,
  type SettingsPatch,
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
export { Watchers, FOLDER_POLL_MS, APP_POLL_MS, globToRegExp } from "./watchers.ts";

/**
 * The Automations façade the engine constructs beside the ThreadScheduler: arming (the
 * set-up gate, judged once, awake), the clock (`tick(now)` from the engine's 1 s tick —
 * sleep detection by the tick gap, the due loop, the rings, the watchers, the timer
 * ticks, the day's brain spend), the signals the app forwards, the twelve commands, the
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
/** A timer this long or shorter holds the Mac awake with `caffeinate -t`. */
export const CAFFEINATE_MAX_MS = 60 * 60_000;
/** What a `firing` row left by a dead daemon says. */
export const RESTART_DETAIL = "the daemon restarted";
/** A recipe the brain hands in with a row is saved with this cap. */
const RECIPE_TIMEOUT_DEFAULT_S = 120;

/** The brain's `automation_change` verbs, one word each (packages/brain declares them; the surfaces send the same set). */
export type ChangeVerb = AutomationVerb;
export const CHANGE_VERBS: ReadonlySet<string> = new Set<ChangeVerb>(["snooze", "done", "skip", "pause", "resume", "trash", "restore", "run"]);

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
  /** The reading helper (the app fallback poll). */
  readonly reader: NativeHands;
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
  /** The snapshot goes out (the LIST or a row changed). */
  readonly onChange: () => void;
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
  /** The app said the Mac is going to sleep: evidence for the missed row's detail. */
  private sleptAt: number | undefined;
  /** Alarms that self-snoozed once while unanswered. */
  private readonly selfSnoozed = new Set<string>();
  /** The ring line per `fired` row (the island's), without `more`. */
  private readonly rings = new Map<string, Omit<RingLine, "more">>();
  private readonly lastChimeAt = new Map<string, number>();
  /** `caffeinate` holds per running timer. */
  private readonly holds = new Map<string, Hold>();
  /** Signals inside a row's cooldown since its last fire. */
  private readonly cooled = new Map<string, number>();
  /** Rows whose fire is in flight (a signal storm queues nothing behind it). */
  private readonly firing = new Set<string>();
  private viewers = 0;
  /** Brain seconds `wake-brain` spent today and the day it was summed for. */
  private brainSpent = 0;
  private spendDay = "";
  private loaded = false;

  constructor(private readonly opts: AutomationsOptions) {
    this.now = opts.now;
    this.home = opts.home ?? homedir();
    this.exec = opts.exec ?? defaultAutomationExec;
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
      brainSpentToday: () => this.brainSpent,
    });
    this.watchers = new Watchers({ now: this.now, reader: opts.reader, shell, shellGate, settings: opts.settings, home: this.home, repoRoot: opts.repoRoot });
  }

  // ------------------------------------------------------------------ load

  /**
   * At `Engine.start()`, after `restoreFromLedger`: the journal, last-by-id; a row left
   * `firing` by a dead daemon → `failed: "the daemon restarted"`; repeaters without a
   * `nextAt` get one; watchers are watched again (their listings the new baseline); the
   * day's brain spend is re-summed from the ledger; then `resync(now, "daemon-down")`.
   * A second load over the same journal appends nothing new for a clean table.
   */
  load(now = this.now()): void {
    const rows = this.table.load();
    this.rings.clear();
    this.holds.clear();
    for (const a of rows) {
      if (a.state === "firing") {
        this.write(mut(a, { state: this.repeats(a) ? "armed" : "failed", nextAt: this.repeats(a) ? nextFire(a.when, now, a.createdAt) : undefined, lastDetail: RESTART_DETAIL, updatedAt: now }), "engine", RESTART_DETAIL);
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
        const err = this.watchers.watch(a);
        if (err) this.watchProblem(a, err);
      }
      if (a.state === "armed" && a.when.kind === "in" && a.nextAt !== undefined) this.caffeinate(a, now);
    }
    this.sumSpend(now);
    this.loaded = true;
    this.lastTickAt = 0;
    this.resync(now, "daemon-down");
    this.opts.onChange();
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
    if (this.lastTickAt !== 0 && now - this.lastTickAt > AUTOMATION_SLEEP_GAP_MS) this.resync(now, "mac-slept");
    this.lastTickAt = now;
    if (!this.opts.settings().automations.enabled) return;
    this.fireDue(now);
    this.ringTick(now);
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
      const quiet = this.opts.settings().automations.quietHours;
      if (a.clauses.quiet === "respect" && inQuiet(quiet, now) && a.state !== "deferred") {
        if (a.then.some((x) => x.kind !== "chime" && x.kind !== "say" && x.kind !== "notify")) {
          this.defer(a, now, dueAt);
          continue;
        }
        void this.fire(a, now, Math.max(0, now - dueAt), { dueAt, quiet: true });
        continue;
      }
      void this.fire(a, now, Math.max(0, now - dueAt), { dueAt, quiet: false });
    }
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
    const rows = this.armedWatchers();
    if (rows.length === 0) return;
    try {
      for (const f of await this.watchers.poll(now, rows)) this.watcherFire(f.id, now, f.file, f.what);
    } catch (e) {
      log.warn(`watchers: ${(e as Error).message}`);
    }
  }

  private armedWatchers(): Automation[] {
    return this.table.inState("armed").filter((a) => a.when.kind === "on");
  }

  // ---------------------------------------------------------------- signals

  /** A signal the app observed on Kevin's behalf — data, never a command. `mac.sleep` is evidence; `mac.wake` / `clock.changed` resync. */
  signal(sig: SystemSignal, at = this.now()): void {
    if (sig.kind === "mac.sleep") {
      this.sleptAt = at;
      return;
    }
    if (sig.kind === "mac.wake" || sig.kind === "clock.changed") this.resync(this.now(), "mac-slept");
    if (sig.kind === "screen.lock") return;
    if (!this.opts.settings().automations.enabled) return;
    for (const f of this.watchers.signal(sig, this.armedWatchers())) this.watcherFire(f.id, this.now(), undefined, f.what);
  }

  /** The agents registry refreshed (the engine's `agents.onChange`). */
  agents(list: readonly AgentInfo[]): void {
    const fires = this.watchers.agents(list, this.loaded ? this.armedWatchers() : []);
    if (!this.opts.settings().automations.enabled) return;
    for (const f of fires) this.watcherFire(f.id, this.now(), undefined, f.what);
  }

  /** A watcher saw its signal: the clauses (days / window / once / cooldown) admit or count it, then it fires. */
  private watcherFire(id: string, now: number, file: string | undefined, what: string | undefined): void {
    const a = this.table.get(id);
    // Armed rows fire; a row whose fire is in flight counts the signal (a storm is one fire and a number).
    if (!a || (a.state !== "armed" && a.state !== "firing")) return;
    if (!inWindow(a.clauses, now)) return;
    if (a.clauses.once === "day" && a.lastFiredAt !== undefined && Ledger.dayFor(a.lastFiredAt) === Ledger.dayFor(now)) return;
    const cooldownMs = (a.clauses.cooldown ?? AUTOMATION_WATCH_COOLDOWN_S) * 1000;
    if (this.firing.has(a.id) || (a.lastFiredAt !== undefined && now - a.lastFiredAt < cooldownMs)) {
      const n = (this.cooled.get(a.id) ?? 0) + 1;
      this.cooled.set(a.id, n);
      const base = (a.lastDetail ?? "").replace(/ · \+\d+ in cooldown$/, "");
      this.write(mut(a, { lastDetail: cut(`${base}${base ? " · " : ""}+${n} in cooldown`, DETAIL_CHARS), updatedAt: now }), "engine", undefined, false);
      return;
    }
    this.cooled.delete(a.id);
    const quiet = a.clauses.quiet === "respect" && inQuiet(this.opts.settings().automations.quietHours, now);
    if (quiet && a.then.some((x) => x.kind !== "chime" && x.kind !== "say" && x.kind !== "notify")) {
      this.missedRow(a, now, "quiet-hours", true);
      this.write(mut(a, { missed: a.missed + 1, lastDetail: "quiet hours: not run", updatedAt: now }), "engine", "quiet hours: not run");
      return;
    }
    void this.fire(a, now, 0, { dueAt: now, quiet, file, what });
  }

  // ------------------------------------------------------------------ fire

  /**
   * One fire: `firing` → the executor → the row's next state: a ring waits for Done; an
   * acting-only repeater re-arms; a one-shot is done; a failure leaves a one-shot `failed`
   * and re-arms a repeater with the reason. Every fire is an `automation.fired` row and
   * one `fired` event with its presses.
   */
  private async fire(row: Automation, now: number, lateMs: number, o: { readonly dueAt: number; readonly quiet: boolean; readonly file?: string | undefined; readonly what?: string | undefined }): Promise<void> {
    if (this.firing.has(row.id)) return;
    this.firing.add(row.id);
    this.releaseHold(row.id);
    const next = this.repeats(row) && row.when.kind !== "on" ? nextFire(row.when, Math.max(o.dueAt, now), row.createdAt) : undefined;
    const started = this.write(mut(row, { state: "firing", updatedAt: now }), "engine", undefined, false);
    let outcome: FireOutcome;
    try {
      outcome = await this.executor.fire({ a: started, now, lateMs, file: o.file, quiet: o.quiet, dueAt: o.dueAt }, next);
    } catch (e) {
      outcome = { ok: false, actions: row.then.map((x) => x.kind), line: this.executor.line(row, o.dueAt), detail: `failed: ${(e as Error).message}`, presses: [], ring: false, ms: 0 };
    } finally {
      this.firing.delete(row.id);
    }
    const at = this.now();
    const current = this.table.get(row.id) ?? started;
    if (current.state === "trashed" || current.state === "paused") return; // Kevin moved it while it ran; the fire's record stands, the state is his.
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
    if (!outcome.ok) {
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
  }

  /** A repeater armed again after a fire: at `next` (clocks) or waiting for its signal (watchers); past `until` it is done. */
  private rearmed(base: Automation, next: number | undefined, now: number): Automation {
    if (base.when.kind === "on") return mut(base, { state: "armed", nextAt: undefined });
    if (next === undefined || (base.clauses.until !== undefined && next > base.clauses.until)) return mut(base, { state: "done", nextAt: undefined, lastDetail: base.lastDetail ?? "past its last day", updatedAt: now });
    return mut(base, { state: "armed", nextAt: next });
  }

  /** A ring ends (Done, unanswered, a restart): one-shots are done, repeaters re-arm. */
  private finishRing(a: Automation, now: number, detail: string | undefined): void {
    this.rings.delete(a.id);
    this.lastChimeAt.delete(a.id);
    const next = a.nextAt !== undefined && a.nextAt > now ? a.nextAt : this.repeats(a) ? nextFire(a.when, now, a.createdAt) : undefined;
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
    for (const a of this.table.due(now)) {
      if (a.nextAt === undefined || this.firing.has(a.id)) continue;
      const dueAt = a.nextAt;
      const lateMs = now - dueAt;
      const kind = automationKind(a);
      if (a.state === "deferred") {
        void this.fire(a, now, lateMs, { dueAt, quiet: false });
        continue;
      }
      if (lateMs <= graceFor(kind)) {
        void this.fire(a, now, lateMs, { dueAt, quiet: a.clauses.quiet === "respect" && inQuiet(this.opts.settings().automations.quietHours, now) });
        continue;
      }
      const routine = kind === "routine" || kind === "watcher";
      this.missedRow(a, dueAt, why, routine);
      if (routine) {
        const next = nextFire(a.when, now, a.createdAt);
        const detail = `skipped ${describeInstant(dueAt)} · ${whyWords(why, this.sleptAt)}`;
        if (next === undefined) this.write(mut(a, { state: "done", nextAt: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
        else this.write(mut(a, { state: "armed", nextAt: next, snoozedUntil: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
        continue;
      }
      const detail = `missed ${describeInstant(dueAt).slice(0, 5)} · ${whyWords(why, this.sleptAt)}`;
      this.opts.problem("automation.missed", `missed ${a.name} ${describeInstant(dueAt).slice(0, 5)} · ${whyWords(why, this.sleptAt)}`, { label: "Run now", command: { type: "automation.run", id: a.id } });
      if (this.repeats(a)) {
        const next = nextFire(a.when, now, a.createdAt);
        this.write(mut(a, { state: next === undefined ? "done" : "armed", nextAt: next, snoozedUntil: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
      } else {
        this.write(mut(a, { state: "failed", nextAt: undefined, snoozedUntil: undefined, missed: a.missed + 1, lastDetail: detail, updatedAt: now }), "engine", detail);
      }
    }
    const landed = this.watchers.rebaseline();
    for (const [id, n] of landed) {
      const a = this.table.get(id);
      if (!a) continue;
      const detail = `not watching while ${whyWords(why, this.sleptAt)} · ${n} new file${n === 1 ? "" : "s"} not handled`;
      this.write(mut(a, { missed: a.missed + n, lastDetail: detail, updatedAt: now }), "engine", detail, false);
    }
    this.sleptAt = undefined;
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
    if (!name) return { kind: "refused", reason: "an automation needs a name Kevin will hear" };
    if (name.length > AUTOMATION_NAME_CHARS) return { kind: "refused", reason: `the name "${cut(name, 30)}" is too long (${AUTOMATION_NAME_CHARS} characters at most)` };
    if (this.table.nameTaken(name, draft.id)) return { kind: "refused", reason: `an automation named "${name}" is already set; pick another name, or change that one` };
    const then = Array.isArray(draft.then) ? draft.then : [];
    if (then.length === 0 || then.length > AUTOMATION_ACTIONS_MAX) return { kind: "refused", reason: `an automation runs 1 to ${AUTOMATION_ACTIONS_MAX} actions` };
    if (!draft.when || typeof draft.when !== "object") return { kind: "refused", reason: "say when it fires: a time, 'in 12 minutes', 'weekdays 09:00', or a signal" };
    const clauses = { ...(draft.clauses ?? {}), quiet: draft.clauses?.quiet ?? (then[0]?.kind === "chime" && draft.when.kind !== "on" ? "override" : "respect") } as Automation["clauses"];
    const settings = this.opts.settings().automations;
    const judged = classifyAutomation({
      when: draft.when,
      then,
      clauses,
      settings,
      recipeCommand: draft.recipeCommand,
      confirmed: false,
      folderWatchers: this.table.folderWatchers(),
      fromThread: ctx.fromThread,
      localBrain: ctx.localBrain ?? this.opts.localBrain(),
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
    const nextAt = nextFire(draft.when, now, now);
    if (draft.when.kind !== "on" && nextAt === undefined) return { kind: "refused", reason: `${describe(draft.when)} is already past; say a time ahead` };
    const echo = cut(this.opts.redact(String(draft.echo ?? "").replace(/\s+/g, " ").trim() || `${describe(draft.when)}: ${then.map((x) => x.kind).join(", ")}`), AUTOMATION_ECHO_CHARS);
    const a: Automation = {
      id,
      name,
      when: draft.when,
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
    const recipeAction = then.find((x) => x.kind === "run-recipe");
    if (draft.recipeCommand && recipeAction?.kind === "run-recipe") this.saveRecipe(recipeAction.recipe, draft.recipeCommand, by === "brain" ? "brain" : "kevin", now);
    let watchNote = "";
    if (a.when.kind === "on") {
      const err = this.watchers.watch(a);
      if (err) {
        this.watchProblem(a, err);
        watchNote = `the folder could not be read yet (${err}); allow it in the Console`;
      }
    }
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
    if (!name || recipes.some((r) => r.name.toLowerCase() === name.toLowerCase())) return;
    const recipe: ShellRecipe = { name: cut(name, AUTOMATION_NAME_CHARS), command, timeoutSeconds: RECIPE_TIMEOUT_DEFAULT_S, approvedAt: now };
    this.opts.updateSettings({ automations: { ...this.opts.settings().automations, recipes: [...recipes, recipe] } });
    this.opts.ledger.append({ at: now, type: "recipe.set", recipe, by });
  }

  private watchProblem(a: Automation, err: string): void {
    const folder = a.when.kind === "on" && a.when.on.kind === "folder.file" ? expandPath(a.when.on.path, this.home) : `${this.home}/Downloads`;
    const which = /\/Downloads(\/|$)/.test(folder) ? "filesDownloads" : /\/Desktop(\/|$)/.test(folder) ? "filesDesktop" : /\/Documents(\/|$)/.test(folder) ? "filesDocuments" : "fullDiskAccess";
    this.opts.problem("automation.watch", `${a.name}: ${err}`, { label: "Ask", command: { type: "request-permission", which } });
  }

  /** A running timer ≤ CAFFEINATE_MAX_MS holds the Mac awake: `/usr/bin/caffeinate -t <seconds>`, killed at Done / Snooze / Trash / the fire. */
  private caffeinate(a: Automation, now: number): void {
    if (a.when.kind !== "in" || a.nextAt === undefined) return;
    const ms = a.nextAt - now;
    if (ms <= 0 || ms > CAFFEINATE_MAX_MS) return;
    this.releaseHold(a.id);
    const hold = this.exec.hold("/usr/bin/caffeinate", ["-t", String(Math.ceil(ms / 1000))]);
    if (hold) this.holds.set(a.id, hold);
  }

  private releaseHold(id: string): void {
    const h = this.holds.get(id);
    if (!h) return;
    this.holds.delete(id);
    try {
      h.kill();
    } catch {
      // gone
    }
  }

  // ----------------------------------------------------------------- verbs

  /** The brain's `automation_change`: one verb on one row by name or id; the row as it stands afterwards, with the engine's own words as `detail`. */
  async change(nameOrId: string, verb: ChangeVerb, minutes?: number): Promise<AutomationChangeResult> {
    const before = this.table.find(nameOrId);
    const r = verb === "run" ? await this.runNow(nameOrId, "brain") : this.changeNow(nameOrId, verb, minutes);
    const after = before ? this.table.get(before.id) : undefined;
    if (!r.ok || !after) return { ok: false, reason: r.text };
    return { ok: true, automation: after, detail: r.text };
  }

  /** The synchronous verbs (everything but `run`). */
  changeNow(nameOrId: string, verb: Exclude<ChangeVerb, "run">, minutes?: number): { readonly ok: boolean; readonly text: string } {
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
        this.write(mut(a, { state: "trashed", nextAt: undefined, snoozedUntil: undefined, updatedAt: now }), "kevin");
        return { ok: true, text: `${a.name} moved to the Trash · Restore brings it back` };
      }
      case "restore": {
        if (a.state !== "trashed") return { ok: false, text: `${a.name} is not in the Trash` };
        if (this.table.nameTaken(a.name, a.id)) return { ok: false, text: `another automation is named "${a.name}" now; rename that one first` };
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

  /** `automation.rename`: ≤ 24 chars, unique among the non-trashed rows. */
  rename(id: string, name: string): { readonly ok: boolean; readonly text: string } {
    const a = this.table.get(id);
    if (!a) return { ok: false, text: `no automation ${id}` };
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean) return { ok: false, text: "a name is needed" };
    if (clean.length > AUTOMATION_NAME_CHARS) return { ok: false, text: `"${cut(clean, 30)}" is too long (${AUTOMATION_NAME_CHARS} at most)` };
    if (this.table.nameTaken(clean, a.id)) return { ok: false, text: `another automation is named "${clean}"` };
    const row = this.table.put(mut(a, { name: clean, updatedAt: this.now() }));
    this.opts.ledger.append({ at: this.now(), type: "automation.set", automation: row, by: "console" });
    this.table.push(row.id, { kind: "set", automation: row });
    this.opts.onChange();
    return { ok: true, text: `renamed to ${clean}` };
  }

  // -------------------------------------------------------------- commands

  /** The twelve surface commands. Never a deletion: `trash` is Move to Trash, `restore` brings it back. */
  async command(cmd: EngineCommand, toast: (text: string, tone?: "info" | "warn") => void): Promise<void> {
    switch (cmd.type) {
      case "automation.set": {
        // The Console's form (and the CLI): the press on Add is Kevin's own hand on a control that says what it does — the
        // two-press idiom's second press — so a confirm-tier row arms with the question as what he heard. Free kinds arm at once.
        const r = this.arm(cmd.automation as AutomationSetInput, cmd.by === "cli" ? "cli" : "console", true, {});
        toast(r.kind === "armed" ? r.text : r.kind === "confirm" ? `needs a yes: ${r.question}` : `not armed: ${r.reason}`, r.kind === "armed" ? "info" : "warn");
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
        return toast(...this.said(this.rename(cmd.id, String(cmd.name ?? ""))));
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
        const rest = this.opts.settings().automations.recipes.filter((r) => r.name.toLowerCase() !== clean.name.toLowerCase());
        this.opts.updateSettings({ automations: { ...this.opts.settings().automations, recipes: [...rest, clean] } });
        this.opts.ledger.append({ at: now, type: "recipe.set", recipe: clean, by: "kevin" });
        return toast(`recipe ${clean.name} saved`);
      }
      case "recipe.trash": {
        const name = String(cmd.name ?? "").trim();
        const recipes = this.opts.settings().automations.recipes;
        if (!recipes.some((r) => r.name.toLowerCase() === name.toLowerCase())) return toast(`no recipe named "${name}"`, "warn");
        this.opts.updateSettings({ automations: { ...this.opts.settings().automations, recipes: recipes.filter((r) => r.name.toLowerCase() !== name.toLowerCase()) } });
        this.opts.ledger.append({ at: this.now(), type: "recipe.trashed", name });
        return toast(`recipe ${name} moved to the Trash (its row is in the ledger)`);
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

  /** Settings' recipes with the shell gate's present verdict and the rows that name each; the snapshot's `recipesAsking` reads the same list. */
  recipeRows(): readonly RecipeRow[] {
    const rows = this.table.inState("all");
    return this.opts.settings().automations.recipes.map((r) => {
      const name = r.name.toLowerCase();
      const usedBy = rows.filter((a) => a.then.some((x) => x.kind === "run-recipe" && x.recipe.toLowerCase() === name) || (a.when.kind === "on" && a.when.on.kind === "recipe.red" && a.when.on.recipe.toLowerCase() === name)).map((a) => a.name);
      const d = classifyAction({ kind: "run_shell", text: r.command, confirmed: false, home: this.home, ...(r.cwd ? { cwd: expandPath(r.cwd, this.home) } : {}), ...(this.opts.repoRoot ? { repoRoot: this.opts.repoRoot } : {}) });
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

function whyWords(why: MissedWhy, sleptAt: number | undefined): string {
  switch (why) {
    case "mac-slept":
      return sleptAt !== undefined ? `the Mac slept from ${describeInstant(sleptAt).slice(0, 5)}` : "the Mac slept";
    case "daemon-down":
      return "Jarhead was off";
    case "quiet-hours":
      return "quiet hours";
    case "budget":
      return "the brain budget was spent";
    default:
      return why;
  }
}
