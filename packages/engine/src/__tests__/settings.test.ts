import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUDIO, DEFAULT_AUTOMATIONS, DEFAULT_SETTINGS, SETTINGS_KEYS, type AudioState } from "@jarhead/protocol";
import { readConfig } from "@jarhead/core";
import { Engine } from "../engine.ts";
import { FakeMemoryService } from "./world.ts";

/** A bare engine over a temp state dir; the memory module is a fake so nothing loads by name or touches a store. */
const bare = (stateDir: string): Engine => new Engine({ config: { ...readConfig(), stateDir, socketPath: join(stateDir, "j.sock") }, connectors: [], memory: { service: new FakeMemoryService() } });

test("settings patches: null clears optional fields, required fields keep their value", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-"));
  const engine = bare(stateDir);
  engine.updateSettings({ micDeviceId: "AppleUSBAudioEngine:123", voice: "marin" });
  assert.equal(engine.snapshot().settings.micDeviceId, "AppleUSBAudioEngine:123");
  assert.equal(engine.snapshot().settings.voice, "marin");

  // The native settings UI sends `null` for "system default".
  engine.updateSettings({ micDeviceId: null, voice: null });
  assert.equal(engine.snapshot().settings.micDeviceId, undefined);
  assert.equal(engine.snapshot().settings.voice, "marin");

  const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal("micDeviceId" in saved, false);
  assert.equal(saved["idleSleepMinutes"], DEFAULT_SETTINGS.idleSleepMinutes);

  // The wake word block merges field-wise, so a partial patch keeps the other defaults.
  engine.updateSettings({ wake: { enabled: true, phrases: ["computer"], auth: "touch-id" } });
  assert.deepEqual(engine.snapshot().settings.wake, { enabled: true, phrases: ["computer"], auth: "touch-id" });
  engine.updateSettings({ wake: { auth: "none" } as never });
  assert.deepEqual(engine.snapshot().settings.wake, { ...DEFAULT_SETTINGS.wake, auth: "none" });
});

test("settings from an older settings.json still carry the wake defaults", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-old-"));
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ voice: "marin", wake: { enabled: false } }));
  const engine = bare(stateDir);
  assert.equal(engine.snapshot().settings.voice, "marin");
  assert.deepEqual(engine.snapshot().settings.wake, { ...DEFAULT_SETTINGS.wake, enabled: false });
});

test("English by default: DEFAULT_SETTINGS says ballad / en / british / memory on; an old settings.json without the keys yields those defaults with no file rewrite; null keeps them; a real pick persists", () => {
  assert.equal(DEFAULT_SETTINGS.voice, "ballad");
  assert.equal(DEFAULT_SETTINGS.language, "en");
  assert.equal(DEFAULT_SETTINGS.accent, "british");
  assert.equal(DEFAULT_SETTINGS.memory, true);
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-lang-"));
  const before = JSON.stringify({ voice: "marin", wake: { enabled: false } });
  writeFileSync(join(stateDir, "settings.json"), before);
  const engine = bare(stateDir);
  const s = engine.snapshot().settings;
  assert.equal(s.language, "en");
  assert.equal(s.accent, "british");
  assert.equal(s.memory, true);
  assert.equal(readFileSync(join(stateDir, "settings.json"), "utf8"), before, "reading defaults writes nothing");
  // null on a required field keeps its value (the native UI's "clear").
  engine.updateSettings({ language: null, accent: null, memory: null });
  assert.equal(engine.snapshot().settings.language, "en");
  assert.equal(engine.snapshot().settings.accent, "british");
  assert.equal(engine.snapshot().settings.memory, true);
  engine.updateSettings({ accent: "british", memory: false });
  const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(saved["accent"], "british");
  assert.equal(saved["language"], "en");
  assert.equal(saved["memory"], false);
  assert.equal(engine.snapshot().memory?.enabled, false);
});

/** The name Settings.threads had in a settings.json written before 2026-09-13. */
const OLD_THREADS_FLAG = "workers"; // before 2026-09-13

