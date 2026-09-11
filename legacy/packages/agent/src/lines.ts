import type { Interface } from "node:readline/promises";

/**
 * A line queue over readline.
 *
 * `rl.question()` alone loses input: readline runs in flowing mode, so any line
 * that arrives while no question is pending is consumed and discarded. With a
 * TTY that never happens because the human waits for the prompt. With piped
 * stdin every line arrives at once, so the whole script vanished during the
 * startup await and the loop then crashed on ERR_USE_AFTER_CLOSE at EOF.
 *
 * Subscribing to `line` from the start and buffering fixes both: scripted runs
 * work, and end-of-input becomes an ordinary `undefined` instead of a throw.
 */
export class LineReader {
  private readonly queue: string[] = [];
  private waiting: ((line: string | undefined) => void) | undefined;
  private closed = false;

  constructor(private readonly rl: Interface) {
    rl.on("line", (line: string) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });

    rl.on("close", () => {
      this.closed = true;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(undefined);
      }
    });
  }

  /** Returns the next line, or undefined at end of input. */
  async next(promptText: string): Promise<string | undefined> {
    const buffered = this.queue.shift();
    if (buffered !== undefined) {
      // Echo so a piped transcript still reads like a conversation.
      if (!this.rl.terminal) process.stdout.write(`${promptText}${buffered}\n`);
      return buffered;
    }
    if (this.closed) return undefined;

    if (this.rl.terminal) this.rl.setPrompt(promptText);
    process.stdout.write(promptText);

    return new Promise<string | undefined>((resolve) => {
      this.waiting = resolve;
    });
  }
}
