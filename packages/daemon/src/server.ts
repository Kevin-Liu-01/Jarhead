import { createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
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
  /** Words the on-device ear should be biased toward (visible control titles, the front app, agent names). Optional: older fakes lack it. */
  on(event: "ear.hints", listener: (strings: readonly string[]) => void): unknown;
  snapshot(): unknown;
  command(cmd: unknown): Promise<void>;
  feedMic(pcm: Buffer): void;
  reportInputLevel(level: number): void;
  setMicrophonePermission(state: Permissions["microphone"]): void;
  /** One permission as the app read it (any kind); the full list after a sweep. Optional: older fakes lack them. */
  setPermission?(which: string, state: Permissions["microphone"], detail?: string): void;
  setPermissions?(all: unknown[]): void;
  registerOwnPid(pid: number): void;
  /** On-device partial/final transcript from the app (reflex path). */
  ear(text: string, isFinal: boolean, segment: number, at: number): void;
  problem(text: string): void;
  readonly ledger: {
    read(at?: number): unknown[];
    days(): string[];
    sessions(): unknown[];
    readSession(sessionId: string): unknown[];
    /** Full-text hits over the live day files (`ledger.search`); optional — an older fake answers none. */
    search?(query: string, limit?: number): unknown[];
  };
  readonly config: { readonly stateDir: string };
  /** The engine's ToolRunner; `tool.run` messages go through it. When it says it has no task attached (`attached === false`), calls are refused: nothing acts without a delegation. */
  readonly runner: { run(name: string, input: unknown): Promise<{ readonly result: ToolResult }>; readonly attached?: boolean };
  /**
   * A worker's lane runner by worker id, for `tool.run { worker }` from a bridge started
   * with `JARHEAD_WORKER`. Undefined for a worker the engine does not have — finished,
   * stopped, never started — and the call is refused. Optional: an engine without workers
   * refuses every worker call the same way, and never hands one to `runner`. A server
   * that fronts ONE brain (CodexBrain's own tool socket outside the daemon process) must
   * still answer here for that brain's worker id, or its every call is refused as unknown.
   */
  runnerFor?(worker: string): EngineLike["runner"] | undefined;
}

interface Client {
  readonly socket: Socket;
  readonly parser: FrameParser;
  audio: boolean;
}

/** What the server tells its host about its clients: the app's bye, and every join and leave with the count after it. */
export interface DaemonServerEvents {
  bye: [];
  join: [count: number];
  leave: [count: number];
}

export class DaemonServer extends EventEmitter<DaemonServerEvents> {
  private server: Server | undefined;
  private readonly clients = new Set<Client>();