test("a settings.json from before 2026-09-13: the old threads flag becomes `threads`, a retired key is dropped, and the file is rewritten once without them; a file holding only known keys is never rewritten", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-migrate-"));
  const path = join(stateDir, "settings.json");
  writeFileSync(path, JSON.stringify({ [OLD_THREADS_FLAG]: false, replayFinish: true, voice: "marin" })); // a file from before 2026-09-13: the old flag and a retired key
  const engine = bare(stateDir);
  const s = engine.snapshot().settings as unknown as Record<string, unknown>;
  assert.equal(s["threads"], false, "the old flag's value carries over");
  assert.equal(OLD_THREADS_FLAG in s, false);
  assert.equal(s["voice"], "marin");
  assert.ok(Object.keys(s).every((k) => (SETTINGS_KEYS as readonly string[]).includes(k)), "the snapshot carries only Settings' keys");
  const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(saved["threads"], false);
  assert.equal(OLD_THREADS_FLAG in saved, false, "rewritten without the old flag");
  assert.equal(saved["voice"], "marin");
  assert.ok(Object.keys(saved).every((k) => (SETTINGS_KEYS as readonly string[]).includes(k)), "only Settings' keys remain in the file");
  // The rewritten file is clean: a second engine over it writes nothing.
  const clean = readFileSync(path, "utf8");
  bare(stateDir);
  assert.equal(readFileSync(path, "utf8"), clean, "a clean file is not rewritten");
  // `threads` already present wins over a stray old flag.
  writeFileSync(path, JSON.stringify({ [OLD_THREADS_FLAG]: false, threads: true }));
  assert.equal(bare(stateDir).snapshot().settings.threads, true);
});

test("brain `local` round-trips through settings.json with an empty model (best fit) and a pinned server; SETTINGS_KEYS is unchanged — no key was added for the local brain", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-local-"));
  const engine = bare(stateDir);
  engine.updateSettings({ brain: "local", brainModel: "", brainBaseUrl: "http://10.0.0.5:11434" });
  const saved = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(saved["brain"], "local");
  assert.equal(saved["brainModel"], "");
  assert.equal(saved["brainBaseUrl"], "http://10.0.0.5:11434");
  const again = bare(stateDir).snapshot().settings;
  assert.equal(again.brain, "local");
  assert.equal(again.brainModel, "");
  assert.equal(again.brainBaseUrl, "http://10.0.0.5:11434");
  // A pick writes the id; clearing the server goes back to discovery.
  engine.updateSettings({ brainModel: "qwen3.5:27b", brainBaseUrl: null });
  const picked = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8")) as Record<string, unknown>;
  assert.equal(picked["brainModel"], "qwen3.5:27b");
  assert.equal("brainBaseUrl" in picked, false);
  // The contract's pin: the local brain rides on brain / brainModel / brainBaseUrl and adds no key.
  // `automations` (design11, 2026-09-14), `audio` (design12, 2026-09-16) and `userName` (release F1, 2026-09-20) are the keys added since: the automations block (switch, unattended kinds, quiet hours, recipes) and the audio block (Recording).
  assert.deepEqual(
    [...SETTINGS_KEYS].sort(),
    ["accent", "audio", "autoWake", "automations", "brain", "brainBaseUrl", "brainModel", "effort", "idleSleepMinutes", "language", "ledgerRetentionDays", "memory", "micDeviceId", "observe", "onboarded", "orbHome", "orbPosition", "reflexes", "shotsRetentionDays", "threadOverflow", "threads", "typedWakes", "userName", "voice", "wake", "warmThreads"],
  );
  assert.ok(!SETTINGS_KEYS.some((k) => /local/i.test(k)));
});

test("set-settings-migration: a settings.json from before the automations block loads DEFAULT_AUTOMATIONS and is not rewritten; a patch to the block persists whole and null keeps the default", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-automations-"));
  const path = join(stateDir, "settings.json");
  const before = JSON.stringify({ voice: "marin", wake: { enabled: false } }); // before 2026-09-14: no `automations`
  writeFileSync(path, before);
  const engine = bare(stateDir);
  assert.deepEqual(engine.snapshot().settings.automations, DEFAULT_AUTOMATIONS);
  assert.deepEqual(DEFAULT_AUTOMATIONS.unattended, ["chime", "say", "notify", "open", "file"], "run-recipe, press and wake-brain are opt-in chips");
  assert.equal(readFileSync(path, "utf8"), before, "reading the default writes nothing");
  assert.deepEqual(engine.snapshot().automations, [], "and no row exists");
  engine.updateSettings({ automations: { ...DEFAULT_AUTOMATIONS, quietHours: { from: "22:00", to: "07:00" }, recipes: [{ name: "backup", command: "echo hi", timeoutSeconds: 5, approvedAt: 1 }] } });
  const saved = JSON.parse(readFileSync(path, "utf8")) as { automations: typeof DEFAULT_AUTOMATIONS };
  assert.deepEqual(saved.automations.quietHours, { from: "22:00", to: "07:00" });
  assert.equal(saved.automations.recipes.length, 1);
  assert.deepEqual(bare(stateDir).snapshot().settings.automations.quietHours, { from: "22:00", to: "07:00" });
  engine.updateSettings({ automations: null });
  assert.deepEqual(engine.snapshot().settings.automations.recipes.length, 1, "null on a required block keeps its value");
});

