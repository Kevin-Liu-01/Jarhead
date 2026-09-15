import { classifyAction, clockOf, describe, parseWhen, shellSteals } from "@jarhead/core";
import { AUTOMATION_TERMINAL, automationKind, type Automation, type AutomationAction, type AutomationDraft, type AutomationKind, type AutomationState, type RingLine, type ShellRecipe, type Snapshot } from "@jarhead/protocol";

/**
 * The CLI's view of the automations table — pure, so `jarhead automations`, `jarhead
 * recipes` and the `automations` block of `jarhead status` are pinned by a test without a
 * daemon: the lines a listing prints, the phrase `add` parses (the clock ladder only, through
 * core's `parseWhen` — no brain), which row an id-or-name means, and the shell gate's word
 * for a recipe.
 *
 * Words: Snooze · Done · Skip · Pause · Resume · Run now · Rename · Move to Trash · Restore.
 * Nothing here deletes anything, and nothing here is a yes: `add` arms the free kinds only
 * (chime · say · notify · open); run-recipe, press and wake-brain are set up by voice or in
 * the Console, where the yes is heard.
 */

/** Every AutomationState, checked against the protocol's union so a new one cannot go unlisted here. */
export const AUTOMATION_STATES: readonly AutomationState[] = Object.keys({ armed: 0, snoozed: 0, firing: 0, fired: 0, deferred: 0, paused: 0, done: 0, failed: 0, trashed: 0 } satisfies Record<AutomationState, 0>) as AutomationState[];

/** What `--state` accepts: a state, or `all`. */
export const LIST_STATES: readonly (AutomationState | "all")[] = [...AUTOMATION_STATES, "all"];

/** The verbs `jarhead automations <verb> <id|name>` sends, each one EngineCommand; none is a deletion. */
export const ROW_VERBS = ["snooze", "done", "skip", "pause", "resume", "rename", "run", "trash", "restore"] as const;
export type RowVerb = (typeof ROW_VERBS)[number];

/** One glyph per kind, as the Console's rail draws them. */
export function automationGlyph(kind: AutomationKind): string {
  switch (kind) {
    case "alarm":
      return "⏰";
    case "timer":
      return "⏳";
    case "reminder":
      return "🔔";
    case "routine":
      return "↻";
    case "watcher":
      return "👁";
  }
}