  constructor(
    private readonly engine: EngineLike,
    private readonly socketPath: string,
    private readonly version = "2.0.0",
  ) {
    super();
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
    engine.on("ear.hints", (strings) => this.broadcast({ type: "ear.hints", strings }));
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
      this.emit("leave", this.clients.size);
    });
    log.info(`client joined (${this.clients.size})`);
    this.emit("join", this.clients.size);
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
        if (this.engine.setPermission) this.engine.setPermission(msg.which, msg.state, msg.detail);
        else if (msg.which === "microphone") this.engine.setMicrophonePermission(msg.state);
        break;
      case "permissions":
        if (Array.isArray(msg.all)) this.engine.setPermissions?.(msg.all);
        return;
      case "ledger.read": {
        const t = Date.parse(`${msg.date}T12:00:00`);
        this.send(client, { type: "ledger.rows", id: msg.id, rows: Number.isFinite(t) ? this.engine.ledger.read(t) : [] });
        return;
      }
      case "ledger.days":
        this.send(client, { type: "ledger.days", id: msg.id, days: this.engine.ledger.days().map((f) => f.replace(/\.jsonl$/, "")).reverse() });
        break;
      case "ledger.sessions":
        this.send(client, { type: "ledger.sessions", id: msg.id, sessions: this.engine.ledger.sessions() });
        break;
      case "ledger.session":
        this.send(client, { type: "ledger.rows", id: msg.id, rows: typeof msg.sessionId === "string" ? this.engine.ledger.readSession(msg.sessionId) : [] });
        return;
      case "ledger.search": {
        // The Console's search box (K1): heard/said text and delegation requests/summaries over the
        // LIVE day files, newest first, bounded by the ledger (50 by default, 200 at most). Synchronous
        // over the walk's parsed cache; the trash is never read.
        const query = typeof msg.query === "string" ? msg.query : "";
        const limit = Number(msg.limit);
        const hits = this.engine.ledger.search ? this.engine.ledger.search(query, ...(Number.isFinite(limit) && limit > 0 ? [limit] : [])) : [];
        this.send(client, { type: "ledger.hits", id: String(msg.id ?? ""), hits });
        return;
      }
      case "tool.run":
        // Nothing on this path may become an unhandled rejection: the daemon has no handler
        // for one, and Node would take the whole engine down over one bad tool call.
        void this.runTool(client, msg.id, msg.name, msg.input, msg.worker).catch((e: unknown) => log.warn(`tool.run ${String(msg.name)} failed outside the runner: ${(e as Error).message}`));
        return;
      case "ping":
        // Liveness (REDESIGN §16, "Liveness"): answered here, synchronously, with no engine
        // work on the path — a wedged event loop is exactly what a late pong reveals.
        this.send(client, { type: "pong", id: String(msg.id ?? ""), at: Date.now() });
        return;
      case "bye":
        // The app is quitting cleanly (wire.ts). The host decides what that means for us;
        // the ack tells the app it may close now.
        log.info("client said bye");
        this.send(client, { type: "bye" });
        this.emit("bye");
        return;
    }
  }

  /**
   * One tool call for an out-of-process brain. Names outside the tool table are
   * refused here, before the runner sees them; everything else is the runner's
   * business (policy, ledger, screenshot archive, the confirmation handshake),
   * exactly as for the in-process brains.
   *
   * A call that names a worker goes to that worker's lane runner and nowhere else:
   * the main runner holds the pointer and the keyboard, so an unknown, finished or
   * malformed worker id is a refusal the model can read, never a fall-through.
   */
  private async runTool(client: Client, id: unknown, name: unknown, input: unknown, worker?: unknown): Promise<void> {
    const requestId = typeof id === "string" ? id : String(id ?? "");
    const answer = (result: ToolResult): void => this.send(client, { type: "tool.result", id: requestId, result });
    if (typeof name !== "string" || !specByName(name)) return answer({ kind: "error", message: `unknown tool ${String(name)}` });
    // Finding the runner is engine code (a pool lookup, possibly mid-cut): a throw there is a
    // refusal the model reads, never an unhandled rejection that exits the daemon.
    let runner: EngineLike["runner"];
    try {
      if (worker === undefined) runner = this.engine.runner;
      else {
        if (typeof worker !== "string" || worker === "") return answer({ kind: "error", message: `refused: malformed worker id; ${name} was not run` });
        const lane = this.engine.runnerFor?.(worker);
        if (!lane) return answer({ kind: "error", message: `refused: no worker ${worker} is running in Jarhead; ${name} was not run (it finished, was stopped, or never started)` });
        runner = lane;
      }
      // An out-of-process brain may only act while a delegation has the runner: a Codex
      // turn that outlived a stop (interrupted before turn/start answered) gets a refusal, not a click.
      if (runner.attached === false) return answer({ kind: "error", message: `refused: no task is running in Jarhead; ${name} was not run (Kevin stopped the task, or it finished)` });
    } catch (e) {
      return answer({ kind: "error", message: `refused: ${(e as Error).message}; ${name} was not run` });
    }
    let result: ToolResult;
    try {
      result = (await runner.run(name, input)).result;
    } catch (e) {
      result = { kind: "error", message: (e as Error).message };
    }
    answer(result);
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

// ----------------------------------------------------------------- lifeline

export interface LifelineOptions {
  /** How long to wait for a relaunched app after the one that spawned us went away without a bye (default 90 s). */
  readonly lingerMs?: number;
  /** A bye older than this when stdin closes is not this quit's (default 10 s). */
  readonly byeWindowMs?: number;
  readonly clientCount: () => number;
  readonly shutdown: (why: string) => void;
  readonly log: (line: string) => void;
  /** Called once, when stdin closes: the pipes into the app are dead, the host should re-home its output. */
  readonly onOrphaned?: () => void;
  readonly now?: () => number;
}

/**
 * When the daemon exits after the app is gone.
 *
 * The app spawns the daemon with a stdin pipe and closes it to stop us. Before the
 * crash guard, every app crash closed that pipe too, the daemon shut down, and the
 * resident Codex thread and its warmed cache died with it — fourteen respawns in one
 * evening. Now a clean quit is announced (`bye`, wire.ts) right before the pipe closes,
 * and stdin closing *without* a recent bye means a crash: the daemon lingers for
 * `lingerMs`, keeps the socket, the brain and the hands, and the relaunched app attaches
 * to it warm. Nobody back inside the window → exit. A client that attaches cancels the
 * linger; the last client leaving an orphaned daemon starts it again (so `pnpm jarhead
 * status` during a linger extends it by one window, no more); and a bye to an orphaned
 * daemon — the adopting app quitting — is the quit itself, since its stdin cannot close
 * a second time. A daemon whose stdin is a terminal (`pnpm jarheadd`) hears byes and
 * ignores them: the terminal owns it.
 */
export class Lifeline {
  private stdinGone = false;
  private byeAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | undefined;
  private done = false;
  private readonly lingerMs: number;
  private readonly byeWindowMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: LifelineOptions) {
    this.lingerMs = opts.lingerMs ?? 90_000;
    this.byeWindowMs = opts.byeWindowMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** True while waiting for a relaunched app. */
  get lingering(): boolean {
    return this.timer !== undefined;
  }

  /** The app announced a clean quit. */
  bye(): void {
    if (this.done) return;
    this.byeAt = this.now();
    if (this.stdinGone) {
      this.end("bye from the app that adopted us");
      return;
    }
    this.opts.log("the app said bye; the stdin close that follows is a clean quit");
  }

  /** The stdin pipe closed: the app quit (after a bye) or crashed (without one). */
  stdinClosed(): void {
    if (this.done || this.stdinGone) return;
    this.stdinGone = true;
    this.opts.onOrphaned?.();
    if (this.now() - this.byeAt <= this.byeWindowMs) {
      this.end("stdin closed");
      return;
    }
    this.startLinger("app went away without a bye");
  }

  clientJoined(): void {
    if (this.done || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.opts.log("a client attached; staying up");
  }

  clientLeft(): void {
    if (this.done || !this.stdinGone || this.timer || this.opts.clientCount() > 0) return;
    this.startLinger("the last client left an orphaned daemon");
  }

  /** Stop the timer (tests, shutdown from elsewhere). */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.done = true;
  }

  private startLinger(why: string): void {
    const seconds = Math.round(this.lingerMs / 1000);
    this.opts.log(`${why}; lingering ${seconds} s for a relaunch`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.opts.clientCount() > 0) {
        this.opts.log("a client is attached; staying up");
        return;
      }
      this.end(`nobody came back in ${seconds} s`);
    }, this.lingerMs);
    this.timer.unref?.();
  }

  private end(why: string): void {
    if (this.done) return;
    this.dispose();
    this.opts.shutdown(why);
  }
}
