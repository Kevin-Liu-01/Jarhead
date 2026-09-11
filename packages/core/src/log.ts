export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (level: LogLevel, scope: string, message: string) => void;

let threshold: LogLevel = "info";
const sinks: LogSink[] = [
  (level, scope, message) => {
    const line = `${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} ${scope}: ${message}\n`;
    if (level === "error" || level === "warn") process.stderr.write(line);
    else process.stdout.write(line);
  },
];

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** Add another destination (the Console window, a file). Returns an unsubscribe. */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

/** Replace the default stdout/stderr sink (the daemon logs to ~/.jarhead/daemon.log). */
export function replaceDefaultSink(sink: LogSink): void {
  sinks[0] = sink;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function logger(scope: string): Logger {
  const emit = (level: LogLevel, message: string): void => {
    if (ORDER[level] < ORDER[threshold]) return;
    for (const sink of sinks) {
      try {
        sink(level, scope, message);
      } catch {
        // A broken sink must not take the logger down.
      }
    }
  };
  return { debug: (m) => emit("debug", m), info: (m) => emit("info", m), warn: (m) => emit("warn", m), error: (m) => emit("error", m) };
}
