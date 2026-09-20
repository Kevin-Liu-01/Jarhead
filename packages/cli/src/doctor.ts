import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import { AUTOMATION_GRACE_MS, AUTO_BRAIN_ORDER, BRAIN_MEMORY_TOKENS, DEFAULT_AUTOMATIONS, DEFAULT_WAKE, PERMISSION_KINDS, VOICE_MEMORY_TOKENS, automationKind, type AgentInfo, type AgentStatus, type AudioDeviceInfo, type AudioSettings, type AudioState, type Automation, type AutomationSettings, type BrainKind, type DataPath, type Grant, type LocalServerStatus, type MemorySummary, type MissedWhy, type PermissionInfo, type Permissions, type Phase, type Problem, type SetupStatus, type Snapshot, type WakeSettings, type Weekday } from "@jarhead/protocol";
import { Ledger, REPO_ROOT, clockOf, dataPaths, expandPath, keySource, noLiveModelLine, readConfig, secretsPresent } from "@jarhead/core";
import { inWords, recipeVerdict } from "./automations-cli.ts";
import { DEFAULT_MEMORY_MODEL, pickMemoryModel } from "@jarhead/memory";
import { defaultConnectors } from "@jarhead/agents";
import { EMBED_PREFERENCE, LOCAL_NUM_CTX_MAX, LOCAL_NUM_CTX_MIN, browserJsDoctor, discoverLocalServer, probeCodex, resolveLocalModel, selfEditDoctorRow, serverLabel, suggestedPull } from "@jarhead/brain";
import { DaemonClient } from "@jarhead/daemon";
import { NativeHandsProcess, type HelloPermissions } from "@jarhead/hands";
import { CODESIGN, CODESIGN_REQUIREMENT_ARGS, CODESIGN_VERIFY_ARGS, INSTALLED_APP, JARHEAD_BUNDLE_ID, defaultExec, describeDock, planInstall, probeTarget, requirementHasIdentifier, runHygiene, type Exec, type TargetProbe } from "./install/index.ts";

/**
 * Preflight for the things that fail silently. Exits non-zero only on failures
 * that make Jarhead unusable; advisories never fail the build.
 */

export type Status = "ok" | "warn" | "fail";

export interface Check {
  readonly group: string;
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly required: boolean;
  readonly fix?: string | undefined;
}

/** How a missing grant is obtained, for a row: the sweep's prompt, System Settings, or one prompt per target app. */
const ASK_WORD: Record<PermissionInfo["ask"], string> = { prompt: "prompt", settings: "System Settings", perApp: "per app" };

/**
 * One line for a permissions list: "12/16 granted · missing: Full Disk Access (System
 * Settings), Contacts (prompt)". A partial list (the app has not reported yet, so only
 * the four the helper reads are known) says how many the app still has to read.
 */
export function summarizePermissions(all: readonly PermissionInfo[] | undefined): string {
  if (!all || all.length === 0) return "not read yet — the app reads them (Setup › Permissions), the daemon's helper reads four";
  const granted = all.filter((p) => p.grant === "granted");
  const missing = all.filter((p) => p.grant === "denied");
  const unknown = all.filter((p) => p.grant === "unknown");
  const parts = [`${granted.length}/${all.length} granted`];
  if (missing.length) parts.push(`missing: ${missing.map((p) => `${p.label} (${ASK_WORD[p.ask] ?? p.ask})`).join(", ")}`);
  if (unknown.length) parts.push(`not asked yet: ${unknown.map((p) => p.label).join(", ")}`);
  const unlisted = PERMISSION_KINDS.length - all.length;
  if (unlisted > 0) parts.push(`${unlisted} more read only by the app (open Jarhead.app)`);
  return parts.join(" · ");
}

/** What the doctor reads from a running daemon's first snapshot: the permission rows, the problems and the memory summary. */
interface DaemonRead {
  readonly permissions: readonly PermissionInfo[] | undefined;
  /** `snapshot.problems`: each with its kind and the one remedy the Console offers. */
  readonly problems: readonly Problem[];
  /** Milliseconds from connect to the snapshot: a slow answer is itself a finding. */
  readonly ms: number;
  /** `snapshot.memory` — the durable memory's counts and last run. */
  readonly memory: MemorySummary | undefined;
  /** `snapshot.automations` and the two pointers; undefined from a daemon before the field. */
  readonly automations: readonly Automation[] | undefined;
  readonly nextFire: Snapshot["nextFire"] | undefined;
  /** `snapshot.settings.automations` — the daemon's view of the block (settings.json is the doctor's fallback). */
  readonly automationSettings: AutomationSettings | undefined;
  /** design12: the phase, the app's audio read-back (absent when no app is connected) and the audio block. */
  readonly phase: Phase | undefined;
  readonly audioState: AudioState | undefined;
  readonly audioSettings: AudioSettings | undefined;
}

/** A running daemon's first snapshot (`permissions.all`, the problems, the memory summary, the automations); undefined when none answers within 1.5 s. */
async function daemonRead(socketPath: string): Promise<DaemonRead | undefined> {
  if (!existsSync(socketPath)) return undefined;
  const client = new DaemonClient(socketPath);
  const t0 = Date.now();
  try {
    const got = new Promise<DaemonRead | undefined>((resolve) => {
      client.on("message", (m) => {
        if (m.type !== "snapshot") return;
        const snap = m.snapshot as { phase?: Phase; permissions: Permissions; problems: readonly Problem[]; memory?: MemorySummary; automations?: readonly Automation[]; nextFire?: Snapshot["nextFire"]; settings?: { automations?: AutomationSettings; audio?: AudioSettings }; audioState?: AudioState };
        resolve({ permissions: snap.permissions.all, problems: snap.problems, ms: Date.now() - t0, memory: snap.memory, automations: snap.automations, nextFire: snap.nextFire, automationSettings: snap.settings?.automations, phase: snap.phase, audioState: snap.audioState, audioSettings: snap.settings?.audio });
      });
      setTimeout(() => resolve(undefined), 1500);
    });
    await client.connect({ pid: process.pid, audio: false });
    return await got;
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

/** The remedy as one line for the doctor's "next steps": the button and what it sends or opens. */
export function remedyLine(p: Problem): string | undefined {
  const r = p.remedy;
  if (!r) return undefined;
  if (r.command) {
    const cmd = r.command as { type: string; which?: string; kind?: string };
    const arg = cmd.which ?? cmd.kind;
    return `${r.label} — sends ${cmd.type}${arg ? ` ${arg}` : ""} (the Console's Problems rail has the button)`;
  }
  if (r.open) return `${r.label} — opens ${r.open}`;
  return r.label;
}

/** "since 2 min" for a problem's first sighting; "" when the engine did not say. */
function sinceLine(p: Problem, now = Date.now()): string {
  if (!p.since) return "";
  const s = Math.max(0, Math.round((now - p.since) / 1000));
  return s < 60 ? ` · since ${s} s` : s < 3600 ? ` · since ${Math.round(s / 60)} min` : ` · since ${Math.round(s / 3600)} h`;
}

/** The kinds that make Jarhead unusable until fixed, as the doctor grades them: the rest are warnings. */
const FAILING_KINDS = new Set<Problem["kind"]>(["voice.key", "daemon", "permission.microphone"]);

function sh(cmd: string, args: readonly string[]): string | undefined {
  try {
    return execFileSync(cmd, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).trim();
  } catch {
    return undefined;
  }
}

async function json(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    body = undefined;
  }
  return { status: r.status, body };
}

/** The brain and memory settings the engine actually uses: ~/.jarhead/settings.json overrides the env defaults (memory defaults to on through DEFAULT_SETTINGS). */
function readSavedSettings(stateDir: string): { brain?: BrainKind; brainModel?: string; brainBaseUrl?: string; memory?: boolean; audio?: AudioSettings } {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as { brain?: BrainKind; brainModel?: string; brainBaseUrl?: string; memory?: boolean; audio?: { recording?: unknown } };
    return {
      ...(saved.brain ? { brain: saved.brain } : {}),
      ...(typeof saved.brainModel === "string" ? { brainModel: saved.brainModel } : {}),
      ...(saved.brainBaseUrl ? { brainBaseUrl: saved.brainBaseUrl } : {}),
      ...(typeof saved.memory === "boolean" ? { memory: saved.memory } : {}),
      // design12: the audio block, merged over its default as the engine merges it (a file from before the block has none).
      ...(typeof saved.audio === "object" && saved.audio !== null ? { audio: { recording: saved.audio.recording === true } } : {}),
    };
  } catch {
    return {};
  }
}

/** Ask a running daemon which brain it resolved to, with its whole `setup` (the local server it saw, the data paths it computed); undefined when none answers within 1.5 s. */
async function daemonBrain(socketPath: string): Promise<{ resolved: string | undefined; detail: string; setup: SetupStatus | undefined } | undefined> {
  if (!existsSync(socketPath)) return undefined;
  const client = new DaemonClient(socketPath);
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 1500);
      client.on("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      client.on("message", (m) => {
        if (m.type !== "snapshot") return;
        clearTimeout(timer);
        const setup = (m.snapshot as { setup?: SetupStatus } | undefined)?.setup;
        resolve({ resolved: setup?.brainResolved, detail: setup?.brainDetail ?? "", setup });
      });
      client.connect({ pid: process.pid, audio: false }).catch(() => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  } finally {
    client.close();
  }
}

/** Seams for the install rows: every shell-out and stat goes through these so the rows run in CI without a Mac. */
export interface InstallCheckDeps {
  readonly exec?: Exec;
  readonly probe?: (path: string) => TargetProbe;
  readonly uid?: number;
  readonly installed?: string;
  readonly bundleId?: string;
  readonly staleRoots?: readonly string[];
  readonly exists?: (path: string) => boolean;
  /** Where `build/Jarhead.app` points, for the note; undefined when the link is missing. */
  readonly linkTarget?: string | undefined;
}

/**
 * The `app` group's install rows, all read-only: `Jarhead.app` (the installed bundle,
 * never the build/ symlink — a dangling link used to read as "not built"), `signing
 * identity`, `install` (target sane, strict verify, designated requirement), `launch
 * services` and `dock` (the one-Jarhead audit; the fix is a command Kevin runs).
 */
export function installChecks(deps: InstallCheckDeps = {}): Check[] {
  const exec = deps.exec ?? defaultExec;
  const installed = deps.installed ?? INSTALLED_APP;
  const bundleId = deps.bundleId ?? JARHEAD_BUNDLE_ID;
  const probe = (deps.probe ?? probeTarget)(installed);
  const uid = deps.uid ?? process.getuid?.() ?? -1;
  const out: Check[] = [];
  const add = (c: Check): void => void out.push(c);
  const rebuild = "pnpm build:mac";

  if (!probe.exists) {
    add({ group: "app", name: "Jarhead.app", status: "warn", detail: `${installed} not installed`, required: false, fix: rebuild });
    add({ group: "app", name: "install", status: "warn", detail: "nothing to verify", required: false, fix: rebuild });
  } else {
    const linkNote = deps.linkTarget === undefined ? linkTargetNote(installed) : deps.linkTarget === installed ? " (build/Jarhead.app → symlink)" : ` (build/Jarhead.app → ${deps.linkTarget}, not this bundle)`;
    add({ group: "app", name: "Jarhead.app", status: "ok", detail: `${installed}${linkNote}`, required: false });
    // codesign -dvv reports on stderr; an ad-hoc signature means TCC forgets the grants on every rebuild.
    const dvv = exec(CODESIGN, ["-dvv", installed], { timeoutMs: 8000 });
    const signature = `${dvv.stderr}${dvv.stdout}`;
    const adhoc = /Signature=adhoc/.test(signature);
    const authority = signature.match(/^Authority=(.+)$/m)?.[1];
    add({ group: "app", name: "signing identity", status: adhoc ? "warn" : "ok", detail: adhoc ? "ad-hoc — microphone/screen/accessibility grants reset on every rebuild" : (authority ?? "signed with a real identity"), required: false, fix: adhoc ? "Keychain Access → Certificate Assistant → Create a Certificate (Code Signing), then pnpm build:mac; or set JARHEAD_SIGN_IDENTITY" : undefined });

    const plan = planInstall(probe, uid, installed);
    if (plan.kind === "refuse") {
      add({ group: "app", name: "install", status: "warn", detail: `${plan.reason} — the next pnpm build:mac refuses`, required: false, fix: plan.hint });
    } else {
      const verify = exec(CODESIGN, [...CODESIGN_VERIFY_ARGS, installed], { timeoutMs: 8000 });
      const req = exec(CODESIGN, [...CODESIGN_REQUIREMENT_ARGS, installed], { timeoutMs: 8000 });
      const hasId = requirementHasIdentifier(`${req.stdout}${req.stderr}`, bundleId);
      const problems: string[] = [];
      if (verify.code !== 0) problems.push(`codesign --verify --strict --deep failed: ${(verify.stderr || verify.stdout).trim().split("\n")[0] ?? verify.code}`);
      if (!hasId) problems.push(`designated requirement lacks identifier "${bundleId}"`);
      add({
        group: "app",
        name: "install",
        status: problems.length ? "warn" : "ok",
        detail: problems.length ? problems.join("; ") : `${installed} · inode ${plan.kind === "update" ? plan.inode : "?"} · strict ok · requirement identifier ${bundleId}`,
        required: false,
        fix: problems.length ? rebuild : undefined,
      });
    }
  }

  const audit = runHygiene({ mode: "audit", exec, installed, bundleId, ...(deps.staleRoots ? { staleRoots: deps.staleRoots } : {}), ...(deps.exists ? { exists: deps.exists } : {}) });
  const ls = audit.launchServices;
  const repair = "pnpm jarhead dock --fix";
  if (ls.skipped) add({ group: "app", name: "launch services", status: "warn", detail: ls.skipped, required: false });
  else {
    const registered = ls.records.some((r) => r.path === installed);
    const others = ls.remaining.map((r) => r.path);
    add({
      group: "app",
      name: "launch services",
      status: registered && others.length === 0 ? "ok" : "warn",
      detail: !registered ? `${installed} is not registered${others.length ? ` — but ${others.join(", ")} ${others.length === 1 ? "is" : "are"}` : ""}` : others.length ? `${others.length + 1} Jarhead records — also ${others.join(", ")} (a name-lookup like open -a Jarhead can pick one of them)` : `1 record: ${installed}`,
      required: false,
      fix: registered && others.length === 0 ? undefined : !registered ? rebuild : repair,
    });
  }
  const dock = audit.dock;
  if (dock.skipped) add({ group: "app", name: "dock", status: "warn", detail: dock.skipped, required: false });
  else {
    const before = dock.before;
    const needsFix = (before?.changes.length ?? 0) > 0;
    // No pin is nothing the fix can do (pinning is Kevin's), but a row that asks him to drag the app is not "ok".
    const unpinned = before !== undefined && before.pinned === 0;
    // A helper LaunchServices counts as a Foreground Jarhead is a tile `dock --fix` cannot remove: the fix is the rebuild.
    const helperTile = audit.running.helperTiles.length > 0;
    const fix = helperTile ? `${rebuild}, quit and relaunch Jarhead, then ${repair}` : needsFix ? repair : undefined;
    add({ group: "app", name: "dock", status: needsFix || unpinned || helperTile ? "warn" : "ok", detail: describeDock(before).replace(/^Dock: /, ""), required: false, fix });
  }
  return out;
}

