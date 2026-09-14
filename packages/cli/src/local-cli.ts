import { totalmem } from "node:os";
import { dataPaths } from "@jarhead/core";
import { bestFit, discoverLocalServer, serverLabel, suggestedPull } from "@jarhead/brain";
import { BRAIN_KINDS, type BrainKind, type EngineCommand, type LocalModel, type LocalServerStatus, type Snapshot } from "@jarhead/protocol";

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

/**
 * `jarhead models`: one header line for the server, then one row per model — id · size · ctx ·
 * badges · fit · `← brain` / `← memory` for the ones the engine uses; a cloud tag (`remote_host`
 * set) is listed dimmed and never offered; an empty list prints the pull to run; nothing
 * answering says where it looked. Nothing here pulls, loads or deletes anything.
 */
export function modelsLines(status: LocalServerStatus, marks: { readonly brain?: string | undefined; readonly memory?: string | undefined } = {}): string[] {
  if (!status.reachable) return [`  nothing on ${status.baseUrl ? status.baseUrl.replace(/^https?:\/\//, "") : LOCAL_ROOTS_WORDS} — open Ollama, or see docs/LOCAL.md`];
  const server = serverLabel(status);
  const local = status.models.filter((m) => !m.cloud);
  const cloud = status.models.filter((m) => m.cloud);
  const withTools = local.filter((m) => m.capabilities.includes("tools"));
  const host = status.baseUrl.replace(/^https?:\/\//, "");
  const lines = [`  ${server} @ ${host} · ${local.length} model${local.length === 1 ? "" : "s"} · ${withTools.length} with tools${cloud.length ? ` · ${cloud.length} cloud (skipped)` : ""} · ${Math.round(status.ramBytes / GIB)} GiB on this Mac`];
  const width = Math.max(12, ...status.models.map((m) => m.id.length));
  for (const m of [...local, ...cloud]) {
    if (m.cloud) {
      lines.push(`  ${m.id.padEnd(width)}  (cloud — never offered)`);
      continue;
    }
    const mark = marks.brain === m.id && marks.memory === m.id ? "← brain, memory" : marks.brain === m.id ? "← brain" : marks.memory === m.id ? "← memory" : "";
    lines.push(`  ${m.id.padEnd(width)}  ${gbWords(m.sizeBytes).padStart(7)}  ${ctxWords(m.contextLength).padStart(5)}  ${badgeWords(m).padEnd(24)} ${m.fit.padEnd(7)} ${m.loaded ? "loaded " : "        "}${mark}`.trimEnd());
  }
  if (withTools.length === 0) {
    const s = status.suggested ?? suggestedPull(status.ramBytes);
    lines.push(`  no models with tools — ${s.command} (${Math.round(s.sizeBytes / 1e9)} GB; fits this Mac's ${Math.round(status.ramBytes / GIB)} GiB)`);
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

/** The `local` line of `jarhead status`: "ollama 0.34.0 · 7 models (4 fit) · brain qwen3.5:27b", or "none". */
export function localStatusLine(local: LocalServerStatus | undefined, brainModel: string): string {
  if (!local?.reachable) return "  local      none";
  const fit = local.models.filter((m) => !m.cloud && m.capabilities.includes("tools") && m.fit !== "no").length;
  const brain = brainModel.trim() || local.picked || "—";
  return `  local      ${local.flavor ?? "server"}${local.version ? ` ${local.version}` : ""} · ${local.models.length} model${local.models.length === 1 ? "" : "s"} (${fit} fit) · brain ${brain}`;
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
  const lines = [`  setting    ${settings.brain}${settings.brainModel ? ` · model ${settings.brainModel}` : settings.brain === "local" ? ` · model best fit${setup.local.picked ? ` (${setup.local.picked})` : ""}` : ""}${settings.brainBaseUrl ? ` · server ${settings.brainBaseUrl}` : ""}`];
  lines.push(`  running    ${setup.brainResolved ?? "none"} · ${s.brainReady ? "ready" : "not ready"} — ${setup.brainDetail}`);
  const paths =
    setup.dataPaths.length > 0
      ? setup.dataPaths
      : dataPaths({
          brain: settings.brain,
          brainModel: settings.brainModel,
          ...(setup.brainResolved ? { brainResolved: setup.brainResolved } : {}),
          brainDetail: setup.brainDetail,
          local: setup.local,
          ...(s.memory ? { memory: s.memory } : {}),
          hasOpenAIKey: setup.secrets.openai,
          liveModel: setup.liveModel,
        });
  lines.push("  leaves the Mac");
  for (const p of paths) lines.push(`    ${p.what.padEnd(7)} ${p.where.padEnd(6)} ${p.detail}`);
  return lines;
}

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

/** The daemon as `jarhead brain` uses it: one snapshot, or a command followed by the snapshots until one satisfies `until` (≤ `waitMs`). */
export interface BrainDaemon {
  snapshot(): Promise<BrainSnapshot>;
  command(cmd: EngineCommand, until: (s: BrainSnapshot) => boolean, waitMs: number): Promise<BrainSnapshot | undefined>;
}

/** The refusal when no daemon answers: settings.json is the daemon's, never written from here. */
export const NO_DAEMON_FOR_BRAIN = "no daemon answering — start Jarhead (or jarheadd) first; the daemon owns settings.json";

/**
 * `jarhead brain [<kind> [<model>] [--server URL]]`: no arguments prints the setting, what runs and
 * where words go; a kind sends the patch and waits ≤ BRAIN_WAIT_MS for a snapshot that carries the
 * new setting with the brain re-selected (`setup.brain` no longer "unchecked"), then prints the same
 * lines. `local` with no model is the best fit; memory follows the brain setting on its own.
 */
export async function runBrain(rest: readonly string[], server: string | undefined, daemon: () => Promise<BrainDaemon>, out: (line: string) => void): Promise<void> {
  const pick = parseBrainArgs(rest, server);
  let d: BrainDaemon;
  try {
    d = await daemon();
  } catch {
    throw new Error(NO_DAEMON_FOR_BRAIN);
  }
  if (!pick) {
    out("");
    for (const line of brainLines(await d.snapshot())) out(line);
    out("");
    return;
  }
  const landed = (s: BrainSnapshot): boolean => s.settings.brain === pick.kind && s.settings.brainModel === pick.model && (s.settings.brainBaseUrl ?? undefined) === pick.server && s.setup.brain !== "unchecked";
  const snap = await d.command(brainPatch(pick), landed, BRAIN_WAIT_MS);
  out("");
  out(`  sent brain ${pick.kind}${pick.model ? ` ${pick.model}` : pick.kind === "local" ? " (best fit)" : ""}${pick.server ? ` --server ${pick.server}` : ""}`);
  if (!snap) {
    out(`  the daemon did not report the new brain within ${BRAIN_WAIT_MS / 1000} s — \`jarhead brain\` prints what it landed on`);
    out("");
    return;
  }
  for (const line of brainLines(snap)) out(line);
  out("");
}
