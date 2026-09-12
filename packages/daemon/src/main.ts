#!/usr/bin/env tsx
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, setLogLevel } from "@jarhead/core";
import { Engine } from "@jarhead/engine";
import { DaemonServer, Lifeline } from "./server.ts";

/**
 * jarheadd — the engine as a process.
 *
 * The native app launches this and talks over the socket; the CLI can too. It
 * never touches a microphone or a speaker itself: audio arrives from whoever is
 * connected, which is what lets the app own the devices and the TCC prompts.
 */

const args = process.argv.slice(2);
const socketArg = args.indexOf("--socket");
const config = readConfig();
setLogLevel(config.logLevel);
const socketPath = socketArg >= 0 ? (args[socketArg + 1] ?? config.socketPath) : config.socketPath;
const autoWake = args.includes("--no-wake") ? false : process.env["JARHEAD_AUTO_WAKE"] !== "0";

const engine = new Engine({ config });
const server = new DaemonServer(engine, socketPath);
await server.listen();
await engine.start();
// The wake word gate (native app, on-device) owns waking when it is enabled: the
// session must not open, and start billing, until Kevin has said the word and
// authenticated.
const gated = engine.currentSettings.wake.enabled;
if (autoWake && engine.currentSettings.autoWake && !gated) void engine.wake("auto-wake at daemon start");
else console.log(`jarheadd: not auto-waking (env JARHEAD_AUTO_WAKE=${process.env["JARHEAD_AUTO_WAKE"] ?? "unset"}, settings.autoWake=${engine.currentSettings.autoWake}, wake word gate=${gated ? "on" : "off"})`);
console.log(`jarheadd up on ${socketPath} (pid ${process.pid})`);

let stopping = false;
async function shutdown(signal: string, code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`jarheadd: ${signal}, shutting down`);
  await Promise.race([Promise.all([server.close(), engine.stop()]), new Promise((r) => setTimeout(r, 6000))]);
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
// Self-update: the engine asks to be replaced; exit 75 (EX_TEMPFAIL) tells the app to respawn at once.
engine.on("restart", (reason) => {
  console.log(`jarheadd: restart requested (${reason}); exiting 75 for the app to respawn`);
  void shutdown("restart", 75);
});

// The app closing its end of the socket is not a shutdown; signals are, and so is stdin
// EOF — but only a clean one. The app says `bye` right before it closes our stdin on a
// quit; EOF without a bye means it crashed, and we linger for the relaunch with the brain
// warm (Lifeline, server.ts). JARHEAD_LINGER_MS shortens the window for tests.
//
// Our stdout/stderr are pipes the app reads into daemon.log. When the app dies they die:
// a write would raise EPIPE, which must never take the lingering daemon down, and every
// line after that would be lost — so an orphaned daemon appends straight to daemon.log
// itself (per line, so the app's rotation and its own O_APPEND writes interleave safely).
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);
const lifeline = new Lifeline({
  lingerMs: Number(process.env["JARHEAD_LINGER_MS"]) > 0 ? Number(process.env["JARHEAD_LINGER_MS"]) : 90_000,
  clientCount: () => server.clientCount,
  shutdown: (why) => void shutdown(why),
  log: (line) => console.log(`jarheadd: ${line}`),
  onOrphaned: () => writeOutputToLog(join(config.stateDir, "daemon.log")),
});
server.on("bye", () => lifeline.bye());
server.on("join", () => lifeline.clientJoined());
server.on("leave", () => lifeline.clientLeft());
process.stdin.on("end", () => lifeline.stdinClosed());
process.stdin.resume();

/** Re-home stdout and stderr to the log file the app used to fill from our pipes. */
function writeOutputToLog(path: string): void {
  const append = (chunk: unknown): boolean => {
    try {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) appendFileSync(path, chunk);
    } catch {
      // Best effort: a log that cannot be written is not a reason to exit.
    }
    return true;
  };
  process.stdout.write = append as typeof process.stdout.write;
  process.stderr.write = append as typeof process.stderr.write;
  console.log(`jarheadd: the app's pipes are gone; appending to ${path} directly`);
}
