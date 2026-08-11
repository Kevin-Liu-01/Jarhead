#!/usr/bin/env tsx
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readConfig } from "@jarvis/core";
import { qmdAvailable, topStories, useCacheDir } from "@jarvis/answers";
import {
  listInputDevices,
  MicPermissionError,
  OpenAiTranscriber,
  recordUntilSilence,
  DEFAULT_MIC,
  prewarm,
} from "@jarvis/voice";
import {
  createAutomation,
  isConsent,
  isRefusal,
  parseSchedule,
  readRegistry,
  registryPathFor,
  shouldOffer,
} from "@jarvis/automations";
import { makeDeps, runTurn } from "./turn.ts";
import { Timeline } from "./timeline.ts";
import { LineReader } from "./lines.ts";

const HELP = `
jarvis — local voice assistant

  pnpm jarvis                 talk to it (mic; needs the Microphone grant)
  pnpm jarvis text            type instead of talking — same pipeline, no mic
  pnpm jarvis ask "..."       one-shot question, spoken aloud
  pnpm jarvis voices          list ElevenLabs voices and pick one
  pnpm jarvis devices         list microphones
  pnpm jarvis warm            pre-fetch the Hacker News cache
  pnpm jarvis automations     list automations you created by voice
  pnpm jarvis bench [rounds]  measure per-stage latency across the answer types

flags
  --silent      skip audio; print the answer only (useful when out of TTS quota)
  --quiet       hide the latency timeline
  --audio       include the TTS leg in bench (costs ElevenLabs characters)
`;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function pickVoice(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.elevenLabsApiKey) {
    console.error("ELEVENLABS_API_KEY is not set.");
    process.exit(1);
  }

  const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=30", {
    headers: { "xi-api-key": cfg.elevenLabsApiKey },
  });
  if (!res.ok) {
    console.error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }

  const body = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; labels?: Record<string, string> }> };
  const voices = body.voices ?? [];

  console.log(`\n  ${voices.length} voices available\n`);
  for (const v of voices) {
    const marker = v.voice_id === cfg.elevenLabsVoiceId ? " ← current" : "";
    console.log(`    ${v.voice_id}  ${v.name}${marker}`);
  }
  console.log(`\n  Set one in .env.local:  ELEVENLABS_VOICE_ID=<id>\n`);
}

async function showDevices(): Promise<void> {
  const devices = await listInputDevices();
  console.log("\n  audio input devices\n");
  for (const d of devices) {
    console.log(`    [${d.index}] ${d.name}${d.index === DEFAULT_MIC.device ? "  ← default" : ""}`);
  }
  console.log("");
}

/** Speak a fixed line — no model call. Used for offers and confirmations. */
async function speak(deps: ReturnType<typeof makeDeps>, text: string): Promise<void> {
  console.log(`\n  jarvis: ${text}`);
  if (flag("silent")) return;
  try {
    const speaker = deps.makeSpeaker();
    speaker.say(text);
    await speaker.idle();
  } catch {
    // Losing the voice should never lose the turn.
  }
}

/**
 * The "make it recurring" loop, Loop D from DECISION.md.
 *
 * Consent has to be spoken and explicit. Anything unrecognized is treated as
 * no — the wiki's governance rules are clear that a standing or implied yes is
 * not approval.
 */
async function maybeOfferRecurring(
  outcome: Awaited<ReturnType<typeof runTurn>>,
  deps: ReturnType<typeof makeDeps>,
  ask: (q: string) => Promise<string | undefined>,
  offered: Set<string>,
): Promise<void> {
  if (!shouldOffer(outcome.intent, offered)) return;
  offered.add(outcome.intent);

  await speak(deps, "want me to make that a recurring thing?");
  const raw = await ask("  you: ");
  if (raw === undefined) return;
  const reply = raw.trim();

  if (!isConsent(reply)) {
    if (isRefusal(reply)) await speak(deps, "fine, leaving it.");
    return;
  }

  const schedule = parseSchedule(reply) ?? "daily";
  if (/every hour|hourly|every minute/i.test(reply)) {
    await speak(deps, "hourly isn't in the schedule vocabulary. best I can do is every four hours.");
  }

  try {
    const created = createAutomation({
      intent: outcome.transcript,
      schedule,
      stateDir: deps.config.stateDir,
      spokenConsent: reply,
      now: new Date(),
    });
    await speak(deps, `done. ${created.slug.replace(/-/g, " ")}, running ${created.entry.schedule}.`);
    console.log(`         ${created.markdownPath}`);
    console.log(`         ${created.registryPath}  (validated against the wiki contract)\n`);
  } catch (e) {
    await speak(deps, "that failed validation, so I didn't save it.");
    console.error(`  ${(e as Error).message}\n`);
  }
}

