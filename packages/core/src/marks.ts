/**
 * Latency marks for one delegation or one turn.
 * Everything Jarhead claims about speed comes from these, never from a table.
 */
export class Marks {
  private readonly at = new Map<string, number>();
  readonly startedAt: number;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  /** First call wins; a repeated mark keeps the earlier time. */
  mark(name: string): number {
    const t = this.now();
    if (!this.at.has(name)) this.at.set(name, t);
    return this.at.get(name) ?? t;
  }

  has(name: string): boolean {
    return this.at.has(name);
  }

  /** ms from start to the mark, or undefined if it never happened. */
  since(name: string): number | undefined {
    const t = this.at.get(name);
    return t === undefined ? undefined : t - this.startedAt;
  }

  between(a: string, b: string): number | undefined {
    const ta = this.at.get(a);
    const tb = this.at.get(b);
    return ta === undefined || tb === undefined ? undefined : tb - ta;
  }

  toRecord(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of this.at) out[k] = v - this.startedAt;
    return out;
  }
}
