import { isRecord, parseJsonLine, str } from "./store.ts";
import type { Line } from "./tail.ts";
import { TranscriptParser, outputText, prettyInput, type Draft } from "./transcript.ts";

/**
 * Codex rollouts as a conversation.
 *
 * response_item payloads and what becomes of them (shapes from codex-store.ts and Kevin's
 * 0.145–0.153 rollouts):
 *   message user/assistant           → one message, id = payload.id; developer messages and
 *                                       injected "user" context (AGENTS.md, plugin lists…) dropped
 *   reasoning                        → one thinking message from its summary/text, when any
 *   function_call / custom_tool_call → one "tool" message, id = call_id, status running
 *   local_shell_call, web_search_call→ the same, named shell / web_search
 *   *_output                         → the matching call's output and status
 *   agent_message                    → nothing (inter-agent chatter)
 * event_msg user_message / agent_message are the 0.145–0.147 echo of the same turns: kept
 * only while the file has shown no response_item message, as the listing decides.
 */

/** Same rule as the listing: injected context arrives as "user" but Kevin never typed it. */
const SYNTHETIC_USER = /^\s*(#\s*AGENTS\.md instructions|#\s*Files mentioned by the user|<[a-z_][\w-]*(\s|>))/i;
const INTERESTING = /"type":"(response_item|event_msg)"/;
const EXIT_CODE = /"exit_code":\s*(-?\d+)|\bexited with code (\d+)\b/i;

export class CodexTranscriptParser extends TranscriptParser {
  private sawTurn = false;

  protected override visible(draft: Draft): boolean {
    return draft.kind === "turn" || !this.sawTurn;
  }

  push(line: Line): void {
    const text = line.text;
    if (!INTERESTING.test(text)) return;
    const o = parseJsonLine(text);
    if (!o) return;
    const at = this.timestamp(o["timestamp"]);
    const payload = o["payload"];
    if (!isRecord(payload)) return;
    const type = str(o["type"]);
    const ptype = str(payload["type"]);
    if (type === "event_msg") {
      const message = str(payload["message"])?.trim();
      if (!message) return;
      if (ptype === "user_message" && !SYNTHETIC_USER.test(message)) this.add({ id: `L${line.offset}`, role: "user", text: message, at, kind: "event" });
      else if (ptype === "agent_message") this.add({ id: `L${line.offset}`, role: "assistant", text: message, at, kind: "event" });
      return;
    }
    if (type !== "response_item") return;
    const id = str(payload["id"]);
    const callId = str(payload["call_id"]);
    switch (ptype) {
      case "message": {
        const role = str(payload["role"]);
        const body = outputText(payload["content"])?.trim();
        if (!body) return;
        if (role === "user") {
          if (SYNTHETIC_USER.test(body)) return;
          this.sawTurn = true;
          this.add({ id: id ?? `L${line.offset}`, role: "user", text: body, at });
        } else if (role === "assistant") {
          this.sawTurn = true;
          this.add({ id: id ?? `L${line.offset}`, role: "assistant", text: body, at });
        }
        return;
      }
      case "reasoning": {
        const body = reasoningText(payload);
        if (body) this.add({ id: id ?? `L${line.offset}`, role: "assistant", text: body, at, thinking: true });
        return;
      }
      case "function_call": {
        const name = str(payload["name"]) ?? "tool";
        this.addCall({ id: callId ?? id ?? `L${line.offset}`, role: "tool", at, tool: { name, input: prettyInput(parseArguments(payload["arguments"])), output: undefined, status: "running" } }, callId ?? id);
        return;
      }
      case "custom_tool_call": {
        const name = str(payload["name"]) ?? "tool";
        this.addCall({ id: callId ?? id ?? `L${line.offset}`, role: "tool", at, tool: { name, input: prettyInput(payload["input"]), output: undefined, status: "running" } }, callId ?? id);
        return;
      }
      case "local_shell_call": {
        const action = payload["action"];
        const command = isRecord(action) ? action["command"] : undefined;
        this.addCall({ id: callId ?? id ?? `L${line.offset}`, role: "tool", at, tool: { name: "shell", input: prettyInput({ command }), output: undefined, status: "running" } }, callId ?? id);
        return;
      }
      case "web_search_call": {
        const action = payload["action"];
        const query = isRecord(action) ? str(action["query"]) : undefined;
        const status = str(payload["status"]);
        this.addCall({ id: id ?? callId ?? `L${line.offset}`, role: "tool", at, tool: { name: "web_search", input: prettyInput(query), output: undefined, status: status === "completed" ? "done" : status === "failed" ? "error" : "running" } }, callId ?? id);
        return;
      }
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output": {
        const output = outputText(payload["output"]);
        this.result(callId ?? id, output, isError(output));
        return;
      }
      default:
        return;
    }
  }
}

/** `arguments` is a JSON string; parsed it prints as the tool's input, unparsed it stands as it is. */
function parseArguments(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return t;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return t;
  }
}

/** Summary lines and, when the model wrote them in the clear, the reasoning text blocks. */
function reasoningText(payload: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  for (const key of ["summary", "content"] as const) {
    const blocks = payload[key];
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (isRecord(b) && typeof b["text"] === "string" && b["text"].trim()) parts.push(b["text"].trim());
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

/** The exec tools report `exit_code` in a JSON body or "exited with code N" in prose. */
function isError(output: string | undefined): boolean {
  if (!output) return false;
  const m = EXIT_CODE.exec(output);
  if (!m) return false;
  const code = Number(m[1] ?? m[2]);
  return Number.isFinite(code) && code !== 0;
}
