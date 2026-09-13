#!/usr/bin/env tsx
import { spawn, type ChildProcess } from "node:child_process";
import { Ledger, readConfig, setLogLevel } from "@jarhead/core";
import { AgentRegistry, defaultConnectors } from "@jarhead/agents";
import { NativeHandsProcess } from "@jarhead/hands";
import { Engine } from "@jarhead/engine";
import { DaemonClient } from "@jarhead/daemon";
import type { Delegation, Effort, EngineEvent, PermissionInfo, Problem, SleepCause, TranscriptItem, Worker } from "@jarhead/protocol";
import { render, runChecks, summarizePermissions } from "./doctor.ts";
import { runHygiene, type DockAudit, type HygieneReport } from "./install/index.ts";
import { bench } from "./bench.ts";
import { benchBrain } from "./bench-brain.ts";

const HELP = `
jarhead — voice-first computer use for Kevin's Mac

  pnpm jarhead doctor                 keys, brain, hands, agents, app (signing, wake word), toolchain
  pnpm jarhead live                   headless session in this terminal (ffmpeg mic, ffplay speaker)
  pnpm jarhead probe "<utterance>"    synthesize the utterance, run it through the whole stack, print the timeline
  pnpm jarhead agents                 list the agent sessions on this Mac (Claude Code, Codex, …)
  pnpm jarhead hands <op> [json]      talk to the native helper directly
  pnpm jarhead ledger [YYYY-MM-DD]    print a day's ledger
  pnpm jarhead ledger trash <day> [--shots|--both]   move a day's ledger file (its screenshots with --shots, both with --both) to ~/.jarhead/trash, through the daemon.
                                      Nothing is deleted; today, the open session's day and any day of a pinned or open conversation stay, and the answer says why
  pnpm jarhead ledger restore <day>   move a day back from the Trash
  pnpm jarhead ledger sweep           run the retention sweep now (Settings ledgerRetentionDays / shotsRetentionDays, 0 = never; the daemon logs what it would move first)
  pnpm jarhead ledger search "<words>" [--limit N]   what was heard and said, and the delegations' requests and summaries, over the live days, newest first (50 by default, 200 at most)
  pnpm jarhead status                 talk to a running daemon (jarheadd or the app) and print its state (--permissions: every grant as a row; workers: the second hands at work)
  pnpm jarhead say "<text>"           send typed text to the running daemon as if spoken
  pnpm jarhead cmd <go|pause|stop|interrupt|wake|resume|mute|unmute|agent.refresh>   send a command to the running daemon
  pnpm jarhead cmd sleep [cause]      go to sleep: return to the notch and close the session (cause: said|idle|pause-decayed|brain-changed|dock|command|stop|shutdown; default command)
  pnpm jarhead cmd worker.stop <id>   stop one worker (its id from \`jarhead status\`); the others and the session carry on
  pnpm jarhead dock [--fix] [--json]  one Jarhead: the Dock tiles and LaunchServices records for /Applications/Jarhead.app, read-only.
                                      --fix removes Jarhead's recent tiles, rebuilds the pin, unregisters stale bundle paths (the Trash's contents are not touched)
                                      and restarts the Dock only when it changed something. The daemon reads the Dock itself 20 s after it starts
                                      (never lsregister); two tiles are the \`dock\` problem on \`jarhead status\` and in the Console, whose Fix the Dock
                                      button runs the same Dock repair
  pnpm jarhead bench                  time the tool path: round trips, quick screenshot, delegation → first action, reflex, the ear's 250 ms path, stop (no API spend)
  pnpm jarhead bench --brain          the five representative commands on the REAL brain (Codex here) with a stand-in Live and canned hands:
                                      delegation → first thinking / first tool / first action / done, model steps, tool calls, rollovers,
                                      bootstrap calls (docs/LATENCY.md). Nothing on the Mac is touched; the turns cost Kevin's ChatGPT plan.

flags
  --speak        (probe) also play the voice through ffplay
  --timeout N    (probe) seconds to wait after the utterance (default 25)
  --runs N       (bench) samples per metric (default 5); (bench --brain) runs per command on the brain path (default 2)
  --codex        (bench) drive the real Codex brain for the delegation runs (a couple of tiny turns on Kevin's login)
  --fake-hands   (bench) answer the helper's requests in-process instead of the Swift helper
  --no-gate      (bench) do not exit non-zero when the ear's p95 to dispatch is over 250 ms with the real helper
  --effort E     (bench --brain) run the brain at effort low|medium|high|xhigh|max (default: the configured effort) — one flag for an A/B
  --no-reflex    (bench --brain) skip the reflexes-on phase: brain path only
  --allow-api-spend  (bench --brain) run even when Codex is not signed in — the auto brain then costs REAL API dollars; off by default the bench refuses
  --only a,b     (bench --brain) restrict to these command ids (wiki-search, open-safari, whats-on-screen, click-search-type, scroll-down)
  --out FILE     (bench --brain) also write the JSON report to FILE
  --json         (bench) print the table as JSON; (bench --brain) print the whole report as JSON
  --shots / --both   (ledger trash) move the day's screenshots instead of / as well as its ledger file
  --limit N      (ledger search) how many hits (default 50, at most 200)
  --debug        verbose logs
`;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--timeout", "--runs", "--effort", "--out", "--only", "--limit"]);
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

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `jarhead ledger …`: a day to print (no daemon needed), or one of the cleanup verbs
 * over the daemon socket — the daemon owns the ledger and the Trash, and its toasts
 * say what moved and why anything stayed. Nothing here deletes anything.
 */
