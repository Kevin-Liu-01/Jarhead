import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession } from "@jarhead/live";
import type { Brain, BrainResult, BrainSink, BrainTask, DelegationTimingsExtra, ToolRunner } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import { Engine } from "@jarhead/engine";
import type { Delegation } from "@jarhead/protocol";

/**
 * `pnpm jarhead bench` — the tool path measured, not asserted (REDESIGN §11).
 *
 * Drives a real Engine with a stand-in Live session (no socket, no billing) and
 * either a stand-in brain (default: it calls frontmost_app, a quick screenshot and
 * one harmless mouse_move to where the pointer already is) or the real Codex
 * brain (`--codex`: one tiny turn on Kevin's ChatGPT login). The hands are the
 * built Swift helper when it is there, or a fake (`--fake-hands`). Measures:
 *
 *   tool round trip          runner.run("frontmost_app") through the helper
 *   quick screenshot         runner.run("screenshot", { quick: true }), 1280-px long edge
 *   eyes (pre-warm shot)     the delegator's own shot at delegation time
 *   delegation → first tool  the brain's first tool step (the eyes' shot excluded)
 *   delegation → first action the first member that moves or types
 *   delegation → done
 *   reflex                   "jarhead, screenshot this.": utterance end → the reflex's tool is ISSUED to
 *                            the helper (prefired: the quiet window plus Jarhead's own path — what
 *                            Jarhead controls), and tool issued → done (the shot itself)
 *   stop                     stopEverything() wall time with a delegation the brain is holding
 *
 * and prints one table with medians, p90 and the targets. The numbers depend on
 * the machine's load and on what is on the display (a busy 1280-px shot is an
 * 800 KB PNG); the header prints the load average so a run can be read in context.
 */

interface Sample {
  readonly metric: string;
  readonly ms: number;
}

