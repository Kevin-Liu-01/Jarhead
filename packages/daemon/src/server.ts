import { createConnection, createServer, type Server, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import { closeSync, constants as fsConstants, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logger } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import { specByName } from "@jarhead/brain";
import { isAudioState, isEngineCommand, type AudioState, type EngineEvent, type Grant, type OverlayCommand } from "@jarhead/protocol";
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

/** What the server needs from the engine; the real Engine satisfies it, and the test fakes implement all of it. */
export interface EngineLike {
  on(event: "event", listener: (e: EngineEvent) => void): unknown;
  on(event: "audio", listener: (pcm: Buffer) => void): unknown;
  on(event: "overlay", listener: (cmd: OverlayCommand) => void): unknown;
  /** Words the on-device ear should be biased toward (visible control titles, the front app, agent names). */
  on(event: "ear.hints", listener: (strings: readonly string[]) => void): unknown;
  snapshot(): unknown;
  command(cmd: unknown): Promise<void>;
  feedMic(pcm: Buffer): void;
  reportInputLevel(level: number): void;
  /** design12: the app's audio graph read back (`audio-state`), or undefined when the app that sent it left. Optional so a tool-only host and the older fakes need none. */
  reportAudioState?(state: AudioState | undefined): void;
  /** One permission as the app read it (any kind, the microphone included); the full list after a sweep. */
  setPermission(which: string, state: Grant, detail?: string): void;
  setPermissions(all: unknown[]): void;
  registerOwnPid(pid: number): void;
  /** On-device partial/final transcript from the app (reflex path). */
  ear(text: string, isFinal: boolean, segment: number, at: number): void;
  problem(text: string): void;
  readonly ledger: {
    read(at?: number): unknown[];
    days(): string[];
    sessions(): unknown[];
    readSession(sessionId: string): unknown[];
    /** Full-text hits over the live day files (`ledger.search`). */
    search(query: string, limit?: number): unknown[];
    /** A whole chain's rows in one read (`ledger.chain`). */
    readChain(rootId: string): { readonly rows: unknown[]; readonly truncated: boolean };
  };
  /** The memory module's reads (`memory.list` / `memory.search`). */
  readonly memory: { list(state?: string, limit?: number): unknown[]; search(query: string, limit?: number): Promise<unknown[]> };
  /** A client's socket closed: its conversation viewers leave (no leaked tails). */
  dropViewers(clientId: string): void;
  /** A `system.signal` the app forwarded (design11): data for the automations' watchers; optional so a tool-only host and the older fakes need none. */
  systemSignal?(signal: unknown, at: number): void;
  /** How many clients look at the island / Console (the app's `hello { audio: true }`): running timers tick only while > 0. Optional, as above. */
  setViewers?(n: number): void;
  readonly config: { readonly stateDir: string };
  /** The user's name as the refusals say it (the engine's effective name); a ToolHost may carry none. */
  readonly userName?: string | undefined;
  /** The engine's ToolRunner; `tool.run` messages go through it. When it says it has no task attached (`attached === false`), calls are refused: nothing acts without a delegation. */
  readonly runner: { run(name: string, input: unknown): Promise<{ readonly result: ToolResult }>; readonly attached?: boolean };
  /**
   * A thread's lane runner by thread id (`t_…`), for `tool.run { thread }` from a bridge
   * started with JARHEAD_THREAD. Undefined for a thread the engine does not have —
   * finished, stopped, never started — and the call is refused, never handed to `runner`.
   */
  runnerFor(threadId: string): EngineLike["runner"] | undefined;
}

/**
 * What `tool.run` needs and nothing more: the engine narrowed to its runners. CodexBrain's
 * private tool socket (one brain outside the daemon process) fronts this — its `runnerFor`
 * answers for exactly that brain's thread id, or its every stamped call is refused as
 * unknown. A server built over a ToolHost answers `tool.run` and refuses or ignores the rest.
 */
export type ToolHost = Pick<EngineLike, "runner" | "runnerFor" | "userName">;

/** A ToolHost as an engine: the runners are its, everything else is inert. */
function toolOnlyEngine(host: ToolHost): EngineLike {
  const noRows = (): unknown[] => [];
  return {
    get userName(): string | undefined {
      return host.userName;
    },
    on: () => undefined,
    snapshot: () => ({ phase: "asleep" }),
    command: async () => undefined,
    feedMic: () => undefined,
    reportInputLevel: () => undefined,
    setPermission: () => undefined,
    setPermissions: () => undefined,
    registerOwnPid: () => undefined,
    ear: () => undefined,
    problem: (text) => log.warn(text),
    ledger: { read: noRows, days: () => [], sessions: noRows, readSession: noRows, search: noRows, readChain: () => ({ rows: [], truncated: false }) },
    memory: { list: noRows, search: async () => [] },
    dropViewers: () => undefined,
    config: { stateDir: "" },
    runner: host.runner,
    runnerFor: (threadId) => host.runnerFor(threadId),
  };
}

function isEngine(e: EngineLike | ToolHost): e is EngineLike {
  return "command" in e;
}

interface Client {
  /** Per connection ("c7"): the prefix on every conversation viewer this client opens, so its tails close with its socket. */
  readonly id: string;
  readonly socket: Socket;
  readonly parser: FrameParser;
  audio: boolean;
  /** This client said `bye` (a clean quit): its socket closing is not a crash. */
  bye: boolean;
  /** This client sent an `audio-state` frame: when its socket closes the snapshot's audioState is cleared (the graph left with the app). */
  audioState: boolean;
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

/** A page's own conversation id, read defensively: a page without one is routed nowhere rather than thrown on. */
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

/**
 * How long a session stays open after the app's connection closes without a bye, waiting for
 * the app to come back. A crash relaunch re-attaches in 1 to 3 s, and an app that dropped one
 * bad frame reconnects in under one: both find the session, the running task and the threads
 * as they were. An app that is still gone after this is not coming back soon, and Live bills
 * every second the session is open: the session is paused then (V7).
 */
export const APP_GONE_GRACE_MS = 10_000;

export interface DaemonServerOptions {
  /** The version in the hello. */
  readonly version?: string;
  /** APP_GONE_GRACE_MS, shorter in tests. */
  readonly appGoneGraceMs?: number;
}

export class DaemonServer extends EventEmitter<DaemonServerEvents> {
  private server: Server | undefined;
  private readonly clients = new Set<Client>();
  private clientSeq = 0;
  private readonly engine: EngineLike;
  private readonly version: string;
  private readonly appGoneGraceMs: number;
  /** The socket file this server bound (device and inode): close() removes that file and no other. */
  private owned: { readonly dev: number; readonly ino: number } | undefined;
  /** `<socket>.lock`, held while this server serves the path (`listen` to `close`). */
  private socketLock: HeldLock | undefined;
  /** Armed when the last app leaves without a bye; an app's hello clears it; firing pauses an open session. */
  private appGoneTimer: NodeJS.Timeout | undefined;
  /** close() has begun: the sockets it destroys are not apps that crashed. */
  private closing = false;

  /** Over the engine, or over a ToolHost (a brain's private tool socket): then only `tool.run` does anything. */
  constructor(
    engine: EngineLike | ToolHost,
    private readonly socketPath: string,
    options: DaemonServerOptions = {},
  ) {
    super();
    this.version = options.version ?? "2.0.0";
    this.appGoneGraceMs = options.appGoneGraceMs ?? APP_GONE_GRACE_MS;
    this.engine = isEngine(engine) ? engine : toolOnlyEngine(engine);
    this.engine.on("event", (e) => {
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
        // ---- automations (design11): small and every surface reads them — the island's ring, the banner, the rail; broadcast like toast.
        case "automation.event":
          return this.broadcast({ type: "automation.event", event: e.event });
        case "local.say":
          return this.broadcast({ type: "local.say", ...(e.text !== undefined ? { text: e.text } : {}), ...(e.sound !== undefined ? { sound: e.sound } : {}), automationId: e.automationId });
        case "notify":
          return this.broadcast({ type: "notify", id: e.id, title: e.title, ...(e.body !== undefined ? { body: e.body } : {}), presses: e.presses, automationId: e.automationId });
      }
    });
    this.engine.on("audio", (pcm) => {
      const frame = encodeFrame(FRAME_SPEAKER, pcm);
      for (const c of this.clients) if (c.audio && c.socket.writable) c.socket.write(frame);
    });
    this.engine.on("overlay", (cmd) => this.broadcast({ type: "overlay", command: cmd }));
    this.engine.on("ear.hints", (strings) => this.broadcast({ type: "ear.hints", strings }));
  }

  /**
   * Bind the socket path, or refuse it. A path another server holds is that server's: a
   * second daemon (a respawn beside a wedged one, `pnpm jarheadd` beside the app's) or a
   * second brain's tool server gets SocketInUseError and takes nothing.
   *
   * Two checks say the path is held. First the lock beside it, `<socket>.lock`, which every
   * server holds from here to close(): a held lock is a live server, even a wedged one whose
   * accept queue is full and refuses every connect. Then a probe, for a server of an older
   * build that takes no lock: one that accepts is refused. Only a file nobody holds and
   * nobody accepts on (ECONNREFUSED: a daemon that was killed) is removed first.
   *
   * The socket is bound under a private name in the same folder and then hard-linked into
   * place: link(2) refuses a path that exists, so two servers racing past both checks cannot
   * both win, and libuv, which unlinks the name it bound when the server closes, removes
   * only the private name. close() removes the public path itself, and only while it is
   * still this server's inode.
   */
  async listen(): Promise<void> {
    const path = this.socketPath;
    this.closing = false;
    const lock = takeLock(socketLockPath(path));
    if (lock === "held") throw new SocketInUseError(path, lockHolder(socketLockPath(path)));
    this.socketLock = lock;
    try {
      await this.bindPath(path);
    } catch (e) {
      this.releaseSocketLock();
      throw e;
    }
    log.info(`listening on ${path}`);
  }

  private async bindPath(path: string): Promise<void> {
    const found = await probeSocket(path);
    if (found.state === "answers") throw new SocketInUseError(path);
    // A file that is not a socket (ENOTSOCK), or one we may not touch: not ours to delete.
    if (found.state === "other") throw new Error(`cannot take ${path} (${found.code}): something other than a Jarhead socket is there`);
    if (found.state === "stale") {
      try {
        unlinkSync(path);
        log.info(`removed a stale socket file at ${path} (nobody held it or accepted on it)`);
      } catch {
        // Gone already, or not ours to remove: the link below reports it.
      }
    }
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    const staging = stagingPath(path);
    if (staging === undefined) {
      // A path too long for a private sibling name: bind it directly (the close-time unlink of a taken-over path is the one thing lost).
      await bind(server, path);
    } else {
      try {
        unlinkSync(staging);
      } catch {
        // none left over
      }
      await bind(server, staging);
      try {
        linkSync(staging, path);
      } catch (e) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.server = undefined;
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SocketInUseError(path);
        throw e;
      } finally {
        try {
          unlinkSync(staging);
        } catch {
          // already gone
        }
      }
    }
    const st = lstatSync(path);
    this.owned = { dev: st.dev, ino: st.ino };
  }

  private releaseSocketLock(): void {
    const lock = this.socketLock;
    this.socketLock = undefined;
    lock?.release(true);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private accept(socket: Socket): void {
    const client: Client = { id: `c${++this.clientSeq}`, socket, parser: new FrameParser(), audio: false, bye: false, audioState: false, viewers: new Set(), panes: new Map() };
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
        this.engine.dropViewers(client.id);
      } catch (e) {
        log.debug(`dropViewers(${client.id}): ${(e as Error).message}`);
      }
      // The audio graph left with the app that reported it: the snapshot must not keep a stale read-back.
      if (client.audioState) {
        try {
          this.engine.reportAudioState?.(undefined);
        } catch (e) {
          log.debug(`reportAudioState(undefined): ${(e as Error).message}`);
        }
      }
      log.info(`client left (${this.clients.size} remaining)`);
      this.tellViewers();
      if (client.audio && !client.bye) this.appGone();
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
        if (client.audio) this.appBack();
        this.tellViewers();
        return;
      case "command": {
        if (!isEngineCommand(msg.command)) return this.send(client, { type: "error", message: "malformed command" });
        // The × on one thumbnail names its mark; without an id there is nothing to forget, and the engine never sees it.
        if (msg.command.type === "mark.remove" && (typeof msg.command.id !== "string" || msg.command.id === "")) return this.send(client, { type: "error", message: "malformed command" });
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
      case "audio-state":
        // Data, never a command (design12): the shape is checked here and a malformed frame is dropped with a line, never kept.
        if (!isAudioState(msg.state)) {
          log.debug("audio-state frame dropped: malformed");
          return;
        }
        client.audioState = true;
        this.engine.reportAudioState?.(msg.state);
        return;
      case "ear":
        if (typeof msg.text === "string") this.engine.ear(msg.text, msg.isFinal === true, Number(msg.segment ?? 0), Number(msg.at ?? Date.now()));
        return;
      case "permission":
        this.engine.setPermission(msg.which, msg.state, msg.detail);
        break;
      case "system.signal":
        // Data, never a command: the engine matches it against the armed watchers and resyncs; nothing here can wake it.
        if (typeof msg.signal === "object" && msg.signal !== null) this.engine.systemSignal?.(msg.signal, Number(msg.at) || Date.now());
        return;
      case "permissions":
        if (Array.isArray(msg.all)) this.engine.setPermissions(msg.all);
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
        const r = typeof msg.rootId === "string" ? this.engine.ledger.readChain(msg.rootId) : { rows: [], truncated: false };
        this.send(client, { type: "ledger.rows", id: String(msg.id ?? ""), rows: r.rows, ...(r.truncated ? { truncated: true } : {}) });
        return;
      }
      case "memory.list": {
        const items = this.engine.memory.list(typeof msg.state === "string" ? msg.state : undefined, memoryLimit(msg.limit));
        this.send(client, { type: "memory.items", id: String(msg.id ?? ""), items: items.slice(0, MEMORY_LIST_MAX) });
        return;
      }
      case "memory.search": {
        // Async (an embedding may be asked for): the answer lands under the request id when it comes; a failure is an empty list, never a dropped client.
        const id = String(msg.id ?? "");
        const query = typeof msg.query === "string" ? msg.query : "";
        const limit = memoryLimit(msg.limit);
        void this.engine.memory
          .search(query, limit)
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
        const hits = this.engine.ledger.search(query, ...(Number.isFinite(limit) && limit > 0 ? [limit] : []));
        this.send(client, { type: "ledger.hits", id: String(msg.id ?? ""), hits });
        return;
      }
      case "tool.run":
        // Nothing on this path may become an unhandled rejection: the daemon has no handler
        // for one, and Node would take the whole engine down over one bad tool call.
        void this.runTool(client, msg.id, msg.name, msg.input, msg.thread).catch((e: unknown) => log.warn(`tool.run ${String(msg.name)} failed outside the runner: ${(e as Error).message}`));
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
        client.bye = true;
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
   * A call that names a thread goes to that thread's lane runner and nowhere else:
   * the main runner holds the pointer and the keyboard, so an unknown, finished or
   * malformed thread id is a refusal the model can read, never a fall-through.
   */
  private async runTool(client: Client, id: unknown, name: unknown, input: unknown, thread?: unknown): Promise<void> {
    const requestId = typeof id === "string" ? id : String(id ?? "");
    const answer = (result: ToolResult): void => this.send(client, { type: "tool.result", id: requestId, result });
    if (typeof name !== "string" || !specByName(name)) return answer({ kind: "error", message: `unknown tool ${String(name)}` });
    // Finding the runner is engine code (a pool lookup, possibly mid-cut): a throw there is a
    // refusal the model reads, never an unhandled rejection that exits the daemon.
    let runner: EngineLike["runner"];
    try {
      if (thread === undefined) runner = this.engine.runner;
      else {
        if (typeof thread !== "string" || thread === "") return answer({ kind: "error", message: `refused: malformed thread id; ${name} was not run` });
        const lane = this.engine.runnerFor(thread);
        if (!lane) return answer({ kind: "error", message: `refused: no thread ${thread} is running in Jarhead; ${name} was not run (it finished, was stopped, or never started)` });
        runner = lane;
      }
      // An out-of-process brain may only act while a delegation has the runner: a Codex
      // turn that outlived a stop (interrupted before turn/start answered) gets a refusal, not a click.
      if (runner.attached === false) return answer({ kind: "error", message: `refused: no task is running in Jarhead; ${name} was not run (${this.engine.userName || "Kevin"} stopped the task, or it finished)` });
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

  /**
   * The app's connection closed without a bye (it crashed, or it dropped the connection) and
   * no other app is attached. Nobody can hear the voice or speak to it now, and GPT-Live-1
   * bills every second the session is open. But the app is usually back within seconds (the
   * crash guard relaunches it; a dropped connection reconnects), and a pause cuts everything:
   * the running task, every thread, the questions waiting for an answer. So wait
   * `appGoneGraceMs` first. An app's hello inside that window clears it, and the session,
   * the task and the threads go on. Only an app still gone then pauses the session: it closes
   * and the conversation is held, so the app resumes it with Go or the wake word when it is
   * back. A clean quit stopped the session before its socket closed, and said bye.
   */
  private appGone(): void {
    if (this.closing || this.hasApp()) return;
    if (this.appGoneTimer) clearTimeout(this.appGoneTimer);
    if (this.sessionOpen()) log.warn(`the app left without a bye while a session was open; it is paused in ${Math.round(this.appGoneGraceMs / 1000)} s unless the app comes back`);
    this.appGoneTimer = setTimeout(() => this.appStayedGone(), this.appGoneGraceMs);
    this.appGoneTimer.unref?.();
  }

  /** An app said hello: whatever its leaving armed is off. */
  private appBack(): void {
    if (!this.appGoneTimer) return;
    clearTimeout(this.appGoneTimer);
    this.appGoneTimer = undefined;
    log.info("the app is back inside the grace; nothing is paused");
  }

  private appStayedGone(): void {
    this.appGoneTimer = undefined;
    if (this.closing || this.hasApp() || !this.sessionOpen()) return;
    log.warn(`the app did not come back in ${Math.round(this.appGoneGraceMs / 1000)} s; pausing the session (the meter stops; Go resumes)`);
    void this.engine.command({ type: "pause" }).catch((e: unknown) => log.warn(`pause after the app left: ${(e as Error).message}`));
  }

  private hasApp(): boolean {
    for (const c of this.clients) if (c.audio) return true;
    return false;
  }

  /** A Live session is open: the meter runs, and a pause can close it. */
  private sessionOpen(): boolean {
    let snapshot: unknown;
    try {
      snapshot = this.engine.snapshot();
    } catch {
      return false;
    }
    return typeof snapshot === "object" && snapshot !== null && (snapshot as { session?: unknown }).session != null;
  }

  /** The app (the client that said `hello { audio: true }`) is the one looking at the island and the Console; the CLI's join/leave clients are not viewers. */
  private tellViewers(): void {
    let n = 0;
    for (const c of this.clients) if (c.audio) n++;
    try {
      this.engine.setViewers?.(n);
    } catch (e) {
      log.debug(`setViewers: ${(e as Error).message}`);
    }
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

  /** Stop serving. The socket file goes only while it is still the one this server bound: a path another daemon has taken since is left answering. */
  async close(): Promise<void> {
    // The sockets destroyed here are not apps that crashed: nothing is armed, and nothing armed fires.
    this.closing = true;
    if (this.appGoneTimer) clearTimeout(this.appGoneTimer);
    this.appGoneTimer = undefined;
    for (const c of this.clients) c.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
    const owned = this.owned;
    this.owned = undefined;
    if (owned) {
      try {
        const st = lstatSync(this.socketPath);
        if (st.dev === owned.dev && st.ino === owned.ino) unlinkSync(this.socketPath);
        else log.info(`not removing ${this.socketPath}: another server has bound it since`);
      } catch {
        // gone already
      }
    }
    // Last, once the path is gone: a server that takes the lock next finds nothing to refuse.
    this.releaseSocketLock();
  }
}

// ----------------------------------------------------------- one instance

/**
 * listen() found the path held: another server keeps it. The message is neutral because a
 * brain's private tool server reads it as well as the daemon (main.ts says its own line).
 */
export class SocketInUseError extends Error {
  readonly code = "EJARHEAD_SOCKET_IN_USE";
  /** The pid in `<socket>.lock` when the lock said so; undefined when a server of an older build answered the probe. */
  constructor(
    readonly socketPath: string,
    readonly holder?: number,
  ) {
    super(`something already serves ${socketPath}${holder !== undefined ? ` (pid ${holder})` : ""}`);
    this.name = "SocketInUseError";
  }
}

/** `<socket>.lock`: held (flock) by the one server listening on that path, from listen() to close(); it holds that server's pid. */
export function socketLockPath(socketPath: string): string {
  return `${socketPath}.lock`;
}

/**
 * Whether a server holds `socketPath` right now, without taking it: its lock is held, or
 * (a server of an older build, which takes no lock) something accepts on it. The error says
 * which; undefined when the path is free. main.ts asks before it builds an engine.
 */
export async function socketInUse(socketPath: string): Promise<SocketInUseError | undefined> {
  const lock = socketLockPath(socketPath);
  if (lockHeld(lock)) return new SocketInUseError(socketPath, lockHolder(lock));
  if ((await probeSocket(socketPath)).state === "answers") return new SocketInUseError(socketPath);
  return undefined;
}

export type SocketProbe =
  | { readonly state: "answers" }
  | { readonly state: "stale" }
  | { readonly state: "absent" }
  | { readonly state: "other"; readonly code: string };

/**
 * What sits at a unix socket path: a server that accepts, a file whose connects are refused
 * (ECONNREFUSED), nothing (ENOENT), or something else that is not ours to remove.
 *
 * A wedged server still "answers" while its accept queue has room: the kernel accepts into
 * the queue. Once the queue is full (closed connections stay in it until the server accepts
 * them; the default backlog is kern.ipc.somaxconn, 128), its connects are refused too, and
 * it reads as "stale" here, the same as a socket file left by a killed daemon. So "stale"
 * alone does not prove nobody listens: listen() trusts it only when the path's lock is free.
 */
export function probeSocket(path: string, timeoutMs = 1000): Promise<SocketProbe> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const done = (r: SocketProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ state: "other", code: "ETIMEDOUT" }), timeoutMs);
    socket.once("connect", () => done({ state: "answers" }));
    socket.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ECONNREFUSED") done({ state: "stale" });
      else if (e.code === "ENOENT") done({ state: "absent" });
      else done({ state: "other", code: e.code ?? e.message });
    });
  });
}

