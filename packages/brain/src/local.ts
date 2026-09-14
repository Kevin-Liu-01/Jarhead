import { logger } from "@jarhead/core";
import type { Effort, LocalCapability, LocalFit, LocalFlavor, LocalModel, LocalServerStatus } from "@jarhead/protocol";
import { LOCAL_MODELS_MAX } from "@jarhead/protocol";
import type { Brain, BrainResult, BrainSink, BrainTask } from "./brain.ts";
import { brainSystemPrompt } from "./brain.ts";
import {
  OpenAIChatTransport,
  OpenAICompatibleBrain,
  errorMessage,
  finishOf,
  normalizeBaseUrl,
  stripReasoning,
  toChatTool,
  type ChatMessage,
  type ChatTransport,
  type ChatTransportRequest,
  type ChatTurn,
  type RawToolCall,
} from "./compatible.ts";
import type { ToolRunner } from "./runner.ts";
import { AGENT_SPECS, ALL_TOOL_SPECS, BROWSER_SPECS, DRAW_SPECS, SELF_SPECS, THREAD_SPECS, specByName, type ToolSpec } from "./tools.ts";

/**
 * The local brain: a model on this Mac served by Ollama, LM Studio or llama.cpp.
 * Discovery reads what the server lists and what each model can do; the brain
 * itself is the OpenAI-compatible loop (compatible.ts) over a transport — Ollama's
 * native streaming `/api/chat`, which is the only door to `num_ctx`, `keep_alive`
 * and `think`, or the plain Chat Completions POST for the other two servers.
 *
 * Nothing here installs, pulls, loads or deletes anything. When a step is Kevin's,
 * the sentence names the command and a surface offers to copy it.
 */

const log = logger("brain.local");

export const LOCAL_PORTS: readonly { flavor: LocalFlavor; port: number }[] = [
  { flavor: "ollama", port: 11434 },
  { flavor: "lmstudio", port: 1234 },
  { flavor: "llamacpp", port: 8080 },
];
/** Below this Jarhead's ~11k-token preamble does not fit; brain.local warns. */
export const LOCAL_NUM_CTX_MIN = 16_384;
/** Codex's own guidance for agentic use is ≥ 64k; asking for more only grows the KV cache. */
export const LOCAL_NUM_CTX_MAX = 65_536;
/** Room for thinking; stops a looping model (the request timeout was the only brake). */
export const LOCAL_NUM_PREDICT = 4_096;
/** How long Ollama keeps the weights after one of Jarhead's own requests (or its preload); `loaded` is trusted for this long after the last one. */
export const LOCAL_KEEP_ALIVE_MS = 30 * 60_000;
export const LOCAL_KEEP_ALIVE = `${LOCAL_KEEP_ALIVE_MS / 60_000}m`;
/** Ollama's own default keep_alive: how long a model discovery found in memory, but Jarhead did not load, is trusted to stay. */
export const LOCAL_SERVER_KEEP_ALIVE_MS = 5 * 60_000;
export const LOCAL_TEMPERATURE = 0.6;
/** No chunk for this long → "the local model went quiet for 60 s". */
export const LOCAL_STALL_MS = 60_000;
/** A cold load pays load_duration before the first chunk. */
export const LOCAL_FIRST_CHUNK_COLD_MS = 180_000;
export const LOCAL_FIRST_CHUNK_WARM_MS = 45_000;
/** system + tools may take this share of num_ctx before groups are dropped. */
export const LOCAL_TOOL_SHARE = 0.35;
export const EMBED_PREFERENCE: readonly string[] = ["embeddinggemma", "nomic-embed-text", "mxbai-embed-large", "qwen3-embedding", "all-minilm"];

const NOT_LOCAL = new Set([...SELF_SPECS, ...AGENT_SPECS].map((s) => s.name));
/** ALL_TOOL_SPECS minus SELF_SPECS and AGENT_SPECS; thread_* kept (gated by `threads()` at request time). */
export const LOCAL_TOOLS: readonly ToolSpec[] = ALL_TOOL_SPECS.filter((s) => !NOT_LOCAL.has(s.name));
/** Groups fitTools drops, in order, until tokens(system + tools) ≤ LOCAL_TOOL_SHARE × ctx. */
export const LOCAL_DROP_ORDER: readonly { name: "draw" | "browser" | "thread"; specs: readonly ToolSpec[] }[] = [
  { name: "draw", specs: DRAW_SPECS },
  { name: "browser", specs: [...BROWSER_SPECS, ...["web_search", "web_fetch"].map((n) => specByName(n)).filter((s): s is ToolSpec => s !== undefined)] },
  { name: "thread", specs: THREAD_SPECS },
];

const FLAVOR_LABEL: Record<LocalFlavor, string> = { ollama: "Ollama", lmstudio: "LM Studio", llamacpp: "llama.cpp" };
const CAPABILITIES: readonly LocalCapability[] = ["completion", "tools", "vision", "thinking", "embedding"];

/** "Ollama 0.34.0", "LM Studio", "llama.cpp b6001". */
export function serverLabel(s: Pick<LocalServerStatus, "flavor" | "version">): string {
  const name = s.flavor ? FLAVOR_LABEL[s.flavor] : "the local server";
  return s.version ? `${name} ${s.version}` : name;
}

/**
 * Drop whole tool groups, in LOCAL_DROP_ORDER, while the system prompt and the
 * tool table would take more than LOCAL_TOOL_SHARE of the window. A per-model
 * gate decided once at start, not a per-turn routing table.
 */
