import { EventEmitter } from "node:events";
import { logger } from "@jarhead/core";
import {
  LIVE_MODEL,
  LIVE_URL,
  parseServerEvent,
  type ClientEvent,
  type ServerEvent,
  type SessionConfig,
  type SessionResource,
} from "./events.ts";

/**
 * One GPT-Live primary WebSocket.
 *
 * Deliberately thin: it frames events, tracks the session resource, and exposes
 * typed emits. Policy — who speaks, what gets delegated, how appends are
 * chunked — lives above it. The one piece of judgement here is the send queue:
 * audio may be fed before `session.started`, and dropping it would clip the
 * first word Kevin says after waking.
 */

export interface LiveSessionOptions {
  readonly apiKey: string;
  readonly config: SessionConfig;
  readonly url?: string;
  /** Injected for tests. Defaults to the global WebSocket (Node 24). */
  readonly webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocketLike;
  readonly connectTimeoutMs?: number;
}

/** The subset of WebSocket this class needs, so tests can fake it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

export type LiveState = "idle" | "connecting" | "started" | "closing" | "closed";

export interface LiveSessionEvents {
  started: [session: SessionResource];
  event: [event: ServerEvent];
  audio: [pcm: Buffer];
  inputTranscript: [delta: string, startMs: number, endMs: number];
  outputTranscript: [delta: string, startMs: number, endMs: number];
  delegation: [delegationId: string, target: "client" | "responses", offsetMs: number];
  responseEvent: [delegationId: string | null, event: Record<string, unknown>];
  usage: [seconds: number, contextRatio: number | undefined];
  appended: [channel: "thinking" | "commentary" | "instructions", clientEventId: string | undefined, startMs: number];
  closed: [reason: string, usageSeconds: number];
  error: [error: Error, clientEventId: string | undefined];
  state: [state: LiveState];
}

const log = logger("live");

/**
 * What a GPT-Live-1 error is about, for the typed problem the engine raises (REDESIGN
 * §16, "Problems, typed"). The server's `error` frames arrive as `code: message`
 * (`dispatch`), a failed start as this class's own words; both are matched here.
 *
 * - `limit`: the session hit a cap that passes — a rate limit, the 128-item / 32 768-token
 *   response input history (`response_input_buffer_full`, 10 rows in two days of Kevin's
 *   ledger), the append cap. Transient: the remedy is to wait, and the row clears itself.
 * - `connection`: the socket, the network, the server closing us (`connection_lost`,
 *   `remote_hangup`, a start that never answered); the engine reconnects on its own.
 * - `key`: authentication and billing — a missing, stale or unentitled key, a model the
 *   key cannot see, an exhausted quota (`insufficient_quota`, "check your plan and
 *   billing"). Nothing recovers this by waiting: Setup is the remedy, and the row stays.
 * - `other`: everything else (`context_injection_incomplete` is an append racing a
 *   close, `unknown_parameter` a client bug); shown as it is.
 *
 * Precedence: billing first (a quota message also says "exceeded", which is limit-shaped);
 * then a key error that is not also a rate-limit message; then limit; then connection.
 */
export type LiveErrorKind = "limit" | "connection" | "key" | "other";

const BILLING_ERROR = /insufficient_quota|\bquota\b|\bbilling\b|exceeded your current quota/i;
const LIMIT_ERROR = /rate[_ ]?limit|too many requests|\b429\b|response_input_buffer_full|buffer.*\bfull\b|limited to \d+ items|context_window|token limit|max_tokens|over capacity|overloaded/i;
const KEY_ERROR = /invalid_api_key|incorrect api key|api[_ ]?key|authentication|unauthori[sz]ed|\b401\b|\b403\b|permission_denied|model_not_found|not listed for it|not available for|OPENAI_API_KEY/i;
const CONNECTION_ERROR = /connection_lost|connection lost|remote_hangup|socket (closed|error)|closed before (it )?start|did not start within|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|\bnetwork\b|handshake|\b50[234]\b|server_error|internal_error|service unavailable|websocket|\bexpired\b/i;

/** Classify a Live error's message (`code: message` from the server, or a start failure). Never throws; the empty string is `other`. */
export function classifyLiveError(message: string): LiveErrorKind {
  const text = String(message ?? "");
  // An exhausted quota is a billing problem: "Retry in 30 s" would lie and the row would
  // clear with the wake still failing. Setup, and the row stays until the key answers.
  if (BILLING_ERROR.test(text)) return "key";
  // A key error that also names a rate limit ("401 rate" is not a thing, but be safe) is the limit.
  if (KEY_ERROR.test(text) && !LIMIT_ERROR.test(text)) return "key";
  if (LIMIT_ERROR.test(text)) return "limit";
  if (CONNECTION_ERROR.test(text)) return "connection";
  return "other";
}

