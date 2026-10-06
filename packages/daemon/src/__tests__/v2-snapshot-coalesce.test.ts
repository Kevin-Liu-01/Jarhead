import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@jarhead/protocol";
import { FRAME_JSON, FRAME_SPEAKER, FrameParser, encodeJson } from "../wire.ts";
import * as serverModule from "../server.ts";
import { DaemonServer, type EngineLike } from "../server.ts";

/** The line past which a client keeps one pending snapshot (64 KB as the plan has it; read from the module once it exports it). */
const SNAPSHOT_BACKLOG_BYTES = (serverModule as { SNAPSHOT_BACKLOG_BYTES?: number }).SNAPSHOT_BACKLOG_BYTES ?? 64 * 1024;

/**
 * Voice PLAN W2.3 (cause #6, prove-3): one unix socket carries the speaker's PCM and every JSON
 * frame, and Node queues whatever the kernel will not take. A client that reads slowly (the app
 * decoding a big snapshot, a busy main thread) let 0.29 to 1.49 MB pile up in the daemon, up to
 * five whole snapshots ahead of the next speaker frame. Snapshots are whole states, so only the
 * newest one has to wait: past SNAPSHOT_BACKLOG_BYTES a client keeps one pending snapshot, written
 * on 'drain'. Speaker frames and every other JSON frame are never dropped and keep their order.
 */

class QuietEngine extends EventEmitter {
  ledger: EngineLike["ledger"] = { read: () => [], days: () => [], sessions: () => [], readSession: () => [], search: () => [], readChain: () => ({ rows: [], truncated: false }) };
  memory: EngineLike["memory"] = { list: () => [], search: async () => [] };
  config = { stateDir: "/tmp/jh-v2" };
  userName = "Kevin";
  runner = { run: async () => ({ result: { kind: "text" as const, text: "" } }) };
  runnerFor(): undefined {
    return undefined;
  }
  snapshot(): unknown {
    return { phase: "asleep", seq: 0 };
  }
  async command(): Promise<void> {}
  feedMic(): void {}
  reportInputLevel(): void {}
  setPermission(): void {}
  setPermissions(): void {}
  registerOwnPid(): void {}
  ear(): void {}
  problem(): void {}
  dropViewers(): void {}
}

/** A snapshot of about `bytes` of JSON, numbered so the test can tell which one arrived. */
function bigSnapshot(seq: number, bytes: number): unknown {
  return { phase: "speaking", seq, transcript: [{ text: "x".repeat(bytes) }] };
}

/** A speaker frame: 40 ms of 24 kHz PCM16 whose first four bytes are its sequence number. */
function pcm(seq: number): Buffer {
  const b = Buffer.alloc(1920);
  b.writeUInt32LE(seq, 0);
  return b;
}

interface Rig {
  engine: QuietEngine;
  server: DaemonServer;
  client: Socket;
  /** The server's socket for that client (the one whose backlog is measured). */
  serverSide: () => Socket;
  /** Frames the server handed to its socket, in order: what Node queues for the kernel. */
  written: { kind: "snapshot" | "speaker" | "json"; seq?: number }[];
  received: { kind: "snapshot" | "speaker" | "json"; seq?: number; type?: string }[];
  close: () => Promise<void>;
}

function kindOf(type: number, payload: Buffer): { kind: "snapshot" | "speaker" | "json"; seq?: number; type?: string } {
  if (type === FRAME_SPEAKER) return { kind: "speaker", seq: payload.readUInt32LE(0) };
  if (type !== FRAME_JSON) return { kind: "json" };
  const msg = JSON.parse(payload.toString("utf8")) as { type: string; snapshot?: { seq?: number } };
  if (msg.type === "snapshot") return { kind: "snapshot", seq: msg.snapshot?.seq ?? -1 };
  return { kind: "json", type: msg.type };
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "jh-v2-"));
  const path = join(dir, "d.sock");
  const engine = new QuietEngine();
  const server = new DaemonServer(engine as unknown as EngineLike, path, { appGoneGraceMs: 60_000 });
  await server.listen();
  const clients = (server as unknown as { clients: Set<{ socket: Socket; audio: boolean }> }).clients;
  const written: Rig["written"] = [];
  const received: Rig["received"] = [];
  const parser = new FrameParser();
  const client = createConnection(path);
  client.on("data", (chunk: Buffer) => {
    for (const f of parser.push(chunk)) received.push(kindOf(f.type, f.payload));
  });
  await new Promise<void>((resolve) => client.once("connect", () => resolve()));
  // The app's hello as EngineClient sends it: an app of this build (W3-3), so no `app.version` snapshot joins the count.
  client.write(encodeJson({ type: "hello", pid: process.pid, audio: true, protocol: PROTOCOL_VERSION }));
  // Wait for the server to register the app (audio: true), then watch what it hands its socket.
  for (let i = 0; i < 200 && ![...clients].some((c) => c.audio); i++) await new Promise((r) => setTimeout(r, 5));
  const side = [...clients].find((c) => c.audio)!.socket;
  const write = side.write.bind(side) as (chunk: Buffer, ...rest: unknown[]) => boolean;
  const outParser = new FrameParser();
  (side as unknown as { write: (chunk: Buffer, ...rest: unknown[]) => boolean }).write = (chunk: Buffer, ...rest: unknown[]) => {
    for (const f of outParser.push(chunk)) written.push(kindOf(f.type, f.payload));
    return write(chunk, ...rest);
  };
  return {
    engine,
    server,
    client,
    serverSide: () => side,
    written,
    received,
    close: async () => {
      client.destroy();
      await server.close();
    },
  };
}

