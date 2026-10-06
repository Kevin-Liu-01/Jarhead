#!/usr/bin/env node
/**
 * The live-check harness (W2-8): the paid checks LC-1..LC-10 of the launch triage, run against
 * the real GPT-Live-1 server under a hard spend cap, and the same scenarios run offline against a
 * scripted stand-in (`--dry-run`), which is what the tests run.
 *
 *   node --import tsx scripts/live-check.mts <check> --i-accept-spend --cap-usd 1.00
 *   node --import tsx scripts/live-check.mts <check> --dry-run
 *   node --import tsx scripts/live-check.mts list
 *
 * `<check>` is an id (LC-1) or a name (cadence), or `all` (each check in order, each gated).
 *
 * What a check is built from, live or dry:
 *
 * - A real Engine over a temp state dir (its ledger, settings and socket path), JARHEAD_NO_AUDIO=1,
 *   JARHEAD_AUTO_WAKE=0, every other JARHEAD_* variable and every secret key unset for the run.
 * - Fake hands on both helpers (FakeHands through fakeHandsSpawn, the engine's own seam): nothing
 *   touches the desktop. A canned brain (scripted results, no model, no Codex or Claude turn) and
 *   canned thread brains. A memory service that does nothing. No agent connectors. No shell.
 * - The real LiveSession, over a socket the harness taps: every frame in and out is timed and kept.
 *   Live: the real WebSocket to wss://api.openai.com. Dry: a scripted server in this file.
 * - Typed lines go through `engine.sayText`. "Spoken" lines are typed text turned into PCM by
 *   gpt-4o-mini-tts (dry: a marked tone the stand-in reads back) and fed as mic frames through
 *   `engine.feedMic`. Never the real microphone. Nothing is played: the engine's `audio` events go
 *   to a counting sink.
 * - A network fence for the run: fetch answers only the free key probe (GET /v1/models/<model>) and
 *   refuses everything else; a WebSocket other than the harness's own is refused. A spawn fence
 *   refuses every child process. Both are recorded in the report.
 *
 * Spend (live): a run refuses without both `--i-accept-spend` and `--cap-usd`, and with a cap over
 * 1.00. The cap is the day's total across checks: today's spend in the harness's one ledger plus the
 * check's plan must fit under it, or the check is refused. The ledger is
 * `<state dir>/live-check/spend.ndjson` (`~/.jarhead` unless JARHEAD_STATE_DIR says otherwise), one
 * line when a check starts and one when it ends; a start with no end counts its whole plan. It is the
 * same file whatever `--out` says, so a new checkout or a new report folder starts no new budget, and
 * the lock beside it (`live.lock`) lets one live check run at a time from any checkout. Each check has
 * its own cap in billed seconds; a watchdog terminates the session the moment the larger of the
 * server's meter and the wall clock reaches it, refuses any further session, and presses Stop. A dry
 * run spends nothing and is never refused for spend: its simulated lines go to
 * `<out>/spend.dry.ndjson`, for the record only.
 *
 * Every run writes one JSON report (`<out>/<day>/<id>-<name>-<time>.json`) and the engine's log
 * beside it; `<out>` (default `build/live-check` in the checkout) also keeps the speech cache. The
 * exit code is 0 when every hard assertion passed, 1 when one failed, 2 when the run was refused.
 * `scripts/rejudge.mts <report.json>` judges a saved report again with this checkout's judges, for free.
 */
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brain, BrainResult, BrainSink, BrainTask } from "@jarhead/brain";
import { REPO_ROOT, replaceDefaultSink, type JarheadConfig, type LogLevel } from "@jarhead/core";
import { Engine, type EngineOptions } from "@jarhead/engine";
import { FakeHands } from "@jarhead/hands";
import { LIVE_MODEL, LIVE_URL, LiveSession, estimateTokens, type SessionConfig, type WebSocketLike } from "@jarhead/live";
import { SECRET_KEYS, type EngineEvent, type LedgerRow, type Snapshot } from "@jarhead/protocol";

// ---- prices, caps, the plan ------------------------------------------------------------------

/** GPT-Live-1: $0.05 a minute, billed per second of open session, muted or not (README; LC-11 confirms it). */
export const LIVE_USD_PER_SECOND = 0.05 / 60;
/** gpt-4o-mini-tts, per second of speech produced (about $0.015 a minute; an estimate, counted when a line is synthesized). */
export const TTS_USD_PER_SECOND = 0.015 / 60;
/** The day's ceiling across every check. `--cap-usd` may lower it, never raise it. */
export const MAX_CAP_USD = 1.0;
/** Every append channel is capped at 500 tokens (packages/live/src/appender.ts APPEND_TOKEN_CAP): the premise LC-3 checks. */
export const APPEND_TOKEN_CAP = 500;
/** PCM16 mono 24 kHz, the rate the session is opened with and the mic frames are fed at. */
export const SAMPLE_RATE = 24_000;
/** One mic frame: 40 ms. */
export const FRAME_MS = 40;
const FRAME_BYTES = (SAMPLE_RATE * 2 * FRAME_MS) / 1000;
/** A frame at or above this RMS (of full scale) is sound; below it, silence. */
export const AUDIBLE_RMS = 0.01;
/** The engine's output gate after a stop (Engine.OUTPUT_GATE_MS); LC-6 counts sink frames inside it. */
const OUTPUT_GATE_MS = Engine.OUTPUT_GATE_MS;
/** The voice's farewell cap (Engine.FAREWELL_CAP_MS); LC-4's close must land inside it, counted from the word's first sound. */
const FAREWELL_CAP_MS = Engine.FAREWELL_CAP_MS;
/** How long the farewell word may take to begin once it is asked for (Engine.FAREWELL_START_MS, 3 s). */
const FAREWELL_START_MS = Engine.FAREWELL_START_MS;
/** The model the spoken lines are synthesized with, and its voice. */
export const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "alloy";
/** How a dry run compresses the check's own timeline (wall ms per check ms). */
export const DRY_SCALE = 0.05;

export type CheckId = "LC-1" | "LC-2" | "LC-3" | "LC-4" | "LC-5" | "LC-6" | "LC-7" | "LC-8" | "LC-9" | "LC-10";
export type Mode = "live" | "dry";

export interface CheckPlan {
  readonly id: CheckId;
  readonly name: string;
  /** What it runs, in one line. */
  readonly what: string;
  /** The check's own cap, in billed seconds of open session. */
  readonly capSeconds: number;
  /** The synthesis the check plans, in dollars (an estimate; the cache makes a rerun free). */
  readonly ttsUsd: number;
}

/** The table in TRIAGE.md's "Live checks", in order. The planned total is about 820 s (865 s with LC-3's --oversize run). */
export const PLANS: readonly CheckPlan[] = [
  { id: "LC-1", name: "cadence", what: "Go; typed one line; 50 s of silence frames; Stop. Server frame gaps while silent.", capSeconds: 75, ttsUsd: 0 },
  { id: "LC-2", name: "meter", what: "Go; typed; mute 20 s; Pause at 40 s; Go; typed; Stop. One session through the mute; the meter, the pause row, continuity.", capSeconds: 120, ttsUsd: 0 },
  { id: "LC-3", name: "append-cap", what: "A typed paste of 2,700 characters. Every append within 500 tokens.", capSeconds: 45, ttsUsd: 0 },
  { id: "LC-4", name: "night", what: "Typed \"that's all for now\", three times. The farewell is \"night.\" and the close lands within 1.8 s of the first farewell sound at the speaker.", capSeconds: 45, ttsUsd: 0 },
  { id: "LC-5", name: "first-word", what: "Ten typed short questions. The engine's share of the first word, and GPT-Live-1's typed path to it.", capSeconds: 120, ttsUsd: 0 },
  { id: "LC-6", name: "spoken-stop", what: "A spoken long story request, then a spoken stop, three times. Nothing reaches the sink inside the gate, and the story does not come back after it.", capSeconds: 90, ttsUsd: 0.003 },
  { id: "LC-7", name: "room-talk", what: "Go and one typed exchange; once its window shuts, room talk every 15 s, commands among it. No reflex, no reply, no delegation; idle sleep about 60 s after the exchange.", capSeconds: 100, ttsUsd: 0.006 },
  { id: "LC-8", name: "drop", what: "A slow canned task; the socket drops; Stop (and Pause, then Go). The brain is cut once.", capSeconds: 90, ttsUsd: 0 },
  { id: "LC-9", name: "delegate", what: "Typed \"Jarhead, scroll down.\" then a haiku. The reflex scrolls; the haiku is composed (Live, or the brain if Live delegates); nothing is typed.", capSeconds: 60, ttsUsd: 0 },
  { id: "LC-10", name: "speech-end", what: "Spoken \"Jarhead, what's on my screen?\" five times. Speech end before the delegation.", capSeconds: 75, ttsUsd: 0.003 },
];

/** LC-3's optional second half: one raw oversize append, the cap premise itself. */
const OVERSIZE_EXTRA_SECONDS = 45;

export function findPlan(name: string): CheckPlan | undefined {
  const n = name.trim().toLowerCase();
  return PLANS.find((p) => p.id.toLowerCase() === n || p.name === n || p.id.toLowerCase().replace("-", "") === n);
}

export function planSeconds(plan: CheckPlan, o: { readonly oversize?: boolean } = {}): number {
  return plan.capSeconds + (plan.id === "LC-3" && o.oversize ? OVERSIZE_EXTRA_SECONDS : 0);
}

export function planUsd(plan: CheckPlan, o: { readonly oversize?: boolean } = {}): number {
  return planSeconds(plan, o) * LIVE_USD_PER_SECOND + plan.ttsUsd;
}

const usd = (v: number): string => `$${v.toFixed(3)}`;

// ---- the arguments ---------------------------------------------------------------------------

export interface Args {
  readonly check: string;
  readonly mode: Mode;
  readonly acceptSpend: boolean;
  readonly capUsd: number | undefined;
  readonly out: string | undefined;
  readonly oversize: boolean;
  readonly keepState: boolean;
  readonly scale: number | undefined;
}

export function parseArgs(argv: readonly string[]): Args | { readonly error: string } {
  let check: string | undefined;
  let mode: Mode = "live";
  let acceptSpend = false;
  let capUsd: number | undefined;
  let out: string | undefined;
  let oversize = false;
  let keepState = false;
  let scale: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = (): string | undefined => {
      const v = argv[i + 1];
      i++;
      return v;
    };
    if (a === "--i-accept-spend") acceptSpend = true;
    else if (a === "--dry-run") mode = "dry";
    else if (a === "--oversize") oversize = true;
    else if (a === "--keep-state") keepState = true;
    else if (a === "--cap-usd") {
      const v = value();
      capUsd = v === undefined ? Number.NaN : Number(v);
    } else if (a === "--out") {
      const v = value();
      if (!v) return { error: "--out needs a directory." };
      out = resolve(v);
    } else if (a === "--scale") {
      const v = Number(value());
      if (!(v > 0 && v <= 1)) return { error: "--scale is a number in (0, 1]." };
      scale = v;
    } else if (a.startsWith("--")) return { error: `Unknown flag ${a}.` };
    else if (check === undefined) check = a;
    else return { error: `One check at a time (got ${check} and ${a}). Use all for every check.` };
  }
  if (!check) return { error: "Name a check: LC-1..LC-10, a name such as cadence, all, or list." };
  if (scale !== undefined && mode !== "dry") return { error: "--scale is for --dry-run only." };
  return { check, mode, acceptSpend, capUsd, out, oversize, keepState, scale };
}

/**
 * The live run's refusals that need no ledger: --i-accept-spend, and a --cap-usd the operator states, in (0, 1.00].
 * A dry run needs neither (its cap defaults to MAX_CAP_USD). Undefined = allowed.
 */
export function spendFlagsRefusal(args: Pick<Args, "mode" | "acceptSpend" | "capUsd">): string | undefined {
  const cap = MAX_CAP_USD.toFixed(2);
  const badCap = args.capUsd !== undefined && !(args.capUsd > 0 && args.capUsd <= MAX_CAP_USD);
  if (args.mode === "dry") return badCap ? `Refused. --cap-usd must be above 0 and at most ${cap}.` : undefined;
  if (!args.acceptSpend) return `Refused. A live check opens a paid GPT-Live session. Pass --i-accept-spend --cap-usd ${cap} to run it, or --dry-run to run it offline.`;
  if (args.capUsd === undefined) return `Refused. State the day's cap. Pass --i-accept-spend --cap-usd ${cap} (at most ${cap}).`;
  if (badCap) return `Refused. --cap-usd must be above 0 and at most ${cap}.`;
  return undefined;
}

// ---- the spend ledger ------------------------------------------------------------------------

export interface SpendLine {
  readonly at: number;
  readonly day: string;
  readonly runId: string;
  readonly check: CheckId;
  readonly event: "start" | "end";
  /** start: the plan. */
  readonly planSeconds?: number;
  readonly planUsd?: number;
  /** end: what the run billed (the larger of the server's meter and the wall clock, per session) and synthesized. */
  readonly billedSeconds?: number;
  readonly ttsUsd?: number;
  readonly usd?: number;
}

export function localDay(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Jarhead's state dir as the app reads it: JARHEAD_STATE_DIR, else ~/.jarhead. */
export function stateDirOf(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env["JARHEAD_STATE_DIR"]?.trim() || join(home, ".jarhead");
  return dir.startsWith("~") ? join(home, dir.slice(1)) : dir;
}

/** The one live spend ledger, whatever --out says: `<state dir>/live-check/spend.ndjson`. The live lock sits beside it. */
export function liveSpendFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(stateDirOf(env, home), "live-check", "spend.ndjson");
}

/** A dry run's simulated spend, kept for the record beside its reports. It never gates a run. */
export function drySpendFile(out: string): string {
  return join(out, "spend.dry.ndjson");
}

/** One live check at a time, from any checkout: the lock beside the ledger holds the pid of the run that took it. */
export function liveLockFile(ledger: string): string {
  return join(dirname(ledger), "live.lock");
}

function pidAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: a process of another user holds the pid; it is alive all the same.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the live lock: created exclusively, so two runs that start together cannot both get it. A lock whose run is
 * gone (its pid dead, or an empty file older than a few seconds) is stale and is taken over.
 */
export function takeLiveLock(lock: string): { readonly ok: true } | { readonly ok: false; readonly pid: number } {
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let text = "";
    let ageMs = 0;
    try {
      text = readFileSync(lock, "utf8").trim();
      ageMs = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between the two calls: try again
    }
    const pid = Number(text);
    if (text === "" ? ageMs < 5000 : pidAlive(pid)) return { ok: false, pid: text === "" ? 0 : pid };
    rmSync(lock, { force: true });
  }
  return { ok: false, pid: 0 };
}

/** Let the lock go, if it is still this run's. */
export function releaseLiveLock(lock: string): void {
  try {
    if (Number(readFileSync(lock, "utf8").trim()) === process.pid) rmSync(lock, { force: true });
  } catch {
    // Gone already.
  }
}

export function readSpend(file: string): SpendLine[] {
  if (!existsSync(file)) return [];
  const lines: SpendLine[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as SpendLine);
    } catch {
      // A torn last line (a crash mid-write) is skipped; its run's start line still counts its plan.
    }
  }
  return lines;
}

/** Today's spend: every ended run's dollars, and the whole plan of a run that started and never ended. */
export function spentToday(lines: readonly SpendLine[], day: string = localDay()): { readonly usd: number; readonly billedSeconds: number; readonly runs: number; readonly unended: number } {
  const starts = new Map<string, SpendLine>();
  const ends = new Map<string, SpendLine>();
  for (const l of lines) {
    if (l.day !== day) continue;
    if (l.event === "start") starts.set(l.runId, l);
    else ends.set(l.runId, l);
  }
  let total = 0;
  let seconds = 0;
  let unended = 0;
  for (const [runId, start] of starts) {
    const end = ends.get(runId);
    if (end) {
      total += end.usd ?? 0;
      seconds += end.billedSeconds ?? 0;
    } else {
      unended++;
      total += start.planUsd ?? 0;
      seconds += start.planSeconds ?? 0;
    }
  }
  return { usd: total, billedSeconds: seconds, runs: starts.size, unended };
}

/** Whether a check may start: today's spend plus its plan under the cap. */
export function spendGate(lines: readonly SpendLine[], plan: CheckPlan, capUsd: number, o: { readonly oversize?: boolean; readonly day?: string } = {}): { readonly ok: true; readonly todayUsd: number; readonly planUsd: number } | { readonly ok: false; readonly reason: string } {
  const today = spentToday(lines, o.day);
  const p = planUsd(plan, o);
  if (today.usd + p > capUsd + 1e-9) {
    const unended = today.unended ? ` (${today.unended} run(s) never ended; each counts its whole plan)` : "";
    return { ok: false, reason: `Refused. Today's checks spent ${usd(today.usd)}${unended}. ${plan.id} plans ${usd(p)}. The cap is ${usd(capUsd)}.` };
  }
  return { ok: true, todayUsd: today.usd, planUsd: p };
}

// ---- PCM ---------------------------------------------------------------------------------------

/** RMS of PCM16 LE as a share of full scale. */
export function rms16(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

function tone(ms: number, amplitude = 0.25, hz = 440): Buffer {
  const samples = Math.round((SAMPLE_RATE * ms) / 1000);
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude * 32767), i * 2);
  return b;
}

const SILENT_FRAME = Buffer.alloc(FRAME_BYTES);

/** Split PCM into mic frames (the last one zero-padded). */
function frames(pcm: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += FRAME_BYTES) {
    const f = Buffer.alloc(FRAME_BYTES);
    pcm.copy(f, 0, i, Math.min(pcm.length, i + FRAME_BYTES));
    out.push(f);
  }
  return out;
}

/** The dry synthesizer's mark: the stand-in server reads the words back from the first frame of the utterance. */
const DRY_MAGIC = Buffer.from("JHTX");

/** Dry speech: the mark (total length, the text) in the first frame, then a tone as long as the words would take. */
export function drySpeech(text: string): Buffer {
  const words = text.split(/\s+/).filter(Boolean).length;
  const body = tone(Math.max(200, words * 60));
  const utf8 = Buffer.from(text, "utf8");
  const header = Buffer.alloc(DRY_MAGIC.length + 6);
  DRY_MAGIC.copy(header, 0);
  if (header.length + utf8.length > FRAME_BYTES) throw new Error(`a dry line must fit one frame: ${text.slice(0, 40)}`);
  const total = header.length + utf8.length + body.length;
  const padded = total + (total % 2);
  header.writeUInt32LE(padded, DRY_MAGIC.length);
  header.writeUInt16LE(utf8.length, DRY_MAGIC.length + 4);
  return Buffer.concat([header, utf8, body, Buffer.alloc(padded - total)]);
}

function readDryMark(chunk: Buffer): { readonly total: number; readonly text: string } | undefined {
  if (chunk.length < DRY_MAGIC.length + 6 || !chunk.subarray(0, DRY_MAGIC.length).equals(DRY_MAGIC)) return undefined;
  const total = chunk.readUInt32LE(DRY_MAGIC.length);
  const len = chunk.readUInt16LE(DRY_MAGIC.length + 4);
  return { total, text: chunk.subarray(DRY_MAGIC.length + 6, DRY_MAGIC.length + 6 + len).toString("utf8") };
}

// ---- the recorder ------------------------------------------------------------------------------

