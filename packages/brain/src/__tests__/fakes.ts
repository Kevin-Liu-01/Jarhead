import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ComputerToolset, ConfirmationState, type NativeHands } from "@jarhead/hands";
import { AgentRegistry, type AgentConnector } from "@jarhead/agents";
import { ToolRunner, type RunnerOptions } from "../runner.ts";
import type { BrainSink, BrainTask } from "../brain.ts";

/** Hands that answer every op with a canned result; enough for a tool round-trip. */
export class FakeHands implements NativeHands {
  ready = true;
  async request<T>(op: string): Promise<T> {
    if (op === "screenshot") return { displayId: 1, pngBase64: Buffer.from("png").toString("base64"), width: 100, height: 50, points: { x: 0, y: 0, w: 200, h: 100 }, scale: 0.5 } as T;
    if (op === "frontmost") return { app: "Finder", pid: 1, window: null } as T;
    if (op === "element_at") return { role: "AXButton", title: "Open" } as T;
    if (op === "cursor") return { x: 10, y: 10 } as T;
    return {} as T;
  }
}

const fakeConnector: AgentConnector = {
  kind: "sessions",
  health: async () => ({ kind: "sessions", ok: true, detail: "ok" }),
  list: async () => [{ id: "sessions:claude:w1p1", kind: "sessions", name: "reviewer", status: "idle", cwd: "/repo", updatedAt: 0 }],
  send: async () => ({ accepted: true }),
  read: async () => "last line",
};

export function makeRunner(overrides: Partial<RunnerOptions> = {}, hands: NativeHands = new FakeHands()): { runner: ToolRunner; dir: string; toolset: ComputerToolset } {
  const dir = mkdtempSync(join(tmpdir(), "jh-brain-"));
  const toolset = new ComputerToolset({ hands, confirmations: new ConfirmationState() });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([fakeConnector], 0), stateDir: dir, ...overrides });
  return { runner, dir, toolset };
}

export interface SinkLog {
  sink: BrainSink;
  thinking: string[];
  commentary: string[];
  steps: string[];
}

export function makeSink(): SinkLog {
  const log: SinkLog = { thinking: [], commentary: [], steps: [], sink: undefined as unknown as BrainSink };
  log.sink = {
    thinking: (t) => log.thinking.push(t),
    commentary: (t) => log.commentary.push(t),
    step: (s) => log.steps.push(`${s.kind}:${s.tool?.name ?? s.text?.slice(0, 40) ?? ""}`),
    screenshot: (p) => log.steps.push(`shot:${p.split("/")[0]}`),
  };
  return log;
}

/** A task for the runner; `extra` sets the dialogue fields (what the gates read is `request` + `kevinDialogue`, never `dialogue`). */
export function makeTask(request: string, signal?: AbortSignal, extra: Partial<Pick<BrainTask, "dialogue" | "kevinDialogue" | "confirmation">> = {}): BrainTask {
  return { delegationId: "item_1", request, dialogue: "", confirmation: false, offsetMs: 0, signal: signal ?? new AbortController().signal, ...extra };
}

export interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface FakeServer {
  url: string;
  seen: Seen[];
  /** Resolves when the n-th request (1-based) has arrived. */
  arrived(n: number): Promise<Seen>;
  close(): Promise<void>;
}

/** A JSON answer, after `delayMs` when set. */
export interface FakeJson {
  status: number;
  json: unknown;
  delayMs?: number;
}
/**
 * A streamed answer: each item is one line of `application/x-ndjson`, written
 * `delayMs` apart (default 5 ms; an array gives the wait before each item). With
 * `hang` the stream stays open after the last item until the client goes away —
 * a model that went quiet.
 */
export interface FakeNdjson {
  status: number;
  ndjson: unknown[];
  delayMs?: number | number[];
  hang?: boolean;
}
export type FakeAnswer = FakeJson | FakeNdjson | "hang";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * An in-process HTTP server whose behaviour is a function of the request. Return
 * `{ status, json }` to answer, `{ status, ndjson }` to stream lines, or `"hang"`
 * to hold the response open until the client goes away (for cancel tests).
 */
export async function fakeServer(route: (req: Seen, res: ServerResponse) => FakeAnswer): Promise<FakeServer> {
  const seen: Seen[] = [];
  const waiters: Array<{ n: number; resolve: (s: Seen) => void }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const entry: Seen = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      seen.push(entry);
      for (const w of waiters.splice(0)) {
        if (w.n <= seen.length) w.resolve(seen[w.n - 1]!);
        else waiters.push(w);
      }
      const out = route(entry, res);
      if (out === "hang") {
        // Never answer. Since Node 16 the IncomingMessage's own "close" fires as
        // soon as the body is consumed, so only the socket says when the client
        // actually went away; server.close() tears down whatever is still open.
        req.socket.once("close", () => res.destroy());
        return;
      }
      if ("ndjson" in out) {
        req.socket.once("close", () => res.destroy());
        void (async () => {
          res.writeHead(out.status, { "content-type": "application/x-ndjson" });
          for (const [i, item] of out.ndjson.entries()) {
            const ms = Array.isArray(out.delayMs) ? out.delayMs[i] ?? 5 : out.delayMs ?? 5;
            if (ms > 0) await wait(ms);
            if (res.destroyed || req.socket.destroyed) return;
            res.write(`${JSON.stringify(item)}\n`);
          }
          if (!out.hang && !res.destroyed) res.end();
        })();
        return;
      }
      void (async () => {
        if (out.delayMs) await wait(out.delayMs);
        if (res.destroyed || req.socket.destroyed) return;
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.json));
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    arrived: (n) => (seen.length >= n ? Promise.resolve(seen[n - 1]!) : new Promise((resolve) => waiters.push({ n, resolve }))),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
