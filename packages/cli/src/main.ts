#!/usr/bin/env tsx
import { spawn, type ChildProcess } from "node:child_process";
import { Ledger, readConfig, setLogLevel } from "@jarhead/core";
import { AgentRegistry, defaultConnectors } from "@jarhead/agents";
import { NativeHandsProcess } from "@jarhead/hands";
import { Engine } from "@jarhead/engine";
import { DaemonClient, type ClientMessage } from "@jarhead/daemon";
import { type AgentInfo, type Delegation, type Effort, type EngineCommand, type EngineEvent, type MemoryItem, type MemoryKind, type MemoryState, type MemorySummary, type Permissions, type Problem, type SetupStatus, type SleepCause, type Snapshot, type Thread, type TranscriptItem, grantOf } from "@jarhead/protocol";
import { MEMORY_ID, agentsByStatus, agoWords, memoryLine, render, runChecks, summarizePermissions } from "./doctor.ts";
import { localStatusLine, runBrain, runModels, type BrainDaemon } from "./local-cli.ts";
import { runHygiene, type DockAudit, type HygieneReport } from "./install/index.ts";
import { bench } from "./bench.ts";
import { benchBrain } from "./bench-brain.ts";
import { ledgerSpeed, renderSpeed } from "./ledger-speed.ts";
import { reflexMisses, renderMisses } from "./reflex-miss.ts";
import { resolveThread, threadsLines } from "./threads-cli.ts";

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
  pnpm jarhead ledger --speed [--days N]   where the time went over the last N days (1): acting steps followed by a screenshot, results carrying the now: line,
                                      tool round trips by class (read-only target p95 ≤ 80 ms), generation gaps by what came before, first action, threads
  pnpm jarhead reflex-miss [--days N]  the short commands Kevin said that the grammar did not catch, grouped by head word (7 days) — the grammar grows from these
  pnpm jarhead memory [list] [--state live|forgotten|archived|merged|all] [--limit N]   what Jarhead durably knows about Kevin: one sentence per item, over the daemon (50 by default, 200 at most)
  pnpm jarhead memory search "<words>" [--limit N]   the items closest to the words (embeddings when a key is present, keywords without)
  pnpm jarhead memory forget <id>    hide an item from every prompt; it stays in Jarhead's own record under Forgotten. Nothing is deleted
  pnpm jarhead memory restore <id>   bring a forgotten or archived item back into use
  pnpm jarhead memory add "<text>" [--kind preference|fact|episode|procedure|contact|place]   remember one thing now, in Kevin's words (redacted and refused like anything extracted)
  pnpm jarhead memory run            read the closed conversations not read yet, now (it runs on its own at a quiet moment; never while a voice session is open)
  pnpm jarhead models [--json]          the models on this Mac's local server (Ollama / LM Studio / llama.cpp): id · size · ctx · tools/vision/thinking/embedding · fit · which the brain and memory use;
                                        cloud tags are listed dimmed and never offered. No daemon needed. Nothing is pulled: an empty list prints the \`ollama pull …\` line to run
  pnpm jarhead brain                    the brain setting, what runs now, and where words go (the four data-path rows)
  pnpm jarhead brain local [<model>] [--server URL]   pick a local model as the brain through the running daemon (memory follows); empty model = best fit; prints the status line when it lands
  pnpm jarhead brain <auto|codex|claude-code|anthropic-api|openai-responses|openai-compatible> [<model>] [--server URL]
  pnpm jarhead status                 talk to a running daemon (jarheadd or the app) and print its state (--permissions: every grant as a row; agents by status —
                                      working · idle · blocked · done · ended (no live process) · unknown (evidence missing) · offline; threads N (M live): the lines of work
                                      with name · status · lane · steps · id; memory: counts and the last learn)
  pnpm jarhead say "<text>"           send typed text to the running daemon as if spoken
  pnpm jarhead cmd <go|pause|resume|stop|interrupt|mute|unmute|agent.refresh>   send a command to the running daemon (go opens the session)
  pnpm jarhead cmd sleep [cause]      go to sleep: return to the notch and close the session (cause: said|idle|pause-decayed|brain-changed|dock|command|stop|shutdown; default command)
  pnpm jarhead cmd thread.stop <id|name>   stop one thread (its id or name from \`jarhead status\`; "main" parks the main turn); the others and the session carry on
  pnpm jarhead cmd thread.pause <id|name> | thread.resume <id|name>   hold one thread's brain turn and release its screen; run its continuation turn
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
  --observe off  (bench --brain) run with Settings.observe off: acting results without the now: line — the A/B for the observation lever
  --compare F    (bench --brain) print median deltas per command against a previous --out report
  --days N       (ledger --speed, reflex-miss) how many day files back, today included
  --no-reflex    (bench --brain) skip the reflexes-on phase: brain path only
  --allow-api-spend  (bench --brain) run even when Codex is not signed in — the auto brain then costs REAL API dollars; off by default the bench refuses
  --only a,b     (bench --brain) restrict to these command ids (wiki-search, open-safari, whats-on-screen, click-search-type, scroll-down)
  --out FILE     (bench --brain) also write the JSON report to FILE
  --json         (bench) print the table as JSON; (bench --brain) print the whole report as JSON
  --shots / --both   (ledger trash) move the day's screenshots instead of / as well as its ledger file
  --limit N      (ledger search, memory list/search) how many hits (default 50 / 50 / 30, at most 200)
  --state S      (memory list) live (default) | forgotten | archived | merged | all
  --kind K       (memory add) preference | fact | episode | procedure | contact | place (the store classifies when absent)
  --server URL   (models, brain) the local server's root instead of the three loopback ports (a second Ollama, a LAN box); (brain) pins it in Settings
  --debug        verbose logs
`;

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--timeout", "--runs", "--effort", "--out", "--only", "--limit", "--state", "--kind", "--days", "--compare", "--observe", "--server"]);
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
    if (problems.length) console.log(`  problems:\n    - ${problems.map((p) => p.text).join("\n    - ")}`);
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
  // `detail` carries no relative time any more; the hint says why a row reads as it does (archived, quiet, ended, unseen …).
  for (const a of list) console.log(`  ${a.id.padEnd(28)} ${a.status.padEnd(8)} ${a.name}${a.cwd ? `  (${a.cwd})` : ""}${a.hint ? `  [${a.hint}]` : ""}${a.detail ? `  — ${a.detail}` : ""}`);
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