/** " (build/Jarhead.app → symlink)" when the checkout's link points at the installed bundle. */
function linkTargetNote(installed: string): string {
  try {
    const target = readlinkSync(join(REPO_ROOT, "build", "Jarhead.app"));
    return target === installed ? " (build/Jarhead.app → symlink)" : ` (build/Jarhead.app → ${target}, not this bundle)`;
  } catch {
    return "";
  }
}

/**
 * What the memory extractor WILL run, and what the key's model list says about it.
 * The engine builds its ResponsesExtractor with `JARHEAD_MEMORY_MODEL` or, unset,
 * @jarhead/memory's DEFAULT_MEMORY_MODEL — nothing in the engine reads the model
 * list, so the doctor reports that id as fact and the key's best mini-class id (the
 * module's own `pickMemoryModel`, one rule, not a copy) only as the thing to pin.
 * Pure, so the table is a test.
 */
export interface ExtractorPlan {
  /** The id the extractor is built with: the override, else DEFAULT_MEMORY_MODEL. */
  readonly runs: string;
  readonly pinned: boolean;
  /** Whether `runs` appears in the key's list; undefined when there was no list to check. */
  readonly listed: boolean | undefined;
  /** The key's best mini-class Responses id by the memory module's rule; undefined when none is listed, or there was no list. */
  readonly best: string | undefined;
}

export function extractorPlan(modelIds: Iterable<string> | undefined, override: string | undefined): ExtractorPlan {
  const runs = override || DEFAULT_MEMORY_MODEL;
  const list = modelIds ? [...modelIds] : undefined;
  return { runs, pinned: Boolean(override), listed: list ? list.includes(runs) : undefined, best: list ? pickMemoryModel(list) : undefined };
}

/** What the memory rows need from the world, so they run in a test without a key, a daemon or a store on disk. */
export interface MemoryCheckInput {
  /** `Settings.memory` (settings.json; default on). */
  readonly enabled: boolean;
  readonly hasOpenAIKey: boolean;
  /** The key's model list from the one GET /v1/models; undefined = not fetched (no key, or the request failed). */
  readonly modelIds: ReadonlySet<string> | undefined;
  /** `JARHEAD_MEMORY_MODEL`. */
  readonly override: string | undefined;
  /** The running daemon's `snapshot.memory`; undefined = no daemon answering, or one from before the module. */
  readonly summary: MemorySummary | undefined;
  /** `<stateDir>/memory` and how many rows its append-only log holds; undefined rows = no store yet. */
  readonly storeDir: string;
  readonly storeRows: number | undefined;
  /**
   * `Settings.brain === "local"`: whether a server answers, and the listed model memory reads
   * conversations with ("" = none resolves: rules); undefined under every other kind. The engine's
   * target for a server that does not answer is keywords + rules, whatever the setting names.
   */
  readonly local?: { readonly reachable: boolean; readonly chat: string } | undefined;
}