async function ledgerCommand(rest: string[]): Promise<void> {
  const [verb, ...args] = rest;
  if (verb === undefined || DAY.test(verb)) return ledger(verb);
  switch (verb) {
    case "trash": {
      const day = args[0];
      if (!day || !DAY.test(day)) throw new Error("usage: jarhead ledger trash <YYYY-MM-DD> [--shots|--both]");
      await sendCommand({ type: "ledger.trash-day", day, what: flags.has("--both") ? "both" : flags.has("--shots") ? "shots" : "ledger" }, 800);
      return;
    }
    case "restore": {
      const day = args[0];
      if (!day || !DAY.test(day)) throw new Error("usage: jarhead ledger restore <YYYY-MM-DD>");
      await sendCommand({ type: "ledger.restore-day", day }, 800);
      return;
    }
    case "sweep":
      await sendCommand({ type: "ledger.sweep" }, 2000);
      return;
    case "search": {
      const query = args.join(" ").trim();
      if (!query) throw new Error('usage: jarhead ledger search "<words>" [--limit N]');
      await search(query, Math.max(1, Math.min(200, Number(flagValue("limit") ?? 50) || 50)));
      return;
    }
    default:
      throw new Error(`unknown ledger verb: ${verb} — a day (YYYY-MM-DD), or trash | restore | sweep | search`);
  }
}

interface Hit {
  sessionId: string;
  chainId: string;
  /** active | archived | trashed — the conversation the hit sits in (absent from a daemon before the field). */
  state?: string;
  at: number;
  kind: string;
  text: string;
}