class FakeLive extends EventEmitter {
  currentState = "idle";
  session: { id: string; expires_at: number } | undefined;
  nowMs = 0;
  private startedWall = 0;
  async start(): Promise<{ id: string; expires_at: number }> {
    this.currentState = "started";
    this.startedWall = Date.now();
    this.session = { id: "bench", expires_at: Math.floor(Date.now() / 1000) + 3600 };
    return this.session;
  }
  /** Session time. Each utterance the bench feeds is spaced well past the transcript's merge gap, so runs stay separate utterances. */
  private skew = 0;
  tick(): number {
    this.nowMs = Date.now() - this.startedWall + this.skew;
    return this.nowMs;
  }
  nextUtterance(): number {
    this.skew += 3000;
    return this.tick();
  }
  appendInstructions(): string {
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

/** A 1×1 PNG, so the fake screenshot is a real image. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

/** Hands that answer at once; the bench then measures Jarhead's own path, not macOS. */
class FakeHands implements NativeHands {
  ready = true;
  async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    switch (op) {
      case "hello":
        return { version: "fake", pid: 1, permissions: { accessibility: true, screenRecording: true } } as T;
      case "screenshot":
        return { displayId: 1, pngBase64: PNG_1X1, width: Number(params["maxLongEdge"] ?? 1280), height: 720, points: { x: 0, y: 0, w: 1728, h: 1117 }, scale: Number(params["maxLongEdge"] ?? 1280) / 1728 } as T;
      case "zoom":
        return { displayId: 1, pngBase64: PNG_1X1, width: 100, height: 100, points: { x: 0, y: 0, w: 50, h: 50 }, scale: 2 } as T;
      case "frontmost":
        return { app: "Finder", pid: 1, window: { title: "Desktop", x: 0, y: 0, w: 800, h: 600, windowId: 1 } } as T;
      case "cursor":
        return { x: 400, y: 300 } as T;
      case "windows":
        return { windows: [] } as T;
      case "element_at":
        return { role: "AXGroup" } as T;
      case "focused_text":
        return { role: "AXTextField", secure: false } as T;
      default:
        return {} as T;
    }
  }
}

/**
 * The stand-in brain: what a good model does on "what's in front and where is the
 * pointer" — one look, one quick shot, one harmless action (moving the pointer to
 * where it already is), one sentence. With `hold` set it looks once and then waits
 * for the task's signal, so a stop has a running delegation to end.
 */
function fakeBrain(getRunner: () => ToolRunner, state: { hold: boolean; held: (() => void) | undefined }): Brain {
  return {
    kind: "bench-fake",
    start: async () => ({ ready: true, detail: "bench stand-in" }),
    handle: async (task: BrainTask, sink: BrainSink): Promise<BrainResult> => {
      const runner = getRunner();
      runner.attach(sink, task);
      try {
        const front = await runner.run("frontmost_app", {});
        if (task.signal.aborted) return { status: "cancelled" };
        if (state.hold) {
          state.held?.();
          await new Promise<void>((r) => task.signal.addEventListener("abort", () => r(), { once: true }));
          return { status: "cancelled" };
        }
        // The eyes already handed a screen in; a real brain would act on it. This one
        // takes its own quick shot too, so the shot's cost shows in the timeline.
        if (!task.attachments?.some((a) => a.kind === "screen")) await runner.run("screenshot", { quick: true });
        const cursor = await runner.run("cursor_position", {});
        if (task.signal.aborted) return { status: "cancelled" };
        const m = cursor.result.kind === "text" ? /X=(-?\d+), Y=(-?\d+)/.exec(cursor.result.text) : null;
        if (m) await runner.run("mouse_move", { coordinate: [Number(m[1]), Number(m[2])] });
        const app = front.result.kind === "text" ? (JSON.parse(front.result.text) as { app?: string }).app : undefined;
        return { status: "done", summary: `${app ?? "something"} is in front.` };
      } finally {
        runner.attach(undefined);
      }
    },
    cancel: async () => undefined,
    stop: async () => undefined,
  };
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? Number.NaN;
}

export interface BenchOptions {
  readonly runs: number;
  readonly codex: boolean;
  readonly fakeHands: boolean;
  readonly json: boolean;
}

export async function bench(opts: BenchOptions): Promise<void> {
  const base = readConfig();
  const dir = mkdtempSync(join(tmpdir(), "jh-bench-"));
  const useFakeHands = opts.fakeHands || !existsSync(base.handsBin);
  const config: JarheadConfig = {
    ...base,
    openaiApiKey: base.openaiApiKey || "sk-bench-never-used",
    brain: opts.codex ? "codex" : "auto",
    stateDir: join(dir, "state"),
    socketPath: join(dir, "state", "j.sock"),
  };
  const live = new FakeLive();
  let engine: Engine;
  const brainState: { hold: boolean; held: (() => void) | undefined } = { hold: false, held: undefined };
  const brain = opts.codex ? undefined : fakeBrain(() => engine.runner, brainState);
  engine = new Engine({ config, connectors: [], ...(brain ? { brain } : {}), makeLive: () => live as unknown as LiveSession, ...(useFakeHands ? { hands: new FakeHands() } : {}) });
  const samples: Sample[] = [];
  const add = (metric: string, ms: number): void => {
    if (Number.isFinite(ms)) samples.push({ metric, ms: Math.round(ms * 10) / 10 });
  };
  const log = (line: string): void => {
    if (!opts.json) console.log(line);
  };

  const load = loadavg().map((v) => v.toFixed(1)).join(" ");
  log(`\n  bench: ${opts.runs} run(s); hands: ${useFakeHands ? "fake (in-process)" : `Swift helper at ${base.handsBin}`}; brain: ${opts.codex ? "real Codex (one tiny turn per run — this uses Kevin's ChatGPT login)" : "stand-in"}; load average ${load}`);
  const t0 = Date.now();
  await engine.start();
  await engine.ready();
  log(`  engine ready in ${Date.now() - t0} ms; brain: ${engine.brainInfo.kind} — ${engine.brainInfo.detail}`);
  if (opts.codex && engine.brainInfo.kind !== "codex") {
    console.error(`  Codex is not available (${engine.brainInfo.detail}); run without --codex for the stand-in`);
    await engine.stop();
    process.exit(1);
  }
  engine.updateSettings({ idleSleepMinutes: 0 });
  await engine.wake("bench");

  try {
    // Tool round trips through the whole path (runner → toolset → helper), warm.
    await engine.runner.run("frontmost_app", {});
    for (let i = 0; i < opts.runs; i++) {
      const a = performance.now();
      await engine.runner.run("frontmost_app", {});
      add("tool round trip (frontmost_app)", performance.now() - a);
      const b = performance.now();
      const shot = await engine.runner.run("screenshot", { quick: true });
      add("quick screenshot (1280 px)", performance.now() - b);
      if (i === 0 && shot.result.kind === "image") log(`  quick screenshot: ${shot.result.width}x${shot.result.height} px, ${Math.round((shot.result.pngBase64.length * 3) / 4 / 1024)} KB PNG`);
      if (i === 0 && !useFakeHands) {
        const c = performance.now();
        await engine.runner.run("screenshot", {});
        add("full screenshot (2000 px)", performance.now() - c);
      }
    }

    // Delegations: the eyes' shot, the brain's first tool, the first action, done.
    const request = opts.codex ? "jarhead what app is in front right now" : "jarhead what is in front and where is my pointer";
    const runs = opts.codex ? Math.min(opts.runs, 2) : opts.runs;
    for (let i = 0; i < runs; i++) {
      const finished = new Promise<Delegation>((resolve) => {
        const onEvent = (e: { type: string; snapshot?: { delegations: readonly Delegation[] } }): void => {
          if (e.type !== "snapshot") return;
          const d = e.snapshot?.delegations.find((x) => x.liveId === `bench_${i}`);
          if (d && d.status !== "running") {
            engine.off("event", onEvent as never);
            resolve(d);
          }
        };
        engine.on("event", onEvent as never);
      });
      const now = live.nextUtterance();
      live.emit("inputTranscript", ` ${request}`, now - 900, now);
      live.emit("delegation", `bench_${i}`, "client", now);
      const d = await Promise.race([finished, new Promise<undefined>((r) => setTimeout(() => r(undefined), opts.codex ? 120_000 : 15_000))]);
      if (!d) {
        log(`  run ${i}: delegation did not finish in time`);
        continue;
      }
      const t = d.timings as DelegationTimingsExtra;
      const rel = (v: number | undefined): number => (v === undefined ? Number.NaN : v - t.delegatedAt);
      add("eyes: pre-warm shot", t.eyesMs ?? Number.NaN);
      add("delegation → first tool", rel(t.firstToolAt));
      add("delegation → first action", rel(t.firstActionAt));
      add("delegation → first commentary", rel(t.firstCommentaryAt));
      add("delegation → done", rel(t.doneAt));
      if (t.toolRoundTripMs) for (const ms of t.toolRoundTripMs) add("tool round trip (in delegation)", ms);
      log(`  run ${i}: ${d.status} in ${rel(t.doneAt)} ms — eyes ${t.eyesMs ?? "-"} ms, first tool @${rel(t.firstToolAt)}, first action @${rel(t.firstActionAt)}, said @${rel(t.firstCommentaryAt)}${d.summary ? ` — "${d.summary.slice(0, 80)}"` : ""}`);
      await new Promise((r) => setTimeout(r, 50));
    }

    // Reflex: "jarhead, screenshot this." settles (the transcriber closed the sentence: the
    // short quiet window applies), fires ahead of the delegation; the delegation adopts the
    // record and only speaks. The moment the helper is asked for the shot is what Jarhead
    // controls; the shot's own duration is the display's.
    {
      const hands = engine.hands as unknown as { request: (op: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown> };
      const original = hands.request.bind(engine.hands);
      let issuedAt = Number.NaN;
      hands.request = (op, params, timeoutMs) => {
        if (op === "screenshot" && Number.isNaN(issuedAt)) issuedAt = performance.now();
        return original(op, params, timeoutMs);
      };
      try {
        for (let i = 0; i < opts.runs; i++) {
          issuedAt = Number.NaN;
          const fired = new Promise<number>((resolve) => engine.once("reflex", (_label, _ms, prefired) => resolve(prefired ? performance.now() : Number.NaN)));
          const now = live.nextUtterance();
          const end = performance.now();
          live.emit("inputTranscript", " jarhead, screenshot this.", now - 700, now);
          const at = await Promise.race([fired, new Promise<number>((r) => setTimeout(() => r(Number.NaN), 3000))]);
          add("reflex: utterance end → tool issued (prefired)", issuedAt - end);
          add("reflex: tool issued → done", at - issuedAt);
          add("reflex: utterance end → done (prefired)", at - end);
          // Live delegates a moment later; the delegation adopts the record and speaks.
          const doneAt = new Promise<number>((resolve) => {
            const onEvent = (e: { type: string; snapshot?: { delegations: readonly Delegation[] } }): void => {
              if (e.type !== "snapshot") return;
              const d = e.snapshot?.delegations.find((x) => x.liveId === `reflex_${i}`);
              if (d && d.status !== "running") {
                engine.off("event", onEvent as never);
                resolve(performance.now());
              }
            };
            engine.on("event", onEvent as never);
          });
          const dAt = performance.now();
          live.emit("delegation", `reflex_${i}`, "client", live.tick());
          const finishedAt = await Promise.race([doneAt, new Promise<number>((r) => setTimeout(() => r(Number.NaN), 3000))]);
          add("reflex: delegation → done (adopted; includes the 50 ms snapshot tick)", finishedAt - dAt);
          await new Promise((r) => setTimeout(r, 30));
        }
      } finally {
        hands.request = original;
      }
    }

    // Stop: with a delegation the brain is holding (it looked once and is waiting), how
    // long until everything perceptible has ended. The run log names the cancelled delegation.
    if (!opts.codex) {
      brainState.hold = true;
      for (let i = 0; i < opts.runs; i++) {
        const held = new Promise<void>((r) => (brainState.held = r));
        const now = live.nextUtterance();
        live.emit("inputTranscript", " jarhead what is in front", now - 800, now);
        live.emit("delegation", `stop_${i}`, "client", now);
        await Promise.race([held, new Promise((r) => setTimeout(r, 3000))]);
        const running = engine.snapshot().delegations.find((d) => d.liveId === `stop_${i}`)?.status === "running";
        const a = performance.now();
        await engine.command({ type: "stop" });
        add("stop: command → everything stopped", performance.now() - a);
        if (i === 0) log(`  stop: the delegation was ${running ? "running (the brain held it)" : "NOT running"} when the stop arrived`);
        // Kevin speaks: the gate lifts so the next run's speech is not muted.
        live.emit("inputTranscript", " ok", live.tick() - 100, live.tick());
        await new Promise((r) => setTimeout(r, 30));
      }
      brainState.hold = false;
    }
  } finally {
    await Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 8000))]);
  }

  // The table.
  const targets: Record<string, number> = {
    "tool round trip (frontmost_app)": 80,
    "tool round trip (in delegation)": 80,
    "quick screenshot (1280 px)": 120,
    "eyes: pre-warm shot": 120,
    "delegation → first action": opts.codex ? 1200 : 300,
    "reflex: utterance end → tool issued (prefired)": 300,
    "stop: command → everything stopped": 150,
  };
  const metrics = [...new Set(samples.map((s) => s.metric))];
  const rows = metrics.map((metric) => {
    const values = samples.filter((s) => s.metric === metric).map((s) => s.ms);
    const median = percentile(values, 50);
    const target = targets[metric];
    return { metric, n: values.length, median, p90: percentile(values, 90), max: Math.max(...values), target, pass: target === undefined ? undefined : median <= target };
  });
  if (opts.json) {
    console.log(JSON.stringify({ hands: useFakeHands ? "fake" : "helper", brain: opts.codex ? engine.brainInfo.detail : "stand-in", rows }, null, 2));
    return;
  }
  const pad = (s: string, n: number): string => s.padEnd(n);
  const num = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : "-").padStart(7);
  console.log(`\n  ${pad("metric", 44)}${"n".padStart(4)}${"median".padStart(8)}${"p90".padStart(8)}${"max".padStart(8)}${"target".padStart(8)}  result`);
  for (const r of rows) {
    console.log(`  ${pad(r.metric, 44)}${String(r.n).padStart(4)}${num(r.median)} ${num(r.p90)} ${num(r.max)} ${r.target === undefined ? "       -" : num(r.target)}  ${r.pass === undefined ? "" : r.pass ? "ok" : "MISS"}`);
  }
  console.log(`\n  hands: ${useFakeHands ? "fake" : "Swift helper"}; brain: ${opts.codex ? engine.brainInfo.detail : "stand-in"}; load average ${load}; state dir ${dir}\n`);
}
