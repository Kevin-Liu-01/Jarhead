import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { logger } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import { specByName } from "@jarhead/brain";
import { isEngineCommand, type EngineEvent, type OverlayCommand, type Permissions } from "@jarhead/protocol";
import { FRAME_JSON, FRAME_MIC, FRAME_SPEAKER, FrameParser, encodeFrame, encodeJson, parseClientMessage, type DaemonMessage } from "./wire.ts";

/**
 * Serves the engine over a unix socket to the native app (and the CLI).
 *
 * Any client may send commands and receive state; audio flows only to clients
 * that said `hello` with `audio: true`, and mic frames from any client are fed to
 * the engine. The daemon is what makes the Swift app a thin, replaceable face.
 */

const log = logger("daemon");

/** What the server needs from the engine; the real Engine satisfies it. */
export interface EngineLike {
  on(event: "event", listener: (e: EngineEvent) => void): unknown;
  on(event: "audio", listener: (pcm: Buffer) => void): unknown;
  on(event: "overlay", listener: (cmd: OverlayCommand) => void): unknown;
  snapshot(): unknown;
  command(cmd: unknown): Promise<void>;
  feedMic(pcm: Buffer): void;
  reportInputLevel(level: number): void;
  setMicrophonePermission(state: Permissions["microphone"]): void;
  registerOwnPid(pid: number): void;
  /** On-device partial/final transcript from the app (reflex path). */
  ear(text: string, isFinal: boolean, segment: number, at: number): void;
  problem(text: string): void;
  readonly ledger: { read(at?: number): unknown[]; days(): string[] };
  readonly config: { readonly stateDir: string };
  /** The engine's ToolRunner; `tool.run` messages go through it. When it says it has no task attached (`attached === false`), calls are refused: nothing acts without a delegation. */
  readonly runner: { run(name: string, input: unknown): Promise<{ readonly result: ToolResult }>; readonly attached?: boolean };
}

interface Client {
  readonly socket: Socket;
  readonly parser: FrameParser;
  audio: boolean;
}

export class DaemonServer {
  private server: Server | undefined;
  private readonly clients = new Set<Client>();

  constructor(
    private readonly engine: EngineLike,
    private readonly socketPath: string,
    private readonly version = "2.0.0",
  ) {
    engine.on("event", (e) => {
      switch (e.type) {
        case "snapshot":
          return this.broadcast({ type: "snapshot", snapshot: e.snapshot });
        case "levels":
          return this.broadcast({ type: "levels", levels: e.levels });
        case "toast":
          return this.broadcast({ type: "toast", text: e.text, tone: e.tone });
        case "speaker-flush":
          return this.broadcast({ type: "audio", control: "flush" });
        case "agent.transcript":
          return this.broadcast({ type: "agent.transcript", transcript: e.transcript, mode: e.mode });
      }
    });
    engine.on("audio", (pcm) => {
      const frame = encodeFrame(FRAME_SPEAKER, pcm);
      for (const c of this.clients) if (c.audio && c.socket.writable) c.socket.write(frame);
    });
    engine.on("overlay", (cmd) => this.broadcast({ type: "overlay", command: cmd }));
  }

  listen(): Promise<void> {
    if (existsSync(this.socketPath)) {
      // A stale socket file from a crashed daemon; a live one would have refused us.
      try {
        unlinkSync(this.socketPath);
      } catch {
        // If we cannot unlink, listen() below reports it.
      }
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        log.info(`listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private accept(socket: Socket): void {
    const client: Client = { socket, parser: new FrameParser(), audio: false };
    this.clients.add(client);
    socket.setNoDelay(true);
    this.send(client, { type: "hello", version: this.version, pid: process.pid, stateDir: this.engine.config.stateDir });
    this.send(client, { type: "snapshot", snapshot: this.engine.snapshot() });
    socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = client.parser.push(chunk);
      } catch (e) {
        log.warn(`dropping client: ${(e as Error).message}`);
        socket.destroy();
        return;
      }
      for (const f of frames) this.onFrame(client, f.type, f.payload);
    });
    socket.on("error", (e) => log.debug(`client error: ${e.message}`));
    socket.on("close", () => {
      this.clients.delete(client);
      log.info(`client left (${this.clients.size} remaining)`);
    });
    log.info(`client joined (${this.clients.size})`);
  }

  private onFrame(client: Client, type: number, payload: Buffer): void {
    if (type === FRAME_MIC) {
      this.engine.feedMic(payload);
      return;
    }
    if (type !== FRAME_JSON) return;
    const msg = parseClientMessage(payload);
    if (!msg) return;
    switch (msg.type) {
      case "hello":
        client.audio = msg.audio === true;
        if (Number.isInteger(msg.pid)) this.engine.registerOwnPid(msg.pid);
        return;
      case "command":
        if (!isEngineCommand(msg.command)) return this.send(client, { type: "error", message: "malformed command" });
        void this.engine.command(msg.command).catch((e: unknown) => this.engine.problem(`command failed: ${(e as Error).message}`));
        return;
      case "mic-level":
        this.engine.reportInputLevel(Number(msg.level) || 0);
        return;
      case "ear":
        if (typeof msg.text === "string") this.engine.ear(msg.text, msg.isFinal === true, Number(msg.segment ?? 0), Number(msg.at ?? Date.now()));
        return;
      case "permission":
        if (msg.which === "microphone") this.engine.setMicrophonePermission(msg.state);
        return;
      case "ledger.read": {
        const t = Date.parse(`${msg.date}T12:00:00`);
        this.send(client, { type: "ledger.rows", id: msg.id, rows: Number.isFinite(t) ? this.engine.ledger.read(t) : [] });
        return;
      }
      case "ledger.days":
        this.send(client, { type: "ledger.days", id: msg.id, days: this.engine.ledger.days().map((f) => f.replace(/\.jsonl$/, "")).reverse() });
        return;
      case "tool.run":
        void this.runTool(client, msg.id, msg.name, msg.input);
        return;
    }
  }

  /**
   * One tool call for an out-of-process brain. Names outside the tool table are
   * refused here, before the runner sees them; everything else is the runner's
   * business (policy, ledger, screenshot archive, the confirmation handshake),
   * exactly as for the in-process brains.
   */
  private async runTool(client: Client, id: unknown, name: unknown, input: unknown): Promise<void> {
    const requestId = typeof id === "string" ? id : String(id ?? "");
    if (typeof name !== "string" || !specByName(name)) {
      this.send(client, { type: "tool.result", id: requestId, result: { kind: "error", message: `unknown tool ${String(name)}` } });
      return;
    }
    // An out-of-process brain may only act while a delegation has the runner: a Codex
    // turn that outlived a stop (interrupted before turn/start answered) gets a refusal, not a click.
    if (this.engine.runner.attached === false) {
      this.send(client, { type: "tool.result", id: requestId, result: { kind: "error", message: `refused: no task is running in Jarhead; ${name} was not run (Kevin stopped the task, or it finished)` } });
      return;
    }
    let result: ToolResult;
    try {
      result = (await this.engine.runner.run(name, input)).result;
    } catch (e) {
      result = { kind: "error", message: (e as Error).message };
    }
    this.send(client, { type: "tool.result", id: requestId, result });
  }

  private send(client: Client, message: DaemonMessage): void {
    if (client.socket.writable) client.socket.write(encodeJson(message));
  }

  private broadcast(message: DaemonMessage): void {
    const frame = encodeJson(message);
    for (const c of this.clients) if (c.socket.writable) c.socket.write(frame);
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    try {
      unlinkSync(this.socketPath);
    } catch {
      // gone already
    }
  }
}
