#!/usr/bin/env tsx
import { readConfig, setLogLevel } from "@jarhead/core";
import { Engine } from "@jarhead/engine";
import { DaemonServer } from "./server.ts";

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
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`jarheadd: ${signal}, shutting down`);
  await Promise.race([Promise.all([server.close(), engine.stop()]), new Promise((r) => setTimeout(r, 6000))]);
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
// The app closing its end of the socket is not a shutdown; only signals and stdin EOF are.
process.stdin.on("end", () => void shutdown("stdin closed"));
process.stdin.resume();
