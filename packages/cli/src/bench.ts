import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, readConfig, type JarheadConfig } from "@jarhead/core";
import type { LiveSession } from "@jarhead/live";
import { parseReflex, type Brain, type BrainResult, type BrainSink, type BrainTask, type DelegationTimingsExtra, type ToolRunner } from "@jarhead/brain";
import type { NativeHands } from "@jarhead/hands";
import { Engine, type EngineOptions } from "@jarhead/engine";
import { THREAD_TERMINAL, type Delegation, type Snapshot } from "@jarhead/protocol";

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
 *   quick screenshot         runner.run("screenshot", { quick: true }), the quick budget (2000-px long edge, 1.1 MP)
 *   eyes (pre-warm shot)     the delegator's own shot at delegation time
 *   delegation → first tool  the brain's first tool step (the eyes' shot excluded)
 *   delegation → first action the first member that moves or types
 *   delegation → done
 *   reflex                   "jarhead, screenshot this.": utterance end → the reflex's tool is ISSUED to
 *                            the helper (prefired: the quiet window plus Jarhead's own path — what
 *                            Jarhead controls), and tool issued → done (the shot itself)
 *   ear                      the 250 ms path (REDESIGN §12): synthetic on-device partials for ten grammar
 *                            phrases → the moment the acting op is issued to the helper (dispatch) and the
 *                            moment it answers (ack), as a partial (the 120 ms stability window applies)
 *                            and as a final (immediate). With the real helper the acting ops are redirected
 *                            to a harmless cursor read so the bench never scrolls or types on Kevin's Mac;
 *                            the round trip is still the real one. p95 to dispatch over 250 ms with the
 *                            real helper fails the bench (exit 1) unless --no-gate.
 *   browser                  the helper's Apple-event path to a running browser (url, tabs), reads only
 *   stop                     the interrupt command's wall time with a delegation the brain is holding
 *   read during a type       a frontmost_app through the runner while the ACTING helper is held for 1.5 s
 *                            (a `wait` on it stands in for a long `type`): with the reads on their own
 *                            helper (SplitHands) it answers in milliseconds; on one serial helper it waits
 *                            the whole hold. Target 20 ms.
 *   acting call incl. observation   a harmless mouse_move to where the pointer is, with the observation
 *                            line's settle and probes when Settings.observe is on; how many results carry
 *                            a `now:` line is printed (target ≥ 95 %). Target p95 350 ms.
 *   status reflex            with two stand-in threads live, "what is spotify doing" as a delegation:
 *                            ms to the spoken status line, and how many brain generations it cost — a
 *                            (count) row, the same columns as tallies, never read as ms (target 0: the
 *                            table answers, the running turn is untouched).
 *   targeted stop            thread.stop for one of the two: ms until only that one is stopped and the
 *                            other is still live.
 *   barge-in → duck          the Mac app's speaker duck (apps/mac AudioEngine.swift `BargeInDuck`), measured by
 *                            the Swift duck probe (apps/mac/Scripts/duck-probe.sh) on synthetic 100 ms tap
 *                            buffers: speech onset (the first hot 10 ms slice's capture time) → the player's
 *                            gain at −20 dB; then the restores — a cough (or a partial made of Jarhead's own
 *                            words) back at 700 ms, a confirmed barge-in back once Kevin stops, and speech
 *                            nobody confirmed held to 1.5 s while the mic stays hot. Live's transcript is
 *                            modelled (+900 ms from onset; DUCK_PROBE_LIVE_MS), not measured: no session is
 *                            opened. Not on this engine's path; in the table so the human-feel numbers sit
 *                            together. A note, not a MISS, when the probe cannot be built here.
 *
 * and prints one table with medians, p90 and the targets. The numbers depend on
 * the machine's load and on what is on the display (a busy 1280-px shot is an
 * 800 KB PNG); the header prints the load average so a run can be read in context.
 */

/** One measurement. `unit` is "ms" for every timing row; a "count" row (brain generations spent) is a tally, never read as a latency. */
interface Sample {
  readonly metric: string;
  readonly value: number;
  readonly unit: SampleUnit;
}
export type SampleUnit = "ms" | "count";

