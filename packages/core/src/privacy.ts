import type { BrainKind, DataPath, LocalFlavor, LocalServerStatus, MemorySummary } from "@jarhead/protocol";
import { isLoopbackHost } from "./policy.ts";

/**
 * What `dataPaths()` needs to say where words go. The engine fills it from the settings, the
 * setup status and the memory summary; the doctor fills the same shape from its own look, so the
 * Console's "Leaves the Mac" section and `pnpm jarhead doctor` print the same four rows.
 */
export interface DataPathsInput {
  readonly brain: BrainKind;
  readonly brainModel: string;
  /** setup.brainResolved: what runs now (a fallback shows here). */
  readonly brainResolved?: Exclude<BrainKind, "auto">;
  readonly brainDetail: string;
  readonly local: LocalServerStatus;
  readonly memory?: Pick<MemorySummary, "enabled" | "embeddings" | "embeddingModel" | "embeddingDims" | "lastRun">;
  readonly hasOpenAIKey: boolean;
  readonly liveModel: string;
}

const SERVER_NAME: Record<LocalFlavor, string> = { ollama: "Ollama", lmstudio: "LM Studio", llamacpp: "llama.cpp" };

/** "Ollama 0.34.0", "LM Studio", "a local server" — the server as the row names it. */
function serverName(local: LocalServerStatus): string {
  const name = local.flavor ? SERVER_NAME[local.flavor] : "a local server";
  return local.version ? `${name} ${local.version}` : name;
}

