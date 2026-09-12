import { logger, newId } from "@jarhead/core";
import { addressesJarhead, endsTerminally, normalizeUtterance, parseReflex, type FiredReflexes, type Reflex, type ReflexOutcome } from "@jarhead/brain";

/**
 * The ear: Kevin's words as the app's on-device recogniser hears them, ~100–200 ms
 * behind his speech, matched against the reflex grammar and acted on at once.
 *
 * Why a second source. Speech → GPT-Live-1 → delegation → brain → first tool call
 * is 1.5–4 s and cannot be 250 ms: a model has to think. So the commands that
 * need no thinking ("scroll down", "press enter", "click Save") must not wait for
 * one. The app runs SFSpeechRecognizer on the same microphone buffers the voice
 * gets and sends every partial here as an `ear` message. This module keeps the
 * current segment's words, considers only the words not yet acted on, and fires a
 * grammar match once it is unambiguous: on the final result at once, on a partial
 * that ends terminally (punctuation, "please", "now"), or after the partial has
 * been stable — for `stableMs` (default 120 ms) when the command is one of the
 * look-only, reversible kinds the Delegator also runs ahead of Live (scroll, page,
 * screenshot, circle), for `carefulMs` (default 450 ms) for everything else. The
 * recogniser emits partials at its own cadence, so a partial that is a prefix of
 * more to come ("copy" of "copy this file to the desktop", "undo" of "undo the
 * last commit", "type hello" of "type hello world") sits unchanged for a
 * recogniser tick or two simply because the next words have not landed; 120 ms is
 * shorter than a tick, 450 ms is longer than one and than a breath (the same
 * figure the Delegator's long quiet window uses: a mid-sentence pause is shorter).
 * Finals and terminal tails cannot carry the fast path alone: the app's
 * SegmentedRecognizer asks for no punctuation and rolls its request every 50 s,
 * so a final arrives at the roll, not at the end of a command.
 *
 * Words are consumed, never forgotten, while the ear is told to hold still — a
 * stop or pause (`quiesce`), the voice speaking (its own words come back through
 * the microphone when echo cancellation is off), a brain task running, the mic
 * muted — so the recogniser's later partial or final for the same segment finds
 * nothing left to judge and cannot run the command a second time.
 *
 * Every fired reflex is remembered in `FiredReflexes` so the slower source —
 * Live's transcript and its delegation for the same words — is finished as
 * "already done" instead of doing it again, and a `reflex` ledger row carries
 * the timing chain: when the app heard the words, when the grammar matched, when
 * the tool was issued, when it answered.
 *
 * Dictation rides the same partials: after "start dictating" every final segment
 * (and any partial stable for `dictationStableMs`) is typed into the focused
 * field with a trailing space; "new line" / "new paragraph" press Return; "delete
 * that" is ⌥⌫; "stop dictating" ends it.
 *
 * A dismissal ("go to sleep", "goodnight jarhead", "that's all for now" — the
 * `sleep` row of the grammar) is judged after "stop" and before the hold: Kevin
 * dismisses Jarhead over its own voice or over a running task, and Jarhead's own
 * words never contain a cue (its idle clause is "going to sleep", its farewell
 * "night."). Unlike "stop" it is careful — at once on a final or a terminal tail,
 * else after `carefulMs` unchanged, so "that is all" cannot fire while it grows
 * into "that is all wrong" — and it fires ONLY when the words name Jarhead or the
 * engine is mid-exchange: a bare "goodnight" to someone in the room never sleeps it.
 */

const log = logger("engine.ear");

/** What the ledger records for one reflex through the ear (a contract wish: `LedgerRow` should grow this type). */
export interface ReflexLedgerRow {
  readonly at: number;
  readonly type: "reflex";
  readonly id: string;
  /** The words, normalised. */
  readonly phrase: string;
  /** The command as understood ("scroll down", "click save"). */
  readonly action: string;
  readonly source: "ear" | "live";
  /** ms since epoch: the app heard the partial; the grammar matched; the tool was issued; the tool answered. */
  readonly earAt: number;
  readonly matchedAt: number;
  readonly dispatchedAt: number;
  readonly doneAt: number;
  readonly ok: boolean;
  /** Set when the policy said confirm/refuse and the reflex was dropped for the model path to ask. */
  readonly dropped?: string;
  /** Final result, or a partial that ended terminally, or the stability window. */
  readonly fired: "final" | "terminal" | "stable";
  /** A multi-step reflex's account of itself (what it did, or how far it got). */
  readonly did?: string;
}

