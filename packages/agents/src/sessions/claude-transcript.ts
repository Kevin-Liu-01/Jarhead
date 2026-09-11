import { userText } from "./claude-store.ts";
import { isRecord, parseJsonLine, str } from "./store.ts";
import type { Line } from "./tail.ts";
import { TranscriptParser, outputText, prettyInput } from "./transcript.ts";

/**
 * Claude Code's JSONL as a conversation.
 *
 * Lines and what becomes of them (shapes from claude-store.ts, checked against 2.1.260):
 *   user, string or text blocks       → one "user" message, id = the line's uuid; harness
 *                                        blocks and isMeta lines are dropped as in the listing
 *   user, tool_result blocks          → the matching tool call's output and status (is_error)
 *   assistant, text block(s)          → one "assistant" message per message.id, texts merged
 *   assistant, thinking block         → one thinking message per message.id (`<id>:thinking`)
 *   assistant, tool_use block         → one "tool" message, id = the tool_use id, status running
 *   isSidechain lines, summary/title/system/queue/attachment lines → nothing
 * A message is written one block per line, so its parts arrive over several pushes; the
 * parser merges by message.id and marks the message changed each time.
 */
export class ClaudeTranscriptParser extends TranscriptParser {
  push(line: Line): void {
    const text = line.text;
    // Cheap gate: only user and assistant lines carry conversation.
    if (!text.includes('"type":"user"') && !text.includes('"type":"assistant"')) return;
    const o = parseJsonLine(text);
    if (!o) return;
    const type = str(o["type"]);
    if (type !== "user" && type !== "assistant") return;
    const at = this.timestamp(o["timestamp"]);
    if (o["isSidechain"] === true) return;
    const message = o["message"];
    if (!isRecord(message)) return;
    if (type === "user") {
      this.user(o, message, at, line.offset);
      return;
    }
    this.assistant(o, message, at, line.offset);
  }

  private user(o: Record<string, unknown>, message: Record<string, unknown>, at: number, offset: number): void {
    const content = message["content"];
    if (Array.isArray(content)) {
      let results = 0;
      for (const block of content) {
        if (!isRecord(block) || block["type"] !== "tool_result") continue;
        results += 1;
        this.result(str(block["tool_use_id"]), outputText(block["content"]), block["is_error"] === true);
      }
      if (results > 0) return; // a result line carries no human text
    }
    if (o["isMeta"] === true) return;
    const text = userText(message);
    if (text === undefined) return;
    this.add({ id: str(o["uuid"]) ?? `L${offset}`, role: "user", text, at });
  }

  private assistant(o: Record<string, unknown>, message: Record<string, unknown>, at: number, offset: number): void {
    const messageId = str(message["id"]) ?? str(o["uuid"]) ?? `L${offset}`;
    const content = message["content"];
    if (typeof content === "string") {
      this.mergeText({ id: messageId, role: "assistant", text: content, at });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      switch (block["type"]) {
        case "text":
          if (typeof block["text"] === "string") this.mergeText({ id: messageId, role: "assistant", text: block["text"], at });
          break;
        case "thinking":
          if (typeof block["thinking"] === "string") this.mergeText({ id: `${messageId}:thinking`, role: "assistant", text: block["thinking"], at, thinking: true });
          break;
        case "tool_use": {
          const id = str(block["id"]);
          const name = str(block["name"]) ?? "tool";
          this.addCall({ id: id ?? `L${offset}`, role: "tool", at, tool: { name, input: prettyInput(block["input"]), output: undefined, status: "running" } }, id);
          break;
        }
        default:
          break;
      }
    }
  }
}
