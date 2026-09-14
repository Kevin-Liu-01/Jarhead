import { THREAD_TERMINAL, type Thread } from "@jarhead/protocol";

/**
 * The CLI's view of the thread table — pure, so `jarhead status` and `jarhead cmd thread.*`
 * are pinned by a test without a daemon: which thread an id-or-name means, the glyph a
 * status draws, and the lines `status` prints.
 */

/** What `thread.stop|pause|resume <id|name>` sends and, when the table knows it, the thread it names. */
export interface ResolvedThread {
  readonly threadId: string;
  readonly target?: Thread;
}

/**
 * An id is sent as it is; a name is looked up case-insensitively, live threads first (a
 * finished "slack" still lingers in the snapshot for THREAD_LINGER_MS while a new one
 * runs). "main" and any `t_…` pass through even when the table does not list them (a
 * thread that just ended), so a stop is never refused for a stale listing. Anything
 * else unknown throws, naming what IS live.
 */
export function resolveThread(threads: readonly Thread[], arg: string): ResolvedThread {
  const wanted = arg.toLowerCase();
  const byId = threads.find((t) => t.id === arg);
  const live = threads.filter((t) => !THREAD_TERMINAL.has(t.status));
  const byName = live.find((t) => t.name.toLowerCase() === wanted) ?? threads.find((t) => t.name.toLowerCase() === wanted);
  const target = byId ?? byName;
  if (!target && arg !== "main" && !/^t_/.test(arg)) {
    const names = live.map((t) => `${t.name} (${t.id})`).join(", ");
    throw new Error(`no thread called ${arg}${names ? `; live: ${names}` : "; nothing is live"}`);
  }
  return target ? { threadId: target.id, target } : { threadId: arg };
}

/** One glyph per thread status: the settled ones as the Console draws them, everything live as a spinner. */
export function threadGlyph(status: Thread["status"]): string {
  switch (status) {
    case "done":
      return "✔";
    case "failed":
      return "✘";
    case "stopped":
      return "–";
    case "waiting-kevin":
      return "?";
    case "paused":
      return "‖";
    case "idle":
      return "·";
    default:
      return "⟳";
  }
}

/** `threads N (M live)` and one row per thread: glyph · name · status · lane · steps · id · the question it asks, else its detail. */
export function threadsLines(threads: readonly Thread[]): string[] {
  const live = threads.filter((t) => !THREAD_TERMINAL.has(t.status)).length;
  const lines = [`  threads    ${threads.length} (${live} live)`];
  for (const t of threads) lines.push(`    ${threadGlyph(t.status)} ${t.name.padEnd(16)} ${t.status.padEnd(14)} ${t.lane.padEnd(10)} ${t.steps} step${t.steps === 1 ? "" : "s"} · ${t.id}${t.question ? ` · asks: ${t.question}` : t.detail ? ` · ${t.detail}` : ""}`);
  return lines;
}