let stagingSeq = 0;
/** sun_path holds 104 bytes on macOS, the terminating NUL included. */
const SUN_PATH_MAX = 103;

/** A private sibling name to bind before linking into place, or undefined when it would not fit in sun_path. */
function stagingPath(path: string): string | undefined {
  const name = `.${basename(path)}.${process.pid.toString(36)}${(stagingSeq++).toString(36)}`;
  const staging = join(dirname(path), name);
  return Buffer.byteLength(staging) <= SUN_PATH_MAX ? staging : undefined;
}

function bind(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

/** `<stateDir>/jarheadd.lock`: held (flock) by the one daemon serving that state dir, for its whole life; it holds that daemon's pid. */
export const DAEMON_LOCK_FILE = "jarheadd.lock";
/** The daemon's exit code when another daemon already serves its state dir or its socket (sysexits' EX_CANTCREAT). */
export const EXIT_ALREADY_RUNNING = 73;
/** Darwin's open(2) O_EXLOCK: the exclusive flock is taken atomically with the open; with O_NONBLOCK a held lock fails at once (EAGAIN). */
const O_EXLOCK = 0x20;
/** Darwin's O_SHLOCK: a shared flock, which cannot be had while another open file holds the exclusive one. */
const O_SHLOCK = 0x10;

/** Another daemon holds the state dir's lock. */
export class DaemonLockHeld extends Error {
  readonly code = "EJARHEAD_LOCKED";
  constructor(
    readonly lockPath: string,
    readonly holder: number | undefined,
  ) {
    super(`another Jarhead daemon${holder !== undefined ? ` (pid ${holder})` : ""} holds ${lockPath}`);
    this.name = "DaemonLockHeld";
  }
}

export interface DaemonLock {
  readonly path: string;
  /** Drop the lock (and blank the pid): at shutdown. The kernel drops it anyway when the process dies, SIGKILL included. */
  release(): void;
}

/**
 * Take `<stateDir>/jarheadd.lock`, or throw DaemonLockHeld naming the daemon that has it.
 * Two engines on one state dir would both write the ledger and both fire every alarm; the
 * lock makes the second refuse before it builds anything. The file carries the holder's pid,
 * which the app reads (only while the lock is held) to kick a daemon it did not spawn. (macOS
 * only, like Jarhead: elsewhere the pid is written and nothing is locked.)
 */
export function acquireDaemonLock(stateDir: string): DaemonLock {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, DAEMON_LOCK_FILE);
  const lock = takeLock(path, { strict: true });
  if (lock === "held") throw new DaemonLockHeld(path, lockHolder(path));
  return { path, release: () => lock?.release(false) };
}

