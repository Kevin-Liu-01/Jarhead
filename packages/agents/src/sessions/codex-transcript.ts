import type { TurnMark } from "./liveness.ts";
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
 *
 * Turn markers (liveness.ts): event_msg task_started opens a turn, task_complete and
 * turn_aborted close it; every response_item that becomes conversation (messages,
 * reasoning, calls, outputs) keeps it open. token_count, token_usage_record,
 * item_completed and the rest are housekeeping and never renew the lease — Codex
 * Desktop writes them into held threads that are doing nothing. Checked against a
 * rollout from today: 1 task_started, 1 task_complete, 13 token_count, 21 item_completed.
 */

/** Same rule as the listing: injected context arrives as "user" but Kevin never typed it. */
const SYNTHETIC_USER = /^\s*(#\s*AGENTS\.md instructions|#\s*Files mentioned by the user|<[a-z_][\w-]*(\s|>))/i;
const INTERESTING = /"type":"(response_item|event_msg)"/;
const EXIT_CODE = /"exit_code":\s*(-?\d+)|\bexited with code (\d+)\b/i;
const EVENT_TYPE = /"type":"event_msg","payload":\{"type":"([a-z_]+)"/;
const ITEM_TYPE = /"type":"response_item","payload":\{"type":"([a-z_]+)"/;
const SKIPPED_OUTPUT = /"call_id":"([^"]+)"/;
const OUTPUT_TYPES = /"type":"(function_call_output|custom_tool_call_output|local_shell_call_output)"/;
const TURN_ITEMS: ReadonlySet<string> = new Set(["message", "reasoning", "function_call", "custom_tool_call", "local_shell_call", "web_search_call", "function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

/**
 * Whether a raw line bears on the turn, and how — from substrings, no JSON.parse, so
 * the store can run it over its tail slice and the parser over every line alike.
 */
export function codexTurnMark(line: string): TurnMark["kind"] | undefined {
  const event = EVENT_TYPE.exec(line)?.[1];
  if (event !== undefined) {
    if (event === "task_started" || event === "user_message" || event === "agent_message") return "open";
    if (event === "task_complete" || event === "turn_aborted") return "closed";
    return undefined;
  }
  const item = ITEM_TYPE.exec(line)?.[1];
  return item !== undefined && TURN_ITEMS.has(item) ? "open" : undefined;
}

export class CodexTranscriptParser extends TranscriptParser {
  private sawTurn = false;

  protected override visible(draft: Draft): boolean {
    return draft.kind === "turn" || !this.sawTurn;
  }

  push(line: Line): void {
    if (line.skippedBytes !== undefined) {
      this.skipped(line, (head) => (OUTPUT_TYPES.test(head) ? SKIPPED_OUTPUT.exec(head)?.[1] : undefined));
      return;
    }
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
      if (ptype === "task_started") this.mark("open", at);
      else if (ptype === "task_complete" || ptype === "turn_aborted") this.mark("closed", at);
      const message = str(payload["message"])?.trim();
      if (!message) return;
      if (ptype === "user_message" && !SYNTHETIC_USER.test(message)) {
        this.mark("open", at);
        this.add({ id: `L${line.offset}`, role: "user", text: message, at, kind: "event", offset: line.offset });
      } else if (ptype === "agent_message") {
        this.mark("open", at);
        this.add({ id: `L${line.offset}`, role: "assistant", text: message, at, kind: "event", offset: line.offset });
      }
      return;
    }
    if (type !== "response_item") return;
    if (ptype !== undefined && TURN_ITEMS.has(ptype)) this.mark("open", at);
    const id = str(payload["id"]);
    const callId = str(payload["call_id"]);
    const offset = line.offset;
    switch (ptype) {
      case "message": {
        const role = str(payload["role"]);
        const body = outputText(payload["content"])?.trim();
        if (!body) return;
        if (role === "user") {
          if (SYNTHETIC_USER.test(body)) return;
          this.sawTurn = true;
          this.add({ id: id ?? `L${offset}`, role: "user", text: body, at, offset });
        } else if (role === "assistant") {
          this.sawTurn = true;
          this.add({ id: id ?? `L${offset}`, role: "assistant", text: body, at, offset });
        }
        return;
      }
      case "reasoning": {
        const body = reasoningText(payload);
        if (body) this.add({ id: id ?? `L${offset}`, role: "assistant", text: body, at, thinking: true, offset });
        return;
      }
      case "function_call": {
        const name = str(payload["name"]) ?? "tool";
        this.addCall({ id: callId ?? id ?? `L${offset}`, role: "tool", at, tool: { name, input: prettyInput(parseArguments(payload["arguments"])), output: undefined, status: "running" }, offset }, callId ?? id);
        return;
      }
      case "custom_tool_call": {
        const name = str(payload["name"]) ?? "tool";
        this.addCall({ id: callId ?? id ?? `L${offset}`, role: "tool", at, tool: { name, input: prettyInput(payload["input"]), output: undefined, status: "running" }, offset }, callId ?? id);
        return;
      }
      case "local_shell_call": {
        const action = payload["action"];
        const command = isRecord(action) ? action["command"] : undefined;
        this.addCall({ id: callId ?? id ?? `L${offset}`, role: "tool", at, tool: { name: "shell", input: prettyInput({ command }), output: undefined, status: "running" }, offset }, callId ?? id);
        return;
      }
      case "web_search_call": {
        const action = payload["action"];
        const query = isRecord(action) ? str(action["query"]) : undefined;
        const status = str(payload["status"]);
        this.addCall({ id: id ?? callId ?? `L${offset}`, role: "tool", at, tool: { name: "web_search", input: prettyInput(query), output: undefined, status: status === "completed" ? "done" : status === "failed" ? "error" : "running" }, offset }, callId ?? id);
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
