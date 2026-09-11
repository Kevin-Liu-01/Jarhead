/**
 * Control the annotation layer from outside Electron: newline-delimited JSON
 * over a unix socket, the same seam as the overlay's ipc.ts.
 *
 * Coordinates on the wire are GLOBAL screen pixels — the space the AX tree
 * and `screen` module speak — and they are frequently negative on this
 * machine (second display's menu bar at y=-2160), so nothing here treats a
 * negative coordinate as an error. Nothing here imports "electron"; the
 * server takes an AnnotateHandler so the app can plug the window in and
 * tests can plug in a recorder.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { DIRECTIONS, isDirection, type ShapeSpec } from "./shapes.ts";
import type { Point } from "./layout.ts";

export function annotateSocketPath(): string {
  return process.env["JARVIS_ANNOTATE_SOCKET"] || "/tmp/jarvis-annotate.sock";
}

/**
 * Caps, enforced at parse time rather than draw time. The client is another
 * process that can be mid-rewrite; a "circle of radius 1e9" must die at the
 * socket with a reason, not as a renderer building a gigabyte of spaces.
 */
export const MAX_CELLS = 1000;
export const MAX_LABEL_CHARS = 2000;
/**
 * Largest line either side will buffer.
 *
 * Generous next to a real command (a big label plus coordinates is well under a
 * kilobyte) and small enough that a peer withholding newlines cannot exhaust
 * memory.
 */
export const MAX_LINE_BYTES = 64 * 1024;

export const MAX_ID_CHARS = 64;

export interface DrawCommand {
  readonly cmd: "draw";
  readonly id: string;
  /** Global screen pixels; negative is normal here. */
  readonly x: number;
  readonly y: number;
  readonly shape: ShapeSpec;
}

export type AnnotateCommand =
  | DrawCommand
  | { readonly cmd: "erase"; readonly id: string }
  | { readonly cmd: "clear" }
  | { readonly cmd: "pulse"; readonly id: string }
  | { readonly cmd: "trail"; readonly from: Point; readonly to: Point };

export interface AnnotateReply {
  readonly ok: boolean;
  readonly error: string | undefined;
}

/** What the layer must be able to do. The app implements it with the window; tests implement it with an array. */
export interface AnnotateHandler {
  draw(command: DrawCommand): void;
  erase(id: string): void;
  clear(): void;
  pulse(id: string): void;
  trail(from: Point, to: Point): void;
}

export type ParsedCommand =
  | { readonly ok: true; readonly command: AnnotateCommand }
  | { readonly ok: false; readonly error: string };

function fail(error: string): ParsedCommand {
  return { ok: false, error };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Cell-count fields must be honest integers inside the cap — floats and NaN get rejected, not floored into something plausible. */
function isCells(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_CELLS;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS;
}

function parsePoint(value: unknown): Point | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const x = obj["x"];
  const y = obj["y"];
  return isFiniteNumber(x) && isFiniteNumber(y) ? { x, y } : undefined;
}

/**
 * The draw command travels flat — `{cmd:"draw", shape:"arrow", direction,
 * length, ...}` — so a line of the protocol reads as one plain object. This
 * reassembles the typed spec, or names exactly what was wrong.
 */
function parseShape(obj: Record<string, unknown>): ShapeSpec | string {
  switch (obj["shape"]) {
    case "arrow": {
      const direction = obj["direction"];
      const length = obj["length"];
      if (!isDirection(direction)) return `arrow direction must be one of ${DIRECTIONS.join(", ")}`;
      if (!isCells(length, 2)) return `arrow length must be an integer in 2..${MAX_CELLS}`;
      return { kind: "arrow", direction, length };
    }
    case "circle": {
      const radius = obj["radius"];
      if (!isCells(radius, 1)) return `circle radius must be an integer in 1..${MAX_CELLS}`;
      return { kind: "circle", radius };
    }
    case "box": {
      const w = obj["w"];
      const h = obj["h"];
      if (!isCells(w, 2) || !isCells(h, 2)) return `box w and h must be integers in 2..${MAX_CELLS}`;
      return { kind: "box", w, h };
    }
    case "bracket": {
      const side = obj["side"];
      const height = obj["height"];
      if (side !== "left" && side !== "right") return "bracket side must be left or right";
      if (!isCells(height, 2)) return `bracket height must be an integer in 2..${MAX_CELLS}`;
      return { kind: "bracket", side, height };
    }
    case "label": {
      const text = obj["text"];
      const maxWidth = obj["maxWidth"];
      if (typeof text !== "string" || text.trim().length === 0) return "label needs non-empty text";
      if (text.length > MAX_LABEL_CHARS) return `label text must be at most ${MAX_LABEL_CHARS} chars`;
      if (!isCells(maxWidth, 1)) return `label maxWidth must be an integer in 1..${MAX_CELLS}`;
      return { kind: "label", text, maxWidth };
    }
    case "underline": {
      const width = obj["width"];
      if (!isCells(width, 1)) return `underline width must be an integer in 1..${MAX_CELLS}`;
      return { kind: "underline", width };
    }
    case "crosshair": {
      const size = obj["size"];
      if (!isCells(size, 3)) return `crosshair size must be an integer in 3..${MAX_CELLS}`;
      return { kind: "crosshair", size };
    }
    default:
      return `unknown shape ${JSON.stringify(obj["shape"])}`;
  }
}

