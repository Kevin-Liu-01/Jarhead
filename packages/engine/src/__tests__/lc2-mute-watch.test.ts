import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveSession, type SessionConfig, type WebSocketLike } from "@jarhead/live";
import type { EngineEvent, LedgerRow } from "@jarhead/protocol";
import { Engine } from "../engine.ts";
import { rows, settle, until, world } from "./world.ts";

/**
 * LC-2 (live, 2026-10-06, lc-2-meter-001659-458): Mute must not drop the session (VS-8, LG-19).
 *
 * GPT-Live-1 streams output audio continuously only while the mic is open. The live run muted at 8665 ms, the server
 * acked 40 ms later (8705), the last output delta came at 12031 (3.37 s after the mute), one 15 s usage beat at 15326,
 * and nothing after. At HEAD the V3 frame watch (LIVE_SILENCE_MS) read that quiet as a dead socket: session.closed
 * live_1 connection_lost (usageSeconds 11) about 12 s into the mute, a toast, a reconnect, and the turn cut.
 *
 * Replayed here on a real LiveSession over a fake socket, on the engine's own clock, ticking once a second as the
 * daemon does.
 */

type ClosedRow = Extract<LedgerRow, { type: "session.closed" }>;
type StartedRow = Extract<LedgerRow, { type: "session.started" }>;

const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = true;
    this.onclose?.({ code: 1000, reason: "" });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** The client events sent, by type. */
  types(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  }
}

const resource = (id: string) => ({ id, expires_at: Math.floor(Date.now() / 1000) + 3600, model: "gpt-live-1", status: "active" as const });
/** 100 ms of PCM16 at 24 kHz, as Live's deltas: silence between sentences is a frame too. */
const delta = { type: "session.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") };
const toasts = (events: EngineEvent[]): string[] => events.filter((e): e is Extract<EngineEvent, { type: "toast" }> => e.type === "toast").map((e) => e.text);

/** The live run's frame pattern from the mute on, in ms after the mute. */
const MUTE_ACK_MS = 40;
const OUTPUT_STOPS_MS = 3400;
const USAGE_BEAT_MS = 6661;
const MUTED_MS = 20_000;
const STEP_MS = 100;

test("LC-2: a 20 s mute keeps the one session and its socket; after the unmute the V3 watch is back and a silent socket is still dropped and reconnected once", async () => {
  const socks: FakeSocket[] = [];
  const makeLive = (config: SessionConfig): LiveSession => {
    const sock = new FakeSocket();
    socks.push(sock);
    return new LiveSession({ apiKey: "k", config, webSocketFactory: () => sock });
  };
  const w = world({ makeLive });
  const { engine, clock, events } = w;
  /** Move the engine's clock in STEP_MS steps for `ms`, ticking once a second; `frame(at)` says what the server sends at each step. */
  const run = async (ms: number, frame: (at: number) => void): Promise<void> => {
    for (let at = STEP_MS; at <= ms; at += STEP_MS) {
      clock.t += STEP_MS;
      frame(at);
      if (at % 1000 === 0) tick(engine);
    }
    await settle(5);
  };
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 10 });
    const waking = engine.wake("test");
    await until(() => socks.length === 1);
    socks[0]!.open();
    socks[0]!.receive({ type: "session.started", event_id: "e1", session: resource("live_1") });
    await waking;
    assert.equal(engine.currentPhase, "listening");

    // 8 s unmuted: output audio streams (10 deltas a second) and the mic is fed.
    await run(8000, (at) => {
      socks[0]!.receive(delta);
      if (at % 1000 === 0) engine.feedMic(Buffer.alloc(1920, 1));
    });

    // Mute: the ack 40 ms later, output deltas for 3.4 s, one usage beat, then nothing for the rest of the 20 s.
    engine.setMuted(true);
    assert.ok(socks[0]!.types().includes("session.input_audio.mute"), "the mute went to the server");
    assert.equal(engine.currentPhase, "muted");
    await run(MUTED_MS, (at) => {
      if (at === Math.ceil(MUTE_ACK_MS / STEP_MS) * STEP_MS) socks[0]!.receive({ type: "session.input_audio.muted", event_id: "m1" });
      if (at <= OUTPUT_STOPS_MS) socks[0]!.receive(delta);
      if (at === Math.round(USAGE_BEAT_MS / STEP_MS) * STEP_MS) socks[0]!.receive({ type: "session.usage.updated", event_id: "u1", usage: { seconds: 11 } });
      // Dropped while muted, as the app's mic is.
      if (at % 1000 === 0) engine.feedMic(Buffer.alloc(1920, 1));
    });

    // (1) One session, one socket, nothing lost.
    const closedMuted = rows<ClosedRow>(w, "session.closed");
    assert.deepEqual(closedMuted.map((r) => [r.sessionId, r.reason, r.usageSeconds]), [], "the muted session was dropped");
    assert.equal(socks.length, 1, "no second socket");
    assert.equal(socks[0]!.closed, false, "the socket is open");
    assert.equal(engine.snapshot().session?.id, "live_1", "the same session");
    assert.equal(engine.currentPhase, "muted");
    assert.ok(!toasts(events).includes("connection lost; reconnecting"), `toasts: ${JSON.stringify(toasts(events))}`);
    assert.equal(engine.snapshot().problems.some((p) => p.kind === "voice.connection"), false, "no voice.connection problem");

    // (2) Unmute: the watch starts over at the first tick after it. A socket that stays silent from here is dead.
    engine.setMuted(false);
    assert.ok(socks[0]!.types().includes("session.input_audio.unmute"), "the unmute went to the server");
    socks[0]!.receive({ type: "session.input_audio.unmuted", event_id: "m2" });
    let droppedAfterMs = 0;
    for (let at = 1000; at <= 30_000 && !socks[0]!.closed; at += 1000) {
      clock.t += 1000;
      tick(engine);
      droppedAfterMs = at;
    }
    assert.ok(socks[0]!.closed, "a socket silent after the unmute was never noticed");
    assert.ok(droppedAfterMs <= Engine.LIVE_SILENCE_MS + 1000, `dropped ${droppedAfterMs} ms after the unmute, over ${Engine.LIVE_SILENCE_MS + 1000}`);
    assert.deepEqual(rows<ClosedRow>(w, "session.closed").map((r) => [r.sessionId, r.reason]), [["live_1", "connection_lost"]]);
    assert.ok(toasts(events).includes("connection lost; reconnecting"));

    // One new session carries the conversation on.
    assert.ok(await until(() => socks.length === 2, 3000), "no reconnect after the real drop");
    socks[1]!.open();
    socks[1]!.receive({ type: "session.started", event_id: "e2", session: resource("live_2") });
    assert.ok(await until(() => engine.snapshot().session?.id === "live_2", 2000), "the reconnect did not start");
    await settle(600);
    assert.equal(socks.length, 2, "exactly one new socket");
    assert.deepEqual(rows<StartedRow>(w, "session.started").map((r) => [r.sessionId, r.resumedFrom]), [["live_1", undefined], ["live_2", "live_1"]]);
  } finally {
    await engine.stop();
  }
});
