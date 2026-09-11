import { STAGE_BUDGET_MS, type TurnStage } from "@jarvis/core";

/**
 * Per-stage latency log, on from the very first turn.
 *
 * The DECISION doc's budget table is a stack of vendor best-cases; it is not
 * evidence. This is what turns it into evidence. M1's exit gate is a measured
 * 50-utterance run, and it reads from here.
 */

export interface Mark {
  readonly stage: TurnStage | string;
  readonly at: number;
  readonly took: number;
  readonly note: string | undefined;
}

export class Timeline {
  private readonly startedAt = Date.now();
  private last = this.startedAt;
  readonly marks: Mark[] = [];

  mark(stage: TurnStage | string, note?: string): void {
    const now = Date.now();
    this.marks.push({
      stage,
      at: now - this.startedAt,
      took: now - this.last,
      note,
    });
    this.last = now;
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Convert an absolute epoch timestamp into ms-since-turn-start. */
  since(epochMs: number): number {
    return epochMs - this.startedAt;
  }

  /** ms from turn start to the mark named `stage`, if it happened. */
  at(stage: string): number | undefined {
    return this.marks.find((m) => m.stage === stage)?.at;
  }

  render(firstAudioMs: number | undefined): string {
    const width = Math.max(...this.marks.map((m) => m.stage.length), 10);
    const rows = this.marks.map((m) => {
      const budget = (STAGE_BUDGET_MS as Record<string, number>)[m.stage];
      const verdict =
        budget === undefined ? "" : m.took <= budget ? `  (budget ${budget})` : `  (over budget ${budget})`;
      const note = m.note ? `  ${m.note}` : "";
      return `    ${m.stage.padEnd(width)}  ${String(m.took).padStart(5)}ms  @${String(m.at).padStart(5)}ms${verdict}${note}`;
    });

    const total =
      firstAudioMs !== undefined
        ? `    ${"→ first audio".padEnd(width)}  ${String(firstAudioMs).padStart(5)}ms  ${firstAudioMs < 1000 ? "under 1s" : "OVER 1s"}`
        : `    ${"→ first audio".padEnd(width)}      —  (nothing spoken)`;

    return [...rows, "", total].join("\n");
  }
}
