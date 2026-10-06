import type { TranscriptItem } from "@jarhead/protocol";

/**
 * The engine asks (LC-7, 2026-10-06). GPT-Live-1 answers what it hears on its own: the protocol has no turn-detection
 * setting, no `create_response` switch and no cancel (packages/live/src/events.ts; AGENTS.md "Stop is local"), and its
 * `response.create` continues the Responses backend, not the voice. F4's orders asked it to keep quiet for the room;
 * in both LC-7 runs it answered the room anyway and delegated its commands, and every answer re-armed the idle clock.
 * So the server's turn-taking runs untouched and the engine decides, per voice turn and before its first audible
 * frame, whether it asked for that turn. Everything it did not ask for is kept on the record and dropped: off the
 * speaker, off the brain, off the hands, off the idle clock.
 *
 * - **The verdict**, per utterance of Kevin's side as its words arrive: `typed`; `named` (its words say the name, the
 *   voice's mishearings included, or the ear heard the name just before); `window` (it began inside the exchange, on
 *   the session timeline, or on the wall clock as the ear judges it); else `room`. A later fragment may upgrade it to
 *   named, never the other way. Items the Transcript split around the voice's words ("…, Jar" | reply | "head") are one
 *   utterance when the second begins within UTTERANCE_GAP_MS on the timeline and arrives within SPLIT_ARRIVAL_MS.
 * - **The exchange** is `exchangeEndMs` on the session timeline: the session start, named or typed words, a circle,
 *   and Jarhead's own granted speech move it; room talk inside the window, the pre-sleep clause and an answer nobody
 *   asked for do not. It is capped: EXCHANGE_MAX_MS after the last anchor (a name, a typed line, a circle, a Go, a
 *   wake, a resume, a line the engine asked the voice to say), nothing is "inside the exchange" any more, so a TV the
 *   voice keeps answering on its own cannot chain it.
 * - **A voice turn** is the voice's words or sound with no gap of VOICE_TURN_GAP_MS. It is granted when it takes an
 *   engine append's ask, replies to an addressed utterance that ended under EXCHANGE_WINDOW_MS before it, speaks for
 *   addressed work still running with nothing from the room since, or goes on inside the exchange. A turn that looks
 *   unasked stays open to the name until its first audible frame (160-350 ms behind its words in every LC-7 reply);
 *   then it is locked. A locked turn's frames are all dropped, silence too, unless the utterance it answers is named
 *   within LATE_NAME_MS: then its frames from the first audible one (RING_FRAMES kept) go to the speaker after all.
 * - **A delegation** is judged on the utterance Live raised it for. One that looks like room talk waits up to
 *   DELEGATION_LATE_MS for a late name before it is refused.
 *
 * Pure apart from the injected clock and one backup timer per waiting delegation. The engine owns the wiring.
 */

export type Verdict = "typed" | "named" | "window" | "room";
/** Why a voice turn was asked for. */
export type VoiceGrant = Verdict | "asked" | "work" | "exchange";

/** "Mid-exchange": an addressed turn this recent (Engine.EXCHANGE_WINDOW_MS, and the voice's orders' "about eight seconds"). */
export const EXCHANGE_WINDOW_MS = 8000;
/** The exchange's cap after its anchor (a name, a typed line, a circle, a Go / wake / resume). */
export const EXCHANGE_MAX_MS = 120_000;

