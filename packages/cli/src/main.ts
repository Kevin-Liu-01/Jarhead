#!/usr/bin/env tsx
import { spawn, type ChildProcess } from "node:child_process";
import { readConfig, setLogLevel } from "@jarhead/core";
import { AgentRegistry, defaultConnectors } from "@jarhead/agents";
import { NativeHandsProcess } from "@jarhead/hands";
import { Engine } from "@jarhead/engine";
import { DaemonClient } from "@jarhead/daemon";
import type { Delegation, EngineEvent, PermissionInfo, TranscriptItem } from "@jarhead/protocol";
import { render, runChecks, summarizePermissions } from "./doctor.ts";
import { bench } from "./bench.ts";

const HELP = `
jarhead — voice-first computer use for Kevin's Mac

  pnpm jarhead doctor                 keys, brain, hands, agents, app (signing, wake word), toolchain
  pnpm jarhead live                   headless session in this terminal (ffmpeg mic, ffplay speaker)
  pnpm jarhead probe "<utterance>"    synthesize the utterance, run it through the whole stack, print the timeline
  pnpm jarhead agents                 list the agent sessions on this Mac (Claude Code, Codex, …)
  pnpm jarhead hands <op> [json]      talk to the native helper directly
  pnpm jarhead ledger [YYYY-MM-DD]    print a day's ledger
  pnpm jarhead status                 talk to a running daemon (jarheadd or the app) and print its state (--permissions: every grant as a row)
  pnpm jarhead say "<text>"           send typed text to the running daemon as if spoken
  pnpm jarhead cmd <wake|sleep|mute|unmute|stop|pause|resume>   send a command to the running daemon
  pnpm jarhead bench                  time the tool path: round trips, quick screenshot, delegation → first action, reflex, the ear's 250 ms path, stop (no API spend)

flags
  --speak        (probe) also play the voice through ffplay
  --timeout N    (probe) seconds to wait after the utterance (default 25)
  --runs N       (bench) samples per metric (default 5)
  --codex        (bench) drive the real Codex brain for the delegation runs (a couple of tiny turns on Kevin's login)
  --fake-hands   (bench) answer the helper's requests in-process instead of the Swift helper
  --no-gate      (bench) do not exit non-zero when the ear's p95 to dispatch is over 250 ms with the real helper
  --json         (bench) print the table as JSON
  --debug        verbose logs
`;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--timeout", "--runs"]);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (a.startsWith("--")) {
    if (VALUE_FLAGS.has(a)) i++;
    continue;
  }
  positional.push(a);
}
const flagValue = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (flags.has("--debug")) setLogLevel("debug");

function printEvent(e: EngineEvent, seenSteps: Set<string>, seenItems: Map<string, string>): void {
  if (e.type === "toast") console.log(`  ⚑ ${e.text}`);
  if (e.type !== "snapshot") return;
  for (const item of e.snapshot.transcript) {
    if (!item.final) continue;
    if (seenItems.get(item.id) === item.text) continue;
    seenItems.set(item.id, item.text);
    console.log(`  ${item.speaker === "kevin" ? "you    " : "jarhead"}: ${item.text}   [${item.startMs}-${item.endMs}ms]`);
  }
  for (const d of e.snapshot.delegations) {
    if (!seenSteps.has(d.id)) {
      seenSteps.add(d.id);
      console.log(`  ▶ delegation "${d.request}"`);
    }
    for (const s of d.steps) {
      if (seenSteps.has(s.id)) continue;
      seenSteps.add(s.id);
      const when = `+${s.at - d.createdAt}ms`;
      if (s.kind === "tool" && s.tool) console.log(`      ${when.padStart(8)} ${s.tool.ok ? "·" : "✘"} ${s.tool.name} ${JSON.stringify(s.tool.input).slice(0, 80)} (${s.tool.ms}ms)`);
      else if (s.kind === "screenshot") console.log(`      ${when.padStart(8)} ▣ screenshot ${s.screenshotPath ?? ""}`);
      else console.log(`      ${when.padStart(8)} ${s.kind}: ${(s.text ?? "").slice(0, 140)}`);
    }
    const key = `${d.id}:${d.status}`;
    if (d.status !== "running" && !seenSteps.has(key)) {
      seenSteps.add(key);
      const t = d.timings;
      console.log(`  ■ ${d.status} in ${(t.doneAt ?? 0) - t.delegatedAt}ms (thinking@${t.firstThinkingAt ? t.firstThinkingAt - t.delegatedAt : "-"} commentary@${t.firstCommentaryAt ? t.firstCommentaryAt - t.delegatedAt : "-"})${d.summary ? ` — ${d.summary}` : ""}`);
    }
  }
}

