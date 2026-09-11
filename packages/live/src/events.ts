/**
 * The GPT-Live wire protocol, as observed on 2026-09-10 against
 * wss://api.openai.com/v1/live/sessions and cross-checked with the `openai@7.14`
 * SDK types (resources/live/live.d.ts). Only the fields Jarhead reads are typed;
 * unknown fields pass through untouched so a server addition never breaks us.
 */

export type BuiltInVoice =
  | "alloy" | "ash" | "ballad" | "beacon" | "bossa" | "cedar" | "cinder" | "coral" | "delta" | "echo" | "gleam"
  | "marin" | "meridian" | "quartz" | "ripple" | "sage" | "shimmer" | "stone" | "tempo" | "verse" | "vesper" | "willow";

export interface InitialItem {
  readonly type?: "message";
  readonly role: "developer" | "user" | "assistant";
  readonly content: readonly { readonly type: "input_text" | "text" | "output_text"; readonly text: string }[];
}

export interface ResponsesDelegationConfig {
  readonly model: string;
  readonly instructions?: string;
  readonly tools?: readonly unknown[];
  readonly tool_choice?: unknown;
  readonly reasoning?: { readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" };
  readonly parallel_tool_calls?: boolean;
  readonly max_output_tokens?: number;
}

export interface SessionConfig {
  readonly model: string;
  readonly instructions?: string;
  readonly audio?: {
    readonly format?: { readonly type: "audio/pcm"; readonly rate: 16000 | 24000 };
    readonly output?: { readonly voice?: string };
  };
  readonly delegation?: { readonly type: "client" } | { readonly type: "responses"; readonly responses: ResponsesDelegationConfig } | null;
  readonly input?: readonly InitialItem[];
  readonly store?: boolean;
}

// ------------------------------------------------------------ client events

export type ClientEvent =
  | { readonly type: "session.start"; readonly event_id?: string; readonly session: SessionConfig }
  | { readonly type: "session.update"; readonly event_id?: string; readonly session: { readonly delegation?: unknown } }
  | { readonly type: "session.input_audio.append"; readonly audio: string }
  | { readonly type: "session.input_audio.mute"; readonly event_id?: string }
  | { readonly type: "session.input_audio.unmute"; readonly event_id?: string }
  | { readonly type: "session.instructions.append"; readonly event_id?: string; readonly delegation_id: string | null; readonly content: string }
  | { readonly type: "session.thinking.append"; readonly event_id?: string; readonly delegation_id: string | null; readonly content: string }
  | { readonly type: "session.commentary.append"; readonly event_id?: string; readonly delegation_id: string | null; readonly content: string }
  | { readonly type: "response.item.create"; readonly event_id?: string; readonly item: unknown }
  | { readonly type: "response.create"; readonly event_id?: string }
  | { readonly type: "session.close"; readonly event_id?: string };

// ------------------------------------------------------------ server events

export interface SessionResource {
  readonly id: string;
  readonly expires_at: number;
  readonly model: string;
  readonly status: "active";
  readonly instructions?: string;
  readonly audio?: { readonly format?: { readonly type: string; readonly rate: number }; readonly output?: { readonly voice?: string } };
  readonly delegation?: { readonly type: "client" | "responses" } | null;
}

interface Timed {
  readonly start_ms: number;
  readonly end_ms: number;
}

export type ServerEvent =
  | { readonly type: "session.started"; readonly event_id: string; readonly session: SessionResource; readonly client_event_id?: string }
  | { readonly type: "session.updated"; readonly event_id: string; readonly session: SessionResource; readonly client_event_id?: string }
  | { readonly type: "session.input_audio.muted"; readonly event_id: string; readonly client_event_id?: string }
  | { readonly type: "session.input_audio.unmuted"; readonly event_id: string; readonly client_event_id?: string }
  | ({ readonly type: "session.instructions.appended"; readonly event_id: string; readonly client_event_id?: string } & Timed)
  | ({ readonly type: "session.thinking.appended"; readonly event_id: string; readonly client_event_id?: string } & Timed)
  | ({ readonly type: "session.commentary.appended"; readonly event_id: string; readonly client_event_id?: string } & Timed)
  | { readonly type: "session.input_audio.append"; readonly audio: string }
  | { readonly type: "session.output_audio.delta"; readonly delta: string; readonly start_ms?: number; readonly end_ms?: number }
  | ({ readonly type: "session.input_transcript.delta"; readonly event_id: string; readonly delta: string } & Timed)
  | ({ readonly type: "session.output_transcript.delta"; readonly event_id: string; readonly delta: string } & Timed)
  | {
      readonly type: "session.delegation.created";
      readonly event_id: string;
      readonly offset_ms: number;
      readonly delegation: { readonly id: string; readonly type: "delegation"; readonly target: "client" | "responses"; readonly response_id?: string };
    }
  | { readonly type: "response.event"; readonly event_id: string; readonly delegation_id?: string | null; readonly event: Record<string, unknown> }
  | { readonly type: "session.usage.updated"; readonly event_id: string; readonly usage: { readonly seconds: number }; readonly context_window?: { readonly usage_ratio: number } }
  | {
      readonly type: "session.closed";
      readonly event_id: string;
      readonly reason: "close_requested" | "expired" | "content" | "remote_hangup" | "connection_lost";
      readonly session: SessionResource;
      readonly usage: { readonly seconds: number };
    }
  | { readonly type: "error"; readonly event_id: string; readonly error: { readonly type: string; readonly code: string; readonly message: string; readonly param?: string; readonly client_event_id?: string } }
  | { readonly type: "info"; readonly event_id: string; readonly code: string; readonly message: string };

export type ServerEventType = ServerEvent["type"];

/** Parse one frame. Unknown types come back as `{type}` so callers can log them. */
export function parseServerEvent(raw: string): ServerEvent | { readonly type: string } | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof msg !== "object" || msg === null) return undefined;
  const type = (msg as { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  return msg as ServerEvent;
}

export const LIVE_URL = "wss://api.openai.com/v1/live/sessions";
export const LIVE_MODEL = "gpt-live-1";
export const SAMPLE_RATE = 24000;
