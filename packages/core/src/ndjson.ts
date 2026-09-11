/**
 * Newline-delimited JSON framing, shared by the native hands helper and the
 * control socket.
 *
 * A line cap is not optional: a peer that withholds newlines must not be able to
 * grow the buffer forever.
 */
export class LineSplitter {
  private buffer = "";

  constructor(private readonly maxLineBytes = 16 * 1024 * 1024) {}

  /** Feed a chunk; returns complete lines (without the newline). */
  push(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = "";
      throw new Error(`ndjson line exceeded ${this.maxLineBytes} bytes; dropped`);
    }
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) lines.push(line);
    }
    return lines;
  }
}