function speaker(): { write: (pcm: Buffer) => void; stop: () => void } {
  let ff: ChildProcess | undefined;
  return {
    write: (pcm) => {
      if (!ff) {
        ff = spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", "-f", "s16le", "-ar", "24000", "-ch_layout", "mono", "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0"], { stdio: ["pipe", "ignore", "ignore"] });
        ff.stdin?.on("error", () => undefined);
        ff.on("close", () => (ff = undefined));
      }
      ff.stdin?.write(pcm);
    },
    stop: () => ff?.kill("SIGKILL"),
  };
}

function mic(onPcm: (pcm: Buffer) => void): () => void {
  const ff = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "24000", "-acodec", "pcm_s16le", "-f", "s16le", "pipe:1"]);
  ff.stdout?.on("data", (chunk: Buffer) => onPcm(chunk));
  ff.stderr?.on("data", (c: Buffer) => console.error(`  mic: ${c.toString().trim()}`));
  return () => ff.kill("SIGINT");
}

async function withEngine(run: (engine: Engine) => Promise<void>): Promise<void> {
  const engine = new Engine();
  const t0 = Date.now();
  await engine.start();
  console.log(`  engine ready in ${Date.now() - t0}ms`);
  try {
    await run(engine);
  } finally {
    // A brain or helper that will not die must not keep the CLI alive.
    await Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 8000))]);
  }
}

async function live(): Promise<void> {
  await withEngine(async (engine) => {
    const seenSteps = new Set<string>();
    const seenItems = new Map<string, string>();
    const out = speaker();
    engine.on("event", (e) => printEvent(e, seenSteps, seenItems));
    engine.on("audio", (pcm) => out.write(pcm));
    let last = "";
    engine.on("event", (e) => {
      if (e.type === "snapshot" && e.snapshot.phase !== last) {
        last = e.snapshot.phase;
        console.log(`  [${last}]`);
      }
    });
    await engine.ready();
    console.log(`\n  brain: ${engine.brainInfo.kind} — ${engine.brainInfo.detail}`);
    await engine.wake();
    const stopMic = mic((pcm) => engine.feedMic(pcm));
    console.log("  listening. talk to it; Ctrl-C to quit.\n");
    await new Promise<void>((resolve) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => resolve());
    });
    stopMic();
    out.stop();
  });
}

async function probe(text: string): Promise<void> {
  const cfg = readConfig();
  if (!cfg.openaiApiKey) throw new Error("OPENAI_API_KEY missing");
  const timeoutS = Number(flagValue("timeout") ?? 25);
  console.log(`\n  synthesizing: "${text}"`);
  const tts = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.openaiApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: text, response_format: "pcm" }),
  });
  if (!tts.ok) throw new Error(`tts failed: ${tts.status}`);
  const pcm = Buffer.from(await tts.arrayBuffer());
  console.log(`  ${(pcm.length / 48000).toFixed(1)}s of speech`);

  await withEngine(async (engine) => {
    const seenSteps = new Set<string>();
    const seenItems = new Map<string, string>();
    const out = flags.has("--speak") ? speaker() : undefined;
    engine.on("event", (e) => printEvent(e, seenSteps, seenItems));
    if (out) engine.on("audio", (pcm2) => out.write(pcm2));
    await engine.ready();
    console.log(`  brain: ${engine.brainInfo.kind} — ${engine.brainInfo.detail}`);
    const t0 = Date.now();
    await engine.wake();
    console.log(`  session up in ${Date.now() - t0}ms; streaming audio`);
    const chunk = 4800;
    for (let off = 0; off < pcm.length; off += chunk) {
      engine.feedMic(pcm.subarray(off, off + chunk));
      await new Promise((r) => setTimeout(r, 100));
    }
    const silence = Buffer.alloc(chunk);
    const until = Date.now() + timeoutS * 1000;
    while (Date.now() < until) {
      engine.feedMic(silence);
      await new Promise((r) => setTimeout(r, 100));
    }
    out?.stop();
    const snap = engine.snapshot();
    console.log(`\n  summary: ${snap.transcript.length} utterances, ${snap.delegations.length} delegation(s), phase ${snap.phase}, billed ${snap.session?.usageSeconds ?? 0}s`);
    const problems = snap.problems;
    if (problems.length) console.log(`  problems:\n    - ${problems.join("\n    - ")}`);
  });
}

