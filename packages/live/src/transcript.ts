import type { Speaker, TranscriptItem } from "@jarhead/protocol";

/**
 * Turns transcript fragments into utterances.
 *
 * Live sends fragments with session-timeline ranges and no turn boundaries, for
 * both sides. A fragment that starts within GAP_MS of the previous fragment's end
 * from the same speaker continues that utterance; otherwise it starts a new one.
 * This is what makes "what did Kevin just ask" a real question with a real
 * answer rather than a bag of words.
 */

export const GAP_MS = 1400;

export interface FragmentEvent {
  readonly speaker: Speaker;
  readonly delta: string;
  readonly startMs: number;
  readonly endMs: number;
}

export class Transcript {
  private items: TranscriptItem[] = [];
  private seq = 0;
  private readonly listeners = new Set<(item: TranscriptItem, kind: "start" | "update" | "final") => void>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxItems = 400,
  ) {}

  onChange(listener: (item: TranscriptItem, kind: "start" | "update" | "final") => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(item: TranscriptItem, kind: "start" | "update" | "final"): void {
    for (const l of this.listeners) l(item, kind);
  }

  /** Feed one fragment; returns the utterance it now belongs to. */
  push(frag: FragmentEvent): TranscriptItem {
    const last = this.items[this.items.length - 1];
    const lastSame = [...this.items].reverse().find((i) => i.speaker === frag.speaker && !i.final);
    const continues =
      lastSame !== undefined &&
      frag.startMs - lastSame.endMs <= GAP_MS &&
      // A fragment from the OTHER speaker in between closes the utterance: a reply
      // to a question is a new turn even when the timing would allow a merge.
      (last === undefined || last.speaker === frag.speaker);

    if (continues && lastSame) {
      const merged: TranscriptItem = {
        ...lastSame,
        text: joinFragments(lastSame.text, frag.delta),
        endMs: Math.max(lastSame.endMs, frag.endMs),
      };
      this.items[this.items.indexOf(lastSame)] = merged;
      this.emit(merged, "update");
      return merged;
    }

    // Anything still open from either speaker is finished by a new utterance.
    this.finalizeOpen();

    const item: TranscriptItem = {
      id: `t_${++this.seq}`,
      speaker: frag.speaker,
      text: frag.delta.trim(),
      startMs: frag.startMs,
      endMs: frag.endMs,
      at: this.now(),
      final: false,
    };
    this.items.push(item);
    if (this.items.length > this.maxItems) this.items.splice(0, this.items.length - this.maxItems);
    this.emit(item, "start");
    return item;
  }

  /** Close utterances that have not grown for GAP_MS at the given session time. */
  settle(nowMs: number): TranscriptItem[] {
    const closed: TranscriptItem[] = [];
    this.items = this.items.map((i) => {
      if (i.final || nowMs - i.endMs < GAP_MS) return i;
      const f = { ...i, final: true };
      closed.push(f);
      return f;
    });
    for (const f of closed) this.emit(f, "final");
    return closed;
  }

  /**
   * Close every open utterance now (a new one is starting). Each item closed here
   * is emitted as `final` exactly as `settle` would: the engine's ledger and its
   * `utterance` event hang on that emission, and a command Jarhead answers within
   * the merge gap used to be closed here silently and never reach the ledger —
   * 4 of 51 delegations had their triggering utterance on record.
   */
  finalizeOpen(): void {
    const closed: TranscriptItem[] = [];
    this.items = this.items.map((i) => {
      if (i.final) return i;
      const f = { ...i, final: true };
      closed.push(f);
      return f;
    });
    for (const f of closed) this.emit(f, "final");
  }

  all(): readonly TranscriptItem[] {
    return this.items;
  }

  /** Kevin's utterances since a session time, newest last — the request behind a delegation. */
  since(startMs: number, speaker?: Speaker): readonly TranscriptItem[] {
    return this.items.filter((i) => i.endMs > startMs && (speaker === undefined || i.speaker === speaker));
  }

  /** Text of the last utterance from a speaker. */
  last(speaker: Speaker): TranscriptItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item && item.speaker === speaker) return item;
    }
    return undefined;
  }

  /**
   * A compact dialogue rendering for the brain: the last `windowMs` of
   * conversation, both sides, oldest first.
   */
  render(windowMs: number, uptoMs: number): string {
    const from = uptoMs - windowMs;
    return this.items
      .filter((i) => i.endMs >= from)
      .map((i) => `${i.speaker === "kevin" ? "Kevin" : "Jarhead"}: ${i.text}`)
      .join("\n");
  }
}

/**
 * Fragments carry their own spacing: " hey", ", jar", "head" — a fragment with
 * no leading space continues the previous word. So joining is concatenation; the
 * only edits are trimming the utterance's leading whitespace and collapsing any
 * doubled spaces the server happens to send.
 */
export function joinFragments(a: string, b: string): string {
  if (!a) return b.replace(/^\s+/, "");
  return `${a}${b}`.replace(/\s{2,}/g, " ");
}