/** "just now", "3 min ago", "2 h ago", "4 d ago" — the suffix is part of the word, so no caller writes "just now ago". */
export function agoWords(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/**
 * The `memory` group: what the durable memory holds and how it matches (from the
 * running daemon when one answers, else the store's row count), and which model
 * the extractor WILL run (the override or the module's default — reported as fact,
 * with the key's best mini only as the thing to pin). Off = one row, no extractor
 * row. Never opens a session, never calls the extractor; the
 * one network call it leans on is the key row's model list. The cost words are
 * honest: the budgets CAP what memory costs a prompt (≤ 250 brain / ≤ 120 voice
 * tokens); the saving is Kevin not re-explaining himself, not fewer prompt bytes.
 */
export function memoryChecks(input: MemoryCheckInput): Check[] {
  const out: Check[] = [];
  const local = input.local !== undefined;
  const offline = input.local !== undefined && !input.local.reachable;
  const chat = input.local?.chat ?? "";
  const matching = local
    ? offline
      ? "keywords · rules (no local server answering — nothing leaves for memory)"
      : `local (${chat || "rules"} on this Mac's server — nothing leaves for memory)`
    : input.hasOpenAIKey
      ? "openai embeddings (text-embedding-3-small, 512 dims)"
      : "keywords (no OPENAI_API_KEY — nothing leaves the Mac)";
  if (!input.enabled) {
    out.push({ group: "memory", name: "memory", status: "ok", detail: `off (Settings › Memory) — nothing is extracted, injected or embedded; the store under ${input.storeDir} stays as it is`, required: false });
  } else if (input.summary) {
    const m = input.summary;
    const learned = m.lastRunAt ? `learned ${agoWords(m.lastRunAt)}${m.lastRun ? ` (+${m.lastRun.added} · ~${m.lastRun.updated} · ${m.lastRun.noop} noop · ${m.lastRun.extractor})` : ""}` : "not learned yet (runs after a conversation closes, at a quiet moment)";
    const waiting = m.pending ? ` · ${m.pending} conversation${m.pending === 1 ? "" : "s"} waiting` : "";
    const spent = m.budgetUsed ? ` · last prompts ${m.budgetUsed.brain} brain / ${m.budgetUsed.voice} voice tokens` : "";
    // Under the local brain the daemon's summary names the space: which embedding model, how wide, which model reads — nothing leaves for memory.
    const how = m.embeddings === "local" ? `local embeddings (${m.embeddingModel ?? "a local model"}, ${m.embeddingDims ?? "?"} dims) · extractor ${chat || "rules"} — nothing leaves for memory` : local && m.embeddings === "keyword" ? `keywords · ${offline ? "rules (no local server answering)" : `extractor ${chat || "rules"}`} — nothing leaves for memory` : m.embeddings;
    out.push({
      group: "memory",
      name: "memory",
      status: m.enabled ? "ok" : "warn",
      detail: `${m.count} remembered · ${m.forgotten} forgotten · ${m.archived} archived · matching ${how} · ${learned}${waiting}${spent} (caps ${BRAIN_MEMORY_TOKENS} brain / ${VOICE_MEMORY_TOKENS} voice tokens per prompt)`,
      required: false,
      fix: m.enabled ? undefined : "the daemon reports memory off while settings.json says on — restart the daemon or flip Settings › Memory",
    });
  } else {
    const store = input.storeRows === undefined ? `no store yet at ${input.storeDir} (it appears after the first closed conversation)` : `${input.storeRows} row${input.storeRows === 1 ? "" : "s"} in ${join(input.storeDir, "memory.jsonl")} (counts come from a running daemon)`;
    out.push({ group: "memory", name: "memory", status: "ok", detail: `on · matching ${matching} · ${store} · caps ${BRAIN_MEMORY_TOKENS} brain / ${VOICE_MEMORY_TOKENS} voice tokens per prompt`, required: false });
  }
  // Off is Kevin's choice: no extractor row, nothing is configured to run.
  if (!input.enabled) return out;
  // Under the local brain the extractor is the brain's model on this Mac (Chat Completions JSON mode); the OpenAI plan does not apply.
  // No server answering is rules, whatever model the setting names — the fix is the server, not the pick.
  if (local) {
    const detail = offline ? "rules (no local server answering) — nothing leaves for memory" : chat ? `runs ${chat} on the local server (Chat Completions JSON mode; rules when it cannot answer) — nothing leaves for memory` : "rules until the local brain has a model (pick one, or pull a tool-capable model)";
    out.push({ group: "memory", name: "extractor", status: !offline && chat ? "ok" : "warn", detail, required: false, ...(offline ? { fix: OPEN_OLLAMA } : {}) });
    return out;
  }
  const plan = extractorPlan(input.modelIds, input.override);
  const via = plan.pinned ? "JARHEAD_MEMORY_MODEL" : "the memory module's default";
  const spend = "Dollars on the key, never the ChatGPT plan; ≤ 5 runs a day, ≤ ~8k in + 0.9k out each";
  const pin = plan.best && plan.best !== plan.runs ? (plan.pinned ? ` — the key also lists ${plan.best}` : ` — the key's best mini-class id is ${plan.best}: pin it with JARHEAD_MEMORY_MODEL=${plan.best}`) : "";
  if (!input.hasOpenAIKey) {
    out.push({ group: "memory", name: "extractor", status: "ok", detail: "rules (regex over Kevin's lines) — no OPENAI_API_KEY; with one, a mini-class Responses model reads each closed conversation once", required: false });
  } else if (plan.listed === false) {
    out.push({
      group: "memory",
      name: "extractor",
      status: "warn",
      detail: `runs ${plan.runs} (${via}) — not listed for this key, so every run falls back to rules with one warning`,
      required: false,
      fix: plan.best ? `pin JARHEAD_MEMORY_MODEL=${plan.best} in ~/.jarhead/env (the key's best mini-class Responses id)` : "set JARHEAD_MEMORY_MODEL in ~/.jarhead/env to a Responses model the key lists, or leave the rules extractor to it",
    });
  } else if (plan.listed === true) {
    out.push({ group: "memory", name: "extractor", status: "ok", detail: `runs ${plan.runs} (${via}, listed for this key)${pin}. ${spend}`, required: false });
  } else {
    // No list: the keys row already says why. A pin is Kevin's word; the default is only unverified.
    out.push({
      group: "memory",
      name: "extractor",
      status: plan.pinned ? "ok" : "warn",
      detail: `runs ${plan.runs} (${via}, not checked: the key's model list could not be read) — a wrong id falls back to rules with one warning`,
      required: false,
    });
  }
  return out;
}

/** What the `local` rows need: the one look at the server (the daemon's, or the doctor's own), and the brain setting. */
export interface LocalCheckInput {
  readonly status: LocalServerStatus;
  readonly brain: BrainKind;
  readonly brainModel: string;
  /** `Settings.brainBaseUrl` under `local`: a pinned root, named in the server row. */
  readonly brainBaseUrl?: string | undefined;
  /** The running daemon's memory summary, for the embedding model's measured dims. */
  readonly memory?: MemorySummary | undefined;
}

const LOCAL_ROOTS = "127.0.0.1:11434, :1234, :8080";
const OPEN_OLLAMA = "open Ollama.app — or brew install --cask ollama-app; see docs/LOCAL.md";

/** A model's bytes as the rows say them: "17 GB" (decimal, as Ollama lists it). */
function gbWords(bytes: number | undefined): string {
  return bytes === undefined ? "? GB" : `${Math.round(bytes / 1e9)} GB`;
}

/** This Mac's memory as it is sold: "128 GB" (GiB-rounded). */
function ramWords(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`;
}

/**
 * The `local` group — `server`, and under `brain === "local"` also `model` and `embeddings`.
 * Read-only: every fix is a command Kevin runs himself (an `ollama pull`, opening the app); the
 * doctor never spawns `ollama` or `brew`. Advisory throughout (`required: false`): a Mac without
 * a local server is a Mac on the cloud brains, not a broken one.
 */
export function localChecks(input: LocalCheckInput): Check[] {
  const out: Check[] = [];
  const { status, brain, brainModel } = input;
  const local = brain === "local";
  const pinned = input.brainBaseUrl?.trim();
  if (!status.reachable) {
    out.push({ group: "local", name: "server", status: "warn", detail: pinned ? `not answering at ${pinned}` : `not running (${LOCAL_ROOTS})`, required: false, fix: OPEN_OLLAMA });
    if (local) out.push({ group: "local", name: "model", status: "warn", detail: `${brainModel || "the best fit"} waits for a server — until one answers the brain's work goes to OpenAI (memory stays on the Mac)`, required: false, fix: OPEN_OLLAMA });
    return out;
  }
  const server = serverLabel(status);
  const host = status.baseUrl.replace(/^https?:\/\//, "");
  // Discovery lists the chat models only (a cloud tag or an embedding-only model is never in `models`); the embedding model has its own row below.
  const models = status.models;
  const withTools = models.filter((m) => m.capabilities.includes("tools"));
  out.push({ group: "local", name: "server", status: "ok", detail: `${server} @ ${host}${pinned ? " (pinned)" : ""} · ${models.length} model${models.length === 1 ? "" : "s"} · ${withTools.length} with tools`, required: false });
  if (!local) return out;
  const resolved = resolveLocalModel(brainModel, status);
  const ram = ramWords(status.ramBytes);
  if ("error" in resolved) {
    if (!brainModel.trim()) {
      const s = status.suggested ?? suggestedPull(status.ramBytes);
      out.push({ group: "local", name: "model", status: "fail", detail: `nothing on ${server} can call tools`, required: false, fix: status.flavor === "ollama" ? `${s.command}  (${gbWords(s.sizeBytes)}, fits this Mac's ${ram})` : "load a model that can call tools" });
    } else if (/ is not on /.test(resolved.error)) {
      out.push({ group: "local", name: "model", status: "fail", detail: `${brainModel} not listed on ${server}${withTools.length ? ` (with tools: ${withTools.slice(0, 3).map((m) => m.id).join(", ")})` : ""}`, required: false, fix: resolved.copy ?? "pick a listed model in Settings › Brain" });
    } else if (/cannot call tools/.test(resolved.error)) {
      out.push({ group: "local", name: "model", status: "fail", detail: `${brainModel} cannot call tools${withTools.length ? ` — with tools: ${withTools.slice(0, 3).map((m) => m.id).join(", ")}` : ""}`, required: false, fix: withTools.length ? `pick one of ${withTools.slice(0, 3).map((m) => m.id).join(", ")} in Settings › Brain, or pnpm jarhead brain local ${withTools[0]!.id}` : (status.suggested ?? suggestedPull(status.ramBytes)).command });
    } else {
      out.push({ group: "local", name: "model", status: "fail", detail: resolved.error, required: false, fix: "pick a listed model in Settings › Brain" });
    }
  } else {
    const m = resolved.model;
    const trained = m.contextLength;
    const asks = trained === undefined ? LOCAL_NUM_CTX_MAX : trained < LOCAL_NUM_CTX_MIN ? trained : Math.min(trained, LOCAL_NUM_CTX_MAX);
    const window = trained === undefined ? `Jarhead asks ${asks}` : `trained ${trained}, Jarhead asks ${asks}${trained < LOCAL_NUM_CTX_MIN ? " (small: Jarhead's tools alone are ~11k tokens)" : ""}`;
    const facts = `${m.capabilities.filter((c) => c !== "completion").join(" ") || "completion"} · ${window} · ${gbWords(m.sizeBytes)} of ${ram}`;
    out.push({
      group: "local",
      name: "model",
      status: resolved.picked ? "warn" : "ok",
      detail: resolved.picked ? `best fit ${m.id} (nothing picked) · ${facts}` : `${m.id} · ${facts}`,
      required: false,
      fix: resolved.picked ? `pick it once in Settings › Brain › Model (or pnpm jarhead brain local ${m.id}) so a newer pull cannot move the choice` : undefined,
    });
  }
  const embed = status.embedModel;
  if (embed) {
    const dims = input.memory?.embeddings === "local" && input.memory.embeddingDims ? ` · ${input.memory.embeddingDims} dims` : "";
    out.push({ group: "local", name: "embeddings", status: "ok", detail: `${embed}${dims} · local`, required: false });
  } else {
    const first = EMBED_PREFERENCE[0] ?? "embeddinggemma";
    out.push({ group: "local", name: "embeddings", status: "warn", detail: `keyword matching until an embedding model is pulled (${first}, ~300 MB)`, required: false, fix: status.flavor === "ollama" ? `ollama pull ${first}` : `load an embedding model (${EMBED_PREFERENCE.join(", ")})` });
  }
  return out;
}

/** What the doctor knows of the daemon it diagnoses: the `setup` of its first snapshot, when one answered. */
export interface RunningDaemon {
  readonly setup: SetupStatus | undefined;
}

/**
 * The `local › daemon` row: a warn when the daemon on the socket answers without `setup.local` — a
 * build from before the local brain, which the rest of the doctor tolerates quietly (its own look
 * at the server, its own data paths) and which would take a `local` pick and land on Responses
 * without a word. Nothing when no daemon answered, or when it carries the field.
 */
export function staleDaemonCheck(running: RunningDaemon | undefined): Check | undefined {
  if (!running || running.setup?.local !== undefined) return undefined;
  return {
    group: "local",
    name: "daemon",
    status: "warn",
    detail: "the daemon on the socket predates this build (its snapshot has no setup.local) — the rows below are the doctor's own look, and `jarhead brain <kind>` refuses a pick until it is restarted",
    required: false,
    fix: "quit and reopen Jarhead.app (or restart jarheadd) so the bundled daemon runs",
  };
}

/** What `memorySummaryWithoutDaemon` reads: the memory setting, the brain setting, the doctor's look at the server, and whether a key is present. */
export interface MemoryWithoutDaemonInput {
  readonly enabled: boolean;
  readonly brain: BrainKind;
  readonly local: LocalServerStatus;
  readonly hasOpenAIKey: boolean;
}

/**
 * The memory summary the engine would report, from what the doctor already read, for the privacy
 * rows when no daemon answers: under `local`, local embeddings when the server answers with an
 * embedding model, else keywords; under every other kind, OpenAI embeddings with a key, keywords
 * without. `dataPaths()` maps an absent summary to "memory is off", which the doctor's own memory
 * group two rows up contradicts — so the summary is never absent here.
 */
export function memorySummaryWithoutDaemon(i: MemoryWithoutDaemonInput): Pick<MemorySummary, "enabled" | "embeddings" | "embeddingModel"> {
  const localEmbed = i.brain === "local" && i.local.reachable ? i.local.embedModel : undefined;
  const embeddings: MemorySummary["embeddings"] = i.brain === "local" ? (localEmbed ? "local" : "keyword") : i.hasOpenAIKey ? "openai" : "keyword";
  return { enabled: i.enabled, embeddings, ...(localEmbed ? { embeddingModel: localEmbed } : {}) };
}

/** The `privacy` group: one row per data path, `ok` always — they inform. The same rows the Console's "Leaves the Mac" shows, from the same function. */
export function privacyChecks(paths: readonly DataPath[]): Check[] {
  return paths.map((p) => ({ group: "privacy", name: p.what, status: "ok" as const, detail: `${p.where} · ${p.detail}`, required: false }));
}

// ---- automations: what the daemon carries out while asleep, and what stands in its way

/** The schedule's journal as the doctor read it: present with its counts, absent, or unreadable. */
export type JournalRead =
  | { readonly path: string; readonly rows: number; readonly live: number }
  | { readonly path: string; readonly missing: true }
  | { readonly path: string; readonly error: string };

/** What the `automations` rows need from the world, so they run in a test without a daemon, a journal or a Mac. */
export interface AutomationCheckInput {
  /** `Settings.automations` — the daemon's when one answers, else settings.json over the defaults. */
  readonly settings: AutomationSettings;
  /** The running daemon's non-trashed rows; undefined = no daemon answering (or one from before the field). */
  readonly rows: readonly Automation[] | undefined;
  readonly nextFire: Snapshot["nextFire"] | undefined;
  readonly journal: JournalRead;
  /** The Notifications grant as the app read it; undefined = no daemon answering. */
  readonly notifications: Grant | undefined;
  /** The three folder grants as the app read them (absent = not read). */
  readonly folderGrants: Partial<Record<"filesDesktop" | "filesDocuments" | "filesDownloads", Grant>>;
  /** `automation.missed` rows over the last seven day files, and why. */
  readonly missed: { readonly count: number; readonly why: readonly MissedWhy[] };
  /** Today's `automation.fired { brainSeconds }` summed. */
  readonly brainSecondsToday: number;
  /** Whether entitlements.plist carries the time-sensitive key. */
  readonly timeSensitive: boolean;
  /** `pmset -g sched` as READ (a read needs no root); undefined = not read. Nothing here ever runs a `pmset` that changes anything. */
  readonly pmsetSched: string | undefined;
  readonly now: number;
  readonly home: string;
}

/** Why a fire was missed, in words. */
const MISSED_WORDS: Readonly<Record<MissedWhy, string>> = { "mac-slept": "the Mac slept", "daemon-down": "Jarhead was off", "quiet-hours": "quiet hours", budget: "brain minutes were spent" };

/** pmset's weekday letters: M T W R F S U. */
const PMSET_DAY: Readonly<Record<Weekday, string>> = { mon: "M", tue: "T", wed: "W", thu: "R", fri: "F", sat: "S", sun: "U" };
const WEEKDAY_ORDER: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
/** How long before the alarm the Mac should be awake. */
const PMSET_LEAD_MS = 5 * 60_000;

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** The alarm grace in minutes, for the wake row's words. */
const AUTOMATION_GRACE_ALARM_MIN = AUTOMATION_GRACE_MS.alarm / 60_000;
/** States a watcher is not watching in: the terminal set plus paused. */
const NOT_WATCHING = new Set<Automation["state"]>(["done", "trashed", "paused"]);

/**
 * The `pmset` line that would wake a closed lid for an alarm — printed as a `copy`, never run
 * (root; `pmset` is confirm-tier for the brain and never a surface's to execute). A weekly
 * alarm is `repeat wakeorpoweron <days> HH:mm:ss`; a one-shot is `schedule wake "MM/dd/yy HH:mm:ss"`.
 * Both five minutes early. Exported so the test pins the exact text.
 */
export function pmsetCopy(a: Pick<Automation, "when" | "nextAt">): string | undefined {
  if (a.when.kind === "every" && a.when.every.kind === "weekly") {
    const r = a.when.every;
    const days = WEEKDAY_ORDER.filter((d) => r.days.includes(d)).map((d) => PMSET_DAY[d]).join("");
    const [hh, mm] = r.at.split(":").map(Number);
    const total = ((hh ?? 0) * 60 + (mm ?? 0) - 5 + 1440) % 1440;
    return `sudo pmset repeat wakeorpoweron ${days} ${pad2(Math.floor(total / 60))}:${pad2(total % 60)}:00`;
  }
  if (a.nextAt === undefined) return undefined;
  const d = new Date(a.nextAt - PMSET_LEAD_MS);
  return `sudo pmset schedule wake "${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${String(d.getFullYear()).slice(2)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:00"`;
}

/** Whether a folder path sits under one of the three TCC-guarded folders. */
function guardedFolder(path: string, home: string): "filesDesktop" | "filesDocuments" | "filesDownloads" | undefined {
  const p = expandPath(path, home);
  for (const [folder, kind] of [["Desktop", "filesDesktop"], ["Documents", "filesDocuments"], ["Downloads", "filesDownloads"]] as const) {
    const root = join(home, folder);
    if (p === root || p.startsWith(`${root}/`)) return kind;
  }
  return undefined;
}

/**
 * The `automations` group — advisory throughout (`required: false`; a Mac with nothing set is
 * not broken). Every row is a function of one input; every fix is a press or a command Kevin
 * makes himself. The `wake for HH:MM` row carries the `pmset` line as text to copy — the doctor
 * READS `pmset -g sched` to see whether one is already scheduled and never runs one that
 * changes anything. The standing line: nothing fires while Jarhead is quit.
 */
export function automationChecks(input: AutomationCheckInput): Check[] {
  const out: Check[] = [];
  const g = "automations";
  const add = (c: Omit<Check, "group" | "required">): void => void out.push({ group: g, required: false, ...c });
  const { settings, rows, now } = input;

  // enabled: the master switch, the counts and the next fire.
  const journalLive = "live" in input.journal ? input.journal.live : undefined;
  if (!settings.enabled) {
    add({ name: "enabled", status: "warn", detail: `off (Settings › Automations) — nothing fires; every row stays${rows ? ` (${rows.length} set)` : ""}`, fix: "Settings › Automations › the switch, when you want them back" });
  } else if (rows === undefined) {
    add({ name: "enabled", status: "ok", detail: `on · ${journalLive === undefined ? "no daemon answering" : `${journalLive} live in the journal`} — the rows and the next fire come from a running daemon` });
  } else if (rows.length === 0) {
    add({ name: "enabled", status: "ok", detail: "on · nothing set — say \"wake me at 7:10 on weekdays\", or pnpm jarhead automations add \"at 7:10 weekdays chime 'Wake up'\"" });
  } else {
    const armed = rows.filter((a) => a.state === "armed" || a.state === "snoozed" || a.state === "deferred").length;
    const next = input.nextFire ? ` · next ${clockOf(input.nextFire.at)} ${input.nextFire.name} (${inWords(input.nextFire.at, now)})` : rows.some((a) => a.when.kind === "on") ? " · watching" : "";
    add({ name: "enabled", status: "ok", detail: `${rows.length} set · ${armed} armed${next}` });
  }

  // journal: the schedule on disk (append-only; last row per id wins).
  const j = input.journal;
  if ("error" in j) add({ name: "journal", status: "fail", detail: `${j.path} unreadable (${j.error}) → nothing fires until it is`, fix: "Open Console — the Now rail says what the daemon could load; a journal the daemon cannot read is never rewritten by it" });
  else if ("missing" in j) add({ name: "journal", status: "ok", detail: `no journal yet at ${j.path} (it appears with the first automation)` });
  else add({ name: "journal", status: "ok", detail: `${j.path} · ${j.live} live · ${j.rows} row${j.rows === 1 ? "" : "s"}` });

  // daemon: the honest line.
  if (settings.openAtLogin) add({ name: "daemon", status: "ok", detail: "Open at login is on — Jarhead and its daemon come back at login; nothing fires while Jarhead is quit" });
  else add({ name: "daemon", status: "warn", detail: "nothing fires while Jarhead is quit — Open at login is off", fix: "Settings › Automations › Open at login" });

  // banners: the grant; the island and the chime do not need it.
  if (input.notifications === "granted") add({ name: "banners", status: "ok", detail: "Notifications granted — Snooze · Done on the banner land the same row as the island's" });
  else if (input.notifications === undefined) add({ name: "banners", status: "warn", detail: "Notifications not read (no daemon answering) — the island and the chime still fire" });
  else add({ name: "banners", status: "warn", detail: `Notifications ${input.notifications === "denied" ? "not granted" : "not asked yet"} — the island and the chime still fire`, fix: "pnpm jarhead cmd request-permission notifications (the app puts up the system prompt; Setup › Permissions › Notifications and the automation.notifications problem's Request button do the same)" });

  // wake for HH:MM: the earliest armed alarm; a closed lid sleeps through it unless pmset says otherwise.
  const alarm = (rows ?? [])
    .filter((a) => automationKind(a) === "alarm" && (a.state === "armed" || a.state === "snoozed") && a.nextAt !== undefined)
    .sort((x, y) => (x.nextAt ?? 0) - (y.nextAt ?? 0))[0];
  if (alarm && alarm.nextAt !== undefined) {
    const at = clockOf(alarm.nextAt);
    const scheduled = input.pmsetSched !== undefined && /wake/i.test(input.pmsetSched);
    const copy = pmsetCopy(alarm);
    if (scheduled) add({ name: `wake for ${at}`, status: "ok", detail: `pmset schedules a wake (pmset -g sched: ${input.pmsetSched?.trim().split("\n").find((l) => /wake/i.test(l))?.trim() ?? "a wake"}) — check it covers ${at}` });
    else add({ name: `wake for ${at}`, status: "warn", detail: `a closed lid sleeps through ${at} — the alarm rings late (within ${AUTOMATION_GRACE_ALARM_MIN} min) or is missed; the Mac is never woken by Jarhead`, ...(copy ? { fix: `copy (root; never run by Jarhead): ${copy}` } : {}) });
  }

  // quiet hours.
  const q = settings.quietHours;
  add({ name: "quiet hours", status: "ok", detail: q ? `${q.from}–${q.to} · alarms override; chime/say show silently; acting kinds wait` : "none set — everything fires as set" });

  // missed: the last seven day files.
  if (input.missed.count === 0) add({ name: "missed", status: "ok", detail: "0 in 7 days" });
  else {
    const why = [...new Set(input.missed.why)].map((w) => MISSED_WORDS[w]).join(", ");
    add({ name: "missed", status: "warn", detail: `${input.missed.count} missed in 7 days${why ? ` · ${why}` : ""}`, fix: "Run now on the row (Console › Now · the automation.missed problem · pnpm jarhead automations run <id|name>)" });
  }

  // brain budget: wake-brain minutes today.
  const cap = settings.wakeBudgetMinutesPerDay;
  const usedMin = Math.ceil(input.brainSecondsToday / 60);
  const wakeRows = (rows ?? []).filter((a) => a.then.some((t) => t.kind === "wake-brain")).length;
  if (cap <= 0) add({ name: "brain budget", status: "ok", detail: "wake-brain off (Brain minutes 0) — no automation wakes the brain; nothing is billed asleep" });
  else if (usedMin >= cap) add({ name: "brain budget", status: "warn", detail: `spent — ${usedMin} of ${cap} min used today; wake-brain rows fail until midnight (a failed row, never a question)`, fix: "Settings › Automations › Brain minutes, or wait for midnight" });
  else add({ name: "brain budget", status: "ok", detail: `${wakeRows === 0 ? "wake-brain unused" : `${wakeRows} wake-brain row${wakeRows === 1 ? "" : "s"}`} · ${usedMin} of ${cap} min used today` });

  // recipes: the gate's word for each, now.
  const recipes = settings.recipes;
  if (recipes.length === 0) add({ name: "recipes", status: "ok", detail: "none — a recipe is a shell command you approved once; the gate re-judges it at every fire" });
  else {
    const judged = recipes.map((r) => ({ r, v: recipeVerdict(r, input.home) }));
    const asks = judged.filter((x) => x.v.word !== "run");
    const names = asks.map((x) => `${x.r.name}: ${x.v.word === "asks" ? "would need a yes when it runs" : x.v.reason}`).join("; ");
    add({ name: "recipes", status: asks.length ? "warn" : "ok", detail: `${recipes.length} · ${recipes.length - asks.length} run-tier${asks.length ? ` · ${asks.length} ${asks.length === 1 ? "asks" : "ask"} (${names})` : ""}`, ...(asks.length ? { fix: "a recipe the gate now rates confirm or refuse fails at fire; edit it so the gate says run (no destructive verb, mv/cp -n), or Move to Trash" } : {}) });
  }

  // time-sensitive banners: pass 1 notes it.
  add(input.timeSensitive ? { name: "time-sensitive", status: "ok", detail: "entitlement present — alarm banners may break through Focus" } : { name: "time-sensitive", status: "warn", detail: "entitlement absent — alarm banners honour Focus like any banner (the island and the chime still fire)" });

  // folder grant: a watched Downloads/Desktop/Documents needs its grant.
  if (rows) {
    const watched = new Map<"filesDesktop" | "filesDocuments" | "filesDownloads", string>();
    for (const a of rows) {
      if (a.when.kind !== "on" || NOT_WATCHING.has(a.state)) continue;
      const path = a.when.on.kind === "folder.file" ? a.when.on.path : a.when.on.kind === "download.done" ? "~/Downloads" : undefined;
      const kind = path ? guardedFolder(path, input.home) : undefined;
      if (kind && !watched.has(kind)) watched.set(kind, path ?? "");
    }
    if (watched.size === 0) add({ name: "folder grant", status: "ok", detail: "no guarded folder watched" });
    for (const [kind, path] of watched) {
      const grant = input.folderGrants[kind];
      const folder = kind.replace(/^files/, "");
      if (grant === "granted") add({ name: "folder grant", status: "ok", detail: `watching ${path} · the ${folder} folder grant is on` });
      else add({ name: "folder grant", status: "warn", detail: `watching ${path} needs the ${folder} folder grant${grant === undefined ? " (not read)" : ""} — a denied read is the automation.watch problem, never a silent watcher`, fix: "Ask (the automation.watch problem's button; Setup › Permissions)" });
    }
  }
  return out;
}

/** The journal on disk: rows, and live rows by last-row-per-id with state ≠ trashed. Never rewritten here. */
export function readJournal(path: string): JournalRead {
  if (!existsSync(path)) return { path, missing: true };
  try {
    const text = readFileSync(path, "utf8");
    const last = new Map<string, string>();
    let rows = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      rows++;
      try {
        const row = JSON.parse(line) as { id?: unknown; state?: unknown };
        if (typeof row.id === "string" && typeof row.state === "string") last.set(row.id, row.state);
      } catch {
        // a torn last line is not a broken journal
      }
    }
    return { path, rows, live: [...last.values()].filter((s) => s !== "trashed").length };
  } catch (e) {
    return { path, error: (e as Error).message };
  }
}