/** `ledger.search` over the socket; one line per hit, newest first. */
async function search(query: string, limit: number): Promise<void> {
  const client = await daemon();
  const id = `cli_${process.pid}_${Date.now()}`;
  let hits: Hit[];
  try {
    hits = await new Promise<Hit[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the daemon did not answer the search within 5 s")), 5000);
      client.on("message", (m) => {
        if (m.type !== "ledger.hits" || m.id !== id) return;
        clearTimeout(timer);
        resolve(m.hits as Hit[]);
      });
      client.sendJson({ type: "ledger.search", id, query, limit });
    });
  } finally {
    client.close();
  }
  if (hits.length === 0) {
    console.log(`\n  nothing for "${query}"\n`);
    return;
  }
  console.log("");
  for (const h of hits) {
    const d = new Date(h.at);
    const when = `${Ledger.dayFor(h.at)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    // A hit in a conversation the rail hides says so, so the line is not mistaken for a live one.
    const mark = h.state === "trashed" || h.state === "archived" ? ` (${h.state})` : "";
    console.log(`  ${when}  ${h.kind.padEnd(7)} ${h.sessionId.padEnd(16)} ${h.text.length > 120 ? `${h.text.slice(0, 119)}…` : h.text}${mark}`);
  }
  console.log(`\n  ${hits.length} hit${hits.length === 1 ? "" : "s"}${hits.length >= limit ? ` · limit ${limit} (--limit N for more)` : ""}\n`);
}

/** "129 MB", "640 KB". */
function human(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(bytes >= 10 * 1_048_576 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Connect to the running daemon; exits with a hint when none is up. */
async function daemon(): Promise<DaemonClient> {
  const cfg = readConfig();
  const client = new DaemonClient(cfg.socketPath);
  // The client re-emits socket errors; without a listener a refused connect is an unhandled 'error' event and a stack, not the hint below.
  client.on("error", () => undefined);
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
  const s = snap as { phase: string; session?: { id: string; usageSeconds: number }; transcript: { speaker: string; text: string }[]; delegations: unknown[]; agents: unknown[]; workers?: Worker[]; problems: string[]; problemsTyped?: Problem[]; brainReady: boolean; handsReady: boolean; permissions?: { microphone: string; screenRecording: string; accessibility: string; all?: PermissionInfo[] }; trash?: { path: string; days: number; bytes: number }; hiddenAgents?: string[] };
  console.log(`\n  phase      ${s.phase}`);
  console.log(`  session    ${s.session ? `${s.session.id} · ${Math.round(s.session.usageSeconds)}s billed` : "none"}`);
  console.log(`  brain      ${s.brainReady ? "ready" : "not ready"}   hands ${s.handsReady ? "ready" : "not ready"}`);
  // The app's read of every grant (TCC keys them on Jarhead.app); without the app, the four the daemon's helper reads.
  const perms = s.permissions;
  if (perms?.all?.length) console.log(`  permissions  ${summarizePermissions(perms.all)}`);
  else if (perms) console.log(`  permissions  mic ${perms.microphone} · screen recording ${perms.screenRecording} · accessibility ${perms.accessibility} (an older daemon: no list)`);
  if (flags.has("--permissions") && perms?.all) for (const p of perms.all) console.log(`    ${p.grant === "granted" ? "✔" : p.grant === "denied" ? "✘" : "?"} ${p.label.padEnd(20)} ${p.grant.padEnd(8)} ${p.ask === "settings" ? "System Settings" : p.ask === "perApp" ? "per app" : "prompt"}${p.required ? " · required" : ""}${p.detail ? ` · ${p.detail}` : ""}`);
  if (levels) console.log(`  levels     mic ${levels.input.toFixed(3)}   speaker ${levels.output.toFixed(3)}`);
  console.log(`  agents     ${s.agents.length}${s.hiddenAgents?.length ? ` (${s.hiddenAgents.length} hidden)` : ""}   delegations ${s.delegations.length}   utterances ${s.transcript.length}`);
  // Workers are the brain's second hands (not agents: those are Kevin's coding sessions); running ones and those finished within the linger window.
  const workers = s.workers ?? [];
  console.log(`  workers    ${workers.length}${workers.length ? ` (${workers.filter((w) => !["done", "failed", "cancelled"].includes(w.status)).length} running)` : ""}`);
  for (const w of workers) console.log(`    ${w.status === "done" ? "✔" : w.status === "failed" ? "✘" : w.status === "cancelled" ? "–" : "⟳"} ${w.name.padEnd(16)} ${w.status.padEnd(22)} ${w.lane.padEnd(10)} ${w.steps} step${w.steps === 1 ? "" : "s"} · ${w.id}${w.detail ? ` · ${w.detail}` : ""}`);
  // The Trash: whole day files Jarhead moved out of the way; emptying it is Kevin's, in Finder.
  if (s.trash) console.log(`  trash      ${s.trash.days === 0 ? "empty" : `${s.trash.days} ${s.trash.days === 1 ? "day" : "days"} · ${human(s.trash.bytes)}`} · ${s.trash.path}`);
  for (const t of s.transcript.slice(-6)) console.log(`    ${t.speaker === "kevin" ? "you    " : "jarhead"}: ${t.text}`);
  // Each line with its kind and the one thing to press for it (the Console's button; `dock` → Fix the Dock = `pnpm jarhead dock --fix`).
  const typed = s.problemsTyped ?? [];
  const problemLine = (text: string): string => {
    const p = typed.find((t) => t.text === text);
    return `    - ${text}${p ? ` (${p.kind}${p.remedy ? ` · ${p.remedy.label}` : ""})` : ""}`;
  };
  if (s.problems.length) console.log(`  problems\n${s.problems.map(problemLine).join("\n")}`);
  console.log("");
}

/** Every SleepCause, checked against the protocol's union so a new cause cannot go unlisted here. */
const SLEEP_CAUSES: readonly SleepCause[] = Object.keys({ said: 0, idle: 0, "pause-decayed": 0, "brain-changed": 0, dock: 0, command: 0, stop: 0, shutdown: 0 } satisfies Record<SleepCause, 0>) as SleepCause[];

/** The hygiene report for --json without the parsed plist trees (a Dock document is thousands of nodes). */
function jsonReport(r: HygieneReport): unknown {
  const audit = (a: DockAudit | undefined): unknown => (a ? { jarhead: a.jarhead, pinned: a.pinned, recent: a.recent, changes: a.changes, modCount: a.modCount } : undefined);
  return { ...r, dock: { ...r.dock, before: audit(r.dock.before), after: audit(r.dock.after) } };
}

/** Send one command; stay `listenMs` for the toasts it raises (a move says what moved and why anything stayed). */
async function sendCommand(cmd: Record<string, unknown>, listenMs = 150): Promise<void> {
  const client = await daemon();
  const toasts: string[] = [];
  client.on("message", (m) => {
    if (m.type === "toast") toasts.push(`${m.tone === "info" ? "·" : "!"} ${m.text}`);
  });
  client.sendJson({ type: "command", command: cmd });
  await new Promise((r) => setTimeout(r, listenMs));
  client.close();
  console.log(`  sent ${JSON.stringify(cmd)}`);
  for (const t of toasts) console.log(`  ${t}`);
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
      await ledgerCommand(rest);
      break;
    case "status":
      await status();
      break;
    case "say":
      if (rest.length === 0) throw new Error('usage: jarhead say "hello there"');
      await sendCommand({ type: "say-text", text: rest.join(" ") });
      break;
    case "bench":
      if (flags.has("--brain")) {
        // The representative-command benchmark on the real brain (bench-brain.ts): its own options, its own report.
        const effort = flagValue("effort");
        if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`--effort must be low, medium, high, xhigh or max (got ${effort})`);
        const only = flagValue("only")?.split(",").map((s) => s.trim()).filter(Boolean);
        if (!(await benchBrain({ runs: Math.max(1, Number(flagValue("runs") ?? 2) || 2), ...(effort ? { effort: effort as Effort } : {}), noReflex: flags.has("--no-reflex"), allowApiSpend: flags.has("--allow-api-spend"), json: flags.has("--json"), ...(flagValue("out") ? { out: flagValue("out") } : {}), ...(only?.length ? { only } : {}) })).ok) process.exit(1);
        break;
      }
      if (!(await bench({ runs: Math.max(1, Number(flagValue("runs") ?? 5) || 5), codex: flags.has("--codex"), fakeHands: flags.has("--fake-hands"), json: flags.has("--json"), gate: !flags.has("--no-gate") })).ok) process.exit(1);
      break;
    case "cmd": {
      const sub = rest[0];
      const arg = rest[1];
      if (sub === "sleep") {
        // A cause names why in the `sleep` ledger row; the app's dropIntoDock sends "dock", a bare command is "command".
        if (arg !== undefined && !SLEEP_CAUSES.includes(arg as SleepCause)) throw new Error(`usage: jarhead cmd sleep [${SLEEP_CAUSES.join("|")}]`);
        await sendCommand(arg ? { type: "sleep", cause: arg } : { type: "sleep" }, 800);
        break;
      }
      if (sub === "worker.stop") {
        if (!arg) throw new Error("usage: jarhead cmd worker.stop <workerId>  (the id is on `jarhead status`; the other workers and the session carry on)");
        await sendCommand({ type: "worker.stop", workerId: arg }, 800);
        break;
      }
      if (!sub || !["go", "pause", "stop", "interrupt", "wake", "resume", "mute", "unmute", "agent.refresh"].includes(sub)) throw new Error("usage: jarhead cmd <go|pause|stop|interrupt|wake|sleep [cause]|resume|mute|unmute|agent.refresh|worker.stop <id>>  (stop closes the voice session — the meter stops; interrupt cancels the work but keeps listening)");
      await sendCommand({ type: sub });
      break;
    }
    case "dock": {
      // Read-only unless --fix; talks to no daemon and sends no EngineCommand.
      const report = runHygiene({ mode: flags.has("--fix") ? "fix" : "audit", ...(flags.has("--json") ? {} : { log: (line) => console.log(`  ${line}`) }) });
      if (flags.has("--json")) console.log(JSON.stringify(jsonReport(report), null, 2));
      else if (report.dock.before && report.dock.before.changes.length > 0 && !report.dock.imported) console.log(`  run \`pnpm jarhead dock --fix\` to repair it (restarts the Dock once)`);
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