interface HeldLock {
  /** Drop it. `remove`: unlink the file first, while still held (a lock beside a socket); otherwise only blank the pid. */
  release(remove: boolean): void;
}

/**
 * An exclusive flock on `path` (created if missing), taken atomically with the open
 * (O_EXLOCK | O_NONBLOCK), with this process's pid written in. "held" when another open
 * file holds it: another process, or another server in this one. undefined when no lock can
 * be had for a reason other than a holder (a folder we may not write); `strict` throws then.
 * The descriptor is close-on-exec, so no child inherits the lock.
 */
function takeLock(path: string, opts: { strict?: boolean } = {}): HeldLock | "held" | undefined {
  const flags = fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NONBLOCK | (process.platform === "darwin" ? O_EXLOCK : 0);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o644);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return "held";
    if (opts.strict) throw e;
    log.debug(`no lock at ${path} (${code ?? (e as Error).message}); going on without one`);
    return undefined;
  }
  ftruncateSync(fd, 0);
  writeSync(fd, `${process.pid}\n`, 0);
  let held = true;
  return {
    release: (remove) => {
      if (!held) return;
      held = false;
      try {
        if (remove) unlinkSync(path);
        else ftruncateSync(fd, 0);
      } catch {
        // the pid stays; the app checks the lock before trusting it
      }
      closeSync(fd);
    },
  };
}

/** Whether another open file holds an exclusive lock on `path` (a shared one cannot be had). False for no file. */
function lockHeld(path: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    closeSync(openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | O_SHLOCK));
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EAGAIN" || code === "EWOULDBLOCK";
  }
}

/** The pid written in a lock file, when there is one. */
function lockHolder(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
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