/** The automations block as settings.json has it, over the defaults; the defaults alone when the file is missing or torn. */
export function readAutomationSettings(stateDir: string): AutomationSettings {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as { automations?: Partial<AutomationSettings> };
    return { ...DEFAULT_AUTOMATIONS, ...(saved.automations ?? {}) };
  } catch {
    return DEFAULT_AUTOMATIONS;
  }
}

/** The ledger's automation rows over `days` day files: missed count and why, and today's wake-brain seconds. Read-only. */
export function readAutomationLedger(ledger: Pick<Ledger, "read">, now: number, days = 7): { missed: { count: number; why: MissedWhy[] }; brainSecondsToday: number } {
  const why: MissedWhy[] = [];
  let count = 0;
  let brainSecondsToday = 0;
  for (let d = 0; d < days; d++) {
    for (const row of ledger.read(now - d * 86_400_000)) {
      if (row.type === "automation.missed") {
        count++;
        why.push(row.why);
      } else if (d === 0 && row.type === "automation.fired" && row.brainSeconds) {
        brainSecondsToday += row.brainSeconds;
      }
    }
  }
  return { missed: { count, why }, brainSecondsToday };
}

// ---- words shared with `jarhead status` (main.ts runs on import, so they live here, where a test can reach them)

/** Every AgentStatus, checked against the protocol's union so a new status cannot go unlisted on `jarhead status`. */
export const AGENT_STATUSES: readonly AgentStatus[] = Object.keys({ working: 0, idle: 0, blocked: 0, done: 0, ended: 0, unknown: 0, offline: 0 } satisfies Record<AgentStatus, 0>) as AgentStatus[];

