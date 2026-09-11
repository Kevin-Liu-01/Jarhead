import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession } from "@jarhead/live";
import type { Brain, BrainResult, BrainTask } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import type { EngineEvent } from "@jarhead/protocol";
import { Engine } from "../engine.ts";

/**
 * Stop that stops. Live has no interrupt, so a stop is local: the speaker is
 * flushed and every output frame is dropped for a while (until Kevin speaks or
 * 2.5 s pass), the running delegation is cancelled and the brain's cancel called,
 * a hands request in flight is failed so its late answer never acts, the voice is
 * told, and a toast says "stopped". With nothing running it is harmless.
 */

class FakeLive extends EventEmitter {
  instructions: string[] = [];
  currentState = "idle";
  session: { id: string; expires_at: number } | undefined;
  nowMs = 1000;
  async start(): Promise<{ id: string; expires_at: number }> {
    this.currentState = "started";
    this.session = { id: "sess_1", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return this.session;
  }
  appendInstructions(_id: string | null, content: string): string {
    this.instructions.push(content);
    return "i";
  }
  appendThinking(): string {
    return "t";
  }
  appendCommentary(): string {
    return "c";
  }
  appendAudio(): void {}
  mute(): string {
    return "m";
  }
  unmute(): string {
    return "u";
  }
  createResponseItem(): void {}
  createResponse(): void {}
  close(): void {
    this.currentState = "closed";
    this.emit("closed", "client_closed", 0);
  }
}

/** Hands whose `frontmost` can be held in flight, so a stop can drop it. */
class HeldHands implements NativeHands {
  ready = true;
  hold: (() => void) | undefined;
  ops: string[] = [];
  async request<T>(op: string): Promise<T> {
    this.ops.push(op);
    if (op === "frontmost" && this.hold === undefined) await new Promise<void>((release) => (this.hold = release));
    if (op === "frontmost") return { app: "Finder", pid: 1, window: null } as T;
    if (op === "hello") return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
    throw new Error(`no hands for ${op}`);
  }
}

function world(): { engine: Engine; live: FakeLive; hands: HeldHands; events: EngineEvent[]; audio: Buffer[]; brain: { cancels: number; resolve: ((r: BrainResult) => void) | undefined; tasks: BrainTask[] }; clock: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), "jh-stop-"));
  const config: JarheadConfig = {
    ...readConfig(),
    openaiApiKey: "sk-test-not-used",
    brain: "auto",
    brainModel: "",
    brainBaseUrl: undefined,
    anthropicApiKey: undefined,
    claudeBin: undefined,
    codexBin: undefined,
    handsBin: join(dir, "no-hands"),
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };
  const brainState: { cancels: number; resolve: ((r: BrainResult) => void) | undefined; tasks: BrainTask[] } = { cancels: 0, resolve: undefined, tasks: [] };
  const brain: Brain = {
    kind: "fake",
    start: async () => ({ ready: true, detail: "fake" }),
    handle: (task) =>
      new Promise<BrainResult>((resolve) => {
        brainState.tasks.push(task);
        brainState.resolve = resolve;
        task.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
      }),
    cancel: async () => {
      brainState.cancels++;
    },
    stop: async () => undefined,
  };
  const live = new FakeLive();
  const hands = new HeldHands();
  const clock = { t: 1_757_500_000_000 };
  const engine = new Engine({ config, connectors: [], brain, hands, makeLive: () => live as unknown as LiveSession, now: () => clock.t });
  const events: EngineEvent[] = [];
  const audio: Buffer[] = [];
  engine.on("event", (e) => events.push(e));
  engine.on("audio", (pcm) => audio.push(pcm));
  return { engine, live, hands, events, audio, brain: brainState, clock };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const frame = (): Buffer => Buffer.alloc(480, 7);