/** "in 6 h" · "in 12 min" · "in 45 s" · "in 3 d" · "now" for an instant behind `now`. */
export function inWords(at: number, now: number): string {
  const s = Math.round((at - now) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86_400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86_400)} d`;
}

/** The action kinds joined: "chime + say". */
export function actionsWords(then: readonly AutomationAction[]): string {
  return then.map((a) => a.kind).join(" + ");
}

/** The row's tail: what it waits for, in words. */
function tailWords(a: Automation, now: number): string {
  switch (a.state) {
    case "armed":
      return a.nextAt !== undefined ? `next ${inWords(a.nextAt, now)}` : "watching";
    case "snoozed":
      return a.snoozedUntil !== undefined ? `snoozed until ${clockOf(a.snoozedUntil)}` : "snoozed";
    case "deferred":
      return a.nextAt !== undefined ? `deferred to ${clockOf(a.nextAt)}` : "deferred";
    case "firing":
      return "firing";
    case "fired":
      return "ringing";
    case "paused":
      return "paused";
    case "failed":
      return a.lastDetail ? `failed: ${a.lastDetail}` : "failed";
    case "done":
      return "done";
    case "trashed":
      return "in the Trash";
  }
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One row: glyph · name · when · actions · id · tail. */
export function automationLine(a: Automation, now: number): string {
  return `    ${automationGlyph(automationKind(a))} ${cut(a.name, 24).padEnd(24)} ${cut(describe(a.when), 26).padEnd(26)} ${cut(actionsWords(a.then), 20).padEnd(20)} ${a.id} · ${tailWords(a, now)}`;
}

/** The rows a `--state` picks: `all` is every live row (the snapshot's trashed tail shows only under `--state trashed`). */
export function filterByState(rows: readonly Automation[], state: AutomationState | "all"): Automation[] {
  return state === "all" ? rows.filter((a) => a.state !== "trashed") : rows.filter((a) => a.state === state);
}

/** "5 armed · 1 paused" — the states present, in AUTOMATION_STATES order; "" when none. */
export function byStateWords(rows: readonly Pick<Automation, "state">[]): string {
  const counts = new Map<AutomationState, number>();
  for (const a of rows) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
  return AUTOMATION_STATES.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(" · ");
}

type Pointers = Pick<Snapshot, "nextFire" | "ringing">;

/** The `automations` line of `jarhead status`: count, states, the next fire and the ring. */
export function automationsSummary(all: readonly Automation[], pointers: Pointers, now: number): string {
  const rows = all.filter((a) => a.state !== "trashed");
  const states = byStateWords(rows);
  const next = pointers.nextFire ? `${clockOf(pointers.nextFire.at)} ${pointers.nextFire.name} (${inWords(pointers.nextFire.at, now)})` : "—";
  return `  automations ${rows.length}${states ? ` (${states})` : ""} · next ${next} · ringing: ${ringWords(pointers.ringing)}`;
}

/** The ring as one phrase: the line, `+N more`; "—" when nothing rings. */
export function ringWords(ring: RingLine | undefined): string {
  if (!ring) return "—";
  return `${ring.line}${ring.more > 0 ? ` (+${ring.more} more)` : ""}`;
}

/**
 * `jarhead automations [list]`: the summary line, then one row each — armed / snoozed /
 * deferred by nextAt first (the snapshot's order), the rest by updatedAt. An empty table says
 * how to set one; an empty filter names the states that ARE present.
 */
export function automationsLines(rows: readonly Automation[], pointers: Pointers, now: number, state: AutomationState | "all" = "all"): string[] {
  const picked = filterByState(rows, state);
  const lines = [automationsSummary(rows, pointers, now)];
  // `--state trashed` lists the snapshot's Trash tail even when nothing live is set.
  if (picked.length > 0) {
    for (const a of picked) lines.push(automationLine(a, now));
    return lines;
  }
  const trashed = rows.filter((a) => a.state === "trashed");
  if (trashed.length === rows.length) {
    lines.push("    nothing set — say \"wake me at 7:10 on weekdays\", or: jarhead automations add \"at 7:10 weekdays chime 'Wake up'\"");
    if (trashed.length > 0) lines.push(`    ${trashed.length} in the Trash — jarhead automations list --state trashed · restore <id>`);
    return lines;
  }
  const live = rows.filter((a) => a.state !== "trashed");
  lines.push(`    nothing ${state} — set: ${byStateWords(live)}`);
  return lines;
}

/** What `<verb> <id|name>` sends and, when the table knows it, the row it names. */
export interface ResolvedAutomation {
  readonly id: string;
  readonly target?: Automation;
}

/** An automation id as the engine mints it (core `newId("auto")`: "auto_", base-36 time, six random chars). */
export const AUTOMATION_ID = /^auto_[a-z0-9]{6,40}$/i;

/**
 * An id is sent as it is; a name is looked up case-insensitively, live rows first (a `done`
 * "pasta" may linger while a new one is armed), the snapshot's trashed tail last (Restore by
 * name). Any `auto_…` passes through even when the snapshot does not list it — the Trash tail
 * is the newest eight; an older trashed row is restored by its id (the journal under
 * ~/.jarhead/automations keeps every one). Anything else unknown throws, naming what IS set.
 */
export function resolveAutomation(rows: readonly Automation[], arg: string): ResolvedAutomation {
  const wanted = arg.trim().toLowerCase();
  const byId = rows.find((a) => a.id === arg);
  const live = rows.filter((a) => !AUTOMATION_TERMINAL.has(a.state));
  const byName = live.find((a) => a.name.toLowerCase() === wanted) ?? rows.find((a) => a.name.toLowerCase() === wanted);
  const target = byId ?? byName;
  if (target) return { id: target.id, target };
  if (AUTOMATION_ID.test(arg)) return { id: arg };
  const names = rows.map((a) => `${a.name} (${a.id})`).join(", ");
  throw new Error(`no automation called ${arg}${names ? `; set: ${names}` : "; nothing is set"}`);
}

// ------------------------------------------------------------------- add ---

/** The kinds `add` arms: the free ones. The rest name where the yes is heard. */
const FREE_VERBS = new Set(["chime", "say", "notify", "open"]);
const ASKING_VERBS = new Set(["run", "run-recipe", "recipe", "press", "wake", "wake-brain", "file"]);
const NAME_CHARS = 24;
const ECHO_CHARS = 120;

export type ParsedAutomation = AutomationDraft | { readonly error: string };

/** Words split on spaces; a quoted run ("…" or '…') is one word with its quotes gone. */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

const USAGE = "say when, then what: chime 'Wake up' · say 'call mum' · notify 'stand-up' · open Notes — e.g. \"at 7:10 weekdays chime 'Wake up'\", \"in 12m chime pasta\", \"weekdays 09:00 open Notes\"";

/**
 * `jarhead automations add "<words>"`: `<when> <chime|say|notify|open> <what>`, the when
 * parsed by core's `parseWhen` (the same ladder the voice's tool uses; no brain). Free kinds
 * only — a `run`, `press`, `file` or `wake` word is refused here with where the yes is heard.
 * The draft's `echo` is the one line the voice would have read back; the engine fills id,
 * state, the stamps and `createdBy { by: "cli" }`, and judges the draft with
 * `classifyAutomation` before it arms anything.
 */
export function parseClockAutomation(words: string, now: number): ParsedAutomation {
  const toks = tokens(words.trim());
  if (toks.length === 0) return { error: USAGE };
  const verbAt = toks.findIndex((t) => FREE_VERBS.has(t.toLowerCase()) || ASKING_VERBS.has(t.toLowerCase()));
  if (verbAt < 0) return { error: `didn't catch what it does — ${USAGE}` };
  const verb = (toks[verbAt] ?? "").toLowerCase();
  if (ASKING_VERBS.has(verb)) return { error: `${verb} is set up by voice or in the Console, where the yes is heard; the CLI arms chime · say · notify · open` };
  const whenPhrase = toks.slice(0, verbAt).join(" ");
  if (!whenPhrase) return { error: `say when first — ${USAGE}` };
  const when = parseWhen(whenPhrase, now);
  if ("error" in when) return when;
  const what = toks.slice(verbAt + 1).join(" ").trim();
  if (!what) return { error: verb === "open" ? "open needs an app, an https URL or a path" : `${verb} needs a line: ${verb} 'Wake up'` };

  const action: AutomationAction =
    verb === "chime" ? { kind: "chime", line: what }
    : verb === "say" ? { kind: "say", line: what }
    : verb === "notify" ? { kind: "notify", title: what }
    : { kind: "open", ...openTarget(what) };
  const name = cut(action.kind === "open" ? `open ${openWords(action)}` : what, NAME_CHARS);
  const then = [action];
  const kind = automationKind({ when, then });
  const whenWords = describe(when);
  const echo = cut(`${whenWords.charAt(0).toUpperCase()}${whenWords.slice(1)}, ${echoVerb(action)}.`, ECHO_CHARS);
  return { name, when, then, clauses: { quiet: kind === "alarm" ? "override" : "respect" }, echo };
}

