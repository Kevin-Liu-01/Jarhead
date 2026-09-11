import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveSession, type WebSocketLike } from "../session.ts";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const resource = { id: "live_1", expires_at: 0, model: "gpt-live-1", status: "active" as const };

test("start sends session.start, resolves on session.started, and flushes queued audio", async () => {
  const sock = new FakeSocket();
  const s = new LiveSession({
    apiKey: "k",
    config: { model: "gpt-live-1", delegation: { type: "client" } },
    webSocketFactory: () => sock,
  });
  const started = s.start();
  sock.open();
  assert.equal(JSON.parse(sock.sent[0] ?? "{}").type, "session.start");
  s.appendAudio(Buffer.from([1, 2, 3, 4]));
  assert.equal(sock.sent.length, 1, "audio waits for session.started");
  sock.receive({ type: "session.started", event_id: "e1", session: resource });
  const res = await started;
  assert.equal(res.id, "live_1");
  assert.equal(sock.sent.length, 2);
  assert.equal(JSON.parse(sock.sent[1] ?? "{}").type, "session.input_audio.append");
});

test("server events are dispatched to typed emits", async () => {
  const sock = new FakeSocket();
  const s = new LiveSession({ apiKey: "k", config: { model: "gpt-live-1" }, webSocketFactory: () => sock });
  const p = s.start();
  sock.open();
  sock.receive({ type: "session.started", event_id: "e1", session: resource });
  await p;

  const seen: string[] = [];
  s.on("inputTranscript", (d) => seen.push(`in:${d}`));
  s.on("outputTranscript", (d) => seen.push(`out:${d}`));
  s.on("delegation", (id, target) => seen.push(`deleg:${id}:${target}`));
  s.on("audio", (pcm) => seen.push(`audio:${pcm.length}`));
  s.on("usage", (sec) => seen.push(`usage:${sec}`));
  s.on("appended", (ch, cid) => seen.push(`appended:${ch}:${cid}`));
  s.on("error", (e, cid) => seen.push(`error:${e.message}:${cid}`));
  s.on("closed", (reason) => seen.push(`closed:${reason}`));

  sock.receive({ type: "session.input_transcript.delta", event_id: "a", delta: " hey", start_ms: 0, end_ms: 200 });
  sock.receive({ type: "session.output_transcript.delta", event_id: "b", delta: " on it", start_ms: 500, end_ms: 700 });
  sock.receive({ type: "session.delegation.created", event_id: "c", offset_ms: 400, delegation: { id: "item_1", type: "delegation", target: "client" } });
  sock.receive({ type: "session.output_audio.delta", delta: Buffer.alloc(480).toString("base64") });
  sock.receive({ type: "session.usage.updated", event_id: "d", usage: { seconds: 12.5 } });
  const cid = s.appendCommentary("item_1", "done");
  sock.receive({ type: "session.commentary.appended", event_id: "e", client_event_id: cid, start_ms: 900, end_ms: 900 });
  sock.receive({ type: "error", event_id: "f", error: { type: "invalid_request_error", code: "unknown_parameter", message: "nope", client_event_id: "x" } });
  sock.receive({ type: "session.closed", event_id: "g", reason: "close_requested", session: resource, usage: { seconds: 13 } });

  assert.deepEqual(seen, [
    "in: hey", "out: on it", "deleg:item_1:client", "audio:480", "usage:12.5", `appended:commentary:${cid}`,
    "error:unknown_parameter: nope:x", "closed:close_requested",
  ]);
  assert.equal(s.currentState, "closed");
  assert.equal(s.billedSeconds, 13);
});

test("append events carry the delegation id and a correlatable event id", async () => {
  const sock = new FakeSocket();
  const s = new LiveSession({ apiKey: "k", config: { model: "gpt-live-1" }, webSocketFactory: () => sock });
  const p = s.start();
  sock.open();
  sock.receive({ type: "session.started", event_id: "e1", session: resource });
  await p;
  const id = s.appendThinking("item_9", "checking");
  const frame = JSON.parse(sock.sent.at(-1) ?? "{}") as { type: string; delegation_id: string; event_id: string; content: string };
  assert.equal(frame.type, "session.thinking.append");
  assert.equal(frame.delegation_id, "item_9");
  assert.equal(frame.event_id, id);
  assert.equal(frame.content, "checking");
});

test("a socket that closes before starting rejects start", async () => {
  const sock = new FakeSocket();
  const s = new LiveSession({ apiKey: "k", config: { model: "gpt-live-1" }, webSocketFactory: () => sock });
  const p = s.start();
  sock.open();
  sock.close();
  await assert.rejects(p, /closed before start/);
});