function defaultFactory(url: string, headers: Record<string, string>): WebSocketLike {
  // Node's WebSocket accepts headers through a non-standard options bag.
  return new WebSocket(url, { headers } as unknown as string[]) as unknown as WebSocketLike;
}

export class LiveSession extends EventEmitter<LiveSessionEvents> {
  private ws: WebSocketLike | undefined;
  private state: LiveState = "idle";
  private resource: SessionResource | undefined;
  private readonly pending: string[] = [];
  private eventSeq = 0;
  private usageSeconds = 0;
  /** Wall clock at session.started; session-timeline ms ≈ now - this. */
  private startedAtWall = 0;

  constructor(private readonly opts: LiveSessionOptions) {
    super();
  }

  get currentState(): LiveState {
    return this.state;
  }

  get session(): SessionResource | undefined {
    return this.resource;
  }

  /** Approximate current position on the session timeline, in ms. */
  get nowMs(): number {
    return this.startedAtWall === 0 ? 0 : Date.now() - this.startedAtWall;
  }

  get billedSeconds(): number {
    return this.usageSeconds;
  }

  private setState(next: LiveState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit("state", next);
  }

  private nextEventId(prefix: string): string {
    this.eventSeq += 1;
    return `${prefix}_${this.eventSeq}`;
  }

  /** Open the socket and start the session. Resolves on `session.started`. */
  start(): Promise<SessionResource> {
    if (this.state !== "idle") return Promise.reject(new Error(`cannot start a session in state ${this.state}`));
    this.setState("connecting");
    const factory = this.opts.webSocketFactory ?? defaultFactory;
    const ws = factory(this.opts.url ?? LIVE_URL, { Authorization: `Bearer ${this.opts.apiKey}` });
    this.ws = ws;

    return new Promise<SessionResource>((resolve, reject) => {
      this.rejectStart = reject;
      const timeout = setTimeout(() => {
        if (this.state === "connecting") {
          reject(new Error(`live session did not start within ${this.opts.connectTimeoutMs ?? 15_000}ms`));
          this.close();
        }
      }, this.opts.connectTimeoutMs ?? 15_000);

      ws.onopen = () => {
        const config: SessionConfig = { ...this.opts.config, model: this.opts.config.model || LIVE_MODEL };
        this.raw({ type: "session.start", event_id: "start", session: config });
      };
      ws.onmessage = (ev) => {
        const parsed = parseServerEvent(String(ev.data));
        if (!parsed) return;
        if (parsed.type === "session.started") {
          clearTimeout(timeout);
          this.startedAtWall = Date.now();
          this.resource = (parsed as Extract<ServerEvent, { type: "session.started" }>).session;
          this.setState("started");
          for (const line of this.pending.splice(0)) ws.send(line);
          this.emit("started", this.resource);
          resolve(this.resource);
          return;
        }
        this.dispatch(parsed as ServerEvent);
      };
      ws.onerror = () => {
        // The close event carries the useful information; onerror is a heads-up.
        log.debug("socket error");
      };
      ws.onclose = (ev) => {
        clearTimeout(timeout);
        const wasStarting = this.state === "connecting";
        this.setState("closed");
        if (wasStarting) reject(new Error(`live socket closed before start (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""})`));
        // A session.closed frame normally precedes this; if it did not, say so.
        if (!this.closedEmitted) {
          this.closedEmitted = true;
          this.emit("closed", "connection_lost", this.usageSeconds);
        }
      };
    });
  }

  private closedEmitted = false;
  private rejectStart: ((e: Error) => void) | undefined;

  private dispatch(ev: ServerEvent): void {
    this.emit("event", ev);
    switch (ev.type) {
      case "session.output_audio.delta":
        this.emit("audio", Buffer.from(ev.delta, "base64"));
        return;
      case "session.input_transcript.delta":
        this.emit("inputTranscript", ev.delta, ev.start_ms, ev.end_ms);
        return;
      case "session.output_transcript.delta":
        this.emit("outputTranscript", ev.delta, ev.start_ms, ev.end_ms);
        return;
      case "session.delegation.created":
        this.emit("delegation", ev.delegation.id, ev.delegation.target, ev.offset_ms);
        return;
      case "response.event":
        this.emit("responseEvent", ev.delegation_id ?? null, ev.event);
        return;
      case "session.usage.updated":
        this.usageSeconds = ev.usage.seconds;
        this.emit("usage", ev.usage.seconds, ev.context_window?.usage_ratio);
        return;
      case "session.thinking.appended":
        this.emit("appended", "thinking", ev.client_event_id, ev.start_ms);
        return;
      case "session.commentary.appended":
        this.emit("appended", "commentary", ev.client_event_id, ev.start_ms);
        return;
      case "session.instructions.appended":
        this.emit("appended", "instructions", ev.client_event_id, ev.start_ms);
        return;
      case "session.closed": {
        this.usageSeconds = ev.usage.seconds;
        this.setState("closed");
        // `closed` fires exactly once per session, with the server's reason: terminate() or the
        // socket's own close may have reported it already, and the socket close below must not.
        const report = !this.closedEmitted;
        this.closedEmitted = true;
        // The session is over; the socket goes with it from this side too (the server closes it
        // as well, normally). Otherwise a graceful close the server answered would leave the socket
        // open for good: close()'s fallback only acts while the state is not `closed`.
        try {
          this.ws?.close();
        } catch {
          // ignore
        }
        if (report) this.emit("closed", ev.reason, ev.usage.seconds);
        return;
      }
      case "error":
        this.emit("error", new Error(`${ev.error.code}: ${ev.error.message}`), ev.error.client_event_id);
        return;
      case "info":
        log.debug(`info ${ev.code}: ${ev.message}`);
        return;
      default:
        return;
    }
  }

