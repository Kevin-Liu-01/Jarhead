import { LiveSession, type SessionConfig, type WebSocketLike } from "@jarhead/live";
import { Engine } from "../engine.ts";
import { until, world, type World } from "./world.ts";

/**
 * A real LiveSession over a fake socket, on the engine's clock: the room-talk gate's replays (room-talk-gate.test.ts,
 * room-talk-gate-review.test.ts). Live's frames go in at their session times — output transcript and audio every 100 ms,
 * input transcript, delegations, usage, the `appended` acks when a script sends them — with a tick each second, and the
 * ear fed as the app's recogniser would. The server answers the engine's own pre-sleep clause as GPT-Live-1 answers any
 * append (LC-5 medians: first transcript +1586 ms, first audible frame +1888 ms).
 */

export const tick = (engine: Engine): void => (engine as unknown as { tick(): void }).tick();

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: { at: number; line: string }[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  closed = false;
  constructor(private readonly clock: () => number) {}
  send(data: string): void {
    this.sent.push({ at: this.clock(), line: data });
    // The server answers a graceful close at once, as GPT-Live-1 did in LC-4 (630 ms) — here in the same turn.
    if ((JSON.parse(data) as { type: string }).type === "session.close") {
      queueMicrotask(() => {
        this.receive({ type: "session.closed", event_id: "c", reason: "close_requested", session: resource("live_1"), usage: { seconds: 60 } });
        this.close();
      });
    }
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
    if (this.readyState === 3) return;
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** The client events sent, with the engine clock they left at. */
  events(): { at: number; type: string; content?: string; delegationId?: string | null }[] {
    return this.sent.map((s) => {
      const e = JSON.parse(s.line) as { type: string; content?: string; delegation_id?: string | null };
      return { at: s.at, type: e.type, ...(e.content !== undefined ? { content: e.content } : {}), ...(e.delegation_id !== undefined ? { delegationId: e.delegation_id } : {}) };
    });
  }
}

export const resource = (id: string) => ({ id, expires_at: Math.floor(Date.now() / 1000) + 3600, model: "gpt-live-1", status: "active" as const });
/** 100 ms of PCM16 at 24 kHz: silence, or a level `rms()` reads as ~0.09 (Live's audible frames read 0.013–0.039). */
export const SILENT = Buffer.alloc(4800).toString("base64");
export const VOICED = (() => {
  const b = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) b.writeInt16LE(i % 2 ? 1000 : -1000, i * 2);
  return b.toString("base64");
})();
export const level = (pcm: Buffer): number => {
  let sum = 0;
  for (let i = 0; i < pcm.length >> 1; i++) sum += (pcm.readInt16LE(i * 2) / 32768) ** 2;
  return Math.min(1, Math.sqrt(sum / Math.max(1, pcm.length >> 1)) * 3);
};

/** GPT-Live-1 answers an append: first transcript +1586 ms, first audible frame +1888 ms (LC-5 medians, n=10). */
export const APPEND_TRANSCRIPT_MS = 1586;
export const APPEND_AUDIBLE_MS = 1888;

/** A scripted session: events at session ms, frames every 100 ms (audible inside `voiced` runs), a tick each second. */
export interface Script {
  /** [from, to] session ms of audible output frames (frame times, inclusive). */
  readonly voiced: readonly (readonly [number, number])[];
  /** How far off the 100 ms frame grid a run may start or end: LC-7's recorded runs are off it (50), a scripted run is on it (0). */
  readonly slop?: number;
  readonly at: readonly { readonly t: number; readonly run: () => void | Promise<void> }[];
  /** The server answers the pre-sleep clause's append with " going to sleep." (transcript, then sound). */
  readonly answerClause?: boolean;
}

export interface Rig {
  readonly w: World;
  readonly sock: () => FakeSocket;
  /** Engine clock of a session ms. */
  readonly wall: (s: number) => number;
  /** Every frame the speaker got, with the session ms it went out at and whether it was audible. */
  readonly played: { s: number; audible: boolean }[];
  /** Session ms the pre-sleep clause's append left at, once it did. */
  clauseS: number | undefined;
  run(script: Script, untilS: number): Promise<void>;
  input(delta: string, startMs: number, endMs: number): void;
  output(delta: string, startMs: number, endMs: number): void;
  delegation(id: string, offsetMs: number): void;
  /** The server acknowledges every commentary and instructions append the engine sent so far and has not acked (`session.*.appended`). */
  ack(): void;
}

