import type { BrainKind } from "@jarhead/protocol";

/**
 * Settings.brainModel outlives a switch of brain in Settings: a Claude id left behind
 * would only 404 at Codex, an OpenAI id at Anthropic. One rule, used wherever a brain
 * decides whether to pass the override on: `true` when `model` is another vendor's id
 * for `kind`. Unknown shapes (a gateway alias, a local model) are never foreign.
 */
export function foreignModel(kind: BrainKind, model: string | undefined): boolean {
  const m = model?.trim();
  if (!m) return false;
  switch (kind) {
    case "codex":
    case "openai-responses":
    case "openai-compatible":
      return /^claude/i.test(m);
    case "anthropic-api":
    case "claude-code":
      return /^(gpt-|o\d|chatgpt|gemini|llama|mistral|qwen|deepseek)/i.test(m);
    case "auto":
    case "local":
      return false;
  }
}

/** The model Codex runs: the override when it says something, else what ~/.codex/config.toml says (undefined = Codex's own default). */
export function codexModel(override: string | undefined, configModel: string | undefined): string | undefined {
  return override?.trim() || configModel || undefined;
}