test("stop: output audio is dropped for the gate window, the running delegation is cancelled with the brain's cancel called, the hands' pending request is failed, the voice is told, a toast says so", async () => {
  const w = world();
  const { engine, live, hands, events, audio, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");
    assert.equal(engine.currentPhase, "listening");

    // Speech flows: frames reach the speaker, the phase says speaking.
    live.emit("audio", frame());
    live.emit("outputTranscript", "hello there", 1000, 1500);
    assert.equal(audio.length, 1);
    assert.equal(engine.currentPhase, "speaking");

    // A delegation runs; the brain holds it; a click's gate probe is in flight in the hands.
    live.emit("inputTranscript", " find the save button", 1500, 2400);
    live.emit("delegation", "item_1", "client", 2400);
    await settle();
    assert.equal(brain.tasks.length, 1);
    assert.ok(engine.snapshot().delegations[0]?.status === "running");
    // (typing needs no screenshot mapping; its gate asks the helper which app is up — held here.)
    const typing = engine.toolset.run("type", { text: "hello" }).catch(() => ({ kind: "error" as const, message: "threw" }));
    await settle();
    assert.ok(hands.ops.includes("frontmost"), "the gate probe is waiting on the helper");

    // Stop.
    events.length = 0;
    const t0 = Date.now();
    await engine.command({ type: "stop" });
    const took = Date.now() - t0;
    assert.ok(took < 150, `stop returned in ${took}ms`);
    assert.equal(brain.cancels, 1, "the brain's cancel was called");
    assert.equal(engine.snapshot().delegations[0]?.status, "cancelled");
    assert.equal(engine.snapshot().delegations[0]?.summary, "Kevin pressed stop");
    assert.ok(events.some((e) => e.type === "speaker-flush"), "the speaker was flushed");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"), "a toast says stopped");
    assert.deepEqual(live.instructions, ["Kevin pressed stop. Stop speaking now and wait."], "the voice was told once — not also asked to acknowledge");
    assert.equal(engine.outputGated, true);
    assert.notEqual(engine.currentPhase, "speaking", "no longer speaking, whatever the transcript said a moment ago");

    // The typing that was waiting on the helper came back as an error, not an action.
    const outcome = await typing;
    assert.equal(outcome.kind, "error");
    assert.match((outcome as { message: string }).message, /cancelled|stop/);
    assert.ok(!hands.ops.includes("type"), "nothing was typed after the stop");
    hands.hold?.(); // the helper's late answer arrives for an id nobody waits on

    // Frames that arrive after the stop are dropped; the output transcript no longer counts as speaking.
    audio.length = 0;
    for (let i = 0; i < 20; i++) live.emit("audio", frame());
    live.emit("outputTranscript", " and then", 2500, 2700);
    assert.equal(audio.length, 0, "gated frames never reach the speaker");
    assert.notEqual(engine.currentPhase, "speaking");

    // 2.5 s later the gate lapses on its own.
    clock.t += Engine.OUTPUT_GATE_MS + 1;
    assert.equal(engine.outputGated, false);
    live.emit("audio", frame());
    assert.equal(audio.length, 1, "after the window, audio flows again");

    // A second stop and Kevin's voice: the gate ends the moment he speaks.
    await engine.command({ type: "stop" });
    assert.equal(engine.outputGated, true);
    live.emit("audio", frame());
    assert.equal(audio.length, 1, "gated");
    live.emit("inputTranscript", " never mind", 3000, 3400);
    assert.equal(engine.outputGated, false, "Kevin spoke: the gate is lifted");
    live.emit("audio", frame());
    assert.equal(audio.length, 2);
  } finally {
    w.hands.hold?.();
    await engine.stop();
  }
});

test("stop with nothing running is harmless: a flush, a toast, the voice told, no delegation touched", async () => {
  const w = world();
  const { engine, live, events, brain } = w;
  try {
    await engine.start();
    await engine.ready();
    await engine.wake("test");
    events.length = 0;
    await engine.command({ type: "stop" });
    assert.equal(brain.cancels, 0, "no delegation, no brain cancel");
    assert.deepEqual(engine.snapshot().delegations, []);
    assert.ok(events.some((e) => e.type === "speaker-flush"));
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"));
    assert.equal(live.instructions.filter((i) => /Kevin pressed stop/.test(i)).length, 1);
    assert.equal(engine.currentPhase, "listening");
    // Asleep: still harmless.
    await engine.sleep();
    await engine.command({ type: "stop" });
    assert.equal(engine.currentPhase, "asleep");
  } finally {
    await engine.stop();
  }
});

test("a spoken \"stop\" is the same stop: the delegation is cancelled, the brain's cancel called, the pending hands request failed so nothing lands after it, a toast, one instruction, and the gate set by the very words that asked for it", async () => {
  const w = world();
  const { engine, live, hands, events, audio, brain, clock } = w;
  try {
    await engine.start();
    await engine.ready();
    engine.updateSettings({ idleSleepMinutes: 0 });
    await engine.wake("test");

    live.emit("inputTranscript", " jarhead type my address", 1500, 2400);
    live.emit("delegation", "item_1", "client", 2400);
    await settle();
    assert.equal(brain.tasks.length, 1);
    const typing = engine.toolset.run("type", { text: "hello again" }).catch(() => ({ kind: "error" as const, message: "threw" }));
    await settle();
    assert.ok(hands.ops.includes("frontmost"), "the gate probe is waiting on the helper");

    events.length = 0;
    live.instructions.length = 0;
    live.emit("inputTranscript", " stop", 2600, 2900);
    await settle();
    assert.equal(engine.snapshot().delegations[0]?.status, "cancelled");
    assert.equal(engine.snapshot().delegations[0]?.summary, "Kevin said stop");
    assert.equal(brain.cancels, 1, "the brain's cancel was called");
    assert.ok(events.some((e) => e.type === "speaker-flush"), "the speaker was flushed");
    assert.ok(events.some((e) => e.type === "toast" && e.text === "stopped"), "a toast says stopped");
    assert.deepEqual(live.instructions, ["Kevin said stop. Stop speaking now and wait."], "one instruction, for the whole stop");
    assert.equal(engine.outputGated, true, "the gate is set — the 'stop' fragment itself does not lift it");
    const outcome = await typing;
    assert.equal(outcome.kind, "error", "the typing that was waiting on the helper came back as an error");
    hands.hold?.();
    await settle();
    assert.ok(!hands.ops.includes("type"), "nothing was typed after the spoken stop");

    // The voice's sentence in flight is dropped; Kevin's next words lift the gate.
    audio.length = 0;
    live.emit("audio", frame());
    assert.equal(audio.length, 0);
    live.emit("inputTranscript", " ok now open safari", 3500, 4200);
    assert.equal(engine.outputGated, false);
    live.emit("audio", frame());
    assert.equal(audio.length, 1);
    clock.t += 10;
  } finally {
    w.hands.hold?.();
    await engine.stop();
  }
});
