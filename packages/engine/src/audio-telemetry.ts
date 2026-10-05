import { monitorEventLoopDelay } from "node:perf_hooks";
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
/** The event-loop monitor's sampling interval: every reading carries it, so the reported delay has it taken off. */
export const LOOP_RESOLUTION_MS = 10;
/** Meters replaced before their session's `closed` keep their last figures this long (in sessions), for a late close. */
const RETIRED_KEEP = 4;
/** The percentiles read the newest this many figures (about 160 s of 40 ms deltas); the maxima are the session's. */
const KEEP = 4096;

/** The first index in ascending `keys` whose value is at least `v`. */
function lowerBound(keys: readonly number[], v: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The newest KEEP figures of one kind, counted per whole millisecond. The snapshot reads the percentiles up to
 * 20 times a second while Jarhead speaks, on the loop that writes the speaker frames, so a read walks the distinct
 * values (a few dozen for Live's deltas) and never sorts the figures. A figure is rounded on the way in. Rounding
 * keeps the order, so the nearest rank of the rounded figures is the rounded nearest rank of the raw ones.
 */
export class FigureWindow {
  /** The figures in arrival order; once full, `head` is the oldest. */
  private readonly ring: number[] = [];
  private head = 0;
  private readonly counts = new Map<number, number>();
  /** The distinct figures, ascending. */
  private readonly keys: number[] = [];

  constructor(private readonly keep = KEEP) {}

  get size(): number {
    return this.ring.length;
  }

  add(value: number): void {
    const v = Math.round(value);
    if (this.ring.length < this.keep) this.ring.push(v);
    else {
      this.drop(this.ring[this.head]!);
      this.ring[this.head] = v;
      this.head = (this.head + 1) % this.keep;
    }
    const n = this.counts.get(v);
    if (n !== undefined) this.counts.set(v, n + 1);
    else {
      this.counts.set(v, 1);
      this.keys.splice(lowerBound(this.keys, v), 0, v);
    }
  }

  private drop(v: number): void {
    const n = (this.counts.get(v) ?? 1) - 1;
    if (n > 0) {
      this.counts.set(v, n);
      return;
    }
    this.counts.delete(v);
    this.keys.splice(lowerBound(this.keys, v), 1);
  }

  /** Nearest rank: the smallest figure with at least `p` of them at or below it. `extra` counts one more figure (the reply under way). */
  percentile(p: number, extra?: number): number {
    let pending = extra === undefined ? undefined : Math.round(extra);
    const n = this.ring.length + (pending === undefined ? 0 : 1);
    if (n === 0) return 0;
    const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
    let seen = 0;
    for (const k of this.keys) {
      if (pending !== undefined && pending < k) {
        if (++seen >= rank) return pending;
        pending = undefined;
      }
      seen += this.counts.get(k)!;
      if (seen >= rank) return k;
    }
    // Only the extra figure is left: it is the largest.
    return pending ?? 0;
  }
}

/** One session's Live audio. Times are the engine's clock (ms). */
class SessionMeter {
  private deltas = 0;
  private gated = 0;
  private readonly sizes = new FigureWindow();
  private readonly gaps = new FigureWindow();
  private maxSize = 0;
  private maxGap = 0;
  /** The reply under way: when its first delta came, the audio it has carried, its first and highest lead. */
  private replyStart: number | undefined;
  private replyAudio = 0;
  private replyDeltas = 0;
  private replyFirstLead = 0;
  private replyMaxLead = 0;
  private lastArrival = 0;
  private readonly aheads = new FigureWindow();
  private readonly loop: LoopMonitor | undefined;

  constructor(
    readonly formatRate: number | undefined,
    monitor: () => LoopMonitor | undefined,
  ) {
    try {
      this.loop = monitor();
      this.loop?.enable();
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
    this.sizes.add(ms);
    this.maxSize = Math.max(this.maxSize, ms);
    if (this.replyStart === undefined || at - this.replyStart > this.replyAudio + REPLY_GAP_MS) {
      this.endReply();
      this.replyStart = at;
      this.replyAudio = 0;
      this.replyDeltas = 0;
    } else {
      const gap = at - this.lastArrival;
      this.gaps.add(gap);
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
    if (this.replyStart !== undefined && this.replyDeltas >= REPLY_MIN_DELTAS) this.aheads.add(this.replyMaxLead - this.replyFirstLead);
  }

  get heard(): boolean {
    return this.deltas > 0;
  }

  /**
   * The figures so far. A figure with nothing behind it is absent (the contract makes all but the counts optional):
   * no delta yet, no size; no second delta inside a reply, no arrival; no reply of REPLY_MIN_DELTAS, no lead.
   * `loopDelayMaxMs` is the event loop's longest delay this window (since the last `audio:` line, `resetLoop`), less
   * the monitor's own sampling interval.
   */
  figures(): LiveAudio {
    // The reply under way counts once it has REPLY_MIN_DELTAS.
    const current = this.replyDeltas >= REPLY_MIN_DELTAS ? this.replyMaxLead - this.replyFirstLead : undefined;
    const loop = this.loop ? this.loop.max / 1e6 - LOOP_RESOLUTION_MS : undefined;
    return {
      deltas: this.deltas,
      ...(this.sizes.size ? { deltaMsP50: this.sizes.percentile(0.5), deltaMsMax: Math.round(this.maxSize) } : {}),
      ...(this.gaps.size ? { arrivalP99Ms: this.gaps.percentile(0.99), arrivalMaxMs: Math.round(this.maxGap) } : {}),
      ...(this.aheads.size || current !== undefined ? { aheadMs: this.aheads.percentile(0.5, current) } : {}),
      gatedFrames: this.gated,
      ...(loop !== undefined && Number.isFinite(loop) ? { loopDelayMaxMs: Math.max(0, Math.round(loop)) } : {}),
      ...(this.formatRate !== undefined ? { formatRate: this.formatRate } : {}),
    };
  }

  /** The `audio:` line went out: the event loop's window starts again. */
  resetLoop(): void {
    try {
      this.loop?.reset();
    } catch {
      // the monitor is gone; the figure stays as it was
    }
  }

  dispose(): void {
    try {
      this.loop?.disable();
    } catch {
      // already off
    }
  }
}

/** What SessionMeter reads of `monitorEventLoopDelay` (a seam for the tests). `max` is in nanoseconds. */
export interface LoopMonitor {
  readonly max: number;
  enable(): void;
  disable(): void;
  reset(): void;
}

export interface AudioTelemetryOptions {
  readonly now: () => number;
  /** daemon.log (the engine's `log.info`). */
  readonly log: (line: string) => void;
  /** The event-loop monitor for each session; `monitorEventLoopDelay` sampling every LOOP_RESOLUTION_MS by default. */
  readonly loopMonitor?: () => LoopMonitor | undefined;
}

const defaultLoopMonitor = (): LoopMonitor => monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });

/**
 * The engine's half: the open session's meter, the rate-limited line, the close row.
 *
 * At most one meter runs: a session the engine opens retires every other one (its event-loop monitor stops at
 * once). A session can end with no `closed` behind it (live.on("error") settles the transcript and nothing more),
 * so a meter left to its close could run for the daemon's lifetime. A retired meter's last figures are kept for the
 * newest RETIRED_KEEP sessions, so a `closed` that comes after the next session opened still writes its row.
 */
export class AudioTelemetry {
  private readonly meters = new Map<string, SessionMeter>();
  /** Retired sessions' last Live figures (undefined when they heard nothing), oldest first. */
  private readonly retired = new Map<string, LiveAudio | undefined>();
  /** The session the snapshot and the line report: the last one opened and not yet closed. */
  private current: string | undefined;
  /** What the last line said, its event-loop figure aside (that one moves every window). */
  private lastKey = "";
  private lastLineAt = Number.NEGATIVE_INFINITY;
  /**
   * The longest app-side wait in any frame since the last line. A frame's `playout.lateMaxMs` covers only the app's
   * window before it, and the line goes out at most every LINE_EVERY_MS, so a stall in a frame that never became a
   * line would be in no line. The next line carries it instead.
   */
  private lateSinceLine: number | undefined;

  constructor(private readonly opts: AudioTelemetryOptions) {}

  /** Meters running now; at most one. */
  get running(): number {
    return this.meters.size;
  }

  private meterFor(sessionId: string, formatRate: number | undefined): SessionMeter {
    const meter = new SessionMeter(formatRate, this.opts.loopMonitor ?? defaultLoopMonitor);
    for (const [id, other] of this.meters) {
      if (id === sessionId) {
        other.dispose();
        continue;
      }
      // Retired: its monitor stops now; its figures wait for a late close.
      this.retired.delete(id);
      this.retired.set(id, other.heard ? other.figures() : undefined);
      other.dispose();
    }
    this.meters.clear();
    while (this.retired.size > RETIRED_KEEP) this.retired.delete(this.retired.keys().next().value as string);
    this.meters.set(sessionId, meter);
    return meter;
  }

  /** session.started: a fresh meter (any other one retired), and the format Live echoed in daemon.log. */
  open(sessionId: string, format: { readonly type?: string; readonly rate?: number } | undefined): void {
    const rate = typeof format?.rate === "number" && Number.isFinite(format.rate) ? format.rate : undefined;
    this.retired.delete(sessionId);
    this.meterFor(sessionId, rate);
    this.current = sessionId;
    this.lastKey = "";
    this.lastLineAt = Number.NEGATIVE_INFINITY;
    this.lateSinceLine = undefined;
    this.opts.log(rate !== undefined ? `audio format echoed: ${format?.type ?? "audio"} ${rate} Hz (session ${sessionId})` : `audio format: session.started echoed none (session ${sessionId})`);
  }

  /** One of Live's output deltas, played or dropped by the output gate (`gated`). A retired session's are not counted. */
  delta(sessionId: string | undefined, bytes: number, gated: boolean): void {
    if (!sessionId || this.retired.has(sessionId)) return;
    let meter = this.meters.get(sessionId);
    if (!meter) {
      meter = this.meterFor(sessionId, undefined);
      this.current = sessionId;
    }
    meter.delta(bytes, this.opts.now(), gated);
  }

  /** The snapshot's field: present while a session is open. */
  snapshotField(): { readonly liveAudio?: LiveAudio } {
    const meter = this.current ? this.meters.get(this.current) : undefined;
    return meter ? { liveAudio: meter.figures() } : {};
  }

  /**
   * The app reported its graph: one `audio:` line when a session is open, LINE_EVERY_MS have passed and it says
   * something new. Every frame's wait counts toward the next line's `late max`, whether or not it makes a line.
   */
  frame(state: AudioState | undefined): void {
    const meter = this.current ? this.meters.get(this.current) : undefined;
    if (!meter || !state || !(state.playout || state.duck || state.output)) return;
    if (state.playout) this.lateSinceLine = Math.max(this.lateSinceLine ?? 0, state.playout.lateMaxMs);
    const now = this.opts.now();
    if (now - this.lastLineAt < AUDIO_LINE_EVERY_MS) return;
    const shown = this.sinceLine(state);
    const live = meter.figures();
    const { loopDelayMaxMs: _loop, ...steady } = live;
    const key = audioLine(shown, steady);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lastLineAt = now;
    this.opts.log(`audio: ${audioLine(shown, live)}`);
    // The line carried this window's event-loop figure and wait; the next ones start now.
    this.lateSinceLine = undefined;
    meter.resetLoop();
  }

  /** The frame as the line prints it: `late max` is the longest wait since the last line, not only the frame's own window. */
  private sinceLine(state: AudioState): AudioState {
    const p = state.playout;
    if (!p || this.lateSinceLine === undefined || this.lateSinceLine <= p.lateMaxMs) return state;
    return { ...state, playout: { ...p, lateMaxMs: this.lateSinceLine } };
  }

  /** Session close: the summary line, and the ledger row when anything was measured (undefined otherwise). */
  close(sessionId: string, state: AudioState | undefined): LedgerRow | undefined {
    const meter = this.meters.get(sessionId);
    this.meters.delete(sessionId);
    meter?.dispose();
    const live = meter ? (meter.heard ? meter.figures() : undefined) : this.retired.get(sessionId);
    this.retired.delete(sessionId);
    const app = state && (state.playout || state.duck || state.output) ? state : undefined;
    // The open session's summary carries the waits since its last line too; the row keeps the app's own figures.
    const shown = app && this.current === sessionId ? this.sinceLine(app) : app;
    if (this.current === sessionId) {
      this.current = undefined;
      this.lateSinceLine = undefined;
    }
    if (!live && !app) return undefined;
    this.opts.log(`audio (session ${sessionId} closed): ${audioLine(shown, live)}`);
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
 * The daemon.log line: `playout 0 underruns (would be 4) · queued 121 ms min 96 · late max 7 ms (31 ms since start) ·
 * duck 2 (2 gate · 2 confirmed) · residual p50 -61 p99 -49 dBFS · output rms -21.8 peak -4.1 dBFS vol 0.62 ·
 * live 40 ms deltas · arrival p99 31 ms · ahead 0 ms · loop max 12 ms`. A part with nothing behind it is left out.
 */
export function audioLine(state: AudioState | undefined, live: LiveAudio | undefined): string {
  const parts: string[] = [];
  const p = state?.playout;
  // `late max` is the app's window (the line's caller folds every frame since the last line in); the figure since the
  // graph started rides beside it, so a stall in a window no frame carried still reaches the log.
  const graph = p?.lateMaxGraphMs !== undefined ? ` (${db0(p.lateMaxGraphMs)} ms since start)` : "";
  if (p) parts.push(`playout ${p.underruns} underrun${p.underruns === 1 ? "" : "s"} (would be ${p.wouldBeUnderruns}) · queued ${db0(p.queuedMs)} ms${p.queuedMinMs !== undefined ? ` min ${db0(p.queuedMinMs)}` : ""} · late max ${db0(p.lateMaxMs)} ms${graph}`);
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
