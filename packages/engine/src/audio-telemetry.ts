import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { AudioState, LedgerRow, LiveAudio } from "@jarhead/protocol";

/**
 * Voice PLAN W1.5: the playback figures that reach daemon.log, the snapshot and the ledger.
 *
 * The app's own audio lines go to NSLog, which this Mac does not keep, so the causes of a spotty
 * voice could not be confirmed from a real session. Two halves meet here:
 * - **Live's side, measured in the daemon** (`snapshot.liveAudio`): how big GPT-Live-1's deltas
 *   are, how they are spaced inside a reply, how far a reply runs ahead of real time, what the
 *   output gate dropped, the daemon's event-loop delay, the rate session.started echoed.
 * - **The app's side**, as its last `audio-state` frame reported it: the playout cushion, the
 *   barge-in duck, the output level.
 *
 * One `audio:` line goes to daemon.log at most every LINE_EVERY_MS while a session is open and
 * what it says changed, a summary at session close, and one `audio.playout` ledger row at close.
 * Numbers only: no line or row carries a word Kevin or Jarhead said.
 */

/** PCM16 mono at 24 kHz. */
const BYTES_PER_MS = 48;
/** Audio received this long past real time without a delta ends a reply (PlayoutModel.dryResetFrames). */
const REPLY_GAP_MS = 500;
/** A reply this short says nothing about running ahead. */
const REPLY_MIN_DELTAS = 3;
/** The daemon.log line's rate limit. */
export const AUDIO_LINE_EVERY_MS = 5000;
/** The percentiles read the newest this many figures (about 160 s of 40 ms deltas); the maxima are the session's. */
const KEEP = 4096;

/** Nearest rank: the smallest value with at least `p` of the values at or below it. */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function keep(list: number[], value: number): void {
  list.push(value);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
}

/** One session's Live audio. Times are the engine's clock (ms). */
class SessionMeter {
  private deltas = 0;
  private gated = 0;
  private readonly sizes: number[] = [];
  private readonly gaps: number[] = [];
  private maxSize = 0;
  private maxGap = 0;
  /** The reply under way: when its first delta came, the audio it has carried, its first and highest lead. */
  private replyStart: number | undefined;
  private replyAudio = 0;
  private replyDeltas = 0;
  private replyFirstLead = 0;
  private replyMaxLead = 0;
  private lastArrival = 0;
  private readonly aheads: number[] = [];
  private readonly loop: IntervalHistogram | undefined;

  constructor(readonly formatRate: number | undefined) {
    try {
      this.loop = monitorEventLoopDelay({ resolution: 10 });
      this.loop.enable();
    } catch {
      this.loop = undefined;
    }
  }

  /**
   * One delta of `bytes` at `at`. A reply's lead at each delta is the audio it carried before it minus the
   * time since its first delta (zero for a stream paced in real time); `ahead` is how far the lead rose
   * above its first value.
   */
  delta(bytes: number, at: number, gated: boolean): void {
    const ms = bytes / BYTES_PER_MS;
    this.deltas++;
    if (gated) this.gated++;
    keep(this.sizes, ms);
    this.maxSize = Math.max(this.maxSize, ms);
    if (this.replyStart === undefined || at - this.replyStart > this.replyAudio + REPLY_GAP_MS) {
      this.endReply();
      this.replyStart = at;
      this.replyAudio = 0;
      this.replyDeltas = 0;
    } else {
      const gap = at - this.lastArrival;
      keep(this.gaps, gap);
      this.maxGap = Math.max(this.maxGap, gap);
    }
    const lead = this.replyAudio - (at - this.replyStart);
    if (this.replyDeltas === 0) {
      this.replyFirstLead = lead;
      this.replyMaxLead = lead;
    } else {
      this.replyMaxLead = Math.max(this.replyMaxLead, lead);
    }
    this.replyAudio += ms;
    this.replyDeltas++;
    this.lastArrival = at;
  }

  private endReply(): void {
    if (this.replyStart !== undefined && this.replyDeltas >= REPLY_MIN_DELTAS) keep(this.aheads, this.replyMaxLead - this.replyFirstLead);
  }

  get heard(): boolean {
    return this.deltas > 0;
  }

  figures(): LiveAudio {
    const aheads = this.replyDeltas >= REPLY_MIN_DELTAS ? [...this.aheads, this.replyMaxLead - this.replyFirstLead] : this.aheads;
    const loop = this.loop ? Math.round(this.loop.max / 1e6) : undefined;
    return {
      deltas: this.deltas,
      deltaMsP50: Math.round(percentile(this.sizes, 0.5)),
      deltaMsMax: Math.round(this.maxSize),
      arrivalP99Ms: Math.round(percentile(this.gaps, 0.99)),
      arrivalMaxMs: Math.round(this.maxGap),
      aheadMs: Math.round(percentile(aheads, 0.5)),
      gatedFrames: this.gated,
      ...(loop !== undefined && Number.isFinite(loop) ? { loopDelayMaxMs: loop } : {}),
      ...(this.formatRate !== undefined ? { formatRate: this.formatRate } : {}),
    };
  }

  dispose(): void {
    try {
      this.loop?.disable();
    } catch {
      // already off
    }
  }
}

export interface AudioTelemetryOptions {
  readonly now: () => number;
  /** daemon.log (the engine's `log.info`). */
  readonly log: (line: string) => void;
}

