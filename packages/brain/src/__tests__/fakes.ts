import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ComputerToolset, ConfirmationState, type NativeHands } from "@jarhead/hands";
import { AgentRegistry, type AgentConnector } from "@jarhead/agents";
import { ToolRunner } from "../runner.ts";
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

export function makeRunner(): { runner: ToolRunner; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "jh-brain-"));
  const toolset = new ComputerToolset({ hands: new FakeHands(), confirmations: new ConfirmationState() });
  const runner = new ToolRunner({ toolset, agents: new AgentRegistry([fakeConnector], 0), stateDir: dir });
  return { runner, dir };
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

export function makeTask(request: string, signal?: AbortSignal): BrainTask {
  return { delegationId: "item_1", request, dialogue: "", confirmation: false, offsetMs: 0, signal: signal ?? new AbortController().signal };
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

/**
 * An in-process HTTP server whose behaviour is a function of the request. Return
 * `{ status, json }` to answer, or `"hang"` to hold the response open until the
 * client goes away (for cancel tests).
 */
export async function fakeServer(route: (req: Seen, res: ServerResponse) => { status: number; json: unknown } | "hang"): Promise<FakeServer> {
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
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
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
