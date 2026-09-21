import { describe, describeInstant, parseWhen } from "@jarhead/core";
import type { Automation, AutomationAction, AutomationClauses, AutomationDraft, AutomationState, AutomationWhen, ClockTime, ShellRecipe, Weekday } from "@jarhead/protocol";
import { AUTOMATION_ACTIONS_MAX, automationKind } from "@jarhead/protocol";

/**
 * The brain's side of automations (design11, 2026-09-14): four tools — `automation_set`,
 * `automation_list`, `automation_change`, `recipe_list` — that the runner answers through an
 * `AutomationSource` the engine hands in (`RunnerOptions.automations`, the way `agents` and
 * `ledger` arrive; the `ThreadToolSource` pattern). This file is the pure half: the source's
 * shape, the tool arguments → an `AutomationDraft`, and the rows → the text a model reads.
 * Nothing here judges: the set-up gate is `classifyAutomation` (core/policy.ts), run by the
 * source, which alone knows Settings, the folder-watcher count and the table. Nothing here
 * fires: firing is the engine's, asleep, with nobody to ask.
 */

/** ≤ 24: spoken as-is, unique among non-trashed rows (case-insensitive), fits the Console's 296 rail. */
export const AUTOMATION_NAME_CHARS = 24;
/** ≤ 120: the one line Jarhead read back at set-up. Longer echoes are trimmed, not refused. */
export const AUTOMATION_ECHO_CHARS = 120;
/** The default budget of a `wake-brain` turn when the model names none: one capped headless turn. */
export const WAKE_BRAIN_DEFAULT_BUDGET = { steps: 25, seconds: 120 } as const;

export const AUTOMATION_VERBS = ["snooze", "done", "skip", "pause", "resume", "trash", "restore", "run"] as const;
export type AutomationVerb = (typeof AUTOMATION_VERBS)[number];

export const AUTOMATION_LIST_STATES = ["armed", "snoozed", "deferred", "paused", "fired", "failed", "done", "all"] as const;
export type AutomationListState = (typeof AUTOMATION_LIST_STATES)[number];

/** What the runner knows that the table does not, handed to `set` with the draft. */
export interface AutomationSetContext {
  readonly by: "brain";
  /** Kevin said yes to this exact set-up: the runner's `consume()` matched the identical re-call. */
  readonly confirmed: boolean;
  /** The question Kevin heard when he said yes (for wake-brain, the cost line) — recorded as `confirmed.heard`. */
  readonly heard?: string | undefined;
  /** A recipe text arriving with the row; the engine writes it to Settings after the yes, a tool never does. */
  readonly recipeCommand?: string | undefined;
  /** A spawned thread is arming it (depth one: free kinds only; `wake-brain` refused). */
  readonly fromThread: boolean;
  /** The brain is a local model, when the runner knows; absent = the source decides from Settings. The cost line then says "warm-up". */
  readonly localBrain?: boolean | undefined;
  /** Kevin's own words for this row (the request and his lines, never Jarhead's): `file`/`open` may use a folder he named. */
  readonly request: string;
  readonly delegationId?: string | undefined;
}

/** What `set` comes back with. `confirm` is the one set-up question; the runner turns it into the handshake. */
export type AutomationSetResult =
  | { readonly kind: "armed"; readonly automation: Automation; readonly note?: string | undefined }
  | { readonly kind: "confirm"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string };

export type AutomationChangeResult = { readonly ok: true; readonly automation: Automation; readonly detail?: string | undefined } | { readonly ok: false; readonly reason: string };

/** An approved recipe as `recipe_list` shows it: `asks` when the shell gate now rates it confirm (never armable until edited). */
export interface RecipeRow {
  readonly recipe: ShellRecipe;
  readonly asks: boolean;
  readonly usedBy: readonly string[];
}

/**
 * As much of the engine's automations table as the runner needs. The engine implements it
 * (packages/engine/src/automations); a runner without one answers "not available here".
 *
 * `set` runs the set-up gate (`classifyAutomation`) with the draft, Settings and the context:
 * `run` → the row is armed, journaled, ledgered (`automation.set { by: "brain" }`) and returned;
 * `confirm` → nothing is armed, the joined reasons come back (the runner asks Kevin ONCE and the
 * identical re-call arrives with `confirmed: true`); `refuse` → the reason, naming the nearest
 * safe kind. `list` is every non-trashed row (the snapshot's order). `change` is one verb on one
 * row by name or id — `trash` is Move to Trash, restorable, nothing deleted; `run` only while a
 * Live session is open. `recipes` is Settings.automations.recipes with the gate's present verdict.
 */