/** "3 working · 1 blocked · 8 ended" — the statuses present, in AGENT_STATUSES order; "" when none. `ended` and `unknown` are listed apart: no live process vs evidence missing. */
export function agentsByStatus(agents: readonly Pick<AgentInfo, "status">[]): string {
  const counts = new Map<AgentStatus, number>();
  for (const a of agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  return AGENT_STATUSES.filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(" · ");
}

/** One line for `jarhead status`: what the durable memory holds and when it last learned; the cost words are the caps, not a saving. */
export function memoryLine(m: MemorySummary | undefined, now = Date.now()): string {
  if (!m) return "(no summary in the snapshot)";
  if (!m.enabled) return "off — nothing is extracted, injected or embedded; the store stays as it is";
  const parts = [`${m.count} remembered`, `${m.forgotten} forgotten`, `${m.archived} archived`, `matching ${m.embeddings}`];
  if (m.pending) parts.push(`${m.pending} conversation${m.pending === 1 ? "" : "s"} waiting`);
  parts.push(m.lastRunAt ? `learned ${agoWords(m.lastRunAt, now)}${m.lastRun ? ` (+${m.lastRun.added} · ~${m.lastRun.updated} · ${m.lastRun.extractor})` : ""}` : "never learned yet");
  if (m.budgetUsed) parts.push(`last prompts ${m.budgetUsed.brain} brain / ${m.budgetUsed.voice} voice tokens (caps ${BRAIN_MEMORY_TOKENS} / ${VOICE_MEMORY_TOKENS})`);
  if (m.lastUsedIds?.length) parts.push(`${m.lastUsedIds.length} used this turn`);
  return parts.join(" · ");
}

/** A memory item's id as the store mints it (core `newId("m")`: "m_", base-36 time, six characters). The CLI refuses anything else before a socket is opened. */
export const MEMORY_ID = /^m_[A-Za-z0-9]{6,40}$/;

/** Rows in the memory store's append-only log; undefined when there is no store. Line count only — never the contents. */
function memoryStoreRows(dir: string): number | undefined {
  try {
    const text = readFileSync(join(dir, "memory.jsonl"), "utf8");
    return text.length === 0 ? 0 : text.split("\n").filter((l) => l.length > 0).length;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ audio (design12)
//
// The `audio` group and the `status` block, from the app's read-back frame (`Snapshot.audioState`),
// the one setting (`Settings.audio`), a read-only `system_profiler` pass and the probe's JSON.
// Advisory throughout (`required: false`): nothing here opens a session, touches the microphone
// or plays a sound — `--test-audio` shells to builder D's probe, which refuses while Jarhead is awake.

/** Below this the default output is on a Bluetooth headset's hands-free codec (16 000 / 8 000 Hz). */
export const NARROWED_BELOW_HZ = 44_100;
/** The guard's residual on the wire after `audibleUntil + tail`: louder than this and Live would hear Jarhead. */
export const LEAK_FAIL_DBFS = -50;
export const AUDIO_PROBE_FILE = "audio-probe.json";
export const AUDIO_PROBE_SCRIPT = join(REPO_ROOT, "apps", "mac", "Scripts", "audio-probe.sh");
/** Rewritten by every build: the probe's figures are stale once this is newer than the run. */
export const APP_BUILD_MARK = join(INSTALLED_APP, "Contents", "Info.plist");

/** The HAL's transport as one word — from the app's word or its four-char code, or system_profiler's `coreaudio_device_type_*`. */
export function transportWord(t: string | undefined): string {
  const k = (t ?? "").replace(/^coreaudio_device_type_/, "").trim().toLowerCase();
  switch (k) {
    case "blue":
    case "bluetooth":
    case "bluetoothle":
      return "bluetooth";
    case "bltn":
    case "builtin":
    case "built-in":
      return "built-in";
    case "cont":
    case "continuity":
      return "continuity";
    case "grup":
    case "aggregate":
      return "aggregate";
    case "":
      return "unknown";
    default:
      return k;
  }
}

/** AUVoiceIOOtherAudioDuckingLevel as a word: 0 default · 10 min · 20 mid · 30 max. */
export function duckWord(level: number | undefined): string {
  if (level === undefined) return "—";
  return level === 0 ? "default" : level === 10 ? "min" : level === 20 ? "mid" : level === 30 ? "max" : `level ${level}`;
}

function onOff(b: boolean | undefined): string {
  return b === undefined ? "?" : b ? "on" : "off";
}

/** The `speaks` state word: a headset below 44.1 kHz is on the hands-free codec, and every app hears it. */
export function speaksState(d: AudioDeviceInfo): string {
  return d.rate >= NARROWED_BELOW_HZ ? "full quality" : "narrowed while the headset mic is held";
}

function hzWords(d: AudioDeviceInfo): string {
  return `${d.rate} Hz ×${d.channels}`;
}

/** ≤ 2 names, then "+ n". */
export function sharedWords(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} + ${names.length - 2}` : shown;
}

/** The `hears` state word: what the graph follows, and who else holds the mic. */
function hearsState(s: AudioState): string {
  const shared = s.sharedWith?.length ? `shared with ${sharedWords(s.sharedWith)}` : "";
  if (s.voiceProcessing) return shared ? `follows the system default · ${shared}` : "follows the system default";
  return shared || "ranked";
}

/** The knobs as one line, shared by the status head and the doctor's `voice processing` row. */
export function voiceProcessingWords(s: AudioState): string {
  if (!s.running) return `off · the graph is down${s.voiceProcessing ? " · voice processing still on" : ""}`;
  if (s.voiceProcessing) return `on · duck ${duckWord(s.duckLevel)} ${s.advancedDucking === false ? "plain" : "advanced"} · agc ${onOff(s.agc)} · bypass ${onOff(s.bypassed)} · rung ${s.rung} ${s.wiring}`;
  return `off · ${s.recording ? "recording" : "fallback (echo cancellation refused)"} · guard ${onOff(s.guardOn)} · rung ${s.rung} ${s.wiring}`;
}

/** The guard's counters as one line: `guard tail 420 ms · held 3.2 s · gated 12 of 340 · 1 break`. */
export function guardWords(s: AudioState): string {
  const held = s.guardHeldMs !== undefined ? ` · held ${(s.guardHeldMs / 1000).toFixed(1)} s` : "";
  return `guard tail ${s.guardTailMs} ms${held} · gated ${s.gated} of ${s.chunks} · ${s.breakthroughs} ${s.breakthroughs === 1 ? "break" : "breaks"}`;
}

function clockWords(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

// ---- system_profiler SPAudioDataType -json (read-only, ≈ 1 s): the fallback when no app is connected, and the default-input name for the rows.

export interface AudioProfilerDevice {
  readonly name: string;
  readonly rate: number;
  readonly channels: number;
  readonly transport: string;
  readonly input: boolean;
  readonly output: boolean;
  readonly defaultInput: boolean;
  readonly defaultOutput: boolean;
}

export interface AudioProfilerRead {
  readonly devices: readonly AudioProfilerDevice[];
  readonly defaultInput?: AudioProfilerDevice;
  readonly defaultOutput?: AudioProfilerDevice;
  /** The first built-in input — the mic the `hears` fix names. */
  readonly builtInInput?: AudioProfilerDevice;
  /**
   * A `VPAUAggregateAudioDevice-*` device is listed: the voice-processing unit's aggregate is still
   * up. Not `CADefaultDeviceAggregate-*` — that one is AVAudioEngine's own default-device aggregate
   * and is present whenever Jarhead.app merely runs on a Mac whose default input ≠ default output.
   */
  readonly aggregatePresent: boolean;
}

/** The voice-processing unit's aggregate, by uid/name prefix (the engine's own is `CADefaultDeviceAggregate-<pid>-n`, a different thing). */
export const UNIT_AGGREGATE_PREFIX = "VPAUAggregateAudioDevice";

/** `system_profiler SPAudioDataType -json` as the rows read it; undefined when the text is not that. */
export function parseAudioProfiler(text: string): AudioProfilerRead | undefined {
  let root: { SPAudioDataType?: { _items?: Record<string, unknown>[] }[] };
  try {
    root = JSON.parse(text) as typeof root;
  } catch {
    return undefined;
  }
  const groups = root.SPAudioDataType;
  if (!Array.isArray(groups)) return undefined;
  const devices: AudioProfilerDevice[] = [];
  for (const g of groups) {
    for (const it of g._items ?? []) {
      const name = typeof it["_name"] === "string" ? it["_name"] : "";
      if (!name) continue;
      const inCh = Number(it["coreaudio_device_input"]) || 0;
      const outCh = Number(it["coreaudio_device_output"]) || 0;
      devices.push({
        name,
        rate: Number(it["coreaudio_device_srate"]) || 0,
        channels: inCh || outCh,
        transport: transportWord(typeof it["coreaudio_device_transport"] === "string" ? it["coreaudio_device_transport"] : undefined),
        input: inCh > 0,
        output: outCh > 0,
        defaultInput: it["coreaudio_default_audio_input_device"] === "spaudio_yes",
        defaultOutput: it["coreaudio_default_audio_output_device"] === "spaudio_yes",
      });
    }
  }
  const defaultInput = devices.find((d) => d.defaultInput);
  const defaultOutput = devices.find((d) => d.defaultOutput);
  const builtInInput = devices.find((d) => d.input && d.transport === "built-in");
  return {
    devices,
    ...(defaultInput ? { defaultInput } : {}),
    ...(defaultOutput ? { defaultOutput } : {}),
    ...(builtInInput ? { builtInInput } : {}),
    aggregatePresent: devices.some((d) => d.name.startsWith(UNIT_AGGREGATE_PREFIX)),
  };
}

/** One read-only `system_profiler` pass; undefined when it is missing or slow (the `sh` timeout). */
export function readAudioProfiler(): AudioProfilerRead | undefined {
  const out = sh("system_profiler", ["SPAudioDataType", "-json"]);
  return out ? parseAudioProfiler(out) : undefined;
}

// ---- ~/.jarhead/audio-probe.json: what apps/mac/Scripts/audio-probe.sh wrote (V1), per mode.

/** One probe run as the script writes it; only `at` and `mode` are required of the file, the figures are read when present. */
export interface AudioProbeRun {
  readonly at: number;
  readonly mode: string;
  readonly rung?: number;
  readonly vpAfterStop?: boolean;
  readonly aggregateAfterStop?: boolean;
  readonly speaksRateDuring?: number;
  readonly couplingDb?: number;
  /**
   * The wire's level WHILE the guard held (dBFS). With zero-fill this is the floor by construction
   * (recorder-probe: −120) — the `leak` row's figure only when no tail figure was written.
   */
  readonly residualDbfs?: number;
  /** The wire's level in the 300 ms after a hold ended (dBFS) — the number that matters; the `leak` row judges it first. */
  readonly tailLeakDbfs?: number;
  readonly floorDbfs?: number;
  readonly tailMs?: number;
  readonly sharedWith?: readonly string[];
  readonly checks?: unknown;
}

export interface AudioProbeRead {
  readonly path: string;
  readonly runs: readonly AudioProbeRun[];
}

export function audioProbePath(stateDir: string): string {
  return join(stateDir, AUDIO_PROBE_FILE);
}

function probeRun(value: unknown, modeHint?: string): AudioProbeRun | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const at = Number(v["at"]);
  const mode = typeof v["mode"] === "string" ? v["mode"] : modeHint;
  if (!Number.isFinite(at) || !mode) return undefined;
  const num = (k: string): { [key: string]: number } | Record<string, never> => (typeof v[k] === "number" && Number.isFinite(v[k] as number) ? { [k]: v[k] as number } : {});
  const bool = (k: string): { [key: string]: boolean } | Record<string, never> => (typeof v[k] === "boolean" ? { [k]: v[k] as boolean } : {});
  const shared = Array.isArray(v["sharedWith"]) ? (v["sharedWith"] as unknown[]).filter((s): s is string => typeof s === "string") : undefined;
  return {
    at,
    mode,
    ...num("rung"),
    ...bool("vpAfterStop"),
    ...bool("aggregateAfterStop"),
    ...num("speaksRateDuring"),
    ...num("couplingDb"),
    ...num("residualDbfs"),
    ...num("tailLeakDbfs"),
    ...num("floorDbfs"),
    ...num("tailMs"),
    ...(shared ? { sharedWith: shared } : {}),
    ...(v["checks"] !== undefined ? { checks: v["checks"] } : {}),
  } as AudioProbeRun;
}

/**
 * The file in any of the three spellings the probe may use — one run, `{ runs: [...] }`, or a
 * record keyed by mode — read leniently: a run needs `at` and a mode, everything else is optional.
 */
export function parseAudioProbe(text: string, path: string): AudioProbeRead | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof root !== "object" || root === null) return undefined;
  const r = root as Record<string, unknown>;
  const runs: AudioProbeRun[] = [];
  const one = probeRun(r);
  if (one) runs.push(one);
  else if (Array.isArray(r["runs"])) for (const x of r["runs"] as unknown[]) {
    const run = probeRun(x);
    if (run) runs.push(run);
  }
  else for (const [k, x] of Object.entries(r)) {
    const run = probeRun(x, k);
    if (run) runs.push(run);
  }
  return { path, runs };
}

export function readAudioProbe(stateDir: string): AudioProbeRead | undefined {
  const path = audioProbePath(stateDir);
  try {
    return parseAudioProbe(readFileSync(path, "utf8"), path);
  } catch {
    return undefined;
  }
}

/** The figure the `leak` row judges: the tail leak when the probe wrote one (the residual while held is the floor by construction), else the residual. */
function leakFigure(run: AudioProbeRun): { readonly word: string; readonly dbfs: number } | undefined {
  if (run.tailLeakDbfs !== undefined) return { word: "tail leak", dbfs: run.tailLeakDbfs };
  if (run.residualDbfs !== undefined) return { word: "residual", dbfs: run.residualDbfs };
  return undefined;
}

/** The `leak` row: the probe's tail leak (else its residual) against LEAK_FAIL_DBFS, saying which it read, or why there is no figure. */
export function leakCheck(probe: AudioProbeRead | undefined, appBuiltAt: number | undefined, now: number): Check {
  const g = { group: "audio", name: "leak", required: false } as const;
  const rerun = `run the probe once per device pair; the doctor reads ~/.jarhead/${AUDIO_PROBE_FILE}`;
  if (!probe || probe.runs.length === 0) return { ...g, status: "warn", detail: "not measured — apps/mac/Scripts/audio-probe.sh (no session; needs the mic grant)", fix: rerun };
  const measured = probe.runs.filter((r) => leakFigure(r) !== undefined);
  const run = measured.find((r) => r.mode === "recording") ?? measured.sort((a, b) => b.at - a.at)[0];
  const figure = run ? leakFigure(run) : undefined;
  if (!run || !figure) return { ...g, status: "warn", detail: `${probe.runs.length} run${probe.runs.length === 1 ? "" : "s"} (${probe.runs.map((r) => r.mode).join(", ")}) — none measured the guard's residual`, fix: rerun };
  const figures = `${figure.word} ${figure.dbfs} dBFS${run.tailMs !== undefined ? ` · tail ${run.tailMs} ms` : ""} · ${run.mode} · ${agoWords(run.at, now)}`;
  if (figure.dbfs > LEAK_FAIL_DBFS) return { ...g, status: "fail", detail: `${figures} — above ${LEAK_FAIL_DBFS} dBFS`, fix: "the guard is not holding on this hardware — use headphones for Recording, or leave it off" };
  if (appBuiltAt !== undefined && run.at < appBuiltAt) return { ...g, status: "warn", detail: `${figures} — measured before this app build`, fix: rerun };
  return { ...g, status: "ok", detail: figures };
}

/** When the installed app last changed (Info.plist is rewritten by every build); undefined without an install. */
export function appBuiltAt(mark = APP_BUILD_MARK): number | undefined {
  try {
    return statSync(mark).mtimeMs;
  } catch {
    return undefined;
  }
}

// ---- the rows

export interface AudioCheckInput {
  /** `snapshot.audioState`; undefined = no app connected (or none has reported yet). */
  readonly state: AudioState | undefined;
  /** `snapshot.settings.audio`, or settings.json's block when no daemon answers. */
  readonly settings: AudioSettings | undefined;
  readonly phase: Phase | undefined;
  readonly profiler: AudioProfilerRead | undefined;
  readonly probe: AudioProbeRead | undefined;
  readonly appBuiltAt: number | undefined;
  readonly now: number;
}

const ASLEEP_PHASES: ReadonlySet<Phase> = new Set<Phase>(["asleep", "paused", "error"]);
/** Recording's ladder (`VoiceProcessingPolicy.plainRungs`): ranked/hardware › ranked/automatic › default/hardware — rung 3 hears the system default. */
export const RECORDING_DEFAULT_MIC_RUNG = 3;

/**
 * The `audio` group. Rules: `hears` warns on a Bluetooth mic (every app's sound narrows while it is
 * held); `speaks` warns below 44.1 kHz (narrowed) or, while Recording, on Bluetooth (a longer guard
 * tail); `voice processing` FAILS when the fallback rung won (running, no unit, Recording off);
 * `other mic clients` is fine beside the plain graph (Recording, or the fallback rung) and a warning beside the unit; `recording` warns while
 * on; `released at sleep` is judged only while asleep; `leak` reads the probe file. Without an app:
 * one warning row, then what settings.json and the file still say.
 */
export function audioChecks(i: AudioCheckInput): Check[] {
  const out: Check[] = [];
  const add = (c: Omit<Check, "group" | "required">): void => void out.push({ group: "audio", required: false, ...c });
  const s = i.state;
  const recording = s?.recording ?? i.settings?.recording ?? false;
  if (!s) add({ name: "audio state", status: "warn", detail: "app not running — the graph's read-back needs Jarhead.app connected", fix: "open Jarhead.app; it reports its graph to the daemon on start, stop and every route change" });
  else {
    const fallbackWon = s.running && !s.voiceProcessing && !s.recording;
    add({ name: "voice processing", status: fallbackWon ? "fail" : "ok", detail: voiceProcessingWords(s), ...(fallbackWon ? { fix: "echo cancellation failed to start on this device pair; Jarhead runs guarded" } : {}) });
    if (s.hears) {
      const bluetooth = transportWord(s.hears.transport) === "bluetooth";
      const builtIn = i.profiler?.builtInInput?.name ?? "the built-in microphone";
      // Recording's ladder pins the ranked mic on rungs 1–2; rung 3 is the unpinned fallback — the system default,
      // whatever it is. On a Mac whose default input is the headset that is the outcome Recording exists to avoid.
      const refusedRanked = s.recording && s.running && !s.voiceProcessing && s.rung === RECORDING_DEFAULT_MIC_RUNG;
      const detail = `${s.hears.name} · ${hzWords(s.hears)} · ${transportWord(s.hears.transport)} · ${hearsState(s)}${refusedRanked ? " · ranked mic refused; hearing the system default" : ""}`;
      const fix = bluetooth
        ? `a headset mic drops every app's sound to hands-free while held — make ${builtIn} the default in System Settings › Sound, or turn Recording on`
        : refusedRanked
          ? `the plain graph could not pin the ranked microphone (rung ${RECORDING_DEFAULT_MIC_RUNG}) — make ${builtIn} the default in System Settings › Sound so Recording hears it`
          : undefined;
      add({ name: "hears", status: bluetooth || refusedRanked ? "warn" : "ok", detail, ...(fix ? { fix } : {}) });
    } else add({ name: "hears", status: "ok", detail: "nothing — the graph is down" });
    if (s.speaks) {
      const narrowed = s.speaks.rate < NARROWED_BELOW_HZ;
      const bluetoothWhileRecording = s.recording && transportWord(s.speaks.transport) === "bluetooth";
      const fix = narrowed ? "the headset mic is held (by Jarhead's unit, or another app) — make the built-in mic the default in System Settings › Sound, or turn Recording on" : bluetoothWhileRecording ? "Bluetooth output buffers lengthen the guard tail — wired headphones or the speakers cut it" : undefined;
      add({ name: "speaks", status: narrowed || bluetoothWhileRecording ? "warn" : "ok", detail: `${s.speaks.name} · ${hzWords(s.speaks)} · ${transportWord(s.speaks.transport)} · ${speaksState(s.speaks)}`, ...(fix ? { fix } : {}) });
    } else add({ name: "speaks", status: "ok", detail: "nothing — the graph is down" });
    const def = i.profiler?.defaultInput?.name ?? (s.voiceProcessing ? s.hears?.name : undefined);
    const held = s.running && s.voiceProcessing ? "held by Jarhead (the unit follows it)" : s.running ? `not held — the plain graph uses ${s.hears?.name ?? "the ranked mic"}` : "not held (the graph is down)";
    add({ name: "default input", status: "ok", detail: def ? `${def} · ${held}` : `unknown (no system_profiler read) · ${held}` });
    if (s.sharedWith === undefined) add({ name: "other mic clients", status: "ok", detail: "unknown (the HAL has no process objects)" });
    else if (s.sharedWith.length === 0) add({ name: "other mic clients", status: "ok", detail: "none" });
    else {
      // A recorder beside the voice-processing unit hears a processed (on AirPods, narrowband) mic; beside the plain graph — Recording, or the fallback rung — it shares an ordinary one.
      const besideUnit = s.running && s.voiceProcessing;
      add({ name: "other mic clients", status: besideUnit ? "warn" : "ok", detail: `${sharedWords(s.sharedWith)} · ${besideUnit ? "beside a voice-processing unit" : "sharing the plain mic"}`, ...(besideUnit ? { fix: "turn Recording on so the recorder shares a plain microphone" } : {}) });
    }
  }
  add({ name: "recording", status: recording ? "warn" : "ok", detail: `${recording ? "on" : "off"} · Settings › Audio, ⌥⇧R`, ...(recording ? { fix: "turn it off after the demo" } : {}) });
  if (s) {
    const asleep = i.phase === undefined || ASLEEP_PHASES.has(i.phase);
    if (!asleep) add({ name: "released at sleep", status: "ok", detail: `awake · voice processing ${onOff(s.voiceProcessing)} — read again after the next sleep` });
    else if (s.running) add({ name: "released at sleep", status: "warn", detail: "the graph is still up while asleep", fix: "sleep and wake once; if it stays, quit Jarhead.app" });
    else {
      const aggregate = s.aggregatePresent || i.profiler?.aggregatePresent === true;
      const bad = s.voiceProcessing || aggregate;
      add({
        name: "released at sleep",
        status: bad ? "warn" : "ok",
        detail: `voice processing ${s.voiceProcessing ? "still on" : "off"} after the last stop · ${aggregate ? "the unit's aggregate (VPAUAggregateAudioDevice) is still present" : "no unit aggregate present"}`,
        ...(bad ? { fix: "the unit was not released — sleep and wake once; if it stays, quit Jarhead.app" } : {}),
      });
    }
  }
  out.push(leakCheck(i.probe, i.appBuiltAt, i.now));
  return out;
}

// ---- `pnpm jarhead status`: the audio block after `permissions`.

const STATUS_PAD = "             "; // the column every status value starts in ("  phase      ")

/**
 * The block: the knobs line, `hears` / `speaks` with their figures, then the guard's counters or
 * the resting line. Without an app: one line, with the profiler's defaults when they were read.
 */
export function audioStatusLines(state: AudioState | undefined, settings: AudioSettings | undefined, profiler?: AudioProfilerRead): string[] {
  if (!state) {
    const recording = settings?.recording ? " · recording on" : "";
    if (!profiler) return [`  audio      no app connected${recording}`];
    const device = (d: AudioProfilerDevice | undefined): string => (d ? `${d.name} ${d.rate} Hz` : "none");
    return [`  audio      no app connected${recording} — defaults: in ${device(profiler.defaultInput)} · out ${device(profiler.defaultOutput)}`];
  }
  const since = state.since !== undefined && state.running ? ` · since ${clockWords(state.since)}` : "";
  const lines = [`  audio      voice processing ${voiceProcessingWords(state)}${since}`];
  const device = (label: string, d: AudioDeviceInfo, word: string): string => `${STATUS_PAD}${label.padEnd(8)}${d.name.padEnd(26)} ${hzWords(d).padEnd(13)} ${transportWord(d.transport).padEnd(11)} ${word}`;
  if (state.hears) lines.push(device("hears", state.hears, hearsState(state)));
  if (state.speaks) lines.push(device("speaks", state.speaks, speaksState(state.speaks)));
  const muted = state.inputMuted ? " · input muted" : "";
  if (state.guardOn) lines.push(`${STATUS_PAD}${guardWords(state)}${muted}`);
  else {
    const rest = state.running ? "released at sleep" : state.voiceProcessing ? "voice processing still on after stop" : state.aggregatePresent ? "released · aggregate still present" : "released";
    lines.push(`${STATUS_PAD}recording ${onOff(state.recording)} · guard off · ${rest}${muted}`);
  }
  return lines;
}

// ---- `pnpm jarhead doctor --test-audio`: builder D's probe, `--test --json`.

export interface AudioTestInput {
  readonly scriptExists: boolean;
  readonly phase: Phase | undefined;
  /** Runs the script and returns its stdout; undefined when it printed nothing, timed out or failed. */
  readonly run: () => string | undefined;
}

/** The last line of the probe's output that parses as a JSON object (human lines may precede it). */
function lastJsonLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i] as string) as unknown;
      if (typeof v === "object" && v !== null) return v as Record<string, unknown>;
    } catch {
      // not this line
    }
  }
  return undefined;
}

