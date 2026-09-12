import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger, newId, readConfig, replaceDefaultSink } from "@jarhead/core";
import type { ToolResult } from "@jarhead/hands";
import { DaemonClient } from "@jarhead/daemon";
import { ALL_TOOL_SPECS, specByName, type ToolSpec } from "./tools.ts";
import { resultText } from "./runner.ts";

/**
 * jarhead-mcp — Jarhead's tools as a stdio MCP server.
 *
 * An out-of-process brain (the Codex CLI today; any MCP client tomorrow) starts
 * this as its MCP server and sees the same tool table the in-process brains have.
 * Nothing runs here: every tools/call becomes one `tool.run` message to the
 * daemon over its unix socket (`JARHEAD_SOCKET`), the engine's ToolRunner does
 * the work under the usual policy / ledger / confirmation handshake, and the
 * `tool.result` comes back as MCP content (screenshots as image content).
 *
 * Run it as: node node_modules/tsx/dist/cli.mjs packages/brain/src/mcp-bridge.ts
 *
 * A worker's brain gets its own bridge process, started with `JARHEAD_WORKER=<id>`
 * (codex-config.ts puts it in the MCP server's env): every tool.run then names the
 * worker and the daemon routes it to that worker's lane runner — never to the main
 * brain's, which holds the pointer. Without it the bridge is the main brain's.
 *
 * stdout is the MCP transport, so this process must never log there; the
 * default log sink is replaced with stderr before anything can speak.
 */

const log = logger("brain.mcp-bridge");

/** agent_wait may legitimately take ten minutes; everything else is far below this. */
export const DEFAULT_TOOL_TIMEOUT_MS = 660_000;

/** The worker id a bridge process acts for, from its environment; unset, empty or blank = the main brain. */
export function workerFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const worker = env["JARHEAD_WORKER"]?.trim();
  return worker ? worker : undefined;
}

/** The spec's JSON Schema goes to the client verbatim; MCP's Tool shape is the same vocabulary. */
export function toMcpTool(spec: ToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: spec.parameters.properties as Record<string, object>,
      ...(spec.parameters.required ? { required: [...spec.parameters.required] } : {}),
    },
  };
}

/** ToolResult → MCP content, the way the Claude Code brain's in-process MCP server renders it. */
export function toMcpContent(r: ToolResult): CallToolResult {
  switch (r.kind) {
    case "image":
      return {
        content: [
          { type: "image", data: r.pngBase64, mimeType: "image/png" },
          { type: "text", text: `${r.width}x${r.height} px${r.note ? `; ${r.note}` : ""}. Coordinates for clicks are pixels of this image.` },
        ],
      };
    case "text":
      return { content: [{ type: "text", text: r.text }] };
    case "needs-confirmation":
      // "needs_confirmation: …" — the same words the function-calling brains read.
      return { content: [{ type: "text", text: resultText(r) }] };
    case "error":
      return { content: [{ type: "text", text: resultText(r) }], isError: true };
  }
}

/**
 * The bridge's one connection to the daemon, kept for the life of the process:
 * every `tool.run` is multiplexed by id over it, several may be in flight at once
 * (Codex calls look-only tools in parallel), and a dropped socket is reconnected
 * on the next call. Saves a connect/hello handshake per call and, more to the
 * point, never lets a call fail because the daemon was between two connects.
 */
export interface SocketToolClientOptions {
  /** The worker this client acts for: rides on every tool.run so the daemon routes to that worker's lane runner. Absent or empty: the main brain. */
  readonly worker?: string | undefined;
}

export class SocketToolClient {
  private client: DaemonClient | undefined;
  private connecting: Promise<DaemonClient> | undefined;
  private readonly waiting = new Map<string, { resolve: (r: ToolResult) => void; timer: NodeJS.Timeout }>();
  private readonly worker: string | undefined;

  constructor(
    private readonly socketPath: string,
    opts: SocketToolClientOptions = {},
  ) {
    this.worker = opts.worker || undefined;
  }

  /** The worker every call names, if any. */
  get workerId(): string | undefined {
    return this.worker;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  get inFlight(): number {
    return this.waiting.size;
  }

  private connect(): Promise<DaemonClient> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    const client = new DaemonClient(this.socketPath);
    // Events from an older connection (a late `close` after a failed connect) must
    // not drop the calls of the one that replaced it.
    const stale = (): boolean => this.client !== client && this.attempt !== client;
    this.attempt = client;
    this.connecting = new Promise<DaemonClient>((resolve, reject) => {
      client.on("message", (m) => {
        if (m.type !== "tool.result" || stale()) return;
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        clearTimeout(w.timer);
        w.resolve(m.result);
      });
      client.on("close", () => {
        if (!stale()) this.dropped("the Jarhead daemon closed the connection before answering");
      });
      client.on("error", (e) => {
        if (!stale()) this.dropped(`could not reach the Jarhead daemon at ${this.socketPath}: ${e.message}`);
        reject(e);
      });
      client
        .connect({ pid: process.pid, audio: false })
        .then(() => {
          this.client = client;
          resolve(client);
        })
        .catch(reject);
    }).finally(() => {
      this.connecting = undefined;
      if (this.attempt === client) this.attempt = undefined;
    });
    return this.connecting;
  }

