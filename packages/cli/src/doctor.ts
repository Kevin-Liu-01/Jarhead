import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_BRAIN_ORDER, BRAIN_MEMORY_TOKENS, DEFAULT_WAKE, PERMISSION_KINDS, VOICE_MEMORY_TOKENS, type AgentInfo, type AgentStatus, type BrainKind, type MemorySummary, type PermissionInfo, type Permissions, type Problem, type WakeSettings } from "@jarhead/protocol";
import { REPO_ROOT, keySource, readConfig } from "@jarhead/core";
import { DEFAULT_MEMORY_MODEL, pickMemoryModel } from "@jarhead/memory";
import { defaultConnectors } from "@jarhead/agents";
import { browserJsDoctor, probeCodex, selfEditDoctorRow } from "@jarhead/brain";
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
}

/** A running daemon's first snapshot (`permissions.all`, the problems, the memory summary); undefined when none answers within 1.5 s. */
async function daemonRead(socketPath: string): Promise<DaemonRead | undefined> {
  if (!existsSync(socketPath)) return undefined;
  const client = new DaemonClient(socketPath);
  const t0 = Date.now();
  try {
    const got = new Promise<DaemonRead | undefined>((resolve) => {
      client.on("message", (m) => {
        if (m.type !== "snapshot") return;
        const snap = m.snapshot as { permissions: Permissions; problems: readonly Problem[]; memory?: MemorySummary };
        resolve({ permissions: snap.permissions.all, problems: snap.problems, ms: Date.now() - t0, memory: snap.memory });
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
function readSavedSettings(stateDir: string): { brain?: BrainKind; brainModel?: string; brainBaseUrl?: string; memory?: boolean } {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as { brain?: BrainKind; brainModel?: string; brainBaseUrl?: string; memory?: boolean };
    return {
      ...(saved.brain ? { brain: saved.brain } : {}),
      ...(typeof saved.brainModel === "string" ? { brainModel: saved.brainModel } : {}),
      ...(saved.brainBaseUrl ? { brainBaseUrl: saved.brainBaseUrl } : {}),
      ...(typeof saved.memory === "boolean" ? { memory: saved.memory } : {}),
    };
  } catch {
    return {};
  }
}

/** Ask a running daemon which brain it resolved to; undefined when none answers within 1.5 s. */
async function daemonBrain(socketPath: string): Promise<{ resolved: string | undefined; detail: string } | undefined> {
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
        const setup = (m.snapshot as { setup?: { brainResolved?: string; brainDetail?: string } } | undefined)?.setup;
        resolve({ resolved: setup?.brainResolved, detail: setup?.brainDetail ?? "" });
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
    add({ group: "app", name: "dock", status: needsFix || unpinned ? "warn" : "ok", detail: describeDock(before).replace(/^Dock: /, ""), required: false, fix: needsFix ? repair : undefined });
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
  const matching = input.hasOpenAIKey ? "openai embeddings (text-embedding-3-small, 512 dims)" : "keywords (no OPENAI_API_KEY — nothing leaves the Mac)";
  if (!input.enabled) {
    out.push({ group: "memory", name: "memory", status: "ok", detail: `off (Settings › Memory) — nothing is extracted, injected or embedded; the store under ${input.storeDir} stays as it is`, required: false });
  } else if (input.summary) {
    const m = input.summary;
    const learned = m.lastRunAt ? `learned ${agoWords(m.lastRunAt)}${m.lastRun ? ` (+${m.lastRun.added} · ~${m.lastRun.updated} · ${m.lastRun.noop} noop · ${m.lastRun.extractor})` : ""}` : "not learned yet (runs after a conversation closes, at a quiet moment)";
    const waiting = m.pending ? ` · ${m.pending} conversation${m.pending === 1 ? "" : "s"} waiting` : "";
    const spent = m.budgetUsed ? ` · last prompts ${m.budgetUsed.brain} brain / ${m.budgetUsed.voice} voice tokens` : "";
    out.push({
      group: "memory",
      name: "memory",
      status: m.enabled ? "ok" : "warn",
      detail: `${m.count} remembered · ${m.forgotten} forgotten · ${m.archived} archived · matching ${m.embeddings} · ${learned}${waiting}${spent} (caps ${BRAIN_MEMORY_TOKENS} brain / ${VOICE_MEMORY_TOKENS} voice tokens per prompt)`,
      required: false,
      fix: m.enabled ? undefined : "the daemon reports memory off while settings.json says on — restart the daemon or flip Settings › Memory",
    });
  } else {
    const store = input.storeRows === undefined ? `no store yet at ${input.storeDir} (it appears after the first closed conversation)` : `${input.storeRows} row${input.storeRows === 1 ? "" : "s"} in ${join(input.storeDir, "memory.jsonl")} (counts come from a running daemon)`;
    out.push({ group: "memory", name: "memory", status: "ok", detail: `on · matching ${matching} · ${store} · caps ${BRAIN_MEMORY_TOKENS} brain / ${VOICE_MEMORY_TOKENS} voice tokens per prompt`, required: false });
  }
  // Off is Kevin's choice: no extractor row, nothing is configured to run.
  if (!input.enabled) return out;
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

export async function runChecks(): Promise<Check[]> {
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
      add({ group: "keys", name: cfg.liveModel, status: hasLive ? "ok" : "fail", detail: hasLive ? "available on this key" : "not listed for this key", required: true, fix: "the Live model must be enabled on the OpenAI project" });
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
  add({
    group: "brain",
    name: "default brain",
    status: "ok",
    detail: `${brain}${brainModel ? ` (${brainModel})` : ""}${brainBaseUrl ? ` @ ${brainBaseUrl}` : ""} — ${resolved}; auto order ${AUTO_BRAIN_ORDER.join(" → ")}`,
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

  // ---- memory: what Jarhead durably knows about Kevin, how it matches, which model reads the conversations.
  // Reads the running daemon's summary and the store's row count; the model list is the keys row's one GET. Never a session, never the extractor.
  {
    const memoryDir = join(cfg.stateDir, "memory");
    for (const c of memoryChecks({ enabled: saved.memory ?? true, hasOpenAIKey: Boolean(cfg.openaiApiKey), modelIds: modelIds, override: cfg.memoryModel, summary: daemon?.memory, storeDir: memoryDir, storeRows: memoryStoreRows(memoryDir) })) add(c);
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