/** Every MemoryKind / MemoryState, checked against the protocol's unions so a new one cannot go unlisted here. */
const MEMORY_KINDS: readonly MemoryKind[] = Object.keys({ preference: 0, fact: 0, episode: 0, procedure: 0, contact: 0, place: 0 } satisfies Record<MemoryKind, 0>) as MemoryKind[];
const MEMORY_STATES: readonly (MemoryState | "all")[] = Object.keys({ live: 0, forgotten: 0, merged: 0, archived: 0, all: 0 } satisfies Record<MemoryState | "all", 0>) as (MemoryState | "all")[];

/**
 * `jarhead memory …`: what Jarhead durably knows about Kevin, over the daemon (the
 * daemon owns the store). list/search are read frames; forget, restore, add and run
 * are EngineCommands whose toasts say what happened. Forget is a state Restore
 * undoes; nothing here deletes anything. A bad id or an unknown state/kind is
 * refused here, before any socket is touched.
 */
async function memoryCommand(rest: string[]): Promise<void> {
  const [verb, ...args] = rest;
  const limit = (dflt: number): number => Math.max(1, Math.min(200, Number(flagValue("limit") ?? dflt) || dflt));
  switch (verb) {
    case undefined:
    case "list": {
      const state = flagValue("state") ?? "live";
      if (!MEMORY_STATES.includes(state as MemoryState | "all")) throw new Error(`usage: jarhead memory list [--state ${MEMORY_STATES.join("|")}] [--limit N]`);
      await memoryList(state as MemoryState | "all", limit(50));
      return;
    }
    case "search": {
      const query = args.join(" ").trim();
      if (!query) throw new Error('usage: jarhead memory search "<words>" [--limit N]');
      await memorySearch(query, limit(30));
      return;
    }
    case "forget":
    case "restore": {
      const id = args[0];
      if (!id || !MEMORY_ID.test(id)) throw new Error(`usage: jarhead memory ${verb} <id>  (an id looks like m_…; \`jarhead memory list\` prints them${verb === "forget" ? "; forget hides the item, nothing is deleted" : ""})`);
      await sendCommand({ type: `memory.${verb}`, id }, 800);
      return;
    }
    case "add": {
      const text = args.join(" ").trim();
      if (!text) throw new Error('usage: jarhead memory add "<text>" [--kind preference|fact|episode|procedure|contact|place]');
      const kind = flagValue("kind");
      if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) throw new Error(`--kind must be one of ${MEMORY_KINDS.join(", ")} (got ${kind})`);
      await sendCommand({ type: "memory.add", text, ...(kind ? { kind } : {}) }, 800);
      return;
    }
    case "run":
      // An extraction run may call the extractor once (20 s cap, one retry): stay long enough to hear its toast.
      await sendCommand({ type: "memory.run" }, 3000);
      return;
    default:
      throw new Error(`unknown memory verb: ${verb} — list | search | forget | restore | add | run`);
  }
}