/** Words that name Jarhead: the voice's orders' list ("Jarhead", also heard as "jar head", "jarred", "jared"). */
const NAMES = /\b(jarhead|jar head|jar-head|jarred|jared)\b/i;
const NAMES_ALL = /\b(jarhead|jar head|jar-head|jarred|jared)\b/gi;
/** A transcript fragment that ends a sentence. */
const SENTENCE_END = /[.!?]["')\]]*\s*$/;

export interface AttentionSeams {
  /** The engine's clock (wall ms). */
  readonly now: () => number;
  /** Words that are Jarhead's own line back through the microphone: they never name it. */
  readonly echo: (text: string) => boolean;
  /** The wall-clock exchange: an addressed turn within EXCHANGE_WINDOW_MS, with the cap open (Engine.inExchange). */
  readonly inExchange: () => boolean;
  /** Work Kevin asked for is running (the Delegator's active delegation). */
  readonly working: () => boolean;
  /** Jarhead's granted words, for the engine's clocks. `clause`: the pre-sleep clause's turn, which counts for nothing. */
  readonly spoke: (grant: VoiceGrant, clause: boolean) => void;
  readonly log?: (line: string) => void;
}

/** What one fragment of Kevin's side did. */
export interface Heard {
  readonly verdict: Verdict;
  /** This fragment made the utterance named: the engine's `named()` turn, once per item. */
  readonly named: boolean;
  /** Frames of a reply a late name released, oldest first, for the speaker. */
  readonly released: readonly Buffer[];
}

/** What the gate did this session, for the log and the LC-7 judge. */
export interface AttentionStats {
  /** Output frames of turns nobody asked for, dropped, and how many of them carried sound. */
  droppedFrames: number;
  droppedAudibleFrames: number;
  /** The words of those turns (still on the transcript). */
  droppedWords: string;
  /** Turns dropped. */
  droppedTurns: number;
  /** Frames a late name handed to the speaker after all. */
  releasedFrames: number;
  /** Delegations refused as not addressed. */
  refused: number;
}

/** One of Kevin's items as the gate keeps it. */
interface KevinItem {
  readonly id: string;
  readonly startMs: number;
  endMs: number;
  text: string;
  /** Wall clock of its last fragment. */
  lastAt: number;
  readonly typed: boolean;
}

/** One utterance over one or more items (the Transcript splits an item when the voice's words land in between). */
interface Utterance {
  readonly items: Map<string, string>;
  endMs: number;
  /** Wall clock of its last fragment. */
  lastAt: number;
}

interface VoiceTurn {
  /** Session timeline: the turn's first words (or the client's estimate at its first sound). */
  readonly startMs: number;
  lastAt: number;
  /** It took an append's ask. */
  readonly asked: boolean;
  /** The ask it took was the pre-sleep clause's: heard, never an addressed turn, never the exchange. */
  readonly clause: boolean;
  /** undefined until decided; null: nobody asked. */
  grant: VoiceGrant | null | undefined;
  /** Kevin's last item when the turn began: what it answers, for a late name. */
  readonly answers: string | undefined;
  /** Live's output item its last words went to. */
  itemId?: string;
  /** Its last words ended a sentence (. ! ?). */
  sentenceEnded?: boolean;
  /** Where its words end so far (session timeline); undefined while it has only sound. */
  endMs?: number;
  /** Wall clock of its first audible frame, when it was locked. */
  lockedAt?: number;
  words: string;
}

interface Waiter {
  /** The item the delegation was raised for, or undefined: the next utterance answers it. */
  itemId: string | undefined;
  readonly deadline: number;
  readonly settle: (named: boolean) => void;
}

export class VoiceAttention {
  /** A new voice turn starts after this long without the voice's words or sound (Live's barge-in cut and its answer are two). */
  static readonly VOICE_TURN_GAP_MS = 600;
  /** An engine append (a typed line, a narration, a thread's line, the clause) asks for the first voice turn within this long (LC-5: p90 2.25 s). */
  static readonly ASK_GRANT_MS = 6000;
  /**
   * The voice had paused this long (no words, no sound: Live streams a reply's frames every 100 ms) when the engine
   * asked it for words: what it says next answers the ask, a turn of its own, even inside VOICE_TURN_GAP_MS. A reply
   * still streaming when the ask lands goes on as the turn it was.
   */
  static readonly ASK_SPLIT_MS = 250;
  /** The ear runs ~1 s ahead of Live's transcript: a Live utterance that starts within this long after the ear heard the name is named. */
  static readonly EAR_NAME_MS = 4000;
  /** The ear's name upgrades the utterance Live is still transcribing when its last fragment is this recent. */
  static readonly EAR_OPEN_MS = 2000;
  /** The Transcript's GAP_MS: Kevin's items this close on the session timeline may be one utterance… */
  static readonly UTTERANCE_GAP_MS = 1400;
  /** …when the second's first fragment arrives this soon after the first's last (LC-6 trial 3: 'head' 582 ms after 'Jar'). */
  static readonly SPLIT_ARRIVAL_MS = 1000;
  /** A name this late after a locked turn's first audible frame still releases that turn (LC-6 trial 3: 410 ms). */
  static readonly LATE_NAME_MS = 600;
  /** Frames a locked turn keeps for a late name: 0.8 s of Live's 100 ms deltas. */
  static readonly RING_FRAMES = 8;
  /**
   * A delegation whose words look like room talk waits this long for a late name before it is refused: Live's
   * delegation comes 190-727 ms before its reply's first words (LC-7, LC-10), plus LATE_NAME_MS. Only room-looking
   * delegations wait; an addressed one never does.
   */
  static readonly DELEGATION_LATE_MS = 1200;
  static readonly VERDICTS_KEPT = 128;
  private static readonly ITEMS_KEPT = 32;

  private readonly verdicts = new Map<string, Verdict>();
  private readonly items: KevinItem[] = [];
  private utterance: Utterance | undefined;
  private exchangeEndMs = Number.NEGATIVE_INFINITY;
  private anchorAt = Number.NEGATIVE_INFINITY;
  private askAt = 0;
  private askClause = false;
  private earNamedAt = 0;
  /** The name's count in each ear segment so far: a partial repeats the segment's earlier words, and only a new name counts. */
  private readonly earNames = new Map<number, number>();
  private turn: VoiceTurn | undefined;
  private ring: Buffer[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly delegations = new Map<string, Verdict | Promise<Verdict>>();
  readonly stats: AttentionStats = { droppedFrames: 0, droppedAudibleFrames: 0, droppedWords: "", droppedTurns: 0, releasedFrames: 0, refused: 0 };

  constructor(private readonly seams: AttentionSeams) {}

  private now(): number {
    return this.seams.now();
  }

  // ------------------------------------------------------------------ the session and the exchange

  /**
   * A new session: its timeline starts at 0. `open`: the exchange carries into it (a Go, a wake or a resume opens one at
   * the session start; a reconnect only when one was open as the server dropped the last). The day's counts stay.
   */
  reset(open: boolean): void {
    this.turn = undefined;
    this.ring = [];
    this.askAt = 0;
    this.askClause = false;
    this.items.length = 0;
    this.utterance = undefined;
    this.verdicts.clear();
    this.delegations.clear();
    this.exchangeEndMs = open ? 0 : Number.NEGATIVE_INFINITY;
    for (const w of [...this.waiters]) w.settle(false);
  }

  /** Kevin turned to Jarhead (a name, a typed line, a circle, a Go / wake / resume): the exchange's cap counts from here. */
  anchor(): void {
    this.anchorAt = this.now();
  }

  /** The exchange's cap has not run out. */
  capOpen(): boolean {
    return this.now() - this.anchorAt < EXCHANGE_MAX_MS;
  }

  /** Whether words that begin at `startMs` (session timeline) are inside the exchange. */
  private inWindow(startMs: number): boolean {
    return startMs < this.exchangeEndMs + EXCHANGE_WINDOW_MS && this.capOpen();
  }

  /** A circle or a captured window: Kevin pointed at something for Jarhead; the exchange opens from now (`nowMs`). */
  gesture(nowMs: number): void {
    this.anchor();
    this.exchangeEndMs = Math.max(this.exchangeEndMs, nowMs);
  }

  /**
   * The engine asked the voice for words (a `commentary` or `instructions` append, LiveSession's `ask`; a Responses
   * backend's result for addressed work). The first voice turn within ASK_GRANT_MS takes it. `clause`: the pre-sleep
   * clause's ask, whose turn is heard and counts for nothing.
   */
  ask(clause = false): void {
    this.askAt = this.now();
    this.askClause = clause;
  }

  // ------------------------------------------------------------------ Kevin's side

  /** A typed line: addressed, an anchor, and the exchange is open from it. It closes any spoken utterance. */
  typed(item: TranscriptItem): void {
    this.utterance = undefined;
    this.track(item, true);
    this.setVerdict(item.id, "typed");
    this.exchangeEndMs = Math.max(this.exchangeEndMs, item.endMs);
    this.anchor();
    this.settleWaiters(new Set([item.id]));
  }

  /**
   * A fragment of Kevin's side of Live's transcript landed; `item` is its utterance so far. Judged as it arrives (see
   * the class comment); named words open the exchange from where they end and anchor its cap, an utterance merely
   * inside the window does not extend it (a TV talking on would hold it for ever) — Jarhead's answer to it does.
   */
  heard(item: TranscriptItem, _delta: string): Heard {
    this.expire();
    const was = this.verdicts.get(item.id);
    this.track(item, false);
    const u = this.utteranceOf(item);
    const named = NAMES.test([...u.items.values()].join(" ")) && !this.seams.echo(item.text);
    // An item that continues an utterance split around the voice's words is that utterance: its verdict, or better.
    const joined = [...u.items.keys()].filter((id) => id !== item.id).map((id) => this.verdicts.get(id));
    let verdict: Verdict;
    if (was === undefined) {
      const earNamed = this.earNamedAt > 0 && this.now() - this.earNamedAt < VoiceAttention.EAR_NAME_MS;
      const inherited = joined.includes("named") ? "named" : joined.includes("window") ? "window" : undefined;
      verdict = named || earNamed ? "named" : (inherited ?? (this.inWindow(item.startMs) || this.seams.inExchange() ? "window" : "room"));
      if (earNamed) this.earNamedAt = 0;
    } else verdict = named && was !== "typed" ? "named" : was;
    let released: Buffer[] = [];
    const upgraded = verdict === "named" && was !== "named";
    if (upgraded) released = this.upgrade(u);
    else this.setVerdict(item.id, verdict);
    if (verdict === "named") {
      this.exchangeEndMs = Math.max(this.exchangeEndMs, item.endMs);
      this.anchor();
    }
    if (verdict === "room") this.awaitName(item.id);
    else this.settleWaiters(new Set(u.items.keys()));
    // One utterance is one named turn, however many items Live split it into.
    return { verdict, named: upgraded && !joined.includes("named"), released };
  }

  /**
   * The on-device ear heard words of segment `segment`. A new name in them (its partials repeat the segment's earlier
   * words) names the next Live utterance within EAR_NAME_MS, and the one Live is still transcribing when its last
   * fragment is under EAR_OPEN_MS old and shares a word with the ear's — the ear runs ~1 s ahead of Live's transcript,
   * so this is what wins the race when the name comes last. Never an older room line.
   */
  ear(text: string, segment: number, isFinal: boolean): Heard | undefined {
    const count = (text.match(NAMES_ALL) ?? []).length;
    const seen = this.earNames.get(segment) ?? 0;
    if (isFinal) this.earNames.delete(segment);
    else this.earNames.set(segment, Math.max(seen, count));
    if (this.earNames.size > 16) this.earNames.delete(this.earNames.keys().next().value as number);
    if (count <= seen || this.seams.echo(text)) return undefined;
    this.earNamedAt = this.now();
    const open = this.items[this.items.length - 1];
    if (!open || open.typed || this.now() - open.lastAt > VoiceAttention.EAR_OPEN_MS || !sharesWords(text, open.text)) return undefined;
    const was = this.verdicts.get(open.id);
    if (was === "named" || was === "typed") return undefined;
    const u = this.utterance && this.utterance.items.has(open.id) ? this.utterance : { items: new Map([[open.id, open.text]]), endMs: open.endMs, lastAt: open.lastAt };
    const released = this.upgrade(u);
    this.exchangeEndMs = Math.max(this.exchangeEndMs, open.endMs);
    this.anchor();
    this.settleWaiters(new Set(u.items.keys()));
    return { verdict: "named", named: true, released };
  }

  /** Whether one of Kevin's utterances was said to Jarhead. One with no verdict is the room's unless typed: closed by default. */
  addressed(item: Pick<TranscriptItem, "id" | "source">): boolean {
    return this.verdictOf(item) !== "room";
  }

  /** The verdict an item stands at. */
  verdictOf(item: Pick<TranscriptItem, "id" | "source">): Verdict {
    return this.verdicts.get(item.id) ?? (item.source === "typed" ? "typed" : "room");
  }

  private verdictOfId(id: string): Verdict {
    const known = this.verdicts.get(id);
    if (known) return known;
    return this.items.find((i) => i.id === id)?.typed ? "typed" : "room";
  }

  /** Keep Kevin's item as the gate sees it: Kevin's last item is what a voice turn answers. */
  private track(item: TranscriptItem, typed: boolean): void {
    const now = this.now();
    const known = this.items.find((i) => i.id === item.id);
    if (known) {
      known.endMs = item.endMs;
      known.text = item.text;
      known.lastAt = now;
      return;
    }
    this.items.push({ id: item.id, startMs: item.startMs, endMs: item.endMs, text: item.text, lastAt: now, typed: typed || item.source === "typed" });
    if (this.items.length > VoiceAttention.ITEMS_KEPT) this.items.shift();
  }

  /** The utterance this item belongs to: its own, the open one it continues across a split, or a new one. */
  private utteranceOf(item: TranscriptItem): Utterance {
    const open = this.utterance;
    const now = this.now();
    if (open?.items.has(item.id)) {
      open.items.set(item.id, item.text);
      open.endMs = Math.max(open.endMs, item.endMs);
      open.lastAt = now;
      return open;
    }
    const split = open !== undefined && !this.verdicts.has(item.id) && item.startMs - open.endMs <= VoiceAttention.UTTERANCE_GAP_MS && now - open.lastAt <= VoiceAttention.SPLIT_ARRIVAL_MS;
    if (open && split) {
      open.items.set(item.id, item.text);
      open.endMs = Math.max(open.endMs, item.endMs);
      open.lastAt = now;
      return open;
    }
    const u: Utterance = { items: new Map([[item.id, item.text]]), endMs: item.endMs, lastAt: now };
    this.utterance = u;
    return u;
  }

  /** Every item of the utterance is named now; a locked reply to it, begun under LATE_NAME_MS ago, is released. */
  private upgrade(u: Utterance): Buffer[] {
    for (const id of u.items.keys()) if (this.verdicts.get(id) !== "typed") this.setVerdict(id, "named");
    return this.release(u);
  }

  /**
   * A locked turn that answered this utterance, whose first audible frame came under LATE_NAME_MS ago, is granted
   * after all: its frames from that first audible one go to the speaker now (RING_FRAMES at most), its words count.
   */
  private release(u: Utterance): Buffer[] {
    const turn = this.turn;
    if (!turn || turn.grant !== null || turn.lockedAt === undefined || turn.answers === undefined || !u.items.has(turn.answers)) return [];
    if (this.now() - turn.lockedAt > VoiceAttention.LATE_NAME_MS) return [];
    turn.grant = "named";
    this.stats.droppedTurns = Math.max(0, this.stats.droppedTurns - 1);
    if (turn.endMs !== undefined) this.speak(turn, turn.endMs);
    const out = this.ring;
    this.ring = [];
    this.stats.releasedFrames += out.length;
    this.seams.log?.(`attention: a late name released ${out.length} held frame(s) of the reply`);
    return out;
  }

  private setVerdict(id: string, verdict: Verdict): void {
    this.verdicts.delete(id);
    this.verdicts.set(id, verdict);
    if (this.verdicts.size <= VoiceAttention.VERDICTS_KEPT) return;
    const oldest = this.verdicts.keys().next();
    if (!oldest.done) this.verdicts.delete(oldest.value);
  }

  // ------------------------------------------------------------------ the voice's side

  /**
   * An output transcript delta (`itemId`: Live's output item on the Transcript). "spoke": granted, the engine counts it
   * as Jarhead's words; "pending": undecided until its first audible frame (its words count then, if granted);
   * "dropped": a turn nobody asked for — on the record and nothing more.
   */
  output(delta: string, startMs: number, endMs: number, itemId: string): "spoke" | "pending" | "dropped" {
    this.expire();
    const turn = this.turnAt(startMs, itemId);
    turn.sentenceEnded = SENTENCE_END.test(delta);
    turn.endMs = Math.max(turn.endMs ?? endMs, endMs);
    turn.words += delta;
    if (turn.grant === undefined) return "pending";
    if (turn.grant === null) {
      this.stats.droppedWords += delta;
      return "dropped";
    }
    this.speak(turn, endMs);
    return "spoke";
  }

  /**
   * An output audio frame (`nowMs`: the session timeline now): true to play it. An audible frame decides its turn at the
   * latest; a turn nobody asked for is dropped whole, its silence too, until the voice has been quiet VOICE_TURN_GAP_MS.
   */
  frame(pcm: Buffer, audible: boolean, nowMs: number): boolean {
    this.expire();
    const turn = audible ? this.turnAt(nowMs) : this.openTurn();
    if (turn && turn.grant === undefined && audible) this.lock(turn);
    if (turn?.grant !== null || !turn) return true;
    this.stats.droppedFrames++;
    if (audible) this.stats.droppedAudibleFrames++;
    if (turn.lockedAt !== undefined && this.now() - turn.lockedAt <= VoiceAttention.LATE_NAME_MS) {
      this.ring.push(pcm);
      if (this.ring.length > VoiceAttention.RING_FRAMES) this.ring.shift();
    }
    return false;
  }

  /** The engine's tick: a turn that ended without a sound is decided as it was left; a waiting delegation past its deadline is the room's. */
  tick(): void {
    if (this.turn && this.turn.grant === undefined && !this.openTurn()) this.lock(this.turn);
    this.expire();
  }

  /** The voice turn now open (its words or sound within VOICE_TURN_GAP_MS), or undefined. */
  private openTurn(): VoiceTurn | undefined {
    const turn = this.turn;
    return turn && this.now() - turn.lastAt <= VoiceAttention.VOICE_TURN_GAP_MS ? turn : undefined;
  }

  /**
   * The voice turn this output belongs to, touched now: the open one, or a new one. A new turn takes the engine's ask
   * if one is waiting, and is decided at once when it was asked for; one that looks unasked stays open to the name
   * until its first audible frame (`lock`) or its end.
   */
  private turnAt(startMs: number, itemId?: string): VoiceTurn {
    const now = this.now();
    const open = this.splitByKevin(this.splitByAsk(this.openTurn()), itemId, startMs);
    if (open) {
      open.lastAt = now;
      if (itemId !== undefined) open.itemId = itemId;
      if (open.grant === undefined) {
        const grant = this.grantFor(open);
        if (grant) this.decide(open, grant);
      }
      return open;
    }
    if (this.turn && this.turn.grant === undefined) this.lock(this.turn);
    const asked = this.askAt > 0 && now - this.askAt <= VoiceAttention.ASK_GRANT_MS;
    const clause = asked && this.askClause;
    if (asked) {
      this.askAt = 0;
      this.askClause = false;
    }
    const last = this.items[this.items.length - 1];
    const turn: VoiceTurn = { startMs, lastAt: now, asked, clause, grant: undefined, answers: last?.id, words: "", ...(itemId !== undefined ? { itemId } : {}) };
    this.turn = turn;
    this.ring = [];
    const grant = this.grantFor(turn);
    if (grant) this.decide(turn, grant);
    return turn;
  }

  /**
   * The open turn, unless Kevin's side spoke into it: Live's next words went on as a new output item (an utterance
   * landed between them) and they start once that utterance had ended (session timeline). After an utterance said to
   * Jarhead the voice is answering it (Live's barge-in cuts mid-sentence); after the room's, only once the voice had
   * finished a sentence — "going to sleep." and, 0.3 s later, "yeah, sounds right" to the TV is a turn of its own,
   * while "going" … TV … "to sleep." is the voice carrying on.
   */
  private splitByKevin(open: VoiceTurn | undefined, itemId: string | undefined, startMs: number): VoiceTurn | undefined {
    if (!open || itemId === undefined || open.itemId === undefined || open.itemId === itemId) return open;
    const last = this.items[this.items.length - 1];
    if (!last || last.id === open.answers || startMs < last.endMs) return open;
    const addressed = this.verdictOfId(last.id) !== "room";
    if (!addressed && !open.sentenceEnded) return open;
    if (open.grant === undefined) this.lock(open);
    open.lastAt = Number.NEGATIVE_INFINITY;
    return undefined;
  }

  /**
   * The open turn, unless the engine asked for words after the voice had paused it (ASK_SPLIT_MS): an answer to the
   * room that ended half a second before the pre-sleep clause was asked for must not swallow the clause's words, and
   * leave the clause's ask to the next answer to the room.
   */
  private splitByAsk(open: VoiceTurn | undefined): VoiceTurn | undefined {
    if (!open || this.askAt === 0 || this.askAt < open.lastAt || this.now() - open.lastAt < VoiceAttention.ASK_SPLIT_MS) return open;
    if (open.grant === undefined) this.lock(open);
    open.lastAt = Number.NEGATIVE_INFINITY;
    return undefined;
  }

  /** The turn's verdict for good: at its first audible frame, or as it ends unheard. */
  private lock(turn: VoiceTurn): void {
    if (turn.grant !== undefined) return;
    const grant = this.grantFor(turn);
    turn.lockedAt = this.now();
    this.decide(turn, grant);
    if (!grant) {
      this.stats.droppedTurns++;
      if (turn.words) this.stats.droppedWords += turn.words;
      this.seams.log?.(`voice turn nobody asked for: dropped (${turn.words ? `"${turn.words.trim().slice(-60)}"` : "its sound came first"})`);
    }
  }

  private decide(turn: VoiceTurn, grant: VoiceGrant | null): void {
    turn.grant = grant;
    if (grant && turn.endMs !== undefined) this.speak(turn, turn.endMs);
  }

  /**
   * Why the engine asked for this voice turn, or null: the reply to an append of its own; the reply to an utterance
   * said to Jarhead (one merely inside the window only while the cap is open); work Kevin asked for still running with
   * nothing from the room since (a TV answered mid-task must not open the window to its next command); the voice going
   * on inside the open exchange. A turn with none of these is the voice answering the room on its own.
   */
  private grantFor(turn: VoiceTurn): VoiceGrant | null {
    if (turn.asked) return "asked";
    // What the turn answers: Kevin's last item when it began (a later utterance is a turn of its own, `splitByKevin`).
    const answered = turn.answers === undefined ? undefined : this.items.find((i) => i.id === turn.answers);
    const verdict = answered ? this.verdictOfId(answered.id) : undefined;
    if (answered && verdict !== "room" && turn.startMs - answered.endMs < EXCHANGE_WINDOW_MS && (verdict !== "window" || this.capOpen())) return verdict ?? null;
    if (this.seams.working() && verdict !== "room") return "work";
    if (this.inWindow(turn.startMs) || this.seams.inExchange()) return "exchange";
    return null;
  }

  /**
   * Jarhead's own granted words: the exchange goes on from where they end, and the engine counts them — except the
   * pre-sleep clause's turn, whatever it says after the clause: counted, it would re-arm the idle clock every idle
   * stretch, and opening the exchange on it would let the room that answers it hold the session (B2). After "going to
   * sleep" the name, a typed line or Go keeps it awake. A line the engine asked for (a brain's question or result, a
   * thread's line, a timer) is Jarhead turning to Kevin: it anchors the cap too, so his unnamed answer to it is the
   * exchange's however long the work took. The voice answering on its own never does: that is the chain the cap bounds.
   */
  private speak(turn: VoiceTurn, endMs: number): void {
    if (!turn.clause) {
      this.exchangeEndMs = Math.max(this.exchangeEndMs, endMs);
      if (turn.grant === "asked") this.anchor();
    }
    this.seams.spoke(turn.grant as VoiceGrant, turn.clause);
  }

  // ------------------------------------------------------------------ delegations

  /**
   * Live delegated: was it for words said to Jarhead? Judged once per delegation (the Delegator asks first; the engine's
   * listener reads the same answer) on `item`, the utterance Live raised it for — the request's last. Addressed:
   * its verdict at once. Room-looking: a promise that settles at the utterance's name, or "room" once
   * DELEGATION_LATE_MS pass on the engine's clock (read at every event and tick; a real timer backs it up). No words on
   * the transcript yet (`nowMs`: the session timeline now): the exchange's, when one is open; else the next utterance
   * answers it the same way.
   */
  delegation(liveId: string, item: Pick<TranscriptItem, "id" | "source"> | undefined, nowMs?: number): Verdict | Promise<Verdict> {
    const known = this.delegations.get(liveId);
    if (known !== undefined) return known;
    let verdict: Verdict | Promise<Verdict>;
    if (item && this.addressed(item)) verdict = this.verdictOf(item);
    else if (!item && (this.seams.inExchange() || (nowMs !== undefined && this.inWindow(nowMs)))) verdict = "window";
    else {
      verdict = this.waitForName(item?.id).then((named) => {
        const v: Verdict = named ? (item ? this.verdictOf(item) : this.lastVerdict()) : "room";
        const settled: Verdict = named && v === "room" ? "named" : v;
        if (settled === "room") this.stats.refused++;
        this.delegations.set(liveId, settled);
        return settled;
      });
    }
    this.delegations.set(liveId, verdict);
    if (this.delegations.size > 64) this.delegations.delete(this.delegations.keys().next().value as string);
    return verdict;
  }

  private lastVerdict(): Verdict {
    const last = this.items[this.items.length - 1];
    return last ? this.verdictOfId(last.id) : "room";
  }

  private waitForName(itemId: string | undefined): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const timer = setTimeout(() => waiter.settle(false), VoiceAttention.DELEGATION_LATE_MS);
      timer.unref?.();
      const waiter: Waiter = {
        itemId,
        deadline: this.now() + VoiceAttention.DELEGATION_LATE_MS,
        settle: (named) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(named);
        },
      };
      this.waiters.add(waiter);
    });
  }

  /** Waiters on these items (or on the next utterance) settle: the words were said to Jarhead. */
  private settleWaiters(ids: ReadonlySet<string>): void {
    for (const w of [...this.waiters]) if (w.itemId === undefined || ids.has(w.itemId)) w.settle(true);
  }

  /** A room-looking utterance landed: a delegation waiting for the next one waits on this one's name now. */
  private awaitName(id: string): void {
    for (const w of this.waiters) if (w.itemId === undefined) w.itemId = id;
  }

  /** A waiting delegation past its deadline on the engine's clock is the room's. */
  private expire(): void {
    if (this.waiters.size === 0) return;
    const now = this.now();
    for (const w of [...this.waiters]) if (now >= w.deadline) w.settle(false);
  }
}

/** Whether the ear's words and Live's share a word of three letters or more (the name aside): the same speech, ~1 s apart. */
function sharesWords(ear: string, live: string): boolean {
  const words = (s: string): string[] =>
    s
      .toLowerCase()
      .replace(NAMES_ALL, " ")
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length >= 3);
  const own = words(live);
  if (own.length === 0) return true;
  const theirs = new Set(words(ear));
  return own.some((w) => theirs.has(w));
}