/** One line of the table / the `--json` rows: the percentiles of a metric's samples and its verdict against the target. */
export interface BenchRow {
  readonly metric: string;
  readonly unit: SampleUnit;
  readonly n: number;
  readonly median: number;
  readonly p90: number;
  readonly p95: number;
  readonly max: number;
  readonly target: number | undefined;
  readonly pass: boolean | undefined;
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
  /** Jarhead's spoken lines, with the wall clock they landed (the status reflex row reads them). */
  commentary: { at: number; text: string }[] = [];
  appendCommentary(_id: string | null, content: string): string {
    this.commentary.push({ at: performance.now(), text: content });
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

/**
 * Hands that answer at once; the bench then measures Jarhead's own path, not macOS. SERIAL,
 * like the Swift helper (one op at a time, in arrival order), so a `wait` holds everything
 * queued behind it on the same process — the situation SplitHands exists to route around.
 */
class FakeHands implements NativeHands {
  ready = true;
  private tail: Promise<unknown> = Promise.resolve();
  request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const run = this.tail.then(() => this.answer<T>(op, params));
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async answer<T>(op: string, params: Record<string, unknown>): Promise<T> {
    switch (op) {
      case "wait":
        await new Promise((r) => setTimeout(r, Math.min(10_000, Number(params["ms"] ?? 0))));
        return {} as T;
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
      case "ax_tree":
        return { app: "Finder", pid: 1, window: "Desktop", count: 12, cached: true, ageMs: 1, treeMs: 2, truncated: false } as T;
      case "find_element": {
        const name = String(params["name"] ?? "").toLowerCase();
        const hit = name === "save";
        return { app: "Finder", window: "Desktop", found: hit, unique: hit, candidates: hit ? 1 : 0, tier: hit ? "exact" : "none", ...(hit ? { element: { i: 3, depth: 2, role: "AXButton", title: "Save", app: "Finder", score: 1, label: "Save", x: 100, y: 100, w: 60, h: 24, center: { x: 130, y: 112 }, pressable: true } } : {}), cached: true, treeMs: 2, nodes: 12, truncated: false, ms: 1 } as T;
      }
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
interface BrainState {
  hold: boolean;
  held: (() => void) | undefined;
  /** "split": start two threads (Slack, Spotify) and end the turn; "answer": one sentence, no tool — a stand-in for the model answering a status question. */
  mode: "act" | "split" | "answer";
  /** Every handle() is one model generation. */
  generations: number;
  /** What `thread_start` answered, for the log. */
  splitResults: string[];
}

function fakeBrain(getRunner: () => ToolRunner, state: BrainState): Brain {
  return {
    kind: "bench-fake",
    start: async () => ({ ready: true, detail: "bench stand-in" }),
    handle: async (task: BrainTask, sink: BrainSink): Promise<BrainResult> => {
      state.generations++;
      const runner = getRunner();
      runner.attach(sink, task);
      try {
        if (state.mode === "answer") return { status: "done", summary: "Spotify is playing." };
        if (state.mode === "split") {
          // One generation ends in one batch of two thread starts (the addendum's rule), then the turn ends.
          for (const [name, taskText] of [["Slack", "tell Ben I'm late"], ["Spotify", "play Focus"]] as const) {
            const r = await runner.run("thread_start", { name, task: taskText, lane: "background" });
            const text = r.result.kind === "text" ? r.result.text : r.result.kind === "error" ? r.result.message : r.result.kind;
            state.splitResults.push(`${name}: ${text.slice(0, 120)}`);
          }
          return { status: "done", summary: "Slack and Spotify alongside." };
        }
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

/** What the Swift duck probe prints as its last line (`--json`). */
interface DuckProbeReport {
  readonly samples?: readonly number[];
  readonly unconfirmedRestoreMs?: readonly number[];
  readonly confirmedReleaseMs?: readonly number[];
  /** Kevin's last word → unity, for a confirmed barge-in (the quiet hold, the poll, the ramp). */
  readonly speechEndToUnityMs?: readonly number[];
  /** Duck → unity when nothing confirmed but the mic stayed hot (held to 1.5 s, then the ramp). */
  readonly heldRestoreMs?: readonly number[];
  /** Duck → Live's (modelled) transcript confirming; duck → the ear's words confirming. */
  readonly liveConfirmMs?: readonly number[];
  readonly earConfirmMs?: readonly number[];
  readonly refusedEchoPartials?: number;
  readonly liveModelledMs?: number;
  readonly ranked?: readonly string[];
}

export const DUCK_TARGET_MS = 170;
export const DUCK_RELEASE_TARGET_MS = 750;

/**
 * Run apps/mac/Scripts/duck-probe.sh (builds the probe when its sources are newer than the
 * binary, then runs it) and read its JSON line: onset → −20 dB samples, the restore
 * timings, and this Mac's microphone ranking (read-only). Never throws; a probe that cannot
 * run comes back as a note.
 */
export async function runDuckProbe(runs: number, timeoutMs = 180_000): Promise<{ report: DuckProbeReport; note?: string }> {
  if (process.platform !== "darwin") return { report: {}, note: "not measured: the duck lives in the Mac app (macOS only)" };
  const script = join(REPO_ROOT, "apps", "mac", "Scripts", "duck-probe.sh");
  if (!existsSync(script)) return { report: {}, note: `not measured: ${script} is missing` };
  return new Promise((resolve) => {
    const child = spawn("bash", [script, "--json"], { env: { ...process.env, DUCK_PROBE_RUNS: String(runs) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ report: {}, note: `not measured: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").reverse().find((l) => l.startsWith("{"));
      const tail = (err.trim() || out.trim()).split("\n").slice(-2).join(" · ").slice(0, 240);
      if (code !== 0 || !line) return resolve({ report: {}, note: `not measured: duck probe exited ${code ?? "by signal"} (${tail})` });
      try {
        resolve({ report: JSON.parse(line) as DuckProbeReport });
      } catch {
        resolve({ report: {}, note: `not measured: unreadable probe output (${tail})` });
      }
    });
  });
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
  /** Exit non-zero when the ear's p95 to dispatch is over 250 ms with the real helper (default true). */
  readonly gate?: boolean;
  /** Run the Mac app's duck probe (builds and runs a Swift harness; default true). A test turns it off. */
  readonly duck?: boolean;
  /** Where the lines go (default console.log); a test captures them. */
  readonly print?: (line: string) => void;
}

/** What `bench()` measured, for a caller that does not read the printed table (the smoke test). */
export interface BenchResult {
  readonly ok: boolean;
  readonly rows: readonly BenchRow[];
  readonly extras: Readonly<Record<string, unknown>>;
}

/**
 * The grammar phrases the ear section feeds; each is one acting op through the gated
 * toolset — except the two search phrases, a batch (focus / the search field or the
 * app's shortcut / select all / type / Return) whose dispatch is its first acting op.
 * They name Finder so the stand-in hands (Finder in front, no "search" field in its
 * tree) take the ⌘F shortcut path, and the real helper's redirect (an acting op
 * becomes a cursor read) keeps Finder unfocused and nothing typed.
 */
export const EAR_PHRASES: readonly string[] = ["scroll down", "scroll up a bit", "scroll to the top", "page down", "press enter", "press escape", "select all", "copy", "undo", "zoom in", "search finder for readme", "look up readme in finder"];
/** Acting helper ops the bench redirects to a harmless cursor read on the real helper. */
const ACTING_OPS = new Set(["scroll", "key", "type", "click", "move", "drag", "mouse_down", "mouse_up", "hold_key", "open_app", "focus_app", "browser_navigate", "browser_js"]);
export const EAR_DISPATCH_TARGET_MS = 250;
/** The ear's stability windows (packages/engine/src/ear.ts defaults): a prefire kind's partial, and every other kind's. */
export const EAR_STABLE_MS = 120;
export const EAR_CAREFUL_MS = 450;
/**
 * A careful partial (a key, an edit, a text, a click) waits out the 450 ms window by
 * design — a prefix of more to come must not fire — so it is judged against that
 * window plus the same harness allowance the 250 ms target leaves over the 120 ms one.
 */
export const EAR_CAREFUL_DISPATCH_TARGET_MS = EAR_CAREFUL_MS + (EAR_DISPATCH_TARGET_MS - EAR_STABLE_MS);

export async function bench(opts: BenchOptions): Promise<BenchResult> {
  const print = opts.print ?? ((line: string): void => console.log(line));
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
  const brainState: BrainState = { hold: false, held: undefined, mode: "act", generations: 0, splitResults: [] };
  const brain = opts.codex ? undefined : fakeBrain(() => engine.runner, brainState);
  // A spawned thread's brain: attaches its lane and holds until the thread is stopped, so two
  // threads stay live for the status and targeted-stop rows without a model.
  const threadBrains: { id: string; stopped: boolean }[] = [];
  const makeThreadBrain: NonNullable<EngineOptions["makeThreadBrain"]> = (spec) => {
    const rec = { id: spec.threadId, stopped: false };
    threadBrains.push(rec);
    return {
      kind: "bench-thread",
      start: async () => ({ ready: true, detail: "bench thread" }),
      handle: async (task: BrainTask, sink: BrainSink): Promise<BrainResult> => {
        spec.runner.attach(sink, task);
        try {
          await new Promise<void>((r) => (task.signal.aborted ? r() : task.signal.addEventListener("abort", () => r(), { once: true })));
          return { status: "cancelled" };
        } finally {
          spec.runner.attach(undefined);
        }
      },
      cancel: async () => undefined,
      stop: async () => {
        rec.stopped = true;
      },
    };
  };
  // Two fake helpers, as the real pool has two processes: the acting one and the reading one.
  engine = new Engine({ config, connectors: [], ...(brain ? { brain } : {}), makeLive: () => live as unknown as LiveSession, ...(useFakeHands ? { hands: new FakeHands(), backgroundHands: new FakeHands() } : {}), ...(opts.codex ? {} : { makeThreadBrain }) });
  /** For the JSON: what the thread rows saw. */
  const extras: Record<string, unknown> = {};
  const samples: Sample[] = [];
  const add = (metric: string, value: number, unit: SampleUnit = "ms"): void => {
    if (Number.isFinite(value)) samples.push({ metric, value: Math.round(value * 10) / 10, unit });
  };
  const log = (line: string): void => {
    if (!opts.json) print(line);
  };

  const load = loadavg().map((v) => v.toFixed(1)).join(" ");
  log(`\n  bench: ${opts.runs} run(s); hands: ${useFakeHands ? "fake (in-process)" : `Swift helper at ${base.handsBin}`}; brain: ${opts.codex ? "real Codex (one tiny turn per run — this uses your ChatGPT login)" : "stand-in"}; load average ${load}`);
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
      add("quick screenshot (2000 px / 1.1 MP)", performance.now() - b);
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

    // The ear: synthetic on-device partials. The acting op is redirected to a harmless
    // cursor read on the real helper (the bench must never scroll or type on Kevin's Mac);
    // the round trip is still a real one. Dispatch is the moment the acting op is written
    // to the helper; ack is its answer.
    {
      const hands = engine.hands as unknown as { request: (op: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown> };
      const original = hands.request.bind(engine.hands);
      let issuedAt = Number.NaN;
      let ackAt = Number.NaN;
      let redirected = 0;
      hands.request = async (op, params, timeoutMs) => {
        const acting = ACTING_OPS.has(op);
        if (acting && Number.isNaN(issuedAt)) issuedAt = performance.now();
        let r: unknown;
        if (acting && !useFakeHands) {
          redirected++;
          r = await original("cursor", {}, timeoutMs);
        } else r = await original(op, params, timeoutMs);
        if (acting && Number.isNaN(ackAt)) ackAt = performance.now();
        return r;
      };
      try {
        let segment = 100;
        const phrases = useFakeHands ? [...EAR_PHRASES, "click save"] : EAR_PHRASES;
        for (let i = 0; i < opts.runs; i++) {
          for (const phrase of phrases) {
            for (const final of [false, true]) {
              issuedAt = Number.NaN;
              ackAt = Number.NaN;
              const fired = new Promise<{ earAt: number; matchedAt: number; dispatchedAt: number; doneAt: number; ok: boolean; dropped?: string }>((resolve) => engine.once("reflex.fired", (row) => resolve(row)));
              const heard = performance.now();
              engine.ear(phrase, final, segment++, Date.now());
              const row = await Promise.race([fired, new Promise<undefined>((r) => setTimeout(() => r(undefined), 2000))]);
              // A partial of a careful kind waits out the long window; its own row, its own target.
              const careful = !final && parseReflex(phrase)?.prefire !== true;
              const label = final ? "final" : careful ? "careful partial" : "partial";
              if (!row) {
                log(`  ear: "${phrase}" (${label}) did not fire within 2 s`);
                continue;
              }
              if (!row.ok) {
                if (i === 0) log(`  ear: "${phrase}" (${label}) dropped: ${row.dropped ?? "?"} (no dispatch; the model path would ask)`);
                continue;
              }
              add(`ear: ${label} → dispatch`, issuedAt - heard);
              add(`ear: ${label} → hands ack`, ackAt - heard);
              add(`ear: ${label} → done (ledger)`, row.doneAt - row.earAt);
              if (i === 0 && final) log(`  ear: "${phrase}": partial→dispatch includes the ${parseReflex(phrase)?.prefire ? `${EAR_STABLE_MS} ms stability` : `${EAR_CAREFUL_MS} ms careful`} window; final→dispatch ${Math.round(issuedAt - heard)} ms, ack ${Math.round(ackAt - heard)} ms`);
              await new Promise((r) => setTimeout(r, 20));
            }
          }
        }
        if (!useFakeHands) log(`  ear: ${redirected} acting op(s) were redirected to a cursor read on the real helper (nothing scrolled, typed or clicked)`);
      } finally {
        hands.request = original;
      }
    }

    // The browser fast path through the helper: Apple events to a running browser, reads only.
    if (!useFakeHands) {
      for (const app of ["Google Chrome", "Safari"]) {
        let running = true;
        for (let i = 0; i < opts.runs && running; i++) {
          const a = performance.now();
          try {
            await engine.hands.request("browser_url", { app }, 4000);
            add(`browser: ${app} url round trip`, performance.now() - a);
            const b = performance.now();
            await engine.hands.request("browser_tabs", { app }, 4000);
            add(`browser: ${app} tabs round trip`, performance.now() - b);
          } catch (e) {
            if (i === 0) log(`  browser: ${app}: ${(e as Error).message}`);
            running = false;
          }
        }
        if (running) {
          const js = await engine.runner.browser.jsAvailable(app);
          log(`  browser: ${app} JavaScript from Apple Events ${js.ok ? "on" : `off (${js.reason ?? ""})`}`);
          if (js.ok) {
            for (let i = 0; i < opts.runs; i++) {
              const c = performance.now();
              await engine.runner.run("browser_read", { app });
              add(`browser: ${app} browser_read (JS)`, performance.now() - c);
            }
          }
        }
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
        await engine.command({ type: "interrupt" });
        add("stop: command → everything stopped", performance.now() - a);
        if (i === 0) log(`  stop: the delegation was ${running ? "running (the brain held it)" : "NOT running"} when the stop arrived`);
        // Kevin speaks: the gate lifts so the next run's speech is not muted.
        live.emit("inputTranscript", " ok", live.tick() - 100, live.tick());
        await new Promise((r) => setTimeout(r, 30));
      }
      brainState.hold = false;
    }

    // Read during a type: hold the ACTING helper with a `wait` (harmless on the real helper —
    // no `type` lands on Kevin's Mac) and ask for the front app through the runner meanwhile.
    // With the reads routed to their own helper the answer comes back in milliseconds.
    {
      const acting = engine.hands as unknown as { request: (op: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown> };
      for (let i = 0; i < opts.runs; i++) {
        const hold = acting.request("wait", { ms: 1500 }, 5000).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 30));
        const a = performance.now();
        await engine.runner.run("frontmost_app", {});
        add("read during a type (acting helper held 1.5 s)", performance.now() - a);
        await hold;
      }
    }

    // Acting call incl. observation: a mouse_move to where the pointer already is — the
    // cheapest acting member — timed through the runner; when Settings.observe is on the
    // result carries a `now:` line read after the settle, and that share is the lever's proof.
    {
      let withLine = 0;
      let acting = 0;
      for (let i = 0; i < opts.runs; i++) {
        const cursor = await engine.runner.run("cursor_position", {});
        const m = cursor.result.kind === "text" ? /X=(-?\d+), Y=(-?\d+)/.exec(cursor.result.text) : null;
        if (!m) break;
        const a = performance.now();
        const out = await engine.runner.run("mouse_move", { coordinate: [Number(m[1]), Number(m[2])] });
        add("acting call incl. observation (mouse_move in place)", performance.now() - a);
        acting++;
        if (out.result.kind === "text" && /(^|\n)now: /.test(out.result.text)) withLine++;
      }
      extras["observation"] = { acting, withLine, observe: engine.snapshot().settings.observe };
      if (acting) log(`  observation: ${withLine}/${acting} acting result(s) carried a now: line (Settings.observe ${engine.snapshot().settings.observe ? "on" : "off"}; target ≥ 95 %)`);
    }

    // Threads: two stand-in threads live, then "what is spotify doing" as a delegation (the
    // table should answer with 0 brain generations, the running turn untouched) and a
    // thread.stop for one of them (only it stops). Skipped when the engine cannot start a
    // thread here (thread_start refused).
    if (!opts.codex) {
      const liveThreads = (snap: Snapshot): { id: string; name: string; status: string }[] =>
        snap.threads.filter((t) => t.id !== "main" && !THREAD_TERMINAL.has(t.status)).map((t) => ({ id: t.id, name: t.name, status: t.status }));
      brainState.mode = "split";
      const splitAt = live.nextUtterance();
      live.emit("inputTranscript", " jarhead tell ben on slack i'm late and put on focus on spotify", splitAt - 1500, splitAt);
      live.emit("delegation", "bench_split", "client", splitAt);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && liveThreads(engine.snapshot()).length < 2) await new Promise((r) => setTimeout(r, 20));
      const before = liveThreads(engine.snapshot());
      brainState.mode = "answer";
      extras["threads"] = { live: before.length, names: before.map((t) => t.name), splitResults: brainState.splitResults };
      if (before.length < 2) {
        log(`  threads: could not get two live threads (${before.map((t) => `${t.name}:${t.status}`).join(", ") || "none"}); ${brainState.splitResults.join(" | ") || "no thread_start answer"} — status reflex and targeted stop not measured`);
      } else {
        log(`  threads: ${before.map((t) => `${t.name} ${t.status} (${t.id})`).join(", ")} live`);
        // Status reflex: the spoken line's time and the generations it cost.
        const gensBefore = brainState.generations;
        const linesBefore = live.commentary.length;
        const askAt = live.nextUtterance();
        const asked = performance.now();
        live.emit("inputTranscript", " jarhead what is spotify doing", askAt - 900, askAt);
        live.emit("delegation", "bench_status", "client", askAt);
        const until = Date.now() + 5000;
        while (Date.now() < until && !live.commentary.slice(linesBefore).some((c) => /spotify/i.test(c.text))) await new Promise((r) => setTimeout(r, 10));
        const line = live.commentary.slice(linesBefore).find((c) => /spotify/i.test(c.text));
        const generations = brainState.generations - gensBefore;
        if (line) add("status reflex: delegation → spoken status line", line.at - asked);
        // A tally, not a timing: the table marks the row (count) and the JSON row says unit "count".
        add("status reflex: brain generations (count, target 0)", generations, "count");
        extras["statusReflex"] = { generations, lineMs: line ? Math.round(line.at - asked) : null, line: line?.text ?? null, stillLive: liveThreads(engine.snapshot()).length };
        log(`  status reflex: ${generations} brain generation(s); ${line ? `"${line.text.slice(0, 80)}" after ${Math.round(line.at - asked)} ms` : "no Spotify line within 5 s"}; ${liveThreads(engine.snapshot()).length} thread(s) still live`);
        await new Promise((r) => setTimeout(r, 100));
        // Targeted stop: one of the two, by id, through thread.stop.
        const target = liveThreads(engine.snapshot()).find((t) => /slack/i.test(t.name)) ?? liveThreads(engine.snapshot())[0];
        if (target) {
          const a = performance.now();
          await engine.command({ type: "thread.stop", threadId: target.id });
          const stopBy = Date.now() + 2000;
          while (Date.now() < stopBy && liveThreads(engine.snapshot()).some((t) => t.id === target.id)) await new Promise((r) => setTimeout(r, 5));
          const after = liveThreads(engine.snapshot());
          const stoppedOne = !after.some((t) => t.id === target.id);
          if (stoppedOne) add("targeted stop: command → that thread stopped", performance.now() - a);
          extras["targetedStop"] = { target: target.name, stoppedOne, othersLive: after.length };
          log(`  targeted stop: ${target.name} ${stoppedOne ? `stopped in ${Math.round(performance.now() - a)} ms` : "NOT stopped within 2 s"}; ${after.length} other thread(s) still live (${after.map((t) => t.name).join(", ") || "none"})`);
        }
      }
      brainState.mode = "act";
      await engine.command({ type: "interrupt" });
      live.emit("inputTranscript", " ok", live.tick() - 100, live.tick());
      await new Promise((r) => setTimeout(r, 50));
    }

    // Barge-in → duck: the Mac app's gate on synthetic tap buffers (nothing is played or
    // recorded; the microphone ranking it prints is read-only). See the header.
    if (!opts.codex && (opts.duck ?? true)) {
      const probe = await runDuckProbe(opts.runs);
      for (const ms of probe.report.samples ?? []) add("barge-in: speech onset → −20 dB (duck probe)", ms);
      for (const ms of probe.report.unconfirmedRestoreMs ?? []) add("barge-in: cough / echo words, unconfirmed → back to unity", ms);
      for (const ms of probe.report.speechEndToUnityMs ?? []) add("barge-in: confirmed, the user's last word → back to unity", ms);
      for (const ms of probe.report.heldRestoreMs ?? []) add("barge-in: no confirmation, still speaking → back to unity", ms);
      if (probe.note) log(`  barge-in: ${probe.note}`);
      else {
        const med = (v: readonly number[] | undefined): string => (v && v.length ? `${percentile(v, 50).toFixed(0)} ms` : "—");
        log(`  barge-in: probe ok; confirmed by Live's transcript ${med(probe.report.liveConfirmMs)} after the duck (modelled at +${probe.report.liveModelledMs ?? "?"} ms from onset), by the ear's words ${med(probe.report.earConfirmMs)}; ${probe.report.refusedEchoPartials ?? 0} partial(s) of Jarhead's own words refused as confirmation`);
        if (probe.report.ranked?.length) log(`  barge-in: mic ranking on this Mac (auto): ${probe.report.ranked.join(" › ")}`);
      }
    }
  } finally {
    await Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 8000))]);
  }

  // The table.
  const targets: Record<string, number> = {
    "tool round trip (frontmost_app)": 80,
    "tool round trip (in delegation)": 80,
    "quick screenshot (2000 px / 1.1 MP)": 120,
    "eyes: pre-warm shot": 120,
    "delegation → first action": opts.codex ? 1200 : 300,
    "reflex: utterance end → tool issued (prefired)": 300,
    "ear: partial → dispatch": EAR_DISPATCH_TARGET_MS,
    "ear: careful partial → dispatch": EAR_CAREFUL_DISPATCH_TARGET_MS,
    "ear: final → dispatch": EAR_DISPATCH_TARGET_MS,
    "browser: Google Chrome url round trip": 80,
    "browser: Google Chrome tabs round trip": 80,
    "browser: Safari url round trip": 80,
    "browser: Safari tabs round trip": 80,
    "browser: Google Chrome browser_read (JS)": 80,
    "browser: Safari browser_read (JS)": 80,
    "stop: command → everything stopped": 150,
    "read during a type (acting helper held 1.5 s)": 20,
    "acting call incl. observation (mouse_move in place)": 350,
    "status reflex: delegation → spoken status line": 500,
    "status reflex: brain generations (count, target 0)": 0,
    "targeted stop: command → that thread stopped": 150,
    // 60 ms of speech energy + the rest of the 100 ms tap buffer it lands in + the 12 ms gain steps.
    "barge-in: speech onset → −20 dB (duck probe)": DUCK_TARGET_MS,
    // 250 ms quiet hold + the 50 ms poll + the tap's 100 ms delivery + the 300 ms ramp.
    "barge-in: confirmed, the user's last word → back to unity": DUCK_RELEASE_TARGET_MS,
  };
  /** The ear rows are judged at p95 (the 250 ms promise is for every command, not the typical one), the acting-call row too (its settle is the cost); the rest at the median. */
  const judgedAtP95 = new Set(["ear: partial → dispatch", "ear: careful partial → dispatch", "ear: final → dispatch", "acting call incl. observation (mouse_move in place)"]);
  const metrics = [...new Set(samples.map((s) => s.metric))];
  const rows: BenchRow[] = metrics.map((metric) => {
    const mine = samples.filter((s) => s.metric === metric);
    const values = mine.map((s) => s.value);
    const median = percentile(values, 50);
    const p95 = percentile(values, 95);
    const target = targets[metric];
    return { metric, unit: mine[0]?.unit ?? "ms", n: values.length, median, p90: percentile(values, 90), p95, max: Math.max(...values), target, pass: target === undefined ? undefined : (judgedAtP95.has(metric) ? p95 : median) <= target };
  });
  // The gate: with the real helper, the ear's p95 to dispatch must be under each row's target
  // (250 ms for finals and prefire partials; the careful window plus the same allowance for the rest).
  const earRows = rows.filter((r) => judgedAtP95.has(r.metric));
  const gateFailed = (opts.gate ?? true) && !useFakeHands && (earRows.length === 0 || earRows.some((r) => !(r.p95 <= (r.target ?? EAR_DISPATCH_TARGET_MS))));
  if (opts.json) {
    print(JSON.stringify({ hands: useFakeHands ? "fake" : "helper", brain: opts.codex ? engine.brainInfo.detail : "stand-in", rows, earGate: useFakeHands ? "not judged (fake hands)" : gateFailed ? "FAIL" : "ok", ...extras }, null, 2));
    return { ok: !gateFailed, rows, extras };
  }
  const pad = (s: string, n: number): string => s.padEnd(n);
  const num = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : "-").padStart(7);
  print(`\n  ${pad("metric", 46)}${"n".padStart(4)}${"median".padStart(8)}${"p90".padStart(8)}${"p95".padStart(8)}${"max".padStart(8)}${"target".padStart(8)}  result`);
  for (const r of rows) {
    // Every column is ms, except on a (count) row, where the same columns are tallies.
    print(`  ${pad(r.metric, 46)}${String(r.n).padStart(4)}${num(r.median)} ${num(r.p90)} ${num(r.p95)} ${num(r.max)} ${r.target === undefined ? "       -" : num(r.target)}  ${r.pass === undefined ? "" : r.pass ? "ok" : "MISS"}${judgedAtP95.has(r.metric) ? " (p95)" : ""}${r.unit === "count" ? " (count, not ms)" : ""}`);
  }
  print(`\n  hands: ${useFakeHands ? "fake" : "Swift helper"}; brain: ${opts.codex ? engine.brainInfo.detail : "stand-in"}; load average ${load}; state dir ${dir}`);
  if (useFakeHands) print(`  ear gate: not judged with fake hands (run without --fake-hands for the real ${EAR_DISPATCH_TARGET_MS} ms check)\n`);
  else print(`  ear gate: p95 partial→dispatch and final→dispatch ≤ ${EAR_DISPATCH_TARGET_MS} ms, careful partial→dispatch ≤ ${EAR_CAREFUL_DISPATCH_TARGET_MS} ms (its ${EAR_CAREFUL_MS} ms window is by design) with the real helper — ${gateFailed ? "FAIL" : "ok"}\n`);
  return { ok: !gateFailed, rows, extras };
}