/** The hostname of a server root, "" when the URL does not parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

/** "10.0.0.5:11434" for the LAN row; the root without its scheme or a trailing slash. */
function hostPort(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** The pinned root is another machine: what goes to the server leaves this Mac for the network. */
function onLan(local: LocalServerStatus): boolean {
  const host = hostOf(local.baseUrl);
  return host !== "" && !isLoopbackHost(host);
}

/** Kevin's pick, or the engine's best fit; "" when neither is known. */
function localModelOf(i: DataPathsInput): string {
  return i.brainModel.trim() || i.local.picked || "";
}

/**
 * The local model that reads closed conversations, when one can right now: memory
 * follows the brain setting, the server answers, and it lists the model. Otherwise the
 * rules extractor reads — the bridge builds it for an offline server, and a pinned id the
 * server no longer has 404s into rules on every run — so the row must not name a model.
 */
function localExtractorOf(i: DataPathsInput): string | undefined {
  if (i.brain !== "local" || !i.local.reachable) return undefined;
  const id = localModelOf(i);
  if (!id) return undefined;
  return i.local.models.some((m) => m.id === id || m.id === `${id}:latest`) ? id : undefined;
}

/** The vendor a cloud brain's words go to. */
function vendorOf(kind: Exclude<BrainKind, "auto" | "local">): string {
  switch (kind) {
    case "codex":
      return "OpenAI via your ChatGPT login";
    case "claude-code":
    case "anthropic-api":
      return "Anthropic";
    case "openai-responses":
    case "openai-compatible":
      return "OpenAI";
  }
}

function brainRow(i: DataPathsInput): DataPath {
  const localModel = localModelOf(i);
  if (i.brainResolved === "local") {
    const model = localModel || "the local model";
    const server = serverName(i.local);
    if (!onLan(i.local)) return { what: "brain", where: "mac", detail: `${model} on ${server} — nothing leaves` };
    return { what: "brain", where: "lan", detail: `${model} on ${server} at ${hostPort(i.local.baseUrl)} — screenshots and tool results leave for your network` };
  }
  const kind = i.brainResolved ?? i.brain;
  if (kind === "auto") return { what: "brain", where: "cloud", detail: "the first signed-in backend, not started yet — screenshots and tool results leave" };
  if (kind === "local") {
    const model = localModel || "the best fit on this Mac";
    const until = i.hasOpenAIKey ? "until it is, the brain's work goes to OpenAI and screenshots and tool results leave" : "nothing runs the brain until it is";
    return { what: "brain", where: "cloud", detail: `${model} is not running yet — ${until}` };
  }
  if (i.brain === "local") {
    // The Responses fallback under an explicit local: brainModel is the LOCAL id, so the cloud brain is named by its own detail.
    const cloud = i.brainDetail.trim() || "the backend's default model";
    return { what: "brain", where: "cloud", detail: `${vendorOf(kind)} ${cloud} — standing in for ${localModel || "the local model"} until it is back; screenshots and tool results leave` };
  }
  const model = i.brainModel.trim() || i.brainDetail.trim() || "the backend's default model";
  return { what: "brain", where: "cloud", detail: `${vendorOf(kind)} ${model} — screenshots and tool results leave` };
}

function memoryRow(i: DataPathsInput): DataPath {
  const m = i.memory;
  if (!m || !m.enabled) return { what: "memory", where: "off", detail: "memory is off — nothing is read or kept" };
  if (m.embeddings === "openai") return { what: "memory", where: "cloud", detail: `${m.embeddingModel ?? "text-embedding-3-small"} + a mini model — item text and closed conversations leave` };
  const extractor = localExtractorOf(i);
  const reads = extractor ? `extractor ${extractor}` : "rules";
  const lan = onLan(i.local);
  if (m.embeddings === "local") {
    const dims = m.embeddingDims ? ` ${m.embeddingDims} dims` : "";
    const how = `embeddings ${m.embeddingModel ?? "local"}${dims} · ${reads}`;
    // The embedder posts item text to the server root; the extractor, when one reads, posts closed conversations there too.
    if (lan) return { what: "memory", where: "lan", detail: `${how} at ${hostPort(i.local.baseUrl)} — ${extractor ? "item text and closed conversations leave" : "item text leaves"} for your network` };
    return { what: "memory", where: "mac", detail: `${how} — nothing leaves` };
  }
  // Keyword matching runs in the daemon; only a local extractor sends anything, and only to the server root.
  if (extractor && lan) return { what: "memory", where: "lan", detail: `keywords · ${reads} at ${hostPort(i.local.baseUrl)} — closed conversations leave for your network` };
  return { what: "memory", where: "mac", detail: `keywords · ${reads} — nothing leaves` };
}

/**
 * The four rows, in order voice · brain · memory · web. Rules: voice is `cloud` always
 * ("OpenAI ${liveModel} — every word heard and said; billed per second of open session");
 * brain is `mac` when brainResolved === "local" and local.baseUrl is loopback (isLoopbackHost),
 * `lan` when local and not loopback, `cloud` otherwise (naming the vendor: Codex → "OpenAI via
 * your ChatGPT login", claude-code/anthropic-api → "Anthropic", openai-* → "OpenAI"), and the
 * detail names the model and says what leaves ("screenshots and tool results leave"); when the
 * setting is local and a cloud brain stands in, the cloud brain is named by its own detail, never
 * by the local model id ("OpenAI responses delegation via gpt-5.6 — standing in for qwen3.5:27b
 * until it is back; …"). Memory is `off` when !enabled; `cloud` when embeddings is "openai"
 * ("text-embedding-3-small + a mini model — item text and closed conversations leave"); for
 * "local" or "keyword" the extractor word is the local model only when it can read right now
 * (brain local, server reachable, model listed), else "rules"; and the row is `lan` when the
 * server root is not loopback and something goes to it — local embeddings ("embeddings
 * ${embeddingModel} ${dims} dims · extractor ${model} at ${host:port} — item text and closed
 * conversations leave for your network") or a local extractor over keywords ("keywords ·
 * extractor ${model} at ${host:port} — closed conversations leave for your network") — and `mac`
 * otherwise ("… — nothing leaves"). Web is `cloud` "the sites you ask for (web_fetch, web_search)".
 * Copy never says "nothing leaves the Mac" globally; the phrase is per row.
 */
export function dataPaths(i: DataPathsInput): DataPath[] {
  return [
    { what: "voice", where: "cloud", detail: `OpenAI ${i.liveModel} — every word heard and said; billed per second of open session` },
    brainRow(i),
    memoryRow(i),
    { what: "web", where: "cloud", detail: "the sites you ask for (web_fetch, web_search)" },
  ];
}