// ---- design12 · V6: the audio block's migration and the read-back frame in the snapshot.

test("V6 · a settings.json from before 2026-09-16 (no `audio`) loads DEFAULT_AUDIO and is not rewritten; `audio: {}` merges recording: false; a patch persists the block whole; null keeps it", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-settings-audio-"));
  const path = join(stateDir, "settings.json");
  const before = JSON.stringify({ voice: "marin", wake: { enabled: false } }); // before 2026-09-16: no `audio`
  writeFileSync(path, before);
  const engine = bare(stateDir);
  assert.deepEqual(engine.snapshot().settings.audio, DEFAULT_AUDIO);
  assert.deepEqual(DEFAULT_AUDIO, { recording: false }, "Recording is off until Kevin turns it on");
  assert.equal(readFileSync(path, "utf8"), before, "reading the default writes nothing — a missing known key is not unknown");
  assert.ok((SETTINGS_KEYS as readonly string[]).includes("audio"), "the cover pin compiles only with the key listed");

  // An empty block (a hand-edited file) merges field-wise.
  writeFileSync(path, JSON.stringify({ voice: "marin", audio: {} }));
  assert.deepEqual(bare(stateDir).snapshot().settings.audio, { recording: false });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { voice: "marin", audio: {} }, "still not rewritten");

  // The first set-settings after lands the block in the file, whole.
  engine.updateSettings({ audio: { recording: true } });
  const saved = JSON.parse(readFileSync(path, "utf8")) as { audio: { recording: boolean } };
  assert.deepEqual(saved.audio, { recording: true });
  assert.equal(bare(stateDir).snapshot().settings.audio.recording, true, "survives a relaunch");
  // A partial block from an older writer merges over the default, never over undefined.
  engine.updateSettings({ audio: {} as never });
  assert.deepEqual(engine.snapshot().settings.audio, { recording: false });
  engine.updateSettings({ audio: { recording: true } });
  engine.updateSettings({ audio: null });
  assert.equal(engine.snapshot().settings.audio.recording, true, "null on a required block keeps its value");
});

const RECORDING_STATE: AudioState = {
  running: true,
  voiceProcessing: false,
  rung: 1,
  wiring: "hardware",
  hears: { name: "MacBook Pro Microphone", uid: "BuiltInMicrophoneDevice", rate: 48000, channels: 1, transport: "built-in" },
  speaks: { name: "Kevin's AirPods Pro", uid: "AP-out", rate: 48000, channels: 2, transport: "bluetooth" },
  tapFormat: "48000 Hz ×1 Float32",
  recording: true,
  fallback: false,
  guardOn: true,
  guardTailMs: 420,
  guardHeldMs: 3200,
  gated: 12,
  chunks: 340,
  breakthroughs: 1,
  sharedWith: ["QuickTime Player"],
  inputMuted: false,
  aggregatePresent: false,
};

test("reportAudioState keeps the app's frame in the snapshot with `since` stamped on the first running frame, coalesces equal frames, and clears on undefined (the app disconnected)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "jh-audio-state-"));
  const engine = bare(stateDir);
  assert.equal(engine.snapshot().audioState, undefined, "absent until the app reports");
  engine.reportAudioState(RECORDING_STATE);
  const first = engine.snapshot().audioState;
  assert.ok(first);
  assert.equal(first.recording, true);
  assert.equal(first.hears?.name, "MacBook Pro Microphone");
  assert.equal(typeof first.since, "number", "stamped when running went true");
  engine.reportAudioState({ ...RECORDING_STATE, gated: 13 });
  assert.equal(engine.snapshot().audioState?.since, first.since, "the same start keeps its since");
  engine.reportAudioState({ ...RECORDING_STATE, running: false, guardOn: false, gated: 13 });
  assert.equal(engine.snapshot().audioState?.since, undefined, "down: no since");
  engine.reportAudioState(undefined);
  assert.equal(engine.snapshot().audioState, undefined, "the app left");
  assert.equal(engine.snapshot().settings.audio.recording, false, "the frame is state, never a setting: Recording stays as set-settings left it");
});
