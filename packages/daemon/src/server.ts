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
 *
 * Conversations are the one thing not broadcast: `agent.transcript` and
 * `thread.transcript` pages go only to the clients that opened that agent or thread
 * (`route`), because every `pnpm jarhead` call is a client too — 304 join/leave pairs in
 * one day's log — and a page of sixty turns to each of them is bytes for nobody.
 * Snapshots, toasts, overlay commands and `thread.event` stay broadcast: they are small
 * and every surface (orb, notch, rail, CLI) reads them.
 */

const log = logger("daemon");

/** `memory.list` / `memory.search`: the default and the ceiling on one answer (a MemoryItem is ~400 B; the frame rides the same socket as the snapshots). */
export const MEMORY_LIST_DEFAULT = 50;
export const MEMORY_LIST_MAX = 200;

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
    /** A whole chain's rows in one read (`ledger.chain`); optional — an older fake answers none. */
    readChain?(rootId: string): { readonly rows: unknown[]; readonly truncated: boolean };
  };
  /** The memory module's reads (`memory.list` / `memory.search`); optional — an engine without one answers empty lists. */
  readonly memory?: { list(state?: string, limit?: number): unknown[]; search(query: string, limit?: number): Promise<unknown[]> };
  /** A client's socket closed: its conversation viewers leave (no leaked tails). Optional: older fakes lack it. */
  dropViewers?(clientId: string): void;
  readonly config: { readonly stateDir: string };
  /** The engine's ToolRunner; `tool.run` messages go through it. When it says it has no task attached (`attached === false`), calls are refused: nothing acts without a delegation. */
  readonly runner: { run(name: string, input: unknown): Promise<{ readonly result: ToolResult }>; readonly attached?: boolean };
  /**
   * A thread's lane runner by thread id (`t_…`, or a `w_…` worker id for one release),
   * for `tool.run { worker }` from a bridge started with `JARHEAD_WORKER` — the wire field
   * keeps its old name. Undefined for a thread the engine does not have — finished,
   * stopped, never started — and the call is refused. Optional: an engine without threads
   * refuses every such call the same way, and never hands one to `runner`. A server that
   * fronts ONE brain (CodexBrain's own tool socket outside the daemon process) must still
   * answer here for that brain's id, or its every call is refused as unknown.
   */
  runnerFor?(worker: string): EngineLike["runner"] | undefined;
}

interface Client {
  /** Per connection ("c7"): the prefix on every conversation viewer this client opens, so its tails close with its socket. */
  readonly id: string;
  readonly socket: Socket;
  readonly parser: FrameParser;
  audio: boolean;
  /**
   * The conversations this client is showing — "agent:<id>" | "thread:<id>" — kept from
   * the open/close commands it sent; `route` reads it. A key stays while ANY of the
   * client's panes has it open (`panes` counts them), so a second pane on the same
   * thread closing does not blind the first — the engine keeps the same per-viewer set.
   */
  readonly viewers: Set<string>;
  readonly panes: Map<string, Set<string>>;
}

/**
 * "agent:<id>" | "thread:<id>" — the key a client's `viewers` holds and a page is routed by — or
 * undefined when the id is not a non-empty string. Both sides derive it here, so a page whose
 * engine event carries no id (`thread:${undefined}` would spell a real key) matches nobody, not
 * whoever opened a thread literally named "undefined".
 */
function conversationKey(kind: "agent" | "thread", id: unknown): string | undefined {
  return typeof id === "string" && id !== "" ? `${kind}:${id}` : undefined;
}

/** A page's own conversation id, read defensively: the engine's types promise it, a fake or an older engine may not. */
function pageId(page: unknown, field: "agentId" | "threadId"): unknown {
  return typeof page === "object" && page !== null ? (page as Record<string, unknown>)[field] : undefined;
}

