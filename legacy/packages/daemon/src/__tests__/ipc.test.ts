import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Server } from "node:net";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcRequest, startIpcServer, type IpcHandlers } from "../ipc.ts";

const sockPath = (): string => join(mkdtempSync(join(tmpdir(), "jarvisd-ipc-")), "d.sock");

function handlers(overrides: Partial<IpcHandlers> = {}): IpcHandlers {
  return {
    status: () => ({ pid: 42 }),
    runs: (limit) => ({ limit }),
    tick: async () => ["ran"],
    stop: async () => undefined,
    ...overrides,
  };
}

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

test("status and tick round-trip as one JSON line each way", async () => {
  const path = sockPath();
  const server = await startIpcServer(path, handlers());
  try {
    assert.deepEqual(await ipcRequest(path, { cmd: "status" }), { ok: true, result: { pid: 42 } });
    assert.deepEqual(await ipcRequest(path, { cmd: "tick" }), { ok: true, result: ["ran"] });
  } finally {
    await close(server);
  }
});

test("runs passes the limit through, defaulting when absent or nonsense", async () => {
  const path = sockPath();
  const server = await startIpcServer(path, handlers());
  try {
    assert.deepEqual(await ipcRequest(path, { cmd: "runs", limit: 3 }), { ok: true, result: { limit: 3 } });
    assert.deepEqual(await ipcRequest(path, { cmd: "runs" }), { ok: true, result: { limit: 20 } });
  } finally {
    await close(server);
  }
});

test("unknown commands and broken json get an error reply, not a dropped connection", async () => {
  const path = sockPath();
  const server = await startIpcServer(path, handlers());
  try {
    const unknown = await ipcRequest(path, { cmd: "reboot" } as never);
    assert.deepEqual(unknown, { ok: false, error: "unknown cmd: reboot" });

    // Raw socket, because the typed client cannot send broken JSON.
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      let buf = "";
      socket.on("connect", () => socket.write("{ nope\n"));
      socket.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        if (buf.includes("\n")) {
          socket.end();
          resolve(buf.trim());
        }
      });
      socket.on("error", reject);
    });
    assert.deepEqual(JSON.parse(reply), { ok: false, error: "request is not json" });
  } finally {
    await close(server);
  }
});

test("a throwing handler becomes an error reply", async () => {
  const path = sockPath();
  const server = await startIpcServer(
    path,
    handlers({
      tick: async () => {
        throw new Error("scheduler exploded");
      },
    }),
  );
  try {
    assert.deepEqual(await ipcRequest(path, { cmd: "tick" }), { ok: false, error: "scheduler exploded" });
  } finally {
    await close(server);
  }
});

test("a stale socket file is deleted on startup", async () => {
  const path = sockPath();
  writeFileSync(path, "");
  assert.ok(existsSync(path));
  const server = await startIpcServer(path, handlers());
  try {
    assert.deepEqual(await ipcRequest(path, { cmd: "status" }), { ok: true, result: { pid: 42 } });
  } finally {
    await close(server);
  }
});

test("stop replies before the handler tears the server down", async () => {
  const path = sockPath();
  let stopped = false;
  const server = await startIpcServer(
    path,
    handlers({
      stop: async () => {
        stopped = true;
      },
    }),
  );
  try {
    assert.deepEqual(await ipcRequest(path, { cmd: "stop" }), { ok: true, result: "stopping" });
    assert.ok(stopped);
  } finally {
    await close(server);
  }
});

test("the client fails fast and clearly when no daemon is listening", async () => {
  await assert.rejects(
    ipcRequest(join(mkdtempSync(join(tmpdir(), "jarvisd-ipc-")), "absent.sock"), { cmd: "status" }, 500),
    /not reachable/,
  );
});