  /** The connection being opened right now, so its events are not taken for a stale one's. */
  private attempt: DaemonClient | undefined;

  /** The connection is gone: every call in flight gets an error result, the next call reconnects. */
  private dropped(message: string): void {
    this.client = undefined;
    for (const [id, w] of this.waiting) {
      this.waiting.delete(id);
      clearTimeout(w.timer);
      w.resolve({ kind: "error", message });
    }
  }

  async run(name: string, input: unknown, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS): Promise<ToolResult> {
    let client: DaemonClient;
    try {
      client = await this.connect();
    } catch (e) {
      return { kind: "error", message: `could not reach the Jarhead daemon at ${this.socketPath}: ${(e as Error).message}` };
    }
    const id = newId("tool");
    return new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ kind: "error", message: `${name} did not answer within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);
      this.waiting.set(id, { resolve, timer });
      client.sendJson({ type: "tool.run", id, name, input, ...(this.worker ? { worker: this.worker } : {}) });
    });
  }

  close(): void {
    const c = this.client;
    this.client = undefined;
    c?.close();
    this.dropped("the bridge is closing");
  }
}

/**
 * One tool call over its own connection: connect, `tool.run`, wait for the
 * matching `tool.result`, disconnect. The bridge itself keeps one connection
 * (SocketToolClient); this stays for one-off callers and tests.
 */
export function runToolOverSocket(socketPath: string, name: string, input: unknown, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, worker?: string): Promise<ToolResult> {
  const client = new DaemonClient(socketPath);
  const id = newId("tool");
  return new Promise<ToolResult>((resolve) => {
    let done = false;
    const finish = (r: ToolResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.close();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ kind: "error", message: `${name} did not answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
    client.on("message", (m) => {
      if (m.type === "tool.result" && m.id === id) finish(m.result);
    });
    client.on("close", () => finish({ kind: "error", message: "the Jarhead daemon closed the connection before answering" }));
    client.on("error", (e) => finish({ kind: "error", message: `could not reach the Jarhead daemon at ${socketPath}: ${e.message}` }));
    client
      .connect({ pid: process.pid, audio: false })
      .then(() => client.sendJson({ type: "tool.run", id, name, input, ...(worker ? { worker } : {}) }))
      .catch(() => undefined); // the "error" listener above has already finished the call
  });
}

export interface BridgeOptions {
  readonly socketPath: string;
  readonly toolTimeoutMs?: number | undefined;
  /** The worker this bridge acts for (the entry script passes `workerFromEnv()`); every tool.run carries it. */
  readonly worker?: string | undefined;
  /** Test seam: replaces the socket round-trip. */
  readonly run?: ((name: string, input: unknown) => Promise<ToolResult>) | undefined;
}

export function createBridgeServer(opts: BridgeOptions): Server {
  const socket = opts.run ? undefined : new SocketToolClient(opts.socketPath, { worker: opts.worker });
  const run = opts.run ?? ((name: string, input: unknown) => socket!.run(name, input, opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS));
  const server = new Server(
    { name: "jarhead", version: "2.0.0" },
    {
      capabilities: { tools: {} },
      instructions: "Jarhead's eyes, hands, and agents on Kevin's Mac. Take a screenshot before acting on anything you have not seen; a needs_confirmation result means: report the question and stop.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOL_SPECS.map(toMcpTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!specByName(name)) return { content: [{ type: "text", text: `error: unknown tool ${name}` }], isError: true } satisfies CallToolResult;
    const input = request.params.arguments ?? {};
    const started = Date.now();
    const result = await run(name, input);
    log.debug(`${name} → ${result.kind} in ${Date.now() - started}ms`);
    return toMcpContent(result);
  });
  server.onclose = () => socket?.close();
  return server;
}

function isEntryScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  replaceDefaultSink((level, scope, message) => process.stderr.write(`${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${scope}: ${message}\n`));
  const socketPath = readConfig().socketPath;
  const worker = workerFromEnv();
  const server = createBridgeServer({ socketPath, worker });
  const onClose = server.onclose;
  server.onclose = () => {
    onClose?.();
    process.exit(0);
  };
  process.stdin.on("end", () => process.exit(0));
  await server.connect(new StdioServerTransport());
  log.debug(`serving ${ALL_TOOL_SPECS.length} tools over stdio; daemon at ${socketPath}${worker ? `; worker ${worker}` : ""}`);
}