/** An `open` argument: an https URL, a path (`/…`, `~…`), else an app name. */
function openTarget(what: string): { readonly url: string } | { readonly path: string } | { readonly app: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(what)) return { url: what };
  if (what.startsWith("/") || what.startsWith("~")) return { path: what };
  return { app: what };
}

function openWords(a: Extract<AutomationAction, { kind: "open" }>): string {
  return a.app ?? a.url ?? a.path ?? "";
}

/** The echo's second half: `ring "Wake up"` · `say "call mum"` · `show "stand-up"` · `open Notes`. */
function echoVerb(a: AutomationAction): string {
  switch (a.kind) {
    case "chime":
      return `ring "${a.line}"`;
    case "say":
      return `say "${a.line}"`;
    case "notify":
      return `show "${a.title}"`;
    case "open":
      return `open ${openWords(a)}`;
    default:
      return a.kind;
  }
}

// --------------------------------------------------------------- recipes ---

/** The shell gate's word for a recipe: `run` fires unattended; `asks` would need a yes at fire (never armable); `refused` is the never list; `fronts` brings an app forward (use the open action). */
export type RecipeWord = "run" | "asks" | "refused" | "fronts";

export interface RecipeVerdict {
  readonly word: RecipeWord;
  readonly reason: string;
}