export interface AutomationSource {
  set(draft: AutomationDraft, ctx: AutomationSetContext): Promise<AutomationSetResult>;
  list(): Promise<readonly Automation[]>;
  change(nameOrId: string, verb: AutomationVerb, minutes?: number): Promise<AutomationChangeResult>;
  recipes(): Promise<readonly RecipeRow[]>;
}

// ------------------------------------------------------------ arguments → draft

/** The tool's draft: `when` is always parsed here (the runner describes it in the question), never left as a phrase. */
export type ToolDraft = AutomationDraft & { readonly when: AutomationWhen };
export type DraftParse = { readonly draft: ToolDraft; readonly recipeCommand?: string | undefined } | { readonly error: string };

const CLOCK = /^(\d{1,2}):(\d{2})$/;
const WEEKDAYS: ReadonlySet<string> = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
/** Trigger kinds this build parses; anything else is passed through by name for the gate to refuse (reserved kinds included). */
const SIGNAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "folder.file": ["path"],
  "download.done": [],
  "app.launch": ["app"],
  "app.quit": ["app"],
  "mac.wake": [],
  "screen.unlock": [],
  "display.connected": [],
  "display.disconnected": [],
  "recipe.red": ["recipe", "everySeconds"],
  "agent.status": ["status"],
};
/** Action kinds and the field each must carry; `open` needs one of three and is checked apart. Unknown kinds pass through for the gate. */
const ACTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  chime: ["line"],
  say: ["line"],
  notify: ["title"],
  open: [],
  file: ["into"],
  "run-recipe": ["recipe"],
  press: ["app", "key"],
  "wake-brain": ["prompt"],
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/**
 * The tool's arguments as one draft. Shape only — presence and type of what each kind needs;
 * the judging (lengths, secrets, hands-off apps, the never list) is the gate's, so there is
 * one place that says no. `when` is a clock phrase for core's `parseWhen`; `on` is a signal
 * object; a row has one of the two.
 */
export function draftFromArgs(args: Record<string, unknown>, now: number, userName = "Kevin"): DraftParse {
  const name = str(args["name"]);
  if (!name) return { error: `name: a short name ${userName} will hear ('Wake up', 'pasta', 'standup notes')` };
  if (name.length > AUTOMATION_NAME_CHARS) return { error: `name: at most ${AUTOMATION_NAME_CHARS} characters ("${name.slice(0, AUTOMATION_NAME_CHARS)}…" is ${name.length})` };

  const when = parseTrigger(args, now);
  if ("error" in when) return when;

  const then = parseActions(args["then"], userName);
  if ("error" in then) return then;

  const clauses = parseClauses(obj(args["clauses"]) ?? {}, when.when, then.actions);
  if ("error" in clauses) return clauses;

  const echoRaw = str(args["echo"]);
  if (!echoRaw) return { error: `echo: one terse line in ${userName}'s words saying exactly when and what ('Weekdays at 07:10, ring "Wake up".')` };
  const echo = echoRaw.length > AUTOMATION_ECHO_CHARS ? `${echoRaw.slice(0, AUTOMATION_ECHO_CHARS - 1)}…` : echoRaw;

  const recipeCommand = str(args["recipeCommand"]);
  return { draft: { name, when: when.when, then: then.actions, clauses: clauses.clauses, echo }, ...(recipeCommand ? { recipeCommand } : {}) };
}

function parseTrigger(args: Record<string, unknown>, now: number): { readonly when: AutomationWhen } | { readonly error: string } {
  const phrase = str(args["when"]);
  const on = obj(args["on"]);
  if (phrase && on) return { error: "give when (a clock phrase) or on (a signal), not both" };
  if (!phrase && !on) return { error: "when: a clock phrase ('7:10', 'in 12 minutes', 'weekdays 09:00', 'every 2 h') — or on: a signal ({ kind: 'app.quit', app: 'Slack' })" };
  if (phrase) {
    const parsed = parseWhen(phrase, now);
    return "error" in parsed ? { error: `when: ${parsed.error}` } : { when: parsed };
  }
  const kind = str(on!["kind"]);
  if (!kind) return { error: "on.kind: which signal (folder.file, download.done, app.launch, app.quit, mac.wake, screen.unlock, display.connected, display.disconnected, recipe.red, agent.status)" };
  const fields = SIGNAL_FIELDS[kind];
  if (fields) {
    for (const f of fields) {
      const v = on![f];
      const ok = f === "everySeconds" ? typeof v === "number" && Number.isFinite(v) : typeof v === "string" && v.trim() !== "";
      if (!ok) return { error: `on.${f}: ${kind} needs it` };
    }
  }
  // Unknown and reserved kinds ride through by name: the gate refuses them and says which.
  return { when: { kind: "on", on: { ...on, kind } as unknown as Extract<AutomationWhen, { kind: "on" }>["on"] } };
}