export interface ServerFrame {
  readonly t: number;
  readonly s: number;
  readonly type: string;
  readonly bytes: number;
  /** Output audio only: whether the frame is sound, how many ms of audio it carries, and its RMS (keptRms). */
  readonly audible?: boolean;
  readonly audioMs?: number;
  readonly rms?: number;
}

/**
 * A frame the engine handed to the speaker (here a record, never played): when, whether it was sound, its length, its
 * RMS (keptRms), and whether the engine hears it as sound (engineAudibleAt). Reports written before the RMS was kept
 * have `audible` only, and those written before the engine's verdict was kept have no `engineAudible`.
 */
export interface SinkFrame {
  readonly t: number;
  readonly audible: boolean;
  readonly ms: number;
  readonly rms?: number;
  readonly engineAudible?: boolean;
}

/** A frame's RMS as the reports keep it: rms16's share of full scale, to 4 decimals. */
const keptRms = (rms: number): number => Math.round(rms * 10_000) / 10_000;

/**
 * Whether the engine hears a frame of this RMS (rms16's, unrounded) as sound: its own level, as engine.ts reckons it
 * (min(1, rms x 3) >= Engine.AUDIBLE_OUTPUT_LEVEL, about 0.0067 of full scale), below the harness's AUDIBLE_RMS. Taken
 * when the frame is recorded: the kept RMS is rounded, and a frame just under the level can round up to it.
 */
const engineAudibleAt = (rms: number): boolean => Math.min(1, rms * 3) >= Engine.AUDIBLE_OUTPUT_LEVEL;

/** The record of a frame the engine handed to the speaker at `t` (check ms). */
export function sinkFrame(t: number, pcm: Buffer): SinkFrame {
  const rms = rms16(pcm);
  return { t, audible: rms >= AUDIBLE_RMS, ms: pcmMs(pcm), rms: keptRms(rms), engineAudible: engineAudibleAt(rms) };
}

/**
 * Whether the engine itself hears a sink frame as sound: the verdict kept with the frame, else its kept RMS at the
 * engine's level (reports from before the verdict was kept), else `audible` (from before the RMS was kept).
 */
export function engineHears(f: SinkFrame): boolean {
  if (f.engineAudible !== undefined) return f.engineAudible;
  return f.rms === undefined ? f.audible : engineAudibleAt(f.rms);
}

/** Milliseconds of PCM16 mono audio at the session's rate. */
export function pcmMs(pcm: Buffer): number {
  return (pcm.length / 2 / SAMPLE_RATE) * 1000;
}

export interface ClientFrame {
  readonly t: number;
  readonly s: number;
  readonly type: string;
  readonly bytes: number;
  /** Appends only: the content's token estimate (estimateTokens, the cap's own measure) and its first characters. */
  readonly tokens?: number;
  readonly chars?: number;
  readonly head?: string;
}

export interface TextDelta {
  readonly t: number;
  readonly s: number;
  readonly delta: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SessionRecord {
  readonly s: number;
  readonly createdT: number;
  startedT?: number;
  id?: string;
  closedT?: number;
  closeReason?: string;
  /** The server's last meter reading. */
  usage: number;
  /** session.start: the instructions' length and whether they carry the continuity section. */
  instructionsChars?: number;
  continuity?: boolean;
}

export interface NetAttempt {
  readonly t: number;
  /** passed: it left the process (live only, the allowed list); answered: the fence answered it in process; refused. */
  readonly verdict: "passed" | "answered" | "refused";
  readonly what: string;
}

export class Recorder {
  /** `wall0`: the wall ms every `t` counts from (a re-judge rebuilds a saved report's recorder on its own). */
  constructor(readonly wall0: number = Date.now()) {}
  readonly server: ServerFrame[] = [];
  readonly client: ClientFrame[] = [];
  readonly inText: TextDelta[] = [];
  readonly outText: TextDelta[] = [];
  readonly delegations: { readonly t: number; readonly s: number; readonly id: string; readonly target: string; readonly offsetMs: number }[] = [];
  readonly errors: { readonly t: number; readonly s: number; readonly code: string; readonly message: string }[] = [];
  readonly usage: { readonly t: number; readonly s: number; readonly seconds: number }[] = [];
  readonly sessions: SessionRecord[] = [];
  readonly sockets: { readonly t: number; readonly s: number; readonly what: string; readonly code?: number }[] = [];
  /** Every frame the engine handed to the speaker (here: recorded, never played), with whether it was sound. */
  readonly sink: SinkFrame[] = [];
  readonly marks: { readonly t: number; readonly name: string; readonly data?: Record<string, unknown> }[] = [];
  readonly events: { readonly t: number; readonly type: string; readonly detail?: string }[] = [];
  readonly phases: { readonly t: number; readonly phase: string }[] = [];
  /** Every reflex the engine reports as run (the ear's, the delegator's prefire, a typed line's). */
  readonly reflexes: { readonly t: number; readonly label: string; readonly ms: number; readonly prefired: boolean }[] = [];
  /** Every reflex row the ear wrote, run or not (a reflex that failed on the hands, or one the policy dropped, is here too). */
  readonly reflexRows: { readonly t: number; readonly action: string; readonly source: string; readonly ok: boolean }[] = [];
  readonly net: NetAttempt[] = [];
  readonly spawns: { readonly t: number; readonly what: string }[] = [];
  /** Spoken lines: when each was fed, and its last audible frame (the speech end the harness knows exactly). */
  readonly speech: { readonly text: string; readonly startT: number; readonly endT: number; readonly seconds: number }[] = [];
  /** Seconds of speech synthesized by this run (a cached line costs nothing). */
  ttsSynthesized = 0;
  /** A hook run after each server frame was dispatched (LC-6 samples the gate here). */
  afterServerFrame: ((f: ServerFrame, ev: Record<string, unknown>) => void) | undefined;

  t(at: number = Date.now()): number {
    return at - this.wall0;
  }

  mark(name: string, data?: Record<string, unknown>): number {
    const t = this.t();
    this.marks.push({ t, name, ...(data ? { data } : {}) });
    return t;
  }

  markT(name: string): number | undefined {
    return this.marks.find((m) => m.name === name)?.t;
  }

  marksNamed(name: string): number[] {
    return this.marks.filter((m) => m.name === name).map((m) => m.t);
  }

  /** `t`: when the frame arrived, stamped before the session dispatched it (so it is never later than what the engine did with it). */
  onServer(s: number, raw: unknown, t: number = this.t()): void {
    const text = String(raw);
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.server.push({ t, s, type: "(unparsed)", bytes: text.length });
      return;
    }
    const type = String(ev["type"] ?? "?");
    let frame: ServerFrame = { t, s, type, bytes: text.length };
    const session = this.sessions[s];
    switch (type) {
      case "session.output_audio.delta": {
        const pcm = Buffer.from(String(ev["delta"] ?? ""), "base64");
        const rms = rms16(pcm);
        frame = { ...frame, audible: rms >= AUDIBLE_RMS, audioMs: pcmMs(pcm), rms: keptRms(rms) };
        break;
      }
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        const d: TextDelta = { t, s, delta: String(ev["delta"] ?? ""), startMs: Number(ev["start_ms"] ?? 0), endMs: Number(ev["end_ms"] ?? 0) };
        (type === "session.input_transcript.delta" ? this.inText : this.outText).push(d);
        break;
      }
      case "session.delegation.created": {
        const dlg = (ev["delegation"] ?? {}) as Record<string, unknown>;
        this.delegations.push({ t, s, id: String(dlg["id"] ?? ""), target: String(dlg["target"] ?? ""), offsetMs: Number(ev["offset_ms"] ?? 0) });
        break;
      }
      case "session.usage.updated": {
        const seconds = Number((ev["usage"] as { seconds?: unknown } | undefined)?.seconds ?? 0);
        this.usage.push({ t, s, seconds });
        if (session) session.usage = Math.max(session.usage, seconds);
        break;
      }
      case "session.closed": {
        const seconds = Number((ev["usage"] as { seconds?: unknown } | undefined)?.seconds ?? 0);
        if (session) session.usage = Math.max(session.usage, seconds);
        break;
      }
      case "error": {
        const e = (ev["error"] ?? {}) as Record<string, unknown>;
        this.errors.push({ t, s, code: String(e["code"] ?? ""), message: String(e["message"] ?? "").slice(0, 300) });
        break;
      }
      default:
        break;
    }
    this.server.push(frame);
    return void this.afterServerFrame?.(frame, ev);
  }

  onClient(s: number, data: string): void {
    const t = this.t();
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      this.client.push({ t, s, type: "(unparsed)", bytes: data.length });
      return;
    }
    const type = String(ev["type"] ?? "?");
    if (type === "session.instructions.append" || type === "session.commentary.append" || type === "session.thinking.append") {
      const content = String(ev["content"] ?? "");
      this.client.push({ t, s, type, bytes: data.length, tokens: estimateTokens(content), chars: content.length, head: content.slice(0, 160) });
      return;
    }
    if (type === "session.start") {
      const instructions = String((ev["session"] as { instructions?: unknown } | undefined)?.instructions ?? "");
      const session = this.sessions[s];
      if (session) {
        session.instructionsChars = instructions.length;
        session.continuity = /^# Continuity/m.test(instructions);
      }
    }
    // Mic frames are many and alike: their count and bytes are kept, not their samples.
    this.client.push({ t, s, type, bytes: data.length });
  }

  /** What the run has billed so far: per session, the larger of the server's meter and its open wall seconds. */
  billedSeconds(now: number = this.t()): number {
    let total = 0;
    for (const s of this.sessions) {
      if (s.startedT === undefined) continue;
      const open = ((s.closedT ?? now) - s.startedT) / 1000;
      total += Math.max(open, s.usage);
    }
    return total;
  }

  ttsSeconds(): number {
    return this.ttsSynthesized;
  }

  // ---- reading helpers for the judges
  audible(s: number | undefined, fromT = 0, toT = Number.POSITIVE_INFINITY): ServerFrame[] {
    return this.server.filter((f) => f.type === "session.output_audio.delta" && f.audible === true && (s === undefined || f.s === s) && f.t >= fromT && f.t < toT);
  }

  /** Milliseconds of sound the engine handed to the speaker in [fromT, toT). */
  audibleSinkMs(fromT: number, toT: number): number {
    return this.sink.filter((f) => f.audible && f.t >= fromT && f.t < toT).reduce((a, f) => a + f.ms, 0);
  }

  /** The input delta at which Kevin's words since `fromT`, joined, first match `re` (a word the server split across deltas still counts). */
  heardAt(fromT: number, re: RegExp): TextDelta | undefined {
    let joined = "";
    for (const d of this.inText) {
      if (d.t < fromT) continue;
      joined += d.delta;
      if (re.test(joined)) return d;
    }
    return undefined;
  }

  text(dir: "in" | "out", fromT = 0, toT = Number.POSITIVE_INFINITY, s?: number): string {
    return (dir === "in" ? this.inText : this.outText)
      .filter((d) => d.t >= fromT && d.t < toT && (s === undefined || d.s === s))
      .map((d) => d.delta)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  }
}

/**
 * The socket the LiveSession talks through: every frame in and out is recorded on its way. `drop()`
 * is a network drop: the session sees an abnormal close (1006) at once and nothing from the server
 * after it, and reports `connection_lost` itself; the socket underneath is closed so the server ends
 * the session and its meter.
 */
class TapSocket implements WebSocketLike {
  private onopen_: ((ev: unknown) => void) | null = null;
  private onmessage_: ((ev: { data: unknown }) => void) | null = null;
  private onerror_: ((ev: unknown) => void) | null = null;
  private onclose_: ((ev: { code: number; reason: string }) => void) | null = null;
  private dropped = false;

  constructor(
    private readonly inner: WebSocketLike,
    private readonly rec: Recorder,
    private readonly s: number,
  ) {}

  get readyState(): number {
    return this.inner.readyState;
  }
  send(data: string): void {
    this.rec.onClient(this.s, data);
    this.inner.send(data);
  }
  close(code?: number, reason?: string): void {
    this.rec.sockets.push({ t: this.rec.t(), s: this.s, what: "client close" });
    this.inner.close(code, reason);
  }
  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.rec.sockets.push({ t: this.rec.t(), s: this.s, what: "drop" });
    this.inner.onmessage = null;
    this.inner.onerror = null;
    this.inner.onclose = null;
    try {
      this.inner.close(4000, "live-check drop");
    } catch {
      // Closed already: the session still hears the drop below.
    }
    this.rec.sockets.push({ t: this.rec.t(), s: this.s, what: "closed (drop)", code: 1006 });
    this.onclose_?.({ code: 1006, reason: "" });
  }
  get onopen(): ((ev: unknown) => void) | null {
    return this.onopen_;
  }
  set onopen(fn: ((ev: unknown) => void) | null) {
    this.onopen_ = fn;
    this.inner.onopen = fn;
  }
  get onmessage(): ((ev: { data: unknown }) => void) | null {
    return this.onmessage_;
  }
  set onmessage(fn: ((ev: { data: unknown }) => void) | null) {
    this.onmessage_ = fn;
    this.inner.onmessage = fn
      ? (ev) => {
          if (this.dropped) return;
          // Stamped before the session dispatches it: whatever the engine does with the frame (the gate a stop
          // fragment sets) happens at or after this time. Recorded after, so a hook reads the engine's reaction.
          const t = this.rec.t();
          fn(ev);
          this.rec.onServer(this.s, ev.data, t);
        }
      : null;
  }
  get onerror(): ((ev: unknown) => void) | null {
    return this.onerror_;
  }
  set onerror(fn: ((ev: unknown) => void) | null) {
    this.onerror_ = fn;
    this.inner.onerror = fn;
  }
  get onclose(): ((ev: { code: number; reason: string }) => void) | null {
    return this.onclose_;
  }
  set onclose(fn: ((ev: { code: number; reason: string }) => void) | null) {
    this.onclose_ = fn;
    this.inner.onclose = fn
      ? (ev) => {
          if (this.dropped) return;
          this.rec.sockets.push({ t: this.rec.t(), s: this.s, what: `closed ${ev.reason || ""}`.trim(), code: ev.code });
          fn(ev);
        }
      : null;
  }
}

// ---- the dry server: GPT-Live, scripted ---------------------------------------------------------

/** Dry only: the stand-in misbehaving on purpose, for the tests that prove a judge catches what it is there to catch. */
export interface DryFaults {
  /** It never barges in: a reply plays on over Kevin's speech, and a spoken stop does not end it (LC-6 must fail). */
  readonly noBargeIn?: boolean;
  /** When its first reply ends, it sends no output audio for this many wall ms while the meter goes on (LC-1 must fail). */
  readonly audioHoleMs?: number;
  /** It delegates a typed line Jarhead already handled, as a model may (LC-9's reconcile, exercised offline). */
  readonly delegateHandled?: boolean;
  /**
   * Live's shape in LC-6 trial 2 (2026-10-06): its barge-in cuts the reply's transcript at once while the sound runs on
   * `tailMs`, and the transcript of Kevin's words lands `inputLagMs` after the audio carrying them.
   */
  readonly lateStop?: { readonly inputLagMs: number; readonly tailMs: number };
  /**
   * GPT-Live-1's farewell timing, in real ms (it tests the engine's real-time farewell constants): a farewell append, or
   * a typed dismissal, gets its " night." transcript `replyMs` later, then about 300 ms of sound starting `soundLagMs`
   * after the transcript; session.close is answered `closeMs` later. LC-4 measured 1.75 s, 166 to 466 ms and 630 ms.
   */
  readonly liveFarewell?: { readonly replyMs: number; readonly soundLagMs: number; readonly closeMs: number };
  /**
   * It answers room talk nobody addressed, as GPT-Live-1 did in LC-7 (2026-10-06). `reply-and-delegate`: it also
   * delegates the command-shaped lines. `reply-only`: it answers and never delegates.
   */
  readonly answersRoom?: "reply-and-delegate" | "reply-only";
  /** It writes the haiku itself and delegates nothing, as GPT-Live-1 did in LC-9 (2026-10-06). */
  readonly composesItself?: boolean;
}

/**
 * What the stand-in plays by default in a dry run of a check, when the caller names no faults: GPT-Live-1 as the paid
 * runs measured it, where the engine's answer to that behaviour is what the check is for. LC-7 (2026-10-06, 034251-542
 * and 002009-399): GPT-Live-1 answered the room and delegated its commands, F4's orders notwithstanding, so a dry LC-7
 * exercises the room-talk gate, not a voice that keeps quiet on its own. `dryFaults: {}` asks for the quiet stand-in.
 */
export const DRY_AS_MEASURED: Partial<Record<CheckId, DryFaults>> = { "LC-7": { answersRoom: "reply-and-delegate" } };

/** GPT-Live-1's order: a reply's first words, then its sound (LC-7 5/5 replies 160-350 ms; LC-5 text 1586 ms, sound 1888 ms medians). */
const DRY_WORDS_FIRST_MS = 200;