export interface DictationHooks {
  /** Type these words (a trailing space is added here) into the focused field; false when the policy refused and dictation must end. */
  type(text: string): Promise<boolean>;
  /** Press Return `count` times. */
  newline(count: number): Promise<void>;
  /** Delete the last word (⌥⌫). */
  deleteWord(): Promise<void>;
  /** Dictation ended by the ear ("stop dictating") or by a refusal. */
  stop(reason: "said" | "refused" | "asleep"): void;
}

export interface EarOptions {
  readonly now?: () => number;
  /** The reflex layer is on: awake, not paused, Settings.reflexes true. */
  readonly enabled: () => boolean;
  readonly match: (utterance: string) => Reflex | undefined;
  /** Run a matched reflex through the gated hands; `ok: false` with a `dropped` reason means the policy wanted a question. */
  readonly run: (reflex: Reflex, phrase: string) => Promise<ReflexOutcome & { readonly dropped?: string }>;
  /** Kevin said "stop" (only forwarded while something is running or speaking; the engine decides). */
  readonly onStop: () => void;
  /** Kevin dismissed Jarhead ("go to sleep", "goodnight jarhead"): the phrase, normalised. Absent, dismissals are ordinary words. */
  readonly onSleep?: ((phrase: string) => void) | undefined;
  /**
   * Mid-exchange right now (Jarhead spoke or was spoken to a moment ago): a dismissal
   * without the name counts then — unless the engine knows these normalised words as
   * Jarhead's own line back through the microphone.
   */
  readonly addressed?: ((phrase: string) => boolean) | undefined;
  /** Dictation: `active()` says whether the field is being dictated into right now. */
  readonly dictation: DictationHooks & { active(): boolean; start(): void };
  readonly fired: FiredReflexes;
  readonly ledger?: (row: ReflexLedgerRow) => void;
  /**
   * A reason the ear must hold still right now (the voice is speaking, a brain task
   * is running, the mic is muted), or undefined. Words heard meanwhile are consumed
   * (never acted on, never re-judged); "stop" still goes through.
   */
  readonly suppressed?: () => string | undefined;
  /** A partial of a prefire kind (scroll, page, screenshot, circle) must not change for this long before it fires (default 120 ms). */
  readonly stableMs?: number;
  /** A partial of any other kind (keys, edits, typing, clicks, tabs, apps) must not change for this long (default 450 ms). */
  readonly carefulMs?: number;
  /** Words older than this with nothing new heard are stale: the next partial starts a fresh command (default 1500 ms). */
  readonly gapMs?: number;
  /** While dictating, a partial unchanged for this long is typed (default 700 ms); finals are typed at once. */
  readonly dictationStableMs?: number;
}

interface Segment {
  readonly id: number;
  /** The whole segment as last heard, split on spaces. */
  words: string[];
  /** Words already acted on (or judged not a command and left behind); the candidate is what follows. */
  consumed: number;
  lastAt: number;
  /** The candidate text a stability timer is waiting on. */
  waitingFor?: string | undefined;
  timer?: NodeJS.Timeout | undefined;
}