async function agents(): Promise<void> {
  const cfg = readConfig();
  const reg = new AgentRegistry(defaultConnectors({ claudeBin: cfg.claudeBin }));
  const { agents: list, health } = await reg.refresh();
  console.log("");
  for (const h of health) console.log(`  ${h.ok ? "✔" : "✘"} ${h.kind.padEnd(12)} ${h.detail}`);
  console.log("");
  if (list.length === 0) console.log("  no agents right now\n");
  for (const a of list) console.log(`  ${a.id.padEnd(28)} ${a.status.padEnd(8)} ${a.name}${a.cwd ? `  (${a.cwd})` : ""}${a.detail ? `  — ${a.detail}` : ""}`);
  console.log("");
}

async function hands(op: string | undefined, json: string | undefined): Promise<void> {
  const cfg = readConfig();
  const h = new NativeHandsProcess({ binPath: cfg.handsBin });
  try {
    const params = json ? (JSON.parse(json) as Record<string, unknown>) : {};
    const t0 = Date.now();
    const r = await h.request(op ?? "hello", params, 10_000);
    const s = JSON.stringify(r, (_k, v) => (typeof v === "string" && v.length > 200 ? `${v.slice(0, 60)}… (${v.length} chars)` : v), 2);
    console.log(`${s}\n  (${Date.now() - t0}ms)`);
  } finally {
    h.stop();
  }
}

function ledger(date: string | undefined): void {
  const engine = new Engine();
  const at = date ? Date.parse(`${date}T12:00:00`) : Date.now();
  for (const row of engine.ledger.read(at)) {
    const t = new Date(row.at).toISOString().slice(11, 19);
    if (row.type === "heard" || row.type === "said") console.log(`${t} ${row.type === "heard" ? "you    " : "jarhead"}: ${(row.item as TranscriptItem).text}`);
    else if (row.type === "delegation.created") console.log(`${t} ▶ ${(row.delegation as Delegation).request}`);
    else if (row.type === "delegation.step") console.log(`${t}    ${row.step.kind} ${row.step.tool?.name ?? row.step.text ?? ""}`);
    else console.log(`${t} ${row.type} ${JSON.stringify(row).slice(0, 120)}`);
  }
}

/** Connect to the running daemon; exits with a hint when none is up. */
async function daemon(): Promise<DaemonClient> {
  const cfg = readConfig();
  const client = new DaemonClient(cfg.socketPath);
  try {
    await client.connect({ pid: process.pid, audio: false });
  } catch {
    throw new Error(`no daemon on ${cfg.socketPath} — start Jarhead.app or \`pnpm jarheadd\``);
  }
  return client;
}

