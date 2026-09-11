import { createConnection, createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Unix-socket control channel, newline-delimited JSON both ways.
 *
 * This is the seam DECISION.md draws between the daemon and whatever face
 * eventually talks to it — CLI today, possibly a native shell at M3. Keeping
 * the protocol to one JSON line per request means a shell one-liner
 * (`echo '{"cmd":"status"}' | nc -U ...`) can always debug it.
 */

export type IpcRequest =
  | { readonly cmd: "status" }
  | { readonly cmd: "runs"; readonly limit?: number }
  | { readonly cmd: "tick" }
  | { readonly cmd: "stop" };

export type IpcResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: string };

export interface IpcHandlers {
  readonly status: () => unknown;
  readonly runs: (limit: number) => unknown;
  /** Forces a scheduler pass now. Resolves with whatever ran. */
  readonly tick: () => Promise<unknown>;
  readonly stop: () => Promise<void>;
}

const DEFAULT_RUNS_LIMIT = 20;

export function startIpcServer(socketPath: string, handlers: IpcHandlers): Promise<Server> {
  // Unconditional delete is safe here: the pidfile gate has already proven no
  // live daemon owns this path, so anything sitting there is crash leftovers.
  if (existsSync(socketPath)) unlinkSync(socketPath);
  mkdirSync(dirname(socketPath), { recursive: true });

  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) void respond(socket, line, handlers);
      }
    });
    // A client hanging up mid-reply is its problem, not a daemon crash.
    socket.on("error", () => undefined);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

async function respond(socket: Socket, line: string, handlers: IpcHandlers): Promise<void> {
  let parsed: { cmd?: unknown; limit?: unknown };
  try {
    parsed = JSON.parse(line) as { cmd?: unknown; limit?: unknown };
  } catch {
    write(socket, { ok: false, error: "request is not json" });
    return;
  }

  try {
    switch (parsed.cmd) {
      case "status":
        write(socket, { ok: true, result: handlers.status() });
        return;
      case "runs": {
        const limit =
          typeof parsed.limit === "number" && parsed.limit > 0 ? Math.floor(parsed.limit) : DEFAULT_RUNS_LIMIT;
        write(socket, { ok: true, result: handlers.runs(limit) });
        return;
      }
      case "tick":
        write(socket, { ok: true, result: await handlers.tick() });
        return;
      case "stop":
        // Acknowledge before tearing down — afterwards there is no socket
        // left to answer on.
        write(socket, { ok: true, result: "stopping" });
        socket.end();
        await handlers.stop();
        return;
      default:
        write(socket, { ok: false, error: `unknown cmd: ${String(parsed.cmd)}` });
    }
  } catch (e) {
    write(socket, { ok: false, error: (e as Error).message });
  }
}

function write(socket: Socket, response: IpcResponse): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
}

/**
 * One request, one reply. This is what the CLI uses to query a running daemon;
 * a connection error means jarvisd is simply not up, and callers should say
 * that instead of stack-tracing.
 */
export function ipcRequest(socketPath: string, request: IpcRequest, timeoutMs = 5000): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const fail = (e: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(e);
    };

    const timer = setTimeout(
      () => fail(new Error(`jarvisd did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    );

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1 || settled) return;
      settled = true;
      clearTimeout(timer);
      socket.end();
      const line = buffer.slice(0, nl);
      try {
        resolve(JSON.parse(line) as IpcResponse);
      } catch {
        reject(new Error(`jarvisd sent a non-json reply: ${line.slice(0, 120)}`));
      }
    });

    socket.on("error", (e) => {
      fail(new Error(`jarvisd is not reachable at ${socketPath}: ${e.message}`));
    });
  });
}