export function fitTools(o: { ctx: number; systemBytes: number; tools: readonly ToolSpec[]; charsPerToken?: number }): { tools: readonly ToolSpec[]; dropped: readonly string[] } {
  const perToken = o.charsPerToken ?? 4;
  const budget = LOCAL_TOOL_SHARE * o.ctx;
  const tokens = (tools: readonly ToolSpec[]): number => (o.systemBytes + JSON.stringify(tools.map(toChatTool)).length) / perToken;
  let tools = o.tools;
  const dropped: string[] = [];
  for (const group of LOCAL_DROP_ORDER) {
    if (tokens(tools) <= budget) break;
    const names = new Set(group.specs.map((s) => s.name));
    const next = tools.filter((t) => !names.has(t.name));
    if (next.length === tools.length) continue;
    tools = next;
    dropped.push(group.name);
  }
  return { tools, dropped };
}

/** usable = 0.75 × RAM; good ≤ 50 % of usable, tight ≤ 85 %, else no; unknown without a size. */
export function fitFor(sizeBytes: number | undefined, ramBytes: number): LocalFit {
  if (sizeBytes === undefined || !(ramBytes > 0)) return "unknown";
  const usable = 0.75 * ramBytes;
  if (sizeBytes <= 0.5 * usable) return "good";
  if (sizeBytes <= 0.85 * usable) return "tight";
  return "no";
}

const FIT_RANK: Record<LocalFit, number> = { good: 0, unknown: 1, tight: 2, no: 3 };

function canBrain(m: LocalModel): boolean {
  return !m.cloud && m.capabilities.includes("completion") && m.capabilities.includes("tools");
}

/** fit good > tools+vision > newest modifiedAt > smaller size; tools-less, cloud and models that do not fit never. */
export function bestFit(models: readonly LocalModel[]): LocalModel | undefined {
  return [...models].filter((m) => canBrain(m) && m.fit !== "no").sort(bestFitOrder)[0];
}

function bestFitOrder(a: LocalModel, b: LocalModel): number {
  const fit = FIT_RANK[a.fit] - FIT_RANK[b.fit];
  if (fit !== 0) return fit;
  const vision = Number(b.capabilities.includes("vision")) - Number(a.capabilities.includes("vision"));
  if (vision !== 0) return vision;
  const newest = (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0);
  if (newest !== 0) return newest;
  return (a.sizeBytes ?? Number.MAX_SAFE_INTEGER) - (b.sizeBytes ?? Number.MAX_SAFE_INTEGER);
}

/** Picker order: brain-capable first in bestFit order, then the rest (greyed) by the same keys. */
function pickerOrder(a: LocalModel, b: LocalModel): number {
  const usable = Number(canBrain(b)) - Number(canBrain(a));
  return usable !== 0 ? usable : bestFitOrder(a, b);
}

const GIB = 1024 ** 3;
/** By RAM tier. Data, reviewed when the library moves; tests pin the tier boundaries, not the ids. */
export function suggestedPull(ramBytes: number): { id: string; sizeBytes: number; command: string } {
  const gib = ramBytes / GIB;
  const pick = gib <= 8 ? { id: "qwen3.5:4b", sizeBytes: 3.4e9 } : gib <= 16 ? { id: "qwen3.5:9b", sizeBytes: 6.6e9 } : gib <= 32 ? { id: "qwen3.5:27b", sizeBytes: 17e9 } : gib <= 64 ? { id: "qwen3.5:35b", sizeBytes: 24e9 } : { id: "qwen3.5:27b", sizeBytes: 17e9 };
  return { ...pick, command: `ollama pull ${pick.id}` };
}

/** Ollama `think` from Settings.effort, only for a model with `thinking`; the gpt-oss family ignores booleans. */
export function thinkFor(effort: Effort, model: LocalModel): boolean | "low" | "medium" | "high" | undefined {
  if (!model.capabilities.includes("thinking")) return undefined;
  const gptOss = /gpt-oss/i.test(model.id) || /gptoss/i.test(model.family ?? "");
  switch (effort) {
    case "low":
      return gptOss ? "low" : false;
    case "medium":
      return "low";
    case "high":
      return "medium";
    case "xhigh":
    case "max":
      return "high";
  }
}

/** The embedding model memory uses: the first of EMBED_PREFERENCE the server has. */
function embedModelOf(ids: readonly string[]): string | undefined {
  for (const pref of EMBED_PREFERENCE) {
    const hit = ids.find((id) => id === pref || id.split(":")[0] === pref);
    if (hit) return hit;
  }
  return undefined;
}

// ---- discovery ------------------------------------------------------------------------------

export interface DiscoverOptions {
  /** Pinned root (Settings.brainBaseUrl); undefined probes the three loopback ports. */
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Per probe (default 1500 ms). */
  readonly timeoutMs?: number | undefined;
  readonly ramBytes: number;
  readonly now?: (() => number) | undefined;
  /** JARHEAD_BRAIN_API_KEY, for an LM Studio that wants a token. */
  readonly apiKey?: string | undefined;
}

interface Probe {
  readonly flavor: LocalFlavor;
  readonly baseUrl: string;
  readonly version?: string;
}

interface ShowInfo {
  readonly capabilities: readonly LocalCapability[];
  readonly contextLength?: number;
  readonly family?: string;
  readonly parameterSize?: string;
}

/** /api/show answers by digest, for the process: the same weights answer the same. */
const showCache = new Map<string, ShowInfo>();

