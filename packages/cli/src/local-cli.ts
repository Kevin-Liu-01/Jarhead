import { totalmem } from "node:os";
import { dataPaths } from "@jarhead/core";
import { bestFit, discoverLocalServer, serverLabel, suggestedPull } from "@jarhead/brain";
import { BRAIN_KINDS, LOCAL_NONE, type BrainKind, type EngineCommand, type LocalModel, type LocalServerStatus, type Snapshot } from "@jarhead/protocol";

/**
 * The CLI's view of the local model server and the brain setting — pure where it can be, so
 * `jarhead models`, `jarhead brain` and the `local` line of `jarhead status` are pinned by a test
 * without a daemon or a server. `models` reads the server directly (no daemon needed; nothing is
 * pulled). `brain` talks to the running daemon, which owns settings.json.
 */

const GIB = 1024 ** 3;

/** "17 GB", "0.6 GB", "—" when the server does not say. */
export function gbWords(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  const gb = bytes / 1e9;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

/** "256k", "8k", "—". */
export function ctxWords(ctx: number | undefined): string {
  return ctx === undefined ? "—" : `${Math.round(ctx / 1024)}k`;
}

/** The badges after the size and window: tools · vision · thinking · embedding, in that order; "no tools" for a completion-only model. */
export function badgeWords(m: LocalModel): string {
  const caps = m.capabilities;
  const words = (["tools", "vision", "thinking", "embedding"] as const).filter((c) => caps.includes(c));
  if (words.length === 0) return "no tools";
  return words.join(" ");
}

/** The three loopback roots discovery asks, as one phrase. */
export const LOCAL_ROOTS_WORDS = "127.0.0.1:11434 / :1234 / :8080";

/** The mark after a row: which of the two jobs the engine gives this model. */
function markWords(id: string, marks: { readonly brain?: string | undefined; readonly memory?: string | undefined }): string {
  return marks.brain === id && marks.memory === id ? "← brain, memory" : marks.brain === id ? "← brain" : marks.memory === id ? "← memory" : "";
}

/**
 * `jarhead models`: one header line for the server, then one row per model — id · size · ctx ·
 * badges · fit · `← brain` / `← memory` for the ones the engine uses. Discovery lists only the
 * chat models in `status.models` (an embedding-only model is carried as `embedModel`, a cloud
 * tag is dropped), so the embedding model memory uses gets a row of its own — size and window
 * are the server's to tell, and it does not tell them here. Nothing tool-capable prints the pull
 * to run (Ollama) or says to load one (LM Studio, llama.cpp); nothing answering says where it
 * looked. Nothing here pulls, loads or deletes anything.
 */
export function modelsLines(status: LocalServerStatus, marks: { readonly brain?: string | undefined; readonly memory?: string | undefined } = {}): string[] {
  if (!status.reachable) return [`  nothing on ${status.baseUrl ? status.baseUrl.replace(/^https?:\/\//, "") : LOCAL_ROOTS_WORDS} — open Ollama, or see docs/LOCAL.md`];
  const server = serverLabel(status);
  const models = status.models;
  const withTools = models.filter((m) => m.capabilities.includes("tools"));
  const embedRow = status.embedModel && !models.some((m) => m.id === status.embedModel) ? status.embedModel : undefined;
  const host = status.baseUrl.replace(/^https?:\/\//, "");
  const lines = [`  ${server} @ ${host} · ${models.length} model${models.length === 1 ? "" : "s"} · ${withTools.length} with tools${embedRow ? " · 1 embedding" : ""} · ${Math.round(status.ramBytes / GIB)} GiB on this Mac`];
  const width = Math.max(12, embedRow?.length ?? 0, ...models.map((m) => m.id.length));
  for (const m of models) {
    lines.push(`  ${m.id.padEnd(width)}  ${gbWords(m.sizeBytes).padStart(7)}  ${ctxWords(m.contextLength).padStart(5)}  ${badgeWords(m).padEnd(24)} ${m.fit.padEnd(7)} ${m.loaded ? "loaded " : "        "}${markWords(m.id, marks)}`.trimEnd());
  }
  if (embedRow) lines.push(`  ${embedRow.padEnd(width)}  ${"—".padStart(7)}  ${"—".padStart(5)}  ${"embedding".padEnd(24)} ${"—".padEnd(7)}         ${markWords(embedRow, marks)}`.trimEnd());
  if (withTools.length === 0) {
    if (status.flavor === "ollama") {
      const s = status.suggested ?? suggestedPull(status.ramBytes);
      lines.push(`  no models with tools — ${s.command} (${Math.round(s.sizeBytes / 1e9)} GB; fits this Mac's ${Math.round(status.ramBytes / GIB)} GiB)`);
    } else {
      lines.push(`  no models with tools — load a model that can call tools in ${server}`);
    }
  }
  return lines;
}

export interface RunModelsOptions {
  readonly json: boolean;
  /** A pinned root (`--server URL`); undefined probes the three loopback ports. */
  readonly server?: string | undefined;
  /** Test seam: answers discovery instead of the network. */
  readonly discover?: typeof discoverLocalServer | undefined;
  readonly ramBytes?: number | undefined;
  readonly out: (line: string) => void;
}

/** `jarhead models [--json] [--server URL]`: one read of the server, no daemon. The brain mark is the best fit (what an empty `brainModel` would run); the memory mark is the discovered embedding model. */
export async function runModels(o: RunModelsOptions): Promise<void> {
  const discover = o.discover ?? discoverLocalServer;
  const status = await discover({ ...(o.server ? { baseUrl: o.server } : {}), ramBytes: o.ramBytes ?? totalmem() });
  if (o.json) {
    o.out(JSON.stringify(status, null, 2));
    return;
  }
  o.out("");
  for (const line of modelsLines(status, { brain: bestFit(status.models)?.id, memory: status.embedModel })) o.out(line);
  o.out("");
}

/**
 * The `local` line of `jarhead status`: "ollama 0.34.0 · 7 models (4 fit) · brain qwen3.5:27b"
 * under the local brain, "… · not the brain (settings: codex)" under any other kind — `brainModel`
 * is a per-backend override, so under codex or openai-compatible it names a cloud model, not a
 * local one — and "none" when nothing answers.
 */
export function localStatusLine(local: LocalServerStatus | undefined, brain: BrainKind | undefined, brainModel: string): string {
  if (!local?.reachable) return "  local      none";
  const fit = local.models.filter((m) => !m.cloud && m.capabilities.includes("tools") && m.fit !== "no").length;
  const who = brain === "local" ? ` · brain ${brainModel.trim() || local.picked || "—"}` : brain ? ` · not the brain (settings: ${brain})` : "";
  return `  local      ${local.flavor ?? "server"}${local.version ? ` ${local.version}` : ""} · ${local.models.length} model${local.models.length === 1 ? "" : "s"} (${fit} fit)${who}`;
}

type BrainSnapshot = Pick<Snapshot, "settings" | "setup" | "brainReady" | "memory">;

/**
 * `jarhead brain` with no arguments, and what a pick prints when it lands: the setting, what runs
 * now (`setup.brainResolved`, ready or not, the brain's own detail) and the four data-path rows
 * — the daemon's `setup.dataPaths`, or the same function over the snapshot when a daemon left
 * them empty.
 */
export function brainLines(s: BrainSnapshot): string[] {
  const { settings, setup } = s;
  // A daemon from a build before the fields answers without `local` and `dataPaths`: the lines still print.
  const local = setup.local ?? LOCAL_NONE;
  const lines = [`  setting    ${settings.brain}${settings.brainModel ? ` · model ${settings.brainModel}` : settings.brain === "local" ? ` · model best fit${local.picked ? ` (${local.picked})` : ""}` : ""}${settings.brainBaseUrl ? ` · server ${settings.brainBaseUrl}` : ""}`];
  lines.push(`  running    ${setup.brainResolved ?? "none"} · ${s.brainReady ? "ready" : "not ready"} — ${setup.brainDetail}`);
  const daemonPaths = setup.dataPaths ?? [];
  const paths =
    daemonPaths.length > 0
      ? daemonPaths
      : dataPaths({
          brain: settings.brain,
          brainModel: settings.brainModel,
          ...(setup.brainResolved ? { brainResolved: setup.brainResolved } : {}),
          brainDetail: setup.brainDetail,
          local,
          ...(s.memory ? { memory: s.memory } : {}),
          hasOpenAIKey: setup.secrets.openai,
          liveModel: setup.liveModel,
        });
  lines.push("  leaves the Mac");
  for (const p of paths) lines.push(`    ${p.what.padEnd(7)} ${p.where.padEnd(6)} ${p.detail}`);
  if (setup.local === undefined) lines.push(`  daemon     ${DAEMON_PREDATES_LOCAL}`);
  return lines;
}

/** Said when the daemon on the socket answers without `setup.local`: a build from before the local brain, which would take a `local` pick and land on Responses without a word. */
export const DAEMON_PREDATES_LOCAL = "predates this build (its snapshot has no setup.local) — quit and reopen Jarhead so the bundled daemon runs";

/** What `jarhead brain <kind> [<model>] [--server URL]` asks for. */
export interface BrainPick {
  readonly kind: Exclude<BrainKind, never>;
  readonly model: string;
  readonly server: string | undefined;
}

/** The kind, model and server from the arguments; undefined for a bare `jarhead brain`; throws on a kind this build does not know. */
export function parseBrainArgs(rest: readonly string[], server: string | undefined): BrainPick | undefined {
  const [kind, model, extra] = rest;
  if (kind === undefined) return undefined;
  if (!(BRAIN_KINDS as readonly string[]).includes(kind)) throw new Error(`usage: jarhead brain [${BRAIN_KINDS.join("|")}] [<model>] [--server URL]  (got ${kind})`);
  if (extra !== undefined) throw new Error("usage: jarhead brain <kind> [<model>] [--server URL] — one model id, then flags");
  return { kind: kind as BrainKind, model: model ?? "", server: server?.trim() || undefined };
}

/** The `set-settings` patch a pick sends: the kind, the model (empty = the backend's default / the best fit), the server pinned or cleared. */
export function brainPatch(pick: BrainPick): EngineCommand {
  return { type: "set-settings", patch: { brain: pick.kind, brainModel: pick.model, brainBaseUrl: pick.server ?? null } };
}

/** How long a pick waits for the daemon to report the brain it landed on. */
export const BRAIN_WAIT_MS = 20_000;

/**
 * The daemon as `jarhead brain` uses it, over one connection: the snapshot the connect answered
 * with, a command followed by the snapshots after it until one satisfies `until` (≤ `waitMs`),
 * and `close()` once, when the verb is done.
 */
export interface BrainDaemon {
  snapshot(): Promise<BrainSnapshot>;
  command(cmd: EngineCommand, until: (s: BrainSnapshot) => boolean, waitMs: number): Promise<BrainSnapshot | undefined>;
  close(): void;
}

/** The refusal when no daemon answers: settings.json is the daemon's, never written from here. */
export const NO_DAEMON_FOR_BRAIN = "no daemon answering — start Jarhead (or jarheadd) first; the daemon owns settings.json";

/** Does the snapshot carry the pick as its setting? */
function carries(s: BrainSnapshot, pick: BrainPick): boolean {
  return s.settings.brain === pick.kind && s.settings.brainModel === pick.model && (s.settings.brainBaseUrl ?? undefined) === pick.server;
}

/**
 * The predicate that ends a pick's wait. The engine snapshots 50 ms after the setting lands but
 * marks the brain re-selecting (`setup.brain` "unchecked", `brainDetail` "restarting") only once
 * the old brain's threads have stopped, so the first snapshot after the patch can carry the new
 * setting with the OLD brain still marked ok and ready. Two phases: a snapshot that says
 * re-selecting, then one that no longer does. Without the first phase, a snapshot counts only
 * when what runs differs from what ran before the patch — the same brain still marked ok is the
 * stale one.
 */
export function landedAfter(pick: BrainPick, before: BrainSnapshot): (s: BrainSnapshot) => boolean {
  let reselecting = false;
  return (s) => {
    if (!carries(s, pick)) return false;
    if (s.setup.brain === "unchecked" || s.setup.brainDetail === "restarting") {
      reselecting = true;
      return false;
    }
    if (reselecting) return true;
    return s.setup.brainResolved !== before.setup.brainResolved || s.setup.brainDetail !== before.setup.brainDetail;
  };
}

/**
 * `jarhead brain [<kind> [<model>] [--server URL]]`: no arguments prints the setting, what runs and
 * where words go; a kind sends the patch and waits ≤ BRAIN_WAIT_MS for the snapshot that carries
 * the new setting with the brain re-selected (`landedAfter`), then prints the same lines. `local`
 * with no model is the best fit; memory follows the brain setting on its own. A daemon from a
 * build before the local brain (no `setup.local` in its snapshot) is refused a pick: it would
 * write the setting and land on Responses without saying so.
 */
export async function runBrain(rest: readonly string[], server: string | undefined, daemon: () => Promise<BrainDaemon>, out: (line: string) => void): Promise<void> {
  const pick = parseBrainArgs(rest, server);
  let d: BrainDaemon;
  try {
    d = await daemon();
  } catch {
    throw new Error(NO_DAEMON_FOR_BRAIN);
  }
  try {
    const before = await d.snapshot();
    if (!pick) {
      out("");
      for (const line of brainLines(before)) out(line);
      out("");
      return;
    }
    if (before.setup.local === undefined) throw new Error(`the daemon ${DAEMON_PREDATES_LOCAL}; nothing was sent`);
    const snap = await d.command(brainPatch(pick), landedAfter(pick, before), BRAIN_WAIT_MS);
    out("");
    out(`  sent brain ${pick.kind}${pick.model ? ` ${pick.model}` : pick.kind === "local" ? " (best fit)" : ""}${pick.server ? ` --server ${pick.server}` : ""}`);
    if (!snap) {
      out(`  the daemon did not report the new brain within ${BRAIN_WAIT_MS / 1000} s — \`jarhead brain\` prints what it landed on`);
      out("");
      return;
    }
    for (const line of brainLines(snap)) out(line);
    out("");
  } finally {
    d.close();
  }
}