/** How long the CLI waits for `memory.items` before it says the daemon did not answer. */
const MEMORY_ITEMS_WAIT_MS = 5000;

/**
 * One `memory.list` / `memory.search` round trip over the daemon wire (`memory.list
 * {id, state?, limit?}` / `memory.search {id, query, limit?}` → `memory.items {id,
 * items}`; the items are MemoryItem[] without vectors). A daemon that does not answer
 * is named by the wait rather than hung on.
 */
async function memoryItems(frame: { type: "memory.list"; state: MemoryState | "all"; limit: number } | { type: "memory.search"; query: string; limit: number }): Promise<MemoryItem[]> {
  const client = await daemon();
  const id = `cli_${process.pid}_${Date.now()}`;
  try {
    return await new Promise<MemoryItem[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the daemon did not answer within ${MEMORY_ITEMS_WAIT_MS / 1000} s (a daemon from before the memory module has no memory frames)`)), MEMORY_ITEMS_WAIT_MS);
      client.on("message", (m) => {
        if (m.type !== "memory.items" || m.id !== id) return;
        clearTimeout(timer);
        resolve(m.items as MemoryItem[]);
      });
      const message: ClientMessage = { ...frame, id };
      client.sendJson(message);
    });
  } finally {
    client.close();
  }
}

function printMemoryItems(items: readonly MemoryItem[], empty: string, tail: string): void {
  if (items.length === 0) {
    console.log(`\n  ${empty}\n`);
    return;
  }
  console.log("");
  for (const it of items) {
    // The state is shown only when it is not the default (a forgotten item in an --state all listing).
    const state = it.state === "live" ? "" : ` (${it.state})`;
    console.log(`  ${it.id.padEnd(22)} ${it.kind.padEnd(10)} ${it.text.length > 110 ? `${it.text.slice(0, 109)}…` : it.text}${state}  · seen ${it.seenCount}× · ${agoWords(it.lastSeenAt)}`);
  }
  console.log(`\n  ${items.length} item${items.length === 1 ? "" : "s"}${tail}\n`);
}

async function memoryList(state: MemoryState | "all", limit: number): Promise<void> {
  const items = await memoryItems({ type: "memory.list", state, limit });
  printMemoryItems(items, state === "live" ? "nothing remembered yet — Jarhead learns after a conversation closes" : `nothing under ${state}`, `${items.length >= limit ? ` · limit ${limit} (--limit N for more)` : ""} · forget <id> hides one (nothing is deleted); restore <id> brings it back`);
}

async function memorySearch(query: string, limit: number): Promise<void> {
  const items = await memoryItems({ type: "memory.search", query, limit });
  printMemoryItems(items, `nothing close to "${query}"`, items.length >= limit ? ` · limit ${limit} (--limit N for more)` : "");
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
  const s = snap as { phase: string; session?: { id: string; usageSeconds: number; voice?: string; accent?: string }; transcript: { speaker: string; text: string }[]; delegations: unknown[]; agents: Pick<AgentInfo, "status">[]; threads: Thread[]; memory?: MemorySummary; problems: Problem[]; brainReady: boolean; handsReady: boolean; permissions: Permissions; trash?: { path: string; days: number; bytes: number }; hiddenAgents?: string[]; setup?: SetupStatus; settings?: { brainModel?: string } };
  console.log(`\n  phase      ${s.phase}`);
  // The voice and accent are the session's own (picked at connect; a change is heard at the next wake).
  console.log(`  session    ${s.session ? `${s.session.id} · ${Math.round(s.session.usageSeconds)}s billed${s.session.voice ? ` · ${s.session.voice} · English${s.session.accent && s.session.accent !== "none" ? ` (${s.session.accent})` : ""}` : ""}` : "none"}`);
  console.log(`  brain      ${s.brainReady ? "ready" : "not ready"}   hands ${s.handsReady ? "ready" : "not ready"}`);
  // The local model server, whatever the brain kind: what is running on this Mac and which model the brain would use.
  console.log(localStatusLine(s.setup?.local, s.settings?.brainModel ?? ""));
  // One row per grant, read by the app (TCC keys them on Jarhead.app) or, without the app, by the daemon's helper for the four it can read.
  // The headline names the three the voice and the hands stand on; the summary counts the rest.
  const perms = s.permissions;
  console.log(`  permissions  mic ${grantOf(perms, "microphone")} · screen recording ${grantOf(perms, "screenRecording")} · accessibility ${grantOf(perms, "accessibility")} · ${summarizePermissions(perms.all)}`);
  if (flags.has("--permissions")) for (const p of perms.all) console.log(`    ${p.grant === "granted" ? "✔" : p.grant === "denied" ? "✘" : "?"} ${p.label.padEnd(20)} ${p.grant.padEnd(8)} ${p.ask === "settings" ? "System Settings" : p.ask === "perApp" ? "per app" : "prompt"}${p.required ? " · required" : ""}${p.detail ? ` · ${p.detail}` : ""}`);
  if (levels) console.log(`  levels     mic ${levels.input.toFixed(3)}   speaker ${levels.output.toFixed(3)}`);
  // Agents by status: `ended` is a session with no live process (however old); `unknown` means the process evidence was missing, not "old".
  const byStatus = agentsByStatus(s.agents);
  console.log(`  agents     ${s.agents.length}${byStatus ? ` (${byStatus})` : ""}${s.hiddenAgents?.length ? ` (${s.hiddenAgents.length} hidden)` : ""}   delegations ${s.delegations.length}   utterances ${s.transcript.length}`);
  console.log(`  memory     ${memoryLine(s.memory)}`);
  // Threads are the lines of work (not agents: those are Kevin's coding sessions): main and the spawned ones, live and those finished within the linger window.
  for (const line of threadsLines(s.threads)) console.log(line);
  // The Trash: whole day files Jarhead moved out of the way; emptying it is Kevin's, in Finder.
  if (s.trash) console.log(`  trash      ${s.trash.days === 0 ? "empty" : `${s.trash.days} ${s.trash.days === 1 ? "day" : "days"} · ${human(s.trash.bytes)}`} · ${s.trash.path}`);
  for (const t of s.transcript.slice(-6)) console.log(`    ${t.speaker === "kevin" ? "you    " : "jarhead"}: ${t.text}`);
  // Each line with its kind and the one thing to press for it (the Console's button; `dock` → Fix the Dock = `pnpm jarhead dock --fix`).
  const problemLine = (p: Problem): string => `    - ${p.text} (${p.kind}${p.remedy ? ` · ${p.remedy.label}` : ""})`;
  if (s.problems.length) console.log(`  problems\n${s.problems.map(problemLine).join("\n")}`);
  console.log("");
}

/** One snapshot from the running daemon, or an error when none answers within `waitMs`. */
async function readSnapshot(waitMs = 1500): Promise<Record<string, unknown>> {
  const client = await daemon();
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the daemon sent no snapshot")), waitMs);
      client.on("message", (m) => {
        if (m.type !== "snapshot") return;
        clearTimeout(timer);
        resolve(m.snapshot as Record<string, unknown>);
      });
    });
  } finally {
    client.close();
  }
}

/**
 * `thread.stop|pause|resume <id|name>`: a name is looked up in the daemon's thread table
 * (case-insensitive, live first; `resolveThread`), an id is sent as it is. "main" is the
 * voice's own thread — stopping it parks the main turn and leaves the spawned threads alone.
 */
async function threadCommand(sub: "thread.stop" | "thread.pause" | "thread.resume", arg: string | undefined): Promise<void> {
  if (!arg) throw new Error(`usage: jarhead cmd ${sub} <threadId|name>  (both are on \`jarhead status\`; "main" is the voice's thread)`);
  const snap = await readSnapshot();
  const { threadId, target } = resolveThread((snap["threads"] as Thread[] | undefined) ?? [], arg);
  if (target) console.log(`  ${target.name} · ${target.status} · ${threadId}`);
  await sendCommand({ type: sub, threadId }, 800);
}

/** Every SleepCause, checked against the protocol's union so a new cause cannot go unlisted here. */
const SLEEP_CAUSES: readonly SleepCause[] = Object.keys({ said: 0, idle: 0, "pause-decayed": 0, "brain-changed": 0, dock: 0, command: 0, stop: 0, shutdown: 0 } satisfies Record<SleepCause, 0>) as SleepCause[];

/** The hygiene report for --json without the parsed plist trees (a Dock document is thousands of nodes). */
function jsonReport(r: HygieneReport): unknown {
  const audit = (a: DockAudit | undefined): unknown => (a ? { jarhead: a.jarhead, pinned: a.pinned, recent: a.recent, changes: a.changes, modCount: a.modCount } : undefined);
  return { ...r, dock: { ...r.dock, before: audit(r.dock.before), after: audit(r.dock.after) } };
}

/**
 * The daemon as `jarhead brain` sees it (local-cli.ts `BrainDaemon`): one snapshot, or a command
 * followed by the snapshots until the pick has landed. The daemon owns settings.json; nothing here
 * writes it.
 */
async function brainDaemon(): Promise<BrainDaemon> {
  const client = await daemon();
  const snapshots: Snapshot[] = [];
  const waiters = new Set<(s: Snapshot) => void>();
  client.on("message", (m) => {
    if (m.type !== "snapshot") return;
    const snap = m.snapshot as Snapshot;
    snapshots.push(snap);
    for (const w of waiters) w(snap);
  });
  const nextMatching = (until: (s: Snapshot) => boolean, waitMs: number): Promise<Snapshot | undefined> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(w);
        resolve(undefined);
      }, waitMs);
      const w = (s: Snapshot): void => {
        if (!until(s)) return;
        clearTimeout(timer);
        waiters.delete(w);
        resolve(s);
      };
      waiters.add(w);
    });
  return {
    snapshot: async () => {
      try {
        const got = snapshots.at(-1) ?? (await nextMatching(() => true, 1500));
        if (!got) throw new Error("the daemon sent no snapshot");
        return got;
      } finally {
        client.close();
      }
    },
    command: async (cmd: EngineCommand, until, waitMs) => {
      try {
        // Only snapshots after the command count: the one the connect answered with shows the old setting.
        const pending = nextMatching(until, waitMs);
        client.sendJson({ type: "command", command: cmd });
        return await pending;
      } finally {
        client.close();
      }
    },
  };
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
      if (flags.has("--speed")) {
        // The day files are read here, no daemon needed (the Engine's Ledger opens the state dir).
        const days = Math.max(1, Number(flagValue("days") ?? 1) || 1);
        for (const line of renderSpeed(ledgerSpeed(new Engine().ledger, days))) console.log(line);
        break;
      }
      await ledgerCommand(rest);
      break;
    case "reflex-miss": {
      const days = Math.max(1, Number(flagValue("days") ?? 7) || 7);
      const { days: picked, groups } = reflexMisses(new Engine().ledger, days);
      for (const line of renderMisses(picked, groups)) console.log(line);
      break;
    }
    case "memory":
      await memoryCommand(rest);
      break;
    case "models":
      // Read directly from the server (no daemon): nothing is pulled, loaded or unloaded.
      await runModels({ json: flags.has("--json"), server: flagValue("server"), out: (line) => console.log(line) });
      break;
    case "brain":
      await runBrain(rest, flagValue("server"), brainDaemon, (line) => console.log(line));
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
        const observe = flagValue("observe");
        if (observe !== undefined && !["on", "off"].includes(observe)) throw new Error(`--observe must be on or off (got ${observe})`);
        if (!(await benchBrain({ runs: Math.max(1, Number(flagValue("runs") ?? 2) || 2), ...(effort ? { effort: effort as Effort } : {}), noReflex: flags.has("--no-reflex"), allowApiSpend: flags.has("--allow-api-spend"), json: flags.has("--json"), ...(flagValue("out") ? { out: flagValue("out") } : {}), ...(only?.length ? { only } : {}), ...(observe ? { observe: observe === "on" } : {}), ...(flagValue("compare") ? { compare: flagValue("compare") } : {}) })).ok) process.exit(1);
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
      if (sub === "thread.stop" || sub === "thread.pause" || sub === "thread.resume") {
        await threadCommand(sub, arg);
        break;
      }
      if (!sub || !["go", "pause", "resume", "stop", "interrupt", "mute", "unmute", "agent.refresh"].includes(sub)) throw new Error("usage: jarhead cmd <go|pause|resume|stop|interrupt|sleep [cause]|mute|unmute|agent.refresh|thread.stop <id|name>|thread.pause <id|name>|thread.resume <id|name>>  (stop closes the voice session — the meter stops; interrupt cancels the work but keeps listening)");
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