function headersFor(apiKey: string | undefined): Record<string, string> {
  return { accept: "application/json", "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; json: unknown } | undefined> {
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch {
    return undefined;
  }
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; json: unknown } | undefined> {
  try {
    const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch {
    return undefined;
  }
}

/** One flavour's signature on one root. */
async function probeFlavor(flavor: LocalFlavor, baseUrl: string, fetchImpl: typeof fetch, headers: Record<string, string>, timeoutMs: number): Promise<Probe | undefined> {
  if (flavor === "ollama") {
    const r = await getJson(fetchImpl, `${baseUrl}/api/version`, headers, timeoutMs);
    const version = (r?.json as { version?: unknown } | undefined)?.version;
    if (r?.status === 200 && typeof version === "string") return { flavor, baseUrl, version };
    return undefined;
  }
  if (flavor === "lmstudio") {
    const r = await getJson(fetchImpl, `${baseUrl}/api/v0/models`, headers, timeoutMs);
    if (r?.status === 200 && Array.isArray((r.json as { data?: unknown } | undefined)?.data)) return { flavor, baseUrl };
    return undefined;
  }
  const r = await getJson(fetchImpl, `${baseUrl}/health`, headers, timeoutMs);
  if (r?.status === 200) return { flavor, baseUrl };
  return undefined;
}

/**
 * Find the local model server and list what it can run. A pinned `baseUrl` is
 * asked the three signatures in turn (Ollama's /api/version, LM Studio's
 * /api/v0/models, llama.cpp's /health); otherwise the three well-known loopback
 * ports are asked at once and the first flavour in LOCAL_PORTS order that answers
 * wins. Read-only throughout: nothing is pulled, loaded or unloaded.
 */
export async function discoverLocalServer(o: DiscoverOptions): Promise<LocalServerStatus> {
  const fetchImpl = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 1500;
  const now = o.now ?? Date.now;
  const headers = headersFor(o.apiKey);
  let probe: Probe | undefined;
  if (o.baseUrl?.trim()) {
    const root = normalizeBaseUrl(o.baseUrl);
    for (const { flavor } of LOCAL_PORTS) {
      probe = await probeFlavor(flavor, root, fetchImpl, headers, timeoutMs);
      if (probe) break;
    }
  } else {
    const answers = await Promise.all(LOCAL_PORTS.map(({ flavor, port }) => probeFlavor(flavor, `http://127.0.0.1:${port}`, fetchImpl, headers, timeoutMs)));
    probe = answers.find((a) => a !== undefined);
  }
  if (!probe) return { reachable: false, baseUrl: o.baseUrl?.trim() ? normalizeBaseUrl(o.baseUrl) : "", models: [], ramBytes: o.ramBytes, checkedAt: now() };

  const listed = probe.flavor === "ollama" ? await listOllama(probe.baseUrl, fetchImpl, headers, timeoutMs, o.ramBytes) : probe.flavor === "lmstudio" ? await listLmStudio(probe.baseUrl, fetchImpl, headers, timeoutMs) : await listLlamaCpp(probe.baseUrl, fetchImpl, headers, timeoutMs);
  const models = listed.models.filter((m) => !m.cloud && m.capabilities.includes("completion")).sort(pickerOrder).slice(0, LOCAL_MODELS_MAX);
  const embedModel = embedModelOf(listed.models.filter((m) => !m.cloud && m.capabilities.includes("embedding")).map((m) => m.id));
  const best = bestFit(models);
  return {
    reachable: true,
    flavor: probe.flavor,
    ...(probe.version ?? listed.version ? { version: probe.version ?? listed.version } : {}),
    baseUrl: probe.baseUrl,
    models,
    ...(embedModel ? { embedModel } : {}),
    ...(best ? {} : { suggested: suggestedPull(o.ramBytes) }),
    ramBytes: o.ramBytes,
    checkedAt: now(),
  };
}

interface TagRow {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: { family?: string; parameter_size?: string };
  remote_model?: string;
  remote_host?: string;
}

async function listOllama(baseUrl: string, fetchImpl: typeof fetch, headers: Record<string, string>, timeoutMs: number, ramBytes: number): Promise<{ models: LocalModel[]; version?: string }> {
  const tags = await getJson(fetchImpl, `${baseUrl}/api/tags`, headers, timeoutMs);
  const rows = ((tags?.json as { models?: TagRow[] } | undefined)?.models ?? []).filter((r) => typeof (r.name ?? r.model) === "string");
  const ps = await getJson(fetchImpl, `${baseUrl}/api/ps`, headers, timeoutMs);
  const loaded = new Set(((ps?.json as { models?: Array<{ name?: string; model?: string }> } | undefined)?.models ?? []).map((m) => m.name ?? m.model).filter((n): n is string => typeof n === "string"));
  const local = rows.filter((r) => !r.remote_host && !r.remote_model);
  const infos = new Map<string, ShowInfo>();
  // ≤ 8 /api/show in flight; a digest seen before in this process is not asked again.
  const queue = [...local];
  const worker = async (): Promise<void> => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      const id = (row.model ?? row.name)!;
      const cached = row.digest ? showCache.get(row.digest) : undefined;
      if (cached) {
        infos.set(id, cached);
        continue;
      }
      const info = await showOllama(baseUrl, id, fetchImpl, headers, Math.max(timeoutMs, 5000));
      if (info) {
        infos.set(id, info);
        if (row.digest) showCache.set(row.digest, info);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
  const models = rows.map((row): LocalModel => {
    const id = (row.model ?? row.name)!;
    const info = infos.get(id);
    const cloud = Boolean(row.remote_host || row.remote_model);
    const modifiedAt = row.modified_at ? Date.parse(row.modified_at) : NaN;
    const family = info?.family ?? row.details?.family;
    const parameterSize = info?.parameterSize ?? row.details?.parameter_size;
    return {
      id,
      capabilities: info?.capabilities ?? [],
      ...(typeof row.size === "number" ? { sizeBytes: row.size } : {}),
      ...(info?.contextLength !== undefined ? { contextLength: info.contextLength } : {}),
      ...(family ? { family } : {}),
      ...(parameterSize ? { parameterSize } : {}),
      ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
      fit: fitFor(row.size, ramBytes),
      loaded: loaded.has(id) || loaded.has(row.name ?? ""),
      cloud,
    };
  });
  return { models };
}

async function showOllama(baseUrl: string, id: string, fetchImpl: typeof fetch, headers: Record<string, string>, timeoutMs: number): Promise<ShowInfo | undefined> {
  const r = await postJson(fetchImpl, `${baseUrl}/api/show`, { model: id }, headers, timeoutMs);
  if (r?.status !== 200 || !r.json || typeof r.json !== "object") return undefined;
  const body = r.json as { capabilities?: unknown; model_info?: Record<string, unknown>; details?: { family?: string; parameter_size?: string } };
  const capabilities = (Array.isArray(body.capabilities) ? body.capabilities : []).filter((c): c is LocalCapability => typeof c === "string" && (CAPABILITIES as readonly string[]).includes(c));
  const arch = typeof body.model_info?.["general.architecture"] === "string" ? (body.model_info["general.architecture"] as string) : undefined;
  const ctx = arch ? body.model_info?.[`${arch}.context_length`] : undefined;
  return {
    capabilities,
    ...(typeof ctx === "number" && ctx > 0 ? { contextLength: ctx } : {}),
    ...(body.details?.family ? { family: body.details.family } : {}),
    ...(body.details?.parameter_size ? { parameterSize: body.details.parameter_size } : {}),
  };
}

interface LmStudioRow {
  id?: string;
  type?: string;
  arch?: string;
  state?: string;
  max_context_length?: number;
}

async function listLmStudio(baseUrl: string, fetchImpl: typeof fetch, headers: Record<string, string>, timeoutMs: number): Promise<{ models: LocalModel[]; version?: string }> {
  const r = await getJson(fetchImpl, `${baseUrl}/api/v0/models`, headers, timeoutMs);
  const rows = ((r?.json as { data?: LmStudioRow[] } | undefined)?.data ?? []).filter((m) => typeof m.id === "string");
  const models = rows.map((row): LocalModel => {
    const capabilities: LocalCapability[] = row.type === "embeddings" ? ["embedding"] : row.type === "vlm" ? ["completion", "tools", "vision"] : ["completion", "tools"];
    return {
      id: row.id!,
      capabilities,
      ...(typeof row.max_context_length === "number" && row.max_context_length > 0 ? { contextLength: row.max_context_length } : {}),
      ...(row.arch ? { family: row.arch } : {}),
      fit: "unknown",
      loaded: row.state === "loaded",
      cloud: false,
    };
  });
  return { models };
}

async function listLlamaCpp(baseUrl: string, fetchImpl: typeof fetch, headers: Record<string, string>, timeoutMs: number): Promise<{ models: LocalModel[]; version?: string }> {
  const [props, list] = await Promise.all([getJson(fetchImpl, `${baseUrl}/props`, headers, timeoutMs), getJson(fetchImpl, `${baseUrl}/v1/models`, headers, timeoutMs)]);
  const p = props?.json as { default_generation_settings?: { n_ctx?: number }; build_info?: string; model_path?: string } | undefined;
  const ids = ((list?.json as { data?: Array<{ id?: string }> } | undefined)?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  const id = ids[0] ?? (p?.model_path ? p.model_path.split("/").pop()! : undefined);
  const ctx = p?.default_generation_settings?.n_ctx;
  const models: LocalModel[] = id ? [{ id, capabilities: ["completion", "tools"], ...(typeof ctx === "number" && ctx > 0 ? { contextLength: ctx } : {}), fit: "unknown", loaded: true, cloud: false }] : [];
  return { models, ...(typeof p?.build_info === "string" ? { version: p.build_info } : {}) };
}

// ---- resolving Kevin's pick -----------------------------------------------------------------

export type Resolved = { model: LocalModel; picked: boolean } | { error: string; copy?: string };

/**
 * Which listed model `wanted` names: the exact id, then `<wanted>:latest`, then a
 * unique name match. Every miss is a sentence with the way out; an empty `wanted`
 * is the best fit on this Mac.
 */
export function resolveLocalModel(wanted: string, status: LocalServerStatus): Resolved {
  const server = serverLabel(status);
  if (!status.reachable) {
    const where = status.baseUrl ? status.baseUrl : "127.0.0.1:11434, :1234 or :8080";
    return { error: `nothing answers at ${where}; open Ollama (or LM Studio) and it is picked up within a minute`, copy: "open -a Ollama" };
  }
  const want = wanted.trim();
  const models = status.models;
  if (!want) {
    const best = bestFit(models);
    if (best) return { model: best, picked: true };
    const s = status.suggested ?? suggestedPull(status.ramBytes);
    const gb = Math.round(s.sizeBytes / 1e9);
    if (status.flavor === "ollama") return { error: `nothing on ${server} can call tools; pull one — ${s.command} (${gb} GB)`, copy: s.command };
    return { error: `nothing on ${server} can call tools; load a model that can` };
  }
  if (/:cloud$/i.test(want) || /-cloud$/i.test(want)) return { error: `${want} runs on ollama.com, not this Mac; pick a local tag` };
  const found = models.find((m) => m.id === want) ?? models.find((m) => m.id === `${want}:latest`);
  const byName = found ? [found] : models.filter((m) => m.id.split(":")[0] === want);
  if (byName.length > 1) return { error: `${want} is ambiguous here: ${byName.map((m) => m.id).join(", ")} — pick one` };
  const model = byName[0];
  if (!model) {
    const have = models.map((m) => m.id);
    const shown = have.length ? `it has ${have.slice(0, 6).join(", ")}${have.length > 6 ? ` and ${have.length - 6} more` : ""}` : "it lists nothing";
    return { error: `${want} is not on ${server} (${shown})`, ...(status.flavor === "ollama" ? { copy: `ollama pull ${want}` } : {}) };
  }
  if (model.cloud) return { error: `${model.id} runs on ollama.com, not this Mac; pick a local tag` };
  if (!model.capabilities.includes("tools")) return { error: `${model.id} cannot call tools; pick a model with the tools badge (pnpm jarhead models)` };
  return { model, picked: false };
}

// ---- Ollama's native streaming transport ----------------------------------------------------

export interface OllamaChatTransportOptions {
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly model: LocalModel;
  readonly numCtx: number;
  readonly think: ReturnType<typeof thinkFor>;
  /** Whether the model is in memory right now (discovery's /api/ps, aged by keep_alive): a cold load is given longer before its first chunk. */
  readonly loaded: () => boolean;
  /** A chunk arrived, and the stream ended: the weights are in memory and Ollama's keep_alive counts from here, so the next turn gets the warm budget. */
  readonly onLoaded?: (() => void) | undefined;
  /** The warm budget passed with no chunk: the weights were not in memory after all (Ollama let them go, or is loading another model), so the next turn gets the cold budget. */
  readonly onEvicted?: (() => void) | undefined;
  readonly keepAlive?: string | undefined;
  readonly apiKey?: string | undefined;
  /** Test seam over the LOCAL_* timing constants. */
  readonly timeouts?: { readonly stallMs?: number; readonly firstChunkColdMs?: number; readonly firstChunkWarmMs?: number } | undefined;
}

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: Array<{ id: string; function: { name: string; arguments: unknown } }>;
  tool_name?: string;
  tool_call_id?: string;
};

interface OllamaChunk {
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: RawToolCall[] };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: unknown;
}

/** Chat Completions messages as Ollama's /api/chat takes them: base64 images, object arguments, named tool results. */
export function toOllamaMessages(messages: readonly ChatMessage[]): OllamaMessage[] {
  const names = new Map<string, string>();
  for (const m of messages) if (m.role === "assistant") for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name);
  return messages.map((m): OllamaMessage => {
    switch (m.role) {
      case "system":
        return { role: "system", content: m.content };
      case "user": {
        if (typeof m.content === "string") return { role: "user", content: m.content };
        const text = m.content.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("\n");
        const images = m.content.filter((p) => p.type === "image_url").map((p) => (p as { image_url: { url: string } }).image_url.url.replace(/^data:[^,]*,/, ""));
        return { role: "user", content: text, ...(images.length ? { images } : {}) };
      }
      case "assistant": {
        const calls = (m.tool_calls ?? []).map((c) => {
          let args: unknown = {};
          try {
            args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          } catch {
            args = {};
          }
          return { id: c.id, function: { name: c.function.name, arguments: args } };
        });
        return { role: "assistant", content: m.content ?? "", ...(calls.length ? { tool_calls: calls } : {}) };
      }
      case "tool":
        return { role: "tool", content: m.content, tool_call_id: m.tool_call_id, ...(names.has(m.tool_call_id) ? { tool_name: names.get(m.tool_call_id)! } : {}) };
    }
  });
}

/**
 * POST {base}/api/chat, streaming NDJSON, with the levers /v1 cannot set:
 * `options.num_ctx`, `num_predict`, `keep_alive`, `think`, `truncate: false` (a
 * prompt that does not fit is a sentence, not a silent front-truncation). Thinking,
 * content and tool calls are gathered across chunks; a stall between chunks and a
 * first chunk that never comes are bounded on their own within `deadline`.
 */
export class OllamaChatTransport implements ChatTransport {
  constructor(private readonly o: OllamaChatTransportOptions) {}

  async complete(req: ChatTransportRequest, signal: AbortSignal, deadline: number, sink: Pick<BrainSink, "thinking">): Promise<ChatTurn> {
    const id = this.o.model.id;
    const fail = (error: string, unready?: string): ChatTurn => ({ content: "", toolCalls: [], finish: "error", error, ...(unready ? { unready } : {}) });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail("I ran out of time");
    const warm = this.o.loaded();
    const firstChunkMs = warm ? this.o.timeouts?.firstChunkWarmMs ?? LOCAL_FIRST_CHUNK_WARM_MS : this.o.timeouts?.firstChunkColdMs ?? LOCAL_FIRST_CHUNK_COLD_MS;
    const stallMs = this.o.timeouts?.stallMs ?? LOCAL_STALL_MS;
    const body = {
      model: id,
      messages: toOllamaMessages(req.messages),
      tools: req.tools,
      stream: true,
      options: { num_ctx: this.o.numCtx, num_predict: LOCAL_NUM_PREDICT, temperature: LOCAL_TEMPERATURE },
      keep_alive: this.o.keepAlive ?? LOCAL_KEEP_ALIVE,
      ...(this.o.think !== undefined ? { think: this.o.think } : {}),
      truncate: false,
    };
    // One controller for every timeout; `why` says which one fired.
    const watchdog = new AbortController();
    let why: "first" | "stall" | "deadline" | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, reason: "first" | "stall"): void => {
      if (timer) clearTimeout(timer);
      const left = deadline - Date.now();
      timer = setTimeout(() => {
        why = left <= ms ? "deadline" : reason;
        watchdog.abort();
      }, Math.max(0, Math.min(ms, left)));
    };
    const started = Date.now();
    if (!warm) sink.thinking(`loading ${id}${this.o.model.sizeBytes ? ` (${Math.round(this.o.model.sizeBytes / 1e9)} GB)` : ""}`);
    let res: Response;
    try {
      arm(firstChunkMs, "first");
      res = await this.o.fetch(`${this.o.baseUrl}/api/chat`, {
        method: "POST",
        headers: headersFor(this.o.apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, watchdog.signal]),
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (signal.aborted) throw e;
      if (watchdog.signal.aborted) return fail(this.timeoutSentence(why, warm, firstChunkMs, stallMs));
      return fail(`could not reach ${serverLabel({ flavor: "ollama" })} at ${this.o.baseUrl}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      if (timer) clearTimeout(timer);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        json = undefined;
      }
      if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return this.httpFailure(res.status, errorMessage(json, res.status));
    }
    if (!res.body) {
      if (timer) clearTimeout(timer);
      return fail("the server sent no body");
    }
    // Everything the model said, gathered chunk by chunk.
    let content = "";
    let thinking = "";
    const toolCalls: RawToolCall[] = [];
    let done: OllamaChunk | undefined;
    let error: string | undefined;
    const take = (line: string): void => {
      let chunk: OllamaChunk;
      try {
        chunk = JSON.parse(line) as OllamaChunk;
      } catch {
        return;
      }
      if (chunk.error !== undefined) {
        error = typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error);
        return;
      }
      if (chunk.message?.thinking) thinking += chunk.message.thinking;
      if (chunk.message?.content) content += chunk.message.content;
      if (Array.isArray(chunk.message?.tool_calls)) toolCalls.push(...chunk.message.tool_calls);
      if (chunk.done) done = chunk;
    };
    const decoder = new TextDecoder();
    let partial = "";
    let first = true;
    try {
      for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm(stallMs, "stall");
        if (first) {
          first = false;
          this.o.onLoaded?.();
        }
        partial += decoder.decode(piece, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) take(line);
        if (error) break;
      }
      partial += decoder.decode();
      if (partial.trim()) take(partial);
      // keep_alive counts from the end of the request: the model is warm from now, not from the first chunk.
      if (!first) this.o.onLoaded?.();
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (signal.aborted) throw e;
      if (watchdog.signal.aborted) return fail(this.timeoutSentence(why, warm, firstChunkMs, stallMs));
      return fail(`the stream from ${id} broke: ${(e as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (error) return this.httpFailure(400, error);
    const stripped = stripReasoning(content);
    const reasoning = [thinking.trim(), stripped.reasoning ?? ""].filter(Boolean).join("\n") || undefined;
    const usage: NonNullable<ChatTurn["usage"]> = {
      ...(typeof done?.prompt_eval_count === "number" ? { promptTokens: done.prompt_eval_count } : {}),
      ...(typeof done?.eval_count === "number" ? { outputTokens: done.eval_count } : {}),
      ms: typeof done?.total_duration === "number" ? Math.round(done.total_duration / 1e6) : Date.now() - started,
      ...(typeof done?.load_duration === "number" && done.load_duration > 0 ? { loadMs: Math.round(done.load_duration / 1e6) } : {}),
    };
    return { content: stripped.content, ...(reasoning ? { reasoning } : {}), toolCalls, finish: finishOf(done?.done_reason, toolCalls.length), usage };
  }

  /** `warm` is the guess the budget was picked on; a warm guess that saw no chunk was wrong, and says so to the brain. */
  private timeoutSentence(why: "first" | "stall" | "deadline" | undefined, warm: boolean, firstChunkMs: number, stallMs: number): string {
    const id = this.o.model.id;
    if (why === "deadline") return "I ran out of time";
    if (why === "first") {
      const s = Math.round(firstChunkMs / 1000);
      if (!warm) return `${id} sent nothing for ${s} s while loading; is Ollama busy with another model?`;
      this.o.onEvicted?.();
      return `${id} sent nothing for ${s} s; Ollama is busy or let it go — say it again and I will wait for the load`;
    }
    return `the local model went quiet for ${Math.round(stallMs / 1000)} s`;
  }

  private httpFailure(status: number, message: string): ChatTurn {
    const id = this.o.model.id;
    const fail = (error: string, unready?: string): ChatTurn => ({ content: "", toolCalls: [], finish: "error", error, ...(unready ? { unready } : {}) });
    if (/context length|exceeds/i.test(message)) return fail(`the request did not fit ${id}'s ${Math.round(this.o.numCtx / 1024)}k context; say it in fewer steps`);
    if (/does not support tools/i.test(message)) {
      const s = `${id} cannot call tools; pick a model with the tools badge`;
      return fail(s, s);
    }
    if (/does not support thinking/i.test(message)) {
      const s = `${id} does not support thinking; Jarhead will stop asking it to`;
      return fail(s, s);
    }
    if (status === 404 || /not found/i.test(message)) {
      const s = `${id} is not on Ollama any more; pick another model`;
      return fail(s, s);
    }
    if (status === 401 || status === 403) {
      const s = `the server rejected the API key (${status})`;
      return fail(s, s);
    }
    return fail(`server error ${status}: ${message}`);
  }
}

// ---- the brain ------------------------------------------------------------------------------

export interface LocalBrainOptions {
  readonly runner: ToolRunner;
  /** Pinned root, or undefined to discover. */
  readonly baseUrl?: string | undefined;
  /** Settings.brainModel; "" = best fit. */
  readonly model: string;
  readonly effort: Effort;
  /** Settings.threads read live: thread_* are sent only when true. */
  readonly threads: () => boolean;
  /** A fresh discovery the engine already made (spares reuse main's); the brain discovers when absent or older than 60 s. */
  readonly status?: LocalServerStatus | undefined;
  readonly ramBytes: number;
  /** JARHEAD_BRAIN_API_KEY only (LM Studio tokens); never OPENAI_API_KEY. */
  readonly apiKey?: string | undefined;
  readonly userName?: string | undefined;
  /** ThreadBrainSpec.secondsCap × 1000 for a thread's brain. */
  readonly maxWallMs?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Status changed (a look, a pick, a mid-run capability failure): the engine redraws setup.local and may raise brain.local. */
  readonly onStatus?: ((s: LocalServerStatus) => void) | undefined;
  /** Test seam for the transport's timing constants. */
  readonly timeouts?: OllamaChatTransportOptions["timeouts"];
  /** Test seam: the clock discovery is stamped with and the loaded guess ages by. */
  readonly now?: (() => number) | undefined;
}

/** Discovery older than this is redone at start(). */
const STATUS_FRESH_MS = 60_000;

/** LM Studio runs these families' own tool templates; anything else gets its "default" prompt-injected mode. */
function lmStudioNativeTools(id: string): boolean {
  return /qwen2\.5|qwen3|llama-?3\.[12]|mistral|ministral/i.test(id);
}

/**
 * The local brain. `start()` discovers the server, resolves Kevin's pick (or the
 * best fit), fits the tool table to the window and builds the OpenAI-compatible
 * loop over the right transport. `warmUp()` preloads the weights at wake, `cool()`
 * lets them go at sleep; `stop()` only stops the task.
 */
export class LocalBrain implements Brain {
  readonly kind = "local";
  private inner: OpenAICompatibleBrain | undefined;
  private innerThreads = false;
  private innerReadyDetail = "";
  private current: LocalServerStatus;
  private model: LocalModel | undefined;
  private picked = false;
  private numCtx = LOCAL_NUM_CTX_MAX;
  private think: ReturnType<typeof thinkFor>;
  private tools: readonly ToolSpec[] = [];
  private dropped: readonly string[] = [];
  private ready = false;
  private readyDetail = "not started";
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** When Jarhead itself last saw each model's weights in memory (a chunk, a stream's end, a preload); absent = only discovery's /api/ps says so. */
  private readonly loadedAt = new Map<string, number>();

  constructor(private readonly opts: LocalBrainOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.current = opts.status ?? { reachable: false, baseUrl: opts.baseUrl ? normalizeBaseUrl(opts.baseUrl) : "", models: [], ramBytes: opts.ramBytes, checkedAt: 0 };
  }

  /** False for a text-only model, so the engine skips the pre-warm screenshot; true until a model is known. */
  get acceptsImages(): boolean {
    return this.model ? this.model.capabilities.includes("vision") : true;
  }

  /** The last discovery + pick. */
  get status(): LocalServerStatus {
    return this.current;
  }

  /** "Local · qwen3.5:27b on Ollama 0.34.0 · 64k ctx · vision · thinking low · 58 tools" — the Console shows it verbatim. */
  get detail(): string {
    return this.readyDetail;
  }

  async start(): Promise<{ ready: boolean; detail: string }> {
    const fresh = this.opts.status && this.now() - this.opts.status.checkedAt < STATUS_FRESH_MS && this.current === this.opts.status;
    const status = fresh ? this.opts.status! : await discoverLocalServer({ baseUrl: this.opts.baseUrl, fetch: this.fetchImpl, ramBytes: this.opts.ramBytes, apiKey: this.opts.apiKey, now: this.now });
    const resolved = resolveLocalModel(this.opts.model, status);
    if ("error" in resolved) {
      this.current = status;
      this.model = undefined;
      this.ready = false;
      this.readyDetail = resolved.error;
      this.opts.onStatus?.(this.current);
      return { ready: false, detail: this.readyDetail };
    }
    this.model = resolved.model;
    this.picked = resolved.picked;
    const { picked: _earlier, ...rest } = status;
    this.current = resolved.picked ? { ...rest, picked: resolved.model.id } : rest;
    const trained = this.model.contextLength;
    this.numCtx = trained === undefined ? LOCAL_NUM_CTX_MAX : trained < LOCAL_NUM_CTX_MIN ? trained : Math.min(trained, LOCAL_NUM_CTX_MAX);
    this.think = thinkFor(this.opts.effort, this.model);
    const started = await this.buildInner(status);
    this.ready = started.ready;
    this.readyDetail = started.ready ? this.compose(status) : this.startFailure(status, started.detail);
    if (started.ready) log.info(`ready: ${this.readyDetail}`);
    this.opts.onStatus?.(this.current);
    return { ready: this.ready, detail: this.readyDetail };
  }

  /** The tool table for this window and this moment's Settings.threads, then the loop over the right transport. */
  private async buildInner(status: LocalServerStatus): Promise<{ ready: boolean; detail: string }> {
    const model = this.model!;
    const threads = this.opts.threads();
    const wanted = LOCAL_TOOLS.filter((t) => threads || !t.name.startsWith("thread_"));
    const fitted = fitTools({ ctx: this.numCtx, systemBytes: brainSystemPrompt(this.opts.userName).length, tools: wanted });
    this.tools = fitted.tools;
    this.dropped = fitted.dropped;
    this.innerThreads = threads;
    const hasVision = model.capabilities.includes("vision");
    const transport: ChatTransport =
      status.flavor === "ollama"
        ? new OllamaChatTransport({
            baseUrl: status.baseUrl,
            fetch: this.fetchImpl,
            model,
            numCtx: this.numCtx,
            think: this.think,
            loaded: () => this.isLoaded(model.id),
            onLoaded: () => this.markLoaded(model.id, true),
            onEvicted: () => this.markLoaded(model.id, false),
            apiKey: this.opts.apiKey,
            timeouts: this.opts.timeouts,
          })
        : new OpenAIChatTransport({ baseUrl: status.baseUrl, headers: () => headersFor(this.opts.apiKey), fetch: this.fetchImpl, requestTimeoutMs: 180_000 });
    if (this.inner) await this.inner.stop();
    this.inner = new OpenAICompatibleBrain({
      runner: this.opts.runner,
      baseUrl: status.baseUrl,
      apiKey: this.opts.apiKey,
      model: model.id,
      capabilities: { images: hasVision },
      tools: this.tools,
      imageHistory: "newest",
      label: "Local",
      maxWallMs: this.opts.maxWallMs,
      userName: this.opts.userName,
      fetch: this.fetchImpl,
      transport,
    });
    const r = await this.inner.start();
    this.innerReadyDetail = this.inner.detail;
    return r;
  }

  private compose(status: LocalServerStatus): string {
    const model = this.model!;
    const ctx = model.contextLength !== undefined && model.contextLength < LOCAL_NUM_CTX_MIN ? `${Math.round(this.numCtx / 1024)}k ctx (small)` : `${Math.round(this.numCtx / 1024)}k ctx`;
    const think = this.think === undefined || this.think === false ? "off" : this.think === true ? "on" : this.think;
    const parts = [`Local · ${model.id} on ${serverLabel(status)}`, ctx, model.capabilities.includes("vision") ? "vision" : "text-only", `thinking ${think}`, `${this.tools.length} tools${this.dropped.length ? ` (${this.dropped.join(", ")} dropped)` : ""}`];
    if (status.flavor === "lmstudio" && !lmStudioNativeTools(model.id)) parts.push("tools: LM Studio default mode");
    if (status.flavor === "llamacpp") parts.push("tools need --jinja");
    if (this.picked) parts.push("best fit (pick another in Settings)");
    return parts.join(" · ");
  }

  private startFailure(status: LocalServerStatus, detail: string): string {
    if (status.flavor === "lmstudio" && /API key/i.test(detail)) return "LM Studio wants a token: put JARHEAD_BRAIN_API_KEY=… in ~/.jarhead/env";
    return detail;
  }

  async handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    if (!this.ready || !this.inner || !this.model) return { status: "failed", error: this.readyDetail };
    if (this.opts.threads() !== this.innerThreads) {
      // Settings.threads moved since the table was built: rebuild it without a restart from the engine.
      const r = await this.buildInner(this.current);
      if (!r.ready) {
        this.ready = false;
        this.readyDetail = this.startFailure(this.current, r.detail);
        this.opts.onStatus?.(this.current);
        return { status: "failed", error: this.readyDetail };
      }
      this.readyDetail = this.compose(this.current);
    }
    const result = await this.inner.handle(task, sink);
    if (result.status === "failed" && this.inner.detail !== this.innerReadyDetail) {
      // The model turned out unable mid-run (no tools, gone, a rejected token): the brain is down until a restart.
      this.ready = false;
      this.readyDetail = this.inner.detail;
      this.opts.onStatus?.(this.current);
    }
    return result;
  }

  async cancel(): Promise<void> {
    await this.inner?.cancel();
  }

  async stop(): Promise<void> {
    await this.inner?.stop();
    this.ready = false;
    this.readyDetail = "stopped";
  }

  /** Ollama: the documented preload — POST /api/generate with the model and keep_alive, no prompt. Others are warm by construction or per request. */
  async warmUp(): Promise<{ warm: boolean; detail: string }> {
    if (!this.ready || !this.model) return { warm: false, detail: this.readyDetail };
    if (this.current.flavor !== "ollama") return { warm: true, detail: this.readyDetail };
    const r = await postJson(this.fetchImpl, `${this.current.baseUrl}/api/generate`, { model: this.model.id, keep_alive: LOCAL_KEEP_ALIVE, stream: false }, headersFor(this.opts.apiKey), LOCAL_FIRST_CHUNK_COLD_MS);
    if (r?.status === 200) {
      this.markLoaded(this.model.id, true);
      return { warm: true, detail: this.readyDetail };
    }
    return { warm: false, detail: r ? `${this.model.id} did not load: ${errorMessage(r.json, r.status)}` : `${serverLabel(this.current)} did not answer the preload` };
  }

  /** Ollama: keep_alive 0 lets the weights go while Jarhead sleeps. Never throws. */
  async cool(): Promise<void> {
    if (!this.model || this.current.flavor !== "ollama") return;
    const r = await postJson(this.fetchImpl, `${this.current.baseUrl}/api/generate`, { model: this.model.id, keep_alive: 0, stream: false }, headersFor(this.opts.apiKey), 10_000);
    if (r?.status === 200) this.markLoaded(this.model.id, false);
  }

  /**
   * The warm guess, aged: `loaded` from discovery or a mark is trusted only while the
   * keep-alive it came with has not run out — LOCAL_KEEP_ALIVE after one of Jarhead's own
   * requests, Ollama's default after a /api/ps sighting alone. Nothing here re-reads the
   * server; a stale true costs a cold load under the warm budget, a stale false costs nothing.
   */
  private isLoaded(id: string): boolean {
    if (!this.current.models.find((m) => m.id === id)?.loaded) return false;
    const mine = this.loadedAt.get(id);
    const since = mine === undefined ? this.current.checkedAt : Math.max(mine, this.current.checkedAt);
    return this.now() - since < (mine === undefined ? LOCAL_SERVER_KEEP_ALIVE_MS : LOCAL_KEEP_ALIVE_MS);
  }

  private markLoaded(id: string, loaded: boolean): void {
    if (loaded) this.loadedAt.set(id, this.now());
    else this.loadedAt.delete(id);
    if (this.current.models.find((m) => m.id === id)?.loaded === loaded) return;
    this.current = { ...this.current, models: this.current.models.map((m) => (m.id === id ? { ...m, loaded } : m)) };
  }
}