function parseActions(raw: unknown, userName: string): { readonly actions: readonly AutomationAction[] } | { readonly error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: `then: one to three actions, in order ([{ kind: 'chime', line: 'Wake up, ${userName}' }])` };
  if (raw.length > AUTOMATION_ACTIONS_MAX) return { error: `then: at most ${AUTOMATION_ACTIONS_MAX} actions; this has ${raw.length}` };
  const actions: AutomationAction[] = [];
  for (const [i, item] of raw.entries()) {
    const a = obj(item);
    const kind = a ? str(a["kind"]) : undefined;
    if (!a || !kind) return { error: `then[${i}]: an action object with a kind (chime, say, notify, open, file, run-recipe, press, wake-brain)` };
    for (const f of ACTION_FIELDS[kind] ?? []) if (!str(a[f])) return { error: `then[${i}].${f}: ${kind} needs it` };
    if (kind === "open" && !str(a["app"]) && !str(a["url"]) && !str(a["path"])) return { error: `then[${i}]: open needs an app, an https url or a path` };
    if (kind === "wake-brain") {
      const b = obj(a["budget"]) ?? {};
      const steps = typeof b["steps"] === "number" ? Math.max(1, Math.round(b["steps"])) : WAKE_BRAIN_DEFAULT_BUDGET.steps;
      const seconds = typeof b["seconds"] === "number" ? Math.max(10, Math.round(b["seconds"])) : WAKE_BRAIN_DEFAULT_BUDGET.seconds;
      actions.push({ kind: "wake-brain", prompt: str(a["prompt"])!, budget: { steps, seconds }, speak: a["speak"] !== false });
      continue;
    }
    // Known kinds keep their fields trimmed; unknown kinds pass through for the gate to name.
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) trimmed[k] = typeof v === "string" ? v.trim() : v;
    actions.push(trimmed as unknown as AutomationAction);
  }
  return { actions };
}

function parseClauses(raw: Record<string, unknown>, when: AutomationWhen, then: readonly AutomationAction[]): { readonly clauses: AutomationClauses } | { readonly error: string } {
  const out: { -readonly [K in keyof AutomationClauses]: AutomationClauses[K] } = { quiet: defaultQuiet(when, then) };
  const window = obj(raw["window"]);
  if (window) {
    const from = clockOf(window["from"]);
    const to = clockOf(window["to"]);
    if (!from || !to) return { error: "clauses.window: { from: 'HH:mm', to: 'HH:mm' }" };
    out.window = { from, to };
  }
  if (raw["days"] !== undefined) {
    if (!Array.isArray(raw["days"]) || !raw["days"].every((d) => typeof d === "string" && WEEKDAYS.has(d.toLowerCase()))) return { error: "clauses.days: weekday names, mon…sun" };
    out.days = raw["days"].map((d) => (d as string).toLowerCase() as Weekday);
  }
  if (raw["once"] !== undefined) {
    if (raw["once"] === "once" || raw["once"] === true) out.once = true;
    else if (raw["once"] === "day") out.once = "day";
    else return { error: "clauses.once: 'once' (fires one time) or 'day' (at most once a day)" };
  }
  if (raw["cooldown"] !== undefined) {
    if (typeof raw["cooldown"] !== "number" || raw["cooldown"] < 0) return { error: "clauses.cooldown: seconds between fires" };
    out.cooldown = Math.round(raw["cooldown"]);
  }
  if (raw["until"] !== undefined) {
    if (typeof raw["until"] !== "number" || raw["until"] <= 0) return { error: "clauses.until: an instant in ms after which a repeater stops" };
    out.until = Math.round(raw["until"]);
  }
  if (raw["quiet"] !== undefined) {
    if (raw["quiet"] !== "respect" && raw["quiet"] !== "override") return { error: "clauses.quiet: 'respect' (wait for quiet hours to end) or 'override' (ring through them)" };
    out.quiet = raw["quiet"];
  }
  return { clauses: out };
}

/** Alarms ring through quiet hours; everything else waits for them to end. */
function defaultQuiet(when: AutomationWhen, then: readonly AutomationAction[]): AutomationClauses["quiet"] {
  return automationKind({ when, then }) === "alarm" ? "override" : "respect";
}

