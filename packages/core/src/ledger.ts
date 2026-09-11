import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerRow } from "@jarhead/protocol";

/**
 * Append-only JSONL, one file per local day, under <stateDir>/ledger.
 *
 * Synchronous appends on purpose: rows are small, the file is local, and a crash
 * between "did" and "recorded" is exactly the gap an append-only log exists to
 * close. The Console reads it back; nothing is shown that was not written.
 */
export class Ledger {
  readonly dir: string;
  private readonly listeners = new Set<(row: LedgerRow) => void>();

  constructor(stateDir: string) {
    this.dir = join(stateDir, "ledger");
    mkdirSync(this.dir, { recursive: true });
  }

  static fileNameFor(at: number): string {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.jsonl`;
  }

  append(row: LedgerRow): void {
    appendFileSync(join(this.dir, Ledger.fileNameFor(row.at)), `${JSON.stringify(row)}\n`);
    for (const l of this.listeners) {
      try {
        l(row);
      } catch {
        // Listeners are views; a broken view never blocks the record.
      }
    }
  }

  onRow(listener: (row: LedgerRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rows for one day, oldest first. Malformed lines are skipped, not fatal. */
  read(at: number = Date.now()): LedgerRow[] {
    const path = join(this.dir, Ledger.fileNameFor(at));
    if (!existsSync(path)) return [];
    const rows: LedgerRow[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as LedgerRow);
      } catch {
        // A torn last line from a crash is expected; skip it.
      }
    }
    return rows;
  }

  days(): string[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort();
  }
}
