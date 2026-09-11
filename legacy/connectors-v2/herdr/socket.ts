import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { LineSplitter } from "@jarhead/core";

/**
 * Minimal NDJSON client for herdr's API socket.
 *
 * Observed against herdr 0.7.4: the server answers exactly one request per
 * connection and then closes it; the only long-lived connection is an
 * `events.subscribe` stream. So every request opens its own connection, and a
 * subscription owns its connection until closed. Invalid requests come back with
 * `"id": ""`, so a response is matched on id only when the server echoed one.
 */

export interface HerdrSocketOptions {
  readonly socketPath: string;
  readonly requestTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

export interface HerdrErrorBody {
  readonly code: string;
  readonly message: string;
}

export type HerdrResponse =
  | { readonly ok: true; readonly id: string; readonly result: unknown }
  | { readonly ok: false; readonly id: string; readonly error: HerdrErrorBody };

export interface HerdrEventEnvelope {
  /** Broadcast kinds are snake_case ("pane_created"); per-pane kinds are dotted ("pane.agent_status_changed"). */
  readonly event: string;
  readonly data: Record<string, unknown>;
}

/** One entry of `events.subscribe` params; per-pane kinds require `pane_id`. */
export interface HerdrSubscriptionSpec {
  readonly type: string;
  readonly pane_id?: string;
  readonly [key: string]: unknown;
}

export interface HerdrSubscription {
  close(): void;
  /** Resolves once the stream is gone, however that happened. */
  readonly closed: Promise<void>;
}

export type HerdrSocketFailure = "offline" | "timeout" | "closed" | "protocol";

export class HerdrSocketError extends Error {
  constructor(
    message: string,
    readonly reason: HerdrSocketFailure,
  ) {
    super(message);
    this.name = "HerdrSocketError";
  }
}

export const DEFAULT_SOCKET_REQUEST_TIMEOUT_MS = 5_000;

export class HerdrSocket {
  private seq = 0;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(private readonly opts: HerdrSocketOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_SOCKET_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? this.requestTimeoutMs;
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<HerdrResponse> {
    const socket = await this.connect();
    const id = this.nextId();
    return new Promise<HerdrResponse>((resolve, reject) => {
      const splitter = new LineSplitter();
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new HerdrSocketError(`herdr ${method} timed out after ${this.requestTimeoutMs} ms`, "timeout"))),
        this.requestTimeoutMs,
      );
      socket.on("data", (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = splitter.push(chunk);
        } catch (err) {
          finish(() => reject(new HerdrSocketError(String(err), "protocol")));
          return;
        }
        for (const line of lines) {
          const response = parseResponse(line);
          if (!response) continue;
          if (response.id !== "" && response.id !== id) continue;
          finish(() => resolve(response));
          return;
        }
      });
      socket.on("error", (err) => finish(() => reject(toSocketError(err, this.opts.socketPath))));
      socket.on("close", () =>
        finish(() => reject(new HerdrSocketError(`herdr closed the connection before answering ${method}`, "closed"))),
      );
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /**
   * Resolves once herdr acknowledges with `subscription_started`; events flow to
   * `onEvent` for the life of the connection.
   */
  async subscribe(
    subscriptions: readonly HerdrSubscriptionSpec[],
    onEvent: (event: HerdrEventEnvelope) => void,
  ): Promise<HerdrSubscription> {
    const socket = await this.connect();
    const id = this.nextId();
    return new Promise<HerdrSubscription>((resolve, reject) => {
      const splitter = new LineSplitter();
      let started = false;
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((r) => {
        resolveClosed = r;
      });
      const subscription: HerdrSubscription = { close: () => socket.destroy(), closed };
      const timer = setTimeout(() => {
        if (started) return;
        socket.destroy();
        reject(new HerdrSocketError(`herdr events.subscribe timed out after ${this.requestTimeoutMs} ms`, "timeout"));
      }, this.requestTimeoutMs);

      socket.on("data", (chunk: Buffer) => {
        let lines: string[];
        try {
          lines = splitter.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const line of lines) {
          const event = parseEvent(line);
          if (event) {
            onEvent(event);
            continue;
          }
          const response = parseResponse(line);
          if (!response || (response.id !== "" && response.id !== id)) continue;
          clearTimeout(timer);
          if (response.ok) {
            started = true;
            resolve(subscription);
          } else {
            socket.destroy();
            reject(new HerdrSocketError(`${response.error.code}: ${response.error.message}`, "protocol"));
          }
        }
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        if (!started) reject(toSocketError(err, this.opts.socketPath));
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!started) reject(new HerdrSocketError("herdr closed the subscription before acknowledging it", "closed"));
        resolveClosed();
      });
      socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`);
    });
  }

  private nextId(): string {
    this.seq += 1;
    return `jarhead:${this.seq}`;
  }

  private connect(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.opts.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HerdrSocketError(`timed out connecting to ${this.opts.socketPath}`, "timeout"));
      }, this.connectTimeoutMs);
      const onError = (err: Error): void => {
        clearTimeout(timer);
        reject(toSocketError(err, this.opts.socketPath));
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.setEncoding("utf8");
        resolve(socket);
      });
    });
  }
}

function toSocketError(err: Error, socketPath: string): HerdrSocketError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED" || code === "ENOENT") {
    return new HerdrSocketError(`herdr server not running (${code} on ${socketPath})`, "offline");
  }
  return new HerdrSocketError(err.message, "closed");
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseResponse(line: string): HerdrResponse | undefined {
  const msg = parseLine(line);
  if (!msg || typeof msg["event"] === "string") return undefined;
  const id = typeof msg["id"] === "string" ? msg["id"] : "";
  if ("error" in msg && typeof msg["error"] === "object" && msg["error"] !== null) {
    const e = msg["error"] as { code?: unknown; message?: unknown };
    return {
      ok: false,
      id,
      error: {
        code: typeof e.code === "string" ? e.code : "unknown",
        message: typeof e.message === "string" ? e.message : line,
      },
    };
  }
  if ("result" in msg) return { ok: true, id, result: msg["result"] };
  return undefined;
}

function parseEvent(line: string): HerdrEventEnvelope | undefined {
  const msg = parseLine(line);
  if (!msg || typeof msg["event"] !== "string") return undefined;
  const data = msg["data"];
  return {
    event: msg["event"],
    data: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {},
  };
}