function listAutomations(): void {
  const cfg = readConfig();
  const registry = readRegistry(cfg.stateDir);
  if (registry.entries.length === 0) {
    console.log(`\n  no automations yet — ask jarvis something, then say "go for it".\n`);
    return;
  }
  console.log(`\n  ${registry.entries.length} automation(s)  ·  ${registryPathFor(cfg.stateDir)}\n`);
  for (const e of registry.entries) {
    console.log(`    ${e.enabled ? "on " : "off"}  ${e.schedule.padEnd(14)}  ${e.slug}`);
    console.log(`         "${String(e.input["intent"] ?? "")}"`);
  }
  console.log("");
}

function printOutcome(outcome: Awaited<ReturnType<typeof runTurn>>, quiet: boolean): void {
  console.log(`\n  jarvis: ${outcome.answer.trim()}\n`);
  if (!quiet) {
    console.log(outcome.timeline.render(outcome.firstAudioMs));
    console.log("");
  }
}

async function oneShot(question: string): Promise<void> {
  const silent = flag("silent");
  const cfg = readConfig();
  // Fire and forget — the TLS handshake happens while the model is generating,
  // so it is off the critical path entirely.
  if (!silent && cfg.elevenLabsApiKey) void prewarm(cfg.elevenLabsApiKey);

  const deps = makeDeps(
    silent
      ? {
          makeSpeaker: () =>
            ({
              say: () => undefined,
              idle: async () => undefined,
              stop: () => undefined,
              spoken: [],
              firstAudioMs: undefined,
              firstAudioAt: undefined,
              charactersSpoken: 0,
            }) as never,
        }
      : {},
  );
  const outcome = await runTurn(question, deps);
  printOutcome(outcome, flag("quiet"));
}

async function textLoop(): Promise<void> {
  const deps = makeDeps();
  const rl = createInterface({ input: stdin, output: stdout });
  const lines = new LineReader(rl);

  const warmMs = deps.config.elevenLabsApiKey ? await prewarm(deps.config.elevenLabsApiKey) : 0;
  console.log(`\n  jarvis — text mode. Same pipeline, typed input. Ctrl-C to quit.`);
  console.log(`  (tts connection warmed in ${warmMs}ms)\n`);

  const offered = new Set<string>();

  for (;;) {
    const raw = await lines.next("  you: ");
    if (raw === undefined) break;
    const line = raw.trim();
    if (!line) continue;
    if (["exit", "quit", "bye"].includes(line.toLowerCase())) break;
    try {
      const outcome = await runTurn(line, deps);
      printOutcome(outcome, flag("quiet"));
      await maybeOfferRecurring(outcome, deps, (q) => lines.next(q), offered);
    } catch (e) {
      console.error(`  error: ${(e as Error).message}\n`);
    }
  }
  rl.close();
}

async function voiceLoop(): Promise<void> {
  const cfg = readConfig();
  if (!cfg.anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY is not set. Run `pnpm run doctor`.");
    process.exit(1);
  }

  const openAiKey = process.env["OPENAI_API_KEY"];
  if (!openAiKey) {
    console.error(
      "No STT available. M0 transcribes with OpenAI; set OPENAI_API_KEY, or use `pnpm jarvis text`.",
    );
    process.exit(1);
  }

  const deps = makeDeps({ transcriber: new OpenAiTranscriber(openAiKey) });
  const rl = createInterface({ input: stdin, output: stdout });
  const lines = new LineReader(rl);

  if (cfg.elevenLabsApiKey) await prewarm(cfg.elevenLabsApiKey);
  const offered = new Set<string>();
  console.log("\n  jarvis — press Enter to talk, then just stop talking. Ctrl-C to quit.\n");

  for (;;) {
    if ((await lines.next("  [enter to speak] ")) === undefined) break;

    const timeline = new Timeline();
    const { done } = recordUntilSilence(DEFAULT_MIC, () => timeline.mark("wake", "mic hot"));

    let recording;
    try {
      recording = await done;
    } catch (e) {
      if (e instanceof MicPermissionError) {
        console.error(`\n  ${e.message}\n`);
        break;
      }
      console.error(`  mic error: ${(e as Error).message}`);
      continue;
    }
    timeline.mark("endpoint", recording.endedBy);

    const transcription = await deps.transcriber.transcribe(recording.path);
    timeline.mark("stt", transcription.engine);

    if (!transcription.text) {
      console.log("  (heard nothing)\n");
      continue;
    }

    console.log(`  you: ${transcription.text}`);

    try {
      const outcome = await runTurn(transcription.text, deps, timeline);
      printOutcome(outcome, flag("quiet"));
      await maybeOfferRecurring(outcome, deps, (q) => lines.next(q), offered);
    } catch (e) {
      console.error(`  error: ${(e as Error).message}\n`);
    }
  }

  rl.close();
}