  private raw(event: ClientEvent): void {
    const line = JSON.stringify(event);
    if (this.state === "started" && this.ws && this.ws.readyState === 1) {
      this.ws.send(line);
    } else if (this.state === "connecting") {
      if (event.type === "session.start") this.ws?.send(line);
      else this.pending.push(line);
    }
    // Closed: drop silently. Callers watch `state`.
  }

  /** Mic PCM16 mono at the configured rate. Never throws; dropped when closed. */
  appendAudio(pcm: Buffer): void {
    if (pcm.length === 0) return;
    this.raw({ type: "session.input_audio.append", audio: pcm.toString("base64") });
  }

  mute(): string {
    const id = this.nextEventId("mute");
    this.raw({ type: "session.input_audio.mute", event_id: id });
    return id;
  }

  unmute(): string {
    const id = this.nextEventId("unmute");
    this.raw({ type: "session.input_audio.unmute", event_id: id });
    return id;
  }

  appendThinking(delegationId: string | null, content: string): string {
    const id = this.nextEventId("think");
    this.raw({ type: "session.thinking.append", event_id: id, delegation_id: delegationId, content });
    return id;
  }

  appendCommentary(delegationId: string | null, content: string): string {
    const id = this.nextEventId("say");
    this.raw({ type: "session.commentary.append", event_id: id, delegation_id: delegationId, content });
    return id;
  }

  appendInstructions(delegationId: string | null, content: string): string {
    const id = this.nextEventId("steer");
    this.raw({ type: "session.instructions.append", event_id: id, delegation_id: delegationId, content });
    return id;
  }

  /** Responses-delegation only. */
  createResponseItem(item: unknown): void {
    this.raw({ type: "response.item.create", event_id: this.nextEventId("item"), item });
  }

  createResponse(): void {
    this.raw({ type: "response.create", event_id: this.nextEventId("resp") });
  }

  /**
   * How long a graceful close() waits for the server's `session.closed` before the
   * socket is closed from this side. The session bills per second while it is open,
   * so this is short; the engine's own deadline (1 s) usually terminate()s first.
   */
  static readonly CLOSE_FALLBACK_MS = 1500;

  /** Ask the server to finalize; `closed` fires with the reason. */
  close(): void {
    if (this.state === "closed" || this.state === "closing") return;
    if (this.state === "started") {
      this.setState("closing");
      try {
        this.ws?.send(JSON.stringify({ type: "session.close", event_id: this.nextEventId("close") }));
      } catch {
        // Socket already gone; the close handler reports it.
      }
      // If the server never answers, do not hang forever (and do not keep billing).
      setTimeout(() => {
        if (this.state !== "closed") {
          try {
            this.ws?.close();
          } catch {
            // ignore
          }
        }
      }, LiveSession.CLOSE_FALLBACK_MS).unref?.();
      return;
    }
    const wasConnecting = this.state === "connecting";
    this.setState("closed");
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    // A socket closed mid-handshake may never fire onclose; settle the caller ourselves.
    if (wasConnecting) {
      // Who closes a session that has not started is always a bug somewhere above; name the caller.
      log.warn(`close() during the handshake, from:\n${(new Error().stack ?? "").split("\n").slice(2, 8).join("\n")}`);
      this.rejectStart?.(new Error("live session closed before it started"));
    }
  }

  /**
   * Close the socket now, without asking the server to finalize. For when a
   * graceful close() has not been answered and the meter must stop: the state is
   * `closed` at once and `closed("client_closed", usageSeconds)` fires exactly
   * once — the socket's own onclose (if it still fires) and any late
   * `session.closed` frame are swallowed. Harmless when already closed.
   */
  terminate(): void {
    if (this.state === "closed") return;
    const wasConnecting = this.state === "connecting";
    this.setState("closed");
    const report = !this.closedEmitted;
    this.closedEmitted = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    if (wasConnecting) this.rejectStart?.(new Error("live session terminated before it started"));
    if (report) this.emit("closed", "client_closed", this.usageSeconds);
  }
}