/** The routing key of a conversation open/close command, or undefined when it names no conversation. */
function viewerKey(command: { readonly type: string; readonly agentId?: unknown; readonly threadId?: unknown }): string | undefined {
  if (command.type === "agent.open" || command.type === "agent.close") return conversationKey("agent", command.agentId);
  if (command.type === "thread.open" || command.type === "thread.close") return conversationKey("thread", command.threadId);
  return undefined;
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
  private clientSeq = 0;

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
          return this.route({ type: "agent.transcript", transcript: e.transcript, mode: e.mode }, conversationKey("agent", pageId(e.transcript, "agentId")));
        case "thread.event":
          // ≤ 200 B and every surface reads it: the satellites fly and the rail recounts from this, never from a snapshot.
          return this.broadcast({ type: "thread.event", event: e.event });
        case "thread.transcript":
          return this.route({ type: "thread.transcript", transcript: e.transcript, mode: e.mode }, conversationKey("thread", pageId(e.transcript, "threadId")));
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
    const client: Client = { id: `c${++this.clientSeq}`, socket, parser: new FrameParser(), audio: false, viewers: new Set(), panes: new Map() };
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
      // Its conversation viewers go with it — here (no more pages routed its way) and in the
      // engine (a Console killed with the window open leaves no tail running).
      client.viewers.clear();
      client.panes.clear();
      try {
        this.engine.dropViewers?.(client.id);
      } catch (e) {
        log.debug(`dropViewers(${client.id}): ${(e as Error).message}`);
      }
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
      case "command": {
        if (!isEngineCommand(msg.command)) return this.send(client, { type: "error", message: "malformed command" });
        let command = msg.command;
        // A conversation viewer is this client's: its pane token (or "pane" when the surface
        // sent none) under the client id, so opens are per pane, a re-open after a reconnect
        // never double-counts, and the socket closing drops them all (`dropViewers`). The
        // same for a thread's pane. The viewer is registered here BEFORE the engine sees the
        // open, so the `replace` page it answers with has somewhere to go.
        if (command.type === "agent.open" || command.type === "agent.close" || command.type === "thread.open" || command.type === "thread.close") {
          const pane = typeof command.viewer === "string" && command.viewer ? command.viewer : "pane";
          command = { ...command, viewer: `${client.id}/${pane}` };
          const key = viewerKey(command);
          if (key) this.setViewing(client, key, pane, command.type === "agent.open" || command.type === "thread.open");
        }
        void this.engine.command(command).catch((e: unknown) => this.engine.problem(`command failed: ${(e as Error).message}`));
        return;
      }
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
      case "ledger.chain": {
        // One read for a whole conversation (the Console used to read a chain one session per round
        // trip); bounded by the ledger at CHAIN_ROWS_MAX, and the answer says when it was cut.
        const r = typeof msg.rootId === "string" && this.engine.ledger.readChain ? this.engine.ledger.readChain(msg.rootId) : { rows: [], truncated: false };
        this.send(client, { type: "ledger.rows", id: String(msg.id ?? ""), rows: r.rows, ...(r.truncated ? { truncated: true } : {}) });
        return;
      }
      case "memory.list": {
        const items = this.engine.memory ? this.engine.memory.list(typeof msg.state === "string" ? msg.state : undefined, memoryLimit(msg.limit)) : [];
        this.send(client, { type: "memory.items", id: String(msg.id ?? ""), items: items.slice(0, MEMORY_LIST_MAX) });
        return;
      }
      case "memory.search": {
        // Async (an embedding may be asked for): the answer lands under the request id when it comes; a failure is an empty list, never a dropped client.
        const id = String(msg.id ?? "");
        const query = typeof msg.query === "string" ? msg.query : "";
        const limit = memoryLimit(msg.limit);
        const search = this.engine.memory ? this.engine.memory.search(query, limit) : Promise.resolve([] as unknown[]);
        void search
          .then((items) => this.send(client, { type: "memory.items", id, items: items.slice(0, MEMORY_LIST_MAX) }))
          .catch((e: unknown) => {
            log.warn(`memory.search failed: ${(e as Error).message}`);
            this.send(client, { type: "memory.items", id, items: [] });
          });
        return;
      }
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

  /**
   * A conversation page to the clients showing that conversation and nobody else: encoded
   * once, written to each client whose `viewers` holds `key`. A page nobody opened goes
   * nowhere (the engine emits `replace` after an open, so that is a closed-while-reading
   * race, not a loss); a page with no key — no id on it — goes nowhere either, and says so
   * at debug, never throws: the daemon outlives a malformed emit.
   */
  private route(message: DaemonMessage, key: string | undefined): void {
    if (key === undefined) {
      log.debug(`${message.type} names no conversation; not routed`);
      return;
    }
    let frame: Buffer | undefined;
    for (const c of this.clients) {
      if (!c.viewers.has(key) || !c.socket.writable) continue;
      frame ??= encodeJson(message);
      c.socket.write(frame);
    }
  }

  /** One pane of this client opened (or closed) a conversation; the routing key stays while any of its panes has it. */
  private setViewing(client: Client, key: string, pane: string, open: boolean): void {
    let panes = client.panes.get(key);
    if (open) {
      if (!panes) client.panes.set(key, (panes = new Set()));
      panes.add(pane);
      client.viewers.add(key);
      return;
    }
    if (!panes) return;
    panes.delete(pane);
    if (panes.size > 0) return;
    client.panes.delete(key);
    client.viewers.delete(key);
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

/** A `memory.*` limit as asked, clamped: not a positive number → the default, never a cap of 1; over the ceiling → the ceiling. */
function memoryLimit(raw: unknown): number {
  const asked = Math.floor(Number(raw));
  return Math.min(MEMORY_LIST_MAX, asked > 0 ? asked : MEMORY_LIST_DEFAULT);
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