async function status(): Promise<void> {
  const client = await daemon();
  let levels: { input: number; output: number } | undefined;
  const snap = await new Promise<Record<string, unknown>>((resolve) => {
    let got: Record<string, unknown> | undefined;
    const done = (): void => {
      if (got) resolve(got);
    };
    client.on("message", (m) => {
      if (m.type === "snapshot") got = m.snapshot as Record<string, unknown>;
      if (m.type === "levels") levels = m.levels as { input: number; output: number };
      if (got && (levels || flags.has("--no-levels"))) done();
    });
    // Levels arrive once a second; do not wait longer than that for them.
    setTimeout(done, 1500);
  });
  client.close();
  const s = snap as { phase: string; session?: { id: string; usageSeconds: number }; transcript: { speaker: string; text: string }[]; delegations: unknown[]; agents: unknown[]; problems: string[]; brainReady: boolean; handsReady: boolean; permissions?: { microphone: string; screenRecording: string; accessibility: string; all?: PermissionInfo[] } };
  console.log(`\n  phase      ${s.phase}`);
  console.log(`  session    ${s.session ? `${s.session.id} · ${Math.round(s.session.usageSeconds)}s billed` : "none"}`);
  console.log(`  brain      ${s.brainReady ? "ready" : "not ready"}   hands ${s.handsReady ? "ready" : "not ready"}`);
  // The app's read of every grant (TCC keys them on Jarhead.app); without the app, the four the daemon's helper reads.
  const perms = s.permissions;
  if (perms?.all?.length) console.log(`  permissions  ${summarizePermissions(perms.all)}`);
  else if (perms) console.log(`  permissions  mic ${perms.microphone} · screen recording ${perms.screenRecording} · accessibility ${perms.accessibility} (an older daemon: no list)`);
  if (flags.has("--permissions") && perms?.all) for (const p of perms.all) console.log(`    ${p.grant === "granted" ? "✔" : p.grant === "denied" ? "✘" : "?"} ${p.label.padEnd(20)} ${p.grant.padEnd(8)} ${p.ask === "settings" ? "System Settings" : p.ask === "perApp" ? "per app" : "prompt"}${p.required ? " · required" : ""}${p.detail ? ` · ${p.detail}` : ""}`);
  if (levels) console.log(`  levels     mic ${levels.input.toFixed(3)}   speaker ${levels.output.toFixed(3)}`);
  console.log(`  agents     ${s.agents.length}   delegations ${s.delegations.length}   utterances ${s.transcript.length}`);
  for (const t of s.transcript.slice(-6)) console.log(`    ${t.speaker === "kevin" ? "you    " : "jarhead"}: ${t.text}`);
  if (s.problems.length) console.log(`  problems\n    - ${s.problems.join("\n    - ")}`);
  console.log("");
}

async function sendCommand(cmd: Record<string, unknown>): Promise<void> {
  const client = await daemon();
  client.sendJson({ type: "command", command: cmd });
  await new Promise((r) => setTimeout(r, 150));
  client.close();
  console.log(`  sent ${JSON.stringify(cmd)}`);
}

const [command, ...rest] = positional;
try {
  switch (command) {
    case "doctor": {
      const { text, blocking } = render(await runChecks());
      console.log(text);
      process.exit(blocking > 0 ? 1 : 0);
    }
    // eslint-disable-next-line no-fallthrough
    case "live":
      await live();
      break;
    case "probe":
      await probe(rest.join(" ") || "hey jarhead, what app is open on my screen right now?");
      break;
    case "agents":
      await agents();
      break;
    case "hands":
      await hands(rest[0], rest[1]);
      break;
    case "ledger":
      ledger(rest[0]);
      break;
    case "status":
      await status();
      break;
    case "say":
      if (rest.length === 0) throw new Error('usage: jarhead say "hello there"');
      await sendCommand({ type: "say-text", text: rest.join(" ") });
      break;
    case "bench":
      if (!(await bench({ runs: Math.max(1, Number(flagValue("runs") ?? 5) || 5), codex: flags.has("--codex"), fakeHands: flags.has("--fake-hands"), json: flags.has("--json"), gate: !flags.has("--no-gate") })).ok) process.exit(1);
      break;
    case "cmd": {
      const sub = rest[0];
      if (!sub || !["go", "pause", "stop", "interrupt", "wake", "sleep", "resume", "mute", "unmute", "agent.refresh"].includes(sub)) throw new Error("usage: jarhead cmd <go|pause|stop|interrupt|wake|sleep|resume|mute|unmute|agent.refresh>  (stop closes the voice session — the meter stops; interrupt cancels the work but keeps listening)");
      await sendCommand({ type: sub });
      break;
    }
    case undefined:
    case "help":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error(`\n  error: ${(e as Error).message}\n`);
  process.exit(1);
}
