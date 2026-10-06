#!/usr/bin/env tsx
import { appendFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, setLogLevel } from "@jarhead/core";
import { Engine } from "@jarhead/engine";
import { DaemonLockHeld, DaemonServer, EXIT_ALREADY_RUNNING, Lifeline, SocketInUseError, acquireDaemonLock, socketInUse, type DaemonLock } from "./server.ts";

/**
 * jarheadd — the engine as a process.
 *
 * The native app launches this and talks over the socket; the CLI can too. It
 * never touches a microphone or a speaker itself: audio arrives from whoever is
 * connected, which is what lets the app own the devices and the TCC prompts.
 *
 * The app runs it as `node --import <tsx loader> packages/daemon/src/main.ts`: one
 * process, so the pid the app holds, the pid in the hello and the pid in the lock file
 * are the same, and the liveness kick kills the daemon itself.
 *
 * One daemon per state dir and per socket: the state dir's lock (`<stateDir>/jarheadd.lock`)
 * is taken before anything is built, and listen() refuses a socket another daemon holds
 * (its `<socket>.lock`) or answers on. A second daemon says why on one line and exits 73
 * (EXIT_ALREADY_RUNNING). So a second daemon needs its own JARHEAD_STATE_DIR as well as its
 * own --socket.
 *
 * The app's connection closing without a bye pauses an open session only when the app is
 * not back within APP_GONE_GRACE_MS (server.ts): a crash relaunch keeps the session, the
 * running task and the threads.
 */

/**
 * Whether the daemon opens a session by itself at start. Never when the wake word gate is on:
 * the native app owns waking then, and the session must not open (and start billing) until
 * Kevin has said the word and authenticated. Never with `--no-wake` or JARHEAD_AUTO_WAKE=0
 * (test launches). Otherwise the `autoWake` setting decides.
 */
export function shouldAutoWake(
  settings: { readonly autoWake: boolean; readonly wake: { readonly enabled: boolean } },
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[] = [],
): boolean {
  if (args.includes("--no-wake")) return false;
  if (env["JARHEAD_AUTO_WAKE"] === "0") return false;
  if (settings.wake.enabled) return false;
  return settings.autoWake;
}

/**
 * What daemon.log says when the socket is taken: Setup's Welcome and the status menu show
 * the line. A held lock names its pid; a server of an older build only answered.
 */
export function socketRefusal(e: SocketInUseError): string {
  return e.holder !== undefined ? `another Jarhead daemon (pid ${e.holder}) holds ${e.socketPath}` : `another Jarhead daemon answers on ${e.socketPath}`;
}

/** True when this file is the process's entry point (not imported by a test). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const socketArg = args.indexOf("--socket");
  const config = readConfig();
  setLogLevel(config.logLevel);
  const socketPath = socketArg >= 0 ? (args[socketArg + 1] ?? config.socketPath) : config.socketPath;

  let lock: DaemonLock;
  try {
    lock = acquireDaemonLock(config.stateDir);
  } catch (e) {
    if (!(e instanceof DaemonLockHeld)) throw e;
    console.error(`jarheadd: ${e.message}. Not starting a second one.`);
    process.exit(EXIT_ALREADY_RUNNING);
  }

  // A daemon of another state dir on our socket: refuse before building an engine. listen()
  // below refuses again if one comes up in between.
  const refuseSocket = (e: SocketInUseError): never => {
    console.error(`jarheadd: ${socketRefusal(e)}. Not starting a second one.`);
    lock.release();
    process.exit(EXIT_ALREADY_RUNNING);
  };
  const taken = await socketInUse(socketPath);
  if (taken) refuseSocket(taken);

  // The lock is ours: this engine closes what a dead daemon left open (its session, its live threads).
  const engine = new Engine({ config, ownsStateDir: true });
  const server = new DaemonServer(engine, socketPath);
  try {
    await server.listen();
  } catch (e) {
    if (!(e instanceof SocketInUseError)) throw e;
    refuseSocket(e);
  }
  await engine.start();
  const settings = engine.currentSettings;
  if (shouldAutoWake(settings, process.env, args)) void engine.wake("auto-wake at daemon start");
  else console.log(`jarheadd: not auto-waking (env JARHEAD_AUTO_WAKE=${process.env["JARHEAD_AUTO_WAKE"] ?? "unset"}, settings.autoWake=${settings.autoWake}, wake word gate=${settings.wake.enabled ? "on" : "off"})`);
  console.log(`jarheadd up on ${socketPath} (pid ${process.pid})`);

  let stopping = false;
  async function shutdown(signal: string, code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    console.log(`jarheadd: ${signal}, shutting down`);
    await Promise.race([Promise.all([server.close(), engine.stop()]), new Promise((r) => setTimeout(r, 6000))]);
    lock.release();
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
}

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

if (isEntryPoint()) await run();