/**
 * One row, `test audio`: the probe builds the graph as the app would in the current setting, records,
 * plays a 1 s −12 dBFS chime through the player node, records again, and prints `leakDb` and what the
 * guard would have gated. Refused here while Jarhead is awake (two voice-processing clients cut each
 * other) before the script is spawned; the script refuses too. Accepted JSON: `{ refused }`,
 * `{ dryRun, note }` (nothing played — AUDIO_PROBE_PLAY unset), `{ leakDb, gated?, chunks?, rung?, mode? }`.
 */
export function audioTestCheck(i: AudioTestInput): Check {
  const g = { group: "audio", name: "test audio", required: false } as const;
  if (!i.scriptExists) return { ...g, status: "warn", detail: "apps/mac/Scripts/audio-probe.sh missing — nothing played", fix: "the probe is builder D's: apps/mac/Scripts/audio-probe.sh --test --json" };
  if (i.phase !== undefined && !ASLEEP_PHASES.has(i.phase)) return { ...g, status: "warn", detail: "Jarhead is awake; sleep it first (two voice-processing clients cut each other)", fix: "pnpm jarhead cmd sleep, then doctor --test-audio again" };
  const out = i.run();
  if (out === undefined) return { ...g, status: "warn", detail: "the probe printed nothing (timed out, or the mic grant was refused)", fix: "run apps/mac/Scripts/audio-probe.sh --test yourself and read its lines" };
  const j = lastJsonLine(out);
  if (!j) return { ...g, status: "warn", detail: `unreadable: ${out.trim().split("\n")[0]?.slice(0, 80) ?? ""}` };
  if (typeof j["refused"] === "string") return { ...g, status: "warn", detail: j["refused"] };
  if (j["dryRun"] === true) return { ...g, status: "ok", detail: `dry run — ${typeof j["note"] === "string" ? j["note"] : "set AUDIO_PROBE_PLAY=1 to play the chime"}` };
  // The tail leak (the wire after the chime, once the hold released) is judged first: while held the wire is zero-filled, so `leakDb` reads the floor.
  const tail = typeof j["tailLeakDbfs"] === "number" ? j["tailLeakDbfs"] : undefined;
  const during = typeof j["leakDb"] === "number" ? j["leakDb"] : typeof j["residualDbfs"] === "number" ? j["residualDbfs"] : undefined;
  const leak = tail ?? during;
  if (leak === undefined) return { ...g, status: "warn", detail: `no leak figure in ${JSON.stringify(j).slice(0, 80)}` };
  const gated = typeof j["gated"] === "number" && typeof j["chunks"] === "number" ? ` · guard would gate ${j["gated"]} of ${j["chunks"]}` : "";
  const rung = typeof j["rung"] === "number" ? ` · rung ${j["rung"]}` : "";
  const mode = typeof j["mode"] === "string" ? ` · ${j["mode"]}` : "";
  const figures = `${tail !== undefined ? "tail leak" : "leak"} ${leak} dB${gated}${rung}${mode}`;
  if (leak > LEAK_FAIL_DBFS) return { ...g, status: "fail", detail: `${figures} — above ${LEAK_FAIL_DBFS} dB`, fix: "the guard is not holding on this hardware — use headphones for Recording, or leave it off" };
  return { ...g, status: "ok", detail: figures };
}

