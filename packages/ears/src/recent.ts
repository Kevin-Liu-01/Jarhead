/**
 * A rolling minute of everything the microphone heard.
 *
 * The wake gate answers "was this addressed to me". This answers the next
 * question: "addressed about WHAT". Kevin says "you got that jarhead?" and the
 * thing he means was said thirty seconds ago, to somebody else, or to himself.
 * Without a buffer the reply has nothing to work with and Jarhead asks him to
 * repeat himself, which is the most annoying possible response.
 *
 * Deliberately just text, and deliberately just a minute. Keeping audio would
 * mean a rolling PCM buffer and a second transcription pass; keeping everything
 * would mean deciding what to forget. Sixty seconds of transcript is a few
 * kilobytes and covers the span in which "that" still refers to something.
 *
 * Nothing here leaves the machine unless a turn actually wakes, and only the
 * window around the wake is attached.
 */

export interface Heard {
  readonly at: number;
  readonly text: string;
}

export const DEFAULT_WINDOW_MS = 60_000;

export class RecentSpeech {
  private readonly entries: Heard[] = [];

  constructor(
    private readonly windowMs: number = DEFAULT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  add(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.push({ at: this.now(), text: trimmed });
    this.prune();
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.entries.length > 0 && (this.entries[0]?.at ?? 0) < cutoff) this.entries.shift();
  }

  /** Everything still inside the window, oldest first. */
  window(): readonly Heard[] {
    this.prune();
    return [...this.entries];
  }

  /**
   * The transcript to hand the model, excluding the utterance that just woke it.
   *
   * The waking utterance is already the request; repeating it as context makes
   * the model answer it twice. `skipLast` drops it.
   */
  context(skipLast = true): string {
    this.prune();
    const rows = skipLast ? this.entries.slice(0, -1) : this.entries;
    if (rows.length === 0) return "";
    const base = this.now();
    return rows
      .map((e) => `[${Math.round((base - e.at) / 1000)}s ago] ${e.text}`)
      .join("\n");
  }

  /**
   * True when the request leans on something already said.
   *
   * Only then is the context worth attaching: a self-contained question
   * ("what's on hacker news") gets nothing, which keeps the prompt small and
   * stops the model dragging unrelated room chatter into an answer.
   */
  static needsContext(command: string): boolean {
    if (command.trim().length === 0) return false;
    // Bare "it" is deliberately absent: "what time is it" is a dummy subject,
    // not a reference, and including it attached room chatter to almost every
    // question. Under-attaching is the safer failure — the model can ask.
    return /\b(that|this|those|these|the (one|thing)|again|same|earlier|just said|you got|what i said|we were)\b/i.test(
      command,
    );
  }

  clear(): void {
    this.entries.length = 0;
  }
}