/**
 * The same judgement `classifyAutomation` makes of a `run-recipe` row, as one word: the
 * shell gate over the saved text with `confirmed: false` — nobody is there to say yes when
 * it runs, so `confirm` is `asks`. Pure; `home` for tests.
 */
export function recipeVerdict(recipe: Pick<ShellRecipe, "command" | "cwd">, home?: string): RecipeVerdict {
  if (shellSteals(recipe.command)) return { word: "fronts", reason: "the recipe fronts an app (open / osascript); use the open action instead" };
  const d = classifyAction({ kind: "run_shell", text: recipe.command, confirmed: false, ...(home ? { home } : {}), ...(recipe.cwd ? { cwd: recipe.cwd } : {}) });
  if (d.verdict === "run") return { word: "run", reason: d.reason };
  if (d.verdict === "refuse") return { word: "refused", reason: d.reason };
  return { word: "asks", reason: `${d.reason.replace(/; ask first$/, "")} — would need a yes when it runs; nobody is there then` };
}

/** "3 d ago" · "just now" — for a recipe's approval. */
function agoShort(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** One row per recipe: name · the gate's word · command · approved · cwd · timeout; `asks` rows carry the reason. */
export function recipesLines(recipes: readonly ShellRecipe[], now: number, home?: string): string[] {
  if (recipes.length === 0) return ["  no recipes — jarhead recipes add <name> \"<command>\" [--cwd DIR] [--timeout 120]; a recipe runs unattended only when the shell gate says run"];
  const lines: string[] = [];
  for (const r of recipes) {
    const v = recipeVerdict(r, home);
    lines.push(`  ${cut(r.name, 24).padEnd(24)} ${v.word.padEnd(8)} ${cut(r.command, 60).padEnd(60)} · approved ${agoShort(r.approvedAt, now)}${r.cwd ? ` · cwd ${r.cwd}` : ""} · ${r.timeoutSeconds} s${v.word === "run" ? "" : ` · ${v.reason}`}`);
  }
  const asks = recipes.filter((r) => recipeVerdict(r, home).word !== "run").length;
  lines.push(`  ${recipes.length} recipe${recipes.length === 1 ? "" : "s"} · ${recipes.length - asks} run-tier${asks ? ` · ${asks} cannot fire unattended (edit the command, or Move to Trash)` : ""}`);
  return lines;
}

/** `jarhead recipes add`: name ≤ 24 chars, a command, an optional cwd, a timeout 1–600 (default 120). Throws on a malformed one before any socket is opened. */
export function parseRecipeArgs(name: string | undefined, command: string | undefined, cwd: string | undefined, timeout: string | undefined, now: number): ShellRecipe {
  const usage = 'usage: jarhead recipes add <name> "<command>" [--cwd DIR] [--timeout 120]';
  if (!name || !command?.trim()) throw new Error(usage);
  if (name.length > NAME_CHARS) throw new Error(`a recipe name is ${NAME_CHARS} chars at most (got ${name.length})`);
  const seconds = timeout === undefined ? 120 : Number(timeout);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error(`--timeout is whole seconds, 1 to 600 (got ${timeout})`);
  return { name, command: command.trim(), ...(cwd ? { cwd } : {}), timeoutSeconds: seconds, approvedAt: now };
}