const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("v2 coalescing: a client that stops reading holds one pending snapshot, never a queue of them; the newest arrives on drain; every speaker frame arrives in order", async () => {
  const r = await rig();
  try {
    await settle();
    r.client.pause();
    const snapBytes = 290_000;
    let maxBacklog = 0;
    for (let i = 1; i <= 10; i++) {
      r.engine.emit("event", { type: "snapshot", snapshot: bigSnapshot(i, snapBytes) });
      for (let k = 0; k < 4; k++) {
        r.engine.emit("audio", pcm((i - 1) * 4 + k));
        maxBacklog = Math.max(maxBacklog, r.serverSide().writableLength);
      }
    }
    // A toast while backed up: not a snapshot, never dropped or held.
    r.engine.emit("event", { type: "toast", text: "still here", tone: "info" });
    const snapsWritten = r.written.filter((w) => w.kind === "snapshot");
    // Before the pause the accept-time snapshot went out; once the backlog passed the line, at most one more was handed over.
    assert.ok(snapsWritten.length <= 2, `snapshots handed to the socket while it was backed up: ${snapsWritten.map((s) => s.seq).join(", ")}`);
    assert.ok(maxBacklog <= SNAPSHOT_BACKLOG_BYTES + snapBytes + 40 * 2000 + 4096, `backlog ${maxBacklog} B: at most one snapshot past the line plus the speaker frames`);
    assert.equal(r.written.filter((w) => w.kind === "speaker").length, 40, "every speaker frame was written at once");
    assert.ok(r.written.some((w) => w.kind === "json"), "the toast was written at once");

    r.client.resume();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(r.received.filter((x) => x.kind === "speaker").length === 40 && r.received.filter((x) => x.kind === "snapshot").at(-1)?.seq === 10)) await settle(10);
    const speakers = r.received.filter((x) => x.kind === "speaker").map((x) => x.seq);
    assert.deepEqual(speakers, Array.from({ length: 40 }, (_, i) => i), "speaker frames: all forty, in order");
    const snaps = r.received.filter((x) => x.kind === "snapshot").map((x) => x.seq);
    assert.equal(snaps.at(-1), 10, `the newest snapshot arrived last: ${snaps.join(", ")}`);
    assert.ok(snaps.length <= 4, `intermediate snapshots were coalesced: ${snaps.join(", ")}`);
    assert.ok(r.received.some((x) => x.kind === "json" && x.type === "toast"), "the toast arrived");
  } finally {
    await r.close();
  }
});

test("v2 coalescing: a client that keeps up gets every snapshot, in order, nothing held", async () => {
  const r = await rig();
  try {
    await settle();
    for (let i = 1; i <= 6; i++) {
      r.engine.emit("event", { type: "snapshot", snapshot: bigSnapshot(i, 2_000) });
      r.engine.emit("audio", pcm(i));
      await settle(5);
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && r.received.filter((x) => x.kind === "snapshot").at(-1)?.seq !== 6) await settle(10);
    const snaps = r.received.filter((x) => x.kind === "snapshot").map((x) => x.seq);
    // The accept-time snapshot (seq 0), then all six.
    assert.deepEqual(snaps, [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(r.received.filter((x) => x.kind === "speaker").map((x) => x.seq), [1, 2, 3, 4, 5, 6]);
  } finally {
    await r.close();
  }
});

test("v2 coalescing: under a slow reader at 290 KB × 6/s the daemon's backlog stays within one snapshot plus the line, and the reader ends on the latest", async () => {
  const r = await rig();
  try {
    await settle();
    const snapBytes = 290_000;
    // The reader looks in for a moment every 100 ms (an app whose net queue is busy decoding); snapshots come at
    // 6/s, speaker frames every 40 ms. Today the daemon queues every snapshot behind the reader.
    r.client.pause();
    const reader = setInterval(() => {
      r.client.resume();
      setImmediate(() => r.client.pause());
    }, 100);
    let maxBacklog = 0;
    let seqPcm = 0;
    let seqSnap = 0;
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const tick = setInterval(() => {
        const t = Date.now() - t0;
        while (seqPcm * 40 <= t && seqPcm < 50) {
          r.engine.emit("audio", pcm(seqPcm++));
          maxBacklog = Math.max(maxBacklog, r.serverSide().writableLength);
        }
        while (seqSnap * 166 <= t && seqSnap < 12) {
          r.engine.emit("event", { type: "snapshot", snapshot: bigSnapshot(++seqSnap, snapBytes) });
          maxBacklog = Math.max(maxBacklog, r.serverSide().writableLength);
        }
        if (seqPcm >= 50 && seqSnap >= 12) {
          clearInterval(tick);
          resolve();
        }
      }, 5);
    });
    clearInterval(reader);
    r.client.resume();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(r.received.filter((x) => x.kind === "speaker").length === 50 && r.received.filter((x) => x.kind === "snapshot").at(-1)?.seq === 12)) await settle(10);
    console.log(`[measure] v2 slow reader: daemon backlog max ${maxBacklog} B (line ${SNAPSHOT_BACKLOG_BYTES} + one snapshot ${snapBytes}); snapshots written ${r.written.filter((w) => w.kind === "snapshot").length} of 13`);
    assert.ok(maxBacklog <= SNAPSHOT_BACKLOG_BYTES + snapBytes + 50 * 2000 + 4096, `backlog ${maxBacklog} B`);
    assert.deepEqual(r.received.filter((x) => x.kind === "speaker").map((x) => x.seq), Array.from({ length: 50 }, (_, i) => i));
    assert.equal(r.received.filter((x) => x.kind === "snapshot").at(-1)?.seq, 12, "the reader ends on the latest snapshot");
  } finally {
    await r.close();
  }
});