/** The engine's half: one meter per open session, the rate-limited line, the close row. */
export class AudioTelemetry {
  private readonly meters = new Map<string, SessionMeter>();
  /** The session the snapshot and the line report: the last one opened and not yet closed. */
  private current: string | undefined;
  private lastLine = "";
  private lastLineAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: AudioTelemetryOptions) {}

  /** session.started: a fresh meter, and the format Live echoed in daemon.log. */
  open(sessionId: string, format: { readonly type?: string; readonly rate?: number } | undefined): void {
    this.meters.get(sessionId)?.dispose();
    const rate = typeof format?.rate === "number" && Number.isFinite(format.rate) ? format.rate : undefined;
    this.meters.set(sessionId, new SessionMeter(rate));
    this.current = sessionId;
    this.lastLine = "";
    this.lastLineAt = Number.NEGATIVE_INFINITY;
    this.opts.log(rate !== undefined ? `audio format echoed: ${format?.type ?? "audio"} ${rate} Hz (session ${sessionId})` : `audio format: session.started echoed none (session ${sessionId})`);
  }

  /** One of Live's output deltas, played or dropped by the output gate (`gated`). */
  delta(sessionId: string | undefined, bytes: number, gated: boolean): void {
    if (!sessionId) return;
    let meter = this.meters.get(sessionId);
    if (!meter) {
      meter = new SessionMeter(undefined);
      this.meters.set(sessionId, meter);
      this.current ??= sessionId;
    }
    meter.delta(bytes, this.opts.now(), gated);
  }

  /** The snapshot's field: present while a session is open. */
  snapshotField(): { readonly liveAudio?: LiveAudio } {
    const meter = this.current ? this.meters.get(this.current) : undefined;
    return meter ? { liveAudio: meter.figures() } : {};
  }

  /** The app reported its graph: one `audio:` line when a session is open, LINE_EVERY_MS have passed and it says something new. */
  frame(state: AudioState | undefined): void {
    const meter = this.current ? this.meters.get(this.current) : undefined;
    if (!meter || !state || !(state.playout || state.duck || state.output)) return;
    const now = this.opts.now();
    if (now - this.lastLineAt < AUDIO_LINE_EVERY_MS) return;
    const line = audioLine(state, meter.figures());
    if (line === this.lastLine) return;
    this.lastLine = line;
    this.lastLineAt = now;
    this.opts.log(`audio: ${line}`);
  }

  /** Session close: the summary line, and the ledger row when anything was measured (undefined otherwise). */
  close(sessionId: string, state: AudioState | undefined): LedgerRow | undefined {
    const meter = this.meters.get(sessionId);
    this.meters.delete(sessionId);
    if (this.current === sessionId) this.current = undefined;
    meter?.dispose();
    const live = meter?.heard ? meter.figures() : undefined;
    const app = state && (state.playout || state.duck || state.output) ? state : undefined;
    if (!live && !app) return undefined;
    this.opts.log(`audio (session ${sessionId} closed): ${audioLine(app, live)}`);
    return {
      at: this.opts.now(),
      type: "audio.playout",
      sessionId,
      ...(app?.playout ? { playout: app.playout } : {}),
      ...(app?.duck ? { duck: app.duck } : {}),
      ...(app?.output ? { output: app.output } : {}),
      ...(live ? { liveAudio: live } : {}),
    };
  }
}

const db1 = (x: number): string => x.toFixed(1);
const db0 = (x: number): string => String(Math.round(x));

/**
 * The daemon.log line: `playout 0 underruns (would be 4) · queued 121 ms min 96 · late max 7 ms · duck 2
 * (2 gate · 2 confirmed) · residual p50 -61 p99 -49 dBFS · output rms -21.8 peak -4.1 dBFS vol 0.62 ·
 * live 40 ms deltas · arrival p99 31 ms · ahead 0 ms · loop max 12 ms`. A part with nothing behind it is left out.
 */
export function audioLine(state: AudioState | undefined, live: LiveAudio | undefined): string {
  const parts: string[] = [];
  const p = state?.playout;
  if (p) parts.push(`playout ${p.underruns} underrun${p.underruns === 1 ? "" : "s"} (would be ${p.wouldBeUnderruns}) · queued ${db0(p.queuedMs)} ms${p.queuedMinMs !== undefined ? ` min ${db0(p.queuedMinMs)}` : ""} · late max ${db0(p.lateMaxMs)} ms`);
  const d = state?.duck;
  if (d) {
    parts.push(`duck ${d.ducks} (${d.gate} gate · ${d.confirmed} confirmed${d.unconfirmed ? ` · ${d.unconfirmed} unconfirmed` : ""})`);
    if (d.residualP50Dbfs !== undefined && d.residualP99Dbfs !== undefined) parts.push(`residual p50 ${db0(d.residualP50Dbfs)} p99 ${db0(d.residualP99Dbfs)} dBFS`);
  }
  const o = state?.output;
  if (o && o.rmsDbfs !== undefined) parts.push(`output rms ${db1(o.rmsDbfs)}${o.peakDbfs !== undefined ? ` peak ${db1(o.peakDbfs)}` : ""} dBFS${o.volume !== undefined ? ` vol ${o.volume.toFixed(2)}` : ""}`);
  if (live) {
    // LiveAudio's figures are optional in the contract: a part with nothing behind it is left out.
    const l: string[] = [];
    if (live.deltaMsP50 !== undefined) l.push(`${db0(live.deltaMsP50)} ms deltas`);
    if (live.arrivalP99Ms !== undefined) l.push(`arrival p99 ${db0(live.arrivalP99Ms)} ms`);
    if (live.aheadMs !== undefined) l.push(`ahead ${db0(live.aheadMs)} ms`);
    if (live.loopDelayMaxMs !== undefined) l.push(`loop max ${db0(live.loopDelayMaxMs)} ms`);
    parts.push(l.length ? `live ${l.join(" · ")}` : `live ${live.deltas} deltas`);
  }
  return parts.length ? parts.join(" · ") : "nothing measured";
}
