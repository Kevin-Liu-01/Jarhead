/**
 * Control the overlay from outside Electron: newline-delimited JSON over a
 * unix socket.
 *
 * This socket is the seam DECISION-AMENDMENTS.md §2 asks for. Everything the
 * agent process knows about the overlay is this protocol — if M3 replaces the
 * Electron shell with a Swift NSPanel, the Swift side reimplements this file's
 * server half and the agent never notices. Nothing here imports "electron";
 * the server takes an OverlayHandler so main.ts can plug the window in and
 * tests can plug in a recorder.
 */

import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { isOverlayState, OVERLAY_STATES, type OverlayState } from "./state.ts";

export function overlaySocketPath(): string {
  return process.env["JARVIS_OVERLAY_SOCKET"] || "/tmp/jarvis-overlay.sock";
}

export type OverlayCommand =
  | { readonly cmd: "setState"; readonly state: OverlayState }
  | { readonly cmd: "flyTo"; readonly x: number; readonly y: number }
  | { readonly cmd: "say"; readonly text: string; readonly ttlMs: number | undefined }
  | { readonly cmd: "hide" }
  | { readonly cmd: "show" }
  | { readonly cmd: "setInteractive"; readonly interactive: boolean }
  | { readonly cmd: "summon" };

export interface OverlayReply {
  readonly ok: boolean;
  readonly error: string | undefined;
}

/** What the overlay must be able to do. main.ts implements it with the window; tests implement it with an array. */
export interface OverlayHandler {
  setState(state: OverlayState): void;
  flyTo(x: number, y: number): void;
  say(text: string, ttlMs: number | undefined): void;
  hide(): void;
  show(): void;
  setInteractive(interactive: boolean): void;
  /** Move to the cursor and flash — the "where did it go" escape hatch. */
  summon(): void;
}

export type ParsedCommand =
  | { readonly ok: true; readonly command: OverlayCommand }
  | { readonly ok: false; readonly error: string };

function fail(error: string): ParsedCommand {
  return { ok: false, error };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Fail-closed: anything not exactly a known command is rejected with a reason,
 * never coerced. The client is another process that can be mid-deploy or
 * mid-rewrite; a silently misparsed flyTo is a buddy pointing at the wrong
 * pixel of Kevin's screen.
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
    case "setState": {
      const state = obj["state"];
      if (!isOverlayState(state)) {
        return fail(`unknown state ${JSON.stringify(state)}; expected one of ${OVERLAY_STATES.join(", ")}`);
      }
      return { ok: true, command: { cmd: "setState", state } };
    }
    case "flyTo": {
      const x = obj["x"];
      const y = obj["y"];
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) return fail("flyTo needs finite numeric x and y");
      return { ok: true, command: { cmd: "flyTo", x, y } };
    }
    case "say": {
      const text = obj["text"];
      if (typeof text !== "string" || text.trim().length === 0) return fail("say needs non-empty text");
      const rawTtl = obj["ttlMs"];
      let ttlMs: number | undefined;
      if (rawTtl === undefined) ttlMs = undefined;
      else if (isFiniteNumber(rawTtl) && rawTtl > 0) ttlMs = rawTtl;
      else return fail("say ttlMs must be a positive finite number when present");
      return { ok: true, command: { cmd: "say", text, ttlMs } };
    }
    case "hide":
      return { ok: true, command: { cmd: "hide" } };
    case "show":
      return { ok: true, command: { cmd: "show" } };
    case "summon":
      return { ok: true, command: { cmd: "summon" } };
    case "setInteractive": {
      const interactive = obj["interactive"];
      if (typeof interactive !== "boolean") return fail("setInteractive needs a boolean `interactive`");
      return { ok: true, command: { cmd: "setInteractive", interactive } };
    }
    default:
      return fail(`unknown cmd ${JSON.stringify(obj["cmd"])}`);
  }
}

export function serializeCommand(command: OverlayCommand): string {
  // JSON.stringify drops undefined properties, so an omitted ttlMs round-trips
  // as undefined — parseCommand always materializes the key.
  return `${JSON.stringify(command)}\n`;
}

export function serializeReply(reply: OverlayReply): string {
  return `${JSON.stringify(reply)}\n`;
}