const BENCH_UTTERANCES = [
  "hey jarvis",
  "what's on hackernews",
  "what's my daily briefing today",
  "what do i know about the reticle design system",
  "why is the sky blue",
] as const;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/**
 * Turn the DECISION doc's budget table into evidence.
 *
 * That table is a stack of vendor best-cases. This measures the real thing on
 * real hardware. Runs silent by default — TTS is the expensive leg and the
 * numbers that vary most are route and time-to-first-token.
 */
async function bench(rounds: number, withAudio: boolean): Promise<void> {
  useCacheDir(readConfig().stateDir);
  const deps = makeDeps(
    withAudio
      ? {}
      : {
          makeSpeaker: () =>
            ({
              say: () => undefined,
              idle: async () => undefined,
              stop: () => undefined,
              spoken: [],
              firstAudioMs: undefined,
              firstAudioAt: undefined,
              charactersSpoken: 0,
            }) as never,
        },
  );

  const byStage = new Map<string, number[]>();
  const firstChunk: number[] = [];
  const firstAudio: number[] = [];
  let failures = 0;

  const total = rounds * BENCH_UTTERANCES.length;
  console.log(`\n  benchmarking ${total} turns (audio: ${withAudio ? "on" : "off"})\n`);

  for (let round = 0; round < rounds; round++) {
    for (const utterance of BENCH_UTTERANCES) {
      try {
        const outcome = await runTurn(utterance, deps);
        for (const m of outcome.timeline.marks) {
          const list = byStage.get(m.stage) ?? [];
          list.push(m.took);
          byStage.set(m.stage, list);
        }
        const fs = outcome.timeline.at("first_sentence");
        if (fs !== undefined) firstChunk.push(fs);
        if (outcome.firstAudioMs !== undefined) firstAudio.push(outcome.firstAudioMs);
        process.stdout.write(".");
      } catch (e) {
        failures++;
        process.stdout.write("x");
        if (failures === 1) console.error(`\n  first failure: ${(e as Error).message}`);
      }
    }
  }

  console.log("\n");
  const width = Math.max(...[...byStage.keys()].map((k) => k.length), 14);
  console.log(`    ${"stage".padEnd(width)}      n     p50     p95     max`);
  for (const [stage, values] of byStage) {
    const sorted = [...values].sort((a, b) => a - b);
    console.log(
      `    ${stage.padEnd(width)}  ${String(sorted.length).padStart(5)}  ` +
        `${String(percentile(sorted, 50)).padStart(5)}ms  ${String(percentile(sorted, 95)).padStart(5)}ms  ` +
        `${String(sorted[sorted.length - 1]).padStart(5)}ms`,
    );
  }

  for (const [label, values] of [
    ["→ first chunk ready", firstChunk],
    ["→ first audio", firstAudio],
  ] as const) {
    if (values.length === 0) continue;
    const sorted = [...values].sort((a, b) => a - b);
    console.log(
      `\n    ${label.padEnd(width)}  ${String(sorted.length).padStart(5)}  ` +
        `${String(percentile(sorted, 50)).padStart(5)}ms  ${String(percentile(sorted, 95)).padStart(5)}ms  ` +
        `${String(sorted[sorted.length - 1]).padStart(5)}ms`,
    );
  }

  if (failures > 0) console.log(`\n    ${failures} turn(s) failed`);
  console.log("");
}

async function warm(): Promise<void> {
  useCacheDir(readConfig().stateDir);
  const started = Date.now();
  const stories = await topStories({ count: 8, force: true });
  console.log(`\n  cached ${stories.length} HN stories in ${Date.now() - started}ms`);
  for (const s of stories.slice(0, 5)) console.log(`    ${String(s.score).padStart(4)}  ${s.title}`);
  console.log(`\n  qmd (wiki memory search): ${qmdAvailable() ? "available" : "NOT on PATH"}\n`);
}

const [command, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

switch (command) {
  case undefined:
    await voiceLoop();
    break;
  case "text":
    await textLoop();
    break;
  case "ask":
    if (rest.length === 0) {
      console.error('usage: pnpm jarvis ask "what is on hackernews"');
      process.exit(1);
    }
    await oneShot(rest.join(" "));
    break;
  case "voices":
    await pickVoice();
    break;
  case "devices":
    await showDevices();
    break;
  case "warm":
    await warm();
    break;
  case "automations":
    listAutomations();
    break;
  case "bench":
    await bench(Number(rest[0] ?? 3), flag("audio"));
    break;
  case "help":
  case "--help":
    console.log(HELP);
    break;
  default:
    console.error(`unknown command: ${command}`);
    console.log(HELP);
    process.exit(1);
}
