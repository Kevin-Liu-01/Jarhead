import type { RealtimeTool } from "./session.ts";

/**
 * Anthropic tool definitions to the realtime wire shape.
 *
 * The two formats differ only in where the schema lives — `input_schema` versus
 * `parameters` — and in the explicit `type: "function"`. Converting keeps
 * @jarvis/tools as the single place tools are defined, rather than maintaining
 * a second list that drifts.
 */
export interface AnthropicShapedTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export function toRealtimeTools(tools: readonly AnthropicShapedTool[]): RealtimeTool[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}