export async function rig(idleMinutes: number): Promise<Rig> {
  const socks: FakeSocket[] = [];
  let t0 = 0;
  const w = world({
    makeLive: (config: SessionConfig): LiveSession => {
      const sock = new FakeSocket(() => w.clock.t);
      socks.push(sock);
      const live = new LiveSession({ apiKey: "k", config, webSocketFactory: () => sock });
      // The session timeline on the engine's clock (LiveSession reads Date.now), so typed lines and Live's own stamps agree.
      Object.defineProperty(live, "nowMs", { get: () => (t0 === 0 ? 0 : w.clock.t - t0) });
      return live;
    },
  });
  const { engine, clock } = w;
  await engine.start();
  await engine.ready();
  engine.updateSettings({ idleSleepMinutes: idleMinutes });
  const waking = engine.wake("test");
  await until(() => socks.length === 1);
  socks[0]!.open();
  t0 = clock.t;
  socks[0]!.receive({ type: "session.started", event_id: "e1", session: resource("live_1") });
  await waking;
  const played: { s: number; audible: boolean }[] = [];
  engine.on("audio", (pcm: Buffer) => played.push({ s: clock.t - t0, audible: level(pcm) >= Engine.AUDIBLE_OUTPUT_LEVEL }));
  const sock = (): FakeSocket => socks[socks.length - 1]!;
  let seq = 0;
  let acked = 0;
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
  const r: Rig = {
    w,
    sock,
    wall: (s) => t0 + s,
    played,
    clauseS: undefined,
    async run(script, untilS) {
      type Ev = { t: number; k: number; run: () => void | Promise<void> };
      const voiced: (readonly [number, number])[] = [...script.voiced];
      const slop = script.slop ?? 0;
      const evs: Ev[] = [];
      const from = clock.t - t0;
      for (let t = Math.ceil(from / 100) * 100 + 48; t <= untilS; t += 100) {
        evs.push({ t, k: 1, run: () => sock().receive({ type: "session.output_audio.delta", delta: voiced.some(([a, b]) => t >= a - slop && t <= b + slop) ? VOICED : SILENT }) });
      }
      for (let t = Math.ceil(from / 1000) * 1000; t <= untilS; t += 1000) evs.push({ t, k: 2, run: () => tick(engine) });
      for (const e of script.at) if (e.t >= from && e.t <= untilS) evs.push({ t: e.t, k: 0, run: e.run });
      evs.sort((a, b) => a.t - b.t || a.k - b.k);
      let seen = sock().sent.length;
      for (let i = 0; i < evs.length; i++) {
        const e = evs[i]!;
        clock.t = t0 + e.t;
        await e.run();
        if (e.k !== 1) await flush();
        // The server answers the engine's own pre-sleep clause, as GPT-Live-1 answers any append.
        if (script.answerClause && sock().sent.length > seen) {
          for (const sent of sock().events().slice(seen)) {
            if (sent.type !== "session.instructions.append" || !/going to sleep in about/.test(sent.content ?? "") || r.clauseS !== undefined) continue;
            const c = sent.at - t0;
            r.clauseS = c;
            voiced.push([c + APPEND_AUDIBLE_MS, c + APPEND_AUDIBLE_MS + 700]);
            const say = { t: c + APPEND_TRANSCRIPT_MS, k: 0, run: () => r.output(" going to sleep.", c + APPEND_TRANSCRIPT_MS - 200, c + APPEND_TRANSCRIPT_MS + 300) };
            const at = evs.findIndex((x, j) => j > i && (x.t > say.t || (x.t === say.t && x.k > say.k)));
            evs.splice(at < 0 ? evs.length : at, 0, say);
          }
          seen = sock().sent.length;
        }
      }
      await flush();
    },
    input(delta, startMs, endMs) {
      sock().receive({ type: "session.input_transcript.delta", event_id: `i${++seq}`, delta, start_ms: startMs, end_ms: endMs });
    },
    output(delta, startMs, endMs) {
      sock().receive({ type: "session.output_transcript.delta", event_id: `o${++seq}`, delta, start_ms: startMs, end_ms: endMs });
    },
    delegation(id, offsetMs) {
      sock().receive({ type: "session.delegation.created", event_id: `d${++seq}`, offset_ms: offsetMs, delegation: { id, type: "delegation", target: "client" } });
    },
    ack() {
      const s = clock.t - t0;
      for (const sent of sock().sent.slice(acked)) {
        const e = JSON.parse(sent.line) as { type: string; event_id?: string };
        const m = /^session\.(commentary|instructions)\.append$/.exec(e.type);
        if (m) sock().receive({ type: `session.${m[1]}.appended`, event_id: `a${++seq}`, client_event_id: e.event_id, start_ms: s, end_ms: s });
      }
      acked = sock().sent.length;
    },
  };
  return r;
}

/** The app's recogniser on a line: partials word by word across the speech, then the final. */
export function earLine(r: Rig, segment: number, text: string, fromS: number, toS: number, finalS: number): { t: number; run: () => void }[] {
  const words = text.split(" ");
  const out: { t: number; run: () => void }[] = [];
  words.forEach((_, k) => {
    const t = Math.round(fromS + 150 + ((toS - fromS) * (k + 1)) / words.length);
    out.push({ t, run: () => r.w.engine.ear(words.slice(0, k + 1).join(" ").replace(/[.,!?]+$/, ""), false, segment, r.wall(t)) });
  });
  out.push({ t: finalS, run: () => r.w.engine.ear(text, true, segment, r.wall(finalS)) });
  return out;
}

/** The first audible frame played at or after `fromS` (session ms), if any. */
export function firstVoicedPlayedAt(r: Rig, fromS: number): number | undefined {
  return r.played.find((p) => p.audible && p.s >= fromS)?.s;
}

/** Audible frames the speaker got between two session times. */
export const audibleFrom = (r: Rig, from: number, to = Infinity): number[] => r.played.filter((p) => p.audible && p.s >= from && p.s <= to).map((p) => p.s);

/** The engine's open LiveSession. */
export const liveOf = (w: World): LiveSession => (w.engine as unknown as { live: LiveSession }).live;