export function parseReply(line: string): OverlayReply {
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

function dispatch(handler: OverlayHandler, command: OverlayCommand): void {
  switch (command.cmd) {
    case "setState":
      handler.setState(command.state);
      return;
    case "flyTo":
      handler.flyTo(command.x, command.y);
      return;
    case "say":
      handler.say(command.text, command.ttlMs);
      return;
    case "hide":
      handler.hide();
      return;
    case "show":
      handler.show();
      return;
    case "setInteractive":
      handler.setInteractive(command.interactive);
      return;
    case "summon":
      handler.summon();
      return;
  }
}

export class OverlayServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly handler: OverlayHandler,
    private readonly socketPath: string = overlaySocketPath(),
  ) {}

  listen(): Promise<void> {
    // A crashed overlay leaves its socket file behind and `listen` would fail
    // with EADDRINUSE forever. The overlay is single-instance (main.ts holds
    // Electron's instance lock), so replacing a stale file is recovery, not a
    // takeover of a live server.
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
      for (const line of split.lines) {
        socket.write(serializeReply(this.execute(line)));
      }
    });
    socket.on("error", () => {
      // A client that vanished mid-write is its problem, not the overlay's.
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  private execute(line: string): OverlayReply {
    const parsed = parseCommand(line);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    try {
      dispatch(this.handler, parsed.command);
      return { ok: true, error: undefined };
    } catch (e) {
      // The handler refusing (e.g. flyTo while hidden) is a reply, not a
      // reason to drop the connection.
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
  readonly resolve: (reply: OverlayReply) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The client the agent process imports.
 *
 * Commands are tiny one-way pokes; the returned promises exist for tests and
 * CLI use. On the live voice path, fire and forget — the hard rule is that
 * nothing in a turn awaits IPC, and a buddy that misses one state change is a
 * cosmetic bug while a stalled turn is a real one.
 */
export class OverlayClient {
  private socket: Socket | undefined;
  private rest = "";
  private readonly pending: PendingReply[] = [];

  constructor(
    private readonly socketPath: string = overlaySocketPath(),
    private readonly replyTimeoutMs = 2000,
  ) {}

  private connect(): Promise<Socket> {
    const existing = this.socket;
    if (existing && !existing.destroyed) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const onConnectError = (e: Error): void => {
        reject(
          new Error(
            `overlay socket ${this.socketPath} refused (${e.message}). ` +
              `Is the overlay running? Start it with: pnpm --filter @jarvis/overlay start`,
          ),
        );
      };
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.off("error", onConnectError);
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("error", (e: Error) => this.failAll(`overlay connection error: ${e.message}`));
        socket.on("close", () => {
          this.socket = undefined;
          this.failAll("overlay connection closed before it replied");
        });
        this.socket = socket;
        resolve(socket);
      });
    });
  }

  private onData(chunk: Buffer): void {
    const split = splitLines(this.rest, chunk.toString("utf8"));
    this.rest = split.rest;
    for (const line of split.lines) {
      this.pending.shift()?.resolve(parseReply(line));
    }
  }

  private failAll(message: string): void {
    while (this.pending.length > 0) {
      this.pending.shift()?.reject(new Error(message));
    }
  }

  async send(command: OverlayCommand): Promise<void> {
    const socket = await this.connect();
    const reply = await new Promise<OverlayReply>((resolve, reject) => {
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
        // never be trusted to line up again. Destroying the connection rejects
        // everything in flight and the next send() reconnects clean.
        socket.destroy();
        reject(new Error(`overlay did not reply within ${this.replyTimeoutMs}ms`));
      }, this.replyTimeoutMs);
      timer.unref();
      this.pending.push(entry);
      socket.write(serializeCommand(command));
    });
    if (!reply.ok) throw new Error(reply.error ?? "overlay rejected the command");
  }

  setState(state: OverlayState): Promise<void> {
    return this.send({ cmd: "setState", state });
  }

  flyTo(x: number, y: number): Promise<void> {
    return this.send({ cmd: "flyTo", x, y });
  }

  say(text: string, ttlMs?: number): Promise<void> {
    return this.send({ cmd: "say", text, ttlMs });
  }

  hide(): Promise<void> {
    return this.send({ cmd: "hide" });
  }

  show(): Promise<void> {
    return this.send({ cmd: "show" });
  }

  setInteractive(interactive: boolean): Promise<void> {
    return this.send({ cmd: "setInteractive", interactive });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }
}