/** GPT-Live-1's usage beat: every 15 s (LC-1, median 14,998 ms). A dry run compresses it, to no less than 250 ms. */
const USAGE_BEAT_MS = 15_000;
const DRY_MIN_USAGE_BEAT_MS = 250;
/** GPT-Live-1 sends no output audio, silence included, from this long after a mute (3.37 s, LC-2) until the unmute. */
const MUTE_DRAIN_MS = 3400;
/** How long the stand-in's live-like farewell sounds (LC-4: the word was 200 to 300 ms). */
const FAREWELL_SOUND_MS = 300;
/** A dismissal the grammar takes whole: typed, the stand-in says "night." and delegates nothing; heard, it delegates. */
const DISMISSAL = /\b(that'?s all for now|go to sleep)\b/i;

/**
 * A stand-in for the GPT-Live server, behind the same WebSocket interface: it answers
 * session.start, bills one second per wall second, sends the usage beat every 15 s of the check's
 * timeline, streams output audio continuously while the mic is open (silence between replies; none
 * from 3.4 s after a mute until the unmute), reads the dry synthesizer's mark back as input
 * transcript, barges in on speech, delegates what a request names, speaks what it is told, answers a
 * typed dismissal with "night." and no delegation (GPT-Live-1, LC-4), refuses an append over the
 * 500-token cap with an error, and closes on session.close. It is a fixture for the scenarios, not a
 * model: the live run is the evidence. `faults` make it misbehave on purpose (DryFaults).
 */
class DryServer {
  private seq = 0;
  sessions = 0;
  /** The audio hole is opened once, after the run's first reply. */
  holeOpened = false;
  /** `scale`: the run's wall ms per check ms, which paces the usage beat and the mute's drain. */
  constructor(
    readonly faults: DryFaults = {},
    readonly scale: number = DRY_SCALE,
  ) {}
  newSocket(): DrySocket {
    this.sessions++;
    return new DrySocket(this, `dry_sess_${this.sessions}`);
  }
  nextId(prefix: string): string {
    this.seq++;
    return `${prefix}_${this.seq}`;
  }
}

/** Wall ms per output frame and per word the stand-in speaks. */
const DRY_FRAME_MS = 10;
const DRY_FRAMES_PER_WORD = 2;
const DRY_SILENCE_MS = 50;

const LONG_STORY = "The sea was grey that morning and the boats sat low in the harbour while the gulls argued over the nets and an old sailor told anyone who would listen about the storm of his youth".split(" ");

class DrySocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  private startedWall = 0;
  private started = false;
  private timers = new Set<NodeJS.Timeout>();
  private silence: NodeJS.Timeout | undefined;
  private meter: NodeJS.Timeout | undefined;
  /** The reply sounding now: `stop` ends it, `cutTranscript` ends only its words (DryFaults.lateStop). */
  private speaking: { stop: () => void; cutTranscript: () => void } | undefined;
  private heard: { total: number; received: number; words: string[]; emitted: number; text: string } | undefined;
  private delegationSeq = 0;
  /** No output audio before this wall time (DryFaults.audioHoleMs). */
  private holeUntil = 0;
  /** Muted: no output audio at all from this wall time (MUTE_DRAIN_MS after the mute) until the unmute. */
  private drainedFrom: number | undefined;
  /** Instruction appends that arrive together are read as one (a typed line chunked into context, then "respond"). */
  private typedBuffer = "";
  private typedTimer: NodeJS.Timeout | undefined;
  private static readonly SILENT = Buffer.alloc((SAMPLE_RATE * 2 * DRY_FRAME_MS) / 1000).toString("base64");
  private static readonly SOUND = tone(DRY_FRAME_MS).toString("base64");

  constructor(
    private readonly server: DryServer,
    private readonly id: string,
  ) {
    this.later(5, () => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private vms(): number {
    return this.startedWall === 0 ? 0 : Date.now() - this.startedWall;
  }

  private deliver(ev: Record<string, unknown>): void {
    if (this.readyState !== 1) return;
    if (ev["type"] === "session.output_audio.delta" && this.drainedFrom !== undefined && Date.now() >= this.drainedFrom) return;
    this.onmessage?.({ data: JSON.stringify(ev) });
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(ev["type"] ?? "");
    const clientEventId = typeof ev["event_id"] === "string" ? ev["event_id"] : undefined;
    switch (type) {
      case "session.start":
        return this.later(10, () => this.start());
      case "session.input_audio.append":
        return this.onAudio(Buffer.from(String(ev["audio"] ?? ""), "base64"));
      case "session.input_audio.mute":
      case "session.input_audio.unmute": {
        const mute = type === "session.input_audio.mute";
        this.drainedFrom = mute ? Date.now() + MUTE_DRAIN_MS * this.server.scale : undefined;
        return this.deliver({ type: mute ? "session.input_audio.muted" : "session.input_audio.unmuted", event_id: this.server.nextId("ev"), ...(clientEventId ? { client_event_id: clientEventId } : {}) });
      }
      case "session.instructions.append":
      case "session.commentary.append":
      case "session.thinking.append":
        return this.onAppend(type, String(ev["content"] ?? ""), clientEventId, ev["delegation_id"]);
      case "session.close":
        return this.later(this.server.faults.liveFarewell?.closeMs ?? 20, () => {
          this.deliver({ type: "session.closed", event_id: this.server.nextId("ev"), reason: "close_requested", session: this.resource(), usage: { seconds: this.billed() } });
          this.close(1000, "");
        });
      default:
        return;
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.halt();
    setTimeout(() => this.onclose?.({ code, reason }), 2);
  }

  private halt(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.silence) clearInterval(this.silence);
    if (this.meter) clearInterval(this.meter);
    this.speaking?.stop();
  }

  private resource(): Record<string, unknown> {
    return { id: this.id, expires_at: Math.floor(Date.now() / 1000) + 3600, model: LIVE_MODEL, status: "active" };
  }

  private billed(): number {
    return Math.round(this.vms() / 100) / 10;
  }

  private start(): void {
    this.startedWall = Date.now();
    this.started = true;
    this.deliver({ type: "session.started", event_id: this.server.nextId("ev"), session: this.resource() });
    const beat = Math.max(DRY_MIN_USAGE_BEAT_MS, USAGE_BEAT_MS * this.server.scale);
    this.meter = setInterval(() => this.deliver({ type: "session.usage.updated", event_id: this.server.nextId("ev"), usage: { seconds: this.billed() } }), beat);
    this.silence = setInterval(() => {
      if (!this.speaking && Date.now() >= this.holeUntil) this.deliver({ type: "session.output_audio.delta", delta: DrySocket.SILENT });
    }, DRY_SILENCE_MS);
  }

  /** `wordsFirstMs`: the first word's transcript goes at once and the sound follows this much later, as GPT-Live-1 orders them. */
  private say(text: string, o: { readonly long?: boolean; readonly wordsFirstMs?: number } = {}): void {
    this.speaking?.stop();
    const words = o.long ? Array.from({ length: 400 }, (_, i) => LONG_STORY[i % LONG_STORY.length]!) : text.split(/\s+/).filter(Boolean);
    let frame = 0;
    let word = 0;
    let transcribing = true;
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    const sayWord = (): void => {
      const s = this.vms();
      this.deliver({ type: "session.output_transcript.delta", event_id: this.server.nextId("ev"), delta: ` ${words[word]}`, start_ms: s, end_ms: s + DRY_FRAME_MS * DRY_FRAMES_PER_WORD });
      word++;
    };
    const sound = (): void => {
      timer = setInterval(() => {
        this.deliver({ type: "session.output_audio.delta", delta: DrySocket.SOUND });
        if (transcribing && frame % DRY_FRAMES_PER_WORD === 0 && word < words.length) sayWord();
        frame++;
        if (word >= words.length && frame % DRY_FRAMES_PER_WORD === 0) stop();
      }, DRY_FRAME_MS);
    };
    const stop = (): void => {
      ended = true;
      if (timer) clearInterval(timer);
      if (this.speaking === speaking) this.speaking = undefined;
      const hole = this.server.faults.audioHoleMs ?? 0;
      if (hole > 0 && !this.server.holeOpened) {
        this.server.holeOpened = true;
        this.holeUntil = Date.now() + hole;
      }
    };
    const speaking = { stop, cutTranscript: (): void => void (transcribing = false) };
    this.speaking = speaking;
    if (o.wordsFirstMs !== undefined && words.length > 0) {
      sayWord();
      this.later(o.wordsFirstMs, () => {
        if (!ended) sound();
      });
    } else sound();
  }

  /**
   * "night.", as GPT-Live-1 says it (DryFaults.liveFarewell): the transcript `replyMs` after the ask, then
   * FAREWELL_SOUND_MS of sound from `soundLagMs` after the transcript. Otherwise at once, like any reply.
   */
  private night(): void {
    const live = this.server.faults.liveFarewell;
    if (!live) return this.later(20, () => this.say("night."));
    this.later(live.replyMs, () => {
      const s = this.vms();
      this.deliver({ type: "session.output_transcript.delta", event_id: this.server.nextId("ev"), delta: " night.", start_ms: s, end_ms: s + FAREWELL_SOUND_MS });
      this.later(live.soundLagMs, () => {
        this.speaking?.stop();
        let n = 0;
        const timer = setInterval(() => {
          this.deliver({ type: "session.output_audio.delta", delta: DrySocket.SOUND });
          if (++n >= FAREWELL_SOUND_MS / DRY_FRAME_MS) stop();
        }, DRY_FRAME_MS);
        const stop = (): void => {
          clearInterval(timer);
          if (this.speaking === sound) this.speaking = undefined;
        };
        const sound = { stop, cutTranscript: (): void => undefined };
        this.speaking = sound;
      });
    });
  }

  private onAudio(chunk: Buffer): void {
    if (!this.started) return;
    const mark = readDryMark(chunk);
    if (mark) {
      // Speech: the reply in flight stops a moment later (the server's own barge-in).
      if (this.speaking && !this.server.faults.noBargeIn) {
        const speaking = this.speaking;
        const late = this.server.faults.lateStop;
        if (late) {
          this.later(150, () => speaking.cutTranscript());
          this.later(150 + late.tailMs, () => speaking.stop());
        } else this.later(150, () => speaking.stop());
      }
      this.heard = { total: mark.total, received: 0, words: mark.text.split(/\s+/).filter(Boolean), emitted: 0, text: mark.text };
    }
    const h = this.heard;
    if (!h) return;
    h.received += chunk.length;
    const due = Math.min(h.words.length, Math.ceil((h.words.length * h.received) / h.total));
    while (h.emitted < due) {
      const s = this.vms();
      const delta = { type: "session.input_transcript.delta", event_id: this.server.nextId("ev"), delta: ` ${h.words[h.emitted]}`, start_ms: s - 60, end_ms: s };
      const lag = this.server.faults.lateStop?.inputLagMs ?? 0;
      if (lag > 0) this.later(lag, () => this.deliver(delta));
      else this.deliver(delta);
      h.emitted++;
    }
    if (h.received >= h.total) {
      this.heard = undefined;
      this.later(30, () => this.kevinSaid(h.text, "heard"));
    }
  }

  private onAppend(type: string, content: string, clientEventId: string | undefined, delegationId: unknown): void {
    if (estimateTokens(content) > APPEND_TOKEN_CAP) {
      this.deliver({ type: "error", event_id: this.server.nextId("ev"), error: { type: "invalid_request_error", code: "append_too_large", message: `content is ${estimateTokens(content)} tokens; the cap is ${APPEND_TOKEN_CAP}`, ...(clientEventId ? { client_event_id: clientEventId } : {}) } });
      return;
    }
    const channel = type.slice("session.".length, type.lastIndexOf("."));
    const s = this.vms();
    this.deliver({ type: `session.${channel}.appended`, event_id: this.server.nextId("ev"), ...(clientEventId ? { client_event_id: clientEventId } : {}), start_ms: s, end_ms: s });
    if (type === "session.thinking.append") return;
    if (type === "session.commentary.append") return this.later(20, () => this.say(content));
    if (/Say exactly one word/.test(content)) return this.night();
    if (/going to sleep in about/.test(content)) return this.later(20, () => this.say("Going to sleep."));
    if (/cancelled the task/.test(content)) return this.later(20, () => this.say("Okay."));
    if (type !== "session.instructions.append") return;
    this.typedBuffer += `${this.typedBuffer ? " " : ""}${content}`;
    if (this.typedTimer) clearTimeout(this.typedTimer);
    this.typedTimer = setTimeout(() => {
      this.typedTimer = undefined;
      const all = this.typedBuffer;
      this.typedBuffer = "";
      if (!/\btyped\b/.test(all)) return;
      if (/Jarhead already (did it|answered it|handled it)/.test(all)) {
        if (this.server.faults.delegateHandled) this.delegate();
        return this.say("Done.");
      }
      const quoted = /typed[^"]*"([\s\S]*)"/.exec(all)?.[1];
      this.kevinSaid(quoted ?? all, "typed");
    }, 30);
    this.timers.add(this.typedTimer);
  }

  private delegate(afterMs = 20): void {
    this.delegationSeq++;
    const id = `dlg_${this.id}_${this.delegationSeq}`;
    this.later(afterMs, () => this.deliver({ type: "session.delegation.created", event_id: this.server.nextId("ev"), offset_ms: this.vms(), delegation: { id, type: "delegation", target: "client" } }));
  }

  /**
   * What the stand-in does with words it was given: delegate a request, speak an answer, or stay quiet for room talk. A
   * typed dismissal gets "night." and no delegation, as GPT-Live-1 did (LC-4, 0 of 3 delegated); a heard one is delegated.
   */
  private kevinSaid(text: string, how: "typed" | "heard"): void {
    const t = text.trim();
    const addressed = /^(hey )?jarhead\b/i.test(t);
    const faults = this.server.faults;
    if (/^(stop|cancel|never mind)\b/i.test(t) || /^jarhead,? stop\b/i.test(t)) return;
    if (how === "typed" && DISMISSAL.test(t)) return this.night();
    if (faults.composesItself && /haiku/i.test(t)) return this.say("Whiskers in moonlight, soft paws stitch the silence, night holds its breath.");
    const task = /\b(scroll|haiku|what'?s on my screen|rename|clean up)\b/i.test(t) || DISMISSAL.test(t);
    if (task && (addressed || how === "typed" || DISMISSAL.test(t))) return this.delegate(how === "heard" ? 60 : 20);
    if (how === "heard" && !addressed) {
      if (!faults.answersRoom) return;
      // GPT-Live-1 in LC-7: an answer to every room line, its words before its sound, and a delegation for each command.
      if (faults.answersRoom === "reply-and-delegate" && [...ROOM_COMMANDS.values()].some((word) => word.test(t))) {
        this.say("on it. done.", { wordsFirstMs: DRY_WORDS_FIRST_MS });
        return this.delegate(60);
      }
      return this.say("yeah, sounds right.", { wordsFirstMs: DRY_WORDS_FIRST_MS });
    }
    if (/long story/i.test(t)) return this.say("", { long: true });
    if (/count slowly to five/i.test(t)) return this.say("One. Two. Three. Four. Five.");
    if (/what did i ask you to count to/i.test(t)) return this.say("You asked me to count to five.");
    const word = /reply with the word (\w+)/i.exec(t)?.[1];
    if (word) return this.say(`${word}.`);
    return this.say("Okay, here is a short answer.");
  }
}

// ---- the fences --------------------------------------------------------------------------------

const SPAWN_NAMES = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;

interface Fences {
  /** The fetch the fence was installed over (the live run's synthesizer and the key probe go through it). */
  readonly realFetch: typeof fetch;
  /** The WebSocket class the fence was installed over (the live run's one socket is built from it). */
  readonly RealWebSocket: typeof WebSocket | undefined;
  restore(): void;
}

/** The free key probe the engine makes at start: GET /v1/models/<model>. The one request a run lets out (live) or answers (dry). */
const KEY_PROBE = /^\/v1\/models\/[\w.:-]+$/;

function installFences(rec: Recorder, mode: Mode): Fences {
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  globalThis.fetch = async function fenced(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const what = `${method} ${url.origin}${url.pathname}`;
    if (method === "GET" && url.origin === "https://api.openai.com" && KEY_PROBE.test(url.pathname)) {
      if (mode === "dry") {
        rec.net.push({ t: rec.t(), verdict: "answered", what });
        return new Response(JSON.stringify({ id: url.pathname.split("/").pop(), object: "model", owned_by: "live-check" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      rec.net.push({ t: rec.t(), verdict: "passed", what });
      return realFetch(input, init);
    }
    rec.net.push({ t: rec.t(), verdict: "refused", what });
    throw new TypeError(`refused by live-check: ${what} is not a request a check makes`);
  } as typeof fetch;
  if (RealWebSocket) {
    globalThis.WebSocket = class FencedWebSocket {
      constructor(address: string | URL) {
        const url = new URL(String(address));
        rec.net.push({ t: rec.t(), verdict: "refused", what: `WebSocket ${url.origin}${url.pathname}` });
        throw new Error(`refused by live-check: a WebSocket to ${url.origin} that is not the check's own`);
      }
    } as unknown as typeof WebSocket;
  }
  // Child processes: none. The hands are fakes, the brain is canned, the shell is a stub. The CommonJS
  // exports are patched and synced into the ESM bindings (the test preload does the same for fs).
  const cp = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  for (const name of SPAWN_NAMES) {
    saved.set(name, cp[name]);
    cp[name] = (cmd: unknown): never => {
      rec.spawns.push({ t: rec.t(), what: `${name} ${String(cmd).slice(0, 120)}` });
      throw new Error(`refused by live-check: ${name} ${String(cmd)} (no child process runs in a check)`);
    };
  }
  syncBuiltinESMExports();
  return {
    realFetch,
    RealWebSocket,
    restore: () => {
      globalThis.fetch = realFetch;
      if (RealWebSocket) globalThis.WebSocket = RealWebSocket;
      for (const [name, fn] of saved) cp[name] = fn;
      syncBuiltinESMExports();
    },
  };
}

// ---- the key and the synthesizer -----------------------------------------------------------------

/**
 * The OpenAI key for a live run, by the app's own rule (packages/core/src/env.ts, OWNED_KEYS): the state dir's env
 * file wins, so a stale key a shell profile exports never shadows the one Setup wrote; the environment's is the
 * fallback. Only the OPENAI_API_KEY lines are read (the last one wins, as loadEnv reads them).
 */
export function readOpenAIKey(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): { readonly key: string; readonly source: string } | undefined {
  const file = join(stateDirOf(env, home), "env");
  let fromFile: string | undefined;
  if (existsSync(file)) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/.exec(raw);
      const v = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2");
      if (v) fromFile = v;
    }
  }
  if (fromFile) return { key: fromFile, source: file.startsWith(home) ? `~${file.slice(home.length)}` : file };
  const fromEnv = env["OPENAI_API_KEY"]?.trim();
  if (fromEnv) return { key: fromEnv, source: "the environment" };
  return undefined;
}

type Synth = (text: string) => Promise<{ readonly pcm: Buffer; readonly cached: boolean }>;

function liveSynth(key: string, realFetch: typeof fetch, cacheDir: string, rec: Recorder): Synth {
  return async (text) => {
    const name = createHash("sha256").update(`${TTS_MODEL}\n${TTS_VOICE}\n${text}`).digest("hex").slice(0, 24);
    const file = join(cacheDir, `${name}.pcm`);
    if (existsSync(file)) return { pcm: readFileSync(file), cached: true };
    const what = "POST https://api.openai.com/v1/audio/speech";
    rec.net.push({ t: rec.t(), verdict: "passed", what });
    const r = await realFetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "pcm", instructions: "Speak naturally at a normal pace, as a person talking in a room." }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`speech synthesis failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const pcm = Buffer.from(await r.arrayBuffer());
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, pcm);
    return { pcm, cached: false };
  };
}

const drySynth: Synth = async (text) => ({ pcm: drySpeech(text), cached: false });

// ---- the canned brain ----------------------------------------------------------------------------

/** What the canned brain answers. No model: the words are fixed. */
export function cannedAnswer(request: string): string {
  if (/haiku/i.test(request)) return "Soft paws on the sill. A slow blink at the morning. The cat owns the light.";
  if (/screen/i.test(request)) return "Notes is in front, with an untitled note open.";
  return "Done.";
}

/**
 * The main brain for a check: it attaches the runner for its turn as a real brain does, records the
 * task, and answers at once with a canned line. In `slow` mode it plays the brain V1 is about: it
 * ignores its abort signal and keeps asking for a tool every 300 ms until `cancel()` is called, each
 * request judged by the daemon's own guard (`runner.attached === false` refuses it).
 */
class CannedBrain implements Brain {
  readonly kind = "live-check-canned";
  mode: "answer" | "slow" = "answer";
  readonly tasks: { readonly t: number; readonly delegationId: string; readonly request: string }[] = [];
  readonly cancels: number[] = [];
  readonly toolCalls: { readonly t: number; readonly name: string; readonly accepted: boolean }[] = [];
  /** Ends the slow turn in flight (cancel, or the brain stopped by a restart). */
  private endTurn: (() => void) | undefined;
  engine: Engine | undefined;

  /** `stepMs`: the slow turn's pace between tool requests (300 ms live; a dry run compresses it). */
  constructor(
    private readonly rec: Recorder,
    private readonly stepMs = 300,
  ) {}

  async start(): Promise<{ ready: boolean; detail: string }> {
    return { ready: true, detail: "canned answers, no model" };
  }

  async handle(task: BrainTask, sink: BrainSink): Promise<BrainResult> {
    const engine = this.engine;
    if (!engine) return { status: "failed", error: "no engine" };
    this.tasks.push({ t: this.rec.t(), delegationId: task.delegationId, request: task.request.slice(0, 300) });
    engine.runner.attach(sink, task);
    try {
      if (this.mode === "slow") return await this.slow(engine);
      await sleep(50);
      return { status: "done", summary: cannedAnswer(task.request) };
    } finally {
      engine.runner.attach(undefined);
    }
  }

  private async slow(engine: Engine): Promise<BrainResult> {
    let ended = false;
    const wake = new Promise<void>((r) => (this.endTurn = () => ((ended = true), r())));
    for (let i = 0; i < 200 && !ended; i++) {
      await Promise.race([sleep(this.stepMs), wake]);
      if (ended) break;
      // The daemon's guard on tool.run (packages/daemon/src/server.ts): no task attached, nothing runs.
      const accepted = engine.runner.attached;
      this.toolCalls.push({ t: this.rec.t(), name: "frontmost_app", accepted });
      if (accepted) await engine.runner.run("frontmost_app", {}).catch(() => undefined);
    }
    return { status: "cancelled" };
  }

  async cancel(): Promise<void> {
    this.cancels.push(this.rec.t());
    this.endTurn?.();
  }

  async stop(): Promise<void> {
    this.endTurn?.();
  }
}

type MemoryService = NonNullable<NonNullable<EngineOptions["memory"]>["service"]>;

/** Memory that learns nothing and recalls nothing: no store, no embedding, no extractor, no request. */
const NULL_MEMORY: MemoryService = {
  ingestSession: async () => ({ status: "skipped", reason: "nothing-new", added: 0, updated: 0, noop: 0, refused: 0, ms: 0 }),
  prime: async () => undefined,
  retrieveForBrain: async () => ({ tokens: 0, ids: [] }),
  retrieveForVoice: () => ({ tokens: 0, ids: [] }),
  remember: async () => undefined,
  forgetRecent: () => 0,
  forget: () => false,
  restore: () => false,
  edit: () => false,
  list: () => [],
  search: async () => [],
  summary: () => ({ count: 0, forgotten: 0, archived: 0, embeddings: "keyword" }),
  consolidateStep: async () => ({ merged: 0, archived: 0, done: true }),
  reembed: async () => 0,
  flush: () => undefined,
};

// ---- the context a scenario runs in ----------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** The logger's own default sink (packages/core/src/log.ts), put back after a run: info to stdout, warnings to stderr. */
const consoleSink = (level: LogLevel, scope: string, message: string): void => {
  const line = `${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${scope}: ${message}\n`;
  if (level === "error" || level === "warn") process.stderr.write(line);
  else process.stdout.write(line);
};

class CheckAborted extends Error {
  constructor(readonly why: string) {
    super(`the check stopped: ${why}`);
  }
}

/** Feeds the engine a mic frame every 40 ms while the check runs: silence, or the next frame of a spoken line. */
class MicPump {
  private queue: { frame: Buffer; audible: boolean; done?: (t: number) => void }[] = [];
  private timer: NodeJS.Timeout | undefined;
  private t0 = 0;
  private sent = 0;
  lastAudibleT = 0;

  constructor(
    private readonly engine: Engine,
    private readonly rec: Recorder,
  ) {}

  start(): void {
    this.t0 = Date.now();
    this.timer = setInterval(() => this.tick(), FRAME_MS / 2);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const q of this.queue) q.done?.(this.rec.t());
    this.queue = [];
  }

  /** Queue a spoken line; resolves with the time its last audible frame was fed. */
  say(pcm: Buffer): Promise<number> {
    return new Promise((resolve) => {
      const fs = frames(pcm);
      let last = fs.length - 1;
      while (last > 0 && rms16(fs[last]!) < AUDIBLE_RMS) last--;
      fs.forEach((frame, i) => this.queue.push({ frame, audible: i <= last, ...(i === fs.length - 1 ? { done: () => resolve(this.lastAudibleT) } : {}) }));
    });
  }

  private tick(): void {
    const due = Math.floor((Date.now() - this.t0) / FRAME_MS) - this.sent;
    // A stalled loop catches up a few frames at a time, never a burst.
    for (let i = 0; i < Math.min(due, 5); i++) {
      const next = this.queue.shift();
      this.engine.feedMic(next?.frame ?? SILENT_FRAME);
      if (next?.audible) this.lastAudibleT = this.rec.t();
      next?.done?.(this.rec.t());
      this.sent++;
    }
    if (due > 5) this.sent += due - 5;
  }
}

export interface Ctx {
  readonly mode: Mode;
  readonly engine: Engine;
  readonly rec: Recorder;
  readonly brain: CannedBrain;
  readonly acting: FakeHands;
  readonly reading: FakeHands;
  readonly signal: AbortSignal;
  readonly oversize: boolean;
  /** The idle setting the check runs under (LC-7), in ms of wall clock. */
  readonly idleMs: number;
  /** Wall ms for a span of the check's own timeline (dry runs compress it). */
  ms(checkMs: number): number;
  wait(checkMs: number): Promise<void>;
  waitWall(ms: number): Promise<void>;
  until(cond: () => boolean, wallMs: number): Promise<boolean>;
  mark(name: string, data?: Record<string, unknown>): number;
  go(): Promise<void>;
  typed(text: string): Promise<number>;
  /**
   * Feed a spoken line as mic frames. `ear`: also hand its words to the ear the way the app's on-device recognizer
   * does (engine.ear, as the daemon's socket does): partials as the words are spoken, then a final. The harness has no
   * app, so without this the ear hears nothing; LC-7 needs it, since the ear is the half of B5 Live never reaches.
   */
  speak(text: string, o?: { readonly ear?: boolean }): Promise<{ readonly startT: number; readonly endT: number }>;
  /**
   * The reply to something sent at `sinceT`: until an audible output frame arrives after it, then
   * until none has arrived for `quietWallMs`; at most `maxWallMs` in all. False when no reply came.
   */
  reply(sinceT: number, quietWallMs: number, maxWallMs: number): Promise<boolean>;
  live(): LiveSession | undefined;
  /** Send one client event on the newest socket as it is, past the engine and the session (it is recorded like any other). */
  raw(ev: Record<string, unknown>): void;
  /** Close the newest socket underneath its session (the session sees connection_lost). */
  drop(): void;
  phase(): string;
}

// ---- the scenarios ---------------------------------------------------------------------------------

type Scenario = (ctx: Ctx) => Promise<void>;

/** LC-1: the longest a silent session may go between output audio frames before "continuous" is false (VS-26). */
export const LC1_AUDIO_GAP_MAX_MS = 2000;

const LC5_QUESTIONS = ["What is two plus two?", "What color is the sky on a clear day?", "Name one fruit.", "What day comes after Monday?", "How many legs does a cat have?", "What is the capital of France?", "Say a word that rhymes with cat.", "What is ten minus three?", "Name a planet.", "What sound does a dog make?"];

/**
 * LC-6, after the gate lapses: how long the harness watches what reaches the speaker, and how much sound may (an
 * acknowledgement such as "Okay, I'll stop." is about four words; the story going on is far more). A dry run's
 * stand-in speaks a word every DRY_FRAMES_PER_WORD x DRY_FRAME_MS, so its four words are 80 ms; its watch is at
 * least 600 ms of wall clock so a story that plays on cannot hide inside a compressed window.
 */
export const LC6_AFTER_GATE_WATCH_MS = 4000;
const DRY_MIN_AFTER_GATE_WATCH_MS = 600;
export const LC6_ACK_MAX_MS = 1500;
const ACK_WORDS = 4;

/** The lines a check speaks, synthesized before its session opens (synthesis never runs on billed seconds). */
const LC6_LINES = ["Jarhead, tell me a long story about the sea.", "Stop, Jarhead."];
const LC10_LINE = "Jarhead, what's on my screen?";

/**
 * LC-7's room: talk nobody addresses to Jarhead, in this order, once the opening exchange's window has shut. Each line
 * starts 15 s after the last one ends. Three lines are commands the reflex grammar takes (a video's "hit the like
 * button", a colleague's "press enter"): the ear must leave them to Live and Live must let them be (B5, RX-23).
 * - The first line is a command, so the room's first words are judged cold.
 * - The goodnight comes before the idle limit. A farewell to someone else is not a dismissal.
 * - Two commands are adjacent. A delegation's request starts where Live's last one ended, so a second command Live
 *   delegated would reach the Delegator bare, where its one-step reflex runs on the hands.
 * Live, the room opens 9 s after the opening answer, and a line starts about 18 s after the last one did (its own
 * length, then 15 s). So lines start about 9, 27, 45 and 63 s after that answer. The clause comes at 55 s and the sleep
 * at 60 s. Before the sleep live hears the first command, the goodnight and "Press enter.". "Hit the like button."
 * waits for the window the clause reopens, so it is spoken only as the asleep line. The adjacent pair is exercised dry
 * only.
 */
export const ROOM_TALK = [
  "Scroll down a bit.",
  "Okay I'm heading out, goodnight.",
  "Press enter.",
  "Hit the like button.",
  "Did you see the game last night? It went to overtime.",
  "I think we need more coffee filters, we are almost out.",
  "My sister is visiting next weekend, she is bringing the dog.",
  "Let's order pizza tonight from the place on the corner.",
] as const;

/** The command-shaped room lines, and the word that shows Live heard each one. */
export const ROOM_COMMANDS: ReadonlyMap<string, RegExp> = new Map([
  ["Scroll down a bit.", /\bscroll/i],
  ["Hit the like button.", /\blike\b/i],
  ["Press enter.", /\benter\b/i],
]);

/**
 * The engine's exchange window (Engine.EXCHANGE_WINDOW_MS): Go, and Jarhead's own words, make the next 8 s
 * mid-exchange, and a command spoken then may run without the name. Room talk is judged outside it only.
 */
const EXCHANGE_WINDOW_MS = Engine.EXCHANGE_WINDOW_MS;
/** How long past its end a spoken line can still move the ear (the last transcript delta, then the ear's decision). */
const LINE_SETTLE_MS = 1500;
/** When the app's recognizer finalizes a line after its last word (Ctx.speak with `ear`). */
const EAR_FINAL_AFTER_MS = 300;
/**
 * LC-7's idle limit in a dry run, in wall ms, counted like the live one from the opening exchange's answer. The engine's
 * clocks are not compressed: the room starts EXCHANGE_WINDOW_MS + 1 s after that answer and the pre-sleep clause comes
 * 5 s before the limit, so the dry room talks for 2 x EXCHANGE_WINDOW_MS + 4 s before the clause, a line every second
 * or two: all of ROOM_TALK, both adjacent commands and the goodnight among it.
 */
const LC7_DRY_IDLE_MS = 3 * EXCHANGE_WINDOW_MS + 10_000;

/** The idle limit a check runs under, in wall ms: LC-7's (60 s live, LC7_DRY_IDLE_MS or more dry), else 10 min. */
export function idleMsFor(id: CheckId, mode: Mode, scale: number): number {
  if (id !== "LC-7") return 10 * 60_000;
  return mode === "dry" ? Math.max(LC7_DRY_IDLE_MS, 60_000 * scale * 2) : 60_000;
}

/** LC-7: the hands ops that read the Mac and never act on it (the Delegator's first look, the AX tree, the handshake). */
const LC7_READ_OPS: ReadonlySet<string> = new Set(["hello", "screenshot", "ax_tree", "frontmost_app", "user_idle", "list_windows", "find_element", "focused_text", "read_focused_text"]);

/**
 * When the exchange window last opened before `at`: Go, or the latest words Jarhead said and Kevin heard — a frame on
 * the speaker at the engine's own level, not GPT-Live-1's words going by on the wire. An answer to the room the engine
 * dropped (the room-talk gate) opens no exchange, in the engine or here.
 */
function exchangeOpenedAt(rec: Recorder, goT: number, at: number): number {
  let last = goT;
  for (const f of rec.sink) if (f.t <= at && f.t > last && engineHears(f)) last = f.t;
  return last;
}

/** LC-7: how long after the pre-sleep clause's instruction its own words may sound (the clause is asked for; it is no reply to the room). */
const LC7_CLAUSE_SOUND_MS = 4000;
/** LC-7: how long after a refused room delegation the voice's words are kept as that close-out's record. */
const LC7_CLOSE_OUT_WATCH_MS = 4000;

/** LC-3's paste: 2,700 characters, the instruction that proves it was read to the end in its last sentence. */
export function pasteText(): string {
  const end = " End of the note. To show you read it to the end, reply with the word periwinkle.";
  const filler = "The garden needs work this spring. The tomatoes go along the south fence, the beans by the shed, and the herbs in the raised bed nearest the kitchen door. Water early, before the heat. ";
  let body = "";
  while (body.length < 2700 - end.length) body += filler;
  return body.slice(0, 2700 - end.length).trimEnd().padEnd(2700 - end.length, ".") + end;
}

/**
 * LC-3 --oversize: one raw append of varied prose, well over the 500-token cap by any tokenizer. It has at least
 * OVERSIZE_MIN_WORDS words, and a tokenizer gives every word at least one token, so it is at least three times the
 * cap whatever the real count; at about 4 characters a token it is closer to four times. (A repeated filler line
 * measured by the harness's own chars/3.2 looked over the cap and was not: a real tokenizer read it as about 490.)
 */
export const OVERSIZE_MIN_WORDS = 3 * APPEND_TOKEN_CAP;

export function oversizeText(): string {
  // Four lists of coprime lengths (12, 11, 13, 7): no sentence repeats before the 12,012th.
  const who = ["The ferry captain", "A retired teacher", "Our neighbour's cousin", "The night baker", "A surveyor from the county", "The choir director", "Two cyclists", "The harbour pilot", "A beekeeper", "The museum guard", "An apprentice carpenter", "The orchard owner"];
  const did = ["repainted the blue shutters", "counted forty-one herons", "mended the torn sail", "planted rows of late cabbage", "measured the flooded meadow", "rehearsed an old hymn", "carried lanterns up the hill", "charted the shifting sandbar", "moved six hives to clover", "found a lost umbrella", "planed a warped door"];
  const when = ["before dawn on Tuesday", "during the long drizzle", "after the market closed", "while the tide turned", "on the coldest morning in March", "just after the bells", "under a copper sky", "between two squalls", "at the end of the harvest", "near midnight", "in the quiet hour after lunch", "as the fog lifted", "on the first warm evening"];
  const why = ["because nobody else would", "to settle a friendly wager", "for the spring fair", "since the old one had cracked", "so the children could see", "as a favour to the mayor", "to keep a promise"];
  const lines: string[] = ["This is a test of the append cap, a note far longer than one append may carry."];
  for (let i = 0; lines.join(" ").split(/\s+/).length < OVERSIZE_MIN_WORDS + 60; i++) {
    lines.push(`Entry ${i + 1}: ${who[i % who.length]} ${did[i % did.length]} ${when[i % when.length]}, ${why[i % why.length]}.`);
  }
  return lines.join(" ");
}

/** What each check speaks (its synthesis is done, and paid for, before the session opens). */
const SPOKEN: Partial<Record<CheckId, readonly string[]>> = { "LC-6": LC6_LINES, "LC-7": ROOM_TALK, "LC-10": [LC10_LINE] };

const SCENARIOS: Record<CheckId, Scenario> = {
  "LC-1": async (c) => {
    await c.go();
    const typed = await c.typed("Say hello in five words.");
    await c.reply(typed, Math.max(150, c.ms(2000)), c.ms(10_000) + 2000);
    c.mark("silence.start");
    await c.wait(50_000);
    c.mark("silence.end");
    c.mark("stop");
    await c.engine.pressStop("live-check");
  },
  "LC-2": async (c) => {
    await c.go();
    const goT = c.mark("go.1");
    await c.typed("Count slowly to five.");
    await c.wait(8000);
    c.engine.setMuted(true);
    c.mark("mute");
    await c.wait(20_000);
    c.engine.setMuted(false);
    c.mark("unmute");
    await c.waitWall(Math.max(0, goT + c.ms(40_000) - c.rec.t()));
    c.mark("pause");
    await c.engine.pause();
    await c.wait(3000);
    c.mark("go.2");
    await c.go();
    const asked = await c.typed("What did I ask you to count to?");
    c.mark("typed.2");
    await c.reply(asked, Math.max(150, c.ms(2000)), c.ms(15_000) + 2000);
    c.mark("stop");
    await c.engine.pressStop("live-check");
    await c.wait(3000);
  },
  "LC-3": async (c) => {
    await c.go();
    c.mark("paste");
    const pasted = await c.typed(pasteText());
    await c.reply(pasted, Math.max(150, c.ms(2500)), c.ms(20_000) + 2000);
    if (c.oversize) {
      // The premise itself: one raw append well over the cap, past the engine and the session, straight to the socket.
      const content = oversizeText();
      c.mark("oversize", { chars: content.length, words: content.split(/\s+/).length, tokensAt4: Math.ceil(content.length / 4), estimate: estimateTokens(content) });
      c.raw({ type: "session.instructions.append", event_id: "live_check_oversize", delegation_id: null, content });
      await c.wait(5000);
    }
    c.mark("stop");
    await c.engine.pressStop("live-check");
  },
  "LC-4": async (c) => {
    for (let trial = 1; trial <= 3; trial++) {
      await c.go();
      await c.wait(1500);
      c.mark("farewell", { trial });
      await c.typed("that's all for now");
      await c.until(() => c.phase() === "asleep" && c.live()?.currentState === "closed", FAREWELL_START_MS + FAREWELL_CAP_MS + 4000);
      c.mark("asleep", { trial, phase: c.phase() });
      await c.wait(1000);
    }
  },
  "LC-5": async (c) => {
    await c.go();
    await c.wait(1500);
    for (const [i, q] of LC5_QUESTIONS.entries()) {
      c.mark("ask", { i });
      const sent = await c.typed(q);
      await c.reply(sent, Math.max(150, c.ms(1200)), c.ms(10_000) + 1000);
    }
    c.mark("stop");
    await c.engine.pressStop("live-check");
  },
  "LC-6": async (c) => {
    await c.go();
    await c.wait(1500);
    for (let trial = 1; trial <= 3; trial++) {
      c.mark("story", { trial });
      const story = await c.speak(LC6_LINES[0]!);
      // Let the reply play for a few seconds (dry: the stand-in starts at once).
      await c.until(() => c.rec.audible(undefined, story.endT).length > 0, c.ms(12_000) + 1000);
      await c.wait(4000);
      c.mark("stop.speech", { trial });
      const stop = await c.speak(LC6_LINES[1]!);
      c.mark("stop.spoken", { trial, endT: stop.endT });
      // The gate's window, whole: from Live's stop fragment (the gate mark carries when it came) to its lapse.
      const gateMark = (): { readonly t: number; readonly name: string; readonly data?: Record<string, unknown> } | undefined => c.rec.marks.find((m) => m.name === "gate" && m.data?.["trial"] === trial);
      await c.until(() => gateMark() !== undefined, c.ms(6000) + 2000);
      const fragmentT = Number(gateMark()?.data?.["fragmentT"] ?? c.rec.t());
      await c.waitWall(fragmentT + OUTPUT_GATE_MS - c.rec.t());
      c.mark("after", { trial, open: c.live()?.currentState === "started", phase: c.phase() });
      // Then what plays once it lapses: an acknowledgement at most, never the story going on.
      await c.waitWall(Math.max(c.ms(LC6_AFTER_GATE_WATCH_MS), DRY_MIN_AFTER_GATE_WATCH_MS));
    }
    c.mark("stop");
    await c.engine.pressStop("live-check");
  },
  "LC-7": async (c) => {
    await c.go();
    const goT = c.mark("go");
    // Kevin's last addressed turn, as in the world: a typed line and its answer. The room starts only once the window
    // that answer opened has shut, so no room line can pass for Kevin's next words, and the judge times the sleep from it.
    const typed = await c.typed("Say hello in five words.");
    await c.reply(typed, Math.max(150, c.ms(1500)), c.ms(10_000) + 2000);
    c.mark("anchor");
    await c.until(() => c.rec.t() - exchangeOpenedAt(c.rec, goT, c.rec.t()) > EXCHANGE_WINDOW_MS + 1000, EXCHANGE_WINDOW_MS + 4000);
    const deadline = c.rec.t() + Math.max(c.ms(100_000), c.idleMs + 6000);
    let i = 0;
    while (c.rec.t() < deadline && c.phase() !== "asleep") {
      const line = ROOM_TALK[i % ROOM_TALK.length]!;
      const command = ROOM_COMMANDS.has(line);
      // A command is room talk only outside the exchange window: wait for it to close (live, 15 s apart, it already
      // has; dry, the window is the engine's own 8 s). The judge still decides per line from what was recorded.
      if (command) await c.until(() => c.phase() === "asleep" || c.rec.t() - exchangeOpenedAt(c.rec, goT, c.rec.t()) > EXCHANGE_WINDOW_MS + 500, Math.max(0, deadline - c.rec.t()));
      if (c.phase() === "asleep" || c.rec.t() >= deadline) break;
      c.mark("room", { i, line, command });
      await c.speak(line, { ear: true });
      i++;
      const next = c.rec.t() + c.ms(15_000);
      await c.until(() => c.phase() === "asleep", Math.max(0, Math.min(next, deadline) - c.rec.t()));
    }
    c.mark("end", { phase: c.phase() });
    // Room talk goes on a little after the sleep: nothing reopens.
    if (c.phase() === "asleep") {
      const line = ROOM_TALK[i % ROOM_TALK.length]!;
      c.mark("room", { i, line, command: ROOM_COMMANDS.has(line), asleep: true });
      await c.speak(line, { ear: true });
      await c.wait(2000);
    } else {
      c.mark("stop");
      await c.engine.pressStop("live-check");
    }
  },
  "LC-8": async (c) => {
    c.brain.mode = "slow";
    // (a) the drop, then Stop.
    await c.go();
    await c.wait(1500);
    c.mark("a.task");
    const before = c.brain.tasks.length;
    await c.typed("Jarhead, rename every file on my desktop slowly, one at a time.");
    if (!(await c.until(() => c.brain.tasks.length > before, c.ms(15_000) + 2000))) c.mark("a.no-task");
    await c.wait(1500);
    c.mark("a.drop");
    c.drop();
    await c.wait(1000);
    c.mark("a.stop");
    await c.engine.pressStop("live-check");
    await c.waitWall(1500);
    c.mark("a.end", { attached: c.engine.runner.attached, phase: c.phase() });
    await c.wait(1500);
    // (b) the drop, Pause 100 ms later, then Go.
    await c.go();
    await c.wait(1500);
    c.mark("b.task");
    const before2 = c.brain.tasks.length;
    await c.typed("Jarhead, rename every file on my desktop slowly, one at a time.");
    if (!(await c.until(() => c.brain.tasks.length > before2, c.ms(15_000) + 2000))) c.mark("b.no-task");
    await c.wait(1500);
    c.mark("b.drop");
    c.drop();
    await c.waitWall(100);
    c.mark("b.pause");
    await c.engine.pause();
    await c.wait(3000);
    c.mark("b.held", { phase: c.phase() });
    c.mark("b.go");
    await c.go();
    await c.wait(3000);
    c.mark("b.stop");
    await c.engine.pressStop("live-check");
    await c.waitWall(1500);
  },
  "LC-9": async (c) => {
    await c.go();
    await c.wait(1500);
    c.mark("scroll");
    const scrolled = await c.typed("Jarhead, scroll down.");
    await c.reply(scrolled, Math.max(150, c.ms(2000)), c.ms(8000) + 1000);
    c.mark("haiku");
    const asked = await c.typed("Jarhead, write me a haiku about cats.");
    // Live's reply first: the haiku itself (composing is not on its delegation list), or "on it" and a delegation.
    await c.reply(asked, Math.max(150, c.ms(2500)), c.ms(15_000) + 1000);
    // Only when Live delegated: the canned brain's task, then the reply from the moment the brain saw it.
    const task = (): { readonly t: number } | undefined => c.brain.tasks.find((x) => x.t >= asked && /haiku/i.test(x.request));
    if (c.rec.delegations.some((d) => d.t >= asked)) {
      await c.until(() => task() !== undefined, c.ms(15_000) + 2000);
      const handed = task();
      if (handed) await c.reply(handed.t, Math.max(150, c.ms(2500)), c.ms(15_000) + 1000);
    }
    c.mark("stop");
    await c.engine.pressStop("live-check");
  },
  "LC-10": async (c) => {
    await c.go();
    await c.wait(1500);
    for (let trial = 1; trial <= 5; trial++) {
      const before = c.rec.delegations.length;
      c.mark("ask", { trial });
      const said = await c.speak(LC10_LINE);
      c.mark("spoken", { trial, endT: said.endT });
      await c.until(() => c.rec.delegations.length > before, c.ms(8000) + 1000);
      await c.reply(c.rec.delegations.at(-1)?.t ?? said.endT, Math.max(150, c.ms(1500)), c.ms(10_000) + 1000);
    }
    c.mark("stop");
    await c.engine.pressStop("live-check");
  },
};

// ---- the judges ---------------------------------------------------------------------------------------

export interface Assertion {
  readonly name: string;
  readonly pass: boolean;
  /** Reported and never fails the check (a range to record, a number to compare by eye). */
  readonly soft?: boolean;
  readonly value?: unknown;
  readonly expect?: string;
}

/** What a judge reads: a run's recorder and the engine as the run left it, or the same rebuilt from a saved report (scripts/rejudge.mts). */
export interface Judge {
  readonly rec: Recorder;
  readonly ledger: readonly LedgerRow[];
  readonly snapshot: Pick<Snapshot, "usageToday" | "delegations">;
  readonly brain: Pick<CannedBrain, "tasks" | "cancels" | "toolCalls">;
  readonly acting: Pick<FakeHands, "calls">;
  readonly reading: Pick<FakeHands, "calls">;
  readonly idleMs: number;
  readonly oversize: boolean;
  readonly mode: Mode;
  /** Wall ms of check start, for ledger and hands timestamps. */
  readonly wall0: number;
  /** Multiplies the ceilings that time this Mac's own work (a dry run on a slow CI runner); 1 for every live run. */
  readonly slack: number;
  /** Wall ms per check ms (dry runs compress the check's timeline; 1 live). */
  readonly scale: number;
  expect(name: string, pass: boolean, value?: unknown, expect?: string, o?: { readonly soft?: boolean }): void;
  metric(name: string, value: unknown): void;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? Number.NaN;
}

const median = (values: readonly number[]): number => percentile(values, 50);
const normWord = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

/** Words too common to say whose sentence they came from, and the words of Kevin's own LC-6 lines (an acknowledgement may echo them). */
const COMMON_WORDS = new Set(
  "about above after again against also always another anything around away back because been before being below between both came come could didnt does doing done down each even ever every first from going gone good have having here into just keep know last like little long made make many more most much must never next okay once only other over really right said same should some something sorry still story such sure tell than that thats their them then there these they thing think this those though through time told very wait want well were what when where which while will with would yeah your alright stop stopped stopping jarhead".split(" "),
);

/** The distinctive words of a passage: four letters or more, not common ones. */
function contentWords(text: string): Set<string> {
  return new Set(normWord(text).split(" ").filter((w) => w.length >= 4 && !COMMON_WORDS.has(w)));
}
const rowsOf = <T extends LedgerRow["type"]>(ledger: readonly LedgerRow[], type: T): Extract<LedgerRow, { type: T }>[] => ledger.filter((r): r is Extract<LedgerRow, { type: T }> => r.type === type);

export const JUDGES: Record<CheckId, (j: Judge) => void> = {
  "LC-1": (j) => {
    const w0 = j.rec.markT("silence.start");
    const w1 = j.rec.markT("silence.end");
    if (w0 === undefined || w1 === undefined) return j.expect("the silence window ran", false);
    const inWindow = j.rec.server.filter((f) => f.s === 0 && f.t >= w0 && f.t <= w1);
    const times = [w0, ...inWindow.map((f) => f.t), w1];
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const maxGap = Math.max(...gaps);
    const audio = inWindow.filter((f) => f.type === "session.output_audio.delta");
    const lastQuarter = audio.filter((f) => f.t >= w1 - (w1 - w0) / 4).length;
    // Output audio on its own: the meter's frames keep the all-frames gap small even when the audio stops (VS-26).
    const audioTimes = [w0, ...audio.map((f) => f.t), w1];
    const audioGaps = audioTimes.slice(1).map((t, i) => t - audioTimes[i]!);
    const audioGapMax = Math.max(...audioGaps);
    const audioGapCeil = j.mode === "dry" ? Math.max(LC1_AUDIO_GAP_MAX_MS * j.scale, 4 * DRY_SILENCE_MS) * j.slack : LC1_AUDIO_GAP_MAX_MS;
    const usageTimes = j.rec.usage.filter((u) => u.s === 0).map((u) => u.t);
    const usageGaps = usageTimes.slice(1).map((t, i) => t - usageTimes[i]!);
    j.metric("silenceWindowMs", w1 - w0);
    j.metric("framesInWindow", inWindow.length);
    j.metric("audioFramesInWindow", audio.length);
    j.metric("frameGapP99Ms", percentile(gaps, 99));
    j.metric("frameGapMaxMs", maxGap);
    j.metric("outputAudioGapP99Ms", percentile(audioGaps, 99));
    j.metric("outputAudioGapMaxMs", audioGapMax);
    j.metric("usageIntervalMedianMs", median(usageGaps));
    j.metric("usageIntervalMaxMs", usageGaps.length ? Math.max(...usageGaps) : Number.NaN);
    j.metric("recommendedWatchdogMs", Math.max(5000, 5 * maxGap));
    j.expect("output audio keeps arriving while silent", audio.length > 0 && lastQuarter > 0, { audio: audio.length, lastQuarter }, "audio frames through the whole window");
    j.expect("no output-audio gap over 2 s while silent (Live's audio is continuous)", audioGapMax <= audioGapCeil, Math.round(audioGapMax), `<= ${Math.round(audioGapCeil)} ms between output_audio.delta frames`);
    j.expect("no server gap over 10 s while silent (a frame watchdog can tell quiet from dead)", maxGap <= 10_000, maxGap, "<= 10000 ms; else V3 needs another liveness signal");
  },
  "LC-2": (j) => {
    const go1 = j.rec.markT("go.1");
    const mute = j.rec.markT("mute");
    const unmute = j.rec.markT("unmute");
    const pause = j.rec.markT("pause");
    const stop = j.rec.markT("stop");
    // The session Go opened: open at the go.1 mark.
    const opened = go1 === undefined ? undefined : j.rec.sessions.filter((s) => s.startedT !== undefined && s.startedT <= go1 && (s.closedT === undefined || s.closedT > go1)).at(-1);
    const pauseRow = rowsOf(j.ledger, "pause")[0];
    // VS-8: Mute keeps the session. One session from Go to Pause: none drops or expires in between, and the pause
    // closes the one Go opened.
    if (opened && go1 !== undefined && pause !== undefined) {
      const cuts = j.rec.sessions.filter((s) => s.closedT !== undefined && s.closedT > go1 && s.closedT < pause && (s.closeReason === "connection_lost" || s.closeReason === "expired")).map((s) => `${s.closeReason}@${s.closedT}`);
      j.expect("Mute keeps one session from Go to Pause", cuts.length === 0 && pauseRow?.sessionId === opened.id, cuts, `no connection_lost or expired between go.1 and the pause, and the pause row names ${opened.id ?? "?"} (it names ${pauseRow?.sessionId ?? "none"})`);
    } else j.expect("Mute keeps one session from Go to Pause", false, opened ? "no go.1 or pause mark" : "no session open at go.1");
    // What the server's own meter said while muted, for the session that spans the mute: its usage beats, and its close
    // figure when it was closed on request. Never "0 before the first beat", and never the invoice.
    const spans = mute === undefined ? undefined : j.rec.sessions.find((s) => s.startedT !== undefined && s.startedT <= mute && (s.closedT === undefined || s.closedT > mute));
    if (mute !== undefined && unmute !== undefined && spans?.startedT !== undefined) {
      const closeFigure = spans.closedT !== undefined && spans.closeReason === "close_requested" ? [{ t: spans.closedT, s: spans.usage }] : [];
      const figures = [...j.rec.usage.filter((u) => u.s === spans.s).map((u) => ({ t: u.t, s: u.seconds })), ...closeFigure].sort((x, y) => x.t - y.t);
      const a = figures.filter((f) => f.t <= mute).at(-1) ?? { t: spans.startedT, s: 0 };
      // The first figure at or after the unmute; a session cut inside the mute has only its last figure before the cut.
      const b = figures.find((f) => f.t >= unmute) ?? figures.filter((f) => f.t > mute).at(-1);
      if (b) {
        const mutedWall = (Math.min(unmute, b.t) - mute) / 1000;
        const advanced = Math.round((b.s - a.s - ((b.t - a.t) / 1000 - mutedWall)) * 10) / 10;
        j.metric("usageWhileMutedSeconds", advanced);
        j.metric("mutedWallSeconds", mutedWall);
        j.metric("usageWhileMutedBasis", { session: spans.id, from: a, to: b });
        j.expect("the server's meter while muted (quoted, not the invoice)", advanced >= mutedWall * 0.75, advanced, `of ${mutedWall} s muted`, { soft: true });
      } else j.expect("the server's meter while muted (quoted, not the invoice)", false, "no server figure after the mute", undefined, { soft: true });
    } else j.expect("the mute window ran", false);
    // The row is judged against the wall time of the session Go opened: a split session shows here as a short row.
    if (pauseRow && opened?.startedT !== undefined) {
      const wall = (pauseRow.at - j.wall0 - opened.startedT) / 1000;
      j.metric("pauseRowUsageSeconds", pauseRow.usageSeconds);
      j.metric("pauseWallSeconds", wall);
      j.metric("pauseSessionServerSeconds", rowsOf(j.ledger, "session.closed").find((r) => r.sessionId === opened.id)?.usageSeconds);
      j.expect("the pause row's usageSeconds is within 2 s of wall time", Math.abs(pauseRow.usageSeconds - wall) <= 2 * j.slack, pauseRow.usageSeconds, `${wall.toFixed(1)} +/- ${2 * j.slack} s`);
    } else j.expect("a pause row was written", false, rowsOf(j.ledger, "pause").length);
    const go2 = j.rec.markT("go.2");
    const resumed = go2 === undefined ? undefined : j.rec.sessions.find((s) => s.createdT >= go2);
    j.expect("the resumed session carries # Continuity", resumed?.continuity === true, resumed?.continuity);
    const typed2 = j.rec.markT("typed.2");
    const answer = typed2 === undefined ? "" : j.rec.text("out", typed2, stop);
    j.metric("answer", answer);
    j.expect("the answer names five", /\bfive\b|\b5\b/i.test(answer), answer);
    const last = j.rec.sessions.at(-1);
    if (stop !== undefined && last?.closedT !== undefined) {
      j.metric("closeAfterStopMs", last.closedT - stop);
      j.expect("after Stop the session is closed within 1 s", last.closedT - stop <= 1000 * j.slack, last.closedT - stop, `<= ${1000 * j.slack} ms`);
      const after = j.rec.server.filter((f) => f.s === last.s && f.t > last.closedT! + 50).length;
      j.expect("no frames after the close", after === 0, after);
    } else j.expect("the last session closed after Stop", false);
    const closed = rowsOf(j.ledger, "session.closed").reduce((a, r) => a + r.usageSeconds, 0);
    const meter = j.snapshot.usageToday?.seconds ?? Number.NaN;
    j.metric("meterSeconds", meter);
    j.metric("closedRowsSeconds", closed);
    j.expect("the meter equals the sum of the closed rows", Math.abs(meter - closed) <= 0.5, meter, `${closed} s`);
  },
  "LC-3": (j) => {
    const paste = j.rec.markT("paste") ?? 0;
    const probe = j.rec.marks.find((m) => m.name === "oversize")?.data;
    if (probe) {
      j.metric("oversizeChars", probe["chars"]);
      j.metric("oversizeWords", probe["words"]);
      j.metric("oversizeTokensAt4Chars", probe["tokensAt4"]);
      j.metric("oversizeTokensEstimate", probe["estimate"]);
    }
    const end = j.rec.markT("oversize") ?? j.rec.markT("stop");
    const appends = j.rec.client.filter((f) => f.tokens !== undefined && f.t >= paste && (end === undefined || f.t < end));
    const maxTokens = Math.max(0, ...appends.map((f) => f.tokens ?? 0));
    j.metric("appends", appends.length);
    j.metric("maxAppendTokens", maxTokens);
    j.expect("every append is within 500 tokens (chunked)", appends.length > 0 && maxTokens <= APPEND_TOKEN_CAP, maxTokens, `<= ${APPEND_TOKEN_CAP}`);
    const errors = j.rec.errors.filter((e) => e.t >= paste && (end === undefined || e.t < end));
    j.expect("no error event", errors.length === 0, errors.map((e) => `${e.code}: ${e.message}`));
    const reply = j.rec.text("out", paste, end);
    j.metric("reply", reply.slice(0, 300));
    j.expect("the reply refers to the end of the paste", /periwinkle/i.test(reply), reply.slice(0, 120));
    const over = j.rec.markT("oversize");
    if (j.oversize && over !== undefined) {
      const e = j.rec.errors.filter((x) => x.t >= over);
      j.expect("one oversize append gives an error event (the cap premise)", e.length > 0, e.map((x) => `${x.code}: ${x.message}`));
    }
  },
  "LC-4": (j) => {
    const starts = j.rec.marks.filter((m) => m.name === "farewell");
    starts.forEach((m, i) => {
      const trial = i + 1;
      const next = starts[i + 1]?.t ?? Number.POSITIVE_INFINITY;
      const session = j.rec.sessions.filter((s) => s.startedT !== undefined && s.startedT <= m.t).at(-1);
      const said = normWord(j.rec.text("out", m.t, next, session?.s));
      const closedT = session?.closedT;
      // What Kevin hears: frames on the speaker sink in this trial, sound at the engine's own level. The wire's frames
      // keep arriving through the close's round trip after the engine has let the session go, and play nothing.
      const end = Math.min(next, closedT ?? Number.POSITIVE_INFINITY);
      const sink = j.rec.sink.filter((f) => f.t >= m.t && f.t < end);
      const heard = sink.filter(engineHears);
      const firstAudio = heard[0]?.t;
      const rmsKept = sink.filter((f) => f.rms !== undefined);
      j.metric(`trial${trial}`, { said, firstAudioT: firstAudio, heardMs: heard.reduce((a, f) => a + f.ms, 0), closedT, maxRms: rmsKept.length ? Math.max(...rmsKept.map((f) => f.rms!)) : undefined });
      j.expect(`trial ${trial}: the farewell is exactly "night."`, said === "night", said, "night");
      j.expect(`trial ${trial}: the farewell reaches the speaker`, heard.length > 0, heard.length, ">= 1 sink frame at the engine's audible level");
      // From the first heard frame; when none was heard, from the farewell's first words on the wire.
      const from = firstAudio ?? j.rec.outText.find((d) => d.t >= m.t && d.t < next && (session === undefined || d.s === session.s))?.t;
      const lag = from !== undefined && closedT !== undefined ? closedT - from : Number.NaN;
      j.expect(`trial ${trial}: closed within 1.8 s of the first farewell audio`, lag <= FAREWELL_CAP_MS * j.slack, lag, `<= ${FAREWELL_CAP_MS * j.slack} ms`);
      const asleep = j.rec.marks.filter((x) => x.name === "asleep")[i]?.data?.["phase"];
      j.expect(`trial ${trial}: the phase is asleep`, asleep === "asleep", asleep);
    });
    j.expect("three trials ran", starts.length === 3, starts.length);
  },
  "LC-5": (j) => {
    // A typed line reaches GPT-Live-1 as one session.instructions.append (the API takes no user text item, and has no
    // faster input), so the clock splits in two. The engine's share is judged: the send to its append on the wire, and
    // the first audible frame on to the speaker sink. Live's share (the append's ack, its words, its voice) is quoted.
    const asks = j.rec.marks.filter((m) => m.name === "ask");
    const latencies: number[] = [];
    const transcriptLatencies: number[] = [];
    const ownSendMs: number[] = [];
    const appendedMs: number[] = [];
    const sinkLagMs: number[] = [];
    asks.forEach((m, i) => {
      const next = asks[i + 1]?.t ?? Number.POSITIVE_INFINITY;
      const first = j.rec.audible(undefined, m.t, next)[0];
      if (first) {
        latencies.push(first.t - m.t);
        const heard = j.rec.sink.find((f) => f.audible && f.t >= first.t && f.t < next);
        if (heard) sinkLagMs.push(heard.t - first.t);
      }
      const words = j.rec.outText.find((d) => d.t >= m.t && d.t < next);
      if (words) transcriptLatencies.push(words.t - m.t);
      const sent = j.rec.client.find((f) => f.type === "session.instructions.append" && f.t >= m.t && f.t < next);
      if (sent) ownSendMs.push(sent.t - m.t);
      const acked = j.rec.server.find((f) => f.type === "session.instructions.appended" && f.t >= m.t && f.t < next);
      if (acked) appendedMs.push(acked.t - m.t);
    });
    const spread = (values: readonly number[]): { readonly median: number; readonly max: number } => ({ median: median(values), max: values.length ? Math.max(...values) : Number.NaN });
    j.metric("n", latencies.length);
    j.metric("firstAudioMs", latencies);
    j.metric("firstAudioMedianMs", median(latencies));
    j.metric("firstAudioP90Ms", percentile(latencies, 90));
    j.metric("firstTranscriptMedianMs", median(transcriptLatencies));
    j.metric("ownSendMs", ownSendMs);
    j.metric("appendedMedianMs", median(appendedMs));
    j.metric("sinkLagMs", sinkLagMs);
    j.metric("date", localDay());
    j.expect("ten questions answered", latencies.length === 10, latencies.length);
    const send = spread(ownSendMs);
    j.expect("the engine's share: typed send to its append on the wire, median <= 20 ms and none over 250 ms", ownSendMs.length === 10 && send.median <= 20 * j.slack && send.max <= 250 * j.slack, send, `10 sends, median <= ${20 * j.slack} ms, max <= ${250 * j.slack} ms`);
    const sink = spread(sinkLagMs);
    j.expect("the engine's share: first audible frame to the speaker sink, median <= 5 ms and none over 100 ms", sinkLagMs.length === 10 && sink.median <= 5 * j.slack && sink.max <= 100 * j.slack, sink, `10 frames, median <= ${5 * j.slack} ms, max <= ${100 * j.slack} ms`);
    j.expect("GPT-Live-1's typed path: typed send to first audible frame, median <= 2.5 s (quoted, not promised)", median(latencies) <= 2500 * j.slack, median(latencies), `<= ${2500 * j.slack} ms`, { soft: true });
  },
  "LC-6": (j) => {
    const stops = j.rec.marks.filter((m) => m.name === "stop.speech");
    const stories = j.rec.marks.filter((m) => m.name === "story");
    const end = j.rec.markT("stop") ?? Number.POSITIVE_INFINITY;
    const ackMaxMs = j.mode === "dry" ? ACK_WORDS * DRY_FRAMES_PER_WORD * DRY_FRAME_MS : LC6_ACK_MAX_MS;
    // The gap that ends a run of story audio: a pause between Live's sentences is shorter; dry, a stalled event loop is.
    const quietMs = j.mode === "dry" ? 300 * j.slack : 1000;
    stops.forEach((m, i) => {
      const trial = i + 1;
      const storyT = stories[i]?.t ?? 0;
      // Everything up to the next trial's story (the last trial: up to the closing Stop) belongs to this one.
      const nextT = stories[i + 1]?.t ?? end;
      const fragment = j.rec.heardAt(m.t, /\bstop\b/i);
      const gate = (j.rec.marks.find((x) => x.name === "gate" && x.data?.["trial"] === trial)?.data?.["gated"] as boolean | undefined) ?? false;
      // Everything below means something only if the story was sounding on the speaker when the stop came: sound, not
      // the silent frames Live streams between replies, in the 2 s before Kevin began to say stop.
      const playingMs = j.rec.audibleSinkMs(Math.max(storyT, m.t - 2000), m.t + 1);
      j.metric(`trial${trial}.storyAudibleBeforeStopMs`, Math.round(playingMs));
      j.expect(`trial ${trial}: the story was sounding on the speaker sink when the stop came`, playingMs > 0, Math.round(playingMs), "> 0 ms of sound in the 2 s before the stop");
      j.expect(`trial ${trial}: Live's " Stop" fragment arrived`, fragment !== undefined, fragment?.delta);
      // Live's own barge-in, unclipped by the gate: the run of story audio still arriving when the stop speech began,
      // to its first quiet (0 when nothing was arriving then); and the last sound Live sent at all before the next trial.
      const audible = j.rec.audible(undefined, m.t, nextT);
      let run: ServerFrame | undefined;
      for (const f of audible) {
        if (f.t - (run?.t ?? m.t) >= quietMs) break;
        run = f;
      }
      j.metric(`trial${trial}.bargeInMs`, run ? run.t - m.t : 0);
      j.metric(`trial${trial}.lastAudibleServerMs`, audible.at(-1) ? audible.at(-1)!.t - m.t : null);
      if (!fragment) return;
      j.metric(`trial${trial}.fragmentAfterSpeechMs`, fragment.t - m.t);
      j.expect(`trial ${trial}: the gate is set at the fragment`, gate, gate);
      // The fragment's time is stamped before the session dispatched it, so the gate the engine set for it runs to at
      // least fragment.t + OUTPUT_GATE_MS: any frame on the sink before then got past the gate.
      // Every frame counts, sound or Live's silence: this is the one live check of V10 (nothing plays while gated).
      const gateEnd = fragment.t + OUTPUT_GATE_MS;
      const inGate = j.rec.sink.filter((f) => f.t > fragment.t + 50 && f.t < gateEnd);
      j.metric(`trial${trial}.framesInGate`, inGate.length);
      j.metric(`trial${trial}.audibleInGate`, inGate.filter((f) => f.audible).length);
      j.expect(`trial ${trial}: 0 frames reach the speaker sink inside the gate`, inGate.length === 0, inGate.length, "0 (50 ms tolerance)");
      const after = j.rec.marks.filter((x) => x.name === "after")[i]?.data;
      j.expect(`trial ${trial}: the session stays open`, after?.["open"] === true && after?.["phase"] !== "asleep", after);
      // The gate only hides the story for 2.5 s. Once it lapses, the story must not come back: Live stopped it, so at
      // most a short acknowledgement sounds, and none of the story's words.
      const afterGateMs = j.rec.audibleSinkMs(gateEnd, nextT);
      const saidAfter = j.rec.text("out", gateEnd, nextT);
      j.metric(`trial${trial}.afterGateWatchMs`, Number.isFinite(nextT) ? nextT - gateEnd : null);
      j.metric(`trial${trial}.afterGateSaid`, saidAfter.slice(0, 200));
      j.expect(`trial ${trial}: after the gate lapses, at most an acknowledgement reaches the speaker sink`, afterGateMs <= ackMaxMs, Math.round(afterGateMs), `<= ${ackMaxMs} ms of sound until the next trial`);
      const storyWords = contentWords(j.rec.text("out", storyT, fragment.t));
      const shared = [...contentWords(saidAfter)].filter((w) => storyWords.has(w));
      j.expect(`trial ${trial}: none of the story's words after the gate lapses`, storyWords.size > 0 && shared.length === 0, storyWords.size > 0 ? shared : "no story words were heard before the stop", "none shared with what Live said before the stop");
    });
    j.expect("three trials ran", stops.length === 3, stops.length);
  },
  "LC-7": (j) => {
    const goMark = j.rec.markT("go") ?? j.rec.sessions[0]?.startedT ?? 0;
    const room = j.rec.marks.filter((m) => m.name === "room");
    const firstRoom = room[0]?.t ?? Number.POSITIVE_INFINITY;
    // The last addressed turn before the room (Go, the opening typed line, or the last word of Jarhead's answer to it):
    // the idle limit and the pre-sleep clause count from here.
    const lastAddressed = exchangeOpenedAt(j.rec, goMark, firstRoom);
    j.metric("lastAddressedBeforeRoomT", lastAddressed);
    j.expect("input transcripts arrive (the premise)", j.rec.inText.length > 0, j.rec.inText.length);
    // The room-talk gate: what Live raised is its own judgment, recorded; what reached the brain is the engine's. Each of
    // Live's room delegations must be on the ledger as refused ("not addressed"), with no commentary after it.
    const roomDelegations = j.rec.delegations.filter((d) => d.t >= firstRoom);
    j.metric("liveDelegatedRoom", roomDelegations.map((d) => d.id));
    const roomTasks = j.brain.tasks.filter((t) => t.t >= firstRoom);
    j.expect("no room talk reached the brain", roomTasks.length === 0, roomTasks.map((t) => t.request));
    j.expect("Live raised no delegation for room talk (its own judgment; the engine refuses what it raises)", roomDelegations.length === 0, roomDelegations.map((d) => d.id), undefined, { soft: true });
    const createdByLive = new Map(rowsOf(j.ledger, "delegation.created").map((r) => [r.delegation.liveId, r.delegation.id]));
    const finishedRows = new Map(rowsOf(j.ledger, "delegation.finished").map((r) => [r.delegationId, r]));
    const notRefused = roomDelegations.filter((d) => {
      const id = createdByLive.get(d.id);
      const end = id ? finishedRows.get(id) : undefined;
      return !(end?.status === "cancelled" && /^not addressed/.test(end.summary ?? ""));
    });
    const roomCommentary = j.rec.client.filter((f) => f.type === "session.commentary.append" && f.t >= firstRoom);
    j.expect("Live's room delegations were refused before the brain, and no commentary answered them", notRefused.length === 0 && roomCommentary.length === 0, { notRefused: notRefused.map((d) => d.id), commentary: roomCommentary.map((f) => f.head) }, "every room delegation cancelled 'not addressed', no commentary");
    // How each refusal was closed out for the voice, and what the voice said in the seconds after (heard by nobody): the
    // paid run settles whether the silent thinking append leaves less drift than an instructions append would.
    j.metric("refusedCloseOut", roomDelegations.map((d) => {
      const close = j.rec.client.find((f) => f.t >= d.t && f.type === "session.thinking.append" && /not said to you/i.test(f.head ?? ""));
      const from = close?.t ?? d.t;
      return { id: d.id, closedBy: close ? "session.thinking.append" : null, closedAfterMs: close ? close.t - d.t : null, voiceAfter: j.rec.text("out", from, from + LC7_CLOSE_OUT_WATCH_MS * j.scale) };
    }));
    // What ran: the engine's reflex events (the ear's, the delegator's prefire on Live's words) and the ear's rows.
    const reflexes = [...j.rec.reflexes.map((r) => ({ t: r.t, label: r.label })), ...j.rec.reflexRows.map((r) => ({ t: r.t, label: `${r.action} (${r.source} row${r.ok ? "" : ", failed"})` }))];
    // Each room line, and whether the exchange window was shut from its first word until the ear decided on it: more
    // than EXCHANGE_WINDOW_MS after Go and after anything Jarhead said, and Jarhead silent until the ear's final. What
    // Jarhead says after that is an answer to the line, and never puts the line inside the window.
    const lines = room.map((m, k) => {
      const line = String(m.data?.["line"] ?? "");
      const spoken = j.rec.speech.find((s) => s.text === line && s.startT >= m.t);
      const endT = spoken?.endT ?? m.t;
      const nextT = room[k + 1]?.t ?? Number.POSITIVE_INFINITY;
      const until = Math.min(nextT, endT + LINE_SETTLE_MS * 2);
      const earFinalT = j.rec.marks.find((x) => x.name === "ear.final" && x.data?.["text"] === line && x.t >= m.t && x.t < nextT)?.t ?? endT + EAR_FINAL_AFTER_MS;
      const shut = m.t - exchangeOpenedAt(j.rec, goMark, m.t) > EXCHANGE_WINDOW_MS && !j.rec.sink.some((f) => f.t > m.t && f.t <= earFinalT && engineHears(f));
      const outside = m.data?.["asleep"] === true || shut;
      const heard = j.rec.text("in", m.t, until);
      const word = ROOM_COMMANDS.get(line);
      return { line, startT: m.t, until, command: word !== undefined, outside, heard: word ? word.test(heard) : undefined, asleep: m.data?.["asleep"] === true, reflexes: reflexes.filter((r) => r.t >= m.t && r.t < until).map((r) => r.label) };
    });
    j.metric("roomLines", lines.map((l) => ({ line: l.line, startT: l.startT, command: l.command, outsideWindow: l.outside, heard: l.heard, asleep: l.asleep, reflexes: l.reflexes })));
    // A command inside the window may run (Kevin is mid-exchange): only its own reflexes are excused, nothing else.
    const excused = (t: number): boolean => lines.some((l) => l.command && !l.outside && t >= l.startT && t < l.until);
    const ran = reflexes.filter((r) => !excused(r.t));
    j.metric("reflexesInsideTheWindow", reflexes.filter((r) => excused(r.t)).map((r) => r.label));
    j.expect("no reflex ran on room talk (outside the exchange window)", ran.length === 0, ran.map((r) => r.label));
    const judged = lines.filter((l) => l.command && l.outside && !l.asleep && l.heard === true);
    const fedToEar = new Set(j.rec.marks.filter((m) => m.name === "ear.final").map((m) => String(m.data?.["text"] ?? "")));
    j.expect("command-shaped room talk was heard outside the exchange window (B5 exercised)", judged.length > 0 && judged.every((l) => fedToEar.has(l.line)), judged.map((l) => l.line), ">= 1 command line Live transcribed and the ear was given, while Jarhead was not mid-exchange");
    // What acts on the Mac, never what reads it: the Delegator's first look at the screen for a delegation is a read (the
    // delegation itself fails above), and the canned brain acts on nothing, so a key, a click or a scroll here is a reflex.
    const touched = j.acting.calls.filter((c) => !LC7_READ_OPS.has(c.op) && judged.some((l) => c.at - j.wall0 >= l.startT && c.at - j.wall0 < l.until)).map((c) => c.op);
    j.expect("the fake hands did nothing for those commands", touched.length === 0, touched);
    const said = rowsOf(j.ledger, "sleep").filter((r) => r.cause === "said");
    j.expect("no 'said goodnight' sleep row", said.length === 0, said.map((r) => r.phrase));
    const clause = j.rec.client.find((f) => f.type === "session.instructions.append" && /going to sleep in about/.test(f.head ?? ""));
    // From the first room line (the answer to the opening exchange is not a reply to the room): what reached the speaker,
    // the clause's own words aside (it was asked for). Then what Live said on the wire, heard by nobody: its judgment.
    const from = Number.isFinite(firstRoom) ? firstRoom : lastAddressed;
    const clauseSound = (t: number): boolean => clause !== undefined && t >= clause.t && t < clause.t + LC7_CLAUSE_SOUND_MS * j.scale;
    const heardReply = j.rec.sink.filter((f) => f.t >= from && engineHears(f) && !clauseSound(f.t));
    j.expect("no reply to the room reached the speaker", heardReply.length === 0, heardReply.map((f) => f.t), "0 frames at the engine's audible level after the first room line, the clause's own aside");
    const reply = j.rec.text("out", from, clause?.t ?? Number.POSITIVE_INFINITY);
    j.metric("roomReplyOnTheWire", reply);
    j.metric("liveSaidToTheRoom", j.rec.text("out", from));
    j.expect("Live said nothing to the room (its own judgment; the engine keeps it off the speaker)", reply === "", reply, undefined, { soft: true });
    const sleep = rowsOf(j.ledger, "sleep").find((r) => r.cause === "idle");
    const sleepT = sleep ? sleep.at - j.wall0 : undefined;
    const tol = Math.max(3000, j.idleMs * 0.1) * j.slack;
    j.metric("idleMs", j.idleMs);
    j.metric("clauseAfterLastAddressedMs", clause ? clause.t - lastAddressed : null);
    j.metric("sleepAfterLastAddressedMs", sleepT !== undefined ? sleepT - lastAddressed : null);
    if (j.idleMs > 5000) j.expect("the pre-sleep clause comes 5 s before the idle limit", clause !== undefined && Math.abs(clause.t - lastAddressed - (j.idleMs - 5000)) <= tol, clause ? clause.t - lastAddressed : null, `${j.idleMs - 5000} +/- ${tol} ms`);
    j.expect("sleep at the idle limit after the last addressed turn", sleepT !== undefined && Math.abs(sleepT - lastAddressed - j.idleMs) <= tol, sleepT !== undefined ? sleepT - lastAddressed : null, `${j.idleMs} +/- ${tol} ms`);
    const talkBefore = sleepT !== undefined && j.rec.speech.some((s) => s.endT <= sleepT && s.endT >= sleepT - 20_000);
    j.expect("the talk was going on when it slept", talkBefore, sleepT === undefined ? "never slept" : talkBefore);
  },
  "LC-8": (j) => {
    const aDrop = j.rec.markT("a.drop");
    const aStop = j.rec.markT("a.stop");
    const aEnd = j.rec.marks.find((m) => m.name === "a.end");
    const bTask = j.rec.markT("b.task") ?? Number.POSITIVE_INFINITY;
    j.expect("(a) the slow task reached the canned brain", j.rec.markT("a.no-task") === undefined && j.brain.tasks.length > 0, j.brain.tasks.length);
    if (aDrop !== undefined && aStop !== undefined) {
      const cancels = j.brain.cancels.filter((t) => t >= aDrop && t < bTask).length;
      j.expect("(a) the brain is cancelled once", cancels === 1, cancels);
      j.expect("(a) the runner is detached", aEnd?.data?.["attached"] === false, aEnd?.data?.["attached"]);
      j.expect("(a) the phase is asleep", aEnd?.data?.["phase"] === "asleep", aEnd?.data?.["phase"]);
      const accepted = j.brain.toolCalls.filter((c) => c.accepted && c.t > aStop && c.t < bTask).length;
      j.metric("a.toolCallsAfterStop", j.brain.toolCalls.filter((c) => c.t > aStop && c.t < bTask).length);
      j.expect("(a) no tool.run is accepted after Stop", accepted === 0, accepted);
      // B1 itself: the turn ends with its session, so nothing it asks for runs between the drop and the Stop either.
      const orphan = j.brain.toolCalls.filter((c) => c.accepted && c.t > aDrop + 50 && c.t < bTask).length;
      j.metric("a.toolCallsAfterDrop", j.brain.toolCalls.filter((c) => c.t > aDrop && c.t < bTask).length);
      j.expect("(a) no tool.run is accepted after the drop (the turn ends with its session)", orphan === 0, orphan);
    } else j.expect("(a) ran", false);
    const bDrop = j.rec.markT("b.drop");
    const bGo = j.rec.markT("b.go");
    const held = j.rec.marks.find((m) => m.name === "b.held");
    j.expect("(b) the slow task reached the canned brain", j.rec.markT("b.no-task") === undefined, j.rec.markT("b.no-task") === undefined);
    if (bDrop !== undefined && bGo !== undefined) {
      const startedBetween = j.rec.server.filter((f) => f.type === "session.started" && f.t > bDrop && f.t < bGo).length;
      j.expect("(b) no second session.started before Go", startedBetween === 0, startedBetween);
      j.expect("(b) Pause is held", held?.data?.["phase"] === "paused", held?.data?.["phase"]);
      const after = j.rec.sessions.filter((s) => s.createdT >= bGo);
      j.expect("(b) Go opens exactly one session", after.length === 1, after.length);
      j.expect("(b) with continuity", after[0]?.continuity === true, after[0]?.continuity);
    } else j.expect("(b) ran", false);
  },
  "LC-9": (j) => {
    const scroll = j.rec.markT("scroll") ?? 0;
    const haiku = j.rec.markT("haiku") ?? Number.POSITIVE_INFINITY;
    const scrolls = j.acting.calls.filter((c) => c.op === "scroll" && c.at - j.wall0 >= scroll && c.at - j.wall0 < haiku);
    const ms = scrolls[0] ? scrolls[0].at - j.wall0 - scroll : Number.NaN;
    j.metric("scrollMs", ms);
    j.expect("the scroll runs on the fake hands within 300 ms", ms <= 300 * j.slack, ms, `<= ${300 * j.slack} ms`);
    const scrollTasks = j.brain.tasks.filter((x) => x.t >= scroll && x.t < haiku);
    j.expect("the scroll never reaches the brain", scrollTasks.length === 0, scrollTasks.map((x) => x.request));
    // Live's delegations for the scroll, from the wire; the engine's record of each is read only when there is one.
    const liveDlg = j.rec.delegations.filter((d) => d.t >= scroll && d.t < haiku);
    j.metric("reconcileExercised", liveDlg.length > 0);
    if (liveDlg.length === 0) j.expect("Live's delegation for it reconciles as already done", false, "not exercised: Live made no delegation for the scroll", "a delegation, done without the brain", { soft: true });
    else {
      const dlg = j.snapshot.delegations.filter((d) => liveDlg.some((x) => x.id === d.liveId));
      j.metric("scrollDelegations", dlg.map((d) => ({ status: d.status, summary: d.summary, request: d.request.slice(0, 80) })));
      // Reconciled: done, and never handed to the brain (a canned brain would also say done, so status alone proves nothing).
      const toBrain = (d: (typeof dlg)[number]): boolean => j.brain.tasks.some((x) => x.delegationId === d.id || x.delegationId === d.liveId);
      const reconciled = dlg.filter((d) => d.status === "done" && !toBrain(d));
      j.expect("Live's delegation for it reconciles as already done", reconciled.length === liveDlg.length, dlg.map((d) => ({ status: d.status, summary: d.summary, toBrain: toBrain(d) })), `each of ${liveDlg.length}: done, and never handed to the brain`);
    }
    const ack = j.rec.text("out", scroll, haiku);
    j.expect("the reply acknowledges it", ack.length > 0, ack.slice(0, 120));
    // B4 is what reaches the hands, not who composes. The haiku is Kevin's either way: the canned brain's when Live
    // delegates it, or Live's own (composing is not on its delegation list; GPT-Live-1 wrote it itself, 2026-10-06). Live's
    // own words count only when it delegated nothing, and a delegation it makes must reach the brain (RF-1).
    const haikuTask = j.brain.tasks.find((x) => x.t >= haiku && /haiku/i.test(x.request));
    const haikuDlg = j.rec.delegations.filter((d) => d.t >= haiku);
    const said = j.rec.text("out", haiku);
    const own = haikuTask === undefined && haikuDlg.length === 0 && said.split(/\s+/).filter(Boolean).length >= 8;
    j.metric("haikuBy", haikuTask ? "brain" : own ? "voice" : "none");
    j.metric("haikuSaid", said.slice(0, 160));
    j.metric("haikuDelegations", haikuDlg.map((d) => d.id));
    j.expect("the haiku is composed: by the canned brain, or by Live itself", haikuTask !== undefined || own, haikuTask?.request ?? said.slice(0, 120), "a brain task, or 8 or more words from Live and no delegation");
    if (haikuDlg.length > 0) j.expect("Live's delegation for the haiku reaches the canned brain", haikuTask !== undefined, haikuDlg.map((d) => d.id));
    const types = [...j.acting.calls, ...j.reading.calls].filter((c) => c.op === "type" && c.at - j.wall0 >= scroll);
    j.expect("no type op on the hands", types.length === 0, types.map((c) => c.params["text"]));
  },
  "LC-10": (j) => {
    const asks = j.rec.marks.filter((m) => m.name === "ask");
    const spoken = j.rec.marks.filter((m) => m.name === "spoken");
    const harness: number[] = [];
    let ordered = 0;
    let measured = 0;
    asks.forEach((m, i) => {
      const next = asks[i + 1]?.t ?? Number.POSITIVE_INFINITY;
      const end = Number(spoken[i]?.data?.["endT"] ?? Number.NaN);
      const dlg = j.rec.delegations.find((d) => d.t >= m.t && d.t < next);
      if (dlg && Number.isFinite(end)) harness.push(dlg.t - end);
      const d = j.snapshot.delegations.find((x) => x.liveId === dlg?.id);
      if (d?.timings.speechEndAt !== undefined) {
        measured++;
        if (d.timings.speechEndAt <= d.timings.delegatedAt) ordered++;
      }
    });
    j.metric("n", harness.length);
    j.metric("speechEndToDelegationMs", harness);
    j.metric("speechEndToDelegationMedianMs", median(harness));
    j.metric("date", localDay());
    j.expect("five delegations", harness.length === 5, harness.length);
    j.expect("speechEndAt <= the delegation every time", measured === 5 && ordered === 5, { measured, ordered });
    j.expect("speech end to delegation in 0.4 to 1.6 s (the README's range)", median(harness) >= 400 && median(harness) <= 1600, median(harness), "400..1600 ms", { soft: true });
  },
};

// ---- one run ----------------------------------------------------------------------------------------

export interface RunOptions {
  readonly plan: CheckPlan;
  readonly mode: Mode;
  /** The day's cap. A live run is refused without it (spendFlagsRefusal); a dry one defaults to MAX_CAP_USD. */
  readonly capUsd?: number;
  /** A live run is refused without it, whoever calls (the command line's --i-accept-spend). */
  readonly acceptSpend?: boolean;
  readonly out: string;
  readonly oversize?: boolean;
  readonly keepState?: boolean;
  /** Dry: wall ms per check ms (default DRY_SCALE). */
  readonly scale?: number;
  /** Lowers the check's own cap (the watchdog test). Never raises it. */
  readonly capSecondsOverride?: number;
  /** Dry only: widens the ceilings that time this Mac's own work (the tests pass RUNNER_SLACK, 3 on CI). A live run judges at 1. */
  readonly slack?: number;
  /** Live: the key (readOpenAIKey). Dry: never read. */
  readonly apiKey?: string;
  /** Dry only: the stand-in misbehaves on purpose, so a test can show a judge failing. A live run with it is refused. */
  readonly dryFaults?: DryFaults;
  readonly print?: (line: string) => void;
}

export interface Report {
  readonly check: CheckId;
  readonly name: string;
  readonly mode: Mode;
  readonly runId: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly head: string;
  /** The ceilings' multiplier this run was judged with (1 for every live run). */
  readonly slack: number;
  /** What the judge was given besides the record, so a re-judge gives the same (scripts/rejudge.mts): the wall ms every `t` counts from, wall ms per check ms, and the idle limit. */
  readonly wall0: number;
  readonly scale: number;
  readonly idleMs: number;
  readonly refused?: string;
  /** The scenario ran to its end (no exception; not cut by the cap or the ceiling). */
  readonly ran: boolean;
  readonly error?: string;
  readonly capHit: boolean;
  readonly ceilingHit: boolean;
  readonly pass: boolean;
  /** The engine as the run left it: its phase and the day's meter. */
  readonly final: { readonly phase: string; readonly usageSeconds: number | undefined; readonly runnerAttached: boolean };
  readonly spend: { readonly capUsd: number; readonly checkCapSeconds: number; readonly todayBeforeUsd: number; readonly planUsd: number; readonly billedSeconds: number; readonly serverSeconds: number; readonly ttsSeconds: number; readonly usd: number };
  readonly assertions: readonly Assertion[];
  readonly metrics: Readonly<Record<string, unknown>>;
  /** Where the engine ran and on what: its state, its socket path, the helper path (absent), the brain, the hands, and the env during the run (secret keys by name only: which were still set, none expected). */
  readonly isolation: { readonly stateDir: string; readonly socketPath: string; readonly handsBin: string; readonly brain: string; readonly hands: string; readonly env: Readonly<Record<string, unknown>> };
  readonly net: readonly NetAttempt[];
  readonly spawns: readonly { readonly t: number; readonly what: string }[];
  readonly sessions: readonly SessionRecord[];
  readonly marks: Recorder["marks"];
  readonly phases: Recorder["phases"];
  readonly events: Recorder["events"];
  readonly reflexes: Recorder["reflexes"];
  readonly reflexRows: Recorder["reflexRows"];
  readonly speech: Recorder["speech"];
  readonly brain: { readonly tasks: CannedBrain["tasks"]; readonly cancels: readonly number[]; readonly toolCalls: CannedBrain["toolCalls"] };
  readonly hands: { readonly acting: readonly HandsCall[]; readonly reading: readonly HandsCall[] };
  /** The engine's delegations as the run left them (the snapshot's). */
  readonly delegations: Snapshot["delegations"];
  readonly wire: { readonly server: readonly ServerFrame[]; readonly client: readonly ClientFrame[]; readonly inText: readonly TextDelta[]; readonly outText: readonly TextDelta[]; readonly delegations: Recorder["delegations"]; readonly errors: Recorder["errors"]; readonly usage: Recorder["usage"]; readonly sockets: Recorder["sockets"] };
  readonly sink: readonly SinkFrame[];
  readonly ledger: readonly LedgerRow[];
  /** Dry runs: what the stand-in played (the caller's faults, or GPT-Live-1 as measured for the check: DRY_AS_MEASURED). */
  readonly standIn?: DryFaults;
  /** The spend ledger this run was gated on and wrote to (live: the one ledger in the state dir; dry: beside the reports). */
  readonly files: { readonly report: string; readonly log: string; readonly spend: string };
}

/** A request the fake hands got: when (check ms), the op and its parameters. */
export interface HandsCall {
  readonly t: number;
  readonly op: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** The checkout's branch and commit, read from .git (no child process): a report names the build it ran on. */
function gitHead(): string {
  try {
    let dir = join(REPO_ROOT, ".git");
    if (!statSync(dir).isDirectory()) {
      const pointer = readFileSync(dir, "utf8").trim();
      if (pointer.startsWith("gitdir:")) dir = resolve(REPO_ROOT, pointer.slice("gitdir:".length).trim());
    }
    const ref = readFileSync(join(dir, "HEAD"), "utf8").trim();
    if (!ref.startsWith("ref:")) return ref.slice(0, 12);
    const name = ref.slice("ref:".length).trim();
    const short = name.replace(/^refs\/heads\//, "");
    // A worktree keeps its branch refs in the common dir.
    const common = existsSync(join(dir, "commondir")) ? resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()) : dir;
    for (const base of [dir, common]) {
      const file = join(base, name);
      if (existsSync(file)) return `${short}@${readFileSync(file, "utf8").trim().slice(0, 12)}`;
    }
    const packed = join(common, "packed-refs");
    const line = existsSync(packed) ? readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${name}`)) : undefined;
    return line ? `${short}@${line.slice(0, 12)}` : short;
  } catch {
    return "unknown";
  }
}

function stamp(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}-${String(d.getMilliseconds()).padStart(3, "0")}`;
}

const SOCKET_NAME = "live-check.sock";
/** The helper binary path the engine is given: it does not exist, so nothing but the fakes can answer. */
const NO_HANDS = "no-hands-helper";

/** Run one check. Never throws for the check's own failures: they are in the report. */
export async function runCheck(opts: RunOptions): Promise<Report> {
  const { plan, mode } = opts;
  const print = opts.print ?? ((line: string): void => void process.stderr.write(`${line}\n`));
  const oversize = opts.oversize === true && plan.id === "LC-3";
  const scale = mode === "dry" ? (opts.scale ?? DRY_SCALE) : 1;
  /** What the dry stand-in plays: the caller's faults, else GPT-Live-1 as measured for this check (DRY_AS_MEASURED). */
  const standIn = mode === "dry" ? (opts.dryFaults ?? DRY_AS_MEASURED[plan.id] ?? {}) : undefined;
  const slack = mode === "dry" ? Math.max(1, opts.slack ?? 1) : 1;
  const idleMs = idleMsFor(plan.id, mode, scale);
  const checkCapSeconds = Math.min(planSeconds(plan, { oversize }), opts.capSecondsOverride ?? Number.POSITIVE_INFINITY);
  const runId = `${plan.id}-${Date.now().toString(36)}-${process.pid}`;
  const startedAt = Date.now();
  const dayDir = join(opts.out, localDay(startedAt));
  mkdirSync(dayDir, { recursive: true });
  const base = join(dayDir, `${plan.id.toLowerCase()}-${plan.name}-${stamp(startedAt)}${mode === "dry" ? "-dry" : ""}`);
  // The live ledger is read where the app keeps its state, before the run points JARHEAD_STATE_DIR at a temp dir.
  const ledgerFile = mode === "live" ? liveSpendFile() : drySpendFile(opts.out);
  const files = { report: `${base}.json`, log: `${base}.log`, spend: ledgerFile };
  const rec = new Recorder();
  const capUsd = opts.capUsd ?? (mode === "dry" ? MAX_CAP_USD : Number.NaN);

  const refuse = (reason: string): Report => {
    print(reason);
    const report = emptyReport(plan, mode, runId, startedAt, files, reason, capUsd, checkCapSeconds, { wall0: rec.wall0, scale, idleMs });
    writeFileSync(files.report, `${JSON.stringify(report, null, 1)}\n`);
    return report;
  };

  // ---- the gates: flags, the key, the day's spend, one live run at a time. A dry run spends nothing: never refused.
  const flags = spendFlagsRefusal({ mode, acceptSpend: opts.acceptSpend === true, capUsd: opts.capUsd });
  if (flags) return refuse(flags);
  if (mode === "live" && opts.dryFaults) return refuse("Refused. Dry faults are for --dry-run only.");
  if (mode === "live" && !opts.apiKey) return refuse("Refused. No OpenAI key: set OPENAI_API_KEY, or put it in ~/.jarhead/env (Setup writes it).");
  const plannedUsd = planUsd(plan, { oversize });
  const todayUsd = spentToday(readSpend(ledgerFile)).usd;
  if (mode === "live") {
    const gate = spendGate(readSpend(ledgerFile), plan, capUsd, { oversize });
    if (!gate.ok) return refuse(`${gate.reason} Ledger: ${ledgerFile}.`);
  }
  const lock = liveLockFile(ledgerFile);
  if (mode === "live") {
    const held = takeLiveLock(lock);
    if (!held.ok) return refuse(`Refused. Another live check is running (pid ${held.pid}). The lock is ${lock}.`);
  }
  mkdirSync(dirname(ledgerFile), { recursive: true });
  appendFileSync(ledgerFile, `${JSON.stringify({ at: startedAt, day: localDay(startedAt), runId, check: plan.id, event: "start", planSeconds: planSeconds(plan, { oversize }), planUsd: plannedUsd } satisfies SpendLine)}\n`);
  print(`${plan.id} ${plan.name} (${mode}): plan ${planSeconds(plan, { oversize })} s, ${usd(plannedUsd)}; today ${usd(todayUsd)} of ${usd(capUsd)}${mode === "dry" ? " (simulated)" : ""}.`);

  // ---- isolation: a temp state dir, the env of a quiet test launch, the fences
  const stateRoot = mkdtempSync(join(tmpdir(), "jh-live-check-"));
  const stateDir = join(stateRoot, "state");
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined): void => {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  for (const k of Object.keys(process.env)) if (k.startsWith("JARHEAD_") && !k.startsWith("JARHEAD_TEST_")) setEnv(k, undefined);
  for (const k of SECRET_KEYS) setEnv(k, undefined);
  setEnv("JARHEAD_STATE_DIR", stateDir);
  setEnv("JARHEAD_NO_AUDIO", "1");
  setEnv("JARHEAD_AUTO_WAKE", "0");
  const runEnv = { JARHEAD_STATE_DIR: stateDir, JARHEAD_NO_AUDIO: process.env["JARHEAD_NO_AUDIO"], JARHEAD_AUTO_WAKE: process.env["JARHEAD_AUTO_WAKE"], secretKeysSet: SECRET_KEYS.filter((k) => process.env[k] !== undefined) };
  const fences = installFences(rec, mode);
  const logLines: string[] = [];
  replaceDefaultSink((level: LogLevel, scope: string, message: string) => {
    logLines.push(`${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${scope}: ${message}`);
  });
  /** Everything the run changed in this process goes back, whatever happened. */
  const restoreProcess = (): void => {
    fences.restore();
    replaceDefaultSink(consoleSink);
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const abort = new AbortController();
  let capHit = false;
  let ceilingHit = false;
  let error: string | undefined;
  let ran = false;
  let watchdog: NodeJS.Timeout | undefined;
  let mic: MicPump | undefined;
  let after: { readonly snapshot: Snapshot; readonly runnerAttached: boolean; readonly ledger: readonly LedgerRow[]; readonly brainKind: string } | undefined;
  const brain = new CannedBrain(rec, Math.max(10, 300 * scale));
  const acting = new FakeHands();
  const reading = new FakeHands();
  const lives: { live: LiveSession; tap: TapSocket | undefined }[] = [];
  try {
    const config: JarheadConfig = {
      openaiApiKey: mode === "live" ? opts.apiKey : "sk-live-check-dry-run-not-a-key",
      anthropicApiKey: undefined,
      liveModel: LIVE_MODEL,
      liveVoice: "ballad",
      brain: "auto",
      brainModel: "",
      brainEffort: "low",
      brainBaseUrl: undefined,
      brainApiKey: undefined,
      stateDir,
      socketPath: join(stateDir, SOCKET_NAME),
      idleSleepMinutes: 10,
      logLevel: "info",
      claudeBin: undefined,
      codexBin: undefined,
      handsBin: join(stateRoot, NO_HANDS),
      memoryModel: undefined,
    };
    const dry = new DryServer(standIn, scale);
    const RealWebSocket = fences.RealWebSocket;
    const makeLive = (sessionConfig: SessionConfig): LiveSession => {
      if (abort.signal.aborted) throw new Error("live-check: the check is over; no session opens");
      const s = rec.sessions.length;
      const record: SessionRecord = { s, createdT: rec.t(), usage: 0 };
      rec.sessions.push(record);
      const entry: { live: LiveSession; tap: TapSocket | undefined } = { live: undefined as unknown as LiveSession, tap: undefined };
      const live = new LiveSession({
        apiKey: config.openaiApiKey ?? "",
        config: sessionConfig,
        webSocketFactory: (url, headers) => {
          let inner: WebSocketLike;
          if (mode === "dry") inner = dry.newSocket();
          else {
            if (!RealWebSocket || url !== LIVE_URL) throw new Error(`live-check: refused a socket to ${url}`);
            rec.net.push({ t: rec.t(), verdict: "passed", what: `WebSocket ${url}` });
            inner = new RealWebSocket(url, { headers } as unknown as string[]) as unknown as WebSocketLike;
          }
          const tap = new TapSocket(inner, rec, s);
          entry.tap = tap;
          return tap;
        },
      });
      entry.live = live;
      live.on("started", (res) => {
        record.startedT = rec.t();
        record.id = res.id;
      });
      live.on("closed", (reason, usage) => {
        record.closedT ??= rec.t();
        record.closeReason ??= reason;
        record.usage = Math.max(record.usage, usage);
      });
      lives.push(entry);
      return live;
    };
    const engine = new Engine({
      config,
      connectors: [],
      brain,
      makeThreadBrain: (spec) => ({
        kind: "live-check-canned-thread",
        start: async () => ({ ready: true, detail: "canned thread" }),
        handle: async (task, sink) => {
          spec.runner.attach(sink, task);
          try {
            return { status: "done", summary: "Done." };
          } finally {
            spec.runner.attach(undefined);
          }
        },
        cancel: async () => undefined,
        stop: async () => undefined,
      }),
      hands: acting,
      backgroundHands: reading,
      makeLive,
      probePermissions: async () => ({ accessibility: true, screenRecording: true }),
      exec: () => ({ code: 127, stdout: "", stderr: "no shell in a live check" }),
      memory: { service: NULL_MEMORY },
      fallbackUserName: "Kevin",
      discoverLocal: async ({ ramBytes }) => ({ reachable: false, baseUrl: "", models: [], ramBytes, checkedAt: Date.now() }),
      automations: { home: stateRoot },
    });
    brain.engine = engine;
    engine.on("audio", (pcm: Buffer) => void rec.sink.push(sinkFrame(rec.t(), pcm)));
    engine.on("reflex", (label, ms, prefired) => void rec.reflexes.push({ t: rec.t(), label, ms, prefired }));
    engine.on("reflex.fired", (row) => void rec.reflexRows.push({ t: rec.t(), action: row.action, source: row.source, ok: row.ok }));
    let lastPhase = "";
    engine.on("event", (e: EngineEvent) => {
      if (e.type === "levels") return;
      if (e.type === "snapshot") {
        if (e.snapshot.phase !== lastPhase) {
          lastPhase = e.snapshot.phase;
          rec.phases.push({ t: rec.t(), phase: lastPhase });
        }
        return;
      }
      rec.events.push({ t: rec.t(), type: e.type, ...(e.type === "toast" ? { detail: e.text } : {}) });
    });
    // LC-6 reads the gate 50 ms after the session dispatched the fragment that first says "stop" in the stop line.
    let stopWatch: { trial: number; heard: string } | undefined;
    rec.afterServerFrame = (f, ev) => {
      if (f.type !== "session.input_transcript.delta" || !stopWatch) return;
      stopWatch.heard += String(ev["delta"] ?? "");
      if (!/\bstop\b/i.test(stopWatch.heard)) return;
      const trial = stopWatch.trial;
      stopWatch = undefined;
      setTimeout(() => rec.marks.push({ t: rec.t(), name: "gate", data: { trial, gated: engine.outputGated, fragmentT: f.t } }), 50);
    };

    mic = new MicPump(engine, rec);
    const pump = mic;
    const synth: Synth = mode === "dry" ? drySynth : liveSynth(opts.apiKey ?? "", fences.realFetch, join(opts.out, "tts-cache"), rec);
    const spoken = new Map<string, Buffer>();
    const prepare = async (text: string): Promise<Buffer> => {
      const known = spoken.get(text);
      if (known) return known;
      const r = await synth(text);
      if (!r.cached && mode === "live") rec.ttsSynthesized += r.pcm.length / (SAMPLE_RATE * 2);
      spoken.set(text, r.pcm);
      return r.pcm;
    };
    const phase = (): string => engine.snapshot().phase;
    /** The ear's segment ids, one per line fed to it (Ctx.speak with `ear`). */
    let earSegment = 0;
    const guard = (): void => {
      if (abort.signal.aborted) throw new CheckAborted(capHit ? "the cap" : "the ceiling");
    };
    const waitWall = async (ms: number): Promise<void> => {
      guard();
      await new Promise<void>((r) => {
        const done = (): void => {
          clearTimeout(t);
          abort.signal.removeEventListener("abort", done);
          r();
        };
        const t = setTimeout(done, Math.max(0, ms));
        abort.signal.addEventListener("abort", done, { once: true });
      });
      guard();
    };
    const ctx: Ctx = {
      mode,
      engine,
      rec,
      brain,
      acting,
      reading,
      signal: abort.signal,
      oversize,
      idleMs,
      ms: (checkMs) => checkMs * scale,
      wait: (checkMs) => waitWall(checkMs * scale),
      waitWall,
      until: async (cond, wallMs) => {
        const end = Date.now() + wallMs;
        while (Date.now() < end) {
          guard();
          if (cond()) return true;
          await waitWall(Math.min(20, Math.max(1, end - Date.now())));
        }
        return cond();
      },
      mark: (name, data) => rec.mark(name, data),
      go: async () => {
        guard();
        const before = rec.sessions.filter((s) => s.startedT !== undefined).length;
        await engine.go();
        const ok = await ctx.until(() => rec.sessions.filter((s) => s.startedT !== undefined).length > before || phase() === "listening", 20_000);
        if (!ok) throw new Error(`the session did not start (phase ${phase()})`);
      },
      typed: async (text) => {
        guard();
        const t = rec.mark("typed.line", { chars: text.length, head: text.slice(0, 60) });
        await engine.sayText(text);
        return t;
      },
      speak: async (text, o = {}) => {
        guard();
        const pcm = await prepare(text);
        const startT = rec.t();
        if (text === LC6_LINES[1]) stopWatch = { trial: rec.marksNamed("stop.speech").length, heard: "" };
        const said = pump.say(pcm);
        if (o.ear) {
          // The app's recognizer: a partial as each word is said (its words so far, no closing punctuation), then the
          // final once the line has ended. One segment per line.
          const words = text.split(/\s+/).filter(Boolean);
          const segment = ++earSegment;
          const stepMs = pcmMs(pcm) / Math.max(1, words.length);
          for (let k = 1; k <= words.length; k++) {
            await waitWall(stepMs);
            engine.ear(words.slice(0, k).join(" ").replace(/[.,!?]+$/, ""), false, segment, Date.now());
          }
          await said;
          await waitWall(EAR_FINAL_AFTER_MS);
          engine.ear(text, true, segment, Date.now());
          rec.mark("ear.final", { segment, text });
        }
        const endT = await said;
        rec.speech.push({ text, startT, endT, seconds: pcm.length / (SAMPLE_RATE * 2) });
        guard();
        return { startT, endT };
      },
      reply: async (sinceT, quietWallMs, maxWallMs) => {
        const end = rec.t() + maxWallMs;
        while (rec.t() < end) {
          guard();
          const last = rec.audible(undefined, sinceT).at(-1)?.t;
          if (last !== undefined && rec.t() - last >= quietWallMs) return true;
          await waitWall(20);
        }
        return false;
      },
      live: () => lives.at(-1)?.live,
      raw: (ev) => {
        const tap = lives.at(-1)?.tap;
        if (!tap) throw new Error("no socket to send on");
        tap.send(JSON.stringify(ev));
      },
      drop: () => {
        const tap = lives.at(-1)?.tap;
        if (!tap) throw new Error("no socket to drop");
        tap.drop();
      },
      phase,
    };

    // ---- the watchdogs: the cap (billed seconds) and a wall ceiling
    const ceilingAt = Date.now() + planSeconds(plan, { oversize }) * 1000 * Math.max(scale, 0.05) * 2 + 90_000;
    const cut = (why: "cap" | "ceiling"): void => {
      if (abort.signal.aborted) return;
      if (why === "cap") capHit = true;
      else ceilingHit = true;
      rec.mark(why, { billedSeconds: rec.billedSeconds() });
      // No session opens after this (makeLive refuses), every socket goes now (the meter stops here), then Stop
      // puts the engine to sleep: no reconnect, nothing running.
      abort.abort();
      for (const { live } of lives) if (live.currentState !== "closed") live.terminate();
      void engine.pressStop(`live-check ${why}`).catch(() => undefined);
    };
    const check = (): void => {
      if (rec.billedSeconds() >= checkCapSeconds) cut("cap");
      else if (Date.now() >= ceilingAt) cut("ceiling");
    };
    watchdog = setInterval(() => {
      check();
      // Between ticks the wall clock bills every open session: near the cap, a one-shot lands on the cap itself.
      const open = rec.sessions.filter((x) => x.startedT !== undefined && x.closedT === undefined).length;
      const remainingMs = ((checkCapSeconds - rec.billedSeconds()) * 1000) / Math.max(1, open);
      if (open > 0 && remainingMs < 150) setTimeout(check, Math.max(0, remainingMs));
    }, 100);

    try {
      await engine.start();
      await engine.ready();
      // The name stays the fallback's ("Kevin"): a rename would restart the brain.
      engine.updateSettings({ memory: false, warmThreads: 0, typedWakes: false, idleSleepMinutes: idleMs / 60_000 }, { quiet: true });
      for (const line of SPOKEN[plan.id] ?? []) await prepare(line);
      pump.start();
      await SCENARIOS[plan.id](ctx);
      ran = !abort.signal.aborted;
    } catch (e) {
      if (!(e instanceof CheckAborted)) error = (e as Error).stack ?? String(e);
    }

    // ---- the end: nothing left open
    if (lives.some(({ live }) => live.currentState !== "closed")) await engine.pressStop("live-check end").catch(() => undefined);
    const closedBy = Date.now() + 3000;
    while (lives.some(({ live }) => live.currentState !== "closed") && Date.now() < closedBy) await sleep(25);
    for (const { live } of lives) if (live.currentState !== "closed") live.terminate();
    abort.abort();
    pump.stop();
    after = { snapshot: engine.snapshot(), runnerAttached: engine.runner.attached, ledger: engine.ledger.read(Date.now()), brainKind: engine.brainInfo.kind };
    await engine.stop().catch((e: unknown) => void logLines.push(`engine.stop: ${(e as Error).message}`));
  } catch (e) {
    error = `${error ? `${error}\n` : ""}${(e as Error).stack ?? String(e)}`;
  } finally {
    if (watchdog) clearInterval(watchdog);
    abort.abort();
    mic?.stop();
    // Whatever went wrong above, no session is left open: the meter stops here.
    for (const { live } of lives) if (live.currentState !== "closed") live.terminate();
    restoreProcess();
  }

  const billedSeconds = rec.billedSeconds();
  const serverSeconds = rec.sessions.reduce((a, s) => a + s.usage, 0);
  const ttsSeconds = rec.ttsSeconds();
  const spent = billedSeconds * LIVE_USD_PER_SECOND + (mode === "live" ? ttsSeconds * TTS_USD_PER_SECOND : 0);
  appendFileSync(ledgerFile, `${JSON.stringify({ at: Date.now(), day: localDay(startedAt), runId, check: plan.id, event: "end", billedSeconds, ttsUsd: mode === "live" ? ttsSeconds * TTS_USD_PER_SECOND : 0, usd: spent } satisfies SpendLine)}\n`);
  if (mode === "live") releaseLiveLock(lock);

  const assertions: Assertion[] = [];
  const metrics: Record<string, unknown> = {};
  const snapshot = after?.snapshot;
  const ledger = after?.ledger ?? [];
  const judge: Judge | undefined = snapshot && {
    rec,
    ledger,
    snapshot,
    brain,
    acting,
    reading,
    idleMs,
    oversize,
    mode,
    wall0: rec.wall0,
    slack,
    scale,
    expect: (name, pass, value, expect, o) => void assertions.push({ name, pass, ...(o?.soft ? { soft: true } : {}), ...(value !== undefined ? { value } : {}), ...(expect !== undefined ? { expect } : {}) }),
    metric: (name, value) => void (metrics[name] = value),
  };
  try {
    if (judge) JUDGES[plan.id](judge);
  } catch (e) {
    error = `${error ? `${error}\n` : ""}judge: ${(e as Error).stack ?? String(e)}`;
  }
  const hard = assertions.filter((a) => !a.soft);
  const pass = ran && !error && hard.length > 0 && hard.every((a) => a.pass);
  const report: Report = {
    check: plan.id,
    name: plan.name,
    mode,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    head: gitHead(),
    slack,
    wall0: rec.wall0,
    scale,
    idleMs,
    ran,
    ...(error ? { error } : {}),
    capHit,
    ceilingHit,
    pass,
    final: { phase: snapshot?.phase ?? "", usageSeconds: snapshot?.usageToday?.seconds, runnerAttached: after?.runnerAttached ?? false },
    spend: { capUsd, checkCapSeconds, todayBeforeUsd: todayUsd, planUsd: plannedUsd, billedSeconds, serverSeconds, ttsSeconds, usd: spent },
    assertions,
    metrics,
    isolation: { stateDir, socketPath: join(stateDir, SOCKET_NAME), handsBin: join(stateRoot, NO_HANDS), brain: after?.brainKind ?? "", hands: "FakeHands (fakeHandsSpawn) on both helpers", env: runEnv },
    net: rec.net,
    spawns: rec.spawns,
    sessions: rec.sessions,
    marks: rec.marks,
    phases: rec.phases,
    events: rec.events,
    reflexes: rec.reflexes,
    reflexRows: rec.reflexRows,
    speech: rec.speech,
    brain: { tasks: brain.tasks, cancels: brain.cancels, toolCalls: brain.toolCalls },
    hands: { acting: acting.calls.map((c) => ({ t: c.at - rec.wall0, op: c.op, params: c.params })), reading: reading.calls.map((c) => ({ t: c.at - rec.wall0, op: c.op, params: c.params })) },
    delegations: snapshot?.delegations ?? [],
    wire: { server: rec.server, client: rec.client, inText: rec.inText, outText: rec.outText, delegations: rec.delegations, errors: rec.errors, usage: rec.usage, sockets: rec.sockets },
    sink: rec.sink,
    ledger,
    ...(standIn ? { standIn } : {}),
    files,
  };
  writeFileSync(files.report, `${JSON.stringify(report)}\n`);
  writeFileSync(files.log, `${logLines.join("\n")}\n`);
  if (!opts.keepState) rmSync(stateRoot, { recursive: true, force: true });
  const failed = hard.filter((a) => !a.pass).map((a) => a.name);
  print(`${plan.id} ${plan.name} (${mode}): ${pass ? "pass" : "FAIL"} (${hard.filter((a) => a.pass).length}/${hard.length})${capHit ? ", cut at the cap" : ""}${ceilingHit ? ", cut at the ceiling" : ""}${error ? ", error" : ""}. Billed ${billedSeconds.toFixed(1)} s, ${usd(spent)}${mode === "dry" ? " (simulated)" : ""}.`);
  for (const name of failed) print(`  failed: ${name}`);
  if (error) print(`  error: ${error.split("\n")[0]}`);
  print(`  report: ${files.report}`);
  return report;
}

function emptyReport(plan: CheckPlan, mode: Mode, runId: string, startedAt: number, files: Report["files"], refused: string, capUsd: number, checkCapSeconds: number, judged: Pick<Report, "wall0" | "scale" | "idleMs">): Report {
  return {
    check: plan.id,
    name: plan.name,
    mode,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    head: gitHead(),
    slack: 1,
    ...judged,
    refused,
    ran: false,
    capHit: false,
    ceilingHit: false,
    pass: false,
    final: { phase: "", usageSeconds: undefined, runnerAttached: false },
    spend: { capUsd, checkCapSeconds, todayBeforeUsd: 0, planUsd: planUsd(plan), billedSeconds: 0, serverSeconds: 0, ttsSeconds: 0, usd: 0 },
    assertions: [],
    metrics: {},
    isolation: { stateDir: "", socketPath: "", handsBin: "", brain: "", hands: "", env: {} },
    net: [],
    spawns: [],
    sessions: [],
    marks: [],
    phases: [],
    events: [],
    reflexes: [],
    reflexRows: [],
    speech: [],
    brain: { tasks: [], cancels: [], toolCalls: [] },
    hands: { acting: [], reading: [] },
    delegations: [],
    wire: { server: [], client: [], inText: [], outText: [], delegations: [], errors: [], usage: [], sockets: [] },
    sink: [],
    ledger: [],
    files,
  };
}

// ---- the command line ------------------------------------------------------------------------------------

export const DEFAULT_OUT = join(REPO_ROOT, "build", "live-check");

export async function main(argv: readonly string[], print: (line: string) => void = (l) => void process.stderr.write(`${l}\n`)): Promise<number> {
  const args = parseArgs(argv);
  if ("error" in args) {
    print(args.error);
    return 2;
  }
  const out = args.out ?? (args.mode === "dry" ? join(DEFAULT_OUT, "dry") : DEFAULT_OUT);
  mkdirSync(out, { recursive: true });
  if (args.check === "list") {
    const ledger = liveSpendFile();
    const today = spentToday(readSpend(ledger));
    for (const p of PLANS) print(`${p.id.padEnd(6)}${p.name.padEnd(13)}${String(planSeconds(p)).padStart(4)} s  ${usd(planUsd(p))}  ${p.what}`);
    print(`Planned total ${PLANS.reduce((a, p) => a + planSeconds(p), 0)} s, ${usd(PLANS.reduce((a, p) => a + planUsd(p), 0))}. Today's live checks spent ${usd(today.usd)} of ${usd(MAX_CAP_USD)} in ${today.runs} run(s). Ledger: ${ledger}.`);
    return 0;
  }
  const plans = args.check === "all" ? PLANS : [findPlan(args.check)].filter((p): p is CheckPlan => p !== undefined);
  if (plans.length === 0) {
    print(`Unknown check ${args.check}. One of ${PLANS.map((p) => `${p.id} (${p.name})`).join(", ")}, all, or list.`);
    return 2;
  }
  const flags = spendFlagsRefusal(args);
  if (flags) {
    print(flags);
    return 2;
  }
  let apiKey: string | undefined;
  if (args.mode === "live") {
    const found = readOpenAIKey();
    if (!found) {
      print("Refused. No OpenAI key: set OPENAI_API_KEY, or put it in ~/.jarhead/env (Setup writes it).");
      return 2;
    }
    apiKey = found.key;
    print(`Key: from ${found.source}.`);
  }
  let code = 0;
  for (const plan of plans) {
    const report = await runCheck({ plan, mode: args.mode, ...(args.capUsd !== undefined ? { capUsd: args.capUsd } : {}), acceptSpend: args.acceptSpend, out, oversize: args.oversize, keepState: args.keepState, ...(args.scale !== undefined ? { scale: args.scale } : {}), ...(apiKey ? { apiKey } : {}), print });
    if (report.refused) return 2;
    if (!report.pass) code = 1;
  }
  return code;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = await main(process.argv.slice(2));
}