function clockOf(v: unknown): ClockTime | undefined {
  const m = typeof v === "string" ? CLOCK.exec(v.trim()) : null;
  if (!m) return undefined;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return undefined;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` as ClockTime;
}

// -------------------------------------------------------------------- words

/** The actions in words, in order: `chime "Wake up, Kevin", then open Notes`. */
export function describeActions(then: readonly AutomationAction[]): string {
  return then.map(describeAction).join(", then ");
}

function describeAction(a: AutomationAction): string {
  switch (a.kind) {
    case "chime":
      return `chime "${a.line}"`;
    case "say":
      return `say "${a.line}"`;
    case "notify":
      return `banner "${a.title}"`;
    case "open":
      return `open ${a.app ?? a.url ?? a.path ?? "nothing"}`;
    case "file":
      return `file it into ${a.into}`;
    case "run-recipe":
      return `run recipe "${a.recipe}"`;
    case "press":
      return `press ${a.key} in ${a.app}`;
    case "wake-brain":
      return `wake the brain: "${a.prompt}"`;
    default:
      return String((a as { readonly kind?: unknown }).kind ?? "?");
  }
}

/** `arm "Wake up" — weekdays 07:10: chime "Wake up, Kevin"` — the description the handshake's question opens with. */
export function describeDraft(d: Pick<ToolDraft, "name" | "when" | "then">): string {
  return `arm "${d.name}" — ${describe(d.when)}: ${describeActions(d.then)}`;
}

/** The result line of a set: `armed: Wake up · weekdays 07:10 · chime "Wake up, Kevin" · next 07:10 · Tue 15 Sep`. */
export function armedLine(a: Automation, note?: string): string {
  const parts = [`armed: ${a.name}`, describe(a.when), describeActions(a.then)];
  if (a.nextAt !== undefined) parts.push(`next ${describeInstant(a.nextAt)}`);
  const line = parts.join(" · ");
  return note ? `${line} — ${note}` : line;
}

/** One row per line: name · kind · state · when · echo · next · last (detail). */
export function renderAutomations(rows: readonly Automation[], state: AutomationListState | undefined): string {
  const wanted = rows.filter((a) => a.state !== "trashed" && (state === "all" || (state ? a.state === state : a.state !== "done")));
  if (wanted.length === 0) return state && state !== "all" ? `nothing ${state}` : "nothing is set";
  return wanted.map(renderAutomation).join("\n");
}

function renderAutomation(a: Automation): string {
  const parts = [a.name, automationKind(a), a.state, describe(a.when), a.echo];
  if (a.nextAt !== undefined && a.state !== "done" && a.state !== "failed") parts.push(`next ${describeInstant(a.nextAt)}`);
  if (a.lastFiredAt !== undefined) parts.push(`last ${describeInstant(a.lastFiredAt)}${a.lastDetail ? ` (${a.lastDetail})` : ""}`);
  else if (a.lastDetail) parts.push(a.lastDetail);
  return parts.join(" · ");
}

const VERB_DONE: Readonly<Record<AutomationVerb, string>> = {
  snooze: "snoozed",
  done: "done",
  skip: "skipped",
  pause: "paused",
  resume: "resumed",
  trash: "moved to the Trash (restorable, nothing deleted)",
  restore: "restored",
  run: "ran",
};

/** `snoozed: Wake up · 10 min · next 07:20 · Tue 15 Sep · snoozed`. */
export function changedLine(verb: AutomationVerb, a: Automation, detail?: string): string {
  const parts = [`${VERB_DONE[verb]}: ${a.name}`];
  if (detail) parts.push(detail);
  if (a.nextAt !== undefined && a.state !== "trashed" && a.state !== "done") parts.push(`next ${describeInstant(a.nextAt)}`);
  parts.push(a.state as AutomationState);
  return parts.join(" · ");
}

/** `backup · ~/bin/backup.sh · approved 23:00 · Sun 13 Sep · used by nightly backup` (+ ` · asks` when the gate would now question it). */
export function renderRecipes(rows: readonly RecipeRow[]): string {
  if (rows.length === 0) return "no recipes approved; a run-recipe automation with recipeCommand asks once and approves one";
  return rows
    .map(({ recipe, asks, usedBy }) => {
      const parts = [recipe.name, recipe.command, `approved ${describeInstant(recipe.approvedAt)}`];
      if (usedBy.length) parts.push(`used by ${usedBy.join(", ")}`);
      if (asks) parts.push("asks — would need a yes when it runs; nobody is there then; edit it before a row can use it");
      return parts.join(" · ");
    })
    .join("\n");
}

/** Stable JSON of the arguments (keys sorted, strings trimmed): the identical re-call is judged by content, not by key order. */
export function canonicalArgs(args: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(args));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return typeof v === "string" ? v.trim() : v;
}