/**
 * Fail-closed: anything not exactly a known command is rejected with a
 * reason, never coerced. A silently misparsed draw is an arrow pointing at
 * the wrong pixel of Kevin's screen while Jarvis narrates it with
 * confidence.
 */
export function parseCommand(line: string): ParsedCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail(`not JSON: ${line.slice(0, 120)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("command must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  switch (obj["cmd"]) {
    case "draw": {
      const id = obj["id"];
      const x = obj["x"];
      const y = obj["y"];
      if (!isId(id)) return fail(`draw needs a non-empty string id of at most ${MAX_ID_CHARS} chars`);
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) return fail("draw needs finite numeric x and y");
      const shape = parseShape(obj);
      if (typeof shape === "string") return fail(shape);
      return { ok: true, command: { cmd: "draw", id, x, y, shape } };
    }
    case "erase": {
      const id = obj["id"];
      if (!isId(id)) return fail(`erase needs a non-empty string id of at most ${MAX_ID_CHARS} chars`);
      return { ok: true, command: { cmd: "erase", id } };
    }
    case "clear":
      return { ok: true, command: { cmd: "clear" } };
    case "pulse": {
      const id = obj["id"];
      if (!isId(id)) return fail(`pulse needs a non-empty string id of at most ${MAX_ID_CHARS} chars`);
      return { ok: true, command: { cmd: "pulse", id } };
    }
    case "trail": {
      const from = parsePoint(obj["from"]);
      const to = parsePoint(obj["to"]);
      if (!from || !to) return fail("trail needs from and to points with finite numeric x and y");
      return { ok: true, command: { cmd: "trail", from, to } };
    }
    default:
      return fail(`unknown cmd ${JSON.stringify(obj["cmd"])}`);
  }
}

export function serializeCommand(command: AnnotateCommand): string {
  if (command.cmd === "draw") {
    // Flattened to match the wire shape parseShape expects; `kind` becomes
    // the `shape` field and the options ride alongside x/y.
    const { kind, ...opts } = command.shape;
    return `${JSON.stringify({ cmd: "draw", id: command.id, shape: kind, x: command.x, y: command.y, ...opts })}\n`;
  }
  return `${JSON.stringify(command)}\n`;
}

export function serializeReply(reply: AnnotateReply): string {
  return `${JSON.stringify(reply)}\n`;
}

export function parseReply(line: string): AnnotateReply {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: `unparseable reply: ${line.slice(0, 120)}` };
  }
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "reply must be a JSON object" };
  const obj = raw as Record<string, unknown>;
  if (typeof obj["ok"] !== "boolean") return { ok: false, error: "reply is missing `ok`" };
  return { ok: obj["ok"], error: typeof obj["error"] === "string" ? obj["error"] : undefined };
}

/** NDJSON framing: sockets deliver arbitrary chunk boundaries, so the partial trailing line carries over to the next chunk. */
export function splitLines(buffered: string, chunk: string): { readonly lines: readonly string[]; readonly rest: string } {
  const parts = (buffered + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((line) => line.trim().length > 0), rest };
}

function dispatch(handler: AnnotateHandler, command: AnnotateCommand): void {
  switch (command.cmd) {
    case "draw":
      handler.draw(command);
      return;
    case "erase":
      handler.erase(command.id);
      return;
    case "clear":
      handler.clear();
      return;
    case "pulse":
      handler.pulse(command.id);
      return;
    case "trail":
      handler.trail(command.from, command.to);
      return;
  }
}

export class AnnotateServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly handler: AnnotateHandler,
    private readonly socketPath: string = annotateSocketPath(),
  ) {}

  listen(): Promise<void> {
    // A crashed layer leaves its socket file behind and `listen` would fail
    // with EADDRINUSE forever. The layer is single-instance (the app holds
    // Electron's instance lock), so replacing a stale file is recovery, not
    // a takeover of a live server.
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Nothing to clean up.
    }

    const server = createServer((socket) => this.onConnection(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => resolve());
    });
  }

  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    let rest = "";
    socket.on("data", (chunk: Buffer) => {
      const split = splitLines(rest, chunk.toString("utf8"));
      rest = split.rest;
      // The per-command caps only apply once a line is complete, so a peer that
      // never sends a newline could grow this buffer without limit. Dropping the
      // fragment is the right response: nothing valid is that long.
      if (rest.length > MAX_LINE_BYTES) {
        rest = "";
        socket.write(serializeReply({ ok: false, error: `line exceeded ${MAX_LINE_BYTES} bytes` }));
        return;
      }
      for (const line of split.lines) {
        socket.write(serializeReply(this.execute(line)));
      }
    });
    socket.on("error", () => {
      // A client that vanished mid-write is its problem, not the layer's.
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  private execute(line: string): AnnotateReply {
    const parsed = parseCommand(line);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    try {
      dispatch(this.handler, parsed.command);
      return { ok: true, error: undefined };
    } catch (e) {
      // The handler refusing (e.g. pulse on an id that never drew) is a
      // reply, not a reason to drop the connection.
      return { ok: false, error: (e as Error).message };
    }
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    return new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => {
        try {
          unlinkSync(this.socketPath);
        } catch {
          // Already gone.
        }
        resolve();
      });
    });
  }
}

interface PendingReply {
  readonly resolve: (reply: AnnotateReply) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The client the agent process imports.
 *
 * Same contract as OverlayClient: the returned promises exist for tests and
 * CLI use, and on the live voice path drawing is fire-and-forget — a missing
 * arrow is a cosmetic bug, a turn stalled on IPC is a real one.
 */
export class AnnotateClient {
  private socket: Socket | undefined;
  /** In-flight connect, so concurrent sends share one socket rather than racing. */
  private connecting: Promise<Socket> | undefined;
  private rest = "";
  private readonly pending: PendingReply[] = [];

  constructor(
    private readonly socketPath: string = annotateSocketPath(),
    private readonly replyTimeoutMs = 2000,
    private readonly connectTimeoutMs = 2000,
  ) {}

  /**
   * One connection, however many sends race for it.
   *
   * `this.socket` is only assigned inside the 'connect' callback, so two sends in
   * the same tick — which is exactly what a turn drawing several annotations
   * does — each opened their own socket. Both then shared one FIFO of pending
   * replies and one line buffer, so a reply could resolve the wrong command
   * (a rejected draw reporting success) and the loser's eventual close would
   * fail the survivor's queue. Memoizing the attempt fixes all of it.
   */
  private connect(): Promise<Socket> {
    const existing = this.socket;
    if (existing && !existing.destroyed) return Promise.resolve(existing);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let settled = false;

      // Without this a socket that neither connects nor errors — a path that
      // exists but has no listener — hangs the caller forever.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`annotate socket ${this.socketPath} did not connect within ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      const onConnectError = (e: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            `annotate socket ${this.socketPath} refused (${e.message}). ` +
              `Is the app running with the annotation layer?`,
          ),
        );
      };

      socket.once("error", onConnectError);
      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("error", onConnectError);
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        // Guarded on identity: a stale socket closing must not fail the live
        // one's pending queue.
        socket.on("error", (e: Error) => {
          if (this.socket === socket) this.failAll(`annotate connection error: ${e.message}`);
        });
        socket.on("close", () => {
          if (this.socket !== socket) return;
          this.socket = undefined;
          this.failAll("annotate connection closed before it replied");
        });
        this.socket = socket;
        resolve(socket);
      });
    }).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }

  private onData(chunk: Buffer): void {
    const split = splitLines(this.rest, chunk.toString("utf8"));
    this.rest = split.rest;
    // A peer that never sends a newline would otherwise grow this without bound.
    if (this.rest.length > MAX_LINE_BYTES) this.rest = "";
    for (const line of split.lines) {
      this.pending.shift()?.resolve(parseReply(line));
    }
  }

  private failAll(message: string): void {
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(new Error(message));
    }
  }

  async send(command: AnnotateCommand): Promise<void> {
    const socket = await this.connect();
    const reply = await new Promise<AnnotateReply>((resolve, reject) => {
      const entry: PendingReply = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        // Replies carry no request id, so after a missed reply the FIFO can
        // never be trusted to line up again. Destroying the connection
        // rejects everything in flight and the next send() reconnects clean.
        socket.destroy();
        reject(new Error(`annotate layer did not reply within ${this.replyTimeoutMs}ms`));
      }, this.replyTimeoutMs);
      timer.unref();
      this.pending.push(entry);
      socket.write(serializeCommand(command));
    });
    if (!reply.ok) throw new Error(reply.error ?? "annotate layer rejected the command");
  }

  draw(id: string, shape: ShapeSpec, x: number, y: number): Promise<void> {
    return this.send({ cmd: "draw", id, shape, x, y });
  }

  erase(id: string): Promise<void> {
    return this.send({ cmd: "erase", id });
  }

  clear(): Promise<void> {
    return this.send({ cmd: "clear" });
  }

  pulse(id: string): Promise<void> {
    return this.send({ cmd: "pulse", id });
  }

  trail(from: Point, to: Point): Promise<void> {
    return this.send({ cmd: "trail", from, to });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
