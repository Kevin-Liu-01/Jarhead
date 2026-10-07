import type { TranscriptItem } from "@jarhead/protocol";
import { BYTES_PER_MS } from "./audio-telemetry.ts";

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
 *   voice's mishearings included, or the ear heard the name in the same speech or just before); `window` (it began
 *   inside the exchange, on the session timeline or on the wall clock as the ear judges it, or it is the first answer
 *   to Jarhead's own question within ANSWER_WINDOW_MS); else `room`. A later fragment may upgrade it to named; a
 *   `window` one lapses to the room once its words run on EXCHANGE_WINDOW_MS past the exchange (or the cap closes), so
 *   a video Kevin asked for, talking on, never stays the exchange's. Items the Transcript split around the voice's
 *   words ("…, Jar" | reply | "head") are one utterance for the name only.
 * - **The exchange** is `exchangeEndMs` on the session timeline: the session start, named or typed words, a circle,
 *   and Jarhead's own granted speech move it; room talk inside the window, an aside (the pre-sleep clause, the cue)
 *   and an answer nobody asked for do not. It is capped: EXCHANGE_MAX_MS after the last anchor (a name, a typed line,
 *   a circle, a Go, a wake, a resume, a line the engine asked for), nothing is "inside the exchange" any more.
 * - **An ask** is an engine append that wants words (LiveSession's `ask`), kept with its provenance (`AskKind`): the
 *   result of work the gate admitted only because it began inside the window asks as `window` — heard, never an anchor
 *   — so a TV whose lines Live delegates cannot renew the cap through their results (ADV-2).
 * - **A voice turn** is the voice's words or sound with no gap of VOICE_TURN_GAP_MS. One that takes an ask, or begins
 *   inside the open exchange, is decided at once; any other at its first audible frame (160-350 ms after its words
 *   arrive, 347-547 ms after their `start_ms`, in every LC-7 reply), on what it answers by the session timeline
 *   (Kevin's last utterance begun before it): a reply to an addressed utterance that ended under EXCHANGE_WINDOW_MS
 *   before it, or words for addressed work still running with nothing from the room since. A locked turn's frames
 *   are all dropped, silence too, unless the utterance it answers is named within LATE_NAME_MS: then its frames from
 *   the first audible one (RING_FRAMES kept) go to the speaker after all. An ask that lands while a dropped or
 *   undecided turn streams starts a turn of its own at the first sentence end, at words that say what was asked, or
 *   after a pause. When new words split a turn, the old turn's sound still on its way stays its own; a granted one
 *   keeps only its words' worth. Once it has had as much PCM from its first audible frame as its words cover on Live's
 *   timeline, the next frame is the next turn's (CI 1c140d8: an answer to the room sounded 219 ms behind its words,
 *   and three of its frames played as the clause). Until the old bound, such a frame does not decide an undecided
 *   next turn: it is dropped and held, and the turn locks at an audible frame past the bound, so a late name counts
 *   from the turn's own sound.
 * - **A delegation** is judged on the utterance Live raised it for. One that looks like room talk waits up to
 *   DELEGATION_LATE_MS for a late name before it is refused.
 *
 * Pure apart from the injected clock and one backup timer per waiting delegation. The engine owns the wiring.
 */

export type Verdict = "typed" | "named" | "window" | "room";
/** Why a voice turn was asked for. */
export type VoiceGrant = Verdict | "asked" | "work" | "exchange";
/**
 * What an append asks of the voice, by where it came from.
 * - `asked`: a line the engine started (a timer, an automation, a thread's question, the answer to a typed line) or the
 *   result of work Kevin asked for himself (typed, named): Jarhead turning to Kevin. It anchors the exchange's cap.
 * - `window`: the result of work the gate admitted only because its words began inside the exchange. Heard, and the
 *   exchange goes on from it, but it anchors nothing and moves only the idle clock (ADV-2).
 * - `aside`: heard and counted for nothing, no exchange: the pre-sleep clause, and the cue that an answer needs the name.
 */
export type AskKind = "asked" | "window" | "aside";
/** Whether Kevin heard a line of Jarhead's on the Transcript: "pending" while its turn waits for its first audible frame. */
export type SaidState = "heard" | "unheard" | "pending";

/** "Mid-exchange": an addressed turn this recent (Engine.EXCHANGE_WINDOW_MS, and the voice's orders' "about eight seconds"). */
export const EXCHANGE_WINDOW_MS = 8000;
/** The exchange's cap after its anchor (a name, a typed line, a circle, a Go / wake / resume, a line the engine asked for). */
export const EXCHANGE_MAX_MS = 120_000;
/**
 * Jarhead asked Kevin a question (a line the engine asked for, with a "?"): his first utterance after it, begun within
 * this long on the session timeline, is the exchange's without the name — the voice's orders' "except answers to your
 * question" (ADV-4). One utterance, never a confirmation's yes (a send's, a thread's): that needs the name or the Console.
 */
export const ANSWER_WINDOW_MS = 30_000;

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
  /** Live's id of the delegation Kevin's work runs on (the Delegator's active one), or undefined. */
  readonly working: () => string | undefined;
  /** The confirmation waiting on Kevin's yes (a send, a pay, a thread's question), by id; undefined when none (or expired). */
  readonly confirming?: () => string | undefined;
  /** Jarhead's granted words, for the engine's clocks. `aside`: the pre-sleep clause's or the cue's turn, which counts for nothing. */
  readonly spoke: (grant: VoiceGrant, aside: boolean) => void;
  /** Jarhead's Transcript items whose turn was just decided (`saidState` says how): the engine marks the unheard and settles their record. */
  readonly decided?: (itemIds: readonly string[]) => void;
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
  /** The words of those turns (still on the transcript, marked unheard). */
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
  /** Wall clock of its first fragment, and of its last. */
  readonly firstAt: number;
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

/** An engine append that wants words, until a voice turn takes it or ASK_GRANT_MS pass. */
interface Ask {
  readonly at: number;
  readonly kind: AskKind;
  /** What it asked for, for "words that say what was asked". */
  readonly content: string;
  /** Its client event ids (asks still waiting merge: the voice may answer any of them), for the server's `appended` ack. */
  readonly eventIds: ReadonlySet<string>;
  /** The server acknowledged it: the voice's answer to it can only begin after this (LC-5, LC-7, LC-10: ack +424-675 ms, answer later). */
  acked: boolean;
  /** Words of a dropped or undecided turn that arrived after it, for "words that say what was asked". */
  heard: string;
}

interface VoiceTurn {
  /** Session timeline: the turn's first words (or the client's estimate at its first sound). */
  readonly startMs: number;
  /** Wall clock of its first words or sound, and of its latest. */
  readonly firstAt: number;
  lastAt: number;
  /** The ask it took, by provenance; undefined: none. */
  readonly ask: AskKind | undefined;
  /** undefined until decided; null: nobody asked. */
  grant: VoiceGrant | null | undefined;
  /** Kevin's item it answers, fixed at its lock: his last utterance begun before it on the session timeline. */
  answers?: string | undefined;
  /** Live's output item its last words went to, and every item its words went to. */
  itemId?: string;
  readonly itemIds: Set<string>;
  /** Its last words ended a sentence (. ! ?). */
  sentenceEnded?: boolean;
  /** Where its words end so far (session timeline); undefined while it has only sound. */
  endMs?: number;
  /** Wall clock of its first audible frame, when it was locked. */
  lockedAt?: number;
  words: string;
  /**
   * Live's timeline its words cover: its first delta's start to its last one's end, less any gap shorter than
   * WORD_GAP_MS between two of them. The sound its words take. It stops at a split: later words are the next turn's.
   */
  wordsMs: number;
  /** PCM it was given from its first audible frame on, silence too (Live streams in real time); undefined before it. */
  soundMs?: number;
}

/** Jarhead's own question: a line the engine asked for, with a "?". */
interface Question {
  readonly turn: VoiceTurn;
  /** Session timeline where its words end; wall clock of its last words. */
  endMs: number;
  at: number;
  /** Kevin's first utterance after it came (the answer window is one utterance). */
  used: boolean;
  /** An addressed utterance of Kevin's came after it. */
  answered: boolean;
  /** The cue that an answer needs the name was said for it. */
  cued: boolean;
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
   * still streaming when the ask lands goes on as the turn it was, to its sentence's end.
   */
  static readonly ASK_SPLIT_MS = 250;
  /**
   * In a session that acknowledges appends, an ask is the voice's to answer once acknowledged, or this long after it was
   * sent without an ack (one lost must not lose the line): the acks came 424-675 ms after the send, the answers later.
   * A reply to the room already on its way when the ask left does not take it (ADV-9b: 200 ms after an ear reflex's).
   */
  static readonly ASK_UNACKED_MS = 800;
  /** The ear runs ~1 s ahead of Live's transcript: a Live utterance that starts within this long after the ear heard the name is named. */
  static readonly EAR_NAME_MS = 4000;
  /** The ear's name upgrades the utterance Live is still transcribing when its last fragment is this recent. */
  static readonly EAR_OPEN_MS = 2000;
  /**
   * …and only one Live began transcribing after the ear's segment opened, less this: Live's transcript of the same speech
   * lands ~0.8 s after the ear's first partial, so an item Live was already sending well before Kevin began is someone
   * else's (ADV-9: a TV line 1.9 s before the ear's segment).
   */
  static readonly EAR_SEGMENT_SLACK_MS = 600;
  /** The Transcript's GAP_MS: Kevin's items this close on the session timeline may be one utterance… */
  static readonly UTTERANCE_GAP_MS = 1400;
  /** …when the second's first fragment arrives this soon after the first's last (LC-6 trial 3: 'head' 582 ms after 'Jar'). */
  static readonly SPLIT_ARRIVAL_MS = 1000;
  /** A name this late after a locked turn's first audible frame still releases that turn (LC-6 trial 3: 410 ms). */
  static readonly LATE_NAME_MS = 600;
  /** Frames a locked turn keeps for a late name: 0.8 s of Live's 100 ms deltas. */
  static readonly RING_FRAMES = 8;
  /**
   * When a turn is split at new words, a frame that arrives sooner than this after those words' `start_ms` (session
   * timeline) is the old turn's sound still streaming, and goes as it went (ADV-1). LC-7 heard a reply's first sound
   * 347-547 ms after its `start_ms` (" on it" 347 and 440, " night." 412, " hello ke" 459, " i didn't" 547). The dry
   * stand-in sounds a reply to the room 200 ms after its words, 219 ms under load (CI 1c140d8). So for a granted turn
   * this is only a cap: its tail ends sooner, once it has had its words' worth of sound (`sounded`). A dropped turn's
   * tail keeps all of it. Past a granted turn's words' worth and short of this, an audible frame is dropped and held
   * for an undecided next turn without locking it.
   */
  static readonly SPLIT_SOUND_LAG_MS = 250;
  /**
   * A gap this long or longer between two of a turn's transcript deltas is the voice still sounding: Live's
   * transcript runs on a 200 ms grid and skips a slot with no new text ("hello kevin, here and listening.": 1200 ms of
   * deltas, 1800 ms from first start to last end, 1801 ms of frames, LC-7). Its gaps are whole slots: 0, 200, 400 ms.
   * A shorter gap is the dry stand-in's clock running late, not sound: 2 and 4 ms in CI 1c140d8, 135 ms between two
   * words of a reply in an LC-7 dry run under load. Counted as sound, that pause put a clause's words ahead of its
   * sound, its tail ran to SPLIT_SOUND_LAG_MS, and the answer to the room played as the clause. So the bar sits just
   * under one slot.
   */
  static readonly WORD_GAP_MS = 190;
  /**
   * A delegation whose words look like room talk waits this long for a late name before it is refused: Live's
   * delegation comes 190-727 ms before its reply's first words (LC-7, LC-10), plus LATE_NAME_MS. Only room-looking
   * delegations wait; an addressed one never does.
   */
  static readonly DELEGATION_LATE_MS = 1200;
  /** An unanswered question of Jarhead's this recent earns one cue when an unnamed answer to it is refused. */
  static readonly ANSWER_CUE_MS = 120_000;
  static readonly VERDICTS_KEPT = 128;
  private static readonly ITEMS_KEPT = 32;
  private static readonly SAID_KEPT = 64;

  private readonly verdicts = new Map<string, Verdict>();
  private readonly items: KevinItem[] = [];
  private utterance: Utterance | undefined;
  private exchangeEndMs = Number.NEGATIVE_INFINITY;
  private anchorAt = Number.NEGATIVE_INFINITY;
  private pendingAsk: Ask | undefined;
  /** The session acknowledges appends (a real LiveSession does, `acknowledgesAppends`; the tests' fakes do not). */
  private acks = false;
  private earNamedAt = 0;
  /** Each ear segment: when its first partial came, and the name's count in it so far (a partial repeats the segment's earlier words; only a new name counts). */
  private readonly earSegments = new Map<number, { readonly firstAt: number; names: number }>();
  private turn: VoiceTurn | undefined;
  /**
   * The turn a split ended, while its sound still streams (`SPLIT_SOUND_LAG_MS`, `sounded`), and the one being split
   * now. `handing`: the old turn has had its sound, and until the old bound its frames go to the next turn.
   */
  private tail: { readonly turn: VoiceTurn; readonly untilMs: number; readonly untilAt: number; handing?: boolean } | undefined;
  private splitOff: VoiceTurn | undefined;
  private ring: Buffer[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly delegations = new Map<string, Verdict | Promise<Verdict>>();
  /** The utterance each delegation was judged on, for its results' provenance. */
  private readonly delegationItems = new Map<string, string | undefined>();
  private question: Question | undefined;
  /** The confirmation the cue was said for. */
  private cuedConfirm: string | undefined;
  /** Jarhead's Transcript items and the turns that said them: whether Kevin heard them. */
  private readonly saidBy = new Map<string, VoiceTurn[]>();
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
  reset(open: boolean, o: { readonly acks?: boolean } = {}): void {
    this.close();
    this.turn = undefined;
    this.tail = undefined;
    this.splitOff = undefined;
    this.ring = [];
    this.pendingAsk = undefined;
    this.acks = o.acks === true;
    this.items.length = 0;
    this.utterance = undefined;
    this.verdicts.clear();
    this.delegations.clear();
    this.delegationItems.clear();
    this.question = undefined;
    this.cuedConfirm = undefined;
    this.saidBy.clear();
    this.exchangeEndMs = open ? 0 : Number.NEGATIVE_INFINITY;
    for (const w of [...this.waiters]) w.settle(false);
  }

  /**
   * The session ended: a voice turn it left undecided never sounded, so its lines are settled as unheard now, while they
   * are still on the session's Transcript (the engine moves it to the held record next).
   */
  close(): void {
    const left = this.turn;
    if (!left || left.grant !== undefined) return;
    left.grant = null;
    if (left.itemIds.size > 0) this.seams.decided?.([...left.itemIds]);
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

  /**
   * A `window` utterance's newest words, begun at `fragmentStartMs`, are still the exchange's: within EXCHANGE_WINDOW_MS
   * of the exchange's end or of the utterance's own start, whichever is later, with the cap open. Past that it is the
   * room's — a video Kevin asked for that talks on, a TV that started in the window (ADV-7, ADV-8).
   */
  private stillWindow(item: Pick<TranscriptItem, "startMs">, fragmentStartMs: number): boolean {
    return fragmentStartMs < Math.max(this.exchangeEndMs, item.startMs) + EXCHANGE_WINDOW_MS && this.capOpen();
  }

  /** A circle or a captured window: Kevin pointed at something for Jarhead; the exchange opens from now (`nowMs`). */
  gesture(nowMs: number): void {
    this.anchor();
    this.exchangeEndMs = Math.max(this.exchangeEndMs, nowMs);
  }

  /**
   * The engine asked the voice for words (a `commentary` or `instructions` append, LiveSession's `ask`; a Responses
   * backend's result). The first voice turn within ASK_GRANT_MS takes it — once the server has acknowledged it, when
   * the session acknowledges appends (ASK_UNACKED_MS at most). Its kind is its provenance: `aside` (the clause, the
   * cue); for an append on a delegation, `window` when the gate admitted that delegation only as `window`; else `asked`.
   */
  ask(o: { readonly aside?: boolean; readonly delegationId?: string | null; readonly eventId?: string; readonly content?: string } = {}): void {
    let kind: AskKind = o.aside ? "aside" : this.provenance(o.delegationId);
    const before = this.liveAsk();
    // One still waiting merges in (a result in two chunks, a thread's line on its heels): Jarhead turning to Kevin wins.
    if (before?.kind === "asked" && kind === "window") kind = "asked";
    const eventIds = new Set(before?.eventIds ?? []);
    if (o.eventId !== undefined) eventIds.add(o.eventId);
    this.pendingAsk = { at: this.now(), kind, content: `${before?.content ?? ""} ${o.content ?? ""}`.trim(), eventIds, acked: before?.acked ?? false, heard: before?.heard ?? "" };
  }

  /** The server acknowledged an append (`session.*.appended`): the voice's answer to it may begin now. */
  acked(eventId: string): void {
    if (this.pendingAsk?.eventIds.has(eventId)) this.pendingAsk.acked = true;
  }

  /** Where the work behind delegation `liveId` came from: Kevin's own (typed, named) or the engine's, or only the window. */
  private provenance(liveId: string | null | undefined): AskKind {
    if (!liveId) return "asked";
    const v = this.delegations.get(liveId);
    // Not judged here (another session's delegation, a thread outliving it): the engine's own line.
    if (v === undefined) return "asked";
    // Still waiting on a late name: nothing ran on it.
    if (typeof v !== "string") return "window";
    if (v === "typed" || v === "named") return "asked";
    const itemId = this.delegationItems.get(liveId);
    const since = itemId !== undefined ? this.verdicts.get(itemId) : undefined;
    return since === "named" || since === "typed" ? "asked" : "window";
  }

  /** The ask still waiting for its turn, or undefined. */
  private liveAsk(): Ask | undefined {
    const a = this.pendingAsk;
    if (a && this.now() - a.at > VoiceAttention.ASK_GRANT_MS) this.pendingAsk = undefined;
    return this.pendingAsk;
  }

  /** The voice's words now can answer this ask: the server took it in, or no ack is coming (a fake session, a lost ack). */
  private takeable(a: Ask): boolean {
    return !this.acks || a.acked || a.eventIds.size === 0 || this.now() - a.at >= VoiceAttention.ASK_UNACKED_MS;
  }

  // ------------------------------------------------------------------ Kevin's side

  /** A typed line: addressed, an anchor, and the exchange is open from it. It closes any spoken utterance. */
  typed(item: TranscriptItem): void {
    this.utterance = undefined;
    this.track(item, true);
    this.setVerdict(item.id, "typed");
    this.exchangeEndMs = Math.max(this.exchangeEndMs, item.endMs);
    this.anchor();
    if (this.question && item.startMs >= this.question.endMs) {
      this.question.used = true;
      this.question.answered = true;
    }
    this.settleWaiters(new Set([item.id]));
  }

  /**
   * A fragment of Kevin's side of Live's transcript landed; `item` is its utterance so far and `fragmentStartMs` where
   * the new words begin. Judged as it arrives (see the class comment); named words open the exchange from where they end
   * and anchor its cap; an utterance merely inside the window does not extend it (a TV talking on would hold it for
   * ever) — Jarhead's answer to it does — and it lapses to the room once its words run on past the window.
   */
  heard(item: TranscriptItem, _delta: string, fragmentStartMs: number = item.endMs): Heard {
    this.expire();
    const was = this.verdicts.get(item.id);
    this.track(item, false);
    const u = this.utteranceOf(item);
    const named = NAMES.test([...u.items.values()].join(" ")) && !this.seams.echo(item.text);
    // An item that continues an utterance split around the voice's words carries its name ("Jar" | reply | "head"),
    // nothing else: a window a split item began in is judged again on its own words.
    const joinedNamed = [...u.items.keys()].some((id) => id !== item.id && this.verdicts.get(id) === "named");
    let verdict: Verdict;
    if (was === undefined) {
      const earNamed = this.earNamedAt > 0 && this.now() - this.earNamedAt < VoiceAttention.EAR_NAME_MS;
      const answer = this.answerTo(item);
      verdict = named || earNamed || joinedNamed ? "named" : this.inWindow(item.startMs) || this.seams.inExchange() || answer ? "window" : "room";
      if (answer && verdict === "window" && !this.inWindow(item.startMs)) this.seams.log?.(`attention: an answer to Jarhead's question ${Math.round((item.startMs - (this.question?.endMs ?? 0)) / 1000)} s after it: the exchange's`);
      if (earNamed) this.earNamedAt = 0;
    } else if (named && was !== "typed") verdict = "named";
    else if (was === "window" && !this.stillWindow(item, fragmentStartMs)) {
      verdict = "room";
      this.seams.log?.(`attention: an utterance begun inside the exchange talked on past it: the room's from here ("${item.text.slice(-60)}")`);
    } else verdict = was;
    let released: Buffer[] = [];
    const upgraded = verdict === "named" && was !== "named";
    if (upgraded) released = this.upgrade(u);
    else this.setVerdict(item.id, verdict);
    if (verdict === "named") {
      this.exchangeEndMs = Math.max(this.exchangeEndMs, item.endMs);
      this.anchor();
    }
    if (verdict !== "room" && this.question && item.startMs >= this.question.endMs - VoiceAttention.UTTERANCE_GAP_MS) this.question.answered = true;
    if (verdict === "room") this.awaitName(item.id);
    else this.settleWaiters(new Set(u.items.keys()));
    // One utterance is one named turn, however many items Live split it into.
    return { verdict, named: upgraded && !joinedNamed, released };
  }

  /**
   * Kevin's first utterance after Jarhead's own question: it spends the answer window whatever it says, and is the
   * exchange's when it began within ANSWER_WINDOW_MS of the question, the cap open and no confirmation waiting (a yes to
   * a send needs the name or the Console).
   */
  private answerTo(item: TranscriptItem): boolean {
    const q = this.question;
    if (!q || q.used || item.startMs < q.endMs - VoiceAttention.UTTERANCE_GAP_MS) return false;
    q.used = true;
    return item.startMs - q.endMs <= ANSWER_WINDOW_MS && this.capOpen() && this.seams.confirming?.() === undefined;
  }

  /**
   * The on-device ear heard words of segment `segment`. A new name in them (its partials repeat the segment's earlier
   * words) names the next Live utterance within EAR_NAME_MS, and the one Live is still transcribing when it is the same
   * speech: Live began sending it after the ear's segment opened (less EAR_SEGMENT_SLACK_MS), its last fragment is
   * under EAR_OPEN_MS old, and its words are the ear's (`sameSpeech`). The ear runs ~1 s ahead of Live's transcript,
   * so this is what wins the race when the name comes last. Never an older room line, never one that merely shares
   * "the" with Kevin's words (ADV-9).
   */
  ear(text: string, segment: number, isFinal: boolean): Heard | undefined {
    const count = (text.match(NAMES_ALL) ?? []).length;
    let seg = this.earSegments.get(segment);
    if (!seg) {
      seg = { firstAt: this.now(), names: 0 };
      this.earSegments.set(segment, seg);
      if (this.earSegments.size > 16) this.earSegments.delete(this.earSegments.keys().next().value as number);
    }
    const seen = seg.names;
    if (isFinal) this.earSegments.delete(segment);
    else seg.names = Math.max(seen, count);
    if (count <= seen || this.seams.echo(text)) return undefined;
    this.earNamedAt = this.now();
    const open = this.items[this.items.length - 1];
    if (!open || open.typed || this.now() - open.lastAt > VoiceAttention.EAR_OPEN_MS) return undefined;
    if (open.firstAt < seg.firstAt - VoiceAttention.EAR_SEGMENT_SLACK_MS || !sameSpeech(text, open.text)) return undefined;
    const was = this.verdicts.get(open.id);
    if (was === "named" || was === "typed") return undefined;
    // The name is spent on this utterance: the next one is not named by it.
    this.earNamedAt = 0;
    const u = this.utterance && this.utterance.items.has(open.id) ? this.utterance : { items: new Map([[open.id, open.text]]), endMs: open.endMs, lastAt: open.lastAt };
    const released = this.upgrade(u);
    this.exchangeEndMs = Math.max(this.exchangeEndMs, open.endMs);
    this.anchor();
    if (this.question && open.startMs >= this.question.endMs - VoiceAttention.UTTERANCE_GAP_MS) this.question.answered = true;
    this.settleWaiters(new Set(u.items.keys()));
    return { verdict: "named", named: true, released };
  }

  /**
   * Whether one of Kevin's utterances was said to Jarhead. One with no verdict is the room's unless typed: closed by
   * default; one merely inside the window only while the cap is open.
   */
  addressed(item: Pick<TranscriptItem, "id" | "source">): boolean {
    const v = this.verdictOf(item);
    return v !== "room" && (v !== "window" || this.capOpen());
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

  /** Keep Kevin's item as the gate sees it: Kevin's last item begun before a voice turn is what that turn answers. */
  private track(item: TranscriptItem, typed: boolean): void {
    const now = this.now();
    const known = this.items.find((i) => i.id === item.id);
    if (known) {
      known.endMs = item.endMs;
      known.text = item.text;
      known.lastAt = now;
      return;
    }
    this.items.push({ id: item.id, startMs: item.startMs, endMs: item.endMs, text: item.text, firstAt: now, lastAt: now, typed: typed || item.source === "typed" });
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
   * An undecided turn that answers it, holding frames a sounded tail handed it, is decided now and they go too.
   */
  private release(u: Utterance): Buffer[] {
    const turn = this.turn;
    if (!turn) return [];
    if (turn.grant === undefined) {
      // Only a hand-over fills an undecided turn's ring. Not granted by the name: it waits for its own first audible frame.
      if (this.ring.length === 0 || !u.items.has(this.answersOf(turn)?.id ?? "") || !this.grantFor(turn, false)) return [];
      this.lock(turn);
    } else {
      if (turn.grant !== null || turn.lockedAt === undefined || turn.answers === undefined || !u.items.has(turn.answers)) return [];
      if (this.now() - turn.lockedAt > VoiceAttention.LATE_NAME_MS) return [];
      turn.grant = "named";
      this.stats.droppedTurns = Math.max(0, this.stats.droppedTurns - 1);
      if (turn.endMs !== undefined) this.speak(turn, turn.endMs);
      this.seams.decided?.([...turn.itemIds]);
    }
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
   * "dropped": a turn nobody asked for — on the record, marked unheard, and nothing more.
   */
  output(delta: string, startMs: number, endMs: number, itemId: string): "spoke" | "pending" | "dropped" {
    this.expire();
    const turn = this.turnAt(startMs, itemId, delta);
    turn.sentenceEnded = SENTENCE_END.test(delta);
    const prev = turn.endMs;
    const from = prev === undefined ? startMs : startMs - prev >= VoiceAttention.WORD_GAP_MS ? prev : Math.max(startMs, prev);
    turn.wordsMs += Math.max(0, endMs - from);
    turn.endMs = Math.max(turn.endMs ?? endMs, endMs);
    turn.words += delta;
    const fresh = !turn.itemIds.has(itemId);
    if (fresh) this.saidIn(turn, itemId);
    if (turn.grant === undefined) {
      // Words of a turn the engine did not ask for, after its ask: the ask's own words, if they come, start a turn of their own.
      const ask = this.liveAsk();
      if (ask && ask.at >= turn.firstAt) ask.heard += delta;
      return "pending";
    }
    if (turn.grant === null) {
      this.stats.droppedWords += delta;
      const ask = this.liveAsk();
      if (ask && ask.at >= turn.firstAt) ask.heard += delta;
      if (fresh) this.seams.decided?.([itemId]);
      return "dropped";
    }
    this.speak(turn, endMs);
    return "spoke";
  }

  /**
   * An output audio frame (`nowMs`: the session timeline now): true to play it. An audible frame decides its turn at the
   * latest; a turn nobody asked for is dropped whole, its silence too, until the voice has been quiet VOICE_TURN_GAP_MS.
   * A granted turn a split ended takes the frames after the split only until it has had its words' worth of sound.
   * Until the split's old bound, an audible frame it hands to an undecided turn is dropped and held, and does not
   * lock that turn: its first audible frame may still be the old turn's sound, and LATE_NAME_MS counts from its own.
   */
  frame(pcm: Buffer, audible: boolean, nowMs: number): boolean {
    this.expire();
    const ms = pcm.length / BYTES_PER_MS;
    const tail = this.tail;
    if (tail && (nowMs >= tail.untilMs || this.now() > tail.untilAt)) this.tail = undefined;
    else if (tail && !tail.handing && sounded(tail.turn)) {
      tail.handing = true;
      this.seams.log?.(`attention: a split's granted turn had its sound (${tail.turn.soundMs} ms for ${tail.turn.wordsMs} ms of words); the next frame is the next turn's`);
    } else if (tail && !tail.handing && tail.turn.grant !== undefined) {
      hear(tail.turn, audible, ms);
      if (tail.turn.grant) return true;
      this.stats.droppedFrames++;
      if (audible) this.stats.droppedAudibleFrames++;
      return false;
    }
    const turn = audible ? this.turnAt(nowMs) : this.openTurn();
    if (turn) hear(turn, audible, ms);
    if (turn && turn.grant === undefined && audible) {
      // Handed over: it may be the old turn's sound running past its words (LC-7 " night.": 200 ms of words, 500 ms of
      // sound). So it does not lock this turn; its lock waits for an audible frame past the old bound. Its sound
      // counts: a later split of this turn ends its tail sooner, never later. A turn granted already (a name landed after
      // its words) locks and plays now: held, its frames would never be released, as the ring empties at a grant.
      if (this.tail?.handing && !this.grantFor(turn, false)) {
        this.stats.droppedFrames++;
        this.stats.droppedAudibleFrames++;
        this.hold(pcm);
        return false;
      }
      this.lock(turn);
    }
    if (turn?.grant !== null || !turn) return true;
    this.stats.droppedFrames++;
    if (audible) this.stats.droppedAudibleFrames++;
    if (turn.lockedAt !== undefined && this.now() - turn.lockedAt <= VoiceAttention.LATE_NAME_MS) this.hold(pcm);
    return false;
  }

  /** Keep a dropped frame of the turn for a late name (RING_FRAMES, the oldest out first). */
  private hold(pcm: Buffer): void {
    this.ring.push(pcm);
    if (this.ring.length > VoiceAttention.RING_FRAMES) this.ring.shift();
  }

  /** The engine's tick: a turn that ended without a sound is decided as it was left; a waiting delegation past its deadline is the room's. */
  tick(): void {
    if (this.turn && this.turn.grant === undefined && !this.openTurn()) this.lock(this.turn);
    this.expire();
  }

  /** Whether Kevin heard a line of Jarhead's on the Transcript (undefined: no voice turn said it — the stop's output gate muted it). */
  saidState(itemId: string): SaidState | undefined {
    const turns = this.saidBy.get(itemId);
    if (!turns) return undefined;
    if (turns.some((t) => t.grant)) return "heard";
    if (turns.some((t) => t.grant === undefined)) return "pending";
    return "unheard";
  }

  private saidIn(turn: VoiceTurn, itemId: string): void {
    turn.itemIds.add(itemId);
    const turns = this.saidBy.get(itemId);
    if (turns) turns.push(turn);
    else {
      this.saidBy.set(itemId, [turn]);
      if (this.saidBy.size > VoiceAttention.SAID_KEPT) this.saidBy.delete(this.saidBy.keys().next().value as string);
    }
  }

  /** The voice turn now open (its words or sound within VOICE_TURN_GAP_MS), or undefined. */
  private openTurn(): VoiceTurn | undefined {
    const turn = this.turn;
    return turn && this.now() - turn.lastAt <= VoiceAttention.VOICE_TURN_GAP_MS ? turn : undefined;
  }

  /**
   * The voice turn this output belongs to, touched now: the open one, or a new one. A new turn takes the engine's ask
   * if one is waiting (and acknowledged, where the session acknowledges) and is decided at once; any other stays open
   * to the name and to what Kevin's side says until its first audible frame (`lock`) or its end.
   */
  private turnAt(startMs: number, itemId?: string, delta?: string): VoiceTurn {
    const now = this.now();
    const open = this.splitByKevin(this.splitAside(this.splitByAsk(this.openTurn(), delta), delta), itemId, startMs);
    if (open) {
      open.lastAt = now;
      if (itemId !== undefined) open.itemId = itemId;
      return open;
    }
    if (this.turn && this.turn.grant === undefined) this.lock(this.turn);
    // Split at new words: the old turn's sound still on its way is its own (and no earlier turn's is, any more).
    this.tail = this.splitOff ? { turn: this.splitOff, untilMs: startMs + VoiceAttention.SPLIT_SOUND_LAG_MS, untilAt: now + VoiceAttention.VOICE_TURN_GAP_MS } : undefined;
    this.splitOff = undefined;
    const ask = this.liveAsk();
    const takes = ask !== undefined && (this.takeable(ask) || (delta !== undefined && saysWhatWasAsked(delta, ask.content)));
    if (takes) this.pendingAsk = undefined;
    const turn: VoiceTurn = { startMs, firstAt: now, lastAt: now, ask: takes ? ask.kind : undefined, grant: undefined, itemIds: new Set(), words: "", wordsMs: 0, ...(itemId !== undefined ? { itemId } : {}) };
    this.turn = turn;
    this.ring = [];
    // Asked for, or inside the open exchange (the room there is the exchange's too): decided at its first words. Any
    // other waits for its first audible frame, so an utterance whose transcript lands just after the voice's words is
    // what it answers (ADV-5: "Yes!" from the TV mid-task, its reply's words first in the same millisecond).
    if (turn.ask) this.decide(turn, turn.ask === "window" ? "window" : "asked");
    else if (this.inWindow(startMs) || this.seams.inExchange()) this.decide(turn, this.grantFor(turn, true) ?? "exchange");
    return turn;
  }

  /**
   * The open turn, unless Kevin's side spoke into it: Live's next words went on as a new output item (an utterance
   * landed between them) and they start once that utterance had ended (session timeline). After an utterance said to
   * Jarhead the voice is answering it (Live's barge-in cuts mid-sentence); after the room's, only once the voice had
   * finished a sentence — "going to sleep." and, 0.3 s later, "yeah, sounds right" to the TV is a turn of its own,
   * while "going" … TV … "to sleep." is the voice carrying on. An utterance begun before the turn is the one it answers.
   */
  private splitByKevin(open: VoiceTurn | undefined, itemId: string | undefined, startMs: number): VoiceTurn | undefined {
    if (!open || itemId === undefined || open.itemId === undefined || open.itemId === itemId) return open;
    const last = this.items[this.items.length - 1];
    if (!last || last.id === this.answersOf(open)?.id || startMs < last.endMs) return open;
    const addressed = this.verdictOfId(last.id) !== "room";
    if (!addressed && !open.sentenceEnded) return open;
    if (open.grant === undefined) this.lock(open);
    open.lastAt = Number.NEGATIVE_INFINITY;
    this.splitOff = open;
    return undefined;
  }

  /**
   * The open turn, unless an ask waits that it did not take and the voice is giving the asked-for words now. A granted
   * turn goes on, and spends the ask when its words after the server took it in (or that say what was asked) answer
   * it — a later answer to the room must not take it (LC-10: "looking." runs on into the result's words). A dropped or
   * undecided turn (an answer to the room) ends where the asked-for words begin: after a pause of ASK_SPLIT_MS (the
   * pre-sleep clause half a second after a dropped answer), at its first sentence end once the server took the ask in,
   * or at words that say what was asked (ADV-1: "no, what happened in it" running straight into "your pasta timer is
   * done."). A reply still streaming mid-sentence goes on as the turn it was.
   */
  private splitByAsk(open: VoiceTurn | undefined, delta: string | undefined): VoiceTurn | undefined {
    const ask = this.liveAsk();
    if (!open || !ask || ask.at < open.firstAt) return open;
    if (open.grant) {
      if (delta !== undefined && ((this.acks && this.takeable(ask)) || saysWhatWasAsked(delta, ask.content))) this.pendingAsk = undefined;
      return open;
    }
    // The pause is the voice's when the ask landed, not now: a reply to the room whose sound has not begun yet is not paused.
    const paused = ask.at - open.lastAt >= VoiceAttention.ASK_SPLIT_MS;
    const boundary = delta !== undefined && open.sentenceEnded === true && this.takeable(ask);
    const asked = delta !== undefined && saysWhatWasAsked(`${ask.heard} ${delta}`, ask.content);
    if (!paused && !boundary && !asked) return open;
    if (open.grant === undefined) this.lock(open);
    open.lastAt = Number.NEGATIVE_INFINITY;
    // After a pause its sound is done; mid-stream, what is still on its way is its own.
    if (!paused) this.splitOff = open;
    return undefined;
  }

  /**
   * The open turn, unless it is an aside (the pre-sleep clause, the cue) that has said its sentence: the orders ask for
   * one clause and nothing more, so the voice's next words are a turn of their own, judged on their own — an answer to
   * the TV that spoke over the clause's end, 400 ms after its sound, is not the clause (LC-7 dry under load).
   */
  private splitAside(open: VoiceTurn | undefined, delta: string | undefined): VoiceTurn | undefined {
    if (!open || delta === undefined || open.ask !== "aside" || !open.sentenceEnded) return open;
    open.lastAt = Number.NEGATIVE_INFINITY;
    this.splitOff = open;
    return undefined;
  }

  /** What a turn answers: fixed at its lock, else Kevin's last item begun before it on the session timeline. */
  private answersOf(turn: VoiceTurn): KevinItem | undefined {
    if (turn.answers !== undefined) return this.items.find((i) => i.id === turn.answers);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (item.startMs < turn.startMs) return item;
    }
    return undefined;
  }

  /** The turn's verdict for good: at its first audible frame, or as it ends unheard. What it answers is read now (ADV-5). */
  private lock(turn: VoiceTurn): void {
    if (turn.grant !== undefined) return;
    turn.answers = this.answersOf(turn)?.id;
    const grant = this.grantFor(turn, false);
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
    if (turn.itemIds.size > 0) this.seams.decided?.([...turn.itemIds]);
  }

  /**
   * Why the engine asked for this voice turn, or null: an append of its own (its kind); the reply to an utterance said
   * to Jarhead (one merely inside the window only while the cap is open), read on the session timeline at the lock;
   * work Kevin asked for still running with nothing from the room since (a TV answered mid-task must not open the
   * window to its next command; work the window admitted is `window`); the voice going on inside the exchange it began
   * in (`atStart`: judged as it begins — an exchange Kevin opened after the voice began answering the room, his name
   * through the ear a moment later, does not take that answer in). A turn with none of these is the voice answering
   * the room on its own.
   */
  private grantFor(turn: VoiceTurn, atStart: boolean): VoiceGrant | null {
    if (turn.ask) return turn.ask === "window" ? "window" : "asked";
    const answered = this.answersOf(turn);
    const verdict = answered ? this.verdictOfId(answered.id) : undefined;
    if (answered && verdict && verdict !== "room" && turn.startMs - answered.endMs < EXCHANGE_WINDOW_MS && (verdict !== "window" || this.capOpen())) return verdict;
    const work = this.seams.working();
    if (work !== undefined && verdict !== "room") return this.provenance(work) === "asked" ? "work" : "window";
    if (atStart && (this.inWindow(turn.startMs) || this.seams.inExchange())) return "exchange";
    return null;
  }

  /**
   * Jarhead's own granted words: the exchange goes on from where they end, and the engine counts them — except an
   * aside's turn (the pre-sleep clause, the cue), whatever it says: counted, the clause would re-arm the idle clock
   * every idle stretch, and opening the exchange on it would let the room that answers it hold the session (B2).
   * After "going to sleep" the name, a typed line or Go keeps it awake. A line the engine asked for (a brain's question
   * or result for work Kevin asked for, a thread's line, a timer) is Jarhead turning to Kevin: it anchors the cap too,
   * so his unnamed answer to it is the exchange's however long the work took, and a "?" in it opens the answer window.
   * The voice answering on its own never anchors, nor does the result of work the window admitted.
   */
  private speak(turn: VoiceTurn, endMs: number): void {
    if (turn.ask !== "aside") {
      this.exchangeEndMs = Math.max(this.exchangeEndMs, endMs);
      if (turn.grant === "asked") this.anchor();
    }
    if (turn.grant === "asked" && turn.ask === "asked" && turn.words.includes("?")) {
      const q = this.question;
      if (q?.turn === turn) {
        q.endMs = Math.max(q.endMs, endMs);
        q.at = this.now();
      } else this.question = { turn, endMs, at: this.now(), used: false, answered: false, cued: false };
    }
    this.seams.spoke(turn.grant as VoiceGrant, turn.ask === "aside");
  }

  /**
   * A delegation was refused as not addressed: the cue Kevin is owed, once, when it may have been his answer to a
   * question of Jarhead's — "confirm" while a confirmation waits (its yes needs the name or the Console), "answer" while
   * an unanswered question of Jarhead's is under ANSWER_CUE_MS old — else undefined. The engine says it as an aside.
   */
  cue(): "confirm" | "answer" | undefined {
    const pending = this.seams.confirming?.();
    if (pending !== undefined) {
      if (this.cuedConfirm === pending) return undefined;
      this.cuedConfirm = pending;
      return "confirm";
    }
    const q = this.question;
    if (!q || q.answered || q.cued || this.now() - q.at > VoiceAttention.ANSWER_CUE_MS) return undefined;
    q.cued = true;
    return "answer";
  }

  // ------------------------------------------------------------------ delegations

  /**
   * Live delegated: was it for words said to Jarhead? Judged once per delegation (the Delegator asks first; the engine's
   * listener reads the same answer) on `item`, the utterance Live raised it for — the request's last. Addressed:
   * its verdict at once — `window` only while the cap is open, as for a reply (ADV-7). Room-looking: a promise that
   * settles at the utterance's name, or "room" once DELEGATION_LATE_MS pass on the engine's clock (read at every event
   * and tick; a real timer backs it up). No words on the transcript yet (`nowMs`: the session timeline now): the
   * exchange's, when one is open; else the next utterance answers it the same way.
   */
  delegation(liveId: string, item: Pick<TranscriptItem, "id" | "source"> | undefined, nowMs?: number): Verdict | Promise<Verdict> {
    const known = this.delegations.get(liveId);
    if (known !== undefined) return known;
    let verdict: Verdict | Promise<Verdict>;
    const said = item ? this.verdictOf(item) : undefined;
    this.delegationItems.set(liveId, item?.id);
    if (said !== undefined && said !== "room" && (said !== "window" || this.capOpen())) verdict = said;
    else if (!item && (this.seams.inExchange() || (nowMs !== undefined && this.inWindow(nowMs)))) verdict = "window";
    else {
      verdict = this.waitForName(item?.id).then(({ named, itemId }) => {
        const v: Verdict = named ? (item ? this.verdictOf(item) : this.lastVerdict()) : "room";
        const settled: Verdict = named && v === "room" ? "named" : v;
        if (settled === "room") this.stats.refused++;
        this.delegations.set(liveId, settled);
        this.delegationItems.set(liveId, item?.id ?? itemId);
        return settled;
      });
    }
    this.delegations.set(liveId, verdict);
    if (this.delegations.size > 64) {
      const oldest = this.delegations.keys().next().value as string;
      this.delegations.delete(oldest);
      this.delegationItems.delete(oldest);
    }
    return verdict;
  }

  private lastVerdict(): Verdict {
    const last = this.items[this.items.length - 1];
    return last ? this.verdictOfId(last.id) : "room";
  }

  private waitForName(itemId: string | undefined): Promise<{ readonly named: boolean; readonly itemId: string | undefined }> {
    return new Promise((resolve) => {
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
          resolve({ named, itemId: waiter.itemId });
        },
      };
      this.waiters.add(waiter);
    });
  }

  /** Waiters on these items (or on the next utterance) settle: the words were said to Jarhead. */
  private settleWaiters(ids: ReadonlySet<string>): void {
    for (const w of [...this.waiters]) {
      if (w.itemId === undefined) w.itemId = ids.values().next().value;
      if (w.itemId !== undefined && ids.has(w.itemId)) w.settle(true);
    }
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

/** A frame given to the turn: its sound counts from its first audible frame on, silence too. */
function hear(turn: VoiceTurn, audible: boolean, ms: number): void {
  if (turn.soundMs !== undefined) turn.soundMs += ms;
  else if (audible) turn.soundMs = ms;
}

/**
 * A granted turn a split ended has had its sound: as much PCM from its first audible frame as its words cover on
 * Live's timeline. Every later frame is the next turn's, however soon it comes after the next turn's words (CI
 * 1c140d8: an answer to the room sounded 219 ms behind its words, inside SPLIT_SOUND_LAG_MS, and three of its frames
 * played as the clause). No slack, and a tie goes to the next turn: the stand-in's clause has 60 ms of words and 60 ms
 * of sound, and the answer's first frame can come straight after. The price is a granted turn's last frame when a
 * dropped turn follows mid-stream: LC-7's replies sounded 0-300 ms longer than their words. Such a frame is held, not
 * the next turn's first audible frame: a late name for the next turn counts from that turn's own, and releases the
 * held frame with it. A dropped turn's tail is never cut short: that could only play its last sound as the next turn's.
 */
function sounded(turn: VoiceTurn): boolean {
  return Boolean(turn.grant) && turn.wordsMs > 0 && turn.soundMs !== undefined && turn.soundMs >= turn.wordsMs;
}

/** Words too common to say two utterances are the same speech, or that the voice is saying what an append asked for. */
const STOPWORDS = new Set(
  "the and for you your are was were what what's whats that that's this with have has had not but can can't could would should will won't just now then there their they them from into about its it's our out all any some how who why when where which did does doing done been being get got let let's yes yeah okay too very really also here she him her his one two say said once tell told wait more nothing only short sentence word words line name thing things know like".split(" "),
);

/** Lowercase words of 3 letters or more, the name aside. */
function wordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(NAMES_ALL, " ")
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 3);
}

/** All lowercase words, the name aside. */
function allWordsOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(NAMES_ALL, " ")
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 0);
}

/**
 * Whether the ear's words and Live's open item are the same speech, ~1 s apart: Live's item shares a word that says
 * something with the ear's words before the name (not "the"), or its tail is where the ear's words before the name end
 * (Live lags: "what's the" against "what's the time jarhead"), or it is the name itself being split ("…, Jar").
 */
function sameSpeech(ear: string, live: string): boolean {
  const own = allWordsOf(live);
  if (own.length === 0) return true;
  const tail = own[own.length - 1]!;
  if (tail === "jar") return true;
  let lastName = -1;
  for (const m of ear.matchAll(NAMES_ALL)) lastName = m.index ?? lastName;
  const before = allWordsOf(lastName >= 0 ? ear.slice(0, lastName) : ear);
  const theirs = new Set(before.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
  if (own.some((w) => w.length >= 3 && !STOPWORDS.has(w) && theirs.has(w))) return true;
  return before.slice(-2).includes(tail);
}

/**
 * Whether the voice's words say what an append asked for: two words that say something in common with it (one when it
 * has only one) — "your pasta timer is done." for "Your pasta timer is done. Say so once."
 */
function saysWhatWasAsked(said: string, asked: string): boolean {
  const wanted = new Set(wordsOf(asked).filter((w) => !STOPWORDS.has(w)));
  if (wanted.size === 0) return false;
  const shared = new Set(wordsOf(said).filter((w) => wanted.has(w)));
  return shared.size >= Math.min(2, wanted.size);
}