const STOP_WORDS = /^(?:stop|stop it|stop that|cancel|cancel that|never ?mind|hold on|abort|that's enough|quiet|shush|shut up)$/;
/**
 * Words the recogniser hears at the start of a command that are not part of it.
 * Not "right": "right click save" is a command of its own (not in the grammar), and
 * stripping the word would turn it into a left click.
 */
const FILLER_HEAD = /^(?:(?:um|uh|erm|so|like|okay|ok|alright|hey|yeah|yes)[,\s]+)+/i;

/** Dictation commands, each a whole-word sequence inside the spoken text. */
const DICTATION_COMMANDS: ReadonlyArray<readonly [RegExp, "stop" | "newline" | "paragraph" | "delete"]> = [
  [/\b(?:stop|end|finish) (?:dictating|dictation)\b/i, "stop"],
  [/\bnew paragraph\b/i, "paragraph"],
  [/\bnew line\b/i, "newline"],
  [/\b(?:delete|scratch) that\b/i, "delete"],
];

export class EarReflexes {
  private readonly now: () => number;
  private readonly segments = new Map<number, Segment>();
  private current: Segment | undefined;

  constructor(private readonly opts: EarOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get stableMs(): number {
    return this.opts.stableMs ?? 120;
  }

  private get carefulMs(): number {
    return this.opts.carefulMs ?? 450;
  }

  /** A partial or final transcript of segment `segment`, as the app heard it at wall clock `at`. */
  hear(rawText: string, isFinal: boolean, segment: number, at: number): void {
    const text = rawText.replace(/\s+/g, " ").trim();
    const now = this.now();
    let seg = this.segments.get(segment);
    if (!seg) {
      // A new segment: whatever an older one was still waiting on is stale.
      for (const old of this.segments.values()) this.clearTimer(old);
      this.segments.clear();
      seg = { id: segment, words: [], consumed: 0, lastAt: now };
      this.segments.set(segment, seg);
      // One line per segment (the app rolls one every ~50 s): the proof, in the daemon's
      // log, that the app's ear reaches the engine at all — a partial is otherwise debug-level.
      log.info(`ear: segment #${segment} open (${isFinal ? "final" : "partial"} "${text.slice(0, 60)}", ${now - at} ms after the app heard it${this.opts.enabled() ? "" : "; reflexes off"})`);
    }
    this.current = seg;
    const words = text ? text.split(" ") : [];
    // Off (paused, reflexes disabled): the words are consumed, not forgotten — the segment
    // goes on after a resume, and its next partial must judge only what is said then.
    if (!this.opts.enabled()) {
      this.consume(seg, words, now);
      return;
    }
    // Silence since the last partial: the words before it are done with, command or not.
    if (now - seg.lastAt > (this.opts.gapMs ?? 1500) && seg.words.length > 0) seg.consumed = Math.min(seg.words.length, words.length);
    // The recogniser may revise earlier words. A text shorter than what was already acted on
    // is a rewrite of those words: they stay consumed (a shortened "press enter please" →
    // "press enter" must not press Return again); only words after the rewrite count.
    if (words.length < seg.consumed) seg.consumed = words.length;
    seg.words = words;
    seg.lastAt = now;
    const candidate = words.slice(seg.consumed).join(" ");
    if (!candidate) {
      this.clearTimer(seg);
      return;
    }

    if (this.opts.dictation.active()) {
      this.dictate(seg, candidate, isFinal, at);
      return;
    }

    const cleaned = candidate.replace(FILLER_HEAD, "");
    const phrase = normalizeUtterance(cleaned);
    if (STOP_WORDS.test(phrase)) {
      this.clearTimer(seg);
      seg.consumed = words.length;
      log.info(`ear: "${phrase}" → stop`);
      this.opts.onStop();
      return;
    }
    // A dismissal, before the hold (Kevin says it over the voice or a task), only to Jarhead.
    if (this.opts.onSleep && parseReflex(cleaned)?.kind === "sleep") {
      if (this.sleepCue(seg, candidate, phrase, words.length, isFinal)) return;
    }
    // Holding still (the voice is speaking — these may be its own words back through the
    // microphone; a task is running; the mic is muted): consumed, never judged later.
    const held = this.opts.suppressed?.();
    if (held) {
      this.clearTimer(seg);
      seg.consumed = words.length;
      // A command the grammar would have taken is worth a line at info: a hold that never
      // lifts (a stuck "speaking" signal) is otherwise invisible in production.
      const wouldHave = this.opts.match(cleaned);
      if (wouldHave) log.info(`ear: "${phrase}" matched ${wouldHave.label} but held (${held}); consumed`);
      else log.debug(`ear: "${phrase}" held (${held})`);
      return;
    }
    const reflex = this.opts.match(cleaned);
    if (!reflex) {
      this.clearTimer(seg);
      // A final that is not a command is left behind; a partial may still grow into one.
      if (isFinal) seg.consumed = words.length;
      return;
    }
    const matchedAt = now;
    if (isFinal || endsTerminally(candidate)) {
      this.clearTimer(seg);
      this.fire(seg, reflex, phrase, words.length, at, matchedAt, isFinal ? "final" : "terminal");
      return;
    }
    // The same candidate as the timer is already waiting on: let it run out.
    if (seg.waitingFor === candidate && seg.timer) return;
    this.clearTimer(seg);
    seg.waitingFor = candidate;
    const wordCount = words.length;
    // A prefix of more to come sits unchanged for a recogniser tick: the reversible kinds
    // may fire after a short one, everything else waits out a breath.
    const window = reflex.prefire ? this.stableMs : this.carefulMs;
    seg.timer = setTimeout(() => {
      seg!.timer = undefined;
      seg!.waitingFor = undefined;
      // Still the same words? Then the pause was the end of the command.
      if (seg!.words.slice(seg!.consumed).join(" ") !== candidate) return;
      if (!this.opts.enabled() || this.opts.dictation.active() || this.opts.suppressed?.()) return;
      this.fire(seg!, reflex, phrase, wordCount, at, matchedAt, "stable");
    }, window);
    seg.timer.unref?.();
  }

  /**
   * The candidate is a dismissal. Fired at once on a final or a terminal tail
   * ("goodnight jarhead"), else after `carefulMs` unchanged — and only when the words
   * name Jarhead or the engine says it is mid-exchange. Returns true when the words
   * were taken (fired, or armed); false leaves them for the ordinary path (a bare
   * "goodnight" in the room: a final is left behind there, a partial may still grow
   * into "goodnight jarhead").
   */
  private sleepCue(seg: Segment, candidate: string, phrase: string, wordCount: number, isFinal: boolean): boolean {
    const addressed = addressesJarhead(candidate) || this.opts.addressed?.(phrase) === true;
    if (!addressed) {
      log.debug(`ear: "${phrase}" is a dismissal but not to Jarhead; ignored`);
      return false;
    }
    const fire = (how: "final" | "terminal" | "stable"): void => {
      seg.consumed = Math.max(seg.consumed, wordCount);
      log.info(`ear: "${phrase}" → sleep (${how})`);
      this.opts.onSleep?.(phrase);
    };
    if (isFinal || endsTerminally(candidate)) {
      this.clearTimer(seg);
      fire(isFinal ? "final" : "terminal");
      return true;
    }
    if (seg.waitingFor === candidate && seg.timer) return true;
    this.clearTimer(seg);
    seg.waitingFor = candidate;
    seg.timer = setTimeout(() => {
      seg.timer = undefined;
      seg.waitingFor = undefined;
      // Still the same words? "that is all" that became "that is all wrong" is not a dismissal.
      if (seg.words.slice(seg.consumed).join(" ") !== candidate) return;
      if (!this.opts.enabled() || this.opts.dictation.active()) return;
      fire("stable");
    }, this.carefulMs);
    seg.timer.unref?.();
    return true;
  }

  /** Take the segment's words as heard and leave them all behind. */
  private consume(seg: Segment, words: string[], now: number): void {
    this.clearTimer(seg);
    seg.words = words;
    seg.consumed = words.length;
    seg.lastAt = now;
  }

  private fire(seg: Segment, reflex: Reflex, phrase: string, wordCount: number, earAt: number, matchedAt: number, how: ReflexLedgerRow["fired"]): void {
    seg.consumed = Math.max(seg.consumed, wordCount);
    const id = newId("rfx");
    const dispatchedAt = this.now();
    log.info(`ear: "${phrase}" → ${reflex.label} (${how}, ${dispatchedAt - earAt} ms after the app heard it)`);
    if (reflex.kind === "dictate_start") this.opts.dictation.start();
    if (reflex.kind === "dictate_stop") this.opts.dictation.stop("said");
    void this.opts
      .run(reflex, phrase)
      .then((outcome) => {
        const doneAt = this.now();
        const did = outcome.did !== undefined ? { did: outcome.did } : {};
        // The outcome's reflex, not the grammar's: a batch hands back one whose `said` is where
        // the words actually landed, and that is what the delegation speaks when it reconciles.
        if (outcome.ok) this.opts.fired.record({ id, phrase, reflex: outcome.reflex ?? reflex, source: "ear", earAt, matchedAt, dispatchedAt: outcome.dispatchedAt ?? dispatchedAt, doneAt, ok: true, ...did });
        if (outcome.did) log.info(`ear: ${reflex.label} ${outcome.ok ? "done" : "did not apply"} in ${doneAt - dispatchedAt} ms: ${outcome.did.slice(0, 200)}`);
        this.opts.ledger?.({ at: doneAt, type: "reflex", id, phrase, action: reflex.label, source: "ear", earAt, matchedAt, dispatchedAt: outcome.dispatchedAt ?? dispatchedAt, doneAt, ok: outcome.ok, ...(outcome.dropped ? { dropped: outcome.dropped } : {}), fired: how, ...did });
      })
      .catch((e: unknown) => {
        const doneAt = this.now();
        log.warn(`ear reflex ${reflex.label} threw: ${(e as Error).message}`);
        this.opts.ledger?.({ at: doneAt, type: "reflex", id, phrase, action: reflex.label, source: "ear", earAt, matchedAt, dispatchedAt, doneAt, ok: false, dropped: (e as Error).message, fired: how });
      });
  }

  // ------------------------------------------------------------- dictation

  private dictate(seg: Segment, candidate: string, isFinal: boolean, _at: number): void {
    // Commands end the wait: "stop dictating" lands the moment it is heard.
    const stopsNow = DICTATION_COMMANDS.some(([re, cmd]) => cmd === "stop" && re.test(candidate));
    if (isFinal || stopsNow) {
      this.clearTimer(seg);
      this.typeDictated(seg, candidate, seg.words.length);
      return;
    }
    if (seg.waitingFor === candidate && seg.timer) return;
    this.clearTimer(seg);
    seg.waitingFor = candidate;
    const wordCount = seg.words.length;
    seg.timer = setTimeout(() => {
      seg.timer = undefined;
      seg.waitingFor = undefined;
      if (seg.words.slice(seg.consumed).join(" ") !== candidate) return;
      if (!this.opts.dictation.active()) return;
      this.typeDictated(seg, candidate, wordCount);
    }, this.opts.dictationStableMs ?? 700);
    seg.timer.unref?.();
  }

  /** Split the dictated words at the commands and carry them out in order; text between commands is typed with a trailing space. */
  private typeDictated(seg: Segment, candidate: string, wordCount: number): void {
    seg.consumed = Math.max(seg.consumed, wordCount);
    const pieces: Array<{ text: string } | { cmd: "stop" | "newline" | "paragraph" | "delete" }> = [];
    let rest = candidate.replace(FILLER_HEAD, "");
    for (;;) {
      let first: { index: number; length: number; cmd: "stop" | "newline" | "paragraph" | "delete" } | undefined;
      for (const [re, cmd] of DICTATION_COMMANDS) {
        const m = re.exec(rest);
        if (m && (!first || m.index < first.index)) first = { index: m.index, length: m[0].length, cmd };
      }
      if (!first) break;
      const before = rest.slice(0, first.index).trim();
      if (before) pieces.push({ text: before });
      pieces.push({ cmd: first.cmd });
      rest = rest.slice(first.index + first.length);
      if (first.cmd === "stop") {
        rest = "";
        break;
      }
    }
    const tail = rest.replace(/^[\s,.]+/, "").trim();
    if (tail) pieces.push({ text: tail });
    void (async () => {
      for (const piece of pieces) {
        if (!this.opts.dictation.active()) return;
        if ("text" in piece) {
          const typed = await this.opts.dictation.type(`${piece.text} `);
          if (!typed) {
            this.opts.dictation.stop("refused");
            return;
          }
        } else if (piece.cmd === "stop") {
          this.opts.dictation.stop("said");
          return;
        } else if (piece.cmd === "delete") await this.opts.dictation.deleteWord();
        else await this.opts.dictation.newline(piece.cmd === "paragraph" ? 2 : 1);
      }
    })().catch((e: unknown) => log.warn(`dictation: ${(e as Error).message}`));
  }

  // ---------------------------------------------------------------- state

  private clearTimer(seg: Segment): void {
    if (seg.timer) clearTimeout(seg.timer);
    seg.timer = undefined;
    seg.waitingFor = undefined;
  }

  /**
   * Stop or pause: nothing heard so far may fire later — and nothing heard so far
   * may fire *again*. The segments stay, with every word consumed: the recogniser
   * still delivers partials and the final for the current segment, and a segment
   * forgotten here would come back whole, with the command Kevin just stopped at
   * the front of it.
   */
  quiesce(): void {
    for (const seg of this.segments.values()) {
      this.clearTimer(seg);
      seg.consumed = seg.words.length;
    }
  }

  /** Asleep: the session is gone and the app's ear restarts with fresh segment numbers; nothing kept here applies. */
  forgetAll(): void {
    for (const seg of this.segments.values()) this.clearTimer(seg);
    this.segments.clear();
    this.current = undefined;
  }

  /** For tests and the bench: the words not yet acted on in the current segment. */
  get pending(): string {
    const seg = this.current;
    return seg ? seg.words.slice(seg.consumed).join(" ") : "";
  }
}