/**
 * What a spawn that exited non-zero still printed. audio-probe.sh exits 3 on a refusal and 1 on any
 * FAIL — the leak figure above the line included — with its JSON already on stdout; `execFileSync`
 * throws on those exits and hangs the output on the error (`stdout`, a string under `encoding`).
 */
export function probeStdout(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const out = (error as { stdout?: unknown }).stdout;
  if (typeof out === "string") return out || undefined;
  if (out instanceof Uint8Array) return Buffer.from(out).toString("utf8") || undefined;
  return undefined;
}

/** What `doctor` takes from the command line: `--test-audio` shells to the probe (nothing else does). */
export interface DoctorOptions {
  readonly testAudio?: boolean;
}

export async function runChecks(opts: DoctorOptions = {}): Promise<Check[]> {
  const cfg = readConfig();
  const checks: Check[] = [];
  const add = (c: Check): void => void checks.push(c);

  // ---- keys
  // The one free GET /v1/models: the key row, the Live model row, the openai brain row
  // and the memory extractor pick all read this set. Never a Live session.
  let modelIds: Set<string> | undefined;
  if (!cfg.openaiApiKey) {
    add({ group: "keys", name: "OPENAI_API_KEY", status: "fail", detail: "missing", required: true, fix: "put OPENAI_API_KEY=... in ~/.jarhead/env" });
  } else {
    try {
      const r = await json("https://api.openai.com/v1/models", { Authorization: `Bearer ${cfg.openaiApiKey}` });
      const ids = new Set(((r.body as { data?: { id: string }[] } | undefined)?.data ?? []).map((m) => m.id));
      if (r.status === 200) modelIds = ids;
      const hasLive = ids.has(cfg.liveModel);
      const src = keySource("OPENAI_API_KEY");
      const where = src === "state-dir" ? "~/.jarhead/env" : "shell env";
      add({
        group: "keys",
        name: "OPENAI_API_KEY",
        status: r.status === 200 ? "ok" : "fail",
        detail: r.status === 200 ? `valid, from ${where} (${ids.size} models)` : `HTTP ${r.status} for the key from ${where}`,
        required: true,
        fix: r.status === 200 ? undefined : src === "shell" ? "the shell's OPENAI_API_KEY is stale; put a working key in ~/.jarhead/env (it takes precedence)" : "replace OPENAI_API_KEY in ~/.jarhead/env with a working key",
      });
      // A valid key without the Live model (release F4): the same line the engine's voice.key problem and Setup › Voice show.
      add({ group: "keys", name: cfg.liveModel, status: hasLive ? "ok" : "fail", detail: hasLive ? "available on this key" : noLiveModelLine(cfg.liveModel), required: true, fix: hasLive ? undefined : "enable the Live model on the OpenAI project, or use a key from a project that has it" });
      const backend = ids.has("gpt-5.6-terra");
      add({ group: "keys", name: "gpt-5.6-terra (openai brain)", status: backend ? "ok" : "warn", detail: backend ? "available" : "not listed; set JARHEAD_BRAIN_MODEL to an available Responses model", required: false });
    } catch (e) {
      add({ group: "keys", name: "OPENAI_API_KEY", status: "fail", detail: `could not reach api.openai.com: ${(e as Error).message}`, required: true });
    }
  }

  // ---- claude code brain
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settingsKey: string | undefined;
  try {
    settingsKey = (JSON.parse(readFileSync(settingsPath, "utf8")) as { env?: { ANTHROPIC_API_KEY?: string } }).env?.ANTHROPIC_API_KEY;
  } catch {
    settingsKey = undefined;
  }
  const anthropicKey = cfg.anthropicApiKey ?? settingsKey;
  if (anthropicKey) {
    try {
      const r = await json("https://api.anthropic.com/v1/models", { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" });
      add({
        group: "brain",
        name: "ANTHROPIC_API_KEY",
        status: r.status === 200 ? "ok" : "warn",
        detail: r.status === 200 ? `valid (${settingsKey && anthropicKey === settingsKey ? "from ~/.claude/settings.json" : "from env"})` : `rejected with HTTP ${r.status} — Claude Code headless will fail to authenticate`,
        required: false,
        fix: r.status === 200 ? undefined : "rotate the key in ~/.claude/settings.json (env.ANTHROPIC_API_KEY) or remove it and run `claude /login` so OAuth is used",
      });
    } catch (e) {
      add({ group: "brain", name: "ANTHROPIC_API_KEY", status: "warn", detail: (e as Error).message, required: false });
    }
  } else {
    add({ group: "brain", name: "ANTHROPIC_API_KEY", status: "warn", detail: "not set — the anthropic-api brain is unavailable; claude-code uses your Claude login instead", required: false });
  }
  // ---- codex brain (first in auto's order): the CLI bundled in ChatGPT.app, on Kevin's ChatGPT login
  const codex = await probeCodex({ bin: cfg.codexBin });
  add({
    group: "brain",
    name: "codex",
    status: codex.bin && codex.signedIn ? "ok" : "warn",
    detail: codex.bin ? `${codex.bin.path}${codex.version ? ` (${codex.version})` : ""}: ${codex.detail}` : codex.detail,
    required: false,
    fix: !codex.bin ? "install Codex Desktop (inside ChatGPT.app) or set JARHEAD_CODEX_BIN" : !codex.signedIn ? "sign in to Codex in ChatGPT, or run `codex login`" : undefined,
  });
  const claudeBin = cfg.claudeBin ?? sh("which", ["claude"]);
  add({ group: "brain", name: "claude", status: claudeBin ? "ok" : "warn", detail: claudeBin ? `${claudeBin} (${sh(claudeBin, ["--version"]) ?? "?"})` : "not on PATH — the claude-code brain is unavailable; auto skips to the next backend", required: false });
  // What `auto` resolves to: the running daemon's answer when there is one, else what this Mac's configuration implies.
  const saved = readSavedSettings(cfg.stateDir);
  const brain: BrainKind = saved.brain ?? cfg.brain;
  const brainModel = saved.brainModel ?? cfg.brainModel;
  const brainBaseUrl = saved.brainBaseUrl ?? cfg.brainBaseUrl;
  const running = await daemonBrain(cfg.socketPath);
  // The local model server: the running daemon's look when one answers, else one read of the three loopback ports (or the pinned root). Never a pull.
  const localStatus = running?.setup?.local ?? (await discoverLocalServer({ ...(brain === "local" && brainBaseUrl ? { baseUrl: brainBaseUrl } : {}), ramBytes: totalmem(), apiKey: secretsPresent().brainApiKey ? cfg.brainApiKey : undefined }));
  const anthropicOk = checks.some((c) => c.name === "ANTHROPIC_API_KEY" && c.status === "ok");
  const expected = codex.bin && codex.signedIn ? "codex" : claudeBin || existsSync(join(homedir(), ".claude")) ? "claude-code (if its login answers the start-up probe)" : anthropicOk ? "anthropic-api" : brainBaseUrl ? "openai-compatible" : "openai-responses";
  const resolved =
    brain === "auto"
      ? running?.resolved
        ? `resolves to ${running.resolved} in the running daemon (${running.detail})`
        : `expected to resolve to ${expected} on this Mac`
      : running?.resolved && running.resolved !== brain
        ? `the running daemon fell back to ${running.resolved} (${running.detail})`
        : running?.resolved
          ? `running (${running.detail})`
          : "explicit";
  // Under `local` the row names the model that runs (Kevin's or the pick) and the server root, discovered or pinned.
  const localWords = brain === "local" ? `${brainModel || localStatus.picked ? ` (${brainModel || localStatus.picked})` : ""}${localStatus.reachable ? ` @ ${localStatus.baseUrl.replace(/^https?:\/\//, "")} (${brainBaseUrl ? "pinned" : "discovered"})` : brainBaseUrl ? ` @ ${brainBaseUrl} (pinned, not answering)` : " (no server answering)"}` : `${brainModel ? ` (${brainModel})` : ""}${brainBaseUrl ? ` @ ${brainBaseUrl}` : ""}`;
  add({
    group: "brain",
    name: "default brain",
    status: "ok",
    detail: `${brain}${localWords} — ${resolved}; auto order ${AUTO_BRAIN_ORDER.join(" → ")} (local only when picked)`,
    required: false,
  });

  // ---- hands
  const hands = new NativeHandsProcess({ binPath: cfg.handsBin });
  if (!hands.available) {
    add({ group: "hands", name: "jarhead-hands", status: "fail", detail: `not built at ${cfg.handsBin}`, required: false, fix: "pnpm build:hands" });
  } else {
    try {
      const hello = await hands.hello();
      add({ group: "hands", name: "jarhead-hands", status: "ok", detail: `v${hello.version} pid ${hello.pid}`, required: false });
      // The four grants a helper process reads for itself. TCC keys them on the responsible
      // app: run from a terminal these are the terminal's answers, not Jarhead.app's — the
      // running daemon's list (below) is the app's.
      const perms: HelloPermissions = hello.permissions;
      const asThis = "(this terminal's grant, not the app's)";
      add({ group: "hands", name: "Accessibility", status: perms.accessibility ? "ok" : "warn", detail: perms.accessibility ? `granted ${asThis}` : `not granted ${asThis} — clicks/typing will silently no-op`, required: false, fix: "System Settings → Privacy & Security → Accessibility: switch Jarhead on; if it is already on, remove the row (−) and press Request in Setup — that row was made by an earlier build" });
      add({ group: "hands", name: "Screen Recording", status: perms.screenRecording ? "ok" : "warn", detail: perms.screenRecording ? `granted ${asThis}` : `not granted ${asThis} — falls back to \`screencapture\``, required: false, fix: "System Settings → Privacy & Security → Screen & System Audio Recording" });
      if (perms.inputMonitoring === undefined || perms.fullDiskAccess === undefined) {
        add({ group: "hands", name: "Input Monitoring / FDA", status: "warn", detail: "this helper build does not read them", required: false, fix: "pnpm build:hands" });
      } else {
        add({ group: "hands", name: "Input Monitoring", status: perms.inputMonitoring ? "ok" : "warn", detail: perms.inputMonitoring ? `granted ${asThis}` : `not granted ${asThis} — the keys watched while circling will not arrive`, required: false, fix: "Setup › Permissions › Ask for everything (the app prompts), or System Settings → Privacy & Security → Input Monitoring" });
        add({ group: "hands", name: "Full Disk Access", status: perms.fullDiskAccess ? "ok" : "warn", detail: perms.fullDiskAccess ? `granted ${asThis}` : `not granted ${asThis} — Mail, Safari, Messages and every folder without a prompt of its own fail with EPERM`, required: false, fix: "System Settings → Privacy & Security → Full Disk Access: add /Applications/Jarhead.app (no prompt exists; Setup opens the pane and reveals the app)" });
      }
      add({ group: "hands", name: "other permissions", status: "ok", detail: "microphone, speech, camera, contacts, calendars, reminders, notifications, local network, Automation and the Desktop/Documents/Downloads folders are read by Jarhead.app itself — Setup › Permissions shows them, `jarhead status` prints the app's list", required: false });
      // The browser fast path: does each running browser allow JavaScript from Apple Events?
      // A browser that is not running is reported, never launched.
      for (const app of ["Google Chrome", "Safari"]) {
        const running = sh("pgrep", ["-x", app]) !== undefined;
        if (!running) {
          add({ group: "hands", name: `${app} JS from Apple Events`, status: "warn", detail: "not running — not probed", required: false });
          continue;
        }
        const r = await browserJsDoctor(hands, app);
        add({ group: "hands", name: `${app} JS from Apple Events`, status: r.status === "ok" ? "ok" : "warn", detail: r.status === "off" ? `off — ${r.detail}` : r.detail, required: false, fix: r.fix });
      }
    } catch (e) {
      add({ group: "hands", name: "jarhead-hands", status: "fail", detail: (e as Error).message, required: false });
    } finally {
      hands.stop();
    }
  }

  // ---- permissions: the app's list, from the running daemon (TCC keys every grant on Jarhead.app)
  const daemon = await daemonRead(cfg.socketPath);
  const appPerms = daemon?.permissions;
  const missingRequired = (appPerms ?? []).filter((p) => p.required && p.grant !== "granted");
  add({
    group: "permissions",
    name: "Jarhead.app",
    status: appPerms === undefined ? "warn" : missingRequired.length ? "warn" : "ok",
    detail: appPerms === undefined ? "no daemon answering — start Jarhead.app; Setup › Permissions asks for all sixteen in one sweep" : summarizePermissions(appPerms),
    required: false,
    ...(missingRequired.length ? { fix: `Setup › Permissions › Ask for everything (required and missing: ${missingRequired.map((p) => p.label).join(", ")})` } : {}),
  });

  // ---- audio (design12): the app's graph as it read itself back, the one setting, a read-only system_profiler pass, the probe's file. Nothing here touches the mic.
  {
    const saved = readSavedSettings(cfg.stateDir);
    for (const c of audioChecks({
      state: daemon?.audioState,
      settings: daemon?.audioSettings ?? saved.audio,
      phase: daemon?.phase,
      profiler: readAudioProfiler(),
      probe: readAudioProbe(cfg.stateDir),
      appBuiltAt: appBuiltAt(),
      now: Date.now(),
    })) add(c);
    if (opts.testAudio) {
      add(
        audioTestCheck({
          scriptExists: existsSync(AUDIO_PROBE_SCRIPT),
          phase: daemon?.phase,
          // The probe carries its own TCC grant and opens nothing paid. A cold `swiftc -O` of Model + Audio + Ear + the
          // wake listener can alone pass a minute, so the build runs first on its own clock; the timed run then covers
          // three seconds of audio. A refusal (exit 3) or a FAIL (exit 1) throws with the JSON on the error's stdout.
          run: () => {
            try {
              execFileSync("bash", [AUDIO_PROBE_SCRIPT, "--build-only"], { stdio: "ignore", timeout: 240_000 });
            } catch {
              // The timed run below says what happened (or prints nothing).
            }
            try {
              return execFileSync("bash", [AUDIO_PROBE_SCRIPT, "--test", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }) || undefined;
            } catch (e) {
              return probeStdout(e);
            }
          },
        }),
      );
    }
  }

  // ---- local: a daemon from before the field is said so first; then the server on this Mac, and under `local` the model and the embeddings memory uses (the daemon's dims when it answers)
  const stale = staleDaemonCheck(running);
  if (stale) add(stale);
  for (const c of localChecks({ status: localStatus, brain, brainModel, brainBaseUrl, memory: daemon?.memory })) add(c);
  // ---- memory: what Jarhead durably knows about Kevin, how it matches, which model reads the conversations.
  // Reads the running daemon's summary and the store's row count; the model list is the keys row's one GET. Never a session, never the extractor.
  const memoryEnabled = saved.memory ?? true;
  const hasOpenAIKey = Boolean(cfg.openaiApiKey);
  {
    const memoryDir = join(cfg.stateDir, "memory");
    // The model memory reads with is the one that resolves on the server (Kevin's pick or the best fit) — none when nothing answers or nothing fits.
    const resolvedChat = resolveLocalModel(brainModel, localStatus);
    const localChat = "model" in resolvedChat ? resolvedChat.model.id : "";
    for (const c of memoryChecks({ enabled: memoryEnabled, hasOpenAIKey, modelIds: modelIds, override: cfg.memoryModel, summary: daemon?.memory, storeDir: memoryDir, storeRows: memoryStoreRows(memoryDir), ...(brain === "local" ? { local: { reachable: localStatus.reachable, chat: localChat } } : {}) })) add(c);
  }
  // ---- privacy: where words go — the daemon's rows when one answers, else the same function over what the doctor read
  {
    // A daemon from a build before the field answers without `dataPaths` (and without `local`, read above the same way).
    const daemonPaths = running?.setup?.dataPaths;
    const paths =
      daemonPaths && daemonPaths.length > 0
        ? daemonPaths
        : dataPaths({
            brain,
            brainModel,
            ...(running?.resolved ? { brainResolved: running.resolved as Exclude<BrainKind, "auto"> } : {}),
            brainDetail: running?.detail ?? "",
            local: localStatus,
            // No daemon: the summary the engine would report, so this row agrees with the memory group above (an absent summary reads as "off").
            memory: daemon?.memory ?? memorySummaryWithoutDaemon({ enabled: memoryEnabled, brain, local: localStatus, hasOpenAIKey }),
            hasOpenAIKey,
            liveModel: cfg.liveModel,
          });
    for (const c of privacyChecks(paths)) add(c);
  }

  // ---- agents: the sessions on this Mac and the connector that continues one
  for (const c of defaultConnectors({ claudeBin: cfg.claudeBin })) {
    try {
      const h = await c.health();
      add({ group: "agents", name: c.kind, status: h.ok ? "ok" : "warn", detail: h.detail, required: false });
    } catch (e) {
      add({ group: "agents", name: c.kind, status: "warn", detail: (e as Error).message, required: false });
    }
  }

  // ---- native app: the installed bundle, its signature, and the one-Jarhead audit (read-only)
  for (const c of installChecks()) add(c);
  // ---- wake word gate (the app enforces it; doctor reports the configuration)
  try {
    const settingsPath = join(cfg.stateDir, "settings.json");
    const saved = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as { wake?: Partial<WakeSettings> }) : {};
    const wake: WakeSettings = { ...DEFAULT_WAKE, ...(saved.wake ?? {}) };
    const passphrase = existsSync(join(cfg.stateDir, "wake-auth.json"));
    const needsPassphrase = wake.auth === "passphrase" || wake.auth === "either";
    const unguarded = wake.enabled && wake.auth === "none";
    add({
      group: "app",
      name: "wake word",
      status: !wake.enabled ? "warn" : unguarded ? "warn" : needsPassphrase && !passphrase && wake.auth === "passphrase" ? "warn" : "ok",
      detail: !wake.enabled
        ? "off — the session opens on launch (autoWake) or by command"
        : `on: "${wake.phrases.join('" / "')}" → ${wake.auth}${passphrase ? ", passphrase set" : ", no passphrase (Touch ID / Mac password only)"}; on-device recognition, no API until authenticated`,
      required: false,
      fix: unguarded ? "set wake.auth to touch-id, passphrase or either in the Console" : needsPassphrase && !passphrase && wake.auth === "passphrase" ? "set a passphrase in Console › Settings › Wake" : undefined,
    });
  } catch (e) {
    add({ group: "app", name: "wake word", status: "warn", detail: (e as Error).message, required: false });
  }
  const daemonSock = existsSync(cfg.socketPath);
  add({
    group: "app",
    name: "daemon socket",
    // A socket file nobody answers on is a daemon that died without cleaning up, or one that is wedged: the app's ping/pong respawns the latter.
    status: !daemonSock ? "warn" : daemon ? "ok" : "warn",
    detail: !daemonSock ? "no daemon running" : daemon ? `${cfg.socketPath} answered in ${daemon.ms} ms` : `${cfg.socketPath} present but nothing answered within 1.5 s`,
    required: false,
    fix: daemonSock && !daemon ? "the daemon is not answering — Jarhead.app respawns one on two missed pongs; from a terminal, pnpm jarhead status, or kill the stale jarheadd" : undefined,
  });
  // ---- problems: what the running engine itself says is wrong, typed, each with its one remedy (REDESIGN §16 "Problems, typed")
  if (daemon) {
    if (daemon.problems.length === 0) add({ group: "problems", name: "engine", status: "ok", detail: "none reported", required: false });
    for (const p of daemon.problems) {
      add({
        group: "problems",
        name: p.kind,
        status: FAILING_KINDS.has(p.kind) ? "fail" : "warn",
        detail: `${p.text}${sinceLine(p)}`,
        required: false,
        fix: remedyLine(p),
      });
    }
  }
  // ---- automations: what the daemon carries out asleep — the daemon's rows when one answers, settings.json and the journal otherwise; the ledger's missed rows; pmset READ, never run
  {
    const automationSettings = daemon?.automationSettings ?? readAutomationSettings(cfg.stateDir);
    const grant = (kind: PermissionInfo["kind"]): Grant | undefined => appPerms?.find((p) => p.kind === kind)?.grant;
    const folderGrants: AutomationCheckInput["folderGrants"] = {};
    for (const kind of ["filesDesktop", "filesDocuments", "filesDownloads"] as const) {
      const g = grant(kind);
      if (g) folderGrants[kind] = g;
    }
    const fromLedger = readAutomationLedger(new Ledger(cfg.stateDir), Date.now());
    let timeSensitive = false;
    try {
      timeSensitive = readFileSync(join(REPO_ROOT, "apps", "mac", "Resources", "entitlements.plist"), "utf8").includes("com.apple.developer.usernotifications.time-sensitive");
    } catch {
      timeSensitive = false;
    }
    for (const c of automationChecks({
      settings: automationSettings,
      rows: daemon?.automations,
      nextFire: daemon?.nextFire,
      journal: readJournal(join(cfg.stateDir, "automations", "jobs.ndjson")),
      notifications: appPerms ? (grant("notifications") ?? "unknown") : undefined,
      folderGrants,
      missed: fromLedger.missed,
      brainSecondsToday: fromLedger.brainSecondsToday,
      timeSensitive,
      // A read of the schedule (no root); the row's fix is the line Kevin copies. Nothing here runs a pmset that changes anything.
      pmsetSched: sh("pmset", ["-g", "sched"]),
      now: Date.now(),
      home: homedir(),
    })) add(c);
  }
  // ---- self-edit: worktrees the brain made of this repo and the last one it applied
  try {
    const se = selfEditDoctorRow(join(cfg.stateDir, "worktrees"));
    add({ group: "app", name: "self-edit", status: se.stale > 0 ? "warn" : "ok", detail: se.detail, required: false, fix: se.stale > 0 ? `${se.stale} worktree${se.stale === 1 ? "" : "s"} older than a day: say "discard the old self-edits" or run git worktree remove under ${join(cfg.stateDir, "worktrees")}` : undefined });
  } catch (e) {
    add({ group: "app", name: "self-edit", status: "warn", detail: (e as Error).message, required: false });
  }

  // ---- toolchain
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({ group: "toolchain", name: "node", status: nodeMajor >= 24 ? "ok" : "fail", detail: process.versions.node, required: true, fix: "use Node 24+" });
  for (const [bin, why] of [["ffmpeg", "headless CLI mic"], ["ffplay", "headless CLI speaker"], ["swiftc", "building the hands helper"]] as const) {
    const out = sh(bin, ["-version"]) ?? sh(bin, ["--version"]);
    add({ group: "toolchain", name: bin, status: out ? "ok" : "warn", detail: out ? (out.split("\n")[0] ?? "present").slice(0, 60) : `missing — needed for ${why}`, required: false });
  }
  const volume = Number(sh("osascript", ["-e", "output volume of (get volume settings)"]) ?? "-1");
  add({ group: "toolchain", name: "output volume", status: volume > 0 ? "ok" : volume === 0 ? "warn" : "warn", detail: volume >= 0 ? `${volume}%` : "unknown", required: false, fix: "a muted Mac makes the whole thing look broken" });
  add({ group: "state", name: "state dir", status: "ok", detail: cfg.stateDir, required: false });
  return checks;
}

export function render(checks: readonly Check[]): { text: string; blocking: number } {
  const icon: Record<Status, string> = { ok: "✔", warn: "!", fail: "✘" };
  const lines: string[] = [`\njarhead doctor  ·  ${REPO_ROOT}\n`];
  for (const g of [...new Set(checks.map((c) => c.group))]) {
    lines.push(`  ${g}`);
    for (const c of checks.filter((x) => x.group === g)) lines.push(`    ${icon[c.status]} ${c.name.padEnd(28)} ${c.detail}`);
    lines.push("");
  }
  const fixes = checks.filter((c) => c.status !== "ok" && c.fix);
  if (fixes.length) {
    lines.push("  next steps");
    for (const f of fixes) lines.push(`    · ${f.name}: ${f.fix}`);
    lines.push("");
  }
  const blocking = checks.filter((c) => c.status === "fail" && c.required).length;
  lines.push(`  ${checks.filter((c) => c.status === "ok").length} ok · ${checks.filter((c) => c.status === "warn").length} warn · ${checks.filter((c) => c.status === "fail").length} fail\n`);
  return { text: lines.join("\n"), blocking };
}
