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
  const localModel = i.brainModel.trim() || i.local.picked || "";
  if (i.brainResolved === "local") {
    const host = hostOf(i.local.baseUrl);
    const model = localModel || "the local model";
    const server = serverName(i.local);
    if (host === "" || isLoopbackHost(host)) return { what: "brain", where: "mac", detail: `${model} on ${server} — nothing leaves` };
    return { what: "brain", where: "lan", detail: `${model} on ${server} at ${hostPort(i.local.baseUrl)} — screenshots and tool results leave for your network` };
  }
  const kind = i.brainResolved ?? i.brain;
  if (kind === "auto") return { what: "brain", where: "cloud", detail: "the first signed-in backend, not started yet — screenshots and tool results leave" };
  if (kind === "local") {
    const model = localModel || "the best fit on this Mac";
    const until = i.hasOpenAIKey ? "until it is, the brain's work goes to OpenAI and screenshots and tool results leave" : "nothing runs the brain until it is";
    return { what: "brain", where: "cloud", detail: `${model} is not running yet — ${until}` };
  }
  const model = i.brainModel.trim() || i.brainDetail.trim() || "the backend's default model";
  return { what: "brain", where: "cloud", detail: `${vendorOf(kind)} ${model} — screenshots and tool results leave` };
}

function memoryRow(i: DataPathsInput): DataPath {
  const m = i.memory;
  if (!m || !m.enabled) return { what: "memory", where: "off", detail: "memory is off — nothing is read or kept" };
  const chatModel = i.brainModel.trim() || i.local.picked || "";
  if (m.embeddings === "local") {
    const dims = m.embeddingDims ? ` ${m.embeddingDims} dims` : "";
    const extractor = chatModel || "the local model";
    return { what: "memory", where: "mac", detail: `embeddings ${m.embeddingModel ?? "local"}${dims} · extractor ${extractor} — nothing leaves` };
  }
  if (m.embeddings === "keyword") {
    const extractor = i.brain === "local" && chatModel ? `extractor ${chatModel}` : "rules";
    return { what: "memory", where: "mac", detail: `keywords · ${extractor} — nothing leaves` };
  }
  return { what: "memory", where: "cloud", detail: `${m.embeddingModel ?? "text-embedding-3-small"} + a mini model — item text and closed conversations leave` };
}

/**
 * The four rows, in order voice · brain · memory · web. Rules: voice is `cloud` always
 * ("OpenAI ${liveModel} — every word heard and said; billed per second of open session");
 * brain is `mac` when brainResolved === "local" and local.baseUrl is loopback (isLoopbackHost),
 * `lan` when local and not loopback, `cloud` otherwise (naming the vendor: Codex → "OpenAI via
 * your ChatGPT login", claude-code/anthropic-api → "Anthropic", openai-* → "OpenAI"), and the
 * detail names the model and says what leaves ("screenshots and tool results leave");
 * memory is `off` when !enabled, `mac` when embeddings is "local" or "keyword"
 * ("embeddings ${embeddingModel} ${dims} dims · extractor ${brainModel}" / "keywords · rules —
 * nothing leaves"), `cloud` when "openai" ("text-embedding-3-small + a mini model — item text and
 * closed conversations leave"); web is `cloud` "the sites you ask for (web_fetch, web_search)".
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
